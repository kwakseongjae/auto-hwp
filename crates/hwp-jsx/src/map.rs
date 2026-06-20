//! `CharShape`/`ParaShape` ↔ CSS declaration mapping (§3.4).
//!
//! Pool index `i` → class `.cN` / `.pN` (dedup inherited from `intern_*`). The
//! mapping is an **exact inverse**: the common subset (`font-size`, `font-weight`,
//! `color`, `text-align`, …) is emitted as human-readable, AI-routable CSS props,
//! and the FULL typed shape is additionally carried in a lossless `--shape` custom
//! property (serde_json of the shape) so `decls_to_char_shape(char_shape_to_decls(s)) == s`
//! holds exhaustively — no field can silently fall out of the projection.
//!
//! The human-readable props are what the CSS AI op (`CssSetDecl`) and the future
//! layout engine consume; `--shape` is the authoritative round-trip carrier and is
//! re-synced from the human-readable props on parse so an AI edit to `font-size`
//! actually changes the reparsed `CharShape::height`.

use hwp_model::style::{CharShape, HorizontalAlign, ParaShape};
use std::collections::BTreeMap;

/// The custom property holding the full serde_json shape (lossless carrier).
const SHAPE_BLOB: &str = "--shape";

pub fn char_class_name(i: usize) -> String {
    format!("c{i}")
}
pub fn para_class_name(i: usize) -> String {
    format!("p{i}")
}

/// `cN` → N (char-shape pool index). None if not a char class.
pub fn char_class_index(name: &str) -> Option<usize> {
    name.strip_prefix('c').and_then(|n| n.parse().ok())
}
pub fn para_class_index(name: &str) -> Option<usize> {
    name.strip_prefix('p').and_then(|n| n.parse().ok())
}

// ---- CharShape ----

pub fn char_shape_to_decls(s: &CharShape) -> BTreeMap<String, String> {
    let mut d = BTreeMap::new();
    if s.height != 0 {
        // HWPUNIT pt*100 → pt
        d.insert("font-size".into(), format_pt(s.height));
    }
    if s.bold {
        d.insert("font-weight".into(), "bold".into());
    }
    if s.italic {
        d.insert("font-style".into(), "italic".into());
    }
    if s.underline || s.strikeout {
        let mut parts = Vec::new();
        if s.underline {
            parts.push("underline");
        }
        if s.strikeout {
            parts.push("line-through");
        }
        d.insert("text-decoration".into(), parts.join(" "));
    }
    if s.text_color != Default::default() {
        d.insert("color".into(), s.text_color.to_hex().to_ascii_lowercase());
    }
    if let Some(f) = &s.font_family {
        d.insert("font-family".into(), f.clone());
    }
    // Lossless carrier — authoritative for the inverse.
    d.insert(SHAPE_BLOB.into(), serde_json_shape(s));
    d
}

pub fn decls_to_char_shape(d: &BTreeMap<String, String>) -> CharShape {
    // Start from the lossless blob (authoritative), then overlay the human-readable
    // props so an AI edit to a CSS prop (e.g. font-size) wins.
    let mut s: CharShape = d
        .get(SHAPE_BLOB)
        .and_then(|b| serde_json::from_str::<CharShapeSerde>(b).ok())
        .map(Into::into)
        .unwrap_or_default();
    if let Some(v) = d.get("font-size") {
        s.height = parse_pt(v);
    }
    if let Some(v) = d.get("font-weight") {
        s.bold = v.trim() == "bold" || v.trim() == "700";
    }
    if let Some(v) = d.get("font-style") {
        s.italic = v.trim() == "italic";
    }
    if let Some(v) = d.get("text-decoration") {
        s.underline = v.contains("underline");
        s.strikeout = v.contains("line-through");
    }
    if let Some(v) = d.get("color") {
        if let Some(c) = hwp_model::types::Color::from_hex(v) {
            s.text_color = c;
        }
    }
    if let Some(v) = d.get("font-family") {
        s.font_family = Some(v.clone());
    }
    s
}

// ---- ParaShape ----

pub fn para_shape_to_decls(s: &ParaShape) -> BTreeMap<String, String> {
    let mut d = BTreeMap::new();
    let align = match s.align {
        HorizontalAlign::Justify => None, // default
        HorizontalAlign::Left => Some("left"),
        HorizontalAlign::Right => Some("right"),
        HorizontalAlign::Center => Some("center"),
        HorizontalAlign::Distribute => Some("justify"), // + data-attr upstream
        HorizontalAlign::DistributeSpace => Some("justify"),
    };
    if let Some(a) = align {
        d.insert("text-align".into(), a.into());
    }
    if s.left_margin != 0 {
        d.insert("margin-left".into(), format_pt(s.left_margin));
    }
    if s.right_margin != 0 {
        d.insert("margin-right".into(), format_pt(s.right_margin));
    }
    if s.indent != 0 {
        d.insert("text-indent".into(), format_pt(s.indent));
    }
    if s.space_before != 0 {
        d.insert("margin-top".into(), format_pt(s.space_before));
    }
    if s.space_after != 0 {
        d.insert("margin-bottom".into(), format_pt(s.space_after));
    }
    if s.page_break_before {
        d.insert("page-break-before".into(), "always".into());
    }
    d.insert(SHAPE_BLOB.into(), serde_json_para(s));
    d
}

pub fn decls_to_para_shape(d: &BTreeMap<String, String>) -> ParaShape {
    let mut s: ParaShape = d
        .get(SHAPE_BLOB)
        .and_then(|b| serde_json::from_str::<ParaShapeSerde>(b).ok())
        .map(Into::into)
        .unwrap_or_default();
    if let Some(v) = d.get("text-align") {
        s.align = match v.trim() {
            "left" => HorizontalAlign::Left,
            "right" => HorizontalAlign::Right,
            "center" => HorizontalAlign::Center,
            // justify maps back to the blob's value (Justify/Distribute/DistributeSpace)
            _ => s.align,
        };
    }
    if let Some(v) = d.get("margin-left") {
        s.left_margin = parse_pt(v);
    }
    if let Some(v) = d.get("margin-right") {
        s.right_margin = parse_pt(v);
    }
    if let Some(v) = d.get("text-indent") {
        s.indent = parse_pt(v);
    }
    if let Some(v) = d.get("margin-top") {
        s.space_before = parse_pt(v);
    }
    if let Some(v) = d.get("margin-bottom") {
        s.space_after = parse_pt(v);
    }
    s.page_break_before = d.get("page-break-before").map(|v| v.trim() == "always").unwrap_or(s.page_break_before);
    s
}

// ---- unit helpers ----

/// HWPUNIT (pt*100) → `"Npt"` (e.g. 1400 → "14pt").
fn format_pt(hwpunit: i32) -> String {
    let pt = hwpunit as f64 / 100.0;
    if pt.fract() == 0.0 {
        format!("{}pt", pt as i64)
    } else {
        format!("{pt}pt")
    }
}

/// `"14pt"` / `"14.0pt"` → HWPUNIT (1400).
fn parse_pt(v: &str) -> i32 {
    let t = v.trim();
    let num = t.trim_end_matches("pt").trim();
    num.parse::<f64>().map(|f| (f * 100.0).round() as i32).unwrap_or(0)
}

fn serde_json_shape(s: &CharShape) -> String {
    serde_json::to_string(&CharShapeSerde::from(s)).unwrap_or_default()
}
fn serde_json_para(s: &ParaShape) -> String {
    serde_json::to_string(&ParaShapeSerde::from(s)).unwrap_or_default()
}

// ---- public lossless blob carriers (used by project.json manifest) ----

/// Serialize a full `CharShape` to the lossless manifest blob.
pub fn shape_blob_char(s: &CharShape) -> String {
    serde_json_shape(s)
}
/// Serialize a full `ParaShape` to the lossless manifest blob.
pub fn shape_blob_para(s: &ParaShape) -> String {
    serde_json_para(s)
}
/// Reconstruct a `CharShape` from a manifest blob (total inverse of [`shape_blob_char`]).
pub fn shape_from_blob_char(blob: &str) -> hwp_model::error::Result<CharShape> {
    let s: CharShapeSerde = serde_json::from_str(blob)
        .map_err(|e| hwp_model::error::Error::Parse(format!("char shape blob: {e}")))?;
    Ok(s.into())
}
/// Reconstruct a `ParaShape` from a manifest blob.
pub fn shape_from_blob_para(blob: &str) -> hwp_model::error::Result<ParaShape> {
    let s: ParaShapeSerde = serde_json::from_str(blob)
        .map_err(|e| hwp_model::error::Error::Parse(format!("para shape blob: {e}")))?;
    Ok(s.into())
}

// hwp-model types don't derive Serialize, so mirror them with a local serde struct
// (exhaustive — every field carried, so the inverse is total).
mod shape_serde {
    use super::*;
    use hwp_model::style::PerScript;
    use hwp_model::types::Color;
    use serde::{Deserialize, Serialize};

    #[derive(Serialize, Deserialize)]
    pub struct ColorS {
        r: u8,
        g: u8,
        b: u8,
        a: u8,
    }
    impl From<Color> for ColorS {
        fn from(c: Color) -> Self {
            ColorS { r: c.r, g: c.g, b: c.b, a: c.a }
        }
    }
    impl From<ColorS> for Color {
        fn from(c: ColorS) -> Self {
            Color { r: c.r, g: c.g, b: c.b, a: c.a }
        }
    }

    fn ps_to<T: Copy>(p: &PerScript<T>) -> [T; 7] {
        p.0
    }

    #[derive(Serialize, Deserialize)]
    pub struct CharShapeSerde {
        height: i32,
        face_id: [u16; 7],
        ratio: [u8; 7],
        spacing: [i8; 7],
        rel_size: [u8; 7],
        offset: [i8; 7],
        bold: bool,
        italic: bool,
        underline: bool,
        strikeout: bool,
        outline: bool,
        shadow: bool,
        emboss: bool,
        engrave: bool,
        superscript: bool,
        subscript: bool,
        use_kerning: bool,
        use_font_space: bool,
        text_color: ColorS,
        shade_color: ColorS,
        underline_color: ColorS,
        font_family: Option<String>,
        fonts: Vec<Option<String>>,
    }

    impl From<&CharShape> for CharShapeSerde {
        fn from(s: &CharShape) -> Self {
            CharShapeSerde {
                height: s.height,
                face_id: ps_to(&s.face_id),
                ratio: ps_to(&s.ratio),
                spacing: ps_to(&s.spacing),
                rel_size: ps_to(&s.rel_size),
                offset: ps_to(&s.offset),
                bold: s.bold,
                italic: s.italic,
                underline: s.underline,
                strikeout: s.strikeout,
                outline: s.outline,
                shadow: s.shadow,
                emboss: s.emboss,
                engrave: s.engrave,
                superscript: s.superscript,
                subscript: s.subscript,
                use_kerning: s.use_kerning,
                use_font_space: s.use_font_space,
                text_color: s.text_color.into(),
                shade_color: s.shade_color.into(),
                underline_color: s.underline_color.into(),
                font_family: s.font_family.clone(),
                fonts: s.fonts.clone(),
            }
        }
    }

    impl From<CharShapeSerde> for CharShape {
        fn from(s: CharShapeSerde) -> Self {
            CharShape {
                height: s.height,
                face_id: PerScript(s.face_id),
                ratio: PerScript(s.ratio),
                spacing: PerScript(s.spacing),
                rel_size: PerScript(s.rel_size),
                offset: PerScript(s.offset),
                bold: s.bold,
                italic: s.italic,
                underline: s.underline,
                strikeout: s.strikeout,
                outline: s.outline,
                shadow: s.shadow,
                emboss: s.emboss,
                engrave: s.engrave,
                superscript: s.superscript,
                subscript: s.subscript,
                use_kerning: s.use_kerning,
                use_font_space: s.use_font_space,
                text_color: s.text_color.into(),
                shade_color: s.shade_color.into(),
                underline_color: s.underline_color.into(),
                font_family: s.font_family,
                fonts: s.fonts,
            }
        }
    }

    #[derive(Serialize, Deserialize)]
    pub struct ParaShapeSerde {
        align: u8,
        vertical_align: u8,
        line_spacing_type: u8,
        line_spacing_value: i32,
        left_margin: i32,
        right_margin: i32,
        indent: i32,
        space_before: i32,
        space_after: i32,
        break_latin: u8,
        break_non_latin: u8,
        widow_orphan: bool,
        keep_with_next: bool,
        keep_lines: bool,
        page_break_before: bool,
        numbering_id: u16,
        border_fill_id: u16,
    }

    impl From<&ParaShape> for ParaShapeSerde {
        fn from(s: &ParaShape) -> Self {
            ParaShapeSerde {
                align: s.align as u8,
                vertical_align: s.vertical_align as u8,
                line_spacing_type: s.line_spacing_type as u8,
                line_spacing_value: s.line_spacing_value,
                left_margin: s.left_margin,
                right_margin: s.right_margin,
                indent: s.indent,
                space_before: s.space_before,
                space_after: s.space_after,
                break_latin: s.break_latin as u8,
                break_non_latin: s.break_non_latin as u8,
                widow_orphan: s.widow_orphan,
                keep_with_next: s.keep_with_next,
                keep_lines: s.keep_lines,
                page_break_before: s.page_break_before,
                numbering_id: s.numbering_id,
                border_fill_id: s.border_fill_id,
            }
        }
    }

    impl From<ParaShapeSerde> for ParaShape {
        fn from(s: ParaShapeSerde) -> Self {
            use hwp_model::style::{
                HorizontalAlign, LineBreakLatin, LineBreakNonLatin, LineSpacingType, VerticalAlign,
            };
            let h_align = |v: u8| match v {
                1 => HorizontalAlign::Left,
                2 => HorizontalAlign::Right,
                3 => HorizontalAlign::Center,
                4 => HorizontalAlign::Distribute,
                5 => HorizontalAlign::DistributeSpace,
                _ => HorizontalAlign::Justify,
            };
            let v_align = |v: u8| match v {
                1 => VerticalAlign::Top,
                2 => VerticalAlign::Center,
                3 => VerticalAlign::Bottom,
                _ => VerticalAlign::Baseline,
            };
            let ls = |v: u8| match v {
                1 => LineSpacingType::Fixed,
                2 => LineSpacingType::BetweenLines,
                3 => LineSpacingType::AtLeast,
                _ => LineSpacingType::Percent,
            };
            let bl = |v: u8| match v {
                1 => LineBreakLatin::Hyphenation,
                2 => LineBreakLatin::BreakWord,
                _ => LineBreakLatin::KeepWord,
            };
            let bnl = |v: u8| match v {
                1 => LineBreakNonLatin::BreakWord,
                _ => LineBreakNonLatin::KeepWord,
            };
            ParaShape {
                align: h_align(s.align),
                vertical_align: v_align(s.vertical_align),
                line_spacing_type: ls(s.line_spacing_type),
                line_spacing_value: s.line_spacing_value,
                left_margin: s.left_margin,
                right_margin: s.right_margin,
                indent: s.indent,
                space_before: s.space_before,
                space_after: s.space_after,
                break_latin: bl(s.break_latin),
                break_non_latin: bnl(s.break_non_latin),
                widow_orphan: s.widow_orphan,
                keep_with_next: s.keep_with_next,
                keep_lines: s.keep_lines,
                page_break_before: s.page_break_before,
                numbering_id: s.numbering_id,
                border_fill_id: s.border_fill_id,
            }
        }
    }
}

use shape_serde::{CharShapeSerde, ParaShapeSerde};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn char_shape_roundtrips_exhaustively() {
        let mut s = CharShape { height: 1400, bold: true, italic: true, ..Default::default() };
        s.text_color = hwp_model::types::Color { r: 255, g: 0, b: 0, a: 255 };
        s.font_family = Some("맑은 고딕".into());
        s.fonts = vec![Some("a".into()), None];
        s.underline = true;
        let back = decls_to_char_shape(&char_shape_to_decls(&s));
        assert_eq!(back, s);
    }

    #[test]
    fn para_shape_roundtrips_exhaustively() {
        let s = ParaShape {
            align: HorizontalAlign::Center,
            left_margin: 500,
            indent: -200,
            space_after: 300,
            page_break_before: true,
            line_spacing_value: 160,
            ..Default::default()
        };
        let back = decls_to_para_shape(&para_shape_to_decls(&s));
        assert_eq!(back, s);
    }

    #[test]
    fn font_size_edit_changes_reparsed_height() {
        let s = CharShape { height: 1000, ..Default::default() };
        let mut d = char_shape_to_decls(&s);
        d.insert("font-size".into(), "14pt".into());
        assert_eq!(decls_to_char_shape(&d).height, 1400);
    }
}
