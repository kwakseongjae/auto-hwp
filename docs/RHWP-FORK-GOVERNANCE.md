# rhwp 포크 거버넌스와 자체 엔진 경계

정본 메타데이터는 `docs/rhwp-fork-policy.json`이다. `external/rhwp`는 MIT 상류
`edwardkim/rhwp`의 우리 조직 포크를 가리키는 고정 서브모듈이며, 제품 코드는 서브모듈을 직접
수정하지 않는다. 2026-08-23 감사 시 우리 포크의 `v0.7.19`는 상류의 같은 태그/커밋
`f137b4c9468eaff5bb43e25108e9c9d39a2ed15b`와 동일했다(고유 커밋 0). 당시 상류 main보다
3402커밋 뒤였다는 수치는 변동 정보이므로 게이트가 아니다.

## 소유 경계

| 능력 | 생산 경로 | 소유 상태 |
|---|---|---|
| HWPX parse/write·무손실 round-trip | `hwp-hwpx` | 자체 엔진 |
| live 조판·SVG·PDF·편집 op-bus | `hwp-typeset`→`hwp-render`/`hwp-export`→`hwp-ops` | 자체 엔진 |
| HWP5/HWP3 bytes→SemanticDoc | `hwp-rhwp`→`external/rhwp` | 교체 대상 hard dependency (#107, #94) |
| 원본 SVG/lineseg/glyph 비교 | 명시적 `source:"original"`·오라클 API | read-only 보조 경로 |
| 수식/차트 SVG enrichment | `hwp-rhwp` helper가 derived cache만 채움 | 좁은 교체 대상 |

따라서 auto-hwp는 rhwp에 완전 종속되지 않는다. HWPX와 최종 live 렌더/export/edit는 이미
자체 소유지만, rhwp feature 없는 빌드는 아직 바이너리 HWP5/HWP3를 열 수 없다. 편집하거나 합성한
HWPX를 rhwp에 다시 넣어 생산 렌더·저장하지 않는다. rhwp 직렬화 API도 공개하지 않는다.

## 역할과 변경 절차

- auto-hwp maintainer는 포크 태그, 보안 backport, 서브모듈 bump, 어댑터 경계를 소유한다.
- 상류 동기화는 월 1회와 보안 공지 시 수행한다. upstream release를 검토하되 main의 이동량 자체는
  합격 조건이 아니다. 필요한 패치만 별도 `auto-hwp/<issue>` 브랜치로 cherry-pick한다.
- 포크 릴리스 태그는 `auto-hwp-v<upstream>-p<N>`을 쓰고 force-push/태그 재사용을 금지한다.
  새 태그와 commit을 만든 뒤 policy JSON, gitlink, Cargo.lock을 한 PR에서 함께 올린다.
- `scripts/vendor-rhwp.sh`로 정확한 태그를 checkout하고 `node scripts/verify-rhwp-boundary.mjs`,
  `cargo test -p hwp-rhwp --features "rhwp shaper"`, `scripts/verify-local.sh --full` 순서로 검증한다.
  회귀 시 gitlink와 policy를 직전 검증 태그로 되돌리는 별도 issue/PR을 만든다.
- 외부 기여는 먼저 auto-hwp 공개 이슈에서 재현한다. 사용자 원문·민감 문서는 포크/이슈/CI에
  올리지 않으며 최소 비식별 fixture만 사용한다.

## 보안

취약점·exploit·개인정보 가능성은 공개 세부를 쓰지 않고 GitHub Private Vulnerability Reporting으로
전환한다. Critical은 24시간 내 분류·72시간 내 보호 포크 수정 목표, High는 7일 내 수정 후보를
목표로 한다. 공개 tag는 수정하지 않고 새 patch tag로 배포한다. 서브모듈 변경 PR은 네트워크 없는
경계 verifier, 라이선스, 전체 파서/조판 회귀가 모두 green이어야 한다.

## 독립화 순서

F0(#87/#151)은 이 문서·검증기·코드 경계를 소유한다. F1(#107)은 자체 HWP5 container/record
경계를 `hwp-hwp5`로 구현했다(`docs/HWP5-NATIVE-PARSER.md`). production decode는 아직 rhwp이며,
#94가 DocInfo/text/object semantic slice와 corpus parity를 순차 승격한다. 자체 전용 API는 미지원
slice에서 fail-closed하고 production route로 fallback하지 않는다. 한 기능씩 corpus와
lineseg/페이지/PDF 시각 오라클을 통과시킨 뒤에만 rhwp 호출을 제거한다.
