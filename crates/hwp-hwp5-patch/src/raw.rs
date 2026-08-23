use crate::{Error, Result};
pub(crate) use hwp_hwp5::Record;

pub(crate) const TAG_PARA_HEADER: u16 = 0x42;
pub(crate) const TAG_PARA_TEXT: u16 = 0x43;
pub(crate) const TAG_PARA_CHAR_SHAPE: u16 = 0x44;
pub(crate) const TAG_PARA_LINE_SEG: u16 = 0x45;
pub(crate) const TAG_CTRL_HEADER: u16 = 0x47;
pub(crate) const TAG_LIST_HEADER: u16 = 0x48;
pub(crate) const TAG_TABLE: u16 = 0x4d;

// HWP stores control IDs as `u32::from_be_bytes(*b"....")`, serialized LE.
const CTRL_TABLE: u32 = u32::from_be_bytes(*b"tbl ");

#[derive(Clone, Debug)]
pub(crate) struct RawParagraph {
    pub(crate) header: usize,
    pub(crate) text: Option<usize>,
    pub(crate) char_shape: Option<usize>,
    pub(crate) line_seg: Option<usize>,
    pub(crate) controls: Vec<usize>,
    pub(crate) tables: Vec<RawTable>,
}

#[derive(Clone, Debug)]
pub(crate) struct RawTable {
    pub(crate) control: usize,
    pub(crate) cells: Vec<RawCell>,
}

#[derive(Clone, Debug)]
pub(crate) struct RawCell {
    pub(crate) list_header: usize,
    pub(crate) row: usize,
    pub(crate) col: usize,
    pub(crate) paragraphs: Vec<RawParagraph>,
}

pub(crate) fn parse_records(raw: &[u8]) -> Result<Vec<Record>> {
    hwp_hwp5::walk_records(raw, hwp_hwp5::RecordLimits::default())
        .map_err(|error| Error::Record(error.to_string()))
}

pub(crate) fn parse_section(records: &[Record], raw: &[u8]) -> Result<Vec<RawParagraph>> {
    let starts: Vec<usize> = records
        .iter()
        .enumerate()
        .filter_map(|(idx, rec)| (rec.tag == TAG_PARA_HEADER && rec.level == 0).then_some(idx))
        .collect();
    let mut out = Vec::with_capacity(starts.len());
    for (position, start) in starts.iter().copied().enumerate() {
        let end = starts.get(position + 1).copied().unwrap_or(records.len());
        out.push(parse_paragraph(records, raw, start, end, 0)?);
    }
    Ok(out)
}

fn parse_paragraph(
    records: &[Record],
    raw: &[u8],
    start: usize,
    end: usize,
    level: u16,
) -> Result<RawParagraph> {
    let header = records
        .get(start)
        .ok_or_else(|| Error::Record(format!("paragraph record index {start} is out of bounds")))?;
    if header.tag != TAG_PARA_HEADER || header.level != level {
        return Err(Error::Record(format!(
            "record {start} is not PARA_HEADER at level {level}"
        )));
    }

    let child_level = level + 1;
    let mut text = None;
    let mut char_shape = None;
    let mut line_seg = None;
    let mut controls = Vec::new();
    let mut tables = Vec::new();
    let mut i = start + 1;
    while i < end {
        let rec = records[i];
        if rec.level == child_level {
            match rec.tag {
                TAG_PARA_TEXT if text.is_none() => text = Some(i),
                TAG_PARA_CHAR_SHAPE if char_shape.is_none() => char_shape = Some(i),
                TAG_PARA_LINE_SEG if line_seg.is_none() => line_seg = Some(i),
                TAG_CTRL_HEADER => {
                    controls.push(i);
                    let control_end = first_at_or_above(records, i + 1, end, child_level);
                    if control_id(raw, rec)? == CTRL_TABLE {
                        tables.push(parse_table(records, raw, i, control_end)?);
                    }
                }
                _ => {}
            }
        }
        i += 1;
    }
    Ok(RawParagraph {
        header: start,
        text,
        char_shape,
        line_seg,
        controls,
        tables,
    })
}

fn parse_table(records: &[Record], raw: &[u8], control: usize, end: usize) -> Result<RawTable> {
    let ctrl = records[control];
    debug_assert_eq!(control_id(raw, ctrl).ok(), Some(CTRL_TABLE));
    let cell_level = ctrl.level + 1;
    // A caption is encoded as LIST_HEADER at the same level *before* HWPTAG_TABLE. Only list
    // headers after that descriptor are cells (the parser/lift uses the same boundary).
    let table_record = (control + 1..end)
        .find(|idx| records[*idx].tag == TAG_TABLE && records[*idx].level == cell_level)
        .ok_or_else(|| {
            Error::Record(format!(
                "table CTRL_HEADER record {control} has no HWPTAG_TABLE child"
            ))
        })?;
    let starts: Vec<usize> = (table_record + 1..end)
        .filter(|idx| records[*idx].tag == TAG_LIST_HEADER && records[*idx].level == cell_level)
        .collect();
    let mut cells = Vec::with_capacity(starts.len());
    for (position, start) in starts.iter().copied().enumerate() {
        let cell_end = starts.get(position + 1).copied().unwrap_or(end);
        // LIST_HEADER common fields are 8 bytes; the table-cell payload then begins with col,row.
        // Decode them independently so IR addresses never rely on parser-preserved vector order.
        let list_header = records[start];
        let col = read_u16(raw, list_header.data + 8)? as usize;
        let row = read_u16(raw, list_header.data + 10)? as usize;
        let para_starts: Vec<usize> = (start + 1..cell_end)
            .filter(|idx| records[*idx].tag == TAG_PARA_HEADER && records[*idx].level == cell_level)
            .collect();
        let mut paragraphs = Vec::with_capacity(para_starts.len());
        for (para_position, para_start) in para_starts.iter().copied().enumerate() {
            let para_end = para_starts
                .get(para_position + 1)
                .copied()
                .unwrap_or(cell_end);
            paragraphs.push(parse_paragraph(
                records, raw, para_start, para_end, cell_level,
            )?);
        }
        cells.push(RawCell {
            list_header: start,
            row,
            col,
            paragraphs,
        });
    }
    Ok(RawTable { control, cells })
}

fn first_at_or_above(records: &[Record], start: usize, end: usize, level: u16) -> usize {
    (start..end)
        .find(|idx| records[*idx].level <= level)
        .unwrap_or(end)
}

fn control_id(raw: &[u8], record: Record) -> Result<u32> {
    if record.size < 4 {
        return Err(Error::Record(format!(
            "CTRL_HEADER at byte {} is shorter than 4 bytes",
            record.head
        )));
    }
    read_u32(raw, record.data)
}

pub(crate) fn paragraph_text(
    records: &[Record],
    raw: &[u8],
    paragraph: &RawParagraph,
) -> Result<DecodedText> {
    let Some(index) = paragraph.text else {
        return Ok(DecodedText::default());
    };
    let record = records[index];
    decode_para_text(&raw[record.data..record.end])
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct DecodedText {
    pub(crate) text: String,
    pub(crate) has_controls: bool,
    pub(crate) utf16_len: u32,
}

// Mirrors the HWP 5 text-control widths used by the parser, but deliberately returns only the
// visible text plus a safety bit. A paragraph containing an 8-code-unit control can be observed and
// mapped, but the v1 patch lane must refuse to replace it because doing so would orphan its record.
fn decode_para_text(data: &[u8]) -> Result<DecodedText> {
    if !data.len().is_multiple_of(2) {
        return Err(Error::Record(format!(
            "PARA_TEXT has odd byte length {}",
            data.len()
        )));
    }
    let units: Vec<u16> = data
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    let mut out = String::new();
    let mut has_controls = false;
    let mut i = 0usize;
    while i < units.len() {
        let unit = units[i];
        match unit {
            0 => i += 1,
            0x0009 => {
                has_controls = true;
                out.push('\t');
                i = (i + 8).min(units.len());
            }
            0x000a => {
                out.push('\n');
                i += 1;
            }
            0x000d => break,
            1..=8 | 11..=12 | 14..=23 => {
                has_controls = true;
                if unit == 0x0012 {
                    out.push(' ');
                }
                i = (i + 8).min(units.len());
            }
            0x0018 => {
                out.push('-');
                i += 1;
            }
            0x0019 => {
                out.push(' ');
                i += 1;
            }
            0x001e => {
                out.push('\u{00a0}');
                i += 1;
            }
            0x001f => {
                out.push('\u{2007}');
                i += 1;
            }
            0x0001..=0x001f => {
                has_controls = true;
                i += 1;
            }
            high if (0xd800..=0xdbff).contains(&high) && i + 1 < units.len() => {
                let low = units[i + 1];
                if (0xdc00..=0xdfff).contains(&low) {
                    let scalar =
                        0x1_0000 + (((high as u32) - 0xd800) << 10) + ((low as u32) - 0xdc00);
                    if let Some(ch) = char::from_u32(scalar) {
                        out.push(ch);
                    }
                    i += 2;
                } else {
                    out.push(char::REPLACEMENT_CHARACTER);
                    i += 1;
                }
            }
            other => {
                out.push(char::from_u32(other as u32).unwrap_or(char::REPLACEMENT_CHARACTER));
                i += 1;
            }
        }
    }
    let utf16_len = units
        .iter()
        .position(|unit| *unit == 0x000d)
        .unwrap_or(units.len()) as u32;
    Ok(DecodedText {
        text: out,
        has_controls,
        utf16_len,
    })
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32> {
    let end = offset
        .checked_add(4)
        .filter(|end| *end <= bytes.len())
        .ok_or_else(|| Error::Record(format!("u32 at byte {offset} is out of bounds")))?;
    Ok(u32::from_le_bytes(bytes[offset..end].try_into().unwrap()))
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16> {
    let end = offset
        .checked_add(2)
        .filter(|end| *end <= bytes.len())
        .ok_or_else(|| Error::Record(format!("u16 at byte {offset} is out of bounds")))?;
    Ok(u16::from_le_bytes(bytes[offset..end].try_into().unwrap()))
}
