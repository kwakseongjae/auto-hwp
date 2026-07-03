// measure-virtualization-037.mjs — issue 037 BEFORE/AFTER for page virtualization.
//
// Measures the DOM-element count and the MOUNTED-sheet count of the real 25-page benchmark2 DOM two ways in
// one session, on the same machine + same doc, so the comparison is apples-to-apples:
//
//   BEFORE (pre-037: every page mounted): forced via the measurement hook `window.__hwVirtDisabled = true`,
//          which makes HwpPageView fall back to the all-mounted render path (byte-for-byte the 034 behaviour).
//   AFTER  (037: only the pages near the viewport ± buffer stay mounted as heavy SVG sheets; the rest are
//          same-size blank placeholders). Proves the mounted-SVG count collapses to ≤ 6 while all 25
//          `.hw-sheet` DOM slots survive (the data-page + exact-size contract), and that a far page RESTORES
//          its SVG when scrolled into view.
//
// Reproduce (repo root), engine pkg + react built + lab dev server up (see measure-browser.mjs header):
//   ( cd apps/hwp-lab && rm -rf .next && npm run dev -- -p 3577 )   # one shell
//   node scripts/figma-grade/measure-virtualization-037.mjs         # another (LAB_URL/LAB_DOC to override)

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pw from '../../apps/hwp-lab/node_modules/playwright/index.js';
const { chromium } = pw;

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const URL = process.env.LAB_URL || 'http://localhost:3577';
const DOC = process.env.LAB_DOC || join(repo, 'benchmarks', 'benchmark2.hwp');
const EXPECT_PAGES = Number(process.env.LAB_PAGES || 25);

const browser = await chromium.launch();
// Same viewport as measure-browser.mjs (issue 033) so the mounted-sheet count is comparable across issues.
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));

console.log('=== issue 037 · page-virtualization BEFORE/AFTER ===');
console.log(`url=${URL}  doc=${DOC.split('/').pop()}  expect ${EXPECT_PAGES}p\n`);

const census = () =>
  page.evaluate(() => {
    const sheets = Array.from(document.querySelectorAll('.hw-sheet'));
    return {
      totalEls: document.querySelectorAll('*').length,
      svgRoots: document.querySelectorAll('svg').length,
      svgInner: document.querySelectorAll('svg *').length,
      sheets: sheets.length,
      mounted: sheets.filter((s) => s.querySelector('svg')).length, // sheets that carry a real SVG
      placeholders: document.querySelectorAll('.hw-sheet-placeholder').length,
    };
  });

/** Open the doc; when `disableVirt`, flip the measurement hook BEFORE the workspace mounts so the render
 *  takes the all-mounted path. Wait until the expected number of `.hw-sheet` slots exist (+ settle). */
async function openDoc(disableVirt) {
  await page.goto(URL, { waitUntil: 'networkidle' });
  if (disableVirt) await page.addInitScript(() => { window.__hwVirtDisabled = true; });
  // addInitScript only applies to the NEXT navigation, so reload once after arming it.
  if (disableVirt) await page.goto(URL, { waitUntil: 'networkidle' });
  await page.locator('[data-testid="file-input"]').setInputFiles(DOC);
  await page.waitForFunction((n) => document.querySelectorAll('.hw-sheet').length >= n, EXPECT_PAGES, { timeout: 90000 });
  if (disableVirt) {
    // BEFORE: wait until EVERY sheet has an SVG (the all-mounted state we are measuring).
    await page.waitForFunction((n) => {
      const s = Array.from(document.querySelectorAll('.hw-sheet'));
      return s.length >= n && s.every((x) => x.querySelector('svg'));
    }, EXPECT_PAGES, { timeout: 90000 });
  }
  await page.waitForTimeout(1200); // settle post-font re-layout + IntersectionObserver
}

// ── BEFORE: all pages mounted ──────────────────────────────────────────────────────────────────────
await openDoc(true);
const before = await census();
console.log('BEFORE (virtualization OFF — every page mounted, pre-037 / 034 path):');
console.log(`  total elements: ${before.totalEls}`);
console.log(`  svg roots: ${before.svgRoots}  ·  svg inner nodes: ${before.svgInner}`);
console.log(`  .hw-sheet: ${before.sheets}  ·  mounted (with svg): ${before.mounted}  ·  placeholders: ${before.placeholders}\n`);

// ── AFTER: virtualized ─────────────────────────────────────────────────────────────────────────────
await page.addInitScript(() => { delete window.__hwVirtDisabled; }); // clear the hook for the next nav
await openDoc(false);
const after = await census();
console.log('AFTER (037 — only viewport ± buffer mounted; rest are blank placeholders):');
console.log(`  total elements: ${after.totalEls}`);
console.log(`  svg roots: ${after.svgRoots}  ·  svg inner nodes: ${after.svgInner}`);
console.log(`  .hw-sheet: ${after.sheets}  ·  mounted (with svg): ${after.mounted}  ·  placeholders: ${after.placeholders}`);
console.log(`  ⇒ mounted SVG sheets ${after.mounted} (target ≤ 6), .hw-sheet slots preserved: ${after.sheets}/${EXPECT_PAGES}\n`);

// ── AFTER: scroll re-entry restores a far page's SVG ────────────────────────────────────────────────
const last = EXPECT_PAGES - 1;
const beforeScroll = await page.evaluate((p) => !!document.querySelector(`.hw-sheet[data-page="${p}"] svg`), last);
await page.locator(`.hw-sheet[data-page="${last}"]`).scrollIntoViewIfNeeded();
await page.waitForFunction((p) => !!document.querySelector(`.hw-sheet[data-page="${p}"] svg`), last, { timeout: 30000 });
const afterScroll = await page.evaluate((p) => !!document.querySelector(`.hw-sheet[data-page="${p}"] svg`), last);
console.log(`Scroll re-entry: last page (#${last}) had svg BEFORE scroll = ${beforeScroll}; AFTER scroll = ${afterScroll}  (expect false → true)\n`);

const drop = (a, b) => `${a} → ${b}  (−${a - b}, ${((100 * (a - b)) / a).toFixed(1)}% fewer)`;
console.log('SUMMARY');
console.log(`  DOM elements:  ${drop(before.totalEls, after.totalEls)}`);
console.log(`  mounted SVG sheets: ${before.mounted} → ${after.mounted}`);
console.log('BENCH037_JSON ' + JSON.stringify({ pages: EXPECT_PAGES, before, after, reentry: { before: beforeScroll, after: afterScroll } }));

await browser.close();
