# 066 — 바이브 편집: 웹 doc-context가 표 구조에 눈이 멀어 표 채우기/구조편집 실패

- 상태: open · 우선순위: **R14-P0 (바이브 편집 핵심 품질)** · 영역: packages/ai-protocol(buildDocContext) + wasm/adapter(표 그리드 노출) + apps/hwp-lab
- 발견: 2026-07-13 실물 QA(사용자 스크린샷 + Grok 실호출 A/B). 모델(Grok 4.5)이 아니라 **컨텍스트가 문제**임을 실증.

## 증상 (사용자 스크린샷 + 재현)
- "해당 표 내용 채워줘"(표 전체 마킹) → **"제안된 편집이 없습니다"**(intents 0).
- "아이디어명은 청소조아로 채워줘" → **1행1열(라벨 칸)** 에 적용(값 칸이 아님) — 엉뚱한 셀 타겟팅.
- "이 표에 행 2개 더 추가해줘" → intents 0 (구조 편집도 실패).
- 대조: 문단 편집("이 문단을 …로 바꿔줘")은 정상(`SetParagraphText`).

## 근본 원인 (Grok A/B로 확정 — 모델 아닌 컨텍스트)
웹 경로 `packages/ai-protocol/src/context.ts::buildDocContext`가 모델에게 주는 건 **앵커 메타 + 앵커의 평문 text 한 줄뿐**:
`#0 table section=0 block=3 text=""`. **표의 셀 그리드(행×열, 각 칸의 라벨/빈칸)를 전혀 안 준다.** 표 앵커는
`deriveSel`(selection.ts:71)에서 `{kind:"table",section,block,label}`로 rows/cols·text도 없음.
- 엔진엔 이미 `to_markdown`(이슈 004, `hwp-ai/src/lib.rs:150` — 표=그리드+`[s/b]` 앵커)이 있으나 **Rust CLI/MCP 전용**,
  웹 route.ts엔 미배선(`hwp-mcp/src/lib.rs:1930`만 사용).

**실증(Grok 4.5, 같은 표·지시)**:
- [A] 얇은 컨텍스트(현 웹, `text=""`) → `intents:[]` (사용자 증상 재현).
- [B] 그리드 컨텍스트(`(3행4열) | (r0c0)청소조아 | (r0c1)_빈칸_ | …`) → **완벽**: r0c1="청소좋아", r0c3="조이",
  r1c1(아이디어명 옆)="스마트 홈 클리닝 매칭 서비스" … 라벨 옆 빈 값 칸을 정확히 타겟, 모르는 칸은 비움.

즉 **표 그리드만 주면 Grok이 표 채우기·라벨 기반 셀 지정을 정확히 한다.**

## 수정안
1. **표 그리드를 doc-context에 포함**: 표 앵커가 마킹되면 그 표의 셀 그리드(행×열, 각 셀 (r,c)+현재 텍스트+빈칸 여부)를
   컨텍스트에 첨부. 소스: (a) `to_markdown`을 wasm에 노출(권장 — 이슈 004 재사용, 표=그리드+앵커) → WasmAdapter →
   buildDocContext, 또는 (b) 클라에서 `tableAt`(행열수)+per-cell `tableCellAt`/`blockRuns` 순회로 그리드 조립.
2. **셀 좌표 규약 명시**: SetTableCell의 row/col이 모델-글로벌 셀 주소임을 프롬프트에 명확히(현재 프롬프트에 표 그리드 설명 부재).
3. **구조 편집(F3) 프롬프트 보강**: TableInsertRows/TableAppendRow의 파라미터(at/count)를 프롬프트에 예시. 그리드 컨텍스트가
   들어가면 "몇 행 표에 몇 개 추가"를 모델이 계산 가능.

## 수용 기준
- [ ] 표 전체 마킹 + "채워줘" → 라벨 옆 빈 값 칸들에 sensible한 SetTableCell 생성(빈 그리드 재현 e2e, mock+실 provider)
- [ ] "아이디어명은 X로" → 아이디어명 값 칸(라벨 칸 아님)에 적용
- [ ] "행 N개 추가" → TableInsertRows/TableAppendRow 생성
- [ ] 얇은 컨텍스트 회귀 방지(그리드 없으면 기존 동작), 토큰 예산(큰 표는 그리드 truncate maxLen)
- [ ] R5 펜스·화이트리스트 유지, 게이트 무영향(JS/컨텍스트 변경)

## 함정
- 큰 표(수백 셀)는 그리드가 토큰 폭증 → maxLen truncate + "마킹된 표만" 그리드(전 문서 아님).
- to_markdown wasm 노출 시 wasm-safe 확인. `to_markdown`의 `[s/b]` 앵커 규약과 웹 앵커(section/block) 정합.
- 셀 좌표: 분할표 fragment의 전역 row/col 규약(hwp-session 함정) — SetTableCell이 쓰는 좌표계와 그리드 좌표 일치 필수.
