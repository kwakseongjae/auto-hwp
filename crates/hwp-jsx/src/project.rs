//! `JsxCssProject` — the on-disk projection of a `SemanticDoc` (§3.5).
//!
//! `document` + `sections` are the JSX-content tree; `styles` is the CSS-design
//! stylesheet; `manifest` is the **lossless side channel** (project.json) holding
//! everything that is neither content nor design — `Provenance.raw`, `Passthrough`,
//! `BinData`, per-section `PageSetup`, header pools, and the per-node un-modeled
//! attributes (`ParaSource`, `char_ref`) — so round-trip is byte/value exact.

use crate::css::Stylesheet;
use crate::jsx::JsxNode;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Manifest schema version.
pub const PROJECT_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct JsxCssProject {
    pub manifest: Manifest,
    /// Root `<Document>` JSX (references the section subtrees, which we also inline).
    pub document: JsxNode,
    /// Per-section `<Section>` JSX (1:1 with `SemanticDoc::sections`).
    pub sections: Vec<JsxNode>,
    /// The deduped CSS class pool (`document.css`) + tag base rules.
    pub styles: Stylesheet,
    /// Extracted binaries (`assets/`), base64-encoded in the manifest for the in-memory project.
    pub assets: Vec<Asset>,
    /// Which on-disk files were re-written by the last edit (dirty-only emit).
    pub dirty: DirtySet,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct DirtySet {
    pub document_jsx: bool,
    pub document_css: bool,
    pub sections: Vec<usize>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Asset {
    pub bin_ref: String,
    pub kind: String,
    /// base64 of the bytes.
    pub b64: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Manifest {
    pub schema_version: u32,
    /// Document-level passthrough parts (base64), e.g. the whole original HWPX (`hwpx:source`).
    pub doc_passthrough: Vec<RawPartBlob>,
    /// The char/para pools (full typed shapes) — index N ↔ class `.cN`/`.pN`.
    pub char_shapes: Vec<ShapeBlob>,
    pub para_shapes: Vec<ShapeBlob>,
    /// Original header.xml pools (read-only, keyed by XML id).
    pub header_char: BTreeMap<u64, ShapeBlob>,
    pub header_para: BTreeMap<u64, ShapeBlob>,
    /// Per-section side data (page setup, provenance.raw, passthrough, decorations, dirty).
    pub sections: Vec<SectionMeta>,
    /// Asset (bin_ref, kind) records — bytes live in `assets/` on disk; kind here.
    pub asset_meta: Vec<AssetMeta>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AssetMeta {
    pub bin_ref: String,
    pub kind: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RawPartBlob {
    pub tag: String,
    pub b64: String,
}

/// A typed shape carried losslessly (serde_json of the mirror struct in `map`).
pub type ShapeBlob = String;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SectionMeta {
    pub page: PageSetupBlob,
    pub page_edited: bool,
    /// base64 of `Section.provenance.raw` (the original section XML), or None.
    pub provenance_raw_b64: Option<String>,
    pub provenance_source: Option<String>,
    pub passthrough: Vec<RawPartBlob>,
    pub dirty: bool,
    pub decorations: Vec<DecorationBlob>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct PageSetupBlob {
    pub width: i32,
    pub height: i32,
    pub margin_left: i32,
    pub margin_right: i32,
    pub margin_top: i32,
    pub margin_bottom: i32,
    pub landscape: bool,
    pub columns: u8,
}

impl Default for PageSetupBlob {
    fn default() -> Self {
        let p = hwp_model::document::PageSetup::default();
        PageSetupBlob::from(&p)
    }
}

impl From<&hwp_model::document::PageSetup> for PageSetupBlob {
    fn from(p: &hwp_model::document::PageSetup) -> Self {
        PageSetupBlob {
            width: p.width,
            height: p.height,
            margin_left: p.margin_left,
            margin_right: p.margin_right,
            margin_top: p.margin_top,
            margin_bottom: p.margin_bottom,
            landscape: p.landscape,
            columns: p.columns,
        }
    }
}

impl From<PageSetupBlob> for hwp_model::document::PageSetup {
    fn from(b: PageSetupBlob) -> Self {
        hwp_model::document::PageSetup {
            width: b.width,
            height: b.height,
            margin_left: b.margin_left,
            margin_right: b.margin_right,
            margin_top: b.margin_top,
            margin_bottom: b.margin_bottom,
            landscape: b.landscape,
            columns: b.columns,
        }
    }
}

/// A header/footer decoration carried as raw JSON of its block subtree, base64'd.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DecorationBlob {
    pub kind: String,
    pub apply: String,
    /// JSON of the decoration's blocks (reuses the inline block encoder in `lib`).
    pub blocks_json: String,
}
