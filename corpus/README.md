# corpus — 골든 정합성 코퍼스

여기에 round-trip/렌더 정합성 골든 샘플을 둔다.

- `hwpxlib_corpus/` — neolord0/hwpxlib의 ~47개 `.hwpx` 샘플(Apache-2.0 **데이터**). 클린룸 경계: 데이터는 사용 가능, 코드는 참조 전용.
- `private/` — 사내/실문서(.gitignore로 제외).

각 샘플에 대해 오라클(soffice+H2Orestart) 렌더와 우리 엔진 렌더를 페이지별 diff하여 정합성 점수를 산출한다. (`hwp-oracle`, Phase 0~2)
