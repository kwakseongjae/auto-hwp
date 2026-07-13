import type { Anchor, DocMeta, EditRequest, TableGrid } from "./types.js";

/// Doc-context assembly (SDK-LAYERS: "buildDocContext(session, anchors) — R5 펜스 포함"). PROMOTED from
/// apps/hwp-lab's LabWorkspace.buildDocContextString + the route handler's user-message assembly so the
/// CLIENT (which sends the doc-context string) and the SERVER (which R5-fences it into the LLM turn)
/// share one implementation. Pure string building — no fetch, no key.

/** Per-cell text budget in a rendered grid (issue 066 토큰예산): a cell longer than this is elided with
 *  "…" so a big table can't blow the doc-context. Newlines are collapsed to " / " (one line per row). */
const DEFAULT_CELL_MAX_LEN = 60;

/** Render ONE table's grid as compact rows the model can read (issue 066). Format (proven with Grok A/B):
 *  a `(N행 M열)` header + one line per row, each cell as `(r{r}c{c})<값>` with `_빈칸_` for an empty cell —
 *  so the model sees which cells are labels, which are blank value cells, and the exact `(row, col)`
 *  address `SetTableCell` targets. Only ACTIVE cells appear (covered/merged slots are absent, matching the
 *  edit lane's coverage). Each value is elided to `cellMaxLen`. */
function renderGrid(grid: TableGrid, cellMaxLen: number): string {
  const cell = (text: string): string => {
    const flat = text.replace(/\s*\n\s*/g, " / ").trim();
    if (flat === "") return "_빈칸_";
    return flat.length > cellMaxLen ? `${flat.slice(0, cellMaxLen)}…` : flat;
  };
  const lines: string[] = [`  표 그리드 (${grid.rows}행 ${grid.cols}열, 셀주소 r=행 c=열, _빈칸_=빈 셀):`];
  for (let r = 0; r < grid.rows; r++) {
    const cols = grid.cells
      .filter((c) => c.row === r)
      .sort((a, b) => a.col - b.col)
      .map((c) => `(r${c.row}c${c.col})${cell(c.text)}`);
    if (cols.length) lines.push(`    ${cols.join(" | ")}`);
  }
  return lines.join("\n");
}

/** Build the doc-context STRING the client sends to its proxy: a compact header (format/pages/…) plus one
 *  line per marked anchor (structure indices + the anchor's current text). The anchor `text` is
 *  document-derived, hence UNTRUSTED — it is fenced as DATA on the server (see `buildUserMessage`).
 *
 *  Issue 066 — TABLE GRID: when the host supplies `opts.grids` (aligned to `anchors` by index — a
 *  `TableGrid` for a table/cell anchor, `null`/undefined otherwise), the FIRST anchor of each table block
 *  gets its full cell grid appended (subsequent anchors of the SAME table are de-duped, so marking many
 *  cells never repeats the grid). Without `grids` the output is byte-identical to the pre-066 builder
 *  (thin anchor-only context — regression-safe). Elided to `maxLen` (default 8000) chars. */
export function buildDocContext(meta: DocMeta, anchors: Anchor[], opts?: { maxLen?: number; grids?: (TableGrid | null | undefined)[]; cellMaxLen?: number }): string {
  const maxLen = opts?.maxLen ?? 8000;
  const cellMaxLen = opts?.cellMaxLen ?? DEFAULT_CELL_MAX_LEN;
  const head = `format=${meta.format} pages=${meta.pages} editable=${meta.editable} sections=${meta.sections}`;
  const gridded = new Set<string>(); // dedup grids by "section:block" — one grid per marked table
  const lines = anchors.map((a, i) => {
    const rows = a.rows ? ` rows=[${a.rows[0]},${a.rows[1]}]` : "";
    const cols = a.cols ? ` cols=[${a.cols[0]},${a.cols[1]}]` : "";
    const line = `#${i} ${a.kind} section=${a.section} block=${a.block}${rows}${cols} text=${JSON.stringify(a.text ?? "")}`;
    const grid = opts?.grids?.[i];
    const key = `${a.section}:${a.block}`;
    if (grid && grid.rows > 0 && !gridded.has(key)) {
      gridded.add(key);
      return `${line}\n${renderGrid(grid, cellMaxLen)}`;
    }
    return line;
  });
  return [head, ...lines].join("\n").slice(0, maxLen);
}

/** Assemble the LLM USER turn from an EditRequest, wrapping the doc-context in the R5 `<document-content>`
 *  fence (the fence marks it as untrusted DATA — never instructions). PROMOTED verbatim from the reference
 *  proxy's user-message assembly; the host pairs it with `buildSystemPrompt()` for the system turn. */
export function buildUserMessage(req: EditRequest): string {
  return [
    `사용자 지시: ${req.instruction}`,
    "",
    "마킹된 앵커(편집 대상, 구조 인덱스 — 이 위치만 편집):",
    JSON.stringify(req.anchors),
    "",
    "<document-content>",
    req.docContext,
    "</document-content>",
  ].join("\n");
}
