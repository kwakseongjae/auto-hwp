# 059 — IME 한글 인라인 조합 (FG-13) — 실은 입력 캡처 아키텍처 이슈

- 상태: open · 우선순위: R13-P0(캐럿 UX 완성의 필수 조각) · 영역: packages/react(CaretLayer/HwpWorkspace) — 엔진 무변경
- 근거: 2026-07-11 리서치. **반전**: "조합이 안 보이는" 표시 문제가 아니라 **입력 표면 부재** 문제.

## 핵심 발견 (전제가 심각)
- 053 타이핑은 `window keydown`이 `e.key`를 읽어 `core.cellCaret.insertText`를 호출(`HwpWorkspace.tsx:1472-1528`). **hidden input/textarea/contentEditable 없음.** 캐럿은 순수 오버레이 div.
- composition 이벤트는 focus된 편집요소에서만 발생 → 현 구조에선 **한글 조합이 시작 자체가 불가능**. 캐럿 라이브 상태에서 한글 입력 시 자모 낱자 커밋 또는 무입력 가능성(⚠️ 착수 전 macOS Chrome + Tauri WKWebView 각 1분 실측으로 재현 사실 확정).
- 대상 런타임: 랩=Chrome, 데스크톱=WKWebView(macOS) → Safari 이벤트 순서 함정 1급.

## 설계 (권장: xterm.js 패턴 — 캐럿 추종 hidden textarea + compositionView 오버레이)
- **입력 캡처**: `opacity:0`·`pointer-events:none`·1px textarea를 **캐럿 px에 절대배치**(화면 밖 금지 — OS 후보창/한자 변환창이 캐럿에 앵커되므로). `focus({preventScroll:true})`. contentEditable 아님(플레인 삽입만 필요, 레포 선례 CellTextPopover).
- **플로우**: compositionstart→기존 229/isComposing 가드가 키 레인 차단 / compositionupdate(e.data)→`hw-ime-preview` span에 조합 문자열 그리기(ref 직결, 렌더-0) + 캐럿 바를 span 우측으로 + textarea를 span에 동기화 / compositionend(e.data)→비었으면 no-op, 아니면 기존 `cellCaret.insertText(data)`(SetTableCellRuns 1 undo). **엔진/editor-core 변경 0.**
- **EditContext API는 아직 불가**: Chromium 121+ 전용, Safari/WKWebView 미구현 → textarea가 베이스라인, EditContext는 Chromium 한정 점진 개선.

## 한글 IME 엣지케이스 (수용 기준 체크리스트)
- 도깨비불(자모 캐리오버): `compositionend.data`만 신뢰(update 이력 diff 금지) / 음절 단위 end→start 연쇄(end 핸들러 재진입 안전) / 조합 중 Backspace=자모삭제(deleteBack 도달 금지) / 이벤트 순서 브라우저 분기(`input` 아닌 composition만 사용) / **WKWebView: compositionend 후 229 keydown 재발**(Enter 이중발화 검증) / 조합 중 blur=현재 data 확정 / Escape 취소=data"" no-op.

## 단계별 계획
| 단계 | 내용 | 난이도 |
|---|---|---|
| 1 | hidden textarea + focus 라우팅 + editable 가드 예외 + compositionend 커밋(표시 없이) — **한글 입력 자체가 처음 가능** | S-M |
| 2 | compositionView 오버레이 + 캐럿 추종(FG-13 본체) | M |
| 3 | 엣지케이스 하드닝 + macOS WKWebView·Chrome 수동 매트릭스 + CDP e2e | S-M |
| 4(선택) | 음절 undo 병합·EditContext 점진 채택 | M |

## 함정 (최대 리스크 3)
1. textarea focus가 기존 window keydown 생태계(035/036/045/⌘F)와 충돌 → `isEditableTarget` 가드 예외를 **모든 window 리스너**(HwpWorkspace 474/1321/1444/1477행)에 일관 적용. 최대 회귀 지점.
2. WKWebView compositionend-후-229-keydown / Enter 이중발화 → **Tauri 실기 검증 없이 완료 선언 금지**.
3. 도깨비불을 diff로 구현하면 필연 버그 → end.data 단일 신뢰 원칙.
