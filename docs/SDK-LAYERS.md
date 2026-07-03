# tf-hwp SDK 레이어 설계 v1 (2026-07-03)

> 목표: **"라이브러리를 웹/앱에 이식하는 사람의 부담 최소화"** + **"우리 에디터 UI에 강제되지
> 않는 커스텀 자유"**. TipTap/ProseMirror의 headless 패턴을 따른다 — 코어는 상태와 커맨드만,
> UI는 선택적 바인딩.

## 레이어와 역할 (경계 = 계약)

```
┌────────────────────────────────────────────────────────────────────┐
│ L4  호스트 앱 (창업지원도움e / apps/hwp-lab / Tauri 앱 / 커스텀)     │
│      · LLM 서버 프록시 구현(키 보관) · 자체 UI 또는 L3 조립           │
├────────────────────────────────────────────────────────────────────┤
│ L3  @tf-hwp/react  — 선택적 UI 바인딩 (전부 교체 가능)               │
│      · HwpPageView/SelectionOverlay/ChatPanel/FontPicker/룰러/툴바    │
│      · L2의 상태를 구독해 그릴 뿐 — 로직 없음                         │
├────────────────────────────────────────────────────────────────────┤
│ L2  @tf-hwp/editor-core (신규) — headless 에디터, 프레임워크 무관     │
│      · DocSession: 열기/페이지/재조판 신호/undo/폰트                  │
│      · SelectionModel: 셀·블록·마퀴·⌘토글 (021/023 로직 하강)        │
│      · EditController: Intent 조립·적용·프리뷰 게이트                 │
│      · 이벤트 구독(onChange/onSelection/onLayout) — React 불필요      │
├────────────────────────────────────────────────────────────────────┤
│ L2' @tf-hwp/ai-protocol (신규) — LLM 통신 규격 (벤더 중립, 동형)      │
│      · 타입: EditRequest{instruction,anchors,docContext} /            │
│              EditResponse{intents} · intent_version                   │
│      · buildDocContext(session, anchors) — R5 펜스 포함               │
│      · buildSystemPrompt(옵션: 허용 intent 서브셋) — INTENT-SCHEMA 발췌│
│      · validateResponse(json) — 화이트리스트+스키마 검증              │
│      → 서버(프록시)와 클라 양쪽에서 import — LLM 벤더는 호스트 자유    │
├────────────────────────────────────────────────────────────────────┤
│ L1  @tf-hwp/engine (wasm) / hwp-mcp lib (Tauri·서비스) — 헤드리스 엔진│
│      · 파싱(IR)·조판(px)·렌더(SVG)·지오메트리·Intent 적용·undo·export │
│      · UI 개념 없음. 상태는 문서뿐. EngineAdapter 계약으로 추상화      │
└────────────────────────────────────────────────────────────────────┘
```

## 커스텀 계약 (강제하지 않는 것들)
- **UI**: L3 없이 L2만으로 완전한 에디터 구축 가능(모든 상태는 이벤트+getter). L3 컴포넌트는
  개별 import 가능(트리셰이킹), CSS는 네임스페이스드(hw-*) — 오버라이드 자유.
- **LLM**: ai-protocol은 **타입과 검증만** 제공 — 어떤 모델/벤더/스트리밍이든 호스트가 결정.
  프록시 참조 구현은 apps/hwp-lab의 route.ts (문서화된 예시일 뿐).
- **렌더 표면**: 엔진 출력은 SVG 문자열 — L3의 HwpPageView 대신 호스트가 직접 그려도 됨
  (단 sanitize 의무는 계약으로 명시 — sanitizeSvg export).
- **셸 대칭**: EngineAdapter 인터페이스(open/pageSvg/geometry/applyIntent/undo/export/registerFont)가
  WasmAdapter(웹)와 TauriAdapter(앱)의 공통 계약 — editor-core는 어댑터만 보고 동작하므로
  Tauri 앱도 같은 L2/L3를 소비 가능(장기 통합 경로).

## 하지 않는 것 (경계 위반 금지)
- L1에 선택/UI 상태 넣지 않기 (엔진은 문서만 안다)
- L2에 React/DOM 의존 넣지 않기 (jsdom 없이 node에서 단위테스트 가능해야)
- L2'에 LLM 클라이언트/키 넣지 않기 (R6 — fetch 한 줄도 금지, 순수 데이터 변환)
- L3에 비즈니스 로직 넣지 않기 (전부 L2 호출로 표현)

## 이슈 매핑
- 026 ✅: L2 `@tf-hwp/editor-core`(DocSession/SelectionModel/EditController/EngineAdapter — react·DOM 0,
  node 단위테스트) + L2' `@tf-hwp/ai-protocol`(EditRequest/EditResponse·buildDocContext·buildSystemPrompt·
  validateRequest/validateResponse — fetch·키·벤더 0, isomorphic) 신설. L3 `@tf-hwp/react`는
  `useHwpEditor(core)` 훅으로 재배선(공개 API 하위호환, 기존 34 vitest·lab Playwright 2 그대로 통과).
  route.ts·LabWorkspace는 ai-protocol 을 공유 import(프롬프트/펜스/검증 단일 출처). vanilla 예제 =
  React 없이 open→선택→intent→undo→export 증명.
- 027: 편집 기능 패리티(룰러/열너비/표추가/텍스트·서식·배경)를 L2 커맨드 + L3 옵트인 UI로
- (선행) 024: 충실도 — 문단 테두리 + 프레임 오버플로 / 025: 성능 — 레이아웃 캐시
