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
    let reopened = parse(&hwpx);
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
    let reopened = parse(&hwpx);

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
