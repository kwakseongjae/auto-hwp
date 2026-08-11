use crate::{
    inflate, observe, paragraph_text, read_stream, AddressMap, CellStep, Error, ParagraphAddress,
    ParagraphRecord, Result,
};
use cfb::{CompoundFile, Entry};
use flate2::{write::DeflateEncoder, Compression};
use hwp_model::document::{Cell, ImageRef, PageSetup, Paragraph, Table};
use hwp_model::prelude::{Block, Inline, SemanticDoc};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::io::{Cursor, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

const HWP_RECOMMENDATION: &str =
    "이 세션의 편집은 HWP5 텍스트 패치 v1 범위를 벗어납니다. HWPX 또는 PDF로 내보내세요.";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    NoChanges,
    TextPatch,
    Unsupported,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TextEdit {
    pub address: ParagraphAddress,
    pub before: String,
    pub after: String,
    /// Minimal changed range in the original paragraph, measured in UTF-16 code units.
    pub start_utf16: u32,
    pub old_end_utf16: u32,
    /// End of the replacement range in the edited paragraph, measured in UTF-16 code units.
    pub new_end_utf16: u32,
}

#[derive(Clone, Debug, Serialize)]
pub struct CapabilityReport {
    pub capability: Capability,
    pub source_format: &'static str,
    pub edit_count: usize,
    pub edits: Vec<TextEdit>,
    pub reasons: Vec<String>,
    pub recommendation: Option<&'static str>,
}

impl CapabilityReport {
    pub fn supported(&self) -> bool {
        self.capability != Capability::Unsupported
    }

    pub fn summary(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| {
            format!(
                "capability={:?}, edits={}, reasons={:?}",
                self.capability, self.edit_count, self.reasons
            )
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WriteStrategy {
    NoOpOriginalBytes,
    InPlaceAllocator,
    FullRewriteFallback,
}

#[derive(Clone, Debug, Serialize)]
pub struct ExportResult {
    /// `None` iff the capability report refuses the session.
    #[serde(skip)]
    pub bytes: Option<Vec<u8>>,
    pub report: CapabilityReport,
    pub strategy: Option<WriteStrategy>,
    pub invalidated_preview_streams: Vec<String>,
}

/// Compare the pristine HWP5 lift with the current live IR. Only text changes whose structure and
/// formatting can be reproduced by shifting existing PARA_CHAR_SHAPE boundaries are accepted.
pub fn analyze(
    original_bytes: &[u8],
    original_doc: &SemanticDoc,
    edited_doc: &SemanticDoc,
) -> Result<CapabilityReport> {
    let map = observe(original_bytes, original_doc)?;
    let mut changes = Vec::new();
    let mut reasons = BTreeSet::new();

    if edited_doc.origin != original_doc.origin {
        reasons.insert("문서 원본 형식(origin)이 변경되었습니다".to_string());
    }
    if !bin_data_equal(original_doc, edited_doc) {
        reasons.insert("이미지/BinData가 변경되었습니다 (HWP5 v1은 텍스트 전용)".to_string());
    }
    if original_doc.sections.len() != edited_doc.sections.len() {
        reasons.insert(format!(
            "구역 수가 {} → {}로 변경되었습니다",
            original_doc.sections.len(),
            edited_doc.sections.len()
        ));
    }

    for section_index in 0..original_doc.sections.len().min(edited_doc.sections.len()) {
        let original = &original_doc.sections[section_index];
        let edited = &edited_doc.sections[section_index];
        if !page_equal(original.page, edited.page) || original.page_edited != edited.page_edited {
            reasons.insert(format!(
                "section {section_index}: 용지/여백 설정이 변경되었습니다"
            ));
        }
        if original.decorations.len() != edited.decorations.len()
            || edited
                .decorations
                .iter()
                .flat_map(|decoration| &decoration.blocks)
                .any(Block::any_dirty)
        {
            reasons.insert(format!(
                "section {section_index}: 머리말/꼬리말 편집은 HWP5 v1 범위가 아닙니다"
            ));
        }
        let mut path = Vec::new();
        compare_blocks(
            original_doc,
            edited_doc,
            section_index,
            &original.blocks,
            &edited.blocks,
            &mut path,
            &map,
            &mut changes,
            &mut reasons,
        );
    }

    let reasons: Vec<String> = reasons.into_iter().collect();
    let capability = if !reasons.is_empty() {
        Capability::Unsupported
    } else if changes.is_empty() {
        Capability::NoChanges
    } else {
        Capability::TextPatch
    };
    Ok(CapabilityReport {
        capability,
        source_format: "hwp5",
        edit_count: changes.len(),
        edits: changes,
        reasons,
        recommendation: (capability == Capability::Unsupported).then_some(HWP_RECOMMENDATION),
    })
}

/// Export the live IR back into the original HWP5 container. Unsupported sessions return a report
/// with `bytes=None`; no-change sessions return the exact original allocation and bytes untouched.
pub fn export_hwp5(
    original_bytes: &[u8],
    original_doc: &SemanticDoc,
    edited_doc: &SemanticDoc,
) -> Result<ExportResult> {
    let report = analyze(original_bytes, original_doc, edited_doc)?;
    match report.capability {
        Capability::Unsupported => Ok(ExportResult {
            bytes: None,
            report,
            strategy: None,
            invalidated_preview_streams: Vec::new(),
        }),
        Capability::NoChanges => Ok(ExportResult {
            bytes: Some(original_bytes.to_vec()),
            report,
            strategy: Some(WriteStrategy::NoOpOriginalBytes),
            invalidated_preview_streams: Vec::new(),
        }),
        Capability::TextPatch => {
            let map = observe(original_bytes, original_doc)?;
            let (replacements, compressed) =
                build_section_replacements(original_bytes, &map, &report)?;
            let (bytes, strategy, invalidated_preview_streams) =
                patch_container(original_bytes, &replacements, compressed)?;
            Ok(ExportResult {
                bytes: Some(bytes),
                report,
                strategy: Some(strategy),
                invalidated_preview_streams,
            })
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn compare_blocks(
    original_doc: &SemanticDoc,
    edited_doc: &SemanticDoc,
    section: usize,
    original: &[Block],
    edited: &[Block],
    path: &mut Vec<CellStep>,
    map: &AddressMap,
    changes: &mut Vec<TextEdit>,
    reasons: &mut BTreeSet<String>,
) {
    if original.len() != edited.len() {
        reasons.insert(format!(
            "section {section} path {path:?}: 블록 수가 {} → {}로 변경되었습니다",
            original.len(),
            edited.len()
        ));
    }
    for index in 0..original.len().min(edited.len()) {
        match (&original[index], &edited[index]) {
            (Block::Paragraph(before), Block::Paragraph(after)) => {
                let address = ParagraphAddress {
                    section,
                    cell_path: path.clone(),
                    block: index,
                };
                compare_paragraph(
                    original_doc,
                    edited_doc,
                    before,
                    after,
                    address,
                    map,
                    changes,
                    reasons,
                );
            }
            (Block::Table(before), Block::Table(after)) => compare_table(
                original_doc,
                edited_doc,
                section,
                before,
                after,
                index,
                path,
                map,
                changes,
                reasons,
            ),
            _ => {
                reasons.insert(format!(
                    "section {section} path {path:?} block {index}: 블록 종류가 변경되었습니다"
                ));
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn compare_paragraph(
    original_doc: &SemanticDoc,
    edited_doc: &SemanticDoc,
    before: &Paragraph,
    after: &Paragraph,
    address: ParagraphAddress,
    map: &AddressMap,
    changes: &mut Vec<TextEdit>,
    reasons: &mut BTreeSet<String>,
) {
    let label = address_label(&address);
    if !paragraph_frame_equal(original_doc, edited_doc, before, after) {
        reasons.insert(format!("{label}: 문단 서식/속성이 변경되었습니다"));
    }
    let before_text = paragraph_text(before);
    let after_text = paragraph_text(after);
    if before_text == after_text {
        if !paragraph_content_equal(original_doc, edited_doc, before, after) {
            reasons.insert(format!(
                "{label}: 텍스트 외 인라인 또는 글자 서식이 변경되었습니다"
            ));
        }
        return;
    }

    let Some(record) = map.get(&address) else {
        // Object-only paragraphs are lift-derived blocks, not source PARA_HEADERs. Any attempted
        // text mutation there is structural from the HWP5 writer's perspective.
        reasons.insert(format!("{label}: 원본 HWP5 문단 레코드 주소가 없습니다"));
        return;
    };
    if !record.patchable {
        reasons.insert(format!(
            "{label}: 컨트롤/자동번호가 섞인 문단은 안전하게 raw 패치할 수 없습니다"
        ));
    }
    if after_text.is_empty()
        && (record
            .para_header
            .end_offset
            .saturating_sub(record.para_header.data_offset)
            < 18
            || record
                .para_char_shape
                .is_none_or(|span| span.end_offset.saturating_sub(span.data_offset) < 8)
            || record
                .para_line_seg
                .is_none_or(|span| span.end_offset.saturating_sub(span.data_offset) < 36))
    {
        reasons.insert(format!(
            "{label}: 네이티브 빈 문단에 필요한 PARA_HEADER/CHAR_SHAPE/LINE_SEG가 없습니다"
        ));
    }
    if !text_only(before) || !text_only(after) {
        reasons.insert(format!(
            "{label}: 이미지·필드·각주가 섞인 문단은 텍스트 전용이 아닙니다"
        ));
        return;
    }
    if let Some(ch) = after_text
        .chars()
        .find(|ch| (*ch as u32) < 0x20 && *ch != '\n')
    {
        reasons.insert(format!(
            "{label}: 제어문자 U+{:04X}는 HWP5 v1에서 지원하지 않습니다",
            ch as u32
        ));
    }

    let diff = minimal_diff(&before_text, &after_text);
    if !style_compatible_for_diff(original_doc, edited_doc, before, after, diff) {
        reasons.insert(format!(
            "{label}: 변경 구간의 글자 서식이 원본 PARA_CHAR_SHAPE로 재현되지 않습니다"
        ));
    }
    changes.push(TextEdit {
        address,
        before: before_text,
        after: after_text,
        start_utf16: diff.start as u32,
        old_end_utf16: diff.old_end as u32,
        new_end_utf16: diff.new_end as u32,
    });
}

#[allow(clippy::too_many_arguments)]
fn compare_table(
    original_doc: &SemanticDoc,
    edited_doc: &SemanticDoc,
    section: usize,
    before: &Table,
    after: &Table,
    table_block: usize,
    path: &mut Vec<CellStep>,
    map: &AddressMap,
    changes: &mut Vec<TextEdit>,
    reasons: &mut BTreeSet<String>,
) {
    if !table_frame_equal(before, after) {
        reasons.insert(format!(
            "section {section} path {path:?} table block {table_block}: 표 구조/서식이 변경되었습니다"
        ));
    }
    if before.cells.len() != after.cells.len() {
        reasons.insert(format!(
            "section {section} path {path:?} table block {table_block}: 셀 수가 {} → {}로 변경되었습니다",
            before.cells.len(),
            after.cells.len()
        ));
    }
    for cell_index in 0..before.cells.len().min(after.cells.len()) {
        let before_cell = &before.cells[cell_index];
        let after_cell = &after.cells[cell_index];
        if !cell_frame_equal(before_cell, after_cell) {
            reasons.insert(format!(
                "section {section} path {path:?} table block {table_block} cell {cell_index}: 셀 구조/서식이 변경되었습니다"
            ));
        }
        path.push(CellStep {
            block: table_block,
            row: before_cell.row,
            col: before_cell.col,
        });
        compare_blocks(
            original_doc,
            edited_doc,
            section,
            &before_cell.blocks,
            &after_cell.blocks,
            path,
            map,
            changes,
            reasons,
        );
        path.pop();
    }
}

fn paragraph_frame_equal(
    original_doc: &SemanticDoc,
    edited_doc: &SemanticDoc,
    before: &Paragraph,
    after: &Paragraph,
) -> bool {
    before.id == after.id
        && before.page_break_before == after.page_break_before
        && before.is_table_anchor == after.is_table_anchor
        && before.style_name == after.style_name
        && shape_at(
            &original_doc.para_shapes,
            before.para_shape,
            &edited_doc.para_shapes,
            after.para_shape,
        )
}

fn paragraph_content_equal(
    original_doc: &SemanticDoc,
    edited_doc: &SemanticDoc,
    before: &Paragraph,
    after: &Paragraph,
) -> bool {
    if !text_only(before) || !text_only(after) {
        return !before.dirty.is_dirty() && !after.dirty.is_dirty();
    }
    let before_styles = style_units(before);
    let after_styles = style_units(after);
    before_styles.len() == after_styles.len()
        && before_styles
            .iter()
            .zip(&after_styles)
            .all(|(lhs, rhs)| char_shape_equal(original_doc, *lhs, edited_doc, *rhs))
        && first_run_shape_equal(original_doc, before, edited_doc, after)
}

fn text_only(paragraph: &Paragraph) -> bool {
    paragraph
        .runs
        .iter()
        .flat_map(|run| &run.content)
        .all(|inline| matches!(inline, Inline::Text(_)))
}

#[derive(Clone, Copy)]
struct DiffRange {
    start: usize,
    old_end: usize,
    new_end: usize,
}

fn minimal_diff(before: &str, after: &str) -> DiffRange {
    let before: Vec<u16> = before.encode_utf16().collect();
    let after: Vec<u16> = after.encode_utf16().collect();
    let mut start = 0usize;
    while start < before.len() && start < after.len() && before[start] == after[start] {
        start += 1;
    }
    let mut suffix = 0usize;
    while suffix < before.len().saturating_sub(start)
        && suffix < after.len().saturating_sub(start)
        && before[before.len() - 1 - suffix] == after[after.len() - 1 - suffix]
    {
        suffix += 1;
    }
    DiffRange {
        start,
        old_end: before.len() - suffix,
        new_end: after.len() - suffix,
    }
}

fn style_compatible_for_diff(
    original_doc: &SemanticDoc,
    edited_doc: &SemanticDoc,
    before: &Paragraph,
    after: &Paragraph,
    diff: DiffRange,
) -> bool {
    let old_styles = style_units(before);
    let new_styles = style_units(after);
    if old_styles.len() != before_text_len(before) || new_styles.len() != before_text_len(after) {
        return false;
    }
    let prefix_ok = (0..diff.start)
        .all(|idx| char_shape_equal(original_doc, old_styles[idx], edited_doc, new_styles[idx]));
    let old_suffix_len = old_styles.len().saturating_sub(diff.old_end);
    let new_suffix_len = new_styles.len().saturating_sub(diff.new_end);
    let suffix_ok = old_suffix_len == new_suffix_len
        && (0..old_suffix_len).all(|offset| {
            char_shape_equal(
                original_doc,
                old_styles[diff.old_end + offset],
                edited_doc,
                new_styles[diff.new_end + offset],
            )
        });
    let inherited = if old_styles.is_empty() {
        before.runs.first().map(|run| run.char_shape)
    } else if diff.start < old_styles.len() {
        Some(old_styles[diff.start])
    } else {
        old_styles.last().copied()
    };
    let replacement_ok = match inherited {
        Some(expected) => (diff.start..diff.new_end)
            .all(|idx| char_shape_equal(original_doc, expected, edited_doc, new_styles[idx])),
        None => diff.start == diff.new_end,
    };
    prefix_ok && suffix_ok && replacement_ok
}

fn before_text_len(paragraph: &Paragraph) -> usize {
    paragraph_text(paragraph).encode_utf16().count()
}

fn style_units(paragraph: &Paragraph) -> Vec<usize> {
    let mut out = Vec::new();
    for run in &paragraph.runs {
        for inline in &run.content {
            if let Inline::Text(text) = inline {
                out.extend(std::iter::repeat_n(
                    run.char_shape,
                    text.encode_utf16().count(),
                ));
            }
        }
    }
    out
}

fn first_run_shape_equal(
    original_doc: &SemanticDoc,
    before: &Paragraph,
    edited_doc: &SemanticDoc,
    after: &Paragraph,
) -> bool {
    match (before.runs.first(), after.runs.first()) {
        (None, None) => true,
        (Some(lhs), Some(rhs)) => {
            char_shape_equal(original_doc, lhs.char_shape, edited_doc, rhs.char_shape)
        }
        _ => false,
    }
}

fn char_shape_equal(
    original_doc: &SemanticDoc,
    before: usize,
    edited_doc: &SemanticDoc,
    after: usize,
) -> bool {
    shape_at(
        &original_doc.char_shapes,
        before,
        &edited_doc.char_shapes,
        after,
    )
}

fn shape_at<T: PartialEq>(before: &[T], lhs: usize, after: &[T], rhs: usize) -> bool {
    before
        .get(lhs)
        .zip(after.get(rhs))
        .is_some_and(|(a, b)| a == b)
}

fn table_frame_equal(before: &Table, after: &Table) -> bool {
    before.rows == after.rows
        && before.cols == after.cols
        && before.col_widths == after.col_widths
        && before.row_heights == after.row_heights
        && before.fixed_row_heights == after.fixed_row_heights
        && before.stored_row_heights == after.stored_row_heights
        && before.geometry_edited == after.geometry_edited
        && before.outer_margin_top == after.outer_margin_top
        && before.outer_margin_bottom == after.outer_margin_bottom
        && before.outer_margin_left == after.outer_margin_left
        && before.outer_margin_right == after.outer_margin_right
        && before.padding == after.padding
        && before.borders == after.borders
}

fn cell_frame_equal(before: &Cell, after: &Cell) -> bool {
    before.row == after.row
        && before.col == after.col
        && before.row_span == after.row_span
        && before.col_span == after.col_span
        && before.active == after.active
        && before.shade_color == after.shade_color
        && image_equal(before.fill_image.as_ref(), after.fill_image.as_ref())
        && before.has_border == after.has_border
        && before.borders == after.borders
        && before.diagonal == after.diagonal
        && before.padding == after.padding
        && before.width == after.width
}

fn image_equal(before: Option<&ImageRef>, after: Option<&ImageRef>) -> bool {
    match (before, after) {
        (None, None) => true,
        (Some(lhs), Some(rhs)) => {
            lhs.bin_ref == rhs.bin_ref && lhs.width == rhs.width && lhs.height == rhs.height
        }
        _ => false,
    }
}

fn page_equal(before: PageSetup, after: PageSetup) -> bool {
    before.width == after.width
        && before.height == after.height
        && before.margin_left == after.margin_left
        && before.margin_right == after.margin_right
        && before.margin_top == after.margin_top
        && before.margin_bottom == after.margin_bottom
        && before.margin_header == after.margin_header
        && before.margin_footer == after.margin_footer
        && before.margin_gutter == after.margin_gutter
        && before.landscape == after.landscape
        && before.columns == after.columns
}

fn bin_data_equal(before: &SemanticDoc, after: &SemanticDoc) -> bool {
    before.bin_data.len() == after.bin_data.len()
        && before
            .bin_data
            .iter()
            .zip(&after.bin_data)
            .all(|(lhs, rhs)| {
                lhs.bin_ref == rhs.bin_ref && lhs.kind == rhs.kind && lhs.bytes == rhs.bytes
            })
}

fn address_label(address: &ParagraphAddress) -> String {
    format!(
        "section {} path {:?} paragraph block {}",
        address.section, address.cell_path, address.block
    )
}

fn build_section_replacements(
    original_bytes: &[u8],
    map: &AddressMap,
    report: &CapabilityReport,
) -> Result<(BTreeMap<String, Vec<u8>>, bool)> {
    let mut compound = CompoundFile::open(Cursor::new(original_bytes))
        .map_err(|error| Error::Cfb(error.to_string()))?;
    let header = read_stream(&mut compound, "/FileHeader")?;
    let flags = header
        .get(36..40)
        .ok_or_else(|| Error::Unsupported("FileHeader is shorter than 40 bytes".into()))?;
    let compressed = u32::from_le_bytes(flags.try_into().unwrap()) & 1 != 0;

    let mut edits_by_stream: BTreeMap<String, Vec<(&TextEdit, &ParagraphRecord)>> = BTreeMap::new();
    for edit in &report.edits {
        let record = map.get(&edit.address).ok_or_else(|| {
            Error::Mapping(format!(
                "address disappeared before write: {:?}",
                edit.address
            ))
        })?;
        edits_by_stream
            .entry(record.section_stream.clone())
            .or_default()
            .push((edit, record));
    }

    let mut replacements = BTreeMap::new();
    for (stream_path, mut edits) in edits_by_stream {
        let stored = read_stream(&mut compound, &stream_path)?;
        let stored_len = stored.len();
        let mut raw = if compressed {
            inflate(&stored, &stream_path)?
        } else {
            stored
        };
        edits.sort_by_key(|(_, record)| std::cmp::Reverse(record.para_header.header_offset));
        for (edit, record) in edits {
            patch_paragraph(&mut raw, record, edit)?;
        }
        let mut next = if compressed { deflate(&raw)? } else { raw };
        // cfb chooses mini-vs-regular storage from stream length. A regular compressed Section that
        // happens to shrink below 4096 must remain regular; raw DEFLATE ignores zero tail padding.
        if compressed && stored_len >= 4096 && next.len() < 4096 {
            next.resize(4096, 0);
        }
        replacements.insert(stream_path, next);
    }
    Ok((replacements, compressed))
}

fn patch_paragraph(raw: &mut Vec<u8>, record: &ParagraphRecord, edit: &TextEdit) -> Result<()> {
    if !record.patchable || record.contains_controls {
        return Err(Error::Unsupported(format!(
            "{} is not a patchable plain-text paragraph",
            address_label(&edit.address)
        )));
    }
    let new_utf16_len = edit.after.encode_utf16().count();
    if new_utf16_len >= 0x7fff_ffff {
        return Err(Error::Unsupported(
            "paragraph exceeds HWP5 nchars range".into(),
        ));
    }
    let count_offset = record.para_header.data_offset;
    let old_count = read_u32(raw, count_offset)?;
    let expected_old = edit.before.encode_utf16().count() as u32 + 1;
    if old_count & 0x7fff_ffff != expected_old {
        return Err(Error::Record(format!(
            "{} nchars mismatch: header={} expected={expected_old}",
            address_label(&edit.address),
            old_count & 0x7fff_ffff
        )));
    }
    write_u32(
        raw,
        count_offset,
        (old_count & 0x8000_0000) | (new_utf16_len as u32 + 1),
    )?;

    let mut splices = Vec::new();
    if edit.after.is_empty() {
        if let Some(text) = record.para_text {
            splices.push(Splice::replace(
                text.header_offset,
                text.end_offset,
                Vec::new(),
            ));
        }
        let char_shape = record.para_char_shape.ok_or_else(|| {
            Error::Unsupported(format!(
                "{} cannot form a native empty paragraph without PARA_CHAR_SHAPE",
                address_label(&edit.address)
            ))
        })?;
        let line_seg = record.para_line_seg.ok_or_else(|| {
            Error::Unsupported(format!(
                "{} cannot form a native empty paragraph without PARA_LINE_SEG",
                address_label(&edit.address)
            ))
        })?;
        let char_body = raw
            .get(char_shape.data_offset..char_shape.data_offset + 8)
            .ok_or_else(|| Error::Record("PARA_CHAR_SHAPE is shorter than one entry".into()))?
            .to_vec();
        let line_body = raw
            .get(line_seg.data_offset..line_seg.data_offset + 36)
            .ok_or_else(|| Error::Record("PARA_LINE_SEG is shorter than one entry".into()))?
            .to_vec();
        splices.push(Splice::replace(
            char_shape.header_offset,
            char_shape.end_offset,
            build_record(0x44, char_shape.level, &char_body),
        ));
        splices.push(Splice::replace(
            line_seg.header_offset,
            line_seg.end_offset,
            build_record(0x45, line_seg.level, &line_body),
        ));
        write_u16(raw, record.para_header.data_offset + 12, 1)?;
        write_u16(raw, record.para_header.data_offset + 16, 1)?;
    } else {
        let text_record = build_para_text_record(&edit.after, record.para_header.level + 1);
        if let Some(text) = record.para_text {
            splices.push(Splice::replace(
                text.header_offset,
                text.end_offset,
                text_record,
            ));
        } else {
            splices.push(Splice::replace(
                record.para_header.end_offset,
                record.para_header.end_offset,
                text_record,
            ));
        }
        if let Some(char_shape) = record.para_char_shape {
            shift_char_shapes(raw, char_shape, edit)?;
        }
    }
    apply_splices(raw, splices)
}

fn shift_char_shapes(raw: &mut [u8], span: crate::RecordSpan, edit: &TextEdit) -> Result<()> {
    let body = &raw[span.data_offset..span.end_offset];
    if !body.len().is_multiple_of(8) {
        return Err(Error::Record(format!(
            "PARA_CHAR_SHAPE at {} has non-entry size {}",
            span.header_offset,
            body.len()
        )));
    }
    let start = edit.start_utf16;
    let old_end = edit.old_end_utf16;
    let delta = edit.new_end_utf16 as i64 - edit.old_end_utf16 as i64;
    for entry in (span.data_offset..span.end_offset).step_by(8) {
        let position = read_u32(raw, entry)?;
        let shifted = if position <= start {
            position as i64
        } else if position >= old_end {
            position as i64 + delta
        } else {
            start as i64
        };
        if !(0..=u32::MAX as i64).contains(&shifted) {
            return Err(Error::Record(format!(
                "PARA_CHAR_SHAPE position {position} shifted out of range"
            )));
        }
        write_u32(raw, entry, shifted as u32)?;
    }
    Ok(())
}

#[derive(Debug)]
struct Splice {
    start: usize,
    end: usize,
    replacement: Vec<u8>,
}

impl Splice {
    fn replace(start: usize, end: usize, replacement: Vec<u8>) -> Self {
        Self {
            start,
            end,
            replacement,
        }
    }
}

fn apply_splices(bytes: &mut Vec<u8>, mut splices: Vec<Splice>) -> Result<()> {
    splices.sort_by_key(|splice| std::cmp::Reverse(splice.start));
    let mut previous_start = bytes.len() + 1;
    for splice in splices {
        if splice.start > splice.end || splice.end > bytes.len() || splice.end > previous_start {
            return Err(Error::Record(format!(
                "invalid/overlapping section splice {}..{} (len {}, previous {})",
                splice.start,
                splice.end,
                bytes.len(),
                previous_start
            )));
        }
        bytes.splice(splice.start..splice.end, splice.replacement);
        previous_start = splice.start;
    }
    Ok(())
}

fn build_para_text_record(text: &str, level: u16) -> Vec<u8> {
    let mut body = Vec::with_capacity(text.len() * 2 + 2);
    for unit in text.encode_utf16() {
        body.extend_from_slice(&unit.to_le_bytes());
    }
    body.extend_from_slice(&0x000d_u16.to_le_bytes());
    build_record(0x43, level, &body)
}

fn build_record(tag: u16, level: u16, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len() + 8);
    if body.len() > 0xffe {
        let header = (tag as u32) | ((level as u32) << 10) | (0xfff << 20);
        out.extend_from_slice(&header.to_le_bytes());
        out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    } else {
        let header = (tag as u32) | ((level as u32) << 10) | ((body.len() as u32) << 20);
        out.extend_from_slice(&header.to_le_bytes());
    }
    out.extend_from_slice(body);
    out
}

fn deflate(raw: &[u8]) -> Result<Vec<u8>> {
    let mut encoder = DeflateEncoder::new(Vec::new(), Compression::best());
    encoder
        .write_all(raw)
        .map_err(|error| Error::Record(format!("deflate Section: {error}")))?;
    encoder
        .finish()
        .map_err(|error| Error::Record(format!("finish deflate Section: {error}")))
}

fn patch_container(
    original: &[u8],
    replacements: &BTreeMap<String, Vec<u8>>,
    _compressed: bool,
) -> Result<(Vec<u8>, WriteStrategy, Vec<String>)> {
    match patch_container_in_place(original, replacements) {
        Ok((bytes, invalidated)) => {
            Ok((bytes, WriteStrategy::InPlaceAllocator, invalidated))
        }
        Err(in_place_error) => match rewrite_container(original, replacements) {
            Ok((bytes, invalidated)) => {
                Ok((bytes, WriteStrategy::FullRewriteFallback, invalidated))
            }
            Err(rewrite_error) => Err(Error::Cfb(format!(
                "in-place allocator failed ({in_place_error}); full rewrite fallback failed ({rewrite_error})"
            ))),
        },
    }
}

fn patch_container_in_place(
    original: &[u8],
    replacements: &BTreeMap<String, Vec<u8>>,
) -> std::io::Result<(Vec<u8>, Vec<String>)> {
    let mut compound = CompoundFile::open(Cursor::new(original.to_vec()))?;
    for (path, bytes) in replacements {
        write_stream(&mut compound, path, bytes)?;
    }
    let invalidated = invalidate_previews(&mut compound)?;
    Ok((compound.into_inner().into_inner(), invalidated))
}

fn write_stream(
    compound: &mut CompoundFile<Cursor<Vec<u8>>>,
    path: &str,
    bytes: &[u8],
) -> std::io::Result<()> {
    let mut stream = compound.open_stream(path)?;
    stream.set_len(bytes.len() as u64)?;
    stream.seek(SeekFrom::Start(0))?;
    stream.write_all(bytes)?;
    stream.flush()
}

fn invalidate_previews(
    compound: &mut CompoundFile<Cursor<Vec<u8>>>,
) -> std::io::Result<Vec<String>> {
    let mut invalidated = Vec::new();
    for path in ["/PrvText", "/PrvImage"] {
        if compound.is_stream(path) {
            let mut stream = compound.open_stream(path)?;
            if !stream.is_empty() {
                // Truncation alone only frees the FAT/miniFAT chain; cfb intentionally leaves the
                // released sectors' bytes intact. Zero first so redacted preview text/image data is
                // absent even from unallocated sectors in the returned container.
                let mut remaining = stream.len();
                stream.seek(SeekFrom::Start(0))?;
                let zeros = [0_u8; 8192];
                while remaining > 0 {
                    let chunk = remaining.min(zeros.len() as u64) as usize;
                    stream.write_all(&zeros[..chunk])?;
                    remaining -= chunk as u64;
                }
                stream.flush()?;
                stream.set_len(0)?;
                stream.flush()?;
                invalidated.push(path.trim_start_matches('/').to_string());
            }
        }
    }
    Ok(invalidated)
}

/// Standards-based last resort. It recreates the same storage hierarchy/version and copies every
/// stream (plus state bits, CLSIDs and timestamps), substituting only edited Sections and empty
/// previews. The primary path never uses this unless the original allocator cannot be mutated.
fn rewrite_container(
    original: &[u8],
    replacements: &BTreeMap<String, Vec<u8>>,
) -> std::io::Result<(Vec<u8>, Vec<String>)> {
    let mut source = CompoundFile::open(Cursor::new(original))?;
    let version = source.version();
    let entries: Vec<Entry> = source.walk().collect();
    let mut stream_bytes = BTreeMap::<PathBuf, Vec<u8>>::new();
    for entry in &entries {
        if entry.is_stream() {
            let mut stream = source.open_stream(entry.path())?;
            let mut bytes = Vec::new();
            stream.read_to_end(&mut bytes)?;
            stream_bytes.insert(entry.path().to_path_buf(), bytes);
        }
    }

    let mut destination = CompoundFile::create_with_version(version, Cursor::new(Vec::new()))?;
    for entry in &entries {
        if entry.is_root() {
            destination.set_storage_clsid("/", *entry.clsid())?;
            destination.set_state_bits("/", entry.state_bits())?;
            destination.set_created_time("/", entry.created())?;
            destination.set_modified_time("/", entry.modified())?;
        } else if entry.is_storage() {
            destination.create_storage(entry.path())?;
        }
    }
    let mut invalidated = Vec::new();
    for entry in &entries {
        if !entry.is_stream() {
            continue;
        }
        let path_string = path_string(entry.path());
        let mut bytes = replacements
            .get(&path_string)
            .cloned()
            .unwrap_or_else(|| stream_bytes[entry.path()].clone());
        if matches!(path_string.as_str(), "/PrvText" | "/PrvImage") && !bytes.is_empty() {
            bytes.clear();
            invalidated.push(path_string.trim_start_matches('/').to_string());
        }
        let mut stream = destination.create_new_stream(entry.path())?;
        stream.write_all(&bytes)?;
        stream.flush()?;
    }
    for entry in &entries {
        if entry.is_root() {
            continue;
        }
        if entry.is_storage() {
            destination.set_storage_clsid(entry.path(), *entry.clsid())?;
        }
        destination.set_state_bits(entry.path(), entry.state_bits())?;
        destination.set_created_time(entry.path(), entry.created())?;
        destination.set_modified_time(entry.path(), entry.modified())?;
    }
    Ok((destination.into_inner().into_inner(), invalidated))
}

fn path_string(path: &Path) -> String {
    let display = path.to_string_lossy().replace('\\', "/");
    if display.starts_with('/') {
        display
    } else {
        format!("/{display}")
    }
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32> {
    let end = offset
        .checked_add(4)
        .filter(|end| *end <= bytes.len())
        .ok_or_else(|| Error::Record(format!("u32 at byte {offset} is out of bounds")))?;
    Ok(u32::from_le_bytes(bytes[offset..end].try_into().unwrap()))
}

fn write_u32(bytes: &mut [u8], offset: usize, value: u32) -> Result<()> {
    let end = offset
        .checked_add(4)
        .filter(|end| *end <= bytes.len())
        .ok_or_else(|| Error::Record(format!("u32 at byte {offset} is out of bounds")))?;
    bytes[offset..end].copy_from_slice(&value.to_le_bytes());
    Ok(())
}

fn write_u16(bytes: &mut [u8], offset: usize, value: u16) -> Result<()> {
    let end = offset
        .checked_add(2)
        .filter(|end| *end <= bytes.len())
        .ok_or_else(|| Error::Record(format!("u16 at byte {offset} is out of bounds")))?;
    bytes[offset..end].copy_from_slice(&value.to_le_bytes());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::raw;
    use cfb::Version;

    #[test]
    fn minimal_diff_uses_utf16_units() {
        let diff = minimal_diff("A😀Z", "A한😀Z");
        assert_eq!(diff.start, 1);
        assert_eq!(diff.old_end, 1);
        assert_eq!(diff.new_end, 2);
    }

    #[test]
    fn record_header_switches_to_extended_size() {
        let small = build_record(0x43, 1, &vec![0; 0xffe]);
        let large = build_record(0x43, 1, &vec![0; 0xfff]);
        assert_eq!(small.len(), 4 + 0xffe);
        assert_eq!(large.len(), 8 + 0xfff);
        assert_eq!(
            (u32::from_le_bytes(large[..4].try_into().unwrap()) >> 20) & 0xfff,
            0xfff
        );
    }

    #[test]
    fn paragraph_patch_preserves_last_flag_and_shifts_char_shape_positions() {
        let mut header_body = vec![0u8; 22];
        header_body[..4].copy_from_slice(&(0x8000_0000_u32 | 6).to_le_bytes());
        header_body[12..14].copy_from_slice(&2u16.to_le_bytes());
        header_body[16..18].copy_from_slice(&1u16.to_le_bytes());
        let mut char_shape = Vec::new();
        char_shape.extend_from_slice(&0u32.to_le_bytes());
        char_shape.extend_from_slice(&1u32.to_le_bytes());
        char_shape.extend_from_slice(&4u32.to_le_bytes());
        char_shape.extend_from_slice(&2u32.to_le_bytes());
        let mut raw_bytes = Vec::new();
        raw_bytes.extend_from_slice(&build_record(0x42, 0, &header_body));
        raw_bytes.extend_from_slice(&build_para_text_record("abcde", 1));
        raw_bytes.extend_from_slice(&build_record(0x44, 1, &char_shape));
        raw_bytes.extend_from_slice(&build_record(0x45, 1, &[0; 36]));

        let records = raw::parse_records(&raw_bytes).unwrap();
        let paragraphs = raw::parse_section(&records, &raw_bytes).unwrap();
        let raw_paragraph = &paragraphs[0];
        let make_span = |record: raw::Record| crate::RecordSpan {
            header_offset: record.head,
            data_offset: record.data,
            end_offset: record.end,
            level: record.level,
        };
        let address = ParagraphAddress {
            section: 0,
            cell_path: Vec::new(),
            block: 0,
        };
        let paragraph_record = ParagraphRecord {
            address: address.clone(),
            section_stream: "/BodyText/Section0".into(),
            para_header: make_span(records[raw_paragraph.header]),
            para_text: raw_paragraph.text.map(|idx| make_span(records[idx])),
            para_char_shape: raw_paragraph.char_shape.map(|idx| make_span(records[idx])),
            para_line_seg: raw_paragraph.line_seg.map(|idx| make_span(records[idx])),
            raw_text: "abcde".into(),
            semantic_text: "abcde".into(),
            contains_controls: false,
            patchable: true,
            raw_utf16_len: 5,
        };
        let edit = TextEdit {
            address,
            before: "abcde".into(),
            after: "abXYZde".into(),
            start_utf16: 2,
            old_end_utf16: 3,
            new_end_utf16: 5,
        };
        patch_paragraph(&mut raw_bytes, &paragraph_record, &edit).unwrap();

        let records = raw::parse_records(&raw_bytes).unwrap();
        let paragraphs = raw::parse_section(&records, &raw_bytes).unwrap();
        let paragraph = &paragraphs[0];
        let count = read_u32(&raw_bytes, records[paragraph.header].data).unwrap();
        assert_eq!(count & 0x8000_0000, 0x8000_0000);
        assert_eq!(count & 0x7fff_ffff, 8);
        assert_eq!(
            raw::paragraph_text(&records, &raw_bytes, paragraph)
                .unwrap()
                .text,
            "abXYZde"
        );
        let shape = records[paragraph.char_shape.unwrap()];
        assert_eq!(read_u32(&raw_bytes, shape.data).unwrap(), 0);
        assert_eq!(read_u32(&raw_bytes, shape.data + 8).unwrap(), 6);
    }

    #[test]
    fn empty_patch_uses_native_no_para_text_form() {
        let mut header_body = vec![0u8; 22];
        header_body[..4].copy_from_slice(&4u32.to_le_bytes());
        header_body[12..14].copy_from_slice(&2u16.to_le_bytes());
        header_body[16..18].copy_from_slice(&2u16.to_le_bytes());
        let mut raw_bytes = Vec::new();
        raw_bytes.extend_from_slice(&build_record(0x42, 0, &header_body));
        raw_bytes.extend_from_slice(&build_para_text_record("abc", 1));
        raw_bytes.extend_from_slice(&build_record(0x44, 1, &[0; 16]));
        raw_bytes.extend_from_slice(&build_record(0x45, 1, &[0; 72]));
        let records = raw::parse_records(&raw_bytes).unwrap();
        let paragraph = &raw::parse_section(&records, &raw_bytes).unwrap()[0];
        let make_span = |record: raw::Record| crate::RecordSpan {
            header_offset: record.head,
            data_offset: record.data,
            end_offset: record.end,
            level: record.level,
        };
        let address = ParagraphAddress {
            section: 0,
            cell_path: Vec::new(),
            block: 0,
        };
        let record = ParagraphRecord {
            address: address.clone(),
            section_stream: "/BodyText/Section0".into(),
            para_header: make_span(records[paragraph.header]),
            para_text: paragraph.text.map(|idx| make_span(records[idx])),
            para_char_shape: paragraph.char_shape.map(|idx| make_span(records[idx])),
            para_line_seg: paragraph.line_seg.map(|idx| make_span(records[idx])),
            raw_text: "abc".into(),
            semantic_text: "abc".into(),
            contains_controls: false,
            patchable: true,
            raw_utf16_len: 3,
        };
        let edit = TextEdit {
            address,
            before: "abc".into(),
            after: String::new(),
            start_utf16: 0,
            old_end_utf16: 3,
            new_end_utf16: 0,
        };
        patch_paragraph(&mut raw_bytes, &record, &edit).unwrap();
        let records = raw::parse_records(&raw_bytes).unwrap();
        let paragraph = &raw::parse_section(&records, &raw_bytes).unwrap()[0];
        assert!(paragraph.text.is_none());
        assert_eq!(
            records[paragraph.char_shape.unwrap()].end
                - records[paragraph.char_shape.unwrap()].data,
            8
        );
        assert_eq!(
            records[paragraph.line_seg.unwrap()].end - records[paragraph.line_seg.unwrap()].data,
            36
        );
        let header = records[paragraph.header];
        assert_eq!(read_u32(&raw_bytes, header.data).unwrap(), 1);
        assert_eq!(
            u16::from_le_bytes(
                raw_bytes[header.data + 12..header.data + 14]
                    .try_into()
                    .unwrap()
            ),
            1
        );
        assert_eq!(
            u16::from_le_bytes(
                raw_bytes[header.data + 16..header.data + 18]
                    .try_into()
                    .unwrap()
            ),
            1
        );
    }

    #[test]
    fn cfb_allocator_promotes_mini_stream_and_full_rewrite_is_valid() {
        let mut source =
            CompoundFile::create_with_version(Version::V3, Cursor::new(Vec::new())).unwrap();
        source.create_storage("/BodyText").unwrap();
        {
            let mut section = source.create_new_stream("/BodyText/Section0").unwrap();
            section.write_all(b"tiny").unwrap();
        }
        {
            let mut preview = source.create_new_stream("/PrvText").unwrap();
            preview.write_all(b"stale secret").unwrap();
        }
        let original = source.into_inner().into_inner();
        let replacement = vec![0x5a; 9_000];
        let replacements =
            BTreeMap::from([("/BodyText/Section0".to_string(), replacement.clone())]);

        let (patched, invalidated) = patch_container_in_place(&original, &replacements).unwrap();
        assert_eq!(invalidated, vec!["PrvText"]);
        assert!(
            !patched
                .windows(b"stale secret".len())
                .any(|window| window == b"stale secret"),
            "truncated preview bytes leaked from a released sector"
        );
        let mut strict = CompoundFile::open_strict(Cursor::new(&patched)).unwrap();
        assert_eq!(
            read_stream(&mut strict, "/BodyText/Section0").unwrap(),
            replacement
        );
        assert!(read_stream(&mut strict, "/PrvText").unwrap().is_empty());

        let (rewritten, invalidated) = rewrite_container(&original, &replacements).unwrap();
        assert_eq!(invalidated, vec!["PrvText"]);
        assert!(!rewritten
            .windows(b"stale secret".len())
            .any(|window| window == b"stale secret"));
        let mut strict = CompoundFile::open_strict(Cursor::new(&rewritten)).unwrap();
        assert_eq!(
            read_stream(&mut strict, "/BodyText/Section0")
                .unwrap()
                .len(),
            9_000
        );
        assert!(read_stream(&mut strict, "/PrvText").unwrap().is_empty());
    }
}
