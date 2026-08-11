# Dependency security preflight — 2026-08-12

브랜치 첫 push 직후 GitHub가 기본 브랜치에 open Dependabot alert 9건(High 3, Moderate 6)을 보고했다.
비밀 값이나 사용자 문서는 조회하지 않고 advisory·manifest·버전 범위만 REST API로 분류했다.

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

## 남은 확인

npm alert 8건은 이 브랜치의 lockfile 수정이 `main`에 병합된 뒤 GitHub가 closed로 재평가해야 한다.
그 전까지 `dependency_security`는 `pending`이며, 병합 후 open alert가 0인지 REST API로 재조회한 뒤
이 문서에 결과를 추가하고 gate를 `pass`로 바꾼다.
