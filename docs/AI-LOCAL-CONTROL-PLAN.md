# AI 레이어 + 로컬 실행 & 터미널→Tauri 제어 계획

> 사용자 방향: ① hwp/hwpx 온전한 업로드·뷰 ② 편집기 심화 ③ **AI 레이어**(로컬: BYOK + "터미널에서 Tauri 제어") ④ 온전한 .hwpx export.
> 본 문서는 14-에이전트 리서치(Tauri2 제어 표면 · 임베디드 MCP · BYOK/로컬LLM · 레퍼런스 아키텍처, 사실검증 10/10 통과)를 근거로 #3의 로컬 실행 모델을 구체화하고 4영역을 시퀀싱한다. (2026-06 기준)

---

## 0. 결론 (한 장)

**두 개의 분리된 topology를 헷갈리지 말 것** — 둘 다 같은 `hwp_ops::apply` op-bus(단일 변이 표면)를 통과한다:

| Topology | 의미 | 메커니즘 | 누가 서버/클라이언트 |
|---|---|---|---|
| **A. MCP 서버(앱 내장)** | *외부 터미널/에이전트가 살아있는 Tauri 편집기를 제어* | rmcp MCP 서버를 Tauri 프로세스 안에 임베드(loopback HTTP), 툴 = Op 1:1 | 앱=서버, 에이전트=클라이언트 |
| **B. BYOK AI 패널 (+선택적 ACP 클라이언트)** | *앱이 LLM/내 에이전트를 호출* | `LlmProvider` trait, keyring 시크릿; (선택) 앱이 사용자의 에이전트를 stdio로 spawn | 앱=클라이언트 |

- "터미널에서 Tauri 제어" = **A** (Claude Code 같은 코딩 에이전트도 MCP를 네이티브로 말하므로 같은 채널로 해결).
- "BYOK로 AI가 문서 작성" = **B**.
- ⚠️ **Tauri의 invoke/emit IPC는 외부에서 못 부른다**(`ipc://localhost`, webview-scoped, ACL이 remote origin 차단). 그래서 A는 *자체 제어 서버를 앱 안에 임베드*하는 게 유일한 길이다.

---

## 1. 4개 작업영역 시퀀싱 (현 상태 대비)

| # | 영역 | 로드맵 | 현 상태 | 다음 핵심작업 |
|---|---|---|---|---|
| 1 | hwp+hwpx 온전한 업로드·뷰 | M1/M2 | rhwp로 렌더 동작(8p 충실, fidelity GREEN), **Tauri 셸 미구현**(현재 HTML 뷰어) | Tauri 2 뷰어 셸 + `getPageLayerTree`(paint IR) → Canvas; HWPX도 동일 경로 |
| 2 | 편집기 심화 | M3 | op-bus `AppendParagraph`만 + 라운드트립 안전 | in-place 텍스트/서식/표 op; 파서 심화(노드↔바이트 offset provenance로 surgical 편집 확장) |
| 3 | **AI 레이어 (로컬: BYOK + 터미널→Tauri)** | M5 + 본 문서 | `hwp-ai` 골격 + projection 스텁 | §2(MCP 제어) + §3(BYOK/LLM) |
| 4 | 온전한 .hwpx export | M4 ✅ | 편집(append)→export→**한컴 정상 오픈** 검증됨 | 심화 편집의 export round-trip 확장 + 기능별 골든 |

> 권장 순서: **3-헤드리스(AI+MCP 코어) → 1(Tauri 뷰어 셸) → A를 셸에 임베드(라이브 제어) → 2(편집 심화) → 4 확장**. 이유: AI/op/MCP는 GUI 없이 코어에 먼저 붙여 검증할 수 있고(헤드리스 `tf-hwp ai-fill`), 그게 검증되면 Tauri 셸에 그대로 임베드된다.

---

## 2. 제어 아키텍처 — 터미널/에이전트 → 살아있는 Tauri 편집기 (Topology A)

### 2.1 권장 설계: rmcp MCP 서버를 Tauri 안에 임베드 (Streamable HTTP, loopback)
- **crate**: `rmcp`(공식 MCP Rust SDK, `modelcontextprotocol/rust-sdk`) — features `server, macros, transport-streamable-http-server`. **버전은 docs.rs에서 pin 후 확인**(소스마다 0.16 vs 1.7.0 상이; MCP spec 2025-11-25). `axum`, `tokio`.
- **위치**: 신규 크레이트 `hwp-mcp`(또는 `hwp-ai` 확장). 서버 struct가 `AppHandle`(또는 op-bus mpsc Sender)을 보유.
- **툴 = op-bus 1:1**: 각 `Op` variant → `#[tool]`(파라미터 struct가 해당 variant 필드 미러, `Deserialize+JsonSchema`). 핸들러는 **UI 경로로** `hwp_ops::apply` 호출(undo/redo·dirty-only export·검증 그대로) → `AppHandle::emit`으로 라이브 편집기 반영 → 결과/diff 반환. **raw-XML 툴 없음**(단일 변이 표면 유지).
- **세션 verbs**(비-Op 편의): `open_document(path)`, `export_hwpx(path)`, `get_doc_state()/snapshot`, `list_sections()`, `ai_fill(...)`, `subscribe/poll_events`(앱→에이전트 이벤트).
- **임베드**: Tauri `setup()`에서 `tauri::async_runtime::spawn` → `StreamableHttpService` 를 `axum Router`의 `/mcp`에 `nest_service`, `127.0.0.1:<port>` bind. `AppHandle`은 `OnceCell`/managed state로 캡처.
- **스레드 마샬링(중요)**: axum은 tokio worker에서 도는데 op-bus 변이·webview emit은 **메인/UI 스레드**여야 함 → 툴 본문은 `tokio::mpsc` command channel로 보내 메인 스레드(`app.run_on_main_thread`)에서 drain + `oneshot` reply. (직접 호출하면 Send/Sync·UI-thread panic.)
- **에이전트 연결**: `claude mcp add --transport http tf-hwp http://127.0.0.1:<port>/mcp --header "Authorization: Bearer <token>"`.
- **stdio 전용 에이전트(Claude Code 기본)**: 작은 **stdio↔loopback 브리지** 바이너리를 Tauri 사이드카(`externalBin`)로 동봉 → `claude mcp add --transport stdio`. (stdio 서버를 에이전트가 spawn하면 *이미 떠있는 창*에 못 닿으므로 브리지 필요.)

### 2.2 🔒 보안 (비협상 — 문서화된 실제 취약점 클래스)
- **loopback bind만**(127.0.0.1) + **Origin·Host 검증**(둘 다, allowlist; `Origin: null` 거부) — DNS-rebinding(rmcp <1.4.0 GHSA-89vp-x53w-74fx, MCP Python SDK CVE-2025-66416). 로컬 포트는 *악성 웹페이지의 fetch*로도 닿을 수 있음.
- **per-launch bearer token**(앱 시작 시 랜덤, 인앱 표시, `0o600` 파일; 로깅 금지). Figma/JetBrains/Obsidian 패턴.
- **인자 검증**: path/식별자 인자는 인증돼도 검증/샌드박스(Obsidian Local REST path-traversal CVE 교훈).
- **UDS 선호**: 가능하면 TCP 대신 `interprocess`(Unix domain socket / Windows named pipe) → 브라우저 도달 TCP 표면 제거.
- **destructive op**: 자율 에이전트가 무인 호출하므로 undo 체크포인트/dry-run/확인 고려.

### 2.3 편의 진입점 (A 위에 얹는 fire-and-forget)
- `tauri-plugin-single-instance`(2.3.6; `|app,argv,cwd|`로 두 번째 실행의 argv를 떠있는 인스턴스로 forward) + `tauri-plugin-deep-link`(`tf-hwp://` URI) + `tauri-plugin-cli`(argv 파싱). → `tf-hwp open doc.hwpx`로 창 포커스+로드.
- **한계**: 결과/스트림 채널 없음(응답 못 받음) → "파일 열기/명령 트리거"만, 메인 드라이버 아님. argv/deep-link는 spoofable → 스킴 재검증.

### 2.4 쓰면 안 되는 것
- `tauri-plugin-websocket` = **클라이언트 전용**(앱이 dial-out) → 외부 연결 못 받음.
- Tauri **sidecar/shell** = 앱이 부모로 자식 spawn(역방향) → 외부가 앱 제어 불가. (단 BYOK 로컬모델 helper엔 적합.)
- crates.io `tauri-plugin-mcp`(proj-airi) = MCP **클라이언트**(반대방향). 참고 구현은 **P3GLEG/tauri-plugin-mcp**, **dirvine/tauri-mcp**(둘 다 Tauri v2, Claude Code/Cursor↔라이브 Tauri 브리지).

---

## 3. AI 실행 모델 — BYOK + 로컬 LLM (Topology B)

### 3.1 `LlmProvider` trait (hwp-ai)
- AI 출력은 **항상 검증된 `hwp_ops::Op` 제안**(raw XML 없음) → 클라우드/로컬은 *백엔드 스왑*일 뿐, 새 변이 표면 없음.
- 편집 루프: 제안 op → scratch AST 적용 → **검증(round-trip + `validate_open_safety` + 오라클 수용)** → **diff 미리보기 → 사람 승인 → commit**. 자동 저장 금지. fill-from-source는 NodeId 인용.

### 3.2 BYOK 시크릿 저장
- **`keyring` 크레이트**(v4.0.1 / keyring-core; OS Keychain·Credential Manager·Secret Service) — **Tauri Rust 코어에서만**, **native-only feature-gated**(wasm 순수성 유지).
- 키는 **webview로 절대 노출 안 함**: 커맨드는 `set_api_key(provider,key)` / `key_status(provider)->bool`만. 키는 Rust LLM 호출 시점에만 읽고 `zeroize::Zeroizing`로 감싸 drop 시 0; 로그 금지.
- env/config fallback(`ANTHROPIC_API_KEY`)으로 헤드리스/CI 대응. **`tauri-plugin-stronghold` 금지**(Tauri v3에서 제거 예정).
- Linux는 Secret Service 부재 가능 → keyutils/sqlite-store/env로 graceful degrade(평문 저장 절대 금지).

### 3.3 Provider
- **Anthropic Claude (클라우드 BYOK, primary, 한국어 공문서 품질 최상)**: Messages API **직접 reqwest**(SSE 스트리밍, tool-use 블록 → typed-op 제안, 문서 outline에 prompt caching). 공식 Rust SDK 없음 → 직접 HTTP(또는 커뮤니티 crate를 리뷰 후 pin).
- **로컬/오프라인: Ollama**(OpenAI-호환 `/v1`, `format`=Op JSON-schema로 구조화 출력 강제, Tauri Channel로 스트림). 권장 기본 오프라인 백엔드.
- **미래(native feature): mistral.rs/candle 임베드**(GGUF in-process, Metal/CUDA) — 데몬 없는 경험; 단 무거운 native 의존 → **반드시 native-only·feature-gated**(wasm CI 깨짐 방지).

### 3.4 ⚠️ 한국어 모델 라이선스 함정 (load-bearing 결정)
- **LG EXAONE 4.0 = NC(비상업)** → 상용 한국어 공문서 편집기에 **번들 금지**(FriendliAI 등 라이선스 호스팅 경유만).
- **기본 로컬 모델 = Qwen3**(Apache-2.0, 한국어/CJK 강함), 보조 **Gemma**(open). 모델 레지스트리를 상업-허용 라이선스로 게이트.
- **Naver HyperCLOVA X SEED**(온디바이스 한국어 강력) — **라이선스 확인 후** 채택.
- 로컬 모델 한국어 공문서 품질 < Claude → **품질 vs 오프라인 토글** 노출, 공문서 기본은 Claude.

### 3.5 ACP 클라이언트(선택, 후순위)
- "내 에이전트를 앱 안에서 쓰기"(Zed/JetBrains ACP: 앱=클라이언트가 사용자의 에이전트를 stdio JSON-RPC로 spawn). **A(외부 터미널→앱)와 방향이 반대** — 혼동 금지. 인앱 BYO-agent UX가 필요할 때만.

---

## 4. 단계별 계획 (이 방향의 마일스톤)

- **A0 — 헤드리스 AI 코어 (GUI 불필요, 먼저) ✅ 완료**: `hwp-ai` `LlmProvider` trait + Anthropic(직접 HTTP, BYOK via env) + Mock. AST→Markdown projection(RAG). CLI `tf-hwp ai-fill <in.hwpx> --instruction "..." --out <out.hwpx>`(편집은 op-bus, export는 §M4). **AI가 검증된 .hwpx를 만든다(오라클 통과 확인).**
- **A0.5 — 키 없는 "Claude Code = LLM" 루프 + 템플릿 파이프라인 ✅ 완료**: §7 참고. `ai-context`(read 툴: 템플릿+문서맥락 출력) → 코딩 에이전트가 템플릿 준수 JSON 작성 → `ai-apply --content c.json --verify`(write 툴: 전처리→op→export→오라클). FormattingShowcase.hwpx에서 헤딩·부분 볼드·불릿·구분선·표 전부 오라클 렌더 확인, 원본 보존.
- **A1 — 헤드리스 MCP 서버 ✅ 완료**: `crates/hwp-mcp`(신규) — **self-contained MCP stdio 서버**(JSON-RPC 2.0 over newline-delimited stdin/stdout, **rmcp 미사용** → 버전 churn 회피 + 의존성 최소, "막히면 자체 구현" 원칙). 툴: `open_document`·`get_context`(템플릿+문서맥락)·`apply_content`(AiContent→op-bus)·`export_hwpx`·`extract_text`. `handle(req,&mut Session)` 순수 함수로 단위테스트 + 실 stdio 파이프 E2E + **에이전트 산출물 오라클 통과** 검증. 등록: `claude mcp add --transport stdio tf-hwp -- hwp-mcp`. (rmcp/Streamable-HTTP·Tauri 임베드는 A3에서.)
- **A2 — Tauri 뷰어 셸 (영역 #1) ✅ 완료**: `crates/hwp-viewer`(신규, Tauri 2.11.2 + tauri-plugin-dialog, withGlobalTauri 무-npm 프론트엔드). `#[tauri::command]` open_doc/render_page(rhwp SVG)/apply_content/export_hwpx — apply/export는 `hwp_mcp::handle` 재사용(단일 op-bus). 순수 로직 fn(detect_open/render_page_logic)로 헤드리스 단위테스트. **검증: 헤드리스 컴파일(default+rhwp) + clippy clean + 2 단위테스트(SVG 렌더, op-bus apply→export 오라클-safe)**. 윈도우 실행은 사용자(`cargo run -p hwp-viewer --features rhwp`; cargo-tauri 부재).
- **A3 — 셸에 제어 서버 임베드 (라이브 제어, Topology A) ✅ 완료**: rmcp/Streamable-HTTP 대신 **자체 std::net 루프백 HTTP 서버**(`hwp_mcp::server`, axum 미사용). `hwp-viewer::server::spawn`이 백그라운드 스레드에서 127.0.0.1:0 bind + per-launch 토큰(0600 cred 파일) + managed `Session` 잠금 후 `hwp_mcp::handle` + `emit("doc-changed")`. 보안(§2.2 fail-closed): 루프백 only, Host+Origin allowlist, Bearer 토큰 constant-time(subtle ct_eq), missing 토큰도 거부. `hwp-mcp --http`로 standalone 실행. **검증(헤드리스 curl): no-token→401, evil origin→403, GET→405, open→apply→export 정상, 산출물 오라클 통과, lsof로 127.0.0.1-only 확인, cred 0600**. 등록: `claude mcp add --transport http tf-hwp-live http://127.0.0.1:$PORT/mcp --header "Authorization: Bearer $TOK"`.
- **A4 — BYOK 인앱 패널 + 편집 심화(영역 #2)**: keyring 설정 UI, 품질/오프라인 토글, in-place 편집 op 확장.
- **A5 — 하드닝**: 보안 감사(Origin/Host/token/UDS), 모델 라이선스 게이트, destructive-op 확인, round-trip 골든.

---

## 5. 신규/변경 크레이트
- `hwp-ai` 확장: `LlmProvider` trait, Anthropic/Ollama provider(native feature), keyring 시크릿, projection, op 제안·검증 루프.
- `hwp-mcp`(신규): rmcp 서버(툴=Op 1:1 + 세션 verbs), stdio 모드(헤드리스) + Streamable-HTTP 모드(Tauri 임베드), 보안 레이어.
- `tf-hwp-app`(신규, Tauri 2): 뷰어 셸 + MCP HTTP 임베드 + single-instance/deep-link 편의 + BYOK 패널.
- 전부 native-only/feature-gated로 wasm 순수성 유지(`hwp-model/ops/ingest` 코어는 계속 wasm-clean).

---

## 6. 리스크 & 미검증 (구현 전 확인)
- **rmcp 버전 churn**: `StreamableHttpService`/`LocalSessionManager`/`#[tool]` 매크로 시그니처가 마이너 간 변동 → `cargo add rmcp` 후 docs.rs로 정확한 시그니처 pin.
- **DNS-rebinding/loopback 노출**: Origin+Host 검증 + token 필수(옵션 아님).
- **스레드 affinity**: op-bus/emit는 UI 스레드 → command channel + run_on_main_thread.
- **EXAONE NC 라이선스**: 상업 번들 금지; Apache-2.0(Qwen3) 기본.
- **로컬 추론 native 의존**: wasm CI와 충돌 → native-only feature-gate 엄수.
- **키 누출**: 로그 redaction + zeroize 강제(가장 흔한 실제 사고).
- **포트/세션 disambiguation**: 다중 인스턴스 시 어떤 문서/창에 붙는지(JetBrains는 IDE_PORT 노출) 명시.

---

## 7. 템플릿 → 생성 → 전처리 → 이식가능 OWPML 파이프라인 (A0.5, 구현됨)

사용자 방향: *"AI가 작성할 때 준수해야 하는 템플릿(테이블·도표·볼드·폰트·구분선)을 정의 → 그 템플릿 기반 생성 결과를 받아 → 전처리하여 실제 이식가능한 코드로 변경해서 반영"*. 이를 키 없이(=Claude Code가 LLM 역할) 검증했다.

### 7.1 데이터 흐름 (모든 단계가 op-bus를 통과 — 원시 바이트/XML 직주입 없음)
```
template_brief()  ─(read 툴: ai-context)→  코딩 에이전트(또는 LLM)가 템플릿 준수 JSON 작성
        │                                              │
        │                                     AiContent { blocks:[Heading|Paragraph(runs:bold)|Bullet|Divider|Table] }
        ▼                                              ▼
  parse_content (검증)  ──→  compile_to_ops (전처리)  ──→  Vec<Op>  (AppendRichParagraph{runs: bold} / AppendParagraph)
        │                                              │
        ▼                                              ▼
   hwp_ops::apply (단일 변이 표면, dirty-mark)  ──→  serialize_hwpx (verbatim passthrough, dirty-only 재직렬화)
        │                                              │
        ▼                                              ▼
   validate_hwpx (싼 게이트, pre-filter)  ──→  ORACLE (LibreOffice+H2Orestart, 권위 게이트) ──→ .hwpx
```

### 7.2 핵심 설계 결정
- **AI는 자유 산문/원시 XML이 아니라 *구조화 JSON 템플릿*만 출력**한다 → 모델이 무엇을 만들든 표면(스키마)은 고정, 컴파일러만 더 풍부한 OWPML을 낸다. 모델 교체/업그레이드에 안정적.
- **전처리기 = `compile_to_ops`**: 구조화 콘텐츠 → 타입 안전 `hwp_ops::Op`("이식 가능한 코드"). 사람 편집과 *동일한* op-bus를 통과하므로 검증·dirty·round-trip-safe export를 공짜로 얻는다.
- **네이티브 볼드**: `bold:true` → `RunSpec{bold}` → `char_shape==1` 관례 → `patch_section_xml`이 헤더 풀에서 *문서의 실제 bold charPr*를 `find_bold_charpr`로 찾아 `charPrIDRef`로 재사용(없으면 plain로 폴백). 가짜 ref가 아니라 진짜 OWPML 볼드 → 오라클이 볼드로 렌더 확인.
- **권위 게이트는 오라클**: 싼 byte-check(`validate_hwpx`)는 pre-filter일 뿐 — 손수 만든 최소 fixture(corpus/sample.hwpx)는 싼 게이트는 통과하나 오라클은 거부. 실제 도구 산출 HWPX(FormattingShowcase/Skeleton/00_smoke_min)만 권위 검증의 소스로 사용.

### 7.3 CLI 표면 (둘 다 키 없음 = MCP-유사 read/write 툴 쌍)
- `tf-hwp ai-context <in.hwpx>` — **read 툴**: `template_brief()`(준수할 스키마) + 문서 맥락(`to_markdown`) 출력. 코딩 에이전트가 이걸 읽고 JSON을 만든다.
- `tf-hwp ai-apply <in.hwpx> --content c.json [--out o.hwpx] [--verify]` — **write 툴**: parse→compile→apply→export(+오라클 verify).

### 7.4 현재 블록 커버리지 & 다음 단계 (같은 계약 아래 성장)
| 블록 | 현재(MVP) | 다음(네이티브 OWPML) |
|---|---|---|
| heading | 볼드 문단 | 스타일(styleIDRef) 매핑 + 개요 번호 |
| paragraph(runs) | **네이티브 부분 볼드** ✅ | italic/underline/색상/폰트(charPr 풀 확장·신규 charPr 합성) |
| bullet | `• ` 접두 문단 | 네이티브 numbering/bullet 문단 속성 |
| divider | 罫선 문자열 문단 | 네이티브 `<hp:p>` 테두리/`hh:border` 또는 도형 |
| table | **네이티브 `<hp:tbl>`** ✅ (행/열·헤더 볼드·실제 테두리; `Op::AppendTable`→`emit_table`, `borderFillIDRef`은 `find_table_borderfill`로 기존 표/헤더 풀에서 재사용) | 셀 병합(colSpan/rowSpan), 셀 정렬/배경, 다중 문단 셀 |
| 도표/chart | — | OWPML chart part 또는 이미지 임베드(영역 #1과 합류) |

> **네이티브 표 완료(2026-06-16)**: 11블록 content.json → 3×5 표가 오라클에서 실제 테두리 표로 렌더(헤더 볼드), 원본 보존. 다음 우선순위: 셀 병합 + 폰트/색상 charPr 합성(신규 글자모양을 헤더 풀에 추가) + 네이티브 bullet/구분선. JSON 스키마(`AiContent`)는 그대로 두고 `compile_to_ops`+serializer만 깊어진다.
