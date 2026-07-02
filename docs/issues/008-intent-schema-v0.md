# 008 — P0-B: Intent 스키마 v0 동결 + 버저닝

- 상태: **open**
- 우선순위: P0
- 영역: 프로토콜 / API 계약
- 선행: 없음. 병렬 가능: 007, 009
- 레드팀: **R11** (전방 호환), R5 보조(화이트리스트가 인젝션 방어의 뼈대)

## 목표
"코어 하나, 셸 셋"의 계약은 **Intent JSON**이다. 외부 소비자(business_plan_k,
에르메스, 웹 SDK)가 붙기 시작하면 깨는 변경이 불가능해지므로, 붙기 **전에**
(1) 현재 Intent 표면을 전수 조사해 문서로 동결하고, (2) 버전 필드와 에러 계약을
넣는다. 새 프로토콜을 발명하지 마라 — **지금 있는 것을 명문화**하는 작업이다.

## 컨텍스트
- Intent 레이어는 `crates/hwp-mcp/src/lib.rs`에 있다(예: `SetCellRangeShade`,
  `SetCellRangeFmt` 등). Intent → `hwp-ops::Op` 로 내려간다.
- MCP 툴 표면: `open_document` / (컨텍스트 조회) / `apply_content` / `save` / `undo`/`redo`
  (`crates/hwp-mcp/src/lib.rs`의 tools/list 참조).
- Tauri 셸은 자체 커맨드(`hwp-viewer/src/lib.rs`)로 같은 ops를 호출한다 — 이 중복은
  012가 해소한다. 008은 **스키마 문서·버전·테스트**만 담당.

## 파일 지도
- Intent enum + 디스패치: `crates/hwp-mcp/src/lib.rs`
- Op enum: `crates/hwp-ops/src/lib.rs`
- 스키마 문서(신규): `docs/INTENT-SCHEMA.md`
- 스키마 스냅샷 테스트(신규): `crates/hwp-mcp/tests/schema_v0.rs`

## 구현 단계
1. **전수 조사**: `hwp-mcp`의 모든 Intent variant와 각 필드(이름/타입/단위/필수 여부)를
   추출한다. 단위가 HWPUNIT인지 px인지 mm인지 **필드마다** 명시(공통 계약 §4.1-5 참조).
2. `docs/INTENT-SCHEMA.md` 작성:
   - 헤더: `intent_version: 0` 규약 — 요청 envelope에 선택 필드로 받고, 없으면 0으로 간주.
   - Intent별 섹션: JSON 예제 1개 + 필드표 + 실패 모드(어떤 에러 문자열/코드가 오는가).
   - **호환성 정책 명문**: unknown Intent/unknown field는 **명시적 에러로 거부**(조용한
     무시 금지 — 에이전트가 오타를 성공으로 오인하는 것이 최악). 필드 추가는 optional로만,
     의미 변경·삭제는 version bump로만.
   - 에러 계약: 에러 응답의 형태(JSON-RPC error / 문자열)와 대표 에러 코드 표.
3. **버전 필드 구현**: envelope에서 `intent_version`을 파싱, 지원 범위(현재 0) 밖이면
   명시적 에러. 기존 호출(필드 없음)은 그대로 동작해야 한다.
4. **스냅샷 테스트**: `schema_v0.rs` — 문서의 JSON 예제들이 실제로 deserialize되고
   디스패치가 에러 없이 Op를 만드는지(문서≠코드 드리프트 방지). unknown field가
   실제로 거부되는지 assert. serde에 `deny_unknown_fields`가 없다면 추가하되,
   기존 앱 호출이 깨지지 않는지 UI 경로로 확인.

## 검증
- 공통 스위트(§4.2) + `cargo test -p hwp-mcp`.
- 앱 회귀: `cd crates/hwp-viewer/ui && npx tsc --noEmit && npm run build` (envelope
  변경이 프론트 api.ts와 어긋나지 않는지).

## 수용 기준
- [ ] `docs/INTENT-SCHEMA.md`에 모든 Intent가 예제+필드표+단위+에러로 기록됨
- [ ] `intent_version` 파싱 + 범위 밖 명시 에러 + 무필드 하위호환
- [ ] unknown Intent/field가 조용히 무시되지 않고 에러가 남 (테스트로 고정)
- [ ] 문서 예제 == 코드 동작을 잇는 스냅샷 테스트 존재
- [ ] 기존 Tauri 앱 플로우 무손상

## 함정
- `deny_unknown_fields`는 serde flatten과 충돌한다 — flatten이 쓰이는 곳이 있으면
  수동 검증 로직으로 대체하고 문서에 그 사실을 남겨라.
- Intent에 자유 문자열로 경로/명령을 받는 필드가 있으면 그 필드를 스키마 문서에
  **위험 표시**하라(013의 경로 감금 대상 목록이 된다).
- 스키마 문서는 한국어 본문 + 필드명은 코드 그대로. 예제는 실제 benchmark.hwp 문서에서
  동작하는 값으로.
