//! Typography / layout engine.
//!
//! The separable "(B) layout" half of the typography subsystem (PLAN §3.1). The
//! engine boundary is a pure function: (text + resolved styles + injected font
//! metrics + writing mode) → line segments + pagination. Korean fidelity targets
//! (자간/장평, 배분/나눔 justification, 금칙, 줄간격 4-mode) are built here, layered on
//! a shaper's glyph advances (harfrust primary, rustybuzz fallback — CHECKLIST 2.5).
//!
//! Phase 0: a naive metric-based stub so `hwp-core` assembles; real layout lands in
//! Phase 2.

use hwp_model::prelude::*;

/// Placeholder layout engine (no real shaping/line-breaking yet).
#[derive(Default)]
pub struct NaiveLayout;

impl LayoutEngine for NaiveLayout {
    fn layout(&self, _doc: &SemanticDoc, _fonts: &dyn FontMetricsProvider) -> Result<LayoutResult> {
        Err(Error::NotImplemented(
            "typeset engine — Korean line-breaking/justification (Phase 2)",
        ))
    }
}

/// Placeholder metrics provider (monospace-ish estimate) so the trait is satisfiable
/// before a real shaper is wired. Never use for fidelity.
#[derive(Default)]
pub struct NullFontMetrics;

impl FontMetricsProvider for NullFontMetrics {
    fn advance_width(&self, _font: &FontKey, _ch: char, size_hwpunit: i32) -> f64 {
        // ~0.5em estimate; placeholder only.
        size_hwpunit as f64 * 0.5
    }
}
