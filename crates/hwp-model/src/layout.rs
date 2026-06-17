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

#[derive(Clone, Debug)]
pub enum PaintOp {
    Glyph { x: f64, y: f64, ch: char, size: f64 },
    Rect { x: f64, y: f64, w: f64, h: f64 },
    Image { x: f64, y: f64, w: f64, h: f64, bin_ref: String },
}

/// A render sink (Canvas/WebGL/SVG/Skia) that replays a `PageLayerTree`.
pub trait PaintSink {
    fn paint(&mut self, op: &PaintOp);
}
