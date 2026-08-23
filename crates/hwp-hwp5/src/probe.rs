use crate::{parse_file_header, walk_records, Error, FileHeader, Record, RecordLimits, Result};
use cfb::CompoundFile;
use flate2::read::DeflateDecoder;
use hwp_ingest::limits::{self, MAX_DECOMPRESSED_TOTAL, MAX_ENTRY_COUNT};
use hwp_model::document::{Block, Inline, SemanticDoc};
use serde::Serialize;
use std::io::{Cursor, Read, Seek};

const TAG_PARA_HEADER: u16 = 0x42;
const TAG_PARA_CHAR_SHAPE: u16 = 0x44;
const TAG_CTRL_HEADER: u16 = 0x47;
const TAG_TABLE: u16 = 0x4d;
const TAG_PICTURE: u16 = 0x55;
const TAG_EQUATION: u16 = 0x58;
const TAG_CHART: u16 = 0x5f;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct StreamProbe {
    /// `None` is DocInfo; `Some(n)` is the standard BodyText section ordinal. No source path is kept.
    pub section: Option<usize>,
    pub decompressed_bytes: usize,
    pub records: Vec<Record>,
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
                content: vec![Inline::Text("private-a".into())],
            }],
            ..Default::default()
        });
        let mut right = left.clone();
        let Block::Paragraph(paragraph) = &mut right.sections[0].blocks[0] else {
            unreachable!()
        };
        paragraph.runs[0].content[0] = Inline::Text("different-secret".into());
        let (_, a) = semantic_inventory(&left);
        let (_, b) = semantic_inventory(&right);
        assert_eq!(a, b);
    }
}
