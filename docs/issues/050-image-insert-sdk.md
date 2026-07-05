# 050 — R11-6: 이미지 삽입 SDK 승격 — 드롭/업로드 → InsertImageAt

- 상태: **done** (ebff42c) · 우선순위: R11-P1 · 영역: packages/react(드롭 존/업로드 진입 + 삽입 배선) + editor-core(insertImage 커맨드) + 필요 시 wasm additive
- 병렬: 049(이미지 선택/핸들/이동/리사이즈 오버레이 소유). 그 영역 접촉 금지.

## 근거 (감사표 "이미지 삽입" L — 데스크톱 M1)
데스크톱: Tauri onDragDropEvent → hit_test → InsertImageAt(파일 경로 기반). 웹은 진입점 자체가
없다. L인 이유: 웹은 **bytes 기반**(경로 없음) — 이미지 데이터가 모델·HWPX 내보내기까지
왕복해야 한다(bin data 임베드).

## 목표
- **드래그드롭**: 이미지 파일(png/jpg)을 페이지 위에 드롭 → 드롭 지점에 삽입(hit 기반 앵커).
  **업로드 버튼**(툴바 "이미지" — 039/048 공용 표면 재량)도 제공(파일 픽커 → 현재 선택/문서 끝).
- 삽입 후 문서에 실반영(SVG <image> 렌더), **HWPX 내보내기에 이미지 포함**(bin 임베드 왕복),
  PDF 내보내기 동작 실측(이미지 임베드 여부 — 안 되면 근거 기록+스코프 명시), undo 1단위.
- 검증: 크기 상한(비정상 대용량 거부 — 014 하드닝 정신), 형식 검증(png/jpg 매직바이트),
  거부 시 정직한 토스트.

## 실측 출발점
- 엔진: InsertImageAt op(M1)의 입력(경로? bytes?) — wasm 경계에서 bytes 임베드가 가능한 형태인지
  (Intent 스키마에 이미지 삽입 variant 존재 여부) 실측. 없으면 additive 바인딩/인텐트 확장이
  필요한데, **인텐트 스키마(008 동결) 변경은 additive variant만 허용** — schema_v0 테스트 준수.
- 데스크톱 M1 경로(crates/hwp-viewer propose_insert_image 등)와 최대 공유.
- own-render의 이미지 렌더 경로(이미 동작 — 벤치마크 문서 이미지 표시됨)를 재사용.

## 수용 기준
- [ ] 드롭+업로드 삽입 → SVG 실반영 + undo — e2e(문서에 <image> 등장 assert)
- [ ] HWPX 내보내기에 삽입 이미지 포함(왕복 재열기 확인), PDF 동작 실측 기록
- [ ] 형식/크기 검증+정직한 거부, 두 어댑터 동형(가능 범위 실측·기록)
- [ ] 049 소유 영역 무접촉, crates 접촉 시 additive+게이트·골든 증빙, 기존 스위트 그린, 언스테이지 0

## 함정
- 삽입 지점의 리플로우가 페이지를 민다 — LOCKSTEP 게이트(8==8·18==18)가 벤치마크에 이미지
  삽입을 포함하진 않지만, place_doc/NaiveLayout 로직을 만지게 되면 즉시 멈추고 보고(엔진
  레이아웃 무접촉 원칙 — 삽입은 기존 op 재사용이어야 한다).
- 웹 드롭이 브라우저 기본(파일 열기 네비게이션)으로 새지 않게 preventDefault — 단 .hwp/.hwpx
  파일 드롭(문서 열기)과 이미지 드롭의 분기 규칙 명시.
- e2e 전 빌드 순서 + **apps/hwp-lab `rm -rf .next` 필수**.
