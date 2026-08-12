# 오픈소스 공개 베타 RC·배포 증거 — 2026-08-12

## 동일 RC 고정

- PR: https://github.com/kwakseongjae/auto-hwp/pull/9
- PR 필수 CI: `build-test` 6m17s, `licenses` 2m49s — 모두 pass
- 보호된 main merge / RC SHA: `31f205f8355df892d9a7233b2c8b4eeb432bb13e`
- 태그: `oss-launch-2026.08.12` → 위 SHA
- GitHub prerelease: https://github.com/kwakseongjae/auto-hwp/releases/tag/oss-launch-2026.08.12

## 프로덕션 배포

- workflow: https://github.com/kwakseongjae/auto-hwp/actions/runs/31593516444
- workflow ref/head SHA: `oss-launch-2026.08.12` / `31f205f8355df892d9a7233b2c8b4eeb432bb13e`
- Vercel deployment: https://auto-516wum9vd-kwakseongjaes-projects.vercel.app
- production alias smoke: `GET / → 200`, `GET /og.png → 200`, canonical=`https://autohwp.com`

## 라이브 자동 smoke 1차

`LAUNCH_BASE_URL=https://autohwp.com`에서 launch Playwright 6개 중 4개가 통과했다.

- pass: `/llms.txt` 링크 계약
- pass: 에이전트 정본·privacy·검색 표면 200
- pass: 보안 헤더
- pass: Docs 에이전트 프롬프트 발견·복사
- expected beta exception: rate-limit은 소유자 결정대로 `memory`, `durable=false`, `configured=false`
- test assertion mismatch: 푸터 privacy 링크가 2개라 정확히 1개를 요구하는 테스트가 실패했다. 링크 부재나
  404가 아니라 중복 진입점이며, 라이브 수동 확인과 테스트 보정이 필요하다.

## 인앱 브라우저 실제 문서 퍼널

- `https://autohwp.com` 랜딩에서 집단지성 3단계 기여 섹션과 실제 화면 이미지를 확인했다.
- **내 문서로 확인하기** → **예시 샘플**을 눌러 실제 `.hwp`가 8개 SVG 페이지로 렌더되는 것을 확인했다.
- 편집 화면의 **레이아웃 문제 제보** 링크가 GitHub 새 이슈 초안을 가리키는 것을 확인했다.
- URL을 디코딩해 샘플 파일명(`sample-8p`, `benchmark.hwp`), 문서 본문 대표 문자열, 장문 해시가
  포함되지 않았음을 확인했다. 제목은 형식만 담은 `[조판] 브라우저 렌더 차이 (.hwp)`다.
- 캡처:
  - `assets/launch/live-production-contribution.png`
  - `assets/launch/live-production-document.png`
  - `assets/launch/live-production-contribution-flow.mp4` — 인앱 브라우저 실제 프레임 88장, 22초, 1280×720

따라서 `release_candidate_live_smoke`는 pass다. durable Upstash 게이트만 pass로 전환하지 않으며,
프로젝트 단계도 `beta-live`를 유지한다.
