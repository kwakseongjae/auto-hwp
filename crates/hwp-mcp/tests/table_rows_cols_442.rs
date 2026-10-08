//! #442 (R-04) — 표 행 지우기 · 열 넣기 · 열 지우기.
//!
//! `SimpleTable.hwpx`(3×3, (0,0) 에 2×2 병합)에서 각 동작 → 메모리 격자 == 내보내기 → 다시 연 격자,
//! `rowCnt`/`colCnt` · 모든 칸의 `cellAddr`/`cellSpan` 이 격자와 맞고, 열기 안전 검사를 통과한다.
//! 행/열이 바뀐 표는 원본 `<hp:tc>` 를 그대로 두고 주소만 고친다 — 표 위치 속성(`treatAsChar` 등)이 남는다.

use hwp_hwpx::package::Package;
use hwp_mcp::{apply_intent, export_bytes, open_bytes, Intent, Session};
use hwp_model::prelude::*;

fn simple_table() -> Vec<u8> {
    let p = format!(
        "{}/../../corpus/hwpxlib_corpus/reader_writer/SimpleTable.hwpx",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read(&p).unwrap_or_else(|e| panic!("read {p}: {e}"))
}

fn open(bytes: &[u8]) -> Session {
    let mut s = Session::default();
    open_bytes(&mut s, bytes, "t.hwpx").expect("open");
    s
}

fn table_index(s: &Session) -> usize {
    s.doc.as_ref().unwrap().doc().sections[0]
        .blocks
        .iter()
        .position(|b| matches!(b, Block::Table(_)))
        .expect("a table")
}

fn table(s: &Session) -> Table {
    let i = table_index(s);
    let Block::Table(t) = &s.doc.as_ref().unwrap().doc().sections[0].blocks[i] else {
        unreachable!()
    };
    t.edit_target().clone()
}

fn cell_text(c: &Cell) -> String {
    c.blocks
        .iter()
        .filter_map(|b| match b {
            Block::Paragraph(p) => Some(
                p.runs
                    .iter()
                    .flat_map(|r| &r.content)
                    .filter_map(|i| match i {
                        Inline::Text(t) => Some(t.as_str()),
                        _ => None,
                    })
                    .collect::<String>(),
            ),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// `(rows, cols, [(row, col, row_span, col_span, text)])` of the active cells, sorted.
type Grid = (usize, usize, Vec<(usize, usize, usize, usize, String)>);

fn grid(t: &Table) -> Grid {
    let mut cells: Vec<_> = t
        .cells
        .iter()
        .filter(|c| c.active)
        .map(|c| {
            (
                c.row,
                c.col,
                c.row_span.max(1),
                c.col_span.max(1),
                cell_text(c),
            )
        })
        .collect();
    cells.sort();
    (t.rows, t.cols, cells)
}

/// An exported table: its open tag, every cell's (row, col, rowSpan, colSpan), its whole XML.
type Exported = (String, Vec<(usize, usize, usize, usize)>, String);

fn attr<'a>(s: &'a str, name: &str) -> &'a str {
    let k = format!(" {name}=\"");
    let i = s.find(&k).unwrap_or_else(|| panic!("{name} in {s:.200}")) + k.len();
    &s[i..i + s[i..].find('"').unwrap()]
}

/// The exported section's (only) table: its open tag + every cell's (row, col, rowSpan, colSpan).
fn exported_table(bytes: &[u8]) -> Exported {
    assert!(
        hwp_hwpx::export::validate_open_safety(bytes).ok,
        "open-safe"
    );
    let pkg = Package::open(bytes).unwrap();
    let sec =
        String::from_utf8_lossy(&pkg.read_part("Contents/section0.xml").unwrap()).into_owned();
    let s = sec.find("<hp:tbl ").expect("tbl");
    let e = s + sec[s..].find("</hp:tbl>").unwrap();
    let tbl = sec[s..e].to_string();
    let open = tbl[..tbl.find('>').unwrap()].to_string();
    let mut cells: Vec<_> = tbl
        .match_indices("<hp:cellAddr ")
        .map(|(i, _)| {
            let addr = &tbl[i..i + tbl[i..].find('>').unwrap()];
            let j = i + tbl[i..].find("<hp:cellSpan ").unwrap();
            let span = &tbl[j..j + tbl[j..].find('>').unwrap()];
            (
                attr(addr, "rowAddr").parse().unwrap(),
                attr(addr, "colAddr").parse().unwrap(),
                attr(span, "rowSpan").parse().unwrap(),
                attr(span, "colSpan").parse().unwrap(),
            )
        })
        .collect();
    cells.sort();
    (open, cells, tbl)
}

/// Apply `intent`, export, reopen → (memory grid, reopened grid, exported table).
fn roundtrip(intent: impl Fn(usize) -> Intent) -> (Grid, Grid, Exported, Session) {
    let src = simple_table();
    let mut s = open(&src);
    let i = table_index(&s);
    apply_intent(&mut s, intent(i)).expect("apply");
    let mem = grid(&table(&s));
    let out = export_bytes(&s).expect("export");
    let re = open(&out);
    let back = grid(&table(&re));
    (mem, back, exported_table(&out), s)
}

fn assert_consistent(mem: &Grid, back: &Grid, x: &Exported) {
    assert_eq!(mem, back, "memory grid == reopened grid");
    let (open, cells, tbl) = x;
    assert_eq!(attr(open, "rowCnt"), mem.0.to_string(), "rowCnt");
    assert_eq!(attr(open, "colCnt"), mem.1.to_string(), "colCnt");
    let want: Vec<_> = mem
        .2
        .iter()
        .map(|(r, c, rs, cs, _)| (*r, *c, *rs, *cs))
        .collect();
    assert_eq!(cells, &want, "cellAddr/cellSpan == grid");
    // Rows are emitted in order and every `<hp:tc>` sits in its own row's `<hp:tr>`.
    for (k, tr) in tbl.split("<hp:tr>").skip(1).enumerate() {
        for (i, _) in tr.match_indices("<hp:cellAddr ") {
            let addr = &tr[i..i + tr[i..].find('>').unwrap()];
            let row: usize = attr(addr, "rowAddr").parse().unwrap();
            assert!(row >= k, "cell row {row} in <hp:tr> #{k}");
        }
    }
    // The table's own placement is kept verbatim (not the editor-table defaults).
    assert!(tbl.contains("treatAsChar=\"0\""), "original placement kept");
}

fn delete_rows(at: usize, count: usize) -> impl Fn(usize) -> Intent {
    move |index| Intent::TableDeleteRows {
        section: 0,
        index,
        at,
        count,
        path: None,
    }
}

#[test]
fn simple_table_shape() {
    let t = table(&open(&simple_table()));
    let g = grid(&t);
    assert_eq!((g.0, g.1), (3, 3));
    assert!(g.2.contains(&(0, 0, 2, 2, "1".into())), "{g:?}");
}

#[test]
fn delete_row_inside_merge_shrinks_it() {
    let (mem, back, x, _) = roundtrip(delete_rows(1, 1));
    assert_eq!((mem.0, mem.1), (2, 3));
    assert!(
        mem.2.contains(&(0, 0, 1, 2, "1".into())),
        "merge shrinks to 1 row: {mem:?}"
    );
    assert!(
        !mem.2.iter().any(|c| c.4 == "3"),
        "row 1's own cell is gone: {mem:?}"
    );
    assert_consistent(&mem, &back, &x);
}

#[test]
fn delete_merge_origin_row_moves_content_down() {
    let (mem, back, x, _) = roundtrip(delete_rows(0, 1));
    assert_eq!((mem.0, mem.1), (2, 3));
    assert!(
        mem.2.contains(&(0, 0, 1, 2, "1".into())),
        "origin moves to row 0, content kept: {mem:?}"
    );
    assert!(!mem.2.iter().any(|c| c.4 == "2"), "{mem:?}");
    assert_consistent(&mem, &back, &x);
}

#[test]
fn delete_row_below_merge_and_both_merge_rows() {
    let (mem, back, x, _) = roundtrip(delete_rows(2, 1));
    assert_eq!(mem.0, 2);
    assert!(mem.2.contains(&(0, 0, 2, 2, "1".into())), "{mem:?}");
    assert_consistent(&mem, &back, &x);

    let (mem, back, x, _) = roundtrip(delete_rows(0, 2));
    assert_eq!(mem.0, 1);
    assert!(
        !mem.2.iter().any(|c| c.4 == "1"),
        "merge wholly inside the range goes: {mem:?}"
    );
    assert_consistent(&mem, &back, &x);
}

#[test]
fn delete_rows_refuses_every_row_and_out_of_range() {
    let mut s = open(&simple_table());
    let i = table_index(&s);
    for (at, count) in [(0, 3), (2, 2), (3, 1), (0, 0)] {
        assert!(
            apply_intent(
                &mut s,
                Intent::TableDeleteRows {
                    section: 0,
                    index: i,
                    at,
                    count,
                    path: None
                }
            )
            .is_err(),
            "({at},{count}) refused"
        );
    }
    assert_eq!(table(&s).rows, 3, "nothing changed");
}

#[test]
fn undo_restores_the_grid() {
    let mut s = open(&simple_table());
    let before = grid(&table(&s));
    let i = table_index(&s);
    apply_intent(
        &mut s,
        Intent::TableDeleteRows {
            section: 0,
            index: i,
            at: 1,
            count: 1,
            path: None,
        },
    )
    .unwrap();
    apply_intent(&mut s, Intent::Undo).unwrap();
    assert_eq!(grid(&table(&s)), before);
    let out = export_bytes(&s).unwrap();
    assert_eq!(grid(&table(&open(&out))), before);
}

fn width_sum(t: &Table) -> i64 {
    t.col_widths.iter().map(|&w| i64::from(w)).sum()
}

#[test]
fn insert_cols_keeps_table_width_and_widens_straddling_merge() {
    let total = width_sum(&table(&open(&simple_table())));
    // Column 1 is inside the 2×2 merge → that merge widens; row 2 gets a new empty cell.
    let (mem, back, x, s) = roundtrip(|index| Intent::TableInsertCols {
        section: 0,
        index,
        at: 1,
        count: 1,
        path: None,
    });
    assert_eq!((mem.0, mem.1), (3, 4));
    assert!(
        mem.2.contains(&(0, 0, 2, 3, "1".into())),
        "merge widens: {mem:?}"
    );
    assert!(
        mem.2.contains(&(2, 1, 1, 1, "".into())),
        "new empty cell in row 2: {mem:?}"
    );
    assert_consistent(&mem, &back, &x);
    let t = table(&s);
    assert_eq!(t.col_widths.len(), 4);
    assert_eq!(width_sum(&t), total, "table width kept");
    assert_eq!(attr(&x.0, "colCnt"), "4");
    // Every row's exported cell widths add up to the table width.
    let tbl = &x.2;
    for tr in tbl.split("<hp:tr>").skip(1) {
        let sum: i64 = tr
            .match_indices("<hp:cellSz ")
            .map(|(i, _)| {
                attr(&tr[i..i + tr[i..].find('>').unwrap()], "width")
                    .parse::<i64>()
                    .unwrap()
            })
            .sum();
        assert!(
            (sum - total).abs() <= 2 || sum < total,
            "row width {sum} vs {total}"
        );
    }
    // Appending at the end too.
    let (mem, back, x, _) = roundtrip(|index| Intent::TableInsertCols {
        section: 0,
        index,
        at: 3,
        count: 2,
        path: None,
    });
    assert_eq!(mem.1, 5);
    assert_consistent(&mem, &back, &x);
}

#[test]
fn delete_cols_shrinks_merge_and_keeps_width() {
    let total = width_sum(&table(&open(&simple_table())));
    let (mem, back, x, s) = roundtrip(|index| Intent::TableDeleteCols {
        section: 0,
        index,
        at: 1,
        count: 1,
        path: None,
    });
    assert_eq!((mem.0, mem.1), (3, 2));
    assert!(
        mem.2.contains(&(0, 0, 2, 1, "1".into())),
        "merge shrinks to 1 col: {mem:?}"
    );
    assert_consistent(&mem, &back, &x);
    assert_eq!(width_sum(&table(&s)), total, "table width kept");

    let (mem, back, x, _) = roundtrip(|index| Intent::TableDeleteCols {
        section: 0,
        index,
        at: 2,
        count: 1,
        path: None,
    });
    assert_eq!(mem.1, 2);
    assert!(!mem.2.iter().any(|c| c.4 == "2" || c.4 == "3"), "{mem:?}");
    assert_consistent(&mem, &back, &x);
}
#[test]
fn nested_path_must_reach_a_table() {
    let mut s = open(&simple_table());
    let i = table_index(&s);
    let path = Some(vec![hwp_ops::CellStep {
        block: i,
        row: 0,
        col: 2,
    }]);
    let Err(err) = apply_intent(
        &mut s,
        Intent::TableDeleteRows {
            section: 0,
            index: 0,
            at: 0,
            count: 1,
            path,
        },
    ) else {
        panic!("a cell without a table must be refused");
    };
    assert!(err.contains("not a table"), "{err}");
}

/// A merge whose origin lies strictly INSIDE the deleted range (not at its start) moves to `at`.
#[test]
fn merge_origin_strictly_inside_range_moves_to_at() {
    let mut s = open(&simple_table());
    let i = table_index(&s);
    // Push the 2×2 merge down to rows 1–2, then delete rows 0–1: its origin (row 1) is inside the range.
    apply_intent(
        &mut s,
        Intent::TableInsertRows {
            section: 0,
            index: i,
            at: 0,
            count: 1,
            cols: 3,
        },
    )
    .unwrap();
    apply_intent(
        &mut s,
        Intent::TableDeleteRows {
            section: 0,
            index: i,
            at: 0,
            count: 2,
            path: None,
        },
    )
    .unwrap();
    let mem = grid(&table(&s));
    assert_eq!(mem.0, 2);
    assert!(
        mem.2.contains(&(0, 0, 1, 2, "1".into())),
        "origin row 1 → 0, span 2 → 1: {mem:?}"
    );
    let out = export_bytes(&s).unwrap();
    assert_consistent(&mem, &grid(&table(&open(&out))), &exported_table(&out));
}
