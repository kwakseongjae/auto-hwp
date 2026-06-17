# tf-hwp

자체 엔진으로 **.hwp / .hwpx → 원본 그대로 뷰 → 수정 → .hwpx export**.
포맷 중립 시맨틱 모델(`SemanticDoc`) 기반. 레이아웃/렌더는 rhwp(MIT)를 *교체 가능한 부트스트랩*으로 벤더링하고, **HWPX 직렬화·round-trip 안전·AI op-bus·한국어 타이포그래피**는 직접 소유한다.

- 계획: [PLAN.md](./PLAN.md) · 체크리스트: [CHECKLIST.md](./CHECKLIST.md) · **로드맵: [ROADMAP.md](./ROADMAP.md)**
- AI 레이어 + 터미널→Tauri 제어 계획: [docs/AI-LOCAL-CONTROL-PLAN.md](./docs/AI-LOCAL-CONTROL-PLAN.md)
- 의존성/Build-vs-Own 전략: [docs/DEPENDENCY-STRATEGY.md](./docs/DEPENDENCY-STRATEGY.md)
- fidelity 검증(원본 그대로 게이트): [docs/FIDELITY.md](./docs/FIDELITY.md) — 기준: 루트 `benchmark.hwp`
- 라이선스 정책: [docs/LICENSE-POLICY.md](./docs/LICENSE-POLICY.md)

## 워크스페이스 구조 (능력 = trait, 구현 = 교체 가능)

| crate | 역할 | 상태 |
|---|---|---|
| `hwp-model` | SemanticDoc AST + capability traits + provenance/passthrough/dirty | 골격(핵심 타입) |
| `hwp-ingest` | 포맷 탐지(OLE/CFB vs ZIP+OWPML) | 동작 |
| `hwp-hwpx` | HWPX 컨테이너 read + 텍스트 추출 + **자체 HWPX export 계약** | 부분 동작 |
| `hwp-typeset` | 타이포/레이아웃 엔진 (자간/장평/배분·나눔/금칙) | trait + naive |
| `hwp-render` | PageLayerTree paint IR + 백엔드 | 골격 |
| `hwp-ops` | typed edit op-bus + undo/redo | 골격 |
| `hwp-ai` | AST↔Markdown projection + op 제안 + MCP | 골격 |
| `hwp-crypto` | 배포용/비밀번호 복호 (Phase 5+) | 골격 |
| `hwp-rhwp` | rhwp 부트스트랩 어댑터 (feature-gated, 없어도 컴파일) | 어댑터 골격 |
| `hwp-oracle` | LibreOffice+H2Orestart 정합성 오라클 (native) | 동작(soffice) |
| `hwp-core` | 능력 레지스트리/파사드 (구현 조립) | 동작 |
| `hwp-fidelity` | benchmark 중심 "원본 그대로" 검증 하베스 | 골격(포맷 게이트 동작) |
| `tf-hwp-cli` | CLI: info/detect/extract-text/oracle/fidelity | 동작 |

## 빌드 / 실행 (Phase 0)
```bash
cargo build
cargo run -p tf-hwp-cli -- detect <file>
cargo run -p tf-hwp-cli -- info <file.hwpx>
cargo run -p tf-hwp-cli -- extract-text <file.hwpx>
cargo run -p tf-hwp-cli -- oracle <file>        # soffice 변환(설치 필요, 현대 HWP는 H2Orestart 확장 필요)
cargo run -p tf-hwp-cli -- fidelity             # benchmark.hwp 원본-그대로 게이트 전제조건/상태

# 순수 코어의 wasm 위생 확인
cargo check -p hwp-model -p hwp-ops -p hwp-ingest --target wasm32-unknown-unknown
```

## 원본 그대로(fidelity) 검증
루트 `benchmark.hwp`로 검증한다(→ [docs/FIDELITY.md](./docs/FIDELITY.md)). 게이트 활성화:
```bash
./scripts/install-h2orestart.sh     # 오라클이 현대 HWP를 열도록(H2Orestart 확장)
./scripts/vendor-rhwp.sh            # 엔진 렌더 부트스트랩
cargo test -p hwp-fidelity -- --ignored
```

## rhwp 부트스트랩 (vendored, feature-gated)
`external/rhwp`는 fork(`kwakseongjae/rhwp`) 서브모듈(v0.7.15). 클론 후:
```bash
git submodule update --init external/rhwp     # (또는 ./scripts/vendor-rhwp.sh)
cargo run -p tf-hwp-cli --features rhwp -- render benchmark.hwp --page 0 --out page0.svg
```
- `--features rhwp` 없으면 rhwp는 **컴파일되지 않음**(기본 빌드 빠름). 단, 서브모듈은 cargo resolve를 위해 존재해야 함.
- `hwp-rhwp`가 trait 뒤 in-process 어댑터(`DocumentCore` → `page_count`/`render_page_svg`). rhwp의 HWPX/HWP **save는 사용 안 함**(issue #196) — HWPX 직렬화는 `hwp-hwpx`가 소유.
- ✅ 검증: `benchmark.hwp` 8페이지 충실 렌더(표·병합셀·한국어 타이포).
