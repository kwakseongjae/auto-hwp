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

/// Content hash for cache keying (std SipHash) — O(n) over the bytes but far cheaper than a parse.
#[cfg(feature = "rhwp")]
fn content_hash(bytes: &[u8]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h);
    h.finish()
}

/// **Engine seam 1 — persistent layout cache.** Holds ONE parsed `DocumentCore` across render
/// calls so scrolling a multi-page document does not re-parse + re-lay-out the whole file on every
/// page (today `render_page_svg`/`page_count` rebuild from bytes each call). Keyed by a content hash
/// of the input bytes; an edit (new bytes) re-parses exactly once, after which rhwp's internal
/// per-page render-tree cache makes subsequent pages cheap. `DocumentCore` is owned + `Send`, so a
/// caller (e.g. an MCP session) can hold this across calls.
#[cfg(feature = "rhwp")]
#[derive(Default)]
pub struct RenderCache {
    cached: Option<(u64, rhwp::DocumentCore)>,
    parses: usize,
}

#[cfg(feature = "rhwp")]
impl RenderCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Number of full parses performed (telemetry/test: stays 1 across all pages of one document).
    pub fn parses(&self) -> usize {
        self.parses
    }

    fn core_for(&mut self, bytes: &[u8]) -> Result<&rhwp::DocumentCore> {
        let h = content_hash(bytes);
        if !matches!(&self.cached, Some((ch, _)) if *ch == h) {
            let core =
                rhwp::DocumentCore::from_bytes(bytes).map_err(|e| Error::Parse(e.to_string()))?;
            self.cached = Some((h, core));
            self.parses += 1;
        }
        Ok(&self.cached.as_ref().expect("cache just populated").1)
    }

    pub fn page_count(&mut self, bytes: &[u8]) -> Result<u32> {
        Ok(self.core_for(bytes)?.page_count())
    }

    pub fn render_page_svg(&mut self, bytes: &[u8], page: u32) -> Result<String> {
        let svg = self
            .core_for(bytes)?
            .render_page_svg_native(page)
            .map_err(|e| Error::Other(e.to_string()))?;
        Ok(unclip_borders(&svg))
    }

    /// Text anchors for a page (engine seam 2), reusing the cached parsed core.
    pub fn text_anchors(&mut self, bytes: &[u8], page: u32) -> Result<Vec<TextAnchor>> {
        let core = self.core_for(bytes)?;
        anchors_from_core(core, page)
    }
}

/// **Engine seam 2 — stable model↔IR edit anchor.** A text run from rhwp's paint IR carrying a
/// STABLE model key (`section:N/para:M/char:O[/cell:…]`) plus its text. This is the basis of
/// click-to-edit: a rendered glyph run resolves (via its `source.id`) to one of these, whose key
/// maps back to a `hwp_ops` target in the semantic model. The key is deterministic (not a
/// render-pass-random id), so it survives re-render.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextAnchor {
    /// rhwp's `TextSourceId` for this run (a glyph run's `source.id` indexes back to it).
    pub source_id: u32,
    /// Stable model key `section:N/para:M/char:O[/cell:…]`, or `None` for an unanchored run.
    pub stable_key: Option<String>,
    pub text: String,
}

/// Extract a page's text-source anchors from rhwp's `build_page_layer_tree` paint IR (seam 2).
#[cfg(feature = "rhwp")]
pub fn page_text_anchors(bytes: &[u8], page: u32) -> Result<Vec<TextAnchor>> {
    let core = rhwp::DocumentCore::from_bytes(bytes).map_err(|e| Error::Parse(e.to_string()))?;
    anchors_from_core(&core, page)
}

#[cfg(feature = "rhwp")]
fn anchors_from_core(core: &rhwp::DocumentCore, page: u32) -> Result<Vec<TextAnchor>> {
    let tree = core.build_page_layer_tree(page).map_err(|e| Error::Other(e.to_string()))?;
    Ok(tree
        .text_sources
        .entries
        .iter()
        .map(|e| TextAnchor {
            source_id: e.id.0,
            stable_key: e.stable_source_key.clone(),
            text: e.text.clone(),
        })
        .collect())
}

#[cfg(not(feature = "rhwp"))]
pub fn page_text_anchors(_bytes: &[u8], _page: u32) -> Result<Vec<TextAnchor>> {
    Err(Error::CapabilityUnavailable(NOT_WIRED))
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

#[cfg(all(test, feature = "rhwp"))]
mod spike_tests {
    //! P0 de-risking spikes for the two engine seams the GUI plan gates on.
    use super::{page_count, page_text_anchors, render_page_svg, RenderCache};

    fn benchmark() -> Vec<u8> {
        let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../../benchmark.hwp");
        std::fs::read(p).expect("benchmark.hwp at repo root")
    }

    /// SEAM 1: one parse renders every page, and cached output is byte-identical to the stateless
    /// path — i.e. the cache is a pure speedup, and virtualized scrolling stops re-parsing per page.
    #[test]
    fn render_cache_parses_once_and_matches_stateless() {
        let bytes = benchmark();
        let n = page_count(&bytes).unwrap();
        assert!(n > 0, "benchmark renders at least one page");

        let mut cache = RenderCache::new();
        assert_eq!(cache.page_count(&bytes).unwrap(), n);
        for p in 0..n {
            let stateless = render_page_svg(&bytes, p).unwrap();
            let cached = cache.render_page_svg(&bytes, p).unwrap();
            assert_eq!(cached, stateless, "page {p}: cached SVG must equal the stateless render");
        }
        // The whole document was parsed exactly ONCE for page_count + all N pages.
        assert_eq!(cache.parses(), 1, "persistent layout cache parses the document once");
    }

    /// SEAM 2: the paint IR exposes per-run STABLE model keys (section/para/char) that survive a
    /// re-parse — the anchor needed to map a rendered glyph back to a hwp_ops edit target.
    #[test]
    fn text_anchors_are_model_keyed_and_stable() {
        let bytes = benchmark();
        let a1 = page_text_anchors(&bytes, 0).unwrap();
        assert!(!a1.is_empty(), "page 0 exposes text-source anchors");

        let keyed: Vec<&str> = a1.iter().filter_map(|a| a.stable_key.as_deref()).collect();
        assert!(
            keyed.iter().any(|k| k.contains("section:") && k.contains("para:") && k.contains("char:")),
            "at least one run anchors to a model position; keys: {keyed:?}"
        );

        // Deterministic across a fresh parse (the key is stable, not a render-pass-random id).
        let a2 = page_text_anchors(&bytes, 0).unwrap();
        assert_eq!(a1, a2, "anchors are stable across re-parse");
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

#[cfg(all(test, feature = "rhwp"))]
mod spike_timing {
    use super::{render_page_svg, RenderCache};
    use std::time::Instant;

    #[test]
    #[ignore = "timing illustration; run with --ignored --nocapture"]
    fn seam1_speedup() {
        let bytes = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../benchmark.hwp")).unwrap();
        let n = super::page_count(&bytes).unwrap();
        let t0 = Instant::now();
        for p in 0..n { let _ = render_page_svg(&bytes, p).unwrap(); }
        let stateless = t0.elapsed();
        let mut cache = RenderCache::new();
        let t1 = Instant::now();
        for p in 0..n { let _ = cache.render_page_svg(&bytes, p).unwrap(); }
        let cached = t1.elapsed();
        eprintln!("SEAM1 {n} pages: stateless(re-parse each)={stateless:?}  cached(parse once)={cached:?}  speedup={:.1}x", stateless.as_secs_f64()/cached.as_secs_f64().max(1e-9));
    }
}
