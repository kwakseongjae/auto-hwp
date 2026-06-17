//! HWPX (OWPML / KS X 6101) support.
//!
//! Phase 0 ships: container reading (ZIP/OPC), part listing, mimetype check, and
//! `<hp:t>` text extraction from `Contents/section*.xml`. Full OWPML→SemanticDoc
//! parsing and the dirty-only serializer are scaffolded in [`export`] and grow next.

pub mod export;
pub mod package;
pub mod parse;
pub mod serialize;
pub mod synth;
pub mod text;

use hwp_model::prelude::*;

/// HWPX parser implementing the [`DocumentParser`] capability.
#[derive(Default)]
pub struct HwpxParser;

impl HwpxParser {
    pub fn new() -> Self {
        Self
    }
}

impl DocumentParser for HwpxParser {
    fn can_parse(&self, fmt: SourceFormat) -> bool {
        fmt == SourceFormat::Hwpx
    }

    fn parse(&self, bytes: &[u8], _fmt: SourceFormat) -> Result<SemanticDoc> {
        // Our own OWPML→SemanticDoc parser (subset: paragraphs + tables). The moat —
        // no rhwp. Deeper fidelity (char/para pools, images, passthrough) grows from here.
        parse::parse_semantic(bytes)
    }
}

/// Our HWPX writer implementing [`HwpxSerializer`] — the capability that is
/// **always ours** (rhwp's serializer is Hancom-incompatible, issue #196).
#[derive(Default)]
pub struct HwpxWriter;

impl HwpxSerializer for HwpxWriter {
    fn serialize(&self, doc: &SemanticDoc) -> Result<Vec<u8>> {
        serialize::serialize(doc)
    }

    fn validate_open_safety(&self, bytes: &[u8]) -> SafetyReport {
        export::validate_open_safety(bytes)
    }
}
