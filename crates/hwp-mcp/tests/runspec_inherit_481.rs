//! #481 — `RunSpec` 에서 생략한 글자 속성은 바꾸는 자리의 글자 모양을 물려받는다(메모리 = 파일).
//!
//! 고치기 전에는 서식을 하나라도 주면 나머지가 기본값(굵게 끔 · 크기 없음 · 글꼴 없음)이 됐다. 그래서
//! 메모리(`blockRuns`)에는 `null` 이, 내보낸 파일에는 헤더 첫 글자 모양의 값(11pt · 그 글꼴)이 들어가
//! 둘이 갈라졌다. 고친 뒤에는 이렇게 동작한다.
//! - 생략한 필드는 그 자리에서 글자가 있는 첫 run 의 값을 받는다(글자 색만 검정).
//! - 파일은 그 run 의 원래 `<hh:charPr>` 를 복제해 다른 속성만 고친다.
//!
//! 공개 코퍼스만 쓴다.
//! - `FormattingShowcase.hwpx`: 블록 1 = 굵게 · 10pt · `#1F4E79` · charPr 7, 블록 3 · 4 = 보통 10pt · charPr 0
//! - `hwpxlib_corpus/error/20230818/test.hwpx`: 표 블록 4 칸 (1,0) = 9pt 맑은 고딕, 블록 6 칸 (5,3) 안의 표
//! - `footnote-01.hwpx`: 계열마다 다른 `fontRef` 를 쓰는 글자 모양

use hwp_mcp::{apply_intent, export_bytes, open_bytes, Intent, Session};
use hwp_model::prelude::*;
use hwp_ops::RunSpec;
use hwp_session::RunDto;
use serde_json::{json, Value};

const SHOWCASE: &str = "hwpx/FormattingShowcase.hwpx";
const TABLES: &str = "hwpxlib_corpus/error/20230818/test.hwpx";
const FOOTNOTE: &str = "hwpx/footnote-01.hwpx";
/// `TABLES` 블록 6 칸 (5,3) 안의 표(블록 4)의 칸 (0,0) — 글 「구분」.
const NESTED_PATH: &str = r#"[{"block":6,"row":5,"col":3},{"block":4,"row":0,"col":0}]"#;

fn corpus(rel: &str) -> Vec<u8> {
    let p = format!("{}/../../corpus/{rel}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&p).unwrap_or_else(|e| panic!("read {p}: {e}"))
}

fn open_src(src: &[u8]) -> Session {
    let mut s = Session::default();
    open_bytes(&mut s, src, "f.hwpx").expect("open hwpx");
    s
}

fn open(rel: &str) -> Session {
    open_src(&corpus(rel))
}

fn reopen(s: &Session) -> Session {
    open_src(&export_bytes(s).expect("export"))
}

fn part(bytes: &[u8], name: &str) -> String {
    let pkg = hwp_hwpx::package::Package::open(bytes).unwrap();
    String::from_utf8(pkg.read_part(name).unwrap()).unwrap()
}

fn specs(json: &str) -> Vec<RunSpec> {
    serde_json::from_str(json).expect("RunSpec[] json")
}

/// Where an edit lands — the three replace targets.
#[derive(Clone, Copy, Debug)]
enum Target {
    Para(usize),
    Cell(usize, usize, usize),
    Nested,
}

fn edit(s: &mut Session, t: Target, runs: Vec<RunSpec>) {
    let intent = match t {
        Target::Para(block) => Intent::SetParagraphRuns {
            section: 0,
            block,
            runs,
        },
        Target::Cell(index, row, col) => Intent::SetTableCellRuns {
            section: 0,
            index,
            row,
            col,
            runs,
            path: None,
        },
        Target::Nested => Intent::SetTableCellRuns {
            section: 0,
            index: 6,
            row: 5,
            col: 3,
            runs,
            path: Some(serde_json::from_str(NESTED_PATH).unwrap()),
        },
    };
    apply_intent(s, intent).expect("edit applies");
}

/// The target's runs as the host reads them (`blockRuns`), as JSON values.
fn read(s: &Session, t: Target) -> Vec<Value> {
    let doc = s.doc.as_ref().unwrap().doc();
    let runs = match t {
        Target::Para(block) => hwp_session::block_runs(doc, 0, block, None, None),
        Target::Cell(index, row, col) => {
            hwp_session::block_runs(doc, 0, index, Some(row), Some(col))
        }
        Target::Nested => hwp_session::block_runs_path(
            doc,
            0,
            &serde_json::from_str::<Vec<_>>(NESTED_PATH).unwrap(),
        ),
    };
    runs.iter()
        .map(|r| serde_json::to_value(r).unwrap())
        .collect()
}

/// The first run that shows text — the base a replacing run inherits from.
fn first_text(runs: &[Value]) -> Value {
    runs.iter()
        .find(|r| r["text"].as_str().is_some_and(|t| !t.trim().is_empty()))
        .cloned()
        .expect("a text run")
}

/// `charPrIDRef` of the `<hp:run>` whose text starts with `marker`.
fn run_char_ref(section: &str, marker: &str) -> String {
    let at = section
        .find(&format!(">{marker}"))
        .expect("marker in section");
    let open = section[..at].rfind("<hp:run ").expect("enclosing run");
    let tag = &section[open..at];
    let v = tag.find("charPrIDRef=\"").expect("charPrIDRef") + "charPrIDRef=\"".len();
    tag[v..v + tag[v..].find('"').unwrap()].to_string()
}

/// The header's `<hh:charPr id="{id}">…</hh:charPr>` element.
fn char_pr(header: &str, id: &str) -> String {
    let at = header
        .find(&format!("<hh:charPr id=\"{id}\""))
        .expect("charPr id");
    let end = at + header[at..].find("</hh:charPr>").unwrap() + "</hh:charPr>".len();
    header[at..end].to_string()
}

fn font_ref(header: &str, id: &str) -> String {
    let c = char_pr(header, id);
    let at = c.find("<hh:fontRef").expect("fontRef");
    c[at..at + c[at..].find("/>").unwrap() + 2].to_string()
}

fn char_item_cnt(header: &str) -> String {
    let at = header.find("<hh:charProperties itemCnt=\"").unwrap() + 28;
    header[at..at + header[at..].find('"').unwrap()].to_string()
}

/// Replace the first `name="…"` value (the open tag's attribute for these charPr attrs).
fn with_attr(s: &str, name: &str, val: &str) -> String {
    let pat = format!("{name}=\"");
    let at = s.find(&pat).expect("attr") + pat.len();
    let end = at + s[at..].find('"').unwrap();
    format!("{}{val}{}", &s[..at], &s[end..])
}

fn run_text(r: &Run) -> String {
    r.content
        .iter()
        .filter_map(|i| match i {
            Inline::Text(t) => Some(t.as_str()),
            _ => None,
        })
        .collect()
}

/// Issue repro 1 — 「크기만」 keeps bold and font, in memory and in the reopened file.
#[test]
fn size_only_keeps_bold_and_font_and_memory_equals_the_file() {
    let mut s = open(SHOWCASE);
    edit(
        &mut s,
        Target::Para(1),
        specs(r#"[{"text":"size only","size_pt":12}]"#),
    );
    let mem = read(&s, Target::Para(1));
    assert_eq!(
        mem,
        read(&reopen(&s), Target::Para(1)),
        "memory = reopened file"
    );
    let r = &mem[0];
    assert_eq!(r["bold"], true, "bold kept");
    assert_eq!(r["size_pt"], 12.0);
    assert_eq!(r["font"], "함초롬바탕");
    assert_eq!(
        r["color"], "#000000",
        "an unnamed color is black — not the base's #1F4E79"
    );
}

/// Issue repro 2 — 「굵게만」 in a cell keeps 9pt (the file used to say 11pt) and the font.
#[test]
fn bold_only_keeps_size_and_font_in_a_cell() {
    let mut s = open(TABLES);
    let t = Target::Cell(4, 1, 0);
    edit(&mut s, t, specs(r#"[{"text":"bold only","bold":true}]"#));
    let mem = read(&s, t);
    assert_eq!(mem, read(&reopen(&s), t), "memory = reopened file");
    assert_eq!(mem[0]["bold"], true);
    assert_eq!(mem[0]["size_pt"], 9.0, "9pt kept");
    assert_eq!(mem[0]["font"], "맑은 고딕");
}

/// A NAMED `false` turns the flag off (omitted would have kept the base's bold).
#[test]
fn an_explicit_false_turns_bold_off() {
    let mut s = open(SHOWCASE);
    edit(
        &mut s,
        Target::Para(1),
        specs(r#"[{"text":"plain now","bold":false}]"#),
    );
    let mem = read(&s, Target::Para(1));
    assert_eq!(
        mem,
        read(&reopen(&s), Target::Para(1)),
        "memory = reopened file"
    );
    assert_eq!(mem[0]["bold"], false);
    assert_eq!(mem[0]["size_pt"], 10.0, "size still inherited");
    assert_eq!(mem[0]["font"], "함초롬바탕");
}

/// Each field alone, on a paragraph, a cell and a cell of a nested table: the named field takes its
/// value, every other field reads what the base run had (color: black), and memory = the file.
#[test]
fn each_field_alone_inherits_the_rest_and_memory_equals_the_file() {
    let cases: [(&str, &str, Value); 9] = [
        ("size_pt", r#""size_pt":14"#, json!(14.0)),
        ("bold", r#""bold":true"#, json!(true)),
        ("italic", r#""italic":true"#, json!(true)),
        ("underline", r#""underline":true"#, json!(true)),
        ("strike", r#""strike":true"#, json!(true)),
        ("color", r##""color":"#C00000""##, json!("#C00000")),
        ("highlight", r##""highlight":"#FFF2CC""##, json!("#FFF2CC")),
        ("font", r#""font":"맑은 고딕""#, json!("맑은 고딕")),
        ("text", r#""text":"x""#, Value::Null),
    ];
    let targets = [
        (SHOWCASE, Target::Para(1)),
        (TABLES, Target::Cell(4, 1, 0)),
        (TABLES, Target::Nested),
    ];
    for (rel, t) in targets {
        let base = first_text(&read(&open(rel), t));
        for (field, member, want) in &cases {
            let mut s = open(rel);
            let spec = if *field == "text" {
                format!("[{{{member}}}]")
            } else {
                format!(r#"[{{"text":"x",{member}}}]"#)
            };
            edit(&mut s, t, specs(&spec));
            let ctx = format!("{rel} {t:?} {field}");
            let mem = read(&s, t);
            assert_eq!(mem, read(&reopen(&s), t), "{ctx}: memory = reopened file");
            let r = &mem[0];
            for k in [
                "bold",
                "italic",
                "underline",
                "strike",
                "size_pt",
                "font",
                "highlight",
            ] {
                let expect = if k == *field {
                    want.clone()
                } else {
                    base[k].clone()
                };
                assert_eq!(r[k], expect, "{ctx}: {k}");
            }
            let color = if *field == "color" {
                want.clone()
            } else {
                json!("#000000")
            };
            assert_eq!(r["color"], color, "{ctx}: color");
        }
    }
}

/// 두 경로 = 한 경로 — a host that re-states the base run's own values (what a host had to do before
/// #481) and a host that leaves them out write the same file, byte for byte, and read the same.
#[test]
fn restating_the_base_values_writes_the_same_bytes_as_leaving_them_out() {
    let cases = [
        (
            SHOWCASE,
            Target::Para(1),
            r#"[{"text":"same","size_pt":12}]"#,
            r##"[{"text":"same","size_pt":12,"bold":true,"italic":false,"underline":false,"strike":false,"font":"함초롬바탕","color":"#000000","highlight":null}]"##,
        ),
        (
            TABLES,
            Target::Cell(4, 1, 0),
            r#"[{"text":"same","bold":true}]"#,
            r##"[{"text":"same","bold":true,"italic":false,"underline":false,"strike":false,"size_pt":9,"font":"맑은 고딕","color":"#000000","highlight":null}]"##,
        ),
    ];
    for (rel, t, omitted, restated) in cases {
        let mut a = open(rel);
        edit(&mut a, t, specs(omitted));
        let mut b = open(rel);
        edit(&mut b, t, specs(restated));
        let (xa, xb) = (export_bytes(&a).unwrap(), export_bytes(&b).unwrap());
        for name in ["Contents/header.xml", "Contents/section0.xml"] {
            assert_eq!(
                part(&xa, name),
                part(&xb, name),
                "{rel}: {name} — omitted = restated"
            );
        }
        assert_eq!(read(&a, t), read(&b, t), "{rel}: memory too");
    }
}

/// An omitted font keeps the base's per-script `fontRef` byte for byte (a named `font` would put
/// every script on that one family).
#[test]
fn an_omitted_font_keeps_the_per_script_font_refs() {
    let src = corpus(FOOTNOTE);
    let header0 = part(&src, "Contents/header.xml");
    let mut s = open_src(&src);
    let (block, root_id) = {
        let doc = s.doc.as_ref().unwrap().doc();
        doc.sections[0]
            .blocks
            .iter()
            .enumerate()
            .find_map(|(bi, b)| {
                let Block::Paragraph(p) = b else { return None };
                let r = p.runs.iter().find(|r| !run_text(r).trim().is_empty())?;
                let id = doc.hwpx_pool_char_ids.get(&r.char_shape)?.to_string();
                let fr = font_ref(&header0, &id);
                let vals: Vec<&str> = fr.split('"').skip(1).step_by(2).collect();
                vals.iter().any(|v| *v != vals[0]).then_some((bi, id))
            })
            .expect("a paragraph whose text run points its scripts at different fonts")
    };
    let base_pt = first_text(&read(&s, Target::Para(block)))["size_pt"]
        .as_f64()
        .unwrap();
    let spec = format!(r#"[{{"text":"bigger","size_pt":{}}}]"#, base_pt + 3.0);
    edit(&mut s, Target::Para(block), specs(&spec));
    let out = export_bytes(&s).unwrap();
    let id = run_char_ref(&part(&out, "Contents/section0.xml"), "bigger");
    assert_ne!(id, root_id, "the size changed → a charPr of its own");
    assert_eq!(
        font_ref(&part(&out, "Contents/header.xml"), &id),
        font_ref(&header0, &root_id),
        "fontRef byte for byte"
    );
}

/// The file side of 메모리 = 파일: the derived charPr is the base's own element with ONLY the changed
/// attributes rewritten — here `height` and `textColor` (the base is #1F4E79; an unnamed color is
/// black). fontRef · ratio · spacing · relSz · offset · underline · shadow … are the original bytes.
#[test]
fn the_derived_charpr_is_the_base_element_with_only_the_changed_attributes() {
    let src = corpus(SHOWCASE);
    let header0 = part(&src, "Contents/header.xml");
    let mut s = open_src(&src);
    edit(
        &mut s,
        Target::Para(1),
        specs(r#"[{"text":"size only","size_pt":12}]"#),
    );
    let out = export_bytes(&s).unwrap();
    let id = run_char_ref(&part(&out, "Contents/section0.xml"), "size only");
    let base = char_pr(&header0, "7");
    let expected = with_attr(
        &with_attr(&with_attr(&base, "id", &id), "height", "1200"),
        "textColor",
        "#000000",
    );
    assert_ne!(
        base, expected,
        "precondition: the base differs in size and color"
    );
    assert_eq!(char_pr(&part(&out, "Contents/header.xml"), &id), expected);
}

/// The file side is a CLONE of the base's own charPr, not a re-synthesis from the header's first charPr:
/// `form-01.hwpx` block 10's text run uses a charPr whose `borderFillIDRef` differs from charPr 0's — an
/// attribute the model does not read, so only cloning keeps it.
#[test]
fn a_derived_charpr_keeps_what_the_headers_first_charpr_does_not_have() {
    let src = corpus("hwpx/form-01.hwpx");
    let header0 = part(&src, "Contents/header.xml");
    let mut s = open_src(&src);
    let t = Target::Para(10);
    let base_id = {
        let doc = s.doc.as_ref().unwrap().doc();
        let Block::Paragraph(p) = &doc.sections[0].blocks[10] else {
            panic!("block 10 is a paragraph")
        };
        let r = p
            .runs
            .iter()
            .find(|r| !run_text(r).trim().is_empty())
            .expect("a text run");
        doc.hwpx_pool_char_ids[&r.char_shape].to_string()
    };
    let base = char_pr(&header0, &base_id);
    let first = header0[header0.find("<hh:charPr ").unwrap()..].to_string();
    let bf = |e: &str| {
        e[e.find("borderFillIDRef=\"").unwrap()..]
            .split('"')
            .nth(1)
            .unwrap()
            .to_string()
    };
    assert_ne!(
        bf(&base),
        bf(&first),
        "precondition: the base differs from charPr 0 in borderFillIDRef"
    );
    let pt = first_text(&read(&s, t))["size_pt"].as_f64().unwrap() + 2.0;
    edit(
        &mut s,
        t,
        specs(&format!(r#"[{{"text":"derived","size_pt":{pt}}}]"#)),
    );
    let out = export_bytes(&s).unwrap();
    let id = run_char_ref(&part(&out, "Contents/section0.xml"), "derived");
    let height = ((pt * 100.0).round() as i64).to_string();
    let expected = with_attr(
        &with_attr(&with_attr(&base, "id", &id), "height", &height),
        "textColor",
        "#000000",
    );
    assert_eq!(char_pr(&part(&out, "Contents/header.xml"), &id), expected);
}

/// A run whose derived shape equals its base writes the base's ORIGINAL id — no new charPr.
#[test]
fn a_run_that_changes_nothing_keeps_the_original_charpr_id() {
    let src = corpus(SHOWCASE);
    let header0 = part(&src, "Contents/header.xml");
    let mut s = open_src(&src);
    edit(
        &mut s,
        Target::Para(1),
        specs(r##"[{"text":"same look","color":"#1F4E79"}]"##),
    );
    let out = export_bytes(&s).unwrap();
    assert_eq!(
        run_char_ref(&part(&out, "Contents/section0.xml"), "same look"),
        "7"
    );
    assert_eq!(
        char_item_cnt(&part(&out, "Contents/header.xml")),
        char_item_cnt(&header0)
    );
}

/// Two runs that derive the same shape from the same base share ONE new charPr.
#[test]
fn two_runs_deriving_the_same_shape_share_one_charpr() {
    let src = corpus(SHOWCASE);
    let header0 = part(&src, "Contents/header.xml");
    let mut s = open_src(&src);
    edit(
        &mut s,
        Target::Para(3),
        specs(r#"[{"text":"first","size_pt":12}]"#),
    );
    edit(
        &mut s,
        Target::Para(4),
        specs(r#"[{"text":"second","size_pt":12}]"#),
    );
    let out = export_bytes(&s).unwrap();
    let section = part(&out, "Contents/section0.xml");
    assert_eq!(
        run_char_ref(&section, "first"),
        run_char_ref(&section, "second")
    );
    let cnt = |h: &str| char_item_cnt(h).parse::<usize>().unwrap();
    assert_eq!(cnt(&part(&out, "Contents/header.xml")), cnt(&header0) + 1);
}

/// `highlight` omitted = inherited (here from an earlier edit's run — a derivation of a derivation),
/// `highlight: null` = cleared.
#[test]
fn highlight_is_inherited_when_omitted_and_cleared_by_null() {
    let mut s = open(SHOWCASE);
    let t = Target::Para(3);
    edit(
        &mut s,
        t,
        specs(r##"[{"text":"marked","highlight":"#FFF2CC"}]"##),
    );
    edit(&mut s, t, specs(r#"[{"text":"still marked","bold":true}]"#));
    let mem = read(&s, t);
    assert_eq!(mem, read(&reopen(&s), t), "memory = reopened file");
    assert_eq!(mem[0]["highlight"], "#FFF2CC", "inherited");
    assert_eq!(mem[0]["bold"], true);
    edit(&mut s, t, specs(r#"[{"text":"cleared","highlight":null}]"#));
    let mem = read(&s, t);
    assert_eq!(mem, read(&reopen(&s), t), "memory = reopened file");
    assert!(mem[0]["highlight"].is_null(), "null clears");
    assert_eq!(mem[0]["bold"], true, "the rest still inherited");
}

/// The base is the first run that shows TEXT — not a leading blank run. Block 1 is bold; after an edit
/// that leaves a NON-bold blank run in front of a bold one, a "크기만" edit still inherits the bold.
#[test]
fn the_base_is_the_first_run_that_shows_text_not_a_leading_blank() {
    let mut s = open(SHOWCASE);
    let t = Target::Para(1);
    edit(
        &mut s,
        t,
        specs(r#"[{"text":"  ","bold":false},{"text":"본문"}]"#),
    );
    let mem = read(&s, t);
    assert_eq!(
        (mem[0]["bold"].clone(), mem[1]["bold"].clone()),
        (json!(false), json!(true))
    );
    edit(&mut s, t, specs(r#"[{"text":"x","size_pt":12}]"#));
    let mem = read(&s, t);
    assert_eq!(mem, read(&reopen(&s), t), "memory = reopened file");
    assert_eq!(
        mem[0]["bold"], true,
        "inherited from the first TEXT run, not the blank one"
    );
}

/// A run that names nothing keeps the base look (color: black) — and now reads the same from memory
/// as from the file.
#[test]
fn a_run_that_names_nothing_keeps_the_base_look() {
    let mut s = open(SHOWCASE);
    let base = first_text(&read(&s, Target::Para(1)));
    edit(&mut s, Target::Para(1), specs(r#"[{"text":"plain"}]"#));
    let mem = read(&s, Target::Para(1));
    assert_eq!(
        mem,
        read(&reopen(&s), Target::Para(1)),
        "memory = reopened file"
    );
    for k in [
        "bold",
        "italic",
        "underline",
        "strike",
        "size_pt",
        "font",
        "highlight",
    ] {
        assert_eq!(mem[0][k], base[k], "{k}");
    }
    assert_eq!(mem[0]["color"], "#000000");
}

/// 바꾸는 자리가 빈 문단이면 지금처럼 이웃 문단 상속(INTENT-SCHEMA §6.9): an empty paragraph whose own run
/// has no size takes the neighbour's size/font under the named bold.
#[test]
fn an_empty_paragraph_inherits_the_neighbour() {
    let mut s = open(SHOWCASE);
    apply_intent(
        &mut s,
        Intent::InsertParagraphAt {
            section: 0,
            index: Some(4),
            runs: specs(r#"[{"text":"","bold":true}]"#),
            para: Default::default(),
        },
    )
    .expect("insert");
    {
        let doc = s.doc.as_ref().unwrap().doc();
        let Block::Paragraph(p) = &doc.sections[0].blocks[4] else {
            panic!("inserted paragraph")
        };
        assert_eq!(
            doc.char_shapes[p.runs[0].char_shape].height, 0,
            "precondition: no size of its own"
        );
    }
    edit(
        &mut s,
        Target::Para(4),
        specs(r#"[{"text":"filled","bold":true}]"#),
    );
    let mem = read(&s, Target::Para(4));
    assert_eq!(
        mem,
        read(&reopen(&s), Target::Para(4)),
        "memory = reopened file"
    );
    assert_eq!(mem[0]["bold"], true);
    assert_eq!(mem[0]["size_pt"], 10.0, "the neighbour's size");
    assert_eq!(mem[0]["font"], "함초롬바탕");
}

/// One undo puts the export back byte for byte (paragraph and cell).
#[test]
fn one_undo_restores_the_original_bytes() {
    for (rel, t, spec) in [
        (
            SHOWCASE,
            Target::Para(1),
            r#"[{"text":"size only","size_pt":12}]"#,
        ),
        (
            TABLES,
            Target::Cell(4, 1, 0),
            r#"[{"text":"bold only","bold":true}]"#,
        ),
    ] {
        let src = corpus(rel);
        let before = export_bytes(&open_src(&src)).unwrap();
        let mut s = open_src(&src);
        edit(&mut s, t, specs(spec));
        assert!(s.doc.as_mut().unwrap().undo(), "{rel}: undo");
        let after = export_bytes(&s).unwrap();
        for name in ["Contents/header.xml", "Contents/section0.xml"] {
            assert_eq!(part(&before, name), part(&after, name), "{rel}: {name}");
        }
    }
}

/// The wire: omitted and `null` mean the same (not named) — except `highlight`, where `null` clears.
/// A named `false` is kept; serialization keeps the difference.
#[test]
fn omitted_and_null_differ_only_for_highlight_on_the_wire() {
    let r: RunSpec = serde_json::from_str(r#"{"text":"a"}"#).unwrap();
    assert!(r.bold.is_none() && r.size_pt.is_none() && r.font.is_none() && r.highlight.is_none());
    let r: RunSpec = serde_json::from_str(
        r#"{"text":"a","bold":null,"size_pt":null,"font":null,"color":null,"highlight":null}"#,
    )
    .unwrap();
    assert!(r.bold.is_none() && r.size_pt.is_none() && r.font.is_none() && r.color.is_none());
    assert_eq!(r.highlight, Some(None));
    assert_eq!(
        serde_json::to_string(&r).unwrap(),
        r#"{"text":"a","highlight":null}"#
    );
    let r: RunSpec = serde_json::from_str(r#"{"text":"a","bold":false}"#).unwrap();
    assert_eq!(r.bold, Some(false));
    assert_eq!(
        serde_json::to_string(&r).unwrap(),
        r#"{"text":"a","bold":false}"#
    );
}

/// The session editor's run (`RunDto`) is a FULL state, so it names its flags and highlight.
#[test]
fn an_editor_run_dto_names_its_flags() {
    let r = RunDto {
        text: "t".into(),
        ..Default::default()
    }
    .to_run_spec();
    assert_eq!(r.bold, Some(false));
    assert_eq!(r.italic, Some(false));
    assert_eq!(r.highlight, Some(None));
    assert!(r.size_pt.is_none() && r.font.is_none() && r.color.is_none());
}
