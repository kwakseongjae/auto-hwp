use cfb::CompoundFile;
use hwp_hwp5::{Error, OwnHwp5Parser, HWP_SIGNATURE};
use hwp_model::document::Block;
use std::io::{Cursor, Write};

const TAG_DOCUMENT_PROPERTIES: u16 = 0x10;
const TAG_ID_MAPPINGS: u16 = 0x11;
const TAG_FACE_NAME: u16 = 0x13;
const TAG_CHAR_SHAPE: u16 = 0x15;
const TAG_PARA_SHAPE: u16 = 0x19;
const TAG_PARA_HEADER: u16 = 0x42;
const TAG_PARA_TEXT: u16 = 0x43;
const TAG_PARA_CHAR_SHAPE: u16 = 0x44;
const TAG_PARA_LINE_SEG: u16 = 0x45;
const TAG_CTRL_HEADER: u16 = 0x47;
const TAG_PAGE_DEF: u16 = 0x49;
const TAG_FOOTNOTE_SHAPE: u16 = 0x4a;
const CTRL_SECTION_DEF: u32 = u32::from_be_bytes(*b"secd");

#[derive(Clone, Copy)]
enum Mutation {
    None,
    Landscape,
    NoBodyBox,
    BadLineCount,
    BadLineBoundary,
    BadLineLength,
    ZeroHeightLine,
    UnsupportedSectionChild,
    DuplicatePageDef,
    BadControlFrame,
    UnsupportedBinding,
}

#[test]
fn parses_page_setup_and_blank_source_line_metrics() {
    let doc = OwnHwp5Parser::new()
        .parse(&fixture(Mutation::None))
        .unwrap();
    let page = doc.sections[0].page;
    assert_eq!((page.width, page.height), (59_528, 84_188));
    assert_eq!((page.margin_left, page.margin_right), (8_504, 8_504));
    assert_eq!((page.margin_top, page.margin_bottom), (5_669, 4_252));
    assert_eq!((page.margin_header, page.margin_footer), (4_252, 4_252));
    assert_eq!(page.margin_gutter, 0);
    assert!(!page.landscape);

    let Block::Paragraph(blank) = &doc.sections[0].blocks[1] else {
        panic!("expected blank paragraph")
    };
    assert_eq!(blank.source_line_metrics.len(), 1);
    assert_eq!(blank.source_line_metrics[0].height, 1_500);
    assert_eq!(blank.source_line_metrics[0].text_height, 1_200);
    assert_eq!(blank.source_line_metrics[0].baseline, 900);
}

#[test]
fn preserves_hwp5_landscape_flag_without_pre_swapping_paper() {
    let doc = OwnHwp5Parser::new()
        .parse(&fixture(Mutation::Landscape))
        .unwrap();
    let page = doc.sections[0].page;
    assert_eq!((page.width, page.height), (59_528, 84_188));
    assert!(page.landscape);
}

#[test]
fn rejects_page_margins_that_remove_the_body_box() {
    assert!(matches!(
        OwnHwp5Parser::new().parse(&fixture(Mutation::NoBodyBox)),
        Err(Error::MalformedRecord {
            tag: TAG_PAGE_DEF,
            section: Some(0),
            reason: "PAGE_DEF margins leave no positive body box",
            ..
        })
    ));
}

#[test]
fn enforces_declared_line_segment_count() {
    assert!(matches!(
        OwnHwp5Parser::new().parse(&fixture(Mutation::BadLineCount)),
        Err(Error::MalformedRecord {
            tag: TAG_PARA_HEADER,
            section: Some(0),
            reason: "PARA_HEADER line-segment count differs from PARA_LINE_SEG",
            ..
        })
    ));
}

#[test]
fn rejects_line_start_outside_a_scalar_or_control_boundary() {
    assert!(matches!(
        OwnHwp5Parser::new().parse(&fixture(Mutation::BadLineBoundary)),
        Err(Error::MalformedRecord {
            tag: TAG_PARA_LINE_SEG,
            section: Some(0),
            reason: "PARA_LINE_SEG text start is not a scalar/control boundary",
            ..
        })
    ));
}

#[test]
fn zero_height_line_segments_are_non_authoritative() {
    let doc = OwnHwp5Parser::new()
        .parse(&fixture(Mutation::ZeroHeightLine))
        .unwrap();
    let Block::Paragraph(blank) = &doc.sections[0].blocks[1] else {
        panic!("expected blank paragraph")
    };
    assert!(blank.source_line_metrics.is_empty());
}

#[test]
fn refuses_unsupported_section_children_with_a_content_free_span() {
    assert!(matches!(
        OwnHwp5Parser::new().parse(&fixture(Mutation::UnsupportedSectionChild)),
        Err(Error::UnsupportedBodyRecord {
            tag: TAG_FOOTNOTE_SHAPE,
            section: 0,
            ..
        })
    ));
}

#[test]
fn rejects_duplicate_page_def_records() {
    assert!(matches!(
        OwnHwp5Parser::new().parse(&fixture(Mutation::DuplicatePageDef)),
        Err(Error::UnsupportedBodyRecord {
            tag: TAG_PAGE_DEF,
            section: 0,
            ..
        })
    ));
}

#[test]
fn rejects_invalid_extended_control_framing() {
    assert!(matches!(
        OwnHwp5Parser::new().parse(&fixture(Mutation::BadControlFrame)),
        Err(Error::MalformedRecord {
            tag: TAG_PARA_TEXT,
            section: Some(0),
            reason: "PARA_TEXT section control framing is invalid",
            ..
        })
    ));
}

#[test]
fn refuses_binding_modes_until_page_parity_is_owned() {
    assert!(matches!(
        OwnHwp5Parser::new().parse(&fixture(Mutation::UnsupportedBinding)),
        Err(Error::MalformedRecord {
            tag: TAG_PAGE_DEF,
            section: Some(0),
            reason: "PAGE_DEF binding mode is not yet supported",
            ..
        })
    ));
}

#[test]
fn rejects_non_integral_line_segment_payload() {
    assert!(matches!(
        OwnHwp5Parser::new().parse(&fixture(Mutation::BadLineLength)),
        Err(Error::MalformedRecord {
            tag: TAG_PARA_LINE_SEG,
            section: Some(0),
            reason: "PARA_LINE_SEG length is not a multiple of 36",
            ..
        })
    ));
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
    for count in [0, 1, 1, 1, 1, 1, 1, 1, 0, 1, 0, 0, 0, 1, 0] {
        mappings.extend_from_slice(&(count as u32).to_le_bytes());
    }
    push_record(&mut doc_info, TAG_ID_MAPPINGS, 0, &mappings);
    for _ in 0..7 {
        push_record(&mut doc_info, TAG_FACE_NAME, 0, &face_name("Test Sans"));
    }
    push_record(&mut doc_info, TAG_CHAR_SHAPE, 0, &char_shape());
    push_record(&mut doc_info, TAG_PARA_SHAPE, 0, &para_shape());

    let mut body = Vec::new();
    let mut section_text = extended_control(0x0002, CTRL_SECTION_DEF);
    if matches!(mutation, Mutation::BadControlFrame) {
        section_text[7] = 0;
    }
    section_text.push(0x000d);
    push_para_header(&mut body, section_text.len() as u32, 1 << 2, 1, 0);
    push_record(&mut body, TAG_PARA_TEXT, 1, &utf16_bytes(&section_text));
    push_record(&mut body, TAG_PARA_CHAR_SHAPE, 1, &shape_refs(&[(0, 0)]));
    let mut section_control = Vec::with_capacity(28);
    section_control.extend_from_slice(&CTRL_SECTION_DEF.to_le_bytes());
    section_control.extend([0; 24]);
    push_record(&mut body, TAG_CTRL_HEADER, 1, &section_control);
    if matches!(mutation, Mutation::UnsupportedSectionChild) {
        push_record(&mut body, TAG_FOOTNOTE_SHAPE, 2, &[0; 28]);
    } else {
        push_record(&mut body, TAG_PAGE_DEF, 2, &page_def(mutation));
        if matches!(mutation, Mutation::DuplicatePageDef) {
            push_record(&mut body, TAG_PAGE_DEF, 2, &page_def(mutation));
        }
    }

    let declared_lines = if matches!(mutation, Mutation::BadLineCount) {
        2
    } else {
        1
    };
    push_para_header(&mut body, 1, 0, 1, declared_lines);
    push_record(&mut body, TAG_PARA_TEXT, 1, &utf16_bytes(&[0x000d]));
    push_record(&mut body, TAG_PARA_CHAR_SHAPE, 1, &shape_refs(&[(0, 0)]));
    let start = if matches!(mutation, Mutation::BadLineBoundary) {
        1
    } else {
        0
    };
    let (height, text_height, baseline) = if matches!(mutation, Mutation::ZeroHeightLine) {
        (0, 0, 0)
    } else {
        (1_500, 1_200, 900)
    };
    let mut line = line_seg(start, height, text_height, baseline);
    if matches!(mutation, Mutation::BadLineLength) {
        line.pop();
    }
    push_record(&mut body, TAG_PARA_LINE_SEG, 1, &line);

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

fn page_def(mutation: Mutation) -> Vec<u8> {
    let width = if matches!(mutation, Mutation::NoBodyBox) {
        100
    } else {
        59_528
    };
    let mut bytes = Vec::with_capacity(40);
    for value in [width, 84_188, 8_504, 8_504, 5_669, 4_252, 4_252, 4_252, 0] {
        bytes.extend_from_slice(&(value as u32).to_le_bytes());
    }
    let attr = if matches!(mutation, Mutation::UnsupportedBinding) {
        0x02
    } else {
        u32::from(matches!(mutation, Mutation::Landscape))
    };
    bytes.extend_from_slice(&attr.to_le_bytes());
    bytes
}

fn line_seg(start: u32, height: i32, text_height: i32, baseline: i32) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(36);
    bytes.extend_from_slice(&start.to_le_bytes());
    for value in [100, height, text_height, baseline, 300, 0, 40_000] {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes
}

fn extended_control(code: u16, id: u32) -> Vec<u16> {
    let bytes = id.to_le_bytes();
    vec![
        code,
        u16::from_le_bytes([bytes[0], bytes[1]]),
        u16::from_le_bytes([bytes[2], bytes[3]]),
        0,
        0,
        0,
        0,
        code,
    ]
}

fn push_para_header(
    out: &mut Vec<u8>,
    char_count: u32,
    control_mask: u32,
    char_shapes: u16,
    line_segments: u16,
) {
    let mut data = Vec::with_capacity(22);
    data.extend_from_slice(&char_count.to_le_bytes());
    data.extend_from_slice(&control_mask.to_le_bytes());
    data.extend_from_slice(&0u16.to_le_bytes());
    data.push(0);
    data.push(0);
    data.extend_from_slice(&char_shapes.to_le_bytes());
    data.extend_from_slice(&0u16.to_le_bytes());
    data.extend_from_slice(&line_segments.to_le_bytes());
    data.extend_from_slice(&0u32.to_le_bytes());
    push_record(out, TAG_PARA_HEADER, 0, &data);
}

fn face_name(value: &str) -> Vec<u8> {
    let units: Vec<u16> = value.encode_utf16().collect();
    let mut bytes = vec![0];
    bytes.extend_from_slice(&(units.len() as u16).to_le_bytes());
    bytes.extend(utf16_bytes(&units));
    bytes
}

fn char_shape() -> Vec<u8> {
    let mut bytes = Vec::with_capacity(68);
    for _ in 0..7 {
        bytes.extend_from_slice(&0u16.to_le_bytes());
    }
    bytes.extend([100; 7]);
    bytes.extend([0; 7]);
    bytes.extend([100; 7]);
    bytes.extend([0; 7]);
    bytes.extend_from_slice(&1_200i32.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&0u16.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&0x00ff_ffffu32.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes
}

fn para_shape() -> Vec<u8> {
    let mut bytes = vec![0; 42];
    bytes[..4].copy_from_slice(&(1u32 << 2).to_le_bytes());
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
    let header = ((data.len() as u32) << 20) | ((level as u32) << 10) | tag as u32;
    out.extend_from_slice(&header.to_le_bytes());
    out.extend_from_slice(data);
}
