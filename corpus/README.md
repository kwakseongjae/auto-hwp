# corpus — 골든 정합성 코퍼스

여기에 round-trip/렌더 정합성 골든 샘플을 둔다.

- `hwpxlib_corpus/` — neolord0/hwpxlib의 `testFile/**/*.hwpx` 샘플(Apache-2.0 **데이터**). 클린룸 경계: 데이터는 사용 가능, 코드는 참조 전용. 재현: `node scripts/fetch-hwpxlib-corpus.mjs`.
- `gov-sources.json` + `GOV-SOURCES.md` — KOGL 실측 공공문서. 바이너리 커밋 금지, `node scripts/fetch-gov-corpus.mjs`로 재현.
- `gov-source-catalog.json` + `GOV-SOURCE-CATALOG.md` — 12개 이상 공식 출처 family의 HWP5/HWPX/PDF 후보 200건 이상을 담은 **metadata-only** 카탈로그(이슈 #99). URL은 비활성 메타데이터이며 다운로드 경로에 연결하지 않는다. `node scripts/gov-source-catalog.mjs --check`로 스키마·개인정보 제외 규율·생성 요약 drift를 검증한다.
- `TYPESET-COVERAGE.md` + `typeset-coverage.json` — 조판 요소 태깅 지도 (이슈 #71). 재현: `node scripts/tag-corpus.mjs`.
- `TYPESET-ORACLE.md` + `typeset-oracle.json` — 코퍼스 전수 `layout-check` 점수 (이슈 #72). **한/글의 참값이 아니라 저장 lineseg 기준의 회귀 잠금**. 채점 불가(빈 linesegarray)는 0점이 아니다. 재현: `node scripts/oracle-sweep.mjs` (전수는 로컬, CI는 `--check-committed`).
- `private/` — 사내/실문서(.gitignore로 제외).

각 샘플에 대해 오라클(soffice+H2Orestart) 렌더와 우리 엔진 렌더를 페이지별 diff하여 정합성 점수를 산출한다. (`hwp-oracle`, Phase 0~2)
