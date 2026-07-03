import { describeIntent } from "./describeIntent";
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

  /** 표 추가 (step 2): append a fresh `rows × cols` empty table at the document END via `ApplyContent`
   *  (the existing insert path — no `InsertTableAt` op exists; see the issue note). One undo batch. */
  async insertTable(rows: number, cols: number, section = 0): Promise<number> {
    const r = Math.max(1, Math.floor(rows));
    const c = Math.max(1, Math.floor(cols));
    const grid = Array.from({ length: r }, () => Array.from({ length: c }, () => ""));
    const json = JSON.stringify({ blocks: [{ type: "table", header: [], rows: grid }] });
    void section; // ApplyContent appends to the live doc; section kept for signature symmetry.
    return this.session.applyBatch([{ intent: "ApplyContent", json }]);
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
