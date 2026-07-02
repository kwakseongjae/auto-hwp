# 007 — P0-A: wasm 스모크 빌드 (코어 크레이트 wasm32 판정)

- 상태: **open**
- 우선순위: P0 (판정 작업 — 이 결과가 015의 아키텍처를 결정한다)
- 영역: 빌드 인프라 / 이식성
- 선행: 없음. 병렬 가능: 008, 009
- 레드팀: **R9** (wasm 미검증 가정)

## 목표
"엔진을 웹에 이식한다"(목표 2 후반)의 최대 리스크는 **컴파일이 되는가**다. 코드를
한 줄도 새로 쓰기 전에, 코어 크레이트들이 `wasm32-unknown-unknown`으로 컴파일되는지
실측하고 **판정 보고서**를 남긴다. 이 이슈의 산출물은 기능이 아니라 **문서와 CI 체크**다.

## 컨텍스트 (지금 코드가 어떻게 생겼나)
- 코어는 의도적으로 dependency-light하게 유지돼 왔다(docs/PIVOT-DESIGN.md: "hwp-export
  순수 Rust, wasm-safe" 설계 원칙):
  - `hwp-model`: thiserror뿐 → 거의 확실히 통과
  - `hwp-typeset`: hwp-model + optional rustybuzz/ttf-parser(둘 다 순수 Rust) → 통과 예상
  - `hwp-render`: + base64 → 통과 예상
  - `hwp-ops`: hwp-model뿐 → 통과 예상
  - `hwp-export`: optional krilla(`pdf` 피처) → **krilla 0.8의 wasm 지원이 관건**
  - `hwp-hwpx`: quick-xml + zip(deflate) → 통과 예상이나 zip의 피처 확인 필요
  - `hwp-ingest` + `hwp-rhwp`(+vendored `external/rhwp`): **HWP5 바이너리 파싱 —
    최대 불확실성**. rhwp는 우리가 수정할 수 없다(불변식 §4.1-3).
- 이미 실패해도 되는 폴백이 있다: 웹 v1 = HWPX 전용(HWP5→HWPX 변환은 서비스(013) 경유).

## 파일 지도
- 각 크레이트 매니페스트: `crates/*/Cargo.toml`
- 판정 보고서(신규): `docs/WASM-FEASIBILITY.md`
- 스모크 스크립트(신규): `scripts/wasm-smoke.sh`

## 구현 단계
1. `rustup target add wasm32-unknown-unknown` (이미 있으면 스킵).
2. 크레이트별로 순서대로 시도하고 결과를 기록:
   ```bash
   cargo check -p hwp-model  --target wasm32-unknown-unknown
   cargo check -p hwp-ops    --target wasm32-unknown-unknown
   cargo check -p hwp-typeset --target wasm32-unknown-unknown
   cargo check -p hwp-typeset --target wasm32-unknown-unknown --features shaper
   cargo check -p hwp-render --target wasm32-unknown-unknown
   cargo check -p hwp-hwpx   --target wasm32-unknown-unknown
   cargo check -p hwp-jsx    --target wasm32-unknown-unknown
   cargo check -p hwp-export --target wasm32-unknown-unknown
   cargo check -p hwp-export --target wasm32-unknown-unknown --features pdf
   cargo check -p hwp-ingest --target wasm32-unknown-unknown
   cargo check -p hwp-rhwp   --target wasm32-unknown-unknown --features rhwp
   ```
3. 실패 크레이트는 **원인 크레이트와 원인 API**(예: getrandom, std::fs, mio)까지 파고들어
   기록한다. 고치려 들지 마라 — 단, cfg-gate 한 줄로 해결되는 자명한 것(예: 우리 크레이트의
   `std::fs` 사용이 테스트 코드에만 있음)은 고쳐도 된다. rhwp는 절대 수정 금지.
4. `scripts/wasm-smoke.sh`로 위 커맨드를 스크립트화(실패 크레이트는 주석으로 명시하고
   통과 세트만 exit 0 조건에 포함).
5. `docs/WASM-FEASIBILITY.md` 작성: 크레이트별 판정표(✅/❌+원인), 그리고 **아키텍처 판정**:
   - A안(전부 통과): 웹 셸이 .hwp를 직접 연다.
   - B안(rhwp 실패, 나머지 통과): 웹 v1 = HWPX 전용, .hwp는 013 서비스가 변환.
   - C안(krilla 실패): PDF export는 서비스 경유, 웹은 뷰/편집만.
   - 판정에 따라 이슈 015의 "전제" 섹션을 갱신하라.

## 검증
- `bash scripts/wasm-smoke.sh` 가 재현 가능하게 동작.
- 기존 네이티브 빌드/테스트에 영향 없음: §4.2 공통 스위트 전부 통과.

## 수용 기준
- [ ] 11개 check 조합 전부에 대해 ✅/❌ + 실패 원인이 `docs/WASM-FEASIBILITY.md`에 기록됨
- [ ] A/B/C 중 아키텍처 판정이 명시되고 015 이슈 문서의 전제가 갱신됨
- [ ] `scripts/wasm-smoke.sh` 존재, 통과 세트에 대해 exit 0
- [ ] 네이티브 게이트/테스트 무손상 (공통 계약 §4.2)

## 함정
- `getrandom`은 wasm에서 `wasm_js` 피처가 필요하다 — 코어에 있으면 안 되는 의존성이니
  발견되면 "누가 끌고 오는지"를 `cargo tree -i getrandom --target wasm32-unknown-unknown`으로 역추적해 기록.
- `zip` crate는 default-features off + deflate만 켜져 있음 — 시간/암호화 피처가 다시 켜지지 않게 주의.
- 여기서 wasm-bindgen 바인딩을 만들기 시작하지 마라. 그건 015다.
