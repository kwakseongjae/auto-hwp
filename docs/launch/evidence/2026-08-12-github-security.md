# GitHub 보안 설정 증거 — 2026-08-12

- 저장소: <https://github.com/kwakseongjae/auto-hwp>
- 검증 시각: `2026-08-11T17:11:58Z` (`2026-08-12 02:11:58 KST`)
- 수행 계정: 저장소 관리자 `kwakseongjae`

GitHub REST API로 다음 상태를 다시 읽어 확인했다.

| 항목 | 결과 |
|---|---|
| 공개 저장소 | `visibility=public` |
| Private vulnerability reporting | `enabled=true` |
| Vulnerability alerts | enabled (API 성공) |
| Automated security fixes | `enabled=true`, `paused=false` |
| Dependabot security updates | `enabled` |
| Secret scanning | `enabled` |
| Secret scanning push protection | `enabled` |

관리 화면: [Security settings](https://github.com/kwakseongjae/auto-hwp/settings/security_analysis) ·
[Private vulnerability reporting](https://github.com/kwakseongjae/auto-hwp/security/advisories/new)

`secret_scanning_non_provider_patterns`와 `secret_scanning_validity_checks`는 현재 GitHub가 이 저장소에
노출한 기본 기능 범위에서 disabled다. 공급자 패턴 secret scanning과 push protection은 활성화돼 있어
이번 런칭 P0의 비밀 유입 차단 조건을 충족한다.

같은 시각 `main` branch protection은 아직 404(`Branch not protected`)였다. 이는 별도
`branch_protection` 게이트이며, 새 PR CI의 실제 check context가 생성된 뒤 이름을 고정해 활성화한다.
