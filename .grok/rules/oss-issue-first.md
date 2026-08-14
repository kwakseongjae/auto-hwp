# Issue-first

auto-hwp is public. Do not edit or push `main`. Search or open a GitHub issue,
branch from `origin/main` as `docs|fix|feat/issue-<n>-<slug>`, and put
`Closes #<n>` in the PR body.

Required checks: `issue-link`, `build-test`, `licenses`. Merge only when they
are green and review threads are resolved, then delete the branch. Deploy only
a protected `main` SHA. No user documents, PII, or `corpus/private` in
issues/PRs/CI.

Load `.grok/skills/oss-issue-first/SKILL.md` before the first edit.
Follow `CONTRIBUTING.md` and `AGENTS.md` if they add more constraints.
