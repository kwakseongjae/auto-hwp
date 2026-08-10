import type { Anchor, Attachment, DocMeta, DocProfile, EditRequest, ParaRun, TableGrid, UserContentPart } from "./types.js";

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

/** Leading markers a Korean 개요/불릿 문단 opens with. A paragraph whose text is ONLY one of these (plus
 *  whitespace) is a bullet line WAITING for its content — the fill belongs on that same line, after the
 *  marker. All single scalars, so a plain `startsWith` scan is unambiguous. */
const BULLET_MARKERS = ["◦", "○", "●", "・", "·", "□", "■", "◇", "◆", "▪", "▫", "▶", "‣", "※", "-", "–", "—", "*"];

/** Below this authored size a BLANK paragraph is a layout GAP, not a slot: Korean body text runs
 *  10–14pt, while a form's spacer lines are the 4–8pt blank paragraphs that open vertical space.
 *  A heuristic on a stated fact — the size itself is always printed, so the model can judge too. */
const SPACER_PT_MAX = 10;

/** The marker a paragraph's text opens with, or `null`. */
function leadingMarker(text: string): string | null {
  const t = text.trim();
  return BULLET_MARKERS.find((m) => t.startsWith(m)) ?? null;
}

/** Render the SHAPE hint of a marked PARAGRAPH anchor from the engine's runs (불릿 채움): the authored
 *  point size(s) plus a role the model can act on —
 *    · `불릿 "◦" 줄 14.0pt — 내용 없음`      the item's content belongs on THIS line, after the marker,
 *    · `빈 문단 6.0pt — 줄간격 스페이서`     a blank line far below body size: a GAP, not an empty slot,
 *    · `빈 문단 12.0pt — 내용 없는 줄`       a blank line at body size (an ordinary writable empty line),
 *    · `본문 12.0pt`                        an ordinary text paragraph.
 *  Returns `""` when there is nothing worth saying (no runs), so the anchor line stays as-is. */
function renderParaShape(runs: ParaRun[]): string {
  if (!runs.length) return "";
  const text = runs.map((r) => r.text).join("");
  // Prefer the TEXT-bearing runs' sizes; a wholly blank paragraph falls back to its (blank) runs —
  // that size IS the fact we need to expose, since it is what any fill would render at.
  const sizesOf = (rs: ParaRun[]): number[] => [...new Set(rs.map((r) => r.size_pt).filter((s): s is number => typeof s === "number" && s > 0))];
  const withText = runs.filter((r) => r.text.trim() !== "");
  const sizes = withText.length ? sizesOf(withText) : sizesOf(runs);
  const size = sizes.length ? `${sizes.map((s) => s.toFixed(1)).join("/")}pt` : "크기 미지정";
  const marker = leadingMarker(text);
  if (text.trim() === "") {
    const small = sizes.length > 0 && Math.max(...sizes) < SPACER_PT_MAX;
    return ` 문단서식=[빈 문단 ${size} — ${small ? "줄간격 스페이서" : "내용 없는 줄"}]`;
  }
  if (marker && text.trim() === marker) return ` 문단서식=[불릿 "${marker}" 줄 ${size} — 내용 없음]`;
  if (marker) return ` 문단서식=[불릿 "${marker}" 줄 ${size}]`;
  return ` 문단서식=[본문 ${size}]`;
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
 *  (thin anchor-only context — regression-safe). Elided to `maxLen` (default 8000) chars.
 *
 *  불릿 채움 — PARAGRAPH SHAPE: when the host supplies `opts.paraRuns` (aligned to `anchors` by index —
 *  the engine's `blockRuns` for a paragraph anchor, `null`/undefined otherwise), each paragraph anchor
 *  line gains a `문단서식=[…]` hint naming its authored point size and its role (불릿 줄 / 빈 문단
 *  스페이서 / 본문). Without it a 6pt blank spacer and a 14pt bullet line look identical (`text=""` vs
 *  `text="◦"`) and the model fills the spacer — the text then renders far smaller than the form's body,
 *  detached from its bullet. Absent `paraRuns` ⇒ byte-identical to the previous builder. */
export function buildDocContext(meta: DocMeta, anchors: Anchor[], opts?: { maxLen?: number; grids?: (TableGrid | null | undefined)[]; cellMaxLen?: number; profileMaxLen?: number; paraRuns?: (ParaRun[] | null | undefined)[] }): string {
  const maxLen = opts?.maxLen ?? 8000;
  const cellMaxLen = opts?.cellMaxLen ?? DEFAULT_CELL_MAX_LEN;
  const head = `format=${meta.format} pages=${meta.pages} editable=${meta.editable} sections=${meta.sections}`;
  const gridded = new Set<string>(); // dedup grids by "section:block" — one grid per marked table
  const lines = anchors.map((a, i) => {
    const rows = a.rows ? ` rows=[${a.rows[0]},${a.rows[1]}]` : "";
    const cols = a.cols ? ` cols=[${a.cols[0]},${a.cols[1]}]` : "";
    const runs = opts?.paraRuns?.[i];
    const shape = runs && runs.length ? renderParaShape(runs) : "";
    const line = `#${i} ${a.kind} section=${a.section} block=${a.block}${rows}${cols} text=${JSON.stringify(a.text ?? "")}${shape}`;
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

/** Prevent document-derived text from manufacturing one of our literal closing fence tags. The model
 *  still sees the characters as escaped DATA, while only the builder can emit raw `<` / `>` delimiters. */
function escapeFenceMarkup(value: string): string {
  return value.replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

/** Assemble the TEXT body of the LLM USER turn. Only the user's explicit instruction is outside the
 *  R5 fence: both structural anchors (including document-derived label/text) and docContext live inside
 *  `<document-content>`. Reference documents use a second `<attachment>` fence whose metadata + text is
 *  one escaped JSON value. This prevents anchor text, filenames, or document content from closing a DATA
 *  fence and masquerading as a new instruction. */
function buildUserText(req: EditRequest): string {
  const lines = [
    `사용자 지시: ${req.instruction}`,
    "",
    "<document-content>",
    escapeFenceMarkup(req.docContext),
    "",
    "마킹된 앵커(편집 대상, 구조 인덱스 — 이 위치만 편집):",
    escapeFenceMarkup(JSON.stringify(req.anchors)),
    "</document-content>",
  ];
  for (const a of docAttachments(req)) {
    lines.push(
      "",
      "<attachment>",
      escapeFenceMarkup(JSON.stringify({ name: a.name, mime: a.mime, text: a.text ?? "" })),
      "</attachment>",
    );
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
