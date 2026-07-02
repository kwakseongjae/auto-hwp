# Intent 스키마 v0 (동결)

> 이슈 008 산출물. **새 프로토콜이 아니라, 지금 `crates/hwp-mcp/src/lib.rs`의 `Intent`
> 표면을 전수 조사해 명문화**한 문서다. "코어 하나, 셸 셋"의 계약은 이 Intent JSON이며,
> 외부 소비자(business_plan_k·에르메스·웹 SDK)가 붙기 전에 표면·버전·에러 계약을 고정한다.
>
> 정본(定本)은 코드다. 이 문서의 모든 예제는 스냅샷 테스트
> `crates/hwp-mcp/tests/schema_v0.rs`가 실제로 `deserialize_intent`로 파싱하고 op-bus로
> 디스패치한다(문서↔코드 드리프트 방지). 예제를 바꾸면 그 테스트도 함께 바꿔야 한다.

---

## 1. 요청 형식 (wire format)

Intent는 **내부 태그(internally tagged) JSON 오브젝트**다. 판별 필드는 `"intent"`이고,
나머지 필드는 같은 레벨에 평평하게 온다.

```json
{ "intent": "SetImageSize", "section": 0, "index": 1, "width": 12000, "height": 9000 }
```

- 파싱 진입점: `hwp_mcp::deserialize_intent(&serde_json::Value) -> Result<Intent, String>`.
- 엔드투엔드(파싱→디스패치): `hwp_mcp::apply_intent_json(&mut Session, &Value) -> Result<Outcome, String>`.
- 디코더는 `#[serde(tag = "intent", deny_unknown_fields)]` — **알 수 없는 `intent` 태그나
  알 수 없는/오타 필드는 조용히 무시하지 않고 하드 에러**로 거부한다. 에이전트가 오타를
  "성공"으로 오인하는 것이 최악이기 때문(레드팀 R11).
- `Option<T>` 필드는 **생략 시 `None`**(예: `SetCharFmt`의 `italic`을 빼면 이태릭 미변경).
  `bool`/`String`/정수 등 **비-Option 필드는 필수**(누락 시 `missing field` 에러).
- 튜플 필드 `cell: Option<(usize, usize)>`는 JSON 배열 `[row, col]`로 온다(또는 생략/`null`).

### 두 개의 전송 레인 (참고)

Intent 표면은 하나지만 이를 나르는 전송은 둘이다. 이 문서는 **(A) Intent JSON 표면**을
동결한다.

| 레인 | 위치 | 형태 | intent_version |
|------|------|------|----------------|
| (A) 타입드 Intent | `hwp-mcp` `Intent`/`apply_intent` | 이 문서의 JSON(내부 태그) | 적용됨(엔벨로프) |
| (B) MCP `tools/*` | `hwp-mcp` `handle`/`call_tool` | JSON-RPC 2.0 tool 호출(툴별 arguments) | 미적용(§5 참고) |

- Tauri 데스크톱 셸(`hwp-viewer/src/lib.rs`)은 커맨드별 `invoke`로 `Intent` variant를
  **Rust에서 직접 생성**한다(JSON 엔벨로프를 거치지 않음). 그래서 `Intent`에 붙인
  `Deserialize` 파생은 셸에 순수 가산(加算)이며 기존 앱 플로우를 바꾸지 않는다.
- MCP `tools/*` 레인은 별도 표면(13개 툴: `open_document`/`get_context`/`apply_content`/
  `export_hwpx`/`extract_text`/`render_page`/`page_count`/`undo`/`redo`/`propose_content`/
  `commit_proposal`/`find_text`/`replace_text`)이며 셀 서식 Intent를 포함하지 않는다.
  이 중복은 이슈 012(hwp-session 파사드)에서 해소 예정.

---

## 2. `intent_version` 엔벨로프

요청 오브젝트는 판별 필드와 **같은 레벨에 선택적** `intent_version` 정수를 실을 수 있다.

```json
{ "intent_version": 0, "intent": "Undo" }
```

- **현재 지원 버전: `0`** (`hwp_mcp::INTENT_VERSION` 상수).
- **없으면 `0`으로 간주** — 기존 호출(필드 미포함)은 그대로 동작(하위호환).
- `deserialize_intent`는 `intent_version`을 **먼저 검사하고 제거한 뒤** 태그 본문을 디코딩한다.
  (제거하지 않으면 `deny_unknown_fields`가 unknown field로 거부하므로.)
- 지원 범위(`0..=0`) 밖이면 **명시적 에러**: `unsupported intent_version 1 (this build supports 0..=0)`.
- 정수가 아니면 에러: `intent_version must be a non-negative integer`.

---

## 3. 호환성 정책 (v0에서 동결)

1. **unknown Intent/필드 = 명시적 거부.** 보존·무시가 아니라 에러(§1, `deny_unknown_fields`).
2. **필드 추가는 optional(`Option<T>`)로만.** 기존 요청(그 필드 미포함)이 계속 파싱돼야 함.
3. **의미 변경·필드 삭제·필수화는 `intent_version` 범프로만.** v0 계약을 깨는 변경 금지.
4. **단위 불변.** 각 필드의 단위(HWPUNIT/px/mm/pt/비율)는 §6 표에 고정. 단위 슬립은 조용히
   클릭선택/이동/리사이즈를 죽인다(공통 계약 §4.5).

### `deny_unknown_fields` ↔ `serde(flatten)` 함정

`deny_unknown_fields`는 `serde(flatten)`과 충돌한다. **본 스키마는 flatten을 쓰지 않는다.**
`intent_version`은 flatten 필드가 아니라 `deserialize_intent`에서 **수동으로 벗겨낸 뒤**
태그 본문을 디코딩하므로 충돌이 없다.

---

## 4. 에러 계약

에러는 형태가 둘로 갈린다.

| 채널 | 형태 | 코드 |
|------|------|------|
| (A) `deserialize_intent`/`apply_intent(_json)` | `Err(String)` (평문) | 없음(문자열) |
| (B) MCP `tools/call` 실패 | `result{ content:[{text}], isError:true }` (평문) | 없음 |
| (B) MCP 프로토콜 에러 | JSON-RPC `error{ code, message }` | 실방출 `-32601`(method not found)뿐 |

즉 **대부분의 실패는 "코드 없는 평문 문자열"**이다. 대표 에러 문자열:

| 상황 | 대표 문자열(부분 일치) |
|------|------------------------|
| 엔벨로프가 오브젝트가 아님 | `intent envelope must be a JSON object` |
| `intent_version` 타입 오류 | `intent_version must be a non-negative integer` |
| `intent_version` 범위 밖 | `unsupported intent_version {n} (this build supports 0..=0)` |
| 알 수 없는 Intent 태그 | `unknown variant \`Foo\`, expected one of ...` (serde) |
| 알 수 없는/오타 필드 | `unknown field \`bar\`, expected ...` (serde) |
| 판별 태그 누락 | `missing field \`intent\`` (serde) |
| 필수 필드 누락 | `missing field \`section\`` (serde) |
| 문서 미개봉 상태에서 편집/조회 | `no document open (call open_document first)` |
| 블록 인덱스 범위 밖 | `SetTableCell: block index {i} out of range` 등 op별 |
| 구조 문단 in-place 편집 | `paragraph N has structural content and cannot be edited in place` |
| 대기 제안 없이 Commit | `대기 중인 제안이 없습니다 (propose first)` |
| rhwp 미빌드에서 렌더/캐럿 | `render needs a build with --features rhwp` / `hit_test needs ...` / `caret_rect needs ...` |

---

## 5. 위험 표시 필드 (경로/자유문자열) — 013 경로 감금 대상

에이전트가 자유 문자열로 주는 **파일 경로** 필드. 이슈 013(헤드리스 서비스 컨테이너)에서
`WORKSPACE_ROOT` canonicalize-후-거부의 감금 대상이 된다. 컨테이너/볼륨 마운트 환경에서
path traversal(호스트 파일 노출) 벡터이므로 **여기 나열된 필드만 감금하면 충분**하다.

| 표면 | 필드 | 위험 |
|------|------|------|
| Intent `Open` | `path` | ⚠️ 임의 읽기 경로 |
| Intent `Export` | `path` | ⚠️ 임의 쓰기 경로(atomic_write) |
| MCP `open_document` | `path` | ⚠️ 임의 읽기 경로 |
| MCP `export_hwpx` | `path` | ⚠️ 임의 쓰기 경로 |

그 외 자유 문자열(`ApplyContent.json`, `Propose.json`)은 경로가 아니라 AI 콘텐츠 JSON이며,
문서 텍스트를 LLM 컨텍스트에 넣는 프롬프트 인젝션(R5)은 이슈 010/013 소관.

---

## 6. Intent 레퍼런스

필드표 범례 — **타입**: JSON 타입. **단위/값**: 의미 단위 또는 허용 값. **필수**: ●=필수,
○=선택(생략 시 `None`/무변경). 예제는 `schema_v0.rs`의 정본과 동일.

### 6.1 수명주기 / 조회

#### `Open` — 문서 열기 (HWPX/HWP5/DOCX/PDF 감지)
```json
{ "intent": "Open", "path": "corpus/hwpx/FormattingShowcase.hwpx" }
```
| 필드 | 타입 | 단위/값 | 필수 |
|------|------|---------|------|
| `path` | string | ⚠️ 파일 경로(§5) | ● |

실패: 읽기 실패 `read {path}: ...`, 미인식 포맷 `unrecognized format (not HWP/HWPX/DOCX/PDF)`.

#### `PageCount` — 현재 문서 페이지 수
```json
{ "intent": "PageCount" }
```
필드 없음. 실패: `no document open ...`.

#### `Render` — 현재 페이지 SVG (rhwp 빌드 필요)
```json
{ "intent": "Render", "page": 0 }
```
| 필드 | 타입 | 단위/값 | 필수 |
|------|------|---------|------|
| `page` | integer | 0-based 페이지 | ● |

실패: rhwp 미빌드 `render needs a build with --features rhwp`; 편집된 문서는 SVG 렌더 거부
(HTML 미리보기로 표시).

#### `ApplyContent` — AI 콘텐츠 JSON 적용(1 undo 단위)
```json
{ "intent": "ApplyContent", "json": "{\"blocks\":[{\"type\":\"paragraph\",\"runs\":[{\"text\":\"에이전트 추가\"}]}]}" }
```
| 필드 | 타입 | 단위/값 | 필수 |
|------|------|---------|------|
| `json` | string | AiContent JSON(문자열로 인코딩) | ● |

#### `Export` — HWPX 직렬화 저장(atomic write)
```json
{ "intent": "Export", "path": "/tmp/out.hwpx" }
```
| 필드 | 타입 | 단위/값 | 필수 |
|------|------|---------|------|
| `path` | string | ⚠️ 출력 경로(§5) | ● |

#### `Undo` / `Redo` — 마지막 편집 취소/재실행
```json
{ "intent": "Undo" }
```
```json
{ "intent": "Redo" }
```
필드 없음. 되돌릴/재실행할 것이 없으면 그레이스풀 no-op(에러 아님).

#### `ExtractText` — 읽기 순서 평문 추출
```json
{ "intent": "ExtractText" }
```
필드 없음.

### 6.2 제안(propose) 루프

#### `Propose` — AI 콘텐츠를 미리보기 제안으로 검증(문서 미변경)
```json
{ "intent": "Propose", "json": "{\"blocks\":[{\"type\":\"heading\",\"text\":\"제안\",\"align\":\"center\"}]}" }
```
| 필드 | 타입 | 단위/값 | 필수 |
|------|------|---------|------|
| `json` | string | AiContent JSON | ● |

#### `Commit` — 대기 중 제안을 1 undo 단위로 적용
```json
{ "intent": "Commit" }
```
필드 없음. 실패: `대기 중인 제안이 없습니다 (propose first)`.

#### `DiscardProposal` — 대기 제안 폐기
```json
{ "intent": "DiscardProposal" }
```
필드 없음.

### 6.3 찾기 / 바꾸기

#### `Find` — 편집 가능한 단순 문단에서 검색(읽기 전용)
```json
{ "intent": "Find", "query": "문서", "case_sensitive": false, "whole_word": false }
```
| 필드 | 타입 | 단위/값 | 필수 |
|------|------|---------|------|
| `query` | string | 검색어 | ● |
| `case_sensitive` | bool | 대소문자 구분 | ● |
| `whole_word` | bool | 온전한 단어 | ● |

#### `Replace` — 찾아 바꾸기(1 undo 단위)
```json
{ "intent": "Replace", "query": "문서", "replacement": "파일", "case_sensitive": false, "whole_word": false, "all": true }
```
| 필드 | 타입 | 단위/값 | 필수 |
|------|------|---------|------|
| `query` | string | 검색어 | ● |
| `replacement` | string | 대체 텍스트 | ● |
| `case_sensitive` | bool | 대소문자 구분 | ● |
| `whole_word` | bool | 온전한 단어 | ● |
| `all` | bool | `true`=전체, `false`=첫 매치만 | ● |

### 6.4 WYSIWYG 캐럿 지오메트리 (rhwp / 라이브 노드 필요)

> ⚠️ 단위: `HitTest`의 `x`/`y`와 `CaretRect`의 `x`/`top`/`height`는 **페이지 공간 px
> (미스케일)**. 프런트가 SVG를 확대하면 같은 배율로 스케일해야 한다(공통 계약 §4.5).

#### `HitTest` — 클릭 좌표를 편집 대상으로 매핑
```json
{ "intent": "HitTest", "page": 0, "x": 120.0, "y": 90.0 }
```
| 필드 | 타입 | 단위/값 | 필수 |
|------|------|---------|------|
| `page` | integer | 0-based 페이지 | ● |
| `x` | number | 페이지 px | ● |
| `y` | number | 페이지 px | ● |

#### `CaretRect` — 모델 대상(NodeId+offset)을 캐럿 사각형으로
```json
{ "intent": "CaretRect", "page": 0, "node": 7, "offset": 3 }
```
| 필드 | 타입 | 단위/값 | 필수 |
|------|------|---------|------|
| `page` | integer | 0-based 페이지 | ● |
| `node` | integer | NodeId(u64) | ● |
| `offset` | integer | 문단 내 문자(char) 인덱스 | ● |

#### `InsertText` — 캐럿 위치에 문자 삽입(1 undo 단위)
```json
{ "intent": "InsertText", "node": 7, "offset": 0, "text": "끼움" }
```
| 필드 | 타입 | 단위/값 | 필수 |
|------|------|---------|------|
| `node` | integer | NodeId | ● |
| `offset` | integer | 문단 내 char 인덱스 | ● |
| `text` | string | 삽입 텍스트 | ● |

실패: 구조 문단 `... structural content and cannot be edited in place`; 범위 밖 offset 에러.

#### `DeleteBack` — offset 직전 1문자 삭제(Backspace, 1 undo 단위)
```json
{ "intent": "DeleteBack", "node": 7, "offset": 1 }
```
| 필드 | 타입 | 단위/값 | 필수 |
|------|------|---------|------|
| `node` | integer | NodeId | ● |
| `offset` | integer | 문단 내 char 인덱스(`0`=no-op) | ● |

### 6.5 이미지 오버레이 (라이브 이미지 필요)

> ⚠️ 단위: `width`/`height`는 **HWPUNIT**.

#### `SetImageSize` — 이미지 리사이즈(1 undo 단위)
```json
{ "intent": "SetImageSize", "section": 0, "index": 2, "width": 12000, "height": 9000 }
```
| 필드 | 타입 | 단위/값 | 필수 |
|------|------|---------|------|
| `section` | integer | 구역 인덱스 | ● |
| `index` | integer | 블록 인덱스 | ● |
| `width` | integer | HWPUNIT | ● |
| `height` | integer | HWPUNIT | ● |

#### `MoveImage` — 이미지 블록 이동(DeleteBlock+InsertImageAt, 1 undo 단위)
```json
{ "intent": "MoveImage", "section": 0, "from": 2, "to": 0, "width": 12000, "height": 9000 }
```
| 필드 | 타입 | 단위/값 | 필수 |
|------|------|---------|------|
| `section` | integer | 구역 인덱스 | ● |
| `from` | integer | 원본 블록 인덱스 | ● |
| `to` | integer | 대상 블록 인덱스 | ● |
| `width` | integer | HWPUNIT(크기 보존) | ● |
| `height` | integer | HWPUNIT(크기 보존) | ● |

### 6.6 블록 / 표 구조

#### `MoveBlock` — 블록 이동(1 undo 단위)
```json
{ "intent": "MoveBlock", "section": 0, "from": 0, "to": 1 }
```
| 필드 | 타입 | 단위/값 | 필수 |
|------|------|---------|------|
| `section` | integer | 구역 인덱스 | ● |
| `from` | integer | 원본 블록 인덱스 | ● |
| `to` | integer | 대상 블록 인덱스(`==len`=끝) | ● |

#### `TableInsertRows` — 빈 본문 행 삽입(1 undo 단위)
```json
{ "intent": "TableInsertRows", "section": 0, "index": 1, "at": 2, "count": 1, "cols": 3 }
```
| 필드 | 타입 | 단위/값 | 필수 |
|------|------|---------|------|
| `section` | integer | 구역 인덱스 | ● |
| `index` | integer | 표 블록 인덱스 | ● |
| `at` | integer | 논리 행 위치(`==rows`=append) | ● |
| `count` | integer | 삽입 행 수(>0) | ● |
| `cols` | integer | 행당 셀 수(>0) | ● |

#### `SetTableCell` — 셀 텍스트 교체(단일 평문 run, 1 undo 단위)
```json
{ "intent": "SetTableCell", "section": 0, "index": 1, "row": 0, "col": 0, "text": "셀 값" }
```
| 필드 | 타입 | 단위/값 | 필수 |
|------|------|---------|------|
| `section` | integer | 구역 인덱스 | ● |
| `index` | integer | 표 블록 인덱스 | ● |
| `row` | integer | 행 | ● |
| `col` | integer | 열 | ● |
| `text` | string | 셀 텍스트(빈 문자열=비움) | ● |

> ⚠️ 서식 보존 편집은 §6.7 `SetTableCellRuns`를 써라. 평문 `SetTableCell`은 run을 하나로
> 접는다(공통 계약 §4.7).

#### `TableAppendRow` — 마지막 행의 열 구성을 복제해 빈 행 1개 추가(merge-safe, 1 undo 단위)
```json
{ "intent": "TableAppendRow", "section": 0, "index": 1 }
```
| 필드 | 타입 | 단위/값 | 필수 |
|------|------|---------|------|
| `section` | integer | 구역 인덱스 | ● |
| `index` | integer | 표 블록 인덱스 | ● |

#### `SetParagraphText` — 단순 문단 텍스트 교체(char/para shape 보존, 1 undo 단위)
```json
{ "intent": "SetParagraphText", "section": 0, "block": 0, "text": "바뀐 문단" }
```
| 필드 | 타입 | 단위/값 | 필수 |
|------|------|---------|------|
| `section` | integer | 구역 인덱스 | ● |
| `block` | integer | 블록 인덱스 | ● |
| `text` | string | 문단 텍스트 | ● |

실패: 구조 문단이면 거부(UI는 채팅으로 폴백).

#### `SetTableColWidths` — 열 너비 비율(1 undo 단위)
```json
{ "intent": "SetTableColWidths", "section": 0, "index": 1, "widths": [2, 1, 1] }
```
| 필드 | 타입 | 단위/값 | 필수 |
|------|------|---------|------|
| `section` | integer | 구역 인덱스 | ● |
| `index` | integer | 표 블록 인덱스 | ● |
| `widths` | integer[] | **상대 비율**(i32, 양수). `len==표의 열 수` | ● |

#### `SetTableRowHeights` — 행 최소높이 오버라이드(1 undo 단위)
```json
{ "intent": "SetTableRowHeights", "section": 0, "index": 1, "heights": [0, 0] }
```
| 필드 | 타입 | 단위/값 | 필수 |
|------|------|---------|------|
| `section` | integer | 구역 인덱스 | ● |
| `index` | integer | 표 블록 인덱스 | ● |
| `heights` | integer[] | **HWPUNIT** 최소높이(`0`=content-sized). `len==표의 행 수` | ● |

#### `SetPageMargins` — 구역 페이지 여백(1 undo 단위, 전체 재-flow)
```json
{ "intent": "SetPageMargins", "section": 0, "left_mm": 20.0, "right_mm": 20.0, "top_mm": 20.0, "bottom_mm": 15.0 }
```
| 필드 | 타입 | 단위/값 | 필수 |
|------|------|---------|------|
| `section` | integer | 구역 인덱스 | ● |
| `left_mm` | number | **mm** | ● |
| `right_mm` | number | **mm** | ● |
| `top_mm` | number | **mm** | ● |
| `bottom_mm` | number | **mm** | ● |

#### `DeleteBlock` — 블록 삭제(1 undo 단위)
```json
{ "intent": "DeleteBlock", "section": 0, "index": 0 }
```
| 필드 | 타입 | 단위/값 | 필수 |
|------|------|---------|------|
| `section` | integer | 구역 인덱스 | ● |
| `index` | integer | 블록 인덱스 | ● |

### 6.7 문자 / 문단 서식

> ⚠️ 단위: `size_pt`는 **포인트(pt)**. 색은 `"#RRGGBB"`. `align` ∈
> `left`|`center`|`right`|`justify`|`distribute`. `cell`은 `[row, col]` 또는 생략/`null`.

#### `SetCharFmt` — 대상 run의 볼드/이태릭/크기/글꼴 패치(다른 속성 보존, 1 undo 단위)
```json
{ "intent": "SetCharFmt", "section": 0, "block": 0, "cell": null, "bold": true, "italic": null, "size_pt": 14.0, "font": "맑은 고딕" }
```
| 필드 | 타입 | 단위/값 | 필수 |
|------|------|---------|------|
| `section` | integer | 구역 인덱스 | ● |
| `block` | integer | 블록 인덱스 | ● |
| `cell` | [int,int]/null | `[row,col]`=셀, 생략/`null`=블록 문단 | ○ |
| `bold` | bool/null | | ○ |
| `italic` | bool/null | | ○ |
| `size_pt` | number/null | **pt**(CharShape.height=round(pt*100)) | ○ |
| `font` | string/null | 글꼴 패밀리(`""`=지움) | ○ |

#### `SetRunCharFmt` — char 범위 `[start,end)`의 볼드/이태릭 패치(1 undo 단위)
```json
{ "intent": "SetRunCharFmt", "section": 0, "block": 0, "cell": null, "start": 0, "end": 2, "bold": true, "italic": false }
```
| 필드 | 타입 | 단위/값 | 필수 |
|------|------|---------|------|
| `section` | integer | 구역 인덱스 | ● |
| `block` | integer | 블록 인덱스 | ● |
| `cell` | [int,int]/null | `[row,col]`=셀, 생략/`null`=블록 문단 | ○ |
| `start` | integer | char 오프셋(바이트 아님) | ● |
| `end` | integer | char 오프셋(반열림) | ● |
| `bold` | bool/null | | ○ |
| `italic` | bool/null | | ○ |

#### `SetTableCellRuns` — 셀을 **스타일 run**으로 교체(WYSIWYG 커밋, 1 undo 단위)
```json
{ "intent": "SetTableCellRuns", "section": 0, "index": 1, "row": 0, "col": 0, "runs": [{"text": "강조", "bold": true}, {"text": " 일반"}] }
```
| 필드 | 타입 | 단위/값 | 필수 |
|------|------|---------|------|
| `section` | integer | 구역 인덱스 | ● |
| `index` | integer | 표 블록 인덱스 | ● |
| `row` | integer | 행 | ● |
| `col` | integer | 열 | ● |
| `runs` | RunSpec[] | 스타일 run 배열(아래) | ● |

#### `SetParagraphRuns` — 단순 문단을 **스타일 run**으로 교체(1 undo 단위)
```json
{ "intent": "SetParagraphRuns", "section": 0, "block": 0, "runs": [{"text": "굵게", "bold": true}] }
```
| 필드 | 타입 | 단위/값 | 필수 |
|------|------|---------|------|
| `section` | integer | 구역 인덱스 | ● |
| `block` | integer | 블록 인덱스 | ● |
| `runs` | RunSpec[] | 스타일 run 배열(아래) | ● |

**`RunSpec` (중첩 오브젝트)** — `#[serde(default, deny_unknown_fields)]`. 모든 필드 선택
(생략 시 기본값). 알 수 없는 run 키는 거부.

| 필드 | 타입 | 단위/값 | 필수 |
|------|------|---------|------|
| `text` | string | run 텍스트(생략 시 `""`) | ○ |
| `bold` | bool | 기본 `false` | ○ |
| `italic` | bool | 기본 `false` | ○ |
| `underline` | bool | 기본 `false` | ○ |
| `strike` | bool | 기본 `false` | ○ |
| `size_pt` | number | **pt** | ○ |
| `color` | string | `"#RRGGBB"` | ○ |
| `highlight` | string | `"#RRGGBB"`(형광/음영) | ○ |
| `font` | string | 글꼴 패밀리 | ○ |

### 6.8 셀 음영 / 범위 서식

> ⚠️ 색은 `"#RRGGBB"` 또는 `null`(지움). `sel` ∈ `row`|`col`|`cell`|`all`(그 외=`cell`로 취급).

#### `SetTableCellShade` — 셀 배경색 설정/해제(`sel` 기준, 1 undo 단위)
```json
{ "intent": "SetTableCellShade", "section": 0, "index": 1, "sel": "cell", "row": 0, "col": 0, "shade": "#FFFF00" }
```
| 필드 | 타입 | 단위/값 | 필수 |
|------|------|---------|------|
| `section` | integer | 구역 인덱스 | ● |
| `index` | integer | 표 블록 인덱스 | ● |
| `sel` | string | `row`\|`col`\|`cell`\|`all` | ● |
| `row` | integer | `(row,col)` 기준 | ● |
| `col` | integer | `(row,col)` 기준 | ● |
| `shade` | string/null | `"#RRGGBB"` 또는 `null`=지움 | ○ |

#### `SetCellRangeShade` — 사각형 `[r0..=r1]×[c0..=c1]` 셀 배경 일괄(1 undo 단위)
```json
{ "intent": "SetCellRangeShade", "section": 0, "index": 1, "r0": 0, "c0": 0, "r1": 1, "c1": 2, "shade": "#EEEEEE" }
```
| 필드 | 타입 | 단위/값 | 필수 |
|------|------|---------|------|
| `section` | integer | 구역 인덱스 | ● |
| `index` | integer | 표 블록 인덱스 | ● |
| `r0`,`c0`,`r1`,`c1` | integer | 포함 사각형 경계 | ● |
| `shade` | string/null | `"#RRGGBB"` 또는 `null`=지움 | ○ |

#### `SetCellRangeFmt` — 사각형 범위 셀의 문자 서식/정렬 일괄(1 undo 단위)
```json
{ "intent": "SetCellRangeFmt", "section": 0, "index": 1, "r0": 0, "c0": 0, "r1": 1, "c1": 2, "bold": true, "italic": null, "size_pt": null, "font": null, "color": "#0000FF", "align": "center" }
```
| 필드 | 타입 | 단위/값 | 필수 |
|------|------|---------|------|
| `section` | integer | 구역 인덱스 | ● |
| `index` | integer | 표 블록 인덱스 | ● |
| `r0`,`c0`,`r1`,`c1` | integer | 포함 사각형 경계 | ● |
| `bold` | bool/null | | ○ |
| `italic` | bool/null | | ○ |
| `size_pt` | number/null | **pt** | ○ |
| `font` | string/null | 글꼴(`""`=지움) | ○ |
| `color` | string/null | `"#RRGGBB"` | ○ |
| `align` | string/null | `left`\|`center`\|`right`\|`justify`\|`distribute` | ○ |

---

## 7. 드리프트 방지

- 정본 테스트: `crates/hwp-mcp/tests/schema_v0.rs`.
  - 위 35개 예제가 실제로 `deserialize_intent`로 파싱됨(문서↔코드 필드명/타입 일치 보증).
  - `Synthetic` 대상은 결정적 3×2 표 문서에 op-bus로 디스패치되어 편집을 만든다(리비전 범프).
  - `Showcase` 대상은 실제 HWPX를 열어 엔드투엔드로 디스패치된다.
  - unknown 태그/필드, 태그·필수 필드 누락, `intent_version`(없음/0/범위밖/비정수)를 고정.
- 검증: `cargo test -p hwp-mcp` (레인 (A) 스키마 + (B) 툴), `cargo test -p hwp-ops`.
