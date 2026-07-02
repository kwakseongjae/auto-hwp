# 012 — P2: `hwp-session` 파사드 추출

- 상태: **open**
- 우선순위: P2 (셸 셋의 공유 기반 — 013/015의 선행)
- 영역: 아키텍처 / 모듈화
- 선행: 008 (스키마 v0). 병렬 가능: 011
- 레드팀: **R10** (추출 중 LOCKSTEP 회귀)

## 목표
`hwp-viewer/src/lib.rs`(2,259줄)의 Tauri 커맨드 안에 갇힌 문서 세션 로직(DTO 조립,
지오메트리 질의, 편집 커밋, export)을 신규 크레이트 **`hwp-session`** 으로 내려,
Tauri(A)/서비스(B)/wasm(C) 세 셸이 **같은 함수**를 감싸게 한다. 이 이슈는
**기능 변화 0의 순수 이동**이다 — 동작이 1픽셀이라도 달라지면 실패.

## 컨텍스트
- 현 구조: `hwp-viewer/src/lib.rs`에 Tauri 커맨드들이 `TableBoxDto`/`BlockStyleDto` 같은
  DTO 정의와 조립 로직, px↔HWPUNIT 변환, `hwp-mcp` Session 호출을 직접 들고 있다.
- `hwp-mcp/src/lib.rs`의 `Session`(문서 상태+undo)은 이미 셸-독립적이다. `hwp-session`은
  이를 감싸는 **렌더·지오메트리·DTO 레이어**가 된다 (Session을 흡수할지 감쌀지는 조사 후
  결정하고 근거를 보고 — 순환 의존이 안 생기는 쪽으로).
- `tf-hwp-cli`도 일부 로직을 중복 보유 — 이동 후 CLI도 hwp-session을 소비하게 정리.

## 파일 지도
- 신규: `crates/hwp-session/` (Cargo.toml + src/lib.rs)
- 이동 원천: `crates/hwp-viewer/src/lib.rs` (DTO/지오메트리/커밋/export 로직)
- 소비자: `crates/hwp-viewer/src/lib.rs`(Tauri 커맨드 → 얇은 위임),
  `crates/tf-hwp-cli/src/main.rs`, (후속) `crates/hwp-mcp`
- 워크스페이스: 루트 `Cargo.toml` members/workspace.dependencies에 등록

## 구현 단계 (반드시 이 순서 — R10 방어)
1. **golden 고정(이동 전)**: 스냅샷 스크립트 `scripts/golden.sh` 작성 —
   ```bash
   cargo run -q -p tf-hwp-cli --features "shaper rhwp" -- layout-check benchmark.hwp
   cargo run -q -p tf-hwp-cli --features "shaper rhwp" -- own-render benchmark.hwp  --out /tmp/g_b.svg
   cargo run -q -p tf-hwp-cli --features "shaper rhwp" -- own-render benchmark1.hwp --out /tmp/g_b1.svg
   shasum /tmp/g_b*.svg   # 해시를 docs/issues/012 작업 로그에 기록
   ```
   layout-check 수치(페이지 수, 줄 정확도)와 SVG 해시가 이동 후에도 **바이트 동일**해야 한다.
2. **크레이트 스캐폴드**: `hwp-session`은 wasm-safe 원칙을 따른다 — `std::fs`·스레드·
   tauri 의존 금지. 파일 열기는 바이트 슬라이스를 받는 API(`open_bytes`)로, 경로 기반
   `open_path`는 `#[cfg(feature = "fs")]` 뒤에.
3. **슬라이스 단위 이동** (한 번에 전부 옮기지 마라). 각 슬라이스 후 golden 재확인:
   - S1: DTO 타입들(TableBoxDto, BlockStyleDto, CharFmt …) + 순수 변환 함수
   - S2: 지오메트리 질의(own_hit_test/table_at/table_bbox/image_at/block_at)
   - S3: 편집 커밋 경로(runs 커밋, range fmt/shade, px→HWPUNIT 변환 지점 포함)
   - S4: export(html/pdf) 진입점
   - S5: Tauri 커맨드를 전부 1~3줄 위임으로 축소, CLI 중복 제거
4. **공개 API 문서화**: lib.rs 상단 rustdoc에 세 셸이 쓰는 표면(open→pages→svg(n)→
   hit_test→apply(Intent)→export)을 요약. 이것이 015 wasm 바인딩의 표면이 된다.

## 검증
- 각 슬라이스마다: 공통 스위트(§4.2) + golden 해시 동일.
- 최종: 앱 수동 스모크(열기→마킹→편집→export), `cargo test --workspace`.

## 수용 기준
- [ ] `hwp-session` 크레이트 존재, tauri/fs 비의존(fs는 피처 게이트)
- [ ] viewer의 Tauri 커맨드가 전부 얇은 위임 (로직 잔존 0 — grep으로 확인 가능해야)
- [ ] CLI가 중복 로직 대신 hwp-session 소비
- [ ] golden: layout-check 수치 + own-render SVG 해시가 이동 전과 **동일**
- [ ] `cargo check -p hwp-session --target wasm32-unknown-unknown` 통과 (007 판정과 정합)

## 함정
- **이동 중 "개선" 금지.** 버그를 발견하면 고치지 말고 TODO 주석+보고. 이동과 수정이
  섞이면 golden 불일치의 원인을 못 찾는다.
- px↔HWPUNIT 변환 지점이 이동 중 이중 적용/누락되기 쉽다(공통 계약 §4.1-5). 변환은
  hwp-session의 경계(입출력 DTO)에서 한 번만 하도록 위치를 명시하라.
- Tauri의 async 커맨드/State 관리는 viewer에 남긴다 — hwp-session은 동기 순수 로직만.
  (락/스레딩을 크레이트에 넣으면 wasm이 깨진다.)
