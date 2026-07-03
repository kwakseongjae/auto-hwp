import type { RunSpec } from "./types";

/// runs.ts — the PURE run-format-preservation rule for the v1 text-edit popover (issue 027 §함정: "텍스트
/// 수정은 반드시 SetTableCellRuns/SetParagraphRuns … 볼드 셀 수정 후 볼드 유지 … 평문 variant 금지").
/// The popover is a plain textarea (v1 — the desktop contentEditable WYSIWYG gotchas are NOT ported), so
/// the edit yields plain text with no per-span styling. To avoid FLATTENING a formatted cell, the new
/// text INHERITS the FIRST run's style (the documented v1 rule). Multi-line text (textarea "\n") becomes
/// one paragraph per line, EACH inheriting that style, joined by a bare `{text:"\n"}` run (the same shape
/// `blockRuns` reads back and `SetTableCellRuns` splits on — INTENT-SCHEMA §6.7).
///
/// This is pure (no adapter/DOM) so a node test can pin "bold cell edited → still bold" deterministically.

/** Just the STYLE of a run (its fields minus `text`). */
export type RunStyle = Omit<RunSpec, "text">;

/** Extract the inheritable style of the first NON-newline run (a leading "\n" separator carries no
 *  style). Returns an empty style `{}` when there are no runs (a fresh/empty target → unstyled text). */
export function firstRunStyle(runs: RunSpec[]): RunStyle {
  const first = runs.find((r) => r.text !== "\n") ?? runs[0];
  if (!first) return {};
  const { text: _text, ...style } = first;
  void _text;
  // Drop undefined/false-y-but-meaningless keys so the emitted runs stay minimal (and equal by value in
  // tests): keep only style that actually differs from the inherit default.
  const out: RunStyle = {};
  if (style.bold) out.bold = true;
  if (style.italic) out.italic = true;
  if (style.underline) out.underline = true;
  if (style.strike) out.strike = true;
  if (style.size_pt != null) out.size_pt = style.size_pt;
  if (style.color != null) out.color = style.color;
  if (style.highlight != null) out.highlight = style.highlight;
  if (style.font != null) out.font = style.font;
  return out;
}

/** Build the `RunSpec[]` for a plain-text edit that INHERITS `current`'s first-run style (issue 027).
 *  `newText` may contain "\n" (textarea multi-line) → one styled run per line, separated by bare "\n"
 *  runs (paragraph split — parity with `blockRuns`). Empty `newText` → a single empty styled run so the
 *  target is CLEARED (not left untouched). Never emits the plain-text collapse variant. */
export function inheritRuns(current: RunSpec[], newText: string): RunSpec[] {
  const style = firstRunStyle(current);
  const lines = newText.split("\n");
  const out: RunSpec[] = [];
  lines.forEach((line, i) => {
    if (i > 0) out.push({ text: "\n" });
    out.push({ text: line, ...style });
  });
  return out;
}
