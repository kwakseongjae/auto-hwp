# Contributing to auto-hwp

기여 환영합니다. 이 프로젝트는 **정확도 게이트가 CI보다 우선**하는 코드베이스입니다 —
아래 불변식을 깨는 PR은 아무리 좋아 보여도 머지되지 않습니다.

## 개발 환경

```bash
# Rust (stable) + wasm 타깃 + Node 20+ / pnpm
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli
brew install binaryen   # wasm-opt (선택 — 번들 다이어트)

git clone --recurse-submodules https://github.com/kwakseongjae/auto-hwp
# external/rhwp 서브모듈이 필수입니다 (파싱 부트스트랩, MIT)
```

## 검증 — 푸시 전 필수

```bash
scripts/verify-local.sh          # quick: fmt·clippy·전체 테스트·게이트·wasm 위생·licenses
scripts/verify-local.sh --full   # + wasm 재빌드·JS 빌드/vitest·e2e — crates/packages 접촉 시 필수
```

CI(GitHub Actions)는 수동 트리거 전용입니다 — **로컬 verify가 정본**입니다.

## 조판 이슈 기여

**가장 필요한 기여는 코드가 아니라 "내 문서에서 어긋난 수치"입니다.**
HWP 조판 결과는 공개 규격만으로 재현할 수 없습니다 — 기준은 한/글의 실제 동작이고,
그 동작은 문서마다 다르게 드러납니다. 우리가 가진 벤치(`benchmarks/*.hwp` + 로컬 실물셋)로는
보이지 않는 격차가 여러분의 양식 하나에 들어 있을 수 있습니다.

### 1) 로컬 벤치 돌리기 — 문서는 컴퓨터를 벗어나지 않습니다

```bash
cp ~/Downloads/사업계획서_양식.hwp benchmarks/local/   # 이 폴더는 .gitignore
scripts/bench-local.sh
```

한/글은 파일 안에 **자기가 조판한 결과**(lineseg — 문단별 줄 수·줄 좌표)를 같이 저장합니다.
`bench-local.sh` 는 그 저장값을 정답지로 삼아 우리 조판과 대조합니다 —
**한/글 설치본도, 인터넷도, 계정도 필요 없습니다.** 스크립트는 네트워크를 호출하지 않습니다.

출력은 문서별 판정 표입니다.

| 판정 | 뜻 |
|---|---|
| `일치` | 쪽수 동일 + 본문 줄 정확 일치 98.9%+ (게이트 기준선) |
| `줄격차` | 쪽수는 맞는데 문단 줄 나눔이 다름 — 가로 조판 정밀도 축 |
| `쪽격차` | 페이지 수가 다름 — 세로 공간 계산 축(영향 가장 큼) |
| `오라클없음` | 파일에 lineseg 캐시가 없음(변환·정규화본). **점수를 매기지 않습니다** |
| `실패` | 파싱/조판 자체가 실패 — 조판 이슈가 아니라 버그 리포트 |

```bash
scripts/bench-local.sh --pipeline   # 조판 대신 "크래시 없이 통과하는가" (bench-corpus.sh 위임)
scripts/bench-local.sh --dir <경로>  # 다른 폴더를 잰다
```

### 2) 격차를 찾으면 — 문서가 아니라 수치를 올립니다

스윕 마지막에 **이슈에 붙여넣기용 마크다운 표**가 출력됩니다. 그걸 들고
[`layout-gap` 이슈 템플릿](.github/ISSUE_TEMPLATE/layout-gap.md)으로 오세요.

> **문서 파일은 첨부하지 마세요.** 공문서·양식은 재배포 규율이 걸려 있고,
> 작성 완료본에는 개인정보가 들어 있습니다. 수치(쪽수 Δ·줄 일치율)와
> 구조 특징(다쪽 표·중첩 표·각주·어울림 그림·머리말…)이면 재현 가설을 세울 수 있습니다.

공개 배포된 정부 양식이라 출처 URL 을 적을 수 있으면 큰 도움이 됩니다 — 우리가 같은 파일을
받아 재현할 수 있기 때문입니다(`corpus/GOV-SOURCES.md` 참조).

### 3) 민감 문서 규율

- `benchmarks/local/` · `corpus/private/` 는 둘 다 **gitignore** 입니다. 절대 커밋되지 않습니다.
- 작성 완료본(실데이터 포함)은 **공개 코퍼스로 승격하지 않습니다.** 로컬 검증 전용입니다.
- 실물이 없는 환경(CI·다른 기여자)에서 그 문서를 쓰는 게이트는 점수를 꾸며내지 않고
  **명시적으로 skip** 합니다 (`scripts/verify-local.sh` 의 modu-startup·bizinfo 게이트 참조).
- 조판을 고치는 PR 은 이 로컬 격차가 아니라 **공개 게이트의 before==after** 로 판정됩니다
  (아래 불변식 1). 로컬 벤치는 결함을 **찾는** 도구지 머지 기준이 아닙니다.

## 불변식 (위반 = 작업 실패)

1. **게이트**: `layout-check` 기준 `benchmarks/benchmark.hwp` **8==8** 페이지,
   `benchmark1.hwp` **18==18** 페이지, 줄바꿈 일치율 98.9%+ 유지. 조판기(`hwp-typeset`)를
   건드리는 변경은 반드시 게이트 before==after를 증명해야 합니다.
2. **LOCKSTEP**: `place_doc`(crates/hwp-typeset/src/place.rs)과 `NaiveLayout`(lib.rs)의
   페이지 수는 항상 일치해야 합니다 — 한쪽만 고치지 마세요.
3. **rhwp는 파싱 전용**: `external/`은 vendored 수정 금지. 렌더는 항상 우리 IR(SemanticDoc)에서.
4. **단위 규율**: 지오메트리 커맨드 = px(=HWPUNIT/75), ops 커밋 = HWPUNIT.
   변환은 `packages/editor-core/src/units.ts` 단일 지점에서만.
5. **round-trip moat**: 편집하지 않은 HWPX 콘텐츠는 바이트 그대로 재직렬화되어야 합니다.
   렌더 전용 복원(테두리 복원·레이아웃 정리 등)은 render-IR만 만지고 저장 바이트에 닿지 않습니다.
6. **Intent 스키마 v0**: additive 확장만 + unknown field 명시적 거부.

## 함정 (자주 걸림)

- **crates(Rust) 변경 후 wasm pkg 재빌드 필수**:
  ```bash
  cargo build -p hwp-wasm --release --target wasm32-unknown-unknown
  wasm-bindgen --target web --out-dir packages/engine/pkg target/wasm32-unknown-unknown/release/hwp_wasm.wasm
  node apps/hwp-lab/scripts/copy-wasm.mjs && rm -rf apps/hwp-lab/.next
  ```
  스테일 wasm은 신규 Intent를 "unknown variant"로 조용히 거부합니다.
- e2e 전 `rm -rf apps/hwp-lab/.next` — 웹팩 캐시가 dist 재빌드를 감지하지 못합니다.
- 앱은 `packages/*/dist`(컴파일 산출물)를 소비합니다 — 소스만 고치면 스테일 dist가 실립니다.
  `pnpm -C packages/<p> build` 후 확인하세요.
- `cargo fmt`는 강제입니다 — fmt-dirty 커밋은 다음 verify에서 걸립니다.

## 아키텍처 지도

```
React UI (@auto-hwp/react: HwpWorkspace + overlays)          ← 선택 레이어
 → editor-core (@auto-hwp/editor-core: headless selection/edit/session)
  → EngineAdapter 27메서드 (adapter.ts)                     ← 자체 에디터는 여기에 연결
   → WasmAdapter(웹) | TauriAdapter(데스크톱) — 같은 계약
    → @auto-hwp/engine (wasm): SemanticDoc + 조판 + SVG/HTML/PDF/HWPX
```

레이어 계약 상세는 `docs/SDK-LAYERS.md`, 임베드는 `docs/EMBED-GUIDE.md`,
편집 프로토콜은 `docs/INTENT-SCHEMA.md`를 보세요.

## 라이선스

기여물은 Apache-2.0 라이선스로 제출됩니다 ([LICENSE](./LICENSE)).
