//! Chart render adapter (issue 062-7) — bootstrap the vendored rhwp OOXML chart engine.
//!
//! rhwp ships a complete OOXML (DrawingML) chart parser + native SVG renderer
//! (`external/rhwp/src/ooxml_chart/`, all `pub`): bar/column/line/pie + combo + dual-axis. tf-hwp uses
//! rhwp PARSE-only and renders from its own IR, so the chart renderer was never wired — a chart was
//! DROPPED at lift (`_ => {}`), leaving no box at all. This adapter calls rhwp's exact
//! `OoxmlChart::parse → render_svg` pipeline to precompute a `<g>`-embeddable SVG fragment at lift time.
//! No rhwp edit — we only wire what rhwp already does (062-1 crypto / 062-5 equation pattern).
//!
//! SCALE: rhwp's chart renderer draws in the coordinate space it is handed. We pass a box sized in the
//! own-render px scale (`px = HWPUNIT/75`) with origin `(0,0)`, so the produced fragment lands in the
//! same page px space as the reserved box — the SVG/HTML backends nest it at the box origin
//! (`<g transform=translate(box)>`) with no rescale, exactly like the equation channel.
//!
//! SCOPE (v1): OOXML DrawingML only. The legacy OLE VtChart (`Contents` stream) is out of scope — the
//! caller resolves the OOXML XML bytes and only reaches here for a real DrawingML chart.

/// Our own-render px scale: 1in = 7200 HWPUNIT = 96px ⇒ px = HWPUNIT/75.
const HWPUNIT_PER_PX: f64 = 7200.0 / 96.0;

/// Render OOXML chart `xml` into a `<g>`-embeddable SVG fragment (issue 062-7) sized to the reserved
/// box (`width`/`height` in HWPUNIT), or `None` when the box is degenerate, the XML isn't a parseable
/// OOXML chart, or the render fails. The fragment's coordinates are in the own-render px scale, so a
/// backend nests it at the box origin with no rescale.
///
/// The rhwp chart parser/renderer is vendored and could panic on a pathological input, so — like every
/// rhwp call in this crate — the pipeline runs under `catch_unwind`: a panic degrades to `None` (the
/// stub box), never poisoning the whole lift.
pub(crate) fn chart_svg(xml: &[u8], width_hwpunit: i32, height_hwpunit: i32) -> Option<String> {
    let w_px = width_hwpunit as f64 / HWPUNIT_PER_PX;
    let h_px = height_hwpunit as f64 / HWPUNIT_PER_PX;
    // A degenerate/zero box would collapse the plot — fall back to the stub.
    if !(w_px.is_finite() && w_px > 0.0 && h_px.is_finite() && h_px > 0.0) {
        return None;
    }

    let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let chart = rhwp::ooxml_chart::OoxmlChart::parse(xml)?;
        // Origin (0,0): the SvgSink/HTML backend translates the fragment to the box position.
        Some(chart.render_svg(0.0, 0.0, w_px, h_px))
    }));

    match run {
        Ok(Some(frag)) if !frag.trim().is_empty() => Some(frag),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // rhwp's own canonical OOXML bar-chart fixture (`ooxml_chart::parser::tests::BAR_XML`): two series
    // over two categories. Parsing + rendering it exercises the whole parse→SVG path.
    const BAR_XML: &str = r#"<?xml version="1.0"?>
<c:chartSpace xmlns:c="x" xmlns:a="y">
<c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>매출</a:t></a:r></a:p></c:rich></c:tx></c:title>
<c:plotArea>
    <c:barChart>
      <c:barDir val="col"/>
      <c:ser>
        <c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>2023</c:v></c:pt></c:strCache></c:strRef></c:tx>
        <c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>1월</c:v></c:pt><c:pt idx="1"><c:v>2월</c:v></c:pt></c:strCache></c:strRef></c:cat>
        <c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>20</c:v></c:pt></c:numCache></c:numRef></c:val>
      </c:ser>
    </c:barChart>
</c:plotArea></c:chart>
</c:chartSpace>"#;

    #[test]
    fn renders_a_bar_chart_to_a_nonempty_fragment() {
        let svg = chart_svg(BAR_XML.as_bytes(), 30000, 20000).expect("bar chart renders");
        assert!(!svg.trim().is_empty(), "fragment is non-empty");
        assert!(
            svg.contains("hwp-ooxml-chart"),
            "rhwp's native chart group is present: {svg}"
        );
        // A rendered bar chart draws its bars as <rect> and its labels as <text>.
        assert!(svg.contains("<rect"), "bars are rects: {svg}");
    }

    #[test]
    fn non_chart_xml_is_none() {
        // Well-formed XML that is not an OOXML chart (no series/title) → parse returns None → stub.
        assert!(chart_svg(b"<foo><bar/></foo>", 30000, 20000).is_none());
        assert!(chart_svg(b"not xml at all", 30000, 20000).is_none());
        assert!(chart_svg(b"", 30000, 20000).is_none());
    }

    #[test]
    fn degenerate_box_is_none() {
        assert!(chart_svg(BAR_XML.as_bytes(), 0, 20000).is_none());
        assert!(chart_svg(BAR_XML.as_bytes(), 30000, 0).is_none());
        assert!(chart_svg(BAR_XML.as_bytes(), -5, 20000).is_none());
    }
}
