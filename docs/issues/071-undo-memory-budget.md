# 071 — undo 스냅샷 메모리 버짓 (070 실측 후속: 대형 문서 OOM 경로 차단)

- 상태: **done (2026-07-22 구현·검증 완료)** · 우선순위: P1 · 영역: hwp-model(추정기) + hwp-ops(EditSession) + hwp-mcp(라이브 레인)
- 근거: 070 실측 — 130p 문서에서 스냅샷당 ~8MB 딥카피 × LIVE_UNDO_LIMIT 50 = 편집 50회 RSS **+403MB**(브라우저 탭 OOM 경로). 조판(1ms/쪽)이 아니라 이것이 대형 문서의 첫 병목.

## 설계 결정 — 왜 "직렬화 스냅샷"이 아니라 "버짓 트리밍"인가
070이 제안한 HWPX-바이트 스냅샷(0.2MB, ~40배 절감)은 검토 결과 **기각**: EditSession 주석이 명시하듯
스냅샷 딥카피만이 dirty 플래그·shape 풀·`Provenance.raw`·`Passthrough`를 bit-for-bit 복원해
round-trip 불변식을 지킨다. 직렬화→재파싱 복원은 ①.hwp 유래 문서의 from-scratch 직렬화가 손실
(070에서 86p→70p 리플로 실측) ②rhwp 라이브 노드(캐럿 레인) 재구성 불가 ③provenance 소실.
→ **딥카피 유지 + 총량 버짓으로 깊이를 정직하게 축소**가 안전한 P1 해법. (구조 공유/IR-bincode
스냅샷은 XL 후속 옵션으로 남긴다.)

## 구현
1. **`SemanticDoc::approx_heap_bytes()`** (hwp-model/document.rs) — 딥카피 힙 비용 추정기.
   계상 규칙: 모든 `Vec<T>`는 스파인(`len×size_of::<T>()` — by-value 구조체 본문 포함), 원소는
   자기 힙(문자열·raw 버퍼·중첩 vec)만 추가 — **by-value 필드 이중 계상 금지**. ±2× 정확도,
   축출 판단 전용(정확성 무관). 모델 확장 시 새 힙 캐리어를 여기 반영할 것.
2. **`EditSession::with_budget(doc, limit, mem_budget)`** (hwp-ops) — `undo_est: Vec<usize>`
   병렬 캐시(푸시 시 1회 walk — 스택 재-walk 없음) + 단일 푸시 경로 `push_undo`(do_op/do_ops/redo
   공유): 개수 상한(기존) → 바이트 버짓 순으로 **가장 오래된 것부터 축출**, `MIN_UNDO_KEPT=4` 바닥
   보장. `new`/`with_limit`(budget 0)은 071 이전과 바이트 동일 동작(라이브러리 기본 불변).
   redo 스택은 의도적 미계상(≤ undo 깊이·다음 편집에 클리어 — 최악 일시 2×).
3. **`LIVE_UNDO_MEM_BUDGET = 128MiB`** (hwp-mcp 라이브 레인) — 실물 공문서(≤41p, 스냅샷 ~1MB)는
   50 깊이 전부 유지, 대형만 축소.

## 검증 (2026-07-22)
- hwp-ops 신규 5 테스트: 버짓 축출+바닥 4 유지 · 소형 문서 풀 깊이 · budget 0 무회귀 ·
  undo/redo 병렬 캐시 정합 · 추정기 스케일링. workspace 56 스위트 전부 그린.
- **게이트 8==8·18==18** · clippy -D warnings · wasm 재빌드+copy.
- **실측(재벤치)**: 130p 합성 편집 50회 RSS **+403MB → +0.1MB**(정상 상태 축출·재사용).
  편집→화면 136→148ms(추정 walk 포함, 노이즈 범위).
- **깊이 프로브(실 wasm)**: 18p 실물 = 편집 55회 후 undo 깊이 **50(무회귀)** · 130p = **10**
  (128MB/스냅샷 추정 ~13MB — 정직 축소, 바닥 4 이상). vitest 170/320/50 · e2e 42/42.

## 함정
- 추정기는 ±2× — 실제 상주 최악 ~2×까지 가능. 버짓 상향/하향은 hwp-mcp 상수 한 곳.
- 모델에 새 대형 힙 필드(예: 새 바이너리 풀)를 추가하면 **추정기에도 계상**해야 과소추정으로
  버짓이 무력화되지 않는다(estimator 주석에 명시).
- ChatPanel per-card 되돌리기(top-of-stack)·undoDepth 소비자는 영향 없음(소형 문서 무변화).
