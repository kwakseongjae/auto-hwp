//! Source-level typesetting-element census (issue #71).
//!
//! Walks rhwp's parsed `Document` so tags reflect **what is in the file**, not only
//! what our lift currently keeps (forms become glyphs; some shapes/OLE stay dropped).

use hwp_model::prelude::*;
use rhwp::model::control::Control;
use rhwp::model::document::Document;
use rhwp::model::paragraph::Paragraph;
use rhwp::model::shape::ShapeObject;
use rhwp::model::table::Table;

/// Counts of typesetting-relevant controls in the source document.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SourceLayoutCensus {
    pub header: u32,
    pub footer: u32,
    pub form: u32,
    pub footnote: u32,
    pub endnote: u32,
    pub equation: u32,
    pub chart: u32,
    pub shape: u32,
    pub ole: u32,
    pub nested_table: u32,
    pub column_gt1: u32,
    pub landscape_sections: u32,
    pub portrait_sections: u32,
    pub tables: u32,
}

/// Parse with rhwp (HWP5 or HWPX) and count controls. Does not lift into `SemanticDoc`.
pub fn source_layout_census(bytes: &[u8]) -> Result<SourceLayoutCensus> {
    let doc = rhwp::parse_document(bytes).map_err(|e| Error::Parse(e.to_string()))?;
    Ok(census_doc(&doc))
}

fn census_doc(doc: &Document) -> SourceLayoutCensus {
    let mut c = SourceLayoutCensus::default();
    for sec in &doc.sections {
        if sec.section_def.page_def.landscape {
            c.landscape_sections += 1;
        } else {
            c.portrait_sections += 1;
        }
        walk_paras(&sec.paragraphs, &mut c);
    }
    c
}

fn walk_paras(paras: &[Paragraph], c: &mut SourceLayoutCensus) {
    for p in paras {
        for ctrl in &p.controls {
            walk_ctrl(ctrl, c);
        }
    }
}

fn walk_ctrl(ctrl: &Control, c: &mut SourceLayoutCensus) {
    match ctrl {
        Control::Header(h) => {
            c.header += 1;
            walk_paras(&h.paragraphs, c);
        }
        Control::Footer(f) => {
            c.footer += 1;
            walk_paras(&f.paragraphs, c);
        }
        Control::Form(_) => c.form += 1,
        Control::Footnote(n) => {
            c.footnote += 1;
            walk_paras(&n.paragraphs, c);
        }
        Control::Endnote(n) => {
            c.endnote += 1;
            walk_paras(&n.paragraphs, c);
        }
        Control::Equation(_) => c.equation += 1,
        Control::ColumnDef(col) => {
            if col.column_count > 1 {
                c.column_gt1 += 1;
            }
        }
        Control::Table(t) => walk_table(t, c),
        Control::Shape(shape) => walk_shape(shape, c),
        Control::Picture(_)
        | Control::SectionDef(_)
        | Control::AutoNumber(_)
        | Control::NewNumber(_)
        | Control::PageNumberPos(_)
        | Control::Bookmark(_)
        | Control::Hyperlink(_)
        | Control::Ruby(_)
        | Control::CharOverlap(_)
        | Control::PageHide(_)
        | Control::HiddenComment(_)
        | Control::Field(_)
        | Control::Unknown(_) => {}
    }
}

fn walk_table(t: &Table, c: &mut SourceLayoutCensus) {
    c.tables += 1;
    for cell in &t.cells {
        let has_inner = cell.paragraphs.iter().any(|p| {
            p.controls
                .iter()
                .any(|ctrl| matches!(ctrl, Control::Table(_)))
        });
        if has_inner {
            c.nested_table += 1;
        }
        walk_paras(&cell.paragraphs, c);
    }
}

fn walk_shape(shape: &ShapeObject, c: &mut SourceLayoutCensus) {
    match shape {
        ShapeObject::Ole(_) => c.ole += 1,
        ShapeObject::Chart(_) => c.chart += 1,
        ShapeObject::Picture(_) => {}
        ShapeObject::Line(_)
        | ShapeObject::Rectangle(_)
        | ShapeObject::Ellipse(_)
        | ShapeObject::Arc(_)
        | ShapeObject::Polygon(_)
        | ShapeObject::Curve(_)
        | ShapeObject::Group(_) => c.shape += 1,
    }
}

#[cfg(all(test, feature = "rhwp"))]
mod tests {
    use super::source_layout_census;

    fn load(rel: &str) -> Vec<u8> {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(rel);
        std::fs::read(&p).unwrap_or_else(|e| panic!("read {}: {e}", p.display()))
    }

    #[test]
    fn form_01_hwpx_has_form_controls() {
        let c = source_layout_census(&load("corpus/hwpx/form-01.hwpx")).unwrap();
        assert!(
            c.form > 0,
            "form-01.hwpx must expose Form controls, got {c:?}"
        );
    }

    #[test]
    fn footnote_01_hwpx_has_notes() {
        let c = source_layout_census(&load("corpus/hwpx/footnote-01.hwpx")).unwrap();
        assert!(
            c.footnote > 0,
            "footnote-01.hwpx must expose footnotes, got {c:?}"
        );
    }
}
