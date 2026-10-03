//! 원본 header 풀의 문단 · 글자 모양 **정체성**(id) 보존 — #356 후속(0.0.9 회귀).
//!
//! 증상(수정 전): HWPX 파서가 `paraPrIDRef` / `charPrIDRef` 를 값(`ParaShape` / `CharShape`)으로
//! 풀어 **값이 같으면 한 인덱스로 합쳤다**. 그런데 그 값은 손실이 있다 — `<hh:heading>`(글머리표 ·
//! 번호 · 개요 수준), `condense`, `snapToGrid`, `<hh:autoSpacing>`, `breakSetting@lineWrap`,
//! 글자 `symMark` · `<hh:shadow>` 같은 것을 읽지 않는다. 그래서 「글머리표 ☐ + 오른쪽 정렬」과
//! 「글머리표 없음 + 오른쪽 정렬」이 같은 인덱스가 되고, #356 이 새로 내보내는 문단(칸 재구성 ·
//! 분리 꼬리)에 인덱스당 **원래 id 하나**를 고르면서 글머리표가 다른 쪽으로 바뀌었다.
//! 수정 후: 풀 모양은 원래 id 마다 따로 인덱스를 받고, 새로 내보내는 문단 · run 은 자기 원래 id 를 쓴다.

use hwp_mcp::{apply_intent, export_bytes, open_bytes, Intent, Session};
use hwp_model::prelude::*;
use std::io::{Cursor, Read, Write};

fn corpus(rel: &str) -> Vec<u8> {
    let p = format!("{}/../../corpus/{rel}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&p).unwrap_or_else(|e| panic!("read {p}: {e}"))
}

fn part(bytes: &[u8], name: &str) -> String {
    let pkg = hwp_hwpx::package::Package::open(bytes).unwrap();
    String::from_utf8(pkg.read_part(name).unwrap()).unwrap()
}

fn open(src: &[u8]) -> Session {
    let mut s = Session::default();
    open_bytes(&mut s, src, "f.hwpx").expect("open hwpx");
    s
}

fn doc(s: &Session) -> &SemanticDoc {
    s.doc.as_ref().unwrap().doc()
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

/// The `<hh:{tag} id="{id}" …>…</hh:{tag}>` element of header.xml.
fn header_elem<'a>(header: &'a str, tag: &str, id: &str) -> &'a str {
    let open = format!("<hh:{tag} id=\"{id}\"");
    let s = header
        .find(&open)
        .unwrap_or_else(|| panic!("{tag} {id} not in header"));
    let close = format!("</hh:{tag}>");
    let e = s + header[s..].find(&close).unwrap() + close.len();
    &header[s..e]
}

/// Top-level block index of the paragraph whose text starts with `marker`.
fn block_of(s: &Session, marker: &str) -> usize {
    doc(s).sections[0]
        .blocks
        .iter()
        .position(|b| matches!(b, Block::Paragraph(p) if para_text(p).starts_with(marker)))
        .unwrap_or_else(|| panic!("no paragraph with {marker}"))
}

// ── 1. 표 칸 재구성(SetTableCell) — 실제 회귀 경로 ─────────────────────────────────────────────

/// FormattingShowcase.hwpx 의 첫 표 칸을 `[16, 950, 950]` 세 문단으로 바꾼 패키지. paraPr 950 은
/// 16 을 복제하고 `<hh:heading type="NONE">` 만 `BULLET` 으로 바꾼 것 — 글머리표 말고는 값이 같다.
/// 16 은 표 앞 본문에서 먼저 나온다(문서 순서상 첫 id). 실제 양식의 「☐ 선택지」 칸과 같은 모양이다.
#[test]
fn cell_rebuild_keeps_each_paragraphs_bullet_para_pr() {
    let src = corpus("hwpx/FormattingShowcase.hwpx");
    let header = part(&src, "Contents/header.xml");
    assert!(header_elem(&header, "paraPr", "16").contains("<hh:heading type=\"NONE\""));
    let header = add_variant(
        &header,
        "paraPr",
        "paraProperties",
        "16",
        "950",
        "<hh:heading type=\"NONE\" idRef=\"0\" level=\"0\"/>",
        "<hh:heading type=\"BULLET\" idRef=\"1\" level=\"0\"/>",
    );
    let sec = part(&src, "Contents/section0.xml");
    let tc = sec.find("<hp:tc").expect("fixture has a table");
    let p0 = tc + sec[tc..].find("<hp:p ").unwrap();
    let p1 = p0 + sec[p0..].find("</hp:p>").unwrap() + "</hp:p>".len();
    let para = &sec[p0..p1];
    assert!(
        para.contains("paraPrIDRef=\"16\""),
        "first cell paragraph uses paraPr 16"
    );
    let bullet = para.replacen("paraPrIDRef=\"16\"", "paraPrIDRef=\"950\"", 1);
    let sec = format!("{}{para}{bullet}{bullet}{}", &sec[..p0], &sec[p1..]);
    let mut s = open(&repack(&src, &header, &sec));

    let refs = |c: &Cell| -> Vec<String> {
        c.blocks
            .iter()
            .filter_map(|b| match b {
                Block::Paragraph(p) => Some(p.para_ref.clone().unwrap_or_default()),
                _ => None,
            })
            .collect()
    };
    let (index, row, col) = doc(&s).sections[0]
        .blocks
        .iter()
        .enumerate()
        .find_map(|(bi, b)| match b {
            Block::Table(t) => t
                .edit_target()
                .cells
                .iter()
                .find(|c| refs(c) == ["16", "950", "950"])
                .map(|c| (bi, c.row, c.col)),
            _ => None,
        })
        .expect("rebuilt cell with paraPr [16, 950, 950]");

    apply_intent(
        &mut s,
        Intent::SetTableCell {
            section: 0,
            index,
            row,
            col,
            text: "CELLHEAD\nCELLBULLETA\nCELLBULLETB".into(),
        },
    )
    .unwrap();
    let xml = part(&export_bytes(&s).unwrap(), "Contents/section0.xml");
    let got: Vec<String> = ["CELLHEAD", "CELLBULLETA", "CELLBULLETB"]
        .iter()
        .map(|m| attr(&open_tag_of(&xml, m), "paraPrIDRef"))
        .collect();
    assert_eq!(
        got,
        ["16", "950", "950"],
        "each rebuilt cell paragraph keeps its own paraPr — the bullet (950) must not collapse to 16"
    );
}

// ── 2. 본문 분리(SplitParagraph) — 글머리표 / 번호 / idRef 차이 ──────────────────────────────

/// hwpxlib `tool/textextractor/ParaHead.hwpx`: paraPr 3(NONE) · 16(BULLET idRef 1) · 17(BULLET idRef 2) ·
/// 23 · 24(NUMBER) 는 heading 말고는 값이 같다(25~28 번호 수준, 18~22 개요 수준도 그렇다).
#[test]
fn split_tail_keeps_its_own_heading_para_pr() {
    let src = corpus("hwpxlib_corpus/tool/textextractor/ParaHead.hwpx");
    let s0 = open(&src);
    // One representative paragraph per heading variant (last non-empty paragraph with that ref).
    let mut picks: Vec<(String, String)> = Vec::new(); // (para_ref, text)
    for b in &doc(&s0).sections[0].blocks {
        if let Block::Paragraph(p) = b {
            let (Some(r), t) = (p.para_ref.clone(), para_text(p)) else {
                continue;
            };
            if ["16", "17", "24", "25", "27", "28", "19", "20", "21"].contains(&r.as_str())
                && t.chars().count() >= 2
            {
                // The LAST paragraph per ref: the first one hosts the section's secPr (not splittable).
                picks.retain(|(pr, _)| *pr != r);
                picks.push((r, t));
            }
        }
    }
    assert_eq!(picks.len(), 9, "fixture paragraphs: {picks:?}");

    // Split at 0: the head keeps its original open tag (now empty); the NEW tail paragraph holds the
    // whole text — so it is found by its exact `<hp:t>` text in the exported XML.
    let mut s = open(&src);
    for (_, text) in &picks {
        let bi = block_of(&s, text);
        apply_intent(
            &mut s,
            Intent::SplitParagraph {
                section: 0,
                block: bi,
                at: 0,
            },
        )
        .unwrap();
    }
    let xml = part(&export_bytes(&s).unwrap(), "Contents/section0.xml");
    let mut wrong = Vec::new();
    for (want, text) in &picks {
        let got = attr(&open_tag_of(&xml, &format!(">{text}<")), "paraPrIDRef");
        if &got != want {
            wrong.push(format!("「{text}」 paraPr {want}: tail got {got}"));
        }
    }
    assert!(
        wrong.is_empty(),
        "split tails lost their heading paraPr:\n{}",
        wrong.join("\n")
    );
}

// ── 3. 합성 최소 HWPX — heading 밖의 「모델에 없는」 속성 ────────────────────────────────────

/// Rebuild `src` with `header` / `section0` replaced.
fn repack(src: &[u8], header: &str, section: &str) -> Vec<u8> {
    let mut zin = zip::ZipArchive::new(Cursor::new(src)).unwrap();
    let names: Vec<String> = (0..zin.len())
        .map(|i| zin.by_index(i).unwrap().name().to_string())
        .collect();
    let mut out = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (i, name) in names.iter().enumerate() {
        let replace = match name.as_str() {
            "Contents/header.xml" => Some(header),
            "Contents/section0.xml" => Some(section),
            _ => None,
        };
        if let Some(body) = replace {
            out.start_file(
                name,
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Deflated),
            )
            .unwrap();
            out.write_all(body.as_bytes()).unwrap();
        } else {
            let raw = zin.by_index_raw(i).unwrap();
            out.raw_copy_file(raw).unwrap();
        }
    }
    let mut v = out.finish().unwrap().into_inner();
    // sanity: the result still opens as a zip
    let mut probe = String::new();
    zip::ZipArchive::new(Cursor::new(&mut v))
        .unwrap()
        .by_name("Contents/header.xml")
        .unwrap()
        .read_to_string(&mut probe)
        .unwrap();
    v
}

/// Clone `<hh:{tag} id="{base}">` as `id="{new_id}"` with ONE textual substitution, append it to
/// the `{container}` pool (bumping `itemCnt`).
fn add_variant(
    header: &str,
    tag: &str,
    container: &str,
    base: &str,
    new_id: &str,
    from: &str,
    to: &str,
) -> String {
    let elem = header_elem(header, tag, base);
    assert!(elem.contains(from), "{tag} {base} lacks `{from}`");
    let variant = elem
        .replacen(&format!("id=\"{base}\""), &format!("id=\"{new_id}\""), 1)
        .replacen(from, to, 1);
    let close = format!("</hh:{container}>");
    let at = header.find(&close).unwrap();
    let mut out = format!("{}{}{}", &header[..at], variant, &header[at..]);
    let open = format!("<hh:{container} itemCnt=\"");
    let s = out.find(&open).unwrap() + open.len();
    let e = s + out[s..].find('"').unwrap();
    let n: u64 = out[s..e].parse().unwrap();
    out.replace_range(s..e, &(n + 1).to_string());
    out
}

/// paraPr variants of ParaHead's paraPr 3 that differ ONLY in an attribute the IR does not model,
/// and charPr variants of charPr 0 likewise. Each gets its own paragraph; splitting each paragraph
/// mid-run makes a NEW paragraph + NEW run that must keep the variant's own ids.
#[test]
fn split_tail_keeps_ids_that_differ_only_in_unmodeled_attributes() {
    let src = corpus("hwpxlib_corpus/tool/textextractor/ParaHead.hwpx");
    let mut header = part(&src, "Contents/header.xml");
    let para_variants: [(&str, &str, &str); 6] = [
        ("901", "condense=\"0\"", "condense=\"20\""),
        ("902", "snapToGrid=\"1\"", "snapToGrid=\"0\""),
        ("903", "vertical=\"BASELINE\"", "vertical=\"TOP\""),
        ("904", "lineWrap=\"BREAK\"", "lineWrap=\"SQUEEZE\""),
        ("905", "eAsianEng=\"0\"", "eAsianEng=\"1\""),
        ("906", "keepWithNext=\"0\"", "keepWithNext=\"1\""),
    ];
    for (id, from, to) in para_variants {
        header = add_variant(&header, "paraPr", "paraProperties", "3", id, from, to);
    }
    let char_variants: [(&str, &str, &str); 2] = [
        ("801", "symMark=\"NONE\"", "symMark=\"DOT_ABOVE\""),
        ("802", "useKerning=\"0\"", "useKerning=\"1\""),
    ];
    for (id, from, to) in char_variants {
        header = add_variant(&header, "charPr", "charProperties", "0", id, from, to);
    }
    // Paragraphs: the base (3 / charPr 0) first, so a doc-order "first id wins" pick lands on the base.
    let mut extra = String::from(
        "<hp:p id=\"3000000000\" paraPrIDRef=\"3\" styleIDRef=\"0\" pageBreak=\"0\" columnBreak=\"0\" merged=\"0\"><hp:run charPrIDRef=\"0\"><hp:t>BASEHEADBASETAIL</hp:t></hp:run></hp:p>",
    );
    for (k, (pid, _, _)) in para_variants.iter().enumerate() {
        extra.push_str(&format!(
            "<hp:p id=\"30000001{k}\" paraPrIDRef=\"{pid}\" styleIDRef=\"0\" pageBreak=\"0\" columnBreak=\"0\" merged=\"0\"><hp:run charPrIDRef=\"0\"><hp:t>PHEAD{k}PTAIL{k}Q</hp:t></hp:run></hp:p>"
        ));
    }
    for (k, (cid, _, _)) in char_variants.iter().enumerate() {
        extra.push_str(&format!(
            "<hp:p id=\"30000002{k}\" paraPrIDRef=\"3\" styleIDRef=\"0\" pageBreak=\"0\" columnBreak=\"0\" merged=\"0\"><hp:run charPrIDRef=\"{cid}\"><hp:t>CHEAD{k}CTAIL{k}Q</hp:t></hp:run></hp:p>"
        ));
    }
    let sec = part(&src, "Contents/section0.xml");
    let at = sec.rfind("</hs:sec>").unwrap();
    let sec = format!("{}{}{}", &sec[..at], extra, &sec[at..]);
    let bytes = repack(&src, &header, &sec);

    let mut s = open(&bytes);
    let split = |s: &mut Session, head: &str| {
        let bi = block_of(s, head);
        apply_intent(
            s,
            Intent::SplitParagraph {
                section: 0,
                block: bi,
                at: head.chars().count(),
            },
        )
        .unwrap();
    };
    split(&mut s, "BASEHEAD");
    for k in 0..para_variants.len() {
        split(&mut s, &format!("PHEAD{k}"));
    }
    for k in 0..char_variants.len() {
        split(&mut s, &format!("CHEAD{k}"));
    }
    let xml = part(&export_bytes(&s).unwrap(), "Contents/section0.xml");
    let mut wrong = Vec::new();
    for (k, (pid, from, to)) in para_variants.iter().enumerate() {
        let got = attr(&open_tag_of(&xml, &format!("PTAIL{k}Q")), "paraPrIDRef");
        if got != *pid {
            wrong.push(format!("paraPr {pid} ({from}→{to}): tail got {got}"));
        }
    }
    for (k, (cid, from, to)) in char_variants.iter().enumerate() {
        let got = run_char_ref(&xml, &format!("CTAIL{k}Q"));
        if got != *cid {
            wrong.push(format!("charPr {cid} ({from}→{to}): tail run got {got}"));
        }
    }
    assert!(
        wrong.is_empty(),
        "ids collapsed onto an equal-valued twin:\n{}",
        wrong.join("\n")
    );
}
