//! issue 057 — HWPX 익스포터 표 앵커링 재현/회귀 가드.
//!
//! 증상(수정 전): hwpx 오리진 문서에서 표 셀을 편집(`SetTableCellRuns` 계열 → cell.blocks 교체 +
//! dirty 마킹)한 뒤 재방출하면, dirty 표가 **문서 끝에 append**되고 원 위치에는 편집 전 표가
//! verbatim으로 잔존했다(표 중복 + 앵커 파손). 수정 후: dirty 표는 원본 XML의 자기 스팬
//! (`Table::src_span`/`Cell::src_span`)에서 **제자리 재방출**된다.

use hwp_hwpx::parse::parse_semantic;
use hwp_hwpx::serialize::serialize;
use hwp_model::prelude::*;

const MARKER: &str = "057제자리편집";

fn showcase() -> Vec<u8> {
    let p = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../corpus/hwpx/FormattingShowcase.hwpx"
    );
    std::fs::read(p).expect("read corpus/hwpx/FormattingShowcase.hwpx")
}

fn section0_xml(bytes: &[u8]) -> String {
    let pkg = hwp_hwpx::package::Package::open(bytes).unwrap();
    String::from_utf8(pkg.read_part("Contents/section0.xml").unwrap()).unwrap()
}

/// Block indices of every top-level table in section 0.
fn table_indices(doc: &SemanticDoc) -> Vec<usize> {
    doc.sections[0]
        .blocks
        .iter()
        .enumerate()
        .filter_map(|(i, b)| matches!(b, Block::Table(_)).then_some(i))
        .collect()
}

/// SetTableCellRuns와 동일한 모델 변이: 셀 본문을 새 dirty 문단으로 교체 + dirty 마킹.
fn edit_cell(doc: &mut SemanticDoc, ti: usize, row: usize, col: usize, text: &str) {
    let sec = doc.sections.get_mut(0).unwrap();
    let Block::Table(t) = &mut sec.blocks[ti] else {
        panic!("block {ti} is not a table")
    };
    let cell = t
        .cells
        .iter_mut()
        .find(|c| c.active && c.row == row && c.col == col)
        .expect("target cell exists");
    cell.blocks = vec![Block::Paragraph(Paragraph {
        runs: vec![Run {
            char_shape: 0,
            content: vec![Inline::Text(text.into())],
            ..Default::default()
        }],
        dirty: Dirty(true),
        ..Default::default()
    })];
    cell.dirty.mark();
    t.dirty.mark();
    sec.dirty.mark();
}

/// 재현 본체: hwpx 오리진 + 표 셀 편집 + 재방출 → 표가 원 블록 인덱스에 유지되고,
/// 문서 끝에 복제 표가 append되지 않아야 한다. (수정 전 레드 — append 경로가 표를 복제)
#[test]
fn edited_table_reemits_in_place_not_appended() {
    let src = showcase();
    let mut doc = parse_semantic(&src).unwrap();

    let tables_before = table_indices(&doc);
    assert!(!tables_before.is_empty(), "fixture has a top-level table");
    let ti = tables_before[0];
    let n_blocks = doc.sections[0].blocks.len();

    edit_cell(&mut doc, ti, 0, 0, MARKER);
    let out = serialize(&doc).unwrap();
    let doc2 = parse_semantic(&out).unwrap();

    // ① 표 개수/블록 개수 불변 — 문서 끝 append 복제가 없다.
    assert_eq!(
        table_indices(&doc2).len(),
        tables_before.len(),
        "table count must not grow (no duplicate appended at the end)"
    );
    assert_eq!(
        doc2.sections[0].blocks.len(),
        n_blocks,
        "block count unchanged"
    );

    // ② 편집된 표가 원 블록 인덱스에 그대로 앉아 있고, 셀 텍스트가 편집본이다.
    let Block::Table(t2) = &doc2.sections[0].blocks[ti] else {
        panic!("block {ti} is no longer a table after round-trip")
    };
    let cell_text: String = t2
        .cells
        .iter()
        .find(|c| c.active && c.row == 0 && c.col == 0)
        .map(|c| {
            let mut s = SemanticDoc::default();
            s.sections.push(Section {
                blocks: c.blocks.clone(),
                ..Default::default()
            });
            s.plain_text()
        })
        .unwrap_or_default();
    assert!(
        cell_text.contains(MARKER),
        "cell (0,0) at the ORIGINAL anchor must carry the edited text, got: {cell_text:?}"
    );

    // ③ 편집 마커는 문서 전체에서 정확히 한 번 — 원 위치 표 잔존 + 끝 복제의 이중화가 없다.
    assert_eq!(
        doc2.plain_text().matches(MARKER).count(),
        1,
        "edited text appears exactly once"
    );

    // ④ 오픈 세이프티(한/글이 '손상된 파일'로 거부하지 않는 패키지).
    assert!(
        hwp_hwpx::export::validate_open_safety(&out).ok,
        "output is open-safe"
    );
}

/// 제자리 셀 수술의 충실도: 편집하지 않은 형제 셀의 `<hp:tc>` 바이트와 표의 `<hp:tbl …>` 오픈
/// 태그(지오메트리/borderFill)는 재방출 후에도 byte-verbatim으로 남아야 한다.
#[test]
fn untouched_sibling_cells_and_table_open_tag_stay_verbatim() {
    let src = showcase();
    let orig_xml = section0_xml(&src);
    let mut doc = parse_semantic(&src).unwrap();
    let ti = table_indices(&doc)[0];

    // 편집 전, (0,0)이 아닌 첫 형제 셀의 원본 tc 스팬과 tbl 오픈 태그를 채집한다.
    let (sibling_bytes, tbl_open) = {
        let Block::Table(t) = &doc.sections[0].blocks[ti] else {
            unreachable!()
        };
        let (s0, _e0) = t
            .src_span
            .expect("hwpx-parsed table carries its source span");
        let open_end = orig_xml[s0..].find('>').unwrap() + s0 + 1;
        let sib = t
            .cells
            .iter()
            .find(|c| c.active && !(c.row == 0 && c.col == 0))
            .and_then(|c| c.src_span)
            .map(|(cs, ce)| orig_xml[cs..ce].to_string())
            .expect("an untouched sibling cell carries its source span");
        (sib, orig_xml[s0..open_end].to_string())
    };

    edit_cell(&mut doc, ti, 0, 0, MARKER);
    let out = serialize(&doc).unwrap();
    let new_xml = section0_xml(&out);

    assert!(
        new_xml.contains(&sibling_bytes),
        "untouched sibling cell stays byte-verbatim"
    );
    assert!(
        new_xml.contains(&tbl_open),
        "the original <hp:tbl …> open tag survives verbatim"
    );
    assert!(
        new_xml.contains(MARKER),
        "edited text present in the section XML"
    );
}

/// verbatim 해자 무회귀: 무편집 문서의 재방출은 결정적이며, 원본 섹션 XML이 그대로 보존된다.
#[test]
fn noedit_export_is_deterministic_and_keeps_section_verbatim() {
    let src = showcase();
    let doc = parse_semantic(&src).unwrap();
    let a = serialize(&doc).unwrap();
    let b = serialize(&doc).unwrap();
    assert_eq!(a, b, "no-edit export is byte-deterministic");
    assert_eq!(
        section0_xml(&a),
        section0_xml(&src),
        "no-edit section XML is byte-verbatim"
    );
}

/// 셀 레벨만 dirty한 편집(SetTableCellShade — 내용 무변경): 셀 본문은 byte-verbatim으로 남고
/// (파싱 AST가 모델링하지 못한 pic/수식/ctrl을 절대 지우지 않는다), tc 오픈 태그의
/// borderFillIDRef만 합성된 음영 fill로 패치된다. 표는 원 앵커 유지.
#[test]
fn shade_only_edit_keeps_cell_body_verbatim_and_patches_fill() {
    let src = showcase();
    let orig_xml = section0_xml(&src);
    let mut doc = parse_semantic(&src).unwrap();
    let tables_before = table_indices(&doc);
    let ti = tables_before[0];

    // 편집 전 대상 셀 (0,0)의 subList 본문 바이트를 채집.
    let cell_body = {
        let Block::Table(t) = &doc.sections[0].blocks[ti] else {
            unreachable!()
        };
        let (cs, ce) = t
            .cells
            .iter()
            .find(|c| c.active && c.row == 0 && c.col == 0)
            .and_then(|c| c.src_span)
            .expect("cell (0,0) carries its source span");
        let seg = &orig_xml[cs..ce];
        let sub = seg.find("<hp:subList").unwrap();
        let open_end = sub + seg[sub..].find('>').unwrap() + 1;
        let close = seg.rfind("</hp:subList>").unwrap();
        seg[open_end..close].to_string()
    };
    assert!(
        !cell_body.is_empty(),
        "captured a non-empty original cell body"
    );

    // SetTableCellShade와 동형: shade만 설정 + cell/table/sec dirty (본문 문단은 dirty 아님).
    let shade = "#DDEBF7";
    {
        let sec = doc.sections.get_mut(0).unwrap();
        let Block::Table(t) = &mut sec.blocks[ti] else {
            unreachable!()
        };
        let cell = t
            .cells
            .iter_mut()
            .find(|c| c.active && c.row == 0 && c.col == 0)
            .unwrap();
        cell.shade_color = hwp_model::types::Color::from_hex(shade);
        cell.dirty.mark();
        t.dirty.mark();
        sec.dirty.mark();
    }

    let out = serialize(&doc).unwrap();
    let new_xml = section0_xml(&out);
    let doc2 = parse_semantic(&out).unwrap();

    // 표 개수/앵커 불변 + 셀 본문 byte-verbatim 보존.
    assert_eq!(
        table_indices(&doc2).len(),
        tables_before.len(),
        "no duplicate table appended"
    );
    assert!(
        new_xml.contains(&cell_body),
        "shade-only cell body stays byte-verbatim"
    );
    // 음영 borderFill이 합성되고 셀이 그것을 참조한다.
    let pkg = hwp_hwpx::package::Package::open(&out).unwrap();
    let header = String::from_utf8(pkg.read_header().unwrap()).unwrap();
    assert!(
        header.contains(&format!("faceColor=\"{shade}\"")),
        "shade borderFill synthesized"
    );
    assert!(hwp_hwpx::export::validate_open_safety(&out).ok);
}

/// 구조가 바뀐 표(새 행 추가 = span 없는 새 셀)는 per-cell 수술 대신 **표 전체를 원 앵커에서**
/// 재합성한다 — 여전히 끝으로 append되지 않는다.
#[test]
fn structurally_changed_table_is_reemitted_whole_but_in_place() {
    let src = showcase();
    let mut doc = parse_semantic(&src).unwrap();
    let tables_before = table_indices(&doc);
    let ti = tables_before[0];
    let n_blocks = doc.sections[0].blocks.len();

    // TableAppendEmptyRow와 동형의 변이: 마지막 행 뒤에 span 없는 새 셀들 + rows+1.
    {
        let sec = doc.sections.get_mut(0).unwrap();
        let Block::Table(t) = &mut sec.blocks[ti] else {
            unreachable!()
        };
        let at = t.rows;
        for col in 0..t.cols {
            t.cells.push(Cell {
                row: at,
                col,
                blocks: vec![Block::Paragraph(Paragraph {
                    runs: vec![Run {
                        char_shape: 0,
                        content: vec![Inline::Text(if col == 0 {
                            MARKER.into()
                        } else {
                            String::new()
                        })],
                        ..Default::default()
                    }],
                    dirty: Dirty(true),
                    ..Default::default()
                })],
                dirty: Dirty(true),
                ..Default::default()
            });
        }
        t.rows += 1;
        t.dirty.mark();
        sec.dirty.mark();
    }

    let out = serialize(&doc).unwrap();
    let doc2 = parse_semantic(&out).unwrap();

    assert_eq!(
        table_indices(&doc2).len(),
        tables_before.len(),
        "no duplicate table appended"
    );
    assert_eq!(
        doc2.sections[0].blocks.len(),
        n_blocks,
        "block count unchanged"
    );
    let Block::Table(t2) = &doc2.sections[0].blocks[ti] else {
        panic!("block {ti} is no longer a table")
    };
    assert_eq!(
        t2.rows, 4,
        "the appended row survives the round-trip (3×3 → 4×3)"
    );
    assert_eq!(
        doc2.plain_text().matches(MARKER).count(),
        1,
        "new row text exactly once"
    );
    assert!(hwp_hwpx::export::validate_open_safety(&out).ok);
}
