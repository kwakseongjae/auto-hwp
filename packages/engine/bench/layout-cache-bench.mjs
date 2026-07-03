// Layout-cache benchmark (issue 025) — proves the wasm `HwpDoc` typesets a document ONCE and answers
// many geometry queries from the cached `PlacedDoc` instead of re-paginating on every click/drag.
//
// It measures, on benchmark1.hwp (18 pages, the heavy self-diagnosis doc), with a real font registered
// (the representative app state — the lab auto-registers NanumGothic on open):
//   (a) 100 consecutive hitTest calls
//        • BEFORE (uncached): each call is forced to re-typeset (fingerprint toggled) → old behaviour.
//        • AFTER  (cached):   the cache serves calls 2..100 → placeBuilds == 1.
//   (b) renderPageSvg after one edit: the first call re-renders the whole doc (revision-keyed svg
//        cache), subsequent pages are cache hits.
//
// Run:  node packages/engine/bench/layout-cache-bench.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initEngineSync, HwpDoc } from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');

const wasmBytes = readFileSync(join(here, '..', 'pkg', 'hwp_wasm_bg.wasm'));
initEngineSync({ module: wasmBytes });

const docBytes = readFileSync(join(repo, 'benchmarks', 'benchmark1.hwp'));
const fontBytes = new Uint8Array(readFileSync(join(repo, 'assets', 'fonts', 'NanumGothic-Regular.ttf')));

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const ms = (n) => `${n.toFixed(2)}ms`;

const doc = HwpDoc.open(docBytes, 'benchmark1.hwp');
doc.registerFont('bench', fontBytes); // representative: metrics driven by the injected face
const pages = doc.pageCount();
if (pages !== 18) throw new Error(`expected 18 pages, got ${pages}`);

// A page-0 point that resolves to a block (hitTest returns the nearest band, so any in-page point hits).
const P = { page: 0, x: 120, y: 220 };
const N = 100;

// ---- (a) AFTER: cached 100 hitTests -----------------------------------------------------------
const before = doc.placedStats();
const tA0 = performance.now();
let sink = null;
for (let i = 0; i < N; i++) sink = doc.hitTest(P.page, P.x, P.y);
const tA1 = performance.now();
const afterStats = doc.placedStats();
const totalAfter = tA1 - tA0;
const builtDuringCached = afterStats.placeBuilds - before.placeBuilds;

// Sanity: the cached result must be a real hit and stable.
if (!sink) throw new Error('hitTest returned null — pick a point over content');

// ---- (a) BEFORE: uncached 100 hitTests (force a re-typeset per call) ---------------------------
// Toggling the registered font family flips the cache fingerprint, so every hitTest is a cold miss —
// exactly what the pre-025 code did on every query (place_doc + geometry). registerFont itself is a
// trivial Vec swap; the cost measured is dominated by the re-pagination.
const b0 = doc.placedStats().placeBuilds;
const perCall = [];
const tB0 = performance.now();
for (let i = 0; i < N; i++) {
  doc.registerFont(i % 2 === 0 ? 'benchA' : 'benchB', fontBytes); // flip fingerprint → invalidate
  const s = performance.now();
  doc.hitTest(P.page, P.x, P.y);
  perCall.push(performance.now() - s);
}
const tB1 = performance.now();
const builtDuringUncached = doc.placedStats().placeBuilds - b0;
const totalBefore = tB1 - tB0;

// ---- (b) renderPageSvg after one edit ---------------------------------------------------------
// Apply a real edit so the revision bumps (both the svg cache AND the placed cache invalidate), then
// time the first full re-render vs a subsequent cached page.
doc.registerFont('bench', fontBytes); // settle back to a single stable font
// Find an editable paragraph so the edit is a real content mutation (bumps the revision → both the
// svg cache and the placed cache invalidate, the true "편집 1회 후" state).
let editTarget = null;
outer: for (let py = 60; py < 1000 && !editTarget; py += 20) {
  for (let px = 60; px < 500; px += 40) {
    const h = doc.hitTest(0, px, py);
    if (h && h.editable && h.kind === 'paragraph') { editTarget = h; break outer; }
  }
}
let edited = false;
if (editTarget) {
  const o = doc.applyIntent({ intent: 'SetParagraphText', section: editTarget.section, block: editTarget.block, text: '캐시 벤치 편집' });
  edited = o.kind === 'edited' || o.kind === 'applied';
}
if (!edited) doc.registerFont('bench2', fontBytes); // fallback: still force an svg-cache miss
const tR0 = performance.now();
doc.renderPageSvg(0); // full document re-render (revision-keyed svg cache miss)
const tR1 = performance.now();
const tRhit0 = performance.now();
doc.renderPageSvg(Math.min(5, pages - 1)); // same revision → svg cache hit
const tRhit1 = performance.now();

doc.free();

// ---- Report -----------------------------------------------------------------------------------
const speedup = totalBefore / totalAfter;
console.log('=== issue 025 layout-cache bench — benchmark1.hwp (18 pages, NanumGothic registered) ===');
console.log(`(a) 100× hitTest`);
console.log(`    BEFORE (re-typeset each call): total ${ms(totalBefore)}  ·  ~${ms(totalBefore / N)}/call  ·  placeBuilds=${builtDuringUncached}`);
console.log(`    AFTER  (cached placement):     total ${ms(totalAfter)}  ·  ~${ms(totalAfter / N)}/call  ·  placeBuilds=${builtDuringCached} placeHits=${afterStats.placeHits - before.placeHits}`);
console.log(`    speedup: ${speedup.toFixed(1)}×   (uncached median/call ${ms(median(perCall))})`);
console.log(`(b) renderPageSvg after ${edited ? 'an edit' : 'a forced invalidation'}`);
console.log(`    first page (full re-render of ${pages} pages): ${ms(tR1 - tR0)}`);
console.log(`    another page (svg cache hit):                 ${ms(tRhit1 - tRhit0)}`);

// Machine-readable line for the report.
console.log('BENCH_JSON ' + JSON.stringify({
  pages,
  hitTest: { n: N, beforeMs: totalBefore, afterMs: totalAfter, speedup, placeBuildsCached: builtDuringCached, placeBuildsUncached: builtDuringUncached },
  render: { edited, firstMs: tR1 - tR0, cachedPageMs: tRhit1 - tRhit0 },
}));

if (builtDuringCached !== 1) throw new Error(`FAIL: cached 100× hitTest re-typeset ${builtDuringCached} times (expected 1)`);
console.log('OK: 문서 불변 시 place_doc 1회 (placeBuilds=1 across 100 cached hitTests)');
