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
    /// Display substitution for a Hanyang-PUA 옛한글 음절 (issue 062-2): the KS X 1026-1 첫가끝 자모
    /// 시퀀스 string to draw INSTEAD of `ch` (which is a full-width metric proxy '가', never drawn).
    /// The renderer draws this as ONE `<text>`/`draw_text` run so an old-hangul-capable OFL face
    /// (Noto Serif CJK KR / Source Han Serif K) shapes the conjoining jamo into a syllable. `None`
    /// for every ordinary glyph → byte-identical to before (`ch` is drawn).
    pub cluster: Option<String>,
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
    /// Precomputed equation SVG fragment (issue 062-5), carried straight to the SVG backend; `None`
    /// for real images and un-rendered equations (→ the stub box, byte-identical to before).
    pub svg: Option<String>,
    /// True for a table-cell image brush. Background images are painted before borders/text and are
    /// excluded from image selection/move APIs; normal inline pictures leave this false.
    pub is_background: bool,
    /// Source provenance: the `(section, block index)` anchor the image's paragraph occupies in the
    /// SemanticDoc — lets an overlay/edit map a placed box back to the editable model (the
    /// `image_bbox` query + a `SetImageSize` op). The renderer ignores these.
    pub section: usize,
    pub block: usize,
}

/// One STEP of a descending CELL PATH (issue 064 Tier-2): which cell of which table. `block` is a block
/// index — at level 0 the top-level table's `(section, block)` block index; at each deeper level the
/// index of the `Block::Table` INSIDE the previous cell's `blocks`. `(row, col)` is the cell address in
/// that table's `edit_target` grid. A length-1 path is exactly today's flat `(section, block, row, col)`,
/// so provenance stays 100% back-compat for a non-nested doc.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CellAddr {
    pub block: usize,
    pub row: usize,
    pub col: usize,
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
    /// The `(section, block index)` anchor the OUTERMOST table occupies in the SemanticDoc. A NESTED
    /// table carries its outer table's `(section, block)` here (so `table_at` drag-to-move + the
    /// active-cell ring's `table_cell_box` keep resolving a real top-level block); its own descent is in
    /// `ancestors` + `self_block`.
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
    /// Descending ANCESTOR-cell path (issue 064 Tier-2) — EMPTY for a top-level table. Each entry is an
    /// enclosing cell, outermost first; combined with `self_block` + a `PlacedCell`'s `(row, col)` it
    /// yields the full leaf `CellPath` (`table_cell_at` appends `{ self_block, row, col }`). A non-nested
    /// doc never populates this, so its provenance is byte-for-byte what it was before Tier-2.
    pub ancestors: Vec<CellAddr>,
    /// This table's block index WITHIN ITS PARENT CELL's `blocks` (== `block`, the section block index,
    /// for a top-level table; the position of the `Block::Table` inside its outer cell for a nested one).
    /// The leaf `CellAddr.block` when `table_cell_at` closes the path.
    pub self_block: usize,
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

    /// Descending `CellPath` to the cell at `(row, col)` of this fragment (issue #48).
    /// Ancestors (outermost first) plus this table's `{self_block, row, col}`.
    pub fn leaf_path(&self, row: usize, col: usize) -> Vec<CellAddr> {
        let mut path = self.ancestors.clone();
        path.push(CellAddr {
            block: self.self_block,
            row,
            col,
        });
        path
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
            pg.blocks.push(PlacedBlock {
                x: ml,
                y: start_y,
                w: body_w,
                h: (end_y - start_y).max(0.0),
                section,
                block,
                kind,
            });
        }
        return;
    }
    if let Some(pg) = pages.get_mut(start_page) {
        pg.blocks.push(PlacedBlock {
            x: ml,
            y: start_y,
            w: body_w,
            h: (mt + body_h - start_y).max(0.0),
            section,
            block,
            kind,
        });
    }
    for p in (start_page + 1)..end_page {
        if let Some(pg) = pages.get_mut(p) {
            pg.blocks.push(PlacedBlock {
                x: ml,
                y: mt,
                w: body_w,
                h: body_h,
                section,
                block,
                kind,
            });
        }
    }
    if let Some(pg) = pages.get_mut(end_page) {
        pg.blocks.push(PlacedBlock {
            x: ml,
            y: mt,
            w: body_w,
            h: (end_y - mt).max(0.0),
            section,
            block,
            kind,
        });
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
    if crate::uses_column_flow(doc) {
        return place_doc_columns(doc, fonts);
    }
    let mut pages: Vec<PlacedPage> = vec![PlacedPage::default()];
    let mut started = false; // any content placed on the current page yet?

    for (sec_idx, sec) in doc.sections.iter().enumerate() {
        let page = &sec.page;
        // 본문 상자는 crate::body_box 단일 지점에서 — 머리말/꼬리말/제본 여백까지 반영해야
        // NaiveLayout 과 쪽수가 어긋나지 않는다(LOCKSTEP, 이슈 074).
        let (ml, mt, body_w, body_h) = crate::body_box(page);

        // Each section starts on a fresh page (matches OWPML section→page + NaiveLayout).
        if started {
            pages.push(PlacedPage::default());
        }
        set_page_size(pages.last_mut().unwrap(), page);
        // After the fresh-page push: decorations must start on THIS section's first page,
        // not the previous section's last page (PR #46 review).
        let section_first_page = pages.len() - 1;
        // "쪽 나누기 앞에서" — NaiveLayout/block_pages 와 공유하는 단일 판정(이슈 080, LOCKSTEP).
        let brk = crate::section_page_breaks(sec, doc);
        let mut vert = 0.0f64; // page-relative vertical cursor (within the body box)

        for (blk_idx, block) in sec.blocks.iter().enumerate() {
            match block {
                Block::Paragraph(p) => {
                    let ps = doc.para_shapes.get(p.para_shape);
                    if brk[blk_idx] && vert > 0.0 {
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
                    place_paragraph(
                        p, doc, fonts, ml, mt, body_w, body_h, &mut vert, &mut pages, page,
                        sec_idx, blk_idx,
                    );
                    // Provenance band for point-to-scope: the paragraph's row extent on each page it
                    // touched. Tag it IMAGE when it carries an anchored object so the UI can label it.
                    let bend_page = pages.len() - 1;
                    let bend_y = mt + vert;
                    let kind = if paragraph_has_object(p) {
                        BlockKind::Image
                    } else {
                        BlockKind::Paragraph
                    };
                    record_block_band(
                        &mut pages,
                        bstart_page,
                        bstart_y,
                        bend_page,
                        bend_y,
                        ml,
                        body_w,
                        mt,
                        body_h,
                        sec_idx,
                        blk_idx,
                        kind,
                    );
                    vert += ps.map(|s| s.space_after).unwrap_or(0).max(0) as f64;
                    started = true;
                }
                Block::Table(t) => {
                    // 표 앞 강제 개쪽(이슈 080) — 바깥 여백보다 먼저. NaiveLayout/block_pages 동일.
                    if brk[blk_idx] && vert > 0.0 {
                        new_page(&mut pages, page);
                        vert = 0.0;
                    }
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
                    let rows = crate::table_row_heights(t, body_w, doc, fonts);
                    if let Some((_, caption_height)) =
                        crate::table_caption_metrics(t, body_w, doc, fonts)
                    {
                        if crate::keep_captioned_table_on_fresh_lane(
                            t,
                            &rows,
                            caption_height,
                            vert,
                            body_h,
                        ) {
                            new_page(&mut pages, page);
                            vert = 0.0;
                        }
                    }
                    if t.caption
                        .as_ref()
                        .is_some_and(|caption| caption.position == TableCaptionPosition::Top)
                    {
                        vert = place_caption(
                            t.caption.as_ref().expect("checked caption"),
                            doc,
                            fonts,
                            ml,
                            mt,
                            body_w,
                            body_h,
                            vert,
                            &mut pages,
                            page,
                            sec_idx,
                            blk_idx,
                        );
                        vert += t.caption.as_ref().unwrap().spacing.max(0) as f64;
                    }
                    let start_page = pages.len() - 1;
                    // place_table SPLITS the table across pages itself (한글식 row-level break): a
                    // first-row reserve, then a new page whenever the next row crosses the body bottom,
                    // emitting one bordered fragment per page. Returns the final page-relative cursor.
                    vert = place_table(
                        t, doc, fonts, ml, mt, body_h, vert, body_w, &mut pages, page, sec_idx,
                        blk_idx, frame,
                    );
                    if t.caption
                        .as_ref()
                        .is_some_and(|caption| caption.position == TableCaptionPosition::Bottom)
                    {
                        vert += t.caption.as_ref().unwrap().spacing.max(0) as f64;
                        vert = place_caption(
                            t.caption.as_ref().expect("checked caption"),
                            doc,
                            fonts,
                            ml,
                            mt,
                            body_w,
                            body_h,
                            vert,
                            &mut pages,
                            page,
                            sec_idx,
                            blk_idx,
                        );
                    }
                    let end_page = pages.len() - 1;
                    // Provenance bands for point-to-scope: one band per fragment page from its ACTUAL box,
                    // so own_hit_test resolves the table — and the scope pin hugs it — on EVERY page it
                    // touches. A degenerate 0×N table pushes no fragment, so the find simply yields none.
                    for pg in pages.iter_mut().take(end_page + 1).skip(start_page) {
                        let band = pg
                            .tables
                            .iter()
                            .rev()
                            // The OUTER fragment only (`ancestors.is_empty()`): a NESTED table (issue 064
                            // Tier-2) now shares this `(section, block)`, so without this guard `rev().find`
                            // would grab the nested box and shrink the point-to-scope band.
                            .find(|pt| {
                                pt.section == sec_idx
                                    && pt.block == blk_idx
                                    && pt.ancestors.is_empty()
                            })
                            .map(|pt| PlacedBlock {
                                x: pt.x,
                                y: pt.y,
                                w: pt.w,
                                h: pt.h,
                                section: sec_idx,
                                block: blk_idx,
                                kind: BlockKind::Table,
                            });
                        if let Some(b) = band {
                            pg.blocks.push(b);
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
        place_section_decorations(&mut pages, section_first_page, sec, doc, fonts);
    }
    PlacedDoc { pages }
}

/// Explicit-column placement lane. The established single-column implementation above is retained
/// unchanged and remains the path for every document without a column-zone/break signal.
fn place_doc_columns(doc: &SemanticDoc, fonts: &dyn FontMetricsProvider) -> PlacedDoc {
    let mut pages = vec![PlacedPage::default()];
    let mut started = false;
    for (section_index, section) in doc.sections.iter().enumerate() {
        let page = &section.page;
        let (body_x, body_y, body_w, body_h) = crate::body_box(page);
        if started {
            pages.push(PlacedPage::default());
        }
        set_page_size(pages.last_mut().expect("page exists"), page);
        let section_first_page = pages.len() - 1;
        let breaks = crate::section_page_breaks(section, doc);
        let mut flow = crate::ColumnFlow::new(body_w);

        for (block_index, block) in section.blocks.iter().enumerate() {
            match block {
                Block::Paragraph(paragraph) => {
                    let shape = doc.para_shapes.get(paragraph.para_shape);
                    if let Some(columns) = &paragraph.column_layout_before {
                        if flow.start_zone(columns, body_w, body_h) {
                            new_page(&mut pages, page);
                        }
                    }
                    if breaks[block_index] && flow.y() > 0.0 {
                        new_page(&mut pages, page);
                        flow.reset_page();
                    } else if paragraph.column_break_before && flow.advance_column() {
                        new_page(&mut pages, page);
                    }
                    if paragraph.is_table_anchor {
                        started = true;
                        continue;
                    }
                    if flow.vert() > 0.0 {
                        flow.add(shape.map(|value| value.space_before).unwrap_or(0).max(0) as f64);
                    }
                    let start_page = pages.len() - 1;
                    let start_column = flow.column_index();
                    let start_box = flow.box_now();
                    let start_y = body_y + flow.y();
                    place_paragraph_columns(
                        paragraph,
                        doc,
                        fonts,
                        body_x,
                        body_y,
                        body_h,
                        &mut flow,
                        &mut pages,
                        page,
                        section_index,
                        block_index,
                        None,
                    );
                    let end_page = pages.len() - 1;
                    let end_y = body_y + flow.y();
                    let kind = if paragraph_has_object(paragraph) {
                        BlockKind::Image
                    } else {
                        BlockKind::Paragraph
                    };
                    if start_page == end_page && start_column == flow.column_index() {
                        pages[start_page].blocks.push(PlacedBlock {
                            x: body_x + start_box.x,
                            y: start_y,
                            w: start_box.width,
                            h: (end_y - start_y).max(0.0),
                            section: section_index,
                            block: block_index,
                            kind,
                        });
                    }
                    flow.add(shape.map(|value| value.space_after).unwrap_or(0).max(0) as f64);
                    started = true;
                }
                Block::Table(table) => {
                    if breaks[block_index] && flow.y() > 0.0 {
                        new_page(&mut pages, page);
                        flow.reset_page();
                    }
                    let promoted = crate::unwrap_frame_table(table);
                    let (table, frame) = match &promoted {
                        Some((inner, frame)) => (inner, *frame),
                        None => (table, None),
                    };
                    if flow.vert() > 0.0 {
                        flow.add(table.outer_margin_top.max(0) as f64);
                    }
                    let rows = crate::table_row_heights(table, flow.min_width(), doc, fonts);
                    if let Some((_, caption_height)) =
                        crate::table_caption_metrics(table, flow.min_width(), doc, fonts)
                    {
                        if crate::keep_captioned_table_on_fresh_lane(
                            table,
                            &rows,
                            caption_height,
                            flow.vert(),
                            flow.available_height(body_h),
                        ) && flow.advance_column()
                        {
                            new_page(&mut pages, page);
                        }
                    }
                    if table
                        .caption
                        .as_ref()
                        .is_some_and(|caption| caption.position == TableCaptionPosition::Top)
                    {
                        place_caption_columns(
                            table.caption.as_ref().expect("checked caption"),
                            doc,
                            fonts,
                            body_x,
                            body_y,
                            body_h,
                            &mut flow,
                            &mut pages,
                            page,
                            section_index,
                            block_index,
                        );
                        flow.add(table.caption.as_ref().unwrap().spacing.max(0) as f64);
                    }
                    let start_page = pages.len() - 1;
                    place_table_columns(
                        table,
                        doc,
                        fonts,
                        body_x,
                        body_y,
                        body_h,
                        &mut flow,
                        &mut pages,
                        page,
                        section_index,
                        block_index,
                        frame,
                    );
                    if table
                        .caption
                        .as_ref()
                        .is_some_and(|caption| caption.position == TableCaptionPosition::Bottom)
                    {
                        flow.add(table.caption.as_ref().unwrap().spacing.max(0) as f64);
                        place_caption_columns(
                            table.caption.as_ref().expect("checked caption"),
                            doc,
                            fonts,
                            body_x,
                            body_y,
                            body_h,
                            &mut flow,
                            &mut pages,
                            page,
                            section_index,
                            block_index,
                        );
                    }
                    let end_page = pages.len() - 1;
                    for output in pages.iter_mut().take(end_page + 1).skip(start_page) {
                        if let Some(placed) = output.tables.iter().rev().find(|placed| {
                            placed.section == section_index
                                && placed.block == block_index
                                && placed.ancestors.is_empty()
                        }) {
                            output.blocks.push(PlacedBlock {
                                x: placed.x,
                                y: placed.y,
                                w: placed.w,
                                h: placed.h,
                                section: section_index,
                                block: block_index,
                                kind: BlockKind::Table,
                            });
                        }
                    }
                    flow.add(table.outer_margin_bottom.max(0) as f64);
                    started = true;
                }
            }
        }
        let separator_layouts = section
            .blocks
            .iter()
            .filter_map(|block| match block {
                Block::Paragraph(paragraph) => paragraph.column_layout_before.as_ref(),
                Block::Table(_) => None,
            })
            .filter(|layout| layout.separator.is_some())
            .collect::<Vec<_>>();
        // The common HWP/HWPX contract is one column definition per section. For that exact case,
        // emit the rule once per physical page; it is lowered through the same PaintOp::Line path to
        // both SVG and PDF. Multiple separator-bearing zones need vertical span ownership and remain
        // deliberately undrawn rather than overlapping contradictory rules.
        if let [layout] = separator_layouts.as_slice() {
            for output in pages.iter_mut().skip(section_first_page) {
                emit_column_separators(output, layout, body_x, body_y, body_w, body_h);
            }
        }
        place_section_decorations(&mut pages, section_first_page, section, doc, fonts);
    }
    PlacedDoc { pages }
}

fn emit_column_separators(
    page: &mut PlacedPage,
    layout: &ColumnLayout,
    body_x: f64,
    body_y: f64,
    body_w: f64,
    body_h: f64,
) {
    let Some(separator) = layout.separator else {
        return;
    };
    let mut boxes = crate::column_boxes(layout, body_w);
    boxes.sort_by(|left, right| left.x.total_cmp(&right.x));
    for pair in boxes.windows(2) {
        let gap_left = pair[0].x + pair[0].width;
        let gap_right = pair[1].x;
        let x = body_x + (gap_left + gap_right) / 2.0;
        page.lines.push(PlacedLine {
            x1: x,
            y1: body_y,
            x2: x,
            y2: body_y + body_h,
            color: separator.color,
            style: separator.style,
            width: separator.width_px,
        });
    }
}

/// Map each top-level block to the 0-based page index its first line/row STARTS on, re-driving the
/// SAME vertical accounting as [`place_doc`] (fresh page per section, paragraph space-before/after,
/// table outer margins + fit/overflow page breaks) WITHOUT placing glyphs. `out[section][block]` =
/// page index. Lets a document-outline / page-nav panel scroll the page list to a heading's page.
pub fn block_pages(doc: &SemanticDoc, fonts: &dyn FontMetricsProvider) -> Vec<Vec<usize>> {
    if crate::uses_column_flow(doc) {
        return block_pages_columns(doc, fonts);
    }
    let mut out: Vec<Vec<usize>> = Vec::with_capacity(doc.sections.len());
    let mut page_idx = 0usize; // current (global) page index
    let mut started = false;
    for sec in &doc.sections {
        let page = &sec.page;
        let (_, _, body_w, body_h) = crate::body_box(page);
        if started {
            page_idx += 1; // each section starts on a fresh page
        }
        let mut vert = 0.0f64;
        let mut sec_pages = Vec::with_capacity(sec.blocks.len());
        // "쪽 나누기 앞에서" — NaiveLayout/place_doc 와 공유하는 단일 판정(이슈 080, LOCKSTEP).
        let brk = crate::section_page_breaks(sec, doc);
        for (blk_idx, block) in sec.blocks.iter().enumerate() {
            match block {
                Block::Paragraph(p) => {
                    let ps = doc.para_shapes.get(p.para_shape);
                    if brk[blk_idx] && vert > 0.0 {
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
                    // 표 앞 강제 개쪽(이슈 080) — 바깥 여백보다 먼저. NaiveLayout/place_doc 동일.
                    if brk[blk_idx] && vert > 0.0 {
                        page_idx += 1;
                        vert = 0.0;
                    }
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
                    let row_h = crate::table_page_flow_row_heights(t, body_w, body_h, doc, fonts);
                    let caption_metrics = crate::table_caption_metrics(t, body_w, doc, fonts);
                    if let Some((_, caption_height)) = caption_metrics {
                        if crate::keep_captioned_table_on_fresh_lane(
                            t,
                            &row_h,
                            caption_height,
                            vert,
                            body_h,
                        ) {
                            page_idx += 1;
                            vert = 0.0;
                        }
                    } else if crate::keep_table_on_fresh_lane(t, &row_h, vert, body_h) {
                        page_idx += 1;
                        vert = 0.0;
                    }
                    if t.caption
                        .as_ref()
                        .is_some_and(|caption| caption.position == TableCaptionPosition::Top)
                    {
                        advance_caption_block_pages(
                            t.caption.as_ref().expect("checked caption"),
                            doc,
                            fonts,
                            body_w,
                            body_h,
                            &mut page_idx,
                            &mut vert,
                        );
                        vert += t.caption.as_ref().unwrap().spacing.max(0) as f64;
                    }
                    // `rh <= body_h` on both checks: an over-tall row (taller than the whole body) never
                    // forces a page bump — mirrors place_table + NaiveLayout so the start pages stay aligned.
                    if vert > 0.0
                        && row_h
                            .first()
                            .map(|&rh| vert + rh > body_h && rh <= body_h)
                            .unwrap_or(false)
                    {
                        page_idx += 1;
                        vert = 0.0;
                    }
                    sec_pages.push(page_idx); // the table starts here (where its first row lands)
                    let repeated_header = if t.repeat_first_row {
                        row_h.first().copied().unwrap_or(0.0)
                    } else {
                        0.0
                    };
                    for (r, rh) in row_h.iter().enumerate() {
                        let header = if r > 0 { repeated_header } else { 0.0 };
                        if let Some(fragments) = crate::over_tall_cell_fragments(
                            t,
                            r,
                            *rh,
                            (body_h - vert).max(1.0),
                            (body_h - header).max(1.0),
                        ) {
                            for (index, fragment) in fragments.iter().enumerate() {
                                if index > 0 {
                                    page_idx += 1;
                                    vert = header;
                                }
                                vert += fragment;
                            }
                            continue;
                        }
                        if r > 0 && vert + rh > body_h && vert > 0.0 && *rh <= body_h {
                            page_idx += 1;
                            vert = 0.0;
                        }
                        vert += rh;
                    }
                    if t.caption
                        .as_ref()
                        .is_some_and(|caption| caption.position == TableCaptionPosition::Bottom)
                    {
                        vert += t.caption.as_ref().unwrap().spacing.max(0) as f64;
                        advance_caption_block_pages(
                            t.caption.as_ref().expect("checked caption"),
                            doc,
                            fonts,
                            body_w,
                            body_h,
                            &mut page_idx,
                            &mut vert,
                        );
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

#[allow(clippy::too_many_arguments)]
fn advance_caption_block_pages(
    caption: &TableCaption,
    doc: &SemanticDoc,
    fonts: &dyn FontMetricsProvider,
    avail_w: f64,
    body_h: f64,
    page_index: &mut usize,
    vert: &mut f64,
) {
    let width = if caption.max_width > 0 {
        avail_w.min(caption.max_width as f64)
    } else {
        avail_w
    }
    .max(1.0);
    for child in &caption.blocks {
        match child {
            Block::Paragraph(paragraph) => {
                let shape = doc.para_shapes.get(paragraph.para_shape);
                if *vert > 0.0 {
                    *vert += shape.map(|value| value.space_before).unwrap_or(0).max(0) as f64;
                }
                let ratio = line_spacing_ratio(paragraph, doc);
                for line in layout_paragraph(paragraph, doc, width, fonts) {
                    if *vert + line.vert_size > body_h && *vert > 0.0 {
                        *page_index += 1;
                        *vert = 0.0;
                    }
                    *vert += line.vert_size * ratio;
                }
                *vert += shape.map(|value| value.space_after).unwrap_or(0).max(0) as f64;
            }
            Block::Table(table) => {
                let height = table_height(table, width, doc, fonts);
                if *vert + height > body_h && *vert > 0.0 && height <= body_h {
                    *page_index += 1;
                    *vert = 0.0;
                }
                *vert += height;
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn advance_caption_columns_pages(
    caption: &TableCaption,
    doc: &SemanticDoc,
    fonts: &dyn FontMetricsProvider,
    body_h: f64,
    flow: &mut crate::ColumnFlow,
    page_index: &mut usize,
) {
    let width = if caption.max_width > 0 {
        flow.min_width().min(caption.max_width as f64)
    } else {
        flow.min_width()
    }
    .max(1.0);
    for child in &caption.blocks {
        match child {
            Block::Paragraph(paragraph) => {
                let shape = doc.para_shapes.get(paragraph.para_shape);
                if flow.vert() > 0.0 {
                    flow.add(shape.map(|value| value.space_before).unwrap_or(0).max(0) as f64);
                }
                let ratio = line_spacing_ratio(paragraph, doc);
                for line in layout_paragraph(paragraph, doc, width, fonts) {
                    if flow.vert() + line.vert_size > flow.available_height(body_h)
                        && flow.vert() > 0.0
                        && flow.advance_column()
                    {
                        *page_index += 1;
                    }
                    flow.add(line.vert_size * ratio);
                }
                flow.add(shape.map(|value| value.space_after).unwrap_or(0).max(0) as f64);
            }
            Block::Table(table) => {
                let height = table_height(table, width, doc, fonts);
                if flow.vert() + height > flow.available_height(body_h)
                    && flow.vert() > 0.0
                    && height <= flow.available_height(body_h)
                    && flow.advance_column()
                {
                    *page_index += 1;
                }
                flow.add(height);
            }
        }
    }
}

fn block_pages_columns(doc: &SemanticDoc, fonts: &dyn FontMetricsProvider) -> Vec<Vec<usize>> {
    let mut output = Vec::with_capacity(doc.sections.len());
    let mut page_index = 0usize;
    let mut started = false;
    for section in &doc.sections {
        let page = &section.page;
        let (_, _, body_w, body_h) = crate::body_box(page);
        if started {
            page_index += 1;
        }
        let breaks = crate::section_page_breaks(section, doc);
        let mut flow = crate::ColumnFlow::new(body_w);
        let mut section_pages = Vec::with_capacity(section.blocks.len());
        for (block_index, block) in section.blocks.iter().enumerate() {
            match block {
                Block::Paragraph(paragraph) => {
                    let shape = doc.para_shapes.get(paragraph.para_shape);
                    if let Some(columns) = &paragraph.column_layout_before {
                        if flow.start_zone(columns, body_w, body_h) {
                            page_index += 1;
                        }
                    }
                    if breaks[block_index] && flow.y() > 0.0 {
                        page_index += 1;
                        flow.reset_page();
                    } else if paragraph.column_break_before && flow.advance_column() {
                        page_index += 1;
                    }
                    if paragraph.is_table_anchor {
                        section_pages.push(page_index);
                        started = true;
                        continue;
                    }
                    if flow.vert() > 0.0 {
                        flow.add(shape.map(|value| value.space_before).unwrap_or(0).max(0) as f64);
                    }
                    let ratio = line_spacing_ratio(paragraph, doc);
                    let indent = indent_of(paragraph, doc, flow.min_width());
                    let lines = layout_paragraph(paragraph, doc, indent.wrap_w, fonts);
                    let mut recorded = false;
                    for line in &lines {
                        if flow.vert() + line.vert_size > flow.available_height(body_h)
                            && flow.vert() > 0.0
                            && flow.advance_column()
                        {
                            page_index += 1;
                        }
                        if !recorded {
                            section_pages.push(page_index);
                            recorded = true;
                        }
                        flow.add(line.vert_size * ratio);
                    }
                    if !recorded {
                        section_pages.push(page_index);
                    }
                    flow.add(shape.map(|value| value.space_after).unwrap_or(0).max(0) as f64);
                    started = true;
                }
                Block::Table(table) => {
                    if breaks[block_index] && flow.y() > 0.0 {
                        page_index += 1;
                        flow.reset_page();
                    }
                    let promoted = crate::unwrap_frame_table(table);
                    let table = promoted.as_ref().map(|(inner, _)| inner).unwrap_or(table);
                    if flow.vert() > 0.0 {
                        flow.add(table.outer_margin_top.max(0) as f64);
                    }
                    let rows = crate::table_row_heights(table, flow.min_width(), doc, fonts);
                    let caption_metrics =
                        crate::table_caption_metrics(table, flow.min_width(), doc, fonts);
                    let should_advance = if let Some((_, caption_height)) = caption_metrics {
                        crate::keep_captioned_table_on_fresh_lane(
                            table,
                            &rows,
                            caption_height,
                            flow.vert(),
                            flow.available_height(body_h),
                        )
                    } else {
                        crate::keep_table_on_fresh_lane(
                            table,
                            &rows,
                            flow.vert(),
                            flow.available_height(body_h),
                        )
                    };
                    if should_advance && flow.advance_column() {
                        page_index += 1;
                    }
                    if table
                        .caption
                        .as_ref()
                        .is_some_and(|caption| caption.position == TableCaptionPosition::Top)
                    {
                        advance_caption_columns_pages(
                            table.caption.as_ref().expect("checked caption"),
                            doc,
                            fonts,
                            body_h,
                            &mut flow,
                            &mut page_index,
                        );
                        flow.add(table.caption.as_ref().unwrap().spacing.max(0) as f64);
                    }
                    if flow.vert() > 0.0
                        && rows.first().is_some_and(|height| {
                            let available = flow.available_height(body_h);
                            flow.vert() + height > available && *height <= available
                        })
                        && flow.advance_column()
                    {
                        page_index += 1;
                    }
                    section_pages.push(page_index);
                    for (row, height) in rows.iter().enumerate() {
                        let available = flow.available_height(body_h);
                        if row > 0
                            && flow.vert() + height > available
                            && flow.vert() > 0.0
                            && *height <= available
                            && flow.advance_column()
                        {
                            page_index += 1;
                        }
                        flow.add(*height);
                    }
                    if table
                        .caption
                        .as_ref()
                        .is_some_and(|caption| caption.position == TableCaptionPosition::Bottom)
                    {
                        flow.add(table.caption.as_ref().unwrap().spacing.max(0) as f64);
                        advance_caption_columns_pages(
                            table.caption.as_ref().expect("checked caption"),
                            doc,
                            fonts,
                            body_h,
                            &mut flow,
                            &mut page_index,
                        );
                    }
                    flow.add(table.outer_margin_bottom.max(0) as f64);
                    started = true;
                }
            }
        }
        output.push(section_pages);
    }
    output
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
    Indent {
        left,
        first_extra,
        wrap_w,
    }
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
    let atoms = paragraph_atoms(p, doc, fonts);
    let align = doc
        .para_shapes
        .get(p.para_shape)
        .map(|s| s.align)
        .unwrap_or_default();
    let ratio = line_spacing_ratio(p, doc);
    // Paragraph indent: block left/right margins shrink the wrap width; first-line indent shifts line 0.
    let ind = indent_of(p, doc, body_w);
    let lines = layout_paragraph(p, doc, ind.wrap_w, fonts);

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
        let slack = (ind.wrap_w
            - if li == 0 {
                ind.first_extra.max(0.0)
            } else {
                0.0
            }
            - line_w)
            .max(0.0);
        let x0 = ml
            + line_indent
            + match align {
                HorizontalAlign::Right => slack,
                HorizontalAlign::Center => slack / 2.0,
                _ => 0.0,
            };
        let baseline = line_top + ls.baseline;

        // Walk this line's glyphs, accumulating x by real advances.
        let start = ls.text_pos as usize;
        let end = lines
            .get(li + 1)
            .map(|n| n.text_pos as usize)
            .unwrap_or(atoms.len());
        let mut x = x0;
        for atom in atoms.get(start..end.min(atoms.len())).unwrap_or(&[]) {
            x += place_atom(pg, atom, x, line_top, baseline, fonts, section, block);
        }

        // (No per-line text-box: the SvgSink strokes fill:None rects as borders, so a box per line
        // cluttered the display with little frames around every bullet/line. The own-render is a
        // read-only fidelity view — caret hit-testing uses the rhwp path, not these boxes — so only
        // table/cell borders are drawn. Line-level hit geometry can come back behind a flag if the
        // own surface ever becomes editable.)

        *vert += ls.vert_size * ratio;
    }
}

/// Multi-column twin of [`place_paragraph`]. It uses the shared [`crate::ColumnFlow`] transition
/// state and the narrowest active column as the wrap width, which guarantees that a paragraph that
/// crosses into an unequal-width column never paints outside that column's body box.
#[allow(clippy::too_many_arguments)]
fn place_paragraph_columns(
    p: &Paragraph,
    doc: &SemanticDoc,
    fonts: &dyn FontMetricsProvider,
    ml: f64,
    mt: f64,
    body_h: f64,
    flow: &mut crate::ColumnFlow,
    pages: &mut Vec<PlacedPage>,
    page: &PageSetup,
    section: usize,
    block: usize,
    width_cap: Option<f64>,
) {
    let atoms = paragraph_atoms(p, doc, fonts);
    let align = doc
        .para_shapes
        .get(p.para_shape)
        .map(|shape| shape.align)
        .unwrap_or_default();
    let ratio = line_spacing_ratio(p, doc);
    let layout_width = width_cap
        .map(|cap| flow.min_width().min(cap))
        .unwrap_or_else(|| flow.min_width())
        .max(1.0);
    let ind = indent_of(p, doc, layout_width);
    let lines = layout_paragraph(p, doc, ind.wrap_w, fonts);

    for (line_index, line) in lines.iter().enumerate() {
        if flow.vert() + line.vert_size > flow.available_height(body_h)
            && flow.vert() > 0.0
            && flow.advance_column()
        {
            new_page(pages, page);
        }
        let column = flow.box_now();
        let effective_width = width_cap
            .map(|cap| column.width.min(cap))
            .unwrap_or(column.width)
            .max(1.0);
        let line_top = mt + flow.y();
        let line_indent = ind.left
            + if line_index == 0 {
                ind.first_extra
            } else {
                0.0
            };
        let slack = (effective_width
            - ind.left
            - if line_index == 0 {
                ind.first_extra.max(0.0)
            } else {
                0.0
            }
            - line.horz_size)
            .max(0.0);
        let x0 = ml
            + column.x
            + line_indent
            + match align {
                HorizontalAlign::Right => slack,
                HorizontalAlign::Center => slack / 2.0,
                _ => 0.0,
            };
        let baseline = line_top + line.baseline;
        let start = line.text_pos as usize;
        let end = lines
            .get(line_index + 1)
            .map(|next| next.text_pos as usize)
            .unwrap_or(atoms.len());
        let mut x = x0;
        let page_out = pages.last_mut().expect("placed document always has a page");
        for atom in atoms.get(start..end.min(atoms.len())).unwrap_or(&[]) {
            x += place_atom(page_out, atom, x, line_top, baseline, fonts, section, block);
        }
        flow.add(line.vert_size * ratio);
    }
}

#[allow(clippy::too_many_arguments)]
fn place_caption(
    caption: &TableCaption,
    doc: &SemanticDoc,
    fonts: &dyn FontMetricsProvider,
    ml: f64,
    mt: f64,
    avail_w: f64,
    body_h: f64,
    mut vert: f64,
    pages: &mut Vec<PlacedPage>,
    page: &PageSetup,
    section: usize,
    block: usize,
) -> f64 {
    let width = if caption.max_width > 0 {
        avail_w.min(caption.max_width as f64)
    } else {
        avail_w
    }
    .max(1.0);
    for child in &caption.blocks {
        match child {
            Block::Paragraph(paragraph) => {
                let shape = doc.para_shapes.get(paragraph.para_shape);
                if vert > 0.0 {
                    vert += shape.map(|value| value.space_before).unwrap_or(0).max(0) as f64;
                }
                place_paragraph(
                    paragraph, doc, fonts, ml, mt, width, body_h, &mut vert, pages, page, section,
                    block,
                );
                vert += shape.map(|value| value.space_after).unwrap_or(0).max(0) as f64;
            }
            Block::Table(table) => {
                vert = place_table(
                    table, doc, fonts, ml, mt, body_h, vert, width, pages, page, section, block,
                    None,
                );
            }
        }
    }
    vert
}

#[allow(clippy::too_many_arguments)]
fn place_caption_columns(
    caption: &TableCaption,
    doc: &SemanticDoc,
    fonts: &dyn FontMetricsProvider,
    ml: f64,
    mt: f64,
    body_h: f64,
    flow: &mut crate::ColumnFlow,
    pages: &mut Vec<PlacedPage>,
    page: &PageSetup,
    section: usize,
    block: usize,
) {
    for child in &caption.blocks {
        match child {
            Block::Paragraph(paragraph) => {
                let shape = doc.para_shapes.get(paragraph.para_shape);
                if flow.vert() > 0.0 {
                    flow.add(shape.map(|value| value.space_before).unwrap_or(0).max(0) as f64);
                }
                place_paragraph_columns(
                    paragraph,
                    doc,
                    fonts,
                    ml,
                    mt,
                    body_h,
                    flow,
                    pages,
                    page,
                    section,
                    block,
                    (caption.max_width > 0).then_some(caption.max_width as f64),
                );
                flow.add(shape.map(|value| value.space_after).unwrap_or(0).max(0) as f64);
            }
            Block::Table(table) => place_table_columns(
                table, doc, fonts, ml, mt, body_h, flow, pages, page, section, block, None,
            ),
        }
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
    let row_h = crate::table_page_flow_row_heights(t, avail_w, body_h, doc, fonts);

    let mut vert = vert;
    if !crate::has_flow_caption(t) && crate::keep_table_on_fresh_lane(t, &row_h, vert, body_h) {
        new_page(pages, page);
        vert = 0.0;
    }
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
    let repeated_header = if t.repeat_first_row {
        row_h.first().copied().unwrap_or(0.0)
    } else {
        0.0
    };
    for r in 0..t.rows {
        let header = if r > 0 { repeated_header } else { 0.0 };
        if let Some(fragments) = crate::over_tall_cell_fragments(
            t,
            r,
            row_h[r],
            (body_h - (y - mt)).max(1.0),
            (body_h - header).max(1.0),
        ) {
            if frag_first < r {
                flush_fragment(
                    pages, t, doc, fonts, ml, frag_top, &col_x, &row_h, frag_first, r, section,
                    block, frame,
                );
            }
            let final_height = flush_over_tall_row(
                pages, t, doc, fonts, ml, y, mt, &col_x, &row_h, r, &fragments, header, page,
                section, block, frame,
            );
            frag_first = r + 1;
            y = mt + final_height;
            frag_top = y;
            continue;
        }
        // Break BEFORE row r if it would cross the body bottom — but never before a fragment's own first
        // row (a row taller than a whole page draws and clips, like before, rather than looping forever),
        // and never to give a row TALLER than the whole body its own page (it can't fit there either, so
        // the break would only waste the current page). `rh <= body_h` mirrors NaiveLayout/block_pages.
        if ((r > frag_first) || (r == frag_first && frag_top > mt))
            && (y - mt) + row_h[r] > body_h
            && row_h[r] <= body_h
        {
            flush_fragment(
                pages, t, doc, fonts, ml, frag_top, &col_x, &row_h, frag_first, r, section, block,
                frame,
            );
            new_page(pages, page);
            frag_first = r;
            frag_top = mt;
            y = mt;
        }
        y += row_h[r];
    }
    if frag_first < t.rows {
        flush_fragment(
            pages, t, doc, fonts, ml, frag_top, &col_x, &row_h, frag_first, t.rows, section, block,
            frame,
        );
    }
    y - mt // final page-relative cursor (bottom of the last fragment)
}

/// Paint one text-only over-tall row as repeated page fragments. Geometry is emitted from an empty
/// clone through the ordinary `flush_fragment` path, so cell boxes/provenance stay identical. Text is
/// laid out once in the full logical row, then each glyph is translated into exactly one page slice;
/// no paragraph is re-shaped per page and no glyph can be duplicated.
#[allow(clippy::too_many_arguments)]
fn flush_over_tall_row(
    pages: &mut Vec<PlacedPage>,
    table: &Table,
    doc: &SemanticDoc,
    fonts: &dyn FontMetricsProvider,
    ml: f64,
    first_top: f64,
    body_top: f64,
    col_x: &[f64],
    row_heights: &[f64],
    row: usize,
    fragments: &[f64],
    repeated_header: f64,
    page: &PageSetup,
    section: usize,
    block: usize,
    frame: Option<CellEdge>,
) -> f64 {
    let mut logical = vec![PlacedPage::default()];
    flush_fragment(
        &mut logical,
        table,
        doc,
        fonts,
        ml,
        0.0,
        col_x,
        row_heights,
        row,
        row + 1,
        section,
        block,
        None,
    );
    let logical_glyphs = std::mem::take(&mut logical[0].glyphs);

    let mut shell = table.clone();
    for cell in &mut shell.cells {
        cell.blocks.clear();
        cell.fill_image = None;
    }
    let mut slice_heights = row_heights.to_vec();
    let mut offset = 0.0;
    for (index, height) in fragments.iter().copied().enumerate() {
        let slice_top = if index == 0 {
            first_top
        } else {
            new_page(pages, page);
            if repeated_header > 0.0 && row > 0 {
                flush_fragment(
                    pages,
                    table,
                    doc,
                    fonts,
                    ml,
                    body_top,
                    col_x,
                    row_heights,
                    0,
                    1,
                    section,
                    block,
                    frame,
                );
            }
            body_top + repeated_header
        };
        slice_heights[row] = height;
        flush_fragment(
            pages,
            &shell,
            doc,
            fonts,
            ml,
            slice_top,
            col_x,
            &slice_heights,
            row,
            row + 1,
            section,
            block,
            frame,
        );
        let end = offset + height;
        if let Some(current) = pages.last_mut() {
            current.glyphs.extend(
                logical_glyphs
                    .iter()
                    .filter(|glyph| glyph.baseline > offset && glyph.baseline <= end)
                    .cloned()
                    .map(|mut glyph| {
                        glyph.baseline = slice_top + glyph.baseline - offset;
                        glyph
                    }),
            );
        }
        offset = end;
    }
    if fragments.len() > 1 {
        repeated_header + fragments.last().copied().unwrap_or(0.0)
    } else {
        (first_top - body_top) + fragments.last().copied().unwrap_or(0.0)
    }
}

/// Column-aware row fragmentation twin of [`place_table`]. Row heights are measured at the
/// narrowest active column, so a fragment remains bounded when unequal columns are traversed.
#[allow(clippy::too_many_arguments)]
fn place_table_columns(
    t: &Table,
    doc: &SemanticDoc,
    fonts: &dyn FontMetricsProvider,
    ml: f64,
    mt: f64,
    body_h: f64,
    flow: &mut crate::ColumnFlow,
    pages: &mut Vec<PlacedPage>,
    page: &PageSetup,
    section: usize,
    block: usize,
    frame: Option<CellEdge>,
) {
    if t.rows == 0 || t.cols == 0 {
        return;
    }
    let table_width = flow.min_width();
    let col_x = column_offsets(t, table_width);
    let row_h = row_heights(t, table_width, doc, fonts);
    let available = flow.available_height(body_h);
    if !crate::has_flow_caption(t)
        && crate::keep_table_on_fresh_lane(t, &row_h, flow.vert(), available)
        && flow.advance_column()
    {
        new_page(pages, page);
    }
    let available = flow.available_height(body_h);
    if flow.vert() > 0.0
        && flow.vert() + row_h[0] > available
        && row_h[0] <= available
        && flow.advance_column()
    {
        new_page(pages, page);
    }

    let mut fragment_first = 0usize;
    let mut fragment_x = ml + flow.box_now().x;
    let mut fragment_top = mt + flow.y();
    for row in 0..t.rows {
        let available = flow.available_height(body_h);
        if row > fragment_first && flow.vert() + row_h[row] > available && row_h[row] <= available {
            flush_fragment(
                pages,
                t,
                doc,
                fonts,
                fragment_x,
                fragment_top,
                &col_x,
                &row_h,
                fragment_first,
                row,
                section,
                block,
                frame,
            );
            if flow.advance_column() {
                new_page(pages, page);
            }
            fragment_first = row;
            fragment_x = ml + flow.box_now().x;
            fragment_top = mt + flow.y();
        }
        flow.add(row_h[row]);
    }
    flush_fragment(
        pages,
        t,
        doc,
        fonts,
        fragment_x,
        fragment_top,
        &col_x,
        &row_h,
        fragment_first,
        t.rows,
        section,
        block,
        frame,
    );
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
    // `table_idx` PINS this fragment: `place_cell_content` (below) may push NESTED `PlacedTable`s (issue
    // 064 Tier-2), so the old `pg.tables.last_mut()` would have attached our cells to the deepest nested
    // table instead of this one.
    let table_idx = pg.tables.len();
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
        cells: Vec::new(),     // filled below, then attached
        ancestors: Vec::new(), // top-level table → no nesting ancestors (length-1 leaf path)
        self_block: block,     // top-level: block-within-parent == the section block index
    });
    let mut placed_cells: Vec<PlacedCell> = Vec::new();
    // 셀 실폭 상자(이슈 074) — 예약(row_heights)과 **같은 폭**으로 그려야 글이 상자를 넘지 않는다.
    let boxes = cell_boxes(t, col_x[t.cols]);
    for (ci, c) in t.cells.iter().enumerate() {
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
        let (bx, bw) = cell_box_at(t, &boxes, col_x, ci);
        let cx = ml + bx;
        let cw = bw.max(1.0);
        let cy = top_of(r0);
        let ch = (top_of(r1) - cy).max(1.0);
        // Cell provenance rect (point→cell for double-click editing) — keyed to the real (row, col).
        placed_cells.push(PlacedCell {
            row: c.row,
            col: c.col,
            x: cx,
            y: cy,
            w: cw,
            h: ch,
        });
        // Cell shade (fill) UNDER its border so the border stays visible.
        if let Some(shade) = c.shade_color {
            pg.rects.push(PlacedRect {
                x: cx,
                y: cy,
                w: cw,
                h: ch,
                fill: Some(shade),
            });
        }
        if let Some(image) = &c.fill_image {
            pg.images.push(PlacedImage {
                x: cx,
                y: cy,
                w: cw,
                h: ch,
                bin_ref: image.bin_ref.clone(),
                svg: None,
                is_background: true,
                section,
                block,
            });
        }
        // Cell borders. Two paths:
        //  - PER-EDGE (lifted from the real borderFill): draw each visible edge as its own styled line,
        //    skipping 선없음 sides — makes the ※ guide boxes DASHED, the section-header band a pentagon.
        //  - LEGACY (no per-edge data, e.g. inserted/test cells): the uniform stroked box, gated on
        //    `has_border`, exactly as before — so nothing regresses.
        if c.has_edge_borders() {
            push_cell_edges(pg, &c.borders, cx, cy, cw, ch);
        } else if c.has_border {
            pg.rects.push(PlacedRect {
                x: cx,
                y: cy,
                w: cw,
                h: ch,
                fill: None,
            });
        }
        // Cell diagonal (HWP borderFill `diagonal`) — only on an EMPTY cell (forms a shape; a text cell's
        // diagonal is a shared-borderFill artifact Hancom doesn't draw through the words).
        if let Some(d) = c.diagonal.filter(|_| !cell_has_text(&c.blocks)) {
            for (y1, y2) in diagonal_segments(d.kind, cy, ch) {
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
        }
        // Cell TEXT: only in the fragment that OWNS the cell's TOP row (c.row >= first) so a cell whose
        // span crosses the page break doesn't draw its text twice. Vertically centered (gov-doc
        // vertAlign=CENTER), honoring each paragraph's horizontal align. The top-level `NestCtx` has NO
        // ancestors and `self_block == block` (the section block index) → a nested table found inside this
        // cell records a length-2 CellPath `[{block, c.row, c.col}, {bi, r, c}]` (issue 064 Tier-2).
        if c.row >= first {
            let ctx = NestCtx {
                section,
                outer_block: block,
                ancestors: Vec::new(),
                self_block: block,
            };
            let (pad_left, pad_right) = crate::cell_horizontal_padding(t, c);
            place_cell_content(
                pg, &c.blocks, cx, cy, cw, ch, pad_left, pad_right, doc, fonts, &ctx, c.row, c.col,
            );
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
            pg.lines.push(PlacedLine {
                x1: x1_,
                y1: y1_,
                x2: x2_,
                y2: y2_,
                color: f.color,
                style: f.style,
                width: w,
            });
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
    // Attach the per-cell rects to the fragment we pushed — by its PINNED index (nested tables may have
    // been appended after it during the cell loop), never `last_mut()`.
    pg.tables[table_idx].cells = placed_cells;
}

/// Vertical endpoint pairs `(y1, y2)` for a cell diagonal, each drawing one line from the cell's left
/// (`x = cx`) to its right (`x = cx + cw`). `cy`/`ch` are the cell's top/height. Slash = bottom-left→
/// top-right (one line); BackSlash = top-left→bottom-right (one line); Cross = BOTH, an X (two lines).
/// The single-line endpoints are reused verbatim for the X so the crossing matches Hancom's rendering
/// (mirrors rhwp `render_cell_diagonal`, which runs both the slash and backslash blocks when both
/// direction bits are set — 062-4).
fn diagonal_segments(kind: DiagonalKind, cy: f64, ch: f64) -> Vec<(f64, f64)> {
    let slash = (cy + ch, cy); // bottom-left → top-right
    let backslash = (cy, cy + ch); // top-left → bottom-right
    match kind {
        DiagonalKind::Slash => vec![slash],
        DiagonalKind::BackSlash => vec![backslash],
        DiagonalKind::Cross => vec![slash, backslash],
    }
}

/// True if a cell's blocks contain any non-empty text run — used to decide whether a cell's diagonal
/// is decorative shape (empty cell → draw) or a shared-borderFill artifact over words (text → skip).
fn cell_has_text(blocks: &[Block]) -> bool {
    blocks.iter().any(|b| match b {
        Block::Paragraph(p) => p.runs.iter().any(|r| {
            r.content
                .iter()
                .any(|i| matches!(i, Inline::Text(s) if !s.trim().is_empty()))
        }),
        Block::Table(t) => t.cells.iter().any(|c| cell_has_text(&c.blocks)),
    })
}

/// Emit up to four styled edge lines for a cell box `(cx,cy,cw,ch)` from its per-edge `borders`
/// (`[left, right, top, bottom]`). A `LineStyle::None` edge (선없음) emits NOTHING — that is how a
/// per-edge cell suppresses a side (e.g. the section-header band's right/inner edges). A 0-px width
/// is clamped to 1 so a hairline stays visible.
fn push_cell_edges(
    pg: &mut PlacedPage,
    borders: &[Option<CellEdge>; 4],
    cx: f64,
    cy: f64,
    cw: f64,
    ch: f64,
) {
    // (edge_index, x1, y1, x2, y2) — left, right, top, bottom.
    let segs = [
        (0usize, cx, cy, cx, cy + ch),      // left
        (1, cx + cw, cy, cx + cw, cy + ch), // right
        (2, cx, cy, cx + cw, cy),           // top
        (3, cx, cy + ch, cx + cw, cy + ch), // bottom
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

/// Nesting-provenance context (issue 064 Tier-2) threaded down `place_cell_content`/`place_nested_table`
/// so a nested table can record the full descending `CellPath` to each of its cells WITHOUT changing any
/// geometry. Describes the CONTAINER table whose cell content is being placed: the outermost
/// `(section, outer_block)` anchor (→ `PlacedTable.section/block`), the ancestor cells above the container
/// (empty at the top level), and the container's own block-within-parent (`self_block`).
struct NestCtx {
    section: usize,
    outer_block: usize,
    ancestors: Vec<CellAddr>,
    self_block: usize,
}

impl NestCtx {
    /// The descending `CellPath` (ancestors + this container's `(self_block, row, col)`) to the cell at
    /// `(row, col)` of the container table — the ancestor list a nested table INSIDE that cell inherits.
    fn cell_path(&self, row: usize, col: usize) -> Vec<CellAddr> {
        let mut path = self.ancestors.clone();
        path.push(CellAddr {
            block: self.self_block,
            row,
            col,
        });
        path
    }
}

/// Draw a NESTED table (a table that lives inside a cell) at origin `(ox, oy)` within width `avail_w` on a
/// SINGLE page. A nested table never paginates internally — its whole height is reserved as part of the
/// outer cell's row — so this draws ALL rows at once (clipping if taller than the page, matching how an
/// over-tall outer row already clips). Mirrors `flush_fragment`'s per-cell drawing (shade → border → diagonal
/// → content) minus the page/fragment logic, and recurses through `place_cell_content` for deeper nesting.
/// Pushes a `PlacedTable` (+ per-cell `PlacedCell`s) carrying `ctx`'s descending `CellPath` (issue 064
/// Tier-2) so a click inside the nested grid resolves to the nested LEAF cell — ADDITIVE metadata only,
/// drawn AFTER the outer cell so `table_at`/`table_cell_at`'s `rfind` (topmost wins) naturally picks it.
#[allow(clippy::too_many_arguments)]
fn place_nested_table(
    pg: &mut PlacedPage,
    t: &Table,
    ox: f64,
    oy: f64,
    avail_w: f64,
    doc: &SemanticDoc,
    fonts: &dyn FontMetricsProvider,
    ctx: &NestCtx,
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
    // Provenance (issue 064 Tier-2): the nested table's outer box + descending CellPath so a click resolves
    // the LEAF cell. Pushed FIRST (its `cells` filled below) — like `flush_fragment` — and, because it lands
    // AFTER the outer table's own `PlacedTable` in `pg.tables`, `rfind` (topmost) picks the innermost hit.
    // `table_idx` pins this exact fragment so the deeper `PlacedTable`s that the recursion below appends
    // (yet-more-nested tables) don't get our `cells` mis-attached.
    let table_idx = pg.tables.len();
    pg.tables.push(PlacedTable {
        x: ox,
        y: oy,
        w: col_x[t.cols],
        h: row_top[t.rows] - oy,
        section: ctx.section,
        block: ctx.outer_block,
        rows: t.rows,
        cols: t.cols,
        first_row: 0,
        last_row: t.rows,
        cells: Vec::new(),
        ancestors: ctx.ancestors.clone(),
        self_block: ctx.self_block,
    });
    let mut placed_cells: Vec<PlacedCell> = Vec::new();
    // 중첩 표도 셀 실폭 상자를 쓴다(이슈 074) — 예약(row_heights)과 같은 폭.
    let boxes = cell_boxes(t, col_x[t.cols]);
    for (ci, c) in t.cells.iter().enumerate() {
        if !c.active || c.col >= t.cols || c.row >= t.rows {
            continue;
        }
        let (bx, bw) = cell_box_at(t, &boxes, &col_x, ci);
        let cx = ox + bx;
        let cw = bw.max(1.0);
        let cy = row_top[c.row];
        let r1 = (c.row + c.row_span.max(1)).min(t.rows);
        let ch = (row_top[r1] - cy).max(1.0);
        placed_cells.push(PlacedCell {
            row: c.row,
            col: c.col,
            x: cx,
            y: cy,
            w: cw,
            h: ch,
        });
        if let Some(shade) = c.shade_color {
            pg.rects.push(PlacedRect {
                x: cx,
                y: cy,
                w: cw,
                h: ch,
                fill: Some(shade),
            });
        }
        if let Some(image) = &c.fill_image {
            pg.images.push(PlacedImage {
                x: cx,
                y: cy,
                w: cw,
                h: ch,
                bin_ref: image.bin_ref.clone(),
                svg: None,
                is_background: true,
                section: ctx.section,
                block: ctx.outer_block,
            });
        }
        if c.has_edge_borders() {
            push_cell_edges(pg, &c.borders, cx, cy, cw, ch);
        } else if c.has_border {
            pg.rects.push(PlacedRect {
                x: cx,
                y: cy,
                w: cw,
                h: ch,
                fill: None,
            });
        }
        if let Some(d) = c.diagonal.filter(|_| !cell_has_text(&c.blocks)) {
            for (y1, y2) in diagonal_segments(d.kind, cy, ch) {
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
        }
        let (pad_left, pad_right) = crate::cell_horizontal_padding(t, c);
        place_cell_content(
            pg, &c.blocks, cx, cy, cw, ch, pad_left, pad_right, doc, fonts, ctx, c.row, c.col,
        );
    }
    // Attach the per-cell rects to the nested fragment we pushed (by its pinned index — the recursion may
    // have appended deeper nested `PlacedTable`s after it).
    pg.tables[table_idx].cells = placed_cells;
}

/// Place a cell's block content (paragraph glyphs + nested tables) inside its box `(cx,cy,cw,ch)`,
/// vertically centered. A nested table is drawn in place (see `place_nested_table`). `ctx` + `(cell_row,
/// cell_col)` identify WHICH cell (of which container table) these blocks belong to, so a nested table
/// found here can record its descending `CellPath` (issue 064 Tier-2) — provenance only, no geometry.
#[allow(clippy::too_many_arguments)]
fn place_cell_content(
    pg: &mut PlacedPage,
    blocks: &[Block],
    cx: f64,
    cy: f64,
    cw: f64,
    ch: f64,
    pad_left: f64,
    pad_right: f64,
    doc: &SemanticDoc,
    fonts: &dyn FontMetricsProvider,
    ctx: &NestCtx,
    cell_row: usize,
    cell_col: usize,
) {
    let textw = (cw - pad_left - pad_right).max(1.0);
    // Total content height → start offset for vertical centering within the cell box.
    let content_h: f64 = blocks
        .iter()
        .map(|b| block_height_for_place(b, doc, textw, fonts))
        .sum();
    let mut vy = cy + ((ch - content_h) / 2.0).max(0.0);
    for (bi, b) in blocks.iter().enumerate() {
        let Block::Paragraph(p) = b else {
            // A NESTED table (a table inside this cell): DRAW it at the current cursor — its height is
            // already reserved in `content_h` (block_height_for_place's Table arm), so the cursor advances
            // by the SAME amount and the pagination math is untouched. Before this, the nested table's
            // glyphs/borders were skipped entirely → the cell (e.g. the 자가진단표 wrapped in a 1×1 table)
            // rendered BLANK. Other block kinds just advance the cursor as before.
            if let Block::Table(nt) = b {
                // The nested table's descent: its ancestors = this cell's full CellPath; its own
                // block-within-parent = `bi` (this `Block::Table`'s index in the cell's blocks). The walk
                // in hwp-ops/hwp-session mirrors this (edit_target at level 0, raw index deeper).
                let child = NestCtx {
                    section: ctx.section,
                    outer_block: ctx.outer_block,
                    ancestors: ctx.cell_path(cell_row, cell_col),
                    self_block: bi,
                };
                place_nested_table(pg, nt, cx + pad_left, vy, textw, doc, fonts, &child);
            }
            vy += block_height_for_place(b, doc, textw, fonts);
            continue;
        };
        let atoms = paragraph_atoms(p, doc, fonts);
        let align = doc
            .para_shapes
            .get(p.para_shape)
            .map(|s| s.align)
            .unwrap_or_default();
        let ratio = line_spacing_ratio(p, doc);
        // Same paragraph indent as the body: block left/right margins shrink wrap; first line shifts.
        let ind = indent_of(p, doc, textw);
        let lines = layout_paragraph(p, doc, ind.wrap_w, fonts);
        for (li, ls) in lines.iter().enumerate() {
            let line_indent = ind.left + if li == 0 { ind.first_extra } else { 0.0 };
            let slack = (ind.wrap_w
                - if li == 0 {
                    ind.first_extra.max(0.0)
                } else {
                    0.0
                }
                - ls.horz_size)
                .max(0.0);
            let x0 = cx
                + pad_left
                + line_indent
                + match align {
                    HorizontalAlign::Right => slack,
                    HorizontalAlign::Center => slack / 2.0,
                    _ => 0.0,
                };
            let baseline = vy + ls.baseline;
            let start = ls.text_pos as usize;
            let end = lines
                .get(li + 1)
                .map(|n| n.text_pos as usize)
                .unwrap_or(atoms.len());
            let mut x = x0;
            for atom in atoms.get(start..end.min(atoms.len())).unwrap_or(&[]) {
                x += place_atom(
                    pg,
                    atom,
                    x,
                    vy,
                    baseline,
                    fonts,
                    ctx.section,
                    ctx.outer_block,
                );
            }
            vy += ls.vert_size * ratio;
        }
        // Trailing-leading trim — LOCKSTEP with `crate::cell_paragraph_height` (the reserve helper this
        // cell's box height was sized by). Line-spacing leading sits BETWEEN lines, not below a
        // paragraph's LAST line, so the NEXT paragraph (or the cell bottom) must start at the trimmed
        // position. Without this the drawn stack over-advanced by one line's leading PER paragraph: a
        // multi-paragraph cell (자가진단표 r16 = 11 paragraphs) drifted ~1278 HWPUNIT and pushed its final
        // line ("…이사장 귀하") BELOW the cell/frame box, so 귀하 escaped the outer 상자 (issue 024). The
        // reserve already subtracts this leading, so trimming the DRAW makes drawn == reserved and the
        // content sits inside the box. The trimmed span is empty space below the last line's ink → no
        // glyph is clipped. Reserve-only (pagination) is untouched, so page counts stay in lockstep.
        if let Some(last) = lines.last() {
            vy -= (last.vert_size * (ratio - 1.0)).max(0.0);
        }
    }
}

// ---- Cell-addressed caret geometry (issue 053) ----------------------------------------------
//
// Read-only re-derivation of `place_cell_content`'s glyph math so a caret can be placed inside a
// TABLE CELL at character precision, in the SAME own-render coordinates the visible SVG was drawn
// from (V4: the caret layer never touches layout — these functions only re-run the identical
// helpers `place_cell_content` used and report positions). This closes the CARET-GAP §5 P1 hole:
// cell text has no NodeId, so the caret is addressed by `(section, block, row, col, para, offset)`
// — the same address space `SetTableCellRuns` commits to.

/// A caret rectangle inside a table cell, in own-render ABSOLUTE page coords (HWPUNIT). `page` is
/// the 0-based page the owning table fragment (the one that draws the cell's text) landed on.
#[derive(Clone, Debug)]
pub struct CellCaretRect {
    pub page: usize,
    pub x: f64,
    pub top: f64,
    pub height: f64,
}

/// A page-space point resolved to a CELL TEXT caret target: the cell address `(section, block,
/// row, col)` (row/col MODEL-GLOBAL, like [`PlacedCell`]), the paragraph ordinal `para`, the char
/// `offset` within it, that paragraph's char count `para_len`, and the caret geometry at the
/// resolved offset. All geometry HWPUNIT (the session facade converts to px).
///
/// ## `para`/`offset` address space — the EDITOR ("\n"-split) space, on purpose
/// `para` counts the cell text's **"\n"-separated segments** in reading order — NOT raw model
/// paragraph blocks. A model cell paragraph can contain a FORCED line break (`'\n'` inside a run,
/// e.g. "라벨\n(Problem)"), and the WHOLE edit lane already treats every `'\n'` as a paragraph
/// boundary: `block_runs` joins cell paragraphs with "\n" runs, and `SetTableCellRuns` splits the
/// committed runs back on every `'\n'`. Addressing the caret in that same space means
/// `global_offset = Σ(para_len_i + 1 for i < para) + offset` over the joined editor text is EXACT —
/// no separator/forced-break ambiguity between what the caret points at and what a commit rewrites.
/// `offset ∈ [0, para_len]` never counts a `'\n'` (it is the boundary itself).
#[derive(Clone, Debug)]
pub struct CellTextHit {
    pub section: usize,
    pub block: usize,
    pub row: usize,
    pub col: usize,
    pub para: usize,
    pub offset: usize,
    pub para_len: usize,
    pub caret: CellCaretRect,
    /// Descending `CellPath` to this cell. Empty for a depth-1 (top-level) hit so existing
    /// consumers keep the flat `(section, block, row, col)` lane (issue #48 A2). Length ≥ 2
    /// addresses a nested leaf; the DTO then omits the flat row/col (R2).
    pub path: Vec<CellAddr>,
}

/// One laid-out cell text line handed to [`walk_cell_lines`]'s callback, in the EDITOR address
/// space (see [`CellTextHit`]): the "\n"-segment ordinal `para` (cell-global), the segment-local
/// char offset of the line's first glyph `line_start`, the segment's char count `para_len`
/// (excluding the `'\n'` separator), the absolute line geometry, and the per-glyph advances +
/// chars for the line (a forced-break line INCLUDES its trailing `'\n'` glyph — callers cap at it).
/// A line never spans two segments: a `'\n'` always ENDS its line (layout_paragraph's forced break).
struct CellLineGeom<'a> {
    para: usize,
    line_start: usize,
    x0: f64,
    top: f64,
    height: f64,
    advances: &'a [f64],
    chars: &'a [char],
    para_len: usize,
}

/// Re-drive `place_cell_content`'s EXACT vertical/horizontal accounting over a cell's blocks —
/// same vertical centering, same indent/align/slack, same per-glyph advances, same trailing-leading
/// trim — but instead of pushing `PlacedGlyph`s, hand each LINE's geometry to `on_line`. Return
/// `true` from the callback to stop early. Nested tables advance the cursor (walk the LEAF cell
/// separately via its `CellPath` — issue #48).
#[allow(clippy::too_many_arguments)]
fn walk_cell_lines(
    blocks: &[Block],
    cx: f64,
    cy: f64,
    cw: f64,
    ch: f64,
    pad_left: f64,
    pad_right: f64,
    doc: &SemanticDoc,
    fonts: &dyn FontMetricsProvider,
    on_line: &mut dyn FnMut(&CellLineGeom) -> bool,
) {
    let textw = (cw - pad_left - pad_right).max(1.0);
    let content_h: f64 = blocks
        .iter()
        .map(|b| block_height_for_place(b, doc, textw, fonts))
        .sum();
    let mut vy = cy + ((ch - content_h) / 2.0).max(0.0);
    let mut seg_base = 0usize; // cell-global ordinal of this model paragraph's FIRST "\n"-segment
    for b in blocks {
        let Block::Paragraph(p) = b else {
            vy += block_height_for_place(b, doc, textw, fonts);
            continue;
        };
        let atoms = paragraph_atoms(p, doc, fonts);
        let glyphs: Vec<&GlyphInfo> = atoms
            .iter()
            .filter_map(|atom| match atom {
                ParagraphAtom::Glyph(glyph) => Some(glyph),
                ParagraphAtom::Object { .. } => None,
            })
            .collect();
        let mut text_prefix = Vec::with_capacity(atoms.len() + 1);
        text_prefix.push(0usize);
        for atom in &atoms {
            let next = text_prefix.last().copied().unwrap_or(0)
                + usize::from(matches!(atom, ParagraphAtom::Glyph(_)));
            text_prefix.push(next);
        }
        // "\n"-segment map (the EDITOR address space — see CellTextHit): positions of the forced
        // breaks split the paragraph into nl_pos.len()+1 segments; a glyph at index i belongs to the
        // segment holding it, with segment-local offset i - seg_start.
        let nl_pos: Vec<usize> = glyphs
            .iter()
            .enumerate()
            .filter(|(_, g)| g.ch == '\n')
            .map(|(i, _)| i)
            .collect();
        let seg_of = |i: usize| nl_pos.partition_point(|&pos| pos < i);
        let seg_start = |s: usize| if s == 0 { 0 } else { nl_pos[s - 1] + 1 };
        let seg_end = |s: usize| nl_pos.get(s).copied().unwrap_or(glyphs.len()); // exclusive of the '\n'
        let align = doc
            .para_shapes
            .get(p.para_shape)
            .map(|s| s.align)
            .unwrap_or_default();
        let ratio = line_spacing_ratio(p, doc);
        let ind = indent_of(p, doc, textw);
        let lines = layout_paragraph(p, doc, ind.wrap_w, fonts);
        for (li, ls) in lines.iter().enumerate() {
            let line_indent = ind.left + if li == 0 { ind.first_extra } else { 0.0 };
            let slack = (ind.wrap_w
                - if li == 0 {
                    ind.first_extra.max(0.0)
                } else {
                    0.0
                }
                - ls.horz_size)
                .max(0.0);
            let x0 = cx
                + pad_left
                + line_indent
                + match align {
                    HorizontalAlign::Right => slack,
                    HorizontalAlign::Center => slack / 2.0,
                    _ => 0.0,
                };
            let start = ls.text_pos as usize;
            let end = lines
                .get(li + 1)
                .map(|n| n.text_pos as usize)
                .unwrap_or(atoms.len())
                .min(atoms.len());
            let text_start = text_prefix[start.min(atoms.len())];
            let mut pending_object_advance = 0.0;
            let mut advances = Vec::new();
            let mut chars = Vec::new();
            for atom in atoms.get(start..end).unwrap_or(&[]) {
                match atom {
                    ParagraphAtom::Object { .. } => pending_object_advance += atom.advance(fonts),
                    ParagraphAtom::Glyph(glyph) => {
                        advances.push(pending_object_advance + atom.advance(fonts));
                        pending_object_advance = 0.0;
                        chars.push(glyph.ch);
                    }
                }
            }
            let s = seg_of(text_start); // a '\n' ends its line, so lines never straddle segments
            let stop = on_line(&CellLineGeom {
                para: seg_base + s,
                line_start: text_start - seg_start(s),
                x0,
                top: vy,
                height: ls.vert_size,
                advances: &advances,
                chars: &chars,
                para_len: seg_end(s) - seg_start(s),
            });
            if stop {
                return;
            }
            vy += ls.vert_size * ratio;
        }
        // Trailing-leading trim — LOCKSTEP with place_cell_content (see its comment).
        if let Some(last) = lines.last() {
            vy -= (last.vert_size * (ratio - 1.0)).max(0.0);
        }
        seg_base += nl_pos.len() + 1;
    }
}

/// The `(page, PlacedCell)` whose fragment DRAWS the cell's text — the fragment that owns the
/// cell's TOP row (`flush_fragment` draws cell text only there, so a split table's continuation
/// rect never yields a duplicate/false caret).
fn owning_cell_rect(
    placed: &PlacedDoc,
    section: usize,
    block: usize,
    row: usize,
    col: usize,
) -> Option<(usize, PlacedCell)> {
    for (pi, pg) in placed.pages.iter().enumerate() {
        for t in pg
            .tables
            .iter()
            .filter(|t| t.section == section && t.block == block)
        {
            if row < t.first_row || row >= t.last_row {
                continue;
            }
            if let Some(c) = t.cells.iter().find(|c| c.row == row && c.col == col) {
                return Some((pi, c.clone()));
            }
        }
    }
    None
}

/// The ACTIVE model cell at `(row, col)` of the table block at `(section, block)`, resolved through
/// a 1×1 frame wrapper (자가진단표) via `edit_target` — the SAME resolution `block_runs`/
/// `SetTableCellRuns` use, so the caret address space and the commit address space agree.
fn model_cell(
    doc: &SemanticDoc,
    section: usize,
    block: usize,
    row: usize,
    col: usize,
) -> Option<(&Table, &Cell)> {
    let Some(Block::Table(t)) = doc.sections.get(section).and_then(|s| s.blocks.get(block)) else {
        return None;
    };
    let t = t.edit_target();
    let cell = t
        .cells
        .iter()
        .find(|c| c.active && c.row == row && c.col == col)?;
    Some((t, cell))
}

/// Walk a descending `CellPath` to the LEAF table+cell (issue #48). Level 0 unwraps a 1×1 frame
/// wrapper via `edit_target`; deeper levels index the RAW `Block::Table` inside the previous cell
/// (mirrors `place_nested_table` / `hwp_ops::resolve_cell`). Length-1 is the flat 053 lane (A2).
fn model_cell_path<'a>(
    doc: &'a SemanticDoc,
    section: usize,
    path: &[CellAddr],
) -> Option<(&'a Table, &'a Cell)> {
    let (first, rest) = path.split_first()?;
    if rest.is_empty() {
        return model_cell(doc, section, first.block, first.row, first.col);
    }
    let sec = doc.sections.get(section)?;
    let Block::Table(t0) = sec.blocks.get(first.block)? else {
        return None;
    };
    let t0 = t0.edit_target();
    let mut cell = t0
        .cells
        .iter()
        .find(|c| c.active && c.row == first.row && c.col == first.col)?;
    for (i, addr) in rest.iter().enumerate() {
        let Block::Table(nt) = cell.blocks.get(addr.block)? else {
            return None;
        };
        if i + 1 == rest.len() {
            let leaf = nt
                .cells
                .iter()
                .find(|c| c.active && c.row == addr.row && c.col == addr.col)?;
            return Some((nt, leaf));
        }
        cell = nt
            .cells
            .iter()
            .find(|c| c.active && c.row == addr.row && c.col == addr.col)?;
    }
    None
}

/// The `(page, PlacedCell)` that draws the leaf cell of `path` (issue #48). Matches the fragment
/// whose `ancestors` + `self_block` equal the path prefix + last step's block.
fn owning_cell_rect_path(
    placed: &PlacedDoc,
    section: usize,
    path: &[CellAddr],
) -> Option<(usize, PlacedCell)> {
    let last = path.last()?;
    let prefix = &path[..path.len() - 1];
    for (pi, pg) in placed.pages.iter().enumerate() {
        for t in pg.tables.iter().filter(|t| t.section == section) {
            if t.ancestors.as_slice() != prefix || t.self_block != last.block {
                continue;
            }
            if last.row < t.first_row || last.row >= t.last_row {
                continue;
            }
            if let Some(c) = t
                .cells
                .iter()
                .find(|c| c.row == last.row && c.col == last.col)
            {
                return Some((pi, c.clone()));
            }
        }
    }
    None
}

#[allow(clippy::too_many_arguments)]
fn caret_rect_in_cell(
    doc: &SemanticDoc,
    fonts: &dyn FontMetricsProvider,
    page: usize,
    pc: &PlacedCell,
    table: &Table,
    cell: &Cell,
    para: usize,
    offset: usize,
) -> Option<CellCaretRect> {
    let (pad_left, pad_right) = crate::cell_horizontal_padding(table, cell);
    let mut out: Option<CellCaretRect> = None;
    walk_cell_lines(
        &cell.blocks,
        pc.x,
        pc.y,
        pc.w,
        pc.h,
        pad_left,
        pad_right,
        doc,
        fonts,
        &mut |lg| {
            if lg.para > para {
                return true; // past the target paragraph — the recorded candidate stands
            }
            if lg.para < para {
                return false;
            }
            let o = offset.min(lg.para_len); // past-end clamps to the paragraph end (CaretRect contract)
            if o < lg.line_start {
                return false; // resolved on an earlier line already
            }
            // Chars of THIS line within the segment (a forced-break line's trailing '\n' is the
            // separator itself — offset o == para_len sits BEFORE it, i.e. at most count-1 advances in).
            let n = (o - lg.line_start).min(lg.advances.len());
            // LAST line with `line_start <= o` wins: an offset on a wrap boundary belongs to the
            // FOLLOWING line's start (typing continues there) — the loop's later overwrite does that.
            if o <= lg.line_start + lg.advances.len() {
                let x = lg.x0 + lg.advances[..n].iter().sum::<f64>();
                out = Some(CellCaretRect {
                    page,
                    x,
                    top: lg.top,
                    height: lg.height,
                });
            }
            false
        },
    );
    out
}

/// Cell-addressed caret rect (issue 053): the caret geometry at char `offset` of the `para`-th
/// paragraph of cell `(row, col)` of the table at `(section, block)` — own-render ABSOLUTE page
/// HWPUNIT, on the page the owning fragment landed on. A past-end `offset` CLAMPS to the paragraph
/// end and returns a rect (never `None` for it — the same contract as the NodeId `CaretRect`).
/// `None` when the address doesn't resolve (no such table/cell/paragraph, or the cell isn't placed).
#[allow(clippy::too_many_arguments)]
pub fn cell_caret_rect(
    doc: &SemanticDoc,
    placed: &PlacedDoc,
    fonts: &dyn FontMetricsProvider,
    section: usize,
    block: usize,
    row: usize,
    col: usize,
    para: usize,
    offset: usize,
) -> Option<CellCaretRect> {
    let (page, pc) = owning_cell_rect(placed, section, block, row, col)?;
    let (table, cell) = model_cell(doc, section, block, row, col)?;
    caret_rect_in_cell(doc, fonts, page, &pc, table, cell, para, offset)
}

/// Path-addressed twin of [`cell_caret_rect`] (issue #48). A length-1 path is the flat 053
/// lane (A2 — do not reimplement depth-1 here). Length ≥ 2 walks the nested leaf.
pub fn cell_caret_rect_path(
    doc: &SemanticDoc,
    placed: &PlacedDoc,
    fonts: &dyn FontMetricsProvider,
    section: usize,
    path: &[CellAddr],
    para: usize,
    offset: usize,
) -> Option<CellCaretRect> {
    if path.len() <= 1 {
        let step = path.first()?;
        return cell_caret_rect(
            doc, placed, fonts, section, step.block, step.row, step.col, para, offset,
        );
    }
    let (page, pc) = owning_cell_rect_path(placed, section, path)?;
    let (table, cell) = model_cell_path(doc, section, path)?;
    caret_rect_in_cell(doc, fonts, page, &pc, table, cell, para, offset)
}

/// Cell-addressed hit test (issue 053): resolve a page-space point (HWPUNIT) to the CELL TEXT caret
/// target under it — the inverse of [`cell_caret_rect`]. Picks the topmost table fragment containing
/// the point, the cell within it, then the vertically NEAREST text line and the char boundary
/// nearest to `x` (a click in the padding still carets the closest position — 근접 스냅, mirroring
/// `block_at`'s nearest-band rule). `None` off any table cell, on a continuation fragment of a
/// row-spanning cell (its text lives on the owning page), or when the cell has no paragraph.
/// Smallest-area table fragment containing `(x, y)` (issue #48 A1). Nested tables sit inside
/// their parent so min-area == innermost; a same-area tie prefers the deeper path, then the
/// later (painted-on-top) fragment.
fn table_at_min_area(pg: &PlacedPage, x: f64, y: f64) -> Option<&PlacedTable> {
    pg.tables
        .iter()
        .enumerate()
        .filter(|(_, t)| x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h)
        .min_by(|(ia, a), (ib, b)| {
            (a.w * a.h)
                .total_cmp(&(b.w * b.h))
                .then_with(|| b.ancestors.len().cmp(&a.ancestors.len()))
                .then_with(|| ib.cmp(ia))
        })
        .map(|(_, t)| t)
}

pub fn cell_text_hit(
    doc: &SemanticDoc,
    placed: &PlacedDoc,
    fonts: &dyn FontMetricsProvider,
    page: usize,
    x: f64,
    y: f64,
) -> Option<CellTextHit> {
    let pg = placed.pages.get(page)?;
    let t = table_at_min_area(pg, x, y)?;
    let pc = t.cell_at(x, y)?;
    if pc.row < t.first_row {
        return None; // continuation fragment — the text (and its caret) lives on the owning page
    }
    let path = t.leaf_path(pc.row, pc.col);
    let (section, block) = (t.section, t.block);
    let (table, cell) = if path.len() > 1 {
        model_cell_path(doc, section, &path)?
    } else {
        model_cell(doc, section, block, pc.row, pc.col)?
    };
    let (pad_left, pad_right) = crate::cell_horizontal_padding(table, cell);
    let (row, col, cx, cy, cw, chh) = (pc.row, pc.col, pc.x, pc.y, pc.w, pc.h);
    let hit_path = if path.len() > 1 { path } else { Vec::new() };
    let mut best: Option<(f64, CellTextHit)> = None;
    walk_cell_lines(
        &cell.blocks,
        cx,
        cy,
        cw,
        chh,
        pad_left,
        pad_right,
        doc,
        fonts,
        &mut |lg| {
            // Vertical distance from the click to this line's band (0 inside it) — nearest line wins,
            // first (upper) line on a tie.
            let vd = if y < lg.top {
                lg.top - y
            } else if y > lg.top + lg.height {
                y - (lg.top + lg.height)
            } else {
                0.0
            };
            if best.as_ref().map(|(d, _)| vd < *d).unwrap_or(true) {
                // Nearest char boundary: advance while the click is past the glyph's midpoint. A forced
                // line break ('\n') caps the walk — the caret never lands PAST it (that position IS the
                // segment end; the next segment starts on the next line).
                let mut cxp = lg.x0;
                let mut off = lg.line_start;
                for (i, &a) in lg.advances.iter().enumerate() {
                    if lg.chars[i] == '\n' {
                        break;
                    }
                    if x > cxp + a / 2.0 {
                        cxp += a;
                        off += 1;
                    } else {
                        break;
                    }
                }
                best = Some((
                    vd,
                    CellTextHit {
                        section,
                        block,
                        row,
                        col,
                        para: lg.para,
                        offset: off,
                        para_len: lg.para_len,
                        caret: CellCaretRect {
                            page,
                            x: cxp,
                            top: lg.top,
                            height: lg.height,
                        },
                        path: hit_path.clone(),
                    },
                ));
            }
            false
        },
    );
    best.map(|(_, h)| h)
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
        for (i, x) in xs.iter_mut().enumerate() {
            *x = cw * i as f64;
        }
    }
    xs
}

/// 셀별 `(x, 폭)` (표 좌상단 기준, 그려지는 단위) — **저장된 셀 실폭**(`Cell::width`)으로 행마다
/// 따로 눕힌다. 반환은 `t.cells` 와 인덱스 정렬. 한 셀이라도 실폭이 없으면 `None` 을 돌려주고
/// 호출자는 열 격자([`column_offsets`])로 되돌아간다.
///
/// 왜(이슈 074): 한글 표의 열 경계는 **행마다 다를 수 있다**. benchmark1 의 24×13 표는 13열 격자로
/// 환산하면 어떤 셀이 실폭 12528 → 6606(절반)으로, 다른 셀은 6373 → 13212(두 배)로 어긋난다.
/// 폭이 절반이면 셀 글이 두 배로 줄바꿈되고 행이 부풀어(+4285 HWPUNIT = 한 문단이 다음 쪽으로
/// 밀리고, 그 다음 쪽 나누기 때문에 한 쪽이 통째로 버려졌다) 쪽수가 늘어난다.
///
/// 축척: 표 실폭(행별 합의 최대) → `avail_w`. `column_offsets` 와 같은 규칙이라 표 전체 폭은 동일.
///
/// ⚠️ **사용자가 열 너비를 편집했으면(`Table::geometry_edited`) 쓰지 않는다.** 그때는 op 이 갱신한
/// `col_widths` 가 진실이고, 파싱 당시의 셀 실폭은 낡은 값이다 — 이걸 계속 쓰면 열 경계 드래그가
/// 화면에 **전혀 반영되지 않는다**(036/031 e2e: 드래그 후 apply-verify 가 "경계가 안 움직였다"로
/// 판정 → 성공 토스트가 안 뜬다). 편집 전에는 두 값이 같은 표를 가리키므로 이 분기는 무해하다.
pub(crate) fn cell_boxes(t: &Table, avail_w: f64) -> Option<Vec<(f64, f64)>> {
    if t.rows == 0 || t.cells.is_empty() || t.geometry_edited {
        return None;
    }
    if t.cells
        .iter()
        .any(|c| c.active && c.width.unwrap_or(0) <= 0)
    {
        return None; // 실폭을 모르는 셀이 하나라도 있으면 격자 근사로
    }
    // 행 r 을 덮는 활성 셀(위 행에서 세로 병합돼 내려온 셀 포함)을 열 순으로 — 한 번만 버킷팅해
    // 두고 재사용한다(행마다 전 셀을 훑으면 큰 표에서 O(행×셀)이 된다).
    let mut covering: Vec<Vec<usize>> = vec![Vec::new(); t.rows];
    for (i, c) in t.cells.iter().enumerate() {
        if !c.active || c.row >= t.rows {
            continue;
        }
        let end = (c.row + c.row_span.max(1)).min(t.rows);
        for row in covering.iter_mut().take(end).skip(c.row) {
            row.push(i);
        }
    }
    for row in &mut covering {
        row.sort_by_key(|&i| t.cells[i].col);
    }
    // 표 실폭 = 행별 덮개 폭 합의 최대(행마다 열 경계가 달라도 표 전체 폭은 같다).
    let width_of = |i: usize| t.cells[i].width.unwrap_or(0) as f64;
    let total = covering
        .iter()
        .map(|row| row.iter().copied().map(width_of).sum::<f64>())
        .fold(0.0f64, f64::max);
    if total <= 0.0 {
        return None;
    }
    let scale = avail_w / total;
    let mut out = vec![(0.0f64, 0.0f64); t.cells.len()];
    for (r, row) in covering.iter().enumerate() {
        let mut x = 0.0f64;
        for &i in row {
            let w = width_of(i) * scale;
            // 세로 병합 셀은 시작 행에서 정한 상자를 유지한다(아래 행에서 다시 쓰지 않음).
            if t.cells[i].row == r {
                out[i] = (x, w);
            }
            x += w;
        }
    }
    Some(out)
}

/// 셀 i 의 `(x, 폭)` — 저장 실폭 상자가 있으면 그것을, 없으면 열 격자 근사를.
pub(crate) fn cell_box_at(
    t: &Table,
    boxes: &Option<Vec<(f64, f64)>>,
    xs: &[f64],
    i: usize,
) -> (f64, f64) {
    if let Some(b) = boxes {
        let (x, w) = b[i];
        if w > 0.0 {
            return (x, w);
        }
    }
    let c = &t.cells[i];
    let col = c.col.min(t.cols.saturating_sub(1));
    let col_end = (c.col + c.col_span.max(1)).min(t.cols);
    let x = xs[col];
    ((x), (xs[col_end] - x).max(1.0))
}

/// Per-row heights — **[`crate::table_row_heights`] 자체를 부른다**. 예전엔 같은 식을 여기에 한 벌
/// 더 두었는데(표기만 다른 쌍둥이), 한쪽만 고치면 예약과 그리기가 어긋나 LOCKSTEP 이 깨진다.
/// 이제 계산은 한 곳뿐이다(이슈 074).
fn row_heights(
    t: &Table,
    avail_w: f64,
    doc: &SemanticDoc,
    fonts: &dyn FontMetricsProvider,
) -> Vec<f64> {
    crate::table_row_heights(t, avail_w, doc, fonts)
}

/// Cumulative row TOPS relative to the table's top edge, length `rows + 1` — the row twin of
/// [`column_offsets`]. `row_offsets[r]` is the y of row r's top edge; `row_offsets[rows]` is the
/// table's content height. Needs `doc`/`fonts` because row heights are content-measured (unlike the
/// explicit column widths). Powers the `table_row_boundaries` resize-handle geometry.
pub fn row_offsets(
    t: &Table,
    avail_w: f64,
    doc: &SemanticDoc,
    fonts: &dyn FontMetricsProvider,
) -> Vec<f64> {
    let row_h = row_heights(t, avail_w, doc, fonts);
    let mut tops = vec![0.0f64; t.rows + 1];
    for r in 0..t.rows {
        tops[r + 1] = tops[r] + row_h[r];
    }
    tops
}

/// Laid-out height of a block at `width` — paragraph (lines×spacing + 위/아래 간격, trailing leading
/// trimmed) or nested table. Delegates the paragraph arm to `crate::cell_paragraph_height` — the SAME
/// helper `lib.rs::block_height` uses — so the drawn cell and the pagination reserve are LOCKSTEP by
/// construction (no parallel formula to drift). See `cell_paragraph_height` for the last-line rationale.
fn block_height_for_place(
    b: &Block,
    doc: &SemanticDoc,
    width: f64,
    fonts: &dyn FontMetricsProvider,
) -> f64 {
    match b {
        Block::Paragraph(p) => crate::cell_paragraph_height(p, doc, width, fonts),
        Block::Table(t) => table_height(t, width, doc, fonts),
    }
}

/// Flat (char, size, color, underline) over a paragraph's text runs — the SAME enumeration order
/// `layout_paragraph` breaks on, so a line's `text_pos` indexes straight into this slice.
#[derive(Clone)]
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
    /// Exact metric selection key. This is resolved once with the same family substitution as the
    /// display face, keeping the line breaker and positioned glyph advances in lockstep.
    metric_font: FontKey,
    /// 장평 (width scale, default 1.0) + 자간 (letter gap as a fraction of the EM, default 0.0), resolved
    /// from the run's char shape per the glyph's script. The DRAWN advance must apply these so glyphs
    /// sit where the line-breaker (which now scales advances) computed — else a compressed run renders
    /// ~10% too wide and overflows its column.
    ratio: f64,
    spacing_em: f64,
    /// Old-hangul jamo cluster to draw instead of `ch` (issue 062-2), else `None`. See [`PlacedGlyph::cluster`].
    cluster: Option<String>,
}

#[derive(Clone)]
enum ParagraphAtom {
    Glyph(GlyphInfo),
    Object {
        width: f64,
        height: f64,
        bin_ref: String,
        svg: Option<String>,
        treat_as_char: bool,
    },
}

impl ParagraphAtom {
    fn advance(&self, fonts: &dyn FontMetricsProvider) -> f64 {
        match self {
            Self::Glyph(glyph) => {
                fonts.advance_width(&glyph.metric_font, glyph.ch, glyph.size as i32) * glyph.ratio
                    + glyph.spacing_em * glyph.size
            }
            Self::Object {
                width,
                treat_as_char,
                ..
            } => {
                if *treat_as_char {
                    *width
                } else {
                    0.0
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn place_atom(
    page: &mut PlacedPage,
    atom: &ParagraphAtom,
    x: f64,
    line_top: f64,
    baseline: f64,
    fonts: &dyn FontMetricsProvider,
    section: usize,
    block: usize,
) -> f64 {
    match atom {
        ParagraphAtom::Glyph(glyph) => {
            if glyph.ch != ' ' && glyph.ch != '\t' && glyph.ch != '\n' {
                page.glyphs.push(PlacedGlyph {
                    x,
                    baseline,
                    ch: glyph.ch,
                    size: glyph.size,
                    color: glyph.color,
                    underline: glyph.underline,
                    bold: glyph.bold,
                    italic: glyph.italic,
                    font: glyph.font.clone(),
                    cluster: glyph.cluster.clone(),
                });
            }
            atom.advance(fonts)
        }
        ParagraphAtom::Object {
            width,
            height,
            bin_ref,
            svg,
            ..
        } => {
            page.images.push(PlacedImage {
                x,
                y: line_top,
                w: *width,
                h: *height,
                bin_ref: bin_ref.clone(),
                svg: svg.clone(),
                is_background: false,
                section,
                block,
            });
            atom.advance(fonts)
        }
    }
}

fn paragraph_atoms(
    p: &Paragraph,
    doc: &SemanticDoc,
    fonts: &dyn FontMetricsProvider,
) -> Vec<ParagraphAtom> {
    let mut out = Vec::new();
    for run in &p.runs {
        let cs = doc.char_shapes.get(run.char_shape);
        let size = cs.map(|c| c.height).filter(|&h| h > 0).unwrap_or(1000) as f64;
        let color = cs.map(|c| c.text_color).unwrap_or_default();
        let underline = cs.map(|c| c.underline).unwrap_or(false);
        let bold = cs.map(|c| c.bold).unwrap_or(false);
        let italic = cs.map(|c| c.italic).unwrap_or(false);
        for inl in &run.content {
            match inl {
                Inline::Text(t) => {
                    for ch in t.chars() {
                        // Issue 062-2: a Hanyang-PUA 옛한글 음절 draws as its 첫가끝 자모 시퀀스 (an OFL-
                        // coverable cluster) while `subst_glyph` swaps `ch` to the full-width metric proxy
                        // — so advances/breaking (via layout_paragraph) stay in lockstep with the drawn cell.
                        let cluster = crate::old_hangul_cluster(ch);
                        let sch = crate::subst_glyph(ch);
                        let slot = crate::script_slot(sch);
                        let metric_font = crate::resolved_font_key(cs, sch, fonts);
                        let (ratio, spacing_em) = cs
                            .map(|c| {
                                let r = match *c.ratio.get(slot) {
                                    0 => 100,
                                    r => r.clamp(50, 200),
                                } as f64
                                    / 100.0;
                                let s = (*c.spacing.get(slot)).clamp(-50, 50) as f64 / 100.0;
                                (r, s)
                            })
                            .unwrap_or((1.0, 0.0));
                        out.push(ParagraphAtom::Glyph(GlyphInfo {
                            ch: sch,
                            size,
                            color,
                            underline,
                            bold,
                            italic,
                            font: display_font(cs, slot, fonts),
                            metric_font,
                            ratio,
                            spacing_em,
                            cluster,
                        }));
                    }
                }
                Inline::Image(image) => out.push(ParagraphAtom::Object {
                    width: image.width.max(0) as f64,
                    height: image.height.max(0) as f64,
                    bin_ref: image.bin_ref.clone(),
                    svg: None,
                    treat_as_char: image.treat_as_char,
                }),
                Inline::Equation(equation) => out.push(ParagraphAtom::Object {
                    width: equation.width.max(0) as f64,
                    height: equation.height.max(0) as f64,
                    bin_ref: String::new(),
                    svg: equation.rendered_svg.clone(),
                    treat_as_char: equation.treat_as_char,
                }),
                Inline::Chart(chart) => out.push(ParagraphAtom::Object {
                    width: chart.width.max(0) as f64,
                    height: chart.height.max(0) as f64,
                    bin_ref: String::new(),
                    svg: chart.rendered_svg.clone(),
                    treat_as_char: chart.treat_as_char,
                }),
                _ => {}
            }
        }
    }
    out
}

#[cfg(test)]
fn paragraph_glyphs(
    p: &Paragraph,
    doc: &SemanticDoc,
    fonts: &dyn FontMetricsProvider,
) -> Vec<GlyphInfo> {
    paragraph_atoms(p, doc, fonts)
        .into_iter()
        .filter_map(|atom| match atom {
            ParagraphAtom::Glyph(glyph) => Some(glyph),
            ParagraphAtom::Object { .. } => None,
        })
        .collect()
}

/// The OFL substitute display family for a glyph (issue 058): resolve the char shape's per-script font
/// NAME (HWP docs carry 함초롬바탕(명조)/함초롬돋움(고딕) in `CharShape.fonts`, one per [`ScriptClass`]),
/// falling back to the single `font_family` (an in-app 글꼴 change / HWPX), then classify it to a bundled
/// substitute ([`hwp_model::font_class::substitute_family`]). `None` = the default gothic (NanumGothic,
/// the SVG's universal fallback) — so 고딕/기타 runs keep their pre-058 rendering (and golden bytes).
/// DISPLAY only: the metric provider stays family-blind, so advances/pagination (and the gate) are
/// unchanged — only which face draws the glyph shape changes.
fn display_font(
    cs: Option<&CharShape>,
    slot: ScriptClass,
    fonts: &dyn FontMetricsProvider,
) -> Option<String> {
    let cs = cs?;
    let name = cs
        .fonts
        .get(slot as usize)
        .and_then(|o| o.as_deref())
        .or(cs.font_family.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty())?;
    // Issue 058 follow-up: a definitive PANOSE (typeInfo) hint for this slot wins over the name
    // heuristic; an absent/indeterminate hint (the empty-Vec common case) falls back to the name.
    // 폰트 제공 (explicit-family bypass): a face name that matches a REGISTERED (injected) family
    // keeps ITSELF — the user explicitly picked a catalog face (or uploaded their own 함초롬), so the
    // 058 class substitute must not overwrite it. Doc-native names (함초롬…) never match → unchanged.
    if fonts.has_family(name) {
        return Some(name.to_string());
    }
    let panose = cs.font_panose.get(slot as usize).and_then(Option::as_ref);
    hwp_model::font_class::substitute_family_with_panose(name, panose).map(str::to_string)
}

fn paragraph_has_object(p: &Paragraph) -> bool {
    p.runs.iter().any(|run| {
        run.content.iter().any(|inline| {
            matches!(
                inline,
                Inline::Image(_) | Inline::Equation(_) | Inline::Chart(_)
            )
        })
    })
}

fn set_page_size(pg: &mut PlacedPage, page: &PageSetup) {
    // Guides must use the same swapped paper as body_box / pg.width (HWP5 landscape).
    let (pw, ph) = crate::display_paper(page);
    pg.width = pw as f64;
    pg.height = ph as f64;
    // 여백 안내선은 **글자가 실제로 놓이는 상자**(= crate::body_box)를 가리켜야 한다 — 제본/
    // 머리말/꼬리말 여백을 빼먹으면 눈금자와 본문이 어긋난다(이슈 074).
    let (ml, mt, bw, bh) = crate::body_box(page);
    pg.margin_left = ml;
    pg.margin_top = mt;
    pg.margin_right = (pw as f64 - ml - bw).max(0.0);
    pg.margin_bottom = (ph as f64 - mt - bh).max(0.0);
}

fn new_page(pages: &mut Vec<PlacedPage>, page: &PageSetup) {
    let mut pg = PlacedPage::default();
    set_page_size(&mut pg, page);
    pages.push(pg);
}

fn deco_applies(apply: ApplyPage, page_idx: usize) -> bool {
    match apply {
        ApplyPage::Both => true,
        ApplyPage::Odd => page_idx.is_multiple_of(2),
        ApplyPage::Even => page_idx % 2 == 1,
    }
}

/// Paint lifted 머리말/꼬리말 into the reserved header/footer bands.
/// Body pagination is unchanged (LOCKSTEP): the bands are already subtracted by `body_box`.
fn place_section_decorations(
    pages: &mut [PlacedPage],
    first_page: usize,
    sec: &Section,
    doc: &SemanticDoc,
    fonts: &dyn FontMetricsProvider,
) {
    if sec.decorations.is_empty() && sec.page_number.is_none() {
        return;
    }
    let page = &sec.page;
    let (pw, ph) = crate::display_paper(page);
    let left = (page.margin_left + page.margin_gutter.max(0)) as f64;
    let right = page.margin_right.max(0) as f64;
    let band_w = (pw as f64 - left - right).max(1.0);
    let header_y = page.margin_header.max(0) as f64;
    let header_h = page.margin_top.max(0) as f64;
    let footer_h = page.margin_bottom.max(0) as f64;
    let footer_y = (ph as f64 - page.margin_footer.max(0) as f64 - footer_h).max(0.0);

    for (i, pg) in pages.iter_mut().enumerate().skip(first_page) {
        for deco in &sec.decorations {
            if !deco_applies(deco.apply, i) {
                continue;
            }
            let (y, h) = match deco.kind {
                DecoKind::Header => (header_y, header_h.max(1.0)),
                DecoKind::Footer => (footer_y, footer_h.max(1.0)),
            };
            place_deco_blocks(pg, &deco.blocks, doc, fonts, left, y, band_w, h, page);
        }
        if let Some(number) = sec.page_number {
            place_page_number(
                pg,
                number,
                usize::from(number.start.get()) + (i - first_page),
                fonts,
                left,
                header_y,
                footer_y,
                band_w,
                header_h,
                footer_h,
            );
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn place_page_number(
    page: &mut PlacedPage,
    decoration: PageNumberDecoration,
    page_number: usize,
    fonts: &dyn FontMetricsProvider,
    left: f64,
    header_y: f64,
    footer_y: f64,
    band_w: f64,
    header_h: f64,
    footer_h: f64,
) {
    if decoration.position == PageNumberPosition::None {
        return;
    }
    let number = format_page_number(page_number, decoration.format);
    let mut text = String::new();
    if let Some(dash) = decoration.dash {
        text.push(dash);
    }
    if let Some(prefix) = decoration.prefix {
        text.push(prefix);
    }
    text.push_str(&number);
    if let Some(suffix) = decoration.suffix {
        text.push(suffix);
    }
    if let Some(dash) = decoration.dash {
        text.push(dash);
    }

    let size = 1_000.0;
    let key = FontKey {
        family: String::new(),
        bold: false,
        italic: false,
    };
    let width = text
        .chars()
        .map(|ch| fonts.advance_width(&key, ch, size as i32))
        .sum::<f64>();
    let is_odd = page_number % 2 == 1;
    let (top, height, horizontal) = match decoration.position {
        PageNumberPosition::TopLeft => (header_y, header_h, 0),
        PageNumberPosition::TopCenter => (header_y, header_h, 1),
        PageNumberPosition::TopRight => (header_y, header_h, 2),
        PageNumberPosition::BottomLeft => (footer_y, footer_h, 0),
        PageNumberPosition::BottomCenter => (footer_y, footer_h, 1),
        PageNumberPosition::BottomRight => (footer_y, footer_h, 2),
        PageNumberPosition::OutsideTop => (header_y, header_h, usize::from(is_odd) * 2),
        PageNumberPosition::OutsideBottom => (footer_y, footer_h, usize::from(is_odd) * 2),
        PageNumberPosition::InsideTop => (header_y, header_h, usize::from(!is_odd) * 2),
        PageNumberPosition::InsideBottom => (footer_y, footer_h, usize::from(!is_odd) * 2),
        PageNumberPosition::None => return,
    };
    let mut x = match horizontal {
        0 => left,
        1 => left + (band_w - width) / 2.0,
        _ => left + band_w - width,
    };
    let baseline = top + (height.max(size) - size) / 2.0 + BASELINE_RATIO * size;
    for ch in text.chars() {
        page.glyphs.push(PlacedGlyph {
            x,
            baseline,
            ch,
            size,
            color: Color::default(),
            underline: false,
            bold: false,
            italic: false,
            font: None,
            cluster: None,
        });
        x += fonts.advance_width(&key, ch, size as i32);
    }
}

fn format_page_number(number: usize, format: PageNumberFormat) -> String {
    match format {
        PageNumberFormat::Digit => number.to_string(),
        PageNumberFormat::CircledDigit if (1..=20).contains(&number) => {
            char::from_u32(0x2460 + number as u32 - 1)
                .expect("circled digit range is scalar")
                .to_string()
        }
        PageNumberFormat::CircledDigit => number.to_string(),
        PageNumberFormat::RomanUpper => format_roman(number, true),
        PageNumberFormat::RomanLower => format_roman(number, false),
        PageNumberFormat::LatinUpper => format_latin(number, true),
        PageNumberFormat::LatinLower => format_latin(number, false),
    }
}

fn format_roman(mut number: usize, upper: bool) -> String {
    if number == 0 || number > 3_999 {
        return number.to_string();
    }
    let values = [1_000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
    let upper_symbols = [
        "M", "CM", "D", "CD", "C", "XC", "L", "XL", "X", "IX", "V", "IV", "I",
    ];
    let lower_symbols = [
        "m", "cm", "d", "cd", "c", "xc", "l", "xl", "x", "ix", "v", "iv", "i",
    ];
    let symbols = if upper {
        &upper_symbols
    } else {
        &lower_symbols
    };
    let mut out = String::new();
    for (value, symbol) in values.into_iter().zip(symbols) {
        while number >= value {
            out.push_str(symbol);
            number -= value;
        }
    }
    out
}

fn format_latin(mut number: usize, upper: bool) -> String {
    if number == 0 {
        return String::new();
    }
    let mut out = String::new();
    while number != 0 {
        number -= 1;
        let base = if upper { b'A' } else { b'a' };
        out.insert(0, (base + (number % 26) as u8) as char);
        number /= 26;
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn place_deco_blocks(
    dest: &mut PlacedPage,
    blocks: &[Block],
    doc: &SemanticDoc,
    fonts: &dyn FontMetricsProvider,
    ml: f64,
    mt: f64,
    body_w: f64,
    body_h: f64,
    page: &PageSetup,
) {
    let mut tmp = vec![dest.clone()];
    let mut vert = 0.0;
    for (bi, block) in blocks.iter().enumerate() {
        match block {
            Block::Paragraph(p) => {
                if p.is_table_anchor {
                    continue;
                }
                place_paragraph(
                    p, doc, fonts, ml, mt, body_w, body_h, &mut vert, &mut tmp, page, 0, bi,
                );
            }
            Block::Table(t) => {
                let unwrapped = crate::unwrap_frame_table(t);
                let (t, frame) = match &unwrapped {
                    Some((inner, f)) => (inner, *f),
                    None => (t, None),
                };
                vert = place_table(
                    t, doc, fonts, ml, mt, body_h, vert, body_w, &mut tmp, page, 0, bi, frame,
                );
            }
        }
        if tmp.len() > 1 {
            tmp.truncate(1);
        }
    }
    *dest = tmp.remove(0);
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
            runs: vec![Run {
                char_shape: 0,
                content: vec![Inline::Text(text.into())],
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    fn doc_with(blocks: Vec<Block>) -> SemanticDoc {
        let mut doc = SemanticDoc::default();
        doc.char_shapes.push(CharShape::default()); // index 0 → size 1000
        doc.para_shapes.push(ParaShape::default());
        let sec = Section {
            blocks,
            ..Default::default()
        };
        doc.sections.push(sec);
        doc
    }

    fn mixed_object_paragraph() -> Paragraph {
        let equation = |name: &str, height| {
            Inline::Equation(EquationRef {
                script: name.into(),
                font: String::new(),
                base_unit: 1000,
                baseline: 0,
                color: Color::default(),
                width: 800,
                height,
                treat_as_char: true,
                version: String::new(),
                rendered_svg: Some(format!("<g id=\"{name}\"/>")),
            })
        };
        Paragraph {
            runs: vec![Run {
                char_shape: 0,
                content: vec![
                    Inline::Text("A".into()),
                    equation("EqA", 1200),
                    Inline::Text("B".into()),
                    equation("EqB", 1400),
                    Inline::Text("C".into()),
                    Inline::Chart(ChartRef {
                        width: 800,
                        height: 1600,
                        treat_as_char: true,
                        rendered_svg: Some("<g id=\"ChartC\"/>".into()),
                    }),
                ],
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    #[test]
    fn mixed_inline_objects_place_in_order_in_body_and_cell() {
        let mut body = doc_with(vec![Block::Paragraph(mixed_object_paragraph())]);
        body.sections[0].page.width = 3000;
        body.sections[0].page.height = 10000;
        body.sections[0].page.margin_left = 0;
        body.sections[0].page.margin_right = 0;
        body.sections[0].page.margin_top = 0;
        body.sections[0].page.margin_bottom = 0;
        let placed = place_doc(&body, &ApproxFontMetrics);
        let images = &placed.pages[0].images;
        assert_eq!(images.len(), 3, "every object atom is painted exactly once");
        assert!(images[0].svg.as_deref().unwrap().contains("EqA"));
        assert!(images[1].svg.as_deref().unwrap().contains("EqB"));
        assert!(images[2].svg.as_deref().unwrap().contains("ChartC"));
        assert_ne!((images[0].x, images[0].y), (images[1].x, images[1].y));
        assert!(images[2].y > images[1].y, "ChartC wraps to the next line");
        assert_eq!(
            placed.pages.len(),
            crate::NaiveLayout
                .layout(&body, &ApproxFontMetrics)
                .unwrap()
                .pages
                .len(),
            "body placement stays in LOCKSTEP"
        );

        let table = Table {
            rows: 1,
            cols: 1,
            col_widths: vec![6000],
            cells: vec![Cell {
                row: 0,
                col: 0,
                width: Some(6000),
                blocks: vec![Block::Paragraph(mixed_object_paragraph())],
                ..Default::default()
            }],
            ..Default::default()
        };
        let cell_doc = doc_with(vec![Block::Table(table)]);
        let cell_placed = place_doc(&cell_doc, &ApproxFontMetrics);
        assert_eq!(cell_placed.pages[0].images.len(), 3);
        let start = cell_caret_rect(
            &cell_doc,
            &cell_placed,
            &ApproxFontMetrics,
            0,
            0,
            0,
            0,
            0,
            0,
        )
        .expect("cell caret before mixed flow");
        let end = cell_caret_rect(
            &cell_doc,
            &cell_placed,
            &ApproxFontMetrics,
            0,
            0,
            0,
            0,
            0,
            3,
        )
        .expect("cell caret after mixed flow");
        assert!(
            end.x > start.x,
            "caret geometry includes inline object advances"
        );
        assert_eq!(
            cell_placed.pages.len(),
            crate::NaiveLayout
                .layout(&cell_doc, &ApproxFontMetrics)
                .unwrap()
                .pages
                .len(),
            "cell placement stays in LOCKSTEP"
        );
    }

    #[test]
    fn explicit_columns_keep_all_three_layout_paths_in_lockstep_and_bounded() {
        let columns = ColumnLayout {
            widths: vec![2_000, 3_000],
            gaps: vec![500],
            separator: Some(ColumnSeparator {
                color: Color {
                    r: 255,
                    g: 0,
                    b: 0,
                    a: 255,
                },
                style: LineStyle::Solid,
                width_px: 0.5,
            }),
            ..ColumnLayout::default()
        };
        let mut first = para("가\n나\n다\n라\n마\n바\n사\n아\n자\n차");
        first.column_layout_before = Some(columns);
        let mut second = para("둘째 단");
        second.column_break_before = true;
        let mut table = Table {
            rows: 2,
            cols: 1,
            ..Table::default()
        };
        for row in 0..2 {
            table.cells.push(Cell {
                row,
                col: 0,
                row_span: 1,
                col_span: 1,
                active: true,
                blocks: vec![Block::Paragraph(para("표"))],
                ..Cell::default()
            });
        }
        let mut doc = doc_with(vec![
            Block::Paragraph(first),
            Block::Paragraph(second),
            Block::Table(table),
        ]);
        doc.sections[0].page = PageSetup {
            width: 5_500,
            height: 5_000,
            margin_left: 0,
            margin_right: 0,
            margin_top: 0,
            margin_bottom: 0,
            ..PageSetup::default()
        };

        let placed = place_doc(&doc, &ApproxFontMetrics);
        let naive = crate::NaiveLayout
            .layout(&doc, &ApproxFontMetrics)
            .expect("column layout succeeds through the public engine");
        let mapped = block_pages(&doc, &ApproxFontMetrics);
        assert_eq!(placed.pages.len(), naive.pages.len(), "LOCKSTEP page count");
        assert_eq!(mapped[0].len(), doc.sections[0].blocks.len());
        for page in &placed.pages {
            assert!(page.glyphs.iter().all(|glyph| {
                (glyph.x >= 0.0 && glyph.x < 2_000.0) || (glyph.x >= 2_500.0 && glyph.x < 5_500.0)
            }));
            assert!(page.tables.iter().all(|table| {
                (table.x >= 0.0 && table.x + table.w <= 2_000.0)
                    || (table.x >= 2_500.0 && table.x + table.w <= 5_500.0)
            }));
            assert!(page.lines.iter().any(|line| {
                line.x1 == 2_250.0 && line.x2 == 2_250.0 && line.color.r == 255 && line.width == 0.5
            }));
        }
        let second_column_has_content = placed.pages.iter().any(|page| {
            page.glyphs.iter().any(|glyph| glyph.x >= 2_500.0)
                || page.tables.iter().any(|table| table.x >= 2_500.0)
        });
        assert!(
            second_column_has_content,
            "explicit column break advances flow"
        );
    }

    #[test]
    fn unequal_rtl_columns_page_break_zone_change_and_section_transition_are_lockstep() {
        let rtl = ColumnLayout {
            direction: ColumnDirection::RightToLeft,
            widths: vec![1_000, 2_000, 3_000],
            gaps: vec![500, 500],
            ..ColumnLayout::default()
        };
        let mut first = para("첫");
        first.column_layout_before = Some(rtl.clone());
        let mut second = para("둘");
        second.column_break_before = true;
        let mut third = para("셋");
        third.page_break_before = true;
        let mut one_column = para("통단");
        one_column.column_layout_before = Some(ColumnLayout {
            widths: vec![7_000],
            gaps: Vec::new(),
            ..ColumnLayout::default()
        });
        let mut doc = doc_with(vec![
            Block::Paragraph(first),
            Block::Paragraph(second),
            Block::Paragraph(third),
            Block::Paragraph(one_column),
        ]);
        doc.sections[0].page = PageSetup {
            width: 7_000,
            height: 4_000,
            margin_left: 0,
            margin_right: 0,
            margin_top: 0,
            margin_bottom: 0,
            ..PageSetup::default()
        };
        let mut next_section = Section {
            blocks: vec![Block::Paragraph({
                let mut paragraph = para("다음 구역");
                paragraph.column_layout_before = Some(rtl);
                paragraph
            })],
            page: doc.sections[0].page,
            ..Section::default()
        };
        next_section.page.columns = 3;
        doc.sections.push(next_section);

        let placed = place_doc(&doc, &ApproxFontMetrics);
        let naive = crate::NaiveLayout
            .layout(&doc, &ApproxFontMetrics)
            .expect("layout");
        let mapped = block_pages(&doc, &ApproxFontMetrics);
        assert_eq!(placed.pages.len(), naive.pages.len());
        assert_eq!(mapped.len(), 2);
        assert!(placed.pages[0]
            .glyphs
            .iter()
            .any(|glyph| glyph.x >= 4_000.0));
        assert!(placed.pages[0]
            .glyphs
            .iter()
            .any(|glyph| (1_500.0..4_000.0).contains(&glyph.x)));
        assert!(placed.pages.len() >= 3, "page break + section transition");
        assert!(placed.pages[1]
            .glyphs
            .iter()
            .any(|glyph| glyph.x >= 4_000.0));
        assert!(placed.pages[1].glyphs.iter().any(|glyph| glyph.x < 1_000.0));
    }

    #[test]
    fn page_number_decoration_does_not_change_pagination_or_body_geometry() {
        let mut doc = doc_with(vec![Block::Paragraph(para(
            "가\n나\n다\n라\n마\n바\n사\n아",
        ))]);
        doc.sections[0].page = PageSetup {
            width: 5_000,
            height: 3_000,
            margin_left: 500,
            margin_right: 500,
            margin_top: 500,
            margin_bottom: 500,
            margin_header: 100,
            margin_footer: 100,
            ..PageSetup::default()
        };
        let without = place_doc(&doc, &ApproxFontMetrics);
        doc.sections[0].page_number = Some(PageNumberDecoration {
            start: std::num::NonZeroU16::new(7).unwrap(),
            format: PageNumberFormat::LatinUpper,
            position: PageNumberPosition::BottomCenter,
            prefix: Some('['),
            suffix: Some(']'),
            dash: Some('-'),
        });

        let placed = place_doc(&doc, &ApproxFontMetrics);
        let naive = crate::NaiveLayout
            .layout(&doc, &ApproxFontMetrics)
            .expect("page-number decoration keeps layout valid");
        assert_eq!(placed.pages.len(), without.pages.len());
        assert_eq!(placed.pages.len(), naive.pages.len());
        assert!(placed.pages.len() >= 2);
        for (before, after) in without.pages.iter().zip(&placed.pages) {
            assert_eq!(before.rects.len(), after.rects.len());
            assert_eq!(before.tables.len(), after.tables.len());
            assert_eq!(before.images.len(), after.images.len());
            assert!(after.glyphs.len() > before.glyphs.len());
        }
        let first_footer = placed.pages[0]
            .glyphs
            .iter()
            .filter(|glyph| glyph.baseline > 2_400.0)
            .map(|glyph| glyph.ch)
            .collect::<String>();
        let second_footer = placed.pages[1]
            .glyphs
            .iter()
            .filter(|glyph| glyph.baseline > 2_400.0)
            .map(|glyph| glyph.ch)
            .collect::<String>();
        assert_eq!(first_footer, "-[G]-");
        assert_eq!(second_footer, "-[H]-");
    }

    #[test]
    fn page_number_formats_are_deterministic_and_bounded() {
        assert_eq!(format_page_number(20, PageNumberFormat::CircledDigit), "⑳");
        assert_eq!(format_page_number(21, PageNumberFormat::CircledDigit), "21");
        assert_eq!(format_page_number(14, PageNumberFormat::RomanUpper), "XIV");
        assert_eq!(format_page_number(14, PageNumberFormat::RomanLower), "xiv");
        assert_eq!(format_page_number(27, PageNumberFormat::LatinUpper), "AA");
        assert_eq!(format_page_number(27, PageNumberFormat::LatinLower), "aa");
    }

    #[test]
    fn page_number_positions_map_to_bands_and_duplex_edges() {
        let decoration = |position| PageNumberDecoration {
            start: std::num::NonZeroU16::MIN,
            format: PageNumberFormat::Digit,
            position,
            prefix: None,
            suffix: None,
            dash: None,
        };
        let placed = |position, number| {
            let mut page = PlacedPage::default();
            place_page_number(
                &mut page,
                decoration(position),
                number,
                &ApproxFontMetrics,
                100.0,
                200.0,
                700.0,
                600.0,
                100.0,
                100.0,
            );
            page.glyphs.first().map(|glyph| (glyph.x, glyph.baseline))
        };

        let top_left = placed(PageNumberPosition::TopLeft, 1).unwrap();
        let top_center = placed(PageNumberPosition::TopCenter, 1).unwrap();
        let top_right = placed(PageNumberPosition::TopRight, 1).unwrap();
        let bottom_left = placed(PageNumberPosition::BottomLeft, 1).unwrap();
        let bottom_center = placed(PageNumberPosition::BottomCenter, 1).unwrap();
        let bottom_right = placed(PageNumberPosition::BottomRight, 1).unwrap();
        assert!(top_left.0 < top_center.0 && top_center.0 < top_right.0);
        assert!(bottom_left.0 < bottom_center.0 && bottom_center.0 < bottom_right.0);
        assert_eq!(top_left.1, top_center.1);
        assert_eq!(top_center.1, top_right.1);
        assert_eq!(bottom_left.1, bottom_center.1);
        assert_eq!(bottom_center.1, bottom_right.1);
        assert!(top_left.1 < bottom_left.1);
        assert!(placed(PageNumberPosition::None, 1).is_none());
        assert_eq!(
            placed(PageNumberPosition::OutsideTop, 1).unwrap().0,
            top_right.0
        );
        assert_eq!(
            placed(PageNumberPosition::OutsideTop, 2).unwrap().0,
            top_left.0
        );
        assert_eq!(
            placed(PageNumberPosition::InsideBottom, 1).unwrap().0,
            bottom_left.0
        );
        assert_eq!(
            placed(PageNumberPosition::InsideBottom, 2).unwrap().0,
            bottom_right.0
        );
    }

    #[test]
    fn page_number_restart_is_scoped_to_each_section() {
        let mut doc = doc_with(vec![Block::Paragraph(para("가"))]);
        doc.sections[0].page = PageSetup {
            width: 5_000,
            height: 3_000,
            margin_left: 500,
            margin_right: 500,
            margin_top: 500,
            margin_bottom: 500,
            margin_header: 100,
            margin_footer: 100,
            ..PageSetup::default()
        };
        let number = PageNumberDecoration {
            start: std::num::NonZeroU16::MIN,
            format: PageNumberFormat::Digit,
            position: PageNumberPosition::BottomCenter,
            prefix: None,
            suffix: None,
            dash: None,
        };
        doc.sections[0].page_number = Some(number);
        let restarted = PageNumberDecoration {
            start: std::num::NonZeroU16::new(7).unwrap(),
            ..number
        };
        doc.sections.push(Section {
            blocks: vec![Block::Paragraph(para("나"))],
            page: doc.sections[0].page,
            page_number: Some(restarted),
            ..Section::default()
        });

        let placed = place_doc(&doc, &ApproxFontMetrics);
        assert_eq!(placed.pages.len(), 2);
        let footer_text = |page: &PlacedPage| {
            page.glyphs
                .iter()
                .filter(|glyph| glyph.baseline > 2_400.0)
                .map(|glyph| glyph.ch)
                .collect::<String>()
        };
        assert_eq!(footer_text(&placed.pages[0]), "1");
        assert_eq!(footer_text(&placed.pages[1]), "7");
    }

    #[test]
    fn hwp5_landscape_section_gets_swapped_page_box() {
        let mut doc = doc_with(vec![Block::Paragraph(para("가로"))]);
        doc.sections[0].page = PageSetup {
            width: 59528,
            height: 84188,
            landscape: true,
            margin_left: 1000,
            margin_right: 1000,
            margin_top: 1000,
            margin_bottom: 1000,
            ..Default::default()
        };
        let placed = place_doc(&doc, &crate::ApproxFontMetrics);
        assert_eq!(placed.pages.len(), 1);
        assert!(
            placed.pages[0].width > placed.pages[0].height,
            "landscape must paint a wide page, got {}×{}",
            placed.pages[0].width,
            placed.pages[0].height
        );
        let naive = crate::NaiveLayout
            .layout(&doc, &crate::ApproxFontMetrics)
            .unwrap();
        assert_eq!(naive.pages.len(), 1);
        assert_eq!(naive.pages[0].width, placed.pages[0].width);
        assert_eq!(naive.pages[0].height, placed.pages[0].height);
    }

    /// PR #46 review: landscape guides subtract from `display_paper`, not the unswapped box.
    #[test]
    fn landscape_margin_guides_match_display_paper_and_body_box() {
        let mut doc = doc_with(vec![Block::Paragraph(para("가로"))]);
        doc.sections[0].page = PageSetup {
            width: 59528,
            height: 84188,
            landscape: true,
            margin_left: 1000,
            margin_right: 2000,
            margin_top: 3000,
            margin_bottom: 4000,
            margin_header: 1500,
            margin_footer: 2500,
            margin_gutter: 500,
            ..Default::default()
        };
        let placed = place_doc(&doc, &crate::ApproxFontMetrics);
        assert_eq!(placed.pages.len(), 1);
        let pg = &placed.pages[0];
        let (pw, ph) = crate::display_paper(&doc.sections[0].page);
        let (ml, mt, bw, bh) = crate::body_box(&doc.sections[0].page);
        assert_eq!(pg.width, pw as f64);
        assert_eq!(pg.height, ph as f64);
        assert!(
            pg.margin_right > 0.0,
            "landscape right guide must stay positive, got {}",
            pg.margin_right
        );
        assert_eq!(pg.margin_left, ml);
        assert_eq!(pg.margin_top, mt);
        assert_eq!(
            pg.margin_left + bw + pg.margin_right,
            pw as f64,
            "left+body_w+right must equal display width"
        );
        assert_eq!(
            pg.margin_top + bh + pg.margin_bottom,
            ph as f64,
            "top+body_h+bottom must equal display height"
        );
    }

    #[test]
    fn header_decoration_paints_in_header_band_without_extra_pages() {
        let mut doc = doc_with(vec![Block::Paragraph(para("본문"))]);
        doc.sections[0].page = PageSetup {
            width: 59528,
            height: 84188,
            margin_left: 2000,
            margin_right: 2000,
            margin_top: 4000,
            margin_bottom: 2000,
            margin_header: 2000,
            margin_footer: 2000,
            ..Default::default()
        };
        doc.sections[0].decorations.push(PageDecoration {
            kind: DecoKind::Header,
            apply: ApplyPage::Both,
            blocks: vec![Block::Paragraph(para("제목표"))],
            from_source: false,
        });
        let placed = place_doc(&doc, &crate::ApproxFontMetrics);
        assert_eq!(placed.pages.len(), 1);
        let header_glyphs: Vec<_> = placed.pages[0]
            .glyphs
            .iter()
            .filter(|g| g.baseline < 6000.0)
            .collect();
        assert!(
            !header_glyphs.is_empty(),
            "header band must contain glyphs, got {:?}",
            placed.pages[0]
                .glyphs
                .iter()
                .map(|g| (g.ch, g.baseline))
                .collect::<Vec<_>>()
        );
        assert!(
            header_glyphs.iter().any(|g| g.ch == '제' || g.ch == '목'),
            "title text must appear in the header band"
        );
    }

    /// PR #46 review: next-section decorations must not paint on the previous section's last page.
    #[test]
    fn later_section_header_does_not_paint_on_prior_section_last_page() {
        fn page() -> PageSetup {
            PageSetup {
                width: 59528,
                height: 84188,
                margin_left: 2000,
                margin_right: 2000,
                margin_top: 4000,
                margin_bottom: 2000,
                margin_header: 2000,
                margin_footer: 2000,
                ..Default::default()
            }
        }
        fn header(text: &str) -> PageDecoration {
            PageDecoration {
                kind: DecoKind::Header,
                apply: ApplyPage::Both,
                blocks: vec![Block::Paragraph(para(text))],
                from_source: false,
            }
        }
        let mut doc = SemanticDoc::default();
        doc.char_shapes.push(CharShape::default());
        doc.para_shapes.push(ParaShape::default());
        let mut first_second = para("본문계속");
        first_second.page_break_before = true;
        doc.sections.push(Section {
            page: page(),
            blocks: vec![
                Block::Paragraph(para("본문하나")),
                Block::Paragraph(first_second),
            ],
            decorations: vec![header("甲머리")],
            ..Default::default()
        });
        doc.sections.push(Section {
            page: page(),
            blocks: vec![Block::Paragraph(para("본문둘"))],
            decorations: vec![header("乙머리")],
            ..Default::default()
        });

        let placed = place_doc(&doc, &crate::ApproxFontMetrics);
        assert_eq!(placed.pages.len(), 3, "2 body pages + 1 next-section page");
        let header_chars = |pg: &PlacedPage| -> String {
            pg.glyphs
                .iter()
                .filter(|g| g.baseline < 6000.0)
                .map(|g| g.ch)
                .collect()
        };
        let last_of_first = header_chars(&placed.pages[1]);
        assert!(
            last_of_first.contains('甲'),
            "section 1 last page must keep its own header, got {last_of_first}"
        );
        assert!(
            !last_of_first.contains('乙'),
            "section 1 last page must not carry section 2 header, got {last_of_first}"
        );
        let first_of_second = header_chars(&placed.pages[2]);
        assert!(
            first_of_second.contains('乙'),
            "section 2 first page must paint its header, got {first_of_second}"
        );
        let naive = crate::NaiveLayout
            .layout(&doc, &crate::ApproxFontMetrics)
            .unwrap();
        assert_eq!(naive.pages.len(), placed.pages.len(), "LOCKSTEP");
    }

    fn title_table(text: &str) -> Table {
        Table {
            rows: 1,
            cols: 1,
            cells: vec![Cell {
                row: 0,
                col: 0,
                blocks: vec![Block::Paragraph(para(text))],
                ..Default::default()
            }],
            col_widths: vec![10_000],
            stored_row_heights: vec![2000],
            row_heights: vec![2000],
            ..Default::default()
        }
    }

    /// #42 / T0: 머리말 **표**가 머리말 밴드에 그려지고 본문 쪽수는 늘지 않는다.
    #[test]
    fn header_table_paints_in_header_band_without_extra_pages() {
        let mut doc = doc_with(vec![Block::Paragraph(para("본문"))]);
        doc.sections[0].page = PageSetup {
            width: 59528,
            height: 84188,
            margin_left: 2000,
            margin_right: 2000,
            margin_top: 4000,
            margin_bottom: 2000,
            margin_header: 2000,
            margin_footer: 2000,
            ..Default::default()
        };
        doc.sections[0].decorations.push(PageDecoration {
            kind: DecoKind::Header,
            apply: ApplyPage::Both,
            blocks: vec![Block::Table(title_table("제목표"))],
            from_source: false,
        });
        let placed = place_doc(&doc, &crate::ApproxFontMetrics);
        assert_eq!(
            placed.pages.len(),
            1,
            "머리말 표는 본문 쪽을 늘리면 안 된다"
        );
        assert!(
            !placed.pages[0].tables.is_empty(),
            "머리말 표가 배치되어야 한다"
        );
        let header_tables: Vec<_> = placed.pages[0]
            .tables
            .iter()
            .filter(|t| t.y < 6000.0)
            .collect();
        assert!(
            !header_tables.is_empty(),
            "표가 머리말 밴드에 있어야 한다, tables={:?}",
            placed.pages[0]
                .tables
                .iter()
                .map(|t| (t.x, t.y, t.w, t.h))
                .collect::<Vec<_>>()
        );
        let naive = crate::NaiveLayout
            .layout(&doc, &crate::ApproxFontMetrics)
            .unwrap();
        assert_eq!(naive.pages.len(), placed.pages.len(), "LOCKSTEP");
    }

    /// #42 / T0: 폼 체크박스 표식은 글리프로 보여야 한다 (rhwp 무관 IR 픽스처).
    #[test]
    fn form_checkbox_marks_paint_as_glyphs() {
        let doc = doc_with(vec![
            Block::Paragraph(para("☐ 공연제작")),
            Block::Paragraph(para("☑ 완료")),
        ]);
        let placed = place_doc(&doc, &crate::ApproxFontMetrics);
        let chars: String = placed.pages[0].glyphs.iter().map(|g| g.ch).collect();
        assert!(chars.contains('☐'), "empty checkbox missing in {chars}");
        assert!(chars.contains('☑'), "checked checkbox missing in {chars}");
        assert!(chars.contains('공'), "caption missing in {chars}");
    }

    /// #42 / T0: 세로 6쪽 + 가로 1쪽 = 7쪽. 머리말 표를 붙여도 7==7, LOCKSTEP.
    #[test]
    fn mixed_orientation_and_header_table_keep_seven_pages() {
        let portrait = PageSetup {
            width: 59528,
            height: 84188,
            landscape: false,
            margin_left: 2000,
            margin_right: 2000,
            margin_top: 4000,
            margin_bottom: 2000,
            margin_header: 2000,
            margin_footer: 2000,
            ..Default::default()
        };
        let landscape = PageSetup {
            width: 59528,
            height: 84188,
            landscape: true,
            ..portrait
        };
        let header = PageDecoration {
            kind: DecoKind::Header,
            apply: ApplyPage::Both,
            blocks: vec![Block::Table(title_table("제목표"))],
            from_source: false,
        };
        let mut doc = SemanticDoc::default();
        doc.char_shapes.push(CharShape::default());
        doc.para_shapes.push(ParaShape::default());
        let portrait_blocks: Vec<Block> = (0..6)
            .map(|i| {
                let mut p = para(&format!("세로{i}"));
                p.page_break_before = i > 0;
                Block::Paragraph(p)
            })
            .collect();
        doc.sections.push(Section {
            page: portrait,
            blocks: portrait_blocks,
            decorations: vec![header.clone()],
            ..Default::default()
        });
        doc.sections.push(Section {
            page: landscape,
            blocks: vec![Block::Paragraph(para("가로"))],
            decorations: vec![header],
            ..Default::default()
        });

        let placed = place_doc(&doc, &crate::ApproxFontMetrics);
        assert_eq!(placed.pages.len(), 7, "7==7 body pages");
        assert!(
            placed.pages[0].height > placed.pages[0].width,
            "first pages stay portrait"
        );
        assert!(
            placed.pages[6].width > placed.pages[6].height,
            "last page must swap to landscape, got {}×{}",
            placed.pages[6].width,
            placed.pages[6].height
        );
        assert!(
            placed
                .pages
                .iter()
                .all(|p| p.tables.iter().any(|t| t.y < 6000.0)),
            "every page should paint the header table"
        );
        let naive = crate::NaiveLayout
            .layout(&doc, &crate::ApproxFontMetrics)
            .unwrap();
        assert_eq!(naive.pages.len(), 7, "LOCKSTEP 7==7");
        assert_eq!(naive.pages[6].width, placed.pages[6].width);
        assert_eq!(naive.pages[6].height, placed.pages[6].height);
    }

    fn one_cell_table(margin: i32) -> Table {
        Table {
            rows: 1,
            cols: 1,
            cells: vec![Cell {
                row: 0,
                col: 0,
                blocks: vec![Block::Paragraph(para("가"))],
                ..Default::default()
            }],
            col_widths: vec![1],
            outer_margin_top: margin,
            outer_margin_bottom: margin,
            ..Default::default()
        }
    }

    fn bottom_table_y(margin: i32) -> f64 {
        let doc = doc_with(vec![
            Block::Table(one_cell_table(margin)),
            Block::Table(one_cell_table(margin)),
        ]);
        let placed = place_doc(&doc, &ApproxFontMetrics);
        // The bottom-most rect's y is the 2nd table's border top.
        placed.pages[0]
            .rects
            .iter()
            .map(|r| r.y)
            .fold(0.0, f64::max)
    }

    /// 이슈 074 회귀: 행마다 열 경계가 다른(ragged) 표는 **저장된 셀 실폭**으로 눕힌다.
    /// 열 격자 근사를 쓰면 r1 의 두 칸이 5:5 로 잘려 실폭(8:2)과 어긋나고, 좁아진 칸의 글이
    /// 두 배로 줄바꿈돼 행이 부푼다.
    #[test]
    fn ragged_rows_use_stored_cell_widths() {
        let mut t = Table {
            rows: 2,
            cols: 2,
            col_widths: vec![5000, 5000], // 격자 근사: 5:5
            ..Default::default()
        };
        // r0 은 격자와 같은 5:5, r1 은 실제로 8:2 (한글 표는 이런 게 흔하다).
        for (row, (w0, w1)) in [(0usize, (5000, 5000)), (1, (8000, 2000))] {
            t.cells.push(Cell {
                row,
                col: 0,
                blocks: vec![Block::Paragraph(para("가"))],
                width: Some(w0),
                ..Default::default()
            });
            t.cells.push(Cell {
                row,
                col: 1,
                blocks: vec![Block::Paragraph(para("나"))],
                width: Some(w1),
                ..Default::default()
            });
        }
        let boxes = cell_boxes(&t, 10000.0).expect("모든 셀에 실폭이 있으면 상자를 만든다");
        let xs = column_offsets(&t, 10000.0);
        // r1 의 첫 칸은 8000, 둘째 칸은 2000 이어야 한다(격자였다면 둘 다 5000).
        let boxes = Some(boxes);
        assert_eq!(cell_box_at(&t, &boxes, &xs, 2).1, 8000.0);
        assert_eq!(cell_box_at(&t, &boxes, &xs, 3), (8000.0, 2000.0));
        // 실폭이 하나라도 없으면 격자로 되돌아간다(합성/삽입 셀 안전망).
        let mut partial = t.clone();
        partial.cells[3].width = None;
        assert!(cell_boxes(&partial, 10000.0).is_none());
        let xs2 = column_offsets(&partial, 10000.0);
        assert_eq!(cell_box_at(&partial, &None, &xs2, 3), (5000.0, 5000.0));

        // 사용자가 열 너비를 드래그해 바꿨으면(`SetTableColWidths` → geometry_edited) **격자가 진실**이다.
        // 파싱 당시의 셀 실폭을 계속 쓰면 열 경계 드래그가 화면에 반영되지 않는다(031 무반영 버그).
        let mut resized = t.clone();
        resized.geometry_edited = true;
        resized.col_widths = vec![7000, 3000]; // 드래그 결과 = 7:3
        assert!(
            cell_boxes(&resized, 10000.0).is_none(),
            "편집된 표는 격자를 쓴다"
        );
        let xs3 = column_offsets(&resized, 10000.0);
        assert_eq!(cell_box_at(&resized, &None, &xs3, 0), (0.0, 7000.0));
        assert_eq!(cell_box_at(&resized, &None, &xs3, 1), (7000.0, 3000.0));
    }

    #[test]
    fn block_pages_agrees_with_place_doc_pagination() {
        // Two paragraphs + a table; block_pages must give one page index per block, all within the
        // page count place_doc produces, monotonically non-decreasing in reading order.
        let mut t = Table {
            rows: 1,
            cols: 1,
            col_widths: vec![1],
            ..Default::default()
        };
        t.cells.push(Cell {
            row: 0,
            col: 0,
            blocks: vec![Block::Paragraph(para("셀"))],
            ..Default::default()
        });
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
        assert!(
            bp[0].iter().all(|&p| p < npages),
            "every block page index is in range: {bp:?} of {npages}"
        );
        assert!(
            bp[0].windows(2).all(|w| w[0] <= w[1]),
            "block pages are non-decreasing in reading order"
        );
        // The last block's start page never exceeds the last page.
        assert_eq!(
            *bp[0].iter().max().unwrap(),
            npages - 1,
            "content reaches the last page"
        );
    }

    #[test]
    fn old_hangul_pua_is_full_width_and_draws_jamo_cluster() {
        use crate::layout_paragraph;
        // Empty doc just to supply char_shape[0]/para_shape[0] that `para()` references.
        let doc = doc_with(vec![]);
        // U+E1A7 (Hanyang-PUA 옛한글) → 첫가끝 ᄀᆞ (U+1100 U+119E) per the KTUG Public-Domain table.
        let p_old = para("\u{E1A7}나");
        let p_ref = para("가나");

        // (1) Drawing: the PUA char becomes the full-width metric proxy '가' carrying the jamo cluster;
        //     the following ordinary char is untouched (no cluster).
        let g = paragraph_glyphs(&p_old, &doc, &crate::ApproxFontMetrics);
        assert_eq!(g.len(), 2);
        assert_eq!(
            g[0].ch, '\u{AC00}',
            "ch is the metric proxy, not the raw PUA codepoint"
        );
        assert_eq!(
            g[0].cluster.as_deref(),
            Some("\u{1100}\u{119E}"),
            "draws the 첫가끝 자모 시퀀스"
        );
        assert_eq!(g[1].ch, '나');
        assert!(g[1].cluster.is_none(), "ordinary glyph carries no cluster");

        // (2) Lockstep width: an old-hangul syllable measures as ONE full-width cell, so a line with
        //     it is exactly as wide as the same line with a plain Hangul syllable — the gate-relevant
        //     advance is unchanged for a full-width cell.
        let w_old = layout_paragraph(&p_old, &doc, 1.0e9, &ApproxFontMetrics)[0].horz_size;
        let w_ref = layout_paragraph(&p_ref, &doc, 1.0e9, &ApproxFontMetrics)[0].horz_size;
        assert_eq!(w_old, w_ref, "옛한글 음절 = 전각 한 칸 (advance lockstep)");
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
            .map(|r| Cell {
                row: r,
                col: 0,
                blocks: vec![Block::Paragraph(para("행"))],
                ..Default::default()
            })
            .collect();
        Table {
            rows: n,
            cols: 1,
            cells,
            col_widths: vec![1],
            ..Default::default()
        }
    }

    fn fixed_height_table(rows: usize, row_height: HwpUnit, keep_together: bool) -> Table {
        let mut table = n_row_table(rows);
        table.row_heights = vec![row_height; rows];
        table.fixed_row_heights = true;
        table.keep_together = keep_together;
        table
    }

    fn captioned_table(position: TableCaptionPosition, keep_together: bool) -> Table {
        let mut table = fixed_height_table(1, 3000, keep_together);
        table.caption = Some(TableCaption {
            position,
            blocks: vec![Block::Paragraph(para("캡션"))],
            spacing: 500,
            max_width: 48_000,
            ..Default::default()
        });
        table
    }

    #[test]
    fn top_and_bottom_captions_paint_on_the_expected_side_in_lockstep() {
        use crate::LayoutEngine;

        for (position, expect_top) in [
            (TableCaptionPosition::Top, true),
            (TableCaptionPosition::Bottom, false),
        ] {
            let doc = doc_with_page(vec![Block::Table(captioned_table(position, false))], 20_000);
            let placed = place_doc(&doc, &ApproxFontMetrics);
            let naive = crate::NaiveLayout
                .layout(&doc, &ApproxFontMetrics)
                .expect("caption layout");
            assert_eq!(
                placed.pages.len(),
                naive.pages.len(),
                "LOCKSTEP {position:?}"
            );
            assert_eq!(block_pages(&doc, &ApproxFontMetrics)[0][0], 0);

            let table = placed.pages[0].tables.first().expect("placed table");
            let caption_baseline = placed.pages[0]
                .glyphs
                .iter()
                .find(|glyph| glyph.ch == '캡')
                .expect("caption glyph")
                .baseline;
            if expect_top {
                assert!(caption_baseline < table.y, "top caption must precede table");
                assert!(
                    table.y - caption_baseline >= 500.0,
                    "stored caption gap must separate caption and table"
                );
            } else {
                assert!(
                    caption_baseline > table.y + table.h,
                    "bottom caption must follow table"
                );
                assert!(
                    caption_baseline - (table.y + table.h) >= 500.0,
                    "stored caption gap must separate table and caption"
                );
            }
        }
    }

    #[test]
    fn column_flow_honors_caption_max_width_for_centered_glyphs() {
        use crate::LayoutEngine;

        let plain_lead = para("");
        let mut column_lead = plain_lead.clone();
        column_lead.column_layout_before = Some(ColumnLayout {
            widths: vec![60_000],
            gaps: vec![],
            ..ColumnLayout::default()
        });
        let table = captioned_table(TableCaptionPosition::Top, false);
        let mut uncapped_table = table.clone();
        uncapped_table
            .caption
            .as_mut()
            .expect("synthetic caption")
            .max_width = 0;
        let mut plain = doc_with_page(
            vec![Block::Paragraph(plain_lead), Block::Table(table.clone())],
            20_000,
        );
        let mut column = doc_with_page(
            vec![Block::Paragraph(column_lead), Block::Table(table)],
            20_000,
        );
        let mut uncapped_column = column.clone();
        uncapped_column.sections[0].blocks[1] = Block::Table(uncapped_table);
        plain.para_shapes[0].align = HorizontalAlign::Center;
        column.para_shapes[0].align = HorizontalAlign::Center;
        uncapped_column.para_shapes[0].align = HorizontalAlign::Center;

        let plain_placed = place_doc(&plain, &ApproxFontMetrics);
        let column_placed = place_doc(&column, &ApproxFontMetrics);
        let uncapped_placed = place_doc(&uncapped_column, &ApproxFontMetrics);
        let first_caption_x = |placed: &PlacedDoc| {
            placed
                .pages
                .iter()
                .flat_map(|page| &page.glyphs)
                .find(|glyph| glyph.ch == '캡')
                .expect("synthetic caption glyph")
                .x
        };
        assert_eq!(
            first_caption_x(&plain_placed).to_bits(),
            first_caption_x(&column_placed).to_bits(),
            "an explicit one-column zone must not discard caption.max_width"
        );
        assert_eq!(
            first_caption_x(&uncapped_placed) - first_caption_x(&column_placed),
            (60_000.0 - 48_000.0) / 2.0,
            "centered caption offset is half the body/max-width discriminator"
        );
        assert_eq!(plain_placed.pages.len(), column_placed.pages.len());
        assert_eq!(
            crate::NaiveLayout
                .layout(&column, &ApproxFontMetrics)
                .unwrap()
                .pages
                .len(),
            column_placed.pages.len(),
            "LOCKSTEP"
        );
    }

    #[test]
    fn keep_together_moves_caption_and_table_as_one_without_blank_loop() {
        use crate::LayoutEngine;

        let doc = doc_with_page(
            vec![
                Block::Table(fixed_height_table(1, 4_000, false)),
                Block::Table(captioned_table(TableCaptionPosition::Top, true)),
            ],
            8_000,
        );
        let placed = place_doc(&doc, &ApproxFontMetrics);
        let naive = crate::NaiveLayout
            .layout(&doc, &ApproxFontMetrics)
            .expect("caption layout");
        assert_eq!(placed.pages.len(), naive.pages.len(), "LOCKSTEP");
        assert_eq!(placed.pages.len(), 2, "one bounded advance");
        assert!(
            placed.pages[1].glyphs.iter().any(|glyph| glyph.ch == '캡'),
            "caption advances with its table"
        );
        assert_eq!(placed.pages[1].tables.len(), 1, "table follows caption");
        assert_eq!(block_pages(&doc, &ApproxFontMetrics)[0], vec![0, 1]);

        let mut over_tall = captioned_table(TableCaptionPosition::Top, true);
        over_tall.row_heights = vec![10_000];
        let hostile = doc_with_page(vec![Block::Table(over_tall)], 5_000);
        let hostile_placed = place_doc(&hostile, &ApproxFontMetrics);
        let hostile_naive = crate::NaiveLayout
            .layout(&hostile, &ApproxFontMetrics)
            .expect("bounded hostile caption layout");
        assert_eq!(hostile_placed.pages.len(), hostile_naive.pages.len());
        assert_eq!(hostile_placed.pages.len(), 1, "no blank-page loop");
    }

    /// 이슈 080 — 표 호스트 앵커에 걸린 `<hp:p pageBreak="1">` 은 **표 앞**에서 쪽을 넘겨야 한다.
    /// 우리 HWPX 블록 순서는 왕복 해자 때문에 `[Table, 앵커]` 라, 앵커 자리에서 실행하면 쪽이 표
    /// **뒤**에서 넘어간다(표만 이전 쪽에 남는다). 판정은 세 조판 경로가 공유하는
    /// [`crate::section_page_breaks`] 하나뿐이므로 LOCKSTEP 도 여기서 함께 잠근다.
    #[test]
    fn anchor_page_break_hoists_to_its_table_in_all_three_paginators() {
        use crate::LayoutEngine;
        // 앵커의 `<hp:p>` 스팬(100..900)이 표의 `<hp:tbl>` 스팬(200..800)을 감싼다 = 그 표의 주인.
        let mut t = n_row_table(2);
        t.src_span = Some((200, 800));
        let anchor = Paragraph {
            is_table_anchor: true,
            page_break_before: true,
            source: Some(ParaSource {
                span: (100, 900),
                ..Default::default()
            }),
            ..Default::default()
        };
        let doc = doc_with_page(
            vec![
                Block::Paragraph(para("앞 문단")),
                Block::Table(t),
                Block::Paragraph(anchor),
            ],
            800_000, // 아주 긴 쪽 — 흐름 때문에 넘어갈 일은 없다(강제 개쪽만 검증).
        );
        assert_eq!(
            crate::section_page_breaks(&doc.sections[0], &doc),
            vec![false, true, false],
            "break 는 앵커(2번)가 아니라 그 표(1번) 앞에 선다"
        );
        // ① block_pages
        assert_eq!(
            block_pages(&doc, &ApproxFontMetrics)[0],
            vec![0, 1, 1],
            "표와 앵커가 2쪽으로 함께 넘어간다"
        );
        // ② place_doc — 표는 2쪽에만 그려진다.
        let placed = place_doc(&doc, &ApproxFontMetrics);
        assert_eq!(placed.pages.len(), 2);
        assert!(placed.pages[0].tables.is_empty(), "1쪽에는 표가 없다");
        assert!(!placed.pages[1].tables.is_empty(), "표는 2쪽 맨 위");
        // ③ NaiveLayout(오라클) — 쪽수 LOCKSTEP.
        assert_eq!(
            crate::NaiveLayout
                .layout(&doc, &ApproxFontMetrics)
                .unwrap()
                .pages
                .len(),
            2
        );
    }

    /// 같은 플래그라도 **.hwp lift 순서**(`[앵커, Table]`)에서는 끌어올릴 것이 없다 — 앵커가
    /// 이미 표 앞이라 제자리에서 실행해야 한다. 소스 스팬이 없으면(lift/합성) 판정은 그대로 false.
    #[test]
    fn lift_order_anchor_keeps_its_break_in_place() {
        let anchor = Paragraph {
            is_table_anchor: true,
            page_break_before: true,
            ..Default::default()
        };
        let doc = doc_with_page(
            vec![
                Block::Paragraph(para("앞 문단")),
                Block::Paragraph(anchor),
                Block::Table(n_row_table(2)),
            ],
            800_000,
        );
        assert_eq!(
            crate::section_page_breaks(&doc.sections[0], &doc),
            vec![false, true, false],
            "lift 순서에서는 앵커 자리가 곧 표 앞이다"
        );
        assert_eq!(block_pages(&doc, &ApproxFontMetrics)[0], vec![0, 1, 1]);
    }

    /// 이슈 080 — `<hp:tbl noAdjust="1">`(자동 맞춤 안 함) 표의 저장 행 높이는 **정확값**이다.
    /// 바닥으로만 쓰면 우리 내용맞춤 높이가 이겨 표가 부풀고 쪽이 일찍 넘어간다.
    #[test]
    fn fixed_row_height_is_exact_not_a_floor() {
        let placed_h = |t: Table| -> f64 {
            let doc = doc_with_page(vec![Block::Table(t)], 800_000);
            place_doc(&doc, &ApproxFontMetrics).pages[0]
                .tables
                .first()
                .expect("표")
                .h
        };
        let mut t = n_row_table(1);
        // 한 줄짜리 저장 높이보다 확실히 큰 내용(5문단)을 넣는다.
        t.cells[0].blocks = (0..5).map(|_| Block::Paragraph(para("행"))).collect();
        t.row_heights = vec![500];
        let content_h = placed_h(t.clone());
        assert!(
            content_h > 500.0,
            "자동 맞춤(기본)은 저장 높이를 바닥으로만 쓴다 — 내용이 이긴다: {content_h}"
        );
        t.fixed_row_heights = true;
        assert_eq!(
            placed_h(t),
            500.0,
            "noAdjust=1 은 저장 높이가 정확값 — 넘치는 내용은 한컴처럼 잘린다"
        );
    }

    #[test]
    fn table_anchor_paragraph_reserves_no_height() {
        use crate::LayoutEngine;
        // A pure table-anchor paragraph (empty, is_table_anchor) reserves NO vertical space: the table
        // starts at the page top, exactly as if the anchor weren't there. A normal empty paragraph would
        // push the table down by one line. Regression for the benchmark1 phantom-anchor over-reservation.
        let anchor = Paragraph {
            is_table_anchor: true,
            ..Default::default()
        };
        let doc = doc_with_page(
            vec![Block::Paragraph(anchor), Block::Table(n_row_table(2))],
            800_000,
        );
        let placed = place_doc(&doc, &ApproxFontMetrics);
        let t = placed.pages[0]
            .tables
            .first()
            .expect("table placed on page 0");
        assert!(
            (t.y - 0.0).abs() < 1.0,
            "anchor reserves no line → table top at page-top (mt=0), got {}",
            t.y
        );
        // Lockstep with the oracle.
        let naive = crate::NaiveLayout
            .layout(&doc, &ApproxFontMetrics)
            .unwrap()
            .pages
            .len();
        assert_eq!(
            placed.pages.len(),
            naive,
            "place_doc {} == NaiveLayout {naive}",
            placed.pages.len()
        );
    }

    #[test]
    fn frame_wrapper_table_unwraps_and_splits_at_row_granularity() {
        use crate::LayoutEngine;
        // 자가진단표 regression: a 1×1 table whose only cell wraps a 20-row nested table, preceded by a
        // heading paragraph (vert>0). The nested grid must be PROMOTED and SPLIT at row boundaries
        // (flowing from the heading's page) — NOT bumped whole to the next page as one atomic 1×1 row.
        let frame = CellEdge {
            color: Color {
                r: 0,
                g: 0,
                b: 0,
                a: 255,
            },
            style: LineStyle::Solid,
            width_px: 2.0,
        };
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
        let doc = doc_with_page(
            vec![Block::Paragraph(para("Ⅰ. 자가진단표")), Block::Table(outer)],
            8000,
        );
        let placed = place_doc(&doc, &ApproxFontMetrics);
        // Promoted + split: ≥2 row fragments (the atomic 1×1 outer would have yielded exactly one).
        let frags: Vec<&PlacedTable> = placed.pages.iter().flat_map(|p| p.tables.iter()).collect();
        assert!(
            frags.len() >= 2,
            "frame wrapper splits into ≥2 row fragments, got {}",
            frags.len()
        );
        // Promoted to the inner 20×1, not the 1×1 outer.
        assert_eq!(
            frags[0].rows, 20,
            "fragments are keyed to the promoted inner table (20 rows)"
        );
        // Flows from the heading's page (page 0), not bumped to a fresh page.
        assert!(
            !placed.pages[0].tables.is_empty(),
            "the grid starts on the heading's page"
        );
        // The outer frame is redrawn on the first fragment's page (a stroked box continues across the split).
        assert!(
            !placed.pages[0].lines.is_empty(),
            "the frame box draws on the first fragment"
        );
        // Lockstep with the oracle.
        let naive = crate::NaiveLayout
            .layout(&doc, &ApproxFontMetrics)
            .unwrap()
            .pages
            .len();
        assert_eq!(
            placed.pages.len(),
            naive,
            "place_doc {} == NaiveLayout {naive}",
            placed.pages.len()
        );
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
    fn text_only_cell_row_taller_than_page_continues_without_duplicate_glyphs() {
        use crate::LayoutEngine;

        let mut table = n_row_table(2);
        table.split_over_tall_cells = true;
        table.cells[1].blocks = vec![Block::Paragraph(para(
            "가\n나\n다\n라\n마\n바\n사\n아\n자\n차\n카\n타",
        ))];
        let doc = doc_with_page(vec![Block::Table(table.clone())], 5_000);
        let placed = place_doc(&doc, &ApproxFontMetrics);
        let naive = crate::NaiveLayout
            .layout(&doc, &ApproxFontMetrics)
            .expect("continued cell layout");
        assert_eq!(placed.pages.len(), naive.pages.len(), "LOCKSTEP");
        assert!(placed.pages.len() >= 3, "one over-tall row must continue");
        assert_eq!(
            placed
                .pages
                .iter()
                .flat_map(|page| &page.glyphs)
                .filter(|glyph| glyph.ch != '행')
                .count(),
            12,
            "each continued cell glyph is painted exactly once"
        );
        assert_eq!(block_pages(&doc, &ApproxFontMetrics)[0], vec![0]);

        table.cells[1].source_page_segments = 5;
        assert_eq!(
            crate::over_tall_cell_fragments(&table, 1, 12_000.0, 4_000.0, 5_000.0)
                .expect("stored clean continuation lower bound")
                .len(),
            5,
            "clean HWPX lineseg resets preserve a content-free minimum fragment count"
        );
        table.geometry_edited = true;
        assert_eq!(
            crate::over_tall_cell_fragments(&table, 1, 12_000.0, 4_000.0, 5_000.0)
                .expect("edited geometry falls back to measured continuation")
                .len(),
            3,
            "stale source segment caches cannot constrain an edited table"
        );
        table.geometry_edited = false;
        table.cells[1].source_page_segments = 257;
        assert_eq!(
            crate::over_tall_cell_fragments(&table, 1, 12_000.0, 4_000.0, 5_000.0)
                .expect("oversize untrusted cache falls back to measurement")
                .len(),
            3,
            "hostile lineseg reset counts cannot manufacture unbounded pages"
        );
        table.cells[1].source_page_segments = 5;
        table.repeat_first_row = true;
        let source_locked = doc_with_page(vec![Block::Table(table.clone())], 5_000);
        let source_placed = place_doc(&source_locked, &ApproxFontMetrics);
        assert!(source_placed.pages.len() >= 5);
        assert_eq!(
            source_placed
                .pages
                .iter()
                .flat_map(|page| &page.glyphs)
                .filter(|glyph| glyph.ch == '행')
                .count(),
            source_placed.pages.len(),
            "the first row is repeated once per continued page"
        );
        assert_eq!(
            source_placed
                .pages
                .iter()
                .flat_map(|page| &page.glyphs)
                .filter(|glyph| glyph.ch != '행')
                .count(),
            12,
            "source fragment lower bounds cannot duplicate or lose body glyphs"
        );
        assert_eq!(
            crate::NaiveLayout
                .layout(&source_locked, &ApproxFontMetrics)
                .unwrap()
                .pages
                .len(),
            source_placed.pages.len(),
            "source-fragment continuation remains LOCKSTEP"
        );

        table.split_over_tall_cells = false;
        let legacy = doc_with_page(vec![Block::Table(table)], 5_000);
        assert_eq!(place_doc(&legacy, &ApproxFontMetrics).pages.len(), 1);
        assert_eq!(
            crate::NaiveLayout
                .layout(&legacy, &ApproxFontMetrics)
                .unwrap()
                .pages
                .len(),
            1,
            "pageBreak=NONE remains bounded legacy overflow"
        );
    }

    #[test]
    fn keep_together_fits_current_page_without_advancing() {
        use crate::LayoutEngine;

        let table = fixed_height_table(2, 2_000, true);
        let doc = doc_with_page(
            vec![Block::Paragraph(para("앞")), Block::Table(table)],
            6_000,
        );
        let placed = place_doc(&doc, &ApproxFontMetrics);
        let fragments = placed.pages[0].tables.iter().collect::<Vec<_>>();
        assert_eq!(placed.pages.len(), 1);
        assert_eq!(fragments.len(), 1);
        assert_eq!((fragments[0].first_row, fragments[0].last_row), (0, 2));
        assert_eq!(
            crate::NaiveLayout
                .layout(&doc, &ApproxFontMetrics)
                .unwrap()
                .pages
                .len(),
            1
        );
        assert_eq!(block_pages(&doc, &ApproxFontMetrics)[0], vec![0, 0]);
    }

    #[test]
    fn keep_together_moves_whole_table_in_all_three_paginators() {
        use crate::LayoutEngine;

        let table = fixed_height_table(2, 2_700, true);
        let doc = doc_with_page(
            vec![Block::Paragraph(para("앞")), Block::Table(table)],
            6_000,
        );
        let placed = place_doc(&doc, &ApproxFontMetrics);
        assert_eq!(placed.pages.len(), 2);
        assert!(placed.pages[0].tables.is_empty());
        assert_eq!(placed.pages[1].tables.len(), 1);
        assert_eq!(
            (
                placed.pages[1].tables[0].first_row,
                placed.pages[1].tables[0].last_row
            ),
            (0, 2)
        );
        assert_eq!(
            crate::NaiveLayout
                .layout(&doc, &ApproxFontMetrics)
                .unwrap()
                .pages
                .len(),
            2
        );
        assert_eq!(block_pages(&doc, &ApproxFontMetrics)[0], vec![0, 1]);
    }

    #[test]
    fn keep_together_over_tall_table_keeps_row_fragment_fallback() {
        use crate::LayoutEngine;

        let table = fixed_height_table(3, 3_000, true);
        let doc = doc_with_page(
            vec![Block::Paragraph(para("앞")), Block::Table(table)],
            6_000,
        );
        let placed = place_doc(&doc, &ApproxFontMetrics);
        assert!(
            !placed.pages[0].tables.is_empty(),
            "over-tall keep-together table must not waste the current page"
        );
        let fragments = placed
            .pages
            .iter()
            .flat_map(|page| &page.tables)
            .collect::<Vec<_>>();
        assert!(fragments.len() >= 2);
        assert_eq!(fragments.first().unwrap().first_row, 0);
        assert_eq!(fragments.last().unwrap().last_row, 3);
        assert_eq!(
            crate::NaiveLayout
                .layout(&doc, &ApproxFontMetrics)
                .unwrap()
                .pages
                .len(),
            placed.pages.len()
        );
        assert_eq!(block_pages(&doc, &ApproxFontMetrics)[0][1], 0);
    }

    #[test]
    fn default_table_retains_row_fragmentation() {
        let table = fixed_height_table(2, 2_700, false);
        let doc = doc_with_page(
            vec![Block::Paragraph(para("앞")), Block::Table(table)],
            6_000,
        );
        let placed = place_doc(&doc, &ApproxFontMetrics);
        assert!(!placed.pages[0].tables.is_empty());
        assert!(!placed.pages[1].tables.is_empty());
        assert_eq!(placed.pages[0].tables[0].first_row, 0);
        assert_eq!(placed.pages[0].tables[0].last_row, 1);
    }

    #[test]
    fn keep_together_advances_to_fresh_column_in_lockstep() {
        use crate::LayoutEngine;

        let mut first = para("앞");
        first.column_layout_before = Some(ColumnLayout {
            widths: vec![2_500, 2_500],
            gaps: vec![0],
            ..ColumnLayout::default()
        });
        let mut table = fixed_height_table(2, 2_700, true);
        table.col_widths = vec![2_500];
        let doc = doc_with_page(vec![Block::Paragraph(first), Block::Table(table)], 6_000);
        let placed = place_doc(&doc, &ApproxFontMetrics);
        assert_eq!(placed.pages.len(), 1);
        assert_eq!(placed.pages[0].tables.len(), 1);
        let fragment = &placed.pages[0].tables[0];
        assert!(fragment.x >= 2_500.0, "table begins in the second column");
        assert_eq!((fragment.first_row, fragment.last_row), (0, 2));
        assert_eq!(
            crate::NaiveLayout
                .layout(&doc, &ApproxFontMetrics)
                .unwrap()
                .pages
                .len(),
            1
        );
        assert_eq!(block_pages(&doc, &ApproxFontMetrics)[0], vec![0, 0]);
    }

    #[test]
    fn keep_together_over_tall_column_table_fragments_without_blank_lane() {
        use crate::LayoutEngine;

        let mut first = para("앞");
        first.column_layout_before = Some(ColumnLayout {
            widths: vec![2_500, 2_500],
            gaps: vec![0],
            ..ColumnLayout::default()
        });
        let mut table = fixed_height_table(3, 3_000, true);
        table.col_widths = vec![2_500];
        let doc = doc_with_page(vec![Block::Paragraph(first), Block::Table(table)], 6_000);
        let placed = place_doc(&doc, &ApproxFontMetrics);
        assert_eq!(placed.pages.len(), 1);
        assert!(placed.pages[0].tables.len() >= 2);
        assert!(
            placed.pages[0].tables[0].x < 2_500.0,
            "over-tall table begins in the current column instead of wasting it"
        );
        assert_eq!(placed.pages[0].tables.first().unwrap().first_row, 0);
        assert_eq!(placed.pages[0].tables.last().unwrap().last_row, 3);
        assert_eq!(
            crate::NaiveLayout
                .layout(&doc, &ApproxFontMetrics)
                .unwrap()
                .pages
                .len(),
            1
        );
        assert_eq!(block_pages(&doc, &ApproxFontMetrics)[0], vec![0, 0]);
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
        assert!(
            frags.len() >= 2,
            "a too-tall table splits into ≥2 fragments, got {}",
            frags.len()
        );
        // Contiguous, gap-free row coverage 0..rows, one page step per fragment.
        assert_eq!(frags.first().unwrap().1.first_row, 0, "starts at row 0");
        assert_eq!(
            frags.last().unwrap().1.last_row,
            rows,
            "ends at the last row"
        );
        for w in frags.windows(2) {
            assert_eq!(
                w[0].1.last_row, w[1].1.first_row,
                "fragments are row-contiguous (no gap/overlap)"
            );
            assert!(w[1].0 > w[0].0, "each fragment is on a later page");
            assert!(w[0].1.last_row > w[0].1.first_row, "no empty fragment");
        }
        // Fragment heights sum to the whole-table height (the reservation invariant).
        let body_w = 60000.0;
        let total_h: f64 = frags.iter().map(|(_, pt)| pt.h).sum();
        let table_h = crate::table_height(&n_row_table(rows), body_w, &doc, &ApproxFontMetrics);
        assert!(
            (total_h - table_h).abs() < 1.0,
            "fragment heights sum to table_height: {total_h} vs {table_h}"
        );
        // Every row's cell is placed in exactly one fragment (later-page rows stay clickable).
        let mut seen_rows: Vec<usize> = placed
            .pages
            .iter()
            .flat_map(|p| p.tables.iter())
            .flat_map(|t| t.cells.iter().map(|c| c.row))
            .collect();
        seen_rows.sort_unstable();
        seen_rows.dedup();
        assert_eq!(
            seen_rows,
            (0..rows).collect::<Vec<_>>(),
            "all rows have a placed cell across the fragments"
        );
        // place_doc's page count agrees with the oracle's NaiveLayout accounting (lockstep → oracle-safe).
        let naive = crate::NaiveLayout
            .layout(&doc, &ApproxFontMetrics)
            .unwrap()
            .pages
            .len();
        assert_eq!(
            placed.pages.len(),
            naive,
            "own-render pages == NaiveLayout pages (kept in lockstep)"
        );
    }

    #[test]
    fn over_tall_row_keeps_place_doc_and_naive_in_lockstep() {
        use crate::LayoutEngine;
        // A single row TALLER than the page body must NOT re-fragment in place_doc while NaiveLayout
        // leaves it whole (the over-tall row draws + clips; a following block breaks). Regression for the
        // page-drift blocker (place_doc 13 vs NaiveLayout 1).
        let tall = (0..40)
            .map(|_| Block::Paragraph(para("긴 내용")))
            .collect::<Vec<_>>();
        let t = Table {
            rows: 1,
            cols: 1,
            col_widths: vec![1],
            cells: vec![Cell {
                row: 0,
                col: 0,
                blocks: tall,
                ..Default::default()
            }],
            ..Default::default()
        };
        let doc = doc_with_page(vec![Block::Table(t)], 5000);
        let placed = place_doc(&doc, &ApproxFontMetrics).pages.len();
        let naive = crate::NaiveLayout
            .layout(&doc, &ApproxFontMetrics)
            .unwrap()
            .pages
            .len();
        assert_eq!(
            placed, naive,
            "over-tall row: place_doc {placed} == NaiveLayout {naive} (no re-fragment drift)"
        );
    }

    #[test]
    fn over_tall_table_after_heading_stays_on_the_heading_page() {
        use crate::LayoutEngine;
        // 자가진단표 regression: a heading paragraph (vert>0) followed by a 1×1 table whose single row is
        // TALLER than the body. The first-row reserve must NOT bump it to a fresh page (that left the
        // heading's page blank below the heading); the over-tall row draws on the heading's page instead.
        let tall = (0..40)
            .map(|_| Block::Paragraph(para("자가진단 항목 내용")))
            .collect::<Vec<_>>();
        let t = Table {
            rows: 1,
            cols: 1,
            col_widths: vec![1],
            cells: vec![Cell {
                row: 0,
                col: 0,
                blocks: tall,
                ..Default::default()
            }],
            ..Default::default()
        };
        let doc = doc_with_page(
            vec![Block::Paragraph(para("Ⅰ. 자가진단표")), Block::Table(t)],
            5000,
        );
        let placed = place_doc(&doc, &ApproxFontMetrics);
        // The table fragment must land on page 0 — the same page as the heading (no blank-page bump).
        let table_page = placed.pages.iter().position(|p| !p.tables.is_empty());
        assert_eq!(
            table_page,
            Some(0),
            "over-tall table starts on the heading's page, not a fresh one"
        );
        // …and the two layout paths still agree (lockstep → oracle-safe).
        let naive = crate::NaiveLayout
            .layout(&doc, &ApproxFontMetrics)
            .unwrap()
            .pages
            .len();
        assert_eq!(
            placed.pages.len(),
            naive,
            "place_doc {} == NaiveLayout {naive}",
            placed.pages.len()
        );
    }

    #[test]
    fn table_outer_margins_keep_place_doc_and_naive_in_lockstep() {
        use crate::LayoutEngine;
        // A multi-page table carrying outer margins, preceded by a paragraph (so vert>0) — the margins
        // must be accounted IDENTICALLY in both paths. Regression for the margin page-drift (9 vs 8).
        let mut tbl = n_row_table(15);
        tbl.outer_margin_top = 2000;
        tbl.outer_margin_bottom = 2000;
        let doc = doc_with_page(
            vec![Block::Paragraph(para("앞 문단")), Block::Table(tbl)],
            5000,
        );
        let placed = place_doc(&doc, &ApproxFontMetrics).pages.len();
        let naive = crate::NaiveLayout
            .layout(&doc, &ApproxFontMetrics)
            .unwrap()
            .pages
            .len();
        assert_eq!(
            placed, naive,
            "table outer margins: place_doc {placed} == NaiveLayout {naive}"
        );
    }

    #[test]
    fn consecutive_tables_get_an_outer_margin_gap() {
        // Outer margins (바깥 여백) must push the 2nd table down so back-to-back tables don't abut.
        // With 500-unit top+bottom margins the gap adds ~1000 HWPUNIT vs no margins.
        let with = bottom_table_y(500);
        let without = bottom_table_y(0);
        assert!(
            with > without + 900.0,
            "outer margins separate consecutive tables: {with} vs {without}"
        );
    }

    fn table_with_margins(top: i32, bottom: i32) -> Table {
        let mut table = one_cell_table(0);
        table.outer_margin_top = top;
        table.outer_margin_bottom = bottom;
        table
    }

    fn top_level_table_tops(doc: &SemanticDoc) -> Vec<(f64, f64)> {
        place_doc(doc, &ApproxFontMetrics).pages[0]
            .tables
            .iter()
            .filter(|table| table.ancestors.is_empty())
            .map(|table| (table.y, table.h))
            .collect()
    }

    #[test]
    fn consecutive_table_gap_is_exact_bottom_plus_top_margin() {
        use crate::LayoutEngine;

        for (first_bottom, second_top) in [(0, 0), (300, 0), (0, 700), (300, 700)] {
            let doc = doc_with(vec![
                Block::Table(table_with_margins(900, first_bottom)),
                Block::Table(table_with_margins(second_top, 800)),
            ]);
            let tables = top_level_table_tops(&doc);
            let gap = tables[1].0 - (tables[0].0 + tables[0].1);
            assert_eq!(
                gap,
                f64::from(first_bottom + second_top),
                "only the preceding bottom and following top margins form the gap"
            );
            if first_bottom > 0 && second_top > 0 {
                assert_ne!(
                    gap,
                    f64::from(first_bottom.max(second_top)),
                    "the current contract sums margins instead of collapsing to max"
                );
            }
            assert_eq!(
                tables[0].0, 7_200.0,
                "page-top suppresses the first table margin but keeps the page margin"
            );
            assert_eq!(
                place_doc(&doc, &ApproxFontMetrics).pages.len(),
                crate::NaiveLayout
                    .layout(&doc, &ApproxFontMetrics)
                    .unwrap()
                    .pages
                    .len(),
                "LOCKSTEP"
            );
            assert_eq!(block_pages(&doc, &ApproxFontMetrics)[0], vec![0, 0]);
        }
    }

    #[test]
    fn table_anchor_is_zero_but_real_spacer_and_page_break_are_owned() {
        use crate::LayoutEngine;

        let anchor = Paragraph {
            is_table_anchor: true,
            ..Default::default()
        };
        let without_anchor = doc_with(vec![
            Block::Table(one_cell_table(0)),
            Block::Table(one_cell_table(0)),
        ]);
        let with_anchor = doc_with(vec![
            Block::Table(one_cell_table(0)),
            Block::Paragraph(anchor.clone()),
            Block::Table(one_cell_table(0)),
        ]);
        assert_eq!(
            top_level_table_tops(&without_anchor),
            top_level_table_tops(&with_anchor),
            "a pure host anchor contributes no line"
        );

        let with_spacer = doc_with(vec![
            Block::Table(one_cell_table(0)),
            Block::Paragraph(para("")),
            Block::Table(one_cell_table(0)),
        ]);
        let spacer_tables = top_level_table_tops(&with_spacer);
        let spacer_placed = place_doc(&with_spacer, &ApproxFontMetrics);
        let spacer_band = spacer_placed.pages[0]
            .blocks
            .iter()
            .find(|block| block.block == 1)
            .expect("real blank spacer has a provenance band");
        assert_eq!(
            spacer_tables[1].0 - (spacer_tables[0].0 + spacer_tables[0].1),
            spacer_band.h,
        );

        let break_anchor = Paragraph {
            is_table_anchor: true,
            page_break_before: true,
            ..Default::default()
        };
        let page_break = doc_with(vec![
            Block::Table(one_cell_table(0)),
            Block::Paragraph(break_anchor),
            Block::Table(table_with_margins(700, 0)),
        ]);
        let placed = place_doc(&page_break, &ApproxFontMetrics);
        let naive = crate::NaiveLayout
            .layout(&page_break, &ApproxFontMetrics)
            .unwrap();
        assert_eq!(placed.pages.len(), 2);
        assert_eq!(placed.pages.len(), naive.pages.len(), "LOCKSTEP");
        assert_eq!(placed.pages[1].tables[0].y, 7_200.0);
        assert_eq!(
            block_pages(&page_break, &ApproxFontMetrics)[0],
            vec![0, 1, 1]
        );
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
        assert_eq!(
            pg.blocks.iter().map(|b| b.block).collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
        assert_eq!(
            pg.blocks[1].kind,
            BlockKind::Table,
            "the middle band is the table"
        );
        assert!(
            pg.blocks[0].kind == BlockKind::Paragraph && pg.blocks[2].kind == BlockKind::Paragraph
        );
        // Bands descend the page in order, no overlap of the paragraph rows with the table.
        assert!(
            pg.blocks[0].y < pg.blocks[1].y && pg.blocks[1].y < pg.blocks[2].y,
            "bands flow downward"
        );
        // A point inside each band resolves to that exact block.
        let mid = |i: usize| pg.blocks[i].y + pg.blocks[i].h / 2.0;
        assert_eq!(
            pg.block_at(8000.0, mid(0)).unwrap().block,
            0,
            "point in para-0 → block 0"
        );
        let tbl = pg.block_at(8000.0, mid(1)).unwrap();
        assert_eq!(
            (tbl.block, tbl.kind),
            (1, BlockKind::Table),
            "point in the table → block 1 (table)"
        );
        assert_eq!(
            pg.block_at(8000.0, mid(2)).unwrap().block,
            2,
            "point in para-2 → block 2"
        );
        // A point far BELOW all content snaps to the nearest band (the last block) — a near-miss in the
        // bottom margin still scopes a real block instead of failing.
        assert_eq!(
            pg.block_at(8000.0, 10_000_000.0).unwrap().block,
            2,
            "below-everything snaps to last"
        );
    }

    #[test]
    fn empty_table_does_not_borrow_a_prior_tables_band() {
        // A degenerate 0×0 table makes place_table early-return without pushing a PlacedTable, so the
        // band recorder's `tables.last()` would point at the PREVIOUS table. The anchor guard must keep
        // the empty table from stealing the real table's (section, block) band.
        let real = one_cell_table(0); // 1×1, block 0
        let empty = Table {
            rows: 0,
            cols: 0,
            ..Default::default()
        }; // block 1, draws nothing
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
        assert!(
            (g[0].baseline - g[2].baseline).abs() < 1e-6,
            "same baseline"
        );
        // First glyph starts at the left margin (default A4: 7200 HWPUNIT).
        assert!(
            (g[0].x - 7200.0).abs() < 1.0,
            "first glyph at the left margin, got {}",
            g[0].x
        );
    }

    #[test]
    fn center_alignment_offsets_the_line() {
        let mut doc = doc_with(vec![Block::Paragraph({
            let mut p = para("가");
            p.para_shape = 1;
            p
        })]);
        // ParaShape index 1 = centered.
        doc.para_shapes.push(ParaShape {
            align: HorizontalAlign::Center,
            ..Default::default()
        });
        let placed = place_doc(&doc, &ApproxFontMetrics);
        let g = &placed.pages[0].glyphs;
        assert_eq!(g.len(), 1);
        // body_w = 59528 - 2*7200 = 45128; one 1000-wide glyph → slack/2 = (45128-1000)/2 = 22064;
        // x = ml(7200) + 22064 = 29264.
        assert!(
            (g[0].x - 29264.0).abs() < 2.0,
            "centered glyph offset, got {}",
            g[0].x
        );
    }

    #[test]
    fn paragraph_left_margin_indents_every_line() {
        let mut doc = doc_with(vec![Block::Paragraph({
            let mut p = para("가");
            p.para_shape = 1;
            p
        })]);
        // ParaShape 1 = left margin 3000 HWPUNIT (들여쓰기 block inset), left-aligned.
        doc.para_shapes.push(ParaShape {
            align: HorizontalAlign::Left,
            left_margin: 3000,
            ..Default::default()
        });
        let placed = place_doc(&doc, &ApproxFontMetrics);
        let g = &placed.pages[0].glyphs;
        assert_eq!(g.len(), 1);
        // ml(7200) + left_margin(3000) = 10200.
        assert!(
            (g[0].x - 10200.0).abs() < 1.0,
            "left margin shifts the line in, got {}",
            g[0].x
        );
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
        doc.para_shapes.push(ParaShape {
            align: HorizontalAlign::Left,
            indent: 2000,
            ..Default::default()
        });
        let placed = place_doc(&doc, &ApproxFontMetrics);
        let g = &placed.pages[0].glyphs;
        assert!(g.len() > 1, "wrapped to multiple glyphs");
        let first = g[0].x;
        // Find the first glyph on a later line: its x should be back at the bare margin (7200), while
        // the first glyph sits indented by 2000 (→ 9200).
        let later = g.iter().find(|gl| (gl.x - 7200.0).abs() < 1.0);
        assert!(
            (first - 9200.0).abs() < 1.0,
            "first line indented by 2000, got {}",
            first
        );
        assert!(
            later.is_some(),
            "a later line starts back at the left margin (no first-line indent)"
        );
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
        assert!(
            (g[0].x - 7200.0).abs() < 1.0,
            "hanging indent clamped to left margin, got {}",
            g[0].x
        );
    }

    #[test]
    fn paragraph_text_color_carries_to_placed_glyph() {
        let blue = Color::from_hex("#0000FF").unwrap();
        let mut doc = doc_with(vec![Block::Paragraph(para("파"))]);
        doc.char_shapes[0] = CharShape {
            text_color: blue,
            ..Default::default()
        };
        let placed = place_doc(&doc, &ApproxFontMetrics);
        let g = &placed.pages[0].glyphs;
        assert_eq!(g.len(), 1);
        assert_eq!(g[0].color, blue, "run text color flows to the placed glyph");
    }

    #[test]
    fn myeongjo_hangul_font_routes_to_the_serif_substitute() {
        // Issue 058: a per-script 명조 (함초롬바탕) Hangul face routes the placed glyph's DISPLAY font to
        // the OFL serif substitute (Nanum Myeongjo); a 고딕 (함초롬돋움) face → None (the default gothic).
        // DISPLAY only — advances are unchanged (metric-neutral), so a font routing never moves the glyph
        // x or shifts pagination. `x` is captured to prove the position is face-independent.
        let mut doc = doc_with(vec![Block::Paragraph(para("가"))]);
        doc.char_shapes[0] = CharShape {
            fonts: vec![Some("함초롬바탕".to_string())],
            ..Default::default()
        };
        let placed = place_doc(&doc, &ApproxFontMetrics);
        assert_eq!(placed.pages[0].glyphs.len(), 1);
        let serif_x = placed.pages[0].glyphs[0].x;
        assert_eq!(
            placed.pages[0].glyphs[0].font.as_deref(),
            Some("Nanum Myeongjo"),
            "명조 Hangul face → serif substitute"
        );

        // 고딕 face → no explicit substitute (default gothic) AND the glyph x is byte-identical (metric-
        // neutral: the face routing is display-only).
        doc.char_shapes[0].fonts = vec![Some("함초롬돋움".to_string())];
        let placed2 = place_doc(&doc, &ApproxFontMetrics);
        assert_eq!(
            placed2.pages[0].glyphs[0].font, None,
            "고딕 Hangul face stays on the default gothic (None)"
        );
        assert_eq!(
            placed2.pages[0].glyphs[0].x, serif_x,
            "font routing is display-only — the glyph x is face-independent"
        );
    }

    #[test]
    fn panose_hint_routes_font_when_name_is_ambiguous() {
        // Issue 058 follow-up: a face whose NAME the heuristic can't classify ("사용자정의체" → Other →
        // default gothic) still routes to the serif substitute when its PANOSE (typeInfo) says serif
        // (Family Kind 2 Latin Text, Serif Style 3 = Obtuse Cove). Metric-neutral: the glyph x is
        // captured from a bare (name-only) placement first and must be byte-identical with the hint.
        let mut doc = doc_with(vec![Block::Paragraph(para("가"))]);
        doc.char_shapes[0] = CharShape {
            fonts: vec![Some("사용자정의체".to_string())],
            ..Default::default()
        };
        let bare = place_doc(&doc, &ApproxFontMetrics);
        let bare_x = bare.pages[0].glyphs[0].x;
        assert_eq!(
            bare.pages[0].glyphs[0].font, None,
            "an unrecognized NAME alone → default gothic (no substitute)"
        );

        // Attach a definitive serif PANOSE for the Hangul slot → now routes to the serif substitute.
        doc.char_shapes[0].font_panose = vec![Some([2, 3, 0, 0, 0, 0, 0, 0, 0, 0])];
        let hinted = place_doc(&doc, &ApproxFontMetrics);
        assert_eq!(
            hinted.pages[0].glyphs[0].font.as_deref(),
            Some("Nanum Myeongjo"),
            "definitive serif PANOSE routes the ambiguous-named face to the serif substitute"
        );
        assert_eq!(
            hinted.pages[0].glyphs[0].x, bare_x,
            "PANOSE routing is display-only — the glyph x is unchanged (metric-neutral)"
        );

        // A definitive SANS PANOSE overrides a serif-looking name (함초롬바탕 → serif by name) → gothic.
        doc.char_shapes[0].fonts = vec![Some("함초롬바탕".to_string())];
        doc.char_shapes[0].font_panose = vec![Some([2, 11, 0, 0, 0, 0, 0, 0, 0, 0])];
        let corrected = place_doc(&doc, &ApproxFontMetrics);
        assert_eq!(
            corrected.pages[0].glyphs[0].font, None,
            "definitive sans PANOSE overrides the serif-looking name → default gothic"
        );
    }

    #[test]
    fn cell_glyph_carries_run_text_color() {
        let blue = Color::from_hex("#0000FF").unwrap();
        let mut t = Table {
            rows: 1,
            cols: 1,
            ..Default::default()
        };
        t.cells.push(Cell {
            row: 0,
            col: 0,
            blocks: vec![Block::Paragraph(para("셀"))],
            ..Default::default()
        });
        let mut doc = doc_with(vec![Block::Table(t)]);
        doc.char_shapes[0] = CharShape {
            text_color: blue,
            ..Default::default()
        };
        let placed = place_doc(&doc, &ApproxFontMetrics);
        let cell_glyph = placed.pages[0]
            .glyphs
            .iter()
            .find(|g| g.ch == '셀')
            .unwrap();
        assert_eq!(
            cell_glyph.color, blue,
            "cell run text color flows to the placed glyph"
        );
    }

    #[test]
    fn over_wide_row_does_not_overlap_or_escape() {
        // A 2-col table, but a row whose cells claim col indices 0,1,2,3 (LLM added extras). The
        // out-of-range cells (col >= 2) must be skipped, not stacked on the last column.
        let mut t = Table {
            rows: 1,
            cols: 2,
            ..Default::default()
        };
        for c in 0..4 {
            t.cells.push(Cell {
                row: 0,
                col: c,
                blocks: vec![Block::Paragraph(para("x"))],
                ..Default::default()
            });
        }
        let doc = doc_with(vec![Block::Table(t)]);
        let placed = place_doc(&doc, &ApproxFontMetrics); // must not panic
                                                          // Exactly 2 cell borders (cols 0 and 1); the over-wide cells produced none.
        let borders = placed.pages[0]
            .rects
            .iter()
            .filter(|r| r.fill.is_none())
            .count();
        assert_eq!(
            borders, 2,
            "only in-range cells draw a border, got {borders}"
        );
        // Every cell rect stays within the table box (page left margin .. right margin).
        let page_right = 59528.0 - 7200.0;
        for r in placed.pages[0].rects.iter().filter(|r| r.fill.is_none()) {
            assert!(
                r.x + r.w <= page_right + 1.0,
                "cell stays inside the table box"
            );
        }
    }

    #[test]
    fn cell_paragraph_center_align_offsets_within_cell_width() {
        // A single full-width-table cell with a centered short paragraph: the glyph should sit roughly
        // in the middle of the cell text width, not flush-left (gov-table numbers/headers center).
        let mut t = Table {
            rows: 1,
            cols: 1,
            ..Default::default()
        };
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
        doc.para_shapes.push(ParaShape {
            align: HorizontalAlign::Center,
            ..Default::default()
        });
        let placed = place_doc(&doc, &ApproxFontMetrics);
        let g = placed.pages[0]
            .glyphs
            .iter()
            .find(|g| g.ch == '중')
            .unwrap();
        // Cell spans the full body width (45128); text width = 45128 - 2*CELL_PAD_X = 44728; one
        // 1000-wide glyph centered → x ≈ ml(7200) + CELL_PAD_X(200) + (44728-1000)/2 = 29264.
        let left_flush = 7200.0 + CELL_PAD_X;
        assert!(
            g.x > left_flush + 5000.0,
            "centered cell glyph is pushed right of flush-left, got {}",
            g.x
        );
    }

    #[test]
    fn out_of_range_row_index_is_skipped() {
        let mut t = Table {
            rows: 1,
            cols: 1,
            ..Default::default()
        };
        t.cells.push(Cell {
            row: 0,
            col: 0,
            blocks: vec![Block::Paragraph(para("ok"))],
            ..Default::default()
        });
        t.cells.push(Cell {
            row: 5,
            col: 0,
            blocks: vec![Block::Paragraph(para("bad"))],
            ..Default::default()
        });
        let doc = doc_with(vec![Block::Table(t)]);
        let placed = place_doc(&doc, &ApproxFontMetrics); // must not panic
        let borders = placed.pages[0]
            .rects
            .iter()
            .filter(|r| r.fill.is_none())
            .count();
        assert_eq!(
            borders, 1,
            "the out-of-range row cell is skipped, got {borders}"
        );
    }

    #[test]
    fn table_emits_cell_boxes() {
        let mut t = Table {
            rows: 2,
            cols: 2,
            ..Default::default()
        };
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
        let cell_borders = placed.pages[0]
            .rects
            .iter()
            .filter(|r| r.fill.is_none())
            .count();
        // 4 cell borders + the line text-boxes inside each cell paragraph.
        assert!(
            cell_borders >= 4,
            "at least 4 cell border boxes, got {cell_borders}"
        );
    }

    /// Build a 1-cell table whose single cell carries the given per-edge borders + diagonal.
    fn edge_table(borders: [Option<CellEdge>; 4], diagonal: Option<CellDiagonal>) -> SemanticDoc {
        edge_table_text(borders, diagonal, "x")
    }

    fn edge_table_text(
        borders: [Option<CellEdge>; 4],
        diagonal: Option<CellDiagonal>,
        text: &str,
    ) -> SemanticDoc {
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
        let blue = Color {
            r: 0,
            g: 0,
            b: 255,
            a: 255,
        };
        // left = dashed blue, right = 선없음 (suppressed), top = solid black, bottom = unspecified.
        let borders = [
            Some(CellEdge {
                color: blue,
                style: LineStyle::Dashed,
                width_px: 2.0,
            }),
            Some(CellEdge {
                color: Color::default(),
                style: LineStyle::None,
                width_px: 1.0,
            }),
            Some(CellEdge {
                color: Color::default(),
                style: LineStyle::Solid,
                width_px: 1.0,
            }),
            None,
        ];
        let doc = edge_table(borders, None);
        let placed = place_doc(&doc, &ApproxFontMetrics);
        let lines = &placed.pages[0].lines;
        // A per-edge cell does NOT emit the legacy uniform border rect.
        assert_eq!(
            placed.pages[0]
                .rects
                .iter()
                .filter(|r| r.fill.is_none())
                .count(),
            0,
            "per-edge cell must not draw the legacy uniform box"
        );
        // Exactly two visible edges: the dashed-blue left and the solid-black top. The 선없음 right
        // emits NO line; the unspecified (None) bottom emits no line either.
        assert_eq!(
            lines.len(),
            2,
            "only the two visible edges emit lines, got {}",
            lines.len()
        );
        let dashed = lines
            .iter()
            .find(|l| l.style == LineStyle::Dashed)
            .expect("a dashed edge line");
        assert_eq!(dashed.color, blue, "dashed edge keeps its blue color");
        assert_eq!(dashed.width, 2.0, "dashed edge keeps its width px");
        let solid = lines
            .iter()
            .find(|l| l.style == LineStyle::Solid)
            .expect("the solid top edge");
        // A 1.0px (above-floor) edge keeps its width — placement only clamps the floor, never rounds.
        assert_eq!(
            solid.width, 1.0,
            "an above-floor edge width is preserved verbatim"
        );
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
            Some(CellEdge {
                color: Color::default(),
                style: LineStyle::Solid,
                width_px: 0.3,
            }),
            None,
            None,
            None,
        ];
        let placed = place_doc(&edge_table(borders, None), &ApproxFontMetrics);
        let edge = placed.pages[0].lines.first().expect("the one visible edge");
        assert_eq!(
            edge.width, HAIRLINE_MIN_PX,
            "sub-floor width clamps to the hairline floor"
        );
    }

    #[test]
    fn cell_diagonal_emits_a_line_corner_to_corner_on_empty_cell() {
        let red = Color {
            r: 255,
            g: 0,
            b: 0,
            a: 255,
        };
        // An EMPTY cell with a back-slash diagonal (top-left → bottom-right): the diagonal forms a
        // shape (the section-header band's pointed end / an N/A slash) so it IS drawn.
        let doc = edge_table_text(
            [None; 4],
            Some(CellDiagonal {
                kind: DiagonalKind::BackSlash,
                color: red,
                width_px: 1.0,
            }),
            "",
        );
        let placed = place_doc(&doc, &ApproxFontMetrics);
        let lines = &placed.pages[0].lines;
        let diag = lines
            .iter()
            .find(|l| l.color == red)
            .expect("a diagonal line on the empty cell");
        assert!(
            diag.x2 > diag.x1 && diag.y2 > diag.y1,
            "back-slash runs top-left → bottom-right"
        );
    }

    #[test]
    fn cell_diagonal_suppressed_when_cell_has_text() {
        // A diagonal on a TEXT cell (e.g. the wide banner cell sharing the band's borderFill) is NOT
        // drawn — Hancom doesn't slash through the words; only the empty point cell shows the line.
        let red = Color {
            r: 255,
            g: 0,
            b: 0,
            a: 255,
        };
        let doc = edge_table_text(
            [None; 4],
            Some(CellDiagonal {
                kind: DiagonalKind::BackSlash,
                color: red,
                width_px: 1.0,
            }),
            "제목",
        );
        let placed = place_doc(&doc, &ApproxFontMetrics);
        assert!(
            !placed.pages[0].lines.iter().any(|l| l.color == red),
            "a diagonal over text is suppressed"
        );
    }

    #[test]
    fn cell_diagonal_cross_emits_two_lines_on_empty_cell() {
        let red = Color {
            r: 255,
            g: 0,
            b: 0,
            a: 255,
        };
        // An EMPTY cell with an X-cross diagonal (HWP set BOTH direction bits) draws BOTH corner-to-
        // corner lines — the slash AND the backslash, overlapping into an X (062-4).
        let doc = edge_table_text(
            [None; 4],
            Some(CellDiagonal {
                kind: DiagonalKind::Cross,
                color: red,
                width_px: 1.0,
            }),
            "",
        );
        let placed = place_doc(&doc, &ApproxFontMetrics);
        let diag: Vec<_> = placed.pages[0]
            .lines
            .iter()
            .filter(|l| l.color == red)
            .collect();
        assert_eq!(
            diag.len(),
            2,
            "X-cross pushes two diagonal lines, got {}",
            diag.len()
        );
        // One slash (bottom-left → top-right: y2 < y1) AND one backslash (top-left → bottom-right:
        // y2 > y1) — the same endpoints the single-direction kinds use, drawn together.
        assert!(
            diag.iter().any(|l| l.y2 < l.y1),
            "a slash line (bottom-left → top-right)"
        );
        assert!(
            diag.iter().any(|l| l.y2 > l.y1),
            "a backslash line (top-left → bottom-right)"
        );
    }

    #[test]
    fn cell_diagonal_cross_suppressed_when_cell_has_text() {
        // The empty-cell-only rule (cell_has_text) is kind-agnostic: an X-cross over a TEXT cell is
        // suppressed exactly like the single-line kinds — Hancom doesn't slash through the words.
        let red = Color {
            r: 255,
            g: 0,
            b: 0,
            a: 255,
        };
        let doc = edge_table_text(
            [None; 4],
            Some(CellDiagonal {
                kind: DiagonalKind::Cross,
                color: red,
                width_px: 1.0,
            }),
            "제목",
        );
        let placed = place_doc(&doc, &ApproxFontMetrics);
        assert!(
            !placed.pages[0].lines.iter().any(|l| l.color == red),
            "an X-cross over text is suppressed"
        );
    }

    // ---- Cell-addressed caret geometry (issue 053) ----

    /// A 1×2 table: cell (0,0) holds "가나다", cell (0,1) holds two paragraphs "행1"/"행2".
    fn caret_doc() -> SemanticDoc {
        let t = Table {
            rows: 1,
            cols: 2,
            cells: vec![
                Cell {
                    row: 0,
                    col: 0,
                    blocks: vec![Block::Paragraph(para("가나다"))],
                    ..Default::default()
                },
                Cell {
                    row: 0,
                    col: 1,
                    blocks: vec![Block::Paragraph(para("행1")), Block::Paragraph(para("행2"))],
                    ..Default::default()
                },
            ],
            col_widths: vec![1, 1],
            ..Default::default()
        };
        doc_with(vec![Block::Table(t)])
    }

    #[test]
    fn cell_caret_rect_places_offset_zero_at_text_origin_and_is_monotonic() {
        let doc = caret_doc();
        let placed = place_doc(&doc, &ApproxFontMetrics);
        let pc = placed.pages[0].tables[0]
            .cells
            .iter()
            .find(|c| c.col == 0)
            .unwrap()
            .clone();
        let r0 = cell_caret_rect(&doc, &placed, &ApproxFontMetrics, 0, 0, 0, 0, 0, 0)
            .expect("caret at offset 0");
        assert_eq!(r0.page, 0);
        assert!(
            (r0.x - (pc.x + CELL_PAD_X)).abs() < 1.0,
            "offset 0 sits at the cell text origin (left align): {} vs {}",
            r0.x,
            pc.x + CELL_PAD_X
        );
        assert!(
            r0.top >= pc.y && r0.top + r0.height <= pc.y + pc.h + 1.0,
            "caret stays inside the cell box"
        );
        // Monotonic advance: each next char boundary sits strictly right of the previous.
        let xs: Vec<f64> = (0..=3)
            .map(|o| {
                cell_caret_rect(&doc, &placed, &ApproxFontMetrics, 0, 0, 0, 0, 0, o)
                    .unwrap()
                    .x
            })
            .collect();
        assert!(
            xs.windows(2).all(|w| w[1] > w[0]),
            "boundaries advance: {xs:?}"
        );
        // Past-end clamps to the paragraph end (a rect, never None) — the CaretRect contract.
        let past = cell_caret_rect(&doc, &placed, &ApproxFontMetrics, 0, 0, 0, 0, 0, 999)
            .expect("past-end clamps");
        assert_eq!(past.x, xs[3], "offset 999 == offset para_len");
    }

    #[test]
    fn cell_text_hit_roundtrips_with_cell_caret_rect() {
        let doc = caret_doc();
        let placed = place_doc(&doc, &ApproxFontMetrics);
        // Click just right of the 2nd char boundary of cell (0,0)'s text: expect offset 2 and the
        // caret geometry to agree with the address-based query.
        let b2 = cell_caret_rect(&doc, &placed, &ApproxFontMetrics, 0, 0, 0, 0, 0, 2).unwrap();
        let hit = cell_text_hit(
            &doc,
            &placed,
            &ApproxFontMetrics,
            0,
            b2.x + 1.0,
            b2.top + b2.height / 2.0,
        )
        .expect("hit inside the cell text");
        assert_eq!(
            (hit.section, hit.block, hit.row, hit.col, hit.para),
            (0, 0, 0, 0, 0)
        );
        assert_eq!(hit.offset, 2, "nearest boundary is the queried one");
        assert_eq!(hit.para_len, 3);
        assert!(
            (hit.caret.x - b2.x).abs() < 0.01 && (hit.caret.top - b2.top).abs() < 0.01,
            "hit caret == addressed caret"
        );
    }

    #[test]
    fn cell_text_hit_addresses_second_paragraph() {
        let doc = caret_doc();
        let placed = place_doc(&doc, &ApproxFontMetrics);
        // Cell (0,1) has two paragraphs; the caret for para 1 sits BELOW para 0's.
        let p0 =
            cell_caret_rect(&doc, &placed, &ApproxFontMetrics, 0, 0, 0, 1, 0, 0).expect("para 0");
        let p1 =
            cell_caret_rect(&doc, &placed, &ApproxFontMetrics, 0, 0, 0, 1, 1, 0).expect("para 1");
        assert!(
            p1.top > p0.top,
            "para 1 line sits below para 0: {} vs {}",
            p1.top,
            p0.top
        );
        // A click on para 1's line resolves to para 1.
        let hit = cell_text_hit(
            &doc,
            &placed,
            &ApproxFontMetrics,
            0,
            p1.x + 1.0,
            p1.top + p1.height / 2.0,
        )
        .unwrap();
        assert_eq!((hit.para, hit.offset), (1, 0));
        assert_eq!(hit.para_len, 2);
    }

    #[test]
    fn cell_caret_forced_break_addresses_as_editor_segments() {
        // ONE model paragraph "가\n나" (forced break inside a run) must address as TWO editor
        // paragraphs — the same "\n"-split space block_runs/SetTableCellRuns speak — so a caret
        // commit can never garble a forced-broken label cell.
        let t = Table {
            rows: 1,
            cols: 1,
            cells: vec![Cell {
                row: 0,
                col: 0,
                blocks: vec![Block::Paragraph(para("가\n나"))],
                ..Default::default()
            }],
            col_widths: vec![1],
            ..Default::default()
        };
        let doc = doc_with(vec![Block::Table(t)]);
        let placed = place_doc(&doc, &ApproxFontMetrics);
        let p0 = cell_caret_rect(&doc, &placed, &ApproxFontMetrics, 0, 0, 0, 0, 0, 0)
            .expect("segment 0");
        let p1 = cell_caret_rect(&doc, &placed, &ApproxFontMetrics, 0, 0, 0, 0, 1, 0)
            .expect("segment 1 (after the forced break)");
        assert!(
            p1.top > p0.top,
            "segment 1 renders on the next line: {} vs {}",
            p1.top,
            p0.top
        );
        assert!(
            cell_caret_rect(&doc, &placed, &ApproxFontMetrics, 0, 0, 0, 0, 2, 0).is_none(),
            "only 2 segments"
        );
        // Hits on each line report segment-local addresses with para_len EXCLUDING the '\n'.
        let h0 = cell_text_hit(
            &doc,
            &placed,
            &ApproxFontMetrics,
            0,
            p0.x + 1.0,
            p0.top + p0.height / 2.0,
        )
        .unwrap();
        assert_eq!((h0.para, h0.offset, h0.para_len), (0, 0, 1));
        let h1 = cell_text_hit(
            &doc,
            &placed,
            &ApproxFontMetrics,
            0,
            p1.x + 1.0,
            p1.top + p1.height / 2.0,
        )
        .unwrap();
        assert_eq!((h1.para, h1.offset, h1.para_len), (1, 0, 1));
        // A click right of the text end (still INSIDE the cell) stops AT the '\n' — the caret never
        // lands past the separator (that position is the next segment's start).
        let h_end = cell_text_hit(
            &doc,
            &placed,
            &ApproxFontMetrics,
            0,
            p0.x + 20_000.0,
            p0.top + p0.height / 2.0,
        )
        .unwrap();
        assert_eq!(
            (h_end.para, h_end.offset),
            (0, 1),
            "caps at the segment end"
        );
    }

    #[test]
    fn cell_caret_null_policy_for_unresolvable_addresses() {
        let doc = caret_doc();
        let placed = place_doc(&doc, &ApproxFontMetrics);
        // Unknown cell / paragraph / block → None (018 null policy), never a panic.
        assert!(
            cell_caret_rect(&doc, &placed, &ApproxFontMetrics, 0, 0, 5, 5, 0, 0).is_none(),
            "no such cell"
        );
        assert!(
            cell_caret_rect(&doc, &placed, &ApproxFontMetrics, 0, 0, 0, 0, 9, 0).is_none(),
            "no such paragraph"
        );
        assert!(
            cell_caret_rect(&doc, &placed, &ApproxFontMetrics, 0, 9, 0, 0, 0, 0).is_none(),
            "no such block"
        );
        // A point off any table → None.
        assert!(
            cell_text_hit(&doc, &placed, &ApproxFontMetrics, 0, 59_000.0, 700_000.0).is_none(),
            "off-table click"
        );
        assert!(
            cell_text_hit(&doc, &placed, &ApproxFontMetrics, 7, 100.0, 100.0).is_none(),
            "page out of range"
        );
    }

    #[test]
    fn cell_caret_queries_do_not_change_pagination() {
        // V4: the caret surface is read-only — placing carets never perturbs place_doc/NaiveLayout.
        use crate::LayoutEngine;
        let doc = caret_doc();
        let placed = place_doc(&doc, &ApproxFontMetrics);
        let before = placed.pages.len();
        let _ = cell_text_hit(&doc, &placed, &ApproxFontMetrics, 0, 10_000.0, 10_000.0);
        let _ = cell_caret_rect(&doc, &placed, &ApproxFontMetrics, 0, 0, 0, 0, 0, 1);
        let again = place_doc(&doc, &ApproxFontMetrics);
        let naive = crate::NaiveLayout
            .layout(&doc, &ApproxFontMetrics)
            .unwrap()
            .pages
            .len();
        assert_eq!(again.pages.len(), before);
        assert_eq!(
            again.pages.len(),
            naive,
            "LOCKSTEP holds after caret queries"
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
        assert_eq!(
            placed.pages.len(),
            naive,
            "placed pagination == NaiveLayout pagination"
        );
        assert!(placed.pages.len() >= 2, "100 lines paginate");
    }
}
