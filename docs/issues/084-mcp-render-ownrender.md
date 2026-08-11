# 084 — MCP `render_page`를 자체 렌더로: 편집된 문서의 중간 산출물 레인

- 상태: **구현·검증 완료 · main 반영** (2026-08-11) — 에이전트 퍼널 **F1** (`docs/AGENT-FUNNEL-ROADMAP.md`)
- 우선순위: P1 · 크기: 작음(반나절급) — 퍼널 첫 관문이자 082의 선행 데모 기반
- 영역: `crates/hwp-mcp` (코어 렌더는 기존 `hwp-session` 재사용 — 신규 조판/렌더 코드 없음)

## 문제 (실측 2026-08-10)

`render_page` 툴이 P1 시절 잔재다 — `renderable_bytes()`(lib.rs:177)가 **편집된 문서를 거부**하고
("원본(SVG) 렌더는 편집 전 문서에만 제공됩니다"), 무편집 원본만 rhwp로 재렌더한다. 에이전트 퍼널의
핵심인 "AI가 작업한 **중간 결과**를 사용자에게 보여주기"가 이 지점에서 막힌다. 한편 웹(autohwp.com)과
`export_pdf`는 이미 자체 조판·자체 렌더로 편집된 문서를 그린다 — 같은 능력이 MCP 표면에만 없다.

## 설계

1. `render_page`의 기본 경로를 **자체 렌더**로 교체: IR → `place_doc` 조판 → SVG
   (`hwp-session`의 프로덕션 렌더 표면 재사용 — 웹·PDF와 동일 provider/조판이라 렌더-export 일치가
   구조로 보장된다). 편집 여부와 무관하게 동작한다.
2. 폰트: PDF export와 같은 규율 — 네이티브 discover(컨테이너는 벤더링 NanumGothic).
   2026-08-10 이슈 6 수리(`own_render_fonts_with` 통일)와 같은 provider 레인을 탄다.
3. 기존 rhwp 원본 렌더는 **옵트인 파라미터**로 보존(예: `"source": "original"` — 무편집 문서 한정,
   기존 오류 메시지 유지). 원본 충실도 대조가 필요한 소비자용. 파라미터는 additive.
4. 렌더 캐시는 기존 `session.render`(revision 키) 구조를 자체 렌더 결과에 맞게 유지 — 같은 revision
   재요청은 재조판하지 않는다.
5. 툴 description 갱신: "편집 반영 페이지 SVG. 중간 검토용" — 에이전트가 언제 부를지 알게.

## 수용 기준

- [x] 편집된 문서(`apply_content` 후) `render_page` → 편집이 반영된 페이지 SVG 반환.
- [x] 페이지 수·내용이 `export_pdf`와 일치(같은 조판) — 픽스처 1건으로 잠금(페이지 수 + 대표 글리프).
- [x] 무편집 문서 기본 경로도 자체 렌더(웹과 동일 화면). `source:"original"`은 종전 rhwp 경로 그대로.
- [x] 기존 테스트 `render_svg_is_original_only_edited_docs_refuse` → 새 계약으로 교체(red→green).
- [x] 같은 revision 2회 요청 시 재조판 1회(캐시 동작 테스트).
- [x] `scripts/verify-local.sh --full` EXIT=0 · 게이트 8/18/24/6·HWPX축·LOCKSTEP 불변
      (조판 코드 무접촉 — hwp-mcp 배선만).

## 완료 실측 (2026-08-11)

- red에서 default 비-rhwp의 종전 `render_page needs a build with --features rhwp` 오류를 재현한 뒤,
  편집 반영·JSON/typed 캐시 공유·revision당 자체 렌더 1회·원본 옵트인 계약을 테스트로 잠갔다.
- feature별 lib 테스트: default 38, rhwp 42, pdf 39, no-default 23; rhwp+pdf 전체 64 green.
  wasm32 no-default check와 `Dockerfile.service` 실제 Linux release 빌드(`rhwp pdf`)도 green.
- `scripts/verify-local.sh --full` EXIT=0: 게이트 8/18/24/6, wasm·JS·vitest 944,
  e2e 79 passed/2 expected skip. `external/rhwp`와 조판 코드는 무접촉이다.

## 함정

- hwp-mcp 는 feature 조합이 갈린다(`rhwp`/`pdf`) — 자체 렌더 경로는 rhwp feature 없이도 컴파일돼야
  한다(cfg 분기 위치 주의). 서비스 컨테이너(`Dockerfile.service`) 빌드도 확인.
- SVG 문자열이 LLM 컨텍스트에 그대로 들어가면 크다 — v1은 SVG 유지(브라우저/뷰어 소비 전제),
  PNG 인코딩은 비범위(F2 검토 URL이 본 소비처).
- wasm 재빌드 불필요(네이티브 crate) — 단 verify --full은 crates 접촉이므로 전체 레인.

## 비범위

PNG/썸네일 변환 · 검토 URL(F2) · `.hwp` export(082) · 멀티세션(F5).
