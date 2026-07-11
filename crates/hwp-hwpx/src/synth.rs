//! header.xml shape **synthesis** — the foundation for AI-controlled typography.
//!
//! Strategy: to emit a run/paragraph with formatting that isn't already in the document's pools,
//! we **clone the document's default `<hh:charPr>` / `<hh:paraPr>` element and patch the requested
//! overrides onto it**, then give it a fresh id above the existing max and append it to the pool
//! (bumping `itemCnt`). Cloning Hancom's own default element guarantees the synthesized entry has
//! a valid `fontRef`, the required children, and the strict child order the oracle demands — far
//! safer than building from scratch. (Before this, bold reused a *colored* charPr → blue bold.)

use hwp_model::prelude::*;

/// The first `<hh:charPr …>…</hh:charPr>` element in header.xml (conventionally id="0", the
/// default). The trailing space in the open delimiter avoids matching the `<hh:charProperties>`
/// container (whose name also begins with "charPr").
pub fn default_char_pr(header: &str) -> Option<&str> {
    element(header, "<hh:charPr ", "</hh:charPr>")
}

/// Parse the existing `charPr`/`paraPr` pools from header.xml into typed values keyed by XML id
/// (issue #003 P1 — the inverse of synthesis; lets the editor read existing formatting).
pub fn parse_header_pools(header: &str) -> HeaderPools {
    let mut pools = HeaderPools::default();
    each_element(header, "<hh:charPr ", "</hh:charPr>", |elem| {
        if let Some(id) = first_attr(elem, "id").and_then(|v| v.parse().ok()) {
            pools.char.insert(id, parse_char_pr(elem));
        }
    });
    each_element(header, "<hh:paraPr ", "</hh:paraPr>", |elem| {
        if let Some(id) = first_attr(elem, "id").and_then(|v| v.parse().ok()) {
            pools.para.insert(id, parse_para_pr(elem));
        }
    });
    pools
}

/// Call `f` on each `open … close` element in `s` (non-nested pools).
fn each_element(s: &str, open: &str, close: &str, mut f: impl FnMut(&str)) {
    let mut idx = 0;
    while let Some(p) = s[idx..].find(open) {
        let start = idx + p;
        let Some(rel) = s[start..].find(close) else {
            break;
        };
        let end = start + rel + close.len();
        f(&s[start..end]);
        idx = end;
    }
}

/// Inverse of [`synthesize_char_pr`]: read a `<hh:charPr>` element into a `CharShape`.
pub fn parse_char_pr(elem: &str) -> CharShape {
    let mut cs = CharShape::default();
    if let Some(h) = first_attr(elem, "height").and_then(|v| v.parse().ok()) {
        cs.height = h;
    }
    if let Some(c) = first_attr(elem, "textColor").and_then(Color::from_hex) {
        cs.text_color = c;
    }
    if let Some(sc) = first_attr(elem, "shadeColor") {
        if sc != "none" {
            if let Some(c) = Color::from_hex(sc) {
                cs.shade_color = c;
            }
        }
    }
    cs.bold = elem.contains("<hh:bold/>");
    cs.italic = elem.contains("<hh:italic/>");
    if let Some(u) = elem.find("<hh:underline") {
        cs.underline = first_attr(&elem[u..], "type").is_some_and(|t| t != "NONE");
    }
    if let Some(s) = elem.find("<hh:strikeout") {
        cs.strikeout = first_attr(&elem[s..], "shape").is_some_and(|sh| sh != "NONE");
    }
    cs
}

/// Inverse of [`synthesize_para_pr`]: read a `<hh:paraPr>` element into a `ParaShape` (the
/// `hp:case` margin branch carries the un-doubled values).
pub fn parse_para_pr(elem: &str) -> ParaShape {
    let mut ps = ParaShape::default();
    if let Some(a) = elem.find("<hh:align") {
        ps.align = match first_attr(&elem[a..], "horizontal").unwrap_or("JUSTIFY") {
            "LEFT" => HorizontalAlign::Left,
            "RIGHT" => HorizontalAlign::Right,
            "CENTER" => HorizontalAlign::Center,
            "DISTRIBUTE" => HorizontalAlign::Distribute,
            "DISTRIBUTE_SPACE" => HorizontalAlign::DistributeSpace,
            _ => HorizontalAlign::Justify,
        };
    }
    if let Some(ls) = elem.find("<hh:lineSpacing") {
        if let Some(v) = first_attr(&elem[ls..], "value").and_then(|v| v.parse().ok()) {
            ps.line_spacing_type = LineSpacingType::Percent;
            ps.line_spacing_value = v;
        }
    }
    if let Some(m) = elem.find("<hh:margin>") {
        let seg = &elem[m..];
        ps.indent = hc_value(seg, "intent").unwrap_or(0);
        ps.left_margin = hc_value(seg, "left").unwrap_or(0);
        ps.right_margin = hc_value(seg, "right").unwrap_or(0);
        ps.space_before = hc_value(seg, "prev").unwrap_or(0);
        ps.space_after = hc_value(seg, "next").unwrap_or(0);
    }
    if let Some(b) = elem.find("<hh:border ") {
        if let Some(bf) = first_attr(&elem[b..], "borderFillIDRef").and_then(|v| v.parse().ok()) {
            ps.border_fill_id = bf;
        }
    }
    ps
}

/// Value of the first `<hc:{name} value="N"…` in `seg`.
fn hc_value(seg: &str, name: &str) -> Option<i32> {
    let pat = format!("<hc:{name} value=\"");
    let s = seg.find(&pat)? + pat.len();
    let e = seg[s..].find('"')? + s;
    seg[s..e].parse().ok()
}

/// The first `<hh:paraPr …>…</hh:paraPr>` element in header.xml (trailing space avoids matching
/// the `<hh:paraProperties>` container).
pub fn default_para_pr(header: &str) -> Option<&str> {
    element(header, "<hh:paraPr ", "</hh:paraPr>")
}

/// A resolved entry from the `<hh:styles>` pool.
#[derive(Clone, Debug)]
pub struct StyleRef {
    pub id: String,
    pub para_pr: String,
    pub char_pr: String,
}

/// Parse the `<hh:styles>` pool into a name→StyleRef map, keyed by BOTH `name` and `engName`
/// (so "개요 1" and "Outline 1" both resolve). Applying a named style = referencing these ids.
pub fn parse_styles(header: &str) -> std::collections::BTreeMap<String, StyleRef> {
    let mut map = std::collections::BTreeMap::new();
    let Some(seg) = element(header, "<hh:styles", "</hh:styles>") else {
        return map;
    };
    let mut idx = 0;
    while let Some(p) = seg[idx..].find("<hh:style ") {
        let start = idx + p;
        let end = seg[start..]
            .find("/>")
            .map(|e| start + e + 2)
            .unwrap_or(seg.len());
        let tag = &seg[start..end];
        idx = end;
        let (Some(id), Some(para), Some(chr)) = (
            first_attr(tag, "id"),
            first_attr(tag, "paraPrIDRef"),
            first_attr(tag, "charPrIDRef"),
        ) else {
            continue;
        };
        let sref = StyleRef {
            id: id.to_string(),
            para_pr: para.to_string(),
            char_pr: chr.to_string(),
        };
        for key in [first_attr(tag, "name"), first_attr(tag, "engName")]
            .into_iter()
            .flatten()
        {
            if !key.is_empty() {
                map.insert(key.to_string(), sref.clone());
            }
        }
    }
    map
}

/// The `<hh:borderFill id="{id}">…</hh:borderFill>` element with the given id (to clone for shading).
pub fn border_fill_by_id(header: &str, id: &str) -> Option<String> {
    let needle = format!("<hh:borderFill id=\"{id}\"");
    let start = header.find(&needle)?;
    let end = header[start..].find("</hh:borderFill>")? + start + "</hh:borderFill>".len();
    Some(header[start..end].to_string())
}

/// Synthesize a shaded `<hh:borderFill>` by cloning `base` (a bordered cell fill) and inserting a
/// `<hc:fillBrush>` with the requested face color — so a cell can have both borders and a background.
pub fn synthesize_border_fill(base: &str, new_id: u64, shade: Color) -> String {
    synthesize_border_fill_full(base, new_id, &[None; 4], Some(shade))
}

/// OWPML border `type` token for a renderable [`LineStyle`] — the inverse of the .hwp lift's
/// collapse (`hwp-rhwp` `lift_line_style`). Exotic HWP strokes (wave/3D/dash-dot …) were already
/// collapsed to `Solid` at lift, so they re-emit as `SOLID` — same honesty as the render.
pub fn border_type_token(style: LineStyle) -> &'static str {
    match style {
        LineStyle::None => "NONE",
        LineStyle::Solid => "SOLID",
        LineStyle::Dashed => "DASH",
        LineStyle::Dotted => "DOT",
        // rhwp's HWPX parser accepts DOUBLE_SLIM|DOUBLE → Double; Hancom writes DOUBLE_SLIM.
        LineStyle::Double => "DOUBLE_SLIM",
    }
}

/// Nearest OWPML border `width` string for a lifted stroke width in device px. The 16 spec widths
/// (표 28, mm) pair 1:1 with the px table the lift converts through (`border_width_to_px`), so this
/// is its inverse — EXCEPT the lift's 0.5px hairline floor collapses index 0 (0.1 mm → 0.4px) into
/// index 1 (0.12 mm → 0.5px): a 0.1 mm hairline re-emits as the visually identical 0.12 mm.
pub fn border_width_token(width_px: f64) -> &'static str {
    const WIDTHS: [(f64, &str); 16] = [
        (0.4, "0.1 mm"),
        (0.5, "0.12 mm"),
        (0.6, "0.15 mm"),
        (0.75, "0.2 mm"),
        (1.0, "0.25 mm"),
        (1.1, "0.3 mm"),
        (1.5, "0.4 mm"),
        (1.9, "0.5 mm"),
        (2.3, "0.6 mm"),
        (2.6, "0.7 mm"),
        (3.8, "1.0 mm"),
        (5.7, "1.5 mm"),
        (7.6, "2.0 mm"),
        (11.3, "3.0 mm"),
        (15.1, "4.0 mm"),
        (18.9, "5.0 mm"),
    ];
    let mut best = WIDTHS[0].1;
    let mut best_d = f64::INFINITY;
    for (px, tok) in WIDTHS {
        let d = (px - width_px).abs();
        if d < best_d {
            best_d = d;
            best = tok;
        }
    }
    best
}

/// Synthesize a full `<hh:borderFill>` (issue 054, F2): clone `base` (a Hancom-authored bordered
/// fill, so child order/required attrs are valid), patch each `Some` edge's
/// `<hh:leftBorder|rightBorder|topBorder|bottomBorder type=".." width=".." color=".."/>`
/// (edge order `[left, right, top, bottom]`, mirroring `Cell::borders`), and set the fill: `Some`
/// shade → replace-or-insert a `<hc:fillBrush>`; `None` → leave the base's fill untouched. A `None`
/// edge inherits the base's edge (unspecified ≠ 선없음 — 선없음 arrives as `LineStyle::None` → NONE).
pub fn synthesize_border_fill_full(
    base: &str,
    new_id: u64,
    edges: &[Option<CellEdge>; 4],
    shade: Option<Color>,
) -> String {
    let mut s = set_attr(base, "id", &new_id.to_string());
    const CHILD: [&str; 4] = ["leftBorder", "rightBorder", "topBorder", "bottomBorder"];
    for (i, edge) in edges.iter().enumerate() {
        let Some(e) = edge else { continue };
        s = set_border_child(
            &s,
            CHILD[i],
            border_type_token(e.style),
            border_width_token(e.width_px),
            &e.color.to_hex(),
        );
    }
    if let Some(shade) = shade {
        let brush = format!(
            "<hc:fillBrush><hc:winBrush faceColor=\"{}\" hatchColor=\"#FF000000\" alpha=\"0\"/></hc:fillBrush>",
            shade.to_hex()
        );
        // Replace an existing fillBrush (never emit two), else insert before the close tag.
        if let (Some(a), Some(b)) = (s.find("<hc:fillBrush"), s.find("</hc:fillBrush>")) {
            let end = b + "</hc:fillBrush>".len();
            if a < end {
                s.replace_range(a..end, &brush);
            }
        } else if let Some(pos) = s.rfind("</hh:borderFill>") {
            s.insert_str(pos, &brush);
        }
    }
    s
}

/// Set the 7 per-script attrs (hangul…user) on the `<hh:{child} …/>` element inside a charPr clone
/// (ratio/spacing). No-op if the child is absent (we then inherit the base's values).
fn set_per_script_child(s: &str, child: &str, vals: &[String; 7]) -> String {
    const ATTRS: [&str; 7] = [
        "hangul", "latin", "hanja", "japanese", "other", "symbol", "user",
    ];
    let open = format!("<hh:{child}");
    let Some(p) = s.find(&open) else {
        return s.to_string();
    };
    let Some(rel) = s[p..].find("/>") else {
        return s.to_string();
    };
    let end = p + rel + 2;
    let mut tag = s[p..end].to_string();
    for (i, attr) in ATTRS.iter().enumerate() {
        tag = set_attr(&tag, attr, &vals[i]);
    }
    format!("{}{}{}", &s[..p], tag, &s[end..])
}

/// Set `type`/`width`/`color` on the `<hh:{child} …/>` element inside a borderFill clone. No-op if
/// the child is absent (a malformed base — we then inherit whatever the base carries).
fn set_border_child(s: &str, child: &str, ty: &str, width: &str, color: &str) -> String {
    let open = format!("<hh:{child}");
    let Some(p) = s.find(&open) else {
        return s.to_string();
    };
    let Some(rel) = s[p..].find("/>") else {
        return s.to_string();
    };
    let end = p + rel + 2;
    let mut tag = s[p..end].to_string();
    tag = set_attr(&tag, "type", ty);
    tag = set_attr(&tag, "width", width);
    tag = set_attr(&tag, "color", color);
    format!("{}{}{}", &s[..p], tag, &s[end..])
}

fn element<'a>(s: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let start = s.find(open)?;
    let end = s[start..].find(close)? + start + close.len();
    Some(&s[start..end])
}

/// If an element byte-identical to `fragment` **ignoring its `id`** already exists in `header`,
/// return that existing id — so a synthesized shape that matches a pool entry is REUSED instead
/// of appended (dedup, issue #003). Safe because we synthesize by cloning the same default element
/// Hancom uses, so equal formatting ⇒ equal XML modulo id. `open` is the element open delimiter
/// incl. trailing space (e.g. "<hh:charPr "); `close` e.g. "</hh:charPr>".
pub fn existing_equivalent_id(
    header: &str,
    open: &str,
    close: &str,
    fragment: &str,
) -> Option<String> {
    let target = set_attr(fragment, "id", "");
    let mut idx = 0;
    while let Some(p) = header[idx..].find(open) {
        let start = idx + p;
        let Some(rel) = header[start..].find(close) else {
            break;
        };
        let end = start + rel + close.len();
        let elem = &header[start..end];
        idx = end;
        if set_attr(elem, "id", "") == target {
            return first_attr(elem, "id").map(str::to_string);
        }
    }
    None
}

/// Largest numeric `id="N"` across `{container}` … `</{container}>` (e.g. charProperties pool).
/// New synthesized ids start above this so they never collide with existing pool entries.
pub fn max_pool_id(header: &str, container: &str) -> u64 {
    let open = format!("<hh:{container}");
    let close = format!("</hh:{container}>");
    let Some(seg) = element(header, &open, &close) else {
        return 0;
    };
    let mut max = 0u64;
    let mut idx = 0;
    while let Some(p) = seg[idx..].find("id=\"") {
        let start = idx + p + 4;
        let rest = &seg[start..];
        match rest.find('"') {
            Some(end) => {
                if let Ok(v) = rest[..end].parse::<u64>() {
                    max = max.max(v);
                }
                idx = start + end;
            }
            None => break,
        }
    }
    max
}

/// Synthesize a `<hh:charPr>` for `shape` by cloning `base` (the default charPr) and patching only
/// the overridden fields. Bold/italic are inserted as markers before `<hh:underline>` (their schema
/// position). A `CharShape` that `is_default()` should never reach here (caller reuses the default).
pub fn synthesize_char_pr(
    base: &str,
    new_id: u64,
    shape: &CharShape,
    fontref: Option<&str>,
) -> String {
    let mut s = base.to_string();
    s = set_attr(&s, "id", &new_id.to_string());
    // Replace the cloned <hh:fontRef …/> with the interned font's reference, if a font was requested.
    if let Some(fr) = fontref {
        if let Some(p) = s.find("<hh:fontRef") {
            if let Some(rel) = s[p..].find("/>") {
                s = format!("{}{}{}", &s[..p], fr, &s[p + rel + 2..]);
            }
        }
    }
    if shape.height != 0 {
        s = set_attr(&s, "height", &shape.height.to_string());
    }
    // 장평/자간 (fidelity #8/#9's EMIT half — the .hwp lift already captures them; 054's round-trip
    // page-preservation needs them re-emitted): dense gov-doc tables compress text to ratio 90–98 /
    // spacing −5…−12, and dropping these over-wraps cell text on reopen → extra pages. A 0 ratio
    // slot means "uncaptured" → the neutral 100 (base value); spacing 0 is itself neutral.
    if shape.ratio.0.iter().any(|&r| r != 0) {
        let vals: [String; 7] = std::array::from_fn(|i| {
            if shape.ratio.0[i] == 0 {
                "100".into()
            } else {
                shape.ratio.0[i].to_string()
            }
        });
        s = set_per_script_child(&s, "ratio", &vals);
    }
    if shape.spacing.0.iter().any(|&v| v != 0) {
        let vals: [String; 7] = std::array::from_fn(|i| shape.spacing.0[i].to_string());
        s = set_per_script_child(&s, "spacing", &vals);
    }
    if shape.text_color != Color::default() {
        s = set_attr(&s, "textColor", &shape.text_color.to_hex());
    }
    if shape.shade_color != Color::default() {
        s = set_attr(&s, "shadeColor", &shape.shade_color.to_hex());
    }
    // italic then bold, immediately before <hh:underline> — the schema order is
    // fontRef,ratio,spacing,relSz,offset,[italic],[bold],underline,… (italic precedes bold).
    let mut markers = String::new();
    if shape.italic {
        markers.push_str("<hh:italic/>");
    }
    if shape.bold {
        markers.push_str("<hh:bold/>");
    }
    if !markers.is_empty() {
        s = s.replacen("<hh:underline", &format!("{markers}<hh:underline"), 1);
    }
    if shape.underline {
        s = s.replacen(
            "<hh:underline type=\"NONE\"",
            "<hh:underline type=\"BOTTOM\"",
            1,
        );
    }
    if shape.strikeout {
        s = s.replacen(
            "<hh:strikeout shape=\"NONE\"",
            "<hh:strikeout shape=\"SOLID\"",
            1,
        );
    }
    // sub/superscript markers sit AFTER <hh:strikeout>, before <hh:outline> (schema order; verified
    // against real Hancom charPrs). Mutually exclusive — superscript wins if both are set.
    if shape.superscript {
        s = s.replacen("<hh:outline", "<hh:supscript/><hh:outline", 1);
    } else if shape.subscript {
        s = s.replacen("<hh:outline", "<hh:subscript/><hh:outline", 1);
    }
    s
}

/// OWPML horizontal-align token for a `HorizontalAlign` (None = Justify, treated as "inherit").
fn align_token(a: HorizontalAlign) -> Option<&'static str> {
    match a {
        HorizontalAlign::Justify => None, // inherit the base paragraph's alignment
        HorizontalAlign::Left => Some("LEFT"),
        HorizontalAlign::Right => Some("RIGHT"),
        HorizontalAlign::Center => Some("CENTER"),
        HorizontalAlign::Distribute => Some("DISTRIBUTE"),
        HorizontalAlign::DistributeSpace => Some("DISTRIBUTE_SPACE"),
    }
}

/// Synthesize a `<hh:paraPr>` for `shape` by cloning `base` (the default paraPr): patch id +
/// alignment, then REBUILD the `<hp:switch>` margin/lineSpacing block. Hancom stores margins
/// twice — `hp:case` carries value V and `hp:default` carries **2V** (verified across the corpus:
/// left 7000→14000, intent -1310→-2620) — while PERCENT lineSpacing is identical in both branches.
pub fn synthesize_para_pr(base: &str, new_id: u64, shape: &ParaShape) -> String {
    let mut s = base.to_string();
    s = set_attr(&s, "id", &new_id.to_string());
    if let Some(tok) = align_token(shape.align) {
        // <hh:align horizontal="LEFT" …> — replace the horizontal value.
        if let Some(p) = s.find("<hh:align") {
            let seg = set_attr(&s[p..], "horizontal", tok);
            s = format!("{}{}", &s[..p], seg);
        }
    }
    // Effective line spacing: override (PERCENT, value) if set, else keep the base's.
    let (ls_type, ls_val) = base_line_spacing(base);
    let (ls_type, ls_val) = if shape.line_spacing_value > 0 {
        ("PERCENT".to_string(), shape.line_spacing_value)
    } else {
        (ls_type, ls_val)
    };
    let switch = build_switch(shape, &ls_type, ls_val);
    // Replace the existing <hp:switch>…</hp:switch> with the rebuilt one.
    if let (Some(a), Some(b)) = (s.find("<hp:switch>"), s.find("</hp:switch>")) {
        let end = b + "</hp:switch>".len();
        s = format!("{}{}{}", &s[..a], switch, &s[end..]);
    }
    s
}

/// Read the base paraPr's first `<hh:lineSpacing type=".." value="..">` (default PERCENT/130).
fn base_line_spacing(base: &str) -> (String, i32) {
    if let Some(p) = base.find("<hh:lineSpacing") {
        let seg = &base[p..];
        let t = first_attr(seg, "type").unwrap_or("PERCENT").to_string();
        let v = first_attr(seg, "value")
            .and_then(|v| v.parse().ok())
            .unwrap_or(130);
        return (t, v);
    }
    ("PERCENT".to_string(), 130)
}

/// Build `<hp:switch>` with margins V in `hp:case` and 2V in `hp:default`, lineSpacing identical.
fn build_switch(shape: &ParaShape, ls_type: &str, ls_val: i32) -> String {
    let (i, l, r, p, n) = (
        shape.indent,
        shape.left_margin,
        shape.right_margin,
        shape.space_before,
        shape.space_after,
    );
    let margin = |k: i32| {
        format!(
            "<hh:margin><hc:intent value=\"{}\" unit=\"HWPUNIT\"/><hc:left value=\"{}\" unit=\"HWPUNIT\"/><hc:right value=\"{}\" unit=\"HWPUNIT\"/><hc:prev value=\"{}\" unit=\"HWPUNIT\"/><hc:next value=\"{}\" unit=\"HWPUNIT\"/></hh:margin>",
            i * k, l * k, r * k, p * k, n * k
        )
    };
    let ls = format!("<hh:lineSpacing type=\"{ls_type}\" value=\"{ls_val}\" unit=\"HWPUNIT\"/>");
    format!(
        "<hp:switch><hp:case hp:required-namespace=\"http://www.hancom.co.kr/hwpml/2016/HwpUnitChar\">{}{ls}</hp:case><hp:default>{}{ls}</hp:default></hp:switch>",
        margin(1),
        margin(2)
    )
}

/// First occurrence of `name="…"` in `s`.
fn first_attr<'a>(s: &'a str, name: &str) -> Option<&'a str> {
    let pat = format!("{name}=\"");
    let start = s.find(&pat)? + pat.len();
    let rest = &s[start..];
    rest.find('"').map(|end| &rest[..end])
}

/// Set attribute `name`'s value (its first occurrence) to `val`, returning the new string.
/// (The charPr/paraPr element's own attrs precede any child, so "first" targets the element.)
/// Returns the input unchanged if `name` is absent (so callers must ensure the attr exists).
pub(crate) fn set_attr(s: &str, name: &str, val: &str) -> String {
    let pat = format!("{name}=\"");
    if let Some(p) = s.find(&pat) {
        let vstart = p + pat.len();
        if let Some(rel_end) = s[vstart..].find('"') {
            let vend = vstart + rel_end;
            let mut out = String::with_capacity(s.len() + val.len());
            out.push_str(&s[..vstart]);
            out.push_str(val);
            out.push_str(&s[vend..]);
            return out;
        }
    }
    s.to_string()
}

/// The 7 OWPML script classes: (fontface `lang`, `fontRef` attribute name), in fontRef order.
const FONT_LANGS: [(&str, &str); 7] = [
    ("HANGUL", "hangul"),
    ("LATIN", "latin"),
    ("HANJA", "hanja"),
    ("JAPANESE", "japanese"),
    ("OTHER", "other"),
    ("SYMBOL", "symbol"),
    ("USER", "user"),
];

/// Ensure font `family` exists in all 7 `<hh:fontface>` pools (reuse by name, else clone an
/// existing `<hh:font>` as a template and append with a fresh id + bumped `fontCnt`), returning
/// the patched header + the per-script `<hh:fontRef …/>` element that references it. `fontfaces`
/// itemCnt stays 7 (no new fontface lang); only each pool's `fontCnt` grows.
pub fn intern_font(header: &str, family: &str) -> (String, String) {
    let mut out = header.to_string();
    let mut refs = Vec::with_capacity(7);
    for (lang, attr) in FONT_LANGS {
        let (next, id) = ensure_font_in_lang(&out, lang, family);
        out = next;
        refs.push(format!("{attr}=\"{id}\""));
    }
    (out, format!("<hh:fontRef {}/>", refs.join(" ")))
}

/// Per-script font interning: for each slot (Hangul..User, aligned with `FONT_LANGS`) that names a
/// font, intern it into THAT language's `<hh:fontface>` pool; slots that are `None`/absent keep
/// `base_charpr`'s existing fontRef value for that language. Returns the patched header + the full
/// `<hh:fontRef …/>` to substitute — so Hangul/Latin/Hanja keep distinct faces instead of one family
/// forced onto all scripts (the limitation of [`intern_font`]).
pub fn intern_fonts(header: &str, fonts: &[Option<String>], base_charpr: &str) -> (String, String) {
    let base_ref = element(base_charpr, "<hh:fontRef", "/>").unwrap_or("");
    let mut out = header.to_string();
    let mut refs = Vec::with_capacity(7);
    for (i, (lang, attr)) in FONT_LANGS.iter().enumerate() {
        let id = match fonts.get(i).and_then(|f| f.as_deref()) {
            Some(name) if !name.is_empty() => {
                let (next, id) = ensure_font_in_lang(&out, lang, name);
                out = next;
                id.to_string()
            }
            // No font requested for this script → keep the base charPr's existing fontRef id.
            _ => first_attr(base_ref, attr).unwrap_or("0").to_string(),
        };
        refs.push(format!("{attr}=\"{id}\""));
    }
    (out, format!("<hh:fontRef {}/>", refs.join(" ")))
}

/// Within the `<hh:fontface lang="{lang}">` pool: return the id of an existing `face="{family}"`,
/// else clone the pool's first `<hh:font>…</hh:font>` as a template (new id = fontCnt), append it,
/// bump fontCnt, and return the new id. Returns id 0 (a safe fallback) if the pool is malformed.
fn ensure_font_in_lang(header: &str, lang: &str, family: &str) -> (String, u64) {
    let open = format!("<hh:fontface lang=\"{lang}\"");
    let Some(fstart) = header.find(&open) else {
        return (header.to_string(), 0);
    };
    let Some(rel) = header[fstart..].find("</hh:fontface>") else {
        return (header.to_string(), 0);
    };
    let fend = fstart + rel; // position of </hh:fontface>
    let seg = &header[fstart..fend];

    // 1. reuse an existing font with this face name.
    if let Some(np) = seg.find(&format!("face=\"{family}\"")) {
        if let Some(idp) = seg[..np].rfind("id=\"") {
            let s = idp + 4;
            if let Some(e) = seg[s..].find('"') {
                if let Ok(id) = seg[s..s + e].parse::<u64>() {
                    return (header.to_string(), id);
                }
            }
        }
    }

    // 2. clone the first <hh:font …>…</hh:font> as a template; patch its id + face.
    let Some(ts) = seg.find("<hh:font ") else {
        return (header.to_string(), 0);
    };
    let Some(te_rel) = seg[ts..].find("</hh:font>") else {
        return (header.to_string(), 0);
    };
    let template = &seg[ts..ts + te_rel + "</hh:font>".len()];
    let new_id = first_attr(seg, "fontCnt")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    let cloned = set_attr(
        &set_attr(template, "id", &new_id.to_string()),
        "face",
        family,
    );

    // Build the new header: insert cloned font before </hh:fontface>, bump this pool's fontCnt.
    let mut new_seg = String::with_capacity(seg.len() + cloned.len());
    new_seg.push_str(seg);
    new_seg.push_str(&cloned);
    let new_seg = bump_attr(&new_seg, "fontCnt", 1);
    let mut out = String::with_capacity(header.len() + cloned.len());
    out.push_str(&header[..fstart]);
    out.push_str(&new_seg);
    out.push_str(&header[fend..]);
    (out, new_id)
}

/// Bump the first numeric `name="N"` by `delta`.
fn bump_attr(s: &str, name: &str, delta: i64) -> String {
    let pat = format!("{name}=\"");
    if let Some(p) = s.find(&pat) {
        let vs = p + pat.len();
        if let Some(rel) = s[vs..].find('"') {
            if let Ok(n) = s[vs..vs + rel].parse::<i64>() {
                return format!("{}{}{}", &s[..vs], n + delta, &s[vs + rel..]);
            }
        }
    }
    s.to_string()
}

/// Patch a section's page setup in-place: `<hp:pagePr>` width/height + the page `<hp:margin>`
/// left/right/top/bottom (header/footer/gutter left intact). Used for `Op::SetPageLayout`; the
/// rest of the secPr (grid, footnote/endnote prefs, columns) is preserved verbatim.
pub fn patch_page(section_xml: &str, page: &PageSetup) -> String {
    let mut s = section_xml.to_string();
    // <hp:pagePr … landscape=".." width=".." height="..">. The orientation attr is load-bearing for
    // the HWP5→HWPX converter: the Skeleton stub is hardcoded landscape="WIDELY", so a portrait .hwp
    // would stay landscape unless we patch it. (HWPX-in only reaches here after a SetPageLayout,
    // which writes the full PageSetup — consistent with the width/height patch below.)
    if let Some(p) = s.find("<hp:pagePr") {
        if let Some(rel) = s[p..].find('>') {
            let end = p + rel + 1;
            let tag = set_attr(&s[p..end], "width", &page.width.to_string());
            let tag = set_attr(&tag, "height", &page.height.to_string());
            let tag = set_attr(
                &tag,
                "landscape",
                if page.landscape { "WIDELY" } else { "NARROWLY" },
            );
            s = format!("{}{}{}", &s[..p], tag, &s[end..]);
        }
    }
    // the page <hp:margin …/> (self-closing); set the four content margins.
    if let Some(p) = s.find("<hp:margin") {
        if let Some(rel) = s[p..].find("/>") {
            let end = p + rel + 2;
            let mut tag = s[p..end].to_string();
            for (name, val) in [
                ("left", page.margin_left),
                ("right", page.margin_right),
                ("top", page.margin_top),
                ("bottom", page.margin_bottom),
            ] {
                tag = set_attr(&tag, name, &val.to_string());
            }
            s = format!("{}{}{}", &s[..p], tag, &s[end..]);
        }
    }
    s
}

/// Insert `fragments` before `</hh:{container}>` and bump that pool's `itemCnt` by `added`.
/// Returns the patched header.xml. No-op (clone) if the container/itemCnt isn't found.
pub fn patch_pool(header: &str, container: &str, fragments: &str, added: usize) -> String {
    if added == 0 || fragments.is_empty() {
        return header.to_string();
    }
    let close = format!("</hh:{container}>");
    let mut s = match header.find(&close) {
        Some(pos) => {
            let mut o = String::with_capacity(header.len() + fragments.len());
            o.push_str(&header[..pos]);
            o.push_str(fragments);
            o.push_str(&header[pos..]);
            o
        }
        None => header.to_string(),
    };
    // bump itemCnt on the <hh:{container} … itemCnt="N"> opening tag
    let open = format!("<hh:{container}");
    if let Some(op) = s.find(&open) {
        if let Some(ic) = s[op..].find("itemCnt=\"") {
            let vstart = op + ic + "itemCnt=\"".len();
            if let Some(rel_end) = s[vstart..].find('"') {
                let vend = vstart + rel_end;
                if let Ok(n) = s[vstart..vend].parse::<usize>() {
                    let mut o = String::with_capacity(s.len() + 2);
                    o.push_str(&s[..vstart]);
                    o.push_str(&(n + added).to_string());
                    o.push_str(&s[vend..]);
                    s = o;
                }
            }
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = r##"<hh:charPr id="0" height="1000" textColor="#000000" shadeColor="none" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="2"><hh:fontRef hangul="1" latin="1" hanja="1" japanese="1" other="1" symbol="1" user="1"/><hh:ratio hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/><hh:spacing hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/><hh:relSz hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/><hh:offset hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/><hh:underline type="NONE" shape="SOLID" color="#000000"/><hh:strikeout shape="NONE" color="#000000"/><hh:outline type="NONE"/><hh:shadow type="NONE" color="#B2B2B2" offsetX="10" offsetY="10"/></hh:charPr>"##;

    #[test]
    fn bold_synthesis_is_pure_bold_not_colored() {
        let shape = CharShape {
            bold: true,
            ..Default::default()
        };
        let out = synthesize_char_pr(BASE, 100, &shape, None);
        assert!(out.contains(r#"id="100""#), "new id assigned");
        assert!(out.contains("<hh:bold/>"), "bold marker present");
        assert!(
            out.contains(r##"textColor="#000000""##),
            "stays black (not the blue id=7 charPr)"
        );
        // bold must sit immediately before underline (schema order)
        assert!(
            out.contains("<hh:bold/><hh:underline"),
            "bold precedes underline"
        );
    }

    #[test]
    fn superscript_synthesis_after_strikeout() {
        let shape = CharShape {
            superscript: true,
            ..Default::default()
        };
        let out = synthesize_char_pr(BASE, 50, &shape, None);
        assert!(
            out.contains("<hh:supscript/>"),
            "supscript marker present: {out}"
        );
        // Schema order: it must sit between strikeout and outline.
        let strike = out.find("<hh:strikeout").unwrap();
        let sup = out.find("<hh:supscript/>").unwrap();
        let outline = out.find("<hh:outline").unwrap();
        assert!(
            strike < sup && sup < outline,
            "supscript between strikeout and outline"
        );
        // Subscript is mutually exclusive (superscript wins).
        let both = synthesize_char_pr(
            BASE,
            51,
            &CharShape {
                superscript: true,
                subscript: true,
                ..Default::default()
            },
            None,
        );
        assert!(both.contains("<hh:supscript/>") && !both.contains("<hh:subscript/>"));
    }

    #[test]
    fn full_formatting_synthesis() {
        let shape = CharShape {
            height: 1400,
            bold: true,
            italic: true,
            underline: true,
            strikeout: true,
            text_color: Color::from_hex("#FF0000").unwrap(),
            ..Default::default()
        };
        let out = synthesize_char_pr(BASE, 7, &shape, None);
        assert!(out.contains(r#"height="1400""#));
        assert!(out.contains(r##"textColor="#FF0000""##));
        assert!(
            out.contains("<hh:italic/><hh:bold/><hh:underline"),
            "italic,bold (schema order) before underline"
        );
        assert!(out.contains(r#"<hh:underline type="BOTTOM""#));
        assert!(out.contains(r#"<hh:strikeout shape="SOLID""#));
    }

    #[test]
    fn patch_pool_inserts_and_bumps_itemcnt() {
        let header = r#"<hh:charProperties itemCnt="2"><hh:charPr id="0"/><hh:charPr id="1"/></hh:charProperties>"#;
        let out = patch_pool(header, "charProperties", "<hh:charPr id=\"2\"/>", 1);
        assert!(out.contains(r#"itemCnt="3""#), "itemCnt bumped 2→3");
        assert!(
            out.contains(r#"<hh:charPr id="2"/></hh:charProperties>"#),
            "fragment before close tag"
        );
    }

    #[test]
    fn parse_char_pr_recovers_formatting() {
        let shape = CharShape {
            bold: true,
            italic: true,
            underline: true,
            text_color: Color::from_hex("#C00000").unwrap(),
            ..Default::default()
        };
        let xml = synthesize_char_pr(BASE, 5, &shape, None);
        let back = parse_char_pr(&xml);
        assert!(back.bold && back.italic && back.underline);
        assert_eq!(back.text_color, Color::from_hex("#C00000").unwrap());
        assert_eq!(back.height, 1000, "height inherited from the base element");
        assert!(
            !parse_char_pr(BASE).bold,
            "the plain base parses as non-bold"
        );
    }

    #[test]
    fn parse_header_pools_reads_all_entries() {
        let header = format!(
            r#"<hh:charProperties itemCnt="2">{BASE}{}</hh:charProperties>"#,
            synthesize_char_pr(
                BASE,
                7,
                &CharShape {
                    bold: true,
                    text_color: Color::from_hex("#1F4E79").unwrap(),
                    ..Default::default()
                },
                None
            )
        );
        let pools = parse_header_pools(&header);
        assert_eq!(pools.char.len(), 2);
        let c7 = &pools.char[&7];
        assert!(c7.bold && c7.text_color == Color::from_hex("#1F4E79").unwrap());
        assert!(!pools.char[&0].bold);
    }

    #[test]
    fn max_pool_id_finds_highest() {
        let header = r#"<hh:charProperties itemCnt="3"><hh:charPr id="0"/><hh:charPr id="7"/><hh:charPr id="3"/></hh:charProperties>"#;
        assert_eq!(max_pool_id(header, "charProperties"), 7);
    }

    #[test]
    fn intern_font_reuses_existing_and_adds_new() {
        let header = r#"<hh:fontfaces itemCnt="2"><hh:fontface lang="HANGUL" fontCnt="2"><hh:font id="0" face="함초롬돋움" type="TTF" isEmbedded="0"><hh:typeInfo/></hh:font><hh:font id="1" face="함초롬바탕" type="TTF" isEmbedded="0"><hh:typeInfo/></hh:font></hh:fontface><hh:fontface lang="LATIN" fontCnt="1"><hh:font id="0" face="Times" type="TTF" isEmbedded="0"><hh:typeInfo/></hh:font></hh:fontface></hh:fontfaces>"#;
        // reuse existing face by name → id 1 in HANGUL, and a NEW id appended in LATIN
        let (out, fref) = intern_font(header, "함초롬바탕");
        assert!(fref.contains(r#"hangul="1""#), "reused HANGUL id 1: {fref}");
        assert!(
            out.contains(r#"<hh:fontface lang="HANGUL" fontCnt="2">"#),
            "HANGUL fontCnt unchanged (reused)"
        );
        // LATIN lacked the face → clone+append at id 1, fontCnt 1→2
        assert!(fref.contains(r#"latin="1""#), "LATIN got new id 1");
        assert!(
            out.contains(r#"<hh:fontface lang="LATIN" fontCnt="2">"#),
            "LATIN fontCnt bumped"
        );
        assert!(
            out.contains(r#"face="함초롬바탕"#),
            "new LATIN font has the requested face"
        );
    }

    #[test]
    fn default_char_pr_excludes_the_container_tag() {
        // The container <hh:charProperties> also starts with "<hh:charPr" — the extractor must
        // NOT grab it (doing so would clone a stray container open tag into every synthesized entry).
        let header = format!(r#"<hh:charProperties itemCnt="1">{BASE}</hh:charProperties>"#);
        let base = default_char_pr(&header).expect("found a charPr");
        assert!(
            base.starts_with("<hh:charPr "),
            "must be the individual element: {base}"
        );
        assert!(
            !base.contains("charProperties"),
            "must NOT include the container tag"
        );
        assert!(base.ends_with("</hh:charPr>"));
    }

    /// PIN TEST for the embedded `Skeleton.hwpx` (the base template the from-scratch HWPX synthesizer
    /// seeds and re-enters the synth pipeline through). EVERY invariant here is load-bearing: if the
    /// template is ever regenerated and one drifts, `build_synth_plan` silently no-ops
    /// (`header_out = None`) and ALL converted content renders as 바탕글 with NO error. This test
    /// fails LOUDLY instead. (Numbers measured directly from the file, not assumed.)
    #[test]
    fn skeleton_pin_invariants() {
        let bytes = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../corpus/hwpx/Skeleton.hwpx"
        ))
        .expect("read corpus/hwpx/Skeleton.hwpx");
        let pkg = crate::package::Package::open(&bytes).expect("open Skeleton package");

        // header.xml — synth clones the DEFAULT charPr/paraPr (must be id=0) as the base for every
        // synthesized entry; appends new entries at max_pool_id+1 (so we pin the MAX id, not itemCnt).
        let header = String::from_utf8(pkg.read_header().expect("Skeleton has a header")).unwrap();
        let dc = default_char_pr(&header).expect("default charPr present");
        assert!(
            dc.starts_with(r#"<hh:charPr id="0""#),
            "default charPr must be id=0: {}",
            &dc[..40.min(dc.len())]
        );
        let dp = default_para_pr(&header).expect("default paraPr present");
        assert!(
            dp.starts_with(r#"<hh:paraPr id="0""#),
            "default paraPr must be id=0"
        );

        // Pool MAX ids (char/para are 0-based contiguous → max = itemCnt-1; borderFills are {1,2}).
        assert_eq!(
            max_pool_id(&header, "charProperties"),
            6,
            "charPr ids 0..=6 (itemCnt 7)"
        );
        assert_eq!(
            max_pool_id(&header, "paraProperties"),
            19,
            "paraPr ids 0..=19 (itemCnt 20)"
        );
        assert_eq!(
            max_pool_id(&header, "borderFills"),
            2,
            "borderFill ids {{1,2}}"
        );

        // itemCnt surface — patch_pool bumps these in lockstep; the Phase-4 validator asserts
        // itemCnt == childcount, so the starting values must be exact.
        assert!(
            header.contains(r#"<hh:charProperties itemCnt="7""#),
            "charProperties itemCnt=7"
        );
        assert!(
            header.contains(r#"<hh:paraProperties itemCnt="20""#),
            "paraProperties itemCnt=20"
        );
        assert!(
            header.contains(r#"<hh:fontfaces itemCnt="7""#),
            "fontfaces itemCnt=7"
        );
        assert!(
            header.contains(r#"<hh:borderFills itemCnt="2""#),
            "borderFills itemCnt=2"
        );

        // styles pool parses and carries the default 바탕글 (named-style application reads these).
        let styles = parse_styles(&header);
        assert!(
            styles.contains_key("바탕글"),
            "styles pool parses + has 바탕글: {} keys",
            styles.len()
        );

        // section0.xml — the body patch appends before </hs:sec>; the lone stub <hp:p> carries the
        // MANDATORY <hp:secPr> (page geometry). Deleting the stub would drop the secPr → damaged file.
        let sec0 =
            String::from_utf8(pkg.read_part("Contents/section0.xml").expect("section0")).unwrap();
        assert!(
            sec0.trim_end().ends_with("</hs:sec>"),
            "section0 ends with </hs:sec>"
        );
        assert!(
            sec0.contains("<hp:secPr"),
            "section0 stub carries the mandatory secPr"
        );
    }
}
