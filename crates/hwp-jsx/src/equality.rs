//! The round-trip invariant (§3.0 / M0 gate). `SemanticDoc` does not derive
//! `PartialEq`, so we define a *rigorous, falsifiable* equality strategy with three
//! independent checks. The codec test FAILS if any content is lost:
//!
//! - **A — fixed point** (`emit_str` byte-equal): `emit_project_strings(parse(emit(doc)))
//!   == emit_project_strings(emit(doc))`. The projection is a deterministic function,
//!   so if `parse∘emit` lost or perturbed anything the *re-emitted strings* diverge.
//! - **B — `doc_value_eq`** (exhaustive, hand-written): structural + value equality over
//!   EVERY modeled field of `SemanticDoc` (sections, blocks, runs, inlines, pools,
//!   header pools, bin data, passthrough, provenance, dirty, source spans). Exhaustive
//!   by construction — adding a field to the model without extending this function would
//!   leave it uncompared, so it is co-located with the codec and reviewed together.
//! - **C — byte-exact provenance**: `Provenance.raw`, `Passthrough` parts and `BinData`
//!   bytes compare byte-for-byte (covered inside B).
//!
//! A and B are complementary: A catches *projection* drift (a perturbation that survives
//! into a different string), B catches *value* drift even when the projection happens to
//! re-stabilize. Passing both + C is the strongest practical combination.

use crate::{css, jsx, project::JsxCssProject};
use hwp_model::prelude::*;

/// Check A: the deterministic-projection fixed point. Returns the two string bundles so a
/// failing test can diff them.
pub fn project_fingerprint(proj: &JsxCssProject) -> String {
    let mut s = String::new();
    s.push_str("== DOCUMENT.JSX ==\n");
    s.push_str(&jsx::emit_jsx(&proj.document));
    for (i, sec) in proj.sections.iter().enumerate() {
        s.push_str(&format!("== SECTION {i} ==\n"));
        s.push_str(&jsx::emit_jsx(sec));
    }
    s.push_str("== STYLES.CSS ==\n");
    s.push_str(&css::emit_css(&proj.styles));
    s.push_str("== MANIFEST ==\n");
    s.push_str(&serde_json::to_string(&proj.manifest).unwrap_or_default());
    s.push_str("== ASSETS ==\n");
    s.push_str(&serde_json::to_string(&proj.assets).unwrap_or_default());
    s
}

/// Check B+C: exhaustive structural+value equality over the modeled `SemanticDoc`.
pub fn doc_value_eq(a: &SemanticDoc, b: &SemanticDoc) -> bool {
    a.char_shapes == b.char_shapes
        && a.para_shapes == b.para_shapes
        && a.header_pools.char == b.header_pools.char
        && a.header_pools.para == b.header_pools.para
        && bin_eq(&a.bin_data, &b.bin_data)
        && pass_eq(&a.passthrough, &b.passthrough)
        && a.sections.len() == b.sections.len()
        && a.sections
            .iter()
            .zip(&b.sections)
            .all(|(x, y)| section_eq(x, y))
}

fn section_eq(a: &Section, b: &Section) -> bool {
    page_eq(&a.page, &b.page)
        && a.page_edited == b.page_edited
        && prov_eq(&a.provenance, &b.provenance)
        && pass_eq(&a.passthrough, &b.passthrough)
        && a.dirty == b.dirty
        && a.decorations.len() == b.decorations.len()
        && a.decorations
            .iter()
            .zip(&b.decorations)
            .all(|(x, y)| deco_eq(x, y))
        && blocks_eq(&a.blocks, &b.blocks)
}

fn deco_eq(a: &PageDecoration, b: &PageDecoration) -> bool {
    a.kind == b.kind && a.apply == b.apply && blocks_eq(&a.blocks, &b.blocks)
}

fn page_eq(a: &PageSetup, b: &PageSetup) -> bool {
    a.width == b.width
        && a.height == b.height
        && a.margin_left == b.margin_left
        && a.margin_right == b.margin_right
        && a.margin_top == b.margin_top
        && a.margin_bottom == b.margin_bottom
        && a.landscape == b.landscape
        && a.columns == b.columns
}

fn blocks_eq(a: &[Block], b: &[Block]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| block_eq(x, y))
}

fn block_eq(a: &Block, b: &Block) -> bool {
    match (a, b) {
        (Block::Paragraph(x), Block::Paragraph(y)) => para_eq(x, y),
        (Block::Table(x), Block::Table(y)) => table_eq(x, y),
        _ => false,
    }
}

fn para_eq(a: &Paragraph, b: &Paragraph) -> bool {
    a.id == b.id
        && a.para_shape == b.para_shape
        && a.style_name == b.style_name
        && a.source == b.source
        && prov_eq(&a.provenance, &b.provenance)
        && pass_eq(&a.passthrough, &b.passthrough)
        && a.dirty == b.dirty
        && a.runs.len() == b.runs.len()
        && a.runs.iter().zip(&b.runs).all(|(x, y)| run_eq(x, y))
}

fn run_eq(a: &Run, b: &Run) -> bool {
    a.char_shape == b.char_shape
        && a.char_ref == b.char_ref
        && a.content.len() == b.content.len()
        && a.content
            .iter()
            .zip(&b.content)
            .all(|(x, y)| inline_eq(x, y))
}

fn inline_eq(a: &Inline, b: &Inline) -> bool {
    match (a, b) {
        (Inline::Text(x), Inline::Text(y)) => x == y,
        (Inline::Image(x), Inline::Image(y)) => {
            x.bin_ref == y.bin_ref && x.width == y.width && x.height == y.height
        }
        (Inline::Equation(x), Inline::Equation(y)) => {
            x.script == y.script
                && x.font == y.font
                && x.base_unit == y.base_unit
                && x.baseline == y.baseline
                && x.color == y.color
                && x.width == y.width
                && x.height == y.height
                && x.version == y.version
        }
        // Issue 062-7: a chart's identity is its reserved box; the SVG is a derived cache (like the
        // equation's rendered_svg, excluded above), so it doesn't gate value-equality.
        (Inline::Chart(x), Inline::Chart(y)) => x.width == y.width && x.height == y.height,
        (Inline::FieldBegin(x), Inline::FieldBegin(y)) => {
            x.id == y.id && x.field_type == y.field_type && x.command == y.command
        }
        (Inline::FieldEnd(x), Inline::FieldEnd(y)) => x == y,
        (Inline::Bookmark(x), Inline::Bookmark(y)) => x == y,
        (Inline::Note(x), Inline::Note(y)) => {
            x.kind == y.kind
                && x.number == y.number
                && x.prefix_char == y.prefix_char
                && x.suffix_char == y.suffix_char
                && x.inst_id == y.inst_id
                && blocks_eq(&x.body, &y.body)
        }
        (Inline::Raw(x), Inline::Raw(y)) => x.tag == y.tag && x.bytes == y.bytes,
        _ => false,
    }
}

fn table_eq(a: &Table, b: &Table) -> bool {
    a.rows == b.rows
        && a.cols == b.cols
        && a.col_widths == b.col_widths
        && a.row_heights == b.row_heights
        && prov_eq(&a.provenance, &b.provenance)
        && pass_eq(&a.passthrough, &b.passthrough)
        && a.dirty == b.dirty
        && a.cells.len() == b.cells.len()
        && a.cells.iter().zip(&b.cells).all(|(x, y)| cell_eq(x, y))
}

fn cell_eq(a: &Cell, b: &Cell) -> bool {
    a.row == b.row
        && a.col == b.col
        && a.row_span == b.row_span
        && a.col_span == b.col_span
        && a.active == b.active
        && a.shade_color == b.shade_color
        && a.has_border == b.has_border
        && a.borders == b.borders
        && a.diagonal == b.diagonal
        && a.dirty == b.dirty
        && blocks_eq(&a.blocks, &b.blocks)
}

fn prov_eq(a: &Provenance, b: &Provenance) -> bool {
    a.source == b.source && a.raw == b.raw // Vec<u8> byte-exact (Check C)
}

fn pass_eq(a: &Passthrough, b: &Passthrough) -> bool {
    a.parts.len() == b.parts.len()
        && a.parts
            .iter()
            .zip(&b.parts)
            .all(|(x, y)| x.tag == y.tag && x.bytes == y.bytes)
}

fn bin_eq(a: &[BinData], b: &[BinData]) -> bool {
    a.len() == b.len()
        && a.iter()
            .zip(b)
            .all(|(x, y)| x.bin_ref == y.bin_ref && x.kind == y.kind && x.bytes == y.bytes)
}
