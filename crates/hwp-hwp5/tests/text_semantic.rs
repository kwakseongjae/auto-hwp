use cfb::CompoundFile;
use hwp_hwp5::{Error, OwnHwp5Parser, HWP_SIGNATURE};
use hwp_model::document::{Block, Inline};
use hwp_model::types::SourceFormat;
use std::io::{Cursor, Write};

const TAG_DOCUMENT_PROPERTIES: u16 = 0x10;
const TAG_ID_MAPPINGS: u16 = 0x11;
const TAG_FACE_NAME: u16 = 0x13;
const TAG_CHAR_SHAPE: u16 = 0x15;
const TAG_PARA_SHAPE: u16 = 0x19;
const TAG_PARA_HEADER: u16 = 0x42;
const TAG_PARA_TEXT: u16 = 0x43;
const TAG_PARA_CHAR_SHAPE: u16 = 0x44;
const TAG_CTRL_HEADER: u16 = 0x47;

#[derive(Clone, Copy)]
enum Mutation {
    None,
    BadShapeBoundary,
    BadShapeReference,
    UnsupportedControl,
    PoolCountMismatch,
    MemoCountMismatch,
    BadDeclaredShapeCount,
    BadControlMask,
}

#[test]
fn parses_text_only_docinfo_and_utf16_runs_without_rhwp() {
    let bytes = fixture(Mutation::None);
    let doc = OwnHwp5Parser::new().parse(&bytes).unwrap();

    assert_eq!(doc.origin, Some(SourceFormat::Hwp5));
    assert_eq!(doc.sections.len(), 1);
    assert_eq!(doc.char_shapes.len(), 3); // reserved default + two HWP5 entries
    assert_eq!(doc.para_shapes.len(), 2); // reserved default + one HWP5 entry
    assert_eq!(doc.plain_text(), "가😀A\n\t끝\n");

    let Block::Paragraph(first) = &doc.sections[0].blocks[0] else {
        panic!("expected paragraph")
    };
    assert_eq!(first.para_shape, 1);
    assert_eq!(first.runs.len(), 2);
    assert_eq!(text(&first.runs[0].content), "가😀");
    assert_eq!(text(&first.runs[1].content), "A");
    assert_eq!(first.runs[0].char_shape, 1);
    assert_eq!(first.runs[1].char_shape, 2);
    assert!(!doc.char_shapes[1].bold);
    assert!(doc.char_shapes[2].bold);
    assert_eq!(doc.char_shapes[1].fonts[0].as_deref(), Some("Test Sans"));

    let probe_json = serde_json::to_string(&OwnHwp5Parser::new().inspect(&bytes).unwrap()).unwrap();
    assert!(!probe_json.contains("가"));
    assert!(!probe_json.contains("Test Sans"));
    assert!(!probe_json.contains("BodyText"));
}

#[test]
fn rejects_shape_boundary_inside_surrogate_pair() {
    assert!(matches!(
        OwnHwp5Parser::new().parse(&fixture(Mutation::BadShapeBoundary)),
        Err(Error::MalformedRecord {
            tag: TAG_PARA_CHAR_SHAPE,
            section: Some(0),
            reason: "PARA_CHAR_SHAPE boundary is not a scalar start",
            ..
        })
    ));
}

#[test]
fn rejects_out_of_pool_shape_reference() {
    assert!(matches!(
        OwnHwp5Parser::new().parse(&fixture(Mutation::BadShapeReference)),
        Err(Error::InvalidReference {
            kind: "character shape",
            index: 2,
            pool_len: 2,
            section: Some(0),
            ..
        })
    ));
}

#[test]
fn rejects_unowned_body_control_instead_of_falling_back() {
    assert!(matches!(
        OwnHwp5Parser::new().parse(&fixture(Mutation::UnsupportedControl)),
        Err(Error::UnsupportedBodyRecord {
            tag: TAG_CTRL_HEADER,
            section: 0,
            ..
        })
    ));
}

#[test]
fn enforces_id_mapping_pool_counts() {
    assert!(matches!(
        OwnHwp5Parser::new().parse(&fixture(Mutation::PoolCountMismatch)),
        Err(Error::PoolCountMismatch {
            tag: TAG_CHAR_SHAPE,
            expected: 3,
            actual: 2,
        })
    ));
}

#[test]
fn enforces_optional_memo_shape_count() {
    assert!(matches!(
        OwnHwp5Parser::new().parse(&fixture(Mutation::MemoCountMismatch)),
        Err(Error::PoolCountMismatch {
            tag: 0x5c,
            expected: 1,
            actual: 0,
        })
    ));
}

#[test]
fn enforces_paragraph_declared_shape_count() {
    assert!(matches!(
        OwnHwp5Parser::new().parse(&fixture(Mutation::BadDeclaredShapeCount)),
        Err(Error::MalformedRecord {
            tag: TAG_PARA_HEADER,
            section: Some(0),
            reason: "PARA_HEADER character-shape count differs from PARA_CHAR_SHAPE",
            ..
        })
    ));
}

#[test]
fn enforces_supported_inline_control_mask() {
    assert!(matches!(
        OwnHwp5Parser::new().parse(&fixture(Mutation::BadControlMask)),
        Err(Error::MalformedRecord {
            tag: TAG_PARA_HEADER,
            section: Some(0),
            reason: "PARA_HEADER control mask differs from supported PARA_TEXT controls",
            ..
        })
    ));
}

fn text(content: &[Inline]) -> &str {
    match content {
        [Inline::Text(value)] => value,
        _ => panic!("expected one text inline"),
    }
}

fn fixture(mutation: Mutation) -> Vec<u8> {
    let mut header = vec![0; 256];
    header[..HWP_SIGNATURE.len()].copy_from_slice(HWP_SIGNATURE);
    header[32..36].copy_from_slice(&[0, 0, 0, 5]);

    let mut doc_info = Vec::new();
    let mut properties = vec![0; 26];
    properties[..2].copy_from_slice(&1u16.to_le_bytes());
    push_record(&mut doc_info, TAG_DOCUMENT_PROPERTIES, 0, &properties);

    let mut mappings = Vec::new();
    let char_shape_count = if matches!(mutation, Mutation::PoolCountMismatch) {
        3
    } else {
        2
    };
    for count in [0, 1, 1, 1, 1, 1, 1, 1, 0, char_shape_count, 0, 0, 0, 1, 0] {
        mappings.extend_from_slice(&(count as u32).to_le_bytes());
    }
    if matches!(mutation, Mutation::MemoCountMismatch) {
        mappings.extend_from_slice(&1u32.to_le_bytes());
    }
    push_record(&mut doc_info, TAG_ID_MAPPINGS, 0, &mappings);
    for _ in 0..7 {
        push_record(&mut doc_info, TAG_FACE_NAME, 0, &face_name("Test Sans"));
    }
    push_record(&mut doc_info, TAG_CHAR_SHAPE, 0, &char_shape(1_200, 0, 0));
    push_record(
        &mut doc_info,
        TAG_CHAR_SHAPE,
        0,
        &char_shape(1_400, 0b10, 0x0000_00ff),
    );
    push_record(&mut doc_info, TAG_PARA_SHAPE, 0, &para_shape());

    let mut body = Vec::new();
    let first_text: Vec<u16> = "가😀A"
        .encode_utf16()
        .chain(std::iter::once(0x000d))
        .collect();
    let first_shape_count = if matches!(mutation, Mutation::BadDeclaredShapeCount) {
        1
    } else {
        2
    };
    push_paragraph_header(&mut body, first_text.len() as u32, 0, first_shape_count);
    push_record(&mut body, TAG_PARA_TEXT, 1, &utf16_bytes(&first_text));
    let boundary = if matches!(mutation, Mutation::BadShapeBoundary) {
        2
    } else {
        3
    };
    let second_shape = if matches!(mutation, Mutation::BadShapeReference) {
        2
    } else {
        1
    };
    push_record(
        &mut body,
        TAG_PARA_CHAR_SHAPE,
        1,
        &shape_refs(&[(0, 0), (boundary, second_shape)]),
    );
    if matches!(mutation, Mutation::UnsupportedControl) {
        push_record(&mut body, TAG_CTRL_HEADER, 1, b"ctrl");
    }

    let mut tab_text = vec![0x0009];
    tab_text.extend([0; 7]);
    tab_text.extend("끝".encode_utf16());
    tab_text.push(0x000d);
    let tab_mask = if matches!(mutation, Mutation::BadControlMask) {
        0
    } else {
        1 << 0x0009
    };
    push_paragraph_header(&mut body, tab_text.len() as u32, tab_mask, 1);
    push_record(&mut body, TAG_PARA_TEXT, 1, &utf16_bytes(&tab_text));
    push_record(&mut body, TAG_PARA_CHAR_SHAPE, 1, &shape_refs(&[(0, 0)]));

    let mut compound = CompoundFile::create(Cursor::new(Vec::new())).unwrap();
    {
        let mut stream = compound.create_stream("/FileHeader").unwrap();
        stream.write_all(&header).unwrap();
    }
    {
        let mut stream = compound.create_stream("/DocInfo").unwrap();
        stream.write_all(&doc_info).unwrap();
    }
    compound.create_storage("/BodyText").unwrap();
    {
        let mut stream = compound.create_stream("/BodyText/Section0").unwrap();
        stream.write_all(&body).unwrap();
    }
    compound.into_inner().into_inner()
}

fn push_paragraph_header(out: &mut Vec<u8>, char_count: u32, control_mask: u32, char_shapes: u16) {
    let mut data = Vec::with_capacity(22);
    data.extend_from_slice(&char_count.to_le_bytes());
    data.extend_from_slice(&control_mask.to_le_bytes());
    data.extend_from_slice(&0u16.to_le_bytes()); // paragraph shape
    data.push(0); // style
    data.push(0); // break type
    data.extend_from_slice(&char_shapes.to_le_bytes());
    data.extend_from_slice(&0u16.to_le_bytes()); // range tags
    data.extend_from_slice(&0u16.to_le_bytes()); // line segments
    data.extend_from_slice(&0u32.to_le_bytes()); // instance id
    push_record(out, TAG_PARA_HEADER, 0, &data);
}

fn face_name(value: &str) -> Vec<u8> {
    let units: Vec<u16> = value.encode_utf16().collect();
    let mut bytes = vec![0]; // no alternate/PANOSE/default name
    bytes.extend_from_slice(&(units.len() as u16).to_le_bytes());
    bytes.extend(utf16_bytes(&units));
    bytes
}

fn char_shape(height: i32, attr: u32, color: u32) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(68);
    for _ in 0..7 {
        bytes.extend_from_slice(&0u16.to_le_bytes());
    }
    bytes.extend([100; 7]); // ratios
    bytes.extend([0; 7]); // spacing
    bytes.extend([100; 7]); // relative size
    bytes.extend([0; 7]); // offset
    bytes.extend_from_slice(&height.to_le_bytes());
    bytes.extend_from_slice(&attr.to_le_bytes());
    bytes.extend_from_slice(&0u16.to_le_bytes()); // shadow offsets
    bytes.extend_from_slice(&color.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes()); // underline color
    bytes.extend_from_slice(&0x00ff_ffffu32.to_le_bytes()); // shade
    bytes.extend_from_slice(&0u32.to_le_bytes()); // shadow color
    assert_eq!(bytes.len(), 68);
    bytes
}

fn para_shape() -> Vec<u8> {
    let mut bytes = vec![0; 42];
    bytes[..4].copy_from_slice(&(1u32 << 2).to_le_bytes()); // left, percent spacing
    bytes[24..28].copy_from_slice(&160i32.to_le_bytes());
    bytes
}

fn shape_refs(refs: &[(u32, u32)]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(refs.len() * 8);
    for (start, shape) in refs {
        bytes.extend_from_slice(&start.to_le_bytes());
        bytes.extend_from_slice(&shape.to_le_bytes());
    }
    bytes
}

fn utf16_bytes(units: &[u16]) -> Vec<u8> {
    units.iter().flat_map(|unit| unit.to_le_bytes()).collect()
}

fn push_record(out: &mut Vec<u8>, tag: u16, level: u16, data: &[u8]) {
    assert!(data.len() < 0x0fff);
    let header = ((data.len() as u32) << 20) | ((level as u32) << 10) | tag as u32;
    out.extend_from_slice(&header.to_le_bytes());
    out.extend_from_slice(data);
}
