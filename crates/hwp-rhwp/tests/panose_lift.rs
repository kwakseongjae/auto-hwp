//! Issue 058 follow-up: prove the FaceName `typeInfo` (PANOSE) actually reaches the IR from a REAL
//! binary `.hwp` — the empirical half of "명조/고딕 혼용 문서에서 분류 개선 실증". rhwp exposes the HWP5
//! FaceName type-info as `Font.type_info: Option<[u8; 10]>`; `lift_font_panose` forwards it into
//! `CharShape.font_panose` for the faces whose PANOSE is DEFINITIVE. The benchmark corpus (the same
//! files the layout gate pins) carries these hints on many faces, so this locks in that the lift path
//! populates them and stays display-only (the gate's page-count invariant is checked separately and
//! is unchanged before/after this feature).
#![cfg(feature = "rhwp")]

use hwp_model::prelude::{DocumentParser, SourceFormat};

fn lift(name: &str) -> hwp_model::document::SemanticDoc {
    let path = format!("{}/../../benchmarks/{name}", env!("CARGO_MANIFEST_DIR"));
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    hwp_rhwp::RhwpEngine::new()
        .parse(&bytes, SourceFormat::Hwp5)
        .expect("rhwp lift")
}

#[test]
fn benchmark_faces_carry_definitive_panose_hints() {
    // Real docs actually populate `font_panose` — this is the on-real-data proof the parse→lift wiring
    // works (not just the synthetic unit tests). Every stored slot is DEFINITIVE by construction
    // (`lift_font_panose` filters to `classify_panose(..).is_some()`), so its presence means the
    // renderer now classifies these faces by PANOSE, not name.
    for name in ["benchmark.hwp", "benchmark1.hwp"] {
        let doc = lift(name);
        let with_hint = doc
            .char_shapes
            .iter()
            .filter(|c| !c.font_panose.is_empty())
            .count();
        assert!(
            with_hint > 0,
            "{name}: expected some char shapes to carry a definitive PANOSE hint, got {with_hint}"
        );
        // Sanity: every stored hint is a definitive serif/sans category (no indeterminate PANOSE leaks
        // into the IR — those are dropped to `None` so the name heuristic still applies).
        for cs in &doc.char_shapes {
            for slot in cs.font_panose.iter().flatten() {
                assert!(
                    hwp_model::font_class::classify_panose(slot).is_some(),
                    "{name}: only definitive PANOSE is stored in the IR"
                );
            }
        }
    }
}
