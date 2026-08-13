# 오토한글(auto-hwp) GA4 트래킹 플랜

정본 이슈: GitHub #29, 구현: #30. 프로덕션 측정 ID가 없으면 GA 스크립트와 네트워크 요청은 0이다.
사용자가 익명 분석을 명시적으로 허용한 뒤에만 `gtag.js`를 로드한다.

## Primary funnel

1. GA4 자동 `page_view`
2. `ws_upload_start` 또는 샘플 진입
3. `ws_document_open` (`result=success`)
4. `ws_ai_request` (선택 경로)
5. `ws_export` (`result=success`)
6. `ws_layout_report_open` (집단지성 기여 경로)

초기 버전은 “문서를 열어 실제 산출물을 만들었는가”와 “레이아웃 제보로 기여했는가”를 본다.
수동 편집 완료와 AI 적용 완료는 SDK의 host callback 계약을 별도 설계한 뒤 additive event로 확장한다.

## Events

| 이름 | 발화 조건 | 목적 |
|---|---|---|
| `ws_upload_start` | 파일 picker/drop에서 파일을 선택 | 열기 시도 진입 |
| `ws_document_open` | 열기 검증이 성공·거부·실패·취소됨 | 브라우저 렌더 성공률 |
| `ws_ai_request` | 동의 게이트를 통과하고 AI 요청을 만들기 직전 | 선택적 AI 사용률 |
| `ws_export` | 브라우저 다운로드가 시작되고 autosave 정리가 완료됨 | 산출물 전환 |
| `ws_layout_report_open` | 비식별 GitHub 제보 초안 링크 클릭 | 기여 전환 |
| `docs_agent_prompt_copy` | Docs의 에이전트 시작 프롬프트 복사 결과 | agent-first 온보딩 전환 |

## Parameters

| 이름 | 타입/허용 값 | 사용처 | 카디널리티·개인정보 규율 |
|---|---|---|---|
| `source` | upload/sample/drop/recovery/url/unknown 또는 picker/drop | upload/open | 유한 enum |
| `file_type` | hwp/hwpx/unknown | upload/open | 파일명은 폐기하고 확장자 분류만 보냄 |
| `result` | success/unsupported/empty/too_large/cancelled/failed | open/export/copy | 원문 오류 금지 |
| `page_count_bucket` | 1/2-5/6-10/11-25/26-50/51+/unknown | open | 실제 쪽수 대신 구간 |
| `transport` | demo/byok | AI | 제공자·모델·프롬프트 없음 |
| `format` | html/pdf/hwpx/unknown | export | 유한 enum |

절대 금지: 파일명, URL/query, 문서 본문·표 값, AI 지시문·응답, CellPath/선택 위치, 문서 해시,
원문 오류 문자열, IP나 사용자 식별자를 custom parameter로 보내는 것.

## One-time GA4 admin setup

1. Account/property 생성 후 Web data stream URL을 `https://autohwp.com`으로 설정한다.
2. Vercel Production에 `NEXT_PUBLIC_GA_MEASUREMENT_ID=G-...`를 등록한다.
3. 자동 스크롤·외부 링크 URL 등을 추가 수집하지 않도록 Enhanced Measurement는 끈다.
4. event-scoped custom dimensions: `source`, `file_type`, `result`, `page_count_bucket`, `transport`, `format`.
5. Key events: 성공한 `ws_document_open`, `ws_export`, `ws_layout_report_open`은 UI에서 조건을 분리해 설정한다.
6. 내부 개발 트래픽 필터와 데이터 보존 기간을 소유자가 확정한다.

## Funnel Exploration

- Step 1: `page_view`, page location host=`autohwp.com`
- Step 2: `ws_document_open`, `result=success`
- Step 3: 선택 분기 `ws_ai_request`
- Step 4: `ws_export`, `result=success`
- Step 5: 선택 분기 `ws_layout_report_open`

## Debug checklist

- [ ] 동의 미선택/거부 상태에서 `googletagmanager.com`, `google-analytics.com` 요청 0
- [ ] 허용 후 `page_view` 1회(중복 없음)
- [ ] sample과 local upload의 source/file_type 구분
- [ ] 성공·거부 파일에 원문 이름·오류·본문이 payload에 없음
- [ ] PDF/HTML/HWPX 성공 이벤트 구분
- [ ] layout report와 agent prompt copy 이벤트 확인
- [ ] GA4 DebugView/Realtime 증거 캡처
