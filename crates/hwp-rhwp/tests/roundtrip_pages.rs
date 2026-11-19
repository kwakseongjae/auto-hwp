//! Issue 054 golden: **무편집 .hwp 왕복 재열기 페이지 수 보존** (벤치마크 3종, Rust 단).
//!
//! 재현하는 증상(052 실측): `.hwp` 오리진은 무편집·동일 폰트 조건에서도 toHwpx 재방출 →
//! 재열기 시 재조판된다(8p→6p). 원인은 lift/serialize 왕복에서 표 서식(행높이·패딩·테두리)이
//! 하드코딩으로 대체되는 것 (F2가 갚는 갭).
//!
//! 파이프라인: .hwp 바이트 → rhwp lift(SemanticDoc) → 우리 페이지 수
//!            → hwp-hwpx serialize(from-scratch HWPX) → 재파싱(rhwp는 HWPX도 파싱) → 페이지 수
//! 두 페이지 수가 같아야 한다. LOCKSTEP 불변식(place_doc == NaiveLayout)도 양쪽에서 확인한다.
#![cfg(feature = "rhwp")]

use hwp_model::prelude::*;

fn fonts() -> impl FontMetricsProvider {
    // layout_fidelity와 동일한 선택: shaper 피처면 실제 rustybuzz 메트릭, 아니면 근사.
    // 왕복 비교는 양쪽에 같은 메트릭을 쓰므로 절대 페이지 수와 무관하게 자기일관적이다.
    #[cfg(feature = "shaper")]
    {
        hwp_typeset::RealFontMetrics::new()
    }
    #[cfg(not(feature = "shaper"))]
    {
        hwp_typeset::ApproxFontMetrics
    }
}

fn parse(bytes: &[u8]) -> SemanticDoc {
    use hwp_model::prelude::DocumentParser;
    hwp_rhwp::RhwpEngine::new()
        .parse(bytes, SourceFormat::Hwp5)
        .expect("rhwp lift")
}

/// 재방출한 HWPX 를 **생산 경로**로 다시 연다 (이슈 247).
///
/// 재열기에 rhwp lift 를 쓰면 안 된다. `.hwp` 의 저장 행높이는 한컴이 그린 **정확값**이고, 우리는 그
/// 사실을 HWPX 로 내보낼 때 `<hp:tbl noAdjust="1">` 로 적는다. 그런데 **rhwp 의 표 모델에는 그 필드가
/// 없어서**(`external/rhwp` 는 vendored — 수정 금지) rhwp 로 읽으면 그 의미가 사라지고 행이 내용만큼
/// 자란다(benchmark1: 18쪽 → 19쪽). 사용자가 실제로 겪는 경로는 우리 HWPX 파서이고, 그쪽은 noAdjust 를
/// 읽으므로 18쪽을 그대로 유지한다. 이 테스트가 잠글 것은 **그 경로**다.
fn reopen_hwpx(bytes: &[u8]) -> SemanticDoc {
    use hwp_model::prelude::DocumentParser;
    hwp_hwpx::HwpxParser::new()
        .parse(bytes, SourceFormat::Hwpx)
        .expect("생산 HWPX 파서")
}

/// (NaiveLayout 페이지 수, place_doc 페이지 수) — 항상 일치해야 한다(LOCKSTEP).
fn page_counts(doc: &SemanticDoc, fonts: &dyn FontMetricsProvider) -> (usize, usize) {
    let naive = hwp_typeset::NaiveLayout
        .layout(doc, fonts)
        .expect("NaiveLayout")
        .pages
        .len();
    let placed = hwp_typeset::place_doc(doc, fonts).pages.len();
    (naive, placed)
}

fn roundtrip_preserves_pages(name: &str) {
    let path = format!("{}/../../benchmarks/{name}", env!("CARGO_MANIFEST_DIR"));
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    let fonts = fonts();

    let orig = parse(&bytes);
    let (n0, p0) = page_counts(&orig, &fonts);
    assert_eq!(
        n0, p0,
        "{name}: 원본 LOCKSTEP (NaiveLayout {n0} != place_doc {p0})"
    );

    let hwpx = hwp_hwpx::serialize::serialize(&orig).expect("serialize to HWPX");
    let reopened = reopen_hwpx(&hwpx);
    // 이슈 247 — 쪽수가 같아도 **이유가 우연이면** 다음 변경에서 풀린다. `.hwp` 의 저장 행높이는
    // 한컴이 그린 정확값이고, 우리는 그 사실을 `<hp:tbl noAdjust="1">` 로 적어 보낸다. 재열기한
    // 문서의 표가 그 사실을 되찾았는지 직접 확인한다 — 잃어버리면 행이 내용만큼 자라 쪽수 보존이
    // 운에 맡겨진다.
    let fixed_tables = |d: &SemanticDoc| -> (usize, usize) {
        let (mut total, mut fixed) = (0usize, 0usize);
        for sec in &d.sections {
            for b in &sec.blocks {
                if let Block::Table(t) = b {
                    total += 1;
                    fixed += usize::from(t.fixed_row_heights);
                }
            }
        }
        (total, fixed)
    };
    let (t0, f0) = fixed_tables(&orig);
    let (t1, f1) = fixed_tables(&reopened);
    assert_eq!(t0, t1, "{name}: 왕복 후 표 개수 보존 ({t0} → {t1})");
    // 이 단언이 0 == 0 으로 헛돌지 않게: `.hwp` lift 의 표는 전부 정확값이어야 한다.
    assert!(
        t0 > 0 && f0 == t0,
        "{name}: .hwp 표 {f0}/{t0} 만 정확값으로 잡혔다"
    );
    assert_eq!(
        f0, f1,
        "{name}: 저장 행높이가 '정확값'이라는 사실이 왕복에서 사라졌다 — 원본 {f0}/{t0} 표 → \
         재열기 {f1}/{t1} (이슈 247: `<hp:tbl noAdjust>` 재방출)"
    );
    let (n1, p1) = page_counts(&reopened, &fonts);
    assert_eq!(
        n1, p1,
        "{name}: 재열기 LOCKSTEP (NaiveLayout {n1} != place_doc {p1})"
    );

    assert_eq!(
        n1, n0,
        "{name}: 무편집 왕복 재열기 페이지 수 변동 {n0}p → {n1}p (lift/serialize 왕복 서식 손실)"
    );
}

#[test]
fn benchmark_roundtrip_preserves_page_count() {
    roundtrip_preserves_pages("benchmark.hwp");
}

#[test]
fn benchmark1_roundtrip_preserves_page_count() {
    roundtrip_preserves_pages("benchmark1.hwp");
}

#[test]
fn benchmark2_roundtrip_preserves_page_count() {
    roundtrip_preserves_pages("benchmark2.hwp");
}

/// 020 stored-floor ↔ F2 실값의 관계를 잠그는 테스트: F2는 020의 `Table::row_heights`(저장 행높이
/// floor)를 **대체하지 않고 보완**한다 — 같은 필드가 단일 소스로 남고, 왕복(serialize→재lift) 후에도
/// 같은 floor 값이 복원되어야 한다(cellSz 실값 재방출 덕분). 이게 무너지면 재열기 페이지 수가 흔들린다.
#[test]
fn roundtrip_preserves_stored_row_height_floors() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../benchmarks/benchmark1.hwp"
    );
    let bytes = std::fs::read(path).expect("read benchmark1.hwp");
    let orig = parse(&bytes);
    let hwpx = hwp_hwpx::serialize::serialize(&orig).expect("serialize to HWPX");
    let reopened = reopen_hwpx(&hwpx);

    let tables = |d: &SemanticDoc| -> Vec<Vec<HwpUnit>> {
        let mut out = Vec::new();
        for s in &d.sections {
            for b in &s.blocks {
                if let Block::Table(t) = b {
                    out.push(t.row_heights.clone());
                }
            }
        }
        out
    };
    // #537 — the conversion writes each row grown where an unedited cell's stored lines need more (the
    // rows the typesetter grows); every other row keeps its stored floor exactly.
    let baked = |d: &SemanticDoc| -> Vec<Vec<HwpUnit>> {
        let mut out = Vec::new();
        for s in &d.sections {
            for b in &s.blocks {
                if let Block::Table(t) = b {
                    let mut rows: Vec<f64> = t.row_heights.iter().map(|&h| f64::from(h)).collect();
                    t.grow_fixed_rows(&mut rows, |i| t.stored_lines_need(i, 280.0));
                    out.push(rows.iter().map(|&h| h.ceil() as HwpUnit).collect());
                }
            }
        }
        out
    };
    let a = baked(&orig);
    let b = tables(&reopened);
    assert_eq!(a.len(), b.len(), "왕복 후 표 개수 보존");
    let mut mismatched = 0usize;
    for (i, (ra, rb)) in a.iter().zip(b.iter()).enumerate() {
        if ra != rb {
            mismatched += 1;
            eprintln!("표 {i}: 행높이 floor 변동\n  원본  {ra:?}\n  재열기 {rb:?}");
        }
    }
    assert_eq!(
        mismatched, 0,
        "{mismatched}개 표의 저장 행높이 floor가 왕복에서 변동"
    );
}

/// #543 PR-2 — `.hwp` → HWPX 변환이 표 캡션을 `<hp:caption>` 으로 쓴다(전에는 빠졌다). 다시 열면(생산 HWPX 파서)
/// 같은 위치 · 간격 · 너비 · 최대 너비 · 글이고, 쪽 수도 같다. 공개 문서 셋: `benchmark.hwp`(위 1) · `benchmark2.hwp`
/// (위 2) · `corpus/hwp/tac-img-02.hwp`(아래 6).
#[test]
fn converted_hwpx_keeps_table_captions() {
    fn captions(d: &SemanticDoc) -> Vec<(TableCaptionPosition, i32, i32, i32, bool, String)> {
        let mut out = Vec::new();
        for sec in &d.sections {
            for b in &sec.blocks {
                let Block::Table(t) = b else { continue };
                let Some(c) = &t.caption else { continue };
                let text: String = c
                    .blocks
                    .iter()
                    .filter_map(|b| match b {
                        Block::Paragraph(p) => Some(p),
                        Block::Table(_) => None,
                    })
                    .flat_map(|p| &p.runs)
                    .flat_map(|r| &r.content)
                    .filter_map(|i| match i {
                        Inline::Text(t) => Some(t.as_str()),
                        _ => None,
                    })
                    .collect();
                out.push((
                    c.position,
                    c.spacing,
                    c.width,
                    c.max_width,
                    c.include_margin,
                    text,
                ));
            }
        }
        out
    }
    let fonts = fonts();
    for (rel, want) in [
        ("benchmarks/benchmark.hwp", 1),
        ("benchmarks/benchmark2.hwp", 2),
        ("corpus/hwp/tac-img-02.hwp", 6),
    ] {
        let path = format!("{}/../../{rel}", env!("CARGO_MANIFEST_DIR"));
        let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
        let orig = parse(&bytes);
        let before = captions(&orig);
        assert_eq!(before.len(), want, "{rel}: 원본 캡션 수");
        let hwpx = hwp_hwpx::serialize::serialize(&orig).expect("serialize to HWPX");
        let pkg = hwp_hwpx::package::Package::open(&hwpx).expect("package");
        let xml_captions: usize = pkg
            .section_part_names()
            .iter()
            .map(|p| {
                let xml = pkg.read_part(p).expect("section part");
                String::from_utf8_lossy(&xml)
                    .matches("<hp:caption ")
                    .count()
            })
            .sum();
        assert_eq!(xml_captions, want, "{rel}: <hp:caption> 수");
        let reopened = reopen_hwpx(&hwpx);
        assert_eq!(captions(&reopened), before, "{rel}: 다시 연 캡션");
        assert_eq!(
            page_counts(&reopened, &fonts),
            page_counts(&orig, &fonts),
            "{rel}: 쪽 수"
        );
    }
}

/// #543 PR-2 — 캡션에서만 쓰는 글자 모양 · 문단 모양 · 그림도 변환 결과에 실린다(모양 · 그림 모으기가 캡션 블록을 돈다).
/// ⚠️ 표본 없음 · 가정: 공개 · 비공개 코퍼스의 캡션은 본문과 같은 모양을 쓰고 그림이 없어, 캡션 전용 모양 · 그림을
/// 시험이 만들어 넣는다. 모으기가 캡션을 건너뛰면 모양은 기본 모양으로 바뀌고(조용히), 그림은 매니페스트에 없는
/// 참조가 되어 변환이 거부된다.
#[test]
fn a_caption_only_shape_and_image_survive_conversion() {
    fn first_caption_para(d: &mut SemanticDoc) -> &mut Paragraph {
        d.sections
            .iter_mut()
            .flat_map(|s| s.blocks.iter_mut())
            .find_map(|b| match b {
                Block::Table(t) => t.caption.as_mut(),
                Block::Paragraph(_) => None,
            })
            .and_then(|c| {
                c.blocks.iter_mut().find_map(|b| match b {
                    Block::Paragraph(p) => Some(p),
                    Block::Table(_) => None,
                })
            })
            .expect("캡션 문단")
    }
    fn strip_images(blocks: &mut [Block], found: &mut Option<Inline>) {
        for b in blocks {
            match b {
                Block::Paragraph(p) => {
                    for r in &mut p.runs {
                        r.content.retain(|i| {
                            if matches!(i, Inline::Image(_)) {
                                found.get_or_insert_with(|| i.clone());
                                false
                            } else {
                                true
                            }
                        });
                    }
                }
                Block::Table(t) => {
                    for c in &mut t.cells {
                        strip_images(&mut c.blocks, found);
                    }
                    if let Some(c) = t.caption.as_mut() {
                        strip_images(&mut c.blocks, found);
                    }
                }
            }
        }
    }
    let path = format!(
        "{}/../../corpus/hwp/tac-img-02.hwp",
        env!("CARGO_MANIFEST_DIR")
    );
    let mut doc = parse(&std::fs::read(&path).expect("read tac-img-02.hwp"));
    // 캡션 전용 모양: 기존 모양을 복제해 본문에 없는 값으로.
    let (cs, ps) = {
        let p = first_caption_para(&mut doc);
        (p.runs[0].char_shape, p.para_shape)
    };
    let mut char_shape = doc.char_shapes[cs].clone();
    char_shape.height = 1_777;
    let mut para_shape = doc.para_shapes[ps].clone();
    para_shape.left_margin = 1_234;
    doc.char_shapes.push(char_shape);
    doc.para_shapes.push(para_shape);
    let (new_cs, new_ps) = (doc.char_shapes.len() - 1, doc.para_shapes.len() - 1);
    // 그림은 캡션에만: 본문 · 칸의 그림을 모두 걷고 첫 그림 하나를 캡션에 넣는다.
    let mut image = None;
    for s in &mut doc.sections {
        strip_images(&mut s.blocks, &mut image);
    }
    let image = image.expect("tac-img-02 에 그림이 있다");
    let p = first_caption_para(&mut doc);
    p.para_shape = new_ps;
    for r in &mut p.runs {
        r.char_shape = new_cs;
    }
    p.runs[0].content.push(image);

    let hwpx = hwp_hwpx::serialize::serialize(&doc).expect("캡션 그림이 매니페스트에 실린다");
    let pkg = hwp_hwpx::package::Package::open(&hwpx).expect("package");
    assert!(
        pkg.part_names.iter().any(|n| n.contains("BinData/")),
        "캡션의 그림 바이트가 실렸다: {:?}",
        pkg.part_names
    );
    let mut reopened = reopen_hwpx(&hwpx);
    let (rcs, rps) = {
        let p = first_caption_para(&mut reopened);
        (p.runs[0].char_shape, p.para_shape)
    };
    assert_eq!(reopened.char_shapes[rcs].height, 1_777, "캡션 글자 모양");
    assert_eq!(
        reopened.para_shapes[rps].left_margin, 1_234,
        "캡션 문단 모양"
    );
}

/// #543 PR-2 리뷰 — 캡션 안 표의 칸에 본문에 없는 테두리 · 음영을 주고 `.hwp` → HWPX 로 변환해도 다시 열면 같다. 테두리
/// 모으기가 캡션 블록을 건너뛰면 그 칸은 알림 없이 검은 실선 · 음영 없음이 된다(리뷰 실측). 코퍼스 캡션에는 표가 없어
/// 시험이 만들어 넣는다.
#[test]
fn a_caption_tables_borders_survive_conversion() {
    fn caption_table(d: &mut SemanticDoc) -> &mut TableCaption {
        d.sections
            .iter_mut()
            .flat_map(|s| s.blocks.iter_mut())
            .find_map(|b| match b {
                Block::Table(t) => t.caption.as_mut(),
                Block::Paragraph(_) => None,
            })
            .expect("캡션")
    }
    fn inner(c: &TableCaption) -> &Cell {
        c.blocks
            .iter()
            .find_map(|b| match b {
                Block::Table(t) => t.cells.first(),
                Block::Paragraph(_) => None,
            })
            .expect("캡션 안 표의 칸")
    }
    let path = format!(
        "{}/../../benchmarks/benchmark.hwp",
        env!("CARGO_MANIFEST_DIR")
    );
    let mut doc = parse(&std::fs::read(&path).expect("read benchmark.hwp"));
    let edge = CellEdge {
        color: Color::from_hex("#FF0000").expect("색"),
        style: LineStyle::Dotted,
        width_px: 1.0,
    };
    let cell = Cell {
        row: 0,
        col: 0,
        row_span: 1,
        col_span: 1,
        active: true,
        blocks: vec![Block::Paragraph(Paragraph {
            runs: vec![Run {
                content: vec![Inline::Text("안쪽".into())],
                ..Default::default()
            }],
            ..Default::default()
        })],
        borders: [Some(edge); 4],
        shade_color: Color::from_hex("#00FF00"),
        ..Default::default()
    };
    caption_table(&mut doc).blocks.push(Block::Table(Table {
        rows: 1,
        cols: 1,
        cells: vec![cell],
        col_widths: vec![5_000],
        row_heights: vec![1_000],
        fixed_row_heights: true,
        ..Default::default()
    }));
    let hwpx = hwp_hwpx::serialize::serialize(&doc).expect("serialize to HWPX");
    let mut reopened = reopen_hwpx(&hwpx);
    let got = inner(caption_table(&mut reopened)).clone();
    let style = |c: &Cell| -> Vec<Option<(LineStyle, Color)>> {
        c.borders
            .iter()
            .map(|e| e.map(|e| (e.style, e.color)))
            .collect()
    };
    let want = inner(caption_table(&mut doc)).clone();
    assert_eq!(style(&got), style(&want), "캡션 안 표 칸의 테두리");
    assert_eq!(got.shade_color, want.shade_color, "캡션 안 표 칸의 음영");
}

/// #537 — `.hwp` → HWPX 변환은 저장 줄이 넘친 고정 행을 키운 높이로 써서(`noAdjust="1"`), 다시 연 문서도 원본과 같은
/// 쪽 수 · 같은 행 높이다. 변환은 저장 줄을 넘기지 않으므로 굽지 않으면 다시 연 문서가 다시 잘린다. 공개 문서 넷 —
/// tac-img-02 는 키우는 행이 가장 많다(63 → 65쪽).
#[test]
fn converted_hwpx_keeps_rows_grown_for_stored_lines() {
    fn rows(d: &SemanticDoc, f: &dyn FontMetricsProvider) -> Vec<Vec<i64>> {
        d.sections
            .iter()
            .flat_map(|s| {
                let (_, _, w, _) = hwp_typeset::body_box(&s.page);
                s.blocks.iter().filter_map(move |b| match b {
                    Block::Table(t) => Some(
                        hwp_typeset::row_term_breakdown(t, w, d, f)
                            .iter()
                            .map(|r| r.reserved.round() as i64)
                            .collect(),
                    ),
                    Block::Paragraph(_) => None,
                })
            })
            .collect()
    }
    let fonts = fonts();
    for rel in [
        "benchmarks/benchmark.hwp",
        "benchmarks/benchmark1.hwp",
        "benchmarks/benchmark2.hwp",
        "corpus/hwp/tac-img-02.hwp",
    ] {
        let path = format!("{}/../../{rel}", env!("CARGO_MANIFEST_DIR"));
        let orig = parse(&std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}")));
        let hwpx = hwp_hwpx::serialize::serialize(&orig).expect("serialize to HWPX");
        let reopened = reopen_hwpx(&hwpx);
        assert_eq!(
            page_counts(&reopened, &fonts),
            page_counts(&orig, &fonts),
            "{rel}: 쪽 수"
        );
        // 키운 행은 다시 연 문서에서도 그대로다(짧아지지 않는다). ⚠️ 자기 칸이 없는 행(병합 칸만 지나는 행)은
        // 다시 열 때 다음 행에 높이를 넘기는 기존 왕복 차이가 있어(benchmark2 의 한 표 60 → +60) 같음 대신
        // 「줄지 않음」을 본다 — #537 과 무관하다(굽기 전에도 같다).
        let (r1, r0) = (rows(&reopened, &fonts), rows(&orig, &fonts));
        assert_eq!(r1.len(), r0.len(), "{rel}: 표 수");
        for (ti, (a, b)) in r1.iter().zip(&r0).enumerate() {
            assert_eq!(a.len(), b.len(), "{rel}: 표 {ti} 행 수");
            for (ri, (h1, h0)) in a.iter().zip(b).enumerate() {
                assert!(
                    h1 + 1 >= *h0,
                    "{rel}: 표 {ti} 행 {ri} — 다시 연 {h1} < 원본 {h0}"
                );
            }
        }
    }
}
