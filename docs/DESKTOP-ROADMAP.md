# 데스크톱(Tauri) 로드맵 — V3 D축의 구체화

> 작성: 2026-08-18 · 공개 이슈 **#54**. `docs/PRODUCT-DIRECTION-V3.md` D축("같은 엔진의
> 얇은 OS 셸, HOP식 「설치해서 한글처럼」 복제 금지")을 **구체화**한다 — 재정의가 아니다.
> 셸 수렴의 계약은 `docs/TAURI-CONVERGENCE.md`(R10)가 정본이다.

## 0. 현재 위치 (2026-08-18)

- `VITE_SHELL=workspace`로 데스크톱이 웹과 같은 `HwpWorkspace`를 마운트한다(R10).
  **기본 off가 계약**이다 — off면 기존 뷰어와 바이트 동일, 롤백은 플래그 하나.
- 채팅(바이브)은 op-bus Intent[] 노출 전까지 데스크톱에서 비활성.
- TauriAdapter는 EngineAdapter 34메서드 계약을 wasm과 공유한다. D0(#64, #51 흡수)가
  `blockRunsPath`·`tableGrid`·`docProfile`을 read-only Intent 래퍼로 배선한다. `normalize`
  2종은 명시적 capability-off(#65). 중첩 캐럿의 죽은-캐럿 가드(#48)는 임의 백엔드 omit에
  계속 유효하다.
- macOS 타이틀바는 CSS `h-9` 확정 해법(ccb9d5a) — 재작업 금지.

## 1. 원칙

- **얇은 셸**: 기능은 코어/SDK에서 나오고 데스크톱은 OS 통합만 얹는다. 데스크톱 전용
  편집 기능을 만들지 않는다(만들고 싶어지면 그것은 SDK 갭이다).
- V3 착수 순서 존중: D축 본격 착수는 A~C 뒤(14개월+). 단 **D0 부채 상환은 수시** —
  어댑터 패리티가 벌어질수록 나중 비용이 커진다.
- 기본 셸 전환은 SDK 승격 8종 + 회귀 0 후(TAURI-CONVERGENCE 계약). 그 전에는 항상
  플래그 뒤.

## 2. 단계

| 단계 | 선행 조건 | 목표 | 내용 |
|---|---|---|---|
| **D0 부채 상환** | 없음(수시) | 어댑터 패리티 (이슈 **#64**, 하위 #51) | hwp-session에 이미 있는 **얇은 3종**(`blockRunsPath`·`tableGrid`·`docProfile`)을 **read-only Intent 래퍼**로 배선(기존 `HitTestCell`·`CaretRectCell` 선례 — hwp-viewer diff 0, 두 백엔드가 같은 op-bus 공유). **"데스크톱 필수 메서드" 선언 목록** 신설 + **CI 계약 테스트**(존재·non-stub·Intent 라운드트립·커맨드 등록 교차검증)을 `build-test`의 신규 node 스텝에서 실행. `normalize` 2종은 사유 기록 커밋과 함께 **명시적 capability-off**(코어 승격은 **#65**) |
| **D1 기본 셸 전환** | SDK 승격 8종+회귀0 | workspace가 기본 | `VITE_SHELL=workspace` 기본 on, 기존 뷰어 제거. 채팅은 op-bus Intent[] 노출 후 활성. §4.8 QA(실빌드 업로드/편집/undo/export) 통과가 게이트 |
| **D2 OS 통합** | D1 | 데스크톱다움 | `.hwp`/`.hwpx` 파일 연결(더블클릭 열기), OS 인쇄 대화상자, 로컬 MCP 서버 내장(앱이 곧 에이전트 엔드포인트 — AI-LOCAL-CONTROL-PLAN 계승), 최근 문서 |
| **D3 배포** | D2 | 설치 가능한 제품 | macOS 서명/공증 + Windows 서명, 자동 업데이트 채널, 릴리스 파이프라인(기존 prebuilt 규율 연장). 다운로드 페이지는 autohwp.com에 |

## 2.1 D0 범위를 이렇게 좁힌 근거 (2026-08-20 인터뷰 · 실측)

- 계약 `adapter.ts`는 34메서드 중 **20개가 optional**이고, `HwpWorkspace.tsx:3135`는 "`tableGrid`는 OPTIONAL(TauriAdapter엔 없음) — 없으면 앵커 `text`로 강등"이라고 **의도된 설계**로 적어 두었다. **omit 자체는 부채가 아니다.** 진짜 부채는 "omit이 조용히 죽는" 경우이고 그건 #48이 가드로 막았다.
- 갭 5종은 동질하지 않다: 3종은 `crates/hwp-session/src/lib.rs`(`doc_profile`:317·`table_grid`:1003·`block_runs_path`:2111)에 이미 있어 얇은 배선이지만, **normalize 2종은 `crates/hwp-wasm`의 `HwpDoc` 상태머신**(`normalize_on`·`ls_baseline` + open 시 자동 적용)에만 있고 `crates/hwp-viewer`에는 참조가 **0건**이다 → 승격하면 CLI `layout-check`의 open 경로가 바뀌어 게이트를 건드릴 수 있다.
- ⚠️ `ci.yml` 필수 3종에 pnpm·node·vitest 스텝이 **0건**이라, CI 계약 테스트는 `build-test`에 node 스텝을 신설해야 실제로 돈다.
- §4.8 체크리스트에는 D0 갭 메서드 대응 항목이 없어 **갱신이 선행**이다. 다만 §4.8 전면 QA는 D1 게이트이지 D0가 아니다 — D0 QA는 배선한 3종의 가시 효과 확인으로 한정한다.

## 3. 하지 말 것

- 「맥에서 한글 대신」 서사(V3 D축 금지 조항) — 포지션은 "브라우저 제품의 OS 셸"이다.
- traffic-light/타이틀바 config·objc 재시도(ccb9d5a 확정).
- 데스크톱 전용 포맷 기능·자유 2D 이동 같은 거짓 자유도.

## 4. 다음 한 줄

**#64(D0 우산: 3종 배선 + 필수 목록 + CI 계약 테스트)가 첫 티켓이다 — A~C축과 독립 착수 가능. Seed `seed_e31ddce71c7e`.**
(기획·검수: Fable / 실작업: Grok 4.6 — AGENTS.md §에이전트 역할 분담)
