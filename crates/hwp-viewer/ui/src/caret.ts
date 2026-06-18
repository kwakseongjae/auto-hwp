/// Pure coordinate-map + offset helpers for the interactive caret. NO DOM imports — every function
/// takes plain numbers/objects so this module is headless-unit-testable (see the self-check at the
/// bottom, gated behind an explicit runCaretSelfChecks() that App.tsx never calls in production).
///
/// COORDINATE SPACES
///  - PAGE units: the injected <svg>'s viewBox space (rhwp px page units, e.g. 793.7 × 1122.48).
///    hit_test takes page-unit (x,y); caret_rect returns page-unit { x, top, height }.
///  - CSS px: on-screen pixels relative to the page's <svg> box (svg.getBoundingClientRect()), which
///    already folds in scroll position and the width:100%/height:auto scale.
/// The two scale by the live rect/viewBox ratio (the implicit 1:1 wrapper ratio holds while there is
/// no zoom — a future zoom feature would need an explicit scale; out of v1 scope).

/** A rectangle's on-screen geometry — only the fields the math needs. */
export type RectLike = { left: number; top: number; width: number; height: number };
/** A viewBox's page-unit dimensions (vb.width === the svg width attr per ground truth). */
export type VbLike = { width: number; height: number };
/** A caret rectangle in PAGE units (mirrors api.CaretRect; duplicated here to keep this DOM-free). */
export type CaretRectLike = { x: number; top: number; height: number };

/** Forward map: an on-screen click (clientX/clientY) → PAGE-unit (x,y) to feed api.hitTest.
 *  Returns null when the page isn't laid out yet (any zero dimension → divide-by-zero guard). */
export function screenToPage(
  clientX: number,
  clientY: number,
  rect: RectLike,
  vb: VbLike,
): { x: number; y: number } | null {
  if (rect.width === 0 || rect.height === 0 || vb.width === 0 || vb.height === 0) return null;
  return {
    x: ((clientX - rect.left) / rect.width) * vb.width,
    y: ((clientY - rect.top) / rect.height) * vb.height,
  };
}

/** Inverse map: a PAGE-unit caret rect → CSS-px box {left,top,height} relative to the .page-svg box.
 *  Returns null on any zero dimension (page not laid out yet). */
export function pageToScreen(
  caret: CaretRectLike,
  rect: { width: number; height: number },
  vb: VbLike,
): { left: number; top: number; height: number } | null {
  if (rect.width === 0 || rect.height === 0 || vb.width === 0 || vb.height === 0) return null;
  return {
    left: (caret.x / vb.width) * rect.width,
    top: (caret.top / vb.height) * rect.height,
    height: (caret.height / vb.height) * rect.height,
  };
}

/** Advance a paragraph char offset past `text`, counting UNICODE SCALARS (NOT UTF-16 code units, NOT
 *  bytes) so multi-scalar Korean syllables and astral emoji move the caret by the correct amount.
 *  `[...text]` iterates by code point; the engine's offset is a Unicode-scalar count over the
 *  paragraph's concatenated run text. */
export function advanceOffset(offset: number, text: string): number {
  return offset + [...text].length;
}

/// ---- headless self-checks (NOT executed in the app; call from a node/tsx scratch run if wanted) ----
/// vitest is not installed, so this is a tiny no-dep assertion harness kept tsc-clean. It exercises
/// the round-trip and the divide-by-zero / unicode-scalar contracts from the spec's pure_helpers_to_test.
export function runCaretSelfChecks(): { passed: number; failed: number } {
  let passed = 0;
  let failed = 0;
  const ok = (cond: boolean, label: string) => {
    if (cond) passed++;
    else {
      failed++;
      // eslint-disable-next-line no-console
      console.error(`caret self-check FAILED: ${label}`);
    }
  };
  const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

  const rect: RectLike = { left: 100, top: 50, width: 400, height: 600 };
  const vb: VbLike = { width: 800, height: 1200 };

  // screenToPage / pageToScreen round-trip: a click maps to page units, then a caret at that x/top
  // maps back to the same CSS-px offset within epsilon.
  const p = screenToPage(100 + 200, 50 + 300, rect, vb); // mid of the box
  ok(p !== null, "screenToPage non-null on valid dims");
  ok(p !== null && near(p.x, 400) && near(p.y, 600), "screenToPage scales by rect/vb ratio");
  const back = pageToScreen({ x: p!.x, top: p!.y, height: 24 }, rect, vb);
  ok(back !== null && near(back.left, 200) && near(back.top, 300), "pageToScreen inverts screenToPage");
  ok(back !== null && near(back.height, (24 / vb.height) * rect.height), "pageToScreen scales height");

  // identity when rect == vb dimensions
  const idRect = { left: 0, top: 0, width: 800, height: 1200 };
  const id = pageToScreen({ x: 123, top: 456, height: 24 }, idRect, vb);
  ok(id !== null && near(id.left, 123) && near(id.top, 456) && near(id.height, 24), "pageToScreen identity when rect==vb");

  // divide-by-zero guards
  ok(screenToPage(0, 0, { left: 0, top: 0, width: 0, height: 10 }, vb) === null, "screenToPage null on zero rect.width");
  ok(screenToPage(0, 0, rect, { width: 0, height: 10 }) === null, "screenToPage null on zero vb.width");
  ok(pageToScreen({ x: 1, top: 1, height: 1 }, { width: 10, height: 0 }, vb) === null, "pageToScreen null on zero rect.height");
  ok(pageToScreen({ x: 1, top: 1, height: 1 }, { width: 10, height: 10 }, { width: 10, height: 0 }) === null, "pageToScreen null on zero vb.height");

  // advanceOffset counts unicode scalars, not UTF-16 units / bytes
  ok(advanceOffset(0, "a") === 1, "advanceOffset ASCII");
  ok(advanceOffset(3, "가") === 4, "advanceOffset single Hangul syllable = 1 scalar"); // precomposed syllable
  ok(advanceOffset(0, "안녕") === 2, "advanceOffset 2 Hangul = 2 scalars");
  ok(advanceOffset(0, "😀") === 1, "advanceOffset astral emoji = 1 scalar (2 UTF-16 units)");
  ok(advanceOffset(5, "") === 5, "advanceOffset empty string no-op");

  return { passed, failed };
}

// Run the pure-math self-checks at DEV startup (Vite sets import.meta.env.DEV) so a coordinate-map /
// offset regression fails loudly the moment you `cargo tauri dev` — the exact env where the caret is
// visually verified. Tree-shaken out of the production bundle by the DEV guard.
if (import.meta.env.DEV) {
  const r = runCaretSelfChecks();
  if (r.failed > 0) throw new Error(`caret.ts self-checks failed: ${r.failed}/${r.passed + r.failed}`);
}
