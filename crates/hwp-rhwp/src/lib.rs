//! rhwp bootstrap adapter (in-process, single-crate path-dep).
//!
//! rhwp is a **replaceable bootstrap behind our capability traits** (docs/DEPENDENCY-STRATEGY.md).
//! With `--features rhwp` we call the vendored fork in-process: `rhwp::DocumentCore::from_bytes`
//! → `page_count()` / `render_page_svg_native()` / `build_page_layer_tree()`. Without the
//! feature, rhwp is not compiled and these report `CapabilityUnavailable` so default builds
//! stay fast and the workspace never hard-depends on the bootstrap.
//!
//! NOTE: do NOT use rhwp's HWPX/HWP save path (issue #196: Hancom rejects) — `HwpxSerializer`
//! stays in `hwp-hwpx`. rhwp here is parse + layout + render only.

use hwp_model::prelude::*;

#[cfg(feature = "rhwp")]
mod lift;

#[cfg(not(feature = "rhwp"))]
const NOT_WIRED: &str =
    "rhwp bootstrap not compiled (run scripts/vendor-rhwp.sh, then build --features rhwp)";

/// rhwp-backed engine handle.
#[derive(Default)]
pub struct RhwpEngine;

impl RhwpEngine {
    pub fn new() -> Self {
        Self
    }
    /// Whether the rhwp bootstrap is wired in this build.
    pub const fn is_available() -> bool {
        cfg!(feature = "rhwp")
    }
}

// ---- Bootstrap viewer path: bytes → page count / SVG (in-process via rhwp) ----

/// Number of laid-out pages.
#[cfg(feature = "rhwp")]
pub fn page_count(bytes: &[u8]) -> Result<u32> {
    let core = rhwp::DocumentCore::from_bytes(bytes).map_err(|e| Error::Parse(e.to_string()))?;
    Ok(core.page_count())
}

/// Render one page to SVG (faithful, via rhwp's typeset+paint pipeline).
#[cfg(feature = "rhwp")]
pub fn render_page_svg(bytes: &[u8], page: u32) -> Result<String> {
    let core = rhwp::DocumentCore::from_bytes(bytes).map_err(|e| Error::Parse(e.to_string()))?;
    let svg = core
        .render_page_svg_native(page)
        .map_err(|e| Error::Other(e.to_string()))?;
    Ok(unclip_borders(&svg))
}

/// Fix edge-coincident borders being clipped away. rhwp wraps body/cell content in
/// `<g clip-path>` whose `<rect>` left edge sits at exactly the table's left border x; a 0.5px
/// stroke centered there is half-clipped (→ the left border looks missing). We expand every
/// clipPath rect outward by 1px so boundary strokes render fully. Cell text has interior padding
/// (~6px), so a 1px expansion never bleeds neighbor content.
#[cfg(feature = "rhwp")]
fn unclip_borders(svg: &str) -> String {
    const PAD: f64 = 1.0;
    let mut out = String::with_capacity(svg.len() + 256);
    let mut rest = svg;
    while let Some(cp) = rest.find("<clipPath") {
        let Some(open_end) = rest[cp..].find('>').map(|i| cp + i + 1) else {
            break;
        };
        // copy through the <clipPath …> open tag
        out.push_str(&rest[..open_end]);
        rest = &rest[open_end..];
        // the immediately following <rect …/> is the clip region — expand it outward
        if let Some(rs) = rest.find("<rect") {
            if let Some(re) = rest[rs..].find("/>").map(|i| rs + i + 2) {
                out.push_str(&rest[..rs]);
                out.push_str(&expand_rect(&rest[rs..re], PAD));
                rest = &rest[re..];
                continue;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Expand a `<rect x y width height/>` outward by `pad` on every side (right/bottom edges fixed
/// relative to the larger box). Returns the tag unchanged if any attribute is missing.
#[cfg(feature = "rhwp")]
fn expand_rect(tag: &str, pad: f64) -> String {
    let attr = |name: &str| -> Option<f64> {
        let pat = format!("{name}=\"");
        let s = tag.find(&pat)? + pat.len();
        let e = tag[s..].find('"')? + s;
        tag[s..e].parse().ok()
    };
    match (attr("x"), attr("y"), attr("width"), attr("height")) {
        (Some(x), Some(y), Some(w), Some(h)) => format!(
            "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\"/>",
            x - pad,
            y - pad,
            w + 2.0 * pad,
            h + 2.0 * pad
        ),
        _ => tag.to_string(),
    }
}

#[cfg(all(test, feature = "rhwp"))]
mod unclip_tests {
    use super::{expand_rect, unclip_borders};

    #[test]
    fn expands_clip_rect_outward() {
        let got = unclip_borders(
            r#"<defs><clipPath id="c"><rect x="75.5" y="94.0" width="640.0" height="900.0"/></clipPath></defs>"#,
        );
        // left/top moved out by 1, size grew by 2 → boundary strokes no longer clipped
        assert!(got.contains(r#"<rect x="74.5" y="93" width="642" height="902"/>"#), "{got}");
    }

    #[test]
    fn leaves_non_clip_rects_untouched() {
        // a content fill rect (not in a clipPath) must NOT be expanded
        let svg = r##"<rect x="10" y="10" width="5" height="5" fill="#ccc"/>"##;
        assert_eq!(unclip_borders(svg), svg);
    }

    #[test]
    fn expand_rect_handles_missing_attrs() {
        assert_eq!(expand_rect(r#"<rect x="1"/>"#, 1.0), r#"<rect x="1"/>"#);
    }
}

#[cfg(not(feature = "rhwp"))]
pub fn page_count(_bytes: &[u8]) -> Result<u32> {
    Err(Error::CapabilityUnavailable(NOT_WIRED))
}

#[cfg(not(feature = "rhwp"))]
pub fn render_page_svg(_bytes: &[u8], _page: u32) -> Result<String> {
    Err(Error::CapabilityUnavailable(NOT_WIRED))
}

// ---- Capability traits ----
// can_parse reflects availability; the full SemanticDoc lift (rhwp Document → our AST with
// provenance/passthrough) and PageLayerTree mapping are the continuing M1 work.

impl DocumentParser for RhwpEngine {
    fn can_parse(&self, _fmt: SourceFormat) -> bool {
        cfg!(feature = "rhwp")
    }

    fn parse(&self, bytes: &[u8], _fmt: SourceFormat) -> Result<SemanticDoc> {
        #[cfg(feature = "rhwp")]
        {
            lift::parse_to_semantic(bytes)
        }
        #[cfg(not(feature = "rhwp"))]
        {
            let _ = bytes;
            Err(Error::CapabilityUnavailable(NOT_WIRED))
        }
    }
}

impl LayoutEngine for RhwpEngine {
    fn layout(&self, _doc: &SemanticDoc, _fonts: &dyn FontMetricsProvider) -> Result<LayoutResult> {
        #[cfg(feature = "rhwp")]
        {
            Err(Error::NotImplemented("rhwp LayoutEngine mapping (M1 cont.)"))
        }
        #[cfg(not(feature = "rhwp"))]
        {
            Err(Error::CapabilityUnavailable(NOT_WIRED))
        }
    }
}

impl Renderer for RhwpEngine {
    fn page_layer_tree(&self, _layout: &LayoutResult, _page: usize) -> Result<PageLayerTree> {
        // rhwp exposes DocumentCore::build_page_layer_tree(page) (paint IR, schemaVersion 1);
        // mapping rhwp::paint::PageLayerTree → our PageLayerTree is the next render step.
        #[cfg(feature = "rhwp")]
        {
            Err(Error::NotImplemented("rhwp PageLayerTree → ours mapping (M1 cont.)"))
        }
        #[cfg(not(feature = "rhwp"))]
        {
            Err(Error::CapabilityUnavailable(NOT_WIRED))
        }
    }
}
