# 082 — `.hwp`(HWP5) 재저장 v1: 원본 바이트 베이스 in-place 텍스트 패치

- 상태: **기획 확정 · 미착수** (2026-08-10) — 에이전트 퍼널 F3 (`docs/AGENT-FUNNEL-ROADMAP.md`)
- 우선순위: P1 — 우리 최대 커버리지 갭. 한국 실무는 "받은 .hwp를 .hwp로 돌려줘야" 하고, 현재 우리는
  `.hwp`를 열면 HWPX/PDF로만 내보낸다(`hwp-mcp` export_bytes = serialize_hwpx 고정).
- 영역: 신규 crate `hwp-hwp5-patch`(가칭) + `hwp-mcp` export 툴 + capability report
- 레퍼런스: `docs/research/claw-hwp-2026-08.md` — claw-hwp(MIT)의 `patchInPlaceSectors` 계열이
  공개된 유일한 검증 사례. **JS 셸아웃 금지**(코어 하나 원칙) — Rust 포팅(MIT 고지+NOTICE 추가).

## 왜 in-place 패치인가 (전체 재직렬화가 아니라)

1. HWP5 전체 재직렬화는 레코드 전종 왕복+암호화+버전 호환을 요구하는 수개월 규모·고위험이다.
2. **한컴독스가 진짜 게이트다**: rhwp `exportHwp()` 산출물조차 한컴독스가 거부한다(claw-hwp 실측).
   원본 바이트를 최대 보존하고 편집된 Section 스트림만 패치하는 쪽이 수용 확률·충실도 모두 우위.
3. 우리 편집 모델과 정합: IR 편집은 주소(section/block/row/col + CellPath)를 알고 있고, 미편집
   문단은 건드리지 않는다 — HWPX byte-verbatim 왕복과 같은 철학의 HWP5 판이다.

## 설계 스케치 (v1 = 텍스트 레인만)

1. **원본 보존**: `Session.source_bytes`(이미 보관 중)가 베이스. 편집 op 로그에서 텍스트 커밋
   (`SetTableCell*`/`SetParagraph*` 계열, CellPath 포함)만 추출.
2. **주소 번역**: export 시점에 원본 레코드를 재주행(walk)해 IR 주소 → 레코드 위치로 해석
   (claw-hwp `locateCell` 방식 — lift 시 provenance를 미리 남기지 않아도 된다. 중첩은 레코드 level
   산술 +2/깊이). ⚠️ 우리 lift의 블록 순서와 레코드 순서의 대응을 픽스처로 잠근다(1차 리스크).
3. **레코드 패치**: PARA_TEXT 교체 + `nchars` 갱신 + PARA_CHAR_SHAPE 오프셋 보정. 새 텍스트가
   레코드 크기를 바꾸므로 스트림 재조립 후 재압축.
4. **CFB 재기입**: Section 체인 deflate → 체인 용량 내면 같은 섹터에 write-back, 초과 시 FAT 체인
   확장/미니→일반 승격(claw-hwp가 증명한 경로) → 최후 폴백은 CFB 전체 재작성.
5. **capability report**: 구조 편집(행/열/표 삽입·이미지)이 세션에 섞여 있으면 `.hwp` export를
   거부하고 "이 문서는 HWPX/PDF로" 정직 안내 — 조용한 손상 금지(불변식 6 정신).
6. **PrvText/PrvImage 무효화 또는 재생성** — 스테일 미리보기가 편집 전 내용(redaction 누수 포함)을
   유출하지 않게.

## 수용 기준

- [ ] 무편집 문서: export 산출물이 원본과 **바이트 동일**(패치 0건 = 통과 경로 자체가 no-op).
- [ ] 텍스트 편집 문서: 미편집 Section·스트림·헤더는 바이트 동일, 편집 문단만 변경(섹터 diff 검증).
- [ ] 산출물을 **rhwp가 재파싱해 우리 IR과 일치**(자체 왕복 게이트 — 오프라인·CI 가능).
- [ ] **한/글 실물 또는 한컴독스가 산출물을 연다** — 수동 검증 절차 문서화(claw-hwp의 GT 방식.
      자동화는 후속 — 075 한컴 네이티브 오라클과 합류 가능).
- [ ] 중첩 셀 텍스트(레벨 산술) 픽스처 포함 — 081과 같은 sample-8p 1×1 중첩 표로.
- [ ] 게이트 8/18/24/6·HWPX축 불변(이 작업은 조판 무접촉), rhwp vendored 무수정(불변식 3).

## 함정 (claw-hwp `references/hwp-internals.md` 실측 지식 — 착수 전 필독)

- `nchars` 최상위비트 `0x80000000`은 섹션 마지막 문단 마커 — 중간 문단에 세우면 한/글이 20억 자로
  읽고 렌더 중단.
- 빈 셀은 PARA_TEXT 없는 네이티브 빈 문단 형태여야 한컴독스가 수용.
- BorderFill 참조는 1-based. 배포용(암호화) `.hwp`는 v1 비범위(우리 hwp-crypto 복호 후 열람만).
- 압축 스트림 크기는 압축 레벨에 따라 달라진다 — "같은 섹터에 들어가는가"는 재압축 후에만 판정.

## 비범위 (v2 이후)

구조 편집(행/열/셀 병합) 스플라이싱 · 이미지 교체(BinData 재번호+스트림 rename) · 각주/누름틀 삽입 ·
차트 OLE — 전부 F4. v1 하네스(섹터 diff + 한컴 수용 검증) 없이는 착수 금지.
