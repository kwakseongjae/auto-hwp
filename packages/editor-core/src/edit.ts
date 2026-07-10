import { deleteBlockDetail, describeIntent } from "./describeIntent";
import { inheritRuns } from "./runs";
import type { DocSession } from "./session";
import type { SelectionModel } from "./selection";
import type { DocContext, Intent, IntentCard, RunSpec } from "./types";

/** A rectangular cell range `[r0..=r1] × [c0..=c1]` (inclusive, MODEL-GLOBAL) — the target of a batch
 *  format / shade (INTENT-SCHEMA §6.8). A single cell is `r0==r1 && c0==c1`. */
export interface CellRange {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

/** The character-format patch a format toolbar applies to a cell range (issue 027 step 5). Every field
 *  is optional — an omitted field leaves that attribute UNCHANGED (INTENT-SCHEMA §6.8 `SetCellRangeFmt`).
 *  Units: `size_pt` in points; colors `"#RRGGBB"`; `align` ∈ left|center|right|justify|distribute. */
export interface CellFmt {
  bold?: boolean;
  italic?: boolean;
  size_pt?: number;
  font?: string;
  color?: string;
  align?: "left" | "center" | "right" | "justify" | "distribute";
}

/** Page margins in MILLIMETRES (the unit `SetPageMargins` takes — INTENT-SCHEMA §6.6). ⚠️ document-wide
 *  (applies to the whole section, re-flows every page) — the UI MUST say so before committing. */
export interface PageMarginsMm {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/// EditController — Intent assembly + apply + preview gate (SDK-LAYERS L2). It joins the DocSession and
/// the SelectionModel: it builds the read-only DocContext (doc meta + the marked anchors) handed to the
/// host AI callback, previews Intents as per-op cards, and APPLIES a proposal as one undo batch (then
/// clears the consumed selection). The AI itself is delegated to the host (R6) — this controller never
/// calls an LLM; it only prepares the request and commits the returned Intents.
///
/// Issue 027 adds the MANUAL edit commands (no AI): each assembles ONE schema-v0 Intent and applies it as
/// ONE undo batch via `session.applyBatch`, so every feature is restored by a single undo (the snapshot-
/// undo contract). All logic lives HERE (React 0 lines) so node tests pin it; the react components are a
/// thin opt-in binding that call these methods.
export class EditController {
  constructor(
    private session: DocSession,
    private selection: SelectionModel,
  ) {}

  /** The read-only DocContext for the current selection (doc meta + marked anchors). */
  docContext(): DocContext {
    return this.session.docContext(this.selection.getAnchors());
  }

  /** Map proposed Intents → preview cards (icon + label + human summary + target chip). */
  preview(intents: Intent[]): IntentCard[] {
    return intents.map(describeIntent);
  }

  /** The ASYNC preview (issue 051): `preview` plus per-card enrichment — a `DeleteBlock` card is
   *  populated with the target block's ORIGINAL text (`detail`, read via `session.runsAt`: paragraph
   *  first, table (0,0) cell fallback, honest placeholder otherwise) so the user sees exactly what a
   *  delete would remove BEFORE the explicit 적용 approval. Non-destructive intents pass through the
   *  pure `describeIntent` unchanged. The chat panel uses THIS for its cards; applying still goes
   *  through the same `apply` (one undo batch) — there is NO auto-apply path for a destructive card. */
  async previewCards(intents: Intent[]): Promise<IntentCard[]> {
    return Promise.all(
      intents.map(async (intent) => {
        const card = describeIntent(intent);
        if (card.destructive && card.section !== null && card.block !== null) {
          const detail = await deleteBlockDetail(
            (s, b, r, c) => this.session.runsAt(s, b, r, c),
            card.section,
            card.block,
          );
          return { ...card, detail };
        }
        return card;
      }),
    );
  }

  /** Apply a previewed proposal as ONE undo batch, then clear the consumed selection. Resolves to how
   *  many ops were applied. Rethrows on failure (the UI surfaces the error / trap-recovery message). */
  async apply(intents: Intent[]): Promise<number> {
    const applied = await this.session.applyBatch(intents);
    this.selection.clear();
    return applied;
  }

  // ── manual edit commands (issue 027) — each = ONE Intent = ONE undo batch ─────────────────────────

  /** 열 너비 (step 1): apply RELATIVE column ratios to a table (INTENT-SCHEMA `SetTableColWidths`). The
   *  px→ratio conversion lives in `units.ts` (single point); the UI passes the already-derived `widths`. */
  async setColumnWidths(section: number, index: number, widths: number[]): Promise<number> {
    return this.session.applyBatch([{ intent: "SetTableColWidths", section, index, widths }]);
  }

  /** 행 높이 (issue 031): apply a WHOLE-table per-row minimum-height override to a table
   *  (INTENT-SCHEMA `SetTableRowHeights`, HWPUNIT; `0` = content-sized). `heights.length` MUST equal the
   *  table's row count — the px→HWPUNIT + split-table fragment→whole-table remap lives in `units.ts`
   *  (`remapFragmentHeights`), so the UI passes the already-derived whole-table `heights`. One undo batch. */
  async setRowHeights(section: number, index: number, heights: number[]): Promise<number> {
    return this.session.applyBatch([{ intent: "SetTableRowHeights", section, index, heights }]);
  }

  /** 이미지 크기 (issue 049): resize the image at block `index` to `width`×`height` HWPUNIT via `SetImageSize`
   *  (INTENT-SCHEMA §6.6 — image sizes are HWPUNIT; the op-bus REFUSES a non-positive size). The px→HWPUNIT
   *  conversion lives in `units.ts` `imageSizeToHwpunit` (single point), so the UI passes already-derived
   *  HWPUNIT. One undo batch — a single ⌘Z reverts the whole resize. The overlay's pointerup commit. */
  async resizeImage(section: number, index: number, width: number, height: number): Promise<number> {
    return this.session.applyBatch([{ intent: "SetImageSize", section, index, width, height }]);
  }

  /** 이미지 이동 (issue 049): relocate the image from block `from` to block `to` in `section` via `MoveImage`
   *  (`DeleteBlock` + `InsertImageAt`, batched into ONE undo unit by the op-bus). ⚠️ SEMANTIC (실측): the
   *  engine's move is an ANCHOR REORDER within the section's block flow — NOT a free 2-D offset. The image is
   *  anchored to a paragraph block; "move" changes WHICH block position it sits at. The UI must therefore
   *  resolve the DROP point to a target block index (via `hitTest`) and NOT pretend the image can be placed
   *  at an arbitrary `(x, y)` (거짓 자유도 금지). `width`/`height` (HWPUNIT) preserve the image's size across
   *  the move. One undo batch. */
  async moveImage(section: number, from: number, to: number, width: number, height: number): Promise<number> {
    return this.session.applyBatch([{ intent: "MoveImage", section, from, to, width, height }]);
  }

  /** 표 추가 (step 2, rewired in issue 051): insert a fresh `rows × cols` empty table via the
   *  `InsertTableAt` Intent (NOTE — 051 정정: the `InsertTableAt` OP has always existed in hwp-ops;
   *  what was missing was only its Intent exposure, so the old ApplyContent end-append fallback is
   *  retired). `at` is the target BLOCK index (`at == len` appends); the default `null` means the
   *  SECTION END — the engine resolves it to `len`, absorbing the end-append without the web shell
   *  needing to know the block count (INTENT-SCHEMA §6.9, the `InsertImage.block` anchor precedent).
   *  Each cell is `{}` (all `CellSpec` defaults — an empty plain cell). One undo batch. */
  async insertTable(rows: number, cols: number, section = 0, at: number | null = null): Promise<number> {
    const r = Math.max(1, Math.floor(rows));
    const c = Math.max(1, Math.floor(cols));
    const grid = Array.from({ length: r }, () => Array.from({ length: c }, () => ({})));
    return this.session.applyBatch([{ intent: "InsertTableAt", section, index: at, rows: grid }]);
  }

  /** 행 삽입 (issue 039): insert `count` empty rows at logical row `at` (whole-table index, `0..=rowCount`)
   *  of the `index`-th table, delegating to the EXISTING `TableInsertRows` op — NO new intent is introduced
   *  (§함정 실측: `TableInsertRows`/`TableAppendRow` exist; row-DELETE and column insert/delete do NOT, so
   *  those verbs are OUT of scope — the menu must not offer them). `cols` = the table's column count so each
   *  new row stays rectangular. `at == row` inserts ABOVE that row, `at == row + 1` inserts BELOW it (the
   *  engine shifts every cell whose `row >= at` down by `count`). The op-bus REFUSES an out-of-range `at`
   *  or a non-table block, so a mistargeted insert surfaces an error rather than a silent no-op (031
   *  false-success 회피 — `TableInsertRows` has no ratio-collapse no-op path: it either grows the grid or
   *  throws). One undo batch. */
  async insertRows(section: number, index: number, at: number, cols: number, count = 1): Promise<number> {
    const r = Math.max(1, Math.floor(count));
    const c = Math.max(1, Math.floor(cols));
    return this.session.applyBatch([{ intent: "TableInsertRows", section, index, at, count: r, cols: c }]);
  }

  /** 이미지 삽입 (issue 050): embed a dropped/uploaded image (base64 PNG/JPEG bytes, NO `data:` prefix) at
   *  `(section, block)` — AFTER `block`, or at the section END when `block` is `null` — as ONE undo batch
   *  (`InsertImage` → the engine's `InsertImageAt` op; layout logic untouched). `size` is the display box in
   *  HWPUNIT (§4.5 commit unit; the natural-px/mm → HWPUNIT conversion lives in `units.ts::imageInsertSize`,
   *  a single point). The ENGINE detects the format from the magic bytes and validates the size cap, so a
   *  non-image / oversized payload REJECTS with a thrown op-bus error the UI toasts (거짓 성공 없음) — the
   *  caller does NOT pass an extension. Same lane on both backends (WasmAdapter/TauriAdapter route
   *  `applyIntent` → `apply_intent_json`), so the two shells insert identically (043 homomorphic parity). */
  async insertImage(
    dataB64: string,
    section: number,
    block: number | null,
    size: { width: number; height: number },
  ): Promise<number> {
    return this.session.applyBatch([
      { intent: "InsertImage", section, block, data_b64: dataB64, width: size.width, height: size.height },
    ]);
  }

  /** 룰러 (step 3): set the section's page margins (INTENT-SCHEMA `SetPageMargins`, mm). ⚠️ document-wide
   *  — the caller MUST have confirmed the whole-document effect. One undo batch (full re-flow). */
  async setPageMargins(section: number, mm: PageMarginsMm): Promise<number> {
    return this.session.applyBatch([
      { intent: "SetPageMargins", section, left_mm: mm.left, right_mm: mm.right, top_mm: mm.top, bottom_mm: mm.bottom },
    ]);
  }

  /** 텍스트 수정 (step 4, cell): replace a cell's text while PRESERVING its run styling. Reads the cell's
   *  current runs, inherits the first run's style onto the new text (runs.ts rule), and commits via
   *  `SetTableCellRuns` — NEVER the plain-text `SetTableCell` variant (issue 027 §함정). One undo batch. */
  async editCellText(section: number, index: number, row: number, col: number, newText: string): Promise<number> {
    const current = await this.session.runsAt(section, index, row, col);
    const runs = inheritRuns(current, newText);
    return this.session.applyBatch([{ intent: "SetTableCellRuns", section, index, row, col, runs }]);
  }

  /** 텍스트 수정 (step 4, paragraph): replace a simple paragraph's text preserving run styling via
   *  `SetParagraphRuns` (never `SetParagraphText`). One undo batch. */
  async editParagraphText(section: number, block: number, newText: string): Promise<number> {
    const current = await this.session.runsAt(section, block);
    const runs = inheritRuns(current, newText);
    return this.session.applyBatch([{ intent: "SetParagraphRuns", section, block, runs }]);
  }

  /** 서식 툴바 (step 5): apply a character-format patch to a rectangular cell range (`SetCellRangeFmt`).
   *  Only the SET fields change (INTENT-SCHEMA §6.8). One undo batch. */
  async formatCellRange(section: number, index: number, range: CellRange, fmt: CellFmt): Promise<number> {
    return this.session.applyBatch([
      {
        intent: "SetCellRangeFmt",
        section,
        index,
        r0: range.r0,
        c0: range.c0,
        r1: range.r1,
        c1: range.c1,
        bold: fmt.bold ?? null,
        italic: fmt.italic ?? null,
        size_pt: fmt.size_pt ?? null,
        font: fmt.font ?? null,
        color: fmt.color ?? null,
        align: fmt.align ?? null,
      },
    ]);
  }

  /** 배경색 (step 5): set/clear a rectangular cell range's background shade (`SetCellRangeShade`).
   *  `shade` is `"#RRGGBB"` or `null` to clear. One undo batch. */
  async shadeCellRange(section: number, index: number, range: CellRange, shade: string | null): Promise<number> {
    return this.session.applyBatch([
      { intent: "SetCellRangeShade", section, index, r0: range.r0, c0: range.c0, r1: range.r1, c1: range.c1, shade },
    ]);
  }

  /** Build the run-preserving `RunSpec[]` a cell/paragraph edit WOULD commit, without applying it — for a
   *  preview or a node assertion. Pure over the given current runs (runs.ts). */
  previewInheritedRuns(current: RunSpec[], newText: string): RunSpec[] {
    return inheritRuns(current, newText);
  }
}
