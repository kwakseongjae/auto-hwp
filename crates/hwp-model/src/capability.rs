//! Capability traits — the swap points. Each external capability sits behind one
//! of these. rhwp and our own crates are interchangeable implementations.
//! See `docs/DEPENDENCY-STRATEGY.md` (§1 capability boundary, §2 replaceability ladder).

use crate::document::SemanticDoc;
use crate::error::Result;
use crate::layout::{LayoutResult, PageLayerTree};
use crate::types::SourceFormat;

/// bytes → SemanticDoc.
pub trait DocumentParser {
    fn can_parse(&self, fmt: SourceFormat) -> bool;
    fn parse(&self, bytes: &[u8], fmt: SourceFormat) -> Result<SemanticDoc>;
}

/// SemanticDoc + fonts → line segments / pagination.
pub trait LayoutEngine {
    fn layout(&self, doc: &SemanticDoc, fonts: &dyn FontMetricsProvider) -> Result<LayoutResult>;
}

/// LayoutResult → paint IR (consumed by a `PaintSink` backend).
pub trait Renderer {
    fn page_layer_tree(&self, layout: &LayoutResult, page: usize) -> Result<PageLayerTree>;
}

/// SemanticDoc → .hwpx bytes. **Always ours** (rhwp's serializer is Hancom-incompatible).
/// Implementations MUST do dirty-only re-serialization (untouched parts byte-verbatim).
pub trait HwpxSerializer {
    fn serialize(&self, doc: &SemanticDoc) -> Result<Vec<u8>>;
    /// Hancom-strict editor-open safety gate (PR#40 triad + structural checks).
    fn validate_open_safety(&self, bytes: &[u8]) -> SafetyReport;
}

/// Glyph metrics — the one hard external coupling of the layout engine.
/// Inject explicitly; pin fonts in golden tests so layout is reproducible.
#[derive(Clone, Debug)]
pub struct FontKey {
    pub family: String,
    pub bold: bool,
    pub italic: bool,
}

pub trait FontMetricsProvider {
    /// Advance width in HWPUNIT. 자간/장평 are applied by the layout engine on top.
    fn advance_width(&self, font: &FontKey, ch: char, size_hwpunit: i32) -> f64;

    /// Natural line height in HWPUNIT for a line whose tallest glyph is `size_hwpunit` (EM) — the
    /// box the layout engine stacks before applying the paragraph's percent line-spacing. The
    /// DEFAULT is the flat EM (`size_hwpunit`), matching the historical approximation; a real shaper
    /// overrides this with the font's `ascent + descent + line_gap` so rows match the actual face
    /// (Korean faces run ~1.15–1.3 EM, which is why flat-EM rows paginate a touch too tight).
    fn line_height(&self, size_hwpunit: i32) -> f64 {
        size_hwpunit.max(1) as f64
    }
}

/// Result of the editor-open-safety acceptance gate.
#[derive(Clone, Debug, Default)]
pub struct SafetyReport {
    pub ok: bool,
    /// Blocking issues (each individually causes Hancom to reject the file).
    pub blocking: Vec<String>,
    /// Non-blocking compatibility hints (esp. macOS Hancom).
    pub warnings: Vec<String>,
}
