# 라이선스 정책

제품(링크되는 코어)에 들어갈 수 있는 라이선스를 강하게 통제한다. 근거: 한컴 종속 탈피라는 프로젝트 목표 + 크로스플랫폼·상용 가능성.

## 허용 (링크 코드)
**MIT / Apache-2.0 / BSD-2 / BSD-3 / ISC / Zlib / Unicode** 만.
- 우리 코드: `MIT OR Apache-2.0` 듀얼.
- rhwp(MIT), quick-xml/zip/flate2/clap/harfrust/rustybuzz/icu_segmenter(전부 퍼미시브) → OK.

## 금지 (링크 코드)
- **GPL / LGPL / AGPL**. 특히 **pyhwp(AGPL)** 임베드 금지, **LibreOffice/H2Orestart(GPL)** 링크 금지.
- 한컴 **COM/SDK** (상용 라이선스 + Windows 종속) — 제품 경로에서 제외.

## 프로세스 격리 예외
- **LibreOffice + H2Orestart (GPL)** 는 `soffice` CLI로 **out-of-process** 호출만 허용 — *정합성 오라클·읽기전용 폴백 전용*, 절대 링크/번들하지 않는다. (`hwp-oracle` 크레이트는 `std::process`로만 호출.)

## 클린룸 경계
- `hwpxlib`/`python-hwpx`의 **샘플 데이터(Apache-2.0)** 는 골든 코퍼스로 사용 가능.
- 그 **코드는 참조 전용** — 동작을 Rust로 재구현(소스 복사 금지).

## 폰트 재배포 (R8 — wasm/npm 패키지)
- **번들 금지·주입만.** `@tf-hwp/engine`(이슈 015, `crates/hwp-wasm` + `packages/engine`)은 폰트를
  **하나도 번들하지 않는다**. PDF export에 필요한 폰트는 호스트가 런타임에 바이트로 주입한다
  (`HwpDoc.registerFont(family, bytes)`). `exportPdf`는 폰트 미주입 시 명시 에러(`{code:"font_missing"}`)를
  던진다 — silent 빈 글리프 금지.
- **OFL 폰트 권장.** Noto Sans KR 등 SIL Open Font License 계열은 호스트가 자체 서빙/주입해도 안전하다
  (재배포 허용, 임베딩 허용). 데모(`packages/engine/demo`)도 Noto Sans KR을 fetch해 주입한다.
- **함초롬/한컴 계열 재배포 불가.** 함초롬바탕/함초롬돋움 및 한컴 번들 폰트는 재배포·임베딩 라이선스가
  없으므로 패키지에 포함하거나 CDN으로 재배포하지 않는다(법적 리스크는 롤백 불가).
- **대체 메트릭 정책.** 폰트 미주입 상태의 own-render/PDF는 per-script 근사 메트릭
  (`ApproxFontMetrics`)으로 레이아웃만 유지한다(글리프는 스텁). 실제 글리프 형상은 주입된 OFL 폰트로만
  나온다.
- **서체 충실도 대체(issue 058).** 문서의 명조/고딕 구분은 **OFL 대체 face** 로만 라우팅한다 —
  명조(serif) → **Nanum Myeongjo(OFL)**, 고딕/기타 → **NanumGothic(OFL, 번들)**. 분류·대체는
  `crates/hwp-model/src/font_class.rs` 단일 출처. 함초롬/한컴 계열은 여전히 **번들 0**(사용자 업로드만 —
  재배포 아님). 대체는 디스플레이 전용이라 조판 메트릭/게이트에 영향 없음.

## 강제
- `deny.toml` + `cargo deny check licenses` (CI). 새 의존 추가 시 분류(BORROW-STABLE/OWN/…)를 PR에 명시.
