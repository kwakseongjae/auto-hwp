# 018 — PDF 폰트 바이트 주입 (wasm 한글 PDF 완성) + 바인딩 폴리시

- 상태: **open**
- 우선순위: P4-A 후속 (015가 정직하게 partial로 남긴 유일한 기능 갭 — **019 통합 PoC의 선행**)
- 영역: hwp-export / hwp-session / hwp-wasm
- 선행: 015 (done, 4fb1ced)
- 레드팀: R8 (폰트 비번들·주입) 완성

## 배경 (015 빌더의 정확한 진단)
`hwp_export::pdf::export_pdf`는 폰트를 **std::fs 후보 경로 발견(discover)으로만** 얻는다 —
바이트 주입 파라미터가 없다. 그래서 wasm에서 `HwpDoc.registerFont(bytes)`로 주입한 폰트가
krilla까지 흐르지 못해 **PDF 글리프가 스텁 박스**로 나온다(지오메트리는 충실). 015는
순수-소비자 제약을 지켜 hwp-export를 수정하지 않고 이 후속을 남겼다.

## 목표
`registerFont(bytes)` → hwp-session → **hwp-export(krilla)까지 폰트 바이트가 관통**해
wasm에서 한글 글리프가 실제 임베드된 PDF가 나온다. **네이티브 경로(viewer/CLI export-pdf)는
바이트 단위 무변경.**

## 파일 지도
- `crates/hwp-export/src/pdf.rs` — export_pdf의 폰트 획득부(std::fs discover) — 주입 우선 경로 추가
- `crates/hwp-session/src/lib.rs` — `emit_pdf` 관통(폰트 바이트 파라미터)
- `crates/hwp-wasm/src/lib.rs` — registerFont 저장분을 emit_pdf로 전달 + tableAt/hitTest 반환형 폴리시
- `packages/engine/index.js` / `index.d.ts` / `README.md` / `demo/index.html` — 반환형 변경 반영

## 구현 단계
1. **hwp-export 주입 파라미터**: 기존 공개 시그니처를 깨지 말고 새 진입점을 추가하라
   (예: `export_pdf_with_fonts(doc, title, fonts: &[(String, Vec<u8>)])` — 기존
   `export_pdf`는 빈 슬라이스로 위임). 주입 폰트가 있으면 **discover보다 우선** 사용,
   없으면 기존 discover 폴백(네이티브 동작 보존).
2. **hwp-session 관통**: `emit_pdf`에 동일한 옵션 표면(새 함수 or Option 파라미터,
   기존 호출부는 무변경 형태로).
3. **hwp-wasm 배선**: registerFont로 쌓인 (family, bytes)를 exportPdf에서 전달.
   폰트 미주입 시 `font_missing` 에러는 그대로 유지.
4. **바인딩 폴리시**: `tableAt`/`hitTest`가 미적중 시 JSON 문자열 `"null"`이 아니라
   **JS null** (`Option<String>` 반환)이 되게 수정. demo/index.d.ts/README의 소비 코드도 갱신.
   (검수 중 실측된 결함 — truthy "null" 문자열이 호스트 코드 오작동 유발.)
5. **(선택) wasm-opt**: `cargo install wasm-opt`이 되면 `-Oz`로 번들 재생성 후 크기 재보고
   (015 실측: 미최적화 gzip 3.5MiB). 불가하면 스킵 사유 보고.

## 검증
- **네이티브 골든**: 변경 전후 `tf-hwp export-pdf benchmark.hwp` 출력 **바이트 동일**
  (discover 경로 무변경 증명). 게이트 8==8.
- `cargo test -p hwp-export -p hwp-session -p hwp-mcp` + `cargo check -p hwp-wasm --target wasm32-unknown-unknown`.
- **node 스모크**: 시스템에서 한글 포함 TTF(예: `/Library/Fonts/Arial Unicode.ttf` 또는
  `/System/Library/Fonts/Supplemental/AppleGothic.ttf` — 실제 존재 확인 후 사용)를 읽어
  registerFont → exportPdf → (a) PDF 바이트에 폰트 프로그램 임베드 흔적(`FontFile2`/서브셋
  스트림) 존재, (b) 폰트 없이 뽑은 PDF보다 유의미하게 큼, (c) `%PDF` 헤더. 육안 확인은 manual로.
- tableAt 미적중이 JS null임을 node로 assert.

## 수용 기준
- [ ] wasm exportPdf에 주입 폰트가 실제 임베드됨 (node 스모크 (a)(b)(c))
- [ ] 네이티브 export-pdf 바이트 동일 + 게이트 8==8
- [ ] tableAt/hitTest 미적중 = JS null (문자열 "null" 아님) + 데모/타입/README 정합
- [ ] 기존 테스트 전부 그린
- [ ] (선택) wasm-opt 크기 재보고 또는 스킵 사유

## 함정
- krilla `simple-text` 피처는 TTC(컬렉션)를 못 먹을 수 있다 — 스모크 폰트는 .ttf 단일면으로.
  주입 API도 "TTF/OTF 바이트" 규약을 README에 명시하라.
- 폰트 family명 매칭을 과도하게 구현하지 마라 — v1은 "주입된 폰트를 본문 기본 폰트로 사용"
  수준이면 충분(문서별 폰트 매핑은 후속). 기존 discover 경로의 매칭 로직을 건드리지 마라.
- demo의 Noto fetch는 네트워크가 없으면 실패한다 — 데모에 로컬 폰트 파일 선택 input을
  폴백으로 두면 오프라인 검증이 쉬워진다.
