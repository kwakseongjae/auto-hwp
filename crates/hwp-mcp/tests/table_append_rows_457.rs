//! #457 — 표 행 붙이기 · 끼우기(`TableAppendRow` · `TableInsertRows`)도 #442 구조 경로를 탄다.
//!
//! 0.0.15 까지는 행 수가 바뀐 표를 통째로 다시 만들었다(`emit_table`) — 원본 행 높이가 22pt 폴백으로
//! 바뀌고, 세로 병합이 붙인 행까지 내려오지 않고, 표 제목(`<hp:caption>`)이 사라졌다. 이제:
//! - 원본 `<hp:tc>` 는 바이트 그대로(주소만 같은 값으로 다시 씀)
//! - 새 행은 기준 행(붙일 때 복제하는 행 = 끼우는 자리 바로 위 행)의 `<hp:tc>` 를 복제 — 높이 · 테두리
//! - 기준 행을 덮는 세로 병합은 `rowSpan` 을 늘려 새 행까지 덮는다(기본 동작)
//! - 붙이기 → 지우기 왕복은 원본 표 XML 과 같다
//!
//! 픽스처는 공개 코퍼스만: `corpus/hwpxlib_corpus/error/20251107/test.hwpx`(묶음 왼쪽 세로 병합이 마지막
//! 행에서 끝나는 3열 표) · `reader_writer/SimpleTable.hwpx`(테스트 안에서 `<hp:caption>` 을 끼워 넣음).

use std::io::{Cursor, Read, Write};

use hwp_hwpx::package::Package;
use hwp_mcp::{apply_intent, export_bytes, open_bytes, Intent, Session};
use hwp_model::prelude::*;

fn corpus(rel: &str) -> Vec<u8> {
    let p = format!("{}/../../corpus/{rel}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&p).unwrap_or_else(|e| panic!("read {p}: {e}"))
}

/// 묶음 왼쪽 세로 병합(`rowSpan=3`)이 마지막 행에서 끝나는 10행 3열 표가 있는 문서.
fn merge_doc() -> Vec<u8> {
    corpus("hwpxlib_corpus/error/20251107/test.hwpx")
}

const CAPTION: &str = r#"<hp:caption side="TOP" fullSz="0" width="8504" gap="850" lastWidth="41954"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0"><hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>&lt; 표 제목 457 &gt;</hp:t></hp:run></hp:p></hp:subList></hp:caption>"#;

/// `SimpleTable.hwpx` 의 표에 위쪽 표 제목(`<hp:caption>`)을 끼운 문서 — `<hp:outMargin …/>` 바로 뒤.
fn caption_doc() -> Vec<u8> {
    let src = corpus("hwpxlib_corpus/reader_writer/SimpleTable.hwpx");
    let mut zin = zip::ZipArchive::new(Cursor::new(&src)).unwrap();
    let mut sec = String::new();
    zin.by_name("Contents/section0.xml")
        .unwrap()
        .read_to_string(&mut sec)
        .unwrap();
    let t = sec.find("<hp:tbl ").expect("tbl");
    let m = t + sec[t..].find("<hp:outMargin ").expect("outMargin");
    let m_end = m + sec[m..].find("/>").unwrap() + 2;
    sec.insert_str(m_end, CAPTION);
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

/// `(section, block)` of the first top-level table with `rows × cols`.
fn find_table(s: &Session, rows: usize, cols: usize) -> (usize, usize) {
    let doc = s.doc.as_ref().unwrap().doc();
    for (si, sec) in doc.sections.iter().enumerate() {
        for (bi, b) in sec.blocks.iter().enumerate() {
            if let Block::Table(t) = b {
                if t.rows == rows && t.cols == cols {
                    return (si, bi);
                }
            }
        }
    }
    panic!("no {rows}x{cols} table");
}

fn table(s: &Session, (si, bi): (usize, usize)) -> Table {
    let Block::Table(t) = &s.doc.as_ref().unwrap().doc().sections[si].blocks[bi] else {
        panic!("block {bi} is not a table")
    };
    t.edit_target().clone()
}

/// `(rows, cols, [(row, col, row_span, col_span)])` of the active cells, sorted.
fn grid(t: &Table) -> (usize, usize, Vec<(usize, usize, usize, usize)>) {
    let mut v: Vec<_> = t
        .cells
        .iter()
        .filter(|c| c.active)
        .map(|c| (c.row, c.col, c.row_span.max(1), c.col_span.max(1)))
        .collect();
    v.sort();
    (t.rows, t.cols, v)
}

fn section_xml(bytes: &[u8], si: usize) -> String {
    let pkg = Package::open(bytes).unwrap();
    String::from_utf8_lossy(&pkg.read_part(&format!("Contents/section{si}.xml")).unwrap())
        .into_owned()
}

/// The `<hp:tbl id="{id}" …>…</hp:tbl>` element (nesting-aware).
fn table_by_id(sec: &str, id: &str) -> String {
    let s = sec
        .find(&format!("<hp:tbl id=\"{id}\""))
        .unwrap_or_else(|| panic!("table id {id}"));
    let mut depth = 0usize;
    let mut i = s + 1;
    loop {
        let open = sec[i..].find("<hp:tbl ").map(|k| i + k);
        let close = i + sec[i..].find("</hp:tbl>").expect("close");
        match open {
            Some(o) if o < close => {
                depth += 1;
                i = o + 1;
            }
            _ => {
                if depth == 0 {
                    return sec[s..close + "</hp:tbl>".len()].to_string();
                }
                depth -= 1;
                i = close + 1;
            }
        }
    }
}

fn attr<'a>(s: &'a str, name: &str) -> &'a str {
    let k = format!(" {name}=\"");
    let i = s.find(&k).unwrap_or_else(|| panic!("{name} in {s:.200}")) + k.len();
    &s[i..i + s[i..].find('"').unwrap()]
}

/// The table's own `<hp:{name} …>` element before its first row (`sz`, `caption`, …).
fn head(tbl: &str) -> &str {
    &tbl[..tbl.find("<hp:tr").unwrap()]
}

/// One top-level cell: its `<hp:tc>` XML and own (row, col, rowSpan, colSpan, height, borderFill).
#[derive(Clone, Debug)]
struct Tc {
    xml: String,
    row: usize,
    col: usize,
    row_span: usize,
    col_span: usize,
    height: i64,
    bf: String,
}

fn own<'a>(tc: &'a str, name: &str) -> &'a str {
    // A cell's own cellAddr/cellSpan/cellSz follow its (outermost) subList → the LAST occurrence.
    let i = tc.rfind(&format!("<hp:{name} ")).expect(name);
    &tc[i..i + tc[i..].find('>').unwrap()]
}

/// Top-level `<hp:tc>` elements of a table, in document order (nested tables skipped).
fn cells(tbl: &str) -> Vec<Tc> {
    let mut out = Vec::new();
    let mut depth = 0i32; // table depth: the table itself = 1
    let mut start: Option<usize> = None;
    let mut i = 0;
    while i < tbl.len() {
        let rest = &tbl[i..];
        if rest.starts_with("<hp:tbl ") {
            depth += 1;
        } else if rest.starts_with("</hp:tbl>") {
            depth -= 1;
        } else if depth == 1 && rest.starts_with("<hp:tc ") {
            start = Some(i);
        } else if depth == 1 && rest.starts_with("</hp:tc>") {
            let s = start.take().unwrap();
            let xml = tbl[s..i + "</hp:tc>".len()].to_string();
            let (addr, span, sz) = (
                own(&xml, "cellAddr"),
                own(&xml, "cellSpan"),
                own(&xml, "cellSz"),
            );
            out.push(Tc {
                row: attr(addr, "rowAddr").parse().unwrap(),
                col: attr(addr, "colAddr").parse().unwrap(),
                row_span: attr(span, "rowSpan").parse().unwrap(),
                col_span: attr(span, "colSpan").parse().unwrap(),
                height: attr(sz, "height").parse().unwrap(),
                bf: attr(&xml[..xml.find('>').unwrap()], "borderFillIDRef").to_string(),
                xml,
            });
        }
        i += rest.chars().next().unwrap().len_utf8();
    }
    out
}

/// A `<hp:tc>` with its own address/span/height normalized — for "same cell except geometry".
fn without_geometry(tc: &Tc) -> String {
    let mut x = tc.xml.clone();
    for name in ["cellAddr", "cellSpan", "cellSz"] {
        let i = x.rfind(&format!("<hp:{name} ")).unwrap();
        let j = i + x[i..].find('>').unwrap();
        x.replace_range(i..j, &format!("<hp:{name}"));
    }
    x
}

fn export(s: &Session) -> Vec<u8> {
    let out = export_bytes(s).expect("export");
    assert!(hwp_hwpx::export::validate_open_safety(&out).ok, "open-safe");
    out
}

struct Case {
    src: Vec<u8>,
    at: (usize, usize),
    id: String,
    orig: String,
}

fn case(src: Vec<u8>, rows: usize, cols: usize) -> (Case, Session) {
    let s = open(&src);
    let at = find_table(&s, rows, cols);
    let sec = section_xml(&src, at.0);
    // The table's id: the first `<hp:tbl id=…>` whose rowCnt/colCnt match.
    let id = sec
        .match_indices("<hp:tbl id=\"")
        .map(|(i, _)| &sec[i..i + sec[i..].find('>').unwrap()])
        .find(|o| attr(o, "rowCnt") == rows.to_string() && attr(o, "colCnt") == cols.to_string())
        .map(|o| attr(o, "id").to_string())
        .expect("table id");
    let orig = table_by_id(&sec, &id);
    (Case { src, at, id, orig }, s)
}

fn exported_table(c: &Case, bytes: &[u8]) -> String {
    table_by_id(&section_xml(bytes, c.at.0), &c.id)
}

// ── 1. 붙이기: 원본 칸 그대로 · 새 행 = 기준 행 복제 · 병합 늘림 ─────────────────────────────────

#[test]
fn append_keeps_original_cells_clones_template_row_and_extends_merge() {
    let (c, mut s) = case(merge_doc(), 10, 3);
    let orig = cells(&c.orig);
    let last = 9;
    // 기준 행(마지막 행)의 칸 · 마지막 행에서 끝나는 세로 병합
    let template: Vec<&Tc> = orig.iter().filter(|t| t.row == last).collect();
    let merges: Vec<&Tc> = orig
        .iter()
        .filter(|t| t.row < last && t.row + t.row_span == last + 1)
        .collect();
    assert!(
        !merges.is_empty(),
        "fixture: a vertical merge ends at the last row"
    );

    apply_intent(
        &mut s,
        Intent::TableAppendRow {
            section: c.at.0,
            index: c.at.1,
        },
    )
    .unwrap();
    let mem = grid(&table(&s, c.at));
    let out = export(&s);
    let back = grid(&table(&open(&out), c.at));
    assert_eq!(mem, back, "memory grid == reopened grid");

    let x = exported_table(&c, &out);
    assert_eq!(attr(head(&x), "rowCnt"), "11");
    let got = cells(&x);
    // 원본 칸: 병합을 늘린 칸 말고는 바이트 그대로(높이 포함)
    for o in &orig {
        let g = got
            .iter()
            .find(|g| (g.row, g.col) == (o.row, o.col))
            .unwrap_or_else(|| panic!("cell ({},{}) kept", o.row, o.col));
        if merges.iter().any(|m| (m.row, m.col) == (o.row, o.col)) {
            assert_eq!(
                g.row_span,
                o.row_span + 1,
                "merge ({},{}) extends",
                o.row,
                o.col
            );
            let th = template[0].height; // 기준 행 높이
            assert_eq!(
                g.height,
                o.height + th,
                "extended merge height += template row"
            );
            assert_eq!(
                without_geometry(g),
                without_geometry(o),
                "merge cell body verbatim"
            );
        } else {
            assert_eq!(
                g.xml, o.xml,
                "original cell ({},{}) byte-verbatim",
                o.row, o.col
            );
        }
    }
    // 새 행: 병합이 덮은 열엔 칸이 없고, 나머지는 기준 행 칸 복제(높이 · 테두리 · 칸 모양)
    let new_row: Vec<&Tc> = got.iter().filter(|g| g.row == last + 1).collect();
    let covered: usize = merges.iter().map(|m| m.col_span).sum();
    let expect_cols: Vec<usize> = template.iter().map(|t| t.col).collect();
    assert_eq!(
        new_row.iter().map(|g| g.col).collect::<Vec<_>>(),
        expect_cols,
        "new row = template row's cells ({covered} merged column(s) covered by the merge)"
    );
    for g in &new_row {
        let t = template.iter().find(|t| t.col == g.col).unwrap();
        assert_eq!(
            g.height, t.height,
            "new cell ({},{}) height = template's",
            g.row, g.col
        );
        assert_eq!(
            g.bf, t.bf,
            "new cell borderFill = template's (dotted lines kept)"
        );
        assert_eq!((g.row_span, g.col_span), (1, t.col_span));
    }
    // 표 바깥 속성 · 크기: 높이만 기준 행만큼 늘었다
    let (oh, gh) = (
        attr(
            &head(&c.orig)[head(&c.orig).find("<hp:sz ").unwrap()..],
            "height",
        )
        .parse::<i64>()
        .unwrap(),
        attr(&head(&x)[head(&x).find("<hp:sz ").unwrap()..], "height")
            .parse::<i64>()
            .unwrap(),
    );
    assert_eq!(
        gh,
        oh + template[0].height,
        "table height += template row height"
    );
}

// ── 2. 붙이기 → 지우기 왕복 = 원본 표 XML ───────────────────────────────────────────────────

fn assert_same_table(got: &str, orig: &str) {
    if got != orig {
        let (g, o) = (cells(got), cells(orig));
        for (a, b) in g.iter().zip(o.iter()) {
            assert_eq!(a.xml, b.xml, "first differing cell");
        }
        assert_eq!(head(got), head(orig), "table head");
        assert_eq!(got, orig, "table XML");
    }
}

#[test]
fn append_then_delete_in_one_session_is_the_original_table() {
    let (c, mut s) = case(merge_doc(), 10, 3);
    let (sec, index) = c.at;
    apply_intent(
        &mut s,
        Intent::TableAppendRow {
            section: sec,
            index,
        },
    )
    .unwrap();
    apply_intent(
        &mut s,
        Intent::TableAppendRow {
            section: sec,
            index,
        },
    )
    .unwrap();
    apply_intent(
        &mut s,
        Intent::TableDeleteRows {
            section: sec,
            index,
            at: 10,
            count: 2,
            path: None,
        },
    )
    .unwrap();
    assert_same_table(&exported_table(&c, &export(&s)), &c.orig);
}

#[test]
fn append_save_reopen_delete_is_the_original_table() {
    let (c, mut s) = case(merge_doc(), 10, 3);
    let (sec, index) = c.at;
    apply_intent(
        &mut s,
        Intent::TableAppendRow {
            section: sec,
            index,
        },
    )
    .unwrap();
    let saved = export(&s);
    let mut re = open(&saved);
    apply_intent(
        &mut re,
        Intent::TableDeleteRows {
            section: sec,
            index,
            at: 10,
            count: 1,
            path: None,
        },
    )
    .unwrap();
    assert_same_table(&exported_table(&c, &export(&re)), &c.orig);
    let _ = &c.src;
}

// ── 3. 표 제목(캡션) · 바깥 속성 유지 ────────────────────────────────────────────────────────

#[test]
fn append_keeps_the_caption_and_outer_props() {
    let src = caption_doc();
    let (c, mut s) = case(src, 3, 3);
    assert!(c.orig.contains(CAPTION), "fixture: caption spliced in");
    apply_intent(
        &mut s,
        Intent::TableAppendRow {
            section: c.at.0,
            index: c.at.1,
        },
    )
    .unwrap();
    let x = exported_table(&c, &export(&s));
    assert!(x.contains(CAPTION), "caption kept byte-verbatim");
    // 바깥 속성: rowCnt · sz height 말고는 머리 그대로
    let norm = |h: &str| {
        let mut h = h.replace(&format!("rowCnt=\"{}\"", attr(h, "rowCnt")), "rowCnt");
        let i = h.find("<hp:sz ").unwrap();
        let j = i + h[i..].find("/>").unwrap();
        let sz = h[i..j].to_string();
        h = h.replace(
            &sz,
            &sz.replace(&format!("height=\"{}\"", attr(&sz, "height")), "height"),
        );
        h
    };
    assert_eq!(
        norm(head(&x)),
        norm(head(&c.orig)),
        "table head except rowCnt/height"
    );
    // 원본 칸 그대로
    let orig = cells(&c.orig);
    let got = cells(&x);
    for o in &orig {
        let g = got
            .iter()
            .find(|g| (g.row, g.col) == (o.row, o.col))
            .unwrap();
        assert_eq!(
            g.xml, o.xml,
            "original cell ({},{}) byte-verbatim",
            o.row, o.col
        );
    }
}

// ── 4. 끼우기(TableInsertRows) — 끝 · 가운데 ───────────────────────────────────────────────

#[test]
fn insert_rows_at_end_keeps_originals_and_borrows_the_cell_above() {
    // `TableInsertRows` keeps its v0 contract (`cols` cells per new row) — a merge that merely ENDS
    // on the row above is not extended — but the table now rides the structural path: originals
    // verbatim, each new cell copies the look + height of the cell above it.
    let (c, mut s) = case(merge_doc(), 10, 3);
    let (sec, index) = c.at;
    let orig = cells(&c.orig);
    apply_intent(
        &mut s,
        Intent::TableInsertRows {
            section: sec,
            index,
            at: 10,
            count: 2,
            cols: 3,
        },
    )
    .unwrap();
    let mem = grid(&table(&s, c.at));
    let out = export(&s);
    assert_eq!(mem, grid(&table(&open(&out), c.at)), "memory == reopened");
    let x = exported_table(&c, &out);
    assert_eq!(attr(head(&x), "rowCnt"), "12");
    let got = cells(&x);
    for o in &orig {
        let g = got
            .iter()
            .find(|g| (g.row, g.col) == (o.row, o.col))
            .unwrap();
        assert_eq!(
            g.xml, o.xml,
            "original cell ({},{}) byte-verbatim",
            o.row, o.col
        );
    }
    let above = |col: usize| {
        orig.iter()
            .find(|o| {
                o.row <= 9 && 9 < o.row + o.row_span && o.col <= col && col < o.col + o.col_span
            })
            .unwrap()
    };
    for r in [10, 11] {
        let row: Vec<&Tc> = got.iter().filter(|g| g.row == r).collect();
        assert_eq!(row.len(), 3, "row {r}: `cols` cells");
        for g in row {
            let a = above(g.col);
            assert_eq!(g.bf, a.bf, "({r},{}) borderFill = the cell above's", g.col);
            if a.row_span == 1 {
                assert_eq!(
                    g.height, a.height,
                    "({r},{}) height = the cell above's",
                    g.col
                );
            }
        }
    }
    // 끼운 행을 지우면 원본
    apply_intent(
        &mut s,
        Intent::TableDeleteRows {
            section: sec,
            index,
            at: 10,
            count: 2,
            path: None,
        },
    )
    .unwrap();
    assert_same_table(&exported_table(&c, &export(&s)), &c.orig);
}

#[test]
fn insert_rows_inside_a_merge_extends_it_and_round_trips() {
    let (c, mut s) = case(merge_doc(), 10, 3);
    let (sec, index) = c.at;
    let orig = cells(&c.orig);
    // 가운데 세로 병합 하나(마지막이 아닌) — 그 안쪽 행에 끼운다.
    let m = orig
        .iter()
        .find(|t| t.row_span > 1 && t.row + t.row_span < 10)
        .expect("fixture: an inner vertical merge");
    let at = m.row + 1;
    apply_intent(
        &mut s,
        Intent::TableInsertRows {
            section: sec,
            index,
            at,
            count: 1,
            cols: 3,
        },
    )
    .unwrap();
    let mem = grid(&table(&s, c.at));
    let out = export(&s);
    assert_eq!(mem, grid(&table(&open(&out), c.at)), "memory == reopened");
    let got = cells(&exported_table(&c, &out));
    let g = got
        .iter()
        .find(|g| (g.row, g.col) == (m.row, m.col))
        .unwrap();
    assert_eq!(
        g.row_span,
        m.row_span + 1,
        "merge crossing the insert row extends"
    );
    // 겹치는 칸 없음: 모든 격자 칸이 정확히 한 번 덮인다.
    let mut cover = vec![vec![0u8; 3]; 11];
    for t in &got {
        for r in t.row..t.row + t.row_span {
            for k in t.col..t.col + t.col_span {
                cover[r][k] += 1;
            }
        }
    }
    assert!(
        cover.iter().flatten().all(|&n| n == 1),
        "grid covered exactly once: {cover:?}"
    );
    // 지우면 원본
    apply_intent(
        &mut s,
        Intent::TableDeleteRows {
            section: sec,
            index,
            at,
            count: 1,
            path: None,
        },
    )
    .unwrap();
    assert_same_table(&exported_table(&c, &export(&s)), &c.orig);
}
