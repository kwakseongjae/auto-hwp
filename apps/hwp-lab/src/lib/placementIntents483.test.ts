// #483 — 배치 속성 Intent 가 wasm 경계(JSON → 엔진 → JS 오류 코드)를 지나서도 같은 결과를 내는지 잠근다.
// Rust 정본은 crates/hwp-mcp/tests/shape_props_483.rs(XML 바이트 단위). 여기서는 호스트가 실제로 부르는
// 두 레인 — Intent 하나씩(`applyIntent`) · 원자 묶음(`applyIntents`, 어댑터 #371 이 쓰는 레인) — 이 같은 HWPX 를
// 내는지, 그리고 거절이 `code` 로 구분되는지 본다.
//
// 실엔진(wasm) 테스트 — packages/engine/pkg 가 있어야 한다(goldenRecovery.test.ts 와 같은 전제, 조용한 스킵 금지).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { HwpDoc, initEngine } from "@auto-hwp/engine";

const REPO = path.resolve(process.cwd(), "..", "..");
const WASM = path.join(REPO, "packages", "engine", "pkg", "hwp_wasm_bg.wasm");
const FIXTURE = path.join(REPO, "corpus", "hwpx", "FormattingShowcase.hwpx");

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

beforeAll(async () => {
  await initEngine(readFileSync(WASM));
}, 120_000);

// FormattingShowcase: 블록 1 · 3 · 4 = 본문 문단, 블록 6 = 3×3 표.
const BATCH = [
  { intent: "SetParagraphShape", section: 0, block: 3, keep_with_next: true },
  { intent: "SetParagraphShape", section: 0, block: 1, align: "right", line_spacing_pct: 175 },
  { intent: "SetTableProps", section: 0, index: 6, treat_as_char: true, page_break: "table", repeat_header: false },
  { intent: "InsertParagraphAt", section: 0, index: 5, runs: [{ text: "묶음 483" }], para_like: { section: 0, block: 3 } },
];

function withDoc<T>(f: (doc: HwpDoc) => T): T {
  const doc = HwpDoc.open(readFileSync(FIXTURE), "showcase.hwpx");
  try {
    return f(doc);
  } finally {
    doc.free();
  }
}

describe("#483 배치 속성 — wasm 경계 (실엔진)", () => {
  it("하나씩 넣은 것과 원자 묶음이 같은 HWPX 를 내고, 실행취소 한 칸이면 편집 전과 같다", () => {
    const original = withDoc((doc) => sha(doc.toHwpx()));
    const oneByOne = withDoc((doc) => {
      for (const it of BATCH) doc.applyIntent(it);
      return sha(doc.toHwpx());
    });
    const atomic = withDoc((doc) => {
      doc.applyIntents(BATCH, { atomic: true });
      const edited = sha(doc.toHwpx());
      doc.undo();
      expect(sha(doc.toHwpx()), "one undo restores the pre-edit export").toBe(original);
      return edited;
    });
    expect(oneByOne).not.toBe(original);
    expect(atomic).toBe(oneByOne);
  });

  it("거절은 code 로 구분된다 — invalid_target · bad_intent · out_of_range", () => {
    withDoc((doc) => {
      const codeOf = (intent: object): string | undefined => {
        try {
          doc.applyIntent(intent);
        } catch (e) {
          return (e as { code?: string }).code;
        }
        return "applied";
      };
      expect(codeOf({ intent: "SetTableProps", section: 0, index: 3, repeat_header: false })).toBe("invalid_target");
      expect(codeOf({ intent: "SetParagraphShape", section: 0, block: 6, keep_with_next: true })).toBe("invalid_target");
      expect(codeOf({ intent: "SetParagraphShape", section: 0, block: 3 })).toBe("bad_intent");
      expect(codeOf({ intent: "SetTableProps", section: 0, index: 6, page_break: "row" })).toBe("bad_intent");
      expect(codeOf({ intent: "SetParagraphShape", section: 0, block: 99, keep_with_next: true })).toBe("out_of_range");
      expect(doc.undoStats().snapshots, "no refusal left an undo unit").toBe(0);
    });
  });
});
