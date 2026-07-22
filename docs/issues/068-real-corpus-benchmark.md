# 068 — 실물 벤치마크 코퍼스 + 스윕 게이트 (must-pass 계약)

- 상태: **부분 완료(로컬셋 확보·게이트 그린)** · 우선순위: P1 (진단 U9·U10 — "벤치 2종 밖 임의 문서 미보증"의 축소) · 영역: corpus/private + scripts
- 근거: 사용자 계약(2026-07-22) — **"로컬 `2026_*` 폴더 문서는 전부 지원 가능해야 한다"** + 공무원 접근가능 공개 예시 최대 수집. `docs/USER-BOTTLENECK-DIAGNOSIS.md` U9/U10/S3(HWPX 의무화).

## 완료 (2026-07-22)
- **bench-local-2026 확보**: `~/Desktop/archive` 전수 24건(.hwp 11 + .hwpx 13)을 `corpus/private/bench-local-2026/files/`에 스냅샷(집계 해시 `e2441b612201fc7f`). must-pass 부분집합 = `2026_*__` 접두 8건.
- **기준선 24/24 전부 통과**: detect·own-render·export-pdf·extract-text (`RESULTS-2026-07-22.tsv`). CLI `tf-hwp` release, features `rhwp,shaper,pdf`.
- **게이트 스크립트**: `scripts/bench-corpus.sh` — corpus/private/bench-*를 전수 스윕, 기준선 대비 회귀 시 비제로 종료. corpus/private 부재 환경(CI)은 skip(로컬 전용). `--update-baseline`으로 기준선 갱신.

## 게이트의 의미 (보수적 해석 — 과대해석 금지)
이 게이트는 **"크래시 없이 파이프라인 통과"** 만 보증한다. 시각 충실도·페이지수 정합은 별개:
- 동일 문서쌍 페이지수 괴리 실측: 딥테크 신청서 .hwp **25p** vs .hwpx **18p** · 초창패 .hwp 8p vs .hwpx 6p — 한글 HWPX 저장 열화 이슈군(CURRENT_STATE 2026-07-16)과 폰트메트릭 근사가 겹친 결과. 쌍 비교는 후속 시각 QA 축.

## 완료 추가 (2026-07-22 같은 날)
- **bench-public 수집 완료**: 25건/17.0MB — HWPX 17/HWP5 8, 유형 7종(보도자료 9·공고문 5·서식 4·
  양식 3·고시 2·가정통신문 1·연구보고서 1), 발행처 12곳. `corpus/private/bench-public/` +
  `manifest.json`(출처 URL·KOGL 기록). 전건 매직바이트 실검증. **기준선 25/25 통과**(최대 41p 문서 포함).
  → **총 49/49 ALL PASS** (`scripts/bench-corpus.sh`).
- 라이선스: KOGL-1 잠정 7건·unknown 18건 — **공개 승격 전 개별 공공누리 마크 재확인 필수**(사용자 판단).

## 남은 것
- [x] **KOGL 재확인 완료(2026-07-22, 25건 전수 웹 실측)**: 0/1유형 마크 확인 8건·서울시 2건은 4유형
  (비상업·변경금지 — 부적합)·15건 불명/접근실패. **승격 방식 결정 = 바이너리 재배포 대신
  `corpus/GOV-SOURCES.md` 공개 출처 매니페스트**(검증 7건 URL+유형+sha256) — korea.kr 자유이용이
  "텍스트 한정"이고 전 건 임베드 이미지 실측(3~11개)이라 제3자 이미지 리스크 회피. manifest.json
  라이선스 필드 판정 정정 반영.
- [ ] verify-local.sh(--full)에 bench-corpus.sh 훅 여부 판단(로컬 전용이라 optional 단계로).
- [ ] 시각 파리티 축: must-pass 8건의 own-render를 원본 PDF/한컴 뷰어와 육안 대조(QA.md 시나리오로 편입), 동일 문서쌍(.hwp/.hwpx) 페이지수 허용 오차 정의.
- [ ] 작성완료본(독스헌터_*)의 표 채우기/바이브 편집 시나리오를 067 프로필 실증에 재사용.

## 함정
- **프라이버시**: `corpus/private/`는 gitignore — 레포는 PUBLIC이다. 작성완료본은 실데이터 포함, 절대 공개 승격 금지. 빈 양식·공공문서도 승격 전 라이선스(KOGL 유형) 확인.
- 원본 폴더(~/Desktop/archive)가 이동/수정될 수 있음 — 스냅샷이 정본, 집계 해시로 드리프트 감지.
- 게이트 그린 ≠ 렌더 정확 — RESULTS의 pages 컬럼 변화도 회귀 신호로 볼 것(현재 스크립트는 FAIL만 잡음; pages diff는 수동 확인).
