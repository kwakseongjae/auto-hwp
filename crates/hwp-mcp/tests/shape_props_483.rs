//! #483 — 문단 · 표 배치 속성 Intent: `SetParagraphShape` · `InsertParagraphAt.para_like` · `SetTableProps`.
//!
//! 수용 기준을 내보낸 XML 로 잠근다: 바꾼 속성만 바뀌고(나머지 바이트 그대로), 같은 묶음을 하나씩 ·
//! 한 번에 · 원자 묶음으로 넣어도 `section*.xml` · `header.xml` 이 같고, 실행취소 한 칸이면 편집 전과
//! 같다. 거절된 요청은 문서 · 리비전 · 실행취소 스택을 건드리지 않는다.
//!
//! 픽스처는 공개 코퍼스만: `corpus/hwpx/FormattingShowcase.hwpx`(본문 문단 + 3×3 표 하나, 문단 모양
//! 12 를 네 문단이 같이 쓴다) · `hwpxlib_corpus/reader_writer/SimpleTable.hwpx`(첫 칸에 표를 하나 더
//! 끼워 칸 안 표를 만든다).

use std::io::{Cursor, Read, Write};

use hwp_hwpx::package::Package;
use hwp_mcp::{
    apply_intent_json, apply_intents_json, apply_intents_json_with, export_bytes, open_bytes,
    BatchOptions, Outcome, Session,
};
use hwp_model::prelude::*;
use serde_json::{json, Value};

const SEC: &str = "Contents/section0.xml";
const HEAD: &str = "Contents/header.xml";

fn corpus(rel: &str) -> Vec<u8> {
    let p = format!("{}/../../corpus/{rel}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&p).unwrap_or_else(|e| panic!("read {p}: {e}"))
}

/// 본문 문단 모양 공유: 블록 1 = paraPr 16(가운데), 블록 3 · 4 · 5 · 8 = paraPr 12, 블록 6 = 표.
fn showcase() -> Vec<u8> {
    corpus("hwpx/FormattingShowcase.hwpx")
}

/// `SimpleTable.hwpx` 의 첫 칸(0,0) 끝에 같은 표의 사본(id 777)을 담은 문단을 끼운 문서 — 칸 안 표.
fn nested_doc() -> Vec<u8> {
    let src = corpus("hwpxlib_corpus/reader_writer/SimpleTable.hwpx");
    let mut zin = zip::ZipArchive::new(Cursor::new(&src)).unwrap();
    let mut sec = String::new();
    zin.by_name(SEC).unwrap().read_to_string(&mut sec).unwrap();
    let t0 = sec.find("<hp:tbl ").expect("tbl");
    let t1 = sec.find("</hp:tbl>").expect("tbl end") + "</hp:tbl>".len();
    let inner = sec[t0..t1].replacen("id=\"1137126797\"", "id=\"777\"", 1);
    let first_cell_end = t0 + sec[t0..].find("</hp:subList>").expect("first cell");
    let host = format!(
        "<hp:p id=\"0\" paraPrIDRef=\"16\" styleIDRef=\"0\" pageBreak=\"0\" columnBreak=\"0\" merged=\"0\"><hp:run charPrIDRef=\"0\">{inner}<hp:t/></hp:run></hp:p>"
    );
    sec.insert_str(first_cell_end, &host);
    let names: Vec<String> = (0..zin.len())
        .map(|i| zin.by_index(i).unwrap().name().to_string())
        .collect();
    let mut out = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (i, name) in names.iter().enumerate() {
        if name == SEC {
            out.start_file(
                name,
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Deflated),
            )
            .unwrap();
            out.write_all(sec.as_bytes()).unwrap();
        } else {
            out.raw_copy_file(zin.by_index_raw(i).unwrap()).unwrap();
        }
    }
    out.finish().unwrap().into_inner()
}

fn open(bytes: &[u8]) -> Session {
    let mut s = Session::default();
    open_bytes(&mut s, bytes, "t.hwpx").expect("open");
    s
}

fn apply(s: &mut Session, v: Value) -> std::result::Result<Outcome, String> {
    apply_intent_json(s, &v)
}

fn export(s: &Session) -> Vec<u8> {
    export_bytes(s).expect("export")
}

fn part(bytes: &[u8], name: &str) -> String {
    let pkg = Package::open(bytes).unwrap();
    String::from_utf8(pkg.read_part(name).unwrap()).unwrap()
}

/// Every `Contents/*.xml` part (sections + header), for "same bytes" comparisons.
fn xml_parts(bytes: &[u8]) -> Vec<(String, String)> {
    let mut z = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut out = Vec::new();
    for i in 0..z.len() {
        let mut f = z.by_index(i).unwrap();
        let name = f.name().to_string();
        if name.starts_with("Contents/") && name.ends_with(".xml") {
            let mut s = String::new();
            f.read_to_string(&mut s).unwrap();
            out.push((name, s));
        }
    }
    out.sort();
    out
}

fn attr(tag: &str, name: &str) -> Option<String> {
    let pat = format!(" {name}=\"");
    let s = tag.find(&pat)? + pat.len();
    Some(tag[s..s + tag[s..].find('"')?].to_string())
}

/// The `<hp:p …>` open tag of the paragraph whose text contains `text`.
fn open_tag_of(sec: &str, text: &str) -> String {
    let at = sec
        .find(text)
        .unwrap_or_else(|| panic!("text {text:?} not found"));
    let p = sec[..at].rfind("<hp:p ").expect("hp:p");
    sec[p..p + sec[p..].find('>').unwrap() + 1].to_string()
}

/// The whole `<hp:p …>…</hp:p>` of the paragraph whose text contains `text` (top-level paragraphs).
fn para_of(sec: &str, text: &str) -> String {
    let at = sec.find(text).unwrap();
    let p = sec[..at].rfind("<hp:p ").unwrap();
    let e = p + sec[p..].find("</hp:p>").unwrap() + "</hp:p>".len();
    sec[p..e].to_string()
}

fn para_pr(header: &str, id: &str) -> String {
    let needle = format!("<hh:paraPr id=\"{id}\"");
    let s = header
        .find(&needle)
        .unwrap_or_else(|| panic!("paraPr {id}"));
    let e = s + header[s..].find("</hh:paraPr>").unwrap() + "</hh:paraPr>".len();
    header[s..e].to_string()
}

fn para_pr_count(header: &str) -> usize {
    header.matches("<hh:paraPr ").count()
}

/// `elem` with its own (first) `id="…"` blanked — "the same element modulo id".
fn blank_id(elem: &str) -> String {
    let s = elem.find(" id=\"").unwrap() + " id=\"".len();
    let e = s + elem[s..].find('"').unwrap();
    format!("{}{}", &elem[..s], &elem[e..])
}

fn sp(block: usize, fields: Value) -> Value {
    let mut v = json!({"intent": "SetParagraphShape", "section": 0, "block": block});
    v.as_object_mut()
        .unwrap()
        .extend(fields.as_object().unwrap().clone());
    v
}

// ---- SetParagraphShape ----------------------------------------------------------------------

/// 수용 기준 1 — 그 문단만 `keepWithNext="1"` 모양을 가리키고, 같은 모양(12)을 쓰던 문단은 그대로.
/// 새 모양은 12 를 통째로 복제한 것과 `keepWithNext` 하나만 다르고, 섹션에서 바뀐 바이트는 그 문단의
/// `paraPrIDRef` 하나뿐이다(본문 · 줄 배치 캐시 그대로).
#[test]
fn keep_with_next_moves_only_that_paragraph_to_a_clone_of_its_shape() {
    let src = showcase();
    let (sec0, head0) = (part(&src, SEC), part(&src, HEAD));
    let mut s = open(&src);
    apply(&mut s, sp(3, json!({"keep_with_next": true}))).expect("apply");
    let out = export(&s);
    let (sec1, head1) = (part(&out, SEC), part(&out, HEAD));

    let old_tag = open_tag_of(&sec0, "표와 셀 병합 확인");
    let new_tag = open_tag_of(&sec1, "표와 셀 병합 확인");
    assert_eq!(attr(&old_tag, "paraPrIDRef").as_deref(), Some("12"));
    let new_id = attr(&new_tag, "paraPrIDRef").unwrap();
    assert_ne!(new_id, "12");
    for other in [
        "다양한 글자 속성 렌더링",
        "문단 간격과 정렬 유지",
        "표 1. 서식 검증용 샘플 데이터",
    ] {
        assert_eq!(
            attr(&open_tag_of(&sec1, other), "paraPrIDRef").as_deref(),
            Some("12"),
            "{other}"
        );
    }
    assert_eq!(para_pr_count(&head1), para_pr_count(&head0) + 1);
    let derived = para_pr(&head1, &new_id);
    assert_eq!(
        blank_id(&derived),
        blank_id(&para_pr(&head0, "12")).replace("keepWithNext=\"0\"", "keepWithNext=\"1\""),
        "the clone of paraPr 12 differs only in keepWithNext"
    );
    // The section changed in that one attribute — the body (runs + linesegarray) is verbatim.
    assert_eq!(sec1.replacen(&new_tag, &old_tag, 1), sec0);
    // The header changed only by the appended paraPr (+ the pool count).
    let head1_back = head1.replacen(&derived, "", 1).replacen(
        &format!(
            "<hh:paraProperties itemCnt=\"{}\"",
            para_pr_count(&head0) + 1
        ),
        &format!("<hh:paraProperties itemCnt=\"{}\"", para_pr_count(&head0)),
        1,
    );
    assert_eq!(head1_back, head0);
}

/// 수용 기준(보강) — 필드마다 복제본은 원래 모양과 **그 속성만** 다르다. 정렬 · 줄 간격은 그 문단의 줄
/// 배치 캐시(`linesegarray`)를 버리고(한/글이 다시 잰다), 나눔 설정만 바꾸면 그대로 둔다.
#[test]
fn every_field_changes_only_its_own_attribute() {
    let src = showcase();
    let (sec0, head0) = (part(&src, SEC), part(&src, HEAD));
    let base = para_pr(&head0, "16"); // 블록 1 「형식 테스트 문서」 — 가운데 정렬
    let line_spacing = |elem: &str, ty: &str, v: &str| {
        let mut out = String::new();
        let mut rest = elem;
        while let Some(i) = rest.find("<hh:lineSpacing ") {
            let e = i + rest[i..].find('>').unwrap() + 1;
            let tag = &rest[i..e];
            let old_ty = attr(tag, "type").unwrap();
            let old_v = attr(tag, "value").unwrap();
            out.push_str(&rest[..i]);
            out.push_str(
                &tag.replacen(&format!("type=\"{old_ty}\""), &format!("type=\"{ty}\""), 1)
                    .replacen(&format!("value=\"{old_v}\""), &format!("value=\"{v}\""), 1),
            );
            rest = &rest[e..];
        }
        out.push_str(rest);
        out
    };
    let cases: Vec<(Value, String, bool)> = vec![
        (
            json!({"widow_orphan": true}),
            base.replace("widowOrphan=\"0\"", "widowOrphan=\"1\""),
            true,
        ),
        (
            json!({"page_break_before": true}),
            base.replace("pageBreakBefore=\"0\"", "pageBreakBefore=\"1\""),
            true,
        ),
        (
            json!({"align": "right"}),
            base.replace("horizontal=\"CENTER\"", "horizontal=\"RIGHT\""),
            false,
        ),
        (
            json!({"line_spacing_pct": 175}),
            line_spacing(&base, "PERCENT", "175"),
            false,
        ),
    ];
    for (fields, expected, keeps_lineseg) in cases {
        assert_ne!(expected, base, "case {fields} must change something");
        let mut s = open(&src);
        apply(&mut s, sp(1, fields.clone())).unwrap_or_else(|e| panic!("{fields}: {e}"));
        let out = export(&s);
        let (sec1, head1) = (part(&out, SEC), part(&out, HEAD));
        let new_id = attr(&open_tag_of(&sec1, "형식 테스트 문서"), "paraPrIDRef").unwrap();
        assert_ne!(new_id, "16", "{fields}");
        assert_eq!(
            blank_id(&para_pr(&head1, &new_id)),
            blank_id(&expected),
            "{fields}: only that attribute differs from paraPr 16"
        );
        assert_eq!(para_pr_count(&head1), para_pr_count(&head0) + 1, "{fields}");
        let before = para_of(&sec0, "형식 테스트 문서");
        let after = para_of(&sec1, "형식 테스트 문서");
        assert!(before.contains("<hp:linesegarray>"));
        assert_eq!(
            after.contains("<hp:linesegarray>"),
            keeps_lineseg,
            "{fields}"
        );
    }
}

/// 지금 값과 같은 패치는 원래 id 를 다시 쓰고, 내보낸 XML 이 편집 전과 바이트까지 같다.
#[test]
fn restating_the_current_values_exports_the_same_bytes() {
    let src = showcase();
    let before = xml_parts(&export(&open(&src)));
    let mut s = open(&src);
    // paraPr 12: LEFT · widowOrphan="1" · keepWithNext="0" · pageBreakBefore="0"
    apply(
        &mut s,
        sp(
            3,
            json!({"align": "left", "widow_orphan": true, "keep_with_next": false, "page_break_before": false}),
        ),
    )
    .expect("apply");
    assert_eq!(xml_parts(&export(&s)), before);
}

/// 같은 원본에 같은 변경을 받은 문단은 paraPr 하나를 같이 쓰고, 같은 문단을 두 번 고치면 원본에서 한
/// 번에 만든 모양 하나다(중간 모양은 나가지 않는다).
#[test]
fn equal_derivations_share_one_parapr_and_a_second_edit_overlays() {
    let src = showcase();
    let head0 = part(&src, HEAD);
    let mut s = open(&src);
    apply(&mut s, sp(3, json!({"keep_with_next": true}))).unwrap();
    apply(&mut s, sp(4, json!({"keep_with_next": true}))).unwrap();
    apply(&mut s, sp(5, json!({"keep_with_next": true}))).unwrap();
    apply(&mut s, sp(5, json!({"page_break_before": true}))).unwrap();
    let out = export(&s);
    let (sec1, head1) = (part(&out, SEC), part(&out, HEAD));
    let id3 = attr(&open_tag_of(&sec1, "표와 셀 병합 확인"), "paraPrIDRef").unwrap();
    let id4 = attr(
        &open_tag_of(&sec1, "다양한 글자 속성 렌더링"),
        "paraPrIDRef",
    )
    .unwrap();
    let id5 = attr(&open_tag_of(&sec1, "문단 간격과 정렬 유지"), "paraPrIDRef").unwrap();
    assert_eq!(id3, id4, "same base + same change → one paraPr");
    assert_ne!(id3, id5);
    assert_eq!(para_pr_count(&head1), para_pr_count(&head0) + 2);
    assert_eq!(
        blank_id(&para_pr(&head1, &id5)),
        blank_id(&para_pr(&head0, "12"))
            .replace("keepWithNext=\"0\"", "keepWithNext=\"1\"")
            .replace("pageBreakBefore=\"0\"", "pageBreakBefore=\"1\""),
        "the second edit lays over the first, from the original shape"
    );
}

/// `page_break_before` 는 조판이 이미 읽는 문단 모양 값이라 라이브 쪽 나눔이 바로 따라온다.
#[test]
fn page_break_before_reaches_the_live_layout() {
    let mut s = open(&showcase());
    let Outcome::PageCount(before) = apply(&mut s, json!({"intent": "PageCount"})).unwrap() else {
        panic!("PageCount")
    };
    let Outcome::Edited { pages } =
        apply(&mut s, sp(5, json!({"page_break_before": true}))).unwrap()
    else {
        panic!("Edited")
    };
    assert_eq!(
        pages,
        before + 1,
        "a forced break before block 5 adds a page"
    );
}

// ---- InsertParagraphAt.para_like ------------------------------------------------------------

/// 수용 기준 2 — 새 문단이 기준 블록과 같은 `paraPrIDRef` 를 쓰고 `hh:paraPr` 는 늘지 않는다.
#[test]
fn para_like_reuses_the_reference_paragraph_shape_id() {
    let src = showcase();
    let head0 = part(&src, HEAD);
    for (block, id) in [(3usize, "12"), (1, "16")] {
        let mut s = open(&src);
        apply(
            &mut s,
            json!({"intent": "InsertParagraphAt", "section": 0, "index": 4,
                   "runs": [{"text": "새로 넣은 줄 483"}], "para_like": {"section": 0, "block": block}}),
        )
        .expect("insert");
        let out = export(&s);
        let (sec1, head1) = (part(&out, SEC), part(&out, HEAD));
        assert_eq!(
            attr(&open_tag_of(&sec1, "새로 넣은 줄 483"), "paraPrIDRef").as_deref(),
            Some(id),
            "like block {block}"
        );
        assert_eq!(
            para_pr_count(&head1),
            para_pr_count(&head0),
            "no new paraPr"
        );
    }
}

/// 이미 고친 문단을 기준으로 하면 그 고친 모양을 그대로 쓴다.
#[test]
fn para_like_follows_a_derived_shape() {
    let mut s = open(&showcase());
    apply(&mut s, sp(3, json!({"keep_with_next": true}))).unwrap();
    apply(
        &mut s,
        json!({"intent": "InsertParagraphAt", "section": 0, "index": 4,
               "runs": [{"text": "뒤따르는 줄 483"}], "para_like": {"section": 0, "block": 3}}),
    )
    .unwrap();
    let sec1 = part(&export(&s), SEC);
    assert_eq!(
        attr(&open_tag_of(&sec1, "뒤따르는 줄 483"), "paraPrIDRef"),
        attr(&open_tag_of(&sec1, "표와 셀 병합 확인"), "paraPrIDRef"),
    );
}

// ---- SetTableProps ---------------------------------------------------------------------------

fn tbl_open(sec: &str, id: &str) -> String {
    let s = sec.find(&format!("<hp:tbl id=\"{id}\"")).expect("tbl");
    sec[s..s + sec[s..].find('>').unwrap() + 1].to_string()
}

/// The table's own `<hp:pos …/>` (the first after its open tag).
fn tbl_pos(sec: &str, id: &str) -> String {
    let s = sec.find(&format!("<hp:tbl id=\"{id}\"")).unwrap();
    let p = s + sec[s..].find("<hp:pos ").unwrap();
    sec[p..p + sec[p..].find('>').unwrap() + 1].to_string()
}

fn grid_json(s: &Session, section: usize, block: usize) -> String {
    let doc = s.doc.as_ref().unwrap().doc();
    serde_json::to_string(&hwp_session::table_grid(doc, section, block)).unwrap()
}

/// 수용 기준 3 — 세 속성만 바뀐다. 다시 열면 칸 격자 · 쪽 수가 그대로다.
#[test]
fn set_table_props_changes_exactly_the_three_attributes() {
    const TID: &str = "1137126797";
    let src = showcase();
    let sec0 = part(&src, SEC);
    assert_eq!(
        attr(&tbl_open(&sec0, TID), "pageBreak").as_deref(),
        Some("CELL")
    );
    assert_eq!(
        attr(&tbl_open(&sec0, TID), "repeatHeader").as_deref(),
        Some("1")
    );
    assert_eq!(
        attr(&tbl_pos(&sec0, TID), "treatAsChar").as_deref(),
        Some("0")
    );

    let mut s0 = open(&src);
    let Outcome::PageCount(pages0) = apply(&mut s0, json!({"intent": "PageCount"})).unwrap() else {
        panic!()
    };
    let grid0 = grid_json(&s0, 0, 6);

    let mut s = open(&src);
    apply(
        &mut s,
        json!({"intent": "SetTableProps", "section": 0, "index": 6,
               "treat_as_char": true, "page_break": "table", "repeat_header": false}),
    )
    .expect("apply");
    let out = export(&s);
    let sec1 = part(&out, SEC);
    let (open1, pos1) = (tbl_open(&sec1, TID), tbl_pos(&sec1, TID));
    assert_eq!(attr(&open1, "pageBreak").as_deref(), Some("TABLE"));
    assert_eq!(attr(&open1, "repeatHeader").as_deref(), Some("0"));
    assert_eq!(attr(&pos1, "treatAsChar").as_deref(), Some("1"));
    let back =
        sec1.replacen(&open1, &tbl_open(&sec0, TID), 1)
            .replacen(&pos1, &tbl_pos(&sec0, TID), 1);
    assert_eq!(back, sec0, "nothing else in the section changed");
    assert_eq!(part(&out, HEAD), part(&src, HEAD), "header untouched");

    let mut re = open(&out);
    let Outcome::PageCount(pages1) = apply(&mut re, json!({"intent": "PageCount"})).unwrap() else {
        panic!()
    };
    assert_eq!(pages1, pages0, "reopened page count");
    assert_eq!(grid_json(&re, 0, 6), grid0, "reopened tableGrid");
}

/// 이슈 본문의 예(`false` · `cell` · `false`)는 이 표에서 `repeatHeader` 만 바꾸고, 지금 값을 다시
/// 말하면 바이트가 그대로다.
#[test]
fn set_table_props_only_writes_what_differs() {
    const TID: &str = "1137126797";
    let src = showcase();
    let sec0 = part(&src, SEC);
    let mut s = open(&src);
    apply(
        &mut s,
        json!({"intent": "SetTableProps", "section": 0, "index": 6,
               "treat_as_char": false, "page_break": "cell", "repeat_header": false}),
    )
    .unwrap();
    let sec1 = part(&export(&s), SEC);
    assert_eq!(
        sec1.replacen("repeatHeader=\"0\"", "repeatHeader=\"1\"", 1),
        sec0
    );
    assert_eq!(
        attr(&tbl_open(&sec1, TID), "repeatHeader").as_deref(),
        Some("0")
    );

    let before = xml_parts(&export(&open(&src)));
    let mut s = open(&src);
    apply(
        &mut s,
        json!({"intent": "SetTableProps", "section": 0, "index": 6,
               "treat_as_char": false, "page_break": "cell", "repeat_header": true}),
    )
    .unwrap();
    assert_eq!(xml_parts(&export(&s)), before);
}

/// 수용 기준 4 — 칸 안 표는 `path`(부모 칸) + `index`(칸 안 블록 번호): 그 표만 바뀌고 바깥 표는 그대로.
#[test]
fn nested_table_props_through_path() {
    let src = nested_doc();
    let sec0 = part(&src, SEC);
    let mut s = open(&src);
    let (bi, inner_index) = {
        let doc = s.doc.as_ref().unwrap().doc();
        let bi = doc.sections[0]
            .blocks
            .iter()
            .position(|b| matches!(b, Block::Table(_)))
            .expect("outer table");
        let Block::Table(t) = &doc.sections[0].blocks[bi] else {
            unreachable!()
        };
        let cell = t.cells.iter().find(|c| c.row == 0 && c.col == 0).unwrap();
        let ii = cell
            .blocks
            .iter()
            .position(|b| matches!(b, Block::Table(_)))
            .expect("nested table in cell (0,0)");
        (bi, ii)
    };
    let path = json!([{"block": bi, "row": 0, "col": 0}]);
    apply(
        &mut s,
        json!({"intent": "SetTableProps", "section": 0, "path": path, "index": inner_index,
               "page_break": "none", "treat_as_char": true}),
    )
    .expect("nested apply");
    let sec1 = part(&export(&s), SEC);
    assert_eq!(
        attr(&tbl_open(&sec1, "777"), "pageBreak").as_deref(),
        Some("NONE")
    );
    assert_eq!(
        attr(&tbl_pos(&sec1, "777"), "treatAsChar").as_deref(),
        Some("1")
    );
    assert_eq!(
        tbl_open(&sec1, "1137126797"),
        tbl_open(&sec0, "1137126797"),
        "outer table untouched"
    );
    let back = sec1
        .replacen(&tbl_open(&sec1, "777"), &tbl_open(&sec0, "777"), 1)
        .replacen(&tbl_pos(&sec1, "777"), &tbl_pos(&sec0, "777"), 1);
    assert_eq!(back, sec0);

    // A paragraph inside the cell is not a table; a missing cell is out of range.
    let e = apply(
        &mut s,
        json!({"intent": "SetTableProps", "section": 0, "path": path, "index": 0, "page_break": "none"}),
    )
    .err()
    .expect("paragraph in cell");
    assert!(e.starts_with("invalid target:"), "{e}");
    let e = apply(
        &mut s,
        json!({"intent": "SetTableProps", "section": 0, "path": [{"block": bi, "row": 9, "col": 9}],
               "index": 0, "page_break": "none"}),
    )
    .err()
    .expect("missing cell");
    assert!(e.contains("out of range"), "{e}");
}

/// 바깥 표의 칸을 고친(칸 단위 다시 쓰기) 뒤에도 그 표의 배치 속성이 같이 나간다.
#[test]
fn table_props_survive_a_cell_edit_of_the_same_table() {
    const TID: &str = "1137126797";
    let src = showcase();
    let mut s = open(&src);
    apply(
        &mut s,
        json!({"intent": "SetTableCellRuns", "section": 0, "index": 6, "row": 1, "col": 1,
               "runs": [{"text": "고친 칸 483"}]}),
    )
    .unwrap();
    apply(
        &mut s,
        json!({"intent": "SetTableProps", "section": 0, "index": 6, "repeat_header": false}),
    )
    .unwrap();
    let sec1 = part(&export(&s), SEC);
    assert!(sec1.contains("고친 칸 483"));
    assert_eq!(
        attr(&tbl_open(&sec1, TID), "repeatHeader").as_deref(),
        Some("0")
    );
}

// ---- 실행취소 · 두 경로 = 한 경로 · 거절 ------------------------------------------------------------

fn batch() -> Vec<Value> {
    vec![
        sp(3, json!({"keep_with_next": true})),
        sp(4, json!({"keep_with_next": true, "widow_orphan": false})),
        sp(1, json!({"align": "right", "line_spacing_pct": 175})),
        sp(3, json!({"page_break_before": true})),
        json!({"intent": "SetTableProps", "section": 0, "index": 6,
               "treat_as_char": true, "page_break": "table", "repeat_header": false}),
        json!({"intent": "InsertParagraphAt", "section": 0, "index": 5,
               "runs": [{"text": "묶음으로 넣은 줄 483"}], "para_like": {"section": 0, "block": 3}}),
        sp(5, json!({"keep_with_next": true})), // the inserted paragraph (index 5)
    ]
}

/// 수용 기준 5 — Intent 하나가 실행취소 한 칸이고, 원자 묶음은 묶음 전체가 한 칸이다. 되돌리면 편집 전
/// 내보내기와 바이트까지 같다.
#[test]
fn undo_restores_the_pre_edit_export() {
    let src = showcase();
    let before = xml_parts(&export(&open(&src)));
    let mut s = open(&src);
    for v in batch() {
        apply(&mut s, v).expect("apply");
    }
    assert_ne!(xml_parts(&export(&s)), before);
    for _ in 0..batch().len() {
        apply(&mut s, json!({"intent": "Undo"})).expect("undo");
    }
    assert_eq!(xml_parts(&export(&s)), before, "one undo per intent");

    let mut s = open(&src);
    apply_intents_json_with(
        &mut s,
        &batch(),
        &BatchOptions {
            atomic: true,
            ..Default::default()
        },
    )
    .expect("atomic batch");
    apply(&mut s, json!({"intent": "Undo"})).expect("undo");
    assert_eq!(
        xml_parts(&export(&s)),
        before,
        "one undo for the atomic batch"
    );
}

/// The editor's apply lane: `ProposeIntents` (scratch preview) then `CommitProposal` (one undo unit).
fn propose_and_commit(s: &mut Session, intents: &[Value]) {
    let Outcome::ProposalV1(p) = apply(s, json!({"intent": "ProposeIntents", "intents": intents}))
        .unwrap_or_else(|e| panic!("propose: {e}"))
    else {
        panic!("ProposalV1")
    };
    apply(
        s,
        json!({"intent": "CommitProposal", "proposal_id": p.proposal_id, "expected_revision": p.base_revision}),
    )
    .unwrap_or_else(|e| panic!("commit: {e}"));
}

/// 핵심 — 두 경로 = 한 경로. 같은 묶음을 하나씩 · 한 번에(재조판 1회) · 원자 묶음 · 편집기 레인(제안 →
/// 커밋)으로 넣어 내보낸 `section*.xml` · `header.xml` 이 바이트까지 같다.
#[test]
fn one_by_one_and_batched_lanes_export_identical_xml() {
    let src = showcase();
    let mut one = open(&src);
    for v in batch() {
        apply(&mut one, v).expect("one by one");
    }
    let mut many = open(&src);
    apply_intents_json(&mut many, &batch()).expect("batch");
    let mut atomic = open(&src);
    apply_intents_json_with(
        &mut atomic,
        &batch(),
        &BatchOptions {
            atomic: true,
            ..Default::default()
        },
    )
    .expect("atomic");
    let mut editor = open(&src);
    propose_and_commit(&mut editor, &batch());
    let a = xml_parts(&export(&one));
    assert_eq!(a, xml_parts(&export(&many)), "one-by-one == batched");
    assert_eq!(a, xml_parts(&export(&atomic)), "one-by-one == atomic");
    assert_eq!(
        a,
        xml_parts(&export(&editor)),
        "one-by-one == propose → commit"
    );
    apply(&mut editor, json!({"intent": "Undo"})).expect("one undo for the committed proposal");
    assert_eq!(xml_parts(&export(&editor)), xml_parts(&export(&open(&src))));
    // …and the batch really did something to both parts.
    let before = xml_parts(&export(&open(&src)));
    let changed: Vec<&str> = a
        .iter()
        .zip(&before)
        .filter(|(x, y)| x != y)
        .map(|(x, _)| x.0.as_str())
        .collect();
    assert!(
        changed.contains(&SEC) && changed.contains(&HEAD),
        "{changed:?}"
    );
}

/// 거절은 문서 · 리비전 · 실행취소 스택을 건드리지 않는다. 메시지 머리말이 wasm 오류 코드를 정한다
/// (`invalid target:` → `invalid_target`, `invalid intent:` → `bad_intent`, `out of range` → `out_of_range`).
#[test]
fn refusals_leave_the_document_untouched() {
    let src = showcase();
    let mut s = open(&src);
    apply(&mut s, sp(3, json!({"keep_with_next": true}))).unwrap(); // one undo unit to protect
    let before = xml_parts(&export(&s));
    let rev = s.doc.as_ref().unwrap().revision();
    let cases: Vec<(Value, &str)> = vec![
        (sp(3, json!({})), "invalid intent:"),
        (sp(3, json!({"line_spacing_pct": 0})), "invalid intent:"),
        (sp(6, json!({"keep_with_next": true})), "invalid target:"),
        (sp(99, json!({"keep_with_next": true})), "out of range"),
        (sp(3, json!({"align": "middle"})), "unknown variant"),
        (sp(3, json!({"keepWithNext": true})), "unknown field"),
        (
            json!({"intent": "SetTableProps", "section": 0, "index": 6}),
            "invalid intent:",
        ),
        (
            json!({"intent": "SetTableProps", "section": 0, "index": 3, "repeat_header": false}),
            "invalid target:",
        ),
        (
            json!({"intent": "SetTableProps", "section": 0, "index": 99, "repeat_header": false}),
            "out of range",
        ),
        (
            json!({"intent": "SetTableProps", "section": 0, "index": 6, "page_break": "row"}),
            "unknown variant",
        ),
        (
            json!({"intent": "InsertParagraphAt", "section": 0, "index": 4, "runs": [{"text": "x"}],
                   "para": {"align": "center"}, "para_like": {"section": 0, "block": 3}}),
            "invalid intent:",
        ),
        (
            json!({"intent": "InsertParagraphAt", "section": 0, "index": 4, "runs": [{"text": "x"}],
                   "para_like": {"section": 0, "block": 6}}),
            "invalid target:",
        ),
        (
            json!({"intent": "InsertParagraphAt", "section": 0, "index": 4, "runs": [{"text": "x"}],
                   "para_like": {"section": 0, "block": 99}}),
            "out of range",
        ),
        (
            json!({"intent": "InsertParagraphAt", "section": 0, "index": 4, "runs": [{"text": "x"}],
                   "para_like": {"section": 0, "block": 3, "para": 0}}),
            "unknown field",
        ),
    ];
    for (v, want) in cases {
        let e = apply(&mut s, v.clone())
            .err()
            .unwrap_or_else(|| panic!("{v} should be refused"));
        assert!(e.contains(want), "{v}: {e}");
        assert_eq!(s.doc.as_ref().unwrap().revision(), rev, "{v}: revision");
    }
    assert_eq!(xml_parts(&export(&s)), before, "document untouched");
    apply(&mut s, json!({"intent": "Undo"})).expect("the protected unit is still there");
    assert_eq!(xml_parts(&export(&s)), xml_parts(&export(&open(&src))));
}
