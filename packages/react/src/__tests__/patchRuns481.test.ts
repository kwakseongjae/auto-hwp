import { describe, expect, it } from "vitest";
import type { RunSpec } from "@auto-hwp/editor-core";
import { patchRuns } from "../components/HwpWorkspace";

// #481 — on SetParagraphRuns/SetTableCellRuns an OMITTED field keeps the replaced text's value. The ribbon
// used to send an "off" as a dropped key (`bold: undefined`), which now means "keep" — so turning bold off on a
// bold paragraph would do nothing. It must name the off.
describe("patchRuns — the ribbon names an off (#481)", () => {
  const runs: RunSpec[] = [
    { text: "굵은 글", bold: true, italic: true, size_pt: 12 },
    { text: "\n" },
    { text: "보통 글", bold: false, size_pt: 12 },
  ];

  it("bold off is sent as bold: false on every run (the key is not dropped)", () => {
    const out = patchRuns(runs, { bold: false });
    expect(out[0]).toEqual({ text: "굵은 글", bold: false, italic: true, size_pt: 12 });
    expect(out[2]).toEqual({ text: "보통 글", bold: false, size_pt: 12 });
    expect(JSON.parse(JSON.stringify(out[0]))).toHaveProperty("bold", false);
  });

  it("each flag's off is named; untouched attributes and the \\n separator pass through", () => {
    const out = patchRuns(runs, { italic: false, underline: false, strike: false });
    expect(out[0]).toEqual({ text: "굵은 글", bold: true, italic: false, underline: false, strike: false, size_pt: 12 });
    expect(out[1]).toEqual({ text: "\n" });
  });

  it("on is still on", () => {
    expect(patchRuns(runs, { bold: true })[2]).toEqual({ text: "보통 글", bold: true, size_pt: 12 });
  });
});
