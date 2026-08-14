---
name: oss-issue-first
description: >
  auto-hwp is public. Every code or docs change starts with a GitHub issue,
  then an issue branch, then a PR whose body contains Closes #<n>. Use when
  implementing, fixing, writing docs, committing, opening a PR, or when the
  user says 진행/ㄱㄱ/파이프라인/오픈소스니까/실제 작업 in this repo.
---

Follow `CONTRIBUTING.md` §이슈에서 시작하는 개발 흐름 and `AGENTS.md` §정식 오픈소스 작업 프로토콜.

1. Search or create a public issue (no user documents, no secrets).
2. Branch from `origin/main`. Do not commit `main`.
3. PR body must include `Closes #<issue>`. Required checks: `issue-link`, `build-test`, `licenses`.
4. Verify with `scripts/verify-local.sh` (use `--full` if crates or packages changed).
5. Merge only with green checks and resolved review threads. Delete the branch. Deploy only a protected `main` SHA.
