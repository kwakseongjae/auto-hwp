//! S2 — 쪽 번호 전용 자체 추출. 실물(비공개 양식)의 꼴을 합성 레코드로 옮겨 고정한다:
//! 첫 문단의 쪽 번호 위치 · 표 칸 안의 감추기 · 표 칸 안의 새 번호 · 본문 문단의 감추기.

use cfb::CompoundFile;
use hwp_hwp5::{OwnHwp5Parser, PageNumberSite, HWP_SIGNATURE};
use hwp_model::document::{PageNumberFormat, PageNumberMark, PageNumberOff, PageNumberPosition};
use std::io::{Cursor, Write};
use std::num::NonZeroU16;

const TAG_PARA_HEADER: u16 = 0x42;
const TAG_CTRL_HEADER: u16 = 0x47;
const TAG_LIST_HEADER: u16 = 0x48;
const TAG_TABLE: u16 = 0x4d;

fn push_record(out: &mut Vec<u8>, tag: u16, level: u16, data: &[u8]) {
    assert!(data.len() < 0x0fff);
    let header = ((data.len() as u32) << 20) | ((level as u32) << 10) | tag as u32;
    out.extend_from_slice(&header.to_le_bytes());
    out.extend_from_slice(data);
}

fn ctrl(id: &[u8; 4], rest: &[u8]) -> Vec<u8> {
    let mut data = u32::from_be_bytes(*id).to_le_bytes().to_vec();
    data.extend_from_slice(rest);
    data
}

fn pgnp(attr: u32, dash: u16) -> Vec<u8> {
    let mut rest = attr.to_le_bytes().to_vec();
    rest.extend_from_slice(&[0; 6]); // user symbol · prefix · suffix
    rest.extend_from_slice(&dash.to_le_bytes());
    ctrl(b"pgnp", &rest)
}

fn nwno(counter: u32, number: u16) -> Vec<u8> {
    let mut rest = counter.to_le_bytes().to_vec();
    rest.extend_from_slice(&number.to_le_bytes());
    ctrl(b"nwno", &rest)
}

fn pghd(attr: u32) -> Vec<u8> {
    ctrl(b"pghd", &attr.to_le_bytes())
}

fn secd(start_page: u16) -> Vec<u8> {
    let mut rest = vec![0; 20];
    rest[16..18].copy_from_slice(&start_page.to_le_bytes()); // offset 20 incl. the id
    ctrl(b"secd", &rest)
}

fn cell(row: u16, col: u16) -> Vec<u8> {
    let mut data = vec![0; 47];
    data[0..2].copy_from_slice(&1u16.to_le_bytes());
    data[8..10].copy_from_slice(&col.to_le_bytes());
    data[10..12].copy_from_slice(&row.to_le_bytes());
    data
}

fn paragraph(out: &mut Vec<u8>, level: u16) {
    push_record(out, TAG_PARA_HEADER, level, &[0; 22]);
}

fn document(sections: &[Vec<u8>]) -> Vec<u8> {
    let mut header = vec![0; 256];
    header[..HWP_SIGNATURE.len()].copy_from_slice(HWP_SIGNATURE);
    header[32..36].copy_from_slice(&[0, 0, 0, 5]);
    let mut compound = CompoundFile::create(Cursor::new(Vec::new())).unwrap();
    compound
        .create_stream("/FileHeader")
        .unwrap()
        .write_all(&header)
        .unwrap();
    compound.create_stream("/DocInfo").unwrap();
    compound.create_storage("/BodyText").unwrap();
    for (index, body) in sections.iter().enumerate() {
        compound
            .create_stream(format!("/BodyText/Section{index}"))
            .unwrap()
            .write_all(body)
            .unwrap();
    }
    compound.into_inner().into_inner()
}

const BOTTOM_CENTER_DIGIT: u32 = 5 << 8;

/// 표지 · 목차 쪽을 감추고 본문에서 1 로 다시 시작하는 양식의 꼴.
fn form_section(start_page: u16) -> Vec<u8> {
    let mut body = Vec::new();
    paragraph(&mut body, 0); // 0: 구역 정의 · 쪽 번호 위치 · 표(2행)
    push_record(&mut body, TAG_CTRL_HEADER, 1, &secd(start_page));
    push_record(
        &mut body,
        TAG_CTRL_HEADER,
        1,
        &pgnp(BOTTOM_CENTER_DIGIT, '-' as u16),
    );
    push_record(&mut body, TAG_CTRL_HEADER, 1, &ctrl(b"tbl ", &[0; 40]));
    push_record(&mut body, TAG_TABLE, 2, &[0; 24]);
    push_record(&mut body, TAG_LIST_HEADER, 2, &cell(0, 0));
    paragraph(&mut body, 2);
    push_record(&mut body, TAG_CTRL_HEADER, 3, &pghd(0x20));
    push_record(&mut body, TAG_LIST_HEADER, 2, &cell(1, 0));
    paragraph(&mut body, 2);
    paragraph(&mut body, 2);
    push_record(&mut body, TAG_CTRL_HEADER, 3, &nwno(0, 1));
    paragraph(&mut body, 0); // 1: 본문 문단의 감추기 + 머리말만 감추기(쪽 번호와 무관)
    push_record(&mut body, TAG_CTRL_HEADER, 1, &pghd(0x20));
    push_record(&mut body, TAG_CTRL_HEADER, 1, &pghd(0x01));
    paragraph(&mut body, 0); // 2: 각주 번호 새로 시작(쪽 번호와 무관) + 같은 쪽 번호 위치 반복
    push_record(&mut body, TAG_CTRL_HEADER, 1, &nwno(1, 3));
    push_record(
        &mut body,
        TAG_CTRL_HEADER,
        1,
        &pgnp(BOTTOM_CENTER_DIGIT, '-' as u16),
    );
    body
}

#[test]
fn reads_page_number_controls_in_paragraphs_and_table_cells() {
    let numbers = OwnHwp5Parser::new()
        .page_numbers(&document(&[form_section(0)]))
        .unwrap();
    assert_eq!(numbers.len(), 1);
    let section = &numbers[0];
    let decoration = section.facts.decoration.expect("pgnp read");
    assert_eq!(decoration.position, PageNumberPosition::BottomCenter);
    assert_eq!(decoration.format, PageNumberFormat::Digit);
    assert_eq!(decoration.dash, Some('-'));
    assert_eq!(section.top_level_paragraphs, 3);
    assert_eq!(section.facts.start_page, 0);
    assert!(!section.facts.restart_at_start);
    assert_eq!(section.facts.off, None);
    let in_cell = |row, cell_paragraph| PageNumberSite::Cell {
        paragraph: 0,
        table: 0,
        row,
        col: 0,
        cell_paragraph,
    };
    let marks: Vec<_> = section.marks.iter().map(|m| (m.site, m.mark)).collect();
    assert_eq!(
        marks,
        vec![
            (PageNumberSite::Paragraph(0), PageNumberMark::Show),
            (in_cell(0, 0), PageNumberMark::Hide),
            (in_cell(1, 1), PageNumberMark::Restart(NonZeroU16::MIN)),
            (PageNumberSite::Paragraph(1), PageNumberMark::Hide),
            (PageNumberSite::Paragraph(2), PageNumberMark::Show),
        ]
    );
    assert!(section.facts.resolve(0).unwrap().is_some());
    assert_eq!(
        section.facts.resolve(1),
        Err(PageNumberOff::ContinuesPreviousSection),
        "later section without a first-paragraph restart"
    );

    let explicit = OwnHwp5Parser::new()
        .page_numbers(&document(&[form_section(3)]))
        .unwrap();
    assert_eq!(explicit[0].facts.start_page, 3);
    assert_eq!(
        explicit[0].facts.resolve(0),
        Err(PageNumberOff::NonzeroSectionStart),
        "nonzero section start is unconfirmed"
    );
}

#[test]
fn a_page_restart_in_the_first_paragraph_fixes_the_first_page_number() {
    let mut body = Vec::new();
    paragraph(&mut body, 0);
    push_record(&mut body, TAG_CTRL_HEADER, 1, &pgnp(BOTTOM_CENTER_DIGIT, 0));
    push_record(&mut body, TAG_CTRL_HEADER, 1, &nwno(0, 1));
    let numbers = OwnHwp5Parser::new()
        .page_numbers(&document(&[body]))
        .unwrap();
    assert!(numbers[0].facts.restart_at_start);
    assert!(numbers[0].facts.resolve(1).unwrap().is_some());
}

/// 받지 않는 자리 · 읽을 수 없는 값은 그 구역을 끄고 이유를 남긴다 — 꼴마다 하나씩.
/// 오류(`Err`)는 레코드 틀이 깨졌을 때뿐이다.
#[test]
fn unowned_sites_and_values_turn_the_section_off_with_a_reason() {
    use PageNumberOff::*;
    let outcome = |build: &dyn Fn(&mut Vec<u8>)| {
        let mut body = Vec::new();
        paragraph(&mut body, 0);
        push_record(&mut body, TAG_CTRL_HEADER, 1, &pgnp(BOTTOM_CENTER_DIGIT, 0));
        build(&mut body);
        let numbers = OwnHwp5Parser::new()
            .page_numbers(&document(&[body]))
            .expect("record frames are intact");
        numbers[0].facts.resolve(0).map(|d| d.is_some())
    };
    let cases: [(&str, PageNumberOff, &dyn Fn(&mut Vec<u8>)); 8] = [
        ("caption (LIST_HEADER before TABLE)", OutsideBody, &|body| {
            push_record(body, TAG_CTRL_HEADER, 1, &ctrl(b"tbl ", &[0; 40]));
            push_record(body, TAG_LIST_HEADER, 2, &cell(0, 0));
            paragraph(body, 2);
            push_record(body, TAG_CTRL_HEADER, 3, &pghd(0x20));
        }),
        ("header body", OutsideBody, &|body| {
            push_record(body, TAG_CTRL_HEADER, 1, &ctrl(b"head", &[0; 8]));
            push_record(body, TAG_LIST_HEADER, 2, &[0; 12]);
            paragraph(body, 2);
            push_record(body, TAG_CTRL_HEADER, 3, &pghd(0x20));
        }),
        ("nested table cell (level 5)", OutsideBody, &|body| {
            push_record(body, TAG_CTRL_HEADER, 1, &ctrl(b"tbl ", &[0; 40]));
            push_record(body, TAG_TABLE, 2, &[0; 24]);
            push_record(body, TAG_LIST_HEADER, 2, &cell(0, 0));
            paragraph(body, 2);
            push_record(body, TAG_CTRL_HEADER, 3, &ctrl(b"tbl ", &[0; 40]));
            push_record(body, TAG_TABLE, 4, &[0; 24]);
            push_record(body, TAG_LIST_HEADER, 4, &cell(0, 0));
            paragraph(body, 4);
            push_record(body, TAG_CTRL_HEADER, 5, &pghd(0x20));
        }),
        ("conflicting position", ConflictingPositions, &|body| {
            push_record(body, TAG_CTRL_HEADER, 1, &pgnp(2 << 8, 0));
        }),
        ("unknown hide bit", UnreadValue, &|body| {
            push_record(body, TAG_CTRL_HEADER, 1, &pghd(0x40))
        }),
        ("short hide record", UnreadValue, &|body| {
            let mut short = pghd(0x20);
            short.pop();
            push_record(body, TAG_CTRL_HEADER, 1, &short);
        }),
        ("restart at zero", UnreadValue, &|body| {
            push_record(body, TAG_CTRL_HEADER, 1, &nwno(0, 0))
        }),
        ("user symbol (strict parser's rule)", UnreadValue, &|body| {
            let mut data = pgnp(BOTTOM_CENTER_DIGIT, 0);
            data[8..10].copy_from_slice(&('*' as u16).to_le_bytes());
            push_record(body, TAG_CTRL_HEADER, 1, &data);
        }),
    ];
    for (why, reason, build) in cases {
        assert_eq!(outcome(build), Err(reason), "{why}");
    }
    // 대조: 같은 꼴이라도 받는 자리면 켠다.
    assert_eq!(
        outcome(&|body| push_record(body, TAG_CTRL_HEADER, 1, &pghd(0x20))),
        Ok(true)
    );
    // 레코드 틀이 깨지면 오류다(쪽 번호가 있었는지 모른다).
    let mut broken = Vec::new();
    paragraph(&mut broken, 0);
    push_record(&mut broken, TAG_CTRL_HEADER, 1, &[0x01, 0x02]);
    assert!(OwnHwp5Parser::new()
        .page_numbers(&document(&[broken]))
        .is_err());
}
