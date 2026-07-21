import { describe, expect, it } from "vitest";
import { createEditorCore } from "../core";
import {
  appliedReflectsDrag,
  boundariesToHeights,
  boundariesToRatios,
  boundariesToWidths,
  columnWidthMm,
  DEFAULT_IMAGE_WIDTH_MM,
  equalizeColumns,
  HWPUNIT_PER_MM,
  HWPUNIT_PER_PX,
  imageInsertSize,
  mmToHwpUnit,
  mmToPx,
  pxToMm,
  remapFragmentHeights,
  resizeBoundary,
  roundMm,
  setColumnWidthMm,
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

describe("units — image insert size math (issue 050, §4.5 single point)", () => {
  it("HWPUNIT_PER_MM is 7200/25.4 and mmToHwpUnit rounds to a whole unit", () => {
    expect(HWPUNIT_PER_MM).toBeCloseTo(283.4645, 3);
    // 120mm → 34016 HWPUNIT (the default display width).
    expect(mmToHwpUnit(DEFAULT_IMAGE_WIDTH_MM)).toBe(34016);
    expect(Number.isInteger(mmToHwpUnit(37.3))).toBe(true); // always whole units (no fractional HWPUNIT)
  });

  it("imageInsertSize preserves the natural ASPECT at the default display width", () => {
    // A 2:1 (wide) image at 120mm → 60mm tall. In HWPUNIT: 34016 × 17008.
    const box = imageInsertSize(1000, 500);
    expect(box.width).toBe(mmToHwpUnit(120));
    expect(box.height).toBe(mmToHwpUnit(60));
    // aspect ratio is preserved (width:height == naturalW:naturalH).
    expect(box.width / box.height).toBeCloseTo(2, 2);
  });

  it("imageInsertSize honours a custom display width + falls back to 4:3 on a degenerate natural size", () => {
    const box = imageInsertSize(800, 800, 90); // square at 90mm → 90×90mm
    expect(box.width).toBe(mmToHwpUnit(90));
    expect(box.height).toBe(mmToHwpUnit(90));
    // natural size 0 (couldn't read intrinsic dims) → 4:3 box at the default width (never 0×0).
    const fallback = imageInsertSize(0, 0);
    expect(fallback.width).toBe(mmToHwpUnit(120));
    expect(fallback.height).toBe(mmToHwpUnit(90)); // 120 × 3/4
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

describe("units — precise column width (mm) + 균등 분배 (issue 047)", () => {
  it("columnWidthMm reads a column's PAGE-px width as rounded mm (honest 1dp, no false precision)", () => {
    // A4-ish table: boundaries in PAGE px. Column 0 = 200px, column 1 = 100px. 200px @ 96dpi = 52.9mm.
    const b = [0, 200, 300, 400];
    expect(columnWidthMm(b, 0)).toBeCloseTo(roundMm(pxToMm(200)), 6);
    expect(columnWidthMm(b, 1)).toBeCloseTo(roundMm(pxToMm(100)), 6);
    // never more precise than 0.1mm (the readout of the live geometry).
    expect(columnWidthMm(b, 0)).toBe(Math.round(pxToMm(200) * 10) / 10);
    // out of range → 0 (no crash).
    expect(columnWidthMm(b, 9)).toBe(0);
    expect(columnWidthMm(b, -1)).toBe(0);
  });

  it("setColumnWidthMm moves the RIGHT boundary to hit the target mm (interior column)", () => {
    const b = [0, 200, 300, 400]; // 3 cols
    // Set column 0 to 20mm. 20mm @ 96dpi ≈ 75.59px → its right boundary lands at 0 + 75.59.
    const next = setColumnWidthMm(b, 0, 20);
    expect(next[1]).toBeCloseTo(mmToPx(20), 6);
    // the neighbour boundary (index 2) and endpoints are untouched.
    expect(next[0]).toBe(0);
    expect(next[2]).toBe(300);
    expect(next[3]).toBe(400);
    // a fresh readout of the resized column reflects ~20mm (roundtrip honesty).
    expect(columnWidthMm(next, 0)).toBeCloseTo(20, 1);
  });

  it("setColumnWidthMm on the LAST column steals from its LEFT neighbour", () => {
    const b = [0, 200, 300, 400]; // last column = index 2 (300..400 = 100px)
    const next = setColumnWidthMm(b, 2, 40); // 40mm ≈ 151.2px → left boundary = 400 - 151.2
    expect(next[2]).toBeCloseTo(400 - mmToPx(40), 6);
    expect(next[3]).toBe(400); // table right edge fixed
    expect(next[0]).toBe(0);
  });

  it("setColumnWidthMm clamps so neither the column nor its neighbour collapses below minPx", () => {
    const b = [0, 100, 200, 300];
    // Ask for an absurdly wide column 0 → clamp at the right neighbour minus minPx(8).
    expect(setColumnWidthMm(b, 0, 9999)[1]).toBe(200 - 8);
    // A 1-column table has nothing to resize against → unchanged.
    expect(setColumnWidthMm([0, 300], 0, 50)).toEqual([0, 300]);
    // out-of-range col → unchanged.
    expect(setColumnWidthMm(b, 9, 50)).toEqual(b);
  });

  it("equalizeColumns redistributes a range to equal widths, holding the bounding boundaries + others", () => {
    // 4 columns of px widths 100 / 40 / 40 / 120. Equalize the middle two (indices 1..2): the span
    // 100..180 (80px) splits into 40/40 — already equal here, so pick an UNequal span.
    const b = [0, 100, 130, 180, 300]; // widths 100/30/50/120
    const next = equalizeColumns(b, 1, 2); // span 100..180 (80px) → two 40px columns
    expect(next).toEqual([0, 100, 140, 180, 300]);
    // whole-table equalize (0..3): span 0..300 → four 75px columns.
    expect(equalizeColumns(b, 0, 3)).toEqual([0, 75, 150, 225, 300]);
    // degenerate (single column / out of range) → unchanged.
    expect(equalizeColumns(b, 1, 1)).toEqual(b);
    expect(equalizeColumns(b, 0, 9)).toEqual(b);
  });

  it("the committed ratios of an equalized range are equal (proportion check)", () => {
    const next = equalizeColumns([0, 100, 130, 180, 300], 0, 3); // [0,75,150,225,300]
    const ratios = boundariesToRatios(next);
    expect(ratios[0]).toBe(ratios[1]);
    expect(ratios[1]).toBe(ratios[2]);
    expect(ratios[2]).toBe(ratios[3]);
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

  it("step2 insertTable (rewired in 051) commits ONE InsertTableAt intent — default = section END (index:null)", async () => {
    const { core, adapter } = await openCore();
    await core.edit.insertTable(2, 3);
    expect(adapter.applied).toHaveLength(1);
    const intent = adapter.applied[0] as Intent & { rows: unknown[][] };
    // The old ApplyContent end-append fallback is retired: the InsertTableAt OP always existed; 051
    // exposed it as an Intent, so the manual toolbar and the chat share ONE structural insert lane.
    expect(intent.intent).toBe("InsertTableAt");
    expect(intent.section).toBe(0);
    expect(intent.index).toBeNull(); // null = section END (the engine resolves len — INTENT-SCHEMA §6.9)
    expect(intent.rows).toHaveLength(2);
    expect(intent.rows[0]).toEqual([{}, {}, {}]); // {} = an empty plain CellSpec (all defaults)
    expect(core.session.canUndo()).toBe(true);
    await core.session.undo();
    expect(adapter.undos).toBe(1); // one op → one undo removes the table
  });

  it("insertTable at an explicit block index passes it through (positioned insert)", async () => {
    const { core, adapter } = await openCore();
    await core.edit.insertTable(1, 2, 0, 4);
    expect(adapter.applied[0]).toMatchObject({ intent: "InsertTableAt", section: 0, index: 4 });
  });

  it("행 삽입 (issue 039) delegates to the EXISTING TableInsertRows op — below = at row+1, above = at row", async () => {
    const { core, adapter } = await openCore();
    // 아래에 행 삽입: selected row 2 of a 3-col table → at = 3, count defaults to 1, cols stays rectangular.
    await core.edit.insertRows(0, 1, 3, 3);
    expect(adapter.applied[0]).toEqual({ intent: "TableInsertRows", section: 0, index: 1, at: 3, count: 1, cols: 3 });
    // 위에 행 삽입: selected row 0 → at = 0.
    await core.edit.insertRows(0, 1, 0, 3);
    expect(adapter.applied[1]).toEqual({ intent: "TableInsertRows", section: 0, index: 1, at: 0, count: 1, cols: 3 });
    // NO new intent kind is introduced — it reuses the same tag the schema already accepts (schema_v0 Synthetic).
    expect(adapter.applied.every((i) => i.intent === "TableInsertRows")).toBe(true);
  });

  it("빈 줄 추가/삭제 — InsertParagraphAt(no runs) below the anchor / DeleteBlock at the anchor", async () => {
    const { core, adapter } = await openCore();
    // 빈 줄 추가: an empty paragraph inserted BELOW block 2 (→ index 3) with no runs = a blank spacer line.
    await core.edit.insertBlankParagraph(0, 3);
    expect(adapter.applied[0]).toEqual({ intent: "InsertParagraphAt", section: 0, index: 3, runs: [], para: {} });
    // 빈 줄 삭제: DeleteBlock at the anchored block.
    await core.edit.deleteBlock(0, 3);
    expect(adapter.applied[1]).toEqual({ intent: "DeleteBlock", section: 0, index: 3 });
  });

  it("행 삽입 clamps count/cols to ≥1 (never an illegal empty insert)", async () => {
    const { core, adapter } = await openCore();
    await core.edit.insertRows(0, 1, 1, 0, 0);
    expect(adapter.applied[0]).toEqual({ intent: "TableInsertRows", section: 0, index: 1, at: 1, count: 1, cols: 1 });
  });

  it("이미지 삽입 (issue 050) commits ONE InsertImage intent (bytes-based) as one undo batch", async () => {
    const { core, adapter } = await openCore();
    const b64 = "iVBORw0KGgoAAAA=="; // a base64 blob — the ENGINE validates the magic bytes, not the core
    const size = imageInsertSize(1000, 500); // 34016 × 17008 HWPUNIT
    // Drop AFTER block 2 → the intent carries `block: 2`; the engine inserts after it.
    await core.edit.insertImage(b64, 0, 2, size);
    expect(adapter.applied).toEqual([
      { intent: "InsertImage", section: 0, block: 2, data_b64: b64, width: size.width, height: size.height },
    ]);
    expect(core.session.canUndo()).toBe(true);
    await core.session.undo();
    expect(adapter.undos).toBe(1); // one op → one undo removes the image
    expect(core.session.canUndo()).toBe(false);
  });

  it("이미지 삽입 with no anchor sends block:null (append at the section END — upload-with-no-selection)", async () => {
    const { core, adapter } = await openCore();
    await core.edit.insertImage("Zm9v", 0, null, { width: 1000, height: 750 });
    expect(adapter.applied[0]).toEqual({ intent: "InsertImage", section: 0, block: null, data_b64: "Zm9v", width: 1000, height: 750 });
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

describe("051 — structural preview cards (describeIntent + EditController.previewCards)", () => {
  it("describeIntent summarizes structural inserts as POSITION + CONTENT", async () => {
    const { core } = await openCore();
    const [table] = core.edit.preview([{ intent: "InsertTableAt", section: 0, index: null, rows: [[{}, {}, {}], [{}, {}, {}]] }]);
    expect(table.label).toBe("표 삽입");
    expect(table.summary).toContain("2×3 표 삽입");
    expect(table.summary).toContain("구역 끝");
    expect(table.destructive).toBeUndefined();

    const [para] = core.edit.preview([
      { intent: "InsertParagraphAt", section: 0, index: 2, runs: [{ text: "회사 " }, { text: "약력", bold: true }] },
    ]);
    expect(para.label).toBe("문단 삽입");
    expect(para.summary).toContain("블록 2 위치");
    expect(para.summary).toContain("회사 약력");

    // 062-follow: an AI-generated data chart previews as a chart card (type + data shape).
    const [chart] = core.edit.preview([
      {
        intent: "InsertChartAt",
        section: 0,
        index: null,
        chart: { type: "bar", title: "연도별 매출", categories: ["2024", "2025", "2026"], series: [{ name: "매출", values: [10, 18, 30] }] },
      },
    ]);
    expect(chart.label).toBe("차트 삽입");
    expect(chart.summary).toContain("막대 차트 삽입");
    expect(chart.summary).toContain("연도별 매출");
    expect(chart.summary).toContain("3개 항목");
    expect(chart.summary).toContain("1개 계열");
    expect(chart.summary).toContain("구역 끝");
    expect(chart.destructive).toBeUndefined();
  });

  it("067-follow: the 4 document-wide intents preview as SPECIFIC cards (never the generic '편집' fallback)", async () => {
    const { core } = await openCore();
    const [rep] = core.edit.preview([{ intent: "Replace", query: "갑", replacement: "을", case_sensitive: false, whole_word: false, all: true }]);
    expect(rep.label).toBe("찾아 바꾸기");
    expect(rep.summary).toContain("“갑” → “을”");
    expect(rep.summary).toContain("(전체)");

    const [fmt] = core.edit.preview([{ intent: "SetCharFmt", section: 0, block: 2, cell: [1, 0], bold: true, size_pt: 14 }]);
    expect(fmt.label).toBe("글자 서식");
    expect(fmt.summary).toContain("굵게");
    expect(fmt.summary).toContain("크기 14pt");
    expect(fmt.summary).toContain("셀 2행 1열"); // [1,0] → 사람 읽는 1-기반

    const [cols] = core.edit.preview([{ intent: "SetTableColWidths", section: 0, index: 1, widths: [2, 1, 1] }]);
    expect(cols.label).toBe("열 너비");
    expect(cols.summary).toContain("2 : 1 : 1");

    const [mg] = core.edit.preview([{ intent: "SetPageMargins", section: 0, left_mm: 20, right_mm: 20, top_mm: 20, bottom_mm: 15 }]);
    expect(mg.label).toBe("페이지 여백");
    expect(mg.summary).toContain("좌 20");
    expect(mg.summary).toContain("하 15");
  });

  it("DeleteBlock card is DESTRUCTIVE and previewCards fetches the target block's 원문 (paragraph)", async () => {
    const { core } = await openCore({ runs: (s, b, row) => (row === undefined && s === 0 && b === 3 ? [{ text: "삭제될 " }, { text: "문단" }] : []) });
    const cards = await core.edit.previewCards([{ intent: "DeleteBlock", section: 0, index: 3 }]);
    expect(cards[0].destructive).toBe(true);
    expect(cards[0].detail).toBe("삭제될 문단");
    // The sync preview stays pure (no detail) — only the async lane reads the doc.
    expect(core.edit.preview([{ intent: "DeleteBlock", section: 0, index: 3 }])[0].detail).toBeUndefined();
  });

  it("DeleteBlock 원문 falls back to the table's (0,0) cell, then to an HONEST placeholder", async () => {
    // A table block: paragraph read is empty, cell (0,0) has text.
    const table = await openCore({ runs: (_s, _b, row, col) => (row === 0 && col === 0 ? [{ text: "보유역량" }] : []) });
    const [tableCard] = await table.core.edit.previewCards([{ intent: "DeleteBlock", section: 0, index: 1 }]);
    expect(tableCard.detail).toContain("표 블록");
    expect(tableCard.detail).toContain("보유역량");

    // A backend that can't read runs at all → honest placeholder, never a fabricated 원문.
    const bare = await openCore();
    const [bareCard] = await bare.core.edit.previewCards([{ intent: "DeleteBlock", section: 0, index: 1 }]);
    expect(bareCard.destructive).toBe(true);
    expect(bareCard.detail).toContain("원문을 읽을 수 없는");
  });

  it("previewCards passes non-destructive intents through unchanged (no doc read)", async () => {
    const { core } = await openCore({ runs: [{ text: "무관" }] });
    const cards = await core.edit.previewCards([
      { intent: "SetTableCell", section: 0, index: 1, row: 0, col: 0, text: "값" },
      { intent: "TableAppendRow", section: 0, index: 1 },
    ]);
    expect(cards[0].detail).toBeUndefined();
    expect(cards[1].label).toBe("행 추가");
    expect(cards.every((c) => !c.destructive)).toBe(true);
  });
});
