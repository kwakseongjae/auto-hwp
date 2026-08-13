# GA4·검색 등록 프로덕션 증거 — 2026-08-13

정본 이슈: #29–#33. 인증 토큰, 계정 쿠키, 사용자 문서 정보는 이 문서와 저장소에 기록하지 않는다.

## 프로덕션과 개인정보 경계

- main `097929767fd8bec6df42acb18ca74835aa342a24`의 Vercel production push run
  `31691376098`이 성공했다. build, prebuilt deploy, production alias smoke가 모두 green이다.
- `autohwp.com`에는 Google/Naver verification meta가 production env를 통해 출력된다.
- 분석 동의 전 `gtag.js`·Google Analytics 요청·GA 쿠키는 모두 0이었다.
- 허용 뒤에만 `gtag.js`, `page_view`, GA 쿠키가 생성됐다. 개인정보 페이지의 선택 초기화는 즉시
  `ga-disable-* = true`로 바꾸고 동의 배너를 복원했다.
- 라이브 샘플 8쪽 열기의 custom event는 `ws_document_open`과
  `file_type=hwp`, `source=sample`, `result=success`, `page_count_bucket=6-10`만 담았다.
  파일명·본문·URL·해시·프롬프트·응답·원문 오류는 없었다.
- CSP는 GA가 설정됐을 때만 `www.googletagmanager.com` script와 Google Analytics connect 출처를
  허용하고, HSTS·frame/object 제한은 유지한다.

## GA4

- 별도 `오토한글 (auto-hwp)` property와 `https://autohwp.com` Web stream을 사용한다.
- Realtime에서 오토한글 페이지와 활성 사용자를 수신했다.
- Enhanced Measurement는 최종 확인까지 완료해 자동 측정은 기본 `page_view`만 남겼다.
- event-scoped custom dimensions 6개를 등록했다:
  `source`, `file_type`, `result`, `page_count_bucket`, `transport`, `format`.
- `ws_export`, `ws_layout_report_open`을 key event로 생성했고 별표 상태를 확인했다.
- `ws_document_open`은 실패·취소도 같은 이름을 쓰므로 전체를 key event로 표시하지 않았다.
  일반 이벤트 처리 후 `result=success` 조건의 파생 key event를 만드는 후속 확인이 필요하다.

## Google Search Console

- URL-prefix property `https://autohwp.com/`를 HTML meta 방식으로 verified했다.
- `/sitemap.xml`은 제출 직후 잠시 `가져올 수 없음`이었지만 재처리 후 `성공`, 발견 URL 15개가 됐다.
- homepage URL Inspection은 `Google에 등록되어 있음`, `페이지 색인이 생성됨`, HTTPS 정상이다.
- `/docs`, `/bulk`, `/privacy`는 sitemap에서 발견됐으나 점검 시점에는
  `발견됨 - 현재 색인이 생성되지 않음`이었다. `/privacy`는 우선순위 크롤링 대기열에 수동 요청했다.

## Naver Search Advisor

- `https://autohwp.com`을 HTML meta 방식으로 소유 확인했다.
- `sitemap.xml`을 등록했다.
- `/`, `/docs`, `/bulk`, `/privacy` 네 URL을 웹 페이지 수집 요청에 등록했다.
- 신규 사이트이므로 노출·진단·수집 리포트 생성에는 시간이 걸릴 수 있다.

## Brave Search

- 공식 `https://search.brave.com/submit-url`에서 `https://autohwp.com/`을 제출했고 `Success`를 확인했다.
- `robots.txt`는 전체 공개 경로를 허용하고 sitemap을 선언하며, Googlebot User-Agent로도 sitemap이
  `application/xml`로 정상 열렸다. BraveBot을 별도로 차단하는 규칙은 없다.
- 제출은 색인을 보장하지 않는다. 첫 `site:autohwp.com` 후속 확인일은 2026-08-20로 둔다.

## 남은 비동기 확인

1. 2026-08-20 이후 Brave `site:autohwp.com` 노출 확인 및 #33 갱신.
2. GA4 일반 이벤트 처리 후 `ws_document_open` + `result=success` 파생 key event 등록.
3. Google `/docs`·`/bulk`·`/privacy`, Naver 수집/색인 리포트의 자연 처리 상태 재확인.
