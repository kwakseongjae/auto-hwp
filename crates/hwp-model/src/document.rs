//! The [`SemanticDoc`] AST — the source of truth. Formats are codecs around it;
//! rendering is a downstream projection. Every editable node carries provenance +
//! a passthrough bag + a dirty flag so untouched content round-trips byte-verbatim.

use crate::style::{CharShape, ParaShape};
use crate::types::{Dirty, HwpUnit, NodeId, Passthrough, Provenance};
use std::collections::{BTreeMap, BTreeSet};

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
    /// `char_shapes`/`para_shapes` indices that the HWPX parser INTERNED FROM the original
    /// `header.xml` pools (resolving each run's `charPrIDRef` / paragraph's `paraPrIDRef` so layout
    /// reads the real size/color/bold/align/indent/spacing instead of the reserved index-0 default).
    /// The serializer SKIPS re-synthesizing these: an UNEDITED run/paragraph re-emits its ORIGINAL
    /// IDRef (via [`Run::char_ref`] / the byte-verbatim `<hp:p>` open tag) rather than a lossy
    /// re-synthesized duplicate — preserving the round-trip moat even when a NEIGHBOURING run in the
    /// same paragraph is edited. Empty for docs from other sources (HWP lift / synthesized) so their
    /// behavior is unchanged.
    pub hwpx_pool_char_shapes: BTreeSet<usize>,
    pub hwpx_pool_para_shapes: BTreeSet<usize>,
}

/// The document's original `header.xml` shape pools, parsed to typed values (issue #003, P1).
#[derive(Clone, Debug, Default)]
pub struct HeaderPools {
    pub char: BTreeMap<u64, CharShape>,
    pub para: BTreeMap<u64, ParaShape>,
    /// `<hh:borderFill>` pool, keyed by XML id (issue #196 Batch C) — a table/cell's
    /// `borderFillIDRef` resolves against this to its per-edge borders, background shade, and
    /// diagonal (the HWPX twin of the .hwp lift's `cell_borders`/`cell_shade`/`cell_diagonal`).
    pub border: BTreeMap<u64, BorderFillDef>,
}

/// A parsed `<hh:borderFill>` pool entry (issue #196 Batch C) — the resolved values a table/cell
/// applies when it references this fill by `borderFillIDRef`. Mirrors what the .hwp lift derives from
/// the binary borderFill so the SHARED renderer draws HWPX tables with the SAME fidelity as HWP.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BorderFillDef {
    /// Per-edge borders `[left, right, top, bottom]`. All four are `Some` when the fill resolves
    /// (a 선없음 edge is `Some(LineStyle::None)`), so a consuming cell's `has_edge_borders()` is true
    /// and the renderer draws each edge individually (mirrors the .hwp lift's `cell_borders`).
    pub borders: [Option<CellEdge>; 4],
    /// Solid background shade, or `None` for an unfilled / white / black cell.
    pub shade: Option<crate::types::Color>,
    /// Diagonal line, or `None` when neither slash direction is set.
    pub diagonal: Option<CellDiagonal>,
    /// True if ANY edge draws a visible line (a `line_type` other than 선없음).
    pub has_border: bool,
}

impl SemanticDoc {
    /// The `CharShape` of a run's original `charPrIDRef` (if it was parsed from the header pool).
    /// Use this to read existing formatting before modifying it.
    pub fn char_shape_of_ref(&self, char_ref: &str) -> Option<&CharShape> {
        let id: u64 = char_ref.trim().parse().ok()?;
        self.header_pools.char.get(&id)
    }

    /// The `ParaShape` of a paragraph's original `paraPrIDRef` (if it was parsed from the header
    /// pool). The paragraph twin of [`Self::char_shape_of_ref`].
    pub fn para_shape_of_ref(&self, para_ref: &str) -> Option<&ParaShape> {
        let id: u64 = para_ref.trim().parse().ok()?;
        self.header_pools.para.get(&id)
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
    /// True if this block — or, for a table, ANY of its cells RECURSIVELY (nested tables included)
    /// — is dirty. This is the FRAME-TRANSPARENT dirty predicate: a table edit op marks only the
    /// `edit_target` (the inner table of a 1×1 frame wrapper), never the outer wrapper table/cell,
    /// so the HWPX emitter must gate on THIS (not a one-level `t.dirty || cells.any(c.dirty)`) or a
    /// 자가진단표 edit is silently dropped on save (issue 060). Shared by `SemanticDoc::any_dirty`
    /// and the serializer's emit gates.
    pub fn any_dirty(&self) -> bool {
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
    /// Original `paraPrIDRef` (parsed from HWPX, for EVERY paragraph incl. nested cell paragraphs) —
    /// the fallback ref for re-emit when the paragraph's interned `para_shape` is still the default
    /// (unedited). The paragraph twin of [`Run::char_ref`]; the HWPX resolve pass reads it to point
    /// `para_shape` at the real align/indent/line-spacing pool entry.
    pub para_ref: Option<String>,
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
    /// A 차트 (OOXML DrawingML chart) — render-only (issue 062-7). Carries just the reserved box
    /// size + a precomputed SVG fragment (rhwp's native OOXML chart renderer).
    Chart(ChartRef),
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
    /// PRECOMPUTED render (issue 062-5): the `<g>`-embeddable SVG fragment rhwp's equation engine
    /// produces from `script` at lift time (in the own-render px scale = HWPUNIT/75). A DERIVED cache,
    /// never part of the equation's semantic identity: `None` (no rhwp / un-rendered) keeps the old
    /// stub-box behavior byte-for-byte, so this is purely additive. Consumed by the own-render SvgSink
    /// (embedded as a `<g transform=translate(box)>`) and the HTML export (inline `<svg>`); the PDF
    /// backend ignores it (v1 stub deferred — no SVG→PDF path yet).
    pub rendered_svg: Option<String>,
}

/// A 차트 (OOXML DrawingML chart), render-only (issue 062-7). v1 carries only the reserved box size
/// (from the stored chart object — typeset input is unchanged, so pagination is gate-neutral, exactly
/// like [`EquationRef`]) and a PRECOMPUTED SVG fragment produced by rhwp's native OOXML chart renderer
/// at lift time (in the own-render px scale = HWPUNIT/75). The SVG is a DERIVED cache, never part of
/// the chart's identity: `None` (no rhwp / legacy OLE VtChart / parse failure) keeps the stub box
/// byte-for-byte, so this is purely additive. Consumed by the own-render SvgSink (rides the SHARED
/// `PaintOp::Image.svg` channel — same as an equation) and the HTML export (inline `<svg>`); the PDF
/// backend ignores it (v1 stub deferred — no SVG→PDF path yet).
#[derive(Clone, Debug)]
pub struct ChartRef {
    pub width: HwpUnit,
    pub height: HwpUnit,
    pub rendered_svg: Option<String>,
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
    /// through `place_doc`), the HTML export (`data-rowh` → per-row `min-height`), AND the HWPX
    /// serializer (issue 054, F2): `<hp:cellSz>` re-emits these stored heights so a reopened
    /// conversion lifts back the SAME floors (round-trip pagination stability).
    pub row_heights: Vec<HwpUnit>,
    /// RENDER-IR ONLY (never serialized): the stored `<hp:cellSz height>` floor for an AUTO-FIT
    /// (`noAdjust="0"`) HWPX table — `rows` entries, or EMPTY for fixed/lift/synth tables. The HWPX
    /// parser records this SEPARATELY from `row_heights` (which stays content-driven for auto-fit so the
    /// round-trip codec is unaffected) so the app can offer two faithful readings of a lossy hwp→hwpx
    /// conversion WITHOUT touching the round-trip bytes: FAITHFUL (mirror Hancom — floor rows to these
    /// stored heights, `hwp_model::normalize::apply_faithful_table_heights`) vs 레이아웃 정리 (recover
    /// the .hwp look — content-fit, `content_fit_autofit_tables`). Non-empty ONLY for HWPX auto-fit
    /// tables, so those helpers use its presence to target exactly them. Never round-trips: an unedited
    /// table re-emits via `src_span` verbatim, so this never reaches saved bytes.
    pub stored_row_heights: Vec<HwpUnit>,
    /// True once an OP changed `col_widths`/`row_heights` (표 열너비/행높이 편집) — distinct from the
    /// geometry the HWPX parser now fills from the original `<hp:cellSz>` (issue #196 Batch C). The
    /// HWPX serializer gates its per-cell in-place surgery on `!geometry_edited`: a table whose geometry
    /// is the ORIGINAL (parse-populated) still re-emits untouched sibling cells byte-verbatim, while a
    /// genuinely resized table falls back to a whole-table re-emit (which applies the new geometry).
    /// Parsed/lifted tables leave this false; only [`crate`]-level geometry ops set it.
    pub geometry_edited: bool,
    /// Outer vertical margins (바깥 여백, HWPUNIT) above/below the table object — the gap HWP keeps
    /// between a table and its neighbours. Lifted from the binary; 0 when unknown. Without these,
    /// consecutive tables abut with no breathing room (the "tables stuck together" artifact).
    pub outer_margin_top: HwpUnit,
    pub outer_margin_bottom: HwpUnit,
    /// `[start, end)` byte range of this TOP-LEVEL `<hp:tbl>…</hp:tbl>` within
    /// `Section.provenance.raw` (set by the HWPX parser only) — lets the serializer re-emit a
    /// dirty table IN PLACE at its original anchor instead of appending it at the section end
    /// (issue 057). `None` ⇒ synthesized/lifted table (no original XML to anchor to) → the
    /// legacy append path. Export provenance only — render/equality ignore it.
    pub src_span: Option<(usize, usize)>,
    /// Outer horizontal margins (바깥 여백 좌/우, HWPUNIT) — captured for faithful HWPX re-emission
    /// (`<hp:outMargin>`); the typesetter doesn't consume these yet (issue 054, F2). 0 when unknown.
    pub outer_margin_left: HwpUnit,
    pub outer_margin_right: HwpUnit,
    /// Table-default cell inner padding `[left, right, top, bottom]` (안쪽 여백, HWPUNIT — HWPX
    /// `<hp:inMargin>`). A cell WITHOUT its own [`Cell::padding`] uses this. `None` = unknown (an
    /// editor-inserted table): the serializer emits the legacy 510/141 defaults, byte-stable with
    /// pre-F2 output. (issue 054, F2 — replaces the hardcoded 510/141.)
    pub padding: Option<[HwpUnit; 4]>,
    /// Table OUTLINE borders `[left, right, top, bottom]` from the table's own borderFill (표 외곽
    /// 테두리 — HWPX `<hp:tbl borderFillIDRef>`). Captured for faithful re-emission; `[None; 4]` =
    /// unknown (serializer falls back to reusing an existing table borderFill, the pre-F2 behavior).
    pub borders: [Option<CellEdge>; 4],
    pub provenance: Provenance,
    pub passthrough: Passthrough,
    pub dirty: Dirty,
}

impl Table {
    /// If this is a 1×1 "frame wrapper" whose single active cell holds exactly ONE multi-row nested table
    /// (plus only empty paragraphs), return that inner table. This is what actually gets RENDERED and
    /// EDITED (e.g. the 자가진단표 = a 17×3 grid wrapped in a 1×1). The render unwrap (hwp_typeset) AND the
    /// edit commands/ops resolve THROUGH this, so a click/double-click/edit on a nested cell targets the
    /// SAME table the renderer drew — without it, nested cells were un-editable (the edit op only saw the
    /// outer 1×1's single cell). `None` for any normal table.
    pub fn frame_inner(&self) -> Option<&Table> {
        if self.rows != 1 || self.cols != 1 {
            return None;
        }
        let cell = self
            .cells
            .iter()
            .find(|c| c.active && c.row == 0 && c.col == 0)?;
        let mut inner: Option<&Table> = None;
        for b in &cell.blocks {
            match b {
                Block::Table(t) => {
                    if inner.is_some() {
                        return None; // two nested tables → not a simple wrapper
                    }
                    inner = Some(t);
                }
                Block::Paragraph(p) => {
                    let has_text = p.runs.iter().any(|r| {
                        r.content
                            .iter()
                            .any(|i| matches!(i, Inline::Text(s) if !s.trim().is_empty()))
                    });
                    if has_text {
                        return None; // real text beside the table → keep the whole cell
                    }
                }
            }
        }
        inner.filter(|t| t.rows > 1)
    }

    /// Mutable twin of [`frame_inner`] — the nested table to MUTATE when editing a frame-wrapper's cell.
    pub fn frame_inner_mut(&mut self) -> Option<&mut Table> {
        self.frame_inner()?; // the immutable borrow ends here, so the mutable walk below is fine (NLL)
        let cell = self
            .cells
            .iter_mut()
            .find(|c| c.active && c.row == 0 && c.col == 0)?;
        cell.blocks.iter_mut().find_map(|b| {
            if let Block::Table(t) = b {
                Some(t)
            } else {
                None
            }
        })
    }

    /// The table a click/edit at `(row, col)` should target: the inner table for a frame wrapper, else
    /// this table. Use everywhere a cell is read/edited so nested 자가진단표 cells become editable.
    pub fn edit_target(&self) -> &Table {
        self.frame_inner().unwrap_or(self)
    }

    /// Mutable [`edit_target`]. Two-phase (probe immutably, then re-borrow mutably) to satisfy the
    /// borrow checker — returning `self` in a `match self.frame_inner_mut()` arm would overlap borrows.
    pub fn edit_target_mut(&mut self) -> &mut Table {
        if self.frame_inner().is_some() {
            self.frame_inner_mut()
                .expect("frame_inner_mut agrees with frame_inner")
        } else {
            self
        }
    }
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
    /// `[start, end)` byte range of this cell's `<hp:tc>…</hp:tc>` within `Section.provenance.raw`
    /// (set by the HWPX parser only) — lets the serializer patch ONLY a dirty cell's subList
    /// content in place while the rest of the table stays byte-verbatim (issue 057). `None` ⇒
    /// synthesized/inserted cell (no original XML) → the enclosing table falls back to a
    /// whole-table re-emit (still anchored in place when the table carries a span).
    pub src_span: Option<(usize, usize)>,
    /// Cell-OWN inner padding `[left, right, top, bottom]` (HWPUNIT) — `Some` ONLY when the cell
    /// declares its own margins (HWP list_attr bit 16, `apply_inner_margin`; HWPX `hasMargin="1"`).
    /// `None` = inherit the table default ([`Table::padding`], else the serializer's legacy 510/141).
    /// Captured for faithful HWPX re-emission (issue 054, F2); the typesetter keeps its constant
    /// `CELL_PAD` (the 020-calibrated reserve) and does not consume this yet.
    pub padding: Option<[HwpUnit; 4]>,
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

/// Slash = bottom-left→top-right (/); BackSlash = top-left→bottom-right (\\);
/// Cross = both drawn together (X) — HWP set BOTH the slash and backslash direction bits (062-4).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DiagonalKind {
    Slash,
    BackSlash,
    Cross,
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
            src_span: None,
            padding: None,
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

// ---- Undo snapshot memory estimator (issue 071) -----------------------------------------------

impl SemanticDoc {
    /// APPROXIMATE heap bytes a deep copy ([`Clone`]) of this document retains — the estimator
    /// behind the undo snapshot MEMORY BUDGET (issue 071; 070 실측: 130p 문서 스냅샷당 ~8MB 딥카피가
    /// 편집 50회에 RSS +403MB). Counting rule: every `Vec<T>` contributes its SPINE
    /// (`len × size_of::<T>()` — which already includes by-value struct/enum bodies), plus each
    /// element's OWN heap (strings, raw buffers, nested vecs). `String`/`Vec<u8>` contribute `len`.
    /// Used ONLY for snapshot eviction, never correctness — ±2× accuracy is acceptable; when
    /// extending the model, count new heap carriers here but never double-count by-value fields.
    pub fn approx_heap_bytes(&self) -> usize {
        use std::mem::size_of;
        fn os(x: &Option<String>) -> usize {
            x.as_ref().map_or(0, |v| v.len())
        }
        fn prov(p: &Provenance) -> usize {
            p.raw.as_ref().map_or(0, |r| r.len())
        }
        fn pass(p: &Passthrough) -> usize {
            p.parts.len() * size_of::<crate::types::RawPart>()
                + p.parts
                    .iter()
                    .map(|r| r.tag.len() + r.bytes.len())
                    .sum::<usize>()
        }
        fn inline(i: &Inline) -> usize {
            match i {
                Inline::Text(t) => t.len(),
                Inline::Image(img) => img.bin_ref.len(),
                Inline::Equation(eq) => {
                    eq.script.len()
                        + eq.font.len()
                        + eq.version.len()
                        + eq.rendered_svg.as_ref().map_or(0, |v| v.len())
                }
                Inline::Chart(c) => c.rendered_svg.as_ref().map_or(0, |v| v.len()),
                Inline::FieldBegin(f) => f.field_type.len() + f.command.len(),
                Inline::FieldEnd(_) => 0,
                Inline::Bookmark(b) => b.len(),
                Inline::Note(n) => blocks(&n.body),
                Inline::Raw(r) => r.tag.len() + r.bytes.len(),
            }
        }
        fn para(p: &Paragraph) -> usize {
            os(&p.style_name)
                + p.source
                    .as_ref()
                    .map_or(0, |src| os(&src.para_pr) + os(&src.style) + os(&src.id))
                + prov(&p.provenance)
                + pass(&p.passthrough)
                + p.runs.len() * size_of::<Run>()
                + p.runs
                    .iter()
                    .map(|r| {
                        os(&r.char_ref)
                            + r.content.len() * size_of::<Inline>()
                            + r.content.iter().map(inline).sum::<usize>()
                    })
                    .sum::<usize>()
        }
        fn table(t: &Table) -> usize {
            (t.col_widths.len() + t.row_heights.len() + t.stored_row_heights.len())
                * size_of::<HwpUnit>()
                + t.cells.len() * size_of::<Cell>()
                + t.cells.iter().map(|c| blocks(&c.blocks)).sum::<usize>()
        }
        fn blocks(bs: &[Block]) -> usize {
            std::mem::size_of_val(bs)
                + bs.iter()
                    .map(|b| match b {
                        Block::Paragraph(p) => para(p),
                        Block::Table(t) => table(t),
                    })
                    .sum::<usize>()
        }
        let sections = self.sections.len() * size_of::<Section>()
            + self
                .sections
                .iter()
                .map(|sec| {
                    blocks(&sec.blocks)
                        + sec.decorations.len() * size_of::<PageDecoration>()
                        + sec
                            .decorations
                            .iter()
                            .map(|d| blocks(&d.blocks))
                            .sum::<usize>()
                        + prov(&sec.provenance)
                        + pass(&sec.passthrough)
                })
                .sum::<usize>();
        let pools = self.char_shapes.len() * size_of::<CharShape>()
            + self.para_shapes.len() * size_of::<ParaShape>();
        let bins = self.bin_data.len() * size_of::<BinData>()
            + self
                .bin_data
                .iter()
                .map(|b| b.bin_ref.len() + b.bytes.len() + b.kind.len())
                .sum::<usize>();
        // header_pools(파싱 원본 풀 값 맵)는 문서 크기에 비해 작고 형태가 맵이라 생략 — 과소추정 쪽
        // 오차는 BTreeSet 노드 오버헤드 상수(×3)로 일부 상쇄한다.
        sections
            + pools
            + bins
            + pass(&self.passthrough)
            + (self.hwpx_pool_char_shapes.len() + self.hwpx_pool_para_shapes.len())
                * size_of::<usize>()
                * 3
    }
}

#[cfg(test)]
mod frame_wrapper_tests {
    use super::*;

    fn n_row_table(rows: usize) -> Table {
        Table {
            rows,
            cols: 1,
            cells: (0..rows)
                .map(|r| Cell {
                    row: r,
                    col: 0,
                    active: true,
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        }
    }

    #[test]
    fn frame_inner_unwraps_1x1_wrapping_a_multirow_table() {
        // The 자가진단표 shape: a 1×1 whose only cell holds one multi-row table → edits resolve to it.
        let wrapper = Table {
            rows: 1,
            cols: 1,
            cells: vec![Cell {
                row: 0,
                col: 0,
                active: true,
                blocks: vec![Block::Table(n_row_table(3))],
                ..Default::default()
            }],
            ..Default::default()
        };
        assert_eq!(wrapper.frame_inner().map(|t| t.rows), Some(3));
        assert_eq!(wrapper.edit_target().rows, 3);
        assert_eq!(wrapper.clone().edit_target_mut().rows, 3);

        // A normal table is its own edit target (no unwrap).
        let normal = n_row_table(2);
        assert!(normal.frame_inner().is_none());
        assert_eq!(normal.edit_target().rows, 2);

        // A 1×1 holding TEXT (not just a table) is NOT a frame wrapper — keep the whole cell.
        let mut with_text = wrapper.clone();
        with_text.cells[0].blocks.push(Block::Paragraph(Paragraph {
            runs: vec![Run {
                content: vec![Inline::Text("내용".into())],
                ..Default::default()
            }],
            ..Default::default()
        }));
        assert!(
            with_text.frame_inner().is_none(),
            "text beside the table → not a pure wrapper"
        );
    }
}
