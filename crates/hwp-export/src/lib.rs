//! Export the JSX+CSS projection to web-native formats.
//!
//! M1 (PIVOT framing B): [`emit_html`] turns a [`JsxCssProject`] into ONE self-contained `.html`
//! file that ANY browser renders — the BROWSER is the layout engine (D2 for the web output; we do
//! not lay it out ourselves). This is the render half of B AND the HTML export (design §6.1).
//!
//! HONESTY (design §6.5/§10): this is **semantic-reflow** — clean, accessible, re-flowable HTML,
//! NOT pixel-identical to Hancom (that is layout-preserve = the rhwp-SVG view, a separate concern).
//! Korean-specific typography that has no clean CSS equivalent (배분/나눔 정렬, 장평/자간, per-script
//! fonts, page geometry) rides on the `.cN`/`.pN` classes our codec already produced (best-effort) —
//! a raw-HTML consumer renders those approximately. Equations (HWP `eqed` script ≠ LaTeX) and
//! un-modeled `<Raw>` objects (shapes/OLE) are shown as **visible placeholders**, never silently
//! dropped and never faked via a wrong transcode. Notes' bodies are opaque (packed in the codec) →
//! a marker only. These narrow as later milestones add eqed→MathML + note-body rendering.
//!
//! SECURITY: document content is untrusted. Every text node + attribute value is escaped, URLs are
//! scheme-allowlisted, and the injected CSS is neutralized against a `</style>` breakout — so a
//! malicious `.hwp` cannot inject script into the emitted page.

use std::collections::BTreeMap;

use hwp_jsx::css::emit_css;
use hwp_jsx::jsx::{JsxElement, JsxNode, Tag};
use hwp_jsx::project::{Asset, JsxCssProject};

/// HTML emit options.
#[derive(Clone, Debug, Default)]
pub struct HtmlOptions {
    /// `<title>` (escaped). Defaults to a generic title.
    pub title: Option<String>,
}

/// A small base stylesheet so the bare semantic HTML reads like a clean document page. The project's
/// `.cN`/`.pN` class rules (more specific) layer on top and carry the real typography.
const BASE_CSS: &str = "\
*{box-sizing:border-box}\
.hwp-doc{max-width:840px;margin:2rem auto;padding:0 1.5rem;\
font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Malgun Gothic','Noto Sans KR',sans-serif;\
line-height:1.7;color:#1a1a1a;word-break:keep-all;overflow-wrap:break-word}\
.hwp-doc p{margin:0 0 .6em}\
.hwp-doc table{border-collapse:collapse;margin:1em auto;width:100%;\
font-family:'Malgun Gothic','맑은 고딕','Noto Sans KR','Apple SD Gothic Neo',sans-serif}\
.hwp-doc th,.hwp-doc td{border:1px solid #000;padding:5px 7px;vertical-align:middle;line-height:1.5}\
.hwp-doc td.hwp-th{background:#e6e6e6;font-weight:600;text-align:center}\
.hwp-doc td.hwp-label-col{background:#f0f0f0;font-weight:600}\
.hwp-doc td.hwp-th.hwp-label-col{background:#dcdcdc}\
.hwp-doc .hwp-title-box{border:1.5px solid #000;padding:8px 12px;margin:1em auto;\
text-align:center;font-weight:700;font-size:1.15em}\
.hwp-doc img{max-width:100%;height:auto}\
.hwp-section+.hwp-section{margin-top:2.5rem;border-top:1px dashed #ddd;padding-top:2.5rem}\
.hwp-eq,.hwp-raw{display:inline-block;color:#8a6d3b;background:#fcf6e3;border:1px solid #f0e3b8;\
border-radius:3px;padding:0 5px;font-size:.88em}\
.hwp-note{color:#06c;font-size:.8em;vertical-align:super}\
.hwp-header,.hwp-footer{color:#888;font-size:.85em}\
";

/// Render a [`JsxCssProject`] into one self-contained HTML document (semantic-reflow).
pub fn emit_html(proj: &JsxCssProject, opts: &HtmlOptions) -> String {
    // bin_ref → asset, for resolving <img src="assets/{bin_ref}"> to a data: URI.
    let assets: BTreeMap<&str, &Asset> =
        proj.assets.iter().map(|a| (a.bin_ref.as_str(), a)).collect();

    let mut body = String::new();
    for section in &proj.sections {
        render_node(section, &assets, &mut body);
    }

    let css = sanitize_css(&emit_css(&proj.styles));
    let title = esc_text(opts.title.as_deref().unwrap_or("tf-hwp 문서"));

    format!(
        "<!doctype html>\n<html lang=\"ko\">\n<head>\n<meta charset=\"utf-8\">\n\
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
<title>{title}</title>\n<style>\n{BASE_CSS}\n{css}</style>\n</head>\n\
<body class=\"hwp-doc\">\n{body}</body>\n</html>\n"
    )
}

// --- node rendering ---------------------------------------------------------------------------

fn render_node(node: &JsxNode, assets: &BTreeMap<&str, &Asset>, out: &mut String) {
    match node {
        JsxNode::Text(t) => out.push_str(&esc_text(&t.text)),
        JsxNode::Element(el) => render_element(el, assets, out),
    }
}

fn render_children(el: &JsxElement, assets: &BTreeMap<&str, &Asset>, out: &mut String) {
    for c in &el.children {
        render_node(c, assets, out);
    }
}

/// Wrap the element's children in `<tag …attrs>`…`</tag>`.
fn wrap(el: &JsxElement, tag: &str, extra: &str, assets: &BTreeMap<&str, &Asset>, out: &mut String) {
    out.push('<');
    out.push_str(tag);
    out.push_str(&class_attr(&el.class_list));
    out.push_str(extra);
    out.push('>');
    render_children(el, assets, out);
    out.push_str("</");
    out.push_str(tag);
    out.push('>');
}

fn render_element(el: &JsxElement, assets: &BTreeMap<&str, &Asset>, out: &mut String) {
    match el.tag() {
        Some(Tag::Section) => {
            out.push_str("<section class=\"hwp-section");
            for c in &el.class_list {
                out.push(' ');
                out.push_str(&esc_attr(c));
            }
            out.push_str("\">");
            render_children(el, assets, out);
            out.push_str("</section>");
        }
        Some(Tag::Para) => wrap(el, "p", &id_attr(el), assets, out),
        Some(Tag::Run) | Some(Tag::Span) => wrap(el, "span", "", assets, out),
        Some(Tag::Table) => render_table(el, assets, out),
        // TableRow/TableCell are rendered by render_table (the codec emits cells FLAT under Table
        // with data-row/data-col); a stray one outside a Table just renders its children.
        Some(Tag::TableRow) | Some(Tag::TableCell) => render_children(el, assets, out),
        Some(Tag::Image) => render_image(el, assets, out),
        Some(Tag::Equation) => out.push_str("<span class=\"hwp-eq\" title=\"수식\">[수식]</span>"),
        Some(Tag::Field) => {
            // FieldBegin/FieldEnd are inline MARKERS (no children); the linked text lives in the
            // sibling runs and renders normally. M1 does not yet pair markers into a clickable <a>
            // (a stateful paragraph walk) — the text is preserved, just not yet a live link.
            render_children(el, assets, out);
        }
        Some(Tag::Note) => out.push_str("<sup class=\"hwp-note\" title=\"주석\">※</sup>"),
        Some(Tag::Bookmark) => {
            if let Some(name) = el.attrs.get("data-name") {
                out.push_str(&format!("<a id=\"{}\" class=\"hwp-bookmark\"></a>", esc_attr(name)));
            }
        }
        Some(Tag::Header) => wrap(el, "header", "", assets, out),
        Some(Tag::Footer) => wrap(el, "footer", "", assets, out),
        Some(Tag::Page) => wrap(el, "div", " data-page", assets, out),
        Some(Tag::Raw) => {
            let tag = el.attrs.get("data-tag").map(String::as_str).unwrap_or("object");
            out.push_str(&format!(
                "<span class=\"hwp-raw\" title=\"{}\">[{}]</span>",
                esc_attr(tag),
                esc_text(tag)
            ));
        }
        // Document wrapper (shouldn't appear in `sections`) or an unknown tag → render children so
        // no content is ever lost.
        Some(Tag::Document) | None => render_children(el, assets, out),
    }
}

/// Render a table from the codec's FLAT cell list: group cells by their `data-row` into real `<tr>`
/// rows (ascending row index), drop covered (`data-inactive`) cells, honor colspan/rowspan + shade,
/// and — when the codec carries `data-colw` (per-column widths in px) — emit a `<colgroup>` with
/// `table-layout:fixed` so the column proportions match the original.
fn render_table(el: &JsxElement, assets: &BTreeMap<&str, &Asset>, out: &mut String) {
    let mut rows: BTreeMap<usize, Vec<&JsxElement>> = BTreeMap::new();
    for child in &el.children {
        if let JsxNode::Element(cell) = child {
            if cell.tag() == Some(Tag::TableCell) {
                let r = cell.attrs.get("data-row").and_then(|s| s.parse().ok()).unwrap_or(0usize);
                rows.entry(r).or_default().push(cell);
            }
        }
    }

    // Per-column widths (HWPUNIT) → px (1in = 7200 HWPUNIT = 96px ⇒ px = hwpunit/75) give the table
    // its real column proportions (table-layout:fixed + a <colgroup>), so it matches the original
    // instead of the browser's content-based auto-sizing.
    let cols_px: Vec<f64> = el
        .attrs
        .get("data-colw")
        .map(|w| w.split(',').filter_map(|v| v.parse::<f64>().ok()).map(|h| h / 75.0).collect())
        .unwrap_or_default();

    out.push_str("<table");
    out.push_str(&class_attr(&el.class_list));
    if !cols_px.is_empty() {
        let total: f64 = cols_px.iter().sum();
        out.push_str(&format!(" style=\"table-layout:fixed;width:{total:.0}px\""));
    }
    out.push('>');
    if !cols_px.is_empty() {
        out.push_str("<colgroup>");
        for w in &cols_px {
            out.push_str(&format!("<col style=\"width:{w:.0}px\">"));
        }
        out.push_str("</colgroup>");
    }
    for cells in rows.values() {
        out.push_str("<tr>");
        for cell in cells {
            if cell.attrs.contains_key("data-inactive") {
                continue; // covered cell — represented by the spanning cell's span
            }
            // Position-derived design classes (Korean gov-doc convention): the top header row and the
            // left label column are shaded gray. Computed from structural indices at RENDER time —
            // never written into the JSX content — so content(JSX)/design(CSS) separation holds.
            let r = cell.attrs.get("data-row").and_then(|s| s.parse::<usize>().ok()).unwrap_or(0);
            let c0 = cell.attrs.get("data-col").and_then(|s| s.parse::<usize>().ok()).unwrap_or(0);
            let mut cls = String::new();
            if r == 0 {
                cls.push_str("hwp-th");
            }
            if c0 == 0 {
                if !cls.is_empty() {
                    cls.push(' ');
                }
                cls.push_str("hwp-label-col");
            }
            out.push_str("<td");
            if !cls.is_empty() {
                out.push_str(&format!(" class=\"{cls}\""));
            }
            if let Some(cs) = cell.attrs.get("colSpan") {
                out.push_str(&format!(" colspan=\"{}\"", esc_attr(cs)));
            }
            if let Some(rs) = cell.attrs.get("rowSpan") {
                out.push_str(&format!(" rowspan=\"{}\"", esc_attr(rs)));
            }
            // A real model shade (data-shade) is an INLINE background that wins over the class gray.
            if let Some(shade) = cell.attrs.get("data-shade") {
                out.push_str(&format!(" style=\"background:{}\"", esc_attr(shade)));
            }
            out.push('>');
            render_children(cell, assets, out);
            out.push_str("</td>");
        }
        out.push_str("</tr>");
    }
    out.push_str("</table>");
}

fn render_image(el: &JsxElement, assets: &BTreeMap<&str, &Asset>, out: &mut String) {
    // src = "assets/{bin_ref}"; resolve to a data: URI from the embedded asset.
    let bin_ref = el
        .attrs
        .get("src")
        .and_then(|s| s.strip_prefix("assets/"))
        .unwrap_or("");
    let Some(asset) = assets.get(bin_ref) else {
        // No bytes → a visible placeholder, never a broken <img>.
        out.push_str("<span class=\"hwp-raw\" title=\"image\">[이미지]</span>");
        return;
    };
    out.push_str(&format!(
        "<img alt=\"\" src=\"data:{};base64,{}\">",
        mime_for(&asset.kind),
        // b64 is base64 our codec produced (safe charset); keep it out of the attribute-escape path.
        asset.b64
    ));
}

fn mime_for(kind: &str) -> &'static str {
    match kind.trim_start_matches('.').to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

// --- attributes -------------------------------------------------------------------------------

fn class_attr(classes: &[String]) -> String {
    if classes.is_empty() {
        return String::new();
    }
    let joined = classes.iter().map(|c| esc_attr(c)).collect::<Vec<_>>().join(" ");
    format!(" class=\"{joined}\"")
}

fn id_attr(el: &JsxElement) -> String {
    match &el.id {
        Some(id) => format!(" id=\"{}\"", esc_attr(id)),
        None => String::new(),
    }
}

// --- escaping (untrusted document content) ----------------------------------------------------

/// Escape text-node content. `<` → `&lt;` neutralizes any `<script>` etc. in document text.
fn esc_text(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            _ => o.push(c),
        }
    }
    o
}

/// Escape an attribute value (adds `"` on top of text escaping).
fn esc_attr(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            _ => o.push(c),
        }
    }
    o
}

/// Neutralize the only HTML breakout vector from inside a `<style>` block — a literal `</style>` (or
/// `</script>`) sequence in a CSS value (e.g. a crafted font-family). `<` is never valid raw CSS, so
/// replacing it with its CSS escape `\3c ` is lossless for legitimate CSS. Also strip the classic
/// dynamic-CSS vectors.
fn sanitize_css(css: &str) -> String {
    css.replace('<', "\\3c ")
        .replace("expression(", "/*x*/(")
        .replace("javascript:", "/*x*/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use hwp_jsx::emit;
    use hwp_model::prelude::*;

    fn html_of(doc: &SemanticDoc) -> String {
        emit_html(&emit(doc), &HtmlOptions::default())
    }

    fn doc_with_para(runs: Vec<Run>) -> SemanticDoc {
        let mut doc = SemanticDoc::default();
        doc.char_shapes.push(CharShape::default());
        doc.para_shapes.push(ParaShape::default());
        let para = Paragraph { id: Some(NodeId(1)), runs, ..Default::default() };
        doc.sections.push(Section { blocks: vec![Block::Paragraph(para)], ..Default::default() });
        doc
    }

    #[test]
    fn well_formed_shell_and_paragraph() {
        let doc = doc_with_para(vec![Run {
            char_shape: 0,
            char_ref: None,
            content: vec![Inline::Text("안녕하세요".into())],
        }]);
        let html = html_of(&doc);
        assert!(html.starts_with("<!doctype html>"));
        assert!(html.contains("<style>") && html.contains("</style>"));
        assert!(html.contains("<body class=\"hwp-doc\">"));
        assert!(html.contains("안녕하세요"));
        assert!(html.contains("<p")); // the paragraph rendered
        assert!(html.trim_end().ends_with("</html>"));
    }

    #[test]
    fn xss_in_document_text_is_escaped_not_executed() {
        let doc = doc_with_para(vec![Run {
            char_shape: 0,
            char_ref: None,
            content: vec![Inline::Text("<script>alert(1)</script> & <b>x".into())],
        }]);
        let html = html_of(&doc);
        assert!(!html.contains("<script>alert(1)</script>"), "raw script must not survive");
        assert!(html.contains("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;b&gt;x"));
    }

    #[test]
    fn malicious_font_family_cannot_break_out_of_style() {
        // A crafted font name carrying a </style> breakout must be neutralized in the <style> block.
        let mut doc = SemanticDoc::default();
        doc.char_shapes.push(CharShape::default());
        doc.char_shapes.push(CharShape {
            fonts: vec![Some("evil</style><script>alert(1)</script>".into())],
            ..Default::default()
        });
        doc.para_shapes.push(ParaShape::default());
        let para = Paragraph {
            id: Some(NodeId(1)),
            runs: vec![Run { char_shape: 1, char_ref: None, content: vec![Inline::Text("x".into())] }],
            ..Default::default()
        };
        doc.sections.push(Section { blocks: vec![Block::Paragraph(para)], ..Default::default() });
        let html = html_of(&doc);
        // The only legitimate </style> is the one we emit to close the block.
        assert_eq!(html.matches("</style>").count(), 1, "no injected </style> breakout");
        assert!(!html.contains("<script>alert(1)</script>"));
    }

    #[test]
    fn deterministic() {
        let doc = doc_with_para(vec![Run {
            char_shape: 0,
            char_ref: None,
            content: vec![Inline::Text("결정적".into())],
        }]);
        assert_eq!(html_of(&doc), html_of(&doc));
    }

    #[test]
    fn table_merged_cell_omitted_spanning_cell_keeps_span() {
        let mut doc = SemanticDoc::default();
        doc.char_shapes.push(CharShape::default());
        doc.para_shapes.push(ParaShape::default());
        let mut t = Table { rows: 1, cols: 2, ..Default::default() };
        t.cells.push(Cell { row: 0, col: 0, col_span: 2, row_span: 1, active: true, ..Default::default() });
        t.cells.push(Cell { row: 0, col: 1, col_span: 1, row_span: 1, active: false, ..Default::default() });
        doc.sections.push(Section { blocks: vec![Block::Table(t)], ..Default::default() });
        let html = html_of(&doc);
        assert!(html.contains("<table"));
        assert!(html.contains("colspan=\"2\""), "spanning cell keeps its colspan");
        // exactly ONE <td> (the inactive covered cell is omitted)
        assert_eq!(html.matches("<td").count(), 1, "covered cell omitted from the HTML grid");
    }

    #[test]
    fn raw_and_equation_are_visible_placeholders_not_dropped() {
        let mut doc = SemanticDoc::default();
        doc.char_shapes.push(CharShape::default());
        doc.para_shapes.push(ParaShape::default());
        let para = Paragraph {
            id: Some(NodeId(1)),
            runs: vec![Run {
                char_shape: 0,
                char_ref: None,
                content: vec![
                    Inline::Equation(EquationRef {
                        script: "1 over 2".into(),
                        font: String::new(),
                        base_unit: 1000,
                        baseline: 0,
                        color: Color::default(),
                        width: 1000,
                        height: 1000,
                        version: String::new(),
                    }),
                    Inline::Raw(RawPart { tag: "shape".into(), bytes: vec![1, 2, 3] }),
                ],
            }],
            ..Default::default()
        };
        doc.sections.push(Section { blocks: vec![Block::Paragraph(para)], ..Default::default() });
        let html = html_of(&doc);
        assert!(html.contains("hwp-eq"), "equation shows a visible placeholder");
        assert!(html.contains("hwp-raw"), "raw object shows a visible placeholder");
    }
}
