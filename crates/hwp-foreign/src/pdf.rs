//! PDF → **VIEW-MOSTLY** [`SemanticDoc`] reader (feature `pdfin`).
//!
//! SCOPE (explicit, per P5): a PDF is NOT reconstructed into semantic paragraphs/tables. We give a
//! FAITHFUL VIEW: positioned text per page, lowered to [`PageLayerTree`] paint ops (`Glyph`) that the
//! P3 SVG renderer replays directly. The `SemanticDoc` we return carries:
//! - `origin = Pdf` (so the UI knows it's view+overlay, not full edit),
//! - one [`Section`] per page with its MediaBox as the page setup,
//! - the page's extracted text as paragraphs (for search / AI context / `plain_text`),
//! so existing text-oriented code keeps working — but the truthful render path is [`page_trees`],
//! which positions glyphs at their PDF coordinates rather than re-laying-out the text.
//!
//! Implementation: `lopdf` parses the PDF object graph; we walk each page's content stream, tracking
//! the text matrix (`Tm`/`Td`/`TD`/`T*`), font size (`Tf`), and leading (`TL`), and emit a glyph per
//! shown character (`Tj`/`TJ`/`'`/`"`). Glyph advances use a coarse per-char width (we don't resolve
//! every font's width array yet — a known fidelity TODO), which is adequate for a readable overlay.

use hwp_model::prelude::*;
use hwp_model::types::Color;
use lopdf::{Document, Object};

/// Parse a `.pdf` byte buffer into a VIEW-MOSTLY `SemanticDoc` (text + page setup; origin = Pdf).
pub fn read(bytes: &[u8]) -> Result<SemanticDoc> {
    let pages = extract_pages(bytes)?;
    let mut doc = SemanticDoc::default();
    doc.origin = Some(SourceFormat::Pdf);
    doc.char_shapes.push(CharShape::default());
    doc.para_shapes.push(ParaShape::default());

    for page in &pages {
        let mut section = Section {
            page: page.page_setup(),
            provenance: Provenance { source: Some(SourceFormat::Pdf), raw: None },
            ..Default::default()
        };
        // One paragraph per text line (grouped by y), so `plain_text` / search behave sanely.
        for line in page.lines() {
            let para = Paragraph {
                para_shape: 0,
                runs: vec![Run { char_shape: 0, char_ref: None, content: vec![Inline::Text(line)] }],
                provenance: Provenance { source: Some(SourceFormat::Pdf), raw: None },
                ..Default::default()
            };
            section.blocks.push(Block::Paragraph(para));
        }
        if section.blocks.is_empty() {
            // Keep an empty paragraph so the page still occupies a section.
            section.blocks.push(Block::Paragraph(Paragraph {
                runs: vec![Run { char_shape: 0, char_ref: None, content: vec![Inline::Text(String::new())] }],
                provenance: Provenance { source: Some(SourceFormat::Pdf), raw: None },
                ..Default::default()
            }));
        }
        doc.sections.push(section);
    }
    if doc.sections.is_empty() {
        doc.sections.push(Section::default());
    }
    assign_node_ids(&mut doc);
    Ok(doc)
}

/// Lower a `.pdf` into one [`PageLayerTree`] per page — positioned glyphs at their PDF coordinates,
/// in HWPUNIT (1pt = 100). This is the FAITHFUL VIEW path the SVG renderer should replay (instead of
/// `place_doc`, which would re-flow the text). Origin/y is page-top-left (PDF's origin is bottom-left,
/// so we flip y against the MediaBox height).
pub fn page_trees(bytes: &[u8]) -> Result<Vec<PageLayerTree>> {
    let pages = extract_pages(bytes)?;
    Ok(pages.iter().map(Page::to_tree).collect())
}

// ---------- PDF content-stream walk ----------

/// A positioned glyph in page coordinates (PDF user space, points, origin bottom-left).
struct Glyph {
    x: f64,
    y: f64,
    ch: char,
    size: f64,
}

struct Page {
    width_pt: f64,
    height_pt: f64,
    glyphs: Vec<Glyph>,
}

const PT_TO_HWP: f64 = 100.0;

impl Page {
    fn page_setup(&self) -> PageSetup {
        PageSetup {
            width: (self.width_pt * PT_TO_HWP) as HwpUnit,
            height: (self.height_pt * PT_TO_HWP) as HwpUnit,
            landscape: self.width_pt > self.height_pt,
            ..Default::default()
        }
    }

    /// Lower to a paint tree (HWPUNIT, page-top-left). Flip y: page-top = MediaBox top.
    fn to_tree(&self) -> PageLayerTree {
        let w = self.width_pt * PT_TO_HWP;
        let h = self.height_pt * PT_TO_HWP;
        let ops = self
            .glyphs
            .iter()
            .map(|g| PaintOp::Glyph {
                x: g.x * PT_TO_HWP,
                // baseline measured from page top: flip against height.
                y: (self.height_pt - g.y) * PT_TO_HWP,
                ch: g.ch,
                size: g.size * PT_TO_HWP,
                color: Color::default(),
            })
            .collect();
        PageLayerTree { schema_version: PAINT_SCHEMA_VERSION, width: w, height: h, ops }
    }

    /// Group glyphs into text lines (by rounded baseline y, top-to-bottom; left-to-right within).
    fn lines(&self) -> Vec<String> {
        use std::collections::BTreeMap;
        // Key by negated rounded y so BTreeMap iterates top (high y in PDF space) → bottom.
        let mut by_line: BTreeMap<i64, Vec<&Glyph>> = BTreeMap::new();
        for g in &self.glyphs {
            by_line.entry(-(g.y.round() as i64)).or_default().push(g);
        }
        let mut out = Vec::new();
        for (_, mut gs) in by_line {
            gs.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal));
            let s: String = gs.iter().map(|g| g.ch).collect();
            if !s.trim().is_empty() {
                out.push(s);
            }
        }
        out
    }
}

/// Extract every page's positioned glyphs from the PDF bytes.
fn extract_pages(bytes: &[u8]) -> Result<Vec<Page>> {
    let document =
        Document::load_mem(bytes).map_err(|e| Error::Parse(format!("pdf load: {e}")))?;
    let mut pages = Vec::new();
    for (_num, page_id) in document.get_pages() {
        let (w, h) = media_box(&document, page_id).unwrap_or((612.0, 792.0)); // US Letter fallback
        let raw = document
            .get_page_content(page_id)
            .map_err(|e| Error::Parse(format!("pdf page content: {e}")))?;
        let content = lopdf::content::Content::decode(&raw)
            .map_err(|e| Error::Parse(format!("pdf content decode: {e}")))?;
        let glyphs = walk_content(&content);
        pages.push(Page { width_pt: w, height_pt: h, glyphs });
    }
    Ok(pages)
}

/// MediaBox (width, height) in points for a page object.
fn media_box(doc: &Document, page_id: (u32, u16)) -> Option<(f64, f64)> {
    // MediaBox may be inherited from an ancestor Pages node.
    let dict = doc.get_object(page_id).ok()?.as_dict().ok()?;
    let mb = dict
        .get(b"MediaBox")
        .ok()
        .and_then(|o| resolve_array(doc, o))
        .or_else(|| {
            // Walk up Parent chain.
            let mut cur = dict.get(b"Parent").ok().and_then(|o| o.as_reference().ok());
            while let Some(r) = cur {
                let d = doc.get_object(r).ok()?.as_dict().ok()?;
                if let Some(arr) = d.get(b"MediaBox").ok().and_then(|o| resolve_array(doc, o)) {
                    return Some(arr);
                }
                cur = d.get(b"Parent").ok().and_then(|o| o.as_reference().ok());
            }
            None
        })?;
    if mb.len() == 4 {
        let n = |i: usize| as_f64(&mb[i]);
        Some(((n(2) - n(0)).abs(), (n(3) - n(1)).abs()))
    } else {
        None
    }
}

fn resolve_array(doc: &Document, o: &Object) -> Option<Vec<Object>> {
    match o {
        Object::Array(a) => Some(a.clone()),
        Object::Reference(r) => doc.get_object(*r).ok().and_then(|x| x.as_array().ok().cloned()),
        _ => None,
    }
}

fn as_f64(o: &Object) -> f64 {
    match o {
        Object::Integer(i) => *i as f64,
        Object::Real(r) => *r as f64,
        _ => 0.0,
    }
}

/// Walk a decoded content stream, tracking the text state machine, emitting one [`Glyph`] per shown
/// character. We model the subset needed for a readable overlay: `BT`/`ET`, `Tf`, `Td`/`TD`/`Tm`/`T*`,
/// `TL`, `Tj`/`TJ`/`'`/`"`. Per-char advance is a coarse `0.5 * size` (font width arrays = TODO).
fn walk_content(content: &lopdf::content::Content) -> Vec<Glyph> {
    let mut glyphs = Vec::new();
    // Text matrix translation (tx, ty), line-matrix translation, font size, leading.
    let mut tx = 0.0f64;
    let mut ty = 0.0f64;
    let mut line_x = 0.0f64;
    let mut line_y = 0.0f64;
    let mut size = 12.0f64;
    let mut leading = 0.0f64;

    for op in &content.operations {
        let operands = &op.operands;
        match op.operator.as_str() {
            "BT" => {
                tx = 0.0;
                ty = 0.0;
                line_x = 0.0;
                line_y = 0.0;
            }
            "Tf" => {
                if let Some(s) = operands.get(1) {
                    size = as_f64(s);
                }
            }
            "TL" => {
                if let Some(l) = operands.first() {
                    leading = as_f64(l);
                }
            }
            "Td" => {
                line_x += operands.first().map(as_f64).unwrap_or(0.0);
                line_y += operands.get(1).map(as_f64).unwrap_or(0.0);
                tx = line_x;
                ty = line_y;
            }
            "TD" => {
                let dx = operands.first().map(as_f64).unwrap_or(0.0);
                let dy = operands.get(1).map(as_f64).unwrap_or(0.0);
                leading = -dy;
                line_x += dx;
                line_y += dy;
                tx = line_x;
                ty = line_y;
            }
            "Tm" => {
                // [a b c d e f]; we use e,f (translation) and d (vertical scale ~ size already in Tf).
                if operands.len() == 6 {
                    line_x = as_f64(&operands[4]);
                    line_y = as_f64(&operands[5]);
                    tx = line_x;
                    ty = line_y;
                }
            }
            "T*" => {
                line_y -= leading;
                tx = line_x;
                ty = line_y;
            }
            "Tj" => {
                if let Some(Object::String(s, _)) = operands.first() {
                    emit_string(s, &mut glyphs, &mut tx, ty, size);
                }
            }
            "'" => {
                // move to next line then show.
                line_y -= leading;
                tx = line_x;
                ty = line_y;
                if let Some(Object::String(s, _)) = operands.first() {
                    emit_string(s, &mut glyphs, &mut tx, ty, size);
                }
            }
            "\"" => {
                line_y -= leading;
                tx = line_x;
                ty = line_y;
                if let Some(Object::String(s, _)) = operands.get(2) {
                    emit_string(s, &mut glyphs, &mut tx, ty, size);
                }
            }
            "TJ" => {
                if let Some(Object::Array(arr)) = operands.first() {
                    for el in arr {
                        match el {
                            Object::String(s, _) => emit_string(s, &mut glyphs, &mut tx, ty, size),
                            // A number adjusts position (thousandths of an em, subtracted).
                            Object::Integer(_) | Object::Real(_) => {
                                tx -= as_f64(el) / 1000.0 * size;
                            }
                            _ => {}
                        }
                    }
                }
            }
            _ => {}
        }
    }
    glyphs
}

/// Emit glyphs for a PDF string literal, advancing `tx` by a coarse per-char width. Bytes are decoded
/// as Latin-1/ASCII (full font CMap decoding is a fidelity TODO; non-ASCII bytes pass through as the
/// replacement glyph rather than being dropped).
fn emit_string(bytes: &[u8], glyphs: &mut Vec<Glyph>, tx: &mut f64, ty: f64, size: f64) {
    for &b in bytes {
        let ch = if b.is_ascii() && !b.is_ascii_control() {
            b as char
        } else if b == b' ' {
            ' '
        } else {
            // Map non-ASCII single bytes to their Latin-1 char so common Western text shows.
            b as char
        };
        glyphs.push(Glyph { x: *tx, y: ty, ch, size });
        // Coarse advance: spaces ~0.3em, others ~0.5em.
        let adv = if ch == ' ' { 0.3 } else { 0.5 };
        *tx += adv * size;
    }
}

/// Assign stable in-memory `NodeId`s to top-level paragraphs.
fn assign_node_ids(doc: &mut SemanticDoc) {
    let mut next = 1u64;
    for sec in &mut doc.sections {
        for b in &mut sec.blocks {
            if let Block::Paragraph(p) = b {
                p.id = Some(NodeId(next));
                next += 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::dictionary;
    use lopdf::{Dictionary, Stream};

    /// Build a valid minimal one-page PDF (via lopdf's writer, so the xref/trailer are correct) with a
    /// single `Tj` text-show at (100, 700) on a 612x792 page. Returns the serialized bytes.
    fn mini_pdf() -> Vec<u8> {
        let mut doc = Document::with_version("1.5");
        let content = b"BT /F1 24 Tf 100 700 Td (Hello PDF) Tj ET".to_vec();
        let content_id = doc.add_object(Stream::new(dictionary! {}, content));
        let page_id = doc.new_object_id();
        let pages_id = doc.new_object_id();
        let page_dict = dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            "Contents" => content_id,
            "Resources" => Dictionary::new(),
        };
        doc.objects.insert(page_id, Object::Dictionary(page_dict));
        let pages = dictionary! {
            "Type" => "Pages",
            "Kids" => vec![page_id.into()],
            "Count" => 1,
        };
        doc.objects.insert(pages_id, Object::Dictionary(pages));
        let catalog_id = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", catalog_id);
        let mut buf = Vec::new();
        doc.save_to(&mut buf).expect("save pdf");
        buf
    }

    #[test]
    fn reads_positioned_text() {
        let bytes = mini_pdf();
        let doc = read(&bytes).expect("read pdf");
        assert_eq!(doc.origin, Some(SourceFormat::Pdf));
        assert_eq!(doc.sections.len(), 1, "one page → one section");
        let page = doc.sections[0].page;
        assert_eq!(page.width, 612 * 100);
        assert_eq!(page.height, 792 * 100);
        let text = doc.plain_text();
        assert!(text.contains("Hello PDF"), "got: {text:?}");
    }

    #[test]
    fn lowers_to_paint_tree_with_glyphs() {
        let trees = page_trees(&mini_pdf()).expect("page trees");
        assert_eq!(trees.len(), 1);
        let glyphs: Vec<_> = trees[0]
            .ops
            .iter()
            .filter(|o| matches!(o, PaintOp::Glyph { .. }))
            .collect();
        assert!(!glyphs.is_empty(), "expected positioned glyphs");
        // First glyph 'H' at x=100pt → 10000 HWPUNIT, y flipped: (792-700)*100 = 9200.
        if let PaintOp::Glyph { x, y, ch, .. } = glyphs[0] {
            assert_eq!(*ch, 'H');
            assert!((*x - 10000.0).abs() < 1.0, "x={x}");
            assert!((*y - 9200.0).abs() < 1.0, "y={y}");
        }
    }
}
