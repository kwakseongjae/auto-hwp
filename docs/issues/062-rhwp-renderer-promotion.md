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

## 잔여 배치 계획 (2026-07-13 조사·검증 워크플로 wf_842c2cd1 — 9에이전트, 적대적 검증 통과)
전 항목 `document.rs`+`lift.rs` 공유 → **병렬 안전 조합 0개, 순차 강제**(054×057·059×058 교훈). 순서 B1→B2→(여유 시)B3.

- **B1 · 062-4 셀 대각선 X-교차** (난이도 low, 게이트 low, verify=--full) — **다음 착수**.
  발견: 공통 케이스(빈 셀 슬래시/백슬래시)는 모델(`CellDiagonal`/`DiagonalKind`)·lift(`lift.rs:421`)·조판
  (`place.rs:872,1044` 본표+중첩표)·렌더(`PaintOp::Line`)·PDF·유닛테스트까지 **이미 전 계층 완성**. 순델타=X자
  교차 하나(현재 slash+backslash 동시 시 backslash로 붕괴 `lift.rs:854`). v1=DiagonalKind에 Cross 추가 +
  lift 붕괴중단 + place 2곳 match암 2선 emit + 테스트. render/pdf 무수정(render-only 증거). 0b011/0b110/0b111
  뾰족-다중선은 희귀·수확체감→후속. **render-only=게이트 무영향**(diagonal은 NaiveLayout에 전무).
- **B2 · 062-5 수식 렌더 v1** (난이도 M, 게이트 중립, verify=--full) — B1 뒤.
  rhwp `equation/`(7,480줄, 전부 pub) **bootstrap SVG 임베드**: lift 시점에 rhwp 파이프라인 호출(편집 없음,
  062-1 패턴)→`EquationRef.rendered_svg: Option<String>`(additive) 캐싱→SvgSink가 예약박스(저장된 width/height,
  조판입력 불변)에 g 중첩→HTML inline SVG. ⚠️ `PaintOp::Image`가 bin_ref:String만 운반→SVG 채널용 신규
  variant/필드 or data-URI 필요. krilla PDF는 v1 stub 유보(SVG→PDF 경로 부재). 자체 PaintOp 이식(Path/Bezier
  프리미티브 추가)은 별도 XL 이슈(v2).
- **B3 · 062-7 차트 v1 OOXML** ✅ **done** (5cdd5f4) — 신규 chart_render.rs가 rhwp `OoxmlChart::parse→render_svg`
  bootstrap(catch_unwind), **B2의 PaintOp::Image.svg 채널 재사용**(별도 variant 불필요). lift Control::Shape arm이
  OOXML Chart/*.xml만 처리(네이티브 GSO·레거시 VtChart·비차트 OLE→드롭=바이트동일). 박스=저장 크기 예약(place_doc ∥
  NaiveLayout LOCKSTEP). 게이트 선확인: 두 벤치마크에 차트 없음→구조적 중립. 게이트 8==8·18==18, 차트없는 문서
  바이트동일(SVG/HTML/HWPX). own-render+HTML에 rhwp 네이티브 차트 SVG, PDF stub. 레거시 OLE VtChart 유보(rhwp 자신도 미렌더).
- ~~(구)B3 여유 시~~ — 아래는 원 계획(참고):
  **정정: 이슈의 "차트=소스 없음/자체구현" 판단은 사실오류** — rhwp v0.7.15에 `ooxml_chart/`+`ole_chart/`
  파서·SVG 렌더러 완성(배선만 미완, 062 패턴). v1=OOXML(bar/line/pie/combo)만, SVG백엔드 한정 RawSvg 임베드,
  PDF stub. ⚠️ 차트 현재 드롭(`lift.rs _=>{}`)→박스 미예약→신규 박스가 flow 밀 수 있음(착수 전 게이트 선확인).
  RawSvg는 screen==export 불변식을 PDF/canvas에서 위배→SVG전용. 희소·render-only라 최후미.

- **폰트 메트릭 실측화 = 디스코프**(착수 비권고). ① RealFontMetrics(rustybuzz)가 이미 런타임 실측 — rhwp
  테이블은 precompute 캐시일 뿐. ② 라이선스가 가치있는 상용 face(Malgun/함초롬/HY, `ttfs/windows/` 추출) 차단;
  합법 OFL 재생성분은 이미 live 측정 중이라 실익 미미. ③ 아키텍처 상충(advance_width family-blind·Hangul EM-격자
  스냅·OFL 치환 draw==measure). ④ V5 최고 게이트 리스크 대비 ROI 낮음. 강행 시 SOLO+before==after gating 필수.
- **차트 잔여**: 레거시 OLE VtChart(휴리스틱·chart_type=Unknown)는 v1 스코프 밖. rhwp upstream(>v0.7.15) 델타는 여전히 미확인.

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
