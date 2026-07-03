// measure-edit-tax-034.mjs — issue 034 BEFORE/AFTER for the edit-reflect DOM tax.
//
// Reuses the SAME "edit re-fetch DOM tax" metric as scripts/figma-grade/measure-browser.mjs (DOMParser+
// serialize sanitize + innerHTML re-inject, on the real 25-page benchmark2 DOM), but measures it TWO ways
// in one session so the comparison is apples-to-apples on the same machine + same DOM:
//
//   BEFORE (what HwpPageView did pre-034): every refreshToken bump re-sanitized + re-injected ALL pages.
//   AFTER  (issue 034): compare each page's RAW svg string to its previous value FIRST, and only
//          sanitize + inject the page(s) that actually changed. A single-cell edit changes exactly one
//          page, so the DOM tax collapses from "×25" to "×1" (plus 25 cheap string compares).
//
// The comparison is on the RAW string BEFORE sanitize (issue 034 §함정: sanitize 후 비교는 세금 그대로).
//
// Reproduce (repo root), engine pkg + lab dev server already up (see measure-browser.mjs header):
//   ( cd apps/hwp-lab && rm -rf .next && npm run dev -- -p 3577 )   # one shell
//   node scripts/figma-grade/measure-edit-tax-034.mjs               # another (LAB_URL/LAB_DOC to override)

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pw from '../../apps/hwp-lab/node_modules/playwright/index.js';
const { chromium } = pw;

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const URL = process.env.LAB_URL || 'http://localhost:3577';
const DOC = process.env.LAB_DOC || join(repo, 'benchmarks', 'benchmark2.hwp');
const REPEAT = Number(process.env.REPEAT || 5);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));

console.log('=== issue 034 · edit-reflect DOM tax BEFORE/AFTER ===');
console.log(`url=${URL}  doc=${DOC.split('/').pop()}  repeat=${REPEAT}\n`);

await page.goto(URL, { waitUntil: 'networkidle' });
await page.locator('[data-testid="file-input"]').setInputFiles(DOC);
await page.waitForFunction(() => {
  const sheets = document.querySelectorAll('.hw-sheet');
  if (sheets.length < 25) return false;
  let withSvg = 0;
  sheets.forEach((s) => { if (s.querySelector('svg')) withSvg++; });
  return withSvg >= 25;
}, { timeout: 60000 });
await page.waitForTimeout(500); // settle post-font-register re-layout

const result = await page.evaluate((repeat) => {
  const sheets = Array.from(document.querySelectorAll('.hw-sheet'));
  // The current (already-injected) svg strings stand in for the per-page RAW svg the adapter returns.
  const prevRaw = sheets.map((s) => s.innerHTML);

  // sanitizeSvg replica (packages/react/src/sanitize.ts): DOMParser parse → XMLSerializer serialize.
  const sanitize = (svg) => new XMLSerializer().serializeToString(
    new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement,
  );
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

  // ---- BEFORE: re-sanitize + re-inject ALL pages (pre-034 behaviour) ----
  const beforeRuns = [];
  for (let r = 0; r < repeat; r++) {
    const t0 = performance.now();
    const cleaned = prevRaw.map(sanitize);          // sanitize ×25
    sheets.forEach((s, i) => { s.innerHTML = cleaned[i]; }); // inject ×25
    void document.body.offsetHeight;                // force layout
    beforeRuns.push(performance.now() - t0);
  }

  // ---- AFTER: an edit changes exactly ONE page; diff RAW strings, sanitize+inject only the changed one ----
  const afterRuns = [];
  let injectedCount = -1;
  for (let r = 0; r < repeat; r++) {
    // Simulate the edit: page 12's raw svg changes (append a harmless comment), the other 24 are identical.
    const editedPage = 12;
    const newRaw = prevRaw.slice();
    newRaw[editedPage] = newRaw[editedPage].replace('</svg>', '<!--edit--></svg>');

    const t0 = performance.now();
    let injected = 0;
    for (let p = 0; p < sheets.length; p++) {
      if (prevRaw[p] === newRaw[p]) continue;      // cheap RAW string compare → skip unchanged page
      sheets[p].innerHTML = sanitize(newRaw[p]);   // pay sanitize + inject for the changed page only
      injected++;
    }
    void document.body.offsetHeight;               // force layout
    afterRuns.push(performance.now() - t0);
    injectedCount = injected;
    // restore for the next repeat
    sheets[editedPage].innerHTML = sanitize(prevRaw[editedPage]);
  }

  return {
    pages: sheets.length,
    beforeMs: median(beforeRuns), beforeRuns,
    afterMs: median(afterRuns), afterRuns, injectedCount,
  };
}, REPEAT);

const f = (x) => x.toFixed(1);
console.log(`pages mounted: ${result.pages}\n`);
console.log('BEFORE (pre-034: re-sanitize+re-inject ALL pages on every edit):');
console.log(`  median ${f(result.beforeMs)}ms   runs=[${result.beforeRuns.map(f).join(', ')}]\n`);
console.log(`AFTER (034: raw-diff → sanitize+inject only the ${result.injectedCount} changed page):`);
console.log(`  median ${f(result.afterMs)}ms   runs=[${result.afterRuns.map(f).join(', ')}]  (target ≤15ms)\n`);
console.log(`speedup: ${(result.beforeMs / result.afterMs).toFixed(1)}×`);
console.log('BENCH034_JSON ' + JSON.stringify({ pages: result.pages, beforeMs: result.beforeMs, afterMs: result.afterMs, injectedCount: result.injectedCount }));

await browser.close();
