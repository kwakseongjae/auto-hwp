# 055 — R12-P2: 웹 프로덕션 하드닝 (워커화·번들·한도)

- 상태: open · 우선순위: R12-P2 · 영역: packages/engine(워커 브릿지)/react + apps/hwp-lab
- 선행: 051·052 병합 후(어댑터 호출 표면이 안정된 뒤 워커화가 안전).

## 근거 (2026-07-10 감사)
- **동기 메인스레드**: `WasmAdapter.ts`의 open/질의/export 전부 동기(FG-14) — 수 MB 실물/악성
  깊은중첩 파싱이 UI 스레드를 멈춤. 052의 toHwpx 스냅샷도 같은 제약 위에 있음.
- **번들**: wasm 11.6MB uncompressed, gzip/brotli 실측 없음(WASM-FEASIBILITY.md의 유일한 잔여 항목).
- **한도 UX**: 엔진엔 limits(MAX_RAW_FILE 64MiB 등, hwp-ingest/limits.rs)가 있으나 웹 업로드
  UX(사전 크기 검사/진행 표시/정직한 거부 사유)가 미배선.

## 목표
실물 크기 문서와 악성 입력에서도 UI가 얼지 않고, 번들 크기를 알고 관리하며, 한도 초과가
정직한 UX로 표면화된다.

## 설계
1. **워커화(FG-14)**: `@tf-hwp/engine`을 Web Worker로 — Comlink류 브릿지 또는 수제 RPC.
   EngineAdapter는 이미 Promise 표면이므로 소비처는 이론상 무변경(V6 — async 전수 확인 먼저).
   트랩 복구(052)와 정합: 워커 죽음=인스턴스 중독의 명시적 신호로 승격(재스폰+스냅샷 복구).
2. **번들 실측+다이어트**: gzip/brotli 실측 보고 → wasm-opt/feature 프루닝(krilla가 heavyweight
   후보) → 목표치 합의 후 감량. 렌더/export 기능 회귀 0(골든 바이트동일).
3. **한도 UX**: 업로드 전 크기 검사(64MiB), 파싱 중 진행/취소, DocLimit 에러의 사용자 문구 매핑.
4. **테스트**: 워커 경유 e2e 전 스펙 통과(기존 스위트가 그대로 그린이어야 — 어댑터 계약 증명),
   대형 픽스처(신규 확보 또는 합성)로 메인스레드 블로킹 측정 BEFORE/AFTER.

## 수용 기준
- [ ] open/render/export/toHwpx가 워커에서 — 메인스레드 블로킹 실측 개선 수치 보고
- [ ] 기존 vitest/e2e 무수정 그린(어댑터 계약 유지 증명), 트랩→재스폰→복구 동작
- [ ] wasm gzip 실측 + 감량 결과 보고(골든 불변), 한도 UX 배선
- [ ] 게이트/골든/wasm-safe 전부 그린

## 함정
- 워커 전환으로 pageSvg 왕복이 늘면 034 선택적 재주입의 raw-diff가 여전히 워커 쪽 캐시를
  타는지 확인(문자열 전송 비용 — 필요 시 변경 페이지 목록을 워커가 계산해 내려보내는 최적화는
  **별도 이슈로**, 여기서 손대지 마라).
- SharedArrayBuffer/COOP-COEP는 쓰지 않는 방향 우선(배포 제약) — 필요해지면 보고 후 결정.
- DEV 카운터/perf 회귀 테스트가 워커 경유에서도 의미를 유지하는지 확인.
