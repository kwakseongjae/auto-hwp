//! Safe, original-byte-based HWP 5 text export.
//!
//! The first and highest-risk seam is observation: HWP5 `BodyText/SectionN` records are walked
//! independently and mapped back to the shared [`hwp_model`] IR. No vendored parser types cross this
//! boundary, and no HWP serializer is called. Mutation is added only after this mapping is proven on
//! the production corpus, including nested tables.

mod raw;
mod save;

pub use save::{
    analyze, export_hwp5, Capability, CapabilityReport, ExportResult, TextEdit, WriteStrategy,
};

use cfb::CompoundFile;
use flate2::read::DeflateDecoder;
use hwp_model::prelude::{Block, Inline, Paragraph, SemanticDoc, Table};
use serde::Serialize;
use std::collections::BTreeMap;
use std::io::{Cursor, Read};
use thiserror::Error;

pub type Result<T> = std::result::Result<T, Error>;
type RawCellDebug = (usize, usize, usize, usize, usize, Option<(u16, u16, usize)>);

// Encryption/distribution/DRM/history/signature/certificate flags all make an edited original-byte
// save unsafe: the body may be opaque, an old revision may leak, or a preserved signature may lie.
const UNSUPPORTED_SECURITY_FLAGS: u32 =
    (1 << 1) | (1 << 2) | (1 << 4) | (1 << 6) | (1 << 7) | (1 << 8) | (1 << 9) | (1 << 10);

#[derive(Debug, Error)]
pub enum Error {
    #[error("not a supported HWP5 source: {0}")]
    Unsupported(String),
    #[error("CFB error: {0}")]
    Cfb(String),
    #[error("HWP5 record error: {0}")]
    Record(String),
    #[error("HWP5 ↔ IR address mapping failed: {0}")]
    Mapping(String),
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct CellStep {
    /// At depth 0, a section block index; at deeper levels, a block index in the parent cell.
    pub block: usize,
    pub row: usize,
    pub col: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct ParagraphAddress {
    pub section: usize,
    /// Empty for a body paragraph. Otherwise walks tables down to the leaf cell.
    pub cell_path: Vec<CellStep>,
    /// Section block index for body text; leaf-cell block index for cell text.
    pub block: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct RecordSpan {
    pub header_offset: usize,
    pub data_offset: usize,
    pub end_offset: usize,
    pub level: u16,
}

#[derive(Clone, Debug, Serialize)]
pub struct ParagraphRecord {
    pub address: ParagraphAddress,
    pub section_stream: String,
    pub para_header: RecordSpan,
    pub para_text: Option<RecordSpan>,
    pub para_char_shape: Option<RecordSpan>,
    pub para_line_seg: Option<RecordSpan>,
    pub raw_text: String,
    pub semantic_text: String,
    pub contains_controls: bool,
    pub patchable: bool,
    pub raw_utf16_len: u32,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct AddressMap {
    entries: BTreeMap<ParagraphAddress, ParagraphRecord>,
    pub section_count: usize,
    pub paragraph_count: usize,
    pub table_count: usize,
    pub cell_count: usize,
    pub exact_text_matches: usize,
}

impl AddressMap {
    pub fn get(&self, address: &ParagraphAddress) -> Option<&ParagraphRecord> {
        self.entries.get(address)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&ParagraphAddress, &ParagraphRecord)> {
        self.entries.iter()
    }
}

/// Re-walk the original CFB/BodyText records and prove their structural correspondence to the
/// pristine HWP5-lifted IR. This is intentionally public so corpus tests and diagnostics can lock the
/// address seam independently from any writer.
pub fn observe(original_bytes: &[u8], original_doc: &SemanticDoc) -> Result<AddressMap> {
    if original_doc.origin != Some(hwp_model::types::SourceFormat::Hwp5) {
        return Err(Error::Unsupported(
            "the semantic document did not originate from HWP5".into(),
        ));
    }
    let mut compound = CompoundFile::open(Cursor::new(original_bytes))
        .map_err(|error| Error::Cfb(error.to_string()))?;
    let header = read_stream(&mut compound, "/FileHeader")?;
    let flags = header
        .get(36..40)
        .ok_or_else(|| Error::Unsupported("FileHeader is shorter than 40 bytes".into()))?;
    let flags = u32::from_le_bytes(flags.try_into().unwrap());
    if flags & UNSUPPORTED_SECURITY_FLAGS != 0 {
        return Err(Error::Unsupported(
            format!(
                "security/history-bearing HWP5 documents are outside v1 (FileHeader flags=0x{flags:08x})"
            ),
        ));
    }
    let compressed = flags & 1 != 0;

    let mut map = AddressMap {
        section_count: original_doc.sections.len(),
        ..AddressMap::default()
    };
    for (section_index, section) in original_doc.sections.iter().enumerate() {
        let section_stream = format!("/BodyText/Section{section_index}");
        let stored = read_stream(&mut compound, &section_stream)?;
        let raw = if compressed {
            inflate(&stored, &section_stream)?
        } else {
            stored
        };
        let records = raw::parse_records(&raw)?;
        let paragraphs = raw::parse_section(&records, &raw)?;
        let mut path = Vec::new();
        map_blocks(
            section_index,
            &section_stream,
            &records,
            &raw,
            &paragraphs,
            &section.blocks,
            &mut path,
            &mut map,
        )?;
    }
    Ok(map)
}

#[allow(clippy::too_many_arguments)]
fn map_blocks(
    section: usize,
    section_stream: &str,
    records: &[raw::Record],
    raw_bytes: &[u8],
    raw_paragraphs: &[raw::RawParagraph],
    blocks: &[Block],
    path: &mut Vec<CellStep>,
    out: &mut AddressMap,
) -> Result<()> {
    let mut block_index = 0usize;
    for (raw_ordinal, raw_paragraph) in raw_paragraphs.iter().enumerate() {
        skip_object_paragraphs(blocks, &mut block_index);
        let Some(Block::Paragraph(paragraph)) = blocks.get(block_index) else {
            return Err(Error::Mapping(format!(
                "section {section} path {path:?}: raw paragraph {raw_ordinal} expected IR paragraph at block {block_index}"
            )));
        };
        let address = ParagraphAddress {
            section,
            cell_path: path.clone(),
            block: block_index,
        };
        insert_paragraph(
            section_stream,
            records,
            raw_bytes,
            raw_paragraph,
            paragraph,
            address,
            out,
        )?;
        block_index += 1;

        for (table_ordinal, raw_table) in raw_paragraph.tables.iter().enumerate() {
            skip_object_paragraphs(blocks, &mut block_index);
            let Some(Block::Table(table)) = blocks.get(block_index) else {
                return Err(Error::Mapping(format!(
                    "section {section} path {path:?}: raw table {table_ordinal} under paragraph {raw_ordinal} expected IR table at block {block_index}"
                )));
            };
            map_table(
                section,
                section_stream,
                records,
                raw_bytes,
                raw_table,
                table,
                block_index,
                path,
                out,
            )?;
            block_index += 1;
        }
    }
    skip_object_paragraphs(blocks, &mut block_index);
    if block_index != blocks.len() {
        return Err(Error::Mapping(format!(
            "section {section} path {path:?}: {} raw paragraph clusters consumed {block_index}/{} IR blocks",
            raw_paragraphs.len(),
            blocks.len()
        )));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn map_table(
    section: usize,
    section_stream: &str,
    records: &[raw::Record],
    raw_bytes: &[u8],
    raw_table: &raw::RawTable,
    table: &Table,
    table_block: usize,
    path: &mut Vec<CellStep>,
    out: &mut AddressMap,
) -> Result<()> {
    out.table_count += 1;
    if raw_table.cells.len() != table.cells.len() {
        let raw_cells: Vec<RawCellDebug> = raw_table
            .cells
            .iter()
            .map(|cell| {
                let record = records[cell.list_header];
                (
                    cell.list_header,
                    cell.row,
                    cell.col,
                    record.size,
                    cell.paragraphs.len(),
                    records
                        .get(cell.list_header + 1)
                        .map(|next| (next.tag, next.level, next.size)),
                )
            })
            .collect();
        return Err(Error::Mapping(format!(
            "section {section} path {path:?} table block {table_block}: raw has {} LIST_HEADER candidates {raw_cells:?} but IR has {} cells (CTRL record {})",
            raw_table.cells.len(),
            table.cells.len(),
            raw_table.control
        )));
    }
    let mut raw_by_coordinate = BTreeMap::new();
    for raw_cell in &raw_table.cells {
        if raw_by_coordinate
            .insert((raw_cell.row, raw_cell.col), raw_cell)
            .is_some()
        {
            return Err(Error::Mapping(format!(
                "section {section} path {path:?} table block {table_block}: duplicate raw cell coordinate ({}, {})",
                raw_cell.row, raw_cell.col
            )));
        }
    }
    for (cell_index, cell) in table.cells.iter().enumerate() {
        let Some(raw_cell) = raw_by_coordinate.get(&(cell.row, cell.col)).copied() else {
            return Err(Error::Mapping(format!(
                "section {section} path {path:?} table block {table_block}: IR cell {cell_index} coordinate ({}, {}) has no raw LIST_HEADER",
                cell.row, cell.col
            )));
        };
        out.cell_count += 1;
        path.push(CellStep {
            block: table_block,
            row: cell.row,
            col: cell.col,
        });
        map_blocks(
            section,
            section_stream,
            records,
            raw_bytes,
            &raw_cell.paragraphs,
            &cell.blocks,
            path,
            out,
        )
        .map_err(|error| {
            Error::Mapping(format!(
                "{error}; raw cell {cell_index} LIST_HEADER record {}",
                raw_cell.list_header
            ))
        })?;
        path.pop();
    }
    Ok(())
}

fn insert_paragraph(
    section_stream: &str,
    records: &[raw::Record],
    raw_bytes: &[u8],
    raw_paragraph: &raw::RawParagraph,
    paragraph: &Paragraph,
    address: ParagraphAddress,
    out: &mut AddressMap,
) -> Result<()> {
    let decoded = raw::paragraph_text(records, raw_bytes, raw_paragraph)?;
    let semantic_text = paragraph_text(paragraph);
    let exact = decoded.text == semantic_text;
    if exact {
        out.exact_text_matches += 1;
    }
    let contains_controls = decoded.has_controls || !raw_paragraph.controls.is_empty();
    let record = ParagraphRecord {
        address: address.clone(),
        section_stream: section_stream.to_string(),
        para_header: span(records[raw_paragraph.header]),
        para_text: raw_paragraph.text.map(|idx| span(records[idx])),
        para_char_shape: raw_paragraph.char_shape.map(|idx| span(records[idx])),
        para_line_seg: raw_paragraph.line_seg.map(|idx| span(records[idx])),
        raw_text: decoded.text,
        semantic_text,
        contains_controls,
        // Text mismatch generally means parser-side derived text (auto-numbering/control expansion).
        // It remains observable but must never be a write target in v1.
        patchable: exact && !contains_controls,
        raw_utf16_len: decoded.utf16_len,
    };
    if out.entries.insert(address.clone(), record).is_some() {
        return Err(Error::Mapping(format!(
            "duplicate semantic paragraph address {address:?}"
        )));
    }
    out.paragraph_count += 1;
    Ok(())
}

fn skip_object_paragraphs(blocks: &[Block], index: &mut usize) {
    while blocks
        .get(*index)
        .is_some_and(|block| matches!(block, Block::Paragraph(p) if is_object_only(p)))
    {
        *index += 1;
    }
}

fn is_object_only(paragraph: &Paragraph) -> bool {
    let mut inlines = paragraph.runs.iter().flat_map(|run| &run.content);
    let has_derived_object = inlines.any(|inline| {
        matches!(
            inline,
            Inline::Image(_) | Inline::Equation(_) | Inline::Chart(_)
        )
    });
    has_derived_object
        && !paragraph
            .runs
            .iter()
            .flat_map(|run| &run.content)
            .any(|inline| matches!(inline, Inline::Text(_) | Inline::Note(_)))
}

pub(crate) fn paragraph_text(paragraph: &Paragraph) -> String {
    paragraph
        .runs
        .iter()
        .flat_map(|run| &run.content)
        .filter_map(|inline| match inline {
            Inline::Text(text) => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

fn span(record: raw::Record) -> RecordSpan {
    RecordSpan {
        header_offset: record.head,
        data_offset: record.data,
        end_offset: record.end,
        level: record.level,
    }
}

pub(crate) fn read_stream<F: Read + std::io::Seek>(
    compound: &mut CompoundFile<F>,
    path: &str,
) -> Result<Vec<u8>> {
    let mut stream = compound
        .open_stream(path)
        .map_err(|error| Error::Cfb(format!("open {path}: {error}")))?;
    let mut bytes = Vec::new();
    stream
        .read_to_end(&mut bytes)
        .map_err(|error| Error::Cfb(format!("read {path}: {error}")))?;
    Ok(bytes)
}

pub(crate) fn inflate(stored: &[u8], path: &str) -> Result<Vec<u8>> {
    let mut decoder = DeflateDecoder::new(stored);
    let mut raw = Vec::new();
    decoder
        .read_to_end(&mut raw)
        .map_err(|error| Error::Record(format!("inflate {path}: {error}")))?;
    Ok(raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};

    fn root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .canonicalize()
            .unwrap()
    }

    fn observe_fixture(relative: &str) -> AddressMap {
        let path = root().join(relative);
        let bytes = std::fs::read(&path)
            .unwrap_or_else(|error| panic!("read fixture {}: {error}", path.display()));
        let doc = hwp_core::Engine::open(&bytes)
            .unwrap_or_else(|error| panic!("parse fixture {}: {error}", path.display()));
        observe(&bytes, &doc)
            .unwrap_or_else(|error| panic!("observe fixture {}: {error}", path.display()))
    }

    fn load_fixture(relative: &str) -> (Vec<u8>, SemanticDoc) {
        let path = root().join(relative);
        let bytes = std::fs::read(&path).unwrap();
        let doc = hwp_core::Engine::open(&bytes).unwrap();
        (bytes, doc)
    }

    fn resolve_paragraph<'a>(doc: &'a SemanticDoc, address: &ParagraphAddress) -> &'a Paragraph {
        if address.cell_path.is_empty() {
            let Block::Paragraph(paragraph) = &doc.sections[address.section].blocks[address.block]
            else {
                panic!("address is not a paragraph: {address:?}");
            };
            return paragraph;
        }
        let cell = resolve_cell(doc, address.section, &address.cell_path);
        let Block::Paragraph(paragraph) = &cell.blocks[address.block] else {
            panic!("leaf address is not a paragraph: {address:?}");
        };
        paragraph
    }

    fn resolve_cell<'a>(
        doc: &'a SemanticDoc,
        section: usize,
        path: &[CellStep],
    ) -> &'a hwp_model::document::Cell {
        let (first, rest) = path.split_first().unwrap();
        let Block::Table(table) = &doc.sections[section].blocks[first.block] else {
            panic!("root path is not a table");
        };
        let cell = table
            .cells
            .iter()
            .find(|cell| cell.row == first.row && cell.col == first.col)
            .unwrap();
        resolve_nested_cell(cell, rest)
    }

    fn resolve_nested_cell<'a>(
        cell: &'a hwp_model::document::Cell,
        path: &[CellStep],
    ) -> &'a hwp_model::document::Cell {
        let Some((step, rest)) = path.split_first() else {
            return cell;
        };
        let Block::Table(table) = &cell.blocks[step.block] else {
            panic!("nested path is not a table");
        };
        let nested = table
            .cells
            .iter()
            .find(|cell| cell.row == step.row && cell.col == step.col)
            .unwrap();
        resolve_nested_cell(nested, rest)
    }

    fn resolve_paragraph_mut<'a>(
        doc: &'a mut SemanticDoc,
        address: &ParagraphAddress,
    ) -> &'a mut Paragraph {
        if address.cell_path.is_empty() {
            let Block::Paragraph(paragraph) =
                &mut doc.sections[address.section].blocks[address.block]
            else {
                panic!("address is not a paragraph: {address:?}");
            };
            return paragraph;
        }
        let cell = resolve_cell_mut(doc, address.section, &address.cell_path);
        let Block::Paragraph(paragraph) = &mut cell.blocks[address.block] else {
            panic!("leaf address is not a paragraph: {address:?}");
        };
        paragraph
    }

    fn resolve_cell_mut<'a>(
        doc: &'a mut SemanticDoc,
        section: usize,
        path: &[CellStep],
    ) -> &'a mut hwp_model::document::Cell {
        let (first, rest) = path.split_first().unwrap();
        let Block::Table(table) = &mut doc.sections[section].blocks[first.block] else {
            panic!("root path is not a table");
        };
        let cell = table
            .cells
            .iter_mut()
            .find(|cell| cell.row == first.row && cell.col == first.col)
            .unwrap();
        resolve_nested_cell_mut(cell, rest)
    }

    fn resolve_nested_cell_mut<'a>(
        cell: &'a mut hwp_model::document::Cell,
        path: &[CellStep],
    ) -> &'a mut hwp_model::document::Cell {
        let Some((step, rest)) = path.split_first() else {
            return cell;
        };
        let Block::Table(table) = &mut cell.blocks[step.block] else {
            panic!("nested path is not a table");
        };
        let nested = table
            .cells
            .iter_mut()
            .find(|cell| cell.row == step.row && cell.col == step.col)
            .unwrap();
        resolve_nested_cell_mut(nested, rest)
    }

    fn stream_map(bytes: &[u8]) -> BTreeMap<String, Vec<u8>> {
        let mut compound = CompoundFile::open(Cursor::new(bytes)).unwrap();
        let paths: Vec<String> = compound
            .walk()
            .filter(|entry| entry.is_stream())
            .map(|entry| entry.path().to_string_lossy().into_owned())
            .collect();
        paths
            .into_iter()
            .map(|path| {
                let bytes = read_stream(&mut compound, &path).unwrap();
                (path, bytes)
            })
            .collect()
    }

    #[test]
    fn observation_maps_sample_8p_alias_and_two_independent_corpora() {
        // apps/hwp-lab/public/samples/sample-8p.hwp is a deploy copy of benchmark.hwp; the tracked
        // benchmark is the canonical test asset (SHA-256 equality is documented in issue 082).
        let sample = observe_fixture("benchmarks/benchmark.hwp");
        let benchmark1 = observe_fixture("benchmarks/benchmark1.hwp");
        let nested = observe_fixture("external/rhwp/samples/inner-table-01.hwp");

        for (name, map) in [
            ("sample-8p", &sample),
            ("benchmark1", &benchmark1),
            ("inner-table-01", &nested),
        ] {
            eprintln!(
                "{name}: sections={} paragraphs={} exact={} tables={} cells={}",
                map.section_count,
                map.paragraph_count,
                map.exact_text_matches,
                map.table_count,
                map.cell_count
            );
            assert!(map.paragraph_count > 0, "{name}: no paragraphs mapped");
            assert_eq!(map.paragraph_count, map.iter().count(), "{name}");
            assert_eq!(
                map.exact_text_matches, map.paragraph_count,
                "{name}: raw/IR text mapping is not exact"
            );
        }
        assert!(sample.table_count > 0 && sample.cell_count > 0);
        assert!(benchmark1.table_count > 0 && benchmark1.cell_count > 0);
        assert!(
            nested.table_count >= 2,
            "nested fixture must map nested tables"
        );
        assert!(
            nested
                .iter()
                .any(|(address, _)| address.cell_path.len() >= 2),
            "nested fixture did not produce a depth-2 CellPath"
        );
    }

    #[test]
    fn no_edit_export_is_byte_identical() {
        let (bytes, doc) = load_fixture("benchmarks/benchmark.hwp");
        let export = export_hwp5(&bytes, &doc, &doc).unwrap();
        assert_eq!(export.report.capability, Capability::NoChanges);
        assert_eq!(export.strategy, Some(WriteStrategy::NoOpOriginalBytes));
        assert_eq!(export.bytes.unwrap(), bytes);
    }

    #[test]
    fn security_or_history_file_flags_are_refused() {
        use std::io::{Seek, SeekFrom, Write};

        let (bytes, doc) = load_fixture("benchmarks/benchmark.hwp");
        for flag in [
            1 << 1,
            1 << 2,
            1 << 4,
            1 << 6,
            1 << 7,
            1 << 8,
            1 << 9,
            1 << 10,
        ] {
            let mut compound = CompoundFile::open(Cursor::new(bytes.clone())).unwrap();
            {
                let mut header = compound.open_stream("/FileHeader").unwrap();
                header.seek(SeekFrom::Start(36)).unwrap();
                header.write_all(&(1_u32 | flag).to_le_bytes()).unwrap();
                header.flush().unwrap();
            }
            let guarded = compound.into_inner().into_inner();
            assert!(matches!(
                observe(&guarded, &doc),
                Err(Error::Unsupported(_))
            ));
        }
    }

    #[test]
    fn nested_cell_text_patch_reparses_and_preserves_unedited_streams() {
        let (bytes, original) = load_fixture("external/rhwp/samples/inner-table-01.hwp");
        let map = observe(&bytes, &original).unwrap();
        let address = map
            .iter()
            .find(|(address, record)| {
                address.cell_path.len() >= 2 && record.patchable && !record.semantic_text.is_empty()
            })
            .map(|(address, _)| address.clone())
            .expect("nested patchable paragraph");
        let before = paragraph_text(resolve_paragraph(&original, &address));
        let mut edited = original.clone();
        let paragraph = resolve_paragraph_mut(&mut edited, &address);
        let text = paragraph
            .runs
            .iter_mut()
            .rev()
            .flat_map(|run| run.content.iter_mut().rev())
            .find_map(|inline| match inline {
                Inline::Text(text) => Some(text),
                _ => None,
            })
            .unwrap();
        text.push_str(" [082]");
        let expected = format!("{before} [082]");

        let export = export_hwp5(&bytes, &original, &edited).unwrap();
        assert_eq!(export.report.capability, Capability::TextPatch);
        assert_eq!(export.report.edit_count, 1);
        assert_eq!(export.strategy, Some(WriteStrategy::InPlaceAllocator));
        let output = export.bytes.unwrap();
        let reparsed = hwp_core::Engine::open(&output).expect("rhwp reparses patched HWP5");
        assert_eq!(
            paragraph_text(resolve_paragraph(&reparsed, &address)),
            expected
        );
        let remapped = observe(&output, &reparsed).expect("patched addresses re-observe");
        assert_eq!(remapped.paragraph_count, map.paragraph_count);
        assert_eq!(remapped.exact_text_matches, remapped.paragraph_count);

        let before_streams = stream_map(&bytes);
        let after_streams = stream_map(&output);
        assert_eq!(
            before_streams.keys().collect::<Vec<_>>(),
            after_streams.keys().collect::<Vec<_>>()
        );
        for (path, original_stream) in &before_streams {
            if matches!(
                path.as_str(),
                "/BodyText/Section0" | "/PrvText" | "/PrvImage"
            ) {
                continue;
            }
            assert_eq!(
                after_streams[path], *original_stream,
                "unedited stream changed: {path}"
            );
        }
        assert_eq!(after_streams["/FileHeader"], before_streams["/FileHeader"]);
        for preview in ["/PrvText", "/PrvImage"] {
            if after_streams.contains_key(preview) {
                assert!(
                    after_streams[preview].is_empty(),
                    "{preview} was not invalidated"
                );
            }
        }
        CompoundFile::open_strict(Cursor::new(&output)).expect("strict CFB accepts output");
        assert_eq!(
            &output[..512],
            &bytes[..512],
            "same-chain edit changed CFB header sector"
        );
        let changed_sectors = bytes
            .chunks(512)
            .zip(output.chunks(512))
            .filter(|(before, after)| before != after)
            .count();
        assert_eq!(
            output.len(),
            32_768,
            "fixture allocation unexpectedly changed"
        );
        assert_eq!(
            changed_sectors, 23,
            "physical diff scope (including preview-sector zeroing) regressed"
        );
        eprintln!(
            "nested HWP5 patch: bytes {}→{}, changed physical sectors={changed_sectors}",
            bytes.len(),
            output.len()
        );
    }

    #[test]
    fn empty_nested_text_roundtrips_as_no_para_text() {
        let (bytes, original) = load_fixture("external/rhwp/samples/inner-table-01.hwp");
        let map = observe(&bytes, &original).unwrap();
        let address = map
            .iter()
            .find(|(address, record)| {
                address.cell_path.len() >= 2 && record.patchable && !record.semantic_text.is_empty()
            })
            .map(|(address, _)| address.clone())
            .unwrap();
        let mut edited = original.clone();
        for run in &mut resolve_paragraph_mut(&mut edited, &address).runs {
            for inline in &mut run.content {
                if let Inline::Text(text) = inline {
                    text.clear();
                }
            }
        }
        let export = export_hwp5(&bytes, &original, &edited).unwrap();
        assert_eq!(export.report.capability, Capability::TextPatch);
        let output = export.bytes.unwrap();
        let reparsed = hwp_core::Engine::open(&output).unwrap();
        assert_eq!(paragraph_text(resolve_paragraph(&reparsed, &address)), "");
        let output_map = observe(&output, &reparsed).unwrap();
        assert!(output_map.get(&address).unwrap().para_text.is_none());
    }

    #[test]
    fn structural_edit_returns_honest_capability_refusal() {
        let (bytes, original) = load_fixture("benchmarks/benchmark.hwp");
        let mut edited = original.clone();
        let table = edited.sections[0]
            .blocks
            .iter_mut()
            .find_map(|block| match block {
                Block::Table(table) => Some(table),
                _ => None,
            })
            .unwrap();
        table.rows += 1;
        let export = export_hwp5(&bytes, &original, &edited).unwrap();
        assert_eq!(export.report.capability, Capability::Unsupported);
        assert!(export.bytes.is_none());
        assert!(export
            .report
            .recommendation
            .unwrap()
            .contains("HWPX 또는 PDF"));
        assert!(export
            .report
            .reasons
            .iter()
            .any(|reason| reason.contains("표 구조")));
    }
}
