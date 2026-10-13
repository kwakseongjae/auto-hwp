//! HWP5 → HWPX 문단 여백 배율 재현 (이슈: HWP5 문단 여백이 HWPX `hp:case` 에 2배로 기록됨).
//!
//! 증상: `.hwp` 를 HWPX 로 저장하면 문단 여백(왼쪽·오른쪽·들여쓰기·위·아래)이 `hp:case`(2016 HwpUnitChar)
//! 에 HWP5 원값 그대로 들어간다. 한컴독스(웹 한글)는 `hp:case` 값을 HWPUNIT 로 읽으므로 여백이 2배가 된다.
//! 실측(행정심판법 시행규칙 별지 제25호서식, 공공 서식 — 저작권법 제7조):
//!   - HWP5 `DocInfo` ParaShape #45 left = 58814 (날짜 줄 `년     월     일`, 오른쪽 정렬)
//!   - 원본 `.hwp` 를 한컴독스에서 열면 눈금자의 왼쪽 여백 ≈ 10.4 cm (≈ 29400 HWPUNIT = 58814 / 2)
//!   - 우리 HWPX 는 `hp:case left=58814`(≈ 207 mm, 칸보다 넓음) → 한컴독스에서 날짜가 한 글자씩 세로로 꺾임
//!   - 같은 HWPX 의 모든 문단 여백을 2로 나누면 한컴독스 화면이 원본 `.hwp` 와 같아짐(쪽수 1, 줄바꿈 같음)
//!
//! 공공 서식 바이너리는 저장소에 넣지 않는다(corpus/README.md). 재현:
//! ```sh
//! curl -sL -o /tmp/form-25.hwp 'https://www.law.go.kr/LSW/flDownload.do?flSeq=164952517'
//! AUTO_HWP_MARGIN_REPRO=/tmp/form-25.hwp cargo test -p hwp-mcp --features rhwp --test hwp5_para_margin_scale -- --ignored --nocapture
//! ```
//! 고침(#466): lift 가 HWP5 원값을 반으로 줄여 IR 을 HWPUNIT 로 맞춘다. 날짜 줄은 IR 29407 ·
//! `hp:case` 29407 · `hp:default` 58814(= HWP5 원값)가 된다. 원값 대조는 `hp:default` 로 한다 —
//! 한컴 관례상 default 는 HWP5 이진과 같은 2배 값이다.

use hwp_mcp::{export_bytes, open_bytes, Session};
use hwp_model::prelude::*;

fn texts(blocks: &[Block], out: &mut Vec<(String, usize)>) {
    for b in blocks {
        match b {
            Block::Paragraph(p) => {
                let t: String = p
                    .runs
                    .iter()
                    .flat_map(|r| &r.content)
                    .filter_map(|i| match i {
                        Inline::Text(t) => Some(t.as_str()),
                        _ => None,
                    })
                    .collect();
                out.push((t, p.para_shape));
            }
            Block::Table(t) => {
                for c in &t.cells {
                    texts(&c.blocks, out);
                }
            }
        }
    }
}

fn attr<'a>(s: &'a str, name: &str) -> Option<&'a str> {
    let pat = format!("{name}=\"");
    let i = s.find(&pat)? + pat.len();
    s[i..].find('"').map(|e| &s[i..i + e])
}

#[test]
#[ignore = "needs AUTO_HWP_MARGIN_REPRO=<public .hwp> (see module doc)"]
fn hwp5_paragraph_margins_are_halved_in_hwpx_case() {
    let Ok(path) = std::env::var("AUTO_HWP_MARGIN_REPRO") else {
        eprintln!("AUTO_HWP_MARGIN_REPRO not set — skipped");
        return;
    };
    let bytes = std::fs::read(&path).expect("read repro .hwp");
    let mut s = Session::default();
    open_bytes(&mut s, &bytes, "repro.hwp").expect("open .hwp");

    // The paragraph with the largest left margin in the IR (the date line in the sample form).
    let doc = s.doc.as_ref().unwrap().doc();
    let mut all = Vec::new();
    for sec in &doc.sections {
        texts(&sec.blocks, &mut all);
    }
    let (text, shape) = all
        .iter()
        .filter(|(t, _)| !t.trim().is_empty())
        .max_by_key(|(_, sh)| doc.para_shapes[*sh].left_margin)
        .cloned()
        .expect("a paragraph");
    let ir_left = doc.para_shapes[shape].left_margin;
    eprintln!("paragraph {text:?}: IR left = {ir_left}");
    assert!(ir_left > 0, "sample has a paragraph with a left margin");

    // The same paragraph in the exported HWPX → its paraPr → the hp:case left value.
    let out = export_bytes(&s).expect("export hwpx");
    let pkg = hwp_hwpx::package::Package::open(&out).unwrap();
    let sec = String::from_utf8(pkg.read_part("Contents/section0.xml").unwrap()).unwrap();
    let header = String::from_utf8(pkg.read_part("Contents/header.xml").unwrap()).unwrap();
    let at = sec
        .find(text.trim())
        .expect("paragraph text in section0.xml");
    let p_open = sec[..at].rfind("<hp:p ").unwrap();
    let pid = attr(&sec[p_open..], "paraPrIDRef").unwrap();
    let pp_at = header.find(&format!("<hh:paraPr id=\"{pid}\"")).unwrap();
    let pp = &header[pp_at..pp_at + header[pp_at..].find("</hh:paraPr>").unwrap()];
    let case = &pp[pp.find("<hp:case").unwrap()..pp.find("</hp:case>").unwrap()];
    let value = |branch: &str, name: &str| -> i32 {
        attr(
            &branch[branch.find(&format!("<hc:{name}")).unwrap()..],
            "value",
        )
        .unwrap()
        .parse()
        .unwrap()
    };
    let default = &pp[pp.find("<hp:default>").unwrap()..pp.find("</hp:default>").unwrap()];
    let case_left = value(case, "left");
    let default_left = value(default, "left");
    eprintln!("HWPX paraPr {pid}: hp:case left = {case_left}, hp:default left = {default_left}");

    // IR is HWPUNIT, hp:case is the value Hancom lays out with, hp:default the legacy 2× mirror.
    assert_eq!(case_left, ir_left, "hp:case carries the IR (HWPUNIT) value");
    assert_eq!(
        default_left,
        2 * case_left,
        "hp:default mirrors the HWP5 2× value"
    );
    // The paragraph's left margin must fit inside the body width (59528 − 2·5669 on A4 with the
    // form's margins ≈ 48190). The un-halved 58814 did not — that is what wrapped the date line.
    assert!(
        case_left < 48_190,
        "left margin {case_left} is wider than the text column"
    );
    if text.contains('년') && text.contains('월') && text.contains('일') {
        // 행정심판법 별지 제25호서식 date line: HWP5 58814, Hancom column_start 29407.
        assert_eq!(case_left, 29_407);
    }
}

/// `hp:case` margins of the paragraph whose text contains `needle` (first hit) in an HWPX package.
fn case_margins(pkg_bytes: &[u8], needle: &str) -> Option<Vec<(String, i32)>> {
    let pkg = hwp_hwpx::package::Package::open(pkg_bytes).ok()?;
    let sec = String::from_utf8(pkg.read_part("Contents/section0.xml").ok()?).ok()?;
    let header = String::from_utf8(pkg.read_part("Contents/header.xml").ok()?).ok()?;
    let at = sec.find(needle)?;
    let p_open = sec[..at].rfind("<hp:p ")?;
    let pid = attr(&sec[p_open..], "paraPrIDRef")?;
    let pp_at = header.find(&format!("<hh:paraPr id=\"{pid}\""))?;
    let pp = &header[pp_at..pp_at + header[pp_at..].find("</hh:paraPr>")?];
    let case = &pp[pp.find("<hp:case")?..pp.find("</hp:case>")?];
    Some(
        ["intent", "left", "right", "prev", "next"]
            .iter()
            .map(|k| {
                let v = case
                    .find(&format!("<hc:{k} "))
                    .and_then(|i| attr(&case[i..], "value"))
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0);
                (k.to_string(), v)
            })
            .collect(),
    )
}

/// #466 guard for the HWPX side: a Hancom-saved `.hwpx` reopened and re-exported keeps its
/// `hp:case` margins exactly — the lift halving must not double-halve (or double) HWPX input.
#[test]
fn hwpx_round_trip_keeps_case_margins() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../benchmarks/benchmark1.hwpx"
    );
    let src = std::fs::read(path).expect("benchmark1.hwpx");
    let mut s = Session::default();
    open_bytes(&mut s, &src, "benchmark1.hwpx").expect("open .hwpx");
    let out = export_bytes(&s).expect("export hwpx");

    let mut checked = 0;
    // Paragraphs with a hanging indent in the source (hp:case intent −6014 / −7228 / −8234).
    for needle in ["곤충산업이 성장성이", "굼벵이는 간기능", "단백질 57."] {
        let before = case_margins(&src, needle).expect("needle in source");
        let after = case_margins(&out, needle).expect("needle in export");
        assert_eq!(
            before, after,
            "{needle:?}: hp:case margins changed on round trip"
        );
        assert!(
            before.iter().any(|(_, v)| *v != 0),
            "{needle:?}: has a margin"
        );
        checked += 1;
    }
    assert_eq!(checked, 3);
}
