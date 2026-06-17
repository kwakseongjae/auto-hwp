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

## 강제
- `deny.toml` + `cargo deny check licenses` (CI). 새 의존 추가 시 분류(BORROW-STABLE/OWN/…)를 PR에 명시.
