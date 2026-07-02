# 014 — P3-pre: 신뢰불가 입력 하드닝 (파서 DoS 방어)

- 상태: **open**
- 우선순위: P3 선행 (013 착수 전 완료 필수)
- 영역: 보안 / 파서 견고성
- 선행: 없음 (011/012와 병렬 가능)
- 레드팀: **R4** (신뢰불가 HWP 입력 DoS/패닉)

## 목표
지금까지 파서는 "내 문서"만 열었다. 서비스(013)와 웹(015)은 **인터넷에서 온 임의
파일**을 연다. zip bomb(HWPX), 깊은 중첩 표, 손상 CFB, 거대 이미지가 프로세스를
죽이거나(패닉) 매달리게(OOM/무한루프) 하면 서비스 전체 장애다. 목표: **어떤 입력도
"빠른 명시적 에러"로 끝난다** — 절대 패닉·OOM·행이 아니라.

## 컨텍스트
- HWPX 파싱: `hwp-hwpx`(quick-xml + zip). HWP5: `hwp-rhwp` → vendored `external/rhwp`
  (**수정 금지** — 방어는 어댑터 경계에서).
- HTTP 레이어엔 요청 1MiB 상한과 connection당 catch_unwind가 이미 있다
  (`hwp-mcp/src/server.rs`). 그러나 문서는 파일 경로로 열리므로 그 상한과 무관하다.
- 이 이슈는 **경계 방어**다. 파서 내부 로직 수정은 최소화하고, 진입점에서 막는다.

## 파일 지도
- `crates/hwp-hwpx/src/*` — HWPX(zip) 진입점: 압축 해제 상한
- `crates/hwp-rhwp/src/*` — HWP5 어댑터 경계: catch_unwind + 사이즈 상한
- `crates/hwp-ingest/src/*` — 공통 open 경로가 있으면 거기에
- 신규 픽스처: `crates/hwp-hwpx/tests/fixtures/hostile/` + 테스트 `hostile_inputs.rs`

## 구현 단계
1. **상한 상수(하나의 모듈에 집중)**: `MAX_RAW_FILE`(기본 64MiB), `MAX_DECOMPRESSED_TOTAL`
   (기본 256MiB), `MAX_ENTRY_COUNT`(zip 항목 수), `MAX_TABLE_NESTING`(기본 8),
   `MAX_PARAGRAPHS`(기본 200k). 전부 명시적 에러 enum variant로 실패
   (`DocLimit::DecompressedTooLarge` 식) — 문자열 에러 금지(서비스가 코드로 구분해야 함).
2. **HWPX**: zip 순회 시 항목별·누적 해제 바이트를 세며 상한 초과 즉시 중단
   (zip bomb — 선언된 크기를 믿지 말고 실제 해제 바이트를 세라). XML 깊이는 quick-xml
   이벤트 루프에서 depth 카운터로.
3. **HWP5(rhwp 경계)**: 어댑터 호출을 `std::panic::catch_unwind`로 감싸 패닉→명시 에러
   변환(rhwp 내부는 못 고치므로 이것이 유일한 방어). 입력 바이트 상한은 호출 전에.
4. **레이아웃 상한**: 신뢰불가 문서가 파싱을 통과해도 레이아웃에서 터질 수 있다
   (거대 표·수십만 문단). `place_doc`/`NaiveLayout` 진입 전에 문단·블록 수를 검사하는
   guard를 **호출자(session/서비스) 레벨**에 둔다 — typeset 내부를 건드리면 LOCKSTEP
   리스크(§4.1-2)가 생기니 내부 수정은 금지.
5. **적대 픽스처 제작**: 스크립트로 생성(리포에는 생성 스크립트+작은 산출물만):
   zip bomb(중첩 아님, 고압축 단일 항목), 깊이 100 중첩 표 HWPX, 손상 CFB 헤더,
   트렁케이트된 파일, 항목 10만 개 zip. 각각 "명시 에러 + 1초 이내 반환"을 테스트로 고정.
6. **(가능하면) cargo-fuzz 스캐폴드**: `fuzz/` 타깃 1개(HWPX open). CI 상시 실행은 스코프
   밖 — 타깃과 실행 방법 문서화까지만.

## 검증
- `cargo test -p hwp-hwpx --test hostile_inputs` 신규 통과.
- 공통 스위트(§4.2) 전부 그린 — **정상 문서(benchmark, benchmark1, 오라클 코퍼스)가
  새 상한에 걸리지 않는 것**이 이 이슈의 절반이다. 상한값이 정상 코퍼스 최대치의
  10배 이상 여유인지 수치로 보고하라.

## 수용 기준
- [ ] 상한 5종이 단일 모듈 상수로 존재, 전부 typed 에러로 실패
- [ ] 적대 픽스처 5종 전부 "명시 에러 + 즉시 반환" (테스트 고정)
- [ ] rhwp 경계 catch_unwind (rhwp 원본 무수정)
- [ ] 정상 코퍼스 전체 무영향 (게이트 포함)
- [ ] 상한값 근거(정상 코퍼스 실측 대비 배율) 보고

## 함정
- catch_unwind는 abort 패닉 전략에서 무력하다 — 워크스페이스 프로파일이 `panic=abort`가
  아닌지 확인하고, 맞다면 서비스 빌드 프로파일에서만 unwind로.
- 상한을 typeset 내부에 넣고 싶어질 것이다 — 참아라. place_doc과 NaiveLayout 중
  한쪽에만 들어가면 페이지 수가 어긋난다(LOCKSTEP). 방어는 진입 전 guard로.
- zip 항목의 `size()` 선언값은 공격자가 조작한다. 반드시 실제 읽은 바이트를 세라.
