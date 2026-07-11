# 055 — R12-P2: 웹 프로덕션 하드닝 (워커화·번들·한도)

- 상태: **구현 완료 — 병합 대기(워크트리 브랜치)** · 우선순위: R12-P2 · 영역: packages/engine(워커 브릿지)/react + apps/hwp-lab
- 선행: 051·052 병합 후(어댑터 호출 표면이 안정된 뒤 워커화가 안전). ✓ 충족 후 착수.

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
- [x] open/render/export/toHwpx가 워커에서 — 메인스레드 블로킹 실측 개선 수치 보고
- [x] 기존 vitest/e2e 무수정 그린(어댑터 계약 유지 증명), 트랩→재스폰→복구 동작
- [x] wasm gzip 실측 + 감량 결과 보고(골든 불변), 한도 UX 배선
- [x] 게이트/골든/wasm-safe 전부 그린

## 구현 결과 (2026-07-11)
- **워커화**: `@tf-hwp/engine`에 모듈 워커 엔트리(`worker.js`) + 수제 RPC 클라이언트
  (`@tf-hwp/engine/worker-client` — 신규 의존 0, 정적 에셋 배포·번들러 마법 X·SAB/COOP-COEP 불요).
  `WasmAdapter(wasmUrl, { worker: { url } })` 옵트인 — hwp-lab 기본 ON, `?engineWorker=off` 롤백
  스위치. 052 정합: 워커 죽음 = `{code:"worker_dead"}` → 트랩과 동일 레인(재스폰+스냅샷 우선 복구).
  probe 워커 분리로 손상 파일 트랩이 본 세션을 오염시키지 않게 됨(+열기 취소 = probe 워커 종료).
- **블로킹 실측** (458p 합성 HWPX·CPU 4× 스로틀·trace 분류, `apps/hwp-lab/scripts/measure-blocking.mjs`):
  JS(엔진+앱) 블로킹 11,478→3,382ms(**−71%**), 최대 단일 태스크 3,982→635ms(**−84%**).
  Layout/Paint(공통 브라우저 비용, 워커화 무관 — 가상화가 상한)는 양 모드 동등. 128p 무스로틀에선
  엔진 몫 자체가 ~150ms 수준(개발기 기준)이라 신호가 작음 — 하네스가 분류/스로틀을 지원한다.
- **번들 다이어트**: wasm 11,697,120→9,096,828B(**raw −22.2%**, `wasm-opt -Oz` binaryen 130) ·
  gzip 3,728,108→3,490,953B(−6.4%) · brotli 2,553,243→2,470,768B(−3.2%). 3픽스처 SVG/HTML/HWPX/
  PDF(폰트 주입 전후) 해시 바이트동일(골든 무회귀). verify-local --full 에 wasm-opt 단계 상시 편입.
  feature 프루닝 기각: `image`=vendored rhwp(.hwp 파싱), krilla=PDF export — 둘 다 핵심 기능.
- **한도 UX**: 업로드 전 64MiB 검사(`apps/hwp-lab/src/lib/limits.ts`, MAX_RAW_FILE 미러) +
  DocLimit/형식 오류 → 사용자 문구 매핑 + 파싱 중 취소 버튼(워커라 실제로 동작).
- **테스트**: 기존 vitest/e2e 무수정 그린(e2e 35→38, react 265→274, hwp-lab 22→36) + 신규:
  워커 RPC 단위(가짜 워커 — 트랩/워커죽음/취소), 실엔진 워커 프로토콜 golden(워커 경유 == 직결,
  034 raw-diff 유효 증명), 한도 매핑 단위, e2e 3종(워커 사용 사실·64MiB 거부·롤백 스위치).
- 부수 수리: 047 셀음영 shield 를 타이머 해제→refreshToken 효과 소비형으로(워커 RPC 매크로태스크
  타이밍에서 결정적 레이스 — e2e가 잡음). Cargo 루트 exclude 에 `.claude` 추가(중첩 워크트리의
  rhwp 사본이 바깥 워크스페이스로 오귀속되던 cargo 함정).

## 함정
- 워커 전환으로 pageSvg 왕복이 늘면 034 선택적 재주입의 raw-diff가 여전히 워커 쪽 캐시를
  타는지 확인(문자열 전송 비용 — 필요 시 변경 페이지 목록을 워커가 계산해 내려보내는 최적화는
  **별도 이슈로**, 여기서 손대지 마라).
- SharedArrayBuffer/COOP-COEP는 쓰지 않는 방향 우선(배포 제약) — 필요해지면 보고 후 결정.
- DEV 카운터/perf 회귀 테스트가 워커 경유에서도 의미를 유지하는지 확인.
