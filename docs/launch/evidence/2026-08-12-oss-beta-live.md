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

durable Upstash 게이트는 pass로 전환하지 않는다. 최종 브라우저 퍼널 smoke와 캡처 후
`release_candidate_live_smoke`를 별도 판정한다.
