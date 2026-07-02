# 017 — P2b: hwp-mcp wasm화 (편집 레인 개방 — http 피처 게이트 + bytes 표면)

- 상태: **open**
- 우선순위: P2b — **015의 선행 필수** (012의 LEAF 결정이 미룬 "Session-core absorb"의 확정 해법)
- 영역: 아키텍처 / wasm 이식
- 선행: 012 (done). 병렬 가능: 011 (파일 disjoint)
- 레드टीम: R9 잔여 해소. 이 이슈가 완료되면 "absorb → 013" 메모(012 커밋 메시지)는 폐기된다.

## 배경 (2026-07-02 실측 — 이 이슈의 존재 이유)
012는 hwp-session을 LEAF로 추출했다(편집 apply(Intent) 레인은 hwp-mcp 잔류). 이유는
"hwp-mcp가 wasm-unsafe"였는데, 아키텍트 실측 결과 **그 원인이 전부 국소적**임이 확인됐다:
- `getrandom`은 `crates/hwp-mcp/src/server.rs:46` **단 한 곳** (HTTP 토큰 CSPRNG).
- `std::net`(TcpListener)은 `server.rs` + `main.rs`(바이너리)뿐.
- `cargo check -p hwp-core --target wasm32-unknown-unknown` → **exit 0** (rhwp 피처 포함도 exit 0).
- `hwp-ai` 기본 피처 = `[]` (reqwest/keyring 전부 optional) → 기본 빌드 wasm-safe.

즉 **Session/Intent/apply_intent를 옮길 필요가 없다** — HTTP 서버만 피처로 게이트하면
hwp-mcp lib 전체가 wasm-safe가 되고, 015는 008 계약(Intent JSON) + 010 프리뷰 게이트 +
undo/redo를 데스크톱과 동일 시맨틱으로 그대로 소비한다.

## 목표
`cargo check -p hwp-mcp --no-default-features --target wasm32-unknown-unknown` → **exit 0**.
네이티브 셸(viewer/CLI/mcp 바이너리)은 **동작·빌드 완전 무변경**.

## 파일 지도
- `crates/hwp-mcp/Cargo.toml` — getrandom/subtle을 optional로, `http` 피처 신설, `default = ["http"]`
- `crates/hwp-mcp/src/lib.rs` — `#[cfg(feature = "http")] pub mod server;` + open_bytes/export_bytes 표면
- `crates/hwp-mcp/src/main.rs` — 바이너리는 http 필수 (`[[bin]] required-features = ["http"]`)
- `scripts/wasm-smoke.sh`, `docs/WASM-FEASIBILITY.md` — 조합 추가
- 소비자 확인: `crates/hwp-viewer/src/lib.rs`(server::spawn 사용 — default 피처라 무변경이어야 함)

## 구현 단계
1. **Cargo 게이트**: `getrandom = { version = "0.3", optional = true }`, `subtle = { ..., optional = true }`,
   `[features] default = ["http"]`, `http = ["dep:getrandom", "dep:subtle"]`.
   main.rs 바이너리에 `required-features = ["http"]`.
2. **cfg 게이트**: `pub mod server;` → `#[cfg(feature = "http")]`. server를 참조하는 테스트/코드도 동일 게이트.
3. **bytes 표면** (코드는 이미 바이트 기반 — 표면만 노출):
   - `pub fn open_bytes(session: &mut Session, bytes: &[u8], name: &str) -> Result<OpenInfo, String>` —
     기존 `do_open`을 "fs::read 후 open_bytes 호출"로 리팩터(로직 이동 없이 분리).
     `source_path`는 name 힌트로 채운다.
   - `pub fn export_bytes(session: &Session) -> Result<Vec<u8>, String>` — 기존 save 경로의
     `hwp_core::serialize_hwpx` 부분을 분리 노출(atomic_write 없이). save는 export_bytes+write로 재구성.
4. **스모크 갱신**: `scripts/wasm-smoke.sh`에 3조합 추가 — `-p hwp-core`, `-p hwp-core --features rhwp`,
   `-p hwp-mcp --no-default-features`. `docs/WASM-FEASIBILITY.md`에 행 추가(판정 A안 유지 서술).
5. **문서 정합**: `docs/PRODUCT-DIRECTION.md` §2의 다이어그램 주석이 이 이슈로 현실과 일치하는지 확인
   (아키텍트가 이미 §2에 주석을 넣었으면 갱신만).

## 검증
- `cargo check -p hwp-mcp --no-default-features --target wasm32-unknown-unknown` → exit 0
- `cargo test -p hwp-mcp` (기본=http 피처 하에 기존 lib 20 + schema_v0 8 전부 통과 — 보안 술어 포함)
- `cargo check -p hwp-viewer` + `cargo build -p tf-hwp-cli --features "shaper rhwp"` — 무변경 빌드
- 게이트: `cargo run -q -p tf-hwp-cli --features "shaper rhwp" -- layout-check benchmark.hwp` → 8==8
- 신규 테스트: open_bytes로 연 문서가 do_open(path)과 동일 OpenInfo/페이지수; export_bytes == 기존 save 바이트

## 수용 기준
- [ ] hwp-mcp `--no-default-features`가 wasm32에서 exit 0
- [ ] 네이티브 셸 3종(viewer/CLI/mcp 바이너리) 빌드·테스트 무변경 (server 테스트 포함 전부 그린)
- [ ] `open_bytes`/`export_bytes` 공개 + 동등성 테스트
- [ ] wasm-smoke.sh 3조합 추가 + WASM-FEASIBILITY.md 갱신
- [ ] 게이트 8==8 유지

## 함정
- `default = ["http"]`이므로 wasm 소비자(015)만 `default-features = false`로 빼면 된다 —
  기존 소비자의 Cargo.toml을 건드리지 마라(무변경이 수용 기준이다).
- `Intent::Open{path}`/`Export{path}`의 std::fs는 **유지**한다(wasm에서 컴파일은 되고 런타임 트랩 —
  015는 open_bytes/export_bytes를 쓰므로 무해). 삭제/게이트하면 스코프 밖 + 네이티브 파손.
- server.rs의 기존 보안 테스트(rejects_missing_and_wrong_token 등)는 http 피처가 기본이라
  `cargo test -p hwp-mcp`에서 계속 돌아야 한다 — cfg 게이트로 테스트가 조용히 빠지면 실패.
- undo 스냅샷/pending 등 Session 로직은 절대 수정하지 마라 — 이 이슈는 게이트와 표면뿐이다.
