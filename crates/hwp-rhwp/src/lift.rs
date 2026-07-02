//! rhwp `Document` → our `SemanticDoc` lift.
//!
//! A DEEP lift: sections → paragraphs (text split into per-formatting runs) and tables
//! (rows/cols/cells with spans + cell paragraphs), PLUS the document's `charPr`/`paraPr` pools
//! translated into our `char_shapes`/`para_shapes` (mirrored into `header_pools` for the editor).
//! Runs are split at rhwp `CharShapeRef` boundaries so per-run bold/italic/size/color survive into
//! the HWP5→HWPX conversion. Un-modeled inline objects (equation/shape/field/image) are not yet
//! emitted (they remain faithfully RENDERED via rhwp's own pipeline); fonts-per-script,
//! sub/superscript, numbering and underline color are deferred (the serializer doesn't emit them
//! yet — see crates/hwp-hwpx/src/synth.rs).

use std::cell::RefCell;
use std::collections::HashMap;

use hwp_model::prelude::*;
use rhwp::model::control::Control;
use rhwp::model::document::Document as RDoc;
use rhwp::model::page::PageDef;
use rhwp::model::paragraph::Paragraph as RParagraph;
use rhwp::model::style::{
    Alignment, CharShape as RCharShape, ParaShape as RParaShape, UnderlineType,
};
use rhwp::model::table::Table as RTable;

/// Parse HWP/HWPX bytes via rhwp and lift into our format-neutral `SemanticDoc`.
pub fn parse_to_semantic(bytes: &[u8]) -> Result<SemanticDoc> {
    let doc = rhwp::parse_document(bytes).map_err(|e| Error::Parse(e.to_string()))?;
    Ok(Lifter::new(&doc).run())
}

/// Stateful lift: translates rhwp's pools once, recording rhwp-id → our-index maps so every
/// run/paragraph references a VALID translated shape (never a raw rhwp id — that was the old
/// dangling-ref bug where `para_shape_id` was forwarded straight into our index space).
struct Lifter<'a> {
    doc: &'a RDoc,
    /// rhwp `char_shapes` index → our `char_shapes` index (always ≥ 1; 0 is the reserved default).
    char_id_to_idx: HashMap<u32, usize>,
    /// rhwp `para_shapes` index → our `para_shapes` index.
    para_id_to_idx: HashMap<u16, usize>,
    /// Embedded images collected from Picture controls (deduped by rhwp bin_data_id). `RefCell` so
    /// the `&self` recursive lift (paragraphs → tables → cell paragraphs) can register into it.
    bin_data: RefCell<Vec<BinData>>,
    /// rhwp `bin_data_id` (1-based) → our `bin_ref` ("image{id}"), so a re-referenced image is
    /// emitted once.
    bin_seen: RefCell<HashMap<u16, String>>,
    /// Monotonic fallback id for fields lacking a stable `field_id` (so begin/end stay paired).
    field_seq: RefCell<u32>,
}

impl<'a> Lifter<'a> {
    fn new(doc: &'a RDoc) -> Self {
        Self {
            doc,
            char_id_to_idx: HashMap::new(),
            para_id_to_idx: HashMap::new(),
            bin_data: RefCell::new(Vec::new()),
            bin_seen: RefCell::new(HashMap::new()),
            field_seq: RefCell::new(900_000_000),
        }
    }

    fn run(mut self) -> SemanticDoc {
        let mut out = SemanticDoc::default();
        // Index 0 is the canonical default in our model (a run/paragraph with no resolvable ref maps
        // here; the serializer reuses the document's default charPr/paraPr for it).
        out.char_shapes.push(CharShape::default());
        out.para_shapes.push(ParaShape::default());

        for (i, rcs) in self.doc.doc_info.char_shapes.iter().enumerate() {
            let cs = lift_char_shape(rcs, self.doc);
            let idx = out.char_shapes.len();
            self.char_id_to_idx.insert(i as u32, idx);
            out.header_pools.char.insert(i as u64, cs.clone());
            out.char_shapes.push(cs);
        }
        for (i, rps) in self.doc.doc_info.para_shapes.iter().enumerate() {
            let ps = lift_para_shape(rps);
            let idx = out.para_shapes.len();
            self.para_id_to_idx.insert(i as u16, idx);
            out.header_pools.para.insert(i as u64, ps.clone());
            out.para_shapes.push(ps);
        }

        for sec in &self.doc.sections {
            let mut section = Section {
                page: lift_page(&sec.section_def.page_def),
                // The converted HWPX seeds the Skeleton's secPr (hardcoded landscape A4); mark the
                // page edited so the serializer patches in THIS document's real geometry/orientation.
                page_edited: true,
                provenance: Provenance { source: Some(SourceFormat::Hwp5), raw: None },
                ..Default::default()
            };
            for para in &sec.paragraphs {
                self.push_paragraph(para, &mut section.blocks);
                // 머리말/꼬리말 are section-scoped but anchored in a paragraph's controls.
                for ctrl in &para.controls {
                    match ctrl {
                        Control::Header(h) => section.decorations.push(PageDecoration {
                            kind: DecoKind::Header,
                            apply: lift_apply(h.apply_to),
                            blocks: self.lift_body(&h.paragraphs),
                        }),
                        Control::Footer(f) => section.decorations.push(PageDecoration {
                            kind: DecoKind::Footer,
                            apply: lift_apply(f.apply_to),
                            blocks: self.lift_body(&f.paragraphs),
                        }),
                        _ => {}
                    }
                }
            }
            out.sections.push(section);
        }
        out.bin_data = self.bin_data.into_inner();
        out
    }

    /// Recurse a header/footer/note body's paragraphs into our blocks.
    fn lift_body(&self, paras: &[RParagraph]) -> Vec<Block> {
        let mut body = Vec::new();
        for bp in paras {
            self.push_paragraph(bp, &mut body);
        }
        body
    }

    /// Emit a paragraph (text split into per-shape runs + inline foot/endnote markers), then any
    /// block-level objects (tables, pictures, equations) anchored in its controls.
    fn push_paragraph(&self, p: &RParagraph, blocks: &mut Vec<Block>) {
        let mut runs = self.lift_runs(p);
        // Inline foot/endnote reference markers — appended at paragraph end for v1 (exact mid-run
        // anchoring is a later refinement); the note body renders at the page foot / document end.
        for ctrl in &p.controls {
            match ctrl {
                Control::Footnote(fp) => runs.push(marker_run(Inline::Note(self.lift_note(
                    &fp.paragraphs,
                    NoteKind::Foot,
                    fp.number,
                    fp.before_decoration_letter,
                    fp.after_decoration_letter,
                    fp.instance_id,
                )))),
                Control::Endnote(en) => runs.push(marker_run(Inline::Note(self.lift_note(
                    &en.paragraphs,
                    NoteKind::End,
                    en.number,
                    en.before_decoration_letter,
                    en.after_decoration_letter,
                    en.instance_id,
                )))),
                _ => {}
            }
        }
        // A pure table anchor: this host paragraph carries a Table control and NO visible text — Hancom
        // reserves no line for it, so flag it for the paginators to skip its height. A text-empty
        // paragraph that does NOT host a table (a genuine blank spacer) is left unflagged (keeps its line).
        let hosts_table = p.controls.iter().any(|c| matches!(c, Control::Table(_)));
        let text_empty = !runs
            .iter()
            .any(|r| r.content.iter().any(|i| matches!(i, Inline::Text(s) if !s.trim().is_empty())));
        let is_table_anchor = hosts_table && text_empty;
        blocks.push(Block::Paragraph(Paragraph {
            para_shape: self.para_id_to_idx.get(&p.para_shape_id).copied().unwrap_or(0),
            runs,
            // A hard 쪽/구역 나누기 carried on the PARAGRAPH (not the shared para_shape). Hancom paginates
            // these gov templates by forced page breaks on chapter headings — without honoring them our
            // page count only matched by coincidence (inflated heights). Page and Section both start a
            // fresh page for our purposes.
            page_break_before: matches!(
                p.column_type,
                rhwp::model::paragraph::ColumnBreakType::Page | rhwp::model::paragraph::ColumnBreakType::Section
            ),
            is_table_anchor,
            provenance: Provenance { source: Some(SourceFormat::Hwp5), raw: None },
            ..Default::default()
        }));

        for ctrl in &p.controls {
            match ctrl {
                Control::Table(t) => blocks.push(Block::Table(self.lift_table(t))),
                Control::Picture(pic) => {
                    if let Some(img) = self.lift_picture(pic) {
                        blocks.push(object_paragraph(Inline::Image(img)));
                    }
                }
                Control::Equation(eq) => {
                    blocks.push(object_paragraph(Inline::Equation(lift_equation(eq))));
                }
                _ => {}
            }
        }
    }

    /// Lift a foot/endnote: recurse its body paragraphs (which may themselves carry tables/images/
    /// notes) and capture the number + decoration chars.
    #[allow(clippy::too_many_arguments)]
    fn lift_note(
        &self,
        paras: &[RParagraph],
        kind: NoteKind,
        number: u16,
        prefix_char: u16,
        suffix_char: u16,
        inst_id: u32,
    ) -> NoteRef {
        NoteRef { kind, number, prefix_char, suffix_char, inst_id, body: self.lift_body(paras) }
    }

    /// Lift an rhwp `Picture` → `ImageRef`, registering its bytes into `bin_data` (deduped by the
    /// rhwp `bin_data_id`). Returns None for an unresolved / external (no embedded bytes) image.
    fn lift_picture(&self, pic: &rhwp::model::image::Picture) -> Option<ImageRef> {
        let bin_id = pic.image_attr.bin_data_id;
        if bin_id == 0 {
            return None;
        }
        // rhwp bin ids are 1-based; the binary is at bin_data_content[id-1], else by .id match.
        let content = self
            .doc
            .bin_data_content
            .get((bin_id - 1) as usize)
            .filter(|c| !c.data.is_empty())
            .or_else(|| self.doc.bin_data_content.iter().find(|c| c.id == bin_id && !c.data.is_empty()))?;

        let seen = self.bin_seen.borrow().get(&bin_id).cloned();
        let bin_ref = if let Some(r) = seen {
            r
        } else {
            // Normalize the extension (drop a leading dot, lowercase): "PNG" / ".png" → "png".
            let kind = content.extension.trim_start_matches('.').to_ascii_lowercase();
            let kind = if kind.is_empty() { "png".to_string() } else { kind };
            let r = format!("image{bin_id}");
            self.bin_data.borrow_mut().push(BinData {
                bin_ref: r.clone(),
                bytes: content.data.clone(),
                kind,
            });
            self.bin_seen.borrow_mut().insert(bin_id, r.clone());
            r
        };

        Some(ImageRef {
            bin_ref,
            width: pic.common.width as i32,
            height: pic.common.height as i32,
        })
    }

    /// Split a paragraph's text into runs at its `CharShapeRef` boundaries, each run referencing the
    /// translated char_shape index. Slicing is by CHAR index (converted from rhwp's UTF-16 offsets)
    /// so non-BMP characters (emoji, rare hanja) never corrupt a boundary. Full text coverage is
    /// guaranteed (a leading gap before the first ref becomes a default-shape run) — text is never
    /// dropped.
    fn lift_runs(&self, p: &RParagraph) -> Vec<Run> {
        if p.text.is_empty() {
            return Vec::new();
        }
        let chars: Vec<char> = p.text.chars().collect();
        let total = chars.len();

        // (char_start, our char_shape index), sorted, covering [0, total).
        let mut bounds: Vec<(usize, usize)> = p
            .char_shapes
            .iter()
            .map(|r| {
                let start = utf16_to_char_idx(&p.text, r.start_pos).min(total);
                let idx = self.char_id_to_idx.get(&r.char_shape_id).copied().unwrap_or(0);
                (start, idx)
            })
            .collect();
        bounds.sort_by_key(|b| b.0);
        if bounds.first().map(|b| b.0) != Some(0) {
            bounds.insert(0, (0, 0)); // leading text with no style ref → default shape
        }

        // (run, start_char) so field markers can snap to run boundaries.
        let mut runs: Vec<(Run, usize)> = Vec::new();
        for k in 0..bounds.len() {
            let (start, idx) = bounds[k];
            let end = bounds.get(k + 1).map(|b| b.0).unwrap_or(total);
            if start >= end {
                continue; // zero-width or out-of-order boundary
            }
            let text: String = chars[start..end].iter().collect();
            runs.push((Run { char_shape: idx, content: vec![Inline::Text(text)], ..Default::default() }, start));
        }
        if runs.is_empty() {
            // Defensive: every boundary collapsed → keep the whole text as one default run.
            runs.push((Run {
                char_shape: 0,
                content: vec![Inline::Text(p.text.clone())],
                ..Default::default()
            }, 0));
        }
        self.splice_field_markers(p, runs)
    }

    /// Wrap field ranges (hyperlinks / click-here) in `Inline::FieldBegin`/`FieldEnd` marker runs,
    /// snapped to run boundaries. Unknown field types are skipped (the spanned text still
    /// round-trips). Markers are kept balanced so the open-safety validator's pairing check passes.
    fn splice_field_markers(&self, p: &RParagraph, runs: Vec<(Run, usize)>) -> Vec<Run> {
        if p.field_ranges.is_empty() {
            return runs.into_iter().map(|(r, _)| r).collect();
        }
        // First run whose start char is ≥ pos (else past the end).
        let idx_at = |pos: usize| runs.iter().position(|(_, s)| *s >= pos).unwrap_or(runs.len());
        // (run_index, ordering, marker run). ord at the same index: field-end(0) < begin(1) < zero-len-end(2).
        let mut inserts: Vec<(usize, u8, Run)> = Vec::new();
        for fr in &p.field_ranges {
            let Some(Control::Field(field)) = p.controls.get(fr.control_idx) else { continue };
            let Some((ftype, command)) = field_type_token(field) else { continue };
            let id = if field.field_id != 0 {
                field.field_id
            } else {
                let mut s = self.field_seq.borrow_mut();
                *s += 1;
                *s
            };
            let begin = marker_run(Inline::FieldBegin(FieldMarker { id, field_type: ftype, command }));
            let end = marker_run(Inline::FieldEnd(id));
            let bi = idx_at(fr.start_char_idx);
            if fr.end_char_idx <= fr.start_char_idx {
                inserts.push((bi, 1, begin)); // zero-length: begin…
                inserts.push((bi, 2, end)); // …then end, adjacent
            } else {
                inserts.push((bi, 1, begin));
                inserts.push((idx_at(fr.end_char_idx), 0, end));
            }
        }
        inserts.sort_by_key(|(i, ord, _)| (*i, *ord));
        let mut it = inserts.into_iter().peekable();
        let mut out = Vec::new();
        for (i, (run, _)) in runs.into_iter().enumerate() {
            while it.peek().is_some_and(|(idx, _, _)| *idx == i) {
                out.push(it.next().unwrap().2);
            }
            out.push(run);
        }
        for (_, _, m) in it {
            out.push(m); // markers anchored past the last run
        }
        out
    }

    fn lift_table(&self, t: &RTable) -> Table {
        let cells = t
            .cells
            .iter()
            .map(|c| {
                let mut blocks = Vec::new();
                for p in &c.paragraphs {
                    self.push_paragraph(p, &mut blocks);
                }
                Cell {
                    row: c.row as usize,
                    col: c.col as usize,
                    row_span: c.row_span.max(1) as usize,
                    col_span: c.col_span.max(1) as usize,
                    blocks,
                    active: true,
                    shade_color: self.cell_shade(c.border_fill_id),
                    has_border: self.cell_has_border(c.border_fill_id),
                    borders: self.cell_borders(c.border_fill_id),
                    diagonal: self.cell_diagonal(c.border_fill_id),
                    ..Default::default()
                }
            })
            .collect();

        Table {
            rows: t.row_count as usize,
            cols: t.col_count as usize,
            // MINIMUM row-height floors from Hancom's stored cell heights (issue 020). HWP writes each
            // cell's laid-out height; where that height EXCEEDS our content-measured height, the row is a
            // fixed/minimum-height row (측정: benchmark1 표순번 6 rows sit at 2990 HWPUNIT regardless of
            // their 1–2 line content, with declared padding only 280 — a real min-row-height, NOT extra
            // padding). `apply_row_overrides` honors these as a FLOOR (max(content, floor)) in BOTH
            // sizing twins, so content-driven rows (where content ≥ stored) are untouched and only the
            // genuinely fixed rows grow. Without this, the cell-paragraph trailing-leading fix
            // (hwp_typeset::cell_paragraph_height) UNMASKS these min-heights and benchmark1 under-shoots
            // to 17; together they land Hancom's 18 exactly (bench.hwp stays 8). A row-spanning cell
            // distributes its stored height evenly (height/span) so the sum over the span is preserved.
            row_heights: stored_row_heights(&t.cells, t.row_count as usize),
            // Per-column widths (HWPUNIT) for faithful column proportions on render.
            col_widths: derive_col_widths(&t.cells, t.col_count as usize),
            // Outer vertical margins (바깥 여백) so consecutive tables keep HWP's real gap on render.
            outer_margin_top: t.outer_margin_top.max(0) as i32,
            outer_margin_bottom: t.outer_margin_bottom.max(0) as i32,
            cells,
            provenance: Provenance { source: Some(SourceFormat::Hwp5), raw: None },
            ..Default::default()
        }
    }

    /// Whether a cell's `border_fill_id` defines ANY visible edge (a line_type other than 선없음/None).
    /// Cells whose four edges are all None render with no border box, so the renderer can skip them
    /// instead of drawing a spurious black grid line. Unknown/missing borderFill → keep a border
    /// (conservative: a real table cell without resolvable style still shows its grid).
    fn cell_has_border(&self, border_fill_id: u16) -> bool {
        let Some(idx) = (border_fill_id as usize).checked_sub(1) else { return true };
        let Some(bf) = self.doc.doc_info.border_fills.get(idx) else { return true };
        use rhwp::model::style::BorderLineType;
        bf.borders.iter().any(|b| b.line_type != BorderLineType::None)
    }

    /// Lift a cell's four per-edge borders from its `border_fill_id` so the renderer can draw exactly
    /// the sides the doc specifies (each with its color/style/width), not one uniform box. Ordering is
    /// HWP's `[left, right, top, bottom]`, mirrored into our `Cell::borders`. Every edge is `Some`
    /// (incl. 선없음 → `LineStyle::None`, which the renderer SKIPS) so `Cell::has_edge_borders()` is
    /// true and the legacy uniform box is bypassed. Unknown/missing borderFill → `[None;4]` (the cell
    /// falls back to the legacy `has_border` box — inserted/test cells keep their normal grid).
    fn cell_borders(&self, border_fill_id: u16) -> [Option<CellEdge>; 4] {
        let Some(idx) = (border_fill_id as usize).checked_sub(1) else { return [None; 4] };
        let Some(bf) = self.doc.doc_info.border_fills.get(idx) else { return [None; 4] };
        let mut out = [None; 4];
        for (i, b) in bf.borders.iter().enumerate().take(4) {
            out[i] = Some(CellEdge {
                color: opaque(lift_text_color(b.color)),
                style: lift_line_style(b.line_type),
                width_px: border_width_to_px(b.width),
            });
        }
        out
    }

    /// Lift a cell's diagonal line (HWP borderFill `diagonal`) ONLY when the borderFill's `attr`
    /// property bits actually request one. CRITICAL: a borderFill ALWAYS carries a `diagonal` border
    /// (type/width/color) as the STYLE to use IF a diagonal is drawn — its width is non-zero for nearly
    /// every cell, so keying off `width` drew a slash through every cell (the bug behind the spurious
    /// diagonals on empty table rows). The real "is a diagonal drawn" signal is the attr bits (mirrors
    /// rhwp's own renderer/layout/border_rendering.rs):
    ///   slash_bits     = (attr >> 2) & 0b111   // 0 = none, else a "/" diagonal
    ///   backslash_bits = (attr >> 5) & 0b111   // 0 = none, else a "\\" diagonal
    /// Both zero → no diagonal. The section-header banner's filler cell DOES set these bits → its pointed
    /// pentagon end still draws.
    fn cell_diagonal(&self, border_fill_id: u16) -> Option<CellDiagonal> {
        let idx = (border_fill_id as usize).checked_sub(1)?;
        let bf = self.doc.doc_info.border_fills.get(idx)?;
        let kind = diagonal_kind(bf.attr, bf.diagonal.diagonal_type)?;
        let d = &bf.diagonal;
        // Style from the diagonal border (color + width); border_width_to_px floors a 0/unset width to a
        // hairline so a requested-but-zero-width diagonal still draws.
        Some(CellDiagonal { kind, color: opaque(lift_text_color(d.color)), width_px: border_width_to_px(d.width) })
    }

    /// Resolve a cell's `border_fill_id` (1-based, per rhwp) → its solid background as a shade color,
    /// or `None` for an unfilled / white cell. This is the gray header/title shading HWP docs use.
    fn cell_shade(&self, border_fill_id: u16) -> Option<Color> {
        let idx = (border_fill_id as usize).checked_sub(1)?;
        let bf = self.doc.doc_info.border_fills.get(idx)?;
        // Prefer a solid background; otherwise approximate a GRADIENT fill by the mean of its stops
        // (we don't render gradients yet, but a flat fill is far better than dropping the header
        // shading entirely — without this, gradient-filled headers render with no background).
        let color = if let Some(solid) = bf.fill.solid.as_ref() {
            lift_text_color(solid.background_color)
        } else if let Some(g) = bf.fill.gradient.as_ref().filter(|g| !g.colors.is_empty()) {
            let (mut r, mut gg, mut b) = (0u32, 0u32, 0u32);
            for &c in &g.colors {
                let col = lift_text_color(c);
                r += col.r as u32;
                gg += col.g as u32;
                b += col.b as u32;
            }
            let n = g.colors.len() as u32;
            Color { r: (r / n) as u8, g: (gg / n) as u8, b: (b / n) as u8, a: 255 }
        } else {
            return None;
        };
        // Skip "no shade": white (the default cell background) and pure black (unset) add no signal.
        if color == (Color { r: 255, g: 255, b: 255, a: 255 }) || color == Color::default() {
            return None;
        }
        Some(color)
    }
}

/// Convert a UTF-16 code-unit offset (rhwp `CharShapeRef.start_pos`) to a char (Unicode scalar)
/// index into `text`. rhwp stores positions in UTF-16; slicing a Rust `String` needs char indices,
/// and the two diverge across non-BMP characters (each costs 2 UTF-16 units but 1 char).
fn utf16_to_char_idx(text: &str, utf16_pos: u32) -> usize {
    let mut units = 0u32;
    for (char_idx, ch) in text.chars().enumerate() {
        if units >= utf16_pos {
            return char_idx;
        }
        units += ch.len_utf16() as u32;
    }
    text.chars().count()
}

/// Translate an rhwp `CharShape` into ours — but ONLY the fields the HWPX serializer actually emits
/// (`synthesize_char_pr`: height, bold, italic, underline-on, strikeout-on, text color). Per-script
/// font/장평/자간, sub/superscript, emphasis, and underline color are left at our defaults: the
/// serializer can't emit them yet, and setting them would only force redundant charPr synthesis
/// (it dedups identical results back to the document's default charPr).
/// Wrap a single inline object (image / equation) in its own paragraph block, emitted in reading
/// order after the text paragraph it was anchored in. (Exact mid-run anchoring is a later refinement.)
fn object_paragraph(inline: Inline) -> Block {
    Block::Paragraph(Paragraph {
        runs: vec![Run { char_shape: 0, content: vec![inline], ..Default::default() }],
        provenance: Provenance { source: Some(SourceFormat::Hwp5), raw: None },
        ..Default::default()
    })
}

/// Per-row MINIMUM-height floors (HWPUNIT) from Hancom's stored cell heights — the min-row-height
/// mechanism (issue 020). Each cell contributes `height / row_span` to every row it spans (so the sum
/// over a merged span is preserved), taking the max across cells in a row. `apply_row_overrides` honors
/// the result as a FLOOR, so content-driven rows are untouched and only genuinely fixed rows grow. A
/// height of 0 (empty/unsized cell) leaves the row content-sized. See the call site for why this pairs
/// with the trailing-leading trim to land benchmark1's 18 pages.
fn stored_row_heights(cells: &[rhwp::model::table::Cell], rows: usize) -> Vec<i32> {
    let mut row_h = vec![0i32; rows];
    for c in cells {
        let span = c.row_span.max(1) as usize;
        let per = (c.height as i32) / span as i32;
        if per <= 0 {
            continue;
        }
        let start = c.row as usize;
        let end = (start + span).min(rows);
        for slot in row_h.iter_mut().take(end).skip(start) {
            *slot = (*slot).max(per);
        }
    }
    row_h
}

/// Derive per-column widths (HWPUNIT) from ALL cells, including spanning ones.
///
/// rhwp's `get_column_widths` only reads `col_span == 1` cells, so a column that appears ONLY under a
/// spanning cell gets no width and falls back to a 1800 default — far too narrow. In gov 일반현황
/// tables the 직업 value column (covered only by spans) collapsed this way, cramping its text to many
/// short lines. We seed exact widths from single-column cells, then iteratively resolve span-only
/// columns: for a span whose other columns are known, the leftover width is split among the unknown
/// columns. Remaining unknowns keep the 1800 fallback. Proportions then match Hancom's grid.
fn derive_col_widths(cells: &[rhwp::model::table::Cell], cols: usize) -> Vec<i32> {
    if cols == 0 {
        return Vec::new();
    }
    let mut w = vec![0u32; cols];
    let mut known = vec![false; cols];
    // 1) Single-column cells give exact column widths (max across rows).
    for c in cells {
        let col = c.col as usize;
        if c.col_span <= 1 && col < cols {
            w[col] = w[col].max(c.width);
            known[col] = true;
        }
    }
    // 2) Resolve columns that only appear under spans: a span's width minus its known columns,
    //    split evenly among its unknown columns. Iterate to a fixpoint (spans can chain).
    let mut changed = true;
    while changed {
        changed = false;
        for c in cells {
            let span = c.col_span.max(1) as usize;
            let start = c.col as usize;
            if span <= 1 || start >= cols {
                continue;
            }
            let end = (start + span).min(cols);
            let unknown: Vec<usize> = (start..end).filter(|&i| !known[i]).collect();
            if unknown.is_empty() {
                continue;
            }
            let known_sum: u32 = (start..end).filter(|&i| known[i]).map(|i| w[i]).sum();
            if c.width <= known_sum {
                continue; // can't split a non-positive remainder sensibly
            }
            let each = (c.width - known_sum) / unknown.len() as u32;
            if each == 0 {
                continue;
            }
            for &i in &unknown {
                w[i] = each;
                known[i] = true;
            }
            changed = true;
        }
    }
    // 3) Any column still unresolved → the historical default (keeps prior behaviour for odd tables).
    for x in &mut w {
        if *x == 0 {
            *x = 1800;
        }
    }
    w.into_iter().map(|x| x as i32).collect()
}

/// Map rhwp's header/footer apply scope to ours.
fn lift_apply(a: rhwp::model::header_footer::HeaderFooterApply) -> ApplyPage {
    use rhwp::model::header_footer::HeaderFooterApply as HFA;
    match a {
        HFA::Both => ApplyPage::Both,
        HFA::Even => ApplyPage::Even,
        HFA::Odd => ApplyPage::Odd,
    }
}

/// A run carrying a single inline marker (field begin/end, bookmark).
fn marker_run(inline: Inline) -> Run {
    Run { char_shape: 0, content: vec![inline], ..Default::default() }
}

/// Map an rhwp field to its OWPML (type token, command). v1 handles HYPERLINK only — its command is
/// a plain URL (low risk). Other field types (click-here forms, cross-refs, …) return None so the
/// spanned text still round-trips without a (riskier) synthesized field.
fn field_type_token(field: &rhwp::model::control::Field) -> Option<(String, String)> {
    use rhwp::model::control::FieldType;
    match field.field_type {
        FieldType::Hyperlink => Some(("HYPERLINK".to_string(), field.command.clone())),
        _ => None,
    }
}

/// Lift an rhwp `Equation` → `EquationRef`. The HWP equation script and OWPML `<hp:script>` are the
/// same markup language, so the script round-trips verbatim (no transcode).
fn lift_equation(eq: &rhwp::model::control::Equation) -> EquationRef {
    EquationRef {
        script: eq.script.clone(),
        font: eq.font_name.clone(),
        base_unit: eq.font_size,
        baseline: eq.baseline,
        color: lift_text_color(eq.color),
        width: eq.common.width as i32,
        height: eq.common.height as i32,
        version: eq.version_info.clone(),
    }
}

fn lift_char_shape(c: &RCharShape, doc: &RDoc) -> CharShape {
    CharShape {
        height: c.base_size,
        // 장평/자간 drive cell line-breaking (this doc compresses dense table text to ratio 90–98% /
        // spacing −5…−12); dropping them over-wrapped the 자가진단/동의서 tables → extra pages. rhwp's
        // per-script arrays are already in our ScriptClass order (Hangul, Latin, Hanja, Japanese, Other,
        // Symbol, User). Display/export still ignore these — they exist for the line-break advance.
        ratio: PerScript(c.ratios),
        spacing: PerScript(c.spacings),
        bold: c.bold,
        italic: c.italic,
        underline: c.underline_type != UnderlineType::None,
        strikeout: c.strikethrough,
        superscript: c.superscript,
        subscript: c.subscript,
        text_color: lift_text_color(c.text_color),
        fonts: lift_fonts(c, doc),
        ..Default::default()
    }
}

/// Resolve the char-shape's per-script font NAMES from rhwp's per-language font tables
/// (`doc_info.font_faces[lang][font_ids[lang]]`). Returns a 7-slot Vec (Hangul..User) aligned with
/// our `ScriptClass` order; a slot is `None` when the font table lacks that id or the name is empty.
fn lift_fonts(c: &RCharShape, doc: &RDoc) -> Vec<Option<String>> {
    (0..7)
        .map(|i| {
            let fid = c.font_ids[i] as usize;
            doc.doc_info
                .font_faces
                .get(i)
                .and_then(|lang| lang.get(fid))
                .map(|f| f.name.clone())
                .filter(|n| !n.is_empty())
        })
        .collect()
}

/// Translate an rhwp `PageDef` (구역 용지 설정) into our `PageSetup`: paper size, the four content
/// margins, and orientation. (HWPUNIT u32 → i32; header/footer/gutter margins and multi-column are
/// not emitted by the page patcher yet, so they're dropped here.)
fn lift_page(pd: &PageDef) -> PageSetup {
    PageSetup {
        width: pd.width as i32,
        height: pd.height as i32,
        margin_left: pd.margin_left as i32,
        margin_right: pd.margin_right as i32,
        margin_top: pd.margin_top as i32,
        margin_bottom: pd.margin_bottom as i32,
        landscape: pd.landscape,
        columns: 1,
    }
}

/// rhwp `ColorRef` is `0x00BBGGRR` (NOT RGB) — unpack the channels by hand. Black (`0x000000`) is
/// the default text color, so it maps to our `Color::default()`: `synthesize_char_pr` only patches
/// `textColor` when the color differs from default, so a plain black run reuses the default charPr.
fn lift_text_color(c: u32) -> Color {
    if c & 0x00FF_FFFF == 0 {
        Color::default()
    } else {
        Color { r: (c & 0xFF) as u8, g: ((c >> 8) & 0xFF) as u8, b: ((c >> 16) & 0xFF) as u8, a: 255 }
    }
}

/// Force a color opaque (`a = 255`). Border/diagonal colors are always opaque visually; this also
/// makes them survive the JSX codec's `#RRGGBB` round-trip cleanly (`from_hex` yields `a = 255`),
/// whereas `lift_text_color`'s black returns `Color::default()` with `a = 0`.
fn opaque(c: Color) -> Color {
    Color { a: 255, ..c }
}

/// Map an rhwp `BorderLineType` to our renderable `LineStyle`. 선없음 (None) → `LineStyle::None` (the
/// renderer skips that edge); dash/long-dash → Dashed; dot/circle → Dotted; the double/triple family
/// → Double; everything else (3D, wave, dash-dot variants) collapses to Solid (we don't draw those
/// special strokes yet — a solid line is a faithful-enough stand-in vs dropping the edge).
fn lift_line_style(lt: rhwp::model::style::BorderLineType) -> LineStyle {
    use rhwp::model::style::BorderLineType as B;
    match lt {
        B::None => LineStyle::None,
        B::Dash | B::LongDash => LineStyle::Dashed,
        B::Dot | B::Circle => LineStyle::Dotted,
        B::Double | B::ThinThickDouble | B::ThickThinDouble | B::ThinThickThinTriple => {
            LineStyle::Double
        }
        _ => LineStyle::Solid,
    }
}

/// Decide a cell's diagonal direction from its borderFill `attr` property bits + the diagonal LINE
/// TYPE — the SAME two-stage gate rhwp's renderer uses (renderer/layout/border_rendering.rs). A diagonal
/// is drawn only when (a) a direction bit is set AND (b) the diagonal line type is non-none:
///   - slash_bits     = (attr >> 2) & 0b111  (0 = no "/" diagonal)
///   - backslash_bits = (attr >> 5) & 0b111  (0 = no "\\" diagonal)
///   - `diagonal_type` is a LINE-STYLE code (0 = 선없음/none) — NOT a direction; a borderFill can set the
///     direction bits with NO `<diagonal>` line element (type 0), and Hancom then draws nothing (rhwp's
///     #1038 guard). Keying off the diagonal border's WIDTH instead drew a slash through nearly every cell.
/// A backslash wins when both bits are set (the rare "X" is collapsed to one line).
fn diagonal_kind(attr: u16, diagonal_type: u8) -> Option<DiagonalKind> {
    let slash = (attr >> 2) & 0b111;
    let backslash = (attr >> 5) & 0b111;
    if (slash == 0 && backslash == 0) || diagonal_type == 0 {
        return None;
    }
    Some(if backslash != 0 { DiagonalKind::BackSlash } else { DiagonalKind::Slash })
}

/// HWP 테두리 굵기 인덱스 → device px (mirrors rhwp's `border_width_to_px`, spec 표 28: mm→96dpi px).
/// Used for both cell edges and the diagonal so our stroke widths match Hancom's visual weight.
///
/// Returns f64 (NOT rounded up): gov-doc tables overwhelmingly use the two thinnest indices (0.4/0.5px
/// hairlines). Rounding those up to 1px made our borders read HEAVIER than the original — so we keep the
/// sub-px value and only clamp the floor to `HAIRLINE_MIN_PX` so a hairline still survives at our scale.
fn border_width_to_px(width: u8) -> f64 {
    /// The thinnest stroke we still draw — a crisp gov-doc hairline. Below this, sub-px strokes
    /// disappear on screen / anti-alias to nothing in the PDF; this keeps them just visible.
    const HAIRLINE_MIN_PX: f64 = 0.5;
    const WIDTHS_PX: [f64; 16] = [
        0.4, 0.5, 0.6, 0.75, 1.0, 1.1, 1.5, 1.9, 2.3, 2.6, 3.8, 5.7, 7.6, 11.3, 15.1, 18.9,
    ];
    let px = if (width as usize) < WIDTHS_PX.len() {
        WIDTHS_PX[width as usize]
    } else {
        (width as f64 * 1.2).clamp(0.4, 20.0)
    };
    px.max(HAIRLINE_MIN_PX)
}

/// Translate an rhwp `ParaShape` into ours — the fields `synthesize_para_pr` emits: alignment and
/// the margin block (indent, left/right margin, space before/after). Line spacing is intentionally
/// left to inherit the base paraPr (a fixed-unit value emitted as PERCENT would distort layout);
/// numbering/border-fill/head-type are deferred (not emitted yet).
fn lift_para_shape(p: &RParaShape) -> ParaShape {
    use rhwp::model::style::LineSpacingType as RLst;
    ParaShape {
        align: match p.alignment {
            Alignment::Left => HorizontalAlign::Left,
            Alignment::Right => HorizontalAlign::Right,
            Alignment::Center => HorizontalAlign::Center,
            Alignment::Distribute => HorizontalAlign::Distribute,
            Alignment::Split => HorizontalAlign::DistributeSpace,
            Alignment::Justify => HorizontalAlign::Justify,
        },
        // Line spacing drives vertical advance (pagination); rhwp's resolver reads `line_spacing`
        // for the percent value (e.g. 160). Map the type so the engine doesn't fall back to 160%.
        line_spacing_type: match p.line_spacing_type {
            RLst::Percent => LineSpacingType::Percent,
            RLst::Fixed => LineSpacingType::Fixed,
            RLst::SpaceOnly => LineSpacingType::BetweenLines,
            RLst::Minimum => LineSpacingType::AtLeast,
        },
        line_spacing_value: p.line_spacing,
        left_margin: p.margin_left,
        right_margin: p.margin_right,
        indent: p.indent,
        space_before: p.spacing_before,
        space_after: p.spacing_after,
        // attr1 bit 19 = "쪽 나누기 앞에서" (page-break-before) — needed for faithful pagination.
        page_break_before: (p.attr1 >> 19) & 1 == 1,
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagonal_kind_gates_on_direction_bits_and_line_type() {
        // 방향 비트 없음 → None (선 타입과 무관).
        assert_eq!(diagonal_kind(0, 1), None, "no direction bits → no diagonal");
        // 방향(slash) 비트는 있으나 선 타입 0(선없음) → None. 이게 #1038 회귀(폭 기준 판단 시 모든 셀에
        // 슬래시가 그려지던 버그)를 막는 핵심 가드. slash 방향 = (attr>>2)&7, CENTER=0b010 → attr=0b010<<2.
        let slash_attr = 0b010u16 << 2;
        assert_eq!(diagonal_kind(slash_attr, 0), None, "direction bit set but line type none → no diagonal (#1038)");
        // 방향 비트 + 실제 선 타입(1=solid) → 그 방향으로 그림.
        assert_eq!(diagonal_kind(slash_attr, 1), Some(DiagonalKind::Slash), "slash direction + solid line → Slash");
        let backslash_attr = 0b010u16 << 5;
        assert_eq!(diagonal_kind(backslash_attr, 1), Some(DiagonalKind::BackSlash), "backslash direction + solid line → BackSlash");
        // 둘 다 설정(X) → 단일 backslash 로 축약(렌더러가 단선만 그림).
        assert_eq!(diagonal_kind(slash_attr | backslash_attr, 1), Some(DiagonalKind::BackSlash), "both set → single BackSlash");
    }

    #[test]
    fn text_color_unpacks_bgr_not_rgb() {
        // rhwp ColorRef is 0x00BBGGRR (NOT RGB): red=0x000000FF, blue=0x00FF0000, green=0x0000FF00.
        assert_eq!(lift_text_color(0x0000_00FF), Color { r: 0xFF, g: 0, b: 0, a: 255 }, "red");
        assert_eq!(
            lift_text_color(0x00FF_0000),
            Color { r: 0, g: 0, b: 0xFF, a: 255 },
            "blue must NOT byte-swap into red"
        );
        assert_eq!(lift_text_color(0x0000_FF00), Color { r: 0, g: 0xFF, b: 0, a: 255 }, "green");
        // Black is the default text color → Color::default(), so a plain run reuses the default charPr
        // (synthesize_char_pr only patches textColor when it differs from default).
        assert_eq!(lift_text_color(0), Color::default(), "black → default");
    }

    #[test]
    fn border_width_index_keeps_distinct_hairlines_and_clamps_floor() {
        // The two thinnest gov-doc indices stay DISTINCT sub-px hairlines (not both rounded up to 1px,
        // which read heavier than the original). Index 0 (0.4px) is lifted to the 0.5px hairline floor;
        // index 1 (0.5px) is already at the floor.
        assert_eq!(border_width_to_px(0), 0.5, "0.4px → clamped up to the 0.5px hairline floor");
        assert_eq!(border_width_to_px(1), 0.5, "0.5px hairline preserved (at floor)");
        // Thicker indices preserve their spec px exactly (no rounding to whole px).
        assert_eq!(border_width_to_px(2), 0.6, "0.6px preserved, not rounded to 1");
        assert_eq!(border_width_to_px(4), 1.0);
        assert_eq!(border_width_to_px(6), 1.5);
        // Out-of-table index falls back to the scaled formula, never below the floor.
        assert!(border_width_to_px(20) >= 0.5);
        assert!(border_width_to_px(255) <= 20.0);
    }

    #[test]
    fn utf16_offsets_map_to_char_indices_across_non_bmp() {
        // "a😀b": 'a'=1 u16, '😀'=2 u16 (surrogate pair), 'b'=1 u16 → char idxs 0,1,2.
        let t = "a😀b";
        assert_eq!(utf16_to_char_idx(t, 0), 0, "before 'a'");
        assert_eq!(utf16_to_char_idx(t, 1), 1, "before '😀' (after 'a')");
        assert_eq!(utf16_to_char_idx(t, 3), 2, "before 'b' (😀 spans u16 1..3)");
        assert_eq!(utf16_to_char_idx(t, 4), 3, "end");
        // All-BMP Hangul: a UTF-16 offset equals the char index.
        assert_eq!(utf16_to_char_idx("가나다", 2), 2);
    }
}
