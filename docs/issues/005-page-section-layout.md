# 005 — 쪽/구역 레이아웃 (여백·단·머리말/꼬리말·쪽번호·구역나눔)

- 상태: **partial** (방향+여백 완료 2026-06-16; 단·머리말/꼬리말·쪽번호·구역나눔 잔여)
- 우선순위: P2
- 영역: HWPX 합성 (로드맵 P7 도메인 "page-section")

## 완료된 부분
**용지 방향 + 여백**: `Op::SetPageLayout { section, orientation, margins_mm }`. apply가 `Section.page`
(`PageSetup`)를 갱신 + `page_edited=true`; 직렬화기가 `synth::patch_page`로 기존 secPr의
`<hp:pagePr>` width/height + 페이지 `<hp:margin>` left/right/top/bottom을 **in-place 패치**
(header/footer/gutter·grid·각주설정 등 나머지 secPr은 verbatim 보존). 가로는 A4 width/height swap.
AiContent에 `page:{orientation,margin_mm}` 노출. **검증: landscape+30mm → pagePr 84188×59528 +
margin 8504, 오라클 통과, rhwp 렌더가 가로 페이지(1122×793)로 표시**(test `page_layout_edit_patches_secpr`).
이것이 우리 엔진 최초의 **기존 요소 in-place 편집**(append 아님) — #003 full parse-in의 디딤돌.

## 잔여
- **다단(columns)**: `<hp:colPr>` 삽입 위치/속성 미검증(리서치 에이전트 Overloaded). 코퍼스에 다단 예제 없음 → 외부 샘플 확보 후.
- 머리말/꼬리말(`hp:header`/`hp:footer`), 쪽 번호, 워터마크, 구역 나눔.

## 문제
한컴 에디터의 쪽/구역 기능 미구현:
- 용지 크기/방향, 쪽 여백
- 다단(`hp:secPr`/`hp:colPr`)
- 머리말/꼬리말(`hp:header`/`hp:footer`), 쪽 번호
- 구역 나눔(`hp:secPr`), 워터마크, 줄 번호

## 왜 보류했나
- 설계 워크플로에서 이 도메인 리서치 에이전트(`verify:page-section`)가 **API Overloaded로 실패** → 검증된 OWPML 스펙 미확보.
- 쪽 설정은 `secPr`(구역 속성)에 모여 있고 본문 첫 문단에 임베드 → append-before-`</sec>` 모델과 상호작용 주의 필요.

## 접근(구현 시)
1. `verify:page-section` 리서치 재실행(워크플로) → `secPr`/`colPr`/`header`/`footer` 정확 스펙.
2. corpus의 기존 `secPr`를 clone-and-patch(여백·단 수 변경)하는 방식 우선.
3. `Op::SetPageLayout`/`SetColumns` + 검증.

## 수용 기준
- 2단 편집, 여백 변경, 머리말/쪽번호가 한컴/오라클에서 정상 렌더.
