//! The [`SemanticDoc`] AST — the source of truth. Formats are codecs around it;
//! rendering is a downstream projection. Every editable node carries provenance +
//! a passthrough bag + a dirty flag so untouched content round-trips byte-verbatim.

use crate::style::{CharShape, ParaShape};
use crate::types::{Dirty, HwpUnit, NodeId, Passthrough, Provenance};
use std::collections::BTreeMap;

/// A whole document.
#[derive(Clone, Debug, Default)]
pub struct SemanticDoc {
    pub sections: Vec<Section>,
    /// `header.xml` dedup pools — runs/paras reference these by index.
    pub char_shapes: Vec<CharShape>,
    pub para_shapes: Vec<ParaShape>,
    /// Read-only snapshot of the ORIGINAL header.xml `charPr`/`paraPr` pools parsed to values
    /// (keyed by their XML id) — lets the editor *read* an existing run/paragraph's formatting
    /// (e.g. to toggle bold) and the serializer dedup synthesized shapes against real entries.
    pub header_pools: HeaderPools,
    /// Embedded binaries (images, OLE) keyed by `bin_ref`.
    pub bin_data: Vec<BinData>,
    /// Document-level un-modeled parts (settings, history, master pages, …).
    pub passthrough: Passthrough,
    /// The on-disk format this document was opened FROM (`None` = synthesized/unknown). Remembered so
    /// downstream (export, UI) can show the original kind and pick a save policy: HWPX round-trips,
    /// `.hwp`/`.docx` are conversions, `.pdf` is view-mostly. Set by `Engine::open`/the readers.
    pub origin: Option<crate::types::SourceFormat>,
}

/// The document's original `header.xml` shape pools, parsed to typed values (issue #003, P1).
#[derive(Clone, Debug, Default)]
pub struct HeaderPools {
    pub char: BTreeMap<u64, CharShape>,
    pub para: BTreeMap<u64, ParaShape>,
}

impl SemanticDoc {
    /// The `CharShape` of a run's original `charPrIDRef` (if it was parsed from the header pool).
    /// Use this to read existing formatting before modifying it.
    pub fn char_shape_of_ref(&self, char_ref: &str) -> Option<&CharShape> {
        let id: u64 = char_ref.trim().parse().ok()?;
        self.header_pools.char.get(&id)
    }
}

impl SemanticDoc {
    /// True if any node has been edited since load (drives dirty-only re-serialization).
    pub fn any_dirty(&self) -> bool {
        self.sections.iter().any(Section::any_dirty)
    }

    /// Reading-order plain text (one line per paragraph; table cells in row/col order).
    /// The seed of the structure-preserving AST→text projection used for AI/RAG.
    pub fn plain_text(&self) -> String {
        let mut s = String::new();
        for sec in &self.sections {
            for b in &sec.blocks {
                block_text(b, &mut s);
            }
        }
        s
    }
}

fn block_text(b: &Block, out: &mut String) {
    match b {
        Block::Paragraph(p) => {
            for run in &p.runs {
                for inl in &run.content {
                    if let Inline::Text(t) = inl {
                        out.push_str(t);
                    }
                }
            }
            out.push('\n');
        }
        Block::Table(t) => {
            for cell in &t.cells {
                for cb in &cell.blocks {
                    block_text(cb, out);
                }
            }
        }
    }
}

/// A 구역 (section): the unit page-setup/columns/headers are scoped to.
#[derive(Clone, Debug, Default)]
pub struct Section {
    pub blocks: Vec<Block>,
    pub page: PageSetup,
    /// True once `page` was explicitly edited — the serializer then patches the section's `secPr`
    /// (parsed sections leave this false so their original page setup round-trips verbatim).
    pub page_edited: bool,
    /// 머리말/꼬리말 (headers/footers) scoped to this section. DEFAULT EMPTY ⇒ no secPr change,
    /// so HWPX-in round-trip is untouched; the converter splices these into the secPr-carrier run.
    pub decorations: Vec<PageDecoration>,
    pub provenance: Provenance,
    pub passthrough: Passthrough,
    pub dirty: Dirty,
}

/// A header or footer (master pages deferred) and which pages it applies to.
#[derive(Clone, Debug)]
pub struct PageDecoration {
    pub kind: DecoKind,
    pub apply: ApplyPage,
    pub blocks: Vec<Block>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecoKind {
    Header,
    Footer,
}

/// Which pages a header/footer applies to (OWPML `applyPageType`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApplyPage {
    Both,
    Even,
    Odd,
}

impl Section {
    fn any_dirty(&self) -> bool {
        self.dirty.is_dirty() || self.blocks.iter().any(Block::any_dirty)
    }
}

#[derive(Clone, Debug)]
pub enum Block {
    Paragraph(Paragraph),
    Table(Table),
}

impl Block {
    fn any_dirty(&self) -> bool {
        match self {
            Block::Paragraph(p) => p.dirty.is_dirty(),
            Block::Table(t) => t.dirty.is_dirty() || t.cells.iter().any(|c| c.any_dirty()),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct Paragraph {
    pub id: Option<NodeId>,
    /// Index into `SemanticDoc::para_shapes`.
    pub para_shape: usize,
    /// A hard 쪽 나누기 (page break) BEFORE this paragraph — per-INSTANCE, from HWP's paragraph
    /// `column_type == Page/Section` (NOT the shared para_shape's attr1 bit19, which can't carry a
    /// per-paragraph break). Pagination forces a fresh page when set, OR'd with the para_shape flag.
    pub page_break_before: bool,
    /// This (empty) paragraph is a pure TABLE/object ANCHOR — in HWP a table control hangs off a host
    /// paragraph; the lift emits that host as an empty `Paragraph` immediately before the `Table` block.
    /// Hancom reserves NO line for such an anchor, so pagination skips its height (a genuine blank
    /// spacer paragraph — text-empty but NOT hosting a control — is left alone and keeps its line).
    pub is_table_anchor: bool,
    /// Requested named style (e.g. "개요 1"); resolved to a `styleIDRef` by the serializer.
    pub style_name: Option<String>,
    pub runs: Vec<Run>,
    /// Provenance for a TOP-LEVEL paragraph parsed from HWPX — enables in-place (non-verbatim)
    /// re-emit: if this paragraph is edited (dirty) the serializer replaces exactly its byte span;
    /// untouched paragraphs ride along byte-verbatim. `None` ⇒ synthesized/appended (legacy path).
    pub source: Option<ParaSource>,
    pub provenance: Provenance,
    pub passthrough: Passthrough,
    pub dirty: Dirty,
}

/// Where a parsed top-level paragraph came from in the section XML, for surgical re-emit.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ParaSource {
    /// `[start, end)` byte range of `<hp:p>…</hp:p>` within `Section.provenance.raw`.
    pub span: (usize, usize),
    /// Original `paraPrIDRef` (re-emitted verbatim).
    pub para_pr: Option<String>,
    /// Original `styleIDRef`.
    pub style: Option<String>,
    /// Original XML `id` string (re-emitted verbatim — distinct from the in-memory `NodeId`).
    pub id: Option<String>,
    /// True iff the original `<hp:p>` contained ONLY `hp:run`/`hp:t` children (no secPr/ctrl/tbl/
    /// linesegarray/pic/equation). The replace-in-place path refuses non-simple paragraphs.
    pub simple: bool,
}

#[derive(Clone, Debug, Default)]
pub struct Run {
    /// Index into `SemanticDoc::char_shapes`.
    pub char_shape: usize,
    /// Original `charPrIDRef` (parsed from HWPX) — the fallback ref for re-emit when the run's
    /// interned `char_shape` is still the default (i.e. this run wasn't re-formatted).
    pub char_ref: Option<String>,
    pub content: Vec<Inline>,
}

#[derive(Clone, Debug)]
pub enum Inline {
    Text(String),
    Image(ImageRef),
    /// A 수식 (equation) — its HWP/OWPML script + display attributes.
    Equation(EquationRef),
    /// Start of a field range (hyperlink / click-here / cross-ref …) — wraps the runs up to the
    /// matching [`Inline::FieldEnd`].
    FieldBegin(FieldMarker),
    /// End of a field range; carries the matching `FieldBegin` id (`beginIDRef`).
    FieldEnd(u32),
    /// A 책갈피 (bookmark) anchor with its name.
    Bookmark(String),
    /// A 각주/미주 (foot/endnote): an inline reference marker whose body is a block sequence.
    Note(NoteRef),
    /// Verbatim un-modeled inline content (shape, chart, …) — the raw `<hp:…>` XML, preserved on
    /// export, even before an edit op exists.
    Raw(crate::types::RawPart),
}

/// 각주 vs 미주.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoteKind {
    Foot,
    End,
}

/// A foot/endnote: the reference appears inline; the `body` (paragraphs, possibly with tables/
/// images) renders at the page foot (footnote) or document/section end (endnote).
#[derive(Clone, Debug)]
pub struct NoteRef {
    pub kind: NoteKind,
    pub number: u16,
    /// Decoration chars (WChar code points) around the number; 0 = none.
    pub prefix_char: u16,
    pub suffix_char: u16,
    pub inst_id: u32,
    pub body: Vec<Block>,
}

/// A field start marker (hyperlink, click-here, cross-reference, …).
#[derive(Clone, Debug, Default)]
pub struct FieldMarker {
    /// Unique field id; the matching `FieldEnd` references it as `beginIDRef`.
    pub id: u32,
    /// OWPML field type token, e.g. "HYPERLINK", "CLICK_HERE".
    pub field_type: String,
    /// The field command/payload (a hyperlink's URL, a click-here's guide text, …).
    pub command: String,
}

#[derive(Clone, Debug, Default)]
pub struct ImageRef {
    pub bin_ref: String,
    pub width: HwpUnit,
    pub height: HwpUnit,
}

/// A 수식. The `script` is HWP's equation markup (e.g. `"1 over 2"`), which is the SAME language as
/// OWPML's `<hp:script>` — so it round-trips verbatim (no transcode). The rest are display attrs.
#[derive(Clone, Debug)]
pub struct EquationRef {
    pub script: String,
    /// Equation font (e.g. "HYhwpEQ"); empty → the default symbol font on export.
    pub font: String,
    /// Base size in HWPUNIT (OWPML `baseUnit`).
    pub base_unit: u32,
    pub baseline: i16,
    pub color: crate::types::Color,
    pub width: HwpUnit,
    pub height: HwpUnit,
    /// e.g. "Equation Version 60"; empty → the default on export.
    pub version: String,
}

#[derive(Clone, Debug, Default)]
pub struct Table {
    pub rows: usize,
    pub cols: usize,
    pub cells: Vec<Cell>,
    /// Per-column widths (HWPUNIT), `cols` entries — for faithful column proportions on render.
    /// Empty when unknown (then the renderer falls back to auto-layout).
    pub col_widths: Vec<HwpUnit>,
    /// Per-row MINIMUM height OVERRIDE (HWPUNIT), `rows` entries — a user-set row height (드래그로 행
    /// 높이 조정). EMPTY = every row sizes to its content (the default; the parser never fills this, so
    /// existing docs/layout/oracle are unaffected). A slot of `0` means "that row stays content-sized";
    /// a slot `> 0` is honored as a FLOOR (`max(content, override)`) in the typesetter
    /// (`hwp_typeset::apply_row_overrides`). Honored by the own-render surface, the PDF export (both go
    /// through `place_doc`), and the HTML export (`data-rowh` → per-row `min-height`). NOT yet honored
    /// by the HWPX serializer, which emits a uniform constant row height (a separate fidelity gap).
    pub row_heights: Vec<HwpUnit>,
    /// Outer vertical margins (바깥 여백, HWPUNIT) above/below the table object — the gap HWP keeps
    /// between a table and its neighbours. Lifted from the binary; 0 when unknown. Without these,
    /// consecutive tables abut with no breathing room (the "tables stuck together" artifact).
    pub outer_margin_top: HwpUnit,
    pub outer_margin_bottom: HwpUnit,
    pub provenance: Provenance,
    pub passthrough: Passthrough,
    pub dirty: Dirty,
}

#[derive(Clone, Debug)]
pub struct Cell {
    pub row: usize,
    pub col: usize,
    pub row_span: usize,
    pub col_span: usize,
    pub blocks: Vec<Block>,
    /// Merge convention: covered cells are *deactivated* (span 1×1, size 0), not removed
    /// (matches Hancom/python-hwpx; a renderer must honor this).
    pub active: bool,
    /// Optional cell background shade (synthesized into a borderFill `fillBrush` on export).
    pub shade_color: Option<crate::types::Color>,
    /// Whether this cell draws a visible border box. Lifted from the cell's borderFill (false when
    /// all four edges are "선없음"). Default `true` keeps the legacy behavior for inserted/test cells
    /// (which want a normal border). A `false` cell is skipped by the renderer — this removes the
    /// spurious grid lines on borderless cells (e.g. the section-header banner's filler cell, spacer
    /// cells) that made the own render look like a plain table instead of the original's clean band.
    ///
    /// NOTE: when `borders` carries per-edge styles (lifted from the real borderFill), the renderer
    /// honors those EDGE-by-edge and ignores `has_border`. `has_border` is the LEGACY fallback for
    /// cells WITHOUT per-edge data (inserted/test cells, older projects) — it still draws a uniform
    /// solid box so nothing regresses.
    pub has_border: bool,
    /// Per-edge border styles in `[left, right, top, bottom]` order (HWP's borderFill `borders`
    /// ordering). `None` for an edge means "unspecified" — the renderer then leaves that edge to the
    /// legacy `has_border` box. A specified `Some(edge)` overrides per side; a 선없음 edge becomes
    /// `Some(CellEdge { style: None, .. })`-equivalent by being SET-but-invisible: we model that as
    /// the edge simply being absent (`None` = legacy) vs present-and-drawn. Concretely: any edge the
    /// real doc draws is `Some`, any edge the real doc suppresses is also `Some` (with a style flagged
    /// so the renderer skips it). See [`CellEdge`].
    pub borders: [Option<CellEdge>; 4],
    /// An optional diagonal line across the cell (HWP borderFill `diagonal`). Drawing this on the
    /// section-header banner's right cell — together with suppressed right edges — turns the 1×2 band
    /// into a pointed pentagon.
    pub diagonal: Option<CellDiagonal>,
    pub dirty: Dirty,
}

/// One cell edge's rendered border (a side of the box). Lifted from a borderFill `BorderLine`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CellEdge {
    pub color: crate::types::Color,
    pub style: LineStyle,
    /// Stroke width in device px (≈ the SVG/PDF stroke width). Lifted from the HWP width index.
    /// f64 so sub-px gov-doc hairlines (0.5/0.7px) survive — not rounded up to a heavier 1px.
    pub width_px: f64,
}

/// How a border line is drawn. `None` = 선없음 (the edge is suppressed: NO stroke emitted) — this is
/// how a per-edge-aware cell turns OFF a side (e.g. the banner band's inner/right edges).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum LineStyle {
    /// 선없음 — the edge is not drawn at all.
    None,
    #[default]
    Solid,
    Dashed,
    Dotted,
    Double,
}

/// A cell diagonal line (HWP borderFill `diagonal`). `kind` picks which corners it connects.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CellDiagonal {
    pub kind: DiagonalKind,
    pub color: crate::types::Color,
    /// Stroke width in device px (f64 — same hairline rationale as [`CellEdge::width_px`]).
    pub width_px: f64,
}

/// Slash = bottom-left→top-right (/); BackSlash = top-left→bottom-right (\\).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DiagonalKind {
    Slash,
    BackSlash,
}

impl Cell {
    fn any_dirty(&self) -> bool {
        self.dirty.is_dirty() || self.blocks.iter().any(Block::any_dirty)
    }

    /// True if ANY of the four edges carries a per-edge style (lifted from the real borderFill).
    /// When true the renderer draws each edge individually and ignores the legacy `has_border` box.
    pub fn has_edge_borders(&self) -> bool {
        self.borders.iter().any(Option::is_some)
    }
}

impl Default for Cell {
    fn default() -> Self {
        Cell {
            row: 0,
            col: 0,
            row_span: 1,
            col_span: 1,
            blocks: Vec::new(),
            active: true,
            shade_color: None,
            has_border: true,
            borders: [None; 4],
            diagonal: None,
            dirty: Dirty::default(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct BinData {
    pub bin_ref: String,
    pub bytes: Vec<u8>,
    /// e.g. "png", "jpg", "ole".
    pub kind: String,
}

/// 편집 용지 — section-scoped page setup.
#[derive(Clone, Copy, Debug)]
pub struct PageSetup {
    pub width: HwpUnit,
    pub height: HwpUnit,
    pub margin_left: HwpUnit,
    pub margin_right: HwpUnit,
    pub margin_top: HwpUnit,
    pub margin_bottom: HwpUnit,
    pub landscape: bool,
    pub columns: u8,
}

impl Default for PageSetup {
    fn default() -> Self {
        // A4 portrait, 1-inch margins, in HWPUNIT (1 inch = 7200).
        PageSetup {
            width: 59528,  // 210mm
            height: 84188, // 297mm
            margin_left: 7200,
            margin_right: 7200,
            margin_top: 7200,
            margin_bottom: 7200,
            landscape: false,
            columns: 1,
        }
    }
}
