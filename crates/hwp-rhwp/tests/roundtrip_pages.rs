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
    let a = tables(&orig);
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
