//! The capability registry / façade. Picks the best-available implementation per
//! capability and routes `open()` by detected format. This is the mechanism that lets
//! us swap rhwp out per capability (docs/DEPENDENCY-STRATEGY.md §2): our own crates are
//! preferred; the rhwp bootstrap fills gaps (HWP5 parse, layout, render) when wired.

use hwp_hwpx::{HwpxParser, HwpxWriter};
use hwp_model::prelude::*;
use hwp_rhwp::RhwpEngine;
use hwp_typeset::{NaiveLayout, NullFontMetrics};

/// Assembled engine: one chosen implementation behind each capability trait.
pub struct Engine {
    pub layout: Box<dyn LayoutEngine>,
    pub renderer: Box<dyn Renderer>,
    pub serializer: Box<dyn HwpxSerializer>,
    pub fonts: Box<dyn FontMetricsProvider>,
}

impl Default for Engine {
    fn default() -> Self {
        Self::assemble()
    }
}

impl Engine {
    /// Assemble the engine from the best-available implementations.
    pub fn assemble() -> Self {
        Engine {
            // Layout/render: rhwp bootstrap when wired, else our (stub) own engine.
            layout: if RhwpEngine::is_available() {
                Box::new(RhwpEngine::new())
            } else {
                Box::new(NaiveLayout)
            },
            renderer: if RhwpEngine::is_available() {
                Box::new(RhwpEngine::new())
            } else {
                Box::new(hwp_render::NullRenderer)
            },
            // Serializer is ALWAYS ours (rhwp's is Hancom-incompatible).
            serializer: Box::new(HwpxWriter),
            fonts: Box::new(NullFontMetrics),
        }
    }

    /// Open a document: detect format, route to the matching parser.
    pub fn open(bytes: &[u8]) -> Result<SemanticDoc> {
        let fmt = hwp_ingest::detect(bytes);
        match fmt {
            SourceFormat::Hwpx => HwpxParser::new().parse(bytes, fmt),
            SourceFormat::Hwp5 | SourceFormat::Hwp3 => {
                // Bootstrap path: rhwp parses binary HWP (when wired).
                RhwpEngine::new().parse(bytes, fmt)
            }
            SourceFormat::Unknown => Err(Error::UnknownFormat),
        }
    }

    /// Detected source format for the given bytes.
    pub fn detect(bytes: &[u8]) -> SourceFormat {
        hwp_ingest::detect(bytes)
    }
}

// ---- HWPX edit/export (rhwp-free; the round-trip moat) ----

/// The honest fidelity notice for an HWP5→HWPX conversion — what is preserved vs still pending.
/// Surface this whenever a binary `.hwp` was converted so users aren't surprised by the gaps.
pub const HWP5_CONVERSION_NOTICE: &str = "HWP5(.hwp) → HWPX 변환: 본문 텍스트, 글자 서식\
    (굵게/기울임/크기/색/밑줄/취소선), 표(중첩·병합 셀 포함), 페이지 크기·여백·방향이 보존됩니다. \
    아직 지원 안 됨: 글꼴(스크립트별), 위·아래첨자, 문단 번호/글머리표, 이미지, 수식/도형, \
    머리말/꼬리말, 다중 구역(현재 단일 구역만).";

/// Open ANY supported document as an editable, HWPX-serializable `SemanticDoc`, reporting whether a
/// binary→HWPX conversion happened. A binary HW5 (`.hwp`) is lifted via rhwp (needs `--features
/// rhwp`) and serializes through the from-scratch synthesis path; an HWPX parses normally.
/// `was_converted` is true for `.hwp`/`.hwp3` so callers can surface [`HWP5_CONVERSION_NOTICE`].
pub fn open_as_hwpx(bytes: &[u8]) -> Result<(SemanticDoc, bool)> {
    let was_converted = matches!(Engine::detect(bytes), SourceFormat::Hwp5 | SourceFormat::Hwp3);
    Ok((Engine::open(bytes)?, was_converted))
}

/// Serialize a SemanticDoc back to HWPX (verbatim passthrough + dirty-only re-emit).
pub fn serialize_hwpx(doc: &SemanticDoc) -> Result<Vec<u8>> {
    hwp_hwpx::HwpxWriter.serialize(doc)
}

/// Editor-open-safety gate on HWPX bytes.
pub fn validate_hwpx(bytes: &[u8]) -> SafetyReport {
    hwp_hwpx::HwpxWriter.validate_open_safety(bytes)
}

// ---- rhwp bootstrap render path (feature `rhwp`) ----
// Faithful "원본 그대로" view via the vendored rhwp, in-process. The trait-based
// parse→typeset→render pipeline supersedes this as our own engine matures.

/// Page count via the rhwp bootstrap.
#[cfg(feature = "rhwp")]
pub fn page_count(bytes: &[u8]) -> Result<u32> {
    hwp_rhwp::page_count(bytes)
}

/// Render one page to faithful SVG via the rhwp bootstrap.
#[cfg(feature = "rhwp")]
pub fn render_page_svg(bytes: &[u8], page: u32) -> Result<String> {
    hwp_rhwp::render_page_svg(bytes, page)
}

/// Persistent layout/render cache (engine seam 1): reuse ONE parsed document across page renders
/// so scrolling does not re-parse per page. Hold one per open document; it self-invalidates when
/// the input bytes change.
#[cfg(feature = "rhwp")]
pub use hwp_rhwp::RenderCache;

#[cfg(test)]
mod inplace_tests {
    use super::*;
    use hwp_ops::{apply, EditSession, Op, Range};

    fn showcase() -> Vec<u8> {
        let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../../corpus/hwpx/FormattingShowcase.hwpx");
        std::fs::read(p).unwrap()
    }

    /// Find a simple, single-run editable paragraph's NodeId (a bullet).
    fn first_simple_node(doc: &SemanticDoc) -> NodeId {
        doc.sections[0]
            .blocks
            .iter()
            .find_map(|b| match b {
                Block::Paragraph(p) => {
                    let id = p.id?;
                    let src = p.source.as_ref()?;
                    (src.simple && p.runs.len() == 1 && !p.runs[0].content.is_empty()).then_some(id)
                }
                _ => None,
            })
            .expect("an editable single-run paragraph")
    }

    /// P2: an in-place SetCharPr op addresses an existing paragraph by NodeId, re-formats it
    /// (bold+red), and re-emits ONLY that paragraph — through the real op-bus + serializer.
    #[test]
    fn setcharpr_op_edits_existing_paragraph_in_place() {
        let mut doc = Engine::open(&showcase()).unwrap();
        // Find a simple, single-run paragraph (a bullet) and grab its NodeId.
        let para_text = |p: &Paragraph| -> String {
            p.runs
                .iter()
                .flat_map(|r| r.content.iter())
                .filter_map(|i| match i {
                    Inline::Text(t) => Some(t.as_str()),
                    _ => None,
                })
                .collect()
        };
        let target = doc.sections[0].blocks.iter().find_map(|b| match b {
            Block::Paragraph(p) => {
                let id = p.id?;
                let src = p.source.as_ref()?;
                (src.simple && p.runs.len() == 1 && para_text(p).contains("표와 셀 병합")).then_some(id)
            }
            _ => None,
        });
        let node = target.expect("found an editable single-run paragraph");

        apply(&mut doc, &Op::SetCharPr {
            range: Range { start: node, end: node },
            shape: CharShape { bold: true, text_color: Color::from_hex("#C00000").unwrap(), ..Default::default() },
        })
        .unwrap();

        let out = serialize_hwpx(&doc).unwrap();
        assert!(validate_hwpx(&out).ok, "editor-open-safety");
        let doc2 = Engine::open(&out).unwrap();
        assert!(doc2.plain_text().contains("표와 셀 병합"), "edited text preserved");
        assert!(doc2.plain_text().contains("형식 테스트 문서"), "other content preserved");
        let _ = std::fs::write(std::env::temp_dir().join("setcharpr-op.hwpx"), &out);
    }

    /// SetCharPr on a structural (non-simple) paragraph must error, never silently drop the edit.
    #[test]
    fn setcharpr_refuses_non_simple_paragraph() {
        let mut doc = Engine::open(&showcase()).unwrap();
        let structural = doc.sections[0].blocks.iter().find_map(|b| match b {
            Block::Paragraph(p) => {
                let id = p.id?;
                (!p.source.as_ref()?.simple).then_some(id)
            }
            _ => None,
        });
        if let Some(node) = structural {
            let r = apply(&mut doc, &Op::SetCharPr {
                range: Range { start: node, end: node },
                shape: CharShape { bold: true, ..Default::default() },
            });
            assert!(r.is_err(), "structural paragraph edit is refused");
        }
    }

    /// Phase 5: InsertText + DeleteRange edit an existing paragraph's text in place (Caret offsets),
    /// surviving round-trip + open-safety; a literal `&`/`<` exercises the xml_escape path.
    #[test]
    fn inserttext_deleterange_ops_edit_text_in_place() {
        use hwp_ops::Caret;
        let mut doc = Engine::open(&showcase()).unwrap();
        let node = first_simple_node(&doc);
        // Insert text (incl. XML-special chars) at the start of the paragraph.
        apply(&mut doc, &Op::InsertText {
            at: Caret { node, offset: 0 },
            text: "A&B<C 삽입 ".into(),
        })
        .unwrap();
        let out = serialize_hwpx(&doc).unwrap();
        assert!(validate_hwpx(&out).ok, "open-safety after insert");
        let doc2 = Engine::open(&out).unwrap();
        assert!(doc2.plain_text().contains("A&B<C 삽입"), "inserted text (with &/< ) round-trips");

        // Now delete the first 3 chars of that same paragraph and re-export.
        let node2 = first_simple_node(&doc2);
        let mut doc2 = doc2;
        apply(&mut doc2, &Op::DeleteRange {
            start: Caret { node: node2, offset: 0 },
            end: Caret { node: node2, offset: 3 },
        })
        .unwrap();
        let out2 = serialize_hwpx(&doc2).unwrap();
        assert!(validate_hwpx(&out2).ok, "open-safety after delete");
        let _ = std::fs::write(std::env::temp_dir().join("inserttext-op.hwpx"), &out);
        let _ = std::fs::write(std::env::temp_dir().join("deleterange-op.hwpx"), &out2);
    }

    /// Phase 4: SetRunCharPr formats a sub-paragraph char range, splitting runs, and re-emits in
    /// place — header gains the charPr, plain text + other paragraphs are preserved, file opens.
    #[test]
    fn setruncharpr_op_formats_sub_paragraph_range() {
        let mut doc = Engine::open(&showcase()).unwrap();
        // A simple paragraph with enough text to carve a sub-range out of.
        let target = doc.sections[0].blocks.iter().find_map(|b| match b {
            Block::Paragraph(p) => {
                let id = p.id?;
                let src = p.source.as_ref()?;
                let chars: usize = p.runs.iter().flat_map(|r| r.content.iter()).map(|i| match i {
                    Inline::Text(t) => t.chars().count(),
                    _ => 0,
                }).sum();
                (src.simple && chars >= 4).then_some((id, chars))
            }
            _ => None,
        });
        let (node, chars) = target.expect("a simple paragraph with >=4 chars");
        let before_text = doc.plain_text();

        apply(&mut doc, &Op::SetRunCharPr {
            para: node,
            start: 1,
            end: (chars - 1).min(3),
            shape: CharShape { bold: true, text_color: Color::from_hex("#1F4E79").unwrap(), ..Default::default() },
        })
        .unwrap();

        let out = serialize_hwpx(&doc).unwrap();
        assert!(validate_hwpx(&out).ok, "editor-open-safety");
        let doc2 = Engine::open(&out).unwrap();
        assert_eq!(doc2.plain_text(), before_text, "sub-range formatting preserves all text");
        let _ = std::fs::write(std::env::temp_dir().join("setruncharpr-op.hwpx"), &out);
    }

    /// Phase 3: SetParaPr through the op-bus re-shapes an existing paragraph (center align) and
    /// re-emits it; ApplyStyle re-points another at a named style. Both survive round-trip + open.
    #[test]
    fn setparapr_and_applystyle_ops_edit_in_place() {
        let mut doc = Engine::open(&showcase()).unwrap();
        let node = first_simple_node(&doc);

        let shape = ParaShape { align: HorizontalAlign::Center, ..Default::default() };
        apply(&mut doc, &Op::SetParaPr { range: Range { start: node, end: node }, shape }).unwrap();

        // A second simple paragraph gets a named style.
        let node2 = doc.sections[0].blocks.iter().find_map(|b| match b {
            Block::Paragraph(p) => {
                let id = p.id?;
                (id != node && p.source.as_ref()?.simple).then_some(id)
            }
            _ => None,
        });
        if let Some(n2) = node2 {
            apply(&mut doc, &Op::ApplyStyle { range: Range { start: n2, end: n2 }, style: "개요 1".into() }).unwrap();
        }

        let out = serialize_hwpx(&doc).unwrap();
        assert!(validate_hwpx(&out).ok, "editor-open-safety");
        let doc2 = Engine::open(&out).unwrap();
        assert!(doc2.plain_text().contains("형식 테스트 문서"), "content preserved");
        let _ = std::fs::write(std::env::temp_dir().join("setparapr-op.hwpx"), &out);
    }

    /// Phase 6: SetParaPr / ApplyStyle are ALLOWED on a structural (non-simple) paragraph (they
    /// only patch the open tag), but body-rebuilding ops (SetCharPr / SetRunCharPr / InsertText /
    /// DeleteRange) are still REFUSED so structural content is never silently dropped.
    #[test]
    fn nonsimple_paragraph_allows_open_tag_edits_refuses_body_edits() {
        use hwp_ops::Caret;
        let mut doc = Engine::open(&showcase()).unwrap();
        let structural = doc.sections[0].blocks.iter().find_map(|b| match b {
            Block::Paragraph(p) => {
                let id = p.id?;
                (!p.source.as_ref()?.simple).then_some(id)
            }
            _ => None,
        });
        let Some(node) = structural else { return };
        let r = Range { start: node, end: node };

        // Open-tag-only edits succeed.
        apply(&mut doc, &Op::SetParaPr { range: r.clone(), shape: ParaShape { align: HorizontalAlign::Center, ..Default::default() } }).unwrap();
        apply(&mut doc, &Op::ApplyStyle { range: r.clone(), style: "개요 1".into() }).unwrap();

        // Body-rebuilding edits are refused.
        assert!(apply(&mut doc, &Op::SetCharPr { range: r.clone(), shape: CharShape { bold: true, ..Default::default() } }).is_err());
        assert!(apply(&mut doc, &Op::SetRunCharPr { para: node, start: 0, end: 1, shape: CharShape { bold: true, ..Default::default() } }).is_err());
        assert!(apply(&mut doc, &Op::InsertText { at: Caret { node, offset: 0 }, text: "X".into() }).is_err());
        assert!(apply(&mut doc, &Op::DeleteRange { start: Caret { node, offset: 0 }, end: Caret { node, offset: 1 } }).is_err());

        // The open-tag edits round-trip + open, with structural content preserved.
        let out = serialize_hwpx(&doc).unwrap();
        assert!(validate_hwpx(&out).ok, "structural-paragraph open-tag edit opens");
        let doc2 = Engine::open(&out).unwrap();
        assert!(doc2.sections[0].blocks.iter().any(|b| matches!(b, Block::Paragraph(p) if p.source.as_ref().is_some_and(|s| !s.simple)) || matches!(b, Block::Table(_))), "structural content survived");
        let _ = std::fs::write(std::env::temp_dir().join("nonsimple-parapr.hwpx"), &out);
    }

    /// DIAGNOSTIC: does a HW5 (.hwp) document round-trip to a valid HWPX today? (Critical: HWP
    /// compatibility.) Reports serialize Ok/Err + open-safety + how much content the lift captured.
    #[cfg(feature = "rhwp")]
    #[test]
    #[ignore = "diagnostic; run with --features rhwp --ignored --nocapture"]
    fn hwp5_to_hwpx_export_behavior() {
        let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../../benchmark.hwp");
        let bytes = std::fs::read(p).unwrap();
        assert_eq!(Engine::detect(&bytes), SourceFormat::Hwp5, "benchmark.hwp is HW5");
        let doc = Engine::open(&bytes).unwrap();
        let blocks: usize = doc.sections.iter().map(|s| s.blocks.len()).sum();
        let text_len = doc.plain_text().len();
        match serialize_hwpx(&doc) {
            Ok(b) => eprintln!(
                "HWP5→HWPX: serialize OK · {} bytes · open_safe={} · sections={} · blocks={} · text={}B",
                b.len(),
                validate_hwpx(&b).ok,
                doc.sections.len(),
                blocks,
                text_len
            ),
            Err(e) => eprintln!("HWP5→HWPX: serialize ERR: {e} · sections={} · blocks={} · text={}B", doc.sections.len(), blocks, text_len),
        }
    }

    /// Track A Phase 1 acceptance: a binary .hwp now CONVERTS to a valid, open-safe HWPX whose text
    /// round-trips. (Before the from-scratch synthesis path, serialize_hwpx errored "no original
    /// HWPX provenance".) Formatting fidelity is Phase 2+; this pins the plumbing: text in → text
    /// out, openable. Writes the artifact to TMPDIR for the LibreOffice+H2Orestart oracle.
    #[cfg(feature = "rhwp")]
    #[test]
    fn hwp5_converts_to_openable_hwpx_with_text_roundtrip() {
        let bytes = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../benchmark.hwp")).unwrap();
        let doc = Engine::open(&bytes).unwrap();
        let original = doc.plain_text();
        assert!(!original.trim().is_empty(), "lift must capture text");

        let out = serialize_hwpx(&doc).expect("HWP5→HWPX must serialize (was erroring)");
        assert!(validate_hwpx(&out).ok, "converted HWPX must be open-safe");

        // Reopen the converted HWPX and confirm every non-whitespace character survives. (The
        // Skeleton's secPr stub contributes one leading empty paragraph; lifted text follows it.)
        // Every non-whitespace character must survive — including multi-paragraph table cells and
        // tables nested inside cells (the benchmark has 10), which the cell emitter handles recursively.
        let reopened = Engine::open(&out).unwrap();
        let norm = |s: &str| s.split_whitespace().collect::<String>();
        assert_eq!(norm(&reopened.plain_text()), norm(&original), "text must round-trip through conversion");

        let _ = std::fs::write(std::env::temp_dir().join("benchmark-converted.hwpx"), &out);
    }

    /// Track A Phase 2: the DEEP lift captures per-run character formatting + paragraph shapes, and
    /// the converter synthesizes them into the HWPX header pools. (Phase 1 was text-only.)
    #[cfg(feature = "rhwp")]
    #[test]
    fn hwp5_lift_captures_formatting_and_synthesizes_charpr() {
        let bytes = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../benchmark.hwp")).unwrap();
        let doc = Engine::open(&bytes).unwrap();

        // Pools translated (index 0 = default, then the document's real shapes).
        assert!(doc.char_shapes.len() > 1, "char_shape pool translated: {}", doc.char_shapes.len());
        assert!(doc.para_shapes.len() > 1, "para_shape pool translated: {}", doc.para_shapes.len());
        assert!(!doc.header_pools.char.is_empty(), "header_pools mirrored for the editor");

        // Run splitting + non-default formatting captured.
        let runs: usize = doc.sections.iter().flat_map(|s| &s.blocks).map(|b| match b {
            Block::Paragraph(p) => p.runs.len(),
            _ => 0,
        }).sum();
        let formatted_shapes = doc.char_shapes.iter().filter(|c| !c.is_default()).count();
        let bold = doc.char_shapes.iter().filter(|c| c.bold).count();
        let colored = doc.char_shapes.iter().filter(|c| c.text_color != crate::Color::default()).count();
        let aligned = doc.para_shapes.iter().filter(|p| p.align != HorizontalAlign::Justify).count();
        eprintln!(
            "Phase2: char_shapes={} para_shapes={} runs={} formatted={} bold={} colored={} non-justify-paras={}",
            doc.char_shapes.len(), doc.para_shapes.len(), runs, formatted_shapes, bold, colored, aligned
        );
        assert!(formatted_shapes > 0, "at least one non-default char_shape (formatting captured)");

        // The synthesized header gains charPr entries beyond the Skeleton's 7 (itemCnt grows), and
        // the open-safety gate still passes.
        let out = serialize_hwpx(&doc).unwrap();
        assert!(validate_hwpx(&out).ok, "converted HWPX stays open-safe with synthesized shapes");
        let pkg = hwp_hwpx::package::Package::open(&out).unwrap();
        let header = String::from_utf8(pkg.read_header().unwrap()).unwrap();
        let char_cnt = hwp_hwpx::synth::max_pool_id(&header, "charProperties");
        eprintln!("Phase2: synthesized charProperties max id = {char_cnt} (Skeleton default max = 6)");
        assert!(char_cnt > 6, "synthesized at least one charPr beyond the Skeleton's pool");
        // The actual formatting reached the header (not just a bigger pool): bold + a real color.
        assert!(header.contains("<hh:bold/>"), "a bold charPr was synthesized into the header");
        let has_color = header
            .match_indices("textColor=\"#")
            .any(|(i, _)| !header[i..].starts_with("textColor=\"#000000"));
        assert!(has_color, "a non-black textColor was synthesized into the header");
    }

    /// Track A Phase 3: the converted HWPX carries the .hwp's OWN page geometry — orientation, size,
    /// margins — instead of inheriting the Skeleton stub's hardcoded landscape A4. benchmark.hwp is
    /// portrait A4, so its secPr must read landscape="NARROWLY" with portrait dimensions.
    #[cfg(feature = "rhwp")]
    #[test]
    fn hwp5_page_geometry_is_lifted_not_skeleton_landscape() {
        let bytes = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../benchmark.hwp")).unwrap();
        let doc = Engine::open(&bytes).unwrap();
        assert!(!doc.sections[0].page.landscape, "benchmark is portrait");
        assert!(doc.sections[0].page_edited, "page marked edited so the secPr is patched");

        let out = serialize_hwpx(&doc).unwrap();
        let pkg = hwp_hwpx::package::Package::open(&out).unwrap();
        let sec0 = String::from_utf8(pkg.read_part("Contents/section0.xml").unwrap()).unwrap();
        let pagepr = &sec0[sec0.find("<hp:pagePr").expect("has pagePr")..][..120];
        assert!(pagepr.contains(r#"landscape="NARROWLY""#), "portrait, not the Skeleton's WIDELY: {pagepr}");
        assert!(pagepr.contains(r#"width="59528""#), "portrait A4 width (210mm), not landscape: {pagepr}");
    }

    /// Track A Phase 5: open_as_hwpx flags a binary .hwp as converted and yields a doc that
    /// serializes to an open-safe HWPX (the engine surface behind the CLI `convert` command).
    #[cfg(feature = "rhwp")]
    #[test]
    fn open_as_hwpx_flags_conversion_and_serializes() {
        let hwp = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../benchmark.hwp")).unwrap();
        let (doc, was_converted) = open_as_hwpx(&hwp).unwrap();
        assert!(was_converted, ".hwp must be flagged as a conversion (for the fidelity notice)");
        assert!(!doc.plain_text().trim().is_empty(), "lifted content present");
        assert!(validate_hwpx(&serialize_hwpx(&doc).unwrap()).ok, "converts to an open-safe HWPX");
        assert!(!HWP5_CONVERSION_NOTICE.is_empty());
    }

    /// Phase 1: undo restores the doc bit-for-bit (the byte-stability moat), redo replays it.
    #[test]
    fn editsession_undo_redo_is_byte_exact() {
        let doc = Engine::open(&showcase()).unwrap();
        let node = first_simple_node(&doc);
        let orig = serialize_hwpx(&doc).unwrap();

        let mut s = EditSession::new(doc);
        s.do_op(&Op::SetCharPr {
            range: Range { start: node, end: node },
            shape: CharShape { bold: true, text_color: Color::from_hex("#C00000").unwrap(), ..Default::default() },
        })
        .unwrap();
        let edited = serialize_hwpx(s.doc()).unwrap();
        assert!(s.doc().any_dirty());
        assert_ne!(edited, orig, "edit changed the bytes");

        assert!(s.undo());
        let after_undo = serialize_hwpx(s.doc()).unwrap();
        assert!(!s.doc().any_dirty(), "undo restores the pristine dirty state");
        assert_eq!(after_undo, orig, "undo is byte-identical to the original parse");

        assert!(s.redo());
        let after_redo = serialize_hwpx(s.doc()).unwrap();
        assert_eq!(after_redo, edited, "redo is byte-identical to the edited output");
    }

    /// Phase 1: a failed op (range spanning a non-simple para) leaves the session pristine —
    /// no partial dirty mutation, serialize stays byte-identical to the original.
    #[test]
    fn editsession_failed_op_is_atomic() {
        let doc = Engine::open(&showcase()).unwrap();
        let orig = serialize_hwpx(&doc).unwrap();
        // A range from the first node id to a large id sweeps across both simple and non-simple paras.
        let max_id = doc.sections[0]
            .blocks
            .iter()
            .filter_map(|b| match b {
                Block::Paragraph(p) => p.id.map(|n| n.0),
                _ => None,
            })
            .max()
            .unwrap();
        let has_structural = doc.sections[0].blocks.iter().any(|b| matches!(b, Block::Paragraph(p) if p.source.as_ref().is_some_and(|s| !s.simple)));

        let mut s = EditSession::new(doc);
        let r = s.do_op(&Op::SetCharPr {
            range: Range { start: NodeId(1), end: NodeId(max_id) },
            shape: CharShape { bold: true, ..Default::default() },
        });
        if has_structural {
            assert!(r.is_err(), "a range covering a non-simple para must error");
            assert!(!s.can_undo(), "failed op pushes no snapshot");
            assert!(!s.doc().any_dirty(), "failed op leaves no dirty node");
            assert_eq!(serialize_hwpx(s.doc()).unwrap(), orig, "failed op is byte-identical to original");
        }
    }
}
