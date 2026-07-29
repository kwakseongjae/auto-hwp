# 076 — 문단을 넘는 범위 선택과 원자적 편집

- 상태: **design-complete / implementation-open** (2026-07-28)
- 우선순위: **P1 (에디터 기본기)**
- 영역: `hwp-ops` → `hwp-mcp`/wasm → `editor-core` → React

## 현재 위험

현 범위 선택은 한 문단 안의 `{anchor, focus}`만 표현한다. `DocSession.applyBatch()`는 여러 Intent를
어댑터에 차례로 적용한 뒤에야 JS undo 배치를 기록한다. N번째 호출이 실패하면 앞의 N-1개는 이미
변경됐지만 JS undo bookkeeping에는 기록되지 않는다. 반면 Rust `EditSession::do_ops()`는 전체 batch를
복제본 위에서 적용하고 실패 시 복구하는 진짜 원자 연산이다.

따라서 문단별 `SetParagraphRuns`를 현재 JS batch로 묶는 구현은 금지한다.

## 결정

### 선택 모델

```text
TextPoint { section, block, offset }
TextRange { anchor: TextPoint, focus: TextPoint }
```

- 문서 순서는 `(section, block, offset)`으로 정규화하되 anchor/focus 방향은 보존한다.
- v1은 **같은 section의 top-level simple paragraph**만 허용한다.
- 표·셀·raw/구조 문단·섹션 경계를 하나라도 지나면 fail-closed 한다.
- 075 오라클과 W3 `body_text_hit`/`body_caret_rect`를 지오메트리 정본으로 사용한다.

### 커밋 모델

- 삭제·붙여넣기는 manual-only 단일 op `ReplaceParagraphRange`로 처리한다.
- 시작 문단 prefix + 삽입 run + 끝 문단 suffix를 합치고, 중간 simple paragraph만 제거한다.
- 시작/끝 run의 char shape를 보존하고 새 텍스트는 시작 caret의 활성 스타일을 따른다.
- AI Intent 화이트리스트에는 공개하지 않는다.
- 여러 op가 필요한 서식 적용은 어댑터에 native atomic batch API를 추가해 Rust `do_ops()` 한 번으로
  내릴 때까지 이연한다.

## 수용 기준

- [ ] 정방향/역방향 드래그, Shift+화살표, 페이지 경계 분할 문단을 지원한다.
- [ ] 멀티문단 copy는 원래 개행을 보존하고 paste/delete는 엔진 undo 1회로 되돌아간다.
- [ ] 중간 op 실패를 주입해 문서와 JS undo depth가 모두 원상복구됨을 증명한다.
- [ ] 표·셀·raw block·section 교차는 콘텐츠를 일부 바꾸지 않고 명시적으로 거부한다.
- [ ] 단일 문단/셀 범위의 현재 동작과 마우스 이동 중 React render 0회 계약을 유지한다.

