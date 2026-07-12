//! OWPML (HWPX) → `SemanticDoc` parser — our own, rhwp-free (the round-trip moat).
//!
//! Subset (M3/M4 foundation): sections → paragraphs (`hp:p`/`hp:run`/`hp:t` text) and
//! tables (`hp:tbl`/`hp:tr`/`hp:tc` with `cellAddr`/`cellSpan` → cell paragraphs). Nesting
//! (table-in-paragraph, paragraph-in-cell) is handled via an explicit block stack. Deeper
//! fidelity (charPr/paraPr pools, images, equations, full passthrough) grows from here.

use crate::package::Package;
use hwp_ingest::limits::{self, DocLimit, HardenedError};
use hwp_model::prelude::*;
use quick_xml::events::{BytesStart, Event};
use quick_xml::reader::Reader;

fn hwpx_prov() -> Provenance {
    Provenance {
        source: Some(SourceFormat::Hwpx),
        raw: None,
    }
}

/// Tag under which the whole original HWPX file is retained for verbatim round-trip.
pub const SOURCE_PART_TAG: &str = "hwpx:source";

/// Parse an HWPX byte buffer into a `SemanticDoc`.
///
/// Round-trip provenance: the entire original file is retained (`SOURCE_PART_TAG`) and each
/// `Section.provenance.raw` holds its original section XML, so the serializer can re-emit
/// untouched parts byte-verbatim and patch only dirty sections.
pub fn parse_semantic(bytes: &[u8]) -> Result<SemanticDoc> {
    let pkg = Package::open(bytes)?;
    let mut doc = SemanticDoc::default();
    // Reserve index 0 as the DEFAULT shape: parsed runs/paragraphs reference index 0 (→ "use the
    // original charPrIDRef/paraPrIDRef, no synthesis"). Op-bus interning therefore allocates edited
    // shapes at index ≥1, so an in-place edit never collides with the unedited runs' index 0.
    doc.char_shapes.push(CharShape::default());
    doc.para_shapes.push(ParaShape::default());
    // P1 (#003): parse the existing header.xml charPr/paraPr pools into typed values, so the editor
    // can read an existing run/paragraph's formatting (e.g. to toggle bold) and the serializer can
    // dedup against real pool entries.
    if let Some(h) = pkg.read_header() {
        doc.header_pools = crate::synth::parse_header_pools(&String::from_utf8_lossy(&h));
    }
    doc.passthrough.push(SOURCE_PART_TAG, bytes.to_vec());
    for name in pkg.section_part_names() {
        // `raw` MUST be the exact bytes the reader sees, so per-paragraph byte spans (captured in
        // parse_section) index correctly into it for surgical in-place re-emit.
        let text = String::from_utf8_lossy(&pkg.read_part(&name)?).into_owned();
        let mut section = Section {
            provenance: Provenance {
                source: Some(SourceFormat::Hwpx),
                raw: Some(text.clone().into_bytes()),
            },
            ..Default::default()
        };
        // Table-nesting guard (#014): a pathologically nested table is rejected as a fast, explicit
        // error rather than building an unbounded structure. Legacy path folds it into Error::Parse.
        parse_section(&text, &mut section.blocks).map_err(|l| Error::Parse(l.to_string()))?;
        doc.sections.push(section);
    }
    assign_node_ids(&mut doc);
    Ok(doc)
}

/// Hardened variant of [`parse_semantic`] for **untrusted** input (issue #014; the service path,
/// 013 wires it). Mirrors `parse_semantic` byte-for-byte in what it produces, but every boundary
/// fails with the typed [`HardenedError`] (so a service switches on the variant): raw-size /
/// entry-count / cumulative-decompression caps via [`Package::open_guarded`] + `read_part_guarded`,
/// and the table-nesting cap via [`parse_section`]. A parsed doc still owes the caller a
/// post-parse [`limits::check_layout_limits`] pass before layout (that guard is un-wired here per
/// the #010/#013 split — see its docs).
pub fn parse_semantic_guarded(bytes: &[u8]) -> std::result::Result<SemanticDoc, HardenedError> {
    let pkg = Package::open_guarded(bytes)?;
    let mut doc = SemanticDoc::default();
    // Reserve index 0 as the DEFAULT shape (see `parse_semantic`).
    doc.char_shapes.push(CharShape::default());
    doc.para_shapes.push(ParaShape::default());
    if let Some(name) = pkg.header_part_name() {
        if let Ok(h) = pkg.read_part_guarded(&name) {
            doc.header_pools = crate::synth::parse_header_pools(&String::from_utf8_lossy(&h));
        }
    }
    doc.passthrough.push(SOURCE_PART_TAG, bytes.to_vec());
    for name in pkg.section_part_names() {
        let raw = pkg.read_part_guarded(&name)?;
        let text = String::from_utf8_lossy(&raw).into_owned();
        let mut section = Section {
            provenance: Provenance {
                source: Some(SourceFormat::Hwpx),
                raw: Some(text.clone().into_bytes()),
            },
            ..Default::default()
        };
        parse_section(&text, &mut section.blocks).map_err(HardenedError::Limit)?;
        doc.sections.push(section);
    }
    assign_node_ids(&mut doc);
    Ok(doc)
}

/// Assign stable in-memory `NodeId`s to top-level (editable) paragraphs — addressing for in-place
/// edit ops. Derived from document order (not the XML id), so they are stable across a re-parse.
/// Cell paragraphs (source=None) stay unaddressed.
fn assign_node_ids(doc: &mut SemanticDoc) {
    let mut next = 1u64;
    for sec in &mut doc.sections {
        for b in &mut sec.blocks {
            if let Block::Paragraph(p) = b {
                if p.source.is_some() {
                    p.id = Some(NodeId(next));
                    next += 1;
                }
            }
        }
    }
}

struct TblFrame {
    table: Table,
    cell: Option<Cell>,
    /// Byte offset of this table's `<hp:tbl` within the section XML (span start, issue 057).
    start: usize,
    /// Byte offset of the in-progress cell's `<hp:tc` (span start, issue 057).
    cell_start: usize,
}

/// Accumulator for one in-progress `<hp:p>` (runs + its source provenance).
#[derive(Default)]
struct ParaAccum {
    start: usize,                              // byte offset of `<hp:p` in the section XML
    para_pr: Option<String>,                   // paraPrIDRef
    style: Option<String>,                     // styleIDRef
    id: Option<String>,                        // XML id string
    simple: bool,                              // only hp:run/hp:t children seen so far
    runs: Vec<Run>,                            // flushed runs
    cur_run: Option<(Option<String>, String)>, // open run (charPrIDRef, text)
}

/// Parse one section's XML into `out`. Returns `Err(DocLimit::TableNestingTooDeep)` if table-in-
/// table nesting exceeds [`limits::MAX_TABLE_NESTING`] — the concrete "XML depth counter" for the
/// only nesting that grows unbounded structures. All other malformation is tolerated (best-effort
/// parse); the reader stops at the first hard error/EOF as before.
fn parse_section(xml: &str, out: &mut Vec<Block>) -> std::result::Result<(), DocLimit> {
    let mut reader = Reader::from_str(xml);
    // Stack of block containers (section, then nested table-cell sublists).
    let mut blocks: Vec<Vec<Block>> = vec![Vec::new()];
    let mut tbls: Vec<TblFrame> = Vec::new();
    // Stack of in-progress paragraphs (a cell paragraph nests inside a table inside an outer para).
    let mut paras: Vec<ParaAccum> = Vec::new();
    let mut in_t = false;

    loop {
        let pos_before = reader.buffer_position() as usize; // lands on '<' of the upcoming tag (qxml 0.37)
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let ln = e.local_name();
                match ln.as_ref() {
                    b"p" => paras.push(ParaAccum {
                        start: pos_before,
                        para_pr: attr_str(&e, b"paraPrIDRef"),
                        style: attr_str(&e, b"styleIDRef"),
                        id: attr_str(&e, b"id"),
                        simple: true,
                        ..Default::default()
                    }),
                    b"run" => {
                        if let Some(p) = paras.last_mut() {
                            flush_run(p);
                            p.cur_run = Some((attr_str(&e, b"charPrIDRef"), String::new()));
                        }
                    }
                    b"t" => in_t = true,
                    b"tbl" => {
                        // Depth counter (#014): `tbls.len()` IS the current table-nesting depth.
                        // Reject before pushing the level that would exceed the cap.
                        limits::check_table_nesting(tbls.len())?;
                        mark_not_simple(&mut paras);
                        let rows = attr_usize(&e, b"rowCnt").unwrap_or(0);
                        let cols = attr_usize(&e, b"colCnt").unwrap_or(0);
                        tbls.push(TblFrame {
                            table: Table {
                                rows,
                                cols,
                                provenance: hwpx_prov(),
                                ..Default::default()
                            },
                            cell: None,
                            start: pos_before,
                            cell_start: 0,
                        });
                    }
                    b"tc" => {
                        blocks.push(Vec::new());
                        if let Some(f) = tbls.last_mut() {
                            f.cell = Some(Cell::default());
                            f.cell_start = pos_before;
                        }
                    }
                    // Structural children (secPr/ctrl/pic/equation/container/…) make a paragraph
                    // NOT re-emittable from the lossy AST. `linesegarray`/`lineseg` are layout
                    // CACHE — safely dropped + recomputed by Hancom — so they don't break `simple`.
                    other => {
                        if !matches!(other, b"linesegarray" | b"lineseg") {
                            mark_not_simple(&mut paras);
                        }
                    }
                }
            }
            Ok(Event::Empty(e)) => match e.local_name().as_ref() {
                b"t" => {} // empty `<hp:t/>` — keeps an empty run; not a simple-breaker
                b"cellAddr" => {
                    if let Some(c) = tbls.last_mut().and_then(|f| f.cell.as_mut()) {
                        c.col = attr_usize(&e, b"colAddr").unwrap_or(0);
                        c.row = attr_usize(&e, b"rowAddr").unwrap_or(0);
                    }
                }
                b"cellSpan" => {
                    if let Some(c) = tbls.last_mut().and_then(|f| f.cell.as_mut()) {
                        c.col_span = attr_usize(&e, b"colSpan").unwrap_or(1).max(1);
                        c.row_span = attr_usize(&e, b"rowSpan").unwrap_or(1).max(1);
                    }
                }
                // `<hp:lineseg/>` (inside linesegarray) is layout cache; everything else structural.
                other => {
                    if !matches!(other, b"lineseg" | b"linesegarray") {
                        mark_not_simple(&mut paras);
                    }
                }
            },
            Ok(Event::Text(e)) if in_t => {
                if let Some((_, t)) = paras.last_mut().and_then(|p| p.cur_run.as_mut()) {
                    t.push_str(&e.unescape().unwrap_or_default());
                }
            }
            Ok(Event::End(e)) => match e.local_name().as_ref() {
                b"t" => in_t = false,
                b"run" => {
                    if let Some(p) = paras.last_mut() {
                        flush_run(p);
                    }
                }
                b"p" => {
                    if let Some(mut p) = paras.pop() {
                        flush_run(&mut p);
                        let end = reader.buffer_position() as usize; // just past `</hp:p>`
                                                                     // Top-level iff no enclosing paragraph remains.
                        let top_level = paras.is_empty();
                        let source = top_level.then(|| ParaSource {
                            span: (p.start, end),
                            para_pr: p.para_pr.clone(),
                            style: p.style.clone(),
                            id: p.id.clone(),
                            simple: p.simple,
                        });
                        if let Some(target) = blocks.last_mut() {
                            target.push(Block::Paragraph(Paragraph {
                                runs: p.runs,
                                source,
                                provenance: hwpx_prov(),
                                ..Default::default()
                            }));
                        }
                    }
                }
                b"tc" => {
                    let cell_blocks = blocks.pop().unwrap_or_default();
                    if let Some(f) = tbls.last_mut() {
                        if let Some(mut c) = f.cell.take() {
                            c.blocks = cell_blocks;
                            c.active = true;
                            // `[<hp:tc … </hp:tc>)` span for surgical in-place cell re-emit (057).
                            c.src_span = Some((f.cell_start, reader.buffer_position() as usize));
                            f.table.cells.push(c);
                        }
                    }
                }
                b"tbl" => {
                    if let Some(mut f) = tbls.pop() {
                        // Record EVERY table's `[<hp:tbl … </hp:tbl>)` span — TOP-LEVEL and NESTED.
                        // Top-level: re-emit a dirty table at its original anchor instead of the
                        // section end (issue 057). Nested: a 1×1 frame wrapper's INNER table needs
                        // its own span too, because a table edit op marks only the inner table/cell
                        // dirty (never the outer wrapper) — so the serializer splices the inner
                        // table's dirty `<hp:tc>` spans in place and leaves the wrapper verbatim
                        // (issue 060). Nested spans index the SAME section XML buffer as top-level
                        // ones. Export provenance only — render/equality ignore it.
                        f.table.src_span = Some((f.start, reader.buffer_position() as usize));
                        if let Some(top) = blocks.last_mut() {
                            top.push(Block::Table(f.table));
                        }
                    }
                }
                _ => {}
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }

    if let Some(root) = blocks.first_mut() {
        out.append(root);
    }
    Ok(())
}

/// Push the open run (if any) into the paragraph's run list — empty-text runs are KEPT (dropping
/// them would shift run indices and misaddress per-run edits).
fn flush_run(p: &mut ParaAccum) {
    if let Some((char_ref, text)) = p.cur_run.take() {
        p.runs.push(Run {
            char_shape: 0,
            char_ref,
            content: vec![Inline::Text(text)],
        });
    }
}

/// Mark the innermost in-progress paragraph as non-re-emittable (it has structural children).
fn mark_not_simple(paras: &mut [ParaAccum]) {
    if let Some(p) = paras.last_mut() {
        p.simple = false;
    }
}

fn attr_usize(e: &BytesStart, name: &[u8]) -> Option<usize> {
    for a in e.attributes().flatten() {
        if a.key.local_name().as_ref() == name {
            return std::str::from_utf8(&a.value).ok()?.trim().parse().ok();
        }
    }
    None
}

fn attr_str(e: &BytesStart, name: &[u8]) -> Option<String> {
    for a in e.attributes().flatten() {
        if a.key.local_name().as_ref() == name {
            return Some(String::from_utf8_lossy(&a.value).into_owned());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_paragraphs_and_table() {
        let xml = r#"<hs:sec xmlns:hs="s" xmlns:hp="p">
          <hp:p><hp:run><hp:t>첫 문단</hp:t></hp:run></hp:p>
          <hp:p><hp:run><hp:tbl rowCnt="1" colCnt="2">
            <hp:tr>
              <hp:tc><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/>
                <hp:subList><hp:p><hp:run><hp:t>셀A</hp:t></hp:run></hp:p></hp:subList></hp:tc>
              <hp:tc><hp:cellAddr colAddr="1" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/>
                <hp:subList><hp:p><hp:run><hp:t>셀B</hp:t></hp:run></hp:p></hp:subList></hp:tc>
            </hp:tr>
          </hp:tbl></hp:run></hp:p>
        </hs:sec>"#;
        let mut blocks = Vec::new();
        parse_section(xml, &mut blocks).unwrap();
        // one paragraph + one table
        assert!(blocks.iter().any(|b| matches!(b, Block::Paragraph(_))));
        let tbl = blocks.iter().find_map(|b| match b {
            Block::Table(t) => Some(t),
            _ => None,
        });
        let tbl = tbl.expect("table parsed");
        assert_eq!((tbl.rows, tbl.cols), (1, 2));
        assert_eq!(tbl.cells.len(), 2);
        // cell text round-trips into the AST
        let doc_text = {
            let mut s = SemanticDoc::default();
            s.sections.push(Section {
                blocks,
                ..Default::default()
            });
            s.plain_text()
        };
        assert!(doc_text.contains("첫 문단"));
        assert!(doc_text.contains("셀A") && doc_text.contains("셀B"));
    }

    #[test]
    fn parse_in_makes_existing_formatting_readable() {
        // P1: parse_semantic fills header_pools; an existing bold/colored run is readable by value.
        let p = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../corpus/hwpx/FormattingShowcase.hwpx"
        );
        let doc = parse_semantic(&std::fs::read(p).unwrap()).unwrap();
        assert!(!doc.header_pools.char.is_empty(), "charPr pool parsed");
        assert!(!doc.header_pools.para.is_empty(), "paraPr pool parsed");
        // The showcase's "굵은 텍스트" run uses charPrIDRef 7 (bold + blue). Find a run with that ref
        // and confirm its formatting is now READABLE from the AST.
        let bold_ref = doc.sections[0].blocks.iter().find_map(|b| match b {
            Block::Paragraph(pp) => pp.runs.iter().find_map(|r| {
                let cr = r.char_ref.as_deref()?;
                let cs = doc.char_shape_of_ref(cr)?;
                cs.bold.then(|| cr.to_string())
            }),
            _ => None,
        });
        let cr = bold_ref.expect("found a run whose original charPr is bold");
        assert!(
            doc.char_shape_of_ref(&cr).unwrap().bold,
            "existing bold formatting is readable"
        );
    }

    #[test]
    fn captures_source_spans_refs_and_simple_flag() {
        let xml = r#"<hs:sec xmlns:hs="s" xmlns:hp="p"><hp:p id="100" paraPrIDRef="3" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>가</hp:t></hp:run><hp:run charPrIDRef="7"><hp:t>나</hp:t></hp:run></hp:p><hp:p id="200" paraPrIDRef="3"><hp:run charPrIDRef="0"><hp:tbl rowCnt="1" colCnt="1"><hp:tr><hp:tc><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:subList><hp:p><hp:run><hp:t>셀</hp:t></hp:run></hp:p></hp:subList></hp:tc></hp:tr></hp:tbl></hp:run></hp:p></hs:sec>"#;
        let mut blocks = Vec::new();
        parse_section(xml, &mut blocks).unwrap();
        let paras: Vec<&Paragraph> = blocks
            .iter()
            .filter_map(|b| match b {
                Block::Paragraph(p) => Some(p),
                _ => None,
            })
            .collect();

        // First top-level paragraph: simple, 2 runs with their charPrIDRefs preserved, valid span.
        let p0 = paras[0];
        let src = p0.source.as_ref().expect("top-level para has source");
        assert!(src.simple, "text-only paragraph is simple");
        assert_eq!(src.para_pr.as_deref(), Some("3"));
        assert_eq!(src.id.as_deref(), Some("100"));
        let (s, e) = src.span;
        assert!(
            xml[s..e].starts_with("<hp:p ") && xml[s..e].ends_with("</hp:p>"),
            "tight span: {:?}",
            &xml[s..e]
        );
        assert_eq!(p0.runs.len(), 2, "runs split per <hp:run>");
        assert_eq!(p0.runs[0].char_ref.as_deref(), Some("0"));
        assert_eq!(p0.runs[1].char_ref.as_deref(), Some("7"));

        // Second top-level paragraph WRAPS a table → NOT simple (must never be re-emitted in place).
        let wrapper = paras
            .iter()
            .find(|p| p.source.as_ref().is_some_and(|sc| !sc.simple));
        assert!(wrapper.is_some(), "table-wrapping paragraph is non-simple");
    }
}
