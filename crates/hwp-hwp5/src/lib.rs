//! First-party HWP5 boundary: bounded CFB/FileHeader/record inspection and content-free
//! differential telemetry. It deliberately does not claim semantic parsing until DocInfo and body
//! text slices are implemented; [`OwnHwp5Parser::parse`] therefore fails closed without calling
//! rhwp or any other parser.

mod header;
mod probe;
mod record;

pub use header::{
    parse_file_header, FileHeader, FileHeaderFlags, HeaderError, HwpVersion, FILE_HEADER_SIZE,
    HWP_SIGNATURE,
};
pub use probe::{
    compare_with_semantic, probe, DifferentialReport, Hwp5Probe, StreamProbe, StructuralDelta,
    StructuralInventory,
};
pub use record::{walk_records, Record, RecordError, RecordLimits};

use hwp_model::document::SemanticDoc;
use thiserror::Error;

pub const OWN_SEMANTIC_SLICE_PENDING: &str =
    "first-party HWP5 SemanticDoc decode is not complete (DocInfo/text slice pending)";

#[derive(Debug, Error)]
pub enum Error {
    #[error("input limit rejected HWP5: {0}")]
    Limit(#[from] hwp_ingest::limits::DocLimit),
    #[error("CFB error: {0}")]
    Cfb(String),
    #[error("required HWP5 stream is missing: {0}")]
    MissingStream(&'static str),
    #[error(
        "BodyText sections are not contiguous: expected Section{expected}, found Section{actual}"
    )]
    NonContiguousSections { expected: usize, actual: usize },
    #[error(transparent)]
    Header(#[from] HeaderError),
    #[error("opaque HWP5 body is not inspected (flags=0x{0:08x})")]
    OpaqueBody(u32),
    #[error("record stream error: {0}")]
    Record(#[from] RecordError),
    #[error("decompressed HWP5 data exceeds {limit}-byte limit")]
    DecompressedLimit { limit: u64 },
    #[error("{OWN_SEMANTIC_SLICE_PENDING}")]
    SemanticSlicePending,
}

pub type Result<T> = std::result::Result<T, Error>;

/// Explicit own-parser entry point. This type has no rhwp dependency and cannot silently fall back.
#[derive(Default)]
pub struct OwnHwp5Parser;

impl OwnHwp5Parser {
    pub fn new() -> Self {
        Self
    }

    pub fn inspect(&self, bytes: &[u8]) -> Result<Hwp5Probe> {
        probe(bytes)
    }

    pub fn parse(&self, bytes: &[u8]) -> Result<SemanticDoc> {
        // Validate everything this slice owns before reporting the precise missing capability.
        let _ = self.inspect(bytes)?;
        Err(Error::SemanticSlicePending)
    }
}
