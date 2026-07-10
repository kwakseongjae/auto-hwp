# 052 — R12-P0: 자동저장 + 세션 복구 (wasm 트랩 안전망)

- 상태: open · 우선순위: R12-P0 · 영역: apps/hwp-lab(persistence 신규) + packages/react(WasmAdapter recover 연동) + packages/editor-core(session 이벤트)
- 병렬: 051(챗 브릿지 — ai-protocol/프리뷰 소유). 이 이슈는 챗/프롬프트를 만지지 마라.

## 근거 (2026-07-10 감사)
wasm32에서 `catch_unwind`는 무력 — 패닉은 트랩이고 인스턴스를 중독시킨다
(`crates/hwp-wasm/src/lib.rs:18-22`). JS 로더가 감지→`resetEngine()`→재오픈으로 복구하지만
**미저장 편집이 통째로 소실**된다. 영속성도 0(브라우저 다운로드만). 신뢰불가 업로드를 받는
웹 제품에서 이 조합은 "열심히 편집했는데 다 날아감" 시나리오 — 프로덕션 블로커.

## 목표
편집 세션이 주기적으로 스냅샷되고, 트랩/새로고침/탭 종료 후 재방문 시 **복구 제안 배너**로
직전 상태를 되살릴 수 있다. HWPX 라운드트립이 바이트 안정이므로 스냅샷=toHwpx() bytes.

## 설계
1. **스냅샷 트리거**: `DocSession.applyBatch` 성공 후 디바운스(예: 2s 유휴)로
   `adapter.toHwpx()` → IndexedDB 저장(키=파일명+열기 시각, 값=bytes+rev+타임스탬프).
   먼저 **비용 실측**(benchmark2 25p에서 toHwpx ms) — 예산(<50ms 유휴 시) 초과 시 빈도 조정.
   toHwpx()가 편집 rev/undo를 건드리지 않음(읽기 전용)을 테스트로 잠근다(V3).
2. **복구 경로 2개**:
   - 트랩 직후: `WasmAdapter.recover()`가 재오픈할 때 원본 bytes 대신 **최신 스냅샷 우선** 시도
     (스냅샷 오픈 실패 시 원본 폴백 — 정직한 폴백 사유 토스트).
   - 재방문: LabWorkspace 열기 화면에서 미복구 스냅샷 존재 시 배너("N분 전 편집본 복구") →
     복구/무시(무시=스냅샷 삭제).
3. **상한/청소**(v1 R13): 문서당 스냅샷 1개(최신만), 전체 저장 상한 + TTL(예: 7일), 명시 저장/
   내보내기 성공 시 스냅샷 정리.
4. **테스트**: vitest(디바운스/저장/복구 제안/무시/상한 — IndexedDB mock), e2e 1개(편집→강제
   reload→복구 배너→복구→편집 내용 유지), 트랩 시뮬레이션(recover 경로에 스냅샷 주입) 단위 테스트.

## 수용 기준
- [ ] 편집→유휴→스냅샷 저장(실측 비용 보고 포함), 편집 rev/undo 무오염 테스트
- [ ] reload 후 복구 배너→복구 동작(e2e), 트랩 후 스냅샷 우선 재오픈(단위)
- [ ] 상한/TTL/정리 동작, 051 소유 영역 무접촉, 기존 스위트 그린

## 함정
- toHwpx는 **동기 메인스레드**(FG-14 워커화 전) — 반드시 유휴 디바운스로만 호출, 편집/드래그
  진행 중 호출 금지(렌더-0 규율 파손).
- 스냅샷 복구본은 "편집된 HWPX"다 — .hwp 원본과 파일명/포맷 혼동 금지(배너에 명시).
- IndexedDB는 시크릿 모드/용량 거부 가능 — 실패는 조용히 무시하지 말고 1회 안내 후 기능 비활성.
- 서식 보존: 복구본 재오픈이 own-render 기준 원 편집 상태와 동일한지 golden 비교 테스트 1개.

## 1단계 실측 결과 (2026-07-10 — 설계 확정 근거, Node+wasm pkg 07-05 빌드)

| 픽스처 | toHwpx @open | @편집후 | HWPX 크기 | exportPdf(참고) |
|---|---|---|---|---|
| benchmark (8p) | 4.5ms | 4.1ms | 24KB | 11.8ms |
| benchmark1 (18p) | 16.8ms | 16.7ms | 168KB | 52.1ms |
| benchmark2 (25p) | 16.8ms | 16.6ms | 62KB | 47.9ms |

- 비용은 쪽수가 아니라 **콘텐츠 볼륨** 스케일(18p==25p ~17ms). 예산(<50ms) 대비 2.8× 헤드룸 →
  **설계 1의 디바운스 2s 그대로 확정, 빈도 조정 불필요.**
- **V3 무오염 통과**: toHwpx 전후 placeBuilds/revision 불변(순수 읽기), 편집 1회 후 toHwpx 7회
  호출해도 undo 1회==true·2회==false(스택에 유닛 미삽입), undo/redo 결과 바이트 동일, 동일 상태
  출력 sha 동일(바이트 결정적).
- **스냅샷 포맷 = HWPX 확정**: PDF는 48–52ms(예산 경계)+재오픈 불가+1.5~4× 크기.
- 바인딩 실명: JS `HwpDoc.toHwpx()`(`packages/engine/index.js:258`) → wasm `hwpdoc_toHwpx` →
  Rust `hwp_mcp::export_bytes`.
