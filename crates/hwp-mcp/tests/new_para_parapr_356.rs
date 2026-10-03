//! #356 — 새 문단(`SplitParagraph` 꼬리 · 이웃 모양을 물려받은 `InsertParagraphAt`)의 HWPX
//! `paraPrIDRef` / `charPrIDRef`.
//!
//! 증상(수정 전): 원본 header 풀에서 온 문단 모양(`hwpx_pool_para_shapes`)은 「편집하지 않은 문단은
//! 원래 여는 태그를 그대로 쓴다」는 전제로 id 사상(`SynthPlan::para_ref`)에 넣지 않았다. 원래 여는
//! 태그가 없는 새 문단은 그래서 구역 XML 의 **마지막** `paraPrIDRef` 로 떨어졌다 — 엔진 화면은
//! 메모리 모양으로 그려 멀쩡하고, 한컴은 파일의 (엉뚱한) 모양으로 그린다.
//! 수정 후: 새 문단은 같은 값을 가진 원래 풀 id 를 쓴다. 원래 여는 태그가 있는 문단은 그대로다.

use hwp_mcp::{apply_intent, export_bytes, open_bytes, Intent, Session};
use hwp_model::prelude::*;

fn fixture(name: &str) -> Vec<u8> {
    let p = format!("{}/../../corpus/hwpx/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&p).unwrap_or_else(|e| panic!("read {p}: {e}"))
}

fn section0_xml(bytes: &[u8]) -> String {
    let pkg = hwp_hwpx::package::Package::open(bytes).unwrap();
    String::from_utf8(pkg.read_part("Contents/section0.xml").unwrap()).unwrap()
}

fn open(src: &[u8]) -> Session {
    let mut s = Session::default();
    open_bytes(&mut s, src, "f.hwpx").expect("open hwpx");
    s
}

fn doc(s: &Session) -> &SemanticDoc {
    s.doc.as_ref().unwrap().doc()
}

fn para(s: &Session, block: usize) -> &Paragraph {
    match &doc(s).sections[0].blocks[block] {
        Block::Paragraph(p) => p,
        _ => panic!("block {block} is not a paragraph"),
    }
}

fn para_text(p: &Paragraph) -> String {
    p.runs
        .iter()
        .flat_map(|r| &r.content)
        .filter_map(|i| match i {
            Inline::Text(t) => Some(t.as_str()),
            _ => None,
        })
        .collect()
}

/// The `<hp:p …>` open tag of the paragraph whose text contains `marker`.
fn open_tag_of(xml: &str, marker: &str) -> String {
    let at = xml
        .find(marker)
        .unwrap_or_else(|| panic!("{marker} not in section XML"));
    let start = xml[..at].rfind("<hp:p ").expect("enclosing <hp:p>");
    let end = start + xml[start..].find('>').unwrap();
    xml[start..=end].to_string()
}

fn attr(tag: &str, name: &str) -> String {
    let key = format!(" {name}=\"");
    let i = tag
        .find(&key)
        .unwrap_or_else(|| panic!("{name} missing in {tag}"))
        + key.len();
    tag[i..i + tag[i..].find('"').unwrap()].to_string()
}

/// The `charPrIDRef` of the run that contains `marker`.
fn run_char_ref(xml: &str, marker: &str) -> String {
    let at = xml.find(marker).unwrap();
    let start = xml[..at].rfind("<hp:run ").expect("enclosing <hp:run>");
    let end = start + xml[start..].find('>').unwrap();
    attr(&xml[start..=end], "charPrIDRef")
}

#[test]
fn split_tail_keeps_the_heads_original_para_pr_id() {
    let src = fixture("FormattingShowcase.hwpx");
    let mut s = open(&src);
    let head = para(&s, 1);
    let head_ref = head
        .para_ref
        .clone()
        .expect("head has an original paraPrIDRef");
    let head_text = para_text(head);
    let head_len = head_text.chars().count();
    let section_last = {
        let x = section0_xml(&src);
        let i = x.rfind("paraPrIDRef=\"").unwrap() + "paraPrIDRef=\"".len();
        x[i..i + x[i..].find('"').unwrap()].to_string()
    };
    assert_ne!(
        head_ref, section_last,
        "fixture must distinguish the two refs"
    );

    apply_intent(
        &mut s,
        Intent::SplitParagraph {
            section: 0,
            block: 1,
            at: head_len,
        },
    )
    .unwrap();
    apply_intent(
        &mut s,
        Intent::SetParagraphRuns {
            section: 0,
            block: 2,
            runs: vec![hwp_ops::RunSpec {
                text: "TAILMARK".into(),
                ..Default::default()
            }],
        },
    )
    .unwrap();
    let out = export_bytes(&s).unwrap();
    let xml = section0_xml(&out);
    assert_eq!(
        attr(&open_tag_of(&xml, "TAILMARK"), "paraPrIDRef"),
        head_ref
    );
    // The head (original open tag) is untouched.
    assert_eq!(
        attr(&open_tag_of(&xml, &head_text), "paraPrIDRef"),
        head_ref
    );
}

#[test]
fn split_tail_runs_keep_their_original_char_pr_id() {
    let src = fixture("FormattingShowcase.hwpx");
    let mut s = open(&src);
    let head = para(&s, 1);
    let run_ref = head.runs[0].char_ref.clone().expect("run has charPrIDRef");
    let text = para_text(head);
    // Split in the middle so the tail run is a clone of the head's run (pool-origin char shape).
    let at = text.chars().count() / 2;
    let tail_text: String = text.chars().skip(at).collect();
    apply_intent(
        &mut s,
        Intent::SplitParagraph {
            section: 0,
            block: 1,
            at,
        },
    )
    .unwrap();
    let out = export_bytes(&s).unwrap();
    let xml = section0_xml(&out);
    assert_eq!(run_char_ref(&xml, &tail_text), run_ref);
}

#[test]
fn inherited_insert_uses_the_neighbours_original_para_pr_id() {
    let src = fixture("FormattingShowcase.hwpx");
    let mut s = open(&src);
    let neighbour_ref = para(&s, 1).para_ref.clone().unwrap();
    apply_intent(
        &mut s,
        Intent::InsertParagraphAt {
            section: 0,
            index: Some(2),
            runs: vec![hwp_ops::RunSpec {
                text: "INSERTMARK".into(),
                ..Default::default()
            }],
            para: Default::default(),
        },
    )
    .unwrap();
    let inserted = para(&s, 2);
    assert_eq!(
        inserted.para_shape,
        para(&s, 1).para_shape,
        "unstyled insert inherits the previous paragraph's shape"
    );
    let out = export_bytes(&s).unwrap();
    let xml = section0_xml(&out);
    let got = attr(&open_tag_of(&xml, "INSERTMARK"), "paraPrIDRef");
    // Same VALUE as the neighbour: either its own id or an equal pool entry.
    let pools = &doc(&s).header_pools.para;
    let want = pools.get(&neighbour_ref.parse::<u64>().unwrap()).unwrap();
    assert_eq!(
        pools.get(&got.parse::<u64>().unwrap()),
        Some(want),
        "inserted paragraph paraPrIDRef={got} must resolve to the neighbour's shape (id {neighbour_ref})"
    );
}
