//! Equation render adapter (issue 062-5) — bootstrap the vendored rhwp equation engine.
//!
//! rhwp ships a complete 한컴 수식 engine (`external/rhwp/src/renderer/equation/`, ~7.5k LOC, all
//! `pub`). tf-hwp uses rhwp PARSE-only and renders from its own IR, so the equation renderer was never
//! wired — the own-render/HTML surfaces drew a stub box. This adapter calls rhwp's exact
//! `tokenize → EqParser → EqLayout → render_equation_svg` pipeline (the SAME sequence rhwp's own
//! `shape_layout.rs` uses) to precompute a `<g>`-embeddable SVG fragment at lift time. No rhwp edit —
//! we only wire what rhwp already does (062-1 crypto pattern).
//!
//! SCALE: rhwp lays the equation out at `font-size px = hwpunit_to_px(font_size, 96)` = `font_size/75`,
//! which is EXACTLY our own-render px scale (`HWPUNIT_PER_PX = 7200/96 = 75`). So the fragment's
//! coordinates land in the same page px space as the reserved box — the SVG/HTML backends nest it at
//! the box origin with no rescale.

/// Our own-render px scale: 1in = 7200 HWPUNIT = 96px ⇒ px = HWPUNIT/75. Matches rhwp's
/// `hwpunit_to_px(hu, 96)` so the produced fragment is drawn at the box's scale.
const HWPUNIT_PER_PX: f64 = 7200.0 / 96.0;

/// Render an equation `script` to a `<g>`-embeddable SVG fragment (issue 062-5), or `None` when the
/// script is empty or the render fails. `font_size_hwpunit` is OWPML `baseUnit` (== our
/// `EquationRef::base_unit`); `color_bgr` is rhwp's `ColorRef` (`0x00BBGGRR`, the raw `Equation.color`).
///
/// The rhwp equation parser is vendored and could panic on a pathological script, so — like every
/// rhwp call in this crate — the pipeline runs under `catch_unwind`: a panic degrades to `None` (the
/// stub box), never poisoning the whole lift.
pub(crate) fn equation_svg(script: &str, font_size_hwpunit: u32, color_bgr: u32) -> Option<String> {
    if script.trim().is_empty() {
        return None;
    }
    let font_size_px = font_size_hwpunit as f64 / HWPUNIT_PER_PX;
    // A degenerate/zero base size would collapse the layout — fall back to the stub.
    if !(font_size_px.is_finite() && font_size_px > 0.0) {
        return None;
    }

    let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        use rhwp::renderer::equation::{layout::EqLayout, parser::EqParser, svg_render, tokenizer};
        let tokens = tokenizer::tokenize(script);
        let ast = EqParser::new(tokens).parse();
        let layout_box = EqLayout::new(font_size_px).layout(&ast);
        let color = svg_render::eq_color_to_svg(color_bgr);
        svg_render::render_equation_svg(&layout_box, &color, font_size_px)
    }));

    match run {
        Ok(frag) if !frag.trim().is_empty() => Some(frag),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_a_simple_fraction_to_a_nonempty_fragment() {
        // "1 over 2" is rhwp's own canonical tokenizer example — a fraction lays out to a fraction bar
        // (<line>) plus two number <text> boxes.
        let svg = equation_svg("1 over 2", 1000, 0).expect("fraction renders");
        assert!(!svg.trim().is_empty(), "fragment is non-empty");
        assert!(
            svg.contains("<text"),
            "numerator/denominator are text: {svg}"
        );
        assert!(svg.contains("<line"), "fraction bar is a line: {svg}");
    }

    #[test]
    fn color_bgr_flows_into_the_fill() {
        // rhwp ColorRef is 0x00BBGGRR → pure red = 0x0000FF.
        let svg = equation_svg("x", 1000, 0x0000FF).expect("renders");
        assert!(svg.contains("#ff0000"), "red fill emitted: {svg}");
    }

    #[test]
    fn empty_script_is_none() {
        assert!(equation_svg("", 1000, 0).is_none());
        assert!(equation_svg("   ", 1000, 0).is_none());
    }

    #[test]
    fn zero_font_size_is_none() {
        assert!(equation_svg("1 over 2", 0, 0).is_none());
    }
}
