//! S2 — 공개 표본(`PageFunctions.hwpx`: 쪽 번호 위치 · 새 번호 23 · 쪽 번호를 감추지 않는 감추기)으로
//! 쪽 번호 제어 읽기와, 편집 없는 저장 왕복에서 그 제어가 바이트 그대로 남는 것을 고정한다.

use hwp_hwpx::parse::parse_semantic;
use hwp_hwpx::serialize::serialize;
use hwp_model::prelude::*;

fn sample() -> Vec<u8> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../corpus/hwpxlib_corpus/reader_writer/PageFunctions.hwpx"
    );
    std::fs::read(path).expect("read PageFunctions.hwpx")
}

fn section_xml(bytes: &[u8], name: &str) -> Vec<u8> {
    hwp_hwpx::package::Package::open(bytes)
        .unwrap()
        .read_part(name)
        .unwrap()
}

fn marks(blocks: &[Block], out: &mut Vec<PageNumberMark>) {
    for block in blocks {
        match block {
            Block::Paragraph(p) => out.extend_from_slice(&p.page_number_marks),
            Block::Table(t) => {
                for cell in &t.cells {
                    marks(&cell.blocks, out);
                }
            }
        }
    }
}

#[test]
fn reads_page_number_controls_from_a_public_sample() {
    let doc = parse_semantic(&sample()).unwrap();
    let section = &doc.sections[0];
    let number = section.page_number.expect("pageNum read");
    assert_eq!(number.position, PageNumberPosition::BottomCenter);
    assert_eq!(number.format, PageNumberFormat::Digit);
    assert_eq!(number.dash, Some('-'));
    let mut found = Vec::new();
    marks(&section.blocks, &mut found);
    assert_eq!(
        found,
        vec![
            PageNumberMark::Show,
            PageNumberMark::Restart(std::num::NonZeroU16::new(23).unwrap()),
        ],
        "hidePageNum=\"0\" adds no Hide mark"
    );
}

#[test]
fn unedited_save_keeps_the_page_number_controls_byte_for_byte() {
    let bytes = sample();
    let doc = parse_semantic(&bytes).unwrap();
    let saved = serialize(&doc).unwrap();
    let before = section_xml(&bytes, "Contents/section0.xml");
    let after = section_xml(&saved, "Contents/section0.xml");
    assert_eq!(before, after);
    let text = String::from_utf8(after).unwrap();
    assert!(text.contains(r#"<hp:newNum num="23" numType="PAGE"/>"#));
    assert!(text.contains("<hp:pageNum "));
}
