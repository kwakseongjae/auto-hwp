# corpus — 골든 정합성 코퍼스

여기에 round-trip/렌더 정합성 골든 샘플을 둔다.

- `hwpxlib_corpus/` — neolord0/hwpxlib의 `testFile/**/*.hwpx` 샘플(Apache-2.0 **데이터**). 클린룸 경계: 데이터는 사용 가능, 코드는 참조 전용. 재현: `node scripts/fetch-hwpxlib-corpus.mjs`.
- `gov-sources.json` + `GOV-SOURCES.md` — KOGL 실측 공공문서. 바이너리 커밋 금지, `node scripts/fetch-gov-corpus.mjs`로 재현.
- `TYPESET-COVERAGE.md` + `typeset-coverage.json` — 조판 요소 태깅 지도 (이슈 #71). 재현: `node scripts/tag-corpus.mjs`.
- `private/` — 사내/실문서(.gitignore로 제외).

각 샘플에 대해 오라클(soffice+H2Orestart) 렌더와 우리 엔진 렌더를 페이지별 diff하여 정합성 점수를 산출한다. (`hwp-oracle`, Phase 0~2)
