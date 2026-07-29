# 채택 격차 리서치 & 작업 계획 — 2026-07-29

> 산출: Fable Workflow `adoption-gap-research-plan` (9 에이전트 — 외부 리서치 2 ∥ 내부 감사 4 → 격차
> 매트릭스 → 작업 계획 → 완결성 검증 통과). 재실행: `.claude/workflows/adoption-gap-research-plan.js`.
> 핵심 경쟁 수치(rhwp star·npm 다운로드·0.0.1 결함)는 오케스트레이터가 GitHub/npm API로 별도 재검증함.

## TL;DR

**격차의 핵심은 "엔진이 부족해서"가 아니라 "만든 것이 바깥에 도달하지 않아서"다.**
레지스트리에는 `file:` 의존이 깨진 0.0.1만 있고, 문서는 미발행 0.0.2 API를 안내하며, 라이브
데모는 7/25 구버전이라 동의 게이트·정확 카피·신규 벌크 랜딩 등 로컬 완성분이 전부 미배포다.
가장 싼 P0는 코딩이 아니라 **승인→커밋→발행→재배포 출시 절차**다. 그 위에 채택 1요인(레이아웃
충실도)의 **공개 증명**과 최대 차별화 축(엑셀→N부 일괄 작성)의 **체험 진입로**를 얹는다.

## 전략 판정 — rhwp 선점과 4공백 축 (실측 검증됨)

| 지표 | rhwp (edwardkim/rhwp) | auto-hwp |
|---|---|---|
| GitHub stars | **3,615** (2026-03-27 생성, 7-28 푸시) | 1 |
| npm 월 다운로드 | @rhwp/editor **12,646** | @auto-hwp/react **116** |
| 배포 표면 | 크롬/엣지/FF 확장·VSCode·CLI·iOS·iframe SDK·wasm SDK·MCP 제안 | 웹 데모 + npm(결함 0.0.1) |
| 라이선스 | MIT | MIT OR Apache-2.0 |

- rhwp는 `external/`에 파싱 전용으로 벤더링한 **상류이자 경쟁자**. 동일 포지션(뷰어/에디터/CLI/MCP)
  정면승부는 유입 불가 — "rhwp 파싱 상류 위의 충실도·일괄작성·바이브 편집 레이어" 서사로 회피.
- **rhwp가 아직 약한 4공백 축**: ① 충실도 공개 벤치마크(rhwp 최다 댓글 이슈가 전부 조판 오차),
  ② 엑셀→N부 일괄 작성 완제품(rhwp #2659는 CLI 제안 단계), ③ 챗 기반 바이브 편집,
  ④ React 네이티브 컴포넌트 SDK.
- 순풍: **정부 HWPX 의무화(2026-05-18 온나라 개방형 포맷 전용)** — 단 HWPX 편집→저장에
  critical 결함(아래 W4)이 남아 있어 "HWPX 시대의 대안" 포지셔닝 전에 저장 신뢰부터 잠가야 한다.
- 수요 정량 증거: 유지중단 hwp.js 월 12,816 DL·2020년 이후 릴리스 없는 pyhwp 월 291,190 DL —
  공급이 끊겨도 수요는 상수. hwp.js 크롬 확장 멀웨어 사건의 학습효과 때문에 "100% 로컬·서버 전송 0"
  증명과 유지보수 신호(CHANGELOG·정기 릴리스)가 이 도메인 특유의 채택 결정 변수다.

## 감사 핵심 (팀 인식 교정 포함)

- **HWPX 엔진**: 파싱·조판은 크게 성숙(byte-verbatim 왕복 해자·074로 한컴 저작 5종 중 4종 쪽수 일치).
  실격차 4곳 — ① [critical] 문단 삽입/Enter 분리 저장 시 섹션 끝 append로 **문서 순서 파손**
  (serialize.rs:728-751·924-933, 057이 표에서 잡은 결함과 동형·문단 레인 미수리, .hwp 픽스처 전용
  게이트라 가려짐), ② 차트 완전 소실(078)·수식 스텁, ③ pageBreak 미독 → bizinfo 24↔25(080),
  ④ verify 게이트·e2e에 .hwpx 0건 + 참값 오라클 부재(075).
- **벌크**: 팀 인식("미숙")보다 성숙 — 웹+CLI 완주·결정론 LLM 0콜·재개봉 검증 3종·검수 캐러셀은
  경쟁 부재 차별점. 실구멍은 ① 100명 배치 시 메인스레드 동기 루프 완전 프리즈, ② 명단 헤더
  오타→조용한 빈칸(무진단), ③ 샘플 양식 부재로 파일 없는 방문자 체험 불가, ④ dropzone이 드롭 미수신.
  073 이슈 헤더가 'open' 스테일 → 이중 기획 위험.
- **정적 페이지**: [critical] 라이브가 "문서는 브라우저 밖으로 나가지 않습니다"라 말하면서 동의 없이
  문서 내용을 OpenRouter로 전송(수정본은 로컬 완성·미배포). 북극성 기능을 "곧 붙일 예정"으로 부정.
  OG/twitter 태그 0·favicon 404·description "QA 전용."·전면 CSR — 공유·검색 유입 구조적 사망.
- **임베드 DX**: [critical] react@0.0.1은 `file:` 의존 발행 → 단독 설치 즉사. README/EMBED-GUIDE의
  sidePanel/workspacePanel API는 레지스트리 실물에 없음. CHANGELOG 0·이미 무고지 파괴 변경 존재.
  SDK 전면 한국어 하드코딩(077). 강점: engine 단독 경로는 오늘도 동작·타입 4패키지 동봉·정직한
  한계 고지·publish:safe 파이프라인 완성(발행 승인만 남음).

## 격차 매트릭스 (19행 요약)

| P | 불만/망설임 지점 | 갭 (해소 방향) |
|---|---|---|
| P0 | npm 설치하면 깨짐 (0.0.1 `file:` 의존 + 문서가 미발행 API 안내) | 0.0.2 실발행 + 0.0.1 deprecate + fresh 스모크 |
| P0 | 라이브 프라이버시 문구 ↔ 실동작 모순 (동의 없는 AI 전송) | 로컬 완성분 커밋→재배포 (절차만 남음) |
| P0 | 충실도 게이트 수치가 내부 문서에만 존재 | 공개 벤치마크 페이지 (원본 vs 렌더 side-by-side + 재현 커맨드) |
| P0 | 벌크(최대 차별화 축)가 샘플 없이 체험 불가 | 샘플 양식+명단 번들 원클릭 + drag&drop |
| P1 | 버전 신뢰 신호 0 (CHANGELOG 부재·무고지 breaking) | CHANGELOG 소급 + 0.x 정책 + publish 게이트 |
| P1 | 공유·검색 유입 사망 (OG 0·favicon 404·CSR) | metadata 일괄 + 가치제안 description |
| P1 | README 10초 증명 부재 (GIF·quickstart·비교표 없음) | GIF 1개 + 상단 quickstart + 3열 비교표(첫 행=라이선스) |
| P1 | 임베드 첫 5분 초과 (4파일 수동 복사·번들러 설정) | wasm/워커 URL 기본값 CDN화 (Monaco 패턴) |
| P1 | 존재가 알려지지 않음 (star 1) | P0 완비 후 GeekNews Show GN 런치 → 기고 연재 |
| P1 | 벌크 100명 배치 프리즈 + 조용한 빈칸 | yield→워커 경유 + 양방향 unmatched 진단 |
| P1 | HWPX 저장 시 문단 순서 파손 (critical) | src_span 앵커링 문단 레인 확장 + HWPX 게이트 |
| P2 | .hwpx 입구 정책 비일관 (픽커 거부·드롭 통과·벌크 허용) | 정책 단일화 (W4 후) |
| P2 | 차트 소실·수식 스텁·pageBreak 미독 (078/080) | 수식 S 편승 → pageBreak M → 차트 L |
| P2 | HWPX 참값 오라클 부재 (075) | Windows COM nightly 레인 (장기) + 게이트 우선 |
| P2 | wasm 3.1MB(압축) 무정보 대기 | idle prefetch + 진행률 + onProgress 공개 |
| P2 | 벌크 .xlsx 미지원·CLI spec 무시·검수 1페이지 한정 | 최소 xlsx 리더 + SPEC_TYPES 이식 (후속) |
| P2 | SDK 전면 한국어 (077) — 글로벌 채택 불가 신호 | messages 주입 계약 + EMBED-GUIDE 영문화 |
| P3 | 벌크 AI 프롬프트의 PII 외부 전송 무고지 (079) | 고지 1줄만 즉시 분리 반영, 본구현은 후속 |
| P3 | 모바일 편집 불가·무고지 | 기대치 배너 S만 선처리 |

## 작업 계획 — W1~W6

착수 순서: **W1(승인→커밋→발행→재배포) → [W2 claude ∥ W3 codex] → [W4 claude ∥ W5.1/W5.4 codex]
→ W5.2·W5.3(claude, W1 커밋 후) → W5.5 런치(user) → W6**.
승인 대기와 무관하게 즉시 착수 가능한 병렬 선행분: **W1.3(CHANGELOG)·W3 전체·W3.6(PII 고지 —
W1.2 커밋 이전 완료해 배포에 편승)·W5.1**.

### W1 [P0] 출시 절차 — 미커밋 대기분 출하
| # | 태스크 | 노력/주체 | 의존 |
|---|---|---|---|
| 1 | 커밋/push·npm 발행·Worker/Pages 배포 **일괄 승인** (키 회전은 새 키 실검증 후) | S/**user** | — |
| 2 | 논리 커밋 분할·실행 (작성자 Codex, docs/assets 히어로 이미지 동반 커밋 → 404 방지) | M/codex | W1.1 |
| 3 | CHANGELOG.md 신설 (0.0.1 결함·0.0.2 파괴 변경 소급) + publish.yml CHANGELOG 게이트 — ⚠️ publish.yml은 Codex 미커밋 파일이므로 게이트 추가는 **W1.2 커밋 후**(또는 Codex 위임) | S/claude | W1.2 |
| 4 | npm 0.0.2 실발행(engine→editor-core→ai-protocol→react) + 0.0.1 deprecate | S/**user** | W1.2, W1.3 |
| 5 | fresh 레지스트리 스모크 (react 단독 설치 import·vite-embed E2E·pnpm 해석) | S/claude | W1.4 |
| 6 | Pages 재배포 라이브 실측 (wasm 바이트·동의 게이트 문구·모순 카피 부재·/bulk 신규) | S/claude | W1.2 |

수용: npm view react@latest=0.0.2·`file:` 0건 / fresh 설치 성공 / 0.0.1 deprecated /
라이브 wasm ≠ 7,657,643B / 동의 게이트 존재·모순 카피 부재 / CHANGELOG 항목 존재.
검증: 커밋 직전 `verify-local.sh --full` 재확인(게이트 8==8/18==18/24==24·98.9%+·LOCKSTEP 불변).

### W2 [P0] 충실도 공개 벤치마크 페이지 (/bench)
1. **[M/claude]** 비교 자산 조립 — .hwp 3종(8/18/24쪽)+modu-startup(6쪽) 페이지별 원본 PDF vs 우리
   SVG 이미지 쌍. ⚠️ 제3자 문서의 공개 게시 여부는 **사용자 확인 게이트**(W1.1 승인에 항목 편입,
   불가 시 수치만 폴백). 068 잔여 '시각 파리티 축'의 v1 산출물로 068에 기록.
2. **[M/claude]** 정적 프리렌더 라우트 — side-by-side 슬라이더 + 수치 표(줄바꿈 98.9%·쪽수
   4게이트·셀 lineseg 826/839) + 각 수치의 재현 커맨드. 랜딩·README 링크.
3. **[S/claude]** docs/BENCHMARK.md 재현 가이드 — "수동 육안이 아니라 자동 게이트"가 차별 서사.

### W3 [P0] 벌크 체험 깔때기 개방 + 스케일 방어선 (전부 codex, 즉시 착수 가능)
1. **[M]** 샘플 양식+명단 번들 → '샘플로 체험' 원클릭 자동 진행 + 벌크 전면 배치 카피
2. **[S]** dropzone drag&drop 핸들러 (onDragOver/onDrop, 기존 onTemplate 재사용)
3. **[M]** 생성 루프 프리즈 해소 — 1단계 주기 yield(즉효) → 2단계 engine worker.js 경유+청크 반영
   +검수 SVG lazy+행 단위 try/catch 부분 보존
4. **[S]** 명단 키↔필드 키 양방향 unmatched 진단 (사유코드+배너+키 칩 매칭 상태)
5. **[S]** 073 헤더 'v1 done/후속 open' 정정 + issues/README 행 추가(이중 기획 차단) + 100명 파일럿
6. **[S]** AI 프롬프트 카드 PII 전송 고지 1줄 (079 선행 분리분 — **W1.2 커밋 전 완료**해 배포 편승)

수용: 샘플 체험 e2e 완주 / 100명 프리즈 0·부분 보존 / unmatched 배너 e2e / 073 정합 / PII 고지.

### W4 [P1] HWPX 저장 신뢰 + HWPX 게이트 (전부 claude — crates 소유)
1. **[M]** 문단 삽입/Enter 분리 끝-append 수리 — 057 src_span 앵커링을 문단 레인으로 확장
   (serialize.rs 수집·inject 지점 + SplitParagraph source:None), goldenRecovery 레드→그린
2. **[M]** ensure_simple_para 세분화 — secPr 호스트(섹션 첫 문단=제목) body-verbatim 보존+run 교체
   개방, 개체 문단은 non-text inline 보존 splice
3. **[M]** verify 게이트·e2e에 HWPX 편입 — benchmark1.hwpx 쪽수+셀 lineseg 임계 assert, 편집 e2e
   3~4개를 sample-18p.hwpx로 복제. 075 네이티브 오라클은 후속 L 트랙
4. **[S]** 수식 enrichment quick-win — EqAccum verbatim 캡처 완료 상태에서 rhwp eq_render(062 승격분)
   호출로 rendered_svg 채움 (스텁→실렌더)
5. **[M]** pageBreak 캡처 (080 확정 설계) — 3조판 경로 공유 helper로 LOCKSTEP 구조 고정, bizinfo 24→25

수용: hwpx-origin Split/Insert 골든 그린 / 섹션 첫 문단 타이핑 e2e / HWPX 게이트 그린 / 수식 44박스
실렌더 / bizinfo 25==25 / **무편집 byte-verbatim 골든 불변**. 검증: `--full` 필수(wasm 재빌드 포함).

### W5 [P1] 유입 기본기 + 런치
1. **[M/codex]** OG/twitter/favicon/description metadata (기존 brand 자산 재활용) + /bulk/ trailing 404 수정
2. **[M/claude, W1.2 후]** README 10초 증명 — 편집 루프 GIF·상단 quickstart·rhwp/hwp.js 3열 비교표
   (첫 행=라이선스 "상용 임베드 무료·동접 제한 없음") + **HWPX 의무화(2026-05) 인용 카피** + AGENTS
   '27메서드'→34 오기 수정
3. **[S/claude]** npm tarball LICENSE 동봉 prepack + NOTICE tf-hwp→auto-hwp (다음 발행 편승)
4. **[S/codex, W4.1 후]** .hwpx 입구 정책 단일화('받되 알파 배지') + 18p hwpx 샘플 노출
5. **[M/user]** GeekNews Show GN 런치 — P0 4건+공유 카드 완비 후. "rhwp 상류 위의 레이어" 서사,
   정직한 한계 고지 포함, 첫 48시간 대응 → 요즘IT/velog 연재로 전환

### W6 [P2] 임베드 첫 5분 + SDK i18n
1. **[M/claude, W1.4 후]** wasm/워커 URL 기본값 jsDelivr CDN화(버전 pin, 명시 URL은 오버라이드로
   강등) — 'npm i 한 줄'화. Workers용 WebAssembly.Module 주입 초기화는 후속 백로그
2. **[M/either]** wasm idle prefetch + onProgress 진행률 (어댑터 API=claude ∥ UI 배선=codex)
3. **[M/codex]** SDK i18n (077 확정 설계) — WorkspaceMessages+koKR catalog+DeepPartial 주입+AST 게이트
4. **[M/claude, W1.4 후]** EMBED-GUIDE.en.md 영문화 + examples registry(^0.0.2) 기본 전환

## 병렬 안전성 (파일 소유권)

- **Claude**: crates/*(W4), verify-local 게이트, /bench 라우트+BENCHMARK.md, CHANGELOG·prepack
  LICENSE, packages/react/src/WasmAdapter.ts·engine 로더. README·docs/assets는 **W1.2 커밋 후에만**.
- **Codex**: apps/hwp-lab 전체(bulk/LabWorkspace/layout/next.config — 미커밋 작성자라 W1.2도 담당),
  packages/react components/(HwpWorkspace·ChatPanel — 077).
- packages/react 내부는 WasmAdapter(claude) vs components/(codex) 파일 단위 분할 — 동시 수정 금지.
- 공통 금지: external/ 수정, LOCKSTEP 단독 수정, 커밋/push/publish/배포는 전부 W1.1 승인 후.
  crates 접촉 시 wasm 재빌드+copy-wasm+.next 삭제, packages 접촉 시 dist 재빌드, e2e 전 .next 삭제.

## 재실행

```
Workflow({scriptPath: ".claude/workflows/adoption-gap-research-plan.js"})
```
분기별 재실행 시 rhwp 지표·npm 다운로드·라이브 상태를 다시 실측해 매트릭스를 갱신한다.
