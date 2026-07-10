# 053 — R12-P1: 셀 주소형 캐럿 (042 승계 — CARET-GAP P0→P1 실행)

- 상태: open · 우선순위: R12-P1 · 영역: crates/hwp-mcp(CaretRectCell)/hwp-session + packages(어댑터 노출 + 캐럿 오버레이)
- 병렬: 054(.hwp lift — hwp-rhwp/lift.rs 소유, disjoint). 총괄 근거 문서: **docs/CARET-GAP.md** (필독).

## 근거 (docs/CARET-GAP.md 실측)
클릭→편집가능 NodeId 해상률: benchmark.hwp **0.0%** · benchmark1.hwp **0.0%** · benchmark1.hwpx
48.2%. 본문이 표 셀(`in_cell` → node=None)이거나 바이너리 .hwp 문단(stable_key 부재)이라서다.
결과: "아무 데나 클릭해 타이핑"이 실코퍼스에서 불가 — 수동 디테일 편집의 마지막 큰 조각.
추가 발견(§3†): own-render 25p vs rhwp 글리프 렌더러 14p **페이지 발산** — rhwp 지오메트리를
own-render SVG에 얹는 모든 기능의 좌표 위험(P0 선행 과제).

## 목표
표 셀 안에서 클릭 → 글리프 정밀 캐럿 표시 → 타이핑/선택이 되는 UI. 엔진은 own-render
`PlacedGlyph`(글리프별 x, place.rs)를 이미 가진다 — **조판 무변경, 노출과 주소체계만 추가**(V4).

## 설계 (CARET-GAP의 사다리 그대로)
1. **P0 — 좌표 화해**: 캐럿 지오메트리를 rhwp 글리프 경로가 아닌 **own-render PlacedGlyph
   기반으로 통일**할 수 있는지 실측(FG-12 방향). 가능하면 25-vs-14 발산 문제를 우회하고
   rhwp는 파싱 전용 원칙과도 정합. 불가 판정 시에만 rhwp 페이지 화해를 별도 보고.
2. **P1 — 셀 주소형 캐럿 표면**: `Intent::CaretRectCell{section,block,row,col,para,offset}` +
   `hit_test_cell_text` (additive, 018 null 정책). hwp-session 파사드 경유, px 반환(단위 계약 §4.1-5).
3. **어댑터/SDK**: WasmAdapter·TauriAdapter에 동형 노출(옵셔널 메서드 — 생략 시 기능 비활성),
   editor-core caret 컨트롤러, react 캐럿 오버레이(깜빡임/선택 하이라이트 — MarqueeLayer의
   렌더-0 패턴 재사용). 커밋은 기존 runs variant 경유(신규 텍스트 op 금지 — 기존 insert_text
   레인과의 통합은 조사 후 보고).
4. **테스트**: 셀 클릭→캐럿 rect 정합(px) Rust 테스트, 해상률 재실측(목표: benchmark1.hwpx
   48.2%→90%+, 바이너리 .hwp 0%→셀 본문 커버), vitest 캐럿 렌더-0, e2e 1개(셀 클릭→캐럿→타이핑→커밋).

## 수용 기준
- [ ] P0 실측 보고(own-render 통일 가부) — 구현 전 아키텍트 확인 지점
- [ ] CaretRectCell + 셀 텍스트 hit — additive 증빙 + 게이트 v2(8==8·18==18) + wasm-safe
- [ ] 해상률 개선 수치 보고(CARET-GAP.md 갱신), 캐럿 UI 렌더-0, e2e 그린
- [ ] LOCKSTEP 무접촉(place_doc/NaiveLayout diff 0), 054 소유 영역 무접촉

## 함정
- **조판을 캐럿 때문에 고치지 마라**(V4) — 캐럿 x가 어긋나면 조판이 아니라 노출 계층을 고친다.
- PlacedGlyph.font는 display-only — 폰트 변경 후 캐럿 x는 default 메트릭 기준임을 문서화.
- IME 인라인 조합(FG-13)은 이 이슈 스코프 밖(후속) — composition 가드만 유지.
- px↔HWPUNIT 슬립(§4.1-5): 캐럿은 px, 커밋은 HWPUNIT — 변환은 units.ts 단일 지점.
