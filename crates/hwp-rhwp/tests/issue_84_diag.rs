//! Issue 84: `.hwp` lift must not emit extra body paragraphs for Equation/Chart controls.
//!
//! Same extra-paragraph hole as Picture (issue 82), different height rule: every observed
//! corpus equation is `treat_as_char=true` (inline), so `object_height` still reserves the box.
#![cfg(feature = "rhwp")]

use hwp_model::prelude::*;
use rhwp::model::control::Control;

fn repo_file(rel: &str) -> Vec<u8> {
    let path = format!("{}/../../{rel}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"))
}

fn body_para_count(blocks: &[Block]) -> usize {
    blocks
        .iter()
        .filter(|b| matches!(b, Block::Paragraph(_)))
        .count()
}

fn count_inlines(blocks: &[Block], pred: impl Fn(&Inline) -> bool) -> usize {
    blocks
        .iter()
        .filter_map(|b| match b {
            Block::Paragraph(p) => Some(p),
            _ => None,
        })
        .flat_map(|p| &p.runs)
        .flat_map(|r| &r.content)
        .filter(|i| pred(i))
        .count()
}

fn pages(doc: &SemanticDoc) -> (usize, usize) {
    #[cfg(feature = "shaper")]
    let fonts = hwp_typeset::RealFontMetrics::new();
    #[cfg(not(feature = "shaper"))]
    let fonts = hwp_typeset::ApproxFontMetrics;
    let naive = hwp_typeset::NaiveLayout
        .layout(doc, &fonts)
        .expect("NaiveLayout")
        .pages
        .len();
    let placed = hwp_typeset::place_doc(doc, &fonts).pages.len();
    (naive, placed)
}

#[test]
fn math_001_equation_controls_do_not_add_extra_body_paragraphs() {
    let bytes = repo_file("corpus/hwp/math-001.hwp");
    let rdoc = rhwp::parse_document(&bytes).expect("rhwp parse");
    let our = hwp_rhwp::parse_to_semantic_guarded(&bytes).expect("lift");

    let rhwp_body: usize = rdoc.sections.iter().map(|s| s.paragraphs.len()).sum();
    let our_body: usize = our
        .sections
        .iter()
        .map(|s| body_para_count(&s.blocks))
        .sum();
    let eqs: usize = our
        .sections
        .iter()
        .map(|s| count_inlines(&s.blocks, |i| matches!(i, Inline::Equation(_))))
        .sum();
    let rhwp_eqs: usize = rdoc
        .sections
        .iter()
        .flat_map(|s| &s.paragraphs)
        .flat_map(|p| &p.controls)
        .filter(|c| matches!(c, Control::Equation(_)))
        .count();
    let tac = rdoc
        .sections
        .iter()
        .flat_map(|s| &s.paragraphs)
        .flat_map(|p| &p.controls)
        .filter(|c| match c {
            Control::Equation(eq) => eq.common.treat_as_char,
            _ => false,
        })
        .count();

    assert_eq!(rhwp_eqs, 44, "fixture still has 44 equation controls");
    assert_eq!(
        tac, rhwp_eqs,
        "corpus equations are treat_as_char=true (inline)"
    );
    assert_eq!(
        our_body, rhwp_body,
        "lift body paragraphs must zip 1:1 with rhwp (was +{rhwp_eqs} equation object paras)"
    );
    assert_eq!(
        eqs, rhwp_eqs,
        "each Equation control must still lift to Inline::Equation"
    );

    let (naive, placed) = pages(&our);
    assert_eq!(
        naive, placed,
        "LOCKSTEP: NaiveLayout {naive} != place_doc {placed}"
    );
    let oracle = hwp_rhwp::page_count(&bytes).unwrap_or(0) as usize;
    // Extra object paragraphs were the 3-vs-1 leak (44 stacked boxes). After attaching,
    // zip is 1:1 and we drop to 2 pages. The remaining +1 is inline TAC flow (equations
    // still have no width in the line breaker; object_height bumps only the first line) —
    // not another extra-paragraph leak.
    assert_eq!(
        naive, 2,
        "extra equation paragraphs gone (was 3); remaining {naive} vs oracle {oracle} is inline flow"
    );
}

#[test]
fn issue_505_equations_stay_one_paragraph_each_and_keep_four_pages() {
    let bytes = repo_file("corpus/hwp/issue-505-equations.hwp");
    let rdoc = rhwp::parse_document(&bytes).expect("rhwp parse");
    let our = hwp_rhwp::parse_to_semantic_guarded(&bytes).expect("lift");
    let rhwp_body: usize = rdoc.sections.iter().map(|s| s.paragraphs.len()).sum();
    let our_body: usize = our
        .sections
        .iter()
        .map(|s| body_para_count(&s.blocks))
        .sum();
    assert_eq!(rhwp_body, 4);
    assert_eq!(
        our_body, rhwp_body,
        "was 8 = 4 empty hosts + 4 object paras"
    );
    let (naive, placed) = pages(&our);
    assert_eq!(naive, placed, "LOCKSTEP");
    assert_eq!(
        naive, 4,
        "empty-host + inline equation still paginates as 4 pages"
    );
}

#[test]
fn issue_265_has_no_equation_or_chart_leak() {
    let bytes = repo_file("corpus/hwp/issue_265.hwp");
    let rdoc = rhwp::parse_document(&bytes).expect("rhwp parse");
    let our = hwp_rhwp::parse_to_semantic_guarded(&bytes).expect("lift");
    let rhwp_body: usize = rdoc.sections.iter().map(|s| s.paragraphs.len()).sum();
    let our_body: usize = our
        .sections
        .iter()
        .map(|s| body_para_count(&s.blocks))
        .sum();
    let eqs: usize = our
        .sections
        .iter()
        .map(|s| {
            count_inlines(&s.blocks, |i| {
                matches!(i, Inline::Equation(_) | Inline::Chart(_))
            })
        })
        .sum();
    assert_eq!(our_body, rhwp_body);
    assert_eq!(eqs, 0, "issue_265 remaining +1 page is not this family");
}
