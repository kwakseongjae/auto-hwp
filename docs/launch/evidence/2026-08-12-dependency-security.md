# Dependency security preflight — 2026-08-12

브랜치 첫 push 직후 GitHub가 기본 브랜치에 open Dependabot alert 9건(High 3, Moderate 6)을 보고했다.
비밀 값이나 사용자 문서는 조회하지 않고 advisory·manifest·버전 범위만 REST API로 분류했다. PR #2가
`main`의 `76cdd8c`로 병합된 뒤 기존 npm/pnpm 경고는 actionable open에서 모두 사라졌다. 전체 이력의
상태는 fixed 11건, auto-dismissed 3건, 아래 `glib` 위험 수용 1건이었다.

## 수정한 8건

| manifest | 패키지 | 종전 | 고정 | 관련 alert |
|---|---|---:|---:|---|
| `services/demo-ai-proxy/package-lock.json` | `undici` | 7.28.0 | 7.29.0 | GHSA 5건(High 1, Moderate 4) |
| `crates/hwp-viewer/ui/pnpm-lock.yaml` | `postcss` | 8.5.15 | 8.5.23 | GHSA 2건(High 1, Moderate 1) |
| `apps/hwp-lab/package-lock.json` | `nanoid` | 3.3.16 | 3.3.17 | GHSA 1건(High) |

재현 가능한 override를 각 package manifest에 명시하고 lockfile을 다시 생성했다. 아래 세 감사는 모두
High/Moderate/Low 포함 **0건**으로 종료했다.

```bash
(cd services/demo-ai-proxy && npm audit --package-lock-only --json)
(cd apps/hwp-lab && npm audit --package-lock-only --json)
(cd crates/hwp-viewer/ui && pnpm audit --json)
```

## Rust `glib` alert #1 판단

- Advisory: `GHSA-wrw7-89jp-8q8g` / `RUSTSEC-2024-0429` (Moderate)
- 경로: Linux Tauri GTK3 전이 의존 `tauri → gtk 0.18 → glib 0.18.5`
- 최신 호환 Tauri를 2.11.5(`tauri-plugin-dialog` 2.7.2)로 올려도 GTK3 계층은 glib 0.18.5를 유지한다.
- `cargo tree --target all -i glib`로 이 경로 하나만 확인했다.
- 저장소와 현재 `tauri`/`wry`/`tao`/`webkit2gtk`/`muda` 소스를 검색해 취약 API
  `VariantStrIter`/`str_iter` 호출이 없음을 확인했다.

따라서 GitHub alert #1은 2026-08-12 `not_used`로 dismiss했다. Tauri GTK 계층이 glib 0.20+를
지원하거나 해당 API가 도달 가능해지면 즉시 재검토한다. 이는 취약 버전이 사라졌다는 주장이 아니라
현재 제품 경로의 비도달성에 근거한 명시적 위험 수용이다.

## 후속 High alert #16 — `quinn-proto`

- Advisory: `GHSA-4w2j-m93h-cj5j` (High, remote memory exhaustion)
- manifest: `Cargo.lock`, 취약 범위 `< 0.11.15`, 최초 수정 버전 `0.11.15`
- PR #2 병합 뒤 REST API 재조회에서 `quinn-proto 0.11.14`가 유일한 actionable open으로 새로 나타났다.
- `cargo tree --locked --target all -i quinn-proto@0.11.15`는 현재 활성 워크스페이스 그래프에 해당
  package ID가 없다고 확인했다. 잠금파일에만 남은 항목이라도 GitHub 정본을 흐리지 않도록 dismiss하지
  않고 `cargo update -p quinn-proto@0.11.14 --precise 0.11.15`로 패치했다.

패치 후 `cargo metadata --locked --no-deps`, `cargo deny check licenses`, `cargo fmt --all --check`,
`cargo check --workspace --all-targets --locked`(11m45s), `scripts/verify-launch.sh --automated`(29/29),
`git diff --check`를 통과했다. lockfile diff는 버전과 checksum만 바뀐다.

## 기본 브랜치 최종 결과

- [PR #4](https://github.com/kwakseongjae/auto-hwp/pull/4)의 `build-test`(6m19s)와
  `licenses`(9m25s)가 [CI run 31530666444](https://github.com/kwakseongjae/auto-hwp/actions/runs/31530666444)에서
  통과했다.
- 보호된 `main`의 merge commit은 `3a1b03011b99f337bb7cd4e6f1de8a1bb46af9da`다.
- GitHub는 alert #16을 merge 5초 뒤인 `2026-08-11T20:09:34Z`에 `fixed`로 재평가했다
  (`dismissed_at=null`).
- 최종 REST API 분류는 fixed 12, auto-dismissed 3, dismissed 1, **open 0**이다.

따라서 actionable Dependabot alert가 없고, 유일한 위험 수용은 위에 근거를 명시한 `glib` #1이다.
`dependency_security` gate를 `pass`로 전환한다. 재조회 명령은 아래와 같다.

```bash
gh api --paginate 'repos/kwakseongjae/auto-hwp/dependabot/alerts?state=open'
```
