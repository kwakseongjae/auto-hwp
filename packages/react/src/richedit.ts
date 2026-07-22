// richedit — WYSIWYG in-place editor helpers (issue 040, ported from the desktop R12 richedit.ts). Render a
// block's styled runs into a contentEditable, and serialize the edited DOM back to RunSpec[]. The
// contentEditable shows formatting LIVE (bold/italic/underline/strike/size/color), unlike the old plain
// textarea (issue 032). Glyph layout is the browser's during edit (approximate); the own SVG re-renders the
// exact layout on commit.
//
// The run shape is @auto-hwp/editor-core's `RunSpec` — the SAME type `blockRuns`/`runsAt` returns AND
// `SetTableCellRuns`/`SetParagraphRuns` accept, so a text edit round-trips through one type (run-format
// preservation, issue 027 §함정 / 040 교훈 6). Multi-paragraph blocks join paragraphs with a bare
// `{ text: "\n" }` run — the same shape the commit ops split on.
//
// The six desktop 교훈 (each fixed by a round-trip test — see __tests__/richedit.test.ts):
//   1. The editor renders pure #000 (styles.css `.hw-inplace-editor { color:#000 }`). rgbToHex maps exact
//      black → NO color, so untouched black text serializes color-less (inherit) and a re-commit is a no-op.
//   2. Multi-paragraph blocks split on "\n" — one <div> per paragraph — so the paragraph structure round-trips.
//   3. strike is handled in ALL THREE of render (line-through) + read (styleOf) + compare (eqStyle).
//   4. Explicitly-styled runs may drop exotic sub-attrs (v1 — RunSpec only carries B/I/U/S/size/color/font).
//   5. font is DISPLAY-only: styleOf ignores the default screen face, so no font change is ever committed.
//   6. The commit is a run-preserving SetTableCellRuns/SetParagraphRuns path (wired in HwpWorkspace) — never
//      a plain-text variant.

import type { RunSpec } from "@auto-hwp/editor-core";

const NANUM = "NanumGothic, sans-serif";
const HWPUNIT_PER_PX = 7200 / 96; // 75 — matches the Rust HWPUNIT_PER_PX
const DEFAULT_PT = 10; // an inherited (size_pt unset) run draws at the doc default ~10pt (height 1000)

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** size_pt (or default) → SCREEN px at the page's zoom `scale` (= client px / page px). 100 HWPUNIT/pt ÷ 75
 *  HWPUNIT/px = 4/3 page px per point — the SAME scale as InPlaceCellEditor's PAGE_PX_PER_PT. */
export function sizePx(sizePt: number | null | undefined, scale: number): number {
  return (((sizePt ?? DEFAULT_PT) * 100) / HWPUNIT_PER_PX) * scale;
}

/** Per-paragraph indent (SCREEN px, already ×scale) + alignment for the per-<div> editor render. Optional on
 *  the web (the wasm adapter has no per-paragraph indent query yet) — kept for parity + future wiring. */
export type ParaIndent = { indentLeft: number; indentFirst: number; indentRight: number; align: string };

/** One run → a styled <span> matching the own SVG <text>. Intra-run "\n" → <br> (a forced break). */
function spanFor(r: RunSpec, scale: number): string {
  const styles = [
    `font-family:${r.font ? `"${r.font}", ${NANUM}` : NANUM}`,
    `font-weight:${r.bold ? 700 : 400}`,
    `font-style:${r.italic ? "italic" : "normal"}`,
    `font-size:${sizePx(r.size_pt, scale).toFixed(2)}px`,
  ];
  // underline + strike combine into ONE text-decoration so a struck run actually SHOWS struck (교훈 3) — and
  // round-trips; without it strikethrough was a silent WYSIWYG lie + lost on commit.
  const deco: string[] = [];
  if (r.underline) deco.push("underline");
  if (r.strike) deco.push("line-through");
  if (deco.length) styles.push(`text-decoration:${deco.join(" ")}`);
  if (r.color) styles.push(`color:${r.color}`);
  const html = esc(r.text).replace(/\n/g, "<br>");
  return `<span style="${styles.join(";")}">${html}</span>`;
}

/** Render runs as styled <span>s matching the own SVG <text>. Set ONCE as the contentEditable innerHTML
 *  (uncontrolled) — never re-set on keystroke (would kill the caret + Korean IME).
 *
 *  Each paragraph gets its OWN <div> (split on "\n", whether a standalone join run or an embedded "\n"), so
 *  serializeEditor's "one structural trailing \n" assumption is ALWAYS correct (deterministic no-op / newline
 *  handling — 교훈 2). `paras` (one entry per paragraph, same order as the runs) is OPTIONAL indent/alignment
 *  decoration; when omitted the divs carry no indent (the web wasm adapter has no per-paragraph indent yet). */
export function runsToHtml(runs: RunSpec[], scale: number, paras?: ParaIndent[]): string {
  if (!runs.length || runs.every((r) => r.text === "")) return "<div><br></div>";
  // Split into per-paragraph groups, one <div> each. A "\n" delimits a paragraph whether it's a standalone
  // join run (editor-init runs from runsAt) or embedded in a run's text (serialized runs) — matching how the
  // commit op splits paragraphs.
  const groups: RunSpec[][] = [[]];
  for (const r of runs) {
    const parts = r.text.split("\n");
    parts.forEach((part, idx) => {
      if (idx > 0) groups.push([]); // each "\n" starts a new paragraph
      if (part !== "") groups[groups.length - 1].push({ ...r, text: part });
    });
  }
  return groups
    .map((g, i) => {
      const p = paras ? paras[Math.min(i, paras.length - 1)] : undefined;
      const style = p
        ? `padding-left:${p.indentLeft.toFixed(1)}px;text-indent:${p.indentFirst.toFixed(1)}px;`
          + `padding-right:${p.indentRight.toFixed(1)}px;text-align:${p.align || "left"}`
        : "";
      const inner = g.length && !g.every((r) => r.text === "") ? g.map((r) => spanFor(r, scale)).join("") : "<br>";
      return `<div${style ? ` style="${style}"` : ""}>${inner}</div>`;
    })
    .join("");
}

function rgbToHex(rgb: string): string | undefined {
  const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return undefined;
  const [r, g, b] = [m[1], m[2], m[3]].map((n) => parseInt(n, 10));
  if (r === 0 && g === 0 && b === 0) return undefined; // black ≈ the default text color (inherit) — 교훈 1
  return "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
}

type Style = Omit<RunSpec, "text">;

/** The EFFECTIVE char style at the current selection (caret/anchor) inside a contentEditable — for
 *  live-syncing a format ribbon as the caret moves over differently-styled text. Returns null when there's
 *  no selection or it isn't inside `root`. */
export function readCaretStyle(
  root: HTMLElement,
  scale: number,
): { bold: boolean; italic: boolean; underline: boolean; strike: boolean; size_pt: number; color: string | null } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.anchorNode || !root.contains(sel.anchorNode)) return null;
  const node = sel.anchorNode;
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement);
  const st = styleOf(el, scale);
  return {
    bold: !!st.bold,
    italic: !!st.italic,
    underline: !!st.underline,
    strike: !!st.strike,
    size_pt: st.size_pt ?? DEFAULT_PT,
    color: st.color ?? null,
  };
}

/** The EFFECTIVE styles of a text node's nearest element, read from the computed style (works no matter how
 *  the style was applied — execCommand spans/<b>/<i>, our render spans, inline styles all compute the same).
 *  strike is read here (교훈 3); font is only kept when it differs from the default screen face (교훈 5). */
function styleOf(el: HTMLElement | null, scale: number): Style {
  if (!el) return {};
  const cs = getComputedStyle(el);
  const st: Style = {};
  // font-weight is "700"/"bold" (execCommand styleWithCSS or a <b>) — handle both the numeric + keyword forms.
  const fw = cs.fontWeight || "";
  if (fw === "bold" || fw === "bolder" || parseInt(fw, 10) >= 600) st.bold = true;
  if (cs.fontStyle === "italic" || cs.fontStyle === "oblique") st.italic = true;
  const deco = `${cs.textDecorationLine || ""} ${cs.textDecoration || ""}`;
  if (deco.includes("underline")) st.underline = true;
  if (deco.includes("line-through")) st.strike = true;
  const px = parseFloat(cs.fontSize);
  // 2-dp round (HWP height is 1/100pt) so a non-integer imported size — e.g. 12.34pt — round-trips exactly
  // instead of snapping to 12.3 and writing a spurious size change on an untouched run.
  if (px > 0 && scale > 0) st.size_pt = Math.round(((px * HWPUNIT_PER_PX) / 100 / scale) * 100) / 100;
  const hex = rgbToHex(cs.color);
  if (hex) st.color = hex;
  const fam = (cs.fontFamily || "").split(",")[0].replace(/["']/g, "").trim();
  if (fam && fam !== "NanumGothic" && fam !== "sans-serif") st.font = fam;
  return st;
}

function eqStyle(a: Style, b: Style): boolean {
  return (
    !!a.bold === !!b.bold &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline &&
    !!a.strike === !!b.strike &&
    // An inherited-size run (size_pt unset, e.g. an HWPX/AI run with CharShape height 0) renders at the
    // DEFAULT and serializes back as DEFAULT_PT — getComputedStyle can never report "inherited". Treat unset
    // and DEFAULT_PT as equal so opening such a run and leaving isn't a spurious size-pinning write.
    (a.size_pt ?? DEFAULT_PT) === (b.size_pt ?? DEFAULT_PT) &&
    (a.color ?? null) === (b.color ?? null) &&
    (a.font ?? null) === (b.font ?? null)
  );
}

/** Walk the contentEditable DOM → RunSpec[]: each text segment's computed style → a run; adjacent same-style
 *  segments merge; <br> and browser block boundaries (div/p on Enter) → "\n" in the run text; &nbsp; → space.
 *  Empty editor → one empty run. */
export function serializeEditor(root: HTMLElement, scale: number): RunSpec[] {
  const runs: RunSpec[] = [];
  const addText = (text: string, st: Style) => {
    if (!text) return;
    const last = runs[runs.length - 1];
    if (last && eqStyle(last, st)) last.text += text;
    else runs.push({ text, ...st });
  };
  const addBreak = () => {
    if (runs.length) runs[runs.length - 1].text += "\n";
  };
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = (node.textContent ?? "").replace(/ /g, " "); // &nbsp; → space
      if (t) addText(t, styleOf(node.parentElement, scale));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (el.tagName === "BR") {
      // A <br> that is the LAST child of its block is WebKit's "filler" br (it makes an empty block visible);
      // the block's own boundary already emits the newline, so counting the filler too would double a blank
      // line. Only a <br> with following content is a real intra-block line break.
      if (el.nextSibling) addBreak();
      return;
    }
    Array.from(el.childNodes).forEach(walk);
    if (/^(DIV|P)$/.test(el.tagName)) addBreak(); // a browser-injected block boundary
  };
  Array.from(root.childNodes).forEach(walk);
  // A trailing block boundary appends a spurious newline — trim one.
  if (runs.length) {
    const last = runs[runs.length - 1];
    if (last.text.endsWith("\n")) last.text = last.text.slice(0, -1);
    if (last.text === "" && runs.length > 1) runs.pop();
  }
  return runs.length ? runs : [{ text: "" }];
}

/** The plain text of the runs (for the ribbon state / a text baseline). */
export function runsText(runs: RunSpec[]): string {
  return runs.map((r) => r.text).join("");
}

/** Deep-equal two run lists (text + style) — the commit no-op check building block. */
export function runsEqual(a: RunSpec[], b: RunSpec[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => x.text === b[i].text && eqStyle(x, b[i]));
}

/** Canonicalize a run list to the exact shape serializeEditor would emit, so the no-op compare is robust to
 *  (a) runsAt's standalone "\n" paragraph-join runs — a <br>/block boundary attaches to the PRECEDING span on
 *  round-trip, folding its (default) style away — and (b) all-empty blocks, which runsToHtml renders as one
 *  styleless empty run. Without this, opening a multi-paragraph or empty cell and clicking away (zero edits)
 *  failed runsEqual and fired a spurious write + undo unit. */
export function canonRuns(runs: RunSpec[]): RunSpec[] {
  if (runs.every((r) => r.text === "")) return [{ text: "" }];
  const out: RunSpec[] = [];
  for (const r of runs) {
    const { text, ...st } = r;
    if (text === "\n" && out.length) {
      out[out.length - 1].text += "\n";
      continue;
    } // paragraph-join run
    const last = out[out.length - 1];
    if (last && eqStyle(last as Style, st as Style)) last.text += text;
    else out.push({ text, ...st });
  }
  if (out.length) {
    const last = out[out.length - 1];
    if (last.text.endsWith("\n")) last.text = last.text.slice(0, -1); // serializeEditor trims one trailing \n
    if (last.text === "" && out.length > 1) out.pop();
  }
  return out.length ? out : [{ text: "" }];
}

/** The commit no-op check: did the edit change nothing? Compares canonicalized forms so the synthetic
 *  paragraph-join "\n" runs + all-empty blocks don't read as a spurious change (미접촉 셀 재커밋 = no-op). */
export function runsUnchanged(serialized: RunSpec[], baseline: RunSpec[]): boolean {
  return runsEqual(canonRuns(serialized), canonRuns(baseline));
}

/** Wrap the current selection in a <span> with the given CSS (for size/color/font, which execCommand can't do
 *  precisely). No-op on a collapsed selection. */
function wrapSelectionStyle(css: string): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  if (range.collapsed) return;
  const span = document.createElement("span");
  span.style.cssText = css;
  try {
    range.surroundContents(span);
  } catch {
    // The range crosses element boundaries → extract its contents and wrap them.
    span.appendChild(range.extractContents());
    range.insertNode(span);
  }
  sel.removeAllRanges();
  const r = document.createRange();
  r.selectNodeContents(span);
  sel.addRange(r);
}

// The inline editor's selection at the moment a ribbon control was PRESSED. A native <select>/color <input>
// can't preventDefault its focus the way the B/I buttons do, so it blurs the contentEditable and the
// selection is lost by the time onChange fires — save it on the control's mousedown and restore it before
// applying, so the style lands on the live SELECTION (not the whole cell).
let savedRange: Range | null = null;
export function saveInlineSelection(): void {
  const el = document.querySelector("[data-inline-edit]") as HTMLElement | null;
  const sel = window.getSelection();
  if (el && sel && sel.rangeCount && el.contains(sel.anchorNode)) {
    savedRange = sel.getRangeAt(0).cloneRange();
  }
}

/** Apply a format LIVE to the inline editor's current selection (⌘B/⌘I/⌘U + the ribbon while editing):
 *  bold/italic/underline/strike/color toggle via execCommand; size/font wrap the selection in a styled span.
 *  Visible immediately, no SVG repaint — the styled DOM is serialized to runs on commit. execCommand is
 *  deprecated but is the desktop-verified path (실측: all current engines support bold/italic/underline/
 *  strikeThrough/foreColor with styleWithCSS); the own SVG is the source of truth on commit. */
export function applyLiveStyle(
  patch: { bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; sizePt?: number; font?: string; color?: string },
  scale: number,
): void {
  const el = document.querySelector("[data-inline-edit]") as HTMLElement | null;
  if (!el) return;
  // Only re-focus + restore when the selection is NOT already inside the editor (a ribbon <select>/color
  // input stole focus). For the ⌘B/⌘I keyboard path the editor ALREADY holds the live selection — calling
  // focus() there disturbs it (it shifted the styled range to the wrong side of the caret), so leave it be.
  const cur = window.getSelection();
  const selInside = !!cur && cur.rangeCount > 0 && !!cur.anchorNode && el.contains(cur.anchorNode);
  if (!selInside) {
    el.focus();
    if (savedRange) {
      cur?.removeAllRanges();
      cur?.addRange(savedRange);
    }
  }
  try {
    document.execCommand("styleWithCSS", false, "true");
  } catch {
    /* older webview */
  }
  if (patch.bold !== undefined) document.execCommand("bold");
  if (patch.italic !== undefined) document.execCommand("italic");
  if (patch.underline !== undefined) document.execCommand("underline");
  if (patch.strike !== undefined) document.execCommand("strikeThrough");
  if (patch.font !== undefined) wrapSelectionStyle(`font-family:${patch.font ? `"${patch.font}", ${NANUM}` : NANUM}`);
  if (patch.sizePt !== undefined) wrapSelectionStyle(`font-size:${sizePx(patch.sizePt, scale).toFixed(2)}px`);
  // 글자색 — execCommand foreColor (styleWithCSS already on) colors the live selection; serializeEditor reads
  // the computed color back per run, so it round-trips on commit.
  if (patch.color !== undefined) document.execCommand("foreColor", false, patch.color);
}
