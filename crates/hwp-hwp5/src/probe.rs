use crate::{parse_file_header, walk_records, Error, FileHeader, Record, RecordLimits, Result};
use cfb::CompoundFile;
use flate2::read::DeflateDecoder;
use hwp_ingest::limits::{self, MAX_DECOMPRESSED_TOTAL, MAX_ENTRY_COUNT};
use hwp_model::document::{Block, Inline, Paragraph, Run, SemanticDoc};
use serde::Serialize;
use std::io::{Cursor, Read, Seek};

const TAG_PARA_HEADER: u16 = 0x42;
const TAG_PARA_CHAR_SHAPE: u16 = 0x44;
const TAG_CTRL_HEADER: u16 = 0x47;
const TAG_TABLE: u16 = 0x4d;
const TAG_PICTURE: u16 = 0x55;
const TAG_EQUATION: u16 = 0x58;
const TAG_CHART: u16 = 0x5f;
const CTRL_SECTION_DEF: u32 = u32::from_be_bytes(*b"secd");
const CTRL_COLUMN_DEF: u32 = u32::from_be_bytes(*b"cold");
const CTRL_PAGE_NUM_POS: u32 = u32::from_be_bytes(*b"pgnp");
const CTRL_NEW_NUMBER: u32 = u32::from_be_bytes(*b"nwno");
const CTRL_TABLE: u32 = u32::from_be_bytes(*b"tbl ");

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct StreamProbe {
    /// `None` is DocInfo; `Some(n)` is the standard BodyText section ordinal. No source path is kept.
    pub section: Option<usize>,
    pub decompressed_bytes: usize,
    pub records: Vec<Record>,
    /// Decompressed bytes stay crate-private and are never serialized into diagnostics.
    #[serde(skip)]
    pub(crate) raw: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Hwp5Probe {
    pub header: FileHeader,
    pub streams: Vec<StreamProbe>,
    pub inventory: StructuralInventory,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct StructuralInventory {
    pub sections: usize,
    pub paragraphs: usize,
    pub runs: usize,
    pub tables: usize,
    pub images: usize,
    pub controls: usize,
    pub equations: usize,
    pub charts: usize,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct StructuralDelta {
    pub sections: i64,
    pub paragraphs: i64,
    pub runs: i64,
    pub tables: i64,
    pub images: i64,
    pub controls: i64,
    pub equations: i64,
    pub charts: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DifferentialReport {
    pub schema: &'static str,
    pub native: StructuralInventory,
    pub oracle: StructuralInventory,
    pub delta: StructuralDelta,
    /// FNV-1a over typed AST topology markers only. It is not a source/content hash.
    pub semantic_topology_fingerprint: String,
}

/// Paragraph/run counts split by their semantic location. Unlike [`StructuralInventory`], every
/// field here is measured from a `SemanticDoc` on both sides of the comparison.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct SemanticScopeCounts {
    pub body: usize,
    pub decorations: usize,
    pub table_cells: usize,
    pub table_captions: usize,
    pub notes: usize,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct SemanticControlCounts {
    pub tables: usize,
    pub images: usize,
    pub equations: usize,
    pub charts: usize,
    pub notes: usize,
    pub field_boundaries: usize,
    pub bookmarks: usize,
    pub raw: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SemanticProjection {
    pub sections: usize,
    pub paragraphs: SemanticScopeCounts,
    pub runs: SemanticScopeCounts,
    /// Adjacent text-only runs with the same in-document character-shape reference count as one.
    /// This distinguishes harmless record segmentation from an effective style boundary.
    pub coalesced_text_runs: SemanticScopeCounts,
    pub empty_text_runs: SemanticScopeCounts,
    pub controls: SemanticControlCounts,
    /// FNV-1a over typed AST topology markers only. It is not a source/content hash.
    pub semantic_topology_fingerprint: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct SourceControlHeaderCounts {
    pub tables: usize,
    pub section_definitions: usize,
    pub column_definitions: usize,
    pub page_number_positions: usize,
    pub new_number_controls: usize,
    pub other: usize,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct SourceRecordProjection {
    pub paragraph_headers: usize,
    pub run_position_tuples: usize,
    pub control_headers: SourceControlHeaderCounts,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SemanticMismatch {
    pub category: &'static str,
    pub candidate: usize,
    pub oracle: usize,
    pub delta: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SemanticDifferentialReport {
    pub schema: &'static str,
    pub candidate: SemanticProjection,
    pub oracle: SemanticProjection,
    pub mismatches: Vec<SemanticMismatch>,
    pub topology_matches: bool,
    /// Exact text equality is checked in memory and exposed only as a boolean. Source text and a
    /// content-derived hash never enter the report.
    pub text_matches: bool,
    /// Content-free, opaque observations for paragraphs whose empty-run counts differ. Empty runs
    /// have no glyphs; the shared typesetter reads only the resolved height when the whole paragraph
    /// is empty. This evidence therefore records no text, source path, file name, or source hash.
    pub empty_run_typography: Vec<EmptyRunTypographyObservation>,
    /// True only when removing the count-only empty-run difference preserves typed topology and every
    /// empty paragraph resolves to the same effective height. This is semantic equivalence evidence,
    /// not production-cutover permission; layout/PDF parity remains a separate gate.
    pub empty_run_typography_equivalent: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct EmptyRunShapeObservation {
    pub run_ordinal: usize,
    pub height_hwpunit: i32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct EmptyRunTypographyObservation {
    pub scope: &'static str,
    /// Global traversal ordinal only. It is deliberately not a section/block/cell source address.
    pub paragraph_ordinal: usize,
    pub paragraph_has_visible_content: bool,
    pub candidate: Vec<EmptyRunShapeObservation>,
    pub oracle: Vec<EmptyRunShapeObservation>,
    pub candidate_effective_empty_height_hwpunit: i32,
    pub oracle_effective_empty_height_hwpunit: i32,
    pub layout_role: &'static str,
    pub effective_height_matches: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct OwnParserEligibilityReport {
    pub schema: &'static str,
    pub eligible: bool,
    /// Static, content-free reason. Dynamic parse errors, offsets, paths, and source identifiers are
    /// intentionally excluded from this report.
    pub rejection_code: Option<&'static str>,
    pub source_records: Option<SourceRecordProjection>,
    pub comparison: Option<SemanticDifferentialReport>,
}

pub fn probe(bytes: &[u8]) -> Result<Hwp5Probe> {
    limits::check_raw_size(bytes.len())?;
    let mut compound =
        CompoundFile::open(Cursor::new(bytes)).map_err(|error| Error::Cfb(error.to_string()))?;
    let entries: Vec<(String, bool)> = compound
        .walk()
        .map(|entry| {
            (
                entry.path().to_string_lossy().into_owned(),
                entry.is_stream(),
            )
        })
        .collect();
    if entries.len() > MAX_ENTRY_COUNT {
        return Err(limits::DocLimit::TooManyEntries {
            count: entries.len(),
            limit: MAX_ENTRY_COUNT,
        }
        .into());
    }
    let header_bytes = read_stream_bounded(&mut compound, "/FileHeader", 256)?;
    let header = parse_file_header(&header_bytes)?;
    if header.flags.body_is_opaque() {
        return Err(Error::OpaqueBody(header.flags.raw));
    }

    let mut budget_used = 0u64;
    let mut streams = Vec::new();
    if !entries
        .iter()
        .any(|(path, is_stream)| *is_stream && path == "/DocInfo")
    {
        return Err(Error::MissingStream("DocInfo"));
    }
    streams.push(inspect_stream(
        &mut compound,
        "/DocInfo",
        None,
        header.flags.compressed,
        &mut budget_used,
    )?);
    let mut sections: Vec<usize> = entries
        .iter()
        .filter(|(_, is_stream)| *is_stream)
        .filter_map(|(path, _)| path.strip_prefix("/BodyText/Section")?.parse().ok())
        .collect();
    sections.sort_unstable();
    if sections.is_empty() {
        return Err(Error::MissingStream("BodyText/Section0"));
    }
    for (expected, section) in sections.into_iter().enumerate() {
        if section != expected {
            return Err(Error::NonContiguousSections {
                expected,
                actual: section,
            });
        }
        let path = format!("/BodyText/Section{section}");
        streams.push(inspect_stream(
            &mut compound,
            &path,
            Some(section),
            header.flags.compressed,
            &mut budget_used,
        )?);
    }
    let inventory = native_inventory(&streams);
    Ok(Hwp5Probe {
        header,
        streams,
        inventory,
    })
}

fn inspect_stream<R: Read + Seek>(
    compound: &mut CompoundFile<R>,
    path: &str,
    section: Option<usize>,
    compressed: bool,
    budget_used: &mut u64,
) -> Result<StreamProbe> {
    let stored = read_stream_bounded(compound, path, MAX_DECOMPRESSED_TOTAL as usize)?;
    let raw = if compressed {
        inflate_bounded(&stored, budget_used)?
    } else {
        account(stored.len(), budget_used)?;
        stored
    };
    let records = walk_records(&raw, RecordLimits::default())?;
    Ok(StreamProbe {
        section,
        decompressed_bytes: raw.len(),
        records,
        raw,
    })
}

fn read_stream_bounded<R: Read + Seek>(
    compound: &mut CompoundFile<R>,
    path: &str,
    limit: usize,
) -> Result<Vec<u8>> {
    let mut stream = compound
        .open_stream(path)
        .map_err(|error| Error::Cfb(error.to_string()))?;
    let mut bytes = Vec::new();
    stream
        .by_ref()
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| Error::Cfb(error.to_string()))?;
    if bytes.len() > limit {
        return Err(Error::DecompressedLimit {
            limit: limit as u64,
        });
    }
    Ok(bytes)
}

fn inflate_bounded(stored: &[u8], budget_used: &mut u64) -> Result<Vec<u8>> {
    let remaining = MAX_DECOMPRESSED_TOTAL.saturating_sub(*budget_used);
    let mut raw = Vec::new();
    DeflateDecoder::new(stored)
        .take(remaining + 1)
        .read_to_end(&mut raw)
        .map_err(|error| Error::Cfb(format!("deflate stream rejected: {error}")))?;
    account(raw.len(), budget_used)?;
    Ok(raw)
}

fn account(size: usize, budget_used: &mut u64) -> Result<()> {
    *budget_used = budget_used.saturating_add(size as u64);
    if *budget_used > MAX_DECOMPRESSED_TOTAL {
        return Err(Error::DecompressedLimit {
            limit: MAX_DECOMPRESSED_TOTAL,
        });
    }
    Ok(())
}

fn native_inventory(streams: &[StreamProbe]) -> StructuralInventory {
    let mut out = StructuralInventory {
        sections: streams
            .iter()
            .filter(|stream| stream.section.is_some())
            .count(),
        ..StructuralInventory::default()
    };
    for stream in streams.iter().filter(|stream| stream.section.is_some()) {
        for record in &stream.records {
            match record.tag {
                TAG_PARA_HEADER => out.paragraphs += 1,
                TAG_PARA_CHAR_SHAPE => out.runs += record.size / 8,
                TAG_TABLE => out.tables += 1,
                TAG_PICTURE => out.images += 1,
                TAG_CTRL_HEADER => out.controls += 1,
                TAG_EQUATION => out.equations += 1,
                TAG_CHART => out.charts += 1,
                _ => {}
            }
        }
    }
    out
}

pub fn compare_with_semantic(native: &Hwp5Probe, oracle: &SemanticDoc) -> DifferentialReport {
    let (oracle_inventory, fingerprint) = semantic_inventory(oracle);
    DifferentialReport {
        schema: "auto-hwp.hwp5-differential.v1",
        native: native.inventory,
        oracle: oracle_inventory,
        delta: delta(native.inventory, oracle_inventory),
        semantic_topology_fingerprint: format!("topo-fnv1a64:{fingerprint:016x}"),
    }
}

/// Compare the first-party parser and the rhwp oracle in the same semantic coordinate system.
/// This additive v2 contract leaves the raw-record-to-semantic v1 report unchanged.
pub fn compare_semantic_candidates(
    candidate: &SemanticDoc,
    oracle: &SemanticDoc,
) -> OwnParserEligibilityReport {
    let text_matches = semantic_text_projection(candidate) == semantic_text_projection(oracle);
    let empty_run_typography = empty_run_typography(candidate, oracle);
    let normalized_topology_matches = semantic_v2_topology_without_empty_runs(candidate)
        == semantic_v2_topology_without_empty_runs(oracle);
    let empty_run_typography_equivalent = !empty_run_typography.is_empty()
        && normalized_topology_matches
        && empty_run_typography.iter().all(|observation| {
            observation.paragraph_has_visible_content || observation.effective_height_matches
        });
    let candidate = semantic_projection(candidate);
    let oracle = semantic_projection(oracle);
    let topology_matches =
        candidate.semantic_topology_fingerprint == oracle.semantic_topology_fingerprint;
    let mismatches = semantic_mismatches(&candidate, &oracle);
    let only_empty_run_counts_differ = mismatches.iter().all(|mismatch| {
        mismatch.category.starts_with("runs.")
            || mismatch.category.starts_with("coalesced-text-runs.")
            || mismatch.category.starts_with("empty-text-runs.")
    });
    let semantic_matches = (topology_matches && text_matches && mismatches.is_empty())
        || (text_matches && empty_run_typography_equivalent && only_empty_run_counts_differ);
    OwnParserEligibilityReport {
        schema: "auto-hwp.hwp5-own-parser-eligibility.v2",
        // v2 classifies semantic equality but has no per-document layout/PDF evidence channel yet.
        // A semantic match is therefore still not sufficient to declare cutover eligibility.
        eligible: false,
        rejection_code: Some(if semantic_matches {
            "render-parity-unproven"
        } else {
            "semantic-mismatch"
        }),
        source_records: None,
        comparison: Some(SemanticDifferentialReport {
            schema: "auto-hwp.hwp5-semantic-differential.v2",
            candidate,
            oracle,
            mismatches,
            topology_matches,
            text_matches,
            empty_run_typography,
            empty_run_typography_equivalent,
        }),
    }
}

fn semantic_text_projection(doc: &SemanticDoc) -> Vec<String> {
    let mut out = Vec::new();
    for section in &doc.sections {
        collect_block_text(&section.blocks, &mut out);
        for decoration in &section.decorations {
            collect_block_text(&decoration.blocks, &mut out);
        }
    }
    out
}

fn collect_block_text(blocks: &[Block], out: &mut Vec<String>) {
    for block in blocks {
        match block {
            Block::Paragraph(paragraph) => {
                let mut text = String::new();
                for run in &paragraph.runs {
                    for inline in &run.content {
                        match inline {
                            Inline::Text(value) => text.push_str(value),
                            Inline::Note(note) => collect_block_text(&note.body, out),
                            _ => {}
                        }
                    }
                }
                out.push(text);
            }
            Block::Table(table) => {
                if let Some(caption) = &table.caption {
                    collect_block_text(&caption.blocks, out);
                }
                for cell in &table.cells {
                    collect_block_text(&cell.blocks, out);
                }
            }
        }
    }
}

pub fn compare_semantic_candidates_with_source(
    source: &Hwp5Probe,
    candidate: &SemanticDoc,
    oracle: &SemanticDoc,
) -> OwnParserEligibilityReport {
    let mut report = compare_semantic_candidates(candidate, oracle);
    report.source_records = Some(source_record_projection(source));
    report
}

pub fn rejected_eligibility(rejection_code: &'static str) -> OwnParserEligibilityReport {
    OwnParserEligibilityReport {
        schema: "auto-hwp.hwp5-own-parser-eligibility.v2",
        eligible: false,
        rejection_code: Some(rejection_code),
        source_records: None,
        comparison: None,
    }
}

pub fn rejected_eligibility_with_source(
    source: &Hwp5Probe,
    rejection_code: &'static str,
) -> OwnParserEligibilityReport {
    let mut report = rejected_eligibility(rejection_code);
    report.source_records = Some(source_record_projection(source));
    report
}

/// Normalize only empty runs that the current shared typesetter cannot observe, for differential
/// layout evidence. This is deliberately **not** called by [`OwnHwp5Parser`](crate::OwnHwp5Parser):
/// the parsed source semantics remain intact. A paragraph with visible content drops glyphless empty
/// runs; a wholly empty paragraph retains exactly the run that supplies its effective positive
/// height (or the first run when every height is zero). Controls and other non-text content are never
/// classified as empty. Hostile tests lock these boundaries.
pub fn normalize_empty_runs_for_layout_evidence(doc: &mut SemanticDoc) {
    fn visit(blocks: &mut [Block], doc_shapes: &[hwp_model::style::CharShape]) {
        for block in blocks {
            match block {
                Block::Paragraph(paragraph) => {
                    for run in &mut paragraph.runs {
                        for inline in &mut run.content {
                            if let Inline::Note(note) = inline {
                                visit(&mut note.body, doc_shapes);
                            }
                        }
                    }
                    let visible = paragraph_has_visible_content(paragraph);
                    if visible {
                        paragraph.runs.retain(|run| !is_empty_text_run(run));
                    } else if paragraph.runs.len() > 1
                        && paragraph.runs.iter().all(is_empty_text_run)
                    {
                        let retained = paragraph
                            .runs
                            .iter()
                            .find(|run| {
                                doc_shapes
                                    .get(run.char_shape)
                                    .is_some_and(|shape| shape.height > 0)
                            })
                            .or_else(|| paragraph.runs.first())
                            .cloned();
                        paragraph.runs.clear();
                        paragraph.runs.extend(retained);
                    }
                }
                Block::Table(table) => {
                    if let Some(caption) = &mut table.caption {
                        visit(&mut caption.blocks, doc_shapes);
                    }
                    for cell in &mut table.cells {
                        visit(&mut cell.blocks, doc_shapes);
                    }
                }
            }
        }
    }

    let shapes = doc.char_shapes.clone();
    for section in &mut doc.sections {
        visit(&mut section.blocks, &shapes);
        for decoration in &mut section.decorations {
            visit(&mut decoration.blocks, &shapes);
        }
    }
}

pub fn source_record_projection(source: &Hwp5Probe) -> SourceRecordProjection {
    let mut projection = SourceRecordProjection::default();
    for stream in source
        .streams
        .iter()
        .filter(|stream| stream.section.is_some())
    {
        for record in &stream.records {
            match record.tag {
                TAG_PARA_HEADER => projection.paragraph_headers += 1,
                TAG_PARA_CHAR_SHAPE => projection.run_position_tuples += record.size / 8,
                TAG_CTRL_HEADER => {
                    let control_id = (record.size >= 4)
                        .then(|| stream.raw.get(record.data..record.data + 4))
                        .flatten()
                        .and_then(|bytes| bytes.try_into().ok())
                        .map(u32::from_le_bytes);
                    match control_id {
                        Some(CTRL_TABLE) => projection.control_headers.tables += 1,
                        Some(CTRL_SECTION_DEF) => {
                            projection.control_headers.section_definitions += 1;
                        }
                        Some(CTRL_COLUMN_DEF) => {
                            projection.control_headers.column_definitions += 1;
                        }
                        Some(CTRL_PAGE_NUM_POS) => {
                            projection.control_headers.page_number_positions += 1;
                        }
                        Some(CTRL_NEW_NUMBER) => {
                            projection.control_headers.new_number_controls += 1;
                        }
                        _ => projection.control_headers.other += 1,
                    }
                }
                _ => {}
            }
        }
    }
    projection
}

fn semantic_projection(doc: &SemanticDoc) -> SemanticProjection {
    let fingerprint = semantic_v2_topology(doc);
    let mut projection = SemanticProjection {
        sections: doc.sections.len(),
        paragraphs: SemanticScopeCounts::default(),
        runs: SemanticScopeCounts::default(),
        coalesced_text_runs: SemanticScopeCounts::default(),
        empty_text_runs: SemanticScopeCounts::default(),
        controls: SemanticControlCounts::default(),
        semantic_topology_fingerprint: format!("topo-fnv1a64:{fingerprint:016x}"),
    };
    for section in &doc.sections {
        visit_typed_blocks(&section.blocks, SemanticScope::Body, &mut projection);
        for decoration in &section.decorations {
            visit_typed_blocks(
                &decoration.blocks,
                SemanticScope::Decoration,
                &mut projection,
            );
        }
    }
    projection
}

fn semantic_v2_topology(doc: &SemanticDoc) -> u64 {
    let mut hash = Fnv1a::new();
    hash.marker(20, doc.sections.len());
    for section in &doc.sections {
        hash.marker(21, section.blocks.len());
        hash_v2_blocks(&section.blocks, &mut hash);
        hash.marker(22, section.decorations.len());
        for decoration in &section.decorations {
            hash.marker(23, decoration.blocks.len());
            hash_v2_blocks(&decoration.blocks, &mut hash);
        }
    }
    hash.0
}

fn semantic_v2_topology_without_empty_runs(doc: &SemanticDoc) -> u64 {
    let mut hash = Fnv1a::new();
    hash.marker(20, doc.sections.len());
    for section in &doc.sections {
        hash.marker(21, section.blocks.len());
        hash_v2_blocks_without_empty_runs(&section.blocks, &mut hash);
        hash.marker(22, section.decorations.len());
        for decoration in &section.decorations {
            hash.marker(23, decoration.blocks.len());
            hash_v2_blocks_without_empty_runs(&decoration.blocks, &mut hash);
        }
    }
    hash.0
}

fn hash_v2_blocks_without_empty_runs(blocks: &[Block], hash: &mut Fnv1a) {
    hash.marker(24, blocks.len());
    for block in blocks {
        match block {
            Block::Paragraph(paragraph) => {
                let visible_runs: Vec<_> = paragraph
                    .runs
                    .iter()
                    .filter(|run| !is_empty_text_run(run))
                    .collect();
                hash.marker(25, visible_runs.len());
                for run in visible_runs {
                    hash.marker(26, run.content.len());
                    for inline in &run.content {
                        match inline {
                            Inline::Text(_) => hash.marker(27, 0),
                            Inline::Image(_) => hash.marker(28, 0),
                            Inline::Equation(_) => hash.marker(29, 0),
                            Inline::Chart(_) => hash.marker(30, 0),
                            Inline::Note(note) => {
                                hash.marker(31, note.body.len());
                                hash_v2_blocks_without_empty_runs(&note.body, hash);
                            }
                            Inline::FieldBegin(_) => hash.marker(32, 0),
                            Inline::FieldEnd(_) => hash.marker(33, 0),
                            Inline::Bookmark(_) => hash.marker(34, 0),
                            Inline::Raw(_) => hash.marker(35, 0),
                        }
                    }
                }
            }
            Block::Table(table) => {
                hash.marker(36, table.rows);
                hash.marker(37, table.cols);
                hash.marker(38, table.cells.len());
                hash.marker(39, usize::from(table.caption.is_some()));
                if let Some(caption) = &table.caption {
                    hash_v2_blocks_without_empty_runs(&caption.blocks, hash);
                }
                for cell in &table.cells {
                    hash.marker(40, cell.row);
                    hash.marker(41, cell.col);
                    hash.marker(42, cell.row_span);
                    hash.marker(43, cell.col_span);
                    hash.marker(44, usize::from(cell.active));
                    hash_v2_blocks_without_empty_runs(&cell.blocks, hash);
                }
            }
        }
    }
}

fn hash_v2_blocks(blocks: &[Block], hash: &mut Fnv1a) {
    hash.marker(24, blocks.len());
    for block in blocks {
        match block {
            Block::Paragraph(paragraph) => {
                hash.marker(25, paragraph.runs.len());
                for run in &paragraph.runs {
                    hash.marker(26, run.content.len());
                    for inline in &run.content {
                        match inline {
                            Inline::Text(_) => hash.marker(27, 0),
                            Inline::Image(_) => hash.marker(28, 0),
                            Inline::Equation(_) => hash.marker(29, 0),
                            Inline::Chart(_) => hash.marker(30, 0),
                            Inline::Note(note) => {
                                hash.marker(31, note.body.len());
                                hash_v2_blocks(&note.body, hash);
                            }
                            Inline::FieldBegin(_) => hash.marker(32, 0),
                            Inline::FieldEnd(_) => hash.marker(33, 0),
                            Inline::Bookmark(_) => hash.marker(34, 0),
                            Inline::Raw(_) => hash.marker(35, 0),
                        }
                    }
                }
            }
            Block::Table(table) => {
                hash.marker(36, table.rows);
                hash.marker(37, table.cols);
                hash.marker(38, table.cells.len());
                hash.marker(39, usize::from(table.caption.is_some()));
                if let Some(caption) = &table.caption {
                    hash_v2_blocks(&caption.blocks, hash);
                }
                for cell in &table.cells {
                    hash.marker(40, cell.row);
                    hash.marker(41, cell.col);
                    hash.marker(42, cell.row_span);
                    hash.marker(43, cell.col_span);
                    hash.marker(44, usize::from(cell.active));
                    hash_v2_blocks(&cell.blocks, hash);
                }
            }
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SemanticScope {
    Body,
    Decoration,
    TableCell,
    TableCaption,
    Note,
}

impl SemanticScope {
    fn label(self) -> &'static str {
        match self {
            Self::Body => "body",
            Self::Decoration => "decoration",
            Self::TableCell => "table-cell",
            Self::TableCaption => "table-caption",
            Self::Note => "note",
        }
    }
}

fn is_empty_text_run(run: &Run) -> bool {
    run.content.iter().all(|inline| match inline {
        Inline::Text(text) => text.is_empty(),
        _ => false,
    })
}

fn semantic_paragraphs(doc: &SemanticDoc) -> Vec<(SemanticScope, &Paragraph)> {
    fn visit<'a>(
        blocks: &'a [Block],
        scope: SemanticScope,
        out: &mut Vec<(SemanticScope, &'a Paragraph)>,
    ) {
        for block in blocks {
            match block {
                Block::Paragraph(paragraph) => {
                    out.push((scope, paragraph));
                    for run in &paragraph.runs {
                        for inline in &run.content {
                            if let Inline::Note(note) = inline {
                                visit(&note.body, SemanticScope::Note, out);
                            }
                        }
                    }
                }
                Block::Table(table) => {
                    if let Some(caption) = &table.caption {
                        visit(&caption.blocks, SemanticScope::TableCaption, out);
                    }
                    for cell in &table.cells {
                        visit(&cell.blocks, SemanticScope::TableCell, out);
                    }
                }
            }
        }
    }

    let mut out = Vec::new();
    for section in &doc.sections {
        visit(&section.blocks, SemanticScope::Body, &mut out);
        for decoration in &section.decorations {
            visit(&decoration.blocks, SemanticScope::Decoration, &mut out);
        }
    }
    out
}

fn effective_empty_height(paragraph: &Paragraph, doc: &SemanticDoc) -> i32 {
    paragraph
        .runs
        .iter()
        .filter_map(|run| doc.char_shapes.get(run.char_shape))
        .map(|shape| shape.height)
        .find(|height| *height > 0)
        .unwrap_or(1000)
}

fn empty_shapes(paragraph: &Paragraph, doc: &SemanticDoc) -> Vec<EmptyRunShapeObservation> {
    paragraph
        .runs
        .iter()
        .enumerate()
        .filter(|(_, run)| is_empty_text_run(run))
        .map(|(run_ordinal, run)| EmptyRunShapeObservation {
            run_ordinal,
            height_hwpunit: doc
                .char_shapes
                .get(run.char_shape)
                .map(|shape| shape.height)
                .unwrap_or_default(),
        })
        .collect()
}

fn paragraph_has_visible_content(paragraph: &Paragraph) -> bool {
    paragraph.runs.iter().any(|run| {
        run.content.iter().any(|inline| match inline {
            Inline::Text(text) => !text.is_empty(),
            _ => true,
        })
    })
}

fn empty_run_typography(
    candidate: &SemanticDoc,
    oracle: &SemanticDoc,
) -> Vec<EmptyRunTypographyObservation> {
    let candidate_paragraphs = semantic_paragraphs(candidate);
    let oracle_paragraphs = semantic_paragraphs(oracle);
    if candidate_paragraphs.len() != oracle_paragraphs.len() {
        return Vec::new();
    }

    candidate_paragraphs
        .into_iter()
        .zip(oracle_paragraphs)
        .enumerate()
        .filter_map(
            |(
                paragraph_ordinal,
                ((candidate_scope, candidate_para), (oracle_scope, oracle_para)),
            )| {
                if candidate_scope != oracle_scope {
                    return None;
                }
                let candidate_shapes = empty_shapes(candidate_para, candidate);
                let oracle_shapes = empty_shapes(oracle_para, oracle);
                if candidate_shapes.len() == oracle_shapes.len() {
                    return None;
                }
                let visible = paragraph_has_visible_content(candidate_para)
                    || paragraph_has_visible_content(oracle_para);
                let candidate_height = effective_empty_height(candidate_para, candidate);
                let oracle_height = effective_empty_height(oracle_para, oracle);
                Some(EmptyRunTypographyObservation {
                    scope: candidate_scope.label(),
                    paragraph_ordinal,
                    paragraph_has_visible_content: visible,
                    candidate: candidate_shapes,
                    oracle: oracle_shapes,
                    candidate_effective_empty_height_hwpunit: candidate_height,
                    oracle_effective_empty_height_hwpunit: oracle_height,
                    layout_role: if visible {
                        "no-glyph-layout-neutral"
                    } else {
                        "empty-paragraph-height-source"
                    },
                    effective_height_matches: candidate_height == oracle_height,
                })
            },
        )
        .collect()
}

fn increment_scope(counts: &mut SemanticScopeCounts, scope: SemanticScope, amount: usize) {
    match scope {
        SemanticScope::Body => counts.body += amount,
        SemanticScope::Decoration => counts.decorations += amount,
        SemanticScope::TableCell => counts.table_cells += amount,
        SemanticScope::TableCaption => counts.table_captions += amount,
        SemanticScope::Note => counts.notes += amount,
    }
}

fn visit_typed_blocks(blocks: &[Block], scope: SemanticScope, projection: &mut SemanticProjection) {
    for block in blocks {
        match block {
            Block::Paragraph(paragraph) => {
                increment_scope(&mut projection.paragraphs, scope, 1);
                increment_scope(&mut projection.runs, scope, paragraph.runs.len());
                let mut coalesced_runs = 0usize;
                let mut previous_plain_shape = None;
                for run in &paragraph.runs {
                    let plain_text = run
                        .content
                        .iter()
                        .all(|inline| matches!(inline, Inline::Text(_)));
                    if !plain_text || previous_plain_shape != Some(run.char_shape) {
                        coalesced_runs += 1;
                    }
                    previous_plain_shape = plain_text.then_some(run.char_shape);
                    let empty_text = run.content.iter().all(|inline| match inline {
                        Inline::Text(text) => text.is_empty(),
                        _ => false,
                    });
                    if empty_text {
                        increment_scope(&mut projection.empty_text_runs, scope, 1);
                    }
                    for inline in &run.content {
                        match inline {
                            Inline::Text(_) => {}
                            Inline::Image(_) => projection.controls.images += 1,
                            Inline::Equation(_) => projection.controls.equations += 1,
                            Inline::Chart(_) => projection.controls.charts += 1,
                            Inline::Note(note) => {
                                projection.controls.notes += 1;
                                visit_typed_blocks(&note.body, SemanticScope::Note, projection);
                            }
                            Inline::FieldBegin(_) | Inline::FieldEnd(_) => {
                                projection.controls.field_boundaries += 1;
                            }
                            Inline::Bookmark(_) => projection.controls.bookmarks += 1,
                            Inline::Raw(_) => projection.controls.raw += 1,
                        }
                    }
                }
                increment_scope(&mut projection.coalesced_text_runs, scope, coalesced_runs);
            }
            Block::Table(table) => {
                projection.controls.tables += 1;
                if let Some(caption) = &table.caption {
                    visit_typed_blocks(&caption.blocks, SemanticScope::TableCaption, projection);
                }
                for cell in &table.cells {
                    visit_typed_blocks(&cell.blocks, SemanticScope::TableCell, projection);
                }
            }
        }
    }
}

fn semantic_mismatches(
    candidate: &SemanticProjection,
    oracle: &SemanticProjection,
) -> Vec<SemanticMismatch> {
    let mut out = Vec::new();
    let mut push = |category: &'static str, left: usize, right: usize| {
        if left != right {
            out.push(SemanticMismatch {
                category,
                candidate: left,
                oracle: right,
                delta: left as i64 - right as i64,
            });
        }
    };
    push("sections", candidate.sections, oracle.sections);
    push(
        "paragraphs.body",
        candidate.paragraphs.body,
        oracle.paragraphs.body,
    );
    push(
        "paragraphs.decorations",
        candidate.paragraphs.decorations,
        oracle.paragraphs.decorations,
    );
    push(
        "paragraphs.table-cells",
        candidate.paragraphs.table_cells,
        oracle.paragraphs.table_cells,
    );
    push(
        "paragraphs.table-captions",
        candidate.paragraphs.table_captions,
        oracle.paragraphs.table_captions,
    );
    push(
        "paragraphs.notes",
        candidate.paragraphs.notes,
        oracle.paragraphs.notes,
    );
    push("runs.body", candidate.runs.body, oracle.runs.body);
    push(
        "runs.decorations",
        candidate.runs.decorations,
        oracle.runs.decorations,
    );
    push(
        "runs.table-cells",
        candidate.runs.table_cells,
        oracle.runs.table_cells,
    );
    push(
        "runs.table-captions",
        candidate.runs.table_captions,
        oracle.runs.table_captions,
    );
    push("runs.notes", candidate.runs.notes, oracle.runs.notes);
    push(
        "coalesced-text-runs.body",
        candidate.coalesced_text_runs.body,
        oracle.coalesced_text_runs.body,
    );
    push(
        "coalesced-text-runs.decorations",
        candidate.coalesced_text_runs.decorations,
        oracle.coalesced_text_runs.decorations,
    );
    push(
        "coalesced-text-runs.table-cells",
        candidate.coalesced_text_runs.table_cells,
        oracle.coalesced_text_runs.table_cells,
    );
    push(
        "coalesced-text-runs.table-captions",
        candidate.coalesced_text_runs.table_captions,
        oracle.coalesced_text_runs.table_captions,
    );
    push(
        "coalesced-text-runs.notes",
        candidate.coalesced_text_runs.notes,
        oracle.coalesced_text_runs.notes,
    );
    push(
        "empty-text-runs.body",
        candidate.empty_text_runs.body,
        oracle.empty_text_runs.body,
    );
    push(
        "empty-text-runs.decorations",
        candidate.empty_text_runs.decorations,
        oracle.empty_text_runs.decorations,
    );
    push(
        "empty-text-runs.table-cells",
        candidate.empty_text_runs.table_cells,
        oracle.empty_text_runs.table_cells,
    );
    push(
        "empty-text-runs.table-captions",
        candidate.empty_text_runs.table_captions,
        oracle.empty_text_runs.table_captions,
    );
    push(
        "empty-text-runs.notes",
        candidate.empty_text_runs.notes,
        oracle.empty_text_runs.notes,
    );
    push(
        "controls.tables",
        candidate.controls.tables,
        oracle.controls.tables,
    );
    push(
        "controls.images",
        candidate.controls.images,
        oracle.controls.images,
    );
    push(
        "controls.equations",
        candidate.controls.equations,
        oracle.controls.equations,
    );
    push(
        "controls.charts",
        candidate.controls.charts,
        oracle.controls.charts,
    );
    push(
        "controls.notes",
        candidate.controls.notes,
        oracle.controls.notes,
    );
    push(
        "controls.field-boundaries",
        candidate.controls.field_boundaries,
        oracle.controls.field_boundaries,
    );
    push(
        "controls.bookmarks",
        candidate.controls.bookmarks,
        oracle.controls.bookmarks,
    );
    push("controls.raw", candidate.controls.raw, oracle.controls.raw);
    out
}

fn delta(a: StructuralInventory, b: StructuralInventory) -> StructuralDelta {
    let d = |left: usize, right: usize| left as i64 - right as i64;
    StructuralDelta {
        sections: d(a.sections, b.sections),
        paragraphs: d(a.paragraphs, b.paragraphs),
        runs: d(a.runs, b.runs),
        tables: d(a.tables, b.tables),
        images: d(a.images, b.images),
        controls: d(a.controls, b.controls),
        equations: d(a.equations, b.equations),
        charts: d(a.charts, b.charts),
    }
}

fn semantic_inventory(doc: &SemanticDoc) -> (StructuralInventory, u64) {
    let mut inventory = StructuralInventory {
        sections: doc.sections.len(),
        ..StructuralInventory::default()
    };
    let mut hash = Fnv1a::new();
    hash.marker(1, doc.sections.len());
    for section in &doc.sections {
        visit_blocks(&section.blocks, &mut inventory, &mut hash);
        hash.marker(2, section.decorations.len());
        for decoration in &section.decorations {
            visit_blocks(&decoration.blocks, &mut inventory, &mut hash);
        }
    }
    (inventory, hash.0)
}

fn visit_blocks(blocks: &[Block], inventory: &mut StructuralInventory, hash: &mut Fnv1a) {
    hash.marker(3, blocks.len());
    for block in blocks {
        match block {
            Block::Paragraph(paragraph) => {
                inventory.paragraphs += 1;
                inventory.runs += paragraph.runs.len();
                hash.marker(4, paragraph.runs.len());
                for run in &paragraph.runs {
                    hash.marker(5, run.content.len());
                    for inline in &run.content {
                        match inline {
                            Inline::Text(_) => hash.marker(6, 0),
                            Inline::Image(_) => {
                                inventory.images += 1;
                                inventory.controls += 1;
                                hash.marker(7, 0);
                            }
                            Inline::Equation(_) => {
                                inventory.equations += 1;
                                inventory.controls += 1;
                                hash.marker(8, 0);
                            }
                            Inline::Chart(_) => {
                                inventory.charts += 1;
                                inventory.controls += 1;
                                hash.marker(9, 0);
                            }
                            Inline::Note(note) => {
                                inventory.controls += 1;
                                hash.marker(10, note.body.len());
                                visit_blocks(&note.body, inventory, hash);
                            }
                            Inline::FieldBegin(_)
                            | Inline::FieldEnd(_)
                            | Inline::Bookmark(_)
                            | Inline::Raw(_) => {
                                inventory.controls += 1;
                                hash.marker(11, 0);
                            }
                        }
                    }
                }
            }
            Block::Table(table) => {
                inventory.tables += 1;
                inventory.controls += 1;
                hash.marker(12, table.cells.len());
                for cell in &table.cells {
                    visit_blocks(&cell.blocks, inventory, hash);
                }
            }
        }
    }
}

struct Fnv1a(u64);

impl Fnv1a {
    fn new() -> Self {
        Self(0xcbf29ce484222325)
    }

    fn marker(&mut self, tag: u8, count: usize) {
        for byte in std::iter::once(tag).chain((count as u64).to_le_bytes()) {
            self.0 ^= byte as u64;
            self.0 = self.0.wrapping_mul(0x100000001b3);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topology_fingerprint_ignores_text_content() {
        let mut left = SemanticDoc::default();
        left.sections.push(Default::default());
        left.sections[0]
            .blocks
            .push(Block::Paragraph(Default::default()));
        left.sections[0].blocks[0] = Block::Paragraph(hwp_model::document::Paragraph {
            runs: vec![hwp_model::document::Run {
                char_shape: 0,
                char_ref: None,
                content: vec![Inline::Text("fixture-a".into())],
            }],
            ..Default::default()
        });
        let mut right = left.clone();
        let Block::Paragraph(paragraph) = &mut right.sections[0].blocks[0] else {
            unreachable!()
        };
        paragraph.runs[0].content[0] = Inline::Text("fixture-b".into());
        let (_, a) = semantic_inventory(&left);
        let (_, b) = semantic_inventory(&right);
        assert_eq!(a, b);

        let changed = compare_semantic_candidates(&left, &right);
        assert!(!changed.eligible);
        assert_eq!(changed.rejection_code, Some("semantic-mismatch"));
        let comparison = changed.comparison.unwrap();
        assert!(comparison.topology_matches);
        assert!(!comparison.text_matches);
        let json = serde_json::to_string(&comparison).unwrap();
        assert!(!json.contains("fixture-a"));
        assert!(!json.contains("fixture-b"));

        let identical = compare_semantic_candidates(&left, &left);
        assert!(!identical.eligible);
        assert_eq!(identical.rejection_code, Some("render-parity-unproven"));
    }

    fn doc_with_runs(runs: Vec<hwp_model::document::Run>, heights: &[i32]) -> SemanticDoc {
        let mut doc = SemanticDoc {
            char_shapes: heights
                .iter()
                .map(|height| hwp_model::style::CharShape {
                    height: *height,
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        };
        doc.sections.push(Default::default());
        doc.sections[0]
            .blocks
            .push(Block::Paragraph(hwp_model::document::Paragraph {
                runs,
                ..Default::default()
            }));
        doc
    }

    fn run(shape: usize, text: &str) -> hwp_model::document::Run {
        hwp_model::document::Run {
            char_shape: shape,
            content: if text.is_empty() {
                Vec::new()
            } else {
                vec![Inline::Text(text.into())]
            },
            ..Default::default()
        }
    }

    #[test]
    fn trailing_empty_run_is_explicitly_layout_neutral() {
        let candidate = doc_with_runs(vec![run(0, "visible"), run(1, "")], &[1200, 2400]);
        let oracle = doc_with_runs(vec![run(0, "visible")], &[1200]);
        let report = compare_semantic_candidates(&candidate, &oracle);
        let comparison = report.comparison.unwrap();
        assert!(comparison.empty_run_typography_equivalent);
        assert_eq!(comparison.empty_run_typography.len(), 1);
        let observation = &comparison.empty_run_typography[0];
        assert!(observation.paragraph_has_visible_content);
        assert_eq!(observation.layout_role, "no-glyph-layout-neutral");
        assert_eq!(observation.candidate[0].height_hwpunit, 2400);
        assert!(observation.effective_height_matches);
    }

    #[test]
    fn empty_paragraph_requires_equal_effective_height() {
        let same_candidate = doc_with_runs(vec![run(0, ""), run(0, "")], &[1600]);
        let same_oracle = doc_with_runs(vec![run(0, "")], &[1600]);
        let same = compare_semantic_candidates(&same_candidate, &same_oracle)
            .comparison
            .unwrap();
        assert!(same.empty_run_typography_equivalent);
        assert!(same.empty_run_typography[0].effective_height_matches);
        assert_eq!(
            same.empty_run_typography[0].layout_role,
            "empty-paragraph-height-source"
        );

        let different_oracle = doc_with_runs(vec![run(0, "")], &[1000]);
        let different = compare_semantic_candidates(&same_candidate, &different_oracle)
            .comparison
            .unwrap();
        assert!(!different.empty_run_typography_equivalent);
        assert!(!different.empty_run_typography[0].effective_height_matches);
    }

    #[test]
    fn non_text_content_is_never_normalized_as_an_empty_run() {
        let mut candidate_run = run(0, "");
        candidate_run
            .content
            .push(Inline::Raw(hwp_model::types::RawPart {
                tag: "fixture-control".into(),
                bytes: vec![1],
            }));
        let candidate = doc_with_runs(vec![candidate_run], &[1000]);
        let oracle = doc_with_runs(Vec::new(), &[1000]);
        let comparison = compare_semantic_candidates(&candidate, &oracle)
            .comparison
            .unwrap();
        assert!(comparison.empty_run_typography.is_empty());
        assert!(!comparison.empty_run_typography_equivalent);
    }

    #[test]
    fn evidence_normalization_preserves_empty_height_and_controls() {
        let mut visible = doc_with_runs(
            vec![run(0, ""), run(1, "visible"), run(2, "")],
            &[900, 1200, 2400],
        );
        normalize_empty_runs_for_layout_evidence(&mut visible);
        let Block::Paragraph(visible_para) = &visible.sections[0].blocks[0] else {
            unreachable!()
        };
        assert_eq!(visible_para.runs.len(), 1);
        assert_eq!(visible_para.runs[0].char_shape, 1);

        let mut empty = doc_with_runs(vec![run(0, ""), run(1, ""), run(2, "")], &[0, 1600, 2400]);
        normalize_empty_runs_for_layout_evidence(&mut empty);
        let Block::Paragraph(empty_para) = &empty.sections[0].blocks[0] else {
            unreachable!()
        };
        assert_eq!(empty_para.runs.len(), 1);
        assert_eq!(empty_para.runs[0].char_shape, 1);
        assert_eq!(effective_empty_height(empty_para, &empty), 1600);

        let mut control_run = run(0, "");
        control_run
            .content
            .push(Inline::Raw(hwp_model::types::RawPart {
                tag: "fixture-control".into(),
                bytes: vec![1],
            }));
        let mut control = doc_with_runs(vec![control_run, run(0, "")], &[1000]);
        normalize_empty_runs_for_layout_evidence(&mut control);
        let Block::Paragraph(control_para) = &control.sections[0].blocks[0] else {
            unreachable!()
        };
        assert_eq!(control_para.runs.len(), 1);
        assert!(matches!(control_para.runs[0].content[0], Inline::Raw(_)));
    }
}
