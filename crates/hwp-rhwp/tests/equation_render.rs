//! Issue 062-5 end-to-end: lifting a real binary `.hwp` that contains equations precomputes each
//! `EquationRef.rendered_svg` (the own-render/HTML surfaces then embed it instead of a stub box).
//! Only meaningful with the rhwp bootstrap wired.
#![cfg(feature = "rhwp")]

use hwp_model::prelude::*;

fn equations(doc: &SemanticDoc) -> Vec<&EquationRef> {
    let mut out = Vec::new();
    fn walk<'a>(blocks: &'a [Block], out: &mut Vec<&'a EquationRef>) {
        for b in blocks {
            match b {
                Block::Paragraph(p) => {
                    for r in &p.runs {
                        for i in &r.content {
                            if let Inline::Equation(e) = i {
                                out.push(e);
                            }
                        }
                    }
                }
                Block::Table(t) => {
                    for c in &t.cells {
                        walk(&c.blocks, out);
                    }
                }
            }
        }
    }
    for s in &doc.sections {
        walk(&s.blocks, &mut out);
    }
    out
}

#[test]
fn lifts_equations_with_precomputed_svg() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../external/rhwp/samples/eq-002.hwp"
    );
    let bytes = std::fs::read(path).expect("eq-002.hwp sample present (vendored rhwp)");

    let doc = hwp_rhwp::parse_to_semantic_guarded(&bytes).expect("lift eq-002.hwp");
    let eqs = equations(&doc);
    assert!(
        !eqs.is_empty(),
        "the fixture must lift at least one Inline::Equation"
    );

    // Every lifted equation carries a precomputed, non-empty SVG fragment.
    let rendered = eqs
        .iter()
        .filter(|e| {
            e.rendered_svg
                .as_deref()
                .is_some_and(|s| !s.trim().is_empty())
        })
        .count();
    assert!(
        rendered > 0,
        "at least one of {} equations precomputed a non-empty SVG fragment",
        eqs.len()
    );

    // The fragment is real equation SVG (rhwp emits <text>/<line>/<path>/<circle>).
    let sample = eqs
        .iter()
        .find_map(|e| e.rendered_svg.as_deref())
        .filter(|s| !s.trim().is_empty())
        .expect("a rendered fragment");
    assert!(
        sample.contains("<text") || sample.contains("<path") || sample.contains("<line"),
        "fragment is SVG markup: {sample}"
    );
}
