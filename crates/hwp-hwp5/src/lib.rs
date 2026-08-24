//! First-party HWP5 boundary: bounded CFB/FileHeader/record inspection, a strict text-only semantic
//! slice, and content-free differential telemetry. [`OwnHwp5Parser::parse`] accepts only the owned
//! subset and fails closed without calling rhwp or any other parser for every unsupported record.

mod header;
mod probe;
mod record;
mod semantic;

pub use header::{
    parse_file_header, FileHeader, FileHeaderFlags, HeaderError, HwpVersion, FILE_HEADER_SIZE,
    HWP_SIGNATURE,
};
pub use probe::{
    compare_semantic_candidates, compare_semantic_candidates_with_source, compare_with_semantic,
    probe, rejected_eligibility, rejected_eligibility_with_source, source_record_projection,
    DifferentialReport, Hwp5Probe, OwnParserEligibilityReport, SemanticControlCounts,
    SemanticDifferentialReport, SemanticMismatch, SemanticProjection, SemanticScopeCounts,
    SourceControlHeaderCounts, SourceRecordProjection, StreamProbe, StructuralDelta,
    StructuralInventory,
};
pub use record::{walk_records, Record, RecordError, RecordLimits};

use hwp_model::document::SemanticDoc;
use thiserror::Error;

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
    #[error(
        "HWP5 record tag {tag:#x} at section {section:?} byte {offset} is malformed: {reason}"
    )]
    MalformedRecord {
        tag: u16,
        section: Option<usize>,
        offset: usize,
        reason: &'static str,
    },
    #[error("HWP5 pool count mismatch for tag {tag:#x}: expected {expected}, found {actual}")]
    PoolCountMismatch {
        tag: u16,
        expected: usize,
        actual: usize,
    },
    #[error("HWP5 {kind} reference {index} is outside pool size {pool_len} at section {section:?} byte {offset}")]
    InvalidReference {
        kind: &'static str,
        index: usize,
        pool_len: usize,
        section: Option<usize>,
        offset: usize,
    },
    #[error(
        "unsupported text-only HWP5 record tag {tag:#x} at section {section} bytes {start}..{end}: {reason}"
    )]
    UnsupportedBodyRecord {
        tag: u16,
        section: usize,
        start: usize,
        end: usize,
        reason: &'static str,
    },
    #[error("decompressed HWP5 data exceeds {limit}-byte limit")]
    DecompressedLimit { limit: u64 },
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    /// Stable content-free classifier for corpus eligibility reports. The detailed error remains
    /// available to local diagnostics, while public matrices never expose paths, offsets, or input.
    pub fn eligibility_code(&self) -> &'static str {
        match self {
            Self::Limit(_) | Self::DecompressedLimit { .. } => "resource-limit",
            Self::Cfb(_) => "invalid-container",
            Self::MissingStream(_) => "missing-required-stream",
            Self::NonContiguousSections { .. } => "noncontiguous-sections",
            Self::Header(_) => "invalid-header",
            Self::OpaqueBody(_) => "opaque-body",
            Self::Record(_) => "malformed-record",
            Self::MalformedRecord { reason, .. } => match *reason {
                "BORDER_FILL image, gradient, or mixed fill is not supported" => {
                    "unsupported-border-fill"
                }
                "STYLE has an unknown kind or attributes" => "unsupported-style-semantics",
                "TABLE attributes or row/column topology are not owned" => {
                    "unsupported-table-topology"
                }
                "section CTRL_HEADER extension semantics are not owned" => {
                    "unsupported-section-control"
                }
                _ => "malformed-record",
            },
            Self::PoolCountMismatch { .. } => "pool-count-mismatch",
            Self::InvalidReference { .. } => "invalid-reference",
            Self::UnsupportedBodyRecord { .. } => "unsupported-semantic",
        }
    }
}

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
        semantic::parse_text_only(bytes)
    }
}
