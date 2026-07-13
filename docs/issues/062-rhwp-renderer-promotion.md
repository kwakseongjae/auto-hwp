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
1. **배포용 복호화** ✅ **done** (c716e8f, 056 해소). 발견: 배포용은 이미 rhwp가 복호 중이었음 →
   hwp-crypto를 NIST골든+fail-closed 정본으로 승격. AES=RustCrypto aes+cipher(MIT/Apache).
2. **옛한글 PUA 테이블** ✅ **done** (6b6d22d). KTUG Public Domain 5,659 매핑 → hwp-typeset/old_hangul.rs.
   측정=전각 프록시(LOCKSTEP 안전)+그리기만 자모확장(additive, cluster=None이면 바이트동일). 게이트 무영향.
   한계: 번들 Nanum은 옛한글 조합 미합성 → Noto Serif CJK KR 필요(폰트 번들은 별도 스코프).
3. **금칙 문자집합** ✅ **done** (c556114). rhwp line_breaking.rs 두 집합(줄머리/줄꼬리) verbatim 재구현 →
   layout_paragraph(LOCKSTEP 단일 지점) kinsoku_adjust. 줄머리=끌어올리기·줄꼬리=밀어내기, 경계에 금칙
   없으면 no-op(바이트동일). 게이트 8==8·18==18 + 줄바꿈 98.9%/99.2% before==after(하락 0, 벤치마크엔
   전각 구두점 경계 없어 additive no-op — 기능은 단위 테스트 4개로 실증). 발견: rhwp는 줄꼬리 집합을
   정의만 하고 미사용 — 우리는 둘 다 구현.
4. **셀 대각선**(난이도 중) → F3 렌더측(하위 하나로 060/F3와 정합). — 잔여
5. **수식 렌더 부트스트랩**(난이도 높음, 즉시 착수 가능 — 폴백부터). — 잔여

## 062 배치 현황 (2026-07-13)
**quick win 3종 완료**: 062-1 배포용복호(056해소) · 062-2 옛한글 · 062-3 금칙 — 전부 병합·검증(게이트 불변).
**잔여(R14 후속)**: 062-4 셀대각선(F3) · 062-5 수식렌더 · 폰트메트릭 실측화 · 차트(자체구현·rhwp upstream 미확인).

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
