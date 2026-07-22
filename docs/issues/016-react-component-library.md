# 016 — P4-B: React 뷰어/채팅 컴포넌트 라이브러리 (`@auto-hwp/react`)

- 상태: **open**
- 우선순위: P4 (목표 2 최종 형태 — 사이트 내 채팅 패널 문서 작업)
- 영역: 웹 이식 / UI 라이브러리화
- 선행: **015 (wasm 패키지)**
- 레드팀: **R7** (SVG 웹 주입)

## 목표
`hwp-viewer/ui`에 있는 검증된 컴포넌트(페이지 뷰어, 선택/마킹 오버레이, 채팅 패널)를
재사용 가능한 React 패키지로 분리해, 외부 사이트가
```tsx
<HwpWorkspace engine={doc} onAiRequest={serverSideAi} />
```
한 줄로 "hwp 열람 + 마킹 + AI 티키타카 + PDF 다운로드"를 얻게 한다. 데스크톱 앱도
장기적으로 이 패키지를 소비하게 하는 것이 목표지만, **v1에서 앱 마이그레이션은 스코프 밖**
(앱은 그대로 두고, 추출은 복사-후-정리로 시작).

## 컨텍스트
- 원천: `crates/hwp-viewer/ui/src/` — App.tsx(선택/오버레이 상태), TableOverlay.tsx(범위
  드래그+배치 서식), Chat.tsx/Composer.tsx(채팅), richedit.ts(WYSIWYG), sanitize.ts(SVG 방어),
  api.ts(호출 표면).
- 핵심 차이: 앱은 Tauri 커맨드를 부르고, 웹은 015의 wasm 인스턴스를 부른다.
  **api.ts의 함수 시그니처를 인터페이스로 추상화**하면 두 백엔드가 같은 컴포넌트를 쓴다.
- AI 호출: 웹에서는 절대 클라이언트에서 LLM API를 부르지 않는다(R6) — `onAiRequest`
  콜백으로 호스트에 위임(호스트가 자기 서버로 프록시).

## 파일 지도
- 신규: `packages/react/` (컴포넌트, EngineAdapter 인터페이스, 스토리/데모)
- 원천(읽기·복사): `crates/hwp-viewer/ui/src/*`
- 계약: `docs/INTENT-SCHEMA.md`(008), `packages/engine`(015)

## 구현 단계
1. **EngineAdapter 인터페이스**: api.ts의 실제 사용 표면(열기/페이지 SVG/hit test/
   apply/undo/export)을 TS interface로 추출. 구현 2개: `WasmAdapter`(015 감쌈),
   `TauriAdapter`(참고 구현 — 앱 이관은 후속).
2. **컴포넌트 추출(복사-후-정리)**: `HwpPageView`(SVG 렌더+줌), `SelectionOverlay`
   (셀/범위 마킹 — TableOverlay에서 배치서식 툴바는 v1 제외 가능), `ChatPanel`
   (칩+프리뷰 카드 — 009/010의 결과물 반영), `HwpWorkspace`(조립). Tauri 전용 코드
   (파일 드롭, 창 관리)는 잘라낸다.
3. **sanitize 내장(R7)**: `sanitize.ts`를 패키지로 가져와 **모든 SVG 삽입이 sanitizer를
   강제 통과**하는 구조로 — SVG 문자열을 직접 받는 prop을 노출하지 말고, adapter에서
   가져온 것만 내부에서 sanitize→삽입. dangerouslySetInnerHTML이 패키지 밖으로 새는
   API를 만들지 마라.
4. **PDF 다운로드**: `exportPdf()` → Blob → download. 폰트 주입 상태 확인 후 미주입이면
   안내 에러.
5. **데모 앱**: `packages/react/demo/`(Vite) — .hwpx 업로드 → 뷰 → 셀 마킹 → 칩 →
   mock AI(고정 Intent 반환) → 프리뷰 → 적용 → PDF 다운로드. **mock으로 완주**가 기준
   (실 LLM 연동은 호스트 앱 책임).

## 검증
- `npm run build`(패키지) + 데모 앱에서 위 완주 시나리오 수동 확인.
- sanitize 테스트: `<script>`/`onload`/`javascript:` href가 든 SVG 문자열을 adapter mock으로
  주입 → DOM에 도달하지 않음을 단위 테스트로 고정.
- 기존 앱(`crates/hwp-viewer/ui`) 무손상 — 이 이슈는 앱 코드를 수정하지 않는다(복사만).

## 수용 기준
- [ ] `EngineAdapter` 인터페이스 + WasmAdapter로 데모 완주(업로드→마킹→mock AI→적용→PDF)
- [ ] SVG 삽입이 100% sanitizer 경유 (우회 API 부재 + 단위 테스트)
- [ ] AI 호출이 콜백 위임 구조 (패키지에 API 키/LLM 클라이언트 없음)
- [ ] 기존 데스크톱 앱 코드 무변경·무손상
- [ ] README: 통합 가이드 (서버사이드 AI 프록시 예제 포함)

## 함정
- richedit(WYSIWYG in-place 편집)는 gotcha가 많다(순수 #000 렌더 전제, run 커밋 경로 등 —
  memory/char-format-editing.md). v1 웹에서는 **채팅 편집만** 넣고 WYSIWYG 직접 편집은
  제외하는 것을 허용한다 — 넣으려면 해당 gotcha 문서를 먼저 읽어라.
- 페이지 가상화: 앱은 estimateSize 기반 가상 스크롤을 쓴다 — 데모 수준에선 단순
  렌더로 시작하되, 큰 문서(50p+)에서 프리즈하면 가상화를 이식하라.
- 좌표계: SVG viewBox↔클라이언트 px 변환을 어댑터가 아니라 컴포넌트가 담당하게
  일원화하라(hit test 인자는 페이지-로컬 px — 공통 계약 §4.1-5).
