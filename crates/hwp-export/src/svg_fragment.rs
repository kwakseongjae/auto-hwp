//! Strict SVG-fragment parser for equation/chart PDF replay.
//!
//! This is deliberately not a general SVG implementation. The only accepted input is the bounded,
//! resource-free primitive subset emitted by auto-hwp/rhwp's equation and chart renderers. Unknown
//! elements or attributes are rejected instead of being silently ignored.

use std::collections::BTreeMap;

use hwp_model::types::Color;
use kurbo::{Arc, Point as KurboPoint, SvgArc, Vec2};
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use svgtypes::{PathParser, PathSegment};

const MAX_BYTES: usize = 1024 * 1024;
const MAX_ELEMENTS: usize = 10_000;
const MAX_DEPTH: usize = 32;
const MAX_ATTRS: usize = 32;
const MAX_PATH_COMMANDS: usize = 100_000;
const MAX_TEXT_BYTES: usize = 256 * 1024;
const MAX_ABS_COORD: f64 = 10_000_000.0;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Fragment {
    pub primitives: Vec<Primitive>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Primitive {
    Rect {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        style: Style,
    },
    Line {
        x1: f64,
        y1: f64,
        x2: f64,
        y2: f64,
        style: Style,
    },
    Path {
        commands: Vec<PathCommand>,
        style: Style,
    },
    Circle {
        cx: f64,
        cy: f64,
        rx: f64,
        ry: f64,
        style: Style,
    },
    Text(TextPrimitive),
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct TextPrimitive {
    pub x: f64,
    pub y: f64,
    pub size: f64,
    pub text: String,
    pub anchor: TextAnchor,
    pub dominant_baseline: DominantBaseline,
    pub bold: bool,
    pub italic: bool,
    pub family: Option<String>,
    pub style: Style,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TextAnchor {
    Start,
    Middle,
    End,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DominantBaseline {
    Auto,
    Central,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Style {
    pub fill: Option<Color>,
    pub stroke: Option<Color>,
    pub stroke_width: f64,
    pub dash: Option<Vec<f64>>,
    pub line_cap: LineCap,
    pub line_join: LineJoin,
    pub opacity: f32,
}

impl Default for Style {
    fn default() -> Self {
        Self {
            // SVG's initial fill is black and initial stroke is none.
            fill: Some(Color {
                r: 0,
                g: 0,
                b: 0,
                a: 255,
            }),
            stroke: None,
            stroke_width: 1.0,
            dash: None,
            line_cap: LineCap::Butt,
            line_join: LineJoin::Miter,
            opacity: 1.0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LineCap {
    Butt,
    Round,
    Square,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LineJoin {
    Miter,
    Round,
    Bevel,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum PathCommand {
    Move(f64, f64),
    Line(f64, f64),
    Quad(f64, f64, f64, f64),
    Cubic(f64, f64, f64, f64, f64, f64),
    Close,
}

#[derive(Clone, Debug)]
struct PendingText {
    primitive: TextPrimitive,
}

/// Parse the deliberately small SVG subset emitted by our equation/chart renderers.
pub(crate) fn parse(svg: &str) -> Result<Fragment, String> {
    if svg.len() > MAX_BYTES {
        return Err("svg.limit.bytes".into());
    }
    if svg.contains("<!") || svg.contains("<?") {
        return Err("svg.security.declaration".into());
    }

    // Equation/chart payloads are SVG fragments, so give the XML reader one artificial root.
    let wrapped = format!("<fragment>{svg}</fragment>");
    let mut reader = Reader::from_str(&wrapped);
    reader.config_mut().trim_text(false);

    let mut primitives = Vec::new();
    let mut styles = vec![Style::default()];
    let mut elements = 0usize;
    let mut pending_text: Option<PendingText> = None;

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                elements = elements.checked_add(1).ok_or("svg.limit.elements")?;
                if elements > MAX_ELEMENTS || styles.len() >= MAX_DEPTH {
                    return Err("svg.limit.elements_or_depth".into());
                }
                let name = local_name(e.name().as_ref())?;
                if name == "fragment" {
                    continue;
                }
                if pending_text.is_some() {
                    return Err("svg.text.nested_element".into());
                }
                let attrs = attrs(&e, &reader)?;
                let parent = styles.last().cloned().unwrap_or_default();
                match name.as_str() {
                    "g" => {
                        styles.push(parse_style(&attrs, &parent, &["class", "data-chart-type"])?)
                    }
                    "text" => {
                        let style = parse_style(
                            &attrs,
                            &parent,
                            &[
                                "x",
                                "y",
                                "font-family",
                                "font-size",
                                "font-weight",
                                "font-style",
                                "text-anchor",
                                "dominant-baseline",
                                "class",
                            ],
                        )?;
                        let primitive = parse_text_attrs(&attrs, style)?;
                        styles.push(primitive.style.clone());
                        pending_text = Some(PendingText { primitive });
                    }
                    _ => return Err(format!("svg.element.unsupported:{name}")),
                }
            }
            Ok(Event::Empty(e)) => {
                elements = elements.checked_add(1).ok_or("svg.limit.elements")?;
                if elements > MAX_ELEMENTS || styles.len() >= MAX_DEPTH {
                    return Err("svg.limit.elements_or_depth".into());
                }
                if pending_text.is_some() {
                    return Err("svg.text.nested_element".into());
                }
                let name = local_name(e.name().as_ref())?;
                let attrs = attrs(&e, &reader)?;
                let parent = styles.last().cloned().unwrap_or_default();
                parse_empty(&name, &attrs, &parent, &mut primitives)?;
            }
            Ok(Event::Text(t)) => {
                let value = t.unescape().map_err(|_| "svg.xml.text")?;
                if let Some(pending) = pending_text.as_mut() {
                    if pending.primitive.text.len() + value.len() > MAX_TEXT_BYTES {
                        return Err("svg.limit.text".into());
                    }
                    pending.primitive.text.push_str(&value);
                } else if !value.trim().is_empty() {
                    return Err("svg.text.outside_text".into());
                }
            }
            Ok(Event::End(e)) => {
                let name = local_name(e.name().as_ref())?;
                match name.as_str() {
                    "text" => {
                        let pending = pending_text.take().ok_or("svg.text.unbalanced")?;
                        styles.pop().ok_or("svg.depth.unbalanced")?;
                        primitives.push(Primitive::Text(pending.primitive));
                    }
                    "g" => {
                        styles.pop().ok_or("svg.depth.unbalanced")?;
                    }
                    "fragment" => {}
                    _ => return Err(format!("svg.element.unsupported:{name}")),
                }
            }
            Ok(Event::Comment(_)) => {}
            Ok(Event::Eof) => break,
            Ok(Event::Decl(_) | Event::PI(_) | Event::DocType(_) | Event::CData(_)) => {
                return Err("svg.security.declaration".into());
            }
            Err(_) => return Err("svg.xml.malformed".into()),
        }
    }

    if pending_text.is_some() || styles.len() != 1 {
        return Err("svg.depth.unbalanced".into());
    }
    if primitives.is_empty() {
        return Err("svg.fragment.empty".into());
    }
    Ok(Fragment { primitives })
}

fn local_name(raw: &[u8]) -> Result<String, String> {
    let s = std::str::from_utf8(raw).map_err(|_| "svg.xml.element_name")?;
    if s.contains(':') {
        return Err("svg.security.namespace".into());
    }
    Ok(s.to_ascii_lowercase())
}

fn attrs(e: &BytesStart<'_>, reader: &Reader<&[u8]>) -> Result<BTreeMap<String, String>, String> {
    let mut out = BTreeMap::new();
    for (idx, attr) in e.attributes().enumerate() {
        if idx >= MAX_ATTRS {
            return Err("svg.limit.attributes".into());
        }
        let attr = attr.map_err(|_| "svg.xml.attribute")?;
        let key = std::str::from_utf8(attr.key.as_ref())
            .map_err(|_| "svg.xml.attribute_name")?
            .to_ascii_lowercase();
        if key.contains(':') || key.starts_with("on") || matches!(key.as_str(), "href" | "style") {
            return Err(format!("svg.security.attribute:{key}"));
        }
        let value = attr
            .decode_and_unescape_value(reader.decoder())
            .map_err(|_| "svg.xml.attribute_value")?
            .into_owned();
        if out.insert(key.clone(), value).is_some() {
            return Err(format!("svg.attribute.duplicate:{key}"));
        }
    }
    Ok(out)
}

fn parse_empty(
    name: &str,
    attrs: &BTreeMap<String, String>,
    parent: &Style,
    out: &mut Vec<Primitive>,
) -> Result<(), String> {
    match name {
        "rect" => {
            let style = parse_style(attrs, parent, &["x", "y", "width", "height", "class"])?;
            let (x, y) = (number(attrs, "x", 0.0)?, number(attrs, "y", 0.0)?);
            let (w, h) = (
                required_number(attrs, "width")?,
                required_number(attrs, "height")?,
            );
            nonnegative(w, "width")?;
            nonnegative(h, "height")?;
            out.push(Primitive::Rect { x, y, w, h, style });
        }
        "line" => {
            let style = parse_style(attrs, parent, &["x1", "y1", "x2", "y2", "class"])?;
            out.push(Primitive::Line {
                x1: number(attrs, "x1", 0.0)?,
                y1: number(attrs, "y1", 0.0)?,
                x2: number(attrs, "x2", 0.0)?,
                y2: number(attrs, "y2", 0.0)?,
                style,
            });
        }
        "circle" | "ellipse" => {
            let extra = if name == "circle" {
                vec!["cx", "cy", "r", "class"]
            } else {
                vec!["cx", "cy", "rx", "ry", "class"]
            };
            let style = parse_style(attrs, parent, &extra)?;
            let cx = number(attrs, "cx", 0.0)?;
            let cy = number(attrs, "cy", 0.0)?;
            let (rx, ry) = if name == "circle" {
                let r = required_number(attrs, "r")?;
                (r, r)
            } else {
                (required_number(attrs, "rx")?, required_number(attrs, "ry")?)
            };
            nonnegative(rx, "radius")?;
            nonnegative(ry, "radius")?;
            out.push(Primitive::Circle {
                cx,
                cy,
                rx,
                ry,
                style,
            });
        }
        "path" => {
            let style = parse_style(attrs, parent, &["d", "class"])?;
            let d = attrs.get("d").ok_or("svg.attribute.missing:d")?;
            out.push(Primitive::Path {
                commands: parse_path(d)?,
                style,
            });
        }
        "polyline" | "polygon" => {
            let style = parse_style(attrs, parent, &["points", "class"])?;
            let points = attrs.get("points").ok_or("svg.attribute.missing:points")?;
            let mut commands = parse_points(points)?;
            if name == "polygon" {
                commands.push(PathCommand::Close);
            }
            out.push(Primitive::Path { commands, style });
        }
        // Empty groups have no visual content; accepting them is harmless and still resource-free.
        "g" => {
            parse_style(attrs, parent, &["class", "data-chart-type"])?;
        }
        "text" => {
            let style = parse_style(
                attrs,
                parent,
                &[
                    "x",
                    "y",
                    "font-family",
                    "font-size",
                    "font-weight",
                    "font-style",
                    "text-anchor",
                    "dominant-baseline",
                    "class",
                ],
            )?;
            out.push(Primitive::Text(parse_text_attrs(attrs, style)?));
        }
        _ => return Err(format!("svg.element.unsupported:{name}")),
    }
    Ok(())
}

fn parse_style(
    attrs: &BTreeMap<String, String>,
    parent: &Style,
    extras: &[&str],
) -> Result<Style, String> {
    const STYLE_ATTRS: &[&str] = &[
        "fill",
        "stroke",
        "stroke-width",
        "stroke-dasharray",
        "stroke-linecap",
        "stroke-linejoin",
        "opacity",
    ];
    for key in attrs.keys() {
        if !STYLE_ATTRS.contains(&key.as_str()) && !extras.contains(&key.as_str()) {
            return Err(format!("svg.attribute.unsupported:{key}"));
        }
    }
    let mut out = parent.clone();
    if let Some(value) = attrs.get("fill") {
        out.fill = paint(value)?;
    }
    if let Some(value) = attrs.get("stroke") {
        out.stroke = paint(value)?;
    }
    if let Some(value) = attrs.get("stroke-width") {
        out.stroke_width = finite(value, "stroke-width")?;
        nonnegative(out.stroke_width, "stroke-width")?;
    }
    if let Some(value) = attrs.get("stroke-dasharray") {
        out.dash = if value.trim().eq_ignore_ascii_case("none") {
            None
        } else {
            let values = number_list(value)?;
            if values.is_empty()
                || values.len() > 64
                || values.iter().any(|v| *v < 0.0)
                || values.iter().all(|v| *v == 0.0)
            {
                return Err("svg.attribute.invalid:stroke-dasharray".into());
            }
            Some(values)
        };
    }
    if let Some(value) = attrs.get("stroke-linecap") {
        out.line_cap = match value.as_str() {
            "butt" => LineCap::Butt,
            "round" => LineCap::Round,
            "square" => LineCap::Square,
            _ => return Err("svg.attribute.invalid:stroke-linecap".into()),
        };
    }
    if let Some(value) = attrs.get("stroke-linejoin") {
        out.line_join = match value.as_str() {
            "miter" => LineJoin::Miter,
            "round" => LineJoin::Round,
            "bevel" => LineJoin::Bevel,
            _ => return Err("svg.attribute.invalid:stroke-linejoin".into()),
        };
    }
    if let Some(value) = attrs.get("opacity") {
        let opacity = finite(value, "opacity")?;
        if !(0.0..=1.0).contains(&opacity) {
            return Err("svg.attribute.invalid:opacity".into());
        }
        out.opacity *= opacity as f32;
    }
    Ok(out)
}

fn parse_text_attrs(
    attrs: &BTreeMap<String, String>,
    style: Style,
) -> Result<TextPrimitive, String> {
    if style.stroke.is_some() {
        return Err("svg.text.stroke_unsupported".into());
    }
    let anchor = match attrs
        .get("text-anchor")
        .map(String::as_str)
        .unwrap_or("start")
    {
        "start" => TextAnchor::Start,
        "middle" => TextAnchor::Middle,
        "end" => TextAnchor::End,
        _ => return Err("svg.attribute.invalid:text-anchor".into()),
    };
    let dominant_baseline = match attrs
        .get("dominant-baseline")
        .map(String::as_str)
        .unwrap_or("auto")
    {
        "auto" | "alphabetic" => DominantBaseline::Auto,
        "central" | "middle" => DominantBaseline::Central,
        _ => return Err("svg.attribute.invalid:dominant-baseline".into()),
    };
    let weight = attrs
        .get("font-weight")
        .map(String::as_str)
        .unwrap_or("400");
    let bold = match weight {
        "bold" | "600" | "700" | "800" | "900" => true,
        "normal" | "100" | "200" | "300" | "400" | "500" => false,
        _ => return Err("svg.attribute.invalid:font-weight".into()),
    };
    let italic = match attrs
        .get("font-style")
        .map(String::as_str)
        .unwrap_or("normal")
    {
        "normal" => false,
        "italic" | "oblique" => true,
        _ => return Err("svg.attribute.invalid:font-style".into()),
    };
    let size = number(attrs, "font-size", 16.0)?;
    if size <= 0.0 {
        return Err("svg.attribute.invalid:font-size".into());
    }
    Ok(TextPrimitive {
        x: number(attrs, "x", 0.0)?,
        y: number(attrs, "y", 0.0)?,
        size,
        text: String::new(),
        anchor,
        dominant_baseline,
        bold,
        italic,
        family: attrs.get("font-family").cloned(),
        style,
    })
}

fn paint(value: &str) -> Result<Option<Color>, String> {
    let value = value.trim().to_ascii_lowercase();
    if value == "none" || value == "transparent" {
        return Ok(None);
    }
    let (r, g, b) = match value.as_str() {
        "black" => (0, 0, 0),
        "white" => (255, 255, 255),
        "red" => (255, 0, 0),
        "green" => (0, 128, 0),
        "blue" => (0, 0, 255),
        "gray" | "grey" => (128, 128, 128),
        _ if value.starts_with('#') => parse_hex_color(&value)?,
        _ => return Err("svg.paint.unsupported".into()),
    };
    Ok(Some(Color { r, g, b, a: 255 }))
}

fn parse_hex_color(value: &str) -> Result<(u8, u8, u8), String> {
    let h = value.trim_start_matches('#');
    match h.len() {
        3 => {
            let mut it = h.chars();
            let r = hex(it.next().unwrap())?;
            let g = hex(it.next().unwrap())?;
            let b = hex(it.next().unwrap())?;
            Ok((r * 17, g * 17, b * 17))
        }
        6 => Ok((
            u8::from_str_radix(&h[0..2], 16).map_err(|_| "svg.paint.invalid")?,
            u8::from_str_radix(&h[2..4], 16).map_err(|_| "svg.paint.invalid")?,
            u8::from_str_radix(&h[4..6], 16).map_err(|_| "svg.paint.invalid")?,
        )),
        _ => Err("svg.paint.invalid".into()),
    }
}

fn hex(c: char) -> Result<u8, String> {
    c.to_digit(16)
        .map(|v| v as u8)
        .ok_or_else(|| "svg.paint.invalid".into())
}

fn required_number(attrs: &BTreeMap<String, String>, key: &str) -> Result<f64, String> {
    let value = attrs
        .get(key)
        .ok_or_else(|| format!("svg.attribute.missing:{key}"))?;
    finite(value, key)
}

fn number(attrs: &BTreeMap<String, String>, key: &str, default: f64) -> Result<f64, String> {
    attrs
        .get(key)
        .map_or(Ok(default), |value| finite(value, key))
}

fn finite(value: &str, key: &str) -> Result<f64, String> {
    let parsed = value
        .trim()
        .parse::<f64>()
        .map_err(|_| format!("svg.attribute.invalid:{key}"))?;
    if !parsed.is_finite() || parsed.abs() > MAX_ABS_COORD {
        return Err(format!("svg.attribute.out_of_range:{key}"));
    }
    Ok(parsed)
}

fn nonnegative(value: f64, key: &str) -> Result<(), String> {
    if value < 0.0 {
        Err(format!("svg.attribute.negative:{key}"))
    } else {
        Ok(())
    }
}

fn number_list(value: &str) -> Result<Vec<f64>, String> {
    value
        .split(|c: char| c == ',' || c.is_ascii_whitespace())
        .filter(|s| !s.is_empty())
        .map(|s| finite(s, "number-list"))
        .collect()
}

fn parse_points(value: &str) -> Result<Vec<PathCommand>, String> {
    let values = number_list(value)?;
    if values.len() < 2 || values.len() % 2 != 0 || values.len() / 2 > MAX_PATH_COMMANDS {
        return Err("svg.path.invalid_points".into());
    }
    let mut out = Vec::with_capacity(values.len() / 2);
    for (idx, pair) in values.chunks_exact(2).enumerate() {
        out.push(if idx == 0 {
            PathCommand::Move(pair[0], pair[1])
        } else {
            PathCommand::Line(pair[0], pair[1])
        });
    }
    Ok(out)
}

fn parse_path(d: &str) -> Result<Vec<PathCommand>, String> {
    if d.len() > MAX_BYTES {
        return Err("svg.limit.path_bytes".into());
    }
    let mut out = Vec::new();
    let (mut x, mut y) = (0.0, 0.0);
    let (mut sx, mut sy) = (0.0, 0.0);
    let mut last_cubic: Option<(f64, f64)> = None;
    let mut last_quad: Option<(f64, f64)> = None;

    for segment in PathParser::from(d) {
        if out.len() >= MAX_PATH_COMMANDS {
            return Err("svg.limit.path_commands".into());
        }
        let segment = segment.map_err(|_| "svg.path.malformed")?;
        match segment {
            PathSegment::MoveTo { abs, x: nx, y: ny } => {
                (x, y) = absolute(abs, x, y, nx, ny)?;
                (sx, sy) = (x, y);
                out.push(PathCommand::Move(x, y));
                last_cubic = None;
                last_quad = None;
            }
            PathSegment::LineTo { abs, x: nx, y: ny } => {
                (x, y) = absolute(abs, x, y, nx, ny)?;
                out.push(PathCommand::Line(x, y));
                last_cubic = None;
                last_quad = None;
            }
            PathSegment::HorizontalLineTo { abs, x: nx } => {
                x = checked(if abs { nx } else { x + nx })?;
                out.push(PathCommand::Line(x, y));
                last_cubic = None;
                last_quad = None;
            }
            PathSegment::VerticalLineTo { abs, y: ny } => {
                y = checked(if abs { ny } else { y + ny })?;
                out.push(PathCommand::Line(x, y));
                last_cubic = None;
                last_quad = None;
            }
            PathSegment::CurveTo {
                abs,
                x1,
                y1,
                x2,
                y2,
                x: nx,
                y: ny,
            } => {
                let (c1x, c1y) = absolute(abs, x, y, x1, y1)?;
                let (c2x, c2y) = absolute(abs, x, y, x2, y2)?;
                let (ex, ey) = absolute(abs, x, y, nx, ny)?;
                out.push(PathCommand::Cubic(c1x, c1y, c2x, c2y, ex, ey));
                (x, y) = (ex, ey);
                last_cubic = Some((c2x, c2y));
                last_quad = None;
            }
            PathSegment::SmoothCurveTo {
                abs,
                x2,
                y2,
                x: nx,
                y: ny,
            } => {
                let (c1x, c1y) = last_cubic.map_or((x, y), |(cx, cy)| (2.0 * x - cx, 2.0 * y - cy));
                let (c2x, c2y) = absolute(abs, x, y, x2, y2)?;
                let (ex, ey) = absolute(abs, x, y, nx, ny)?;
                out.push(PathCommand::Cubic(c1x, c1y, c2x, c2y, ex, ey));
                (x, y) = (ex, ey);
                last_cubic = Some((c2x, c2y));
                last_quad = None;
            }
            PathSegment::Quadratic {
                abs,
                x1,
                y1,
                x: nx,
                y: ny,
            } => {
                let (cx, cy) = absolute(abs, x, y, x1, y1)?;
                let (ex, ey) = absolute(abs, x, y, nx, ny)?;
                out.push(PathCommand::Quad(cx, cy, ex, ey));
                (x, y) = (ex, ey);
                last_quad = Some((cx, cy));
                last_cubic = None;
            }
            PathSegment::SmoothQuadratic { abs, x: nx, y: ny } => {
                let (cx, cy) = last_quad.map_or((x, y), |(qx, qy)| (2.0 * x - qx, 2.0 * y - qy));
                let (ex, ey) = absolute(abs, x, y, nx, ny)?;
                out.push(PathCommand::Quad(cx, cy, ex, ey));
                (x, y) = (ex, ey);
                last_quad = Some((cx, cy));
                last_cubic = None;
            }
            PathSegment::EllipticalArc {
                abs,
                rx,
                ry,
                x_axis_rotation,
                large_arc,
                sweep,
                x: nx,
                y: ny,
            } => {
                let (ex, ey) = absolute(abs, x, y, nx, ny)?;
                let rx = checked(rx.abs())?;
                let ry = checked(ry.abs())?;
                if rx == 0.0 || ry == 0.0 || (x == ex && y == ey) {
                    out.push(PathCommand::Line(ex, ey));
                } else {
                    let svg_arc = SvgArc {
                        from: KurboPoint::new(x, y),
                        to: KurboPoint::new(ex, ey),
                        radii: Vec2::new(rx, ry),
                        x_rotation: x_axis_rotation.to_radians(),
                        large_arc,
                        sweep,
                    };
                    if let Some(arc) = Arc::from_svg_arc(&svg_arc) {
                        arc.to_cubic_beziers(0.1, |p1, p2, p3| {
                            out.push(PathCommand::Cubic(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y));
                        });
                        if out.len() > MAX_PATH_COMMANDS {
                            return Err("svg.limit.path_commands".into());
                        }
                    } else {
                        out.push(PathCommand::Line(ex, ey));
                    }
                }
                (x, y) = (ex, ey);
                last_cubic = None;
                last_quad = None;
            }
            PathSegment::ClosePath { .. } => {
                out.push(PathCommand::Close);
                (x, y) = (sx, sy);
                last_cubic = None;
                last_quad = None;
            }
        }
    }
    if out.is_empty() {
        return Err("svg.path.empty".into());
    }
    Ok(out)
}

fn absolute(abs: bool, x: f64, y: f64, nx: f64, ny: f64) -> Result<(f64, f64), String> {
    if abs {
        Ok((checked(nx)?, checked(ny)?))
    } else {
        Ok((checked(x + nx)?, checked(y + ny)?))
    }
}

fn checked(value: f64) -> Result<f64, String> {
    if value.is_finite() && value.abs() <= MAX_ABS_COORD {
        Ok(value)
    } else {
        Err("svg.path.out_of_range".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_equation_and_chart_primitives() {
        let equation = r##"<g class="eq"><text x="2" y="12" font-size="12" fill="#123">x</text><line x1="0" y1="15" x2="20" y2="15" stroke="#000" stroke-width="1"/><path d="M0 0 Q5 10 10 0" fill="none" stroke="#000"/><circle cx="3" cy="3" r="2" fill="#f00"/></g>"##;
        assert_eq!(parse(equation).unwrap().primitives.len(), 4);

        let chart = r##"<g class="hwp-gen-chart" data-chart-type="pie"><rect x="0" y="0" width="20" height="20" fill="#fff"/><polyline points="0,10 5,2 10,8" fill="none" stroke="#00f" stroke-linejoin="round"/><path d="M10,10 L10,1 A9,9 0 0 1 19,10 Z" fill="#0f0"/></g>"##;
        let parsed = parse(chart).unwrap();
        assert_eq!(parsed.primitives.len(), 3);
        assert!(matches!(parsed.primitives[2], Primitive::Path { .. }));
    }

    #[test]
    fn accepts_the_actual_vendored_rhwp_ooxml_chart_output() {
        const BAR_XML: &str = r#"<?xml version="1.0"?>
<c:chartSpace xmlns:c="x" xmlns:a="y"><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>매출</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:barChart><c:barDir val="col"/><c:ser><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>2023</c:v></c:pt></c:strCache></c:strRef></c:tx><c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>1월</c:v></c:pt><c:pt idx="1"><c:v>2월</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>20</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>"#;
        let chart =
            rhwp::ooxml_chart::OoxmlChart::parse(BAR_XML.as_bytes()).expect("rhwp chart parses");
        let svg = chart.render_svg(0.0, 0.0, 320.0, 180.0);
        assert!(svg.contains("hwp-ooxml-chart"));
        let fragment =
            parse(&svg).expect("every primitive emitted by rhwp belongs to the bounded subset");
        assert!(!fragment.primitives.is_empty());
    }

    #[test]
    fn rejects_active_or_external_svg_features() {
        for bad in [
            "<script>alert(1)</script>",
            "<foreignObject><div>x</div></foreignObject>",
            "<image href=\"https://example.test/a.png\"/>",
            "<use href=\"#x\"/>",
            "<rect onclick=\"x()\" width=\"1\" height=\"1\"/>",
            "<rect style=\"fill:red\" width=\"1\" height=\"1\"/>",
            "<g transform=\"translate(1)\"><rect width=\"1\" height=\"1\"/></g>",
            "<!DOCTYPE svg><rect width=\"1\" height=\"1\"/>",
        ] {
            assert!(parse(bad).is_err(), "must reject {bad}");
        }
    }

    #[test]
    fn rejects_limits_nonfinite_and_unknown_attributes() {
        assert!(parse("<rect x=\"NaN\" width=\"1\" height=\"1\"/>").is_err());
        assert!(parse("<rect mystery=\"1\" width=\"1\" height=\"1\"/>").is_err());
        assert!(parse(&"x".repeat(MAX_BYTES + 1)).is_err());
        let deep = format!(
            "{}<rect width=\"1\" height=\"1\"/>{}",
            "<g>".repeat(MAX_DEPTH + 1),
            "</g>".repeat(MAX_DEPTH + 1)
        );
        assert!(parse(&deep).is_err());
    }
}
