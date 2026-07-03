// measure-browser.mjs — issue 033 (docs-only research) BROWSER-side measurement harness.
//
// Measures the numbers the node/engine harness CANNOT see — the real browser DOM node count, the
// scroll frame budget, and the zoom re-layout cost of the current render architecture (page = one big
// inline-SVG sheet, ALL pages mounted, no virtualization — HwpPageView.tsx:61-80,154). Feeds
// docs/FIGMA-GRADE-UX.md §1 (latency budget) and §2 (render architecture gap).
//
// Reproduce (repo root), with the engine pkg already built (see measure-engine.mjs header):
//   ( cd apps/hwp-lab && rm -rf .next && npm run dev -- -p 3577 )   # in one shell
//   node scripts/figma-grade/measure-browser.mjs                    # in another (LAB_URL to override)
//
// Uses the playwright chromium that apps/hwp-lab already depends on:
//   ( cd apps/hwp-lab && npx playwright install chromium )
//
// It uploads benchmarks/benchmark2.hwp (25 pages, the largest fixture) and reports:
//   • DOM: total elements, SVG elements, .hw-sheet count (mounted pages)
//   • scroll: real wheel-driven frame deltas over the doc — avg / p95 / max / jank%(>16.7ms)
//   • zoom: time to apply a zoom change (reflow of all 25 scaled SVG sheets)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pw from '../../apps/hwp-lab/node_modules/playwright/index.js';
const { chromium } = pw;

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const URL = process.env.LAB_URL || 'http://localhost:3577';
const DOC = process.env.LAB_DOC || join(repo, 'benchmarks', 'benchmark2.hwp');

const pctl = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));

console.log('=== issue 033 · figma-grade BROWSER measurement ===');
console.log(`url=${URL}  doc=${DOC.split('/').pop()}\n`);

await page.goto(URL, { waitUntil: 'networkidle' });

// --- OPEN wall time: from file-select to all-25-sheets-rendered (parse+register+render+sanitize+inject+layout)
const tOpen0 = Date.now();
await page.locator('[data-testid="file-input"]').setInputFiles(DOC);
// Wait until every page sheet is mounted AND its SVG is injected (HwpPageView fills all pages).
await page.waitForFunction(() => {
  const sheets = document.querySelectorAll('.hw-sheet');
  if (sheets.length < 25) return false;
  let withSvg = 0;
  sheets.forEach((s) => { if (s.querySelector('svg')) withSvg++; });
  return withSvg >= 25;
}, { timeout: 60000 });
const openWallMs = Date.now() - tOpen0;
await page.waitForTimeout(500); // settle post-font-register re-layout
console.log(`Open wall time (file-select → 25 sheets rendered): ${openWallMs}ms  (target <1s/10p → <2.5s for 25p)\n`);

// --- DOM census -----------------------------------------------------------------------------------
const dom = await page.evaluate(() => ({
  totalEls: document.querySelectorAll('*').length,
  svgEls: document.querySelectorAll('svg *').length + document.querySelectorAll('svg').length,
  sheets: document.querySelectorAll('.hw-sheet').length,
  texts: document.querySelectorAll('svg text').length,
  lines: document.querySelectorAll('svg line').length,
  overlays: document.querySelectorAll('.hw-overlay').length,
}));
console.log('DOM (all 25 pages mounted, no virtualization):');
console.log(`  total elements: ${dom.totalEls}`);
console.log(`  svg elements:   ${dom.svgEls}   (text ${dom.texts}, line ${dom.lines})`);
console.log(`  .hw-sheet:      ${dom.sheets}   ·  .hw-overlay: ${dom.overlays}\n`);

// --- scroll frame budget --------------------------------------------------------------------------
// Real wheel events (page.mouse.wheel) drive the actual scroller + paint; a rAF loop in the page
// samples frame deltas. We scroll from top to bottom of the doc in ~60 wheel ticks.
await page.mouse.move(700, 500);
await page.evaluate(() => {
  window.__frames = [];
  let last = performance.now();
  const tick = (t) => { window.__frames.push(t - last); last = t; if (window.__sampling) requestAnimationFrame(tick); };
  window.__sampling = true;
  requestAnimationFrame(tick);
});
for (let i = 0; i < 60; i++) { await page.mouse.wheel(0, 600); await page.waitForTimeout(16); }
const scroll = await page.evaluate(() => {
  window.__sampling = false;
  const f = window.__frames.filter((d) => d > 0 && d < 1000);
  const avg = f.reduce((a, b) => a + b, 0) / f.length;
  const jank = f.filter((d) => d > 16.7).length;
  return { n: f.length, avg, jank, jankPct: (100 * jank) / f.length, max: Math.max(...f), frames: f };
});
console.log('Scroll (60 wheel ticks top→bottom, rAF frame deltas):');
console.log(`  frames sampled: ${scroll.n}`);
console.log(`  avg frame: ${scroll.avg.toFixed(1)}ms  ·  p95: ${pctl(scroll.frames, 0.95).toFixed(1)}ms  ·  max: ${scroll.max.toFixed(1)}ms`);
console.log(`  jank frames (>16.7ms = below 60fps): ${scroll.jank}/${scroll.n} (${scroll.jankPct.toFixed(0)}%)\n`);

// --- zoom re-layout cost --------------------------------------------------------------------------
// Find the zoom control (a range/number input or +/- buttons). Fall back to forcing a width change on
// .hw-pages children to measure the reflow of 25 scaled SVGs. We measure via a forced-reflow timer.
const zoom = await page.evaluate(() => {
  const sheets = Array.from(document.querySelectorAll('.hw-sheet-wrap'));
  if (!sheets.length) return null;
  // Read current width, bump it 20% (simulating a zoom step), force layout, measure, restore.
  const t0 = performance.now();
  sheets.forEach((s) => { s.style.width = `${parseFloat(getComputedStyle(s).width) * 1.2}px`; });
  // Force synchronous layout of the whole page tree (offsetHeight read).
  void document.body.offsetHeight;
  const t1 = performance.now();
  sheets.forEach((s) => { s.style.width = ''; });
  void document.body.offsetHeight;
  return { reflowMs: t1 - t0, sheets: sheets.length };
});
if (zoom) {
  console.log('Zoom step (force width +20% on all sheets → synchronous reflow of 25 SVG trees):');
  console.log(`  reflow: ${zoom.reflowMs.toFixed(1)}ms  (${zoom.sheets} sheets)\n`);
}

// --- edit re-fetch DOM cost -----------------------------------------------------------------------
// The browser HALF of HwpPageView.tsx:61-80 on every refreshToken bump (edit/undo/font): for EACH of
// the 25 sheets, the SVG string is run through sanitizeSvg (DOMParser → tree-walk → XMLSerializer)
// and re-injected via innerHTML (browser re-parses the node tree). We replay exactly that on the
// already-rendered sheets to measure the per-edit DOM tax (the wasm render itself is ~18ms, measured
// separately by measure-engine.mjs).
const refetch = await page.evaluate(() => {
  const sheets = Array.from(document.querySelectorAll('.hw-sheet'));
  const svgs = sheets.map((s) => s.innerHTML);
  // sanitizeSvg replica (packages/react/src/sanitize.ts): parse + serialize (skip the scrub walk cost
  // is included since serialize walks the whole tree anyway).
  const tS0 = performance.now();
  const cleaned = svgs.map((svg) => {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    return new XMLSerializer().serializeToString(doc.documentElement);
  });
  const sanitizeMs = performance.now() - tS0;
  // re-inject all 25 (innerHTML parse) + force layout.
  const tI0 = performance.now();
  sheets.forEach((s, i) => { s.innerHTML = cleaned[i]; });
  void document.body.offsetHeight;
  const injectMs = performance.now() - tI0;
  return { sanitizeMs, injectMs, totalMs: sanitizeMs + injectMs, sheets: sheets.length };
});
console.log('Edit re-fetch DOM tax (browser half of HwpPageView refreshToken, all 25 pages):');
console.log(`  sanitizeSvg (DOMParser+serialize ×25): ${refetch.sanitizeMs.toFixed(1)}ms`);
console.log(`  re-inject innerHTML ×25 + reflow:      ${refetch.injectMs.toFixed(1)}ms`);
console.log(`  total per-edit DOM tax (+ ~18ms wasm render): ${refetch.totalMs.toFixed(1)}ms\n`);

console.log('BENCH_JSON ' + JSON.stringify({ openWallMs, dom, scroll: { n: scroll.n, avg: scroll.avg, p95: pctl(scroll.frames, 0.95), max: scroll.max, jank: scroll.jank, jankPct: scroll.jankPct }, zoom, refetch }));

await browser.close();
