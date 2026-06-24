//! Positioned layout — the bridge from line-broken paragraphs to the PAINT IR.
//!
//! [`NaiveLayout`](crate::NaiveLayout) emits bare [`LineSeg`]s (a `text_pos` + a vertical box) but
//! drops the one thing a renderer needs: the actual glyphs and their horizontal positions. This
//! module re-drives the SAME greedy break + vertical-accumulation paginator (so there is no second
//! layout truth) and emits, per page, fully **positioned** content in absolute page coordinates
//! (HWPUNIT, page-top-left origin, margins applied): every glyph's `(x, baseline, ch, size, color)`,
//! every anchored image's box, and per-line text boxes. `hwp-render` walks this into `PaintOp`s.
//!
//! Horizontal placement honors the paragraph's alignment (left/right/center/justify) by offsetting
//! the line's start within the body width — the layout engine's job, mirroring Hancom. Tables are
//! drawn as their outer + cell boxes (text inside cells is positioned recursively); per-column widths
//! use `Table::col_widths` when present, else an equal split — matching `table_height`'s accounting.

use hwp_model::prelude::*;

use crate::{layout_paragraph, line_spacing_ratio, table_height, BASELINE_RATIO};

/// A single positioned glyph in absolute page coordinates (HWPUNIT, page-top-left origin).
#[derive(Clone, Debug)]
pub struct PlacedGlyph {
    /// Left edge of the glyph's advance box.
    pub x: f64,
    /// Baseline y (text sits ABOVE this by the ascent).
    pub baseline: f64,
    pub ch: char,
    /// Glyph size (EM) in HWPUNIT — the renderer scales this to its device units.
    pub size: f64,
    /// Resolved text color (from the run's [`CharShape`]).
    pub color: Color,
    /// Underline requested by the run's char shape (renderer draws the rule).
    pub underline: bool,
    /// Bold weight from the run's char shape (renderer picks a bold face / font-weight).
    pub bold: bool,
    /// Italic slant from the run's char shape (renderer uses an italic face / synthetic oblique).
    pub italic: bool,
}

/// A positioned image/equation box in absolute page coordinates.
#[derive(Clone, Debug)]
pub struct PlacedImage {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// `bin_ref` into [`SemanticDoc::bin_data`]; empty for an equation placeholder.
    pub bin_ref: String,
    /// Source provenance: the `(section, block index)` anchor the image's paragraph occupies in the
    /// SemanticDoc — lets an overlay/edit map a placed box back to the editable model (the
    /// `image_bbox` query + a `SetImageSize` op). The renderer ignores these.
    pub section: usize,
    pub block: usize,
}

/// A positioned table's OUTER box in absolute page coordinates + its model anchor. Provenance only
/// (mirrors [`PlacedImage`]): lets a drag-to-move overlay map a table's placed box back to the
/// editable `(section, block)` so it can emit a `MoveBlock`. The renderer ignores these (the visible
/// table is drawn from `rects`/`lines`); they exist purely so `table_bbox`/`table_at` can find a table.
#[derive(Clone, Debug)]
pub struct PlacedTable {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// The `(section, block index)` anchor the table occupies in the SemanticDoc.
    pub section: usize,
    pub block: usize,
    /// Logical row/column counts — so a quick-edit overlay can append a row (`TableInsertRows` wants
    /// the column count + the append-at row) without a second query.
    pub rows: usize,
    pub cols: usize,
    /// Per-cell page rects (provenance only) so a double-click can resolve which CELL was hit — the
    /// basis for direct "표에 내용 작성" (point a cell → edit it). Empty for tables placed before this
    /// was added; populated by `place_table`.
    pub cells: Vec<PlacedCell>,
}

/// One placed table cell's page rect + its `(row, col)` address (provenance only; not drawn). Powers
/// `table_cell_at` — a double-click → the cell editor for exactly the clicked cell.
#[derive(Clone, Debug)]
pub struct PlacedCell {
    pub row: usize,
    pub col: usize,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl PlacedTable {
    /// The cell containing page-space `(x, y)` — tightest (smallest-area) on overlap so a merged cell
    /// doesn't swallow a smaller neighbour. `None` if the point is outside every cell.
    pub fn cell_at(&self, x: f64, y: f64) -> Option<&PlacedCell> {
        self.cells
            .iter()
            .filter(|c| x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h)
            .min_by(|a, b| (a.w * a.h).total_cmp(&(b.w * b.h)))
    }
}

/// What kind of top-level block a [`PlacedBlock`] band came from — lets a point-action UI label the
/// pointed target ("문단"/"표"/"그림") and decide whether to offer a caret vs an overlay.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlockKind {
    Paragraph,
    Table,
    Image,
}

/// The page-space VERTICAL BAND a top-level block occupies on one page + its `(section, block)`
/// anchor. Unlike [`PlacedGlyph`] (no provenance), this is what lets the own-render surface answer
/// "which block did the user point at?" — the missing primitive behind point-to-scope / point-to-insert
/// in the 자체 렌더 view. One band per page-portion (a block spanning a page break gets a band on each
/// page it touches). `x/w` span the body column for a paragraph, or the table's own extent for a table;
/// resolution is by `y` (row-based pointing), see [`PlacedPage::block_at`]. Provenance only — not drawn.
#[derive(Clone, Debug)]
pub struct PlacedBlock {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub section: usize,
    pub block: usize,
    pub kind: BlockKind,
}

/// A positioned box (line text-box, cell, table outline, cell shade). The renderer emits these as
/// `PaintOp::Rect`; `fill` distinguishes a stroked border (None) from a shaded fill (Some(color)).
#[derive(Clone, Debug)]
pub struct PlacedRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// Some → a filled rect (shading); None → a stroked outline (border/line box).
    pub fill: Option<Color>,
}

/// A positioned styled line segment (a single cell edge or a cell diagonal) in absolute page coords.
/// The renderer lowers these into `PaintOp::Line` — distinct from a `PlacedRect` box so a table can
/// draw exactly the sides the doc specifies, each with its own color/style/width.
#[derive(Clone, Debug)]
pub struct PlacedLine {
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
    pub color: Color,
    pub style: LineStyle,
    /// Stroke width in device px (the renderer scales to its units).
    pub width: f64,
}

/// All positioned content for one page, ready to lower into a `PageLayerTree`.
#[derive(Clone, Debug, Default)]
pub struct PlacedPage {
    pub width: f64,
    pub height: f64,
    pub glyphs: Vec<PlacedGlyph>,
    pub images: Vec<PlacedImage>,
    /// Per-table outer-box provenance (anchor → page rect). Provenance only; not drawn (see
    /// [`PlacedTable`]). Powers the drag-to-move overlay's `table_bbox`/`table_at`.
    pub tables: Vec<PlacedTable>,
    /// Per-top-level-block vertical bands (anchor → page band). Provenance only; not drawn. Powers
    /// `own_hit_test` (point → block) so the 자체 렌더 surface can scope/insert at what's pointed at.
    pub blocks: Vec<PlacedBlock>,
    pub rects: Vec<PlacedRect>,
    /// Per-edge cell borders + cell diagonals (styled lines). Drawn after `rects` (which now only
    /// carry shading + the LEGACY uniform box for cells without per-edge data).
    pub lines: Vec<PlacedLine>,
}

impl PlacedPage {
    /// Resolve a page-space point to the top-level block the user pointed at — the missing primitive
    /// for own-render point-to-scope / point-to-insert. Resolution is ROW-BASED (by `y`): the band
    /// whose vertical extent contains the point wins (tightest height if bands overlap, e.g. a table
    /// inside the flow); if the point falls in an inter-block gap or a margin, the vertically NEAREST
    /// band wins so a near-miss still scopes a real block. `None` only when the page has no blocks.
    pub fn block_at(&self, _x: f64, y: f64) -> Option<&PlacedBlock> {
        if self.blocks.is_empty() {
            return None;
        }
        self.blocks
            .iter()
            .filter(|b| y >= b.y && y <= b.y + b.h)
            .min_by(|a, c| a.h.total_cmp(&c.h))
            .or_else(|| {
                self.blocks
                    .iter()
                    .min_by(|a, c| band_vdist(a, y).total_cmp(&band_vdist(c, y)))
            })
    }
}

/// Vertical distance from `y` to a block's band `[b.y, b.y + b.h]` (0 inside the band).
fn band_vdist(b: &PlacedBlock, y: f64) -> f64 {
    if y < b.y {
        b.y - y
    } else if y > b.y + b.h {
        y - (b.y + b.h)
    } else {
        0.0
    }
}

/// Record full-width band(s) for a top-level block that occupies `[start_page,start_y] ..
/// [end_page,end_y]` in the flow (page-relative y's), one band per page-portion it touches. `mt`/`body_h`
/// frame the body box so a block spanning a page break gets the right slice on each page.
#[allow(clippy::too_many_arguments)]
fn record_block_band(
    pages: &mut [PlacedPage],
    start_page: usize,
    start_y: f64,
    end_page: usize,
    end_y: f64,
    ml: f64,
    body_w: f64,
    mt: f64,
    body_h: f64,
    section: usize,
    block: usize,
    kind: BlockKind,
) {
    if start_page == end_page {
        if let Some(pg) = pages.get_mut(start_page) {
            pg.blocks.push(PlacedBlock { x: ml, y: start_y, w: body_w, h: (end_y - start_y).max(0.0), section, block, kind });
        }
        return;
    }
    if let Some(pg) = pages.get_mut(start_page) {
        pg.blocks.push(PlacedBlock { x: ml, y: start_y, w: body_w, h: (mt + body_h - start_y).max(0.0), section, block, kind });
    }
    for p in (start_page + 1)..end_page {
        if let Some(pg) = pages.get_mut(p) {
            pg.blocks.push(PlacedBlock { x: ml, y: mt, w: body_w, h: body_h, section, block, kind });
        }
    }
    if let Some(pg) = pages.get_mut(end_page) {
        pg.blocks.push(PlacedBlock { x: ml, y: mt, w: body_w, h: (end_y - mt).max(0.0), section, block, kind });
    }
}

/// Positioned, paginated document — the renderer's direct input.
#[derive(Clone, Debug, Default)]
pub struct PlacedDoc {
    pub pages: Vec<PlacedPage>,
}

/// Place a whole [`SemanticDoc`] into positioned pages, re-driving the paginator so screen == the
/// `NaiveLayout` page count. `fonts` supplies advances (inject [`crate::RealFontMetrics`] under the
/// `shaper` feature for real glyph widths; [`crate::ApproxFontMetrics`] otherwise).
pub fn place_doc(doc: &SemanticDoc, fonts: &dyn FontMetricsProvider) -> PlacedDoc {
    let mut pages: Vec<PlacedPage> = vec![PlacedPage::default()];
    let mut started = false; // any content placed on the current page yet?

    for (sec_idx, sec) in doc.sections.iter().enumerate() {
        let page = &sec.page;
        let ml = page.margin_left as f64;
        let mt = page.margin_top as f64;
        let body_w = (page.width - page.margin_left - page.margin_right).max(1) as f64;
        let body_h = (page.height - page.margin_top - page.margin_bottom).max(1) as f64;

        // Each section starts on a fresh page (matches OWPML section→page + NaiveLayout).
        if started {
            pages.push(PlacedPage::default());
        }
        set_page_size(pages.last_mut().unwrap(), page);
        let mut vert = 0.0f64; // page-relative vertical cursor (within the body box)

        for (blk_idx, block) in sec.blocks.iter().enumerate() {
            match block {
                Block::Paragraph(p) => {
                    let ps = doc.para_shapes.get(p.para_shape);
                    if ps.map(|s| s.page_break_before).unwrap_or(false) && vert > 0.0 {
                        new_page(&mut pages, page);
                        vert = 0.0;
                    }
                    if vert > 0.0 {
                        vert += ps.map(|s| s.space_before).unwrap_or(0).max(0) as f64;
                    }
                    let bstart_page = pages.len() - 1;
                    let bstart_y = mt + vert;
                    place_paragraph(p, doc, fonts, ml, mt, body_w, body_h, &mut vert, &mut pages, page, sec_idx, blk_idx);
                    // Provenance band for point-to-scope: the paragraph's row extent on each page it
                    // touched. Tag it IMAGE when it carries an anchored object so the UI can label it.
                    let bend_page = pages.len() - 1;
                    let bend_y = mt + vert;
                    let kind = if paragraph_object(p).is_some() { BlockKind::Image } else { BlockKind::Paragraph };
                    record_block_band(&mut pages, bstart_page, bstart_y, bend_page, bend_y, ml, body_w, mt, body_h, sec_idx, blk_idx, kind);
                    vert += ps.map(|s| s.space_after).unwrap_or(0).max(0) as f64;
                    started = true;
                }
                Block::Table(t) => {
                    let h = table_height(t, body_w, doc, fonts);
                    // Outer top margin (바깥 여백): the gap HWP keeps above the table, but only when
                    // it isn't the first block on the page (mirrors paragraph space_before).
                    if vert > 0.0 {
                        vert += t.outer_margin_top.max(0) as f64;
                    }
                    if vert + h > body_h && vert > 0.0 {
                        new_page(&mut pages, page);
                        vert = 0.0;
                    }
                    place_table(t, doc, fonts, ml, mt + vert, body_w, &mut pages, sec_idx, blk_idx);
                    // Provenance band for point-to-scope: reuse the exact outer box place_table just
                    // recorded (a table is single-page in our flow) so the band matches what's drawn.
                    // Guard on the anchor: a degenerate 0×N/N×0 table makes place_table early-return
                    // WITHOUT pushing, so `tables.last()` would be the PREVIOUS table — only adopt the
                    // box when it actually belongs to THIS block (else skip; an empty table draws
                    // nothing, so there's nothing to point at).
                    let tpage = pages.len() - 1;
                    if let Some(pt) = pages[tpage].tables.last() {
                        if pt.section == sec_idx && pt.block == blk_idx {
                            let b = PlacedBlock { x: pt.x, y: pt.y, w: pt.w, h: pt.h, section: pt.section, block: pt.block, kind: BlockKind::Table };
                            pages[tpage].blocks.push(b);
                        }
                    }
                    vert += h;
                    // Outer bottom margin so the next block doesn't abut the table.
                    vert += t.outer_margin_bottom.max(0) as f64;
                    while vert > body_h {
                        new_page(&mut pages, page);
                        vert -= body_h;
                    }
                    started = true;
                }
            }
        }
    }
    PlacedDoc { pages }
}

/// Map each top-level block to the 0-based page index its first line/row STARTS on, re-driving the
/// SAME vertical accounting as [`place_doc`] (fresh page per section, paragraph space-before/after,
/// table outer margins + fit/overflow page breaks) WITHOUT placing glyphs. `out[section][block]` =
/// page index. Lets a document-outline / page-nav panel scroll the page list to a heading's page.
pub fn block_pages(doc: &SemanticDoc, fonts: &dyn FontMetricsProvider) -> Vec<Vec<usize>> {
    let mut out: Vec<Vec<usize>> = Vec::with_capacity(doc.sections.len());
    let mut page_idx = 0usize; // current (global) page index
    let mut started = false;
    for sec in &doc.sections {
        let page = &sec.page;
        let body_w = (page.width - page.margin_left - page.margin_right).max(1) as f64;
        let body_h = (page.height - page.margin_top - page.margin_bottom).max(1) as f64;
        if started {
            page_idx += 1; // each section starts on a fresh page
        }
        let mut vert = 0.0f64;
        let mut sec_pages = Vec::with_capacity(sec.blocks.len());
        for block in &sec.blocks {
            match block {
                Block::Paragraph(p) => {
                    let ps = doc.para_shapes.get(p.para_shape);
                    if ps.map(|s| s.page_break_before).unwrap_or(false) && vert > 0.0 {
                        page_idx += 1;
                        vert = 0.0;
                    }
                    if vert > 0.0 {
                        vert += ps.map(|s| s.space_before).unwrap_or(0).max(0) as f64;
                    }
                    let ratio = line_spacing_ratio(p, doc);
                    let ind = indent_of(p, doc, body_w);
                    let lines = layout_paragraph(p, doc, ind.wrap_w, fonts);
                    let mut recorded = false;
                    for ls in &lines {
                        if vert + ls.vert_size > body_h && vert > 0.0 {
                            page_idx += 1;
                            vert = 0.0;
                        }
                        if !recorded {
                            sec_pages.push(page_idx); // the block starts where its first line lands
                            recorded = true;
                        }
                        vert += ls.vert_size * ratio;
                    }
                    if !recorded {
                        sec_pages.push(page_idx);
                    }
                    vert += ps.map(|s| s.space_after).unwrap_or(0).max(0) as f64;
                    started = true;
                }
                Block::Table(t) => {
                    let h = table_height(t, body_w, doc, fonts);
                    if vert > 0.0 {
                        vert += t.outer_margin_top.max(0) as f64;
                    }
                    if vert + h > body_h && vert > 0.0 {
                        page_idx += 1;
                        vert = 0.0;
                    }
                    sec_pages.push(page_idx); // the table starts here
                    vert += h + t.outer_margin_bottom.max(0) as f64;
                    while vert > body_h {
                        page_idx += 1;
                        vert -= body_h;
                    }
                    started = true;
                }
            }
        }
        out.push(sec_pages);
    }
    out
}

/// 문단 들여쓰기/여백 (paragraph indent geometry) resolved from a [`ParaShape`].
///
/// `left` is the block left inset (`ParaShape.left_margin`, clamped ≥0) applied to EVERY line;
/// `first_extra` is the additional offset on the FIRST line only (positive = 들여쓰기, negative =
/// 내어쓰기/hanging — clamped so the first line never crosses left of the block's left inset);
/// `wrap_w` is the line-break width shrunk by the block's left+right margins (so wrapping stays
/// correct under the inset). The first-line indent is a positional x-shift, not a width change.
struct Indent {
    left: f64,
    first_extra: f64,
    wrap_w: f64,
}

/// Resolve indent geometry for a paragraph against an available width (body width or cell text width).
fn indent_of(p: &Paragraph, doc: &SemanticDoc, avail_w: f64) -> Indent {
    let ps = doc.para_shapes.get(p.para_shape);
    let left = ps.map(|s| s.left_margin).unwrap_or(0).max(0) as f64;
    let right = ps.map(|s| s.right_margin).unwrap_or(0).max(0) as f64;
    let indent = ps.map(|s| s.indent).unwrap_or(0) as f64;
    // First-line indent: positive shifts in (들여쓰기); negative is hanging (내어쓰기) — clamp so the
    // first line's start never crosses left of the block left inset (i.e. first_extra >= -left… but
    // since `left` is the new origin, the clamp is first_extra >= -0 relative to that origin → ≥ -left
    // in absolute terms; we apply it relative to `left`, so clamp to ≥ -left is the same as the line
    // not going past the page/body left). Hanging text simply starts back at the block left edge.
    let first_extra = indent.max(-left);
    // Wrap width shrinks by left+right block margins so line breaking respects the inset. Keep ≥1.
    let wrap_w = (avail_w - left - right).max(1.0);
    Indent { left, first_extra, wrap_w }
}

/// Place one paragraph's lines (glyphs + a line text-box), advancing `vert` and paginating exactly
/// like [`crate::NaiveLayout`]. `ml`/`mt` are the body-origin margins; `body_w`/`body_h` the body box.
#[allow(clippy::too_many_arguments)]
fn place_paragraph(
    p: &Paragraph,
    doc: &SemanticDoc,
    fonts: &dyn FontMetricsProvider,
    ml: f64,
    mt: f64,
    body_w: f64,
    body_h: f64,
    vert: &mut f64,
    pages: &mut Vec<PlacedPage>,
    page: &PageSetup,
    section: usize,
    block: usize,
) {
    // Flat (char, size, color, underline) over the paragraph's text — same order layout_paragraph
    // breaks on, so line `text_pos` indexes straight into this.
    let glyphs = paragraph_glyphs(p, doc);
    let align = doc.para_shapes.get(p.para_shape).map(|s| s.align).unwrap_or_default();
    let ratio = line_spacing_ratio(p, doc);
    // Paragraph indent: block left/right margins shrink the wrap width; first-line indent shifts line 0.
    let ind = indent_of(p, doc, body_w);
    let lines = layout_paragraph(p, doc, ind.wrap_w, fonts);

    // Anchored object (image/equation) on this paragraph — placed on its (single) line.
    let obj = paragraph_object(p);

    for (li, ls) in lines.iter().enumerate() {
        if *vert + ls.vert_size > body_h && *vert > 0.0 {
            new_page(pages, page);
            *vert = 0.0;
        }
        let pg = pages.last_mut().unwrap();
        let line_top = mt + *vert;
        let line_w = ls.horz_size;
        // First-line indent only shifts (and narrows the usable slack of) line 0.
        let line_indent = ind.left + if li == 0 { ind.first_extra } else { 0.0 };
        // Alignment offset within the indented width (left/justify = 0, right = full slack, center = ½).
        let slack = (ind.wrap_w - if li == 0 { ind.first_extra.max(0.0) } else { 0.0 } - line_w).max(0.0);
        let x0 = ml + line_indent + match align {
            HorizontalAlign::Right => slack,
            HorizontalAlign::Center => slack / 2.0,
            _ => 0.0,
        };
        let baseline = line_top + ls.baseline;

        // Walk this line's glyphs, accumulating x by real advances.
        let start = ls.text_pos as usize;
        let end = lines.get(li + 1).map(|n| n.text_pos as usize).unwrap_or(glyphs.len());
        let mut x = x0;
        let plain = FontKey { family: String::new(), bold: false, italic: false };
        for g in glyphs.get(start..end.min(glyphs.len())).unwrap_or(&[]) {
            let adv = fonts.advance_width(&plain, g.ch, g.size as i32);
            if g.ch != ' ' && g.ch != '\t' && g.ch != '\n' {
                pg.glyphs.push(PlacedGlyph {
                    x,
                    baseline,
                    ch: g.ch,
                    size: g.size,
                    color: g.color,
                    underline: g.underline,
                    bold: g.bold,
                    italic: g.italic,
                });
            }
            x += adv;
        }

        // (No per-line text-box: the SvgSink strokes fill:None rects as borders, so a box per line
        // cluttered the display with little frames around every bullet/line. The own-render is a
        // read-only fidelity view — caret hit-testing uses the rhwp path, not these boxes — so only
        // table/cell borders are drawn. Line-level hit geometry can come back behind a flag if the
        // own surface ever becomes editable.)

        // An anchored object sits on the first line of its paragraph.
        if li == 0 {
            if let Some((w, h, bin_ref)) = &obj {
                pg.images.push(PlacedImage {
                    x: x0,
                    y: line_top,
                    w: *w,
                    h: *h,
                    bin_ref: bin_ref.clone(),
                    section,
                    block,
                });
            }
        }

        *vert += ls.vert_size * ratio;
    }
}

/// Draw a table as its cell boxes (+ shades) with cell text positioned recursively. Column widths
/// come from `col_widths` when present, else an equal split (mirrors `table_height`). Anchored at
/// `(ml, top)` in absolute page coords; assumes the table fits the current page (row-level flow is
/// handled by the caller's `vert` accounting — cells beyond the page bottom are clipped by the sink).
fn place_table(
    t: &Table,
    doc: &SemanticDoc,
    fonts: &dyn FontMetricsProvider,
    ml: f64,
    top: f64,
    avail_w: f64,
    pages: &mut [PlacedPage],
    section: usize,
    block: usize,
) {
    if t.rows == 0 || t.cols == 0 {
        return;
    }
    // Per-column x offsets + widths.
    let col_x = column_offsets(t, avail_w);
    // Row tops: reuse table_height's row sizing so cell boxes line up with the reserved height.
    let row_h = row_heights(t, avail_w, doc, fonts);
    let mut row_top = vec![top; t.rows + 1];
    for r in 0..t.rows {
        row_top[r + 1] = row_top[r] + row_h[r];
    }

    let pg = match pages.last_mut() {
        Some(p) => p,
        None => return,
    };
    // Outer-box provenance (anchor → page rect) for the drag-to-move overlay. Drawn from the actual
    // placed column/row extents so it matches the visible table exactly. Provenance only — not painted.
    pg.tables.push(PlacedTable {
        x: ml,
        y: top,
        w: col_x[t.cols],
        h: row_top[t.rows] - top,
        section,
        block,
        rows: t.rows,
        cols: t.cols,
        cells: Vec::new(), // filled in the loop below, then attached
    });
    let mut placed_cells: Vec<PlacedCell> = Vec::new();
    for c in &t.cells {
        if !c.active {
            continue;
        }
        // Defensive clamp: an LLM edit can append a row with MORE cells than the table has columns
        // (or a stray row index). Such a cell would otherwise reuse the last column/row and draw on
        // top of a real cell or outside the table box. Skip it entirely so nothing overlaps/escapes.
        if c.col >= t.cols || c.row >= t.rows {
            continue;
        }
        let cx = ml + col_x[c.col];
        let col_end = (c.col + c.col_span.max(1)).min(t.cols);
        let cw = (col_x[col_end] - col_x[c.col]).max(1.0);
        let cy = row_top[c.row];
        let row_end = (c.row + c.row_span.max(1)).min(t.rows);
        let ch = (row_top[row_end] - row_top[c.row]).max(1.0);
        // Cell provenance rect (point→cell for double-click editing).
        placed_cells.push(PlacedCell { row: c.row, col: c.col, x: cx, y: cy, w: cw, h: ch });
        // Cell shade (fill) UNDER its border so the border stays visible.
        if let Some(shade) = c.shade_color {
            pg.rects.push(PlacedRect { x: cx, y: cy, w: cw, h: ch, fill: Some(shade) });
        }
        // Cell borders. Two paths:
        //  - PER-EDGE (lifted from the real borderFill): draw each visible edge as its own styled
        //    line, skipping 선없음 sides. This is what makes the ※ guide boxes render DASHED and the
        //    section-header band lose its inner/right edges (→ pentagon with the diagonal).
        //  - LEGACY (no per-edge data, e.g. inserted/test cells): the uniform stroked box, gated on
        //    `has_border`, exactly as before — so nothing regresses.
        if c.has_edge_borders() {
            push_cell_edges(pg, &c.borders, cx, cy, cw, ch);
        } else if c.has_border {
            pg.rects.push(PlacedRect { x: cx, y: cy, w: cw, h: ch, fill: None });
        }
        // Cell diagonal (HWP borderFill `diagonal`) — drawn on top of the edges. Slash = ⤢ from the
        // bottom-left to the top-right; BackSlash = ⤡ from the top-left to the bottom-right.
        // ONLY on an EMPTY cell: an empty cell's diagonal forms a shape (the section-header band's
        // pointed end on its narrow filler cell, or a "해당없음" N/A slash). A TEXT cell carrying a
        // diagonal is a shared-borderFill artifact (the wide banner cell references the same fill) and
        // Hancom does NOT slash through the text — so we suppress it to avoid a line across the words.
        if let Some(d) = c.diagonal.filter(|_| !cell_has_text(&c.blocks)) {
            let (y1, y2) = match d.kind {
                DiagonalKind::Slash => (cy + ch, cy), // bottom-left → top-right
                DiagonalKind::BackSlash => (cy, cy + ch), // top-left → bottom-right
            };
            pg.lines.push(PlacedLine {
                x1: cx,
                y1,
                x2: cx + cw,
                y2,
                color: d.color,
                style: LineStyle::Solid,
                width: d.width_px.max(HAIRLINE_MIN_PX),
            });
        }
        // Cell TEXT: place the cell's paragraph glyphs inside the box, vertically centered (the
        // Korean gov-doc convention: vertAlign=CENTER), honoring each paragraph's horizontal align.
        place_cell_content(pg, &c.blocks, cx, cy, cw, ch, doc, fonts);
    }
    // Attach the per-cell rects to the table we pushed (point→cell for double-click editing).
    if let Some(pt) = pg.tables.last_mut() {
        pt.cells = placed_cells;
    }
}

/// True if a cell's blocks contain any non-empty text run — used to decide whether a cell's diagonal
/// is decorative shape (empty cell → draw) or a shared-borderFill artifact over words (text → skip).
fn cell_has_text(blocks: &[Block]) -> bool {
    blocks.iter().any(|b| match b {
        Block::Paragraph(p) => p.runs.iter().any(|r| {
            r.content.iter().any(|i| matches!(i, Inline::Text(s) if !s.trim().is_empty()))
        }),
        Block::Table(t) => t.cells.iter().any(|c| cell_has_text(&c.blocks)),
    })
}

/// Emit up to four styled edge lines for a cell box `(cx,cy,cw,ch)` from its per-edge `borders`
/// (`[left, right, top, bottom]`). A `LineStyle::None` edge (선없음) emits NOTHING — that is how a
/// per-edge cell suppresses a side (e.g. the section-header band's right/inner edges). A 0-px width
/// is clamped to 1 so a hairline stays visible.
fn push_cell_edges(pg: &mut PlacedPage, borders: &[Option<CellEdge>; 4], cx: f64, cy: f64, cw: f64, ch: f64) {
    // (edge_index, x1, y1, x2, y2) — left, right, top, bottom.
    let segs = [
        (0usize, cx, cy, cx, cy + ch),           // left
        (1, cx + cw, cy, cx + cw, cy + ch),      // right
        (2, cx, cy, cx + cw, cy),                // top
        (3, cx, cy + ch, cx + cw, cy + ch),      // bottom
    ];
    for (i, x1, y1, x2, y2) in segs {
        let Some(edge) = borders[i] else { continue };
        if edge.style == LineStyle::None {
            continue; // 선없음 — side suppressed, draw nothing
        }
        pg.lines.push(PlacedLine {
            x1,
            y1,
            x2,
            y2,
            color: edge.color,
            style: edge.style,
            width: edge.width_px.max(HAIRLINE_MIN_PX),
        });
    }
}

/// Horizontal inset for cell text from the cell's left/right edges (HWPUNIT ≈ 0.7mm).
const CELL_PAD_X: f64 = 200.0;

/// Floor for any border/diagonal stroke width (device px). Matches rhwp's hairline clamp so a 0.4px
/// gov-doc border still renders as a crisp ~0.5px hairline instead of vanishing at our scale.
const HAIRLINE_MIN_PX: f64 = 0.5;

/// Place a cell's block content (paragraph glyphs) inside its box `(cx,cy,cw,ch)`, vertically centered.
/// Nested tables inside a cell are NOT yet positioned (advance vertical only) — a follow-up.
fn place_cell_content(
    pg: &mut PlacedPage,
    blocks: &[Block],
    cx: f64,
    cy: f64,
    cw: f64,
    ch: f64,
    doc: &SemanticDoc,
    fonts: &dyn FontMetricsProvider,
) {
    let textw = (cw - 2.0 * CELL_PAD_X).max(1.0);
    // Total content height → start offset for vertical centering within the cell box.
    let content_h: f64 = blocks.iter().map(|b| block_height_for_place(b, doc, textw, fonts)).sum();
    let mut vy = cy + ((ch - content_h) / 2.0).max(0.0);
    let plain = FontKey { family: String::new(), bold: false, italic: false };
    for b in blocks {
        let Block::Paragraph(p) = b else {
            // nested table / other block: keep the vertical cursor moving so following paragraphs sit
            // below it (the nested table's own glyphs aren't placed yet — TODO).
            vy += block_height_for_place(b, doc, textw, fonts);
            continue;
        };
        let glyphs = paragraph_glyphs(p, doc);
        let align = doc.para_shapes.get(p.para_shape).map(|s| s.align).unwrap_or_default();
        let ratio = line_spacing_ratio(p, doc);
        // Same paragraph indent as the body: block left/right margins shrink wrap; first line shifts.
        let ind = indent_of(p, doc, textw);
        let lines = layout_paragraph(p, doc, ind.wrap_w, fonts);
        for (li, ls) in lines.iter().enumerate() {
            let line_indent = ind.left + if li == 0 { ind.first_extra } else { 0.0 };
            let slack = (ind.wrap_w - if li == 0 { ind.first_extra.max(0.0) } else { 0.0 } - ls.horz_size).max(0.0);
            let x0 = cx + CELL_PAD_X + line_indent + match align {
                HorizontalAlign::Right => slack,
                HorizontalAlign::Center => slack / 2.0,
                _ => 0.0,
            };
            let baseline = vy + ls.baseline;
            let start = ls.text_pos as usize;
            let end = lines.get(li + 1).map(|n| n.text_pos as usize).unwrap_or(glyphs.len());
            let mut x = x0;
            for g in glyphs.get(start..end.min(glyphs.len())).unwrap_or(&[]) {
                let adv = fonts.advance_width(&plain, g.ch, g.size as i32);
                if g.ch != ' ' && g.ch != '\t' && g.ch != '\n' {
                    pg.glyphs.push(PlacedGlyph {
                        x,
                        baseline,
                        ch: g.ch,
                        size: g.size,
                        color: g.color,
                        underline: g.underline,
                        bold: g.bold,
                        italic: g.italic,
                    });
                }
                x += adv;
            }
            vy += ls.vert_size * ratio;
        }
    }
}

/// Per-column LEFT offsets (len `cols + 1`, last = full width) from `col_widths` or an equal split.
pub(crate) fn column_offsets(t: &Table, avail_w: f64) -> Vec<f64> {
    let mut xs = vec![0.0f64; t.cols + 1];
    if t.col_widths.len() == t.cols && t.col_widths.iter().all(|&w| w > 0) {
        let total: f64 = t.col_widths.iter().map(|&w| w as f64).sum();
        let scale = if total > 0.0 { avail_w / total } else { 1.0 };
        for i in 0..t.cols {
            xs[i + 1] = xs[i] + t.col_widths[i] as f64 * scale;
        }
    } else {
        let cw = avail_w / t.cols as f64;
        for i in 0..=t.cols {
            xs[i] = cw * i as f64;
        }
    }
    xs
}

/// Per-row heights — identical sizing to [`crate::table_height`] (a spanning cell distributes evenly).
fn row_heights(t: &Table, avail_w: f64, doc: &SemanticDoc, fonts: &dyn FontMetricsProvider) -> Vec<f64> {
    let col_x = column_offsets(t, avail_w);
    let mut row_h = vec![0.0f64; t.rows];
    for c in &t.cells {
        if !c.active {
            continue;
        }
        let col_end = (c.col + c.col_span.max(1)).min(t.cols);
        let cw = (col_x[col_end] - col_x[c.col.min(t.cols - 1)]).max(1.0);
        let content: f64 =
            c.blocks.iter().map(|b| block_height_for_place(b, doc, cw, fonts)).sum::<f64>() + crate::CELL_PAD;
        let span = c.row_span.max(1);
        let per = content / span as f64;
        let end = (c.row + span).min(t.rows);
        for slot in row_h.iter_mut().take(end).skip(c.row) {
            *slot = slot.max(per);
        }
    }
    row_h
}

/// Laid-out height of a block at `width` — paragraph (lines×spacing + 위/아래 간격) or nested table.
/// Mirrors `lib.rs::block_height` (private there); kept in lockstep so cell sizing matches pagination.
fn block_height_for_place(b: &Block, doc: &SemanticDoc, width: f64, fonts: &dyn FontMetricsProvider) -> f64 {
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

/// Flat (char, size, color, underline) over a paragraph's text runs — the SAME enumeration order
/// `layout_paragraph` breaks on, so a line's `text_pos` indexes straight into this slice.
struct GlyphInfo {
    ch: char,
    size: f64,
    color: Color,
    underline: bool,
    bold: bool,
    italic: bool,
}

fn paragraph_glyphs(p: &Paragraph, doc: &SemanticDoc) -> Vec<GlyphInfo> {
    let mut out = Vec::new();
    for run in &p.runs {
        let cs = doc.char_shapes.get(run.char_shape);
        let size = cs.map(|c| c.height).filter(|&h| h > 0).unwrap_or(1000) as f64;
        let color = cs.map(|c| c.text_color).unwrap_or_default();
        let underline = cs.map(|c| c.underline).unwrap_or(false);
        let bold = cs.map(|c| c.bold).unwrap_or(false);
        let italic = cs.map(|c| c.italic).unwrap_or(false);
        for inl in &run.content {
            if let Inline::Text(t) = inl {
                for ch in t.chars() {
                    out.push(GlyphInfo { ch: crate::subst_glyph(ch), size, color, underline, bold, italic });
                }
            }
        }
    }
    out
}

/// The tallest anchored image/equation on the paragraph as `(w, h, bin_ref)` — bin_ref empty for an
/// equation (the renderer draws a placeholder box). `None` if the paragraph anchors no object.
fn paragraph_object(p: &Paragraph) -> Option<(f64, f64, String)> {
    let mut best: Option<(f64, f64, String)> = None;
    for run in &p.runs {
        for inl in &run.content {
            let cand = match inl {
                Inline::Image(img) => Some((img.width as f64, img.height as f64, img.bin_ref.clone())),
                Inline::Equation(eq) => Some((eq.width as f64, eq.height as f64, String::new())),
                _ => None,
            };
            if let Some((w, h, r)) = cand {
                if best.as_ref().map(|(_, bh, _)| h > *bh).unwrap_or(true) {
                    best = Some((w, h, r));
                }
            }
        }
    }
    best
}

fn set_page_size(pg: &mut PlacedPage, page: &PageSetup) {
    pg.width = page.width as f64;
    pg.height = page.height as f64;
}

fn new_page(pages: &mut Vec<PlacedPage>, page: &PageSetup) {
    let mut pg = PlacedPage::default();
    set_page_size(&mut pg, page);
    pages.push(pg);
}

/// Re-export so the renderer can compute a baseline from a bare size without re-deriving the ratio.
pub fn baseline_of(size: f64) -> f64 {
    size * BASELINE_RATIO
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ApproxFontMetrics;

    fn para(text: &str) -> Paragraph {
        Paragraph {
            runs: vec![Run { char_shape: 0, content: vec![Inline::Text(text.into())], ..Default::default() }],
            ..Default::default()
        }
    }

    fn doc_with(blocks: Vec<Block>) -> SemanticDoc {
        let mut doc = SemanticDoc::default();
        doc.char_shapes.push(CharShape::default()); // index 0 → size 1000
        doc.para_shapes.push(ParaShape::default());
        let mut sec = Section::default();
        sec.blocks = blocks;
        doc.sections.push(sec);
        doc
    }

    fn one_cell_table(margin: i32) -> Table {
        Table {
            rows: 1,
            cols: 1,
            cells: vec![Cell { row: 0, col: 0, blocks: vec![Block::Paragraph(para("가"))], ..Default::default() }],
            col_widths: vec![1],
            outer_margin_top: margin,
            outer_margin_bottom: margin,
            ..Default::default()
        }
    }

    fn bottom_table_y(margin: i32) -> f64 {
        let doc = doc_with(vec![Block::Table(one_cell_table(margin)), Block::Table(one_cell_table(margin))]);
        let placed = place_doc(&doc, &ApproxFontMetrics);
        // The bottom-most rect's y is the 2nd table's border top.
        placed.pages[0].rects.iter().map(|r| r.y).fold(0.0, f64::max)
    }

    #[test]
    fn block_pages_agrees_with_place_doc_pagination() {
        // Two paragraphs + a table; block_pages must give one page index per block, all within the
        // page count place_doc produces, monotonically non-decreasing in reading order.
        let mut t = Table { rows: 1, cols: 1, col_widths: vec![1], ..Default::default() };
        t.cells.push(Cell { row: 0, col: 0, blocks: vec![Block::Paragraph(para("셀"))], ..Default::default() });
        let doc = doc_with(vec![
            Block::Paragraph(para("첫 문단")),
            Block::Table(t),
            Block::Paragraph(para("끝 문단")),
        ]);
        let placed = place_doc(&doc, &ApproxFontMetrics);
        let bp = block_pages(&doc, &ApproxFontMetrics);
        assert_eq!(bp.len(), 1, "one section");
        assert_eq!(bp[0].len(), 3, "one page index per block");
        let npages = placed.pages.len();
        assert!(bp[0].iter().all(|&p| p < npages), "every block page index is in range: {bp:?} of {npages}");
        assert!(bp[0].windows(2).all(|w| w[0] <= w[1]), "block pages are non-decreasing in reading order");
        // The last block's start page never exceeds the last page.
        assert_eq!(*bp[0].iter().max().unwrap(), npages - 1, "content reaches the last page");
    }

    #[test]
    fn consecutive_tables_get_an_outer_margin_gap() {
        // Outer margins (바깥 여백) must push the 2nd table down so back-to-back tables don't abut.
        // With 500-unit top+bottom margins the gap adds ~1000 HWPUNIT vs no margins.
        let with = bottom_table_y(500);
        let without = bottom_table_y(0);
        assert!(with > without + 900.0, "outer margins separate consecutive tables: {with} vs {without}");
    }

    #[test]
    fn placed_blocks_resolve_point_to_the_right_block() {
        // Two paragraphs framing a table: every top-level block must get exactly one provenance band
        // (in reading order), and `block_at` must map a page point back to the block the user pointed
        // at — the primitive behind own-render point-to-scope / point-to-insert.
        let doc = doc_with(vec![
            Block::Paragraph(para("첫 문단")),
            Block::Table(one_cell_table(0)),
            Block::Paragraph(para("끝 문단")),
        ]);
        let placed = place_doc(&doc, &ApproxFontMetrics);
        let pg = &placed.pages[0];
        assert_eq!(pg.blocks.len(), 3, "one band per top-level block");
        // Bands are in reading order, anchored to their real block index, and the table is tagged.
        assert_eq!(pg.blocks.iter().map(|b| b.block).collect::<Vec<_>>(), vec![0, 1, 2]);
        assert_eq!(pg.blocks[1].kind, BlockKind::Table, "the middle band is the table");
        assert!(pg.blocks[0].kind == BlockKind::Paragraph && pg.blocks[2].kind == BlockKind::Paragraph);
        // Bands descend the page in order, no overlap of the paragraph rows with the table.
        assert!(pg.blocks[0].y < pg.blocks[1].y && pg.blocks[1].y < pg.blocks[2].y, "bands flow downward");
        // A point inside each band resolves to that exact block.
        let mid = |i: usize| pg.blocks[i].y + pg.blocks[i].h / 2.0;
        assert_eq!(pg.block_at(8000.0, mid(0)).unwrap().block, 0, "point in para-0 → block 0");
        let tbl = pg.block_at(8000.0, mid(1)).unwrap();
        assert_eq!((tbl.block, tbl.kind), (1, BlockKind::Table), "point in the table → block 1 (table)");
        assert_eq!(pg.block_at(8000.0, mid(2)).unwrap().block, 2, "point in para-2 → block 2");
        // A point far BELOW all content snaps to the nearest band (the last block) — a near-miss in the
        // bottom margin still scopes a real block instead of failing.
        assert_eq!(pg.block_at(8000.0, 10_000_000.0).unwrap().block, 2, "below-everything snaps to last");
    }

    #[test]
    fn empty_table_does_not_borrow_a_prior_tables_band() {
        // A degenerate 0×0 table makes place_table early-return without pushing a PlacedTable, so the
        // band recorder's `tables.last()` would point at the PREVIOUS table. The anchor guard must keep
        // the empty table from stealing the real table's (section, block) band.
        let real = one_cell_table(0); // 1×1, block 0
        let empty = Table { rows: 0, cols: 0, ..Default::default() }; // block 1, draws nothing
        let doc = doc_with(vec![Block::Table(real), Block::Table(empty)]);
        let placed = place_doc(&doc, &ApproxFontMetrics);
        let pg = &placed.pages[0];
        assert!(
            pg.blocks.iter().all(|b| b.block == 0),
            "the empty table must not produce a band (esp. not one carrying block 0's geometry): {:?}",
            pg.blocks.iter().map(|b| (b.block, b.kind)).collect::<Vec<_>>()
        );
    }

    #[test]
    fn places_glyphs_with_increasing_x_on_one_line() {
        let doc = doc_with(vec![Block::Paragraph(para("가나다"))]);
        let placed = place_doc(&doc, &ApproxFontMetrics);
        assert_eq!(placed.pages.len(), 1);
        let g = &placed.pages[0].glyphs;
        assert_eq!(g.len(), 3, "three Hangul glyphs placed");
        assert_eq!(g.iter().map(|p| p.ch).collect::<String>(), "가나다");
        // x strictly increases (1 EM advance each), and all sit on the same baseline.
        assert!(g[0].x < g[1].x && g[1].x < g[2].x, "x increases left→right");
        assert!((g[0].baseline - g[2].baseline).abs() < 1e-6, "same baseline");
        // First glyph starts at the left margin (default A4: 7200 HWPUNIT).
        assert!((g[0].x - 7200.0).abs() < 1.0, "first glyph at the left margin, got {}", g[0].x);
    }

    #[test]
    fn center_alignment_offsets_the_line() {
        let mut doc = doc_with(vec![Block::Paragraph({
            let mut p = para("가");
            p.para_shape = 1;
            p
        })]);
        // ParaShape index 1 = centered.
        doc.para_shapes.push(ParaShape { align: HorizontalAlign::Center, ..Default::default() });
        let placed = place_doc(&doc, &ApproxFontMetrics);
        let g = &placed.pages[0].glyphs;
        assert_eq!(g.len(), 1);
        // body_w = 59528 - 2*7200 = 45128; one 1000-wide glyph → slack/2 = (45128-1000)/2 = 22064;
        // x = ml(7200) + 22064 = 29264.
        assert!((g[0].x - 29264.0).abs() < 2.0, "centered glyph offset, got {}", g[0].x);
    }

    #[test]
    fn paragraph_left_margin_indents_every_line() {
        let mut doc = doc_with(vec![Block::Paragraph({
            let mut p = para("가");
            p.para_shape = 1;
            p
        })]);
        // ParaShape 1 = left margin 3000 HWPUNIT (들여쓰기 block inset), left-aligned.
        doc.para_shapes
            .push(ParaShape { align: HorizontalAlign::Left, left_margin: 3000, ..Default::default() });
        let placed = place_doc(&doc, &ApproxFontMetrics);
        let g = &placed.pages[0].glyphs;
        assert_eq!(g.len(), 1);
        // ml(7200) + left_margin(3000) = 10200.
        assert!((g[0].x - 10200.0).abs() < 1.0, "left margin shifts the line in, got {}", g[0].x);
    }

    #[test]
    fn first_line_indent_only_shifts_the_first_line() {
        // Long enough to wrap to >=2 lines so we can compare line 0 vs line 1.
        let text: String = "가".repeat(60);
        let mut doc = doc_with(vec![Block::Paragraph({
            let mut p = para(&text);
            p.para_shape = 1;
            p
        })]);
        // First-line indent 2000, left-aligned, no block margin.
        doc.para_shapes
            .push(ParaShape { align: HorizontalAlign::Left, indent: 2000, ..Default::default() });
        let placed = place_doc(&doc, &ApproxFontMetrics);
        let g = &placed.pages[0].glyphs;
        assert!(g.len() > 1, "wrapped to multiple glyphs");
        let first = g[0].x;
        // Find the first glyph on a later line: its x should be back at the bare margin (7200), while
        // the first glyph sits indented by 2000 (→ 9200).
        let later = g.iter().find(|gl| (gl.x - 7200.0).abs() < 1.0);
        assert!((first - 9200.0).abs() < 1.0, "first line indented by 2000, got {}", first);
        assert!(later.is_some(), "a later line starts back at the left margin (no first-line indent)");
    }

    #[test]
    fn hanging_indent_clamps_to_the_left_margin() {
        // 내어쓰기: negative indent larger than the block left margin must clamp so the first line does
        // not cross left of the block inset.
        let mut doc = doc_with(vec![Block::Paragraph({
            let mut p = para("가");
            p.para_shape = 1;
            p
        })]);
        doc.para_shapes.push(ParaShape {
            align: HorizontalAlign::Left,
            left_margin: 1000,
            indent: -5000, // way past the 1000 inset
            ..Default::default()
        });
        let placed = place_doc(&doc, &ApproxFontMetrics);
        let g = &placed.pages[0].glyphs;
        // first_extra clamps to -left(1000); line_indent = left(1000) + (-1000) = 0 → x = ml(7200).
        assert!((g[0].x - 7200.0).abs() < 1.0, "hanging indent clamped to left margin, got {}", g[0].x);
    }

    #[test]
    fn paragraph_text_color_carries_to_placed_glyph() {
        let blue = Color::from_hex("#0000FF").unwrap();
        let mut doc = doc_with(vec![Block::Paragraph(para("파"))]);
        doc.char_shapes[0] = CharShape { text_color: blue, ..Default::default() };
        let placed = place_doc(&doc, &ApproxFontMetrics);
        let g = &placed.pages[0].glyphs;
        assert_eq!(g.len(), 1);
        assert_eq!(g[0].color, blue, "run text color flows to the placed glyph");
    }

    #[test]
    fn cell_glyph_carries_run_text_color() {
        let blue = Color::from_hex("#0000FF").unwrap();
        let mut t = Table { rows: 1, cols: 1, ..Default::default() };
        t.cells.push(Cell { row: 0, col: 0, blocks: vec![Block::Paragraph(para("셀"))], ..Default::default() });
        let mut doc = doc_with(vec![Block::Table(t)]);
        doc.char_shapes[0] = CharShape { text_color: blue, ..Default::default() };
        let placed = place_doc(&doc, &ApproxFontMetrics);
        let cell_glyph = placed.pages[0].glyphs.iter().find(|g| g.ch == '셀').unwrap();
        assert_eq!(cell_glyph.color, blue, "cell run text color flows to the placed glyph");
    }

    #[test]
    fn over_wide_row_does_not_overlap_or_escape() {
        // A 2-col table, but a row whose cells claim col indices 0,1,2,3 (LLM added extras). The
        // out-of-range cells (col >= 2) must be skipped, not stacked on the last column.
        let mut t = Table { rows: 1, cols: 2, ..Default::default() };
        for c in 0..4 {
            t.cells.push(Cell { row: 0, col: c, blocks: vec![Block::Paragraph(para("x"))], ..Default::default() });
        }
        let doc = doc_with(vec![Block::Table(t)]);
        let placed = place_doc(&doc, &ApproxFontMetrics); // must not panic
        // Exactly 2 cell borders (cols 0 and 1); the over-wide cells produced none.
        let borders = placed.pages[0].rects.iter().filter(|r| r.fill.is_none()).count();
        assert_eq!(borders, 2, "only in-range cells draw a border, got {borders}");
        // Every cell rect stays within the table box (page left margin .. right margin).
        let page_right = 59528.0 - 7200.0;
        for r in placed.pages[0].rects.iter().filter(|r| r.fill.is_none()) {
            assert!(r.x + r.w <= page_right + 1.0, "cell stays inside the table box");
        }
    }

    #[test]
    fn cell_paragraph_center_align_offsets_within_cell_width() {
        // A single full-width-table cell with a centered short paragraph: the glyph should sit roughly
        // in the middle of the cell text width, not flush-left (gov-table numbers/headers center).
        let mut t = Table { rows: 1, cols: 1, ..Default::default() };
        t.cells.push(Cell {
            row: 0,
            col: 0,
            blocks: vec![Block::Paragraph({
                let mut p = para("중");
                p.para_shape = 1;
                p
            })],
            ..Default::default()
        });
        let mut doc = doc_with(vec![Block::Table(t)]);
        doc.para_shapes.push(ParaShape { align: HorizontalAlign::Center, ..Default::default() });
        let placed = place_doc(&doc, &ApproxFontMetrics);
        let g = placed.pages[0].glyphs.iter().find(|g| g.ch == '중').unwrap();
        // Cell spans the full body width (45128); text width = 45128 - 2*CELL_PAD_X = 44728; one
        // 1000-wide glyph centered → x ≈ ml(7200) + CELL_PAD_X(200) + (44728-1000)/2 = 29264.
        let left_flush = 7200.0 + CELL_PAD_X;
        assert!(g.x > left_flush + 5000.0, "centered cell glyph is pushed right of flush-left, got {}", g.x);
    }

    #[test]
    fn out_of_range_row_index_is_skipped() {
        let mut t = Table { rows: 1, cols: 1, ..Default::default() };
        t.cells.push(Cell { row: 0, col: 0, blocks: vec![Block::Paragraph(para("ok"))], ..Default::default() });
        t.cells.push(Cell { row: 5, col: 0, blocks: vec![Block::Paragraph(para("bad"))], ..Default::default() });
        let doc = doc_with(vec![Block::Table(t)]);
        let placed = place_doc(&doc, &ApproxFontMetrics); // must not panic
        let borders = placed.pages[0].rects.iter().filter(|r| r.fill.is_none()).count();
        assert_eq!(borders, 1, "the out-of-range row cell is skipped, got {borders}");
    }

    #[test]
    fn table_emits_cell_boxes() {
        let mut t = Table { rows: 2, cols: 2, ..Default::default() };
        for r in 0..2 {
            for c in 0..2 {
                t.cells.push(Cell {
                    row: r,
                    col: c,
                    blocks: vec![Block::Paragraph(para("x"))],
                    ..Default::default()
                });
            }
        }
        let doc = doc_with(vec![Block::Table(t)]);
        let placed = place_doc(&doc, &ApproxFontMetrics);
        let cell_borders = placed.pages[0].rects.iter().filter(|r| r.fill.is_none()).count();
        // 4 cell borders + the line text-boxes inside each cell paragraph.
        assert!(cell_borders >= 4, "at least 4 cell border boxes, got {cell_borders}");
    }

    /// Build a 1-cell table whose single cell carries the given per-edge borders + diagonal.
    fn edge_table(borders: [Option<CellEdge>; 4], diagonal: Option<CellDiagonal>) -> SemanticDoc {
        edge_table_text(borders, diagonal, "x")
    }

    fn edge_table_text(borders: [Option<CellEdge>; 4], diagonal: Option<CellDiagonal>, text: &str) -> SemanticDoc {
        let cell = Cell {
            row: 0,
            col: 0,
            blocks: vec![Block::Paragraph(para(text))],
            borders,
            diagonal,
            ..Default::default()
        };
        doc_with(vec![Block::Table(Table {
            rows: 1,
            cols: 1,
            cells: vec![cell],
            col_widths: vec![1],
            ..Default::default()
        })])
    }

    #[test]
    fn per_edge_borders_skip_none_and_emit_styled_lines() {
        let blue = Color { r: 0, g: 0, b: 255, a: 255 };
        // left = dashed blue, right = 선없음 (suppressed), top = solid black, bottom = unspecified.
        let borders = [
            Some(CellEdge { color: blue, style: LineStyle::Dashed, width_px: 2.0 }),
            Some(CellEdge { color: Color::default(), style: LineStyle::None, width_px: 1.0 }),
            Some(CellEdge { color: Color::default(), style: LineStyle::Solid, width_px: 1.0 }),
            None,
        ];
        let doc = edge_table(borders, None);
        let placed = place_doc(&doc, &ApproxFontMetrics);
        let lines = &placed.pages[0].lines;
        // A per-edge cell does NOT emit the legacy uniform border rect.
        assert_eq!(
            placed.pages[0].rects.iter().filter(|r| r.fill.is_none()).count(),
            0,
            "per-edge cell must not draw the legacy uniform box"
        );
        // Exactly two visible edges: the dashed-blue left and the solid-black top. The 선없음 right
        // emits NO line; the unspecified (None) bottom emits no line either.
        assert_eq!(lines.len(), 2, "only the two visible edges emit lines, got {}", lines.len());
        let dashed = lines.iter().find(|l| l.style == LineStyle::Dashed).expect("a dashed edge line");
        assert_eq!(dashed.color, blue, "dashed edge keeps its blue color");
        assert_eq!(dashed.width, 2.0, "dashed edge keeps its width px");
        let solid = lines.iter().find(|l| l.style == LineStyle::Solid).expect("the solid top edge");
        // A 1.0px (above-floor) edge keeps its width — placement only clamps the floor, never rounds.
        assert_eq!(solid.width, 1.0, "an above-floor edge width is preserved verbatim");
        assert!(
            !lines.iter().any(|l| l.style == LineStyle::None),
            "a 선없음 edge never emits a Line"
        );
    }

    #[test]
    fn sub_floor_edge_width_clamps_to_hairline_not_zero() {
        // A 0.3px hairline (below HAIRLINE_MIN_PX) must clamp UP to the floor so it stays visible —
        // not pass through at 0.3 (would anti-alias to nothing) nor round up to a heavier 1px.
        let borders = [
            Some(CellEdge { color: Color::default(), style: LineStyle::Solid, width_px: 0.3 }),
            None,
            None,
            None,
        ];
        let placed = place_doc(&edge_table(borders, None), &ApproxFontMetrics);
        let edge = placed.pages[0].lines.first().expect("the one visible edge");
        assert_eq!(edge.width, HAIRLINE_MIN_PX, "sub-floor width clamps to the hairline floor");
    }

    #[test]
    fn cell_diagonal_emits_a_line_corner_to_corner_on_empty_cell() {
        let red = Color { r: 255, g: 0, b: 0, a: 255 };
        // An EMPTY cell with a back-slash diagonal (top-left → bottom-right): the diagonal forms a
        // shape (the section-header band's pointed end / an N/A slash) so it IS drawn.
        let doc = edge_table_text([None; 4], Some(CellDiagonal { kind: DiagonalKind::BackSlash, color: red, width_px: 1.0 }), "");
        let placed = place_doc(&doc, &ApproxFontMetrics);
        let lines = &placed.pages[0].lines;
        let diag = lines.iter().find(|l| l.color == red).expect("a diagonal line on the empty cell");
        assert!(diag.x2 > diag.x1 && diag.y2 > diag.y1, "back-slash runs top-left → bottom-right");
    }

    #[test]
    fn cell_diagonal_suppressed_when_cell_has_text() {
        // A diagonal on a TEXT cell (e.g. the wide banner cell sharing the band's borderFill) is NOT
        // drawn — Hancom doesn't slash through the words; only the empty point cell shows the line.
        let red = Color { r: 255, g: 0, b: 0, a: 255 };
        let doc = edge_table_text([None; 4], Some(CellDiagonal { kind: DiagonalKind::BackSlash, color: red, width_px: 1.0 }), "제목");
        let placed = place_doc(&doc, &ApproxFontMetrics);
        assert!(
            !placed.pages[0].lines.iter().any(|l| l.color == red),
            "a diagonal over text is suppressed"
        );
    }

    #[test]
    fn placed_page_count_matches_naive_layout() {
        let mut sec_blocks = Vec::new();
        for _ in 0..100 {
            sec_blocks.push(Block::Paragraph(para("한 줄")));
        }
        let doc = doc_with(sec_blocks);
        let placed = place_doc(&doc, &ApproxFontMetrics);
        let naive = crate::NaiveLayout
            .layout(&doc, &ApproxFontMetrics)
            .unwrap()
            .pages
            .len();
        assert_eq!(placed.pages.len(), naive, "placed pagination == NaiveLayout pagination");
        assert!(placed.pages.len() >= 2, "100 lines paginate");
    }
}
