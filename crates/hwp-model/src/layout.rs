//! Layout result + paint IR contract.
//!
//! The render contract is the **paint IR** (`PageLayerTree`), pinned to schema
//! version 1 (rhwp's PageLayerTree is additive-only at schemaVersion 1). We consume
//! the layer tree — NOT rhwp's SVG string — so our canvas owns paint and the
//! typography subsystem stays separable.

/// Result of a `LayoutEngine` pass: pages of positioned line segments.
#[derive(Clone, Debug, Default)]
pub struct LayoutResult {
    pub pages: Vec<PageLayout>,
}

#[derive(Clone, Debug, Default)]
pub struct PageLayout {
    pub width: f64,
    pub height: f64,
    pub lines: Vec<LineSeg>,
}

/// One laid-out line. Mirrors HWP's `ParaLineSeg` / OWPML `<hp:lineseg>` so we can
/// (a) replay originals for read-only fidelity and (b) diff against our own output.
/// NOTE: linesegarray is *non-standard* layout cache (Hancom recomputes on open);
/// never treat it as the line-break source of truth (PLAN §3.1).
#[derive(Clone, Debug, Default)]
pub struct LineSeg {
    pub text_pos: u32,
    pub vert_pos: f64,
    pub vert_size: f64,
    pub text_height: f64,
    pub baseline: f64,
    pub horz_pos: f64,
    pub horz_size: f64,
}

/// We pin the paint IR to this schema version and assert on it (additive-only).
pub const PAINT_SCHEMA_VERSION: u32 = 1;

/// Resolution-independent paint IR (page-top-left, px). Every render backend
/// (Canvas/WebGL/Skia) replays this — guaranteeing screen == export.
#[derive(Clone, Debug)]
pub struct PageLayerTree {
    pub schema_version: u32,
    pub width: f64,
    pub height: f64,
    pub ops: Vec<PaintOp>,
}

impl Default for PageLayerTree {
    fn default() -> Self {
        PageLayerTree {
            schema_version: PAINT_SCHEMA_VERSION,
            width: 0.0,
            height: 0.0,
            ops: Vec::new(),
        }
    }
}

/// One paint primitive in page-top-left coordinates (HWPUNIT — backends scale to device px).
///
/// Schema v1 is additive-only: `Glyph` carries a `color` and `Rect` a `fill` (added with the own
/// renderer); both default sensibly (`Color::default()` = opaque black, `fill: None` = a stroked
/// outline) so older producers/consumers stay valid.
#[derive(Clone, Debug)]
pub enum PaintOp {
    /// A single glyph: `(x, baseline)` left edge + baseline, the `ch`, EM `size`, text `color`, and
    /// `bold` (the run's weight — backends pick a bold face / font-weight). `bold` is additive: older
    /// producers leave it `false` (regular), so the schema stays v1-compatible.
    Glyph { x: f64, y: f64, ch: char, size: f64, color: crate::types::Color, bold: bool },
    /// A box: `fill = Some(color)` paints a filled rect (shading); `None` strokes the outline
    /// (cell/line border).
    Rect { x: f64, y: f64, w: f64, h: f64, fill: Option<crate::types::Color> },
    /// An embedded image/object box referencing `bin_ref` into `SemanticDoc::bin_data` (empty for an
    /// equation/unknown-object placeholder, which a backend draws as a stub box).
    Image { x: f64, y: f64, w: f64, h: f64, bin_ref: String },
}

/// A render sink (Canvas/WebGL/SVG/Skia) that replays a `PageLayerTree`.
pub trait PaintSink {
    fn paint(&mut self, op: &PaintOp);
}
