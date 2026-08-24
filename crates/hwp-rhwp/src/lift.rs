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
use rhwp::model::shape::CaptionDirection as RCaptionDirection;
use rhwp::model::style::{
    Alignment, CharShape as RCharShape, ParaShape as RParaShape, UnderlineType,
};
use rhwp::model::table::Table as RTable;

/// Parse HWP/HWPX bytes via rhwp and lift into our format-neutral `SemanticDoc`.
pub fn parse_to_semantic(bytes: &[u8]) -> Result<SemanticDoc> {
    let doc = rhwp::parse_document(bytes).map_err(|e| Error::Parse(e.to_string()))?;
    Ok(Lifter::new(&doc).with_hwpx_source(is_hwpx(bytes)).run())
}

/// HWPX(=ZIP) 입력인가 — 앞 4바이트가 ZIP 로컬 헤더면 HWPX 로 본다(`.hwp` 는 CFB `D0CF11E0`).
fn is_hwpx(bytes: &[u8]) -> bool {
    bytes.starts_with(b"PK\x03\x04")
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
    /// 입력이 HWPX 였는가 — 문단 여백 보정에 쓴다([`lift_para_shape`] 참조).
    from_hwpx: bool,
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
            from_hwpx: false,
        }
    }

    /// HWPX 입력 표시 — `lift_para_shape` 의 문단 여백 보정을 켠다.
    fn with_hwpx_source(mut self, yes: bool) -> Self {
        self.from_hwpx = yes;
        self
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
            let ps = lift_para_shape(rps, self.from_hwpx);
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
                provenance: Provenance {
                    source: Some(SourceFormat::Hwp5),
                    raw: None,
                },
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
                            // .hwp 원본에는 대응하는 HWPX XML 이 없다 — 변환기가 반드시 새로 emit 한다.
                            from_source: false,
                        }),
                        Control::Footer(f) => section.decorations.push(PageDecoration {
                            kind: DecoKind::Footer,
                            apply: lift_apply(f.apply_to),
                            blocks: self.lift_body(&f.paragraphs),
                            from_source: false,
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
        let text_empty = !runs.iter().any(|r| {
            r.content
                .iter()
                .any(|i| matches!(i, Inline::Text(s) if !s.trim().is_empty()))
        });
        let is_table_anchor = hosts_table && text_empty;
        // Stored line boxes are needed only for true blank spacers in decorative forms: their authored
        // height has no glyph evidence, and dropping it pulls an image-filled title table upward. Do not
        // carry the cache for ordinary documents or control-host paragraphs; that would make persisted
        // layout a second typesetter and break HWP→HWPX page-count parity.
        let preserve_blank_metrics = text_empty
            && p.controls.is_empty()
            && self
                .doc
                .doc_info
                .border_fills
                .iter()
                .any(|fill| fill.fill.image.is_some());
        blocks.push(Block::Paragraph(Paragraph {
            para_shape: self
                .para_id_to_idx
                .get(&p.para_shape_id)
                .copied()
                .unwrap_or(0),
            runs,
            // A hard 쪽/구역 나누기 carried on the PARAGRAPH (not the shared para_shape). Hancom paginates
            // these gov templates by forced page breaks on chapter headings — without honoring them our
            // page count only matched by coincidence (inflated heights). Page and Section both start a
            // fresh page for our purposes.
            page_break_before: matches!(
                p.column_type,
                rhwp::model::paragraph::ColumnBreakType::Page
                    | rhwp::model::paragraph::ColumnBreakType::Section
            ),
            is_table_anchor,
            source_line_metrics: if preserve_blank_metrics {
                p.line_segs
                    .iter()
                    .filter(|line| line.line_height > 0)
                    .map(|line| SourceLineMetric {
                        height: line.line_height,
                        text_height: line.text_height.max(0),
                        baseline: line.baseline_distance.max(0),
                    })
                    .collect()
            } else {
                Vec::new()
            },
            provenance: Provenance {
                source: Some(SourceFormat::Hwp5),
                raw: None,
            },
            ..Default::default()
        }));

        // The host we just pushed — pictures ride here (issue 82). Tables still follow as
        // `Block::Table` (scoring zips paragraphs only, so a table does not shift the pair).
        let host_idx = blocks.len() - 1;
        for ctrl in &p.controls {
            match ctrl {
                Control::Table(t) => blocks.push(Block::Table(self.lift_table(t))),
                Control::Picture(pic) => {
                    // A Picture is a control ON an existing rhwp paragraph, not a second body
                    // paragraph. Emitting `object_paragraph` made layout-check zip 1:1 slip
                    // (issue_265.hwp: 199 vs 195, +4). Caption/text-box lists stay nested on the
                    // rhwp object and are not flattened — they were not the leak.
                    if let Some(img) = self.lift_picture(pic) {
                        if let Some(Block::Paragraph(host)) = blocks.get_mut(host_idx) {
                            attach_inline_object(host, Inline::Image(img));
                        }
                    }
                }
                Control::Equation(eq) => {
                    blocks.push(object_paragraph(Inline::Equation(lift_equation(eq))));
                }
                // Issue 062-7: an OOXML (DrawingML) chart hosted in a drawing shape. Rendered (or a
                // reserved stub box) only for the OOXML path; native/legacy charts stay dropped.
                Control::Shape(shape) => {
                    if let Some(chart) = self.lift_chart(shape) {
                        blocks.push(object_paragraph(Inline::Chart(chart)));
                    }
                }
                Control::Form(form) => {
                    if let Some(text) = form_visible_text(form) {
                        append_form_text(blocks, text);
                    }
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
        NoteRef {
            kind,
            number,
            prefix_char,
            suffix_char,
            inst_id,
            body: self.lift_body(paras),
        }
    }

    /// Lift an rhwp `Picture` → `ImageRef`, registering its bytes into `bin_data` (deduped by the
    /// rhwp `bin_data_id`). Returns None for an unresolved / external (no embedded bytes) image.
    fn lift_picture(&self, pic: &rhwp::model::image::Picture) -> Option<ImageRef> {
        let bin_id = pic.image_attr.bin_data_id;
        let bin_ref = self.register_bin(bin_id)?;

        Some(ImageRef {
            bin_ref,
            width: pic.common.width as i32,
            height: pic.common.height as i32,
            treat_as_char: pic.common.treat_as_char,
        })
    }

    /// Register one embedded raster by its 1-based HWP bin id and return the stable model reference.
    /// Shared by normal Picture controls and borderFill image brushes so both paths dedupe bytes.
    fn register_bin(&self, bin_id: u16) -> Option<String> {
        if bin_id == 0 {
            return None;
        }
        if let Some(seen) = self.bin_seen.borrow().get(&bin_id).cloned() {
            return Some(seen);
        }
        // rhwp bin ids are normally 1-based; sparse HWPX ids fall back to the explicit `id`.
        let content = self
            .doc
            .bin_data_content
            .get((bin_id - 1) as usize)
            .filter(|c| !c.data.is_empty())
            .or_else(|| {
                self.doc
                    .bin_data_content
                    .iter()
                    .find(|c| c.id == bin_id && !c.data.is_empty())
            })?;
        let kind = content
            .extension
            .trim_start_matches('.')
            .to_ascii_lowercase();
        let kind = if kind.is_empty() {
            "png".to_string()
        } else {
            kind
        };
        let bin_ref = format!("image{bin_id}");
        self.bin_data.borrow_mut().push(BinData {
            bin_ref: bin_ref.clone(),
            // rhwp keeps bin data lazy; our IR owns its bytes, so materialize exactly once here.
            bytes: content.data.load(),
            kind,
        });
        self.bin_seen.borrow_mut().insert(bin_id, bin_ref.clone());
        Some(bin_ref)
    }

    /// Lift an OOXML (DrawingML) chart hosted in a drawing shape → `ChartRef` (issue 062-7). v1 handles
    /// ONLY the OOXML path: an `Ole` shape whose bin data is either a directly-injected `Chart/*.xml`
    /// (HWPX, extension "ooxml_chart") or a CFB OLE container carrying `OOXMLChartContents` (HWP5). The
    /// legacy OLE VtChart (`Contents` stream) and native GSO `Chart` shapes are OUT of scope → `None`
    /// (dropped, byte-identical to the pre-062-7 behavior). Once we've confirmed the shape carries OOXML
    /// chart XML we reserve the box from the STORED object size (like `lift_equation`; typeset input is
    /// unchanged → gate-neutral), rendering the SVG when possible and falling back to `None` (a stub
    /// box) on a parse failure — we never guess a wrong chart.
    fn lift_chart(&self, shape: &rhwp::model::shape::ShapeObject) -> Option<ChartRef> {
        use rhwp::model::shape::ShapeObject;
        let ShapeObject::Ole(ole) = shape else {
            return None; // v1: only OLE-hosted OOXML charts (native GSO Chart / other shapes deferred)
        };
        // Reserve from the stored object size; fall back to the OLE extent when the common size is unset.
        let mut w = ole.common.width as i32;
        let mut h = ole.common.height as i32;
        if w <= 0 {
            w = ole.extent_x;
        }
        if h <= 0 {
            h = ole.extent_y;
        }
        if w <= 0 || h <= 0 {
            return None;
        }
        let content = self.find_bin(ole.bin_data_id)?;
        // Extract the OOXML chart XML: HWPX injects it directly (extension "ooxml_chart"); HWP5 wraps it
        // in the CFB OLE container's `OOXMLChartContents` stream. Anything else (legacy VtChart /
        // non-chart OLE) yields no OOXML bytes → not our chart → drop.
        // rhwp v0.7.18+ BinDataBytes is lazy — load() materializes (and decompresses) the bytes.
        let xml: Vec<u8> = if content.extension == "ooxml_chart" {
            content.data.load()
        } else {
            let data = content.data.load();
            let container = rhwp::parser::ole_container::parse_ole_container(&data)?;
            container.ooxml_chart?
        };
        Some(ChartRef {
            width: w,
            height: h,
            rendered_svg: crate::chart_render::chart_svg(&xml, w, h),
        })
    }

    /// Resolve an OLE/chart `bin_data_id` to its stored bytes — the SAME 1-based-else-sparse-id lookup
    /// as rhwp's `find_bin_data` (HWPX charts use a sparse id like 60000+N that overflows the index).
    /// `None` for id 0 / missing / empty.
    fn find_bin(&self, bin_id: u32) -> Option<&rhwp::model::bin_data::BinDataContent> {
        if bin_id == 0 {
            return None;
        }
        self.doc
            .bin_data_content
            .get((bin_id - 1) as usize)
            .filter(|c| !c.data.is_empty())
            .or_else(|| {
                self.doc
                    .bin_data_content
                    .iter()
                    .find(|c| c.id as u32 == bin_id && !c.data.is_empty())
            })
    }

    /// Split a paragraph's text into runs at its `CharShapeRef` boundaries, each run referencing the
    /// translated char_shape index. Slicing is by CHAR index (converted from rhwp's UTF-16 offsets)
    /// so non-BMP characters (emoji, rare hanja) never corrupt a boundary. Full text coverage is
    /// guaranteed (a leading gap before the first ref becomes a default-shape run) — text is never
    /// dropped.
    fn lift_runs(&self, p: &RParagraph) -> Vec<Run> {
        if p.text.is_empty() {
            // 이슈 074: 빈 문단도 **글자 모양 참조는 살려서** 내보낸다(내용 없는 run 하나).
            // 빈 줄의 높이는 그 문단의 글자 크기 × 줄간격인데(한컴 실측: 5pt 간격 문단 = 652
            // HWPUNIT = 500×130%), 참조를 버리면 조판기가 10pt(1000) 기본값으로 두 배를 잡는다.
            // HWPX 파서는 이미 빈 run 을 그대로 보존하므로 두 파서의 IR 도 이 쪽이 일치한다.
            let idx = p
                .char_shapes
                .first()
                .and_then(|r| self.char_id_to_idx.get(&r.char_shape_id).copied());
            return match idx {
                Some(i) => vec![Run {
                    char_shape: i,
                    content: Vec::new(),
                    ..Default::default()
                }],
                None => Vec::new(),
            };
        }
        let chars: Vec<char> = p.text.chars().collect();
        let total = chars.len();

        // (char_start, our char_shape index), sorted, covering [0, total).
        let mut bounds: Vec<(usize, usize)> = p
            .char_shapes
            .iter()
            .map(|r| {
                let start = utf16_to_char_idx(&p.text, r.start_pos).min(total);
                let idx = self
                    .char_id_to_idx
                    .get(&r.char_shape_id)
                    .copied()
                    .unwrap_or(0);
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
            runs.push((
                Run {
                    char_shape: idx,
                    content: vec![Inline::Text(text)],
                    ..Default::default()
                },
                start,
            ));
        }
        if runs.is_empty() {
            // Defensive: every boundary collapsed → keep the whole text as one default run.
            runs.push((
                Run {
                    char_shape: 0,
                    content: vec![Inline::Text(p.text.clone())],
                    ..Default::default()
                },
                0,
            ));
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
        let idx_at = |pos: usize| {
            runs.iter()
                .position(|(_, s)| *s >= pos)
                .unwrap_or(runs.len())
        };
        // (run_index, ordering, marker run). ord at the same index: field-end(0) < begin(1) < zero-len-end(2).
        let mut inserts: Vec<(usize, u8, Run)> = Vec::new();
        for fr in &p.field_ranges {
            let Some(Control::Field(field)) = p.controls.get(fr.control_idx) else {
                continue;
            };
            let Some((ftype, command)) = field_type_token(field) else {
                continue;
            };
            let id = if field.field_id != 0 {
                field.field_id
            } else {
                let mut s = self.field_seq.borrow_mut();
                *s += 1;
                *s
            };
            let begin = marker_run(Inline::FieldBegin(FieldMarker {
                id,
                field_type: ftype,
                command,
            }));
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
                    fill_image: self.cell_fill_image(c.border_fill_id),
                    has_border: self.cell_has_border(c.border_fill_id),
                    borders: self.cell_borders(c.border_fill_id),
                    diagonal: self.cell_diagonal(c.border_fill_id),
                    // Cell-OWN padding ONLY when declared (list_attr bit 16) — matches rhwp's own
                    // renderer/height_measurer, which use table.padding when the bit is off. (F2)
                    padding: c.apply_inner_margin.then(|| lift_padding(&c.padding)),
                    // 이슈 074: 저장된 셀 실폭 — 한글 표는 행마다 열 경계가 달라(ragged) 열 격자
                    // 근사로는 폭이 최대 2배까지 틀린다. 0 은 "없음"으로 본다.
                    width: i32::try_from(cell_layout_width(c))
                        .ok()
                        .filter(|width| *width > 0),
                    ..Default::default()
                }
            })
            .collect();

        let caption = t.caption.as_ref().map(|caption| {
            let mut blocks = Vec::new();
            for paragraph in &caption.paragraphs {
                self.push_paragraph(paragraph, &mut blocks);
            }
            TableCaption {
                position: lift_caption_position(caption.direction),
                blocks,
                spacing: i32::from(caption.spacing),
                width: i32::try_from(caption.width).unwrap_or(i32::MAX),
                max_width: i32::try_from(caption.max_width).unwrap_or(i32::MAX),
                include_margin: caption.include_margin,
            }
        });

        Table {
            rows: t.row_count as usize,
            cols: t.col_count as usize,
            caption,
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
            col_widths: derive_col_widths(&t.cells, t.col_count as usize, t.common.width),
            // Outer vertical margins (바깥 여백) so consecutive tables keep HWP's real gap on render.
            outer_margin_top: t.outer_margin_top.max(0) as i32,
            outer_margin_bottom: t.outer_margin_bottom.max(0) as i32,
            // F2 (issue 054): the remaining real values for faithful HWPX re-emission — outer L/R
            // margins, the table-default cell padding (<hp:inMargin>), and the table's OWN borderFill
            // edges (표 외곽 테두리; previously dropped — the serializer reused an arbitrary bf).
            outer_margin_left: t.outer_margin_left.max(0) as i32,
            outer_margin_right: t.outer_margin_right.max(0) as i32,
            padding: Some(lift_padding(&t.padding)),
            borders: self.cell_borders(t.border_fill_id),
            cells,
            provenance: Provenance {
                source: Some(SourceFormat::Hwp5),
                raw: None,
            },
            ..Default::default()
        }
    }

    /// Whether a cell's `border_fill_id` defines ANY visible edge (a line_type other than 선없음/None).
    /// Cells whose four edges are all None render with no border box, so the renderer can skip them
    /// instead of drawing a spurious black grid line. Unknown/missing borderFill → keep a border
    /// (conservative: a real table cell without resolvable style still shows its grid).
    fn cell_has_border(&self, border_fill_id: u16) -> bool {
        let Some(idx) = (border_fill_id as usize).checked_sub(1) else {
            return true;
        };
        let Some(bf) = self.doc.doc_info.border_fills.get(idx) else {
            return true;
        };
        use rhwp::model::style::BorderLineType;
        bf.borders
            .iter()
            .any(|b| b.line_type != BorderLineType::None)
    }

    /// Lift a cell's four per-edge borders from its `border_fill_id` so the renderer can draw exactly
    /// the sides the doc specifies (each with its color/style/width), not one uniform box. Ordering is
    /// HWP's `[left, right, top, bottom]`, mirrored into our `Cell::borders`. Every edge is `Some`
    /// (incl. 선없음 → `LineStyle::None`, which the renderer SKIPS) so `Cell::has_edge_borders()` is
    /// true and the legacy uniform box is bypassed. Unknown/missing borderFill → `[None;4]` (the cell
    /// falls back to the legacy `has_border` box — inserted/test cells keep their normal grid).
    fn cell_borders(&self, border_fill_id: u16) -> [Option<CellEdge>; 4] {
        let Some(idx) = (border_fill_id as usize).checked_sub(1) else {
            return [None; 4];
        };
        let Some(bf) = self.doc.doc_info.border_fills.get(idx) else {
            return [None; 4];
        };
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
        Some(CellDiagonal {
            kind,
            color: opaque(lift_text_color(d.color)),
            width_px: border_width_to_px(d.width),
        })
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
            Color {
                r: (r / n) as u8,
                g: (gg / n) as u8,
                b: (b / n) as u8,
                a: 255,
            }
        } else {
            return None;
        };
        // Skip "no shade": white (the default cell background) and pure black (unset) add no signal.
        if color
            == (Color {
                r: 255,
                g: 255,
                b: 255,
                a: 255,
            })
            || color == Color::default()
        {
            return None;
        }
        Some(color)
    }

    /// Resolve an image brush from a cell borderFill. Its stored intrinsic dimensions are irrelevant:
    /// Hancom's `FitToSize` brush is fitted to the final cell box by the placer.
    fn cell_fill_image(&self, border_fill_id: u16) -> Option<ImageRef> {
        let idx = (border_fill_id as usize).checked_sub(1)?;
        let image = self
            .doc
            .doc_info
            .border_fills
            .get(idx)?
            .fill
            .image
            .as_ref()?;
        let bin_ref = self.register_bin(image.bin_data_id)?;
        Some(ImageRef {
            bin_ref,
            width: 0,
            height: 0,
            treat_as_char: true,
        })
    }
}

fn lift_caption_position(direction: RCaptionDirection) -> TableCaptionPosition {
    match direction {
        RCaptionDirection::Left => TableCaptionPosition::Left,
        RCaptionDirection::Right => TableCaptionPosition::Right,
        RCaptionDirection::Top => TableCaptionPosition::Top,
        RCaptionDirection::Bottom => TableCaptionPosition::Bottom,
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
/// Attach an image to the host paragraph it was anchored on. A following `object_paragraph`
/// would be an extra body paragraph rhwp does not have, so layout-check's 1:1 zip shifts
/// (issue 82). Equations/charts still use [`object_paragraph`] — that leak was not identified.
fn attach_inline_object(host: &mut Paragraph, inline: Inline) {
    host.runs.push(Run {
        char_shape: host.runs.last().map(|r| r.char_shape).unwrap_or(0),
        content: vec![inline],
        ..Default::default()
    });
}

/// Wrap a single inline object (equation / chart) in its own paragraph block, emitted in reading
/// order after the text paragraph it was anchored in. Pictures no longer use this (issue 82).
fn object_paragraph(inline: Inline) -> Block {
    Block::Paragraph(Paragraph {
        runs: vec![Run {
            char_shape: 0,
            content: vec![inline],
            ..Default::default()
        }],
        provenance: Provenance {
            source: Some(SourceFormat::Hwp5),
            raw: None,
        },
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
    // ① 한 행짜리 셀이 그 행의 저장 높이를 정한다.
    for c in cells {
        let r = c.row as usize;
        if c.row_span.max(1) == 1 && r < rows && c.height > 0 {
            row_h[r] = row_h[r].max(c.height as i32);
        }
    }
    // ② 세로 병합 셀은 **덮는 행들의 합이 모자랄 때만** 부족분을 마지막 행에 더한다.
    //    균등 분배(height/span 을 각 행에 max)는 짧은 행을 평균치까지 부풀린다 — benchmark.hwp
    //    3쪽 표에서 한컴 실측(rhwp 레이아웃 트리)은 r6=11918 / r7=1845 인데 균등 분배는 둘 다
    //    6884(=13768÷2)로 깔려 5042 HWPUNIT 과다 예약 → 한 행이 페이지를 넘고, 뒤이은 쪽 나누기
    //    때문에 한 쪽이 통째로 낭비됐다(이슈 074).
    let mut spans: Vec<&rhwp::model::table::Cell> = cells
        .iter()
        .filter(|c| c.row_span.max(1) > 1 && (c.row as usize) < rows && c.height > 0)
        .collect();
    spans.sort_by_key(|c| c.row_span);
    for c in spans {
        let start = c.row as usize;
        let end = (start + c.row_span.max(1) as usize).min(rows);
        if end <= start {
            continue;
        }
        let sum: i32 = row_h[start..end].iter().sum();
        let h = c.height as i32;
        if h > sum {
            row_h[end - 1] += h - sum;
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
fn derive_col_widths(
    cells: &[rhwp::model::table::Cell],
    cols: usize,
    total_width: u32,
) -> Vec<i32> {
    if cols == 0 {
        return Vec::new();
    }
    if let Some(exact) = derive_exact_col_widths(cells, cols, total_width) {
        return exact;
    }
    let mut w = vec![0u32; cols];
    let mut known = vec![false; cols];
    // 1) Single-column cells give exact column widths (max across rows).
    for c in cells {
        let col = c.col as usize;
        if c.col_span <= 1 && col < cols {
            w[col] = w[col].max(cell_layout_width(c));
            known[col] = true;
        }
    }
    // 2) Resolve columns that only appear under spans: a span's width minus its known columns,
    //    split evenly among its unknown columns. Iterate to a fixpoint (spans can chain).
    let mut changed = true;
    while changed {
        changed = false;
        for c in cells {
            let cell_width = cell_layout_width(c);
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
            if cell_width <= known_sum {
                continue; // can't split a non-positive remainder sensibly
            }
            let each = (cell_width - known_sum) / unknown.len() as u32;
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

/// Solve the source cell-span equations against the common-object endpoints. The extension-aware
/// width is load-bearing: a newer LIST_HEADER can deliberately supersede one stale core width. Any
/// missing, contradictory, non-positive, or overflowing equation rejects the exact solve as a whole;
/// the caller then uses the historical bounded fallback rather than partially mixing two grids.
fn derive_exact_col_widths(
    cells: &[rhwp::model::table::Cell],
    cols: usize,
    total_width: u32,
) -> Option<Vec<i32>> {
    let total_width = i64::from(total_width);
    if cols == 0 || total_width <= 0 || total_width > i64::from(i32::MAX) {
        return None;
    }
    let mut boundaries = vec![None::<i64>; cols + 1];
    boundaries[0] = Some(0);
    boundaries[cols] = Some(total_width);
    for _ in 0..=cells.len() + cols {
        let mut progressed = false;
        for cell in cells {
            let start = cell.col as usize;
            let span = cell.col_span.max(1) as usize;
            let end = start.checked_add(span)?;
            if start >= cols || end > cols {
                return None;
            }
            let width = i64::from(cell_layout_width(cell));
            if width <= 0 || width > i64::from(i32::MAX) {
                return None;
            }
            match (boundaries[start], boundaries[end]) {
                (Some(left), Some(right)) if right - left != width => return None,
                (Some(left), None) => {
                    boundaries[end] = Some(left.checked_add(width)?);
                    progressed = true;
                }
                (None, Some(right)) => {
                    boundaries[start] = Some(right.checked_sub(width)?);
                    progressed = true;
                }
                _ => {}
            }
        }
        if !progressed {
            break;
        }
    }
    let boundaries = boundaries.into_iter().collect::<Option<Vec<_>>>()?;
    if boundaries.first() != Some(&0)
        || boundaries.last() != Some(&total_width)
        || boundaries.windows(2).any(|pair| pair[0] >= pair[1])
    {
        return None;
    }
    boundaries
        .windows(2)
        .map(|pair| i32::try_from(pair[1] - pair[0]).ok())
        .collect()
}

/// HWP5 cell LIST_HEADERs may carry a 13-byte layout extension whose first `u32` is the live cell
/// width and whose remaining bytes are reserved zeroes. rhwp intentionally preserves that tail but
/// exposes only the older core-width slot. Prefer the exact bounded extension in our lift so a stale
/// core width cannot equal-split a ragged span. Longer/non-zero/zero/overflow tails fail closed to the
/// core field; `external/rhwp` remains untouched.
fn cell_layout_width(cell: &rhwp::model::table::Cell) -> u32 {
    if cell.raw_list_extra.len() == 13 && cell.raw_list_extra[4..].iter().all(|byte| *byte == 0) {
        let width = u32::from_le_bytes(
            cell.raw_list_extra[..4]
                .try_into()
                .expect("exact four-byte prefix"),
        );
        if width > 0 && i32::try_from(width).is_ok() {
            return width;
        }
    }
    cell.width
}

/// rhwp `Padding` (i16 per side) → our `[left, right, top, bottom]` HWPUNIT array, negatives
/// clamped to 0 (a negative stored margin is a corrupt/edge value HWP treats as none).
fn lift_padding(p: &rhwp::model::Padding) -> [i32; 4] {
    [
        p.left.max(0) as i32,
        p.right.max(0) as i32,
        p.top.max(0) as i32,
        p.bottom.max(0) as i32,
    ]
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
    Run {
        char_shape: 0,
        content: vec![inline],
        ..Default::default()
    }
}

fn form_visible_text(f: &rhwp::model::control::FormObject) -> Option<String> {
    use rhwp::model::control::FormType;
    match f.form_type {
        FormType::CheckBox | FormType::RadioButton => {
            let mark = if f.value != 0 { "☑" } else { "☐" };
            let cap = f.caption.trim();
            Some(if cap.is_empty() {
                mark.to_string()
            } else {
                format!("{mark} {cap}")
            })
        }
        FormType::Edit | FormType::ComboBox => {
            let t = f.text.trim();
            let t = if t.is_empty() { f.caption.trim() } else { t };
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        }
        FormType::PushButton => {
            let t = f.caption.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        }
    }
}

fn append_form_text(blocks: &mut Vec<Block>, text: String) {
    let run = Run {
        char_shape: 0,
        char_ref: None,
        content: vec![Inline::Text(text)],
    };
    if let Some(Block::Paragraph(p)) = blocks.last_mut() {
        p.runs.push(run);
    } else {
        blocks.push(Block::Paragraph(Paragraph {
            runs: vec![run],
            ..Default::default()
        }));
    }
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
        // Issue 062-5: precompute the equation SVG via rhwp's own engine (raw `eq.color` is rhwp's
        // ColorRef 0x00BBGGRR — pass it straight to `eq_color_to_svg`). `None` on empty/failed render
        // → the own-render/HTML surfaces keep the stub box, byte-identical to before.
        rendered_svg: crate::eq_render::equation_svg(&eq.script, eq.font_size, eq.color),
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
        font_panose: lift_font_panose(c, doc),
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

/// Per-script PANOSE (`typeInfo`) hints, parallel to [`lift_fonts`] (issue 058 follow-up). rhwp DOES
/// expose the HWP5 FaceName type-info as `Font.type_info: Option<[u8; 10]>` (the 10-byte PANOSE), so we
/// forward it — but ONLY for a face whose PANOSE is DEFINITIVE (serif/sans per
/// [`font_class::classify_panose`]); an indeterminate/absent PANOSE stores `None` so the renderer falls
/// back to the name heuristic. When NO slot has a definitive PANOSE we return an EMPTY Vec, keeping the
/// IR (and its JSX manifest) byte-identical to pre-typeInfo for the common case. DISPLAY only.
fn lift_font_panose(c: &RCharShape, doc: &RDoc) -> Vec<Option<[u8; 10]>> {
    let hints: Vec<Option<[u8; 10]>> = (0..7)
        .map(|i| {
            let fid = c.font_ids[i] as usize;
            doc.doc_info
                .font_faces
                .get(i)
                .and_then(|lang| lang.get(fid))
                .and_then(|f| f.type_info)
                .filter(|ti| hwp_model::font_class::classify_panose(ti).is_some())
        })
        .collect();
    if hints.iter().all(Option::is_none) {
        Vec::new()
    } else {
        hints
    }
}

/// Translate an rhwp `PageDef` (구역 용지 설정) into our `PageSetup`: paper size, the six margins
/// (본문 여백 4종 + 머리말/꼬리말, 그리고 제본 여백), and orientation. (HWPUNIT u32 → i32;
/// multi-column is not emitted by the page patcher yet.)
///
/// 머리말/꼬리말/제본 여백은 이슈 074 에서 추가됐다 — 본문 상자를 실제로 줄이는 값인데
/// 버려지고 있었다(`crate::body_box` 참조). rhwp 자신이 `PageAreas::from_page_def_for_page`
/// 에서 같은 규칙(`content_top = margin_header + margin_top`)을 쓴다.
fn lift_page(pd: &PageDef) -> PageSetup {
    PageSetup {
        width: pd.width as i32,
        height: pd.height as i32,
        margin_left: pd.margin_left as i32,
        margin_right: pd.margin_right as i32,
        margin_top: pd.margin_top as i32,
        margin_bottom: pd.margin_bottom as i32,
        margin_header: pd.margin_header as i32,
        margin_footer: pd.margin_footer as i32,
        margin_gutter: pd.margin_gutter as i32,
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
        Color {
            r: (c & 0xFF) as u8,
            g: ((c >> 8) & 0xFF) as u8,
            b: ((c >> 16) & 0xFF) as u8,
            a: 255,
        }
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
///
/// Both direction bits set → `Cross` (the X — slash + backslash drawn together, 062-4). Only one bit
/// set → that single direction. (Sub-variants of the direction bits — 0b011/0b110/0b111 pointed/multi-
/// line ends — are out of scope; any non-zero slash/backslash maps to the plain single line for now.)
fn diagonal_kind(attr: u16, diagonal_type: u8) -> Option<DiagonalKind> {
    let slash = (attr >> 2) & 0b111;
    let backslash = (attr >> 5) & 0b111;
    if (slash == 0 && backslash == 0) || diagonal_type == 0 {
        return None;
    }
    Some(match (slash != 0, backslash != 0) {
        (true, true) => DiagonalKind::Cross,
        (false, true) => DiagonalKind::BackSlash,
        _ => DiagonalKind::Slash, // (true, false) — (false, false) already returned None above
    })
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
/// rhwp `ParaShape` → ours. `from_hwpx` 면 문단 여백(들여쓰기/좌우/위아래)을 **절반으로 되돌린다**.
///
/// 왜(이슈 074): vendored rhwp 의 HWPX 헤더 파서는 `<hp:case required-namespace=…HwpUnitChar>` 의
/// 여백 값을 읽어 **2배**로 곱한다(`parser/hwpx/header.rs`: "HWP 바이너리와 동일한 2× 스케일로
/// 변환"). 하지만 실측하면 case 값이 이미 이진 `.hwp` 와 같은 값이다 — benchmark1 의 같은 문단
/// 들여쓰기가 이진 −3456 / HWPX case −3456 로 정확히 일치한다. 그래서 rhwp 경로로 HWPX 를 읽으면
/// 문단 위/아래 간격이 400→800 으로 두 배가 되고, **무편집 왕복(.hwp → 우리 HWPX → 재열기)에서
/// 쪽수가 늘어난다**(실측 18p→19p · benchmark2 24p→26p). rhwp 는 수정 금지(vendored)라 lift 에서
/// 되돌린다. `.hwp` 이진 경로는 이 보정을 타지 않으므로 게이트(8==8·18==18)와 무관하다.
fn lift_para_shape(p: &RParaShape, from_hwpx: bool) -> ParaShape {
    let fix = |v: i32| if from_hwpx { v / 2 } else { v };
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
        left_margin: fix(p.margin_left),
        right_margin: fix(p.margin_right),
        indent: fix(p.indent),
        space_before: fix(p.spacing_before),
        space_after: fix(p.spacing_after),
        // attr1 bit 19 = "쪽 나누기 앞에서" (page-break-before) — needed for faithful pagination.
        page_break_before: (p.attr1 >> 19) & 1 == 1,
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cell_layout_width_uses_only_the_exact_bounded_extension() {
        let mut cell = rhwp::model::table::Cell {
            width: 1_000,
            ..Default::default()
        };
        let mut exact = vec![0; 13];
        exact[..4].copy_from_slice(&1_176u32.to_le_bytes());
        cell.raw_list_extra = exact.clone();
        assert_eq!(cell_layout_width(&cell), 1_176);

        let mut nonzero_tail = exact.clone();
        nonzero_tail[12] = 1;
        cell.raw_list_extra = nonzero_tail;
        assert_eq!(cell_layout_width(&cell), 1_000);

        cell.raw_list_extra = exact[..12].to_vec();
        assert_eq!(cell_layout_width(&cell), 1_000);

        let mut zero = vec![0; 13];
        zero[..4].copy_from_slice(&0u32.to_le_bytes());
        cell.raw_list_extra = zero;
        assert_eq!(cell_layout_width(&cell), 1_000);

        let mut overflow = vec![0; 13];
        overflow[..4].copy_from_slice(&u32::MAX.to_le_bytes());
        cell.raw_list_extra = overflow;
        assert_eq!(cell_layout_width(&cell), 1_000);
    }

    #[test]
    fn exact_column_solver_uses_layout_extension_for_span_equations() {
        let single = |col, width| rhwp::model::table::Cell {
            col,
            col_span: 1,
            width,
            ..Default::default()
        };
        let mut spanning = rhwp::model::table::Cell {
            col: 1,
            col_span: 2,
            width: 1_800,
            ..Default::default()
        };
        spanning.raw_list_extra = vec![0; 13];
        spanning.raw_list_extra[..4].copy_from_slice(&2_000u32.to_le_bytes());
        let cells = vec![single(0, 1_000), single(2, 1_000), spanning];
        assert_eq!(derive_col_widths(&cells, 3, 3_000), vec![1_000; 3]);

        let mut contradictory = cells;
        contradictory[2].raw_list_extra[..4].copy_from_slice(&1_900u32.to_le_bytes());
        assert!(derive_exact_col_widths(&contradictory, 3, 3_000).is_none());
    }

    #[test]
    fn caption_directions_map_without_loss() {
        assert_eq!(
            lift_caption_position(RCaptionDirection::Left),
            TableCaptionPosition::Left
        );
        assert_eq!(
            lift_caption_position(RCaptionDirection::Right),
            TableCaptionPosition::Right
        );
        assert_eq!(
            lift_caption_position(RCaptionDirection::Top),
            TableCaptionPosition::Top
        );
        assert_eq!(
            lift_caption_position(RCaptionDirection::Bottom),
            TableCaptionPosition::Bottom
        );
    }

    #[test]
    fn table_caption_content_and_geometry_lift_into_shared_ir() {
        use rhwp::model::shape::Caption as RCaption;

        let source = RDoc::default();
        let lifter = Lifter::new(&source);
        let table = RTable {
            row_count: 1,
            col_count: 1,
            caption: Some(RCaption {
                direction: RCaptionDirection::Top,
                width: 8_504,
                spacing: 850,
                max_width: 48_047,
                include_margin: true,
                paragraphs: vec![RParagraph {
                    text: "합성 캡션".into(),
                    ..Default::default()
                }],
                ..Default::default()
            }),
            ..Default::default()
        };

        let lifted = lifter.lift_table(&table);
        let caption = lifted.caption.expect("caption must not be dropped");
        assert_eq!(caption.position, TableCaptionPosition::Top);
        assert_eq!(caption.width, 8_504);
        assert_eq!(caption.spacing, 850);
        assert_eq!(caption.max_width, 48_047);
        assert!(caption.include_margin);
        assert_eq!(caption.blocks.len(), 1);
        assert!(matches!(caption.blocks[0], Block::Paragraph(_)));
    }

    #[test]
    fn form_checkbox_and_edit_become_visible_text() {
        use rhwp::model::control::{FormObject, FormType};
        let mut box_off = FormObject {
            form_type: FormType::CheckBox,
            caption: "공연제작".into(),
            value: 0,
            ..Default::default()
        };
        assert_eq!(form_visible_text(&box_off).unwrap(), "☐ 공연제작");
        box_off.value = 1;
        assert_eq!(form_visible_text(&box_off).unwrap(), "☑ 공연제작");
        let edit = FormObject {
            form_type: FormType::Edit,
            text: "단체명을 기재해 주세요.".into(),
            ..Default::default()
        };
        assert_eq!(form_visible_text(&edit).unwrap(), "단체명을 기재해 주세요.");

        // 구조 스냅샷: 표식은 직전 문단에 붙고, 문단이 없으면 새 문단을 만든다.
        let mut blocks = vec![Block::Paragraph(Paragraph::default())];
        append_form_text(&mut blocks, "☐ 공연제작".into());
        match &blocks[..] {
            [Block::Paragraph(p)] => {
                assert_eq!(p.runs.len(), 1);
                match &p.runs[0].content[..] {
                    [Inline::Text(t)] => assert_eq!(t, "☐ 공연제작"),
                    other => panic!("expected one text run, got {other:?}"),
                }
            }
            other => panic!("expected one paragraph, got {other:?}"),
        }
        let mut empty = Vec::new();
        append_form_text(&mut empty, "☑".into());
        assert_eq!(empty.len(), 1);
        assert!(matches!(&empty[0], Block::Paragraph(p) if p.runs.len() == 1));
    }

    #[test]
    fn diagonal_kind_gates_on_direction_bits_and_line_type() {
        // 방향 비트 없음 → None (선 타입과 무관).
        assert_eq!(diagonal_kind(0, 1), None, "no direction bits → no diagonal");
        // 방향(slash) 비트는 있으나 선 타입 0(선없음) → None. 이게 #1038 회귀(폭 기준 판단 시 모든 셀에
        // 슬래시가 그려지던 버그)를 막는 핵심 가드. slash 방향 = (attr>>2)&7, CENTER=0b010 → attr=0b010<<2.
        let slash_attr = 0b010u16 << 2;
        assert_eq!(
            diagonal_kind(slash_attr, 0),
            None,
            "direction bit set but line type none → no diagonal (#1038)"
        );
        // 방향 비트 + 실제 선 타입(1=solid) → 그 방향으로 그림.
        assert_eq!(
            diagonal_kind(slash_attr, 1),
            Some(DiagonalKind::Slash),
            "slash direction + solid line → Slash"
        );
        let backslash_attr = 0b010u16 << 5;
        assert_eq!(
            diagonal_kind(backslash_attr, 1),
            Some(DiagonalKind::BackSlash),
            "backslash direction + solid line → BackSlash"
        );
        // 둘 다 설정(X) → Cross (슬래시+백슬래시 2선을 겹쳐 X자로; 062-4, 붕괴 중단).
        assert_eq!(
            diagonal_kind(slash_attr | backslash_attr, 1),
            Some(DiagonalKind::Cross),
            "both set → Cross (X)"
        );
    }

    #[test]
    fn text_color_unpacks_bgr_not_rgb() {
        // rhwp ColorRef is 0x00BBGGRR (NOT RGB): red=0x000000FF, blue=0x00FF0000, green=0x0000FF00.
        assert_eq!(
            lift_text_color(0x0000_00FF),
            Color {
                r: 0xFF,
                g: 0,
                b: 0,
                a: 255
            },
            "red"
        );
        assert_eq!(
            lift_text_color(0x00FF_0000),
            Color {
                r: 0,
                g: 0,
                b: 0xFF,
                a: 255
            },
            "blue must NOT byte-swap into red"
        );
        assert_eq!(
            lift_text_color(0x0000_FF00),
            Color {
                r: 0,
                g: 0xFF,
                b: 0,
                a: 255
            },
            "green"
        );
        // Black is the default text color → Color::default(), so a plain run reuses the default charPr
        // (synthesize_char_pr only patches textColor when it differs from default).
        assert_eq!(lift_text_color(0), Color::default(), "black → default");
    }

    #[test]
    fn border_width_index_keeps_distinct_hairlines_and_clamps_floor() {
        // The two thinnest gov-doc indices stay DISTINCT sub-px hairlines (not both rounded up to 1px,
        // which read heavier than the original). Index 0 (0.4px) is lifted to the 0.5px hairline floor;
        // index 1 (0.5px) is already at the floor.
        assert_eq!(
            border_width_to_px(0),
            0.5,
            "0.4px → clamped up to the 0.5px hairline floor"
        );
        assert_eq!(
            border_width_to_px(1),
            0.5,
            "0.5px hairline preserved (at floor)"
        );
        // Thicker indices preserve their spec px exactly (no rounding to whole px).
        assert_eq!(
            border_width_to_px(2),
            0.6,
            "0.6px preserved, not rounded to 1"
        );
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

    /// Issue 062-7: an OLE shape carrying directly-injected OOXML chart XML (the HWPX path) lifts to a
    /// rendered `Inline::Chart`, with the box reserved from the stored object size.
    #[test]
    fn lifts_an_ooxml_chart_ole_to_a_rendered_chart_inline() {
        use rhwp::model::bin_data::BinDataContent;
        use rhwp::model::document::{Document, Section};
        use rhwp::model::paragraph::Paragraph as RPara;
        use rhwp::model::shape::{OleShape, ShapeObject};

        const BAR_XML: &[u8] = br#"<?xml version="1.0"?>
<c:chartSpace xmlns:c="x" xmlns:a="y"><c:chart><c:plotArea>
<c:barChart><c:barDir val="col"/><c:ser>
<c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>20</c:v></c:pt></c:numCache></c:numRef></c:val>
</c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>"#;

        let mut doc = Document::default();
        // HWPX-style directly-injected chart XML at bin id 1 (extension "ooxml_chart").
        doc.bin_data_content.push(BinDataContent {
            id: 1,
            data: rhwp::model::bin_data::BinDataBytes::Loaded(BAR_XML.to_vec()),
            extension: "ooxml_chart".to_string(),
        });
        let ole = OleShape {
            bin_data_id: 1,
            common: rhwp::model::shape::CommonObjAttr {
                width: 30000,
                height: 20000,
                ..Default::default()
            },
            ..Default::default()
        };
        let para = RPara {
            controls: vec![Control::Shape(Box::new(ShapeObject::Ole(Box::new(ole))))],
            ..Default::default()
        };
        doc.sections.push(Section {
            paragraphs: vec![para],
            ..Default::default()
        });

        let semantic = Lifter::new(&doc).run();
        let chart = semantic
            .sections
            .iter()
            .flat_map(|s| &s.blocks)
            .filter_map(|b| match b {
                Block::Paragraph(p) => Some(p),
                _ => None,
            })
            .flat_map(|p| &p.runs)
            .flat_map(|r| &r.content)
            .find_map(|i| match i {
                Inline::Chart(c) => Some(c),
                _ => None,
            })
            .expect("an OOXML chart OLE lifts to Inline::Chart");
        assert_eq!(
            chart.width, 30000,
            "box reserved from the stored object width"
        );
        assert_eq!(
            chart.height, 20000,
            "box reserved from the stored object height"
        );
        let svg = chart
            .rendered_svg
            .as_ref()
            .expect("the OOXML chart rendered to an SVG fragment");
        assert!(
            svg.contains("hwp-ooxml-chart"),
            "rhwp's native chart fragment: {svg}"
        );
    }

    /// A non-OOXML OLE (no injected chart XML, not a CFB OOXML container) is NOT our chart → dropped,
    /// so pagination/flow stays exactly as before (legacy VtChart / spreadsheets are out of v1 scope).
    #[test]
    fn non_ooxml_ole_lifts_to_no_chart() {
        use rhwp::model::bin_data::BinDataContent;
        use rhwp::model::document::{Document, Section};
        use rhwp::model::paragraph::Paragraph as RPara;
        use rhwp::model::shape::{OleShape, ShapeObject};

        let mut doc = Document::default();
        doc.bin_data_content.push(BinDataContent {
            id: 1,
            data: rhwp::model::bin_data::BinDataBytes::Loaded(b"not a cfb ole container".to_vec()),
            extension: "ole".to_string(),
        });
        let ole = OleShape {
            bin_data_id: 1,
            common: rhwp::model::shape::CommonObjAttr {
                width: 30000,
                height: 20000,
                ..Default::default()
            },
            ..Default::default()
        };
        let para = RPara {
            controls: vec![Control::Shape(Box::new(ShapeObject::Ole(Box::new(ole))))],
            ..Default::default()
        };
        doc.sections.push(Section {
            paragraphs: vec![para],
            ..Default::default()
        });

        let semantic = Lifter::new(&doc).run();
        let has_chart = semantic
            .sections
            .iter()
            .flat_map(|s| &s.blocks)
            .filter_map(|b| match b {
                Block::Paragraph(p) => Some(p),
                _ => None,
            })
            .flat_map(|p| &p.runs)
            .flat_map(|r| &r.content)
            .any(|i| matches!(i, Inline::Chart(_)));
        assert!(!has_chart, "a non-OOXML OLE must not produce a chart node");
    }

    /// Issue 82: a Picture control is an extra *inline* on the host paragraph, not a second
    /// body paragraph. layout-check zips `Block::Paragraph` 1:1 with rhwp paragraphs.
    #[test]
    fn picture_control_rides_on_the_host_paragraph() {
        use rhwp::model::bin_data::BinDataContent;
        use rhwp::model::document::{Document, Section};
        use rhwp::model::image::Picture;
        use rhwp::model::paragraph::Paragraph as RPara;

        let mut doc = Document::default();
        doc.bin_data_content.push(BinDataContent {
            id: 1,
            data: rhwp::model::bin_data::BinDataBytes::Loaded(b"fake-png".to_vec()),
            extension: "png".to_string(),
        });
        let mut pic = Picture::default();
        pic.image_attr.bin_data_id = 1;
        pic.common.width = 4000;
        pic.common.height = 3000;
        let para = RPara {
            text: "\u{FFFC}".into(),
            controls: vec![Control::Picture(Box::new(pic))],
            ..Default::default()
        };
        doc.sections.push(Section {
            paragraphs: vec![para],
            ..Default::default()
        });

        let semantic = Lifter::new(&doc).run();
        let blocks = &semantic.sections[0].blocks;
        assert_eq!(
            blocks.len(),
            1,
            "picture must not add a following object paragraph, got {blocks:?}"
        );
        let Block::Paragraph(p) = &blocks[0] else {
            panic!("host must stay a paragraph");
        };
        let images = p
            .runs
            .iter()
            .flat_map(|r| &r.content)
            .filter(|i| matches!(i, Inline::Image(_)))
            .count();
        assert_eq!(images, 1, "the picture rides on the host paragraph");
    }

    /// A picture control on a text paragraph must keep the text *and* the image on that one
    /// block — splitting it would shift every later paragraph pair (issue_265.hwp p76).
    #[test]
    fn picture_on_a_text_host_does_not_split_the_paragraph() {
        use rhwp::model::bin_data::BinDataContent;
        use rhwp::model::document::{Document, Section};
        use rhwp::model::image::Picture;
        use rhwp::model::paragraph::Paragraph as RPara;

        let mut doc = Document::default();
        doc.bin_data_content.push(BinDataContent {
            id: 1,
            data: rhwp::model::bin_data::BinDataBytes::Loaded(b"fake-png".to_vec()),
            extension: "png".to_string(),
        });
        let mut pic = Picture::default();
        pic.image_attr.bin_data_id = 1;
        pic.common.width = 4000;
        pic.common.height = 3000;
        let para = RPara {
            text: "본문 텍스트\u{FFFC}계속".into(),
            controls: vec![Control::Picture(Box::new(pic))],
            ..Default::default()
        };
        doc.sections.push(Section {
            paragraphs: vec![para],
            ..Default::default()
        });

        let semantic = Lifter::new(&doc).run();
        let blocks = &semantic.sections[0].blocks;
        assert_eq!(blocks.len(), 1, "one rhwp paragraph → one block");
        let Block::Paragraph(p) = &blocks[0] else {
            panic!("host must stay a paragraph");
        };
        let text: String = p
            .runs
            .iter()
            .flat_map(|r| &r.content)
            .filter_map(|i| match i {
                Inline::Text(s) => Some(s.as_str()),
                _ => None,
            })
            .collect();
        assert!(
            text.contains("본문 텍스트"),
            "host text must survive: {text:?}"
        );
        assert!(
            p.runs
                .iter()
                .flat_map(|r| &r.content)
                .any(|i| matches!(i, Inline::Image(_))),
            "image must ride on the same paragraph"
        );
    }
}
