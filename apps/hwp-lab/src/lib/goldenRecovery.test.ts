// issue 052 — golden 비교 + V3 무오염(실엔진): 복구본(=toHwpx 스냅샷) 재오픈이 원 편집 상태를
// 보존함을 잠근다. 아울러 1단계 실측의 V3 증거(스냅샷 직렬화가 재조판/리비전/undo 스택을 오염시키지
// 않고 바이트 결정적임)를 회귀 가드로 고정한다.
//
// ⚠️ 실측 fidelity 매트릭스(2026-07-10, 052 구현 중 실측 — 모두 crates 스코프 밖의 기존 갭):
//  - hwpx 오리진 + 문단 텍스트 편집(Replace): 재오픈 전 페이지 픽셀 동일 ✓ → 이 파일의 golden.
//  - hwpx 오리진 + 표 추가(ApplyContent): 기존 페이지 픽셀 동일, 새 표만 3.74px 상향 배치.
//  - hwpx 오리진 + 표 셀 텍스트(SetTableCellRuns): ✅ 057에서 수정(익스포터가 dirty 표를 원본
//    XML의 자기 스팬에서 제자리 재방출 — Rust 정본: crates/hwp-{hwpx,mcp}/tests/table_anchor_057.rs).
//    이 파일의 두 번째 golden(전 페이지 pageSvg 동일)이 승격·잠금.
//  - .hwp 오리진 전반: 무편집·동일 폰트 조건에서도 toHwpx 재오픈이 8p→6p 재조판(.hwp 파서 IR →
//    HWPX 왕복 서식 손실, Track-A conversion fidelity 계열). 콘텐츠는 제자리 보존.
// 따라서 golden(전 페이지 pageSvg 문자열 동일)은 성립이 확인된 hwpx 오리진 + 문단 편집 · 표 셀
// 편집 레인에서 잠그고(복구본은 항상 HWPX — 복구 이후 왕복은 전부 이 레인), .hwp 오리진은 콘텐츠
// 보존으로 잠근다.
//
// 실엔진(wasm) 테스트 — packages/engine/pkg 가 있어야 한다(015 레시피 빌드 산출물, copy-wasm.mjs 와
// 같은 위치). 없으면 명확히 실패한다(조용한 스킵 금지 — 게이트가 가짜 그린이 되면 안 된다).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { HwpDoc, initEngine } from "@auto-hwp/engine";

const REPO = path.resolve(process.cwd(), "..", "..");
const WASM = path.join(REPO, "packages", "engine", "pkg", "hwp_wasm_bg.wasm");
const FIXTURE = path.join(REPO, "benchmarks", "benchmark.hwp");

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const MARKER = "복구골든052";

beforeAll(async () => {
  await initEngine(readFileSync(WASM));
}, 120_000);

// 복구본과 같은 레인의 HWPX 오리진 바이트(벤치마크를 한 번 내보낸 것).
function hwpxOrigin(): Uint8Array {
  const seed = HwpDoc.open(readFileSync(FIXTURE), "benchmark.hwp");
  try {
    return seed.toHwpx();
  } finally {
    seed.free();
  }
}

describe("issue 052 — 복구본 golden + V3 무오염 (실엔진)", () => {
  it(
    "golden(HWPX 오리진 + 문단 편집): 편집→toHwpx 스냅샷 재오픈 렌더 == 원 편집 상태 (전 페이지 pageSvg 동일)",
    () => {
      // 복구본은 항상 HWPX(스냅샷=toHwpx)이므로, 복구 이후의 모든 재저장/재복구는 이 레인을 돈다.
      const doc = HwpDoc.open(hwpxOrigin(), "benchmark (복구본).hwpx");
      try {
        const out = doc.applyIntent({ intent: "Replace", query: "사업", replacement: MARKER, case_sensitive: false, whole_word: false, all: false }) as {
          kind?: string;
          replaced?: number;
        };
        expect(out.replaced ?? 0).toBeGreaterThan(0); // 편집이 실제로 일어났다
        const pages = doc.pageCount();
        const editedSvgs: string[] = [];
        for (let p = 0; p < pages; p++) editedSvgs.push(doc.renderPageSvg(p));
        expect(editedSvgs.some((s) => s.includes(`>${MARKER[0]}<`))).toBe(true); // 마커가 렌더에 존재

        const snap = doc.toHwpx();
        const reopened = HwpDoc.open(snap, "benchmark (복구본).hwpx");
        try {
          expect(reopened.pageCount()).toBe(pages);
          for (let p = 0; p < pages; p++) {
            expect(reopened.renderPageSvg(p), `page ${p} SVG must match the edited state`).toBe(editedSvgs[p]);
          }
        } finally {
          reopened.free();
        }
      } finally {
        doc.free();
      }
    },
    120_000,
  );

  it(
    "golden(HWPX 오리진 + 표 셀 편집, 057 승격): SetTableCellRuns→toHwpx 스냅샷 재오픈 렌더 == 원 편집 상태 (전 페이지 pageSvg 동일)",
    () => {
      // 057 수정 전에는 이 레인이 "편집된 표를 문서 끝으로 오배치(원 위치 표는 원문 유지)"로
      // 격리되어 콘텐츠 보존 잠금조차 불가했다. 수정 후 제자리 재방출이 성립하므로 문단 편집
      // 레인과 같은 강도(전 페이지 pageSvg 동일)로 승격해 잠근다.
      const doc = HwpDoc.open(hwpxOrigin(), "benchmark (복구본).hwpx");
      try {
        // 페이지 0의 표 블록들을 지오메트리로 찾는다(blocksInRect — 페이지 전체 AABB, px).
        const tables = doc
          .blocksInRect(0, 0, 0, 100_000, 100_000)
          .filter((b) => b.kind === "table");
        expect(tables.length).toBeGreaterThan(0); // benchmark에는 표가 있다
        // 첫 번째로 편집이 성립하는 표의 (0,0) 셀 텍스트를 교체 — 에디터의 실제 커밋 레인
        // (SetTableCellRuns; 평문 variant는 run 붕괴라 금지 — §4 불변식 5).
        let edited: { section: number; block: number } | null = null;
        for (const t of tables) {
          try {
            doc.applyIntent({
              intent: "SetTableCellRuns",
              section: t.section,
              index: t.block,
              row: 0,
              col: 0,
              runs: [{ text: MARKER }],
            });
            edited = { section: t.section, block: t.block };
            break;
          } catch {
            // (0,0)이 비활성(병합 피복)인 표 → 다음 후보
          }
        }
        expect(edited, "표 셀 편집이 실제로 일어났다").not.toBeNull();
        // 편집 읽어보기: 셀 run에 마커가 박혔다.
        const runs = doc.blockRuns(edited!.section, edited!.block, 0, 0);
        expect(runs.map((r) => r.text).join("")).toContain(MARKER);

        const pages = doc.pageCount();
        const editedSvgs: string[] = [];
        for (let p = 0; p < pages; p++) editedSvgs.push(doc.renderPageSvg(p));

        const snap = doc.toHwpx();
        const reopened = HwpDoc.open(snap, "benchmark (복구본).hwpx");
        try {
          expect(reopened.pageCount()).toBe(pages);
          for (let p = 0; p < pages; p++) {
            expect(reopened.renderPageSvg(p), `page ${p} SVG must match the edited state`).toBe(editedSvgs[p]);
          }
          // 앵커 회귀 가드: 편집된 표가 원 블록 인덱스에 그대로(문서 끝 복제 없음).
          const rruns = reopened.blockRuns(edited!.section, edited!.block, 0, 0);
          expect(rruns.map((r) => r.text).join("")).toContain(MARKER);
        } finally {
          reopened.free();
        }
      } finally {
        doc.free();
      }
    },
    120_000,
  );

  it(
    "V3 무오염(.hwp 오리진): toHwpx는 rev/undo/재조판 무오염 · 바이트 결정적 · 복구본이 편집 내용을 보존",
    () => {
      const doc = HwpDoc.open(readFileSync(FIXTURE), "benchmark.hwp");
      try {
        // 1) 편집 1회 (한 undo 유닛) — 문서 끝 2×2 표 추가(EditController.insertTable 과 동일 Intent).
        const out = doc.applyIntent({
          intent: "ApplyContent",
          json: JSON.stringify({ blocks: [{ type: "table", header: [], rows: [[MARKER, "복구"], ["golden", "유지"]] }] }),
        }) as { kind?: string };
        expect(out.kind).not.toBe("error");
        const pages = doc.pageCount();

        // 편집 상태의 전 페이지를 렌더해 조판 캐시를 채운다(placeBuilds 기준선).
        for (let p = 0; p < pages; p++) doc.renderPageSvg(p);
        const stats0 = doc.placedStats();

        // 2) V3: toHwpx 7회 — 재조판 0회 · 리비전 불변 · 출력 sha 동일(바이트 결정적).
        const snaps: Uint8Array[] = [];
        for (let i = 0; i < 7; i++) snaps.push(doc.toHwpx());
        const stats1 = doc.placedStats();
        expect(stats1.placeBuilds).toBe(stats0.placeBuilds); // 순수 읽기 — 재조판 없음
        expect(stats1.revision).toBe(stats0.revision); // 편집 리비전 불변
        expect(new Set(snaps.map(sha)).size).toBe(1); // 동일 상태 → 동일 바이트

        // 3) undo 스택 무오염: 편집 1회였으므로 toHwpx 7회 뒤에도 undo는 정확히 1회만 성공한다.
        expect(doc.undo()).toBe(true);
        expect(doc.undo()).toBe(false); // 스택에 유닛이 몰래 늘지 않았다
        expect(doc.redo()).toBe(true); // 편집 상태 복원

        // 4) 복구본 콘텐츠 보존: 재오픈한 스냅샷에 편집 텍스트가 살아 있다. (렌더 픽셀 동일성은
        //    .hwp 오리진에선 기존 변환 갭(8p→6p 재조판)으로 성립하지 않는다 — 파일 상단 매트릭스.)
        const reopened = HwpDoc.open(snaps[0], "benchmark (복구본).hwpx");
        try {
          expect(reopened.pageCount()).toBeGreaterThan(0);
          expect(reopened.exportHtml()).toContain(MARKER);
        } finally {
          reopened.free();
        }
      } finally {
        doc.free();
      }
    },
    120_000,
  );
});
