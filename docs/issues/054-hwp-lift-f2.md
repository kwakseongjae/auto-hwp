# 054 — R12-P1: .hwp lift 충실도 F2 (행높이·셀패딩·셀테두리 실값)

- 상태: **done** (8cd4233) · 우선순위: R12-P1 · 영역: crates/hwp-rhwp + hwp-hwpx serialize/synth(재방출) + hwp-model(additive 필드)
- 결과 요약: 무편집 왕복 재열기 페이지 수 8→8·18→18·25→25 복원(이전 6/20/23p), 행높이 floor 멱등(67표→0 변동),
  게이트 불변(8==8·18==18). 왕복 손실 4종 수리(행높이 균일화·쪽나누기 드롭·앵커 문단 증식·셀 paraPr 하드코딩).
  020 floor 판정=보완(재방출만, 조판 무접촉). Tier-2 #8/#9/#10 emit 절반 선반영(페이지 보존의 직접 필요조건 — 측정 근거).
  보류: 셀 간격·대각선 재방출(F3), 두께 인덱스 0↔1 수렴(시각 동일, FIDELITY.md 명기). 골든: roundtrip_pages.rs.
- 병렬: 053(캐럿 — hwp-mcp/hwp-session/packages 소유, disjoint). 총괄 근거: **docs/HWP-CONVERSION-FIDELITY.md**.

## 근거
`.hwp`를 편집하는 순간 재합성 HWPX 경로로 전환되는데, lift가 Tier-1 항목을 하드코딩/드롭한다:
행높이(`RH*rows` 하드코딩), 셀 패딩(510/141 하드코딩), 셀 테두리(음영만 — 스타일/색/두께 드롭),
표 외곽 테두리 드롭, columns=1 고정. F1(열너비)만 완료(be949de). "편집해도 원본처럼"이라는
핵심 약속이 .hwp에서 깎이는 지점 — 표 중심의 공공문서 코퍼스에서 체감 큼.

## 목표
F2 = 행높이·셀 패딩·셀 테두리(스타일/색/두께)·표 외곽 테두리를 rhwp 파스 결과에서 실값으로
lift → 편집 후에도 원본 표 모양 유지. (다단/F3은 후속 — 이 이슈에서 스코프 확장 금지.)

## 설계
1. **조사**: rhwp Document IR에서 각 값의 소스 필드 확정(행높이/패딩/테두리 fill) — 없으면
   "rhwp가 안 주는 값" 표로 보고(rhwp 수정 금지 계약이므로 그 항목은 정직하게 보류).
2. **lift**: lift.rs에서 하드코딩 제거→실값 매핑. **stored 행높이 floor(020, apply_row_overrides)와의
   상호작용 주의**(V5) — F2의 실값이 020 floor와 이중 적용되지 않게 단일 소스 정리.
3. **serialize**: HWPX 재방출에 반영(테두리 fill id 등 헤더 참조 무결성 — 003 dedup 슬라이스 재사용).
4. **검증**: 게이트 v2(8==8·18==18)가 이 이슈의 1차 수용 기준 — lift는 조판 입력이므로 페이지 수
   변동 가능성이 실재한다. 변동 시 **멈추고 보고**(수치 조정으로 우기지 마라). 셀 단위 검증은
   `layout-check --rows`(020 도구) + 교차렌더 비교. 라운드트립: .hwp→편집→HWPX→재열기 골든.

## 수용 기준
- [ ] 조사 표(값별 rhwp 소스 유/무) 보고 — 구현 전 아키텍트 확인 지점
- [ ] 행높이/패딩/테두리/외곽 실값 lift + HWPX 재방출, 하드코딩 제거 diff 증빙
- [ ] 게이트 v2 유지(변동 시 보고), --rows 오디트로 benchmark1 표 행높이 정합 수치 보고
- [ ] HWP-CONVERSION-FIDELITY.md 갱신(F2 done, 잔여 F3 명시), 053 영역 무접촉

## 함정
- rhwp는 vendored 수정 금지 — 어댑터(crates/hwp-rhwp)에서만.
- LOCKSTEP: 행높이 변경은 place_doc과 NaiveLayout **양쪽**에 같은 입력으로 흘러야 한다
  (한쪽만 반영되는 경로를 만들지 마라).
- 020의 "마지막 줄 leading 트림 + stored floor"는 benchmark1 18==18의 성립 조건 — F2가 이를
  대체하는지 보완하는지 명시적으로 판정하고 테스트로 잠가라.

## 관련 실측 (2026-07-10 — 052 golden 테스트가 격리)
`.hwp` 오리진은 **무편집·동일 폰트 조건에서도** toHwpx 재방출→재열기 시 8p→6p로 재조판된다
(lift/serialize 왕복 서식 손실 — 본 이슈 F2가 갚을 Tier-1 갭의 직접 증상. 콘텐츠는 보존됨).
재현 절차: `apps/hwp-lab/src/lib/goldenRecovery.test.ts` 상단 매트릭스. → F2 수용 기준에
**"무편집 .hwp 왕복 재열기 페이지 수 보존(벤치마크 3종)"**을 추가 검증 항목으로 삼을 것.
(hwpx 오리진의 표 앵커링 오배치는 별개 — [057](057-hwpx-export-table-anchor.md) 관할.)
