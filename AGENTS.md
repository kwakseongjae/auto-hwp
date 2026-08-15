# AGENTS.md — auto-hwp 에이전트 온보딩 (모델 중립: Claude/GPT/Codex 공통)

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

## 정식 오픈소스 작업 프로토콜
- Grok/다른 에이전트: `.grok/skills/oss-issue-first/SKILL.md` — 구현·문서 변경의 첫 동작은 이슈다.
- 모든 코드·문서 변경은 먼저 공개 GitHub 이슈를 만들거나 기존 이슈를 연결한다.
- `main` 직접 작업·직접 push 금지: 이슈 브랜치 → PR 본문 `Closes #<issue>` → 필수 CI 순서다.
- 필수 checks는 `issue-link`·`build-test`·`licenses`; 대화 해결 전 merge 금지. 배포는 보호된
  `main`의 정확한 commit SHA로만 실행한다.
- **에이전트는 PR에서 멈춘다.** 사용자가 머지/병합/merge 라고 하거나, 변경이 사소한
  경우(오타·주석·JOURNAL만·한 줄 포인터)만 병합한다. 그 외에는 물어본다.
- merge 뒤 작업 브랜치를 삭제한다. 사용자 콘텐츠·민감 문서는 이슈/PR/CI 아티팩트에 올리지 않는다.
- UI·레이아웃·라우팅·클라이언트 상태·업로드 화면을 바꿨으면 브라우저 MCP로 실제 업로드/클릭
  검수를 한다(스크린샷 한 장은 검수가 아니다). 절차: `.grok/skills/browser-qa/SKILL.md`.

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
fmt-dirty 커밋은 다음 verify에서 걸린다). GitHub Actions는 PR마다 자동 실행되며 `gh workflow run ci`로
수동 재검증도 가능하다.

## 함정 top 6 (전체는 각 이슈 파일의 "함정" 절)
- e2e 전 `rm -rf apps/hwp-lab/.next` — 웹팩 캐시가 dist 재빌드를 감지 못해 가짜 통과/실패.
- **crates(Rust) 변경 후 wasm pkg 재빌드 필수**: `cargo build -p hwp-wasm --profile wasm-size --target
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
  → EngineAdapter 34메서드(packages/editor-core/src/adapter.ts)
   → WasmAdapter(웹) | TauriAdapter(데스크톱) — 같은 계약
    → 공유 Rust 코어: hwp-session(지오메트리, px) + hwp-ops(op-bus, HWPUNIT)
      + hwp-typeset(place_doc 조판) + hwp-render(PaintOp→SvgSink) + hwp-export(krilla PDF)
```
편집 흐름: UI 제스처 → Intent → `apply_intent`(hwp-mcp) → Op → 스냅샷 undo(50) →
layoutInvalidated → refreshToken → 페이지 SVG **선택적 재주입**(034) + **가상화**(037).
성능 규율: 드래그/호버/줌 제스처 중 React 리렌더 0회 — vitest 카운터가 잠근다.

## Cursor Cloud specific instructions
클라우드 VM은 업데이트 스크립트(서브모듈 init · `wasm-bindgen-cli` 0.2.125 · 패키지 install)가 이미
돌아간 상태로 부팅한다. 아래는 **빌드/실행 시 걸리는 비자명한 함정**만 적는다(표준 명령은 기존 문서 인용).

- **메인 제품 = 웹앱 `apps/hwp-lab`(Next.js, 브라우저 wasm 엔진).** 기동: `cd apps/hwp-lab && npm run dev`
  → http://localhost:3000. `predev` 훅이 `build:deps`(JS 패키지 dist) + wasm/폰트/샘플 복사를 자동 수행한다.
  키 없이도 **mock 모드**로 업로드→렌더→편집→export 전체 완주(우상단 배지 `mock 모드`). 실 LLM은
  `apps/hwp-lab/.env.local`(gitignore)에 `OPENROUTER_API_KEY`/`ANTHROPIC_API_KEY` — 상세는 `apps/hwp-lab/QA.md`.
- **엔진 wasm은 첫 세션에 한 번 빌드해야 한다**(pkg/는 gitignore): `pnpm -C packages/engine build`
  (cargo + wasm-bindgen 사용, `wasm-size` 프로필). 툴체인은 이미 PATH에 있다(cargo/wasm-bindgen).
- **`wasm-opt`(binaryen)는 미설치 — 의도적.** 번들이 다이어트 안 돼 ~11.5MB(정상은 ~8.7MB)이지만
  **기능은 100% 동일**(다이어트는 게이트 아님). dev/QA엔 무영향 — 크기 최적화가 필요할 때만 `binaryen` 설치.
- **pnpm `file:` 주입(injected) 함정 — 이번 세션 실측:** `@auto-hwp/react`는 `file:../editor-core`·
  `file:../engine`를 **install 시점 스냅샷(하드카피)** 으로 주입한다. 그래서 dist가 없을 때 install하면
  주입본에 dist가 빠져 이후 `pnpm -C packages/react build`가
  `Failed to resolve entry for package "@auto-hwp/editor-core"`로 실패한다. **해법:
  editor-core/ai-protocol/engine dist를 먼저 빌드한 뒤 `pnpm -C packages/react install`을 다시 돌려
  주입본을 갱신**하고 나서 react를 빌드한다(= handover-verify.sh의 빌드 순서).
- **Rust 워크스페이스 검증엔 GTK/WebKit 시스템 라이브러리가 필요**(워크스페이스 멤버 `crates/hwp-viewer`가
  Tauri 데스크톱 셸). VM에 CI와 동일하게 이미 설치돼 있다(`libwebkit2gtk-4.1-dev`·`libgtk-3-dev`·
  `librsvg2-dev`·`libxdo-dev`·`libayatana-appindicator3-dev` 등 — 목록은 `.github/workflows/ci.yml`).
  이게 없으면 `scripts/verify-local.sh`의 `cargo clippy --workspace`가 `gdk-3.0` 못 찾아 실패한다.
- **테스트/린트 정본은 `scripts/verify-local.sh`**(quick = Rust fmt/clippy/test/게이트/wasm 위생/deny).
  JS 단위 테스트는 각 패키지 `pnpm -C packages/<p> exec vitest run` + `apps/hwp-lab`에서 `npx vitest run`.
  e2e(playwright)는 최초 1회 `npx playwright install chromium`(네트워크) 필요.
