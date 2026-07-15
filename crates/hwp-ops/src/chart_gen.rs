//! Pure-Rust SVG chart generator for AI-inserted data charts (`Op::InsertChartAt`, bar/pie/line).
//!
//! REUSES the issue-062 chart render channel instead of adding any new render/PDF plumbing: the string
//! this module builds is a `<g>`-embeddable SVG fragment in the own-render **px** scale (px = HWPUNIT/75)
//! with origin `(0,0)` — the SAME shape rhwp's OOXML chart renderer produces in
//! [`hwp_model::ChartRef::rendered_svg`]. So a generated chart flows through `place_doc`'s
//! `paragraph_object` → `PaintOp::Image.svg` → the SvgSink (own view, nested at the box origin as
//! `<g transform=translate(box)>{svg}</g>`) and the HTML export exactly like a parsed OOXML chart, with
//! zero engine changes on the render side (the PDF backend draws the reserved stub box — v1, like 062).
//!
//! No new dependencies: the whole chart is `format!`-built SVG primitives (rect / line / text / path /
//! polyline / circle). It is intentionally a clean business-doc chart, not a full charting library.

use crate::ChartSeries;

/// Office-like categorical palette (distinct in light theme and in print; series/slice cycle it).
const PALETTE: [&str; 8] = [
    "#4472C4", "#ED7D31", "#70AD47", "#FFC000", "#5B9BD5", "#A5A5A5", "#264478", "#9E480E",
];
const AXIS_COLOR: &str = "#8C8C8C";
const GRID_COLOR: &str = "#E0E0E0";
const TEXT_COLOR: &str = "#404040";

/// Render a validated chart spec to a `<g>`-embeddable SVG fragment sized to a `w`×`h` px box (origin
/// `(0,0)`). `kind` is one of `"bar"` | `"pie"` | `"line"` (the caller validates it + the data). Always
/// returns a non-empty fragment wrapped in `<g class="hwp-gen-chart" data-chart-type="…">`.
pub(crate) fn render_chart_svg(
    kind: &str,
    title: Option<&str>,
    categories: &[String],
    series: &[ChartSeries],
    w: f64,
    h: f64,
) -> String {
    let mut s = String::new();
    s.push_str(&format!(
        "<g class=\"hwp-gen-chart\" data-chart-type=\"{}\">",
        esc(kind)
    ));
    // A light card frame so the object reads as a chart even over a white page.
    s.push_str(&format!(
        "<rect x=\"0\" y=\"0\" width=\"{w:.1}\" height=\"{h:.1}\" fill=\"#FFFFFF\" \
         stroke=\"#D9D9D9\" stroke-width=\"1\"/>"
    ));
    // Optional title band across the top.
    let mut top = 10.0;
    if let Some(t) = title.map(str::trim).filter(|t| !t.is_empty()) {
        s.push_str(&text_el(w / 2.0, 18.0, t, 13.0, "middle", TEXT_COLOR, true));
        top = 30.0;
    }
    match kind {
        "pie" => render_pie(&mut s, categories, series, w, h, top),
        "line" => render_axes(&mut s, categories, series, w, h, top, true),
        // "bar" (default): grouped column chart.
        _ => render_axes(&mut s, categories, series, w, h, top, false),
    }
    s.push_str("</g>");
    s
}

/// BAR (grouped columns) and LINE share the same Cartesian frame: y grid + tick labels, the value/
/// category axes, category labels, and a series legend. `is_line` swaps the marks (bars ↔ polylines).
fn render_axes(
    s: &mut String,
    categories: &[String],
    series: &[ChartSeries],
    w: f64,
    h: f64,
    top: f64,
    is_line: bool,
) {
    let n_cat = categories.len().max(1);
    let n_ser = series.len().max(1);

    // Value domain across every series. Business charts anchor at 0; only drop the floor for negatives.
    let mut dmax = f64::MIN;
    let mut dmin = f64::MAX;
    for ser in series {
        for &v in &ser.values {
            if v.is_finite() {
                dmax = dmax.max(v);
                dmin = dmin.min(v);
            }
        }
    }
    if !dmax.is_finite() {
        dmax = 1.0;
    }
    if !dmin.is_finite() {
        dmin = 0.0;
    }
    let axis_max = nice_ceil(dmax.max(0.0));
    let axis_min = if dmin < 0.0 { -nice_ceil(-dmin) } else { 0.0 };
    let span = (axis_max - axis_min).max(1e-6);

    // Plot rectangle; the legend row sits at the very bottom, category labels just above it.
    let legend_h = 22.0;
    let plot_l = 46.0;
    let plot_r = w - 16.0;
    let plot_t = top + 8.0;
    let plot_b = h - legend_h - 22.0;
    let plot_w = (plot_r - plot_l).max(1.0);
    let plot_h = (plot_b - plot_t).max(1.0);

    let y_of = |v: f64| plot_b - (v - axis_min) / span * plot_h;

    // Horizontal gridlines + y tick labels (4 intervals → 5 labels).
    let ticks = 4;
    for i in 0..=ticks {
        let val = axis_min + span * (i as f64) / (ticks as f64);
        let y = y_of(val);
        s.push_str(&format!(
            "<line x1=\"{plot_l:.1}\" y1=\"{y:.1}\" x2=\"{plot_r:.1}\" y2=\"{y:.1}\" \
             stroke=\"{GRID_COLOR}\" stroke-width=\"1\"/>"
        ));
        s.push_str(&text_el(
            plot_l - 6.0,
            y + 3.0,
            &fmt_num(val),
            9.0,
            "end",
            TEXT_COLOR,
            false,
        ));
    }
    // Value axis (left) + category axis (at value 0).
    s.push_str(&format!(
        "<line x1=\"{plot_l:.1}\" y1=\"{plot_t:.1}\" x2=\"{plot_l:.1}\" y2=\"{plot_b:.1}\" \
         stroke=\"{AXIS_COLOR}\" stroke-width=\"1\"/>"
    ));
    let base_y = y_of(0.0).clamp(plot_t, plot_b);
    s.push_str(&format!(
        "<line x1=\"{plot_l:.1}\" y1=\"{base_y:.1}\" x2=\"{plot_r:.1}\" y2=\"{base_y:.1}\" \
         stroke=\"{AXIS_COLOR}\" stroke-width=\"1\"/>"
    ));

    let band = plot_w / n_cat as f64;

    if is_line {
        // One polyline per series, then point markers on top.
        for (si, ser) in series.iter().enumerate() {
            let color = PALETTE[si % PALETTE.len()];
            let mut pts = String::new();
            for (ci, &v) in ser.values.iter().enumerate() {
                let x = plot_l + band * (ci as f64 + 0.5);
                let y = y_of(if v.is_finite() { v } else { 0.0 });
                if ci > 0 {
                    pts.push(' ');
                }
                pts.push_str(&format!("{x:.1},{y:.1}"));
            }
            s.push_str(&format!(
                "<polyline points=\"{pts}\" fill=\"none\" stroke=\"{color}\" \
                 stroke-width=\"2\" stroke-linejoin=\"round\"/>"
            ));
            for (ci, &v) in ser.values.iter().enumerate() {
                let x = plot_l + band * (ci as f64 + 0.5);
                let y = y_of(if v.is_finite() { v } else { 0.0 });
                s.push_str(&format!(
                    "<circle cx=\"{x:.1}\" cy=\"{y:.1}\" r=\"2.5\" fill=\"{color}\"/>"
                ));
            }
        }
    } else {
        // Grouped bars: within each category band, `n_ser` side-by-side columns.
        let group_w = band * 0.72;
        let bar_w = (group_w / n_ser as f64).max(0.5);
        for (si, ser) in series.iter().enumerate() {
            let color = PALETTE[si % PALETTE.len()];
            for (ci, &v) in ser.values.iter().enumerate() {
                let v = if v.is_finite() { v } else { 0.0 };
                let x = plot_l + band * ci as f64 + (band - group_w) / 2.0 + bar_w * si as f64;
                let y = y_of(v);
                let (ry, rh) = if y <= base_y {
                    (y, base_y - y)
                } else {
                    (base_y, y - base_y)
                };
                s.push_str(&format!(
                    "<rect x=\"{x:.1}\" y=\"{ry:.1}\" width=\"{bar_w:.1}\" height=\"{rh:.1}\" \
                     fill=\"{color}\"/>"
                ));
                // Value label above (or below, for a negative) the bar when the column is wide enough.
                if bar_w >= 10.0 {
                    let ly = if v >= 0.0 { ry - 3.0 } else { ry + rh + 9.0 };
                    s.push_str(&text_el(
                        x + bar_w / 2.0,
                        ly,
                        &fmt_num(v),
                        8.0,
                        "middle",
                        TEXT_COLOR,
                        false,
                    ));
                }
            }
        }
    }

    // Category labels under each band.
    for (ci, cat) in categories.iter().enumerate() {
        let x = plot_l + band * (ci as f64 + 0.5);
        s.push_str(&text_el(
            x,
            plot_b + 13.0,
            &elide(cat, 12),
            9.0,
            "middle",
            TEXT_COLOR,
            false,
        ));
    }

    // Series legend at the bottom.
    render_legend(
        s,
        series.iter().map(|se| se.name.as_str()),
        w,
        h - legend_h + 4.0,
    );
}

/// PIE: slices of the FIRST series over the categories (single-series semantics), each an SVG arc path
/// with a `%` label, plus a category legend at the bottom.
fn render_pie(
    s: &mut String,
    categories: &[String],
    series: &[ChartSeries],
    w: f64,
    h: f64,
    top: f64,
) {
    // One value per category from the first series (missing → 0; negatives clamped — a pie needs ≥ 0).
    let values: Vec<f64> = match series.first() {
        Some(ser) => (0..categories.len())
            .map(|i| ser.values.get(i).copied().unwrap_or(0.0).max(0.0))
            .filter(|v| v.is_finite())
            .collect(),
        None => Vec::new(),
    };
    let total: f64 = values.iter().sum();

    let legend_h = 22.0;
    let cx = w / 2.0;
    let cy = top + (h - top - legend_h) / 2.0;
    let r = (w * 0.34).min((h - top - legend_h) / 2.0 - 6.0).max(10.0);

    if total <= 0.0 {
        // Degenerate data: an empty ring so the box still reads as a chart (never a wrong render).
        s.push_str(&format!(
            "<circle cx=\"{cx:.1}\" cy=\"{cy:.1}\" r=\"{r:.1}\" fill=\"none\" \
             stroke=\"{AXIS_COLOR}\" stroke-width=\"1\"/>"
        ));
    } else {
        let mut a0 = -std::f64::consts::FRAC_PI_2; // start at 12 o'clock
        for (i, &v) in values.iter().enumerate() {
            let frac = v / total;
            let a1 = a0 + frac * std::f64::consts::TAU;
            let color = PALETTE[i % PALETTE.len()];
            if (frac - 1.0).abs() < 1e-9 {
                // A single full-circle slice: the arc path degenerates at 2π, so draw a disc.
                s.push_str(&format!(
                    "<circle cx=\"{cx:.1}\" cy=\"{cy:.1}\" r=\"{r:.1}\" fill=\"{color}\"/>"
                ));
            } else {
                let (x0, y0) = (cx + r * a0.cos(), cy + r * a0.sin());
                let (x1, y1) = (cx + r * a1.cos(), cy + r * a1.sin());
                let large = if a1 - a0 > std::f64::consts::PI { 1 } else { 0 };
                s.push_str(&format!(
                    "<path d=\"M {cx:.1} {cy:.1} L {x0:.1} {y0:.1} \
                     A {r:.1} {r:.1} 0 {large} 1 {x1:.1} {y1:.1} Z\" \
                     fill=\"{color}\" stroke=\"#FFFFFF\" stroke-width=\"1\"/>"
                ));
            }
            // Percentage label near the slice mid-radius (skip slivers that can't fit text).
            if frac >= 0.05 {
                let am = (a0 + a1) / 2.0;
                let lr = r * 0.62;
                let lx = cx + lr * am.cos();
                let ly = cy + lr * am.sin() + 3.0;
                s.push_str(&text_el(
                    lx,
                    ly,
                    &format!("{:.0}%", frac * 100.0),
                    9.0,
                    "middle",
                    "#FFFFFF",
                    true,
                ));
            }
            a0 = a1;
        }
    }

    // Legend = category names (pie is single-series, so the categories carry the colors).
    render_legend(
        s,
        categories.iter().map(String::as_str),
        w,
        h - legend_h + 4.0,
    );
}

/// A centered legend row of `swatch + label` items at baseline `y`, colors cycling the palette.
fn render_legend<'a>(s: &mut String, labels: impl Iterator<Item = &'a str>, w: f64, y: f64) {
    let items: Vec<&str> = labels.collect();
    if items.is_empty() {
        return;
    }
    let sw = 10.0; // swatch side
    let gap = 5.0; // swatch→text gap
    let item_gap = 12.0; // between items
                         // Approximate label widths (ASCII ≈ 6px, wider glyphs like Hangul ≈ 10px) to center the row.
    let widths: Vec<f64> = items
        .iter()
        .map(|l| {
            sw + gap
                + l.chars()
                    .map(|c| if c.is_ascii() { 6.0 } else { 10.0 })
                    .sum::<f64>()
        })
        .collect();
    let total: f64 = widths.iter().sum::<f64>() + item_gap * (items.len().saturating_sub(1) as f64);
    let mut x = ((w - total) / 2.0).max(6.0);
    for (i, label) in items.iter().enumerate() {
        let color = PALETTE[i % PALETTE.len()];
        s.push_str(&format!(
            "<rect x=\"{x:.1}\" y=\"{ry:.1}\" width=\"{sw:.1}\" height=\"{sw:.1}\" fill=\"{color}\"/>",
            ry = y - sw + 2.0,
        ));
        s.push_str(&text_el(
            x + sw + gap,
            y,
            &elide(label, 16),
            9.0,
            "start",
            TEXT_COLOR,
            false,
        ));
        x += widths[i] + item_gap;
    }
}

/// The smallest "nice" number ≥ `v` (1/2/5 × 10ⁿ) for a readable axis maximum. `v ≤ 0` → 1.
fn nice_ceil(v: f64) -> f64 {
    if !(v.is_finite() && v > 0.0) {
        return 1.0;
    }
    let base = 10f64.powf(v.log10().floor());
    let n = v / base;
    let nice = if n <= 1.0 {
        1.0
    } else if n <= 2.0 {
        2.0
    } else if n <= 5.0 {
        5.0
    } else {
        10.0
    };
    nice * base
}

/// Format an axis/label number: integers show plain, fractions show up to 2 trimmed decimals.
fn fmt_num(v: f64) -> String {
    if v == 0.0 {
        return "0".to_string();
    }
    if (v - v.round()).abs() < 1e-6 {
        return format!("{}", v.round() as i64);
    }
    let s = format!("{v:.2}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// Truncate a label to `max` characters (Unicode scalar count), appending "…" when clipped.
fn elide(s: &str, max: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= max {
        return s.to_string();
    }
    let mut out: String = chars[..max.saturating_sub(1)].iter().collect();
    out.push('…');
    out
}

/// XML-escape text content for an SVG `<text>` / attribute.
fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// One `<text>` element (content is XML-escaped).
fn text_el(
    x: f64,
    y: f64,
    content: &str,
    size: f64,
    anchor: &str,
    fill: &str,
    bold: bool,
) -> String {
    let weight = if bold { " font-weight=\"bold\"" } else { "" };
    format!(
        "<text x=\"{x:.1}\" y=\"{y:.1}\" font-family=\"sans-serif\" font-size=\"{size:.0}\" \
         fill=\"{fill}\" text-anchor=\"{anchor}\"{weight}>{}</text>",
        esc(content)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn series(name: &str, values: &[f64]) -> ChartSeries {
        ChartSeries {
            name: name.to_string(),
            values: values.to_vec(),
        }
    }

    fn cats(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    // Every fragment must open + close its marker group so it nests cleanly inside the page <svg>.
    fn well_formed(svg: &str) {
        assert!(
            svg.starts_with("<g class=\"hwp-gen-chart\""),
            "opens the group: {svg}"
        );
        assert!(svg.trim_end().ends_with("</g>"), "closes the group: {svg}");
        assert_eq!(
            svg.matches("<g").count(),
            svg.matches("</g>").count(),
            "balanced <g>: {svg}"
        );
    }

    #[test]
    fn bar_chart_draws_bars_axes_labels_and_legend() {
        let c = cats(&["2024", "2025", "2026"]);
        let svg = render_chart_svg(
            "bar",
            Some("연도별 매출"),
            &c,
            &[series("매출", &[10.0, 18.0, 30.0])],
            400.0,
            260.0,
        );
        well_formed(&svg);
        assert!(svg.contains("data-chart-type=\"bar\""));
        assert!(svg.contains("<rect"), "bars are rects: {svg}");
        assert!(svg.contains("<line"), "axis/grid lines present");
        assert!(svg.contains("연도별 매출"), "title rendered");
        assert!(svg.contains("2025"), "category label rendered");
        assert!(svg.contains("매출"), "legend label rendered");
    }

    #[test]
    fn grouped_bar_cycles_colors_across_series() {
        let c = cats(&["Q1", "Q2"]);
        let svg = render_chart_svg(
            "bar",
            None,
            &c,
            &[series("A", &[1.0, 2.0]), series("B", &[3.0, 4.0])],
            400.0,
            260.0,
        );
        well_formed(&svg);
        assert!(
            svg.contains(PALETTE[0]) && svg.contains(PALETTE[1]),
            "two series → two palette colors: {svg}"
        );
    }

    #[test]
    fn pie_chart_draws_slices_and_percent_labels() {
        let c = cats(&["사과", "배", "감"]);
        let svg = render_chart_svg(
            "pie",
            Some("과일"),
            &c,
            &[series("수량", &[50.0, 30.0, 20.0])],
            400.0,
            260.0,
        );
        well_formed(&svg);
        assert!(svg.contains("data-chart-type=\"pie\""));
        assert!(svg.contains("<path"), "slices are arc paths: {svg}");
        assert!(svg.contains('%'), "percentage labels present: {svg}");
        assert!(svg.contains("사과"), "category legend rendered");
    }

    #[test]
    fn pie_single_full_slice_is_a_disc_not_a_degenerate_arc() {
        let c = cats(&["전체"]);
        let svg = render_chart_svg("pie", None, &c, &[series("v", &[42.0])], 300.0, 200.0);
        well_formed(&svg);
        assert!(
            svg.contains("<circle"),
            "a 100% slice draws as a full circle: {svg}"
        );
    }

    #[test]
    fn line_chart_draws_a_polyline_per_series() {
        let c = cats(&["Jan", "Feb", "Mar"]);
        let svg = render_chart_svg(
            "line",
            Some("추세"),
            &c,
            &[series("2025", &[5.0, 9.0, 7.0])],
            400.0,
            260.0,
        );
        well_formed(&svg);
        assert!(svg.contains("data-chart-type=\"line\""));
        assert!(
            svg.contains("<polyline"),
            "line series is a polyline: {svg}"
        );
        assert!(svg.contains("<circle"), "point markers present: {svg}");
    }

    #[test]
    fn escapes_untrusted_labels() {
        let c = cats(&["<b>&\"x\""]);
        let svg = render_chart_svg(
            "bar",
            Some("<t&t>"),
            &c,
            &[series("s<&>", &[1.0])],
            400.0,
            260.0,
        );
        // The raw injection characters never appear unescaped in the fragment.
        assert!(!svg.contains("<b>"), "category label is escaped: {svg}");
        assert!(
            svg.contains("&lt;b&gt;") && svg.contains("&amp;"),
            "escapes applied: {svg}"
        );
        assert!(svg.contains("&lt;t&amp;t&gt;"), "title is escaped: {svg}");
    }

    #[test]
    fn empty_pie_still_produces_a_readable_box() {
        let c = cats(&["a", "b"]);
        let svg = render_chart_svg("pie", None, &c, &[series("z", &[0.0, 0.0])], 400.0, 260.0);
        well_formed(&svg);
        assert!(
            svg.contains("<circle"),
            "zero-total pie draws an empty ring: {svg}"
        );
    }

    #[test]
    fn nice_ceil_rounds_to_readable_maxima() {
        assert_eq!(nice_ceil(30.0), 50.0);
        assert_eq!(nice_ceil(18.0), 20.0);
        assert_eq!(nice_ceil(9.0), 10.0);
        assert_eq!(nice_ceil(0.0), 1.0);
    }
}
