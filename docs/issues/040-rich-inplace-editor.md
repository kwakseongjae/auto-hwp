# 040 — R8-1: 리치 제자리 에디터 — 부분 서식(런 단위) 편집 (FG-11)

- 상태: **done** (b807f7c) · 우선순위: **R8-P0** · 영역: packages/react (InPlaceCellEditor + 신규 richedit 모듈 + HwpWorkspace 커밋 경로 + styles.css + index.ts)
- 병렬: 041(WasmAdapter/TauriAdapter/editor-core 소유 — **이 이슈는 그 파일 금지**)

## 근거 (033 FG-11)
032 제자리 에디터 = plaintext textarea → **셀 안 텍스트 일부만 볼드 불가**. 엔진은 run 단위
Set*Runs를 이미 보유(027 runsAt + SetTableCellRuns 경로가 web에서 이미 가동). 데스크톱은 R12에서
TRUE WYSIWYG contentEditable 에디터를 완성했고 그 자산이 crates/hwp-viewer/ui/src/richedit.ts
(287줄, runsToHtml/serializeEditor 왕복)로 존재한다 — **포팅+웹 적응이지 신규 발명이 아니다.**

## 목표
셀/문단 제자리 에디터를 **contentEditable 리치 에디터**로: 텍스트 일부 선택 → **굵게/기울임/
밑줄/취소선(+크기/색은 커밋 경로 확인 후)** 라이브 반영 → 커밋 시 run 단위로 문서에 보존.
032의 UX 계약(제자리 bbox<4px, Enter=저장·Shift+Enter=개행·Esc=취소, IME 가드, latch)과
036 Tab 커밋-이동 전부 유지.

## 데스크톱 richedit 교훈 (전부 준수 — 하나라도 어기면 유령버그)
1. **에디터는 순수 #000으로 렌더**: 미접촉 검정 텍스트가 #171717 등으로 직렬화되면 no-op 판정이
   영원히 안 뜨고 서식 보존이 깨진다.
2. **다중 문단 셀은 "\n" 분할 + 각 para_shape 보존**.
3. **취소선(strike)은 렌더+판독+비교 3곳 모두** 다뤄라(하나 빠지면 왕복 소실).
4. 명시 서식 런은 이국적 sub-attr을 잃을 수 있다(v1 허용) — 문서화만.
5. **폰트는 DISPLAY 전용**(oracle-safe — 커밋에 폰트 변경을 싣지 마라).
6. **커밋은 반드시 run 보존 경로**(SetTableCellRuns/Set*Runs) — plain SetParagraphText/
   SetTableCell 텍스트 변형은 런을 붕괴시킨다. 절대 금지.

## 설계
- richedit 모듈 신규(packages/react/src/richedit.ts): runsToHtml(런→에디터 DOM) /
  serializeEditor(에디터 DOM→런) 왕복 — 데스크톱 판을 웹 어댑터 런 스키마(027 runsAt 반환형)에
  맞춰 포팅. **왕복 무손실 vitest가 1급 산출물**(미접촉 셀 커밋 = no-op 판정 포함).
- InPlaceCellEditor: textarea → contentEditable. ⌘B/⌘I/⌘U(+취소선 단축키) → 라이브 선택 서식.
  서식 UI 표면은 재량(최소 = 단축키 + 032의 실행 규약 유지); 028 툴바는 에디터 열림 중 숨김
  규약(032/039) 유지 — 두 크롬 원칙 불변.
- IME: contentEditable 네이티브 조합이 그대로 인라인 표시된다(FG-13의 에디터-내 부분은 여기서
  자연 해소). 032의 조합 중 커밋 금지 가드(compositionstart/end + isComposing)를 contentEditable
  에 재적용. **Enter 후보 확정이 커밋으로 새지 않는지** 한국어 조합 시나리오 vitest.
- HwpWorkspace 커밋 경로: onEditorCommit/onEditorCommitMove가 text 대신 런 배열을 받도록 확장
  (037/038/039가 들어간 최신 HwpWorkspace 기준 — 다른 영역 접촉 최소). 036 Tab 이동·재진입,
  032 latch/reject-un-latch 계약 그대로.

## 구현 단계
1. 어댑터 런 스키마 실측(runsAt 반환형, SetTableCellRuns 입력형) + 데스크톱 richedit.ts 정독.
2. richedit.ts 포팅 + 왕복 vitest(무손실/no-op/#000/strike/다중문단 para_shape).
3. InPlaceCellEditor contentEditable 전환 + 단축키 + IME 가드 + 032 계약 회귀 테스트 갱신.
4. HwpWorkspace 커밋 경로 런 배열화 + 036 Tab 시퀀스 재검증.
5. e2e: 셀 더블클릭 → 텍스트 일부 선택 ⌘B → Enter 커밋 → **SVG에서 해당 부분만 bold tspan**
   assert + 다른 런 서식 불변 assert → undo. IME는 실기기 항목으로 문서화(수동 QA 큐).

## 수용 기준
- [ ] 부분 선택 B/I/U/S 라이브+커밋, run 보존(무접촉 런 byte 불변) — vitest 왕복 + e2e
- [ ] 미접촉 셀 재커밋 = no-op(#000 규율), 다중 문단 para_shape 보존, strike 왕복
- [ ] 032 계약(제자리/Enter/Esc/latch/IME) + 036 Tab 이동 전부 유지 — 기존 스위트 그린
- [ ] 041 소유 파일(WasmAdapter/TauriAdapter/editor-core) 무접촉, 엔진 무접촉, 언스테이지 0

## 함정
- contentEditable의 브라우저별 DOM 정규화(span 중첩/병합)가 serializeEditor를 깨기 쉽다 —
  데스크톱 판의 정규화 로직을 그대로 가져오고, 왕복 vitest를 다양한 중첩 케이스로.
- document.execCommand는 deprecated지만 데스크톱에서 검증된 경로면 유지 가능 — 실측 후 결정,
  근거 기록.
- e2e 전 패키지 빌드 순서 + **apps/hwp-lab `rm -rf .next` 필수**.
