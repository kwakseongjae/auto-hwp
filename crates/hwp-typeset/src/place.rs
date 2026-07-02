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
    /// Requested font family (CharShape.font_family) — DISPLAY only (the renderer sets it as the SVG
    /// `font-family`); glyph advances still use the default metrics, so a font change re-displays
    /// without reflowing. `None` = the document default face.
    pub font: Option<String>,
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
    /// Logical row/column counts of the WHOLE table — so a quick-edit overlay can append a row
    /// (`TableInsertRows` wants the column count + the append-at row) without a second query. These are
    /// the full-table counts even on a continuation fragment (see `first_row`/`last_row`).
    pub rows: usize,
    pub cols: usize,
    /// The half-open ROW RANGE `[first_row, last_row)` this placed box covers. A table that fits one
    /// page is the degenerate single fragment `0..rows`. A table SPLIT across pages emits one
    /// `PlacedTable` per page, each keyed to the SAME `(section, block)` but covering only its rows — so
    /// a consumer must treat "a fragment is per-page" (pick by page / aggregate), never "one box = whole
    /// table". `cells` holds only this fragment's rows.
    pub first_row: usize,
    pub last_row: usize,
    /// Per-cell page rects (provenance only) so a double-click can resolve which CELL was hit — the
    /// basis for direct "표에 내용 작성" (point a cell → edit it). Empty for tables placed before this
    /// was added; populated by `place_table`. Holds only this fragment's rows when the table is split.
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
    /// Printable-area margins (HWPUNIT, page-top-left origin) from the section's `PageSetup`. Provenance
    /// for the editor's margin guides / ruler chrome — NOT drawn into the page SVG, so they never leak
    /// into export. 0 on a default page.
    pub margin_left: f64,
    pub margin_top: f64,
    pub margin_right: f64,
    pub margin_bottom: f64,
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
                    if (p.page_break_before || ps.map(|s| s.page_break_before).unwrap_or(false)) && vert > 0.0 {
                        new_page(&mut pages, page);
                        vert = 0.0;
                    }
                    // A pure table anchor reserves NO height + draws nothing — the following Table block
                    // owns the space. Mirrors NaiveLayout + block_pages (skip its line) for lockstep.
                    if p.is_table_anchor {
                        started = true;
                        continue;
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
                    // Promote a 1×1 frame-wrapper (자가진단표) to its inner table so a tall nested grid
                    // splits at row granularity instead of bumping whole; the outer box rides along as
                    // `frame` and is redrawn per page fragment. Identical predicate in NaiveLayout +
                    // block_pages → lockstep.
                    let unwrapped = crate::unwrap_frame_table(t);
                    let (t, frame) = match &unwrapped {
                        Some((inner, f)) => (inner, *f),
                        None => (t, None),
                    };
                    // Outer top margin (바깥 여백): the gap HWP keeps above the table, but only when it
                    // isn't the first block on the page (mirrors paragraph space_before).
                    if vert > 0.0 {
                        vert += t.outer_margin_top.max(0) as f64;
                    }
                    let start_page = pages.len() - 1;
                    // place_table SPLITS the table across pages itself (한글식 row-level break): a
                    // first-row reserve, then a new page whenever the next row crosses the body bottom,
                    // emitting one bordered fragment per page. Returns the final page-relative cursor.
                    vert = place_table(t, doc, fonts, ml, mt, body_h, vert, body_w, &mut pages, page, sec_idx, blk_idx, frame);
                    let end_page = pages.len() - 1;
                    // Provenance bands for point-to-scope: one band per fragment page from its ACTUAL box,
                    // so own_hit_test resolves the table — and the scope pin hugs it — on EVERY page it
                    // touches. A degenerate 0×N table pushes no fragment, so the find simply yields none.
                    for pi in start_page..=end_page {
                        let band = pages[pi].tables.iter().rev()
                            .find(|pt| pt.section == sec_idx && pt.block == blk_idx)
                            .map(|pt| PlacedBlock { x: pt.x, y: pt.y, w: pt.w, h: pt.h, section: sec_idx, block: blk_idx, kind: BlockKind::Table });
                        if let Some(b) = band {
                            pages[pi].blocks.push(b);
                        }
                    }
                    // Outer bottom margin so the next block doesn't abut the table. NO trailing
                    // page-slice: place_table already broke every row that didn't fit, so any leftover
                    // (an over-tall row's clipped overflow, or a bottom-margin spill) is left as
                    // vert>body_h and resolved by the NEXT block's page reserve — IDENTICAL to
                    // NaiveLayout, keeping the two page counts in lockstep (a `while vert>body_h` here
                    // would re-fragment an over-tall row that NaiveLayout leaves whole → page drift).
                    vert += t.outer_margin_bottom.max(0) as f64;
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
                    if (p.page_break_before || ps.map(|s| s.page_break_before).unwrap_or(false)) && vert > 0.0 {
                        page_idx += 1;
                        vert = 0.0;
                    }
                    // A pure table anchor reserves no height; still record ONE start page (block→page must
                    // stay 1:1) at the current page, then skip. Mirrors NaiveLayout + place_doc.
                    if p.is_table_anchor {
                        sec_pages.push(page_idx);
                        started = true;
                        continue;
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
                    // Promote a 1×1 frame-wrapper (자가진단표) to its inner table — identical to place_doc +
                    // NaiveLayout so the start pages stay lockstep.
                    let unwrapped = crate::unwrap_frame_table(t);
                    let t = unwrapped.as_ref().map(|(it, _)| it).unwrap_or(t);
                    if vert > 0.0 {
                        vert += t.outer_margin_top.max(0) as f64;
                    }
                    // Row-level split accounting, matching place_doc/place_table: a row that doesn't fit
                    // the remaining body flows to the next page. Record the page where the FIRST row
                    // lands as the table's start page (outline/page-nav only needs the start).
                    let row_h = crate::table_row_heights(t, body_w, doc, fonts);
                    // `rh <= body_h` on both checks: an over-tall row (taller than the whole body) never
                    // forces a page bump — mirrors place_table + NaiveLayout so the start pages stay aligned.
                    if vert > 0.0 && row_h.first().map(|&rh| vert + rh > body_h && rh <= body_h).unwrap_or(false) {
                        page_idx += 1;
                        vert = 0.0;
                    }
                    sec_pages.push(page_idx); // the table starts here (where its first row lands)
                    for (r, rh) in row_h.iter().enumerate() {
                        if r > 0 && vert + rh > body_h && vert > 0.0 && *rh <= body_h {
                            page_idx += 1;
                            vert = 0.0;
                        }
                        vert += rh;
                    }
                    vert += t.outer_margin_bottom.max(0) as f64;
                    // No trailing page-slice (matches place_doc/NaiveLayout): a leftover over-tall row /
                    // margin spill is resolved by the next block's reserve, so the recorded start pages
                    // stay aligned with place_doc's fragment pages.
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
            let adv = fonts.advance_width(&plain, g.ch, g.size as i32) * g.ratio + g.spacing_em * g.size;
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
                    font: g.font.clone(),
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

/// Place a table, SPLITTING it across pages at row boundaries when it doesn't fit (한글식 표 나눔).
/// Column widths come from `col_widths` (else an equal split, mirroring `table_height`). `vert` is the
/// page-relative cursor where the table starts; `mt`/`body_h` frame the body. A first-row reserve moves
/// the table to a fresh page if even its first row won't fit the remaining space; thereafter each row
/// that would cross the body bottom starts a NEW page (via `new_page`). Emits ONE `PlacedTable` fragment
/// per page (a proper bordered box over only that page's rows), so the per-page renderer draws the table
/// form on each page with no table awareness. Returns the final page-relative cursor (last fragment's
/// bottom). A table that fits yields exactly one fragment — byte-identical to the pre-split output.
#[allow(clippy::too_many_arguments)]
fn place_table(
    t: &Table,
    doc: &SemanticDoc,
    fonts: &dyn FontMetricsProvider,
    ml: f64,
    mt: f64,
    body_h: f64,
    vert: f64,
    avail_w: f64,
    pages: &mut Vec<PlacedPage>,
    page: &PageSetup,
    section: usize,
    block: usize,
    frame: Option<CellEdge>,
) -> f64 {
    if t.rows == 0 || t.cols == 0 {
        return vert;
    }
    let col_x = column_offsets(t, avail_w);
    // Per-row heights: the SAME sizing the reservation summed (table_height), so fragment heights add up
    // exactly and the page boundaries match NaiveLayout's row-level accounting.
    let row_h = row_heights(t, avail_w, doc, fonts);

    let mut vert = vert;
    // First-row reserve: if not at page top and even the first row won't fit the remaining body, start
    // the table on a fresh page (a table that fits stays put; one that doesn't begins on a clean page).
    // EXCEPT a row taller than the whole body (e.g. the 자가진단표 wrapped in one 1×1 cell): bumping it to
    // a fresh page can't help — it won't fit there either — and only wastes the current page (leaving the
    // heading's page blank below it). Draw it here and let it overflow/clip, same as a mid-table over-tall
    // row. Mirrored in NaiveLayout + block_pages (lib.rs) to keep the page counts in lockstep.
    if vert > 0.0 && vert + row_h[0] > body_h && row_h[0] <= body_h {
        new_page(pages, page);
        vert = 0.0;
    }
    let mut frag_first = 0usize; // first row index of the current page fragment
    let mut frag_top = mt + vert; // absolute y of the current fragment's top edge
    let mut y = mt + vert; // absolute running top of the next row
    for r in 0..t.rows {
        // Break BEFORE row r if it would cross the body bottom — but never before a fragment's own first
        // row (a row taller than a whole page draws and clips, like before, rather than looping forever),
        // and never to give a row TALLER than the whole body its own page (it can't fit there either, so
        // the break would only waste the current page). `rh <= body_h` mirrors NaiveLayout/block_pages.
        if r > frag_first && (y - mt) + row_h[r] > body_h && row_h[r] <= body_h {
            flush_fragment(pages, t, doc, fonts, ml, frag_top, &col_x, &row_h, frag_first, r, section, block, frame);
            new_page(pages, page);
            frag_first = r;
            frag_top = mt;
            y = mt;
        }
        y += row_h[r];
    }
    flush_fragment(pages, t, doc, fonts, ml, frag_top, &col_x, &row_h, frag_first, t.rows, section, block, frame);
    y - mt // final page-relative cursor (bottom of the last fragment)
}

/// Draw ONE page fragment of a table: rows `[first, last)` anchored at `frag_top` on the LAST page, as a
/// bordered box with per-cell shade/edges/diagonal/text. Pushes one `PlacedTable` covering this row range
/// (keyed to the table's `(section, block)`). A merged cell straddling the fragment boundary has its
/// drawn span CLAMPED to this fragment's rows (its box continues on each page; its TEXT is drawn only in
/// the fragment that owns the cell's top row, so it isn't duplicated across the break).
#[allow(clippy::too_many_arguments)]
fn flush_fragment(
    pages: &mut [PlacedPage],
    t: &Table,
    doc: &SemanticDoc,
    fonts: &dyn FontMetricsProvider,
    ml: f64,
    frag_top: f64,
    col_x: &[f64],
    row_h: &[f64],
    first: usize,
    last: usize,
    section: usize,
    block: usize,
    frame: Option<CellEdge>,
) {
    if first >= last {
        return;
    }
    // Row tops within THIS fragment, rebased to frag_top (index r-first).
    let mut row_top = vec![frag_top; last - first + 1];
    for r in first..last {
        row_top[r + 1 - first] = row_top[r - first] + row_h[r];
    }
    let top_of = |r: usize| -> f64 { row_top[r.clamp(first, last) - first] };

    let pg = match pages.last_mut() {
        Some(p) => p,
        None => return,
    };
    // Outer-box provenance (anchor → page rect) for the drag-to-move overlay + point-to-scope. Drawn
    // from the actual placed extents so it matches the visible fragment exactly. Provenance only.
    pg.tables.push(PlacedTable {
        x: ml,
        y: frag_top,
        w: col_x[t.cols],
        h: row_top[last - first] - frag_top,
        section,
        block,
        rows: t.rows,
        cols: t.cols,
        first_row: first,
        last_row: last,
        cells: Vec::new(), // filled below, then attached
    });
    let mut placed_cells: Vec<PlacedCell> = Vec::new();
    for c in &t.cells {
        if !c.active {
            continue;
        }
        // Defensive clamp: an LLM edit can append a row with MORE cells than the table has columns (or a
        // stray row index). Such a cell would otherwise reuse the last column/row and draw over a real
        // cell or outside the table box. Skip it entirely so nothing overlaps/escapes.
        if c.col >= t.cols || c.row >= t.rows {
            continue;
        }
        // Clamp the cell's drawn ROW span to THIS fragment; skip a cell wholly outside it.
        let r0 = c.row.max(first);
        let r1 = (c.row + c.row_span.max(1)).min(last);
        if r0 >= r1 {
            continue;
        }
        let cx = ml + col_x[c.col];
        let col_end = (c.col + c.col_span.max(1)).min(t.cols);
        let cw = (col_x[col_end] - col_x[c.col]).max(1.0);
        let cy = top_of(r0);
        let ch = (top_of(r1) - cy).max(1.0);
        // Cell provenance rect (point→cell for double-click editing) — keyed to the real (row, col).
        placed_cells.push(PlacedCell { row: c.row, col: c.col, x: cx, y: cy, w: cw, h: ch });
        // Cell shade (fill) UNDER its border so the border stays visible.
        if let Some(shade) = c.shade_color {
            pg.rects.push(PlacedRect { x: cx, y: cy, w: cw, h: ch, fill: Some(shade) });
        }
        // Cell borders. Two paths:
        //  - PER-EDGE (lifted from the real borderFill): draw each visible edge as its own styled line,
        //    skipping 선없음 sides — makes the ※ guide boxes DASHED, the section-header band a pentagon.
        //  - LEGACY (no per-edge data, e.g. inserted/test cells): the uniform stroked box, gated on
        //    `has_border`, exactly as before — so nothing regresses.
        if c.has_edge_borders() {
            push_cell_edges(pg, &c.borders, cx, cy, cw, ch);
        } else if c.has_border {
            pg.rects.push(PlacedRect { x: cx, y: cy, w: cw, h: ch, fill: None });
        }
        // Cell diagonal (HWP borderFill `diagonal`) — only on an EMPTY cell (forms a shape; a text cell's
        // diagonal is a shared-borderFill artifact Hancom doesn't draw through the words).
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
        // Cell TEXT: only in the fragment that OWNS the cell's TOP row (c.row >= first) so a cell whose
        // span crosses the page break doesn't draw its text twice. Vertically centered (gov-doc
        // vertAlign=CENTER), honoring each paragraph's horizontal align.
        if c.row >= first {
            place_cell_content(pg, &c.blocks, cx, cy, cw, ch, doc, fonts);
        }
    }
    // Outer frame (an unwrapped 1×1-wrapper's box, e.g. 자가진단표): the left/right sides draw on EVERY
    // fragment; the top only on the table's TRUE first row and the bottom only on its TRUE last row — so
    // the box continues across the page split (한글식) instead of closing per page.
    if let Some(f) = frame.filter(|f| f.style != LineStyle::None) {
        let x0 = ml;
        let x1 = ml + col_x[t.cols];
        let y0 = frag_top;
        let y1 = row_top[last - first];
        let w = f.width_px.max(HAIRLINE_MIN_PX);
        let mut edge = |x1_: f64, y1_: f64, x2_: f64, y2_: f64| {
            pg.lines.push(PlacedLine { x1: x1_, y1: y1_, x2: x2_, y2: y2_, color: f.color, style: f.style, width: w });
        };
        edge(x0, y0, x0, y1); // left
        edge(x1, y0, x1, y1); // right
        if first == 0 {
            edge(x0, y0, x1, y0); // top — only the table's first fragment
        }
        if last == t.rows {
            edge(x0, y1, x1, y1); // bottom — only the last fragment
        }
    }
    // Attach the per-cell rects to the fragment we pushed (point→cell for double-click editing).
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

/// Horizontal inset for cell text from the cell's left/right edges (HWPUNIT ≈ 0.7mm). Cell text is
/// laid out (and its height RESERVED) at `cw - 2*CELL_PAD_X` so the reservation equals what's drawn —
/// otherwise a label that fits at the full `cw` but wraps at the padded width drew a 2nd line BELOW the
/// reserved row, overlapping the next cell.
pub(crate) const CELL_PAD_X: f64 = 80.0;

/// Floor for any border/diagonal stroke width (device px). Matches rhwp's hairline clamp so a 0.4px
/// gov-doc border still renders as a crisp ~0.5px hairline instead of vanishing at our scale.
const HAIRLINE_MIN_PX: f64 = 0.5;

/// Draw a NESTED table (a table that lives inside a cell) at origin `(ox, oy)` within width `avail_w` on a
/// SINGLE page. A nested table never paginates internally — its whole height is reserved as part of the
/// outer cell's row — so this draws ALL rows at once (clipping if taller than the page, matching how an
/// over-tall outer row already clips). Mirrors `flush_fragment`'s per-cell drawing (shade → border → diagonal
/// → content) minus the page/fragment logic, and recurses through `place_cell_content` for deeper nesting.
/// No `PlacedTable` provenance is pushed (nested cells aren't drag/edit targets yet).
fn place_nested_table(
    pg: &mut PlacedPage,
    t: &Table,
    ox: f64,
    oy: f64,
    avail_w: f64,
    doc: &SemanticDoc,
    fonts: &dyn FontMetricsProvider,
) {
    if t.rows == 0 || t.cols == 0 {
        return;
    }
    let col_x = column_offsets(t, avail_w);
    let row_h = row_heights(t, avail_w, doc, fonts);
    // Absolute row tops (rebased to oy) — same accounting flush_fragment uses, so the drawn height equals
    // the height block_height_for_place reserved for this nested table.
    let mut row_top = vec![oy; t.rows + 1];
    for r in 0..t.rows {
        row_top[r + 1] = row_top[r] + row_h[r];
    }
    for c in &t.cells {
        if !c.active || c.col >= t.cols || c.row >= t.rows {
            continue;
        }
        let cx = ox + col_x[c.col];
        let col_end = (c.col + c.col_span.max(1)).min(t.cols);
        let cw = (col_x[col_end] - col_x[c.col]).max(1.0);
        let cy = row_top[c.row];
        let r1 = (c.row + c.row_span.max(1)).min(t.rows);
        let ch = (row_top[r1] - cy).max(1.0);
        if let Some(shade) = c.shade_color {
            pg.rects.push(PlacedRect { x: cx, y: cy, w: cw, h: ch, fill: Some(shade) });
        }
        if c.has_edge_borders() {
            push_cell_edges(pg, &c.borders, cx, cy, cw, ch);
        } else if c.has_border {
            pg.rects.push(PlacedRect { x: cx, y: cy, w: cw, h: ch, fill: None });
        }
        if let Some(d) = c.diagonal.filter(|_| !cell_has_text(&c.blocks)) {
            let (y1, y2) = match d.kind {
                DiagonalKind::Slash => (cy + ch, cy),
                DiagonalKind::BackSlash => (cy, cy + ch),
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
        place_cell_content(pg, &c.blocks, cx, cy, cw, ch, doc, fonts);
    }
}

/// Place a cell's block content (paragraph glyphs + nested tables) inside its box `(cx,cy,cw,ch)`,
/// vertically centered. A nested table is drawn in place (see `place_nested_table`).
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
            // A NESTED table (a table inside this cell): DRAW it at the current cursor — its height is
            // already reserved in `content_h` (block_height_for_place's Table arm), so the cursor advances
            // by the SAME amount and the pagination math is untouched. Before this, the nested table's
            // glyphs/borders were skipped entirely → the cell (e.g. the 자가진단표 wrapped in a 1×1 table)
            // rendered BLANK. Other block kinds just advance the cursor as before.
            if let Block::Table(nt) = b {
                place_nested_table(pg, nt, cx + CELL_PAD_X, vy, textw, doc, fonts);
            }
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
                let adv = fonts.advance_width(&plain, g.ch, g.size as i32) * g.ratio + g.spacing_em * g.size;
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
                        font: g.font.clone(),
                    });
                }
                x += adv;
            }
            vy += ls.vert_size * ratio;
        }
    }
}

/// Per-column LEFT offsets (len `cols + 1`, last = full width) from `col_widths` or an equal split.
pub fn column_offsets(t: &Table, avail_w: f64) -> Vec<f64> {
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
        // Reserve at the SAME padded text width the glyphs are drawn at (place_cell_content), so a row
        // never reserves fewer lines than get drawn (the 2-line-label-over-next-cell overlap).
        let tw = (cw - 2.0 * CELL_PAD_X).max(1.0);
        let content: f64 =
            c.blocks.iter().map(|b| block_height_for_place(b, doc, tw, fonts)).sum::<f64>() + crate::CELL_PAD;
        let span = c.row_span.max(1);
        let per = content / span as f64;
        let end = (c.row + span).min(t.rows);
        for slot in row_h.iter_mut().take(end).skip(c.row) {
            *slot = slot.max(per);
        }
    }
    crate::apply_row_overrides(&mut row_h, t);
    row_h
}

/// Cumulative row TOPS relative to the table's top edge, length `rows + 1` — the row twin of
/// [`column_offsets`]. `row_offsets[r]` is the y of row r's top edge; `row_offsets[rows]` is the
/// table's content height. Needs `doc`/`fonts` because row heights are content-measured (unlike the
/// explicit column widths). Powers the `table_row_boundaries` resize-handle geometry.
pub fn row_offsets(t: &Table, avail_w: f64, doc: &SemanticDoc, fonts: &dyn FontMetricsProvider) -> Vec<f64> {
    let row_h = row_heights(t, avail_w, doc, fonts);
    let mut tops = vec![0.0f64; t.rows + 1];
    for r in 0..t.rows {
        tops[r + 1] = tops[r] + row_h[r];
    }
    tops
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
    /// Requested font family (CharShape.font_family) — display only (the SVG/text font-family); advances
    /// still use the default metrics, so a font change re-DISPLAYS without reflowing.
    font: Option<String>,
    /// 장평 (width scale, default 1.0) + 자간 (letter gap as a fraction of the EM, default 0.0), resolved
    /// from the run's char shape per the glyph's script. The DRAWN advance must apply these so glyphs
    /// sit where the line-breaker (which now scales advances) computed — else a compressed run renders
    /// ~10% too wide and overflows its column.
    ratio: f64,
    spacing_em: f64,
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
        let font = cs.and_then(|c| c.font_family.clone()).filter(|s| !s.trim().is_empty());
        for inl in &run.content {
            if let Inline::Text(t) = inl {
                for ch in t.chars() {
                    let sch = crate::subst_glyph(ch);
                    let (ratio, spacing_em) = cs
                        .map(|c| {
                            let slot = crate::script_slot(sch);
                            let r = match *c.ratio.get(slot) { 0 => 100, r => r.clamp(50, 200) } as f64 / 100.0;
                            let s = (*c.spacing.get(slot)).clamp(-50, 50) as f64 / 100.0;
                            (r, s)
                        })
                        .unwrap_or((1.0, 0.0));
                    out.push(GlyphInfo { ch: sch, size, color, underline, bold, italic, font: font.clone(), ratio, spacing_em });
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
    pg.margin_left = page.margin_left as f64;
    pg.margin_top = page.margin_top as f64;
    pg.margin_right = page.margin_right as f64;
    pg.margin_bottom = page.margin_bottom as f64;
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

    /// A doc with one section whose page is `height` tall (no margins, wide body) — lets a test force a
    /// table to overflow with a known body height.
    fn doc_with_page(blocks: Vec<Block>, height: i32) -> SemanticDoc {
        let mut doc = SemanticDoc::default();
        doc.char_shapes.push(CharShape::default());
        doc.para_shapes.push(ParaShape::default());
        let mut sec = Section::default();
        sec.page.width = 60000;
        sec.page.height = height;
        sec.page.margin_left = 0;
        sec.page.margin_top = 0;
        sec.page.margin_right = 0;
        sec.page.margin_bottom = 0;
        sec.blocks = blocks;
        doc.sections.push(sec);
        doc
    }

    fn n_row_table(n: usize) -> Table {
        let cells = (0..n)
            .map(|r| Cell { row: r, col: 0, blocks: vec![Block::Paragraph(para("행"))], ..Default::default() })
            .collect();
        Table { rows: n, cols: 1, cells, col_widths: vec![1], ..Default::default() }
    }

    #[test]
    fn table_anchor_paragraph_reserves_no_height() {
        use crate::LayoutEngine;
        // A pure table-anchor paragraph (empty, is_table_anchor) reserves NO vertical space: the table
        // starts at the page top, exactly as if the anchor weren't there. A normal empty paragraph would
        // push the table down by one line. Regression for the benchmark1 phantom-anchor over-reservation.
        let anchor = Paragraph { is_table_anchor: true, ..Default::default() };
        let doc = doc_with_page(vec![Block::Paragraph(anchor), Block::Table(n_row_table(2))], 800_000);
        let placed = place_doc(&doc, &ApproxFontMetrics);
        let t = placed.pages[0].tables.first().expect("table placed on page 0");
        assert!((t.y - 0.0).abs() < 1.0, "anchor reserves no line → table top at page-top (mt=0), got {}", t.y);
        // Lockstep with the oracle.
        let naive = crate::NaiveLayout.layout(&doc, &ApproxFontMetrics).unwrap().pages.len();
        assert_eq!(placed.pages.len(), naive, "place_doc {} == NaiveLayout {naive}", placed.pages.len());
    }

    #[test]
    fn frame_wrapper_table_unwraps_and_splits_at_row_granularity() {
        use crate::LayoutEngine;
        // 자가진단표 regression: a 1×1 table whose only cell wraps a 20-row nested table, preceded by a
        // heading paragraph (vert>0). The nested grid must be PROMOTED and SPLIT at row boundaries
        // (flowing from the heading's page) — NOT bumped whole to the next page as one atomic 1×1 row.
        let frame = CellEdge { color: Color { r: 0, g: 0, b: 0, a: 255 }, style: LineStyle::Solid, width_px: 2.0 };
        let outer = Table {
            rows: 1,
            cols: 1,
            col_widths: vec![1],
            cells: vec![Cell {
                row: 0,
                col: 0,
                blocks: vec![Block::Table(n_row_table(20))],
                borders: [Some(frame); 4],
                ..Default::default()
            }],
            ..Default::default()
        };
        let doc = doc_with_page(vec![Block::Paragraph(para("Ⅰ. 자가진단표")), Block::Table(outer)], 8000);
        let placed = place_doc(&doc, &ApproxFontMetrics);
        // Promoted + split: ≥2 row fragments (the atomic 1×1 outer would have yielded exactly one).
        let frags: Vec<&PlacedTable> = placed.pages.iter().flat_map(|p| p.tables.iter()).collect();
        assert!(frags.len() >= 2, "frame wrapper splits into ≥2 row fragments, got {}", frags.len());
        // Promoted to the inner 20×1, not the 1×1 outer.
        assert_eq!(frags[0].rows, 20, "fragments are keyed to the promoted inner table (20 rows)");
        // Flows from the heading's page (page 0), not bumped to a fresh page.
        assert!(!placed.pages[0].tables.is_empty(), "the grid starts on the heading's page");
        // The outer frame is redrawn on the first fragment's page (a stroked box continues across the split).
        assert!(!placed.pages[0].lines.is_empty(), "the frame box draws on the first fragment");
        // Lockstep with the oracle.
        let naive = crate::NaiveLayout.layout(&doc, &ApproxFontMetrics).unwrap().pages.len();
        assert_eq!(placed.pages.len(), naive, "place_doc {} == NaiveLayout {naive}", placed.pages.len());
    }

    #[test]
    fn table_that_fits_yields_exactly_one_fragment() {
        // A 2-row table on a tall page → ONE PlacedTable covering 0..rows (byte-identical to pre-split).
        let doc = doc_with_page(vec![Block::Table(n_row_table(2))], 800_000);
        let placed = place_doc(&doc, &ApproxFontMetrics);
        let frags: Vec<&PlacedTable> = placed.pages.iter().flat_map(|p| p.tables.iter()).collect();
        assert_eq!(frags.len(), 1, "a fitting table is one fragment");
        assert_eq!((frags[0].first_row, frags[0].last_row), (0, 2));
        assert_eq!(placed.pages.len(), 1, "no extra pages");
    }

    #[test]
    fn tall_table_splits_into_contiguous_per_page_fragments() {
        use crate::LayoutEngine;
        // A 20-row table on a SHORT page → must split across pages, row by row.
        let rows = 20;
        let doc = doc_with_page(vec![Block::Table(n_row_table(rows))], 5000);
        let placed = place_doc(&doc, &ApproxFontMetrics);
        // Collect fragments in page order, each carrying its (first_row, last_row, page, height).
        let mut frags: Vec<(usize, &PlacedTable)> = Vec::new();
        for (pi, pg) in placed.pages.iter().enumerate() {
            for pt in &pg.tables {
                assert_eq!((pt.section, pt.block), (0, 0));
                frags.push((pi, pt));
            }
        }
        assert!(frags.len() >= 2, "a too-tall table splits into ≥2 fragments, got {}", frags.len());
        // Contiguous, gap-free row coverage 0..rows, one page step per fragment.
        assert_eq!(frags.first().unwrap().1.first_row, 0, "starts at row 0");
        assert_eq!(frags.last().unwrap().1.last_row, rows, "ends at the last row");
        for w in frags.windows(2) {
            assert_eq!(w[0].1.last_row, w[1].1.first_row, "fragments are row-contiguous (no gap/overlap)");
            assert!(w[1].0 > w[0].0, "each fragment is on a later page");
            assert!(w[0].1.last_row > w[0].1.first_row, "no empty fragment");
        }
        // Fragment heights sum to the whole-table height (the reservation invariant).
        let body_w = 60000.0;
        let total_h: f64 = frags.iter().map(|(_, pt)| pt.h).sum();
        let table_h = crate::table_height(&n_row_table(rows), body_w, &doc, &ApproxFontMetrics);
        assert!((total_h - table_h).abs() < 1.0, "fragment heights sum to table_height: {total_h} vs {table_h}");
        // Every row's cell is placed in exactly one fragment (later-page rows stay clickable).
        let mut seen_rows: Vec<usize> = placed.pages.iter().flat_map(|p| p.tables.iter()).flat_map(|t| t.cells.iter().map(|c| c.row)).collect();
        seen_rows.sort_unstable();
        seen_rows.dedup();
        assert_eq!(seen_rows, (0..rows).collect::<Vec<_>>(), "all rows have a placed cell across the fragments");
        // place_doc's page count agrees with the oracle's NaiveLayout accounting (lockstep → oracle-safe).
        let naive = crate::NaiveLayout.layout(&doc, &ApproxFontMetrics).unwrap().pages.len();
        assert_eq!(placed.pages.len(), naive, "own-render pages == NaiveLayout pages (kept in lockstep)");
    }

    #[test]
    fn over_tall_row_keeps_place_doc_and_naive_in_lockstep() {
        use crate::LayoutEngine;
        // A single row TALLER than the page body must NOT re-fragment in place_doc while NaiveLayout
        // leaves it whole (the over-tall row draws + clips; a following block breaks). Regression for the
        // page-drift blocker (place_doc 13 vs NaiveLayout 1).
        let tall = (0..40).map(|_| Block::Paragraph(para("긴 내용"))).collect::<Vec<_>>();
        let t = Table {
            rows: 1, cols: 1, col_widths: vec![1],
            cells: vec![Cell { row: 0, col: 0, blocks: tall, ..Default::default() }],
            ..Default::default()
        };
        let doc = doc_with_page(vec![Block::Table(t)], 5000);
        let placed = place_doc(&doc, &ApproxFontMetrics).pages.len();
        let naive = crate::NaiveLayout.layout(&doc, &ApproxFontMetrics).unwrap().pages.len();
        assert_eq!(placed, naive, "over-tall row: place_doc {placed} == NaiveLayout {naive} (no re-fragment drift)");
    }

    #[test]
    fn over_tall_table_after_heading_stays_on_the_heading_page() {
        use crate::LayoutEngine;
        // 자가진단표 regression: a heading paragraph (vert>0) followed by a 1×1 table whose single row is
        // TALLER than the body. The first-row reserve must NOT bump it to a fresh page (that left the
        // heading's page blank below the heading); the over-tall row draws on the heading's page instead.
        let tall = (0..40).map(|_| Block::Paragraph(para("자가진단 항목 내용"))).collect::<Vec<_>>();
        let t = Table {
            rows: 1, cols: 1, col_widths: vec![1],
            cells: vec![Cell { row: 0, col: 0, blocks: tall, ..Default::default() }],
            ..Default::default()
        };
        let doc = doc_with_page(vec![Block::Paragraph(para("Ⅰ. 자가진단표")), Block::Table(t)], 5000);
        let placed = place_doc(&doc, &ApproxFontMetrics);
        // The table fragment must land on page 0 — the same page as the heading (no blank-page bump).
        let table_page = placed.pages.iter().position(|p| !p.tables.is_empty());
        assert_eq!(table_page, Some(0), "over-tall table starts on the heading's page, not a fresh one");
        // …and the two layout paths still agree (lockstep → oracle-safe).
        let naive = crate::NaiveLayout.layout(&doc, &ApproxFontMetrics).unwrap().pages.len();
        assert_eq!(placed.pages.len(), naive, "place_doc {} == NaiveLayout {naive}", placed.pages.len());
    }

    #[test]
    fn table_outer_margins_keep_place_doc_and_naive_in_lockstep() {
        use crate::LayoutEngine;
        // A multi-page table carrying outer margins, preceded by a paragraph (so vert>0) — the margins
        // must be accounted IDENTICALLY in both paths. Regression for the margin page-drift (9 vs 8).
        let mut tbl = n_row_table(15);
        tbl.outer_margin_top = 2000;
        tbl.outer_margin_bottom = 2000;
        let doc = doc_with_page(vec![Block::Paragraph(para("앞 문단")), Block::Table(tbl)], 5000);
        let placed = place_doc(&doc, &ApproxFontMetrics).pages.len();
        let naive = crate::NaiveLayout.layout(&doc, &ApproxFontMetrics).unwrap().pages.len();
        assert_eq!(placed, naive, "table outer margins: place_doc {placed} == NaiveLayout {naive}");
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
