# autohwp.com 검색 등록 운영 절차

정본 이슈: Google #31, Naver #32, Brave #33. 등록·소유권 인증·사이트맵 제출·실제 색인은 서로 다른
상태다. “제출됨”을 “색인됨”으로 기록하지 않는다.

## 공통 사전 조건

- `https://autohwp.com/robots.txt` 200, `/api/`와 `/d/`만 disallow
- `https://autohwp.com/sitemap.xml` 200
- canonical은 `https://autohwp.com/`
- 인증 값은 Git에 커밋하지 않고 Vercel Production env로만 주입

## Google Search Console — HTML tag

1. URL-prefix property `https://autohwp.com/`을 추가한다.
2. HTML tag 방식에서 `content` 값만 복사한다.
3. Vercel Production의 `NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION`에 넣고 배포한다.
4. 라이브 `<head>`에 `name="google-site-verification"` meta가 정확히 한 개 있는지 확인한다.
5. Search Console에서 Verify한다. 인증 뒤에도 환경변수와 meta를 제거하지 않는다.
6. `/sitemap.xml`을 제출하고 주요 URL을 URL Inspection으로 확인한다.

## Naver Search Advisor — HTML tag

1. `https://autohwp.com`을 사이트로 추가한다.
2. HTML 태그 방식에서 `content` 값만 복사한다.
3. Vercel Production의 `NEXT_PUBLIC_NAVER_SITE_VERIFICATION`에 넣고 배포한다.
4. 라이브 `<head>`에 `name="naver-site-verification"` meta가 정확히 한 개 있는지 확인한다.
5. 소유 확인 후 sitemap URL을 제출하고 Yeti 수집 상태를 확인한다.

## Brave Search

1. 공식 Submit URL에서 `https://autohwp.com/`을 제출한다.
2. CAPTCHA는 소유자가 직접 완료한다.
3. 제출 시각과 결과를 기록하고, 후속 날짜에 `site:autohwp.com` 결과를 확인한다.

## 증거 형식

`docs/launch/evidence/YYYY-MM-DD-search-registration.md`에 property, 인증 방식, 제출 URL, 콘솔 결과,
후속 점검 날짜를 기록한다. 계정 이메일·verification token·쿠키·스크린샷의 개인정보는 남기지 않는다.
