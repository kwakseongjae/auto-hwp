# 067 — 문서 프로필 자동 컨텍스트 (결정론 — 업로드당 LLM 호출 0)

- 상태: **done (2026-07-22 구현·검증 완료 — 미커밋)** · 우선순위: **P0 (진단 U1·U2·U5 — AI 문서이해 층 부재의 정공법)** · 영역: hwp-session → hwp-wasm → editor-core → ai-protocol → hwp-lab

## 구현 결과 (2026-07-22)
- 설계 §5단계 그대로 배관: `hwp_session::doc_profile`(+DTO 3종, 순수 모델 walk) → wasm `docProfile` →
  engine index.js/worker.js(METHODS)/index.d.ts → adapter optional `docProfile?()` → `DocMeta.profile` +
  `buildDocContext` 프로필 블록 → LabWorkspace `onAiRequest`가 grids와 병렬 조회·상시 첨부.
- **설계 편차(개선) 2건**: ① open-시-1회-캐시 대신 **요청당 조회** — 순수 모델 read라 싸고, 편집 직후 스테일
  0(무효화 로직 불필요). ② 프로필 헤딩/표에 **페이지 번호 미포함** — block_pages(타이프셋 패스)를 피해
  프로필을 완전한 pure-model read로 유지([s/b]가 편집 통화라 모델엔 무손실).
- 예산 규율: 프로필은 head+앵커/그리드가 남긴 예산에만 삽입(앵커 우선), 상한 2500자·최소 200자 미만이면 드롭.
  프롬프트 FOOTER에 DOC PROFILE 스탠자(앵커 없을 때 프로필 인쇄 주소만 겨냥 허용·발명 금지) 추가.
- 검증: cargo workspace 전체 + hwp-session 16(신규 3) · 게이트 **8==8/18==18(98.9%/99.2%)** · wasm 재빌드
  (wasm-opt 9.79MB)+copy · vitest 169/46/316/50 · e2e 신규 `doc-profile-067.spec.ts` + 066 회귀 통과.
- **실 Grok 실증(마킹 0)**: "첫 번째 표에 빈 행 추가" → 사고 로그가 "Looking at the document profile,
  the first table is at [s0/b1]" — 프로필을 직접 읽고 `TableAppendRow{section:0,index:1}` 제안·카드 렌더.
  067 이전 동일 요청 = intents:[] blindness.
- 근거: `docs/USER-BOTTLENECK-DIAGNOSIS.md` §2-A U1(모델이 받는 문서 정보 = 4필드+마킹앵커뿐) · 066이 같은 패턴(표 그리드 첨부)으로 intents:[]를 해소한 실증.

## 핵심 판정 (2026-07-22 표면 검증 완료)
**프로필은 100% 결정론 알고리즘으로 가능 — 업로드/요청당 LLM 호출은 설계상 0.**
병목은 알고리즘이 아니라 **노출**이다: native에 이미 완성된 재료(`hwp_ai::to_markdown` = 본문+표 `|`그리드+`[s/b]` 앵커, `doc.plain_text()`, `hwp_session::outline()`)가 wasm에 안 뚫려 있을 뿐.
- 아웃라인: wasm까지 완비(`hwp-session/src/lib.rs:134-153` → wasm `outline` → `WasmAdapter.outline()`). 단 휴리스틱 기반(□/■ 접두, 40자 미만 — `outline_heading` :157-208) — 정부문서 튜닝, Heading 스타일 문단은 놓침(선택 개선).
- 표 인벤토리: `table_grid`는 지목한 표 1개만(:734-759) — **전체 열거 API 신규 필요**(to_markdown이 이미 전체 표를 순회하므로 walk 재사용).
- 본문 발췌·통계: native에 재료 완비, **wasm 노출 신규 필요**. `sections`는 WasmAdapter가 하드코딩 1(`WasmAdapter.ts:328`) — 프로필에서 실측으로 교정.

## 설계 (additive 배관 5단계)
1. **hwp-session**: 신규 `doc_profile(doc) -> DocProfileDto` — 내부는 전부 재사용: 통계(Block/Inline 1-walk: 문단·표·이미지·차트·수식 수), 표 인벤토리(`(section, block, rows, cols, 첫행 텍스트, page)` — page는 outline이 쓰는 `hwp_typeset::block_pages` 재사용), 본문 발췌(`hwp_ai::to_markdown` 앞 N자), 아웃라인(기존 `outline()`), 제목 후보(outline level-1 우선 → to_markdown 첫 비표 라인 폴백 + 호스트 전달 파일명).
2. **hwp-wasm**: `docProfile()` 바인딩 1개(JSON 문자열, 기존 `outline`/`tableGrid` 패턴 :624-648).
3. **editor-core/adapter**: optional `docProfile?()` (043 패리티 규약 — `outline?()`과 동일). WasmAdapter는 guard 복제, TauriAdapter는 `doc_profile` 커맨드 미러 또는 생략.
4. **ai-protocol**: `DocMeta.profile?: string` additive 필드(`types.ts:49-54`) + `buildDocContext` 헤더 다음(:46 뒤)에 프로필 블록 삽입. **프로필 없으면 출력 바이트 동일**(회귀 안전). grids와 역할 분리: 프로필=표 "목록"(개수·크기·헤더행), 셀 상세=기존 grids 경로 유지. 8000자 예산 내 프로필 상한(예: 2500자) 별도 캡.
5. **hwp-lab**: open 직후 **1회** `adapter.docProfile()` → 상태 보관 → `onAiRequest`(현재 요청당 조립 :378)에서 `meta.profile`로 상시 첨부. 편집으로 문서가 크게 바뀌면 refreshToken 계기로 재계산(디바운스).

MVP 축소안: `to_markdown`만 `docMarkdown()`으로 노출해도 본문+표 즉시 해결(통계·제목은 TS 파싱).
후속(옵션, 별도 판단): LLM 1콜 "문서 종류/목적 요약"을 **최초 AI 요청 시 lazy 생성·세션 캐시** — 업로드 시가 아님. MVP에는 불포함.

## 수용 기준
- [x] 마킹 0 + "이 문서 뭐야/표 채워줘"류 요청에서 모델이 프로필 기반으로 문서 구조를 인지(mock e2e `doc-profile-067` + 실 Grok 실증, 066 방식)
- [x] 프로필 미제공 시 buildDocContext 출력 바이트 동일(vitest 46 — byte-identical 회귀 테스트 포함)
- [x] R5 유지: 프로필 전체가 `<document-content>` DATA 펜스 안(신뢰불가 데이터 취급 + FOOTER 스탠자)
- [x] 게이트 8==8·18==18 불변(읽기 전용 — 조판 입력 무접촉, 실측 확인)
- [x] wasm 재빌드+copy-wasm+`.next` 삭제(함정 top 6) · ai-protocol **dist 재빌드**(066 스테일 dist 함정 재발 방지)

## 함정
- **ai-protocol dist 스테일**(066/#1 전례): src만 고치면 앱이 낡은 dist를 실어 프로필이 조용히 드롭 — predev build:deps로 커버되나 verify에서 확인.
- 프로필이 커지면 anchors/grids 예산을 밀어냄 — maxLen 8000 내 우선순위(anchors > grids > profile 순 유지) 명시적으로.
- 대형 문서에서 to_markdown 전문 생성 비용 — 발췌 N자 캡을 엔진 쪽에서(직렬화 전) 적용.
- outline 휴리스틱은 □/■ 정부문서 특화 — 프로필 품질이 문서 유형에 따라 출렁임을 정직하게 수용(빈 아웃라인도 유효 프로필).
