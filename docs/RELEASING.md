# 릴리스 순서 — npm 패키지 4종

npm 발행은 GitHub Actions 의 `publish.yml`(수동 실행)에서만 일어난다(Trusted Publishing). 그 첫 단계가 **같은 커밋의 전체 e2e
성공 기록**을 요구한다(#549 — 화면 시험 하나가 빨간 채로 0.0.22 가 발행됐던 일).

## 순서

1. **로컬 게이트**: `scripts/verify-local.sh --full` 이 끝까지 초록. (Rust · wasm · JS · vitest · e2e · 조판 오라클)
2. **버전 · CHANGELOG**: 네 패키지 버전을 함께 올리고 `CHANGELOG.md` 의 `[Unreleased]` 를 새 버전 절로 옮긴다(머리의 버저닝 정책).
   이 변경을 PR 로 main 에 머지한다.
3. **전체 e2e(CI)**: 발행할 커밋에서 `e2e.yml` 을 돌리고 초록을 확인한다.

   ```bash
   SHA="$(git rev-parse origin/main)"   # git fetch 뒤 — 발행할 바로 그 커밋
   gh workflow run e2e.yml --ref main
   # 방금 낸 실행이 목록에 뜰 때까지 기다린 뒤, 그 커밋의 수동 실행만 골라 지켜본다
   # (--limit 1 만 쓰면 dispatch 직후엔 직전 실행 — 다른 커밋의 초록일 수 있다 — 을 잡는다)
   until RUN="$(gh run list --workflow e2e.yml --commit "$SHA" --event workflow_dispatch --limit 1 --json databaseId --jq '.[0].databaseId // empty')" && [ -n "$RUN" ]; do sleep 5; done
   gh run watch "$RUN" --exit-status
   ```

   빨가면 발행하지 않는다. 실패한 시험을 끄거나 건너뛰게 표시하지 말고 고친 뒤 다시 1부터 한다.

4. **발행 연습**: `gh workflow run publish.yml --ref main -f dry_run=true` — 첫 단계 「e2e gate」에 경고가 없고, 네 패키지의
   `npm publish --dry-run` 이 통과하는지 본다.
5. **발행**: `gh workflow run publish.yml --ref main -f dry_run=false`. 같은 커밋(3 에서 초록인 그 커밋)이어야 한다 — main 에
   그 사이 다른 커밋이 머지됐다면 3 부터 다시.

## e2e 관문이 보는 것

- `scripts/e2e-gate.mjs` 가 GitHub API 로 `e2e.yml` 의 실행 가운데 **발행하는 커밋(`GITHUB_SHA`)과 같은 커밋 · 완료 · 성공**인 것을 찾는다.
- 없으면(다른 커밋의 성공만 있음 · 실패 · 진행 중 · 기록을 읽지 못함) 실제 발행은 아무것도 하지 않고 멈춘다. dry-run 은 경고 줄만 남기고 계속한다.
- 근거로 삼는 것은 이 저장소의 **수동 실행(`workflow_dispatch`)** 뿐이다. 통과 줄(`::notice::`)에 그 실행 주소와 시도 횟수를 남긴다 — 재실행으로 받은 초록이면 그렇게 적힌다.
- dry-run 인지는 발행 단계와 같게 읽는다: `dry_run` 이 정확히 `true` 일 때만 dry-run 이다.
- 판단은 `scripts/tests/e2e-gate.test.mjs` 가 고정한다(CI `build-test` · `verify-local.sh` 에서 돈다).
