//! rhwp `Document` → our `SemanticDoc` lift.
//!
//! A real (subset) lift: sections → paragraphs (text) and tables (rows/cols/cells with
//! spans + cell paragraphs). This is the foundation for HWP5 text extraction, the
//! structure-preserving AI projection, and the edit/export pipeline. Deeper fidelity
//! (resolved char/para shapes into header pools, images, equations, full passthrough)
//! is the continuing M1/M3 work — un-modeled inline objects are simply not emitted yet
//! (they remain faithfully RENDERED via rhwp's own pipeline).

use hwp_model::prelude::*;
use rhwp::model::control::Control;
use rhwp::model::paragraph::Paragraph as RParagraph;
use rhwp::model::table::Table as RTable;

/// Parse HWP/HWPX bytes via rhwp and lift into our format-neutral `SemanticDoc`.
pub fn parse_to_semantic(bytes: &[u8]) -> Result<SemanticDoc> {
    let doc = rhwp::parse_document(bytes).map_err(|e| Error::Parse(e.to_string()))?;
    let mut out = SemanticDoc::default();
    for sec in &doc.sections {
        let mut section = Section {
            provenance: Provenance { source: Some(SourceFormat::Hwp5), raw: None },
            ..Default::default()
        };
        for para in &sec.paragraphs {
            push_paragraph(para, &mut section.blocks);
        }
        out.sections.push(section);
    }
    Ok(out)
}

/// Emit a paragraph, then any block-level objects (tables) anchored in its controls.
fn push_paragraph(p: &RParagraph, blocks: &mut Vec<Block>) {
    let runs = if p.text.is_empty() {
        Vec::new()
    } else {
        vec![Run {
            char_shape: 0,
            content: vec![Inline::Text(p.text.clone())],
            ..Default::default()
        }]
    };
    blocks.push(Block::Paragraph(Paragraph {
        para_shape: p.para_shape_id as usize,
        runs,
        provenance: Provenance { source: Some(SourceFormat::Hwp5), raw: None },
        ..Default::default()
    }));

    for ctrl in &p.controls {
        if let Control::Table(t) = ctrl {
            blocks.push(Block::Table(lift_table(t)));
        }
    }
}

fn lift_table(t: &RTable) -> Table {
    let cells = t
        .cells
        .iter()
        .map(|c| {
            let mut blocks = Vec::new();
            for p in &c.paragraphs {
                push_paragraph(p, &mut blocks);
            }
            Cell {
                row: c.row as usize,
                col: c.col as usize,
                row_span: (c.row_span.max(1)) as usize,
                col_span: (c.col_span.max(1)) as usize,
                blocks,
                active: true,
                ..Default::default()
            }
        })
        .collect();

    Table {
        rows: t.row_count as usize,
        cols: t.col_count as usize,
        cells,
        provenance: Provenance { source: Some(SourceFormat::Hwp5), raw: None },
        ..Default::default()
    }
}
