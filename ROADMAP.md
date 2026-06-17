# tf-hwp — 프로덕션 레디 로드맵 (상세)

> 목표(Production DoD): 사용자가 **.hwp/.hwpx 업로드 → 원본 그대로 뷰 → 수정 → .hwpx 다운로드(export = HWPX only)**.
> 본 로드맵은 [PLAN.md](./PLAN.md)·[CHECKLIST.md](./CHECKLIST.md)·[docs/DEPENDENCY-STRATEGY.md](./docs/DEPENDENCY-STRATEGY.md) 위에서 마일스톤을 정의한다. 검증은 루트의 `benchmark.hwp`로 한다([docs/FIDELITY.md](./docs/FIDELITY.md)).

---

## 0. 추천 다음 작업 (immediate next)

**M1: rhwp 벤더링 + read→render 와이어업(충실 뷰).**
근거: ① 북극성이 "원본 그대로 표시"이고, 그걸 **검증 가능한 형태**(benchmark fidelity 게이트)로 만드는 가장 빠른 길이다. ② 벤치마크는 HWP5이고, 레거시/공공 문서 대부분이 HWP5라 어차피 HWP5 ingest는 rhwp 부트스트랩이 필요하다. ③ rhwp는 표/이미지/차트/수식/한국어 타이포(자간·장평·금칙·옛한글)를 *이미* 렌더하므로, 뷰 신규작업이 최소다.
→ 이 뒤에 곧바로 M4(자체 HWPX 직렬화기=해자)로 편집→export 절반을 채운다.

> rhwp 의존은 trait 뒤 부트스트랩일 뿐이며, M2(타이포)·이후 단계에서 모듈 단위로 우리 구현으로 교체한다(교체 사다리).

---

## 1. 범위: export = HWPX only (확정)

**출력은 `.hwpx` export only.** (2026-06-15 사용자 확정 — 한때 `.hwp` 다운로드를 검토했으나 철회.)
- 바이너리 `.hwp` 쓰기는 **생태계 미해결 최난도**이고 — 충실한 .hwp 쓰기는 Windows COM + 유료 한컴뿐, FOSS는 HWPX만 충실히 씀 — 우리 목표(크로스플랫폼·퍼미시브·한컴 비종속)와 상충하므로 **제품 스코프에서 제외**한다.
- 온나라 2026-05-18 HWPX 의무화와도 정렬. .hwp 입력은 계속 지원(읽기/변환), 출력만 HWPX.
- (미래 옵션, 비-스코프) 진짜 .hwp 저장이 필요하면 선택적 Windows COM 사이드카(유료 한글)로 분리 가능하나 로드맵 밖이다.

---

## 2. 마일스톤

각 마일스톤: **목표 · 작업 · Exit(게이트) · 리스크**. Exit의 fidelity 게이트는 `benchmark.hwp` 기준.

### M0 — 기반 스캐폴드 ✅ (완료)
- 12-crate 워크스페이스, capability trait 경계, CLI(detect/info/extract-text/oracle/fidelity), wasm 위생, CI, fidelity 하베스 골격.
- Exit ✅: `cargo build/test/clippy -D warnings`/wasm32 green; `tf-hwp fidelity`가 벤치마크를 hwp5로 인식하고 전제조건 보고.

### M1 — 충실 뷰 (read-only) ⭐원본그대로 — *다음 작업*
- **목표**: benchmark.hwp(및 .hwpx)를 업로드하면 원본 그대로(표/이미지/차트/수식 포함) 화면에 표시.
- **작업**:
  - `scripts/vendor-rhwp.sh` 실행 → `external/rhwp` 포크 서브모듈(v0.7.15 pin), native+wasm32 빌드 검증, `native-skia` 등 C 의존 wasm 제외 확인.
  - `hwp-rhwp`(feature `rhwp`): rhwp `Document` IR ↔ 우리 `SemanticDoc` 어댑터(모든 노드 provenance + passthrough + dirty=false). UI/AI는 rhwp 타입 미접근.
  - `getPageLayerTree`(PageLayerTree schemaVersion 1) 소비 → `hwp-render` Canvas/WebGL 페인트. 미편집 문단 LineSeg replay.
  - `tf-hwp-app`(Tauri 2) + `ui/`(TS/React) 최소 뷰어 셸: 파일 열기 → 페이지 렌더 → 스크롤/줌.
  - 오라클 준비: `scripts/install-h2orestart.sh`로 H2Orestart 설치 → `tf-hwp oracle benchmark.hwp` 레퍼런스 PDF 생성.
  - `hwp-fidelity`: 페이지별 SSIM/structural diff 스코어러 구현 + green/yellow/red 밴드.
- **Exit (fidelity 게이트 ON)**:
  - benchmark.hwp + corpus가 뷰어에 렌더된다.
  - `hwp-fidelity` 비교가 동작: benchmark **모든 페이지 Red 0** (green/yellow만), 합의 tolerance에서.
  - `cargo test -p hwp-fidelity -- --ignored`의 `benchmark_oracle_reference_renders`·`benchmark_engine_matches_original` 통과.
- **리스크**: rhwp wasm 빌드(Docker wasm-pack), LFS 대용량, pre-parity 정합성(차트/옛한글/세로쓰기). → 오라클 폴백 뷰 + known-divergence allowlist.

### M2 — 타이포그래피 분리 + 한국어 정합성 하드닝 ⭐1
- **목표**: 타이포를 교체 가능한 모듈로 분리하고 한컴급 한국어 조판 정합성 확보.
- **작업**:
  - `hwp-typeset` 경계 함수 확립: `layout(runs+charPr, paraPr, geometry, FontMetricsProvider, writing_mode) -> LineSeg + PageLayout`.
  - rhwp 한계 보강: widow/orphan, keep flags, useKerning 매핑. (선택) **harfrust** 셰이퍼 PoC + wasm32 빌드 검증, `icu_segmenter`(UAX#14) + **금칙 post-filter**, Hanyang PUA→첫가끝 테이블.
  - HWPX BinData 임베드 폰트 추출 + 결정적 fallback 정책(폰트 부재 시 줄바꿈 안정).
  - 정합성 골든 4종(자간/장평·배분·나눔·금칙·줄간격 4모드) 스위트.
- **Exit**: benchmark fidelity 점수 ≥ 임계치(예: 페이지 평균 green); 한국어 타이포 골든 스위트 green; native==wasm 줄바꿈 동일성.
- **리스크**: 한컴 정렬/금칙 알고리즘 비공개 → 오라클 기반 허용오차 reverse-engineering.

### M3 — 편집 코어 + op-bus(Wave 1) ⭐3
- **목표**: 한글식 편집(텍스트/서식/표/이미지/스타일/번호/페이지·구역/머리꼬리말/각주/책갈피/하이퍼링크) — UI·AI 공용 op로.
- **작업**:
  - `hwp-ops` Op 적용기: SemanticDoc 변이 + dirty 마킹 + undo/redo. 서식은 property-set(intern).
  - 증분 재레이아웃(dirty 영역만 typeset 재실행) → 인터랙티브.
  - 표: 행/열 삽입·삭제, 병합(셀 비활성화 관례)·분할, 셀 테두리/여백.
  - 구역 op 선행(페이지 설정·단·머리꼬리말이 section-scoped).
  - Tauri UI: 리본 Wave 1 컨트롤 바인딩(컨트롤 1개 = op 1개).
- **Exit**: benchmark에서 텍스트/서식/표 편집 후 재렌더가 충실(편집 영역 외 변화 없음); op 1개당 undo/redo 라운드트립.
- **리스크**: 증분 레이아웃 정확도; 편집 후 정합성 회귀 → fidelity 게이트로 가드.

### M4 — HWPX export + round-trip 안전 커널 🎯 .hwpx 다운로드 완료
- **목표**: 편집 결과를 **한컴이 여는** .hwpx로 무손실 저장.
- **작업** (`hwp-hwpx` 자체 직렬화기):
  - 🔴 PR#40 3종: `standalone="yes"` + 15 HWPML 네임스페이스 surface + mimetype-first/STORED·ZIP 순서/ZipInfo 보존.
  - 🔴 dirty-only 재직렬화: 미편집 part = 원본 바이트 verbatim, dirty만 재생성.
  - `package_validator` acceptance 게이트 포팅(블로킹 마커 + 표/secPr 필수 자식 + ID 정합성 signed-int32).
  - 이미지 3-step(BinData+manifest+binItem→`<hp:pic>`), 표 필수 자식·병합 비활성화, dirty 섹션 stale lineseg strip, macOS hint.
  - 기능별 골든 round-trip 테스트(캡션/메모/표 pageBreak/차트데이터/여백/탭) + 오라클 한컴 수용 게이트(CI).
- **Exit**:
  - benchmark → (편집) → .hwpx → 우리 엔진 재오픈 + 오라클 수용; **미편집 part byte-equal**, 편집 part 의미-equal.
  - round-trip 실패 기능 편집은 비활성(조용한 손상 0).
  - **= 프로덕션 코어(업로드·뷰·편집·.hwpx 다운로드) 달성 — 유일한 export 포맷.**
- **리스크**: 한컴 strict 파서 거부 → 오라클(+가능 시 실제 한글) 게이트 반복.

### M5 — AI 레이어 + 로컬 실행 + 터미널→Tauri 제어 ⭐2 → 상세: [docs/AI-LOCAL-CONTROL-PLAN.md](./docs/AI-LOCAL-CONTROL-PLAN.md)
- **두 topology(혼동 금지)**: (A) **앱 내장 MCP 서버**(rmcp, loopback HTTP) = *외부 터미널/에이전트가 살아있는 Tauri 편집기 제어*, 툴=Op 1:1; (B) **BYOK AI 패널**(`LlmProvider` trait, keyring) = *앱이 LLM 호출*. 둘 다 같은 op-bus + round-trip 검증 통과.
- **작업(헤드리스 먼저)**: `hwp-ai` `LlmProvider`(Anthropic 직접 HTTP + Ollama 오프라인, 키는 keyring·native-only·webview 노출 금지) + AST→Markdown projection + op 제안→검증(round-trip + 오라클)→diff→승인→commit → CLI `tf-hwp ai-fill`. 이어서 `hwp-mcp`(rmcp stdio→Tauri 임베드 HTTP, 보안: loopback+Origin/Host+per-launch token+UDS, 스레드 마샬링). stdio 브리지 사이드카로 Claude Code 연결.
- **모델 라이선스 함정**: EXAONE 4.0=NC(상업 금지) → 기본 로컬 **Qwen3(Apache-2.0)**. rmcp 버전 docs.rs pin.
- **Exit**: 터미널/Claude Code가 MCP로 라이브 편집기를 구동해 AI가 문단/내용 추가 → 검증·diff 후 .hwpx 저장; BYOK 키 OS keychain.
- **리스크**: 공문서 오작성 → diff+인용+사람 commit; loopback 보안(DNS-rebinding/token); 키 누출(zeroize/redact).

### M6 — 앱/UX 프로덕션화
- Tauri 앱 폴리시: 파일 open/save 다이얼로그, 최근 문서, 5-상태(빈/로딩/에러/성공/스켈레톤), IME/접근성.
- 리본 Wave 1 전 UI, 키바인딩, 다국어 문자열.
- 성능: 대용량 문서(증분 레이아웃, lazy per-page typeset, OffscreenCanvas worker), 메모리 예산.

### M7 — 하드닝 / 보안 / QA
- 배포용/비밀번호 `hwp-crypto`(필요 시; golden-vector MSVC-rand→SHA-1→AES-128-ECB, fail-closed).
- 광역 코퍼스 QA(공공 템플릿), 파서 퍼징, 신뢰불가 입력 안전(임베드 OLE/스크립트 미실행).
- 텔레메트리/크래시 리포팅(옵트인), fidelity 회귀 대시보드.

### M8 — Beta → GA
- 패키징/서명/공증(macOS notarization), Windows/Linux 빌드, 자동 업데이트.
- 라이선스 컴플라이언스 감사(`cargo deny`), 서드파티 고지, 폰트 라이선스.
- 문서/온보딩, 성능 예산 SLA, 릴리스.

---

## 3. fidelity 게이트 진행 (benchmark 중심)
| 마일스톤 | 게이트 | 명령 |
|---|---|---|
| M0 ✅ | 포맷 인식 = hwp5 | `tf-hwp fidelity` / `cargo test -p hwp-fidelity` |
| M1 | 오라클 레퍼런스 렌더 + 엔진 렌더, 페이지 Red 0 | H2Orestart 설치 후 `--ignored` 테스트 |
| M2 | 한국어 타이포 정합성 ≥ 임계치 | 골든 4종 + benchmark 평균 green |
| M3 | 편집 후 재렌더 충실(영역 외 무변화) | 편집 시나리오 fidelity diff |
| M4 | benchmark→편집→.hwpx round-trip 무손실 + 오라클 수용 (유일 export) | round-trip 골든 + acceptance 게이트 |

전제조건(M1 ON): `scripts/install-h2orestart.sh`(오라클) + `scripts/vendor-rhwp.sh`(엔진 렌더). `tf-hwp fidelity`가 충족 여부를 실시간 보고.

---

## 4. Export Definition of Done — `.hwpx` (M4, 유일 포맷)
- 한컴 Win/macOS가 손상 없이 연다 · 미편집 콘텐츠 byte-equal · 편집 콘텐츠 의미 보존 · `validate_editor_open_safety` + 오라클 수용 게이트 통과.

## 5. 컷라인 (MVP vs Full)
- **MVP(데모 가능)** = M1+M2 (업로드·원본 뷰).
- **프로덕션 코어** = +M3+M4 (편집·.hwpx 다운로드) — *제품 완성의 핵심.*
- **풀 프로덕션** = +M5(AI)+M6~M8(앱/하드닝/GA).
- 자원 제약 시 우선순위: M1 → M4 → M3 → M2 하드닝 → M5.
