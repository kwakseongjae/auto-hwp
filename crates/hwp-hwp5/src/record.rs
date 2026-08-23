use serde::Serialize;
use thiserror::Error;

/// A single HWP5 record's provenance within its decompressed record stream.
/// No source bytes are copied into this descriptor.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Record {
    pub tag: u16,
    pub level: u16,
    pub size: usize,
    #[serde(rename = "header_offset")]
    pub head: usize,
    #[serde(rename = "data_offset")]
    pub data: usize,
    #[serde(rename = "end_offset")]
    pub end: usize,
    pub extended: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RecordLimits {
    pub max_stream_bytes: usize,
    pub max_records: usize,
}

impl Default for RecordLimits {
    fn default() -> Self {
        Self {
            max_stream_bytes: hwp_ingest::limits::MAX_DECOMPRESSED_TOTAL as usize,
            max_records: 1_000_000,
        }
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum RecordError {
    #[error("record stream exceeds {limit}-byte limit: {size}")]
    StreamTooLarge { size: usize, limit: usize },
    #[error("record count exceeds {limit} limit")]
    TooManyRecords { limit: usize },
    #[error("truncated record header at byte {offset}")]
    TruncatedHeader { offset: usize },
    #[error("record at byte {offset} declares {size} bytes beyond stream length {stream_len}")]
    TruncatedData {
        offset: usize,
        size: usize,
        stream_len: usize,
    },
}

pub fn walk_records(raw: &[u8], limits: RecordLimits) -> Result<Vec<Record>, RecordError> {
    if raw.len() > limits.max_stream_bytes {
        return Err(RecordError::StreamTooLarge {
            size: raw.len(),
            limit: limits.max_stream_bytes,
        });
    }
    let mut records = Vec::new();
    let mut cursor = 0usize;
    while cursor < raw.len() {
        if raw[cursor..].iter().all(|byte| *byte == 0) {
            break;
        }
        if records.len() >= limits.max_records {
            return Err(RecordError::TooManyRecords {
                limit: limits.max_records,
            });
        }
        let head = cursor;
        let header =
            read_u32(raw, cursor).ok_or(RecordError::TruncatedHeader { offset: cursor })?;
        cursor += 4;
        let tag = (header & 0x3ff) as u16;
        let level = ((header >> 10) & 0x3ff) as u16;
        let packed_size = ((header >> 20) & 0xfff) as usize;
        let (size, extended) = if packed_size == 0xfff {
            let value = read_u32(raw, cursor)
                .ok_or(RecordError::TruncatedHeader { offset: cursor })?
                as usize;
            cursor += 4;
            (value, true)
        } else {
            (packed_size, false)
        };
        let data_offset = cursor;
        let end_offset = data_offset
            .checked_add(size)
            .filter(|end| *end <= raw.len())
            .ok_or(RecordError::TruncatedData {
                offset: head,
                size,
                stream_len: raw.len(),
            })?;
        records.push(Record {
            tag,
            level,
            size,
            head,
            data: data_offset,
            end: end_offset,
            extended,
        });
        cursor = end_offset;
    }
    Ok(records)
}

fn read_u32(raw: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        raw.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(tag: u16, level: u16, data: &[u8], extended: bool) -> Vec<u8> {
        let packed = if extended { 0xfff } else { data.len() as u32 };
        let mut out = ((tag as u32) | ((level as u32) << 10) | (packed << 20))
            .to_le_bytes()
            .to_vec();
        if extended {
            out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        }
        out.extend_from_slice(data);
        out
    }

    #[test]
    fn preserves_unknown_tag_and_exact_raw_span() {
        let bytes = record(0x3aa, 17, &[1, 2, 3], false);
        let records = walk_records(&bytes, RecordLimits::default()).unwrap();
        assert_eq!(
            records,
            vec![Record {
                tag: 0x3aa,
                level: 17,
                size: 3,
                head: 0,
                data: 4,
                end: 7,
                extended: false,
            }]
        );
    }

    #[test]
    fn accepts_extended_header_and_zero_tail() {
        let mut bytes = record(0x43, 1, &[8; 12], true);
        bytes.extend_from_slice(&[0; 7]);
        let records = walk_records(&bytes, RecordLimits::default()).unwrap();
        assert_eq!(records[0].data, 8);
        assert_eq!(records[0].end, 20);
        assert!(records[0].extended);
    }

    #[test]
    fn rejects_truncation_and_record_exhaustion() {
        assert!(matches!(
            walk_records(&[1, 2, 3], RecordLimits::default()),
            Err(RecordError::TruncatedHeader { .. })
        ));
        let bytes = record(1, 0, &[], false);
        assert_eq!(
            walk_records(
                &bytes,
                RecordLimits {
                    max_stream_bytes: 100,
                    max_records: 0
                }
            ),
            Err(RecordError::TooManyRecords { limit: 0 })
        );
        assert_eq!(
            walk_records(
                &bytes,
                RecordLimits {
                    max_stream_bytes: 3,
                    max_records: 1
                }
            ),
            Err(RecordError::StreamTooLarge { size: 4, limit: 3 })
        );
        let extended_without_size = ((1_u32) | (0xfff << 20)).to_le_bytes();
        assert_eq!(
            walk_records(&extended_without_size, RecordLimits::default()),
            Err(RecordError::TruncatedHeader { offset: 4 })
        );
    }
}
