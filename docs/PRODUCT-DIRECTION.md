# tf-hwp 제품 방향 v1 — "코어 하나, 셸 셋" (2026-07-02)

> 이 문서는 **아키텍트(설계자)가 빌더(Opus 4.8 workflow)에게 내리는 총괄 지시서**다.
> 각 작업 단위는 `docs/issues/007`~`016`에 빌더블 이슈로 쪼개져 있고, 이 문서는
> (1) 왜 이 방향인가, (2) 레드팀 진단 결과, (3) 모든 이슈가 공유하는 **빌더 공통 계약**을 담는다.
> 빌더는 이슈 하나를 잡기 전에 반드시 이 문서의 §4(공통 계약)를 읽어야 한다.

---

## 1. 두 가지 목표

**목표 1 — 압도적 사용성 (데스크톱).** hwp 업로드 → 원본과 거의 동일한 렌더 →
특정 지점을 **마킹**하고 채팅으로 **바이브편집** → 원하는 콘텐츠(회사 약력 표,
대주제/소주제 불릿 정렬 등)를 AI와 함께 완성.

**목표 2 — 헤드리스/이식 (에이전트·웹).** business_plan_k·에르메스 같은 외부
에이전트가 hwp를 던지면 우리 형식으로 변환, AI와 티키타카로 편집, 결과를 렌더하고
PDF로 export. 에이전트 쪽은 서비스(컨테이너) 호출로, **사이트 안에서는 엔진 자체를
이식(wasm)** 해서 채팅 패널로 문서 작업 후 PDF 다운로드까지.

## 2. 아키텍처: 코어 하나, 셸 셋

엔진 코어(파싱 `hwp-ingest`/`hwp-rhwp`/`hwp-hwpx` → IR `hwp-model` → 레이아웃
`hwp-typeset` → 렌더 `hwp-render` → export `hwp-export`(HTML/krilla PDF) → 편집
`hwp-ops`/`hwp-ai`/`hwp-mcp`)는 이미 헤드리스-우선으로 지어져 있다(`tf-hwp-cli`가 증명).
문제는 **셸 로직이 Tauri 커맨드(`hwp-viewer/src/lib.rs`, 2,259줄)에 갇혀 있는 것**.

```
                  ┌─ hwp-session (신규 파사드, 이슈 012) ────────────┐
 코어 크레이트 →  │ open() → pages()/svg(n) → hit_test()/geometry     │
                  │ apply(Intent) → diff → export_pdf()/export_html() │
                  └───────┬─────────────┬──────────────┬─────────────┘
                   Shell A│      Shell B│       Shell C│
                   Tauri 앱      서비스/MCP       WASM npm
                   (기존, 얇게)  (Docker, 013)    (웹 이식, 015+016)
```

- **계약은 Intent JSON**(이슈 008). 세 셸과 외부 에이전트가 전부 같은 언어로 문서를 조작한다.
- **Shell B**: `hwp-mcp`를 stdio MCP + HTTP 겸용 바이너리로 → Docker 이미지 →
  business_plan_k의 Python `hwp-converter`(services/hwp-converter)를 교체.
- **Shell C**: 코어를 wasm32로 빌드해 npm 패키지화. 렌더가 SVG "문자열"이므로 브라우저
  캔버스 불필요. React 뷰어/채팅 컴포넌트는 `hwp-viewer/ui`에서 분리해 재사용.
  AI 호출만 서버사이드(키 보호), op 적용·렌더·PDF는 브라우저 안 wasm에서.

## 3. 레드팀 진단 (2026-07-02)

각 항목은 심각도 / 영향 단계 / 완화책(→담당 이슈)을 명시한다. **빌더는 자기 이슈에
연결된 R-항목을 수용 기준으로 취급하라.**

| # | 발견 | 심각도 | 단계 | 완화 → 이슈 |
|---|------|--------|------|------------|
| R1 | **루프백 보안 모델 붕괴**: 현 HTTP 서버(`hwp-mcp/src/server.rs`)의 안전성은 ①127.0.0.1 바인딩 ②Host/Origin 루프백 allowlist ③per-launch 토큰 3중 가정 위에 있다. Docker/네트워크 서비스로 바꾸는 순간 ①이 깨지고, Host 검사를 열면 DNS-rebinding 방어가 사라진다 | **Critical** | P3 | 네트워크 모드는 별도 opt-in 모드로 분리: 사설망/사이드카 전제, env 시크릿 bearer, Host 검사 재설계, 절대 공인망 직노출 금지 → **013** |
| R2 | **단일 전역 Session = 멀티테넌시 없음**: `Mutex<Session>` 하나 + sequential accept. 두 에이전트가 동시에 쓰면 문서 교차 오염 | **Critical** | P3 | v1은 "1 컨테이너 = 1 작업" 사이드카 모델로 회피(코드 최소), 공유 서비스는 session-id 맵 도입 전까지 금지 → **013** |
| R3 | **임의 파일 경로**: `open_document`/`save`가 경로를 그대로 받음 → 컨테이너 path traversal, 볼륨 마운트 시 호스트 파일 노출 | High | P3 | `WORKSPACE_ROOT` 밖 canonicalize-후-거부 → **013** |
| R4 | **신뢰불가 HWP 입력 DoS**: 인터넷발 .hwp/.hwpx — zip bomb, 깊은 중첩 표, 손상 CFB → OOM/패닉. 현 방어는 요청 1MiB 한도+connection catch_unwind뿐 | High | P3·P4 | 압축해제 상한·중첩 깊이 상한·컨테이너 mem/cpu limit·패닉=요청 실패(프로세스 생존)·퍼징 픽스처 → **014** |
| R5 | **문서 내용발 프롬프트 인젝션**: ai-edit/ai_fill이 문서 텍스트를 LLM 컨텍스트에 삽입. 악성 문서의 지시문이 에이전트 체인(에르메스→MCP→LLM)으로 전파 가능 | High | P1·P3 | 문서 텍스트는 델리미팅된 데이터 블록으로만, side-effect는 Intent 화이트리스트로만(자유 tool 호출 금지 유지), tool result에 문서 원문 인용 최소화 → **010**, **013** |
| R6 | **keyring 부재**: `hwp-ai` BYOK가 keyring 기반 — 컨테이너/wasm엔 없음. 웹에 API 키를 내리면 즉시 유출 | Medium | P3·P4 | LlmProvider에 env-var 경로 추가(서비스), 웹은 LLM 호출을 서버 프록시로 — wasm은 op 적용만 → **013**, **015** |
| R7 | **SVG 웹 주입(XSS)**: 자체 렌더 SVG를 DOM에 삽입 — 문서 유래 문자열이 벡터가 될 수 있음. 앱은 `sanitize.ts`+CSP로 방어 중 | High | P4 | npm 패키지에 sanitizer 내장, "비-sanitize 삽입 불가" API 형태로 강제 → **016** |
| R8 | **폰트 재배포 라이선스**: wasm/npm에 폰트 임베드 = 재배포. 함초롬/한컴 폰트는 재배포 불가 | High(법적) | P4 | OFL 폰트(Noto Sans KR 등)만 번들, 대체 메트릭 정책 명문화(`docs/LICENSE-POLICY.md` 확장) → **015** |
| R9 | **wasm 미검증 가정**: HWP5 파싱이 vendored rhwp 경유 — wasm 컴파일 미검증. krilla/getrandom wasm 피처 미검증. 최악: 웹 v1은 HWPX 전용+변환은 서비스 경유 | Medium | P0·P4 | P0 스모크 빌드가 선판정, 실패 시 폴백 아키텍처(웹=HWPX only) 채택 → **007** |
| R10 | **P2 추출 중 LOCKSTEP 회귀**: 2,259줄 이동은 place_doc/NaiveLayout 게이트를 깨기 쉬움 | High | P2 | 이동 전 golden 고정(페이지 수+SVG 바이트 해시), "이동만, 수정 금지" 규율, 단계별 게이트 → **012** |
| R11 | **스키마 동결 후 전방 호환**: 외부 소비 시작 후엔 깨는 변경 불가. unknown-field 정책/버전 필드/에러 계약 미정 | Medium | P0 | v0에서 명시: `intent_version`, unknown field는 **보존 아닌 명시적 거부**, 에러 코드 표 → **008** |
| R12 | **business_plan_k 전환 리스크**: Python hwp-converter와 출력 계약이 다르면 다운스트림 파손 | Medium | P3 | 병행 운용 + 픽스처 패리티 테스트 통과 후 스위치, 롤백 경로 유지 → **013** |
| R13 | **장수 세션 메모리**: undo 스택·렌더 캐시 무한 성장(서비스/웹 장시간 세션) | Low | P3·P4 | undo 상한(N=50)+캐시 상한, 세션 TTL → **013**, **015** |

**레드팀 총평**: 방향 자체를 뒤집는 발견은 없음. 다만 ①P3는 "지금 서버를 그대로
노출"이 아니라 **사이드카 모델 + 경로 감금 + 입력 하드닝(014 선행)** 으로 가야 하고,
②P4는 P0 스모크 결과에 따라 **웹 v1 = HWPX 전용** 폴백을 처음부터 설계에 포함해야 하며,
③폰트 라이선스는 코드보다 먼저 정리해야 한다(법적 리스크는 롤백이 안 된다).

## 4. 빌더 공통 계약 (모든 이슈에 적용 — 위반 시 그 작업은 실패)

### 4.1 불변식
1. **게이트**: `benchmark.hwp`는 **8페이지 == 8페이지**를 유지해야 한다. 레이아웃을
   건드리는 모든 변경 후 실행:
   ```bash
   cargo run -q -p tf-hwp-cli --features "shaper rhwp" -- layout-check benchmark.hwp
   ```
   (98.9% 줄바꿈 정확도 이하로 떨어져도 실패로 간주.) `benchmark1.hwp`는 현재 19쪽
   (한컴 18) — **더 나빠지면 안 됨**.
2. **LOCKSTEP**: `hwp-typeset/src/place.rs::place_doc`과 `hwp-typeset/src/lib.rs::NaiveLayout`의
   페이지 수는 항상 일치해야 한다. 오라클은 NaiveLayout을 쓴다. 한쪽만 고치지 마라.
3. **rhwp는 수정 금지**: `external/rhwp`는 vendored 서브모듈. 어댑터는 `crates/hwp-rhwp`에서만.
4. **rhwp는 파싱 전용**: 렌더는 항상 우리 IR에서. rhwp 출력물 패치 금지.
5. **단위**: 자체 렌더 지오메트리 커맨드(own_hit_test/table_at/…)는 **px**(=HWPUNIT/75),
   ops는 **HWPUNIT**. 변환은 커밋 시점에. 단위 슬립은 조용히 클릭선택/이동/리사이즈를 죽인다.
6. **사용자 콘텐츠 삭제 금지**, 커밋/푸시는 명시 요청 시에만.
7. 에디터 관련: 에디터는 순수 `#000`으로 렌더해야 함(스냅샷 no-op·서식 보존 로직 전제).
   커밋은 `SetTableCellRuns`/`SetParagraphRuns` 경유(평문 variant는 run을 붕괴시킴).

### 4.2 검증 스위트 (이슈별 명시가 없어도 전부 실행)
```bash
cargo test -p hwp-ops        # 63+ 통과
cargo test -p hwp-typeset    # 39+ 통과
cargo test -p hwp-mcp        # 보안 술어 포함
cargo run -q -p tf-hwp-cli --features "shaper rhwp" -- layout-check benchmark.hwp
# UI를 건드렸으면:
cd crates/hwp-viewer/ui && npx tsc --noEmit && npm run build
```

### 4.3 작업 방식
- **조사 → 구현 → 적대적 자기리뷰 → 게이트 → 보고** 순서. 구현 전에 이슈의
  "파일 지도"에 적힌 파일을 실제로 읽고 이슈 서술과 코드가 어긋나면 **멈추고 보고**.
- 이슈의 "수용 기준"은 전부 체크리스트다. 하나라도 미달이면 미완으로 보고.
- 스코프 밖 리팩터 금지. 특히 이슈 012 이전에 viewer 로직을 "겸사겸사" 이동하지 마라.

## 5. 로드맵 → 이슈 맵

| 단계 | 이슈 | 제목 | 의존 |
|------|------|------|------|
| P0-A | [007](issues/007-wasm-smoke-build.md) | wasm 스모크 빌드 (코어 9크레이트/11조합 wasm32 판정 → **A안 확정**) | — |
| P0-B | [008](issues/008-intent-schema-v0.md) | Intent 스키마 v0 동결 + 버저닝 | — |
| P1-A | [009](issues/009-anchor-chips.md) | 앵커 칩: 마킹 → 채팅 컨텍스트 | — |
| P1-B | [010](issues/010-ai-preview-apply-undo.md) | AI 편집 프리뷰→적용 게이트 + undo | 009 |
| P1-C | [011](issues/011-content-presets.md) | 콘텐츠 플로우 프리셋 (약력 표·불릿 정렬) | 009, 010 |
| P2 | [012](issues/012-hwp-session-extraction.md) | `hwp-session` 파사드 추출 | 008 |
| P3-pre | [014](issues/014-input-hardening.md) | 신뢰불가 입력 하드닝 (R4) | — |
| P3 | [013](issues/013-headless-service-container.md) | 헤드리스 서비스 컨테이너 (R1·R2·R3·R6·R12) | 012, 014 |
| P4-A | [015](issues/015-wasm-npm-package.md) | wasm npm 패키지 (R6·R8·R9·R13) | 007, 012 |
| P4-B | [016](issues/016-react-component-library.md) | React 뷰어/채팅 컴포넌트 라이브러리 (R7) | 015 |

권장 착수 순서: **007 ∥ 008 ∥ 009** (상호 독립, 병렬 가능) → 010 → 011 ∥ 012 → 014 → 013 → 015 → 016.
