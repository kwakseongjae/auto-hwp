//! Typography / layout engine — the separable "(B) layout" half of the typography subsystem.
//!
//! Pure function: (paragraphs + resolved char/para shapes + page setup + injected font metrics) →
//! line segments + pagination. This is THE production critical path (PLAN §3.1, GUI memory seam #1):
//! it gates faithful in-app rendering, our own `linesegarray` emission (so rhwp/Hancom paginate our
//! converted .hwpx correctly), and the WYSIWYG caret (screen↔doc coordinate mapping).
//!
//! STATUS: a real greedy line-breaker + vertical-accumulation paginator. The DEFAULT build runs on
//! per-script APPROXIMATE metrics ([`ApproxFontMetrics`]); the `shaper` feature swaps in a real
//! rustybuzz (pure-Rust HarfBuzz) advance/metrics path ([`shaper::RealFontMetrics`]) with 자간/장평
//! scaling from the [`CharShape`]. NOT YET: Korean 금칙 (kinsoku), 배분/나눔 justification,
//! cluster-aware line breaking, vertical text. Those layer on this skeleton.

use hwp_model::prelude::*;

#[cfg(feature = "shaper")]
pub mod shaper;
#[cfg(feature = "shaper")]
pub use shaper::RealFontMetrics;

/// Positioned layout (glyphs/images/boxes per page) — the paint-IR bridge consumed by `hwp-render`.
pub mod place;
pub use place::{block_pages, column_offsets, place_doc, row_offsets, BlockKind, PlacedBlock, PlacedCell, PlacedDoc, PlacedGlyph, PlacedImage, PlacedPage, PlacedRect, PlacedTable};

/// Half the EM for half-width glyphs.
const HALF: f64 = 0.5;
/// Space advance as a fraction of the EM.
const SPACE: f64 = 0.3;
/// Default line advance as a fraction of the line's max glyph size (≈ 160% line spacing) when a
/// paragraph carries no explicit percent line spacing.
const DEFAULT_LINESPACE: f64 = 1.6;
/// Baseline as a fraction of the line height (matches Hancom's 850/1000 convention).
pub(crate) const BASELINE_RATIO: f64 = 0.85;

/// A plain (no family/style) font key — metrics here are per-script, family-independent.
fn plain_font() -> FontKey {
    FontKey { family: String::new(), bold: false, italic: false }
}

/// True for full-width glyphs (Hangul, CJK, fullwidth forms) — ~1 EM advance; others are ~half EM.
pub fn is_full_width(ch: char) -> bool {
    matches!(ch as u32,
        0x1100..=0x11FF |   // Hangul Jamo
        0x2E80..=0x2FDF |   // CJK radicals / Kangxi
        0x3000..=0x303F |   // CJK symbols & punctuation
        0x3040..=0x30FF |   // Hiragana + Katakana
        0x3130..=0x318F |   // Hangul Compatibility Jamo
        0x3400..=0x4DBF |   // CJK Ext-A
        0x4E00..=0x9FFF |   // CJK Unified Ideographs
        0xA960..=0xA97F |   // Hangul Jamo Ext-A
        0xAC00..=0xD7A3 |   // Hangul Syllables
        0xD7B0..=0xD7FF |   // Hangul Jamo Ext-B
        0xF900..=0xFAFF |   // CJK Compatibility Ideographs
        0xFF00..=0xFFEF     // Halfwidth/Fullwidth Forms (approx as full)
    )
}

/// Per-script APPROXIMATE metrics so we can break lines + paginate before a real shaper lands:
/// full-width glyph ≈ 1 EM, half-width (Latin/digit/punct) ≈ 0.5 EM, space ≈ 0.3 EM. Never fidelity.
#[derive(Default)]
pub struct ApproxFontMetrics;

impl FontMetricsProvider for ApproxFontMetrics {
    fn advance_width(&self, _font: &FontKey, ch: char, size_hwpunit: i32) -> f64 {
        let em = size_hwpunit.max(1) as f64;
        if ch == ' ' || ch == '\t' {
            em * SPACE
        } else if is_full_width(ch) {
            em
        } else {
            em * HALF
        }
    }
}

/// Real layout engine: greedy line-breaking + vertical-accumulation pagination over the injected
/// metrics. Replaces the old no-op stub.
#[derive(Default)]
pub struct NaiveLayout;

impl LayoutEngine for NaiveLayout {
    fn layout(&self, doc: &SemanticDoc, fonts: &dyn FontMetricsProvider) -> Result<LayoutResult> {
        let mut pages = vec![PageLayout::default()];
        for sec in &doc.sections {
            let page = &sec.page;
            let body_w = (page.width - page.margin_left - page.margin_right).max(1) as f64;
            let body_h = (page.height - page.margin_top - page.margin_bottom).max(1) as f64;
            // Each section starts on a fresh page (matches OWPML section→page).
            if !pages.last().map(|p| p.lines.is_empty()).unwrap_or(true) {
                pages.push(PageLayout::default());
            }
            if let Some(p) = pages.last_mut() {
                p.width = page.width as f64;
                p.height = page.height as f64;
            }
            let mut vert = 0.0f64; // page-relative vertical cursor

            for block in &sec.blocks {
                match block {
                    Block::Paragraph(p) => {
                        let ps = doc.para_shapes.get(p.para_shape);
                        // "쪽 나누기 앞에서": force a page break before this paragraph (unless already
                        // at the top of a fresh page).
                        if ps.map(|s| s.page_break_before).unwrap_or(false) && vert > 0.0 {
                            pages.push(new_page(page));
                            vert = 0.0;
                        }
                        // 문단 위 간격 — Hancom adds it before the paragraph (suppressed at page top).
                        if vert > 0.0 {
                            vert += ps.map(|s| s.space_before).unwrap_or(0).max(0) as f64;
                        }
                        let ratio = line_spacing_ratio(p, doc);
                        for ls in layout_paragraph(p, doc, body_w, fonts) {
                            if vert + ls.vert_size > body_h && vert > 0.0 {
                                pages.push(new_page(page));
                                vert = 0.0;
                            }
                            let adv = ls.vert_size * ratio;
                            pages.last_mut().unwrap().lines.push(LineSeg { vert_pos: vert, ..ls });
                            vert += adv;
                        }
                        // 문단 아래 간격.
                        vert += ps.map(|s| s.space_after).unwrap_or(0).max(0) as f64;
                    }
                    // Real table layout for pagination: each row is sized to its tallest cell's
                    // laid-out content (cells break lines at an equal-split width). A row that doesn't
                    // fit the remaining body flows to the NEXT page (한글식 row-level split) instead of
                    // jumping the whole table (which left big white gaps). IDENTICAL accounting to
                    // place_doc/place_table — outer top margin (suppressed at page top), the row-level
                    // split (an over-tall row draws and leaves vert>body_h for the NEXT block to break,
                    // NO trailing page-slice), then the outer bottom margin — so this page count stays
                    // in LOCKSTEP with place_doc's fragment placement (oracle can't drift).
                    Block::Table(t) => {
                        if vert > 0.0 {
                            vert += t.outer_margin_top.max(0) as f64;
                        }
                        for rh in table_row_heights(t, body_w, doc, fonts) {
                            if vert + rh > body_h && vert > 0.0 {
                                pages.push(new_page(page));
                                vert = 0.0;
                            }
                            vert += rh;
                        }
                        vert += t.outer_margin_bottom.max(0) as f64;
                    }
                }
            }
        }
        Ok(LayoutResult { pages })
    }
}

fn new_page(page: &PageSetup) -> PageLayout {
    PageLayout { width: page.width as f64, height: page.height as f64, lines: Vec::new() }
}

/// Vertical cell padding (HWPUNIT) — top+bottom default cell insets (~0.5mm each) plus a little
/// row breathing room. Approximate; the per-cell margin override isn't modeled yet.
pub(crate) const CELL_PAD: f64 = 600.0;

/// Laid-out height of one block (HWPUNIT) at the given content width — paragraph (lines×spacing +
/// 위/아래 간격) or a nested table (recursive). Drives table-row sizing + pagination accounting.
fn block_height(b: &Block, doc: &SemanticDoc, width: f64, fonts: &dyn FontMetricsProvider) -> f64 {
    match b {
        Block::Paragraph(p) => {
            let ps = doc.para_shapes.get(p.para_shape);
            let sb = ps.map(|s| s.space_before).unwrap_or(0).max(0) as f64;
            let sa = ps.map(|s| s.space_after).unwrap_or(0).max(0) as f64;
            let ratio = line_spacing_ratio(p, doc);
            let text: f64 = layout_paragraph(p, doc, width, fonts).iter().map(|l| l.vert_size * ratio).sum();
            sb + text + sa
        }
        Block::Table(t) => table_height(t, width, doc, fonts),
    }
}

/// Estimated height of a table (HWPUNIT): Σ row heights, each row = max content height of the cells
/// occupying it (a row-spanning cell distributes its height evenly across the rows it covers).
/// Cells break lines at an equal-split column width (`avail / cols × col_span`) — no per-column
/// widths yet, but enough for faithful page accounting.
pub fn table_height(t: &Table, avail_w: f64, doc: &SemanticDoc, fonts: &dyn FontMetricsProvider) -> f64 {
    table_row_heights(t, avail_w, doc, fonts).iter().sum()
}

/// Per-row heights (HWPUNIT) — the SINGLE sizing truth shared by the pagination reserve
/// ([`table_height`] = their sum), the row-level page split in [`NaiveLayout`], and the cell placer
/// ([`crate::place`] uses an identical computation). Each row = max content height of its cells
/// (a spanning cell distributes evenly) + [`CELL_PAD`], with any `Table::row_heights` override applied
/// as a floor. Column offsets honor the captured `col_widths` — the SAME widths place_table draws with,
/// so the RESERVATION equals the DRAWN height (an equal-split estimate over-reserved a wide-then-narrow
/// gov-doc table by ~1.5×, shoving it onto the next page with the rest empty).
pub(crate) fn table_row_heights(t: &Table, avail_w: f64, doc: &SemanticDoc, fonts: &dyn FontMetricsProvider) -> Vec<f64> {
    if t.rows == 0 {
        return Vec::new();
    }
    let xs = crate::place::column_offsets(t, avail_w);
    let mut row_h = vec![0.0f64; t.rows];
    for c in &t.cells {
        if !c.active {
            continue;
        }
        let col_end = (c.col + c.col_span.max(1)).min(t.cols);
        let cw = (xs[col_end] - xs[c.col.min(t.cols - 1)]).max(1.0);
        let content: f64 =
            c.blocks.iter().map(|b| block_height(b, doc, cw, fonts)).sum::<f64>() + CELL_PAD;
        let span = c.row_span.max(1);
        let per = content / span as f64;
        let end = (c.row + span).min(t.rows);
        for slot in row_h.iter_mut().take(end).skip(c.row) {
            *slot = slot.max(per);
        }
    }
    apply_row_overrides(&mut row_h, t);
    row_h
}

/// Apply per-row MINIMUM-height overrides (HWPUNIT) from [`Table::row_heights`] as a FLOOR on the
/// content-derived heights (drag-to-resize 행 높이). An empty vec or a `0` slot leaves the content
/// size untouched — so the default path (every parsed table, which never sets `row_heights`) is
/// byte-for-byte identical and the layout oracle is unaffected. Used by both the pagination
/// reservation (`table_height`) and the cell placer (`place::row_heights`) so they stay in lockstep.
pub(crate) fn apply_row_overrides(row_h: &mut [f64], t: &Table) {
    for (r, slot) in row_h.iter_mut().enumerate() {
        if let Some(&h) = t.row_heights.get(r) {
            if h > 0 {
                *slot = slot.max(h as f64);
            }
        }
    }
}

/// Substitute a few typographic chars that common free Korean faces (e.g. NanumGothic) lack with a
/// present, visually-equivalent glyph, so a missing glyph renders as the intended mark instead of a
/// blank .notdef gap. Applied at glyph-build time in BOTH the line-breaker and the placer so advances
/// and drawing stay in lockstep. Currently: dot-leader / katakana middle dots → the middle dot (·),
/// all used as separators (e.g. "제품·서비스") in gov-doc forms.
pub(crate) fn subst_glyph(ch: char) -> char {
    match ch {
        // U+2024 ONE DOT LEADER, U+30FB KATAKANA MIDDLE DOT, U+FF65 HALFWIDTH KATAKANA MIDDLE DOT.
        '\u{2024}' | '\u{30FB}' | '\u{FF65}' => '\u{00B7}',
        _ => ch,
    }
}

/// Lay out a single paragraph into [`LineSeg`]s (vert_pos left at 0 — the caller stacks them). Greedy
/// break: fill the line, then for a Latin word that straddles the edge back up to the last space;
/// Hangul/CJK break anywhere. Exposed for per-paragraph `linesegarray` emission.
pub fn layout_paragraph(p: &Paragraph, doc: &SemanticDoc, line_width: f64, fonts: &dyn FontMetricsProvider) -> Vec<LineSeg> {
    // (char, size_hwpunit) for every text glyph, in order.
    let mut chars: Vec<(char, i32)> = Vec::new();
    for run in &p.runs {
        let size = doc.char_shapes.get(run.char_shape).map(|c| c.height).filter(|&h| h > 0).unwrap_or(1000);
        for inl in &run.content {
            if let Inline::Text(t) = inl {
                for ch in t.chars() {
                    chars.push((subst_glyph(ch), size));
                }
            }
        }
    }
    let n = chars.len();
    let font = plain_font();
    let adv = |i: usize| fonts.advance_width(&font, chars[i].0, chars[i].1);

    // Tallest anchored object (image/equation) — an object paragraph is ONE line, but as tall as
    // the object (so pagination accounts for a half-page image, not a 1000-unit text line).
    let obj_h = object_height(p);

    if n == 0 {
        // An empty paragraph still occupies one line — height = the object's if it anchors one.
        // No glyph → use the default 1000-EM line height from the metrics provider. (Measured: Hancom
        // gives blank lines this full leading-based height too — the layout-check oracle drops 8→7
        // pages if we shrink it to the bare EM, so the leading is load-bearing for pagination.)
        let lh = if obj_h > 0 { obj_h as f64 } else { fonts.line_height(1000) };
        return vec![mk_line(0, lh, 0.0)];
    }

    let mut lines = Vec::new();
    let mut start = 0usize;
    while start < n {
        let mut w = 0.0;
        let mut end = start;
        let mut last_space: Option<usize> = None; // index AFTER a space within this line
        let mut forced = false; // hit a '\n' (HWP forced line break within the paragraph)
        while end < n {
            // A '\n' is a hard line break (강제 줄나눔, shift+enter): end the line BEFORE it and
            // consume it (it draws nothing). Without this the breaker flows "라벨\n(Problem)" as one
            // run and wraps by width, producing the wrong line split.
            if chars[end].0 == '\n' {
                forced = true;
                break;
            }
            let a = adv(end);
            if w + a > line_width && end > start {
                break;
            }
            w += a;
            end += 1;
            if chars[end - 1].0 == ' ' {
                last_space = Some(end);
            }
        }
        // Forced break: the line is [start, end); the '\n' at `end` is consumed (skipped) below.
        let line_end = if forced {
            end
        // Mid-word Latin break → back up to the last space (Hangul/CJK break anywhere).
        } else if end < n && !is_full_width(chars[end].0) {
            match last_space.filter(|&s| s > start) {
                Some(s) => s,
                // No space to back up to, mid Latin word. Extend to the word end (next space /
                // full-width char) and keep it whole IF it fits the line — but if the whole token is
                // wider than the line itself (a long Latin word in a narrow label cell, e.g.
                // "(Solution)"), keeping it whole would spill PAST the cell border into the neighbour.
                // Hancom wraps such a token inside the box, so char-break at the last glyph that fit.
                None => {
                    let mut e = end;
                    while e < n && chars[e].0 != ' ' && !is_full_width(chars[e].0) {
                        e += 1;
                    }
                    let e = e.max(start + 1);
                    let (whole_w, _) = measure(&chars, start, e, &font, fonts);
                    if whole_w > line_width {
                        end.max(start + 1) // char-break: keep the line within line_width
                    } else {
                        e
                    }
                }
            }
        } else {
            end.max(start + 1)
        };
        let (lw, measured_size) = measure(&chars, start, line_end, &font, fonts);
        // An empty line (a '\n' at the line start → blank line) has no glyph to size from; use the
        // break char's own font size so the blank line gets a real height, not a collapsed sliver.
        let max_size = if line_end == start {
            chars.get(start).map(|c| c.1).unwrap_or(1000).max(1)
        } else {
            measured_size
        };
        // Line box height = the font's real leading for the tallest glyph (real shaper) or flat EM
        // (approximation), NOT the bare EM — so rows match the actual face's line height.
        lines.push(mk_line(start as u32, fonts.line_height(max_size), lw));
        // Consume the '\n' itself on a forced break so the next line starts after it (it draws
        // nothing — the place step skips '\n'). Otherwise advance to the computed break point.
        start = if forced && line_end < n { line_end + 1 } else { line_end };
    }
    // An inline object taller than the text bumps the line it sits on (approximated as the first).
    if obj_h > 0 {
        if let Some(first) = lines.first_mut() {
            if obj_h as f64 > first.vert_size {
                let h = obj_h as f64;
                first.vert_size = h;
                first.text_height = h;
                first.baseline = h * BASELINE_RATIO;
            }
        }
    }
    lines
}

/// Tallest anchored image/equation in the paragraph (HWPUNIT), or 0 if none.
fn object_height(p: &Paragraph) -> i32 {
    let mut h = 0;
    for run in &p.runs {
        for inl in &run.content {
            match inl {
                Inline::Image(img) => h = h.max(img.height),
                Inline::Equation(eq) => h = h.max(eq.height),
                _ => {}
            }
        }
    }
    h.max(0)
}

/// Sum of advances + max glyph size over `[a, b)`.
fn measure(chars: &[(char, i32)], a: usize, b: usize, font: &FontKey, fonts: &dyn FontMetricsProvider) -> (f64, i32) {
    let mut w = 0.0;
    let mut sz = 0;
    for &(ch, size) in &chars[a..b] {
        w += fonts.advance_width(font, ch, size);
        sz = sz.max(size);
    }
    (w, sz.max(1))
}

/// One line at `text_pos` with line `height` (HWPUNIT, already resolved via the metrics provider's
/// `line_height`), content `width` (vert_pos filled by the caller).
fn mk_line(text_pos: u32, height: f64, width: f64) -> LineSeg {
    let h = height.max(1.0);
    LineSeg {
        text_pos,
        vert_pos: 0.0,
        vert_size: h,
        text_height: h,
        baseline: h * BASELINE_RATIO,
        horz_pos: 0.0,
        horz_size: width,
    }
}

/// Line advance as a multiple of the glyph size, from the paragraph's percent line spacing
/// (default ≈ 160%). Fixed/min spacing types fall back to the default for now.
pub(crate) fn line_spacing_ratio(p: &Paragraph, doc: &SemanticDoc) -> f64 {
    match doc.para_shapes.get(p.para_shape) {
        Some(s) if s.line_spacing_type == LineSpacingType::Percent && s.line_spacing_value > 0 => {
            s.line_spacing_value as f64 / 100.0
        }
        _ => DEFAULT_LINESPACE,
    }
}

/// Placeholder metrics provider (flat ~0.5em). Prefer [`ApproxFontMetrics`] (per-script).
#[derive(Default)]
pub struct NullFontMetrics;

impl FontMetricsProvider for NullFontMetrics {
    fn advance_width(&self, _font: &FontKey, _ch: char, size_hwpunit: i32) -> f64 {
        size_hwpunit as f64 * 0.5
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn para(text: &str) -> Paragraph {
        Paragraph {
            runs: vec![Run { char_shape: 0, content: vec![Inline::Text(text.into())], ..Default::default() }],
            ..Default::default()
        }
    }

    #[test]
    fn full_width_classification() {
        assert!(is_full_width('가') && is_full_width('한') && is_full_width('漢'));
        assert!(!is_full_width('a') && !is_full_width('1') && !is_full_width(' '));
    }

    #[test]
    fn approx_metrics_per_script() {
        let m = ApproxFontMetrics;
        let f = plain_font();
        assert_eq!(m.advance_width(&f, '가', 1000), 1000.0); // full EM
        assert_eq!(m.advance_width(&f, 'a', 1000), 500.0); // half EM
        assert_eq!(m.advance_width(&f, ' ', 1000), 300.0); // space
    }

    #[test]
    fn hangul_breaks_to_expected_line_count() {
        let mut doc = SemanticDoc::default();
        doc.char_shapes.push(CharShape::default()); // index 0 default → size 1000
        // 30 Hangul syllables at 1000 (1 EM each) → 30000 HWPUNIT of text.
        let p = para(&"가".repeat(30));
        // line width 10000 → 10 full-width glyphs/line → 3 lines.
        let lines = layout_paragraph(&p, &doc, 10000.0, &ApproxFontMetrics);
        assert_eq!(lines.len(), 3, "30 glyphs / 10 per line = 3 lines");
        assert_eq!(lines[0].text_pos, 0);
        assert_eq!(lines[1].text_pos, 10);
        assert_eq!(lines[2].text_pos, 20);
    }

    #[test]
    fn newline_is_a_forced_line_break() {
        let mut doc = SemanticDoc::default();
        doc.char_shapes.push(CharShape::default());
        // "1. 문제 인식\n(Problem)" — the '\n' must split into exactly two lines regardless of width,
        // and must NOT be drawn (it's consumed). A wide line_width proves the break is forced, not
        // width-driven.
        let p = para("문제\n(Problem)");
        let lines = layout_paragraph(&p, &doc, 100000.0, &ApproxFontMetrics);
        assert_eq!(lines.len(), 2, "'\\n' forces a second line even when everything fits one line");
        assert_eq!(lines[0].text_pos, 0, "line 1 starts at the beginning");
        // chars: 문(0) 제(1) \n(2) ((3)... → line 2 starts AFTER the '\n', at index 3.
        assert_eq!(lines[1].text_pos, 3, "line 2 starts after the consumed '\\n'");
    }

    #[test]
    fn missing_glyph_dot_variants_map_to_middle_dot() {
        // NanumGothic lacks U+2024 (one-dot leader) / U+30FB (katakana middle dot); they're used as
        // separators ("제품·서비스") in gov forms. subst_glyph maps them to U+00B7 so they render.
        assert_eq!(subst_glyph('\u{2024}'), '·');
        assert_eq!(subst_glyph('\u{30FB}'), '·');
        assert_eq!(subst_glyph('·'), '·', "an already-present middle dot is unchanged");
        assert_eq!(subst_glyph('가'), '가', "ordinary glyphs pass through");
    }

    #[test]
    fn latin_breaks_at_word_boundary() {
        let mut doc = SemanticDoc::default();
        doc.char_shapes.push(CharShape::default());
        // "aaaa bbbb cccc": each letter 500, space 300.
        let p = para("aaaa bbbb cccc");
        // width 5000: "aaaa "(2300) + "bbbb "(2300) = 4600 fits; "cccc"(2000)→6600 > 5000 → wrap.
        let lines = layout_paragraph(&p, &doc, 5000.0, &ApproxFontMetrics);
        assert_eq!(lines.len(), 2, "wraps at a space, not mid-word");
        assert_eq!(lines[1].text_pos, 10, "line 2 starts at 'cccc' (after 'aaaa bbbb ')");
    }

    #[test]
    fn approx_line_height_is_bare_em() {
        // The DEFAULT provider keeps the flat-EM line height (no calibration) so the default build's
        // pagination is byte-for-byte what it was before the shaper's vmetrics path landed.
        let m = ApproxFontMetrics;
        assert_eq!(m.line_height(1000), 1000.0);
        assert_eq!(m.line_height(1200), 1200.0);
    }

    /// A metrics provider that reports a taller-than-EM line height (like a real Korean face),
    /// to verify `layout_paragraph` honors `line_height` for the line box.
    struct TallLines;
    impl FontMetricsProvider for TallLines {
        fn advance_width(&self, _f: &FontKey, ch: char, size: i32) -> f64 {
            ApproxFontMetrics.advance_width(_f, ch, size)
        }
        fn line_height(&self, size: i32) -> f64 {
            size.max(1) as f64 * 1.2 // 1.2 EM leading
        }
    }

    #[test]
    fn line_height_provider_drives_lineseg_height() {
        let mut doc = SemanticDoc::default();
        doc.char_shapes.push(CharShape::default()); // size 1000
        let p = para("가나다");
        let flat = layout_paragraph(&p, &doc, 10000.0, &ApproxFontMetrics);
        let tall = layout_paragraph(&p, &doc, 10000.0, &TallLines);
        assert_eq!(flat.len(), 1);
        assert_eq!(tall.len(), 1);
        assert!((flat[0].vert_size - 1000.0).abs() < 1.0, "flat = 1 EM, got {}", flat[0].vert_size);
        assert!((tall[0].vert_size - 1200.0).abs() < 1.0, "tall = 1.2 EM, got {}", tall[0].vert_size);
        // Line breaking (advances) is identical — only the box height changed.
        assert_eq!(flat[0].text_pos, tall[0].text_pos);
    }

    #[test]
    fn table_height_sums_row_content() {
        let mut doc = SemanticDoc::default();
        doc.char_shapes.push(CharShape::default()); // size 1000
        // 3-row × 1-col table, one short line per cell. Each row ≈ one 1000-unit line × 1.6 + CELL_PAD.
        let mut t = Table { rows: 3, cols: 1, ..Default::default() };
        for r in 0..3 {
            t.cells.push(Cell {
                row: r,
                col: 0,
                row_span: 1,
                col_span: 1,
                active: true,
                blocks: vec![Block::Paragraph(para("셀"))],
                ..Default::default()
            });
        }
        let h = table_height(&t, 40000.0, &doc, &ApproxFontMetrics);
        let per_row = 1000.0 * DEFAULT_LINESPACE + CELL_PAD;
        assert!((h - 3.0 * per_row).abs() < 1.0, "3 rows × (line+pad): got {h}");
    }

    #[test]
    fn page_break_before_forces_a_new_page() {
        let mut doc = SemanticDoc::default();
        doc.char_shapes.push(CharShape::default());
        doc.para_shapes.push(ParaShape::default()); // index 0 = plain default
        // ParaShape index 1 carries 쪽-나누기-앞에서.
        doc.para_shapes.push(ParaShape { page_break_before: true, ..Default::default() });
        let mut sec = Section::default();
        sec.blocks.push(Block::Paragraph(para("first")));
        let mut second = para("second");
        second.para_shape = 1;
        sec.blocks.push(Block::Paragraph(second));
        doc.sections.push(sec);
        let res = NaiveLayout.layout(&doc, &ApproxFontMetrics).unwrap();
        assert_eq!(res.pages.len(), 2, "page-break-before splits two short paragraphs onto 2 pages");
    }

    #[test]
    fn paginates_when_content_exceeds_body_height() {
        let mut doc = SemanticDoc::default();
        doc.char_shapes.push(CharShape::default());
        // A4 portrait body ≈ 84188 - 2*7200 = 69788; line advance ≈ 1000*1.6 = 1600 → ~43 lines/page.
        let mut sec = Section::default();
        for _ in 0..100 {
            sec.blocks.push(Block::Paragraph(para("한 줄")));
        }
        doc.sections.push(sec);
        let res = NaiveLayout.layout(&doc, &ApproxFontMetrics).unwrap();
        assert!(res.pages.len() >= 2, "100 lines must paginate: got {} pages", res.pages.len());
        for pg in &res.pages {
            for ls in &pg.lines {
                assert!(ls.vert_pos < pg.height, "every line sits within its page body");
            }
        }
    }
}
