# tf-hwp 제품 방향 v2 — "브라우저 프로덕션" (2026-07-10)

> v1(`docs/PRODUCT-DIRECTION.md`, "코어 하나, 셸 셋")의 후속 총괄 지시서다. v1의 이슈
> 007~016과 라운드 R2~R11이 전부 완료된 시점에서, 다음 목표(웹 프로덕션)까지의 잔여
> 격차를 이슈 051~056으로 쪼갠다. **v1 §4(빌더 공통 계약)는 그대로 유효하며 모든 이슈에
> 적용된다** — 착수 전 반드시 읽어라. 진행 상태의 진실은 git log이고, 사람/에이전트가
> 읽는 포인터는 `docs/CURRENT_STATE.md`다(`bash scripts/context_restore.sh`로 복원+대조).

---

## 1. 북극성 (v2)

**브라우저에서 프로덕션 수준으로**: 사용자가 .hwp/.hwpx를 **업로드** → 원본에 가까운 렌더 →
**바이브 편집(채팅)** + **수동 디테일 편집** → **PDF export(v1 스코프: PDF만)**.
전부 클라이언트 사이드 wasm — AI 호출만 서버 프록시(키 보호).

## 2. 현재 위치 (2026-07-10 실측 — 4-에이전트 전수 감사 결과)

이미 동작(웹 `apps/hwp-lab`에서 증명):
- 업로드/파싱(.hwp rhwp lift 포함, 악성 파일 프로브-오픈 방어), own-render SVG 뷰
- 수동 편집 전체 어휘: 셀/문단 제자리 리치 편집(040), 이미지 이동/리사이즈(049)/삽입(050),
  열/행 리사이즈(031), 서식 리본(048), mm 정밀 열너비(047), 찾기/바꾸기(045), 아웃라인/상태바(046),
  팬/줌(035)/가상화(037)/선택적 재주입(034)/호버·커서(038)/키 내비(036)/컨텍스트 메뉴(039)
- 채팅 바이브 편집: ChatPanel → `/api/hwp-edit`(서버측 키) → Intent[] 화이트리스트 → 프리뷰 → 적용
- PDF/HWPX export: 브라우저 안 wasm(kirlla 서브셋 임베드), undo/redo(스냅샷 50, 배치=1 ⌘Z)

수준 판정: **강한 내부 데모/프라이빗 베타 — GA 아님.** 남은 격차가 아래 이슈들이다.

## 3. 격차 → 이슈 맵 (우선순위순)

| # | 이슈 | 격차 (근거) | 단계 |
|---|------|-------------|------|
| [051](issues/051-chat-structural-edit.md) | 챗 구조 편집 브릿지 | 웹 챗 화이트리스트가 in-place 5종뿐(`packages/ai-protocol/src/prompt.ts` `DEFAULT_ALLOWED_INTENTS`) — 표/이미지/문단 삽입·삭제를 챗으로 못 함. 풍부한 어휘(`crates/hwp-ai/src/edit.rs` EditScript)는 Rust/CLI 전용 | R12-P0 |
| [052](issues/052-autosave-recovery.md) | 자동저장/세션 복구 | wasm 패닉=인스턴스 중독(`crates/hwp-wasm/src/lib.rs:18-22`) → 미저장 편집 소실. 영속성 0(다운로드만) | R12-P0 |
| [053](issues/053-cell-caret.md) | 셀 주소형 캐럿 (042 승계) | 클릭→편집노드 해상률 **바이너리 .hwp 0%**(`docs/CARET-GAP.md`) — "아무 데나 클릭해 타이핑" 불가. 선행: own-render↔rhwp 페이지 발산(25 vs 14) 화해 | R12-P1 |
| [054](issues/054-hwp-lift-f2.md) | .hwp lift 충실도 F2 | `.hwp` 편집 시 행높이/셀패딩/셀테두리 하드코딩·드롭(`docs/HWP-CONVERSION-FIDELITY.md` Tier-1, F1 열너비만 완료) | R12-P1 |
| [055](issues/055-web-hardening.md) | 웹 프로덕션 하드닝 | 엔진 동기 메인스레드(`WasmAdapter.ts` — FG-14), wasm 11.6MB gzip 미측정, 업로드 한도/세션 상한 UX 미배선 | R12-P2 |
| [056](issues/056-distribution-crypto.md) | 배포용 .hwp 복호화 | `crates/hwp-crypto` fail-closed 스텁 — 기관 배포 문서 안 열림 | 조건부(수요 확인 시) |

**착수 순서: 051 ∥ 052** (영역 disjoint: 051=ai-protocol/hwp-mcp Intent/챗 UI, 052=persistence/react 복구 경로)
→ **053 ∥ 054** (둘 다 엔진이지만 disjoint: 053=캐럿/지오메트리, 054=rhwp lift) → **055** → (조건부) **056**.

## 4. v2 리스크 노트 (v1 레드팀 R1~R13 계승 + 신규)

| # | 발견 | 완화 → 이슈 |
|---|------|------------|
| V1 | **챗 어휘 확장 = 프롬프트 인젝션 표면 확대**(v1 R5 계승): 구조 편집 Intent가 늘수록 악성 문서 지시문의 파괴력 증가 | 화이트리스트 유지(자유 tool 호출 금지), 구조 변경은 반드시 프리뷰→적용 게이트, DeleteBlock류는 프리뷰에 삭제 대상 원문 표시 → **051** |
| V2 | **Intent 스키마는 동결 상태**(v1 R11): 확장은 additive만, unknown field는 명시적 거부 유지 | schema_v0 테스트에 신규 variant 추가, `intent_version` 불변 → **051** |
| V3 | **자동저장이 undo/스냅샷 저널을 오염시킬 위험**: 저장용 직렬화가 편집 rev를 건드리면 안 됨 | toHwpx()는 읽기 전용임을 테스트로 잠금, 스냅샷은 어댑터 밖(JS)에서 | → **052** |
| V4 | **캐럿 작업의 오라클 리스크**: 캐럿을 위해 조판을 건드리면 게이트/LOCKSTEP 파손 | 캐럿은 노출(exposure)만 — place_doc 무변경 원칙, 게이트 v2 필수 실행 → **053** |
| V5 | **lift 변경 = 조판 입력 변경**: F2가 행높이 실값을 넣으면 stored-height floor(020)와 상호작용 → 페이지 수 변동 가능 | benchmark 게이트 8==8·18==18을 수용 기준으로, 변동 시 멈추고 보고 → **054** |
| V6 | **워커화는 동기 API 계약 파괴**: EngineAdapter가 동기 가정인 소비처가 있으면 회귀 | 어댑터는 이미 Promise 표면 — 소비처 async 전수 확인 후 워커 브릿지 → **055** |

## 5. 검증 (v1 §4.2 계승 + v2 추가)

```bash
cargo test -p hwp-ops && cargo test -p hwp-typeset && cargo test -p hwp-mcp
cargo run -q -p tf-hwp-cli --features "shaper rhwp" -- layout-check benchmarks/benchmark.hwp   # 8==8
# UI 접촉 시:
pnpm -C packages/editor-core build && pnpm -C packages/react build   # + vitest
# e2e 전: rm -rf apps/hwp-lab/.next  (웹팩 캐시가 dist 재빌드 미감지)
# 엔진(crates) 접촉 시: 게이트 v2(benchmark1 18==18) + wasm-safe(cargo check -p hwp-wasm --target wasm32-unknown-unknown)
```

## 6. 상태 추적 규율 (신규 — 이 라운드부터, roadmap-continuity 킷)

- 모든 세션은 `bash scripts/context_restore.sh`(또는 `docs/CURRENT_STATE.md` 정독)로 시작하고,
  작업 단위 완료/결정/중단마다 CURRENT_STATE.md를 **보고보다 먼저** 갱신한다. 세션 종료 시
  `docs/JOURNAL.md` 맨 위에 5줄 항목 추가(append-only). 전체 프로토콜: `AGENTS.md` §세션 연속성.
- 이슈 상태의 진실은 git log — context_restore.sh가 README 표 대신 git에서 미완료를 도출한다
  (013을 R9에서 이중 기획할 뻔한 사고의 재발 방지).
- 컨텍스트(대화)가 아니라 **디스크가 진실**: compact/세션 교체가 언제 일어나도 작업이
  이어지도록, 결정·중간 상태는 이슈 파일과 CURRENT_STATE.md에 적는다. Claude Code에서는
  SessionStart 훅(`.claude/settings.json`)이 compact/재시작 직후 복원 출력을 자동 주입한다.
