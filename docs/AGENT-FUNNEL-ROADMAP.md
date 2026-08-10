# 에이전트 퍼널 로드맵 — "AI가 .hwp를 받아 작업하고, 사람이 중간 검토하고, .hwp로 돌려준다"

- 확정: 2026-08-10 (기획만 — 작업 미착수). 오픈소스 레포의 공개 로드맵 축으로 관리한다.
- 비전(사용자 정의): 에이전트가 **우리가 호스팅한 서버**에 사업계획서 같은 `.hwp`를 첨부해 요청 →
  원본 베이스로 AI가 작업 → **중간 단계는 사용자가 확인·수정·피드백** 가능한 형태 →
  **최종 export는 `.hwp`**(어려우면 PDF라도). MCP처럼 호출 가능한 엔진 고도화가 축이다.
- 근거 리서치: `docs/research/claw-hwp-2026-08.md`(.hwp 재저장 지식의 유일한 공개 출처),
  `docs/research/rhwp-nested-tables-2026-08.md`.

## 0. 실사 결론 — 뼈대는 이미 있다 (2026-08-10 코드 실측)

| 퍼널 요소 | 현재 상태 | 근거 |
|---|---|---|
| 에이전트 호출 표면 | ✅ `hwp-mcp` 3 transport — stdio·loopback HTTP·**`--http-network` 서비스 모드(013, fail-closed 토큰)** | `crates/hwp-mcp/src/main.rs` |
| 호스팅 셸 | ✅ Docker 서비스 컨테이너 178MB, 2-stage, SELF-HOST 문서화 | `Dockerfile.service`, `docs/SELF-HOST.md` |
| 작업 op | ✅ `open_document`·`get_context`·`apply_content`·`find/replace`·`undo/redo` + **제안 흐름 `propose_content`/`commit_proposal`** | `crates/hwp-mcp/src/lib.rs` |
| 최종 export | ✅ `export_hwpx`·`export_pdf`(pdf feature=컨테이너) / ❌ `.hwp` 없음 — `.hwp` 열면 "HWP5→HWPX (converted)" | lib.rs:589,647 |
| 중간 렌더 | ⚠️ `render_page`가 **P1 잔재** — rhwp 렌더라 "원본 전용, 편집된 문서 거부" | lib.rs:177-190 |
| 사람 검토 화면 | ⚠️ 웹 워크스페이스(제안 카드·고스트 프리뷰·카드별 되돌리기)는 완성돼 있으나 `/d/<key>` 매핑이 **브라우저 localStorage 전용** — 기기 간 공유 불가 | `apps/hwp-lab/src/lib/docUrl.ts` |

즉 이 축은 신규 건설이 아니라 **네 개의 갭 메우기**다: ① 중간 렌더를 자체 렌더로 교체
② 검토 링크의 서버측 세션 ③ `.hwp` 재저장(→ 이슈 082) ④ 호스팅 운영(멀티테넌트·인증·과금 없는 rate).

## F1 — 중간 산출물 레인: `render_page`를 자체 렌더로 (작음)

P1 시절 rhwp 렌더를 걷어내고 own-render(`hwp-session` render_svg — autohwp.com 프로덕션 표면과 동일)로
교체. 편집된 문서도 페이지 SVG/PNG를 돌려준다 → 에이전트가 "지금 문서가 이렇게 생겼다"를 매 단계
사용자에게 보여줄 수 있다. `export_pdf`는 이미 자체 조판이므로 렌더-export 일치가 구조로 보장된다.
- 게이트: 편집 후 render_page == 웹 워크스페이스 렌더(같은 IR·같은 조판) 픽스처 대조.

## F2 — 검토 퍼널: 서버측 문서 세션 + 승인 API (중간)

`/d/<key>`를 서버측 스냅샷 저장소로 승격(현재 localStorage 매핑은 폴백 유지). 흐름:
1. 에이전트: `open_document` → 편집/제안 → `share_review` (신규 툴) → **검토 URL** 반환.
2. 사용자: 그 URL을 브라우저로 열면 **기존 워크스페이스 검토 모드** — 제안 카드·고스트 프리뷰·
   카드별 승인/거부·수동 수정·코멘트. (이 UI는 이미 프로덕션이다 — 새로 짓는 건 승인 상태의 저장뿐.)
3. 에이전트: `poll_review`(신규 툴)로 승인/거부/수정 diff를 받아 다음 턴 반영.
- 저장소는 셸 소관(Vercel KV/S3/파일 — 컨테이너는 파일이 기본), 코어는 스냅샷 bytes만 안다.
- 게이트: 제안 N건 → 사용자 부분 승인 → 에이전트가 거부 사유를 받아 재제안하는 e2e 1개.

## F3 — `.hwp` export v1: 텍스트 레인 in-place 패치 (**이슈 082**, 크고 가치 최대)

원본 `.hwp` 바이트를 베이스로 CFB Section 스트림만 레코드 패치해 되돌려주는 claw-hwp 방식의 Rust
포팅. **v1은 텍스트 편집만**(SetTableCell*/SetParagraph* 레인) — 퍼널의 지배 시나리오(서식 채우기·
문구 수정)가 정확히 이 레인이다. 구조 편집(행 삽입·표 신설)이 섞인 문서는 정직하게 HWPX/PDF로
강등 안내(capability report). 상세·수용 기준은 `docs/issues/082-hwp5-resave.md`.

## F4 — `.hwp` export v2: 구조 편집 + 미디어 (크고 뒤로)

행/열 삽입·이미지 교체(BinData 재번호)·각주 등 레코드 스플라이싱. claw-hwp가 증명한 영역이지만
테스트 0인 그들과 달리 우리는 게이트를 세워야 하므로 v1의 한컴독스 수용 하네스가 선행 자산이다.

## F5 — 호스팅 운영·오픈소스 배포 (F2와 병행 가능)

- 컨테이너 1개=작업 1개 모델(현행 가드)을 유지한 **세션 풀** 프론트(간단·격리 우수) 또는 멀티세션.
- 인증 키 발급·IP rate(데모 AI 레인과 동일 규율)·업로드 상한·보존 기간(개인정보 — secure-fill 정책
  이식은 claw-hwp 리서치 §파생 백로그).
- 오픈소스 스토리: "self-host 한 줄(docker run) = 너의 에이전트에게 HWP 손발을 달아준다" —
  SELF-HOST.md 확장 + MCP 등록 예제(`claude mcp add`)를 퍼널 시나리오로 재작성.

## 순서 제안

**F1 → F3(082) → F2 → F5 → F4.** F1은 반나절급인데 퍼널 데모가 즉시 성립하고(중간 확인=PDF/SVG,
최종=PDF), F3이 "hwp로 돌려받기"라는 차별화 본체다. F2는 UI가 이미 있어 저장소+API만이며,
F4는 v1 하네스 없이는 착수 금지.

## 비범위·정직 노트

- 퍼널 전체에서 rhwp는 계속 **파싱 전용**(불변식 3) — `.hwp` 쓰기는 원본 바이트 패치이지 rhwp
  직렬화가 아니다(rhwp exportHwp 산출물은 한컴독스가 거부한다는 claw-hwp 실측 — 우리가 안 갈 길을
  그들이 먼저 확인해 줬다).
- F2의 코멘트/승인 모델은 실사용 전 확정하지 않는다 — 카드 단위 승인부터(이미 있는 UI 단위).
