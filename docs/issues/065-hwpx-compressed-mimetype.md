# 065 — 압축 mimetype HWPX가 "지원하지 않는 형식"으로 거부됨 (실물 25% 안 열림)

- 상태: **done** · 우선순위: **R14-P0 (핵심 로버스트니스 — 업로드→렌더 직결)** · 영역: crates/hwp-ingest(detect)
- 발견: 2026-07-13 실물 QA(~/Desktop/archive 24개). **6/24(25%)가 안 열림 — 전부 "작성완료" 실사용 문서.**

## 증상
`export-html`/`export-pdf`/업로드가 `error: unrecognized or unsupported document format`으로 거부.
실패 파일(전부 "독스헌터"류 작성완료 HWPX): 예창패_작성완료, 창업도약패키지(딥테크/일반형), 초기창업패키지_2025,
청년창업사관학교_2025, 딥테크창업사관학교 신청서.

## 근본 원인 (확정)
실패 파일은 **완전히 정상 HWPX**다 — `Contents/header.xml`(708KB)·`section0.xml`(272KB)·`content.hpf`·mimetype
=`application/hwp+zip` 다 있음. 문제는 **mimetype 엔트리가 압축(deflate, method 8)** 돼 있는 것.
- 우리 `crates/hwp-ingest/src/lib.rs::detect`(:33)는 "mimetype은 OPC 규약상 첫 엔트리·**무압축 저장**"을 가정해
  **앞 512바이트에서 리터럴 `application/hwp+zip` 바이트를 windows-검색**한다(`window_contains(&bytes[..512], HWPX_MIMETYPE)`).
- mimetype이 압축되면 그 리터럴 바이트가 클리어로 안 나타남 → 매칭 실패 → `SourceFormat::Unknown` → 거부.
- OWPML/ODF 규약은 mimetype 무압축을 "권장"하나 **강제 아님** — 실물 도구(독스헌터, Hancom 계열)는 압축해서 저장.

## 수정안 (well-scoped)
detect의 fast-path 리터럴 매칭이 실패하면 **fallback으로 zip 중앙디렉토리를 읽어 `mimetype` 엔트리를 실제 디코드**
(압축이면 inflate)해서 `application/hwp+zip`인지 확인. hwp-hwpx에 이미 zip 리더가 있으니 재사용.
- 대안(더 관대): ZIP이면서 `Contents/header.xml`(또는 `content.hpf`) 엔트리가 central dir에 있으면 HWPX로 판정.
  (엔트리 NAME은 압축돼도 central dir에 클리어로 있음 — DOCX 감지가 이미 이 방식.)
- ⚠️ 014 입력 하드닝과 정합: zip 엔트리 디코드 시 압축폭탄/한도(MAX_DECOMPRESSED) 적용.

## 수용 기준
- [x] 6개 실패 파일 전부 열려 렌더/export (재현 픽스처: archive의 "작성완료" HWPX; 커밋엔 합성 압축-mimetype HWPX)
- [x] 기존 무압축 mimetype HWPX 무회귀, 비-HWPX zip(docx/일반 zip)은 여전히 정확히 분류
- [x] 게이트 8==8·18==18, wasm-safe(감지는 wasm 경로에도 있음)
- [x] 압축폭탄 방어(014 한도) 유지

## 해결 (2026-07-13)
`detect`에 **관대안(엔트리 NAME 스캔)** fallback 채택 — 권장안(mimetype inflate) 대신 선택.
- 근거: 리터럴 fast-path 실패 시 ZIP 중앙디렉토리에 클리어로 남는 `Contents/header.xml` 엔트리 NAME을
  스캔(DOCX 감지와 동일 기법). **inflate가 전혀 없어** hwp-ingest가 pure & wasm-clean을 유지하고
  압축폭탄 표면이 0 — 014 한도는 파싱 경로(hwp-hwpx)에만 있으면 충분(detect는 압축을 풀지 않음).
- 실측: archive HWPX 12개 전부 `detect=Hwpx`, 6개 실패 파일 export-html 성공. 게이트 8==8·18==18,
  quick verify(fmt/clippy/test/rhwp피처/wasm-check/deny) 그린, wasm 재빌드+copy 완료.
- 테스트: hwp-ingest 순수 유닛(압축-스타일 버퍼 fallback + docx/plain 무회귀) + hwp-core 통합
  (real zip: DEFLATE mimetype HWPX detect+open, STORED 무회귀, 비-HWPX zip=Unknown).

## 함정
- 감지는 wasm(브라우저 업로드)에도 흐름 — 브라우저에서 이 파일들이 안 열리는 게 사용자 실체감.
- content.hpf(OPF 매니페스트) 기반 HWPX도 header.xml/section0.xml이 실재하므로 파싱은 기존 경로로 됨 — 감지만 뚫으면 됨(확인 필요).
