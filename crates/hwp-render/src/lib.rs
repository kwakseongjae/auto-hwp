//! Rendering: LayoutResult → paint IR (`PageLayerTree`, schemaVersion 1), then a
//! `PaintSink` backend (Canvas/WebGL on web, Skia for offline golden rasters).
//!
//! Phase 0: a null renderer (asserts the schema-version pin). Real paint lands with
//! the typeset engine (Phase 1–2).

use hwp_model::prelude::*;

#[derive(Default)]
pub struct NullRenderer;

impl Renderer for NullRenderer {
    fn page_layer_tree(&self, layout: &LayoutResult, page: usize) -> Result<PageLayerTree> {
        let p = layout
            .pages
            .get(page)
            .ok_or(Error::Other("page out of range".into()))?;
        Ok(PageLayerTree {
            schema_version: PAINT_SCHEMA_VERSION,
            width: p.width,
            height: p.height,
            ops: Vec::new(),
        })
    }
}

/// A trivial sink that counts paint ops — useful for tests/diagnostics.
#[derive(Default)]
pub struct CountingSink {
    pub count: usize,
}

impl PaintSink for CountingSink {
    fn paint(&mut self, _op: &PaintOp) {
        self.count += 1;
    }
}
