//! `layout-check --page-starts` 의 저장 쪽 맞대기(`hwp_rhwp::page_start_alignment`).
//!
//! benchmark.hwp 는 한글이 저장한 8쪽이고 쪽을 넘는 표가 없다 — 저장 쪽 나눔 사건이 정확히 7이다.
#![cfg(feature = "rhwp")]

fn benchmark() -> Vec<u8> {
    std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../benchmarks/benchmark.hwp"
    ))
    .expect("benchmark.hwp")
}

#[test]
fn stored_page_breaks_are_counted_and_every_event_is_listed() {
    let a = hwp_rhwp::page_start_alignment(&benchmark()).expect("measure");
    assert_eq!(a.skipped, None);
    assert_eq!(a.stored_breaks, 7, "저장 8쪽 → 쪽 나눔 7");
    assert_eq!(a.our_pages, 8);
    let count = |f: fn(&hwp_rhwp::PageBreakEvent) -> bool| a.events.iter().filter(|e| f(e)).count();
    assert_eq!(count(|e| e.stored), a.stored_breaks);
    assert_eq!(count(|e| e.ours), a.our_breaks);
    assert_eq!(count(|e| e.stored && e.ours), a.matched);
}

/// 표 앵커 문단은 그 표가 시작하는 쪽에 선다 — 저장 배치의 호스트 줄 자리가 표 자리라서다. lift 는
/// `[앵커, 표]` 순서라 표는 앵커 **뒤**에 있다. 이것을 앞에서 찾으면 표가 새 쪽에서 시작하는 곳마다
/// 우리 쪽 나눔이 한 문단 늦게 잡혀 짝이 깨진다(이 문서의 일곱 곳 중 넷).
#[test]
fn a_table_anchor_stands_where_its_table_starts() {
    let a = hwp_rhwp::page_start_alignment(&benchmark()).expect("measure");
    assert_eq!(
        (a.matched, a.max_drift),
        (7, 0),
        "저장 쪽 나눔 일곱이 모두 같은 줄 — {:?}",
        a.events
    );
}
