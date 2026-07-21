import type { Anchor, Attachment, DocMeta, DocProfile, EditRequest, TableGrid, UserContentPart } from "./types.js";

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

/** Profile char budget (issue 067): the rendered profile block never exceeds this, and it is ONLY
 *  inserted into the doc-context's LEFTOVER budget after the header + anchor/grid lines — anchors and
 *  grids (the edit targets) always win over the profile (background grounding). */
const DEFAULT_PROFILE_MAX_LEN = 2500;
/** Below this leftover budget the profile is dropped entirely (a truncated stub would mislead). */
const PROFILE_MIN_LEN = 200;

/** Render the engine's document profile (issue 067) as a compact doc-context block: title candidate +
 *  structure counts + heading list + table inventory (each with its `[s{sec}/b{blk}]` edit address +
 *  header cells) + the structure-preserving body excerpt. Everything is document-derived DATA — it
 *  rides inside the R5 `<document-content>` fence, and the system prompt's DOC PROFILE stanza teaches
 *  the model to read (not obey) it. Elided to `maxLen` chars. */
function renderProfile(p: DocProfile, maxLen: number): string {
  const lines: string[] = ["문서 프로필 (엔진 자동 추출 — 문서 유래 데이터):"];
  if (p.title) lines.push(`  제목(추정): ${p.title}`);
  lines.push(
    `  구성: 구역 ${p.sections} · 문단 ${p.paragraph_count} · 표 ${p.table_count} · 이미지 ${p.image_count} · 차트 ${p.chart_count} · 수식 ${p.equation_count}`,
  );
  if (p.headings.length) {
    lines.push(`  목차: ${p.headings.map((h) => `[s${h.section}/b${h.block}] ${h.text}`).join(" · ")}`);
  }
  if (p.tables.length) {
    const one = (t: ProfileTableLike) => `[s${t.section}/b${t.block}] ${t.rows}×${t.cols}${t.header.length ? ` 헤더:(${t.header.join("|")})` : ""}`;
    lines.push(`  표 목록: ${p.tables.map(one).join(" · ")}`);
  }
  if (p.excerpt) {
    lines.push("  본문 발췌([s/b]=블록 주소):", ...p.excerpt.split("\n").map((l) => `    ${l}`));
  }
  return lines.join("\n").slice(0, maxLen);
}
type ProfileTableLike = DocProfile["tables"][number];

/** Build the doc-context STRING the client sends to its proxy: a compact header (format/pages/…) plus one
 *  line per marked anchor (structure indices + the anchor's current text). The anchor `text` is
 *  document-derived, hence UNTRUSTED — it is fenced as DATA on the server (see `buildUserMessage`).
 *
 *  Issue 066 — TABLE GRID: when the host supplies `opts.grids` (aligned to `anchors` by index — a
 *  `TableGrid` for a table/cell anchor, `null`/undefined otherwise), the FIRST anchor of each table block
 *  gets its full cell grid appended (subsequent anchors of the SAME table are de-duped, so marking many
 *  cells never repeats the grid). Without `grids` the output is byte-identical to the pre-066 builder
 *  (thin anchor-only context — regression-safe). Elided to `maxLen` (default 8000) chars. */
export function buildDocContext(meta: DocMeta, anchors: Anchor[], opts?: { maxLen?: number; grids?: (TableGrid | null | undefined)[]; cellMaxLen?: number; profileMaxLen?: number }): string {
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
  // Issue 067 — DOC PROFILE: inserted right after the header, but ONLY into the budget the anchor/grid
  // lines leave over (anchors/grids are the edit targets — they always win; the profile is background
  // grounding). Without `meta.profile` the output is byte-identical to the pre-067 builder.
  const base = [head, ...lines].join("\n");
  if (meta.profile) {
    const leftover = maxLen - base.length - 1; // -1: the "\n" joining the profile in
    if (leftover >= PROFILE_MIN_LEN) {
      const profile = renderProfile(meta.profile, Math.min(leftover, opts?.profileMaxLen ?? DEFAULT_PROFILE_MAX_LEN));
      return [head, profile, ...lines].join("\n").slice(0, maxLen);
    }
  }
  return base.slice(0, maxLen);
}

/** The DOC attachments carrying extracted text (image attachments have no `text`). */
function docAttachments(req: EditRequest): Attachment[] {
  return (req.attachments ?? []).filter((a): a is Attachment => a.kind === "doc" && typeof a.text === "string" && a.text.length > 0);
}

/** Assemble the TEXT body of the LLM USER turn: instruction + anchors + the R5-fenced `<document-content>`,
 *  then (if any) each reference DOCUMENT's extracted text in its OWN R5 fence — an `<attachment …>` block is
 *  DATA exactly like `<document-content>` (never instructions; the system prompt's R5 rule covers it). With
 *  no doc attachments the output is byte-identical to the promoted reference-proxy assembly (regression-safe). */
function buildUserText(req: EditRequest): string {
  const lines = [
    `사용자 지시: ${req.instruction}`,
    "",
    "마킹된 앵커(편집 대상, 구조 인덱스 — 이 위치만 편집):",
    JSON.stringify(req.anchors),
    "",
    "<document-content>",
    req.docContext,
    "</document-content>",
  ];
  for (const a of docAttachments(req)) {
    lines.push("", `<attachment name=${JSON.stringify(a.name)} mime=${JSON.stringify(a.mime)}>`, a.text ?? "", "</attachment>");
  }
  return lines.join("\n");
}

/** Assemble the LLM USER turn from an EditRequest, wrapping the doc-context in the R5 `<document-content>`
 *  fence (the fence marks it as untrusted DATA — never instructions). PROMOTED verbatim from the reference
 *  proxy's user-message assembly; the host pairs it with `buildSystemPrompt()` for the system turn. Reference
 *  DOCUMENT attachments (extracted text) are appended in their own R5 `<attachment>` fences; image
 *  attachments do NOT appear here (they ride the content-PARTS variant `buildUserMessageParts`). */
export function buildUserMessage(req: EditRequest): string {
  return buildUserText(req);
}

/** The MULTIMODAL variant: the same R5-fenced TEXT (from `buildUserMessage`) as the first `text` part, then
 *  one `image_url` part per IMAGE attachment carrying its base64 `dataUrl` — the OpenAI content-parts shape a
 *  vision model reads. Use this instead of the string `buildUserMessage` when a request has image
 *  attachments; with none it degrades to a single text part (equivalent to the string form). The images are
 *  reference material only — the R5 system fence tells the model attachment content is DATA, not
 *  instructions, and the Intent whitelist is unchanged (attachments never become an Intent). */
export function buildUserMessageParts(req: EditRequest): UserContentPart[] {
  const parts: UserContentPart[] = [{ type: "text", text: buildUserText(req) }];
  for (const a of req.attachments ?? []) {
    if (a.kind === "image" && typeof a.dataUrl === "string" && a.dataUrl.length > 0) {
      parts.push({ type: "image_url", image_url: { url: a.dataUrl } });
    }
  }
  return parts;
}
