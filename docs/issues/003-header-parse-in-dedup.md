# 003 — 헤더 풀 parse-in (기존 풀 dedup + 정확한 styleIDRef)

- 상태: **#003-full 거의 완료** (in-place 편집 6슬라이스 완료 2026-06-17; 잔여: 구조 문단의 *본문 텍스트* 편집(run-region splice)만 안전성 게이트로 보류)

## 완료: #003-full 잔여 슬라이스 6단계 (2026-06-17, 설계 워크플로 기반)
설계 워크플로(`inplace-edit-remaining-design`)가 적대적 검증으로 6단계 buildable 계획 산출 → smallest-safe-first 구현, 매 단계 오라클(LibreOffice+H2Orestart) + round-trip byte-stability 게이트.

1. **undo/redo** — `hwp_ops::EditSession{doc,undo,redo,limit}` 스냅샷 기반(역연산 저널 아님; `SemanticDoc:Clone`은 Rc/RefCell 없는 deep copy라 dirty/풀/raw 바이트까지 정확 복원). `do_op`은 **원자적**(Err 시 복원 — apply가 Err 전에 shape intern + 일부 dirty 마킹하므로 필수). 죽은 `OpLog` 제거. **검증**: undo→serialize가 원본과 byte-identical, 실패 op는 pristine 유지.
2. **caller 이행** — hwp-mcp `Session.doc: Option<EditSession>` 8곳 + MCP `undo`/`redo` 도구, auto-hwp-cli `ai_apply`. MCP 라운드트립 스모크 통과.
3. **SetParaPr + ApplyStyle** — 여는 태그 paraPrIDRef/styleIDRef를 **변경 시에만**(gated) 패치(`synth::set_attr` pub(crate), `patch_para_open_tag` 헬퍼). runs-only 편집은 여는 태그 byte-verbatim 유지(회귀 검증).
4. **SetRunCharPr** — 문단 내 char-range run 분할. char 오프셋→byte는 항상 `char_indices().nth()`(한글 UTF-8 경계 안전). 경계-인접 빈 run은 `[lo,hi)` 밖(charPrIDRef churn 방지).
5. **InsertText/DeleteRange** — `Caret{node,offset}`(char 오프셋, 경계 left-attach, 범위초과 Err). 제어문자(NUL+C0 except \t\n\r) sanitize. run 간 텍스트 변이. `&`/`<` 삽입 오라클 검증(xml_escape/unescape 비대칭이 valid OWPML 산출).
6. **non-simple 문단 편집 (안전 부분집합)** — 구조 문단(secPr/ctrl/tbl)에 **SetParaPr/ApplyStyle 허용**: body는 byte-verbatim 보존하고 여는 태그만 패치(`reemit_paragraph_open_only`). body 재구성 op(SetCharPr/SetRunCharPr/Insert/Delete)는 여전히 **거부**(조용한 구조 손실 방지). **검증**: secPr body 바이트 verbatim 생존 + 오라클 오픈.

테스트: hwp-ops 18 + hwp-hwpx 26 + hwp-core 8 + hwp-mcp 9, fidelity benchmark GREEN, clippy -D warnings 클린, 워크스페이스 전체 그린.

### 보류 (안전 게이트): 구조 문단의 *본문 텍스트* 편집
인라인 객체(pic/equation) 주변 또는 구조 prefix 뒤 pure-text run 영역만 splice하는 "run-region splice"는 최고위험·최소검증(설계 워크플로의 해당 연구 에이전트 2건이 rate-limit로 실패)이라, round-trip 모트를 위협하지 않도록 **명시적으로 보류**. parser가 run별 byte-span + pure-text 플래그를 기록하고 두 번째 splice 경로를 검증한 뒤에만 simple 게이트를 넓힌다.

## 완료: in-place 편집 첫 슬라이스 (2026-06-17, 설계 워크플로 기반)

## 완료: in-place 편집 첫 슬라이스 (2026-06-17, 설계 워크플로 기반)
기존 콘텐츠를 *수정*하는 능력(append 아님)을 구현. 핵심:
- 파서가 TOP-LEVEL 문단마다 **바이트 span + 원본 paraPrIDRef/styleIDRef/id + run 분리 + `simple` 플래그**(hp:run/hp:t/linesegarray만 → 재방출 가능) 기록. `parse_semantic`이 char/para_shapes 인덱스 0 = default 예약(편집 shape는 1+).
- 직렬화기 `patch_section_xml`: dirty+simple 문단은 원본 `<hp:p …>` 여는 태그를 **그대로 두고 run만 AST에서 재방출**(linesegarray drop), span을 내림차순 splice. 나머지 문단은 byte-verbatim. non-simple은 재방출 거부.
- 검증: FormattingShowcase의 6-run 문단의 한 run을 bold+red로 in-place 편집 → 다른 문단 byte 보존 → 오라클 오픈 + rhwp 렌더 확인. 무편집 round-trip byte-stable 유지(20 테스트 green).

### 완료: P2 op-bus 주소지정 (2026-06-17)
`parse_semantic`이 top-level 문단에 안정적 `NodeId` 부여(문서순서, XML id 아님). `Op::SetCharPr{range,shape}` 구현 — NodeId 범위의 문단을 찾아 in-place 편집(문단 단위), **non-simple이면 Err**(조용한 손실 없음). hwp-core 테스트 + 오라클 + 렌더 검증(불릿 → bold+red).

### 완료: P1 값기반 parse-in (2026-06-17)
`synth::parse_char_pr`/`parse_para_pr`(synthesize 역함수) + `parse_header_pools` → `SemanticDoc.header_pools`(BTreeMap<u64,CharShape/ParaShape>). `char_shape_of_ref()`로 기존 run 서식을 값으로 읽기 가능(toggle 등 서식 인식 편집의 토대). 정정: charPr id=0은 값으로 default 아님(height 1000) — 풀은 실제 파싱값 저장, dedup은 기존 XML조각 비교 유지(상속 필드에 더 견고).

잔여: run-level(문단 내 선택) char-offset 주소지정, SetParaPr/InsertText/DeleteRange in-place, non-simple 문단 편집, undo/redo OpLog 연결.
- 우선순위: P2 (정확도 토대)
- 영역: 파서 / 합성 (로드맵 P1)

## 완료된 부분 (A2/A3 interleave)
**합성 dedup**: `synth::existing_equivalent_id(header, open, close, fragment)`이 합성한 charPr/paraPr를
기존 풀의 모든 엔트리와 (id 제외) 바이트 비교하여 동일하면 그 id를 재사용한다(중복 합성 방지).
기본 element를 clone해 합성하므로 "동일 서식 ⇒ 동일 XML(modulo id)"이 성립해 파서 없이 안전.
검증: `bold+textColor #1F4E79` 요청 → 기존 charPr id=7 재사용, `max_pool_id` 불변
(`serialize.rs` test `dedups_synthesized_charpr_against_existing_pool`). intra-export dedup은
`intern_char_shape`/`intern_para_shape`(값 기준)로 이미 동작.

## 잔여 (전체 parse-in)
기존 *본문* 서식을 AST로 끌어올리는 것(run charPrIDRef → char_shapes idx, hp:p paraPrIDRef →
para_shapes idx)은 **미완**. 이유: 현재 직렬화기는 변경 안 된 콘텐츠를 verbatim 원본 XML로
재방출(append-only)하므로, 파싱한 서식을 AST에 넣어도 직렬화기가 무시한다. 전체 parse-in은
**in-place 편집 op + 비-verbatim 재방출**이 생긴 뒤라야 가치가 있다(그 전엔 round-trip 위험만 추가).

## 문제
현재 파서(`parse.rs`)는 `doc.char_shapes`/`para_shapes`를 채우지 않고 모든 run을 `char_shape: 0`으로 둔다(기존 콘텐츠 서식은 verbatim 원본 XML에만 존재). 합성기는 **기존 풀을 읽지 않고** 항상 max id 위에 새 charPr/paraPr를 추가한다.

이는 동작하지만(검증됨):
- **중복**: AI가 요청한 서식이 이미 풀에 있어도 새로 합성(풀 비대).
- **styleIDRef 하드코딩**: 합성 문단이 `styleIDRef="0"` 고정 → 스타일 연동 불가(이슈/008 P5와 연관, 단 P5는 별도로 스타일명 적용은 구현).

## 접근(구현 시)
1. `parse_header_pools()`: `<hh:charProperties>`/`<hh:paraProperties>`/`<hh:fontfaces>`/`<hh:borderFills>`/`<hh:styles>`를 in-memory 구조로 읽어 `doc.char_shapes`/`para_shapes`를 **실제 엔트리로 시드**(index==id, dense pool 가정).
2. run `charPrIDRef` → char_shapes idx, `hp:p paraPrIDRef` → para_shapes idx 매핑.
3. 합성기 인터너를 **파싱된 풀로 시드** → 동일 shape는 기존 id 재사용(dedup), 신규만 합성.
4. `SemanticDoc`에 `header_pools`/`style_index`/`outline_index` 스냅샷 필드.

## 효과
- 풀 비대 제거, 기존 Hancom 엔트리 재사용, P5 스타일/개요 연동 정확도↑, 향후 in-place 편집(기존 문단 서식 변경)의 토대.

## 수용 기준
- no-edit 라운드트립이 기존과 동일(byte-stable 수준), 합성 시 동일 shape 재사용 확인.
