import type { CellAddr, Intent } from "./types";

/// Host-defined editable regions + intent veto (issue #368).
///
/// Form-filling hosts (application forms, HR forms, contracts) want users to type ONLY into value cells
/// or a few body paragraphs while labels, structure (column widths, row heights, row insert, block
/// delete, page margins, images) and the rest of the body stay untouched. An `EditPolicy` gives the
/// host two hooks:
///  - `editable(target)` — a synchronous predicate over a TYPED edit target. It gates caret placement
///    (a click on a non-editable target places no caret AND dismisses the current one), the inline
///    editors, the structural handles, and — as the last line — every Intent before it reaches the
///    engine (`DocSession` checks every target of every Intent).
///  - `beforeApply(intents)` — sees each batch after the predicate passed; return `false` to veto it,
///    `true` to let it through, or a replacement `Intent[]` (re-checked against `editable`).
/// A vetoed batch throws `EditVetoedError` (`code: "edit_vetoed"`) BEFORE any adapter call, so the
/// document and the undo stack are untouched.

/** What an edit touches. `intent` names the Intent (or gesture) asking. */
export type EditTarget =
  /** Text/format of ONE table cell (`SetTableCellRuns`, `SetTableCell`, `SetTableCellShade`). */
  | { kind: "cell"; section: number; block: number; row: number; col: number; path?: CellAddr[]; intent: string }
  /** Text/format of ONE body paragraph (`SetParagraphRuns`, `SplitParagraph`, `MergeParagraph`, …). */
  | { kind: "paragraph"; section: number; block: number; intent: string }
  /** Structure at/around a block: delete/move/insert blocks, table rows/columns/sizes, images,
   *  cell-range formatting. `block` is null for an append/insert without a position. */
  | { kind: "block"; section: number; block: number | null; intent: string }
  /** Document-wide edits (page margins, replace-all, content/edit scripts) and unknown Intents. */
  | { kind: "document"; section: number | null; intent: string };

export interface EditPolicy {
  editable?: (target: EditTarget) => boolean;
  beforeApply?: (intents: Intent[]) => boolean | Intent[];
}

/** Thrown by `DocSession` when a policy refuses a batch. The document and undo stack are untouched. */
export class EditVetoedError extends Error {
  readonly code = "edit_vetoed";
  constructor(
    readonly intents: Intent[],
    readonly target: EditTarget | null,
  ) {
    super(target ? `edit vetoed: ${target.intent} on a non-editable ${target.kind}` : "edit vetoed by beforeApply");
    this.name = "EditVetoedError";
  }
}

/** Read-only Intents — no target, never vetoed. */
const READ_ONLY = new Set([
  "PageCount",
  "Render",
  "ExtractText",
  "Find",
  "HitTest",
  "CaretRect",
  "HitTestCell",
  "CaretRectCell",
  "HitTestBody",
  "CaretRectBody",
  "BlockRunsPath",
  "TableGrid",
  "DocProfile",
  "DiscardProposal",
]);

const CELL = new Set(["SetTableCell", "SetTableCellRuns", "SetTableCellShade"]);
const PARAGRAPH = new Set(["SetParagraphText", "SetParagraphRuns", "SetCharFmt", "SetRunCharFmt", "SplitParagraph", "MergeParagraph"]);
const BLOCK_AT_INDEX = new Set([
  "DeleteBlock",
  "DeleteNestedBlock",
  "SetImageSize",
  "TableInsertRows",
  "TableAppendRow",
  "SetTableColWidths",
  "SetTableRowHeights",
  "SetCellRangeShade",
  "SetCellRangeFmt",
  "InsertTableAt",
  "InsertParagraphAt",
  "InsertChartAt",
]);
const BLOCK_MOVE = new Set(["MoveBlock", "MoveImage"]);

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The edit targets an Intent touches (`[]` for a read-only Intent). Unknown Intents map to a
 *  `document` target so a restrictive predicate refuses them by default. `ProposeIntents` maps to the
 *  targets of the Intents it carries. */
export function intentTargets(intent: Intent): EditTarget[] {
  const name = intent.intent;
  if (READ_ONLY.has(name)) return [];
  const section = num(intent.section) ?? 0;
  if (name === "ProposeIntents") {
    const inner = Array.isArray(intent.intents) ? (intent.intents as Intent[]) : [];
    return inner.flatMap(intentTargets);
  }
  if (CELL.has(name)) {
    const block = num(intent.index) ?? num(intent.block) ?? 0;
    const path = Array.isArray(intent.path) ? (intent.path as CellAddr[]) : undefined;
    const leaf = path && path.length > 0 ? path[path.length - 1] : null;
    return [
      {
        kind: "cell",
        section,
        block,
        row: leaf ? leaf.row : (num(intent.row) ?? 0),
        col: leaf ? leaf.col : (num(intent.col) ?? 0),
        ...(path && path.length > 1 ? { path } : {}),
        intent: name,
      },
    ];
  }
  if (PARAGRAPH.has(name)) return [{ kind: "paragraph", section, block: num(intent.block) ?? 0, intent: name }];
  if (BLOCK_AT_INDEX.has(name)) return [{ kind: "block", section, block: num(intent.index) ?? num(intent.block), intent: name }];
  if (name === "InsertImage") return [{ kind: "block", section, block: num(intent.block), intent: name }];
  if (BLOCK_MOVE.has(name)) {
    return [
      { kind: "block", section, block: num(intent.from), intent: name },
      { kind: "block", section, block: num(intent.to), intent: name },
    ];
  }
  return [{ kind: "document", section: num(intent.section), intent: name }];
}
