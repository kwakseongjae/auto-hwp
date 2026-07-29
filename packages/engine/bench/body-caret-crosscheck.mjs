// Body-caret engine/API cross-check (W3 handoff, 2026-07-28).
//
// Compares the new PlacedGlyph-backed engine surface against the CURRENT editor-core SVG-alignment
// workaround on the three layout gates. The workaround is the reference for migration compatibility,
// not a second layout truth: an engine-only result on a page-split paragraph is expected (the JS layer
// deliberately returns null when one page's SVG cannot align to the whole model paragraph).
//
// Run after rebuilding packages/engine/pkg:
//   node packages/engine/bench/body-caret-crosscheck.mjs
//
// Emits one machine-readable BODY_CARET_CROSSCHECK_JSON line. Hard gates are renderer-independent:
// visible PlacedGlyph x equality, the glyph baseline inside the engine LineSeg caret box, every
// non-null hit embedding a caret on its queried page, and engine rect→hit address/offset round-trip.
// SVG-estimated whitespace/paragraph-end widths and the old glyph-font-size caret height remain
// diagnostic, with their disagreements explicitly counted.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HwpDoc, initEngineSync } from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const wasm = readFileSync(join(here, '..', 'pkg', 'hwp_wasm_bg.wasm'));
const font = new Uint8Array(readFileSync(join(repo, 'assets', 'fonts', 'NanumGothic-Regular.ttf')));
initEngineSync({ module: wasm });

const DOCS = [
  ['benchmark.hwp', 8],
  ['benchmark1.hwp', 18],
  ['benchmark2.hwp', 24],
];
const TOL = 0.06; // SVG serializes coordinates to 2 decimals; allow a little rounding headroom.

const uniq = (xs) => [...new Set(xs)];
const dist = (a, b) => Math.abs(a - b);
const clampOffset = (n, len) => Math.min(Math.max(0, Number.isFinite(n) ? Math.trunc(n) : 0), len);
const runsText = (runs) => runs.map((r) => r.text).join('');

// Frozen copy of the CURRENT editor-core SVG workaround's pure geometry helpers. Keep this script
// directly runnable with plain Node: editor-core's tsc dist intentionally uses bundler-style
// extensionless ESM imports, which Node cannot import by itself. The production source of record is
// packages/editor-core/src/bodyCaret.ts; this copy is comparison-only and must disappear when the
// editor switches to bodyTextHit/bodyCaretRect.
const BASELINE_RATIO = 0.85;
const FALLBACK_ADV_WIDE = 1.0;
const FALLBACK_ADV_NARROW = 0.5;
const FALLBACK_SPACE = 0.3;
const BASELINE_EPS = 0.05;
const ATTR_RE = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
const TEXT_RE = /<text\s([^>]*)>([^<]*)<\/text>/g;
const isWs = (ch) => /\s/.test(ch);

function unescapeXml(s) {
  return s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function parsePageGlyphs(svg) {
  const out = [];
  TEXT_RE.lastIndex = 0;
  let m;
  while ((m = TEXT_RE.exec(svg))) {
    let x = NaN;
    let y = NaN;
    let size = NaN;
    ATTR_RE.lastIndex = 0;
    let a;
    while ((a = ATTR_RE.exec(m[1]))) {
      if (a[1] === 'x') x = parseFloat(a[2]);
      else if (a[1] === 'y') y = parseFloat(a[2]);
      else if (a[1] === 'font-size') size = parseFloat(a[2]);
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push({ x, baseline: y, size: Number.isFinite(size) ? size : 0, text: unescapeXml(m[2]) });
  }
  return out;
}

function glyphsInBand(glyphs, band) {
  return glyphs
    .filter((g) => g.baseline > band.y && g.baseline <= band.y + band.h + 0.5)
    .sort((a, b) => a.baseline - b.baseline || a.x - b.x);
}

function isWide(ch) {
  const c = ch.codePointAt(0) ?? 0;
  return (
    (c >= 0x1100 && c <= 0x11ff) ||
    (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6)
  );
}

function medianValue(xs) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[(s.length - 1) >> 1];
}

function calibrate(text, glyphs, modelIdx, lineOf) {
  const wide = [];
  const narrow = [];
  const pairs = [];
  for (let i = 0; i + 1 < glyphs.length; i++) {
    if (lineOf[i] !== lineOf[i + 1]) continue;
    const size = glyphs[i].size || glyphs[i + 1].size;
    if (!(size > 0)) continue;
    const gap = glyphs[i + 1].x - glyphs[i].x;
    if (!(gap > 0)) continue;
    const k = modelIdx[i + 1] - modelIdx[i] - 1;
    const ch = text[modelIdx[i]];
    if (k === 0) (isWide(ch) ? wide : narrow).push(gap / size);
    else pairs.push({ gap, k, ch, size });
  }
  const advWide = medianValue(wide) ?? FALLBACK_ADV_WIDE;
  const advNarrow = medianValue(narrow) ?? FALLBACK_ADV_NARROW;
  const advRatio = (ch) => (isWide(ch) ? advWide : advNarrow);
  const spaces = pairs
    .map((p) => (p.gap - advRatio(p.ch) * p.size) / (p.k * p.size))
    .filter((r) => r > 0.02 && r < 1.5);
  return { advRatio, spaceRatio: medianValue(spaces) ?? FALLBACK_SPACE };
}

function alignCharBoxes(text, glyphs) {
  if (glyphs.length === 0 || text.length === 0) return null;
  const modelIdx = [];
  for (let i = 0; i < text.length; i++) if (!isWs(text[i])) modelIdx.push(i);
  if (modelIdx.length !== glyphs.length) return null;
  const lineOf = [];
  const lineBaseline = [];
  const lineHeight = [];
  for (let k = 0; k < glyphs.length; k++) {
    const g = glyphs[k];
    if (k === 0 || Math.abs(g.baseline - lineBaseline.at(-1)) > BASELINE_EPS) {
      lineBaseline.push(g.baseline);
      lineHeight.push(g.size);
    } else if (g.size > lineHeight.at(-1)) {
      lineHeight[lineHeight.length - 1] = g.size;
    }
    lineOf.push(lineBaseline.length - 1);
  }
  const { advRatio, spaceRatio } = calibrate(text, glyphs, modelIdx, lineOf);
  const boxes = new Array(text.length);
  const put = (i, x, adv, line) => {
    boxes[i] = { x, adv, baseline: lineBaseline[line], lineHeight: lineHeight[line], line };
  };
  let cursor = glyphs[0].x;
  let prevSize = glyphs[0].size || 1;
  let k = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (k < glyphs.length && modelIdx[k] === i) {
      const g = glyphs[k];
      const line = lineOf[k];
      const size = g.size || prevSize;
      const next =
        k + 1 < glyphs.length && lineOf[k + 1] === line && modelIdx[k + 1] === i + 1
          ? glyphs[k + 1]
          : null;
      const adv = next ? next.x - g.x : advRatio(ch) * size;
      put(i, g.x, adv, line);
      cursor = g.x + adv;
      prevSize = size;
      k++;
      continue;
    }
    const line = k === 0 ? lineOf[0] : lineOf[k - 1];
    const size = (k < glyphs.length ? glyphs[k].size : 0) || prevSize;
    const spaceAdv = spaceRatio * size;
    if (k === 0) {
      let n = 0;
      for (let j = i; j < text.length && modelIdx[0] !== j; j++) n++;
      let x = glyphs[0].x - n * spaceAdv;
      for (let j = 0; j < n; j++, i++) {
        put(i, x, spaceAdv, line);
        x += spaceAdv;
      }
      i--;
      cursor = glyphs[0].x;
      continue;
    }
    put(i, cursor, spaceAdv, line);
    cursor += spaceAdv;
  }
  return boxes.every(Boolean) ? boxes : null;
}

function emptyParaBoxes(band, count = 1) {
  if (!(band.h > 0)) return [];
  const box = {
    x: band.x,
    adv: 0,
    baseline: band.y + band.h * BASELINE_RATIO,
    lineHeight: band.h,
    line: 0,
  };
  return Array.from({ length: Math.max(1, count) }, () => ({ ...box }));
}

function bodyCaretRectAt(boxes, offset, page) {
  if (boxes.length === 0) return null;
  const o = clampOffset(offset, boxes.length);
  const b = o < boxes.length ? boxes[o] : boxes.at(-1);
  const x = o < boxes.length ? b.x : b.x + b.adv;
  return { page, x, top: b.baseline - b.lineHeight * BASELINE_RATIO, height: b.lineHeight };
}

function offsetInLine(boxes, line, x) {
  let first = -1;
  let last = -1;
  for (let i = 0; i < boxes.length; i++) {
    if (boxes[i].line !== line) continue;
    if (first < 0) first = i;
    last = i;
  }
  if (first < 0) return 0;
  for (let i = first; i <= last; i++) if (x < boxes[i].x + boxes[i].adv / 2) return i;
  return last + 1;
}

function bodyOffsetAtPoint(boxes, x, y) {
  if (boxes.length === 0) return 0;
  const lines = new Map();
  for (const b of boxes) if (!lines.has(b.line)) lines.set(b.line, b);
  let best = -1;
  let bestDist = Infinity;
  for (const [line, b] of lines) {
    const top = b.baseline - b.lineHeight * BASELINE_RATIO;
    if (y >= top && y <= top + b.lineHeight) return offsetInLine(boxes, line, x);
    const d = y < top ? top - y : y - (top + b.lineHeight);
    if (d < bestDist) {
      bestDist = d;
      best = line;
    }
  }
  return offsetInLine(boxes, best, x);
}

const totals = {
  docs: [],
  bands: 0,
  jsAlignedBands: 0,
  jsUnalignedBands: 0,
  engineOnlyBands: 0,
  engineUnresolvedJsMissBands: 0,
  ghostNextFragmentResolved: 0,
  ghostNextFragmentUnresolved: 0,
  utf16SkippedBands: 0,
  emptyOrWhitespaceBands: 0,
  hitChecks: 0,
  hitOffsetMatches: 0,
  hitAddressMismatches: 0,
  hitOffsetMismatches: 0,
  hitCaretPageChecks: 0,
  hitCaretPageMatches: 0,
  hitCaretPageMismatches: 0,
  estimatedHitChecks: 0,
  estimatedHitOffsetDivergences: 0,
  rectChecks: 0,
  rectWithinTolerance: 0,
  rectMismatches: 0,
  rectXChecks: 0,
  rectXWithinTolerance: 0,
  rectXMismatches: 0,
  baselineContainmentChecks: 0,
  baselineContainmentMatches: 0,
  baselineContainmentMismatches: 0,
  engineRoundTripChecks: 0,
  engineRoundTripMatches: 0,
  engineRoundTripMismatches: 0,
  estimatedRectChecks: 0,
  estimatedRectDivergences: 0,
  maxDx: 0,
  maxDy: 0,
  maxDh: 0,
  strictRectMismatchSamples: [],
  rectMismatchSamples: [],
  hitMismatchSamples: [],
  hitCaretPageMismatchSamples: [],
  engineRoundTripMismatchSamples: [],
  jsUnalignedSamples: [],
};
const queryMs = { hit: [], rect: [] };
const runStarted = performance.now();
const timed = (bucket, fn) => {
  const started = performance.now();
  const value = fn();
  queryMs[bucket].push(performance.now() - started);
  return value;
};
const checkHitCaretPage = (hit, queriedPage, context) => {
  if (!hit) return;
  totals.hitCaretPageChecks++;
  if (hit.caret?.page === queriedPage) {
    totals.hitCaretPageMatches++;
  } else {
    totals.hitCaretPageMismatches++;
    if (totals.hitCaretPageMismatchSamples.length < 12) {
      totals.hitCaretPageMismatchSamples.push({
        ...context,
        queriedPage,
        offset: hit.offset,
        caretPage: hit.caret?.page ?? null,
      });
    }
  }
};

for (const [name, expectedPages] of DOCS) {
  const doc = HwpDoc.open(readFileSync(join(repo, 'benchmarks', name)), name);
  try {
    doc.registerFont('NanumGothic', font);
    const pages = doc.pageCount();
    if (pages !== expectedPages) {
      throw new Error(`${name}: expected own-render ${expectedPages} pages, got ${pages}`);
    }
    const perDoc = {
      name,
      pages,
      bands: 0,
      jsAlignedBands: 0,
      jsUnalignedBands: 0,
      engineOnlyBands: 0,
      hitChecks: 0,
      hitOffsetMatches: 0,
      rectChecks: 0,
      rectWithinTolerance: 0,
      rectXChecks: 0,
      rectXWithinTolerance: 0,
      engineRoundTripChecks: 0,
      engineRoundTripMatches: 0,
    };

    for (let page = 0; page < pages; page++) {
      const geom = doc.pageGeometry(page);
      const bands = doc
        .blocksInRect(page, 0, 0, geom?.w ?? 1e6, geom?.h ?? 1e6)
        .filter((b) => b.kind === 'paragraph' && b.editable);
      const glyphs = parsePageGlyphs(doc.renderPageSvg(page));

      for (const band of bands) {
        totals.bands++;
        perDoc.bands++;
        const text = runsText(doc.blockRuns(band.section, band.block));
        if (text.trim().length === 0) totals.emptyOrWhitespaceBands++;
        // The current JS helper indexes UTF-16 code units; the engine/edit bus indexes Unicode scalars.
        // None of the gate docs are expected to hit this, but don't label that known model difference a
        // geometry regression if an astral char appears later.
        if ([...text].length !== text.length) {
          totals.utf16SkippedBands++;
          continue;
        }
        const boxes =
          text.trim().length === 0
            ? emptyParaBoxes(band, text.length)
            : alignCharBoxes(text, glyphsInBand(glyphs, band));
        if (!boxes) {
          totals.jsUnalignedBands++;
          perDoc.jsUnalignedBands++;
          const engine = timed('hit', () =>
            doc.bodyTextHit(
              page,
              band.x + Math.min(4, band.w / 2),
              band.y + band.h / 2,
            ),
          );
          checkHitCaretPage(engine, page, {
            name,
            section: band.section,
            block: band.block,
            probe: 'js-unaligned-band',
          });
          if (engine) {
            totals.engineOnlyBands++;
            perDoc.engineOnlyBands++;
          } else {
            totals.engineUnresolvedJsMissBands++;
          }
          // place_doc can leave a clipped zero/short-height band at the page bottom when the whole
          // paragraph is deferred. Neither implementation should caret that ghost band; the same
          // paragraph must instead resolve on its real next-page fragment.
          let nextFragment = null;
          if (!engine && page + 1 < pages) {
            for (let offset = 0; offset <= [...text].length; offset++) {
              nextFragment = doc.bodyCaretRect(
                page + 1,
                band.section,
                band.block,
                offset,
              );
              if (nextFragment) break;
            }
            if (nextFragment) totals.ghostNextFragmentResolved++;
            else totals.ghostNextFragmentUnresolved++;
          }
          if (totals.jsUnalignedSamples.length < 12) {
            totals.jsUnalignedSamples.push({
              name,
              page,
              section: band.section,
              block: band.block,
              textLength: text.length,
              nonWhitespace: [...text].filter((ch) => !isWs(ch)).length,
              engineResolved: !!engine,
              nextFragmentPage: nextFragment?.page ?? null,
            });
          }
          continue;
        }
        totals.jsAlignedBands++;
        perDoc.jsAlignedBands++;

        const offsets = uniq([0, Math.floor(text.length / 3), Math.floor((2 * text.length) / 3), text.length]);
        for (const offset of offsets) {
          const jsRect = bodyCaretRectAt(boxes, offset, page);
          const engineRect = timed('rect', () =>
            doc.bodyCaretRect(page, band.section, band.block, offset),
          );
          // At a non-whitespace char boundary both paths read the exact placed-glyph x. Whitespace and
          // paragraph-end x are ESTIMATED by the SVG workaround (median/fallback calibration), whereas
          // the engine has the typesetter's exact advance; those are diagnostic, not an old-code oracle.
          // EmptyParaBoxes also has a known len=0→offset1 click bug, so it belongs in that bucket.
          const strict = offset < text.length && !isWs(text[offset]);
          if (!jsRect || !engineRect) {
            if (strict) totals.rectMismatches++;
            else totals.estimatedRectDivergences++;
            continue;
          }
          const dx = dist(jsRect.x, engineRect.x);
          const dy = dist(jsRect.top, engineRect.y);
          const dh = dist(jsRect.height, engineRect.h);
          totals.maxDx = Math.max(totals.maxDx, dx);
          totals.maxDy = Math.max(totals.maxDy, dy);
          totals.maxDh = Math.max(totals.maxDh, dh);
          const within = dx <= TOL && dy <= TOL && dh <= TOL;
          if (strict) {
            totals.rectXChecks++;
            perDoc.rectXChecks++;
            if (dx <= TOL) {
              totals.rectXWithinTolerance++;
              perDoc.rectXWithinTolerance++;
            } else {
              totals.rectXMismatches++;
            }
            totals.baselineContainmentChecks++;
            const baseline = boxes[offset].baseline;
            if (baseline >= engineRect.y - TOL && baseline <= engineRect.y + engineRect.h + TOL) {
              totals.baselineContainmentMatches++;
            } else {
              totals.baselineContainmentMismatches++;
            }
            totals.rectChecks++;
            perDoc.rectChecks++;
            if (within) {
              totals.rectWithinTolerance++;
              perDoc.rectWithinTolerance++;
            } else {
              totals.rectMismatches++;
              if (totals.strictRectMismatchSamples.length < 12) {
                totals.strictRectMismatchSamples.push({
                  name,
                  page,
                  section: band.section,
                  block: band.block,
                  offset,
                  char: text[offset],
                  js: jsRect,
                  engine: engineRect,
                  dx,
                  dy,
                  dh,
                });
              }
            }
          } else {
            totals.estimatedRectChecks++;
            if (!within) totals.estimatedRectDivergences++;
          }
          if (!within) {
            if (totals.rectMismatchSamples.length < 12) {
              totals.rectMismatchSamples.push({
                name,
                page,
                section: band.section,
                block: band.block,
                offset,
                char: text[offset] ?? '<end>',
                js: jsRect,
                engine: engineRect,
                dx,
                dy,
                dh,
              });
            }
          }

          const x = jsRect.x + 0.01;
          const y = jsRect.top + jsRect.height / 2;
          const wantOffset = bodyOffsetAtPoint(boxes, x, y);
          const hit = timed('hit', () => doc.bodyTextHit(page, x, y));
          checkHitCaretPage(hit, page, {
            name,
            section: band.section,
            block: band.block,
            probe: 'legacy-point',
          });
          if (!hit || hit.section !== band.section || hit.block !== band.block) {
            totals.hitAddressMismatches++;
          } else if (strict) {
            totals.hitChecks++;
            perDoc.hitChecks++;
            if (hit.offset !== wantOffset) {
              totals.hitOffsetMismatches++;
              if (totals.hitMismatchSamples.length < 12) {
                totals.hitMismatchSamples.push({
                  name,
                  page,
                  section: band.section,
                  block: band.block,
                  probeOffset: offset,
                  wantOffset,
                  gotOffset: hit.offset,
                  x,
                  y,
                });
              }
            } else {
              totals.hitOffsetMatches++;
              perDoc.hitOffsetMatches++;
            }
          } else {
            totals.estimatedHitChecks++;
            if (hit.offset !== wantOffset) totals.estimatedHitOffsetDivergences++;
          }

          if (strict) {
            totals.engineRoundTripChecks++;
            perDoc.engineRoundTripChecks++;
            const roundTrip = timed('hit', () =>
              doc.bodyTextHit(
                engineRect.page,
                engineRect.x + 0.01,
                engineRect.y + engineRect.h / 2,
              ),
            );
            checkHitCaretPage(roundTrip, engineRect.page, {
              name,
              section: band.section,
              block: band.block,
              probe: 'engine-roundtrip',
            });
            if (
              roundTrip &&
              roundTrip.section === band.section &&
              roundTrip.block === band.block &&
              roundTrip.offset === offset
            ) {
              totals.engineRoundTripMatches++;
              perDoc.engineRoundTripMatches++;
            } else {
              totals.engineRoundTripMismatches++;
              if (totals.engineRoundTripMismatchSamples.length < 12) {
                totals.engineRoundTripMismatchSamples.push({
                  name,
                  page,
                  section: band.section,
                  block: band.block,
                  offset,
                  roundTrip,
                });
              }
            }
          }
        }
      }
    }
    totals.docs.push(perDoc);
  } finally {
    doc.free();
  }
}

const percentile = (xs, p) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
};
const stats = (xs) => ({
  queries: xs.length,
  totalMs: Number(xs.reduce((a, b) => a + b, 0).toFixed(3)),
  medianMs: Number((medianValue(xs) ?? 0).toFixed(3)),
  p95Ms: Number(percentile(xs, 0.95).toFixed(3)),
  maxMs: Number(Math.max(0, ...xs).toFixed(3)),
});
totals.performance = {
  hit: stats(queryMs.hit),
  rect: stats(queryMs.rect),
  allQueries: stats([...queryMs.hit, ...queryMs.rect]),
  wallMs: Number((performance.now() - runStarted).toFixed(3)),
};
console.log(`BODY_CARET_CROSSCHECK_JSON ${JSON.stringify(totals)}`);
if (
  totals.hitAddressMismatches > 0 ||
  totals.rectXMismatches > 0 ||
  totals.baselineContainmentMismatches > 0 ||
  totals.engineRoundTripMismatches > 0 ||
  totals.hitCaretPageMismatches > 0 ||
  totals.ghostNextFragmentUnresolved > 0 ||
  totals.rectXChecks === 0
) {
  process.exitCode = 1;
}
