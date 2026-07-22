//! tf-hwp **shell-independent document-session logic** (issue 012).
//!
//! This crate holds the document logic that used to live inside the Tauri viewer's command bodies
//! (`hwp-viewer/src/lib.rs`): DTO assembly, own-engine geometry queries, styled-run reads, HTML/PDF
//! export projection, and the image-insert proposal builder. It is a **pure, synchronous, wasm-safe
//! leaf**: no `tauri`, no locks/threads/async, and no `std::fs` unless the `fs` feature is on. The
//! three shells (Tauri app / headless service / wasm npm) each own their I/O + state and wrap the
//! SAME functions here, so a change lands identically everywhere.
//!
//! ## Facade surface (what a shell wraps)
//! Every entry point takes a `&SemanticDoc` (the live document the shell holds) plus plain scalars,
//! and returns a serde-serializable DTO / SVG string / HTML string — never a session handle:
//! - **render**: [`render_svg`] (per-page own-render SVG), [`outline`] (heading nav).
//! - **geometry** (own-render px space, converts px↔HWPUNIT at the boundary): [`image_bbox`],
//!   [`image_at`], [`table_bbox`], [`table_at`], [`own_hit_test`], [`table_cell_at`],
//!   [`table_cell_box`], [`table_col_boundaries`], [`table_row_boundaries`], [`page_geometry`].
//! - **style reads**: [`char_fmt`], [`block_runs`], [`block_style`].
//! - **export**: [`emit_html`] (+ [`emit_pdf`] under `pdf`).
//! - **image insert**: [`build_insert_image_proposal`] (+ [`stash_image`] under `fs`).
//!
//! The op-bus edit lane (`Intent`/`apply_intent`, undo/redo, the shared `Session`) stays in the
//! shell — it carries locks/threads and (via `hwp-mcp`) a non-wasm `getrandom`/`std::net` surface, so
//! folding it in here would break the wasm-safe guarantee. Unifying that behind this facade is the
//! follow-up the recon deferred (Session absorb, issue 013).

use hwp_model::prelude::SemanticDoc;
use serde_json::{json, Value};

/// The positioned, paginated document produced by [`place`] — re-exported so a caller (the wasm
/// `HwpDoc` layout cache, issue 025) can name and store it without depending on `hwp-typeset` directly.
pub use hwp_typeset::PlacedDoc;

// ---- Own-engine geometry unit boundary --------------------------------------------------------
//
// Own-engine geometry lives in HWPUNIT in `place_doc`, but the own-render SVG (and therefore the
// clicks `screenToPage` produces + the boxes the overlays draw) is in CSS px = HWPUNIT /
// HWPUNIT_PER_PX (the SvgSink divides by the same factor). So every own-engine geometry query here
// accepts clicks AND returns boxes in PX, converting at the boundary — otherwise the ~75× mismatch
// makes clicks never hit and handles land far off-screen (the bug behind "이미지/표 이동·리사이즈가
// 전혀 안 됨"). This is the ONLY place px↔HWPUNIT conversion happens; the edit-commit lane already
// speaks HWPUNIT/mm end-to-end.
pub const HWPUNIT_PER_PX: f64 = 7200.0 / 96.0;

/// Choose the font-metrics provider for the OWN renderer: the real rustybuzz shaper under
/// `--features shaper` (real Latin advances + EM-grid Hangul), else the per-script approximation.
/// Every own-render / geometry path uses this, so the in-app view, `tf-hwp own-render`, and the
/// geometry overlays all measure identically.
#[cfg(feature = "shaper")]
pub fn own_render_fonts() -> Box<dyn hwp_model::prelude::FontMetricsProvider> {
    Box::new(hwp_typeset::RealFontMetrics::new())
}
#[cfg(not(feature = "shaper"))]
pub fn own_render_fonts() -> Box<dyn hwp_model::prelude::FontMetricsProvider> {
    Box::new(hwp_typeset::ApproxFontMetrics)
}

/// Like [`own_render_fonts`], but backed by CALLER-INJECTED font bytes when present — the wasm/web
/// path where `std::fs` finds no fonts to discover (issue 022 §1, mirroring 018's PDF byte-injection).
/// The FIRST parseable injected face backs the rustybuzz shaper, so the SCREEN SVG, the LAYOUT
/// pagination and the PDF embed all measure with the SAME bytes. An EMPTY slice returns EXACTLY
/// [`own_render_fonts`] (same provider construction → byte-identical output), and a build WITHOUT the
/// `shaper` feature ignores the bytes (no rustybuzz to feed) and stays on the Approx fallback — so the
/// native discover/Approx paths are byte-unchanged (the golden regime). v1 uses the first injected
/// face for every document font name (the "모든 문서 폰트명 → 현재 선택 폰트 1개" mapping, issue §3).
#[cfg(feature = "shaper")]
pub fn own_render_fonts_with(
    injected: &[(String, Vec<u8>)],
) -> Box<dyn hwp_model::prelude::FontMetricsProvider> {
    match injected.iter().find(|(_, b)| !b.is_empty()) {
        Some((_family, bytes)) => Box::new(WithFamilies {
            inner: Box::new(hwp_typeset::RealFontMetrics::from_bytes(bytes)),
            families: injected.iter().map(|(f, _)| f.clone()).collect(),
        }),
        None => own_render_fonts(),
    }
}
#[cfg(not(feature = "shaper"))]
pub fn own_render_fonts_with(
    injected: &[(String, Vec<u8>)],
) -> Box<dyn hwp_model::prelude::FontMetricsProvider> {
    // No `shaper` feature → no rustybuzz to feed the injected bytes into; Approx is the deterministic
    // fallback (the injected face still drives the PDF embed via `emit_pdf_with_fonts`). The FAMILY
    // names still ride along (폰트제공): the explicit-family display bypass works metrics-free.
    if injected.iter().any(|(_, b)| !b.is_empty()) {
        Box::new(WithFamilies {
            inner: own_render_fonts(),
            families: injected.iter().map(|(f, _)| f.clone()).collect(),
        })
    } else {
        own_render_fonts()
    }
}

/// Provider wrapper carrying the INJECTED family names (폰트 제공): display stamping asks
/// [`hwp_model::prelude::FontMetricsProvider::has_family`] so an EXPLICITLY-set registered family
/// (e.g. "Pretendard") bypasses the 058 class substitute and keeps its own name (the screen
/// `@font-face` and the PDF per-family embed pick it up). Metrics delegate untouched (V5 게이트 불변); the
/// zero-injection path never builds this, so golden bytes are unchanged.
struct WithFamilies {
    inner: Box<dyn hwp_model::prelude::FontMetricsProvider>,
    families: Vec<String>,
}

impl hwp_model::prelude::FontMetricsProvider for WithFamilies {
    fn advance_width(
        &self,
        font: &hwp_model::prelude::FontKey,
        ch: char,
        size_hwpunit: i32,
    ) -> f64 {
        self.inner.advance_width(font, ch, size_hwpunit)
    }
    fn line_height(&self, size_hwpunit: i32) -> f64 {
        self.inner.line_height(size_hwpunit)
    }
    fn has_family(&self, family: &str) -> bool {
        self.families
            .iter()
            .any(|f| f.trim().eq_ignore_ascii_case(family.trim()))
    }
}

/// Render every page of `doc` through OUR OWN engine (`place_doc` → paint IR → `SvgSink`), one
/// standalone SVG string per page. The self-owned, browser-independent fidelity surface — the SAME
/// path the CLI `own-render` runs and the in-app "자체 렌더" view shows. Under `shaper` glyph
/// x-positions are real (rustybuzz advances).
pub fn render_svg(doc: &SemanticDoc) -> Vec<String> {
    let fonts = own_render_fonts();
    hwp_render::render_doc_svg(doc, fonts.as_ref())
}

/// Like [`render_svg`], but measures with CALLER-INJECTED font bytes (issue 022 §2) so the wasm/web
/// screen SVG uses the SAME face as its layout + PDF. An EMPTY slice is byte-identical to
/// [`render_svg`] (delegates through [`own_render_fonts_with`]). Registering/replacing a font changes
/// pagination, so the host MUST re-query [`crate`]-derived page counts after `registerFont` (the wasm
/// `HwpDoc` invalidates its revision-keyed SVG cache on register).
pub fn render_svg_with(doc: &SemanticDoc, injected: &[(String, Vec<u8>)]) -> Vec<String> {
    let fonts = own_render_fonts_with(injected);
    hwp_render::render_doc_svg(doc, fonts.as_ref())
}

// ---- Reusable placement (issue 025 — layout cache) --------------------------------------------

/// Typeset the whole document ONCE into positioned pages — the reusable geometry surface (issue 025).
/// Every `*_placed` query below reads a `&PlacedDoc` instead of re-typesetting, so a caller (the wasm
/// `HwpDoc` cache, a shell) can place once per document revision and answer many clicks / drags /
/// marquees without paying the pagination cost on every event (the body of "선택·드래그 딜레이"). The
/// bare and `_with` query families are re-expressed as `place() + *_placed()` — the geometry logic lives
/// ONLY in the `_placed` bodies, so there is no duplicated (drift-prone) copy.
///
/// `injected` threads caller-supplied font faces exactly like the `_with` family: an EMPTY slice is
/// byte-identical to the discover/Approx placement (`own_render_fonts_with(&[]) == own_render_fonts`),
/// so the native golden path (own-render / export-pdf / layout-check) is unchanged.
pub fn place(doc: &SemanticDoc, injected: &[(String, Vec<u8>)]) -> PlacedDoc {
    let fonts = own_render_fonts_with(injected);
    hwp_typeset::place_doc(doc, fonts.as_ref())
}

// ---- Outline (heading nav) --------------------------------------------------------------------

/// One heading in the document outline: where it lives in the model + the page it starts on.
#[derive(serde::Serialize)]
pub struct OutlineItem {
    pub section: usize,
    pub block: usize,
    pub level: u8,
    pub text: String,
    pub page: u32,
}

/// Document outline for the left nav panel: the gov-doc's top-level headings — □-prefixed section
/// labels and numbered section bands ("1. 문제 인식 …") — each with the 0-based page it starts on
/// (via [`hwp_typeset::block_pages`]). Heuristic + gov-doc-tuned; empty when the doc has none.
pub fn outline(doc: &SemanticDoc) -> Vec<OutlineItem> {
    let fonts = own_render_fonts();
    let pages = hwp_typeset::block_pages(doc, fonts.as_ref());
    let mut out = Vec::new();
    for (si, sec) in doc.sections.iter().enumerate() {
        for (bi, block) in sec.blocks.iter().enumerate() {
            if let Some((level, text)) = outline_heading(block) {
                let page = pages.get(si).and_then(|p| p.get(bi)).copied().unwrap_or(0) as u32;
                out.push(OutlineItem {
                    section: si,
                    block: bi,
                    level,
                    text,
                    page,
                });
            }
        }
    }
    out
}

/// Detect a heading block → `(level, text)`. Level 1 = a □/■-prefixed section label paragraph;
/// level 2 = a numbered section-band table ("N. …"). Returns `None` for body content.
fn outline_heading(block: &hwp_model::document::Block) -> Option<(u8, String)> {
    use hwp_model::document::{Block, Inline};
    fn para_text(p: &hwp_model::document::Paragraph) -> String {
        p.runs
            .iter()
            .flat_map(|r| {
                r.content.iter().filter_map(|i| {
                    if let Inline::Text(s) = i {
                        Some(s.as_str())
                    } else {
                        None
                    }
                })
            })
            .collect()
    }
    match block {
        Block::Paragraph(p) => {
            let t = para_text(p);
            let tt = t.trim();
            if (tt.starts_with('□') || tt.starts_with('■')) && tt.chars().count() < 40 {
                return Some((1, tt.to_string()));
            }
            None
        }
        Block::Table(t) => {
            // The first non-empty cell text; a numbered band starts with a digit and contains '.'.
            let first = t.cells.iter().find_map(|c| {
                let s: String = c
                    .blocks
                    .iter()
                    .filter_map(|b| {
                        if let Block::Paragraph(p) = b {
                            Some(para_text(p))
                        } else {
                            None
                        }
                    })
                    .collect();
                let s = s.trim().to_string();
                (!s.is_empty()).then_some(s)
            })?;
            let numbered = first
                .chars()
                .next()
                .map(|c| c.is_ascii_digit())
                .unwrap_or(false)
                && first.contains('.');
            (numbered && first.chars().count() < 80).then_some((2, first))
        }
    }
}

// ---- Document profile (issue 067 — AI doc-context grounding) ----------------------------------

/// Char-budget caps for the profile — keep the WHOLE profile a small, bounded doc-context block so it
/// can ride every AI request without threatening the anchors/grids budget (067 §예산).
const PROFILE_EXCERPT_MAX: usize = 1200;
const PROFILE_HEADINGS_MAX: usize = 20;
const PROFILE_TABLES_MAX: usize = 20;
const PROFILE_HEADER_CELLS_MAX: usize = 6;
const PROFILE_HEADER_CELL_LEN: usize = 24;
const PROFILE_TITLE_MAX: usize = 60;

/// One detected heading for the profile — [`outline`] WITHOUT the page number, so building the
/// profile stays a PURE MODEL read (`outline()` pays a `block_pages` typeset pass for the nav
/// panel's page jump; the model doesn't need pages — `[s/b]` anchors are the edit currency).
#[derive(serde::Serialize)]
pub struct ProfileHeading {
    pub section: usize,
    pub block: usize,
    pub level: u8,
    pub text: String,
}

/// One table's inventory line for the profile: model address + shape + first-row (header) cell
/// texts — so the model can tell WHICH table the user means without a marked anchor. `(section,
/// block)` are the SAME addresses `tableGrid`/`SetTableCell` target (`edit_target` inner table).
#[derive(serde::Serialize)]
pub struct ProfileTable {
    pub section: usize,
    pub block: usize,
    pub rows: usize,
    pub cols: usize,
    pub header: Vec<String>,
}

/// The deterministic document profile (issue 067): title candidate + structure counts + headings +
/// table inventory + a `to_markdown` body excerpt — what the chat doc-context needs to ground
/// "what IS this document" without the user marking anchors or re-explaining it each session, with
/// ZERO LLM calls. Pure model read (no placement, no fonts) — cheap enough to compute per AI
/// request, so it is never stale after an edit. Counts include NESTED content (cell blocks).
#[derive(serde::Serialize)]
pub struct DocProfileDto {
    pub title: Option<String>,
    pub sections: usize,
    pub paragraph_count: usize,
    pub table_count: usize,
    pub image_count: usize,
    pub chart_count: usize,
    pub equation_count: usize,
    pub headings: Vec<ProfileHeading>,
    pub tables: Vec<ProfileTable>,
    pub excerpt: String,
}

/// Truncate to `max` CHARS (not bytes — never splits a Hangul scalar), appending "…" when elided.
fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let t: String = s.chars().take(max).collect();
        format!("{t}…")
    }
}

/// Build the document profile — see [`DocProfileDto`]. Every ingredient is an existing surface:
/// heading detection = [`outline`]'s `outline_heading`, table shape/text = the [`table_grid`] lane
/// (`edit_target` + active cells), excerpt = `hwp_ai::to_markdown` (the 004 structure-preserving
/// projection). Nothing here re-typesets.
pub fn doc_profile(doc: &SemanticDoc) -> DocProfileDto {
    use hwp_model::document::{Block, Inline};

    // Recursive structure counts — a nested table (a table inside a cell) counts like the visible
    // content it is; Raw/field/bookmark inlines are ignored (un-modeled passthrough).
    fn walk(
        blocks: &[Block],
        p: &mut usize,
        t: &mut usize,
        img: &mut usize,
        ch: &mut usize,
        eq: &mut usize,
    ) {
        for b in blocks {
            match b {
                Block::Paragraph(para) => {
                    *p += 1;
                    for run in &para.runs {
                        for inl in &run.content {
                            match inl {
                                Inline::Image(_) => *img += 1,
                                Inline::Chart(_) => *ch += 1,
                                Inline::Equation(_) => *eq += 1,
                                _ => {}
                            }
                        }
                    }
                }
                Block::Table(table) => {
                    *t += 1;
                    for cell in &table.cells {
                        walk(&cell.blocks, p, t, img, ch, eq);
                    }
                }
            }
        }
    }

    let (mut paragraphs, mut tables_n, mut images, mut charts, mut equations) = (0, 0, 0, 0, 0);
    let mut headings = Vec::new();
    let mut tables = Vec::new();
    let mut first_para_text: Option<String> = None;
    for (si, sec) in doc.sections.iter().enumerate() {
        walk(
            &sec.blocks,
            &mut paragraphs,
            &mut tables_n,
            &mut images,
            &mut charts,
            &mut equations,
        );
        for (bi, block) in sec.blocks.iter().enumerate() {
            if headings.len() < PROFILE_HEADINGS_MAX {
                if let Some((level, text)) = outline_heading(block) {
                    headings.push(ProfileHeading {
                        section: si,
                        block: bi,
                        level,
                        text,
                    });
                }
            }
            match block {
                Block::Paragraph(p) => {
                    if first_para_text.is_none() {
                        let t: String = p
                            .runs
                            .iter()
                            .flat_map(|r| &r.content)
                            .filter_map(|i| match i {
                                Inline::Text(s) => Some(s.as_str()),
                                _ => None,
                            })
                            .collect();
                        let t = t.trim().to_string();
                        if !t.is_empty() {
                            first_para_text = Some(t);
                        }
                    }
                }
                Block::Table(t) => {
                    if tables.len() < PROFILE_TABLES_MAX {
                        let t = t.edit_target(); // SAME coordinate frame as tableGrid/SetTableCell
                        let (rows, cols) = (t.rows.max(1), t.cols.max(1));
                        let mut first_row: Vec<_> = t
                            .cells
                            .iter()
                            .filter(|c| c.active && c.row == 0 && c.col < cols)
                            .collect();
                        first_row.sort_by_key(|c| c.col);
                        let header = first_row
                            .into_iter()
                            .take(PROFILE_HEADER_CELLS_MAX)
                            .map(|c| {
                                truncate_chars(cell_plain_text(c).trim(), PROFILE_HEADER_CELL_LEN)
                            })
                            .collect();
                        tables.push(ProfileTable {
                            section: si,
                            block: bi,
                            rows,
                            cols,
                            header,
                        });
                    }
                }
            }
        }
    }

    // Title candidate: the first level-1 heading, else the first non-empty paragraph (a gov-doc's
    // big centered title is normally the first text block). Honest `None` when neither exists.
    let title = headings
        .iter()
        .find(|h| h.level == 1)
        .map(|h| h.text.clone())
        .or(first_para_text)
        .map(|t| truncate_chars(&t, PROFILE_TITLE_MAX));

    let excerpt = {
        let md = hwp_ai::to_markdown(doc).unwrap_or_default();
        truncate_chars(md.trim(), PROFILE_EXCERPT_MAX)
    };

    DocProfileDto {
        title,
        sections: doc.sections.len(),
        paragraph_count: paragraphs,
        table_count: tables_n,
        image_count: images,
        chart_count: charts,
        equation_count: equations,
        headings,
        tables,
        excerpt,
    }
}

// ---- Image move/resize overlay geometry -------------------------------------------------------

/// An anchored image's placed box in own-render PX (own SVG space) + its model anchor. The frontend
/// draws the 8-handle overlay over `x/y/w/h` and commits a resize via `set_image_size`.
#[derive(serde::Serialize)]
pub struct ImageBoxDto {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub section: usize,
    pub block: usize,
}

/// Locate the placed box of the image anchored at `(section, block)` on `page`, in own-render px.
/// Re-drives `place_doc` over the LIVE IR with the SAME `own_render_fonts` as [`render_svg`], so the
/// box matches the "자체 렌더" SVG exactly. `None` if that image doesn't fall on the queried page or
/// the anchor holds no image.
pub fn image_bbox(
    doc: &SemanticDoc,
    page: u32,
    section: usize,
    block: usize,
) -> Option<ImageBoxDto> {
    image_bbox_placed(&place(doc, &[]), page, section, block)
}

/// [`image_bbox`] against an already-placed document (issue 025 cache surface). No typesetting here —
/// pure geometry over `placed`.
pub fn image_bbox_placed(
    placed: &PlacedDoc,
    page: u32,
    section: usize,
    block: usize,
) -> Option<ImageBoxDto> {
    let pg = placed.pages.get(page as usize)?;
    let k = HWPUNIT_PER_PX;
    pg.images
        .iter()
        .find(|im| im.section == section && im.block == block && !im.bin_ref.is_empty())
        .map(|im| ImageBoxDto {
            x: im.x / k,
            y: im.y / k,
            w: im.w / k,
            h: im.h / k,
            section: im.section,
            block: im.block,
        })
}

/// Click-to-select: the topmost image whose placed box contains page-space `(x, y)` on `page`, in
/// own-render px (with its `(section, block)` anchor). `None` if the click misses every image.
pub fn image_at(doc: &SemanticDoc, page: u32, x: f64, y: f64) -> Option<ImageBoxDto> {
    image_at_placed(&place(doc, &[]), page, x, y)
}

/// [`image_at`] against an already-placed document (issue 025 cache surface).
pub fn image_at_placed(placed: &PlacedDoc, page: u32, x: f64, y: f64) -> Option<ImageBoxDto> {
    let pg = placed.pages.get(page as usize)?;
    let k = HWPUNIT_PER_PX;
    let (x, y) = (x * k, y * k); // px click → HWPUNIT (place_doc space)
                                 // Last match wins → topmost in paint order (later images draw over earlier ones).
    pg.images
        .iter()
        .filter(|im| !im.bin_ref.is_empty())
        .rfind(|im| x >= im.x && x <= im.x + im.w && y >= im.y && y <= im.y + im.h)
        .map(|im| ImageBoxDto {
            x: im.x / k,
            y: im.y / k,
            w: im.w / k,
            h: im.h / k,
            section: im.section,
            block: im.block,
        })
}

// ---- Table move/select/edit overlay geometry --------------------------------------------------

/// A placed table's OUTER box in own-render PX + its model anchor.
#[derive(serde::Serialize)]
pub struct TableBoxDto {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub section: usize,
    pub block: usize,
    pub rows: usize,
    pub cols: usize,
    /// For a table SPLIT across pages, this fragment's FIRST global row index (0 for a single-page
    /// table). The cell-range selection adds this offset to its fragment-local row indices so a batch
    /// op targets the correct GLOBAL rows of the (possibly frame-wrapped) table.
    pub first_row: usize,
}

/// Locate the placed outer box of the table anchored at `(section, block)` on `page`, in own-render
/// px. `None` if that table doesn't fall on the queried page.
pub fn table_bbox(
    doc: &SemanticDoc,
    page: u32,
    section: usize,
    block: usize,
) -> Option<TableBoxDto> {
    table_bbox_placed(&place(doc, &[]), page, section, block)
}

/// [`table_bbox`] against an already-placed document (issue 025 cache surface).
pub fn table_bbox_placed(
    placed: &PlacedDoc,
    page: u32,
    section: usize,
    block: usize,
) -> Option<TableBoxDto> {
    let pg = placed.pages.get(page as usize)?;
    let k = HWPUNIT_PER_PX;
    pg.tables
        .iter()
        .find(|t| t.section == section && t.block == block)
        .map(|t| TableBoxDto {
            x: t.x / k,
            y: t.y / k,
            w: t.w / k,
            h: t.h / k,
            section: t.section,
            block: t.block,
            rows: t.rows,
            cols: t.cols,
            first_row: t.first_row,
        })
}

/// Click-to-select: the topmost table whose placed outer box contains page-space `(x, y)` on `page`,
/// in own-render px (with its `(section, block)` anchor). `None` if the click misses every table.
pub fn table_at(doc: &SemanticDoc, page: u32, x: f64, y: f64) -> Option<TableBoxDto> {
    table_at_placed(&place(doc, &[]), page, x, y)
}

/// [`table_at`] measured with CALLER-INJECTED font bytes (issue 022) — the wasm/web path where a
/// registered font changed the pagination, so the geometry MUST agree with the injected-metric SVG or
/// clicks miss. Empty slice → identical to [`table_at`].
pub fn table_at_with(
    doc: &SemanticDoc,
    page: u32,
    x: f64,
    y: f64,
    injected: &[(String, Vec<u8>)],
) -> Option<TableBoxDto> {
    table_at_placed(&place(doc, injected), page, x, y)
}

/// [`table_at`] against an already-placed document (issue 025 cache surface). The wasm `HwpDoc` calls
/// this with its cached `PlacedDoc` so a click does not re-typeset the document.
pub fn table_at_placed(placed: &PlacedDoc, page: u32, x: f64, y: f64) -> Option<TableBoxDto> {
    let pg = placed.pages.get(page as usize)?;
    let k = HWPUNIT_PER_PX;
    let (x, y) = (x * k, y * k); // px click → HWPUNIT (place_doc space)
                                 // Last match wins → topmost in paint order (a nested table draws after its outer table).
    pg.tables
        .iter()
        .rfind(|t| x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h)
        .map(|t| TableBoxDto {
            x: t.x / k,
            y: t.y / k,
            w: t.w / k,
            h: t.h / k,
            section: t.section,
            block: t.block,
            rows: t.rows,
            cols: t.cols,
            first_row: t.first_row,
        })
}

// ---- Own-render point-to-block ----------------------------------------------------------------

/// The top-level block the user pointed at, in own-render px: its `(section, block)` anchor, a label
/// `kind` ("paragraph"/"table"/"image"), and its band box `x/y/w/h`.
#[derive(serde::Serialize)]
pub struct BlockHitDto {
    pub section: usize,
    pub block: usize,
    pub kind: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// The block's plain text when it is a top-level PARAGRAPH (else empty) — lets a double-click open
    /// the inline editor pre-filled. Empty for a table band (cells edit via `table_cell_at`).
    pub text: String,
    /// True when a PARAGRAPH is inline-editable (simple, all-text) — matches SetParagraphText's accept
    /// rule, so the UI can gate double-click and avoid the user typing into a paragraph that will refuse.
    pub editable: bool,
}

/// Whether a top-level paragraph block is inline-editable (mirrors SetParagraphText's accept rule:
/// `source.simple` AND no non-text inline). False for tables/images/structural paragraphs.
fn model_para_editable(doc: &SemanticDoc, section: usize, block: usize) -> bool {
    use hwp_model::prelude::{Block, Inline};
    let Some(sec) = doc.sections.get(section) else {
        return false;
    };
    let Some(Block::Paragraph(p)) = sec.blocks.get(block) else {
        return false;
    };
    let simple = p.source.as_ref().map(|s| s.simple).unwrap_or(true);
    let all_text = p
        .runs
        .iter()
        .all(|r| r.content.iter().all(|i| matches!(i, Inline::Text(_))));
    simple && all_text
}

/// Concatenate the plain text of a top-level paragraph block `(section, block)` (empty if not a simple
/// paragraph). Used to pre-fill the inline paragraph editor.
fn model_para_text(doc: &SemanticDoc, section: usize, block: usize) -> String {
    use hwp_model::prelude::{Block, Inline};
    let Some(sec) = doc.sections.get(section) else {
        return String::new();
    };
    let Some(Block::Paragraph(p)) = sec.blocks.get(block) else {
        return String::new();
    };
    let mut out = String::new();
    for r in &p.runs {
        for i in &r.content {
            if let Inline::Text(s) = i {
                out.push_str(s);
            }
        }
    }
    out
}

/// Click-to-point (own-render only): resolve a page-space click to the top-level block under it, in
/// own-render px geometry. Unlike [`image_at`]/[`table_at`] this resolves PARAGRAPHS too. `None` only
/// when the page has no placed blocks.
pub fn own_hit_test(doc: &SemanticDoc, page: u32, x: f64, y: f64) -> Option<BlockHitDto> {
    own_hit_test_placed(doc, &place(doc, &[]), page, x, y)
}

/// [`own_hit_test`] measured with CALLER-INJECTED font bytes (issue 022) — the wasm/web path so the
/// click-to-point geometry agrees with the injected-metric SVG. Empty slice → identical to
/// [`own_hit_test`].
pub fn own_hit_test_with(
    doc: &SemanticDoc,
    page: u32,
    x: f64,
    y: f64,
    injected: &[(String, Vec<u8>)],
) -> Option<BlockHitDto> {
    own_hit_test_placed(doc, &place(doc, injected), page, x, y)
}

/// [`own_hit_test`] against an already-placed document (issue 025 cache surface). Takes BOTH `placed`
/// (geometry) and `doc` (the model text/editable read-back), so the wasm `HwpDoc` can serve every click
/// from its cached `PlacedDoc` while still resolving the paragraph pre-fill text from the live model.
pub fn own_hit_test_placed(
    doc: &SemanticDoc,
    placed: &PlacedDoc,
    page: u32,
    x: f64,
    y: f64,
) -> Option<BlockHitDto> {
    let pg = placed.pages.get(page as usize)?;
    let k = HWPUNIT_PER_PX;
    pg.block_at(x * k, y * k).map(|b| BlockHitDto {
        section: b.section,
        block: b.block,
        kind: match b.kind {
            hwp_typeset::BlockKind::Paragraph => "paragraph",
            hwp_typeset::BlockKind::Table => "table",
            hwp_typeset::BlockKind::Image => "image",
        }
        .into(),
        x: b.x / k,
        y: b.y / k,
        w: b.w / k,
        h: b.h / k,
        text: if b.kind == hwp_typeset::BlockKind::Paragraph {
            model_para_text(doc, b.section, b.block)
        } else {
            String::new()
        },
        editable: b.kind == hwp_typeset::BlockKind::Paragraph
            && model_para_editable(doc, b.section, b.block),
    })
}

/// Marquee (rubber-band) select (own-render only): every top-level block whose placed BAND intersects
/// the page-space rectangle `(x0,y0)-(x1,y1)`, in own-render px geometry. The rectangle corners come in
/// either order (a drag can go up-left); they're normalized here. Additive to [`own_hit_test`] — it uses
/// the SAME `PlacedBlock` bands, but tests full 2-D AABB overlap against the rect (not the point-nearest
/// fallback), so only blocks the box actually crosses are returned. One [`BlockHitDto`] per distinct
/// `(section, block)` (a block appears once per page). Empty vec when nothing intersects (never `None`).
///
/// Units mirror [`own_hit_test`]: the rect is in own-render px (= HWPUNIT/75, page-local), converted to
/// place_doc HWPUNIT at the boundary; the returned boxes are back in px. Multi-page marquee is out of
/// scope — the caller clips the rect to the start page and queries that page only.
pub fn blocks_in_rect(
    doc: &SemanticDoc,
    page: u32,
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
) -> Vec<BlockHitDto> {
    blocks_in_rect_placed(doc, &place(doc, &[]), page, x0, y0, x1, y1)
}

/// [`blocks_in_rect`] measured with CALLER-INJECTED font bytes (issue 022) — the wasm/web path so the
/// marquee geometry agrees with the injected-metric SVG. Empty slice → identical to [`blocks_in_rect`].
pub fn blocks_in_rect_with(
    doc: &SemanticDoc,
    page: u32,
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
    injected: &[(String, Vec<u8>)],
) -> Vec<BlockHitDto> {
    blocks_in_rect_placed(doc, &place(doc, injected), page, x0, y0, x1, y1)
}

/// [`blocks_in_rect`] against an already-placed document (issue 025 cache surface) — the marquee path.
/// The wasm `HwpDoc` calls this with its cached `PlacedDoc` on pointer-up so a rubber-band select does
/// not re-typeset. `doc` is still needed for each block's model text/editable read-back.
pub fn blocks_in_rect_placed(
    doc: &SemanticDoc,
    placed: &PlacedDoc,
    page: u32,
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
) -> Vec<BlockHitDto> {
    let Some(pg) = placed.pages.get(page as usize) else {
        return Vec::new();
    };
    let k = HWPUNIT_PER_PX;
    // Normalize the (possibly reversed) corners, then px → HWPUNIT (place_doc space).
    let (rx0, rx1) = (x0.min(x1) * k, x0.max(x1) * k);
    let (ry0, ry1) = (y0.min(y1) * k, y0.max(y1) * k);
    let mut seen: std::collections::BTreeSet<(usize, usize)> = std::collections::BTreeSet::new();
    let mut out: Vec<BlockHitDto> = Vec::new();
    for b in &pg.blocks {
        // 2-D AABB overlap: the band [b.x, b.x+b.w] × [b.y, b.y+b.h] intersects the rect.
        let overlaps = b.x <= rx1 && b.x + b.w >= rx0 && b.y <= ry1 && b.y + b.h >= ry0;
        if !overlaps {
            continue;
        }
        if !seen.insert((b.section, b.block)) {
            continue; // one chip per block even if it somehow bands twice on a page
        }
        let kind = match b.kind {
            hwp_typeset::BlockKind::Paragraph => "paragraph",
            hwp_typeset::BlockKind::Table => "table",
            hwp_typeset::BlockKind::Image => "image",
        };
        out.push(BlockHitDto {
            section: b.section,
            block: b.block,
            kind: kind.into(),
            x: b.x / k,
            y: b.y / k,
            w: b.w / k,
            h: b.h / k,
            text: if b.kind == hwp_typeset::BlockKind::Paragraph {
                model_para_text(doc, b.section, b.block)
            } else {
                String::new()
            },
            editable: b.kind == hwp_typeset::BlockKind::Paragraph
                && model_para_editable(doc, b.section, b.block),
        });
    }
    out
}

/// One step of a descending `CellPath` (issue 064 Tier-2) — the FE↔Rust wire twin of
/// `hwp_typeset::CellAddr`. `block` is a block index (top-level: the section block index; deeper: the
/// `Block::Table`'s index INSIDE the previous cell); `(row, col)` is that table's `edit_target` cell
/// address. `Deserialize` too (the `SetTableCell`/`SetTableCellRuns` write path carries a path back).
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct CellAddrDto {
    pub block: usize,
    pub row: usize,
    pub col: usize,
}

impl From<&hwp_typeset::CellAddr> for CellAddrDto {
    fn from(a: &hwp_typeset::CellAddr) -> Self {
        CellAddrDto {
            block: a.block,
            row: a.row,
            col: a.col,
        }
    }
}

/// Walk a descending `CellPath` from `section`'s blocks to the LEAF cell (issue 064 Tier-2). Level 0
/// resolves `section.blocks[path[0].block].edit_target()` (unwrapping a 자가진단표 frame wrapper — the
/// SAME unwrap the top-level render does); each deeper level indexes the RAW `Block::Table` at
/// `blocks[addr.block]` inside the previous cell (mirroring `place_nested_table`, which draws nested
/// tables un-unwrapped). A length-1 path is exactly the plain top-level cell → 100% back-compat. `None`
/// when any step doesn't resolve (bad index / not-a-table / covered cell).
fn resolve_cell_path<'a>(
    doc: &'a SemanticDoc,
    section: usize,
    path: &[CellAddrDto],
) -> Option<&'a hwp_model::prelude::Cell> {
    use hwp_model::prelude::Block;
    let sec = doc.sections.get(section)?;
    let (first, rest) = path.split_first()?;
    let Block::Table(t) = sec.blocks.get(first.block)? else {
        return None;
    };
    let t = t.edit_target(); // level 0: unwrap a 1×1 frame wrapper, as place_doc did
    let mut cell = t
        .cells
        .iter()
        .find(|c| c.active && c.row == first.row && c.col == first.col)?;
    for addr in rest {
        let Block::Table(nt) = cell.blocks.get(addr.block)? else {
            return None;
        };
        // Deeper levels: RAW nested table (no edit_target) — matches place_nested_table's drawn coords.
        cell = nt
            .cells
            .iter()
            .find(|c| c.active && c.row == addr.row && c.col == addr.col)?;
    }
    Some(cell)
}

/// The table CELL the user double-clicked: its table anchor `(section, block)`, the cell `(row, col)`,
/// the table's `(rows, cols)`, the cell's CURRENT text, and its PX box (own SVG space).
#[derive(serde::Serialize)]
pub struct CellHitDto {
    pub section: usize,
    pub block: usize,
    pub row: usize,
    pub col: usize,
    pub rows: usize,
    pub cols: usize,
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// True when the resolved LEAF cell contains a NESTED table (`Block::Table` among its blocks). With
    /// Tier-2 a nested cell is EDITABLE (via `path`), so the UI no longer refuses it — this flag now just
    /// tells a consumer the cell has a further nested grid inside (the deepest reachable level reads
    /// `false`). Retained for back-compat with Tier-1 consumers.
    pub nested: bool,
    /// The DESCENDING `CellPath` to this (possibly nested) cell (issue 064 Tier-2). Level 0 is the
    /// top-level table cell; each deeper entry indexes the nested `Block::Table` inside the previous
    /// cell. A length-1 path equals the flat `(section, block, row, col)` above (the leaf) → 100%
    /// back-compat for a non-nested doc. The write path (`SetTableCellRuns` + `Op::SetTableCell`) walks
    /// this to reach the LEAF cell.
    pub path: Vec<CellAddrDto>,
}

/// Join a table cell's paragraphs into plain text — multiple paragraphs joined with '\n' so a
/// multi-line cell reads back readably (the layout engine renders a '\n' inside a run as a forced line
/// break, so an edit round-trips). The SHARED readback used by both the cell-hit chip
/// ([`table_cell_at_placed`], via the resolved leaf cell) and the AI grid ([`table_grid`]).
fn cell_plain_text(cell: &hwp_model::prelude::Cell) -> String {
    use hwp_model::prelude::{Block, Inline};
    let mut paras: Vec<String> = Vec::new();
    for b in &cell.blocks {
        if let Block::Paragraph(p) = b {
            let mut line = String::new();
            for r in &p.runs {
                for i in &r.content {
                    if let Inline::Text(s) = i {
                        line.push_str(s);
                    }
                }
            }
            paras.push(line);
        }
    }
    paras.join("\n")
}

// (issue 064 Tier-2) The cell's text + nested-table flag are now read straight off the LEAF cell that
// `resolve_cell_path` returns (see `table_cell_at_placed`), so the earlier level-0-only `model_cell_text`
// / `model_cell_has_nested_table` helpers are gone — the path reaches nested cells the flat lookup missed.

/// One ACTIVE (uncovered) cell of a marked table's grid (issue 066): its MODEL-GLOBAL `(row, col)`
/// address + current plain text. The address is the SAME space [`hwp_ops::Op::SetTableCell`] writes
/// (see [`table_grid`] §좌표계), so an AI fill/target lands on the intended cell.
#[derive(serde::Serialize)]
pub struct GridCellDto {
    pub row: usize,
    pub col: usize,
    pub text: String,
}

/// The full cell grid of the table BLOCK at `(section, block)` — its `rows`×`cols` plus every ACTIVE
/// (uncovered) cell's `(row, col, text)`, read straight from the MODEL (no placement, no fonts). The
/// doc-context source for vibe table editing (issue 066): the model needs to SEE each cell's address +
/// current text (which are label cells, which are blank) to fill or target cells correctly — the thin
/// anchor-only context (`text=""`) left it blind, so "표 채워줘" produced zero edits.
///
/// §좌표계 정합 (issue 066 §함정): unwraps via `edit_target()` (a 1×1 프레임 wrapper 자가진단표 → the
/// inner table), the SAME unwrapping `SetTableCell` / `resolve_cell_path` / `table_col_boundaries` do, so
/// the `(row, col)` the model READS here equals the address an edit WRITES. Rows/cols are MODEL-GLOBAL:
/// split-table fragments are a placement concept and never enter here (the model table carries every
/// row), so this is fragment-free by construction. Covered/merged slots are ABSENT — only their origin
/// cell (which holds the text) is listed, exactly like the coverage the edit ops see. Returns `None`
/// when `(section, block)` is out of range or the block is not a table.
#[derive(serde::Serialize)]
pub struct TableGridDto {
    pub section: usize,
    pub block: usize,
    pub rows: usize,
    pub cols: usize,
    pub cells: Vec<GridCellDto>,
}

/// Read the cell grid of the table block at `(section, block)` for the AI doc-context (issue 066). See
/// [`TableGridDto`] for the coordinate contract. Pure model read — no geometry, so it is cheap and
/// works identically on binary `.hwp` and HWPX.
pub fn table_grid(doc: &SemanticDoc, section: usize, block: usize) -> Option<TableGridDto> {
    use hwp_model::prelude::Block;
    let sec = doc.sections.get(section)?;
    let Block::Table(t) = sec.blocks.get(block)? else {
        return None;
    };
    let t = t.edit_target(); // frame wrapper (자가진단표) → the inner table SetTableCell edits
    let (rows, cols) = (t.rows.max(1), t.cols.max(1));
    let cells = t
        .cells
        .iter()
        .filter(|c| c.active && c.row < rows && c.col < cols)
        .map(|c| GridCellDto {
            row: c.row,
            col: c.col,
            text: cell_plain_text(c),
        })
        .collect();
    Some(TableGridDto {
        section,
        block,
        rows,
        cols,
        cells,
    })
}

/// Click-to-edit (own-render only): the table cell under a page-space double-click, in own-render px
/// geometry. `None` when the point isn't over any table cell.
pub fn table_cell_at(doc: &SemanticDoc, page: u32, x: f64, y: f64) -> Option<CellHitDto> {
    table_cell_at_placed(doc, &place(doc, &[]), page, x, y)
}

/// [`table_cell_at`] against an already-placed document (issue 025 cache surface). Takes BOTH `placed`
/// (geometry) and `doc` (the cell text read-back), so the wasm `HwpDoc` serves cell-marking clicks from
/// its cached `PlacedDoc`. `row`/`col` stay MODEL-GLOBAL (do NOT re-add `first_row` on a split fragment).
pub fn table_cell_at_placed(
    doc: &SemanticDoc,
    placed: &PlacedDoc,
    page: u32,
    x: f64,
    y: f64,
) -> Option<CellHitDto> {
    let pg = placed.pages.get(page as usize)?;
    let k = HWPUNIT_PER_PX;
    let (hx, hy) = (x * k, y * k); // px click → HWPUNIT
                                   // Topmost table containing the point, then the cell within it.
    let t = pg
        .tables
        .iter()
        .rfind(|t| hx >= t.x && hx <= t.x + t.w && hy >= t.y && hy <= t.y + t.h)?;
    let cell = t.cell_at(hx, hy)?;
    // The full DESCENDING CellPath to this (possibly nested) LEAF cell (issue 064 Tier-2): the placed
    // table's ancestor cells + this table's own `(self_block, row, col)`. For a top-level table `ancestors`
    // is empty and `self_block == block`, so the path is the length-1 `[{block, row, col}]` — 100%
    // back-compat. The topmost `rfind` above already picks the INNERMOST table (its `PlacedTable` was
    // pushed after the outer one), so a click in a nested grid lands on the nested leaf naturally.
    let mut path: Vec<CellAddrDto> = t.ancestors.iter().map(CellAddrDto::from).collect();
    path.push(CellAddrDto {
        block: t.self_block,
        row: cell.row,
        col: cell.col,
    });
    // Read the LEAF cell's text + nested flag straight off the resolved cell (the path walks through
    // nesting; the flat `model_cell_text` only reaches level 0). Fallback keeps the length-1 behavior.
    let leaf = resolve_cell_path(doc, t.section, &path);
    let text = leaf.map(cell_plain_text).unwrap_or_default();
    let nested = leaf
        .map(|c| {
            c.blocks
                .iter()
                .any(|b| matches!(b, hwp_model::prelude::Block::Table(_)))
        })
        .unwrap_or(false);
    Some(CellHitDto {
        section: t.section,
        block: t.block,
        row: cell.row,
        col: cell.col,
        rows: t.rows,
        cols: t.cols,
        text,
        x: cell.x / k,
        y: cell.y / k,
        w: cell.w / k,
        h: cell.h / k,
        nested,
        path,
    })
}

/// [`table_cell_at`] measured with CALLER-INJECTED font bytes (issue 022/023) — the wasm/web path where
/// a registered font changed the pagination, so the CELL geometry MUST agree with the injected-metric
/// SVG (and with `table_at_with`/`own_hit_test_with`) or a click resolves to the wrong cell / misses.
/// 022 added the `_with` metric variants for `table_at`/`own_hit_test`/`blocks_in_rect` but not for the
/// cell hit; this is the missing member of that family (additive — no new geometry logic). Empty slice →
/// byte-identical to [`table_cell_at`]. `row`/`col` remain MODEL-GLOBAL (PlacedCell.row is global even in
/// a split fragment — do NOT re-add `first_row`, issue §좌표계).
pub fn table_cell_at_with(
    doc: &SemanticDoc,
    page: u32,
    x: f64,
    y: f64,
    injected: &[(String, Vec<u8>)],
) -> Option<CellHitDto> {
    table_cell_at_placed(doc, &place(doc, injected), page, x, y)
}

/// The PX box (own SVG space) + page of the cell at `(section, block, row, col)`, looked up BY ADDRESS
/// (not by point) across all pages — so the active-cell ring can be re-placed against FRESH geometry
/// after an edit GROWS the row. `None` if the cell isn't placed (degenerate/covered cell).
#[derive(serde::Serialize)]
pub struct CellBox {
    pub page: u32,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

pub fn table_cell_box(
    doc: &SemanticDoc,
    section: usize,
    block: usize,
    row: usize,
    col: usize,
) -> Option<CellBox> {
    table_cell_box_placed(&place(doc, &[]), section, block, row, col)
}

/// [`table_cell_box`] against an already-placed document (issue 025 cache surface).
pub fn table_cell_box_placed(
    placed: &PlacedDoc,
    section: usize,
    block: usize,
    row: usize,
    col: usize,
) -> Option<CellBox> {
    let k = HWPUNIT_PER_PX;
    for (pi, pg) in placed.pages.iter().enumerate() {
        for t in pg
            .tables
            .iter()
            .filter(|t| t.section == section && t.block == block)
        {
            if let Some(cell) = t.cells.iter().find(|c| c.row == row && c.col == col) {
                return Some(CellBox {
                    page: pi as u32,
                    x: cell.x / k,
                    y: cell.y / k,
                    w: cell.w / k,
                    h: cell.h / k,
                });
            }
        }
    }
    None
}

// ---- Cell-addressed caret (issue 053 — CARET-GAP §5 P1) ----------------------------------------

/// Cell-addressed caret rect DTO (own-render PX + the 0-based page the owning fragment landed on).
/// Geometry comes from the SAME `place_doc` output the visible SVG was drawn from, so the caret can
/// never drift from the screen (bypasses the own-render↔rhwp page divergence, CARET-GAP §3†).
#[derive(serde::Serialize)]
pub struct CellCaretDto {
    pub page: u32,
    pub x: f64,
    pub top: f64,
    pub height: f64,
}

/// A click resolved to a CELL TEXT caret target (own-render PX): the cell address `(section, block,
/// row, col)` (row/col MODEL-GLOBAL), the paragraph ordinal `para` among the cell's paragraphs (the
/// SAME order [`block_runs`] joins with "\n"), the char `offset` within it, `para_len` (the clamp
/// bound), and the caret geometry at the resolved offset.
#[derive(serde::Serialize)]
pub struct CellTextHitDto {
    pub section: usize,
    pub block: usize,
    pub row: usize,
    pub col: usize,
    pub para: usize,
    pub offset: usize,
    pub para_len: usize,
    pub caret: CellCaretDto,
}

fn cell_caret_dto(r: hwp_typeset::CellCaretRect) -> CellCaretDto {
    let k = HWPUNIT_PER_PX;
    CellCaretDto {
        page: r.page as u32,
        x: r.x / k,
        top: r.top / k,
        height: r.height / k,
    }
}

/// Cell-addressed caret rect (issue 053): the caret geometry at `(section, block, row, col, para,
/// offset)` in own-render PX, or `None` when the address doesn't resolve (018 null policy). A
/// past-end `offset` CLAMPS to the paragraph end and returns a rect — never `None` for it.
pub fn cell_caret_rect(
    doc: &SemanticDoc,
    section: usize,
    block: usize,
    row: usize,
    col: usize,
    para: usize,
    offset: usize,
) -> Option<CellCaretDto> {
    let fonts = own_render_fonts();
    let placed = hwp_typeset::place_doc(doc, fonts.as_ref());
    cell_caret_rect_placed(
        doc,
        &placed,
        fonts.as_ref(),
        section,
        block,
        row,
        col,
        para,
        offset,
    )
}

/// [`cell_caret_rect`] against an already-placed document (issue 025 cache surface). Pass the SAME
/// `fonts` provider `placed` was built with (advance re-derivation must match the drawn glyphs).
#[allow(clippy::too_many_arguments)]
pub fn cell_caret_rect_placed(
    doc: &SemanticDoc,
    placed: &PlacedDoc,
    fonts: &dyn hwp_model::prelude::FontMetricsProvider,
    section: usize,
    block: usize,
    row: usize,
    col: usize,
    para: usize,
    offset: usize,
) -> Option<CellCaretDto> {
    hwp_typeset::cell_caret_rect(doc, placed, fonts, section, block, row, col, para, offset)
        .map(cell_caret_dto)
}

/// Cell text hit (issue 053): resolve a PAGE-LOCAL px click to the cell-text caret target under it —
/// the cell-addressed twin of the NodeId `HitTest`, covering the `in_cell → node:None` gap
/// (docs/CARET-GAP.md §2). `None` off any table cell (018 null policy).
pub fn cell_text_hit(doc: &SemanticDoc, page: u32, x: f64, y: f64) -> Option<CellTextHitDto> {
    let fonts = own_render_fonts();
    let placed = hwp_typeset::place_doc(doc, fonts.as_ref());
    cell_text_hit_placed(doc, &placed, fonts.as_ref(), page, x, y)
}

/// [`cell_text_hit`] against an already-placed document (issue 025 cache surface). Pass the SAME
/// `fonts` provider `placed` was built with.
pub fn cell_text_hit_placed(
    doc: &SemanticDoc,
    placed: &PlacedDoc,
    fonts: &dyn hwp_model::prelude::FontMetricsProvider,
    page: u32,
    x: f64,
    y: f64,
) -> Option<CellTextHitDto> {
    let k = HWPUNIT_PER_PX;
    hwp_typeset::cell_text_hit(doc, placed, fonts, page as usize, x * k, y * k).map(|h| {
        CellTextHitDto {
            section: h.section,
            block: h.block,
            row: h.row,
            col: h.col,
            para: h.para,
            offset: h.offset,
            para_len: h.para_len,
            caret: cell_caret_dto(h.caret),
        }
    })
}

/// Column-boundary x-positions (PX, own SVG space) of the table at `(section, block)` on `page` — the
/// x's the column-resize handles are drawn on. `cols + 1` absolute px boundaries from the table left to
/// the table right, derived from `column_offsets` so they land exactly on the drawn grid. `None` if the
/// table isn't on the page.
pub fn table_col_boundaries(
    doc: &SemanticDoc,
    page: u32,
    section: usize,
    block: usize,
) -> Option<Vec<f64>> {
    table_col_boundaries_placed(doc, &place(doc, &[]), page, section, block)
}

/// [`table_col_boundaries`] against an already-placed document (issue 025 cache surface). `doc` is still
/// read for the model table's `column_offsets`.
pub fn table_col_boundaries_placed(
    doc: &SemanticDoc,
    placed: &PlacedDoc,
    page: u32,
    section: usize,
    block: usize,
) -> Option<Vec<f64>> {
    let pg = placed.pages.get(page as usize)?;
    let pt = pg
        .tables
        .iter()
        .find(|t| t.section == section && t.block == block)?;
    let hwp_model::prelude::Block::Table(model) = doc
        .sections
        .get(section)
        .and_then(|s| s.blocks.get(block))?
    else {
        return None;
    };
    let model = model.edit_target(); // a frame wrapper (자가진단표) → the inner table the grid drew
    let k = HWPUNIT_PER_PX;
    // column_offsets rescales the model col_widths to the table's drawn width (pt.w), so the boundary
    // x's match the painted grid exactly. Absolute px = (table-left + col_x) / 75.
    let col_x = hwp_typeset::column_offsets(model, pt.w);
    Some(col_x.iter().map(|x| (pt.x + x) / k).collect())
}

/// Row-resize geometry (own-render only) — `rows + 1` absolute px y-boundaries of the `block`-th table
/// on `page`, top→bottom, for the row-height drag handles. `None` when the table isn't on the page.
pub fn table_row_boundaries(
    doc: &SemanticDoc,
    page: u32,
    section: usize,
    block: usize,
) -> Option<Vec<f64>> {
    let fonts = own_render_fonts();
    let placed = hwp_typeset::place_doc(doc, fonts.as_ref());
    table_row_boundaries_placed(doc, &placed, fonts.as_ref(), page, section, block)
}

/// [`table_row_boundaries`] against an already-placed document (issue 025 cache surface). Unlike the
/// other `_placed` queries this ALSO needs the `fonts` provider, because `row_offsets` re-measures the
/// row content heights the same way `place_table` drew them — pass the SAME provider `placed` was built
/// with, or the boundaries won't line up with the painted grid.
pub fn table_row_boundaries_placed(
    doc: &SemanticDoc,
    placed: &PlacedDoc,
    fonts: &dyn hwp_model::prelude::FontMetricsProvider,
    page: u32,
    section: usize,
    block: usize,
) -> Option<Vec<f64>> {
    let pg = placed.pages.get(page as usize)?;
    let pt = pg
        .tables
        .iter()
        .find(|t| t.section == section && t.block == block)?;
    let hwp_model::prelude::Block::Table(model) = doc
        .sections
        .get(section)
        .and_then(|s| s.blocks.get(block))?
    else {
        return None;
    };
    let model = model.edit_target(); // frame wrapper (자가진단표) → the inner table the grid drew
    let k = HWPUNIT_PER_PX;
    // row_offsets measures content (+ any row_heights override) the SAME way place_table draws, so
    // the boundary y's line up with the painted rows. A SPLIT table's `pt` is the per-page FRAGMENT,
    // so slice row_offsets to the fragment's [first_row, last_row] and rebase to the fragment top —
    // otherwise the whole-table rows would be squashed onto one fragment's box. For a single-fragment
    // table (first_row=0, last_row=rows) this is identical to the full set.
    let row_y = hwp_typeset::row_offsets(model, pt.w, doc, fonts);
    let (f, l) = (pt.first_row, pt.last_row);
    if f >= l || l >= row_y.len() {
        return None;
    }
    let base = row_y[f];
    let frag_total = row_y[l] - base;
    let scale = if frag_total > 0.0 {
        pt.h / frag_total
    } else {
        1.0
    };
    Some(
        row_y[f..=l]
            .iter()
            .map(|y| (pt.y + (y - base) * scale) / k)
            .collect(),
    )
}

/// Page geometry in CSS px (own-render only): the page box + the printable-area margins of `page`, for
/// the editor chrome (한글식 모서리 영역 표시 + 줄자). All values are px (HWPUNIT / 75). `None` when the
/// page is out of range.
#[derive(serde::Serialize)]
pub struct PageGeom {
    pub w: f64,
    pub h: f64,
    pub ml: f64,
    pub mt: f64,
    pub mr: f64,
    pub mb: f64,
}

pub fn page_geometry(doc: &SemanticDoc, page: u32) -> Option<PageGeom> {
    page_geometry_placed(&place(doc, &[]), page)
}

/// [`page_geometry`] against an already-placed document (issue 025 cache surface).
pub fn page_geometry_placed(placed: &PlacedDoc, page: u32) -> Option<PageGeom> {
    let pg = placed.pages.get(page as usize)?;
    let k = HWPUNIT_PER_PX;
    Some(PageGeom {
        w: pg.width / k,
        h: pg.height / k,
        ml: pg.margin_left / k,
        mt: pg.margin_top / k,
        mr: pg.margin_right / k,
        mb: pg.margin_bottom / k,
    })
}

// ---- Character-format / styled-run reads ------------------------------------------------------

/// The CURRENT character format of a target's first run — so the manual format bar can show + toggle
/// the right state. `None` if the target/run can't be resolved.
#[derive(serde::Serialize)]
pub struct CharFmt {
    pub bold: bool,
    pub italic: bool,
    pub size_pt: f32,
    pub font: Option<String>,
    pub color: Option<String>,
}

/// Read the first run's char format of the `block`-th paragraph (row/col `None`) or the `(row, col)`
/// cell of that table. `None` if the target/run can't be resolved.
pub fn char_fmt(
    doc: &SemanticDoc,
    section: usize,
    block: usize,
    row: Option<usize>,
    col: Option<usize>,
) -> Option<CharFmt> {
    use hwp_model::prelude::Block;
    let sec = doc.sections.get(section)?;
    let blk = sec.blocks.get(block)?;
    let first_run_shape = match (blk, row, col) {
        (Block::Paragraph(p), None, None) => p.runs.first().map(|r| r.char_shape),
        (Block::Table(t), Some(r), Some(c)) => t
            .edit_target()
            .cells
            .iter()
            .find(|cell| cell.active && cell.row == r && cell.col == c)
            .and_then(|cell| {
                cell.blocks.iter().find_map(|b| match b {
                    Block::Paragraph(p) => p.runs.first().map(|run| run.char_shape),
                    _ => None,
                })
            }),
        _ => None,
    };
    let idx = first_run_shape?;
    let sh = doc.char_shapes.get(idx).cloned().unwrap_or_default();
    let default_color = hwp_model::prelude::CharShape::default().text_color;
    Some(CharFmt {
        bold: sh.bold,
        italic: sh.italic,
        size_pt: if sh.height > 0 {
            sh.height as f32 / 100.0
        } else {
            10.0
        },
        font: sh.font_family.clone(),
        color: if sh.text_color == default_color {
            None
        } else {
            Some(sh.text_color.to_hex())
        },
    })
}

/// FE↔Rust wire type for a STYLED text run — the WYSIWYG editor reads a block's runs ([`block_runs`])
/// to render styled spans, and writes them back (via the run-based table-cell / paragraph commits).
#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
pub struct RunDto {
    pub text: String,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub italic: bool,
    #[serde(default)]
    pub underline: bool,
    #[serde(default)]
    pub strike: bool,
    #[serde(default)]
    pub size_pt: Option<f32>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub highlight: Option<String>,
    #[serde(default)]
    pub font: Option<String>,
}
impl RunDto {
    pub fn to_run_spec(&self) -> hwp_ops::RunSpec {
        hwp_ops::RunSpec {
            text: self.text.clone(),
            bold: self.bold,
            italic: self.italic,
            underline: self.underline,
            strike: self.strike,
            size_pt: self.size_pt,
            color: self.color.clone(),
            highlight: self.highlight.clone(),
            font: self.font.clone(),
        }
    }
}

/// Convert a slice of [`RunDto`] (the WYSIWYG editor's wire form) into op-bus [`hwp_ops::RunSpec`]s —
/// the ONLY transform the run-commit commands need before delegating to the op-bus.
pub fn run_specs(runs: &[RunDto]) -> Vec<hwp_ops::RunSpec> {
    runs.iter().map(RunDto::to_run_spec).collect()
}

/// Append one paragraph's styled runs (per-run char shapes) to `out` — the shared reader behind
/// [`block_runs`]/[`block_runs_path`] so the WYSIWYG editor renders each run as a styled span.
fn push_para_runs(doc: &SemanticDoc, p: &hwp_model::prelude::Paragraph, out: &mut Vec<RunDto>) {
    use hwp_model::prelude::{CharShape, Inline};
    let default_color = CharShape::default().text_color;
    for run in &p.runs {
        let sh = doc
            .char_shapes
            .get(run.char_shape)
            .cloned()
            .unwrap_or_default();
        let text: String = run
            .content
            .iter()
            .filter_map(|i| {
                if let Inline::Text(t) = i {
                    Some(t.as_str())
                } else {
                    None
                }
            })
            .collect();
        out.push(RunDto {
            text,
            bold: sh.bold,
            italic: sh.italic,
            underline: sh.underline,
            strike: sh.strikeout,
            size_pt: if sh.height > 0 {
                Some(sh.height as f32 / 100.0)
            } else {
                None
            },
            color: if sh.text_color == default_color {
                None
            } else {
                Some(sh.text_color.to_hex())
            },
            highlight: None,
            font: sh.font_family.clone(),
        });
    }
}

/// All styled runs of a resolved cell (its paragraphs joined by a `\n` run — parity with the cell-text
/// reader). The nesting-agnostic core: `block_runs`/`block_runs_path` differ only in how they RESOLVE
/// the cell (flat vs descending path).
fn cell_runs(doc: &SemanticDoc, cell: &hwp_model::prelude::Cell) -> Vec<RunDto> {
    use hwp_model::prelude::Block;
    let mut out: Vec<RunDto> = Vec::new();
    let mut first = true;
    for b in &cell.blocks {
        if let Block::Paragraph(p) = b {
            if !first {
                out.push(RunDto {
                    text: "\n".into(),
                    ..Default::default()
                });
            }
            push_para_runs(doc, p, &mut out);
            first = false;
        }
    }
    out
}

/// Read ALL styled runs of a target paragraph/cell (per-run shapes) so the WYSIWYG editor can render
/// them as styled spans. Unlike [`char_fmt`] (first run only), this returns every run. A multi-paragraph
/// cell's paragraphs are joined by a `\n` run (parity with the cell-text reader). The `(row, col)` cell
/// case is the length-1 fast path of [`block_runs_path`] (issue 064 Tier-2) — a nested LEAF cell prefills
/// via `block_runs_path` with its full `CellPath`.
pub fn block_runs(
    doc: &SemanticDoc,
    section: usize,
    block: usize,
    row: Option<usize>,
    col: Option<usize>,
) -> Vec<RunDto> {
    use hwp_model::prelude::Block;
    match (row, col) {
        // A cell target → the length-1 descending path (edit_target unwrap happens inside).
        (Some(r), Some(c)) => block_runs_path(
            doc,
            section,
            &[CellAddrDto {
                block,
                row: r,
                col: c,
            }],
        ),
        // A paragraph target (row/col omitted).
        _ => {
            let Some(Block::Paragraph(p)) =
                doc.sections.get(section).and_then(|s| s.blocks.get(block))
            else {
                return Vec::new();
            };
            let mut out = Vec::new();
            push_para_runs(doc, p, &mut out);
            out
        }
    }
}

/// [`block_runs`] for a (possibly NESTED) cell addressed by its descending `CellPath` (issue 064 Tier-2).
/// Walks the path to the LEAF cell ([`resolve_cell_path`]) and reads its runs, so the inline editor
/// prefills a nested cell's text/style. A length-1 path is exactly the flat `(section, block, row, col)`
/// cell → back-compat with [`block_runs`]. Empty when the path doesn't resolve.
pub fn block_runs_path(doc: &SemanticDoc, section: usize, path: &[CellAddrDto]) -> Vec<RunDto> {
    match resolve_cell_path(doc, section, path) {
        Some(cell) => cell_runs(doc, cell),
        None => Vec::new(),
    }
}

/// The target cell/paragraph's BACKGROUND fill + horizontal alignment + per-paragraph indent — the
/// WYSIWYG inline editor paints itself to MATCH the original (shaded cell stays shaded, centered header
/// stays centered, numbered list keeps its indent) instead of a plain white left-aligned box.
#[derive(serde::Serialize)]
pub struct BlockStyleDto {
    /// Cell fill as "#RRGGBB" (None = no fill / a paragraph → the white page background).
    pub shade: Option<String>,
    /// Horizontal text alignment: "left" | "center" | "right" | "justify".
    pub align: String,
    /// Paragraph indent geometry in HWPUNIT (mirrors the FIRST paragraph — back-compat single-para path).
    pub indent_left: i32,
    pub indent_first: i32,
    pub indent_right: i32,
    /// PER-PARAGRAPH style, one entry per paragraph in the SAME order [`block_runs`] emits them
    /// (a cell's paragraphs joined by standalone "\n" runs), so each editor block keeps its own indent.
    pub paragraphs: Vec<ParaStyleDto>,
}

/// One paragraph's indent (HWPUNIT) + alignment — the per-paragraph half of [`BlockStyleDto`].
#[derive(serde::Serialize)]
pub struct ParaStyleDto {
    pub indent_left: i32,
    pub indent_first: i32,
    pub indent_right: i32,
    pub align: String,
}

/// One paragraph's [`ParaStyleDto`] (align + indent, HWPUNIT) — the shared unit behind
/// [`block_style`]/[`block_style_path`]. Mirrors `hwp_typeset::place::indent_of`'s clamping so the
/// editor's inset matches the placed glyphs.
fn para_style_dto(doc: &SemanticDoc, p: &hwp_model::prelude::Paragraph) -> ParaStyleDto {
    use hwp_model::prelude::HorizontalAlign;
    let align = match doc
        .para_shapes
        .get(p.para_shape)
        .map(|ps| ps.align)
        .unwrap_or_default()
    {
        HorizontalAlign::Left => "left",
        HorizontalAlign::Right => "right",
        HorizontalAlign::Center => "center",
        _ => "justify", // Justify (양쪽, default) / Distribute / DistributeSpace
    }
    .to_string();
    let ps = doc.para_shapes.get(p.para_shape);
    let left = ps.map(|s| s.left_margin).unwrap_or(0).max(0);
    let right = ps.map(|s| s.right_margin).unwrap_or(0).max(0);
    let indent = ps.map(|s| s.indent).unwrap_or(0);
    let first = indent.max(-left); // 들여(+)/내어(−)쓰기, clamped so line 0 never crosses the inset
    ParaStyleDto {
        indent_left: left,
        indent_first: first,
        indent_right: right,
        align,
    }
}

/// The first paragraph drives the back-compat single-indent fields + the container alignment.
fn finalize_block_style(dto: &mut BlockStyleDto) {
    if let Some(first) = dto.paragraphs.first() {
        dto.align = first.align.clone();
        dto.indent_left = first.indent_left;
        dto.indent_first = first.indent_first;
        dto.indent_right = first.indent_right;
    }
}

/// A resolved cell's [`BlockStyleDto`] (shade + per-paragraph style). SAME paragraph iteration as
/// [`cell_runs`] so `paragraphs[i]` aligns with the i-th editor block (lockstep — an off-by-one would
/// mis-indent every later line).
fn cell_block_style(doc: &SemanticDoc, cell: &hwp_model::prelude::Cell) -> BlockStyleDto {
    use hwp_model::prelude::Block;
    let mut dto = BlockStyleDto {
        shade: cell.shade_color.map(|c| c.to_hex()),
        align: "justify".into(),
        indent_left: 0,
        indent_first: 0,
        indent_right: 0,
        paragraphs: Vec::new(),
    };
    for b in &cell.blocks {
        if let Block::Paragraph(p) = b {
            dto.paragraphs.push(para_style_dto(doc, p));
        }
    }
    finalize_block_style(&mut dto);
    dto
}

pub fn block_style(
    doc: &SemanticDoc,
    section: usize,
    block: usize,
    row: Option<usize>,
    col: Option<usize>,
) -> BlockStyleDto {
    use hwp_model::prelude::Block;
    match (row, col) {
        // A cell target → the length-1 descending path (edit_target unwrap happens inside).
        (Some(r), Some(c)) => block_style_path(
            doc,
            section,
            &[CellAddrDto {
                block,
                row: r,
                col: c,
            }],
        ),
        // A paragraph target (row/col omitted).
        _ => {
            let mut dto = BlockStyleDto {
                shade: None,
                align: "justify".into(),
                indent_left: 0,
                indent_first: 0,
                indent_right: 0,
                paragraphs: Vec::new(),
            };
            if let Some(Block::Paragraph(p)) =
                doc.sections.get(section).and_then(|s| s.blocks.get(block))
            {
                dto.paragraphs.push(para_style_dto(doc, p));
            }
            finalize_block_style(&mut dto);
            dto
        }
    }
}

/// [`block_style`] for a (possibly NESTED) cell addressed by its descending `CellPath` (issue 064
/// Tier-2). Walks to the LEAF cell ([`resolve_cell_path`]) so the inline editor paints a nested cell's
/// shade/align/indent. A length-1 path is the flat `(section, block, row, col)` cell → back-compat.
pub fn block_style_path(doc: &SemanticDoc, section: usize, path: &[CellAddrDto]) -> BlockStyleDto {
    match resolve_cell_path(doc, section, path) {
        Some(cell) => cell_block_style(doc, cell),
        None => {
            let mut dto = BlockStyleDto {
                shade: None,
                align: "justify".into(),
                indent_left: 0,
                indent_first: 0,
                indent_right: 0,
                paragraphs: Vec::new(),
            };
            finalize_block_style(&mut dto);
            dto
        }
    }
}

// ---- Export (HTML / PDF) ----------------------------------------------------------------------

/// Project the LIVE document to a self-contained HTML string via the JSX(content)/CSS(design) path:
/// `hwp_jsx::emit` → `hwp_export::emit_html`. Byte-identical to the CLI `export-html` and the in-app
/// HTML preview. `title` = the browser/document title (e.g. the file stem), or `None`.
pub fn emit_html(doc: &SemanticDoc, title: Option<String>) -> String {
    let proj = hwp_jsx::emit(doc);
    hwp_export::emit_html(&proj, &hwp_export::HtmlOptions { title })
}

/// Export the LIVE document to PDF bytes through OUR OWN engine (`place_doc` → PageLayerTree →
/// krilla), embedding a subset of the discovered Korean face. Under `shaper` the real rustybuzz
/// advances drive placement. Returns the krilla export result (bytes + page count + embedded font
/// path). Needs the `pdf` feature.
///
/// Native shells (viewer/CLI) call this — it forwards to [`emit_pdf_with_fonts`] with no injected
/// fonts, so the discover path (and its bytes) are unchanged.
#[cfg(feature = "pdf")]
pub fn emit_pdf(
    doc: &SemanticDoc,
    title: Option<String>,
) -> Result<hwp_export::pdf::PdfExport, String> {
    emit_pdf_with_fonts(doc, title, &[])
}

/// Like [`emit_pdf`], but threads CALLER-INJECTED font faces `(family, bytes)` all the way to krilla
/// (issue 018) — the wasm/web path where `std::fs` has no fonts. When `injected_fonts` is non-empty and
/// parseable, the injected face backs the glyphs; an empty slice takes the native discover path
/// unchanged. TTF/OTF single-face bytes only (a TTC collection isn't accepted by krilla's simple-text).
#[cfg(feature = "pdf")]
pub fn emit_pdf_with_fonts(
    doc: &SemanticDoc,
    title: Option<String>,
    injected_fonts: &[(String, Vec<u8>)],
) -> Result<hwp_export::pdf::PdfExport, String> {
    let fonts = own_render_fonts();
    hwp_export::pdf::export_pdf_with_fonts(
        doc,
        fonts.as_ref(),
        &hwp_export::pdf::PdfOptions { title },
        injected_fonts,
    )
}

// ---- Image insert (proposal builder + fs stash) -----------------------------------------------

/// Build a single-`InsertImage` [`hwp_ai::edit::EditScript`] anchored at the pointed target and
/// validate it into a [`hwp_ai::Proposal`] against the LIVE doc (the SAME op-bus path the AI uses).
/// Shared by the propose (chat, review-first) and apply (drag-drop, immediate) image-insert lanes.
pub fn build_insert_image_proposal(
    doc: &SemanticDoc,
    path: &std::path::Path,
    scope_section: Option<usize>,
    scope_block: Option<usize>,
    width_mm: Option<f32>,
    height_mm: Option<f32>,
) -> Result<hwp_ai::Proposal, String> {
    let (section, block, position) = match (scope_section, scope_block) {
        (Some(sec), Some(blk)) => (sec, blk, "after"),
        (Some(sec), None) => (sec, 0, "end"),
        _ => (0, 0, "end"),
    };
    let script = hwp_ai::edit::EditScript {
        edits: vec![serde_json::from_value(serde_json::json!({
            "op": "insert_image",
            "section": section,
            "block": block,
            "position": position,
            "path": path.to_string_lossy(),
            "width_mm": width_mm,
            "height_mm": height_mm,
        }))
        .map_err(|e| format!("이미지 편집 구성 실패: {e}"))?],
    };
    hwp_ai::propose_from_edit_script(doc, &script, "이미지 삽입").map_err(|e| e.to_string())
}

/// Shape a validated [`hwp_ai::Proposal`] into the structured JSON the chat panel renders: the
/// provider name (for the honest mock badge), the rationale prose, and one `ProposalOp` per op.
pub fn proposal_json(provider: &str, proposal: &hwp_ai::Proposal) -> Value {
    json!({
        "provider": provider,
        "rationale": proposal.rationale,
        "ops": proposal.structured_ops(),
    })
}

/// Materialize image bytes to a temp file the op-bus can read back, and return
/// `(temp_path, safe_basename)`. The bytes come from EITHER a base64 payload (`data_b64`, the
/// chat-attach lane) OR a source file `src_path` (a native OS drag-drop gives a path); exactly one
/// must be present. A sanitized basename keeps the extension. Needs the `fs` feature (touches disk).
#[cfg(feature = "fs")]
pub fn stash_image(
    name: &str,
    data_b64: Option<&str>,
    src_path: Option<&str>,
) -> Result<(std::path::PathBuf, String), String> {
    use base64::Engine as _;
    let bytes = match (data_b64, src_path) {
        (Some(b64), _) => base64::engine::general_purpose::STANDARD
            .decode(b64.as_bytes())
            .map_err(|e| format!("이미지 디코드 실패: {e}"))?,
        (None, Some(p)) => {
            std::fs::read(p).map_err(|e| format!("이미지 파일 읽기 실패: {p} — {e}"))?
        }
        (None, None) => return Err("이미지 데이터(dataB64) 또는 경로(srcPath)가 필요합니다".into()),
    };
    if bytes.is_empty() {
        return Err("빈 이미지입니다".into());
    }
    // A native drop carries the source path; prefer ITS basename for the visible name when given.
    let basis = src_path.filter(|_| data_b64.is_none()).unwrap_or(name);
    let safe: String = std::path::Path::new(basis)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("image.png")
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let dir = std::env::temp_dir().join("tfhwp_imgs");
    std::fs::create_dir_all(&dir).map_err(|e| format!("임시 폴더 생성 실패: {e}"))?;
    let path = dir.join(&safe);
    std::fs::write(&path, &bytes).map_err(|e| format!("이미지 저장 실패: {e}"))?;
    Ok((path, safe))
}

// ---- AI edit-scope directive ------------------------------------------------------------------

/// One structural edit ANCHOR the user marked in the viewer (issue #009), deserialized from the JSON
/// the UI passes. Coordinates are STRUCTURE indices (never pixels): `rows`/`cols` are inclusive GLOBAL
/// bounds addressing the live model table directly (same space as `hwp_ai::edit::EditCommand`).
#[derive(serde::Deserialize)]
pub struct AnchorDto {
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub section: usize,
    #[serde(default)]
    pub block: usize,
    #[serde(default)]
    pub rows: Option<[usize; 2]>,
    #[serde(default)]
    pub cols: Option<[usize; 2]>,
    #[serde(default)]
    pub label: String,
}

/// Turn the marked anchors into a Korean directive prepended to the user's instruction, telling the
/// model to edit ONLY those spots (with their exact `[s/b]` + row/col structure coords). Returns
/// `None` when the JSON is absent/empty/unparseable, so the caller falls back to the click-scope path.
pub fn anchor_directive(anchors_json: Option<&str>, instruction: &str) -> Option<String> {
    let list: Vec<AnchorDto> = serde_json::from_str(anchors_json?).ok()?;
    if list.is_empty() {
        return None;
    }
    let mut lines = String::new();
    for a in &list {
        let mut coord = format!("section={}, block={}", a.section, a.block);
        if let Some([r0, r1]) = a.rows {
            if r0 == r1 {
                coord.push_str(&format!(", row={r0}"));
            } else {
                coord.push_str(&format!(", row {r0}..={r1}"));
            }
        }
        if let Some([c0, c1]) = a.cols {
            if c0 == c1 {
                coord.push_str(&format!(", col={c0}"));
            } else {
                coord.push_str(&format!(", col {c0}..={c1}"));
            }
        }
        let label = if a.label.is_empty() {
            a.kind.as_str()
        } else {
            a.label.as_str()
        };
        lines.push_str(&format!(
            "- [s{}/b{}] {label} ({coord})\n",
            a.section, a.block
        ));
    }
    Some(format!(
        "[편집 대상 앵커 — 사용자가 문서에서 직접 지정한 위치입니다. 아래 앵커가 가리키는 곳만 편집하고, \
         다른 블록은 절대 건드리지 마세요. 좌표는 0부터 시작하는 구조 인덱스(섹션/블록/행/열)입니다:\n\
         {lines}]\n사용자 요청: {instruction}"
    ))
}

// ---- Table-fill header/shade guard (issue #011 "표 채우기") ------------------------------------

/// The set of rows that MUST NOT be overwritten by a "표 채우기" preset for the table at
/// `(section, block)`: the header row (row 0) plus every row that carries a background shade in the
/// live document. Detecting shade needs the doc, so this reads the model directly.
fn protected_rows(
    doc: &SemanticDoc,
    section: usize,
    block: usize,
) -> std::collections::BTreeSet<usize> {
    use hwp_model::document::Block;
    let mut rows = std::collections::BTreeSet::new();
    rows.insert(0); // the header row is always protected
    if let Some(Block::Table(t)) = doc.sections.get(section).and_then(|s| s.blocks.get(block)) {
        for cell in t
            .cells
            .iter()
            .filter(|c| c.active && c.shade_color.is_some())
        {
            rows.insert(cell.row);
        }
    }
    rows
}

/// Post-process guard (issue #011 "표 채우기"): the preset's prompt tells the model to preserve the
/// header row (row 0) and any 음영(shaded) row, but a prompt is not a guarantee. This makes the guard
/// STRUCTURAL — it drops every pending text-fill op (`Op::SetTableCell`) that targets a protected row
/// of a table the user marked, so a model that ignores the prompt still can never clobber a header or
/// shaded row. Formatting/shading ops are left untouched (they don't overwrite content). Reads the
/// marked anchors' `(section, block)` and returns how many writes were blocked (0 = nothing stripped),
/// so the caller can surface a note. No-op when no anchor rides along or the JSON is empty/unparseable.
pub fn protect_table_header_rows(
    doc: &SemanticDoc,
    ops: &mut Vec<hwp_ops::Op>,
    anchors_json: Option<&str>,
) -> usize {
    let Some(json) = anchors_json else { return 0 };
    let Ok(anchors): std::result::Result<Vec<AnchorDto>, _> = serde_json::from_str(json) else {
        return 0;
    };
    if anchors.is_empty() {
        return 0;
    }
    // Protected rows keyed by the anchored table's (section, block). A single marked table/range is the
    // common case, but several anchors are handled the same way.
    let mut guard: std::collections::HashMap<(usize, usize), std::collections::BTreeSet<usize>> =
        std::collections::HashMap::new();
    for a in &anchors {
        guard
            .entry((a.section, a.block))
            .or_insert_with(|| protected_rows(doc, a.section, a.block));
    }
    let before = ops.len();
    ops.retain(|op| match op {
        hwp_ops::Op::SetTableCell {
            section,
            index,
            row,
            ..
        } => !guard
            .get(&(*section, *index))
            .is_some_and(|rows| rows.contains(row)),
        _ => true,
    });
    before - ops.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use hwp_ops::{CellSel, CellSpec, Op, RunSpec};

    /// A section-0 doc whose block 1 is a 3-row × 2-col table (row 0 = header, rows 1–2 = body).
    fn doc_with_table() -> SemanticDoc {
        use hwp_model::document::{Block, Paragraph, Section};
        let mut doc = SemanticDoc {
            char_shapes: vec![Default::default()],
            para_shapes: vec![Default::default()],
            ..Default::default()
        };
        doc.sections.push(Section {
            blocks: vec![Block::Paragraph(Paragraph::default())],
            ..Default::default()
        });
        let cell = |t: &str| CellSpec {
            text: t.into(),
            ..Default::default()
        };
        hwp_ops::apply(
            &mut doc,
            &Op::InsertTableAt {
                section: 0,
                index: 1,
                rows: vec![
                    vec![cell("항목"), cell("내용")],
                    vec![cell(""), cell("")],
                    vec![cell(""), cell("")],
                ],
            },
        )
        .expect("seed table");
        doc
    }

    // ---- doc_profile (issue 067) ----

    /// The profile is a PURE MODEL read that sees the fixture's structure: 1 table (3×2, header
    /// 항목/내용), its cell paragraphs counted, and a to_markdown excerpt carrying the table grid.
    #[test]
    fn doc_profile_reads_fixture_structure() {
        let doc = doc_with_table();
        let p = doc_profile(&doc);
        assert_eq!(p.sections, 1);
        assert_eq!(p.table_count, 1);
        assert_eq!(p.tables.len(), 1);
        let t = &p.tables[0];
        assert_eq!((t.section, t.block, t.rows, t.cols), (0, 1, 3, 2));
        assert_eq!(t.header, vec!["항목".to_string(), "내용".to_string()]);
        // 1 top-level paragraph + 6 cell paragraphs (nested cell blocks ARE walked).
        assert!(
            p.paragraph_count >= 7,
            "cell paragraphs must be counted, got {}",
            p.paragraph_count
        );
        assert!(
            p.excerpt.contains("표 3×2"),
            "excerpt must carry the to_markdown table header: {}",
            p.excerpt
        );
        assert_eq!((p.image_count, p.chart_count, p.equation_count), (0, 0, 0));
    }

    /// Title candidate: a □-heading wins; without one the first non-empty paragraph text is used.
    #[test]
    fn doc_profile_title_prefers_heading() {
        use hwp_model::document::{Block, Inline, Paragraph, Run, Section};
        let para = |text: &str| {
            Block::Paragraph(Paragraph {
                runs: vec![Run {
                    content: vec![Inline::Text(text.to_string())],
                    ..Default::default()
                }],
                ..Default::default()
            })
        };
        let mut doc = SemanticDoc {
            char_shapes: vec![Default::default()],
            para_shapes: vec![Default::default()],
            ..Default::default()
        };
        doc.sections.push(Section {
            blocks: vec![para("2026년 사업계획서"), para("□ 일반현황")],
            ..Default::default()
        });
        let p = doc_profile(&doc);
        assert_eq!(p.title.as_deref(), Some("□ 일반현황"));
        assert_eq!(p.headings.len(), 1);
        assert_eq!(p.headings[0].level, 1);

        // Drop the heading → the first paragraph text becomes the candidate.
        doc.sections[0].blocks.pop();
        let p = doc_profile(&doc);
        assert_eq!(p.title.as_deref(), Some("2026년 사업계획서"));
        assert!(p.headings.is_empty());
    }

    /// Char-safe elision: a long header cell / title is cut at CHAR boundaries with "…" (never a
    /// byte split through a Hangul scalar).
    #[test]
    fn doc_profile_truncates_char_safe() {
        let long = "가".repeat(100);
        let cut = truncate_chars(&long, 24);
        assert_eq!(cut.chars().count(), 25); // 24 chars + '…'
        assert!(cut.ends_with('…'));
    }

    fn fill(row: usize, col: usize) -> Op {
        Op::SetTableCell {
            section: 0,
            index: 1,
            row,
            col,
            runs: vec![RunSpec {
                text: "x".into(),
                ..Default::default()
            }],
        }
    }

    #[test]
    fn guard_strips_header_and_shaded_writes_keeps_body() {
        let mut doc = doc_with_table();
        // Shade the whole SECOND body row (model row 2) → it becomes protected alongside the header.
        hwp_ops::apply(
            &mut doc,
            &Op::SetTableCellShade {
                section: 0,
                index: 1,
                sel: CellSel::Row(2),
                shade: Some("#FFF2CC".into()),
            },
        )
        .expect("shade row 2");

        let anchors =
            r#"[{"kind":"range","section":0,"block":1,"rows":[0,2],"cols":[0,1],"label":"표"}]"#;
        let mut ops = vec![
            fill(0, 0), // header → stripped
            fill(0, 1), // header → stripped
            fill(1, 0), // body   → kept
            fill(1, 1), // body   → kept
            fill(2, 0), // shaded → stripped
        ];
        let blocked = protect_table_header_rows(&doc, &mut ops, Some(anchors));
        assert_eq!(blocked, 3, "row 0 (header ×2) + row 2 (shaded ×1) stripped");
        assert_eq!(ops.len(), 2, "only the two unshaded body writes survive");
        assert!(ops
            .iter()
            .all(|o| matches!(o, Op::SetTableCell { row: 1, .. })));
    }

    #[test]
    fn guard_is_noop_without_anchors() {
        let doc = doc_with_table();
        let mut ops = vec![fill(0, 0), fill(1, 0)];
        assert_eq!(protect_table_header_rows(&doc, &mut ops, None), 0);
        assert_eq!(protect_table_header_rows(&doc, &mut ops, Some("[]")), 0);
        assert_eq!(ops.len(), 2, "nothing stripped when no anchor rides along");
    }

    /// A section-0 doc with THREE distinct top-level blocks stacked down the page: a header paragraph,
    /// a 3×2 table, then a footer paragraph — so `blocks_in_rect` has separable vertical bands to test.
    fn doc_with_stacked_blocks() -> SemanticDoc {
        use hwp_model::document::{Block, Paragraph, Section};
        use hwp_ops::ParaSpec;
        let mut doc = SemanticDoc {
            char_shapes: vec![Default::default()],
            para_shapes: vec![Default::default()],
            ..Default::default()
        };
        doc.sections.push(Section {
            blocks: vec![Block::Paragraph(Paragraph::default())],
            ..Default::default()
        });
        // block 0 = header paragraph.
        hwp_ops::apply(
            &mut doc,
            &Op::SetParagraphText {
                section: 0,
                block: 0,
                text: "머리말 문단입니다".into(),
            },
        )
        .expect("header text");
        // block 1 = table.
        let cell = |t: &str| CellSpec {
            text: t.into(),
            ..Default::default()
        };
        hwp_ops::apply(
            &mut doc,
            &Op::InsertTableAt {
                section: 0,
                index: 1,
                rows: vec![
                    vec![cell("항목"), cell("내용")],
                    vec![cell("A"), cell("B")],
                    vec![cell("C"), cell("D")],
                ],
            },
        )
        .expect("seed table");
        // block 2 = footer paragraph (appended after the table).
        hwp_ops::apply(
            &mut doc,
            &Op::InsertParagraphAt {
                section: 0,
                index: 2,
                runs: vec![RunSpec {
                    text: "꼬리말 문단입니다".into(),
                    ..Default::default()
                }],
                para: ParaSpec::default(),
            },
        )
        .expect("footer para");
        doc
    }

    #[test]
    fn blocks_in_rect_full_returns_all_narrow_returns_subset() {
        let doc = doc_with_stacked_blocks();
        // A generous rect covering the whole page (px units, page-local) hits every stacked block.
        let all = blocks_in_rect(&doc, 0, 0.0, 0.0, 100_000.0, 100_000.0);
        let anchors: std::collections::BTreeSet<(usize, usize)> =
            all.iter().map(|b| (b.section, b.block)).collect();
        assert!(
            anchors.contains(&(0, 0)),
            "header paragraph is in the full-page marquee"
        );
        assert!(
            anchors.contains(&(0, 1)),
            "table is in the full-page marquee"
        );
        assert!(
            anchors.contains(&(0, 2)),
            "footer paragraph is in the full-page marquee"
        );
        assert_eq!(
            anchors.len(),
            all.len(),
            "no duplicate (section, block) chips"
        );

        // Returned boxes are px (page-local): within the page's px extent, never HWPUNIT-scale.
        let geom = page_geometry(&doc, 0).expect("page 0 geometry");
        for b in &all {
            assert!(
                b.x >= -0.5 && b.x + b.w <= geom.w + 1.0,
                "band x in page px [0,{}]: got {}..{}",
                geom.w,
                b.x,
                b.x + b.w
            );
            assert!(
                b.y >= -0.5 && b.y + b.h <= geom.h + 1.0,
                "band y in page px [0,{}]: got {}..{}",
                geom.h,
                b.y,
                b.y + b.h
            );
        }

        // A narrow rect hugging ONLY the table band's vertical extent is a strict subset (excludes the
        // footer paragraph below it). Use the table's own returned box as the probe rect.
        let table = all
            .iter()
            .find(|b| b.kind == "table")
            .expect("table block present");
        let mid_y = table.y + table.h / 2.0;
        let narrow = blocks_in_rect(
            &doc,
            0,
            table.x + 1.0,
            mid_y - 1.0,
            table.x + table.w - 1.0,
            mid_y + 1.0,
        );
        let narrow_anchors: std::collections::BTreeSet<(usize, usize)> =
            narrow.iter().map(|b| (b.section, b.block)).collect();
        assert!(
            narrow_anchors.contains(&(0, 1)),
            "the narrow rect over the table still hits the table"
        );
        assert!(
            !narrow_anchors.contains(&(0, 2)),
            "the narrow rect does NOT reach the footer paragraph"
        );
        assert!(
            narrow.len() < all.len(),
            "narrow marquee is a strict subset of the full-page marquee"
        );
    }

    #[test]
    fn render_svg_with_empty_matches_render_svg() {
        // The golden invariant (issue 022 §1): an EMPTY injection must be byte-identical to the
        // discover/Approx path — the injection is a NEW entry point, the old one is untouched.
        let doc = doc_with_stacked_blocks();
        assert_eq!(
            render_svg_with(&doc, &[]),
            render_svg(&doc),
            "empty injection == render_svg"
        );
        // Geometry `_with` variants likewise agree with their bare counterparts on an empty slice.
        assert_eq!(
            blocks_in_rect_with(&doc, 0, 0.0, 0.0, 1e5, 1e5, &[]).len(),
            blocks_in_rect(&doc, 0, 0.0, 0.0, 1e5, 1e5).len(),
        );
    }

    #[test]
    fn blocks_in_rect_empty_on_out_of_range_page() {
        let doc = doc_with_stacked_blocks();
        assert!(
            blocks_in_rect(&doc, 99, 0.0, 0.0, 100_000.0, 100_000.0).is_empty(),
            "off-page marquee → empty vec, not a panic"
        );
    }

    /// A section-0 doc that is ONE tall single-column table on a SHORT page, so `place_doc` splits it
    /// across many page fragments (row-granular). Row `r`'s cell text is `"행{r}"`.
    fn tall_split_table_doc(rows: usize, page_height: i32) -> SemanticDoc {
        use hwp_model::document::{Block, Cell, Paragraph, Run, Section, Table};
        use hwp_model::prelude::Inline;
        let mut doc = SemanticDoc {
            char_shapes: vec![Default::default()],
            para_shapes: vec![Default::default()],
            ..Default::default()
        };
        let cells = (0..rows)
            .map(|r| Cell {
                row: r,
                col: 0,
                active: true,
                blocks: vec![Block::Paragraph(Paragraph {
                    runs: vec![Run {
                        char_shape: 0,
                        content: vec![Inline::Text(format!("행{r}"))],
                        ..Default::default()
                    }],
                    ..Default::default()
                })],
                ..Default::default()
            })
            .collect();
        let table = Table {
            rows,
            cols: 1,
            cells,
            col_widths: vec![1],
            ..Default::default()
        };
        let mut sec = Section::default();
        sec.page.width = 60000;
        sec.page.height = page_height;
        sec.page.margin_left = 0;
        sec.page.margin_top = 0;
        sec.page.margin_right = 0;
        sec.page.margin_bottom = 0;
        sec.blocks = vec![Block::Table(table)];
        doc.sections.push(sec);
        doc
    }

    #[test]
    fn table_cell_at_reports_global_row_on_a_split_fragment() {
        // 023 §함정 (1순위 예상 버그): a table SPLIT across pages must report a MODEL-GLOBAL row on a
        // LATER fragment — PlacedCell.row is already global, so `table_cell_at` returns it verbatim (NO
        // first_row re-add / fragment-local reset, the 009 desktop landmine). Round-trip: look a KNOWN
        // global row up BY ADDRESS (`table_cell_box` → its page + px box), click that box's center
        // (`table_cell_at`), and assert the hit's row is the SAME global index on a page > 0.
        let rows = 30usize;
        let doc = tall_split_table_doc(rows, 5000);
        let target_row = rows - 3; // a high row → guaranteed onto a later fragment
        let bx = table_cell_box(&doc, 0, 0, target_row, 0).expect("target row is placed");
        assert!(
            bx.page > 0,
            "row {target_row} must land on a later fragment (page>0), got page {}",
            bx.page
        );
        let hit = table_cell_at(&doc, bx.page, bx.x + bx.w / 2.0, bx.y + bx.h / 2.0)
            .expect("cell center hits a cell");
        assert_eq!(
            hit.row, target_row,
            "split fragment reports the GLOBAL row (no first_row double-add)"
        );
        assert_eq!(hit.col, 0);
        assert_eq!(hit.rows, rows, "the whole-table row count rides along");
        assert_eq!(
            hit.text,
            format!("행{target_row}"),
            "the hit's snippet is that global cell's text"
        );
        // A low row still resolves to its own global index (round-trip on page 0 too).
        let b0 = table_cell_box(&doc, 0, 0, 1, 0).expect("row 1 placed");
        let h0 =
            table_cell_at(&doc, b0.page, b0.x + b0.w / 2.0, b0.y + b0.h / 2.0).expect("row 1 hit");
        assert_eq!(h0.row, 1, "row 1 → global row 1");
    }

    #[test]
    fn table_cell_at_with_empty_matches_table_cell_at() {
        // Golden invariant (issue 022/023 §1): the injected-metric `_with` variant on an EMPTY slice is
        // byte-identical to the bare metric path — the wasm cell hit is a NEW entry point, the old one is
        // untouched. (The wasm binding always calls `_with`, so this pins its no-injection equivalence.)
        let doc = tall_split_table_doc(30, 5000);
        let bx = table_cell_box(&doc, 0, 0, 27, 0).expect("row 27 placed");
        let (px, py) = (bx.x + bx.w / 2.0, bx.y + bx.h / 2.0);
        let bare = table_cell_at(&doc, bx.page, px, py).expect("bare hit");
        let with = table_cell_at_with(&doc, bx.page, px, py, &[]).expect("with-empty hit");
        assert_eq!(
            (with.section, with.block, with.row, with.col),
            (bare.section, bare.block, bare.row, bare.col)
        );
        assert_eq!(with.text, bare.text);
        // A miss returns None (not a panic) on both paths (018 null policy).
        assert!(
            table_cell_at(&doc, 999, 0.0, 0.0).is_none(),
            "off-page → None"
        );
        assert!(
            table_cell_at_with(&doc, 0, -1.0, -1.0, &[]).is_none(),
            "off-table → None"
        );
    }

    #[test]
    fn table_grid_reports_active_cells_with_model_coords_and_none_for_non_table() {
        // issue 066: the AI doc-context grid must report every ACTIVE cell at its MODEL-GLOBAL
        // (row, col) — the SAME address SetTableCell writes — with the cell's current text, and a blank
        // value cell as empty text. Build a 2×2 table: (0,0)="아이디어명", (0,1)="" (blank value cell),
        // (1,0)="담당자", (1,1)="김철수", with a plain PARAGRAPH as block 0 so the non-table path is covered.
        use hwp_model::document::{Block, Cell, Paragraph, Run, Section, Table};
        use hwp_model::prelude::Inline;
        let cell = |r: usize, c: usize, text: &str| Cell {
            row: r,
            col: c,
            active: true,
            blocks: vec![Block::Paragraph(Paragraph {
                runs: if text.is_empty() {
                    vec![]
                } else {
                    vec![Run {
                        char_shape: 0,
                        content: vec![Inline::Text(text.to_string())],
                        ..Default::default()
                    }]
                },
                ..Default::default()
            })],
            ..Default::default()
        };
        let table = Table {
            rows: 2,
            cols: 2,
            cells: vec![
                cell(0, 0, "아이디어명"),
                cell(0, 1, ""),
                cell(1, 0, "담당자"),
                cell(1, 1, "김철수"),
            ],
            col_widths: vec![1, 1],
            ..Default::default()
        };
        let mut doc = SemanticDoc {
            char_shapes: vec![Default::default()],
            para_shapes: vec![Default::default()],
            ..Default::default()
        };
        let sec = Section {
            blocks: vec![
                Block::Paragraph(Paragraph::default()), // block 0 = a non-table paragraph
                Block::Table(table),                    // block 1 = the marked table
            ],
            ..Default::default()
        };
        doc.sections.push(sec);

        let grid = table_grid(&doc, 0, 1).expect("block 1 is a table");
        assert_eq!((grid.rows, grid.cols), (2, 2));
        assert_eq!(grid.cells.len(), 4, "every active cell is listed");
        let at = |r: usize, c: usize| {
            grid.cells
                .iter()
                .find(|g| g.row == r && g.col == c)
                .map(|g| g.text.as_str())
        };
        assert_eq!(at(0, 0), Some("아이디어명"));
        assert_eq!(at(0, 1), Some(""), "a blank value cell reports empty text");
        assert_eq!(at(1, 0), Some("담당자"));
        assert_eq!(at(1, 1), Some("김철수"));

        // A non-table block → None (the caller then attaches no grid); out-of-range → None (no panic).
        assert!(table_grid(&doc, 0, 0).is_none(), "paragraph block → None");
        assert!(table_grid(&doc, 9, 9).is_none(), "out-of-range → None");
    }

    #[test]
    fn placed_queries_equal_the_re_placing_queries() {
        // Issue 025 §동일성: a query answered from a SHARED `place()` result must be byte-identical to
        // the bare query that re-typesets internally — the cache surface is a pure factoring, not a new
        // geometry. Place ONCE, then compare every `_placed` variant to its self-placing sibling.
        let doc = doc_with_stacked_blocks();
        let placed = place(&doc, &[]);

        // own_hit_test: probe the centre of every stacked block's band.
        for probe_y in [50.0f64, 300.0, 500.0] {
            let bare = own_hit_test(&doc, 0, 40.0, probe_y);
            let cached = own_hit_test_placed(&doc, &placed, 0, 40.0, probe_y);
            assert_eq!(
                serde_json::to_string(&bare).unwrap(),
                serde_json::to_string(&cached).unwrap(),
                "own_hit_test == own_hit_test_placed at y={probe_y}"
            );
        }
        // blocks_in_rect over the whole page.
        assert_eq!(
            serde_json::to_string(&blocks_in_rect(&doc, 0, 0.0, 0.0, 1e5, 1e5)).unwrap(),
            serde_json::to_string(&blocks_in_rect_placed(&doc, &placed, 0, 0.0, 0.0, 1e5, 1e5))
                .unwrap(),
        );
        // page geometry.
        assert_eq!(
            serde_json::to_string(&page_geometry(&doc, 0)).unwrap(),
            serde_json::to_string(&page_geometry_placed(&placed, 0)).unwrap(),
        );
        // A table lives at block 1 — its outer box + cell hit + col boundaries all match.
        let tb = table_bbox(&doc, 0, 0, 1).expect("table present");
        assert_eq!(
            serde_json::to_string(&Some(&tb)).unwrap(),
            serde_json::to_string(&table_bbox_placed(&placed, 0, 0, 1)).unwrap(),
        );
        let (cx, cy) = (tb.x + tb.w / 2.0, tb.y + tb.h / 2.0);
        assert_eq!(
            serde_json::to_string(&table_at(&doc, 0, cx, cy)).unwrap(),
            serde_json::to_string(&table_at_placed(&placed, 0, cx, cy)).unwrap(),
        );
        assert_eq!(
            serde_json::to_string(&table_cell_at(&doc, 0, cx, cy)).unwrap(),
            serde_json::to_string(&table_cell_at_placed(&doc, &placed, 0, cx, cy)).unwrap(),
        );
        assert_eq!(
            serde_json::to_string(&table_col_boundaries(&doc, 0, 0, 1)).unwrap(),
            serde_json::to_string(&table_col_boundaries_placed(&doc, &placed, 0, 0, 1)).unwrap(),
        );
    }

    #[test]
    fn place_empty_injection_equals_place_via_with_variants() {
        // The `_with` family and the bare family must both fold onto `place()`: an empty injection is
        // byte-identical, so a `_placed` result driven by `place(&doc, &[])` equals the `_with(&[])` path.
        let doc = tall_split_table_doc(30, 5000);
        let placed = place(&doc, &[]);
        let bx = table_cell_box_placed(&placed, 0, 0, 27, 0).expect("row 27 placed");
        let (px, py) = (bx.x + bx.w / 2.0, bx.y + bx.h / 2.0);
        assert_eq!(
            serde_json::to_string(&table_cell_at_with(&doc, bx.page, px, py, &[])).unwrap(),
            serde_json::to_string(&table_cell_at_placed(
                &doc,
                &place(&doc, &[]),
                bx.page,
                px,
                py
            ))
            .unwrap(),
        );
        // table_cell_box likewise round-trips through the placed surface.
        assert_eq!(
            serde_json::to_string(&table_cell_box(&doc, 0, 0, 27, 0)).unwrap(),
            serde_json::to_string(&table_cell_box_placed(&placed, 0, 0, 27, 0)).unwrap(),
        );
    }

    #[test]
    fn guard_leaves_formatting_and_shading_ops_untouched() {
        // Only text-fill (SetTableCell) writes are guarded; a shade op on the header must survive
        // (freeform "헤더 색 바꿔줘" through a preset must still work).
        let doc = doc_with_table();
        let anchors = r#"[{"kind":"table","section":0,"block":1,"label":"표"}]"#;
        let mut ops = vec![
            Op::SetTableCellShade {
                section: 0,
                index: 1,
                sel: CellSel::Row(0),
                shade: Some("#D9E1F2".into()),
            },
            fill(0, 0), // header text → stripped
        ];
        let blocked = protect_table_header_rows(&doc, &mut ops, Some(anchors));
        assert_eq!(blocked, 1);
        assert_eq!(ops.len(), 1);
        assert!(
            matches!(ops[0], Op::SetTableCellShade { .. }),
            "shade op is preserved"
        );
    }

    // ── issue 064 Tier-2: descending CellPath ────────────────────────────────
    /// A section-0 doc whose block 1 is a 2×1 OUTER table; its cell (0,0) holds a NESTED 2×2 table
    /// (blocks `[Paragraph(""), Table(nested)]`, so the nested table is at cell-block index 1). The outer
    /// table has 2 rows, so `unwrap_frame_table` does NOT promote it — the nested grid is drawn by
    /// `place_nested_table` with its own provenance.
    fn doc_with_nested_table() -> SemanticDoc {
        use hwp_model::document::{Block, Cell, Paragraph, Run, Section, Table};
        use hwp_model::prelude::Inline;
        let mut doc = SemanticDoc {
            char_shapes: vec![Default::default()],
            para_shapes: vec![Default::default()],
            ..Default::default()
        };
        doc.sections.push(Section {
            blocks: vec![Block::Paragraph(Paragraph::default())],
            ..Default::default()
        });
        hwp_ops::apply(
            &mut doc,
            &Op::InsertTableAt {
                section: 0,
                index: 1,
                rows: vec![
                    vec![CellSpec {
                        text: "".into(),
                        ..Default::default()
                    }],
                    vec![CellSpec {
                        text: "아래".into(),
                        ..Default::default()
                    }],
                ],
            },
        )
        .expect("outer table");
        let mk_para = |s: &str| {
            Block::Paragraph(Paragraph {
                runs: vec![Run {
                    char_shape: 0,
                    content: vec![Inline::Text(s.into())],
                    ..Default::default()
                }],
                ..Default::default()
            })
        };
        let mk_cell = |r: usize, c: usize, s: &str| Cell {
            row: r,
            col: c,
            row_span: 1,
            col_span: 1,
            active: true,
            blocks: vec![mk_para(s)],
            ..Default::default()
        };
        let nested = Table {
            rows: 2,
            cols: 2,
            col_widths: vec![1, 1],
            cells: vec![
                mk_cell(0, 0, "A"),
                mk_cell(0, 1, "B"),
                mk_cell(1, 0, "C"),
                mk_cell(1, 1, "D"),
            ],
            ..Default::default()
        };
        if let Block::Table(t) = &mut doc.sections[0].blocks[1] {
            let cell00 = t
                .cells
                .iter_mut()
                .find(|c| c.active && c.row == 0 && c.col == 0)
                .unwrap();
            cell00.blocks.push(Block::Table(nested)); // → [Paragraph(""), Table(nested)] (index 1)
        }
        doc
    }

    #[test]
    fn table_cell_at_resolves_nested_leaf_path() {
        let doc = doc_with_nested_table();
        let placed = place(&doc, &[]);
        // The nested table's PlacedTable is the one carrying ancestor provenance.
        let (pi, nt) = placed
            .pages
            .iter()
            .enumerate()
            .find_map(|(pi, pg)| {
                pg.tables
                    .iter()
                    .find(|t| !t.ancestors.is_empty())
                    .map(|t| (pi, t))
            })
            .expect("a nested PlacedTable with descent provenance");
        assert_eq!(nt.ancestors.len(), 1, "one ancestor cell (the outer (0,0))");
        assert_eq!(
            nt.self_block, 1,
            "nested Block::Table sits at cell-block index 1"
        );
        let leaf = nt
            .cells
            .iter()
            .find(|c| c.row == 1 && c.col == 1)
            .expect("nested (1,1) placed");
        let k = HWPUNIT_PER_PX;
        let px = (leaf.x + leaf.w / 2.0) / k;
        let py = (leaf.y + leaf.h / 2.0) / k;
        let hit = table_cell_at_placed(&doc, &placed, pi as u32, px, py)
            .expect("nested cell hit resolves");
        // The DEEPER path wins (rfind picks the innermost table).
        assert_eq!(hit.path.len(), 2, "1-deep nesting → length-2 CellPath");
        assert_eq!(
            hit.path[0],
            CellAddrDto {
                block: 1,
                row: 0,
                col: 0
            },
            "level 0 = outer table block, its (0,0) cell"
        );
        assert_eq!(
            hit.path[1],
            CellAddrDto {
                block: 1,
                row: 1,
                col: 1
            },
            "level 1 = nested Block::Table (index 1), its (1,1) leaf"
        );
        // Flat row/col mirror the LEAF for back-compat; the leaf reads its own text "D".
        assert_eq!((hit.row, hit.col), (1, 1));
        assert_eq!(hit.text, "D");
    }

    #[test]
    fn table_cell_at_non_nested_stays_length_1() {
        // A plain top-level table (no nesting) resolves the flat quad as a length-1 path — 100% back-compat.
        let doc = doc_with_table();
        let placed = place(&doc, &[]);
        let t = placed.pages[0]
            .tables
            .iter()
            .find(|t| t.ancestors.is_empty())
            .expect("top-level table");
        let cell = t
            .cells
            .iter()
            .find(|c| c.row == 1 && c.col == 0)
            .expect("cell (1,0)");
        let k = HWPUNIT_PER_PX;
        let px = (cell.x + cell.w / 2.0) / k;
        let py = (cell.y + cell.h / 2.0) / k;
        let hit = table_cell_at_placed(&doc, &placed, 0, px, py).expect("cell hit");
        assert_eq!(hit.path.len(), 1, "no nesting → length-1 path");
        assert_eq!(
            hit.path[0],
            CellAddrDto {
                block: 1,
                row: 1,
                col: 0
            }
        );
        assert_eq!((hit.section, hit.block, hit.row, hit.col), (0, 1, 1, 0));
        assert!(!hit.nested, "a plain cell is not nested");
    }
}
