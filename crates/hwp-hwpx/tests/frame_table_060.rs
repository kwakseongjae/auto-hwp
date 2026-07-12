//! issue 060 — 1×1 프레임 래퍼(자가진단표류) 내부표 편집이 HWPX 저장에 반영되어야 한다.
//!
//! 증상(수정 전): 표 편집 op은 `edit_target()`로 **내부 표만** dirty 마킹한다. 외부 1×1 래퍼 표와
//! 그 셀의 dirty는 영원히 false → 익스포터의 emit 게이트(비재귀 `t.dirty || cells.any(c.dirty)`)가
//! 래퍼 블록을 전부 스킵 → export는 돌지만 아무것도 안 내보내 원본 그대로 저장(편집 소실).
//!
//! 수정(2단계): ① emit 게이트를 프레임 투명(재귀 `Block::any_dirty`)으로, ② 내부 표에도 `src_span`을
//! 부여하고 `table_inplace_edits`가 `edit_target()`로 내부 표를 해소해 내부 dirty 셀만 제자리 splice —
//! 외부 래퍼·미편집 형제 셀은 byte-verbatim.
//!
//! 코퍼스에 실제 프레임 래퍼가 없어, FormattingShowcase의 top-level 3×3 표를 1×1 외곽 표로 감싸
//! (모든 IDRef는 원본에서 재사용) 진짜 프레임 래퍼 HWPX를 합성한 뒤 real 파서/직렬화기로 왕복한다.

use hwp_hwpx::package::Package;
use hwp_hwpx::parse::parse_semantic;
use hwp_hwpx::serialize::serialize;
use hwp_model::prelude::*;
use std::io::{Cursor, Write};

const MARKER: &str = "060프레임내부편집";

fn showcase() -> Vec<u8> {
    let p = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../corpus/hwpx/FormattingShowcase.hwpx"
    );
    std::fs::read(p).expect("read corpus/hwpx/FormattingShowcase.hwpx")
}

fn section0_xml(bytes: &[u8]) -> String {
    let pkg = Package::open(bytes).unwrap();
    String::from_utf8(pkg.read_part("Contents/section0.xml").unwrap()).unwrap()
}

/// Wrap the section's first top-level `<hp:tbl>` (a 3×3 grid) inside a NEW 1×1 outer table whose
/// single cell holds it — the 자가진단표 shape (a frame wrapper). Every IDRef is reused from the
/// original table so the reused header pools stay valid (open-safe).
fn wrap_first_table_in_frame(sec_xml: &str) -> String {
    let ti = sec_xml.find("<hp:tbl").expect("a top-level table");
    // Enclosing wrapper <hp:p> of that table…
    let ps = sec_xml[..ti].rfind("<hp:p ").expect("table wrapper <hp:p>");
    // …and its close, AFTER the table's </hp:tbl>.
    let tclose = sec_xml[ti..].find("</hp:tbl>").expect("table close") + ti + "</hp:tbl>".len();
    let pe = sec_xml[tclose..].find("</hp:p>").expect("wrapper close") + tclose + "</hp:p>".len();
    let original_para = &sec_xml[ps..pe];

    // Outer 1×1 wrapper: <hp:p><hp:run><hp:tbl 1×1><hp:tr><hp:tc><hp:subList> {original_para} …
    let outer_open = concat!(
        "<hp:p id=\"4000000099\" paraPrIDRef=\"3\" styleIDRef=\"0\" pageBreak=\"0\" columnBreak=\"0\" merged=\"0\">",
        "<hp:run charPrIDRef=\"0\">",
        "<hp:tbl id=\"1137199999\" zOrder=\"0\" numberingType=\"TABLE\" textWrap=\"TOP_AND_BOTTOM\" textFlow=\"BOTH_SIDES\" lock=\"0\" dropcapstyle=\"None\" pageBreak=\"CELL\" repeatHeader=\"1\" rowCnt=\"1\" colCnt=\"1\" cellSpacing=\"0\" borderFillIDRef=\"3\" noAdjust=\"0\">",
        "<hp:sz width=\"19029\" widthRelTo=\"ABSOLUTE\" height=\"8657\" heightRelTo=\"ABSOLUTE\" protect=\"0\"/>",
        "<hp:pos treatAsChar=\"0\" affectLSpacing=\"0\" flowWithText=\"1\" allowOverlap=\"0\" holdAnchorAndSO=\"0\" vertRelTo=\"PARA\" horzRelTo=\"COLUMN\" vertAlign=\"TOP\" horzAlign=\"LEFT\" vertOffset=\"0\" horzOffset=\"0\"/>",
        "<hp:outMargin left=\"0\" right=\"0\" top=\"0\" bottom=\"0\"/>",
        "<hp:inMargin left=\"0\" right=\"0\" top=\"0\" bottom=\"0\"/>",
        "<hp:tr>",
        "<hp:tc name=\"\" header=\"0\" hasMargin=\"0\" protect=\"0\" editable=\"0\" dirty=\"0\" borderFillIDRef=\"3\">",
        "<hp:subList id=\"\" textDirection=\"HORIZONTAL\" lineWrap=\"BREAK\" vertAlign=\"CENTER\" linkListIDRef=\"0\" linkListNextIDRef=\"0\" textWidth=\"0\" textHeight=\"0\" hasTextRef=\"0\" hasNumRef=\"0\">",
    );
    let outer_close = concat!(
        "</hp:subList>",
        "<hp:cellAddr colAddr=\"0\" rowAddr=\"0\"/>",
        "<hp:cellSpan colSpan=\"1\" rowSpan=\"1\"/>",
        "<hp:cellSz width=\"19029\" height=\"8657\"/>",
        "<hp:cellMargin left=\"0\" right=\"0\" top=\"0\" bottom=\"0\"/>",
        "</hp:tc></hp:tr></hp:tbl>",
        "<hp:t></hp:t></hp:run></hp:p>",
    );

    let mut out = String::with_capacity(sec_xml.len() + 1200);
    out.push_str(&sec_xml[..ps]);
    out.push_str(outer_open);
    out.push_str(original_para);
    out.push_str(outer_close);
    out.push_str(&sec_xml[pe..]);
    out
}

/// Repackage `src` (a valid HWPX) replacing `Contents/section0.xml` with `new_sec` — every other
/// part is copied byte-verbatim (raw_copy preserves STORED mimetype + order).
fn repackage_section0(src: &[u8], new_sec: &str) -> Vec<u8> {
    let mut zin = zip::ZipArchive::new(Cursor::new(src.to_vec())).unwrap();
    let names: Vec<String> = (0..zin.len())
        .map(|i| zin.by_index(i).unwrap().name().to_string())
        .collect();
    let mut out = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (i, name) in names.iter().enumerate() {
        if name == "Contents/section0.xml" {
            out.start_file(
                name,
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Deflated),
            )
            .unwrap();
            out.write_all(new_sec.as_bytes()).unwrap();
        } else {
            let raw = zin.by_index_raw(i).unwrap();
            out.raw_copy_file(raw).unwrap();
        }
    }
    out.finish().unwrap().into_inner()
}

/// The FormattingShowcase package rebuilt so section0 carries a 1×1 frame wrapper around its table.
fn frame_fixture() -> Vec<u8> {
    let src = showcase();
    let wrapped = wrap_first_table_in_frame(&section0_xml(&src));
    repackage_section0(&src, &wrapped)
}

/// Block index of the frame-wrapper table (1×1 whose inner is a multi-row table) in section 0.
fn frame_wrapper_index(doc: &SemanticDoc) -> usize {
    doc.sections[0]
        .blocks
        .iter()
        .enumerate()
        .find_map(|(i, b)| match b {
            Block::Table(t) if t.frame_inner().is_some() => Some(i),
            _ => None,
        })
        .expect("a frame-wrapper table exists")
}

/// SetTableCell과 동형: 프레임 래퍼의 INNER 표(edit_target) 셀 본문을 새 dirty 문단으로 교체 +
/// **내부** 셀/표/섹션만 dirty 마킹(외부 래퍼는 절대 건드리지 않는다 — 이게 060의 근본 원인).
fn edit_inner_cell(doc: &mut SemanticDoc, row: usize, col: usize, text: &str) {
    let fi = frame_wrapper_index(doc);
    let sec = doc.sections.get_mut(0).unwrap();
    let Block::Table(outer) = &mut sec.blocks[fi] else {
        unreachable!()
    };
    let inner = outer.edit_target_mut(); // 1×1 wrapper → the inner grid
    let cell = inner
        .cells
        .iter_mut()
        .find(|c| c.active && c.row == row && c.col == col)
        .expect("inner cell exists");
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
    inner.dirty.mark();
    sec.dirty.mark();
    // NOTE: `outer` (the 1×1 wrapper) and its wrapper cell stay CLEAN — as the real op leaves them.
}

fn cell_text(cell: &Cell) -> String {
    let mut s = SemanticDoc::default();
    s.sections.push(Section {
        blocks: cell.blocks.clone(),
        ..Default::default()
    });
    s.plain_text()
}

/// 근본 재현: 프레임 래퍼 내부 셀 편집 → 저장 → 재열기에 반영되어야 한다.
/// (수정 전 레드 — 게이트가 래퍼를 스킵해 편집이 통째로 소실된다.)
#[test]
fn frame_wrapper_inner_edit_reaches_export() {
    let src = frame_fixture();
    let mut doc = parse_semantic(&src).unwrap();

    // 프레임 래퍼가 실제로 합성됐는지 + 내부 표가 다행(多行)인지 사전 확인 (깊이 2단: 프레임>표>셀).
    let fi = frame_wrapper_index(&doc);
    let inner_rows = {
        let Block::Table(t) = &doc.sections[0].blocks[fi] else {
            unreachable!()
        };
        t.frame_inner().unwrap().rows
    };
    assert!(inner_rows > 1, "inner table is multi-row (nesting depth 2)");
    let wrappers_before = doc.sections[0]
        .blocks
        .iter()
        .filter(|b| matches!(b, Block::Table(t) if t.frame_inner().is_some()))
        .count();

    edit_inner_cell(&mut doc, 0, 0, MARKER);
    let out = serialize(&doc).unwrap();
    let doc2 = parse_semantic(&out).unwrap();

    // ① 편집이 반영됐다 — 내부 셀 (0,0)이 마커를 갖는다.
    let fi2 = frame_wrapper_index(&doc2);
    let Block::Table(outer2) = &doc2.sections[0].blocks[fi2] else {
        unreachable!()
    };
    let inner2 = outer2.frame_inner().expect("still a frame wrapper");
    let c00 = inner2
        .cells
        .iter()
        .find(|c| c.active && c.row == 0 && c.col == 0)
        .expect("inner (0,0) exists");
    assert!(
        cell_text(c00).contains(MARKER),
        "inner cell (0,0) must carry the edit after round-trip, got: {:?}",
        cell_text(c00)
    );

    // ② 마커는 문서 전체에서 정확히 한 번 — 끝 append 복제나 원 위치 잔존 이중화가 없다.
    assert_eq!(
        doc2.plain_text().matches(MARKER).count(),
        1,
        "edited text appears exactly once"
    );

    // ③ 프레임 래퍼 개수 불변 — 복제 표가 생기지 않았다.
    let wrappers_after = doc2.sections[0]
        .blocks
        .iter()
        .filter(|b| matches!(b, Block::Table(t) if t.frame_inner().is_some()))
        .count();
    assert_eq!(
        wrappers_after, wrappers_before,
        "no duplicate frame wrapper"
    );

    // ④ 오픈 세이프티.
    assert!(
        hwp_hwpx::export::validate_open_safety(&out).ok,
        "output is open-safe"
    );
}

/// verbatim 해자: 편집하지 않은 INNER 형제 셀의 `<hp:tc>` 바이트와 OUTER 1×1 래퍼의 오픈 태그는
/// 재방출 후에도 byte-verbatim으로 남아야 한다(제자리 셀 수술 — 057 정합).
#[test]
fn frame_wrapper_untouched_sibling_and_outer_wrapper_stay_verbatim() {
    let src = frame_fixture();
    let orig_xml = section0_xml(&src);
    let mut doc = parse_semantic(&src).unwrap();

    let (sibling_bytes, outer_open) = {
        let fi = frame_wrapper_index(&doc);
        let Block::Table(outer) = &doc.sections[0].blocks[fi] else {
            unreachable!()
        };
        // 외부 1×1 래퍼의 오픈 태그(외곽 지오메트리) — 절대 재합성되면 안 된다.
        let (os, _) = outer.src_span.expect("outer wrapper carries its span");
        let outer_open_end = orig_xml[os..].find('>').unwrap() + os + 1;
        let inner = outer.frame_inner().unwrap();
        // 내부 표의 미편집 형제 셀 하나의 원본 tc 바이트.
        let sib = inner
            .cells
            .iter()
            .find(|c| c.active && !(c.row == 0 && c.col == 0))
            .and_then(|c| c.src_span)
            .map(|(cs, ce)| orig_xml[cs..ce].to_string())
            .expect("an untouched inner sibling cell carries its span");
        (sib, orig_xml[os..outer_open_end].to_string())
    };

    edit_inner_cell(&mut doc, 0, 0, MARKER);
    let out = serialize(&doc).unwrap();
    let new_xml = section0_xml(&out);

    assert!(
        new_xml.contains(&sibling_bytes),
        "untouched inner sibling cell stays byte-verbatim"
    );
    assert!(
        new_xml.contains(&outer_open),
        "the outer 1×1 wrapper open tag survives verbatim"
    );
    assert!(
        new_xml.contains(MARKER),
        "edited text present in section XML"
    );
}

/// 무편집 왕복은 결정적 + 섹션 XML byte-verbatim (프레임 래퍼가 있어도 해자 불변).
#[test]
fn frame_fixture_noedit_export_is_verbatim() {
    let src = frame_fixture();
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
