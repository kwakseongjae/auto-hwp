// #481 — RunSpec 에서 생략한 글자 속성은 바꾸는 자리의 글자 모양을 물려받는다. 이것이 wasm 경계(JSON → 엔진 → blockRuns ·
// toHwpx)에서도 성립하는지 잠근다. 이슈 재현을 그대로 옮겼다: 메모리 blockRuns 와 다시 연 문서의 blockRuns 가 같고, 생략한
// 굵게 · 크기 · 글꼴이 유지된다. Rust 정본은 crates/hwp-mcp/tests/runspec_inherit_481.rs(XML 바이트 단위).
//
// 실엔진(wasm) 테스트 — packages/engine/pkg 가 있어야 한다(goldenRecovery.test.ts 와 같은 전제, 조용한 스킵 금지).
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { HwpDoc, initEngine } from "@auto-hwp/engine";

const REPO = path.resolve(process.cwd(), "..", "..");
const WASM = path.join(REPO, "packages", "engine", "pkg", "hwp_wasm_bg.wasm");
const corpus = (rel: string) => readFileSync(path.join(REPO, "corpus", rel));

beforeAll(async () => {
  await initEngine(readFileSync(WASM));
}, 120_000);

function withDoc<T>(rel: string, f: (doc: HwpDoc) => T): T {
  const doc = HwpDoc.open(corpus(rel), "a.hwpx");
  try {
    return f(doc);
  } finally {
    doc.free();
  }
}

function reopened<T>(doc: HwpDoc, f: (doc: HwpDoc) => T): T {
  const again = HwpDoc.open(doc.toHwpx(), "re.hwpx");
  try {
    return f(again);
  } finally {
    again.free();
  }
}

describe("#481 생략 = 물려받기 — wasm 경계 (실엔진)", () => {
  it("크기만 주면 굵게 · 글꼴이 남고, 메모리 = 다시 연 문서", () => {
    withDoc("hwpx/FormattingShowcase.hwpx", (d) => {
      d.applyIntent({ intent: "SetParagraphRuns", section: 0, block: 1, runs: [{ text: "size only", size_pt: 12 }] });
      const mem = d.blockRuns(0, 1);
      expect(mem[0]).toMatchObject({ bold: true, size_pt: 12, font: "함초롬바탕", color: "#000000" });
      expect(reopened(d, (r) => r.blockRuns(0, 1))).toEqual(mem);
    });
  });

  it("칸에서 굵게만 주면 9pt · 글꼴이 남고, 메모리 = 다시 연 문서", () => {
    withDoc("hwpxlib_corpus/error/20230818/test.hwpx", (d) => {
      d.applyIntent({
        intent: "SetTableCellRuns",
        section: 0,
        index: 4,
        row: 1,
        col: 0,
        runs: [{ text: "bold only", bold: true }],
      });
      const mem = d.blockRuns(0, 4, 1, 0);
      expect(mem[0]).toMatchObject({ bold: true, size_pt: 9, font: "맑은 고딕" });
      expect(reopened(d, (r) => r.blockRuns(0, 4, 1, 0))).toEqual(mem);
    });
  });

  it("bold:false 는 끄고, highlight:null 은 지운다", () => {
    withDoc("hwpx/FormattingShowcase.hwpx", (d) => {
      d.applyIntent({ intent: "SetParagraphRuns", section: 0, block: 1, runs: [{ text: "off", bold: false }] });
      expect(d.blockRuns(0, 1)[0]).toMatchObject({ bold: false, size_pt: 10, font: "함초롬바탕" });
      d.applyIntent({
        intent: "SetParagraphRuns",
        section: 0,
        block: 3,
        runs: [{ text: "marked", highlight: "#FFF2CC" }],
      });
      d.applyIntent({ intent: "SetParagraphRuns", section: 0, block: 3, runs: [{ text: "cleared", highlight: null }] });
      const mem = d.blockRuns(0, 3);
      expect(mem[0].highlight ?? null).toBeNull();
      expect(reopened(d, (r) => r.blockRuns(0, 3))).toEqual(mem);
    });
  });
});
