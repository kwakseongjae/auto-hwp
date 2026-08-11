# Main branch protection — 2026-08-12

- Repository: `kwakseongjae/auto-hwp`
- Source PR: <https://github.com/kwakseongjae/auto-hwp/pull/2>
- Verified green run: <https://github.com/kwakseongjae/auto-hwp/actions/runs/31527277416>
- Head SHA used to discover check contexts: `b2258e21af5f611d54d2d4b6929afe4e871a9036`

PR #2에서 실제 생성·통과한 GitHub Actions check 이름을 확인한 뒤 REST API로 `main` 보호를 적용했다.
Vercel은 자동 Git 배포를 끈 prebuilt-only 구조이므로 필수 context에 포함하지 않았다.

```json
{
  "strict": true,
  "contexts": ["build-test", "licenses"],
  "required_approving_review_count": 0,
  "enforce_admins": true,
  "required_conversation_resolution": true,
  "allow_force_pushes": false,
  "allow_deletions": false
}
```

승인 수 0은 단일 관리자 저장소에서 PR 경로와 CI를 강제하면서 자기 승인 불가 교착을 피하기 위한 값이다.
보호 적용 직후 `GET /repos/kwakseongjae/auto-hwp/branches/main/protection`으로 위 값을 재조회했다.
