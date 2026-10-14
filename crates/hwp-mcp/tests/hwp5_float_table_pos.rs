//! #467 — 기안문(.hwp) → HWPX 무편집 저장이 한컴독스에서 빈 둘째 쪽을 만들던 문제.
//!
//! 원인: 본문 칸의 직인 상자는 **글 앞으로 띄운 1×1 표**다(HWP5 `treat_as_char=false`,
//! `text_wrap=InFrontOfText`, 가로 24802 · 세로 1124 HWPUNIT, 문단·단 기준). 내보내기가 모든 표를
//! `treatAsChar="1"` `TOP_AND_BOTTOM` 오프셋 0 으로 썼기 때문에, 한컴은 직인 상자를 본문 칸 안의 한
//! 줄(≈ 5,175 HWPUNIT)로 배치했다 → 본문 칸이 그만큼 커져 표 뒤의 빈 문단 둘이 둘째 쪽으로 밀렸다.
//! (한컴독스 실측 2026-10-13: 원본 `.hwp` 1쪽 · 이전 HWPX 2쪽 · 칸 안 `pageBreak` 를 꺼도 2쪽.)
//!
//! 공공 서식 바이너리는 저장소에 넣지 않는다(corpus/README.md). 재현:
//! ```sh
//! curl -sL -o /tmp/form-04.hwp 'https://www.law.go.kr/LSW/flDownload.do?flSeq=137303605'
//! AUTO_HWP_FLOAT_REPRO=/tmp/form-04.hwp cargo test -p hwp-mcp --features rhwp --test hwp5_float_table_pos -- --ignored --nocapture
//! ```

use hwp_mcp::{export_bytes, open_bytes, Session};

fn attr<'a>(s: &'a str, name: &str) -> Option<&'a str> {
    let pat = format!(" {name}=\"");
    let i = s.find(&pat)? + pat.len();
    s[i..].find('"').map(|e| &s[i..i + e])
}

#[test]
#[ignore = "needs AUTO_HWP_FLOAT_REPRO=<public .hwp> (see module doc)"]
fn floating_stamp_box_keeps_its_position_in_hwpx() {
    let Ok(path) = std::env::var("AUTO_HWP_FLOAT_REPRO") else {
        eprintln!("AUTO_HWP_FLOAT_REPRO not set — skipped");
        return;
    };
    let bytes = std::fs::read(&path).expect("read repro .hwp");
    let mut s = Session::default();
    open_bytes(&mut s, &bytes, "repro.hwp").expect("open .hwp");
    let out = export_bytes(&s).expect("export hwpx");
    let pkg = hwp_hwpx::package::Package::open(&out).unwrap();
    let sec = String::from_utf8(pkg.read_part("Contents/section0.xml").unwrap()).unwrap();

    // The innermost <hp:tbl> that encloses the 직인 text.
    let at = sec.find("<hp:t>직인").expect("직인 box in section0.xml");
    let tbl_at = sec[..at].rfind("<hp:tbl ").unwrap();
    let head = &sec[tbl_at..tbl_at + sec[tbl_at..].find("<hp:tr").unwrap()];
    let pos = &head[head.find("<hp:pos").unwrap()..];
    eprintln!("{head}");
    assert_eq!(attr(head, "textWrap"), Some("IN_FRONT_OF_TEXT"));
    assert_eq!(attr(pos, "treatAsChar"), Some("0"));
    assert_eq!(attr(pos, "vertRelTo"), Some("PARA"));
    assert_eq!(attr(pos, "horzRelTo"), Some("COLUMN"));
    assert_eq!(attr(pos, "horzOffset"), Some("24802"));
    assert_eq!(attr(pos, "vertOffset"), Some("1124"));

    // The inline tables (outer form, 발신명의) stay inline.
    let outer = &sec[sec.find("<hp:tbl ").unwrap()..];
    assert_eq!(
        attr(&outer[outer.find("<hp:pos").unwrap()..], "treatAsChar"),
        Some("1")
    );
    let at = sec.find("<hp:t>발신명의").expect("발신명의 box");
    let tbl_at = sec[..at].rfind("<hp:tbl ").unwrap();
    let head = &sec[tbl_at..tbl_at + sec[tbl_at..].find("<hp:tr").unwrap()];
    assert_eq!(attr(head, "textWrap"), Some("TOP_AND_BOTTOM"));
    assert_eq!(
        attr(&head[head.find("<hp:pos").unwrap()..], "treatAsChar"),
        Some("1")
    );
}
