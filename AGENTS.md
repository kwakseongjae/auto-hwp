# AGENTS.md — tf-hwp 에이전트 온보딩 (모델 중립: Claude/GPT/Codex 공통)

HWP(한글) 자체 엔진: Rust 코어(파싱→IR→조판→렌더→export→편집 op-bus) + React SDK.
아키텍처 = "코어 하나, 셸 셋"(Tauri 앱 / 서비스 컨테이너 / wasm 웹).
북극성(v2): **브라우저에서 업로드 → 바이브(챗)+수동 편집 → PDF export** 프로덕션.

## 세션 연속성 프로토콜
- 시작: `bash scripts/context_restore.sh` 실행(또는 `docs/CURRENT_STATE.md` 읽기) → 막힘/대기부터 처리.
- 체크포인트: 작업 단위 완료·결정 확정마다 CURRENT_STATE.md를 **먼저 갱신하고 나서** 보고한다.
- 종료: `docs/JOURNAL.md` 맨 위에 항목 추가(한 일/열린 것/다음, 5줄 이내, append-only).
  채팅에만 있는 맥락은 잃어버린 것으로 간주한다.
- 컨텍스트가 요약(compact)된 채 재개되면: 첫 행동으로 context_restore.sh를 실행해 복원한다.
  요약문과 파일이 충돌하면 **파일이 정본**이다.

## 로드맵/상태 지도 (정본 위치)
| 무엇 | 어디 |
|---|---|
| 현재 위치·다음 작업 | `docs/CURRENT_STATE.md` (단일 복원 지점) |
| 현행 로드맵 | `docs/PRODUCT-DIRECTION-V2.md` (R12: 이슈 051–056) |
| 공통 계약(불변식 전문) | `docs/PRODUCT-DIRECTION.md` §4 — **이슈 착수 전 필독** |
| 이슈 진행표 | `docs/issues/README.md` (⚠️ 상태 진실은 git log — 복원 스크립트가 대조) |
| 세션 로그 | `docs/JOURNAL.md` (append-only) |
| 역사 문서(참고만) | `docs/history/ROADMAP.md`/`docs/history/PLAN.md`(M-마일스톤 시대), `docs/PRODUCTION-DIAGNOSIS.md`/`PRODUCTION-ROADMAP.md`(2026-06-18 — 대부분 R1~R11에서 해소) |

## 불변식 다이제스트 (위반 = 작업 실패 — 전문은 PRODUCT-DIRECTION.md §4)
1. 게이트: `layout-check` → benchmark **8==8** · benchmark1 **18==18** · 줄바꿈 98.9%+ 유지.
2. LOCKSTEP: `place_doc`(crates/hwp-typeset/src/place.rs)과 `NaiveLayout`(lib.rs)의 페이지 수 항상 일치 — 한쪽만 고치지 마라.
3. rhwp(`external/`)는 vendored 수정 금지 + **파싱 전용** — 렌더는 항상 우리 IR에서.
4. 단위: 지오메트리 커맨드 = **px**(=HWPUNIT/75), ops 커밋 = **HWPUNIT** — 변환은 `packages/editor-core/src/units.ts` 단일 지점.
5. 에디터는 순수 `#000` 렌더, 텍스트 커밋은 `SetTableCellRuns`/`SetParagraphRuns`만(평문 variant는 run 붕괴).
6. 사용자 콘텐츠 삭제 금지 · 커밋/푸시는 명시 요청 시에만.
7. Intent 스키마 v0: additive 확장만 + unknown field 명시적 거부.

## 검증 스위트 — 정본은 `scripts/verify-local.sh` (CI는 수동 전용, 2026-07-11 전환)
```bash
scripts/verify-local.sh          # quick: fmt·clippy·전체 테스트·게이트 v2·wasm·(deny)
scripts/verify-local.sh --full   # + wasm 재빌드·JS 빌드/vitest·e2e — crates/UI 접촉 시 필수
```
푸시 전 quick은 최소, crates·packages 접촉 시 --full. fmt는 이제 강제(2026-07-11 전체 포맷 완료 —
fmt-dirty 커밋은 다음 verify에서 걸린다). GitHub Actions는 `gh workflow run ci`로만 수동 실행.

## 함정 top 6 (전체는 각 이슈 파일의 "함정" 절)
- e2e 전 `rm -rf apps/hwp-lab/.next` — 웹팩 캐시가 dist 재빌드를 감지 못해 가짜 통과/실패.
- **crates(Rust) 변경 후 wasm pkg 재빌드 필수**: `cargo build -p hwp-wasm --release --target
  wasm32-unknown-unknown` → `wasm-bindgen --target web --out-dir packages/engine/pkg …` →
  (있으면) `wasm-opt -Oz` 다이어트(055 — verify-local --full이 자동 수행, 골든 바이트동일 검증됨) →
  `node apps/hwp-lab/scripts/copy-wasm.mjs` → `.next` 삭제. 스테일 wasm은 신규 Intent를
  "unknown variant"로 거부(2026-07-10 R12 배치 A 병합 검증에서 실측 — e2e 3건 가짜 실패).
- px↔HWPUNIT 슬립은 클릭선택/이동/리사이즈를 **조용히** 죽인다 — own-render 지오메트리는 시각 검증까지.
- 이슈 상태는 README 표가 아니라 **git log가 진실**(`scripts/context_restore.sh`가 대조) — 이중 기획 방지.
- macOS 타이틀바/신호등 재작업 금지 — CSS `h-9` 확정 해법(ccb9d5a). config/objc 재시도 금지.
- 이동(MoveImage/MoveBlock)은 **앵커 재배열** — 자유 2D 오프셋을 UI로 흉내내지 마라("거짓 자유도 금지").

## 아키텍처 지도 (5층 요약)
```
React UI(packages/react: HwpWorkspace + 오버레이들)
 → editor-core(headless: selection/edit/session — packages/editor-core)
  → EngineAdapter 27메서드(packages/editor-core/src/adapter.ts)
   → WasmAdapter(웹) | TauriAdapter(데스크톱) — 같은 계약
    → 공유 Rust 코어: hwp-session(지오메트리, px) + hwp-ops(op-bus, HWPUNIT)
      + hwp-typeset(place_doc 조판) + hwp-render(PaintOp→SvgSink) + hwp-export(krilla PDF)
```
편집 흐름: UI 제스처 → Intent → `apply_intent`(hwp-mcp) → Op → 스냅샷 undo(50) →
layoutInvalidated → refreshToken → 페이지 SVG **선택적 재주입**(034) + **가상화**(037).
성능 규율: 드래그/호버/줌 제스처 중 React 리렌더 0회 — vitest 카운터가 잠근다.
