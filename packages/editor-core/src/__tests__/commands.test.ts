import { describe, expect, it } from "vitest";
import { createEditorCore } from "../core";
import {
  appliedReflectsDrag,
  boundariesToHeights,
  boundariesToRatios,
  boundariesToWidths,
  HWPUNIT_PER_PX,
  mmToPx,
  pxToMm,
  remapFragmentHeights,
  resizeBoundary,
  roundMm,
  widthsToRatios,
} from "../units";
import { firstRunStyle, inheritRuns } from "../runs";
import type { Intent, RunSpec } from "../types";
import { MockAdapter } from "./mockAdapter";

// A helper: open a core over a mock adapter with the given opts and return {core, adapter}.
async function openCore(opts: ConstructorParameters<typeof MockAdapter>[0] = {}) {
  const adapter = new MockAdapter({ pages: 1, ...opts });
  const core = createEditorCore(adapter);
  await core.session.open(new Uint8Array([1]), "t.hwpx");
  return { core, adapter };
}

describe("units — the single px↔mm↔ratio conversion point (issue 027)", () => {
  it("mm↔px round-trips at 96dpi (page px == CSS px)", () => {
    // 210mm (A4 width) → 793.7px @ 96dpi.
    expect(mmToPx(210)).toBeCloseTo(793.70, 1);
    expect(pxToMm(mmToPx(37.5))).toBeCloseTo(37.5, 6);
    expect(roundMm(20.00001)).toBe(20);
  });

  it("boundaries → widths → integer ratios preserve proportion", () => {
    // 3 columns of px widths 200 / 100 / 100 → ratios proportional to 2:1:1.
    const widths = boundariesToWidths([0, 200, 300, 400]);
    expect(widths).toEqual([200, 100, 100]);
    const ratios = boundariesToRatios([0, 200, 300, 400]);
    expect(ratios[0]).toBe(2 * ratios[1]); // 2:1
    expect(ratios[1]).toBe(ratios[2]); // 1:1
  });

  it("widthsToRatios clamps a zero column to ≥1 (no illegal zero-width)", () => {
    const r = widthsToRatios([0, 100]);
    expect(r[0]).toBeGreaterThanOrEqual(1);
    expect(r.every((x) => x >= 1)).toBe(true);
  });

  it("resizeBoundary moves an interior handle, clamped, and never an endpoint", () => {
    const b = [0, 100, 200, 300];
    expect(resizeBoundary(b, 1, 150)).toEqual([0, 150, 200, 300]);
    // clamp: can't cross the right neighbour minus minPx(8).
    expect(resizeBoundary(b, 1, 400)).toEqual([0, 192, 200, 300]);
    // endpoints are the table box — never move.
    expect(resizeBoundary(b, 0, 50)).toEqual([0, 100, 200, 300]);
    expect(resizeBoundary(b, 3, 999)).toEqual([0, 100, 200, 300]);
  });
});

describe("units — row-height override math (issue 031)", () => {
  it("HWPUNIT_PER_PX is 75 (own-render px = HWPUNIT/75)", () => {
    expect(HWPUNIT_PER_PX).toBe(75);
  });

  it("boundariesToHeights maps a row-boundary px array → per-row HWPUNIT heights (whole table)", () => {
    // rows of px heights 40 / 20 / 40 → HWPUNIT ×75 = 3000 / 1500 / 3000.
    expect(boundariesToHeights([60, 100, 120, 160])).toEqual([3000, 1500, 3000]);
  });

  it("remapFragmentHeights places fragment heights at GLOBAL rows; rows outside the fragment are 0", () => {
    // A split table's fragment covers global rows 2..3 (firstRow=2), whole table has 5 rows. The dragged
    // fragment boundaries [0,40,80] → heights [3000,3000] land at indices 2,3; every other row is 0.
    expect(remapFragmentHeights([0, 40, 80], 2, 5)).toEqual([0, 0, 3000, 3000, 0]);
  });

  it("remapFragmentHeights on a single-fragment table equals boundariesToHeights", () => {
    const b = [10, 50, 70, 110];
    expect(remapFragmentHeights(b, 0, 3)).toEqual(boundariesToHeights(b));
  });

  it("remapFragmentHeights never overflows totalRows (fragment longer than the tail is truncated)", () => {
    // firstRow near the end: only the rows that fit are written, no out-of-range indices.
    expect(remapFragmentHeights([0, 40, 80, 120], 3, 4)).toEqual([0, 0, 0, 3000]);
  });
});

describe("units — apply-verify predicate (issue 031 §거짓 성공 차단)", () => {
  it("returns TRUE when the dragged boundary moved ≥ half the intended delta (real reflect)", () => {
    const before = [0, 100, 200];
    const intended = [0, 160, 200]; // dragged interior boundary +60
    // engine applied +60 exactly (columns) → reflected.
    expect(appliedReflectsDrag(before, intended, [0, 160, 200])).toBe(true);
    // engine applied +40 (≥ 0.5×60=30) → still reflected (row grow drags lower boundaries along).
    expect(appliedReflectsDrag(before, intended, [0, 140, 200])).toBe(true);
  });

  it("returns FALSE on a NO-OP (frozen engine returned the unchanged boundaries) — false-success guard", () => {
    const before = [0, 100, 200];
    const intended = [0, 160, 200];
    expect(appliedReflectsDrag(before, intended, before)).toBe(false); // no movement → not reflected
  });

  it("returns FALSE when the applied movement is the WRONG direction or too small", () => {
    const before = [0, 100, 200];
    const intended = [0, 160, 200]; // wanted +60
    expect(appliedReflectsDrag(before, intended, [0, 90, 200])).toBe(false); // moved the other way
    expect(appliedReflectsDrag(before, intended, [0, 110, 200])).toBe(false); // only +10 (< 0.5×60)
  });

  it("uses MOVEMENT MAGNITUDE not target proximity — a grown row that drags lower boundaries still passes", () => {
    // Row drag: intended raises boundary 1 by 30 (100→130). The engine grows row 0 so boundary 1 lands at
    // 128 AND boundary 2 is dragged down 200→228. A target-proximity model would reject boundary 2 (it's
    // nowhere near its intended 200); the movement-at-dragged-index model accepts (boundary 1 moved +28).
    const before = [0, 100, 200];
    const intended = [0, 130, 200];
    expect(appliedReflectsDrag(before, intended, [0, 128, 228])).toBe(true);
  });

  it("no meaningful drag (below epsilon) → TRUE (nothing to verify); length change → TRUE (re-paginated)", () => {
    expect(appliedReflectsDrag([0, 100, 200], [0, 100, 200], [0, 100, 200])).toBe(true); // no drag
    expect(appliedReflectsDrag([0, 100, 200], [0, 160, 200], [0, 100, 150, 220])).toBe(true); // re-paginated
  });
});

describe("runs — run-format preservation (issue 027 §함정)", () => {
  it("firstRunStyle takes the first non-newline run's style, dropping falsey defaults", () => {
    expect(firstRunStyle([{ text: "굵게", bold: true, italic: false }])).toEqual({ bold: true });
    expect(firstRunStyle([{ text: "\n" }, { text: "본문", size_pt: 12 }])).toEqual({ size_pt: 12 });
    expect(firstRunStyle([])).toEqual({});
  });

  it("inheritRuns keeps the first run's style on the new text (bold cell stays bold)", () => {
    const current: RunSpec[] = [{ text: "강조", bold: true, color: "#FF0000" }];
    expect(inheritRuns(current, "바뀐 값")).toEqual([{ text: "바뀐 값", bold: true, color: "#FF0000" }]);
  });

  it("inheritRuns splits multi-line text into per-paragraph runs joined by a \\n run", () => {
    expect(inheritRuns([{ text: "a", bold: true }], "가\n나")).toEqual([
      { text: "가", bold: true },
      { text: "\n" },
      { text: "나", bold: true },
    ]);
  });

  it("inheritRuns on unstyled/empty current yields a plain run (no crash)", () => {
    expect(inheritRuns([], "새 텍스트")).toEqual([{ text: "새 텍스트" }]);
  });
});

describe("EditController manual commands (issue 027) — each = ONE Intent = ONE undo batch", () => {
  it("step1 setColumnWidths applies SetTableColWidths(ratios) as one undo batch", async () => {
    const { core, adapter } = await openCore();
    const widths = boundariesToRatios([0, 200, 300, 400]);
    await core.edit.setColumnWidths(0, 1, widths);
    expect(adapter.applied).toEqual([{ intent: "SetTableColWidths", section: 0, index: 1, widths }]);
    expect(core.session.canUndo()).toBe(true);
    await core.session.undo();
    expect(adapter.undos).toBe(1); // one op → one undo restores it
    expect(core.session.canUndo()).toBe(false);
  });

  it("setRowHeights applies SetTableRowHeights(heights) as one undo batch (issue 031)", async () => {
    const { core, adapter } = await openCore();
    const heights = boundariesToHeights([60, 100, 120, 160]); // [3000,1500,3000] HWPUNIT
    await core.edit.setRowHeights(0, 1, heights);
    expect(adapter.applied).toEqual([{ intent: "SetTableRowHeights", section: 0, index: 1, heights }]);
    expect(core.session.canUndo()).toBe(true);
    await core.session.undo();
    expect(adapter.undos).toBe(1);
  });

  it("step2 insertTable appends a rows×cols empty table via ApplyContent", async () => {
    const { core, adapter } = await openCore();
    await core.edit.insertTable(2, 3);
    expect(adapter.applied).toHaveLength(1);
    const intent = adapter.applied[0] as Intent & { json: string };
    expect(intent.intent).toBe("ApplyContent");
    const parsed = JSON.parse(intent.json);
    expect(parsed.blocks[0].type).toBe("table");
    expect(parsed.blocks[0].rows).toHaveLength(2);
    expect(parsed.blocks[0].rows[0]).toEqual(["", "", ""]);
  });

  it("step3 setPageMargins passes mm through to SetPageMargins (document-wide)", async () => {
    const { core, adapter } = await openCore();
    await core.edit.setPageMargins(0, { left: 20, right: 20, top: 15, bottom: 15 });
    expect(adapter.applied[0]).toEqual({
      intent: "SetPageMargins",
      section: 0,
      left_mm: 20,
      right_mm: 20,
      top_mm: 15,
      bottom_mm: 15,
    });
  });

  it("step4 editCellText PRESERVES bold via SetTableCellRuns (never plain SetTableCell)", async () => {
    const { core, adapter } = await openCore({ runs: [{ text: "굵은 셀", bold: true }] });
    await core.edit.editCellText(0, 1, 0, 0, "새 값");
    const intent = adapter.applied[0] as Intent & { runs: RunSpec[] };
    expect(intent.intent).toBe("SetTableCellRuns"); // run-preserving variant, NOT SetTableCell
    expect(intent.runs).toEqual([{ text: "새 값", bold: true }]); // bold inherited
    // undo restores in one step.
    await core.session.undo();
    expect(adapter.undos).toBe(1);
  });

  it("step4 editParagraphText commits SetParagraphRuns (never plain SetParagraphText)", async () => {
    const { core, adapter } = await openCore({ runs: [{ text: "문단", italic: true }] });
    await core.edit.editParagraphText(0, 2, "바뀐 문단");
    const intent = adapter.applied[0] as Intent & { runs: RunSpec[] };
    expect(intent.intent).toBe("SetParagraphRuns");
    expect(intent.runs).toEqual([{ text: "바뀐 문단", italic: true }]);
  });

  it("step4 with a backend that OMITS blockRuns falls back to a plain run (still SetTableCellRuns)", async () => {
    const { core, adapter } = await openCore(); // no `runs` opt → blockRuns method omitted
    expect((adapter as { blockRuns?: unknown }).blockRuns).toBeUndefined();
    await core.edit.editCellText(0, 1, 1, 1, "값");
    const intent = adapter.applied[0] as Intent & { runs: RunSpec[] };
    expect(intent.intent).toBe("SetTableCellRuns");
    expect(intent.runs).toEqual([{ text: "값" }]);
  });

  it("step5 formatCellRange sends only set fields (unset → null) via SetCellRangeFmt", async () => {
    const { core, adapter } = await openCore();
    await core.edit.formatCellRange(0, 1, { r0: 0, c0: 0, r1: 1, c1: 2 }, { bold: true, color: "#0000FF" });
    expect(adapter.applied[0]).toEqual({
      intent: "SetCellRangeFmt",
      section: 0,
      index: 1,
      r0: 0,
      c0: 0,
      r1: 1,
      c1: 2,
      bold: true,
      italic: null,
      size_pt: null,
      font: null,
      color: "#0000FF",
      align: null,
    });
  });

  it("step5 shadeCellRange sets/clears a range background via SetCellRangeShade", async () => {
    const { core, adapter } = await openCore();
    await core.edit.shadeCellRange(0, 1, { r0: 0, c0: 0, r1: 0, c1: 0 }, "#FFFF00");
    expect(adapter.applied[0]).toEqual({ intent: "SetCellRangeShade", section: 0, index: 1, r0: 0, c0: 0, r1: 0, c1: 0, shade: "#FFFF00" });
    await core.edit.shadeCellRange(0, 1, { r0: 0, c0: 0, r1: 0, c1: 0 }, null);
    expect((adapter.applied[1] as Intent & { shade: unknown }).shade).toBeNull();
  });
});

describe("DocSession read helpers (issue 027) — optional adapter methods", () => {
  it("colBoundaries / rowBoundaries / pageGeom / runsAt delegate, and return null/[] when the backend omits them", async () => {
    const withGeom = await openCore({ colBoundaries: [0, 100, 200], rowBoundaries: [0, 40, 80], pageGeom: { w: 794, h: 1123, ml: 90, mt: 90, mr: 90, mb: 90 }, runs: [{ text: "x" }] });
    expect(await withGeom.core.session.colBoundaries(0, 0, 1)).toEqual([0, 100, 200]);
    expect(await withGeom.core.session.rowBoundaries(0, 0, 1)).toEqual([0, 40, 80]);
    expect((await withGeom.core.session.pageGeom(0))?.w).toBe(794);
    expect(await withGeom.core.session.runsAt(0, 1, 0, 0)).toEqual([{ text: "x" }]);

    const bare = await openCore(); // omits all optional methods
    expect(await bare.core.session.colBoundaries(0, 0, 1)).toBeNull();
    expect(await bare.core.session.rowBoundaries(0, 0, 1)).toBeNull();
    expect(await bare.core.session.pageGeom(0)).toBeNull();
    expect(await bare.core.session.runsAt(0, 1, 0, 0)).toEqual([]);
  });
});
