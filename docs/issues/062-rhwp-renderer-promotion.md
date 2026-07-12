# 062 — rhwp 렌더러 계층 승격 (이미 트리 안 MIT 코드를 우리 엔진에 배선)

- 상태: open · 우선순위: R14 배치(quick win 순) · 영역: crates/hwp-crypto·hwp-typeset(+PaintOp) — vendored rhwp에서 이식
- 근거: 2026-07-13 오픈소스 전수 조사. **헤드라인 발견**: 우리가 "미구현/스텁"으로 알던 약점 상당수가
  `external/rhwp`(MIT, v0.7.15, **이미 우리 소유**)의 **렌더러 계층**에 완성돼 있다. tf-hwp는 rhwp를
  **파스 전용**으로만 쓰고 렌더는 자체 `hwp-typeset`으로 하기 때문에 배선이 안 됐을 뿐 —
  라이선스 리스크 0의 "우리 코드 승격"이다.

## 갭 → rhwp 소스 (전부 external/rhwp, MIT)
| 우리 약점 | rhwp 완성 위치 | 승격 형태 |
|---|---|---|
| 배포용 복호화(현 15줄 스텁) | `src/parser/crypto.rs`(MSVC LCG→XOR→AES-128-ECB 순수 Rust, NIST 벡터 테스트 보유) | 코드 이식 → hwp-crypto |
| 금칙(禁則) 줄머리/줄꼬리 | `src/renderer/composer/line_breaking.rs`(문자집합 완비) | 데이터+코드 → shaper.rs TODO 자리 |
| 배분/나눔 정렬 | `src/renderer/composer/`·`layout` | 코드 → hwp-typeset |
| 다단(Distribute/Parallel) | rhwp 다단 배치 | 코드 → hwp-typeset (005 §단 미완 해소) |
| 셀 대각선(F3) | `src/renderer/layout/table_layout.rs::render_cell_diagonal` | 알고리즘 → PaintOp IR |
| 수식 렌더 | `src/renderer/equation/`(**7,480줄** 완전 엔진) | rhwp-bootstrap식 폴백 → 장기 자체화(accforaus HwpEqToTex.kt=Apache 참고) |
| 옛한글 PUA→자모 | `src/renderer/pua_oldhangul.rs`(KTUG **Public Domain** 매핑표) | 데이터 테이블 → 함초롬 의존 제거 |
| 폰트 메트릭 근사→실측 | `src/tools/font_metric_gen.rs`(추출 도구) | ⚠️ 도구를 **OFL 폰트에 재실행**해 자산 재생성(상용폰트 추출분 재배포 회색지대 회피) |

## 착수 순서 (quick win 난이도순 — 각각 별도 커밋/검증)
1. **배포용 복호화**(난이도 낮음) → **056을 이걸로 해소**. `.hwp`는 `rhwp::parse_document`가 이미 자동
   복호 중이므로 SDK/HWPX 경로 배선 + rhwp crypto 테스트 벡터 재사용. ⚠️ 암호 문서(사용자 비번→SHA-1)는
   rhwp에도 없음 — 별도 영역(장기).
2. **옛한글 PUA 테이블**(난이도 낮음, Public Domain — 라이선스 가장 깨끗).
3. **금칙 문자집합**(난이도 낮음~중) → 그리디 브레이커에 훅. benchmark 줄바꿈 98.9%↑ 여지.
4. **셀 대각선**(난이도 중) → F3 렌더측(하위 하나로 060/F3와 정합).
5. **수식 렌더 부트스트랩**(난이도 높음, 즉시 착수 가능 — 폴백부터).

## 함정
- rhwp는 vendored 수정 금지(계약) — **읽어서 우리 crate에 재구현/이식**(어댑터 방식). rhwp 파일 자체 편집 아님.
- 게이트 V5: 금칙·정렬·다단은 조판 입력 변경 → benchmark 8==8·18==18 재확인 필수(틀어지면 멈추고 보고).
- 폰트 메트릭: 상용폰트 추출 수치 재배포 회색지대 → OFL 폰트로 도구 재실행해 자산 재생성(클린).
- LOCKSTEP: place_doc↔NaiveLayout — 조판 변경은 양쪽 동일 입력.
- 차트 렌더는 **어느 소스도 미해결**(rhwp upstream 델타 미확인) → 자체 구현 확정, 이 이슈 밖.

## 후속 확인 (미확인)
- rhwp upstream(>v0.7.15) 델타(특히 차트) — 확인 후 반영.
- kordoc 정체·라이선스 — 확인 후 참조 여부 판단.
- 암호 문서(SHA-1) 복호화 클린룸(pyhwp AGPL 접촉 금지 — 산문/스펙 근거로 자체 구현).
