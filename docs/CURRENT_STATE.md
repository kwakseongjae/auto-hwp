# CURRENT STATE — 단일 복원 지점

> 새 세션·compact 후 **이 파일 하나만 읽으면 재개할 수 있어야 한다.**
> 갱신 시점: 작업 단위 완료 · 결정 확정 · 머지 직후 (보고보다 먼저). 프로토콜: `AGENTS.md` §세션 연속성.

- 갱신: 2026-08-24 · Codex(sol) — **PR #181 병합 · #182 next TABLE 착수**.
  #175는 exact head `6711ff9`에서 issue-link/build-test/licenses green, CLEAN/MERGEABLE,
  review/general/inline 댓글 0을 확인하고 protected main `c917c584`로 squash 병합했다. #174 close와
  원격 branch 정리 후 #94에 bounded two-table host 소유 근거를 동기화했다. 월요일 #114 감사에서
  open PR 0, 새 외부 제보·스팸·보안 신호 0, 기존 외부 #50의 Proposal/security 라우팅, desktop
  signing blocker를 재확인했다. 중복 없는 #176을 R18/P1/area:hwp5/status:ready로 열고 exact latest
  main의 `codex/issue-176-hwp5-next-table` worktree를 만들었다. **다음:** content-free TABLE
  `0x4d/7561..7605` header/child topology 분류→faithful shared-IR 표현 가능할 때만 synthetic/hostile
  fixture와 strict parser 구현. production route·HWPX·shared layout·generated assets·rhwp는 불변.
  분류 결과 exact 9×8/34 active cells, 행별 count `2/2/4/1/5/5/5/5/5`, 고정 horizontal merge
  topology, 1~2 cell paragraphs, 단 하나의 depth-1 1×1 nested table이다. attr은 no-split·inert
  repeat-header·no-adjust의 exact `0x0600000c`이고 shared IR의 keep-together/fixed-row-height/nested
  Block으로 표현 가능하다. parser는 row count·span/order·record level, zero/mirrored-width 13B cell
  extension, border refs, row heights, common geometry를 검증하고 span equation graph로 8개 column
  boundary를 유일하게 복원한다. nested table은 exact cell/paragraph 위치와 depth≤1만 허용한다.
  synthetic positive + hostile attr/row-count/span/width/extension/missing/deeper-nest 7축을 추가해 HWP5
  **57 tests** green. 공개 own-parser 경계는 다음 TABLE `0x4d/13704..13746`(8×5)으로 전진했다.
  focused clippy `-D warnings`·wasm32와 quick의 fork governance, fmt/clippy, Rust workspace,
  PDF visual **51**, canonical **8/18/24·98.9%+**, public corpus **84**, oracle **82**, HWPX,
  wasm/licenses가 모두 green이다. full도 wasm 재빌드(7,810,657B), JS build·crosscheck·i18n,
  Vitest **1,018**까지 green이고 샌드박스 포트 EPERM만 허용된 로컬 서버에서 분리 실행해 Chromium
  **85 pass/3 intentional skip/0 fail**이다. 임시 dependency link는 제거했고 production route·
  HWPX parser/serializer·shared typesetter·`external/rhwp`·generated asset diff 0, 공개 금지 원문·
  경로·hash·raw payload·credential diff 0을 확인했다. 구현은 commit `52e9fc6`으로 push했고 PR #177을
  `Closes #176`으로 게시했다. exact head `e3199a7`에서 issue-link **2s**·build-test **9m12s**·licenses
  **2m52s** green, MERGEABLE, review/general/inline 댓글 0을 확인하고 protected main `aa7a23f7`로
  squash 병합했다. #176 close·원격 branch 정리 후 #94에 근거를 동기화하고, 중복 없는 #178을
  R18/P1/area:hwp5/status:ready로 열었다. exact latest main의
  `codex/issue-178-hwp5-next-table` worktree와 pinned rhwp oracle을 초기화했다. **다음:** content-free
  TABLE `0x4d/13704..13746`의 exact flag/topology/geometry/nesting을 먼저 분류→shared IR이 모든 active
  semantics를 faithful하게 표현할 때만 synthetic/hostile fixture와 strict parser 구현. production route·
  HWPX·shared layout·generated assets·rhwp는 불변. 1차 분류 결과 attr exact `0x0600000e`, 8×5,
  active cells **19**, row counts `4/2/2/2/2/2/3/2`, horizontal merges + `(row6,col0)`의 2-row
  merge, depth-1 1×1 nested table **9개**다. row-span 1 cells가 도출한 높이
  `5012/7339/10169×4/11921/1848`은 object height **66796**과 정확히 같고 spanning cell height도
  마지막 두 행 합과 같다. 모든 셀의 stored width는 shared `Cell.width` ragged-row lane으로 보존 가능;
  row6 마지막 cell의 legacy 13B extension만 core width와 다르며 아래 row/grid width와 일치하므로
  extension을 geometry로 오인하지 않고 exact bounded discriminator로 다뤄야 한다. low attr=2는 로컬
  공식 rev1.3 표기와 pinned rhwp의 RowBreak 해석이 충돌하므로 현 shared pagination 의미로 섣불리
  확정하지 않는다. 다만 repeat-header bit는 active header cell이 없어 inert하고 no-adjust는 exact row
  heights로 표현 가능하다. one-shot numeric classifier는 제거했다. **다음:** exact topology/
  width-ref/extension/nested-position synthetic+hostile fixture→strict parser; row-span height constraints와
  ragged `Cell.width`를 보존하고 global column widths는 기존 lift와 동일한 bounded derivation만 사용.
  첫 own parse는 top-level을 통과해 nested 1×1 geometry까지 전진했다. 9개 중 7개는 common/cell
  height가 exact하고, 첫 행의 좁은 2개만 stale common **3882** 대 cell **1848**이다. 폭/extension은
  전부 일치하고 다른 framing도 같으므로 depth-1 exact height pair만 bounded legacy exception으로
  소유하며 cell height를 shared IR geometry로 보존한다. 추가 one-shot classifier도 제거했다.
  strict parser와 합성 회귀를 구현해 exact width-ref pattern, 19-cell row-major span, layout-width
  override delta, row-span height 합, 9개 nested 위치/개수, 2개 stale common-height pair를 검증한다.
  13B override를 authoritative `Cell.width=20279`로 내리면 span equations가 5개 열
  `7667/16324/3879/3955/16324`를 유일하게 복원하고 모든 행 effective width가 object **48149**와
  일치한다. attr/count/rowspan/delta/width-ref/nested missing·wrong-position/stale-height hostile 8축은
  fail-closed. HWP5 **59 tests**, fmt, clippy `-D warnings`, wasm32 green이며 public boundary는 다음
  `CTRL_HEADER 0x47/21538..21588`의 unowned common-object attr로 전진했다. quick의 Rust workspace,
  PDF visual **51**, canonical **8/18/24·98.9%+**, public corpus **84**, oracle **82**, HWPX,
  wasm/licenses가 green이다. full은 wasm 재빌드 **7,810,657B**, JS build·crosscheck·i18n,
  Vitest **1,018**까지 green이고 sandbox port EPERM만 허용된 로컬 서버에서 분리한 Chromium도
  **85 pass/3 intentional skip/0 fail**이다. 임시 dependency link를 모두 제거했으며 production
  route·HWPX parser/serializer·shared typesetter·`external/rhwp`·generated asset diff 0을 재확인했다.
  final security/diff review도 source content/path/hash/raw payload/credential 노출 0이며 구현 commit
  `28d1c55`을 push하고 PR #179를 `Closes #178`로 게시했다. exact head `4b999b1`에서 issue-link
  **5s**·build-test **9m08s**·licenses **2m18s** green, CLEAN/MERGEABLE, review/general/inline
  댓글 0을 확인하고 protected main `22b6979a`로 squash 병합했다. #178 close·원격 branch 정리 후
  #94에 근거를 동기화하고 중복 없는 #180을 R18/P1/area:hwp5/status:ready로 열었다. exact latest
  main의 `codex/issue-180-hwp5-common-object` worktree와 pinned rhwp oracle을 초기화했다. **다음:**
  content-free `CTRL_HEADER 0x47/21538..21588`의 common-object flags·child topology를 분류하고,
  shared IR/SVG/PDF가 active semantics를 모두 표현할 때만 strict synthetic/hostile slice를 구현.
  production route·HWPX·shared layout defaults·generated assets·rhwp는 불변. 분류 결과 common attr
  exact `0x082a2211`은 기존 owned inline table의 `0x082a2311`과 horizontal relative 기준만
  column/paragraph로 다르고 treat-as-char·top-and-bottom·absolute size·zero offsets는 같다. child는
  exact TABLE `0x04000004`, 1×2/2 active cells, no-split + repeat-header이며 첫 셀만 header flag다.
  단일 행 전체가 atomic이라 반복 의미는 비활성이고 shared IR로 손실 없이 표현 가능하다. 폭
  `39903+2261=42164`, 양 cell height와 object height **3005**, mirrored 13B extension, padding·border
  refs가 모두 일치한다. common/table pair를 함께 exact match하고 첫/둘째 width-ref를 `0x0500/0`으로
  고정했다. common attr/table attr/row count/width/width-ref/order/extension hostile **7축**은
  fail-closed. one-shot classifier는 제거했다. HWP5 **61 tests**, fmt, clippy `-D warnings`, wasm32
  green이며 public boundary는 다음 TABLE `0x4d/25952..25990`의 unowned topology로 전진했다.
  quick의 Rust workspace, PDF visual **51**, canonical **8/18/24·98.9%+**, public corpus **84**,
  oracle **82**, HWPX, wasm/licenses가 green이다. full도 wasm 재빌드 **7,810,657B**, JS
  build·crosscheck·i18n, Vitest **1,018**까지 green이고 sandbox port EPERM만 허용된 로컬 서버에서
  분리한 Chromium **85 pass/3 intentional skip/0 fail**이다. 임시 dependency link를 제거했고
  production route·rhwp·HWPX parser/serializer·shared typesetter·generated asset diff 0을 확인했다.
  final security/diff review도 source content/path/hash/raw payload/credential 노출 0, silent fallback 0,
  변경 파일은 parser/tests/state 5개뿐이다. PR #181 exact head `10f2b0a0`에서 issue-link **5s**·
  build-test **9m08s**·licenses **2m04s** green, CLEAN/MERGEABLE, review/general/inline 댓글 0을
  확인하고 protected main `09e71a07`로 squash 병합했다. #180 close·원격 branch 정리 후 #94에
  exact 근거를 동기화하고, 중복 없는 #182를 R18/P1/area:hwp5/status:ready로 열었다. exact latest
  main의 `codex/issue-182-hwp5-next-table` worktree와 pinned rhwp oracle을 초기화했다. **다음:**
  content-free TABLE `0x4d/25952..25990`의 flags·topology·geometry·nesting을 먼저 분류하고 shared
  IR/SVG/PDF가 모든 active semantics를 faithful하게 표현할 때만 strict synthetic/hostile slice를 구현.
  production route·HWPX·shared layout defaults·generated assets·rhwp는 불변. 분류 결과 exact common
  attr `0x082a2311` + TABLE attr `0x04000004`, 6×4 완전 격자/24 active cells, row counts 전부 4,
  병합·중첩 없음, 모든 셀 1문단이다. col widths `3238/14908/11795/18021` 합은 object **47962**,
  row heights `1946/1846×5` 합은 object **11176**과 exact다. mirrored 13B extension과 padding·border
  refs도 일치한다. row0 width-ref는 모두 `0x0100`, rows1..5는 `0x0500`; repeat-header attr은 active
  header cell이 없어 inert이고 no-split은 shared `keep_together`로 보존 가능하다. one-shot numeric
  classifier는 제거했다. **다음:** exact tuple/24-cell row-major/width-ref/geometry synthetic+hostile
  fixture→strict parser; route/rhwp/HWPX/generated 불변. strict parser와 합성 회귀를 구현해 exact
  common/table pair, 24-cell row-major full grid, row counts, 1-paragraph cells, row0/body width refs,
  mirrored extension, column/row/object geometry를 검증한다. common/table attr·row count·width·height·
  paragraph count·width-ref·order·extension hostile **9축**은 fail-closed. HWP5 **63 tests**, fmt,
  clippy `-D warnings`, wasm32 green이며 public boundary는 다음 TABLE `0x4d/30321..30361`의 unowned
  topology로 전진했다. quick의 Rust workspace, PDF visual **51**, canonical
  **8/18/24·98.9%+**, public corpus **84**, oracle **82**, HWPX, wasm/licenses가 모두 green이다.
  full도 wasm 재빌드 **7,810,657B**, JS build·crosscheck·i18n, Vitest **1,018**까지 green이고
  sandbox port EPERM만 허용된 로컬 서버에서 분리한 Chromium **85 pass/3 intentional skip/0
  fail**이다. 임시 dependency link는 모두 제거했다. final diff/security review에서 one-shot
  classifier·production route·rhwp·HWPX parser/serializer·shared typesetter·generated asset diff
  0, source content/path/hash/raw payload/credential 노출 0을 확인했고 변경 파일은 strict HWP5
  parser/tests/state 5개뿐이다. 구현 commit `4aa018b`을 push하고 PR #183을 `Closes #182`로
  게시했다. exact head `75f49e9f`에서 issue-link **3s**·build-test **7m46s**·licenses **2m48s**
  green, MERGEABLE, review/general/inline 댓글 0을 확인하고 protected main `c95fef7c`로 squash
  병합했다. #182 close·원격 branch 정리 후 #94에 exact 근거와 다음 boundary를 동기화했다.
  중복 없는 #184를 R18/P1/area:hwp5/status:ready로 열고 exact latest main의
  `codex/issue-184-hwp5-next-table` worktree와 pinned rhwp oracle을 초기화했다. **다음:**
  content-free TABLE `0x4d/30321..30361`의 flags·topology·geometry·nesting을 먼저 분류하고,
  shared IR/SVG/PDF가 모든 active semantics를 faithful하게 표현할 때만 synthetic/hostile fixture와
  strict parser를 구현. production route·HWPX·shared layout defaults·generated assets·rhwp는 불변.
  분류 결과 exact common attr `0x082a2311` + TABLE attr `0x0600000c`, 7×3/active cells **19**,
  row counts `3/3/2/3/3/3/2`다. `(row1,col0)`의 2-row vertical merge와
  `(row6,col0)`의 2-column horizontal merge만 있고 중첩 표는 없다. 모든 셀 1문단, mirrored 13B
  extension이며 col widths `6509/31215/10200` 합은 object **47924**와 exact다. row heights
  `2229/2129×5/2229` 합은 object **15103**과 exact이고 vertical span height **4258**도 두 행 합과
  같다. width-ref는 col0/1 `0x0500`, col2 `0x0100`으로 고정된다. attr의 no-split/no-adjust는 기존
  shared `keep_together=true`/`fixed_row_heights=true`로 보존되고 repeat-header는 active header cell이
  없어 inert하다. one-shot numeric classifier는 두 번 동일 결과를 확인한 뒤 제거했다. **다음:**
  exact tuple/19-cell topology/width-ref/span/geometry/extension synthetic+hostile fixture→strict parser;
  route/rhwp/HWPX/generated 불변.

- 갱신: 2026-08-24 · Codex(sol) — **PR #173 병합 · #174 multi-table 경계 착수**.
  자체 HWP5 파서가 exact `tbl ` marker/common-object/TABLE/LIST_HEADER/cell paragraph를 검증해
  treat-as-character 1×1 표를 source-neutral `Table`/`Cell` IR로 내린다. 셀/개체 geometry,
  inherited padding, CENTER alignment, border-fill refs를 range/shape 검증하고 visible host text,
  larger·floating·merged·captioned·nested table과 불일치 geometry/ref는 content-free fail-closed한다.
  nested cell을 위해 문단 파서는 상대 `base_level`을 소유한다. 표에 앞선 public prerequisite인
  exact 19B `secd` extension, dormant note-shape framing, visually inert page-border refs도 strict하게
  소유했다. page-border attr은 로컬 vendored 공식 HWP 5.0 revision 1.3의 low bits와 관측된 두 legacy
  word만 허용하며 보이는 border/shade/diagonal은 거부한다. 동일한 `pgnp`/`nwno` 중복은 typed
  equality로 idempotent collapse하고 충돌 중복은 거부한다. 공개 자체 파서 경계는
  `CTRL_HEADER 0x47/499..549`에서 다음 larger `TABLE 0x4d/936..982`로 전진했다.
  quick/full의 Rust workspace, HWP5 **51**, typeset **94**, PDF visual **51**, canonical
  **8/18/24·98.9%+**, public corpus **84**, oracle **82**, HWPX, wasm(7,810,113B), licenses,
  JS build·crosscheck·i18n, Vitest **1,007**이 green이고 Chromium **85 pass/3 intentional skip/0 fail**.
  fresh worktree node_modules와 sandbox port는 루트 설치 임시 링크/허용된 로컬 서버로 분리 검증 후
  링크를 제거했다. production route·HWPX parser/serializer·shared typesetter·`external/rhwp`·
  generated asset diff 0이며 원문·경로·hash·raw payload는 공개하지 않았다. PR #169는 exact head
  `d870e80`의 필수 CI·MERGEABLE·댓글 0을 확인하고 main `0cb4529`로 병합, #168 close·branch 정리.
  #170의 next TABLE은 content-free 분류상 10×2/17 cells/가로병합 3행/셀 1~5문단이며 width/height
  합이 object geometry와 정확히 일치한다. 그러나 official no-split attr을 현 always-row-split IR이
  표현하지 못해 #170은 fail-closed 유지하고 #171을 prerequisite로 열었다. exact latest-main
  `codex/issue-171-table-keep-together`에서 additive `Table.keep_together` default false와
  `place_doc`/`NaiveLayout`/`block_pages`/column flow 동일 선결정을 구현했다. 전체 측정 높이가 fresh
  lane에는 맞고 current remainder에만 안 맞을 때 row 0 전에 한 번 advance하며, current에 맞거나
  fresh lane보다 큰 표와 default false 표는 기존 row fragmentation 그대로다. JSX는 true만
  `data-keep-together=1`로 왕복하고 다른 값은 거부하며 equality도 의미를 비교한다. direct tests는
  current fit/page move/over-tall fallback/default unchanged/column move/column over-tall을 잠갔다.
  quick/full의 Rust workspace, hwp-typeset **100+4**, PDF visual **51**, canonical
  **8/18/24·98.9%+**, public corpus **84**, oracle **82**, HWPX, wasm(7,810,657B), licenses,
  JS build·crosscheck·i18n, Vitest **1,007**이 green이고, 샌드박스 포트 EPERM만 허용된 로컬
  서버에서 분리 재실행해 Chromium **85 pass/3 intentional skip/0 fail**이다. 임시 dependency
  link는 제거했고 production route·rhwp·HWPX parser/serializer·generated asset diff 0.
  PR #172는 exact head `02f0c630`의 issue-link **4s**·build-test **8m32s**·licenses **2m38s**
  green, CLEAN/MERGEABLE, review/general/inline 댓글 0을 확인하고 main `e14c8e7`로 squash 병합했다.
  #171 close·원격 branch 정리 후 #170의 중복 docs-only checkpoint는 main에 이미 포함된 것을
  대조해 rebase에서 skip하고, `codex/issue-170-hwp5-next-table`을 exact new main으로 force-with-lease
  갱신했다. strict parser는 exact 10×2/17 active cells, row-major horizontal spans(row 0/1/5),
  zero spacing/zones, CENTER horizontal LIST_HEADER, observed width-ref 0/0x100/0x500, 1~5 paragraphs,
  table/cell padding·border refs·object/column/row geometry를 bounded 검증한다. col widths와 stored row
  floors는 rhwp lift와 같은 source-neutral 방식으로 도출하고 no-split attr은 `keep_together=true`로
  내린다. 셀 문단 끝의 별도 char shape boundary는 terminal empty run으로 보존한다. count/span/
  missing/extra count·span·width·row-height·paragraph-count·width-ref·order hostile 8종은
  fail-closed하며 HWP5 **53 tests**, clippy `-D warnings`, wasm32 green. 공개 경계는 TABLE
  `936..982`를 소유하고 다음 multi-table CTRL_HEADER `5926..5976`에서 static content-free
  unsupported로 전진했다. quick/full의 Rust workspace, typeset **100+4**, PDF visual **51**,
  canonical **8/18/24·98.9%+**, public corpus **84**, oracle **82**, HWPX, wasm(7,810,657B),
  licenses, JS build·crosscheck·i18n, Vitest **1,007**이 green이다. 샌드박스 포트 EPERM만 허용된
  로컬 서버에서 분리 재실행해 Chromium **85 pass/3 intentional skip/0 fail**이며, 이후 강화한
  distinct terminal char-shape/extra-cell bound도 focused HWP5·clippy 재검증 green. 임시 dependency
  link 제거, production route·rhwp·HWPX parser/serializer·generated asset diff 0.
  검증 완료 PR #173은 exact head `864d985`에서 issue-link **5s**·build-test **9m01s**·licenses
  **2m45s** green, CLEAN/MERGEABLE, review/general/inline 댓글 0을 확인하고 main `cfb42b3d`로
  squash 병합했다. #170 close·원격 branch 정리 후 #94에 근거를 동기화했고, 중복 검색 0건인
  다음 content-free 경계를 #174로 등록했다. exact latest main의
  `codex/issue-174-hwp5-multi-table`에서 marker/header 1:1 순서, disjoint child ownership,
  anchor→ordered Table lowering을 먼저 분류하며 표현 불가능한 inline semantics면 fail-closed와 최소
  prerequisite를 유지한다. 커뮤니티 감사상 새 외부 PR·스팸·보안 신호는 없고 기존 외부 #50은
  Proposal·provider 보안 child에 이미 연결돼 있다. **다음:** #174 content-free 분류→합성 hostile
  fixture→focused/quick/full; production route·HWPX·rhwp 불변. 1차 분류 결과 host는 visible char 0,
  table marker 2개(offset 0/8)와 동일 순서의 disjoint CTRL_HEADER 2개를 가진다. 두 번째 표는 exact
  common-object/no-split 1×1/1 active cell/4 paragraphs이며 object·cell geometry가 일치한다. 기존
  strict 1×1과의 유일한 의미 차이는 LIST_HEADER `0x0501`: pinned rhwp와 공식 bitfield상 low bit는
  cell-own inner margin이고 shared `Cell.padding`으로 정확히 표현 가능하다. rhwp lift도 동일 control
  순서대로 anchor 뒤 `Block::Table`을 1:1 emit한다. 따라서 #174는 exact own-margin bit + ordered
  multi-table lowering만 소유하고 보호/header/form 등 다른 low bit와 mixed/nested/floating은 거부한다.
  구현은 host당 exact 최대 2개, marker/header count·ID·순서와 disjoint record-level child 귀속을 기존
  strict framing으로 검증한 뒤 ordered `Table`을 emit한다. 1×1 `0x0501`만 stored padding을
  `Cell.padding`으로 내리고 10×2 또는 protect/header/form low bit는 거부한다. 합성 positive는
  10×2→1×1 순서/단일 anchor/4 paragraphs/own padding을 잠갔고 missing·extra marker, visible text,
  unknown cell bit, stray child, third control을 정확한 정적 오류로 거부한다. 공개 경계는 multi-table
  CTRL `5926..5976`를 넘어 다음 TABLE `0x4d/7561..7605`의 unowned attr/framing으로 전진했다.
  HWP5 **55 tests**, clippy `-D warnings`, wasm32 green; route/rhwp/HWPX/generated diff 0.
  quick/full의 Rust workspace, typeset **100+4**, PDF visual **51**, canonical **8/18/24·98.9%+**,
  public corpus **84**, oracle **82**, HWPX, wasm(7,810,657B), licenses, JS build·crosscheck·i18n,
  Vitest **1,018**이 green이다. full의 샌드박스 포트 EPERM만 전용 `PW_PORT=31974`에서 분리해
  Chromium **85 pass/3 intentional skip/0 fail**을 확인했다. 첫 quick은 코드가 아닌 완료 worktree
  build cache 누적으로 ENOSPC였고, 병합 완료 #164/#166/#168/#170/#171의 재생성 가능한 Cargo
  cache만 `cargo clean`해 약 69GiB를 회수한 뒤 같은 quick이 전부 green. 임시 dependency link 제거,
  production route·rhwp·HWPX parser/serializer·generated asset diff 0.
  검증 완료 commit `aee1f70`을 push하고 PR #175(`Closes #174`, `Refs #94 #170 #171 #172 #173`)을
  게시했다. **다음:** exact-head issue-link/build-test/licenses·mergeability·review/comment 추적→전부
  green이면 자율 병합·branch 정리→TABLE 7561 child 분류.

- 갱신: 2026-08-23 · Codex(sol) — **#161 PR #163 게시**.
  검증 완료 commit `c751833`을 push하고 PR #163(`Closes #161`, `Refs #94 #160`)을 만들었다.
  normal 1~32단 strict subset, 3-path LOCKSTEP, SVG/PDF shared line, separator-span/distribution
  fail-closed, public boundary 0x47/431..451, no production cutover/no rhwp/generated drift와
  quick/full/Vitest 1,018/Chromium 85 pass·3 skip을 본문에 명시했다. **다음:** 이 상태 commit push→
  issue-link/build-test/licenses·mergeability·review/comment 추적→전부 green이면 자율 병합·branch 정리.

- 갱신: 2026-08-23 · Codex(sol) — **#161 게시 준비 완료**.
  최종 quick이 다시 전부 green이고, PDF export가 column separator `PaintOp::Line`을 같은 page tree에서
  produced=1/replayed=1/stubbed=0으로 소비하는 직접 회귀도 추가했다. 별도 demo proxy **11 tests**를
  동일 lockfile 의존성으로 확인해 full Vitest 합계는 **1,018**, Chromium은 **85 pass/3 skip**이다.
  final diff/security review에서 source content/path/hash/credential 노출·silent fallback·production route
  변경이 없고 `external/rhwp`와 generated asset diff도 0이다. **다음:** commit/push→PR `Closes #161`/
  `Refs #94 #160`→issue-link/build-test/licenses·mergeability·review/comment 확인→green 자율 병합.

- 갱신: 2026-08-23 · Codex(sol) — **#161 full green · separator span 최종 하드닝**.
  full의 Rust/PDF/canonical/public corpus/oracle/HWPX/wasm/JS build·crosscheck·i18n과 Vitest
  **1,007**이 green이고, 샌드박스 포트 EPERM만 전용 `PW_PORT=31861`에서 분리 재실행해 실제
  Chromium **85 pass/3 intentional skip/0 fail**을 확인했다. 이후 페이지 전체 구분선 렌더의
  정직한 경계로 mid-section separator zone도 fail-closed하고 합성 회귀를 추가해 hwp-hwp5
  **42 tests**·clippy·wasm32 green. demo proxy 11건은 별도 재실행 green으로 full 합계 **1,018**.
  임시 dependency link 제거, route/rhwp/generated diff 0.
  **다음:** final quick→security/diff→commit/push/PR #161→필수 CI·자율 병합.

- 갱신: 2026-08-23 · Codex(sol) — **#161 quick 전체 green**.
  strict normal-column subset과 shared LOCKSTEP column lane을 quick 전수 검증했다. rhwp governance,
  fmt/clippy, workspace+rhwp tests, PDF visual 51/parity, canonical **8/18/24·98.9%+**, public corpus
  계약 84, oracle 82, HWPX lock, wasm32, licenses가 전부 green이다. private `modu-startup`/정부양식
  실물 gate만 로컬 corpus 부재로 기존 정책대로 skip됐다. production route, `external/rhwp`, generated
  wasm diff 0. **다음:** `verify-local --full`→final security/diff→commit/push/PR #161→CI/자율 병합.

- 갱신: 2026-08-23 · Codex(sol) — **#161 의미 경계 하드닝 · focused/wasm green**.
  HWP5 `cold`의 normal 1~32단과 LTR/RTL만 owned로 한정하고 distribute/parallel은 정상 단처럼
  흉내내지 않고 fail-closed한다. 최초 owned zone 전 단나누기와 구분선이 포함된 복수 zone도
  정확한 의미/세로 span을 소유할 때까지 정적·content-free 오류로 거부한다. hwp-hwp5 **41 tests**,
  hwp-typeset **90+4**, hwp-render **17+3**, touched-crate clippy `-D warnings`, hwp-hwp5/typeset wasm32,
  production route/rhwp/generated diff 0. 전체 workspace clippy는 기존 hwp-foreign·hwp-jsx-test의
  Rust 1.95 신규 lint 기준선에서만 실패. **다음:** quick→full→최종 diff/PR #161/CI/자율 병합.

- 갱신: 2026-08-23 · Codex(sol) — **#161 column IR/parser/LOCKSTEP 1차 focused green**.
  `Paragraph` 열 zone/단나누기 + 절대 HWPUNIT `ColumnLayout`(종류·LTR/RTL·폭·간격·구분선)을
  source-neutral IR로 추가했다. HWP5 `cold`는 1~32단, exact 16B equal/관측 proportional unequal,
  upper attr·direction·zero width·tail·separator style를 strict 검증한 뒤 page body의 절대 geometry로만
  옮긴다. 별도 column lane을 public `place_doc`/`NaiveLayout`/`block_pages`에 동시 연결해
  문단·표를 열/쪽 경계에서 분할하고 구분선은 공유 `PlacedLine`→SVG/PDF PaintOp로 내린다.
  focused hwp-hwp5 **38 tests**, hwp-typeset **83 tests**, public 경계 `0x42/0..28`→
  `CTRL_HEADER 0x47/431..451`, focused clippy `-D warnings` green. **다음:** unequal/3단·RTL·
  zone/page/column break·hostile fixture 확장→workspace/quick/full; production route/rhwp 불변.

- 갱신: 2026-08-23 · Codex(sol) — **PR #162 병합 · #161 다단 조판 착수**.
  #162는 head `24516e7`에서 issue-link·build-test 8m58s·licenses green, CLEAN/MERGEABLE,
  리뷰/일반/인라인 댓글 0을 확인한 뒤 main `a5c1125`로 squash 병합했고 #160이 close됐다.
  원격 브랜치를 정리하고 #94에 STYLE/ref 소유 및 multi-column fail-closed 경계를 동기화했다.
  정확한 latest main에서 `codex/issue-161-hwp5-columns`를 시작했다. **다음:** source-neutral
  column geometry→strict `cold` parser→`place_doc`/`NaiveLayout`/`block_pages` LOCKSTEP fixture.
  production HWP5 route와 `external/rhwp`는 불변이다.

- 갱신: 2026-08-23 · Codex(sol) — **#160 PR #162 게시**.
  검증 완료 commit `75f5ad5`를 push하고 PR #162(`Closes #160`, `Refs #94 #158 #161`)를 만들었다.
  strict STYLE, content-free failure reasons, public multi-column boundary, #161 faithful column dependency,
  no production cutover/no rhwp fallback과 quick/full/Chromium 85 pass·3 intentional skip·generated/rhwp
  diff 0을 본문에 명시했다. **다음:** 이 상태 commit push→issue-link/build-test/licenses·mergeability·
  review/comment를 추적하고 전부 green이면 자율 병합·원격 브랜치 정리→#161 구현을 시작한다.

- 갱신: 2026-08-23 · Codex(sol) — **#160 전체 검증 완료 · PR 준비**.
  strict STYLE/content-free header diagnostics와 #161 다단 blocker 분리를 최종 security/diff review했다.
  STYLE 이름은 strict UTF-16 확인 후 폐기하고, 참조는 linear 검증하며 unsupported reason은 정적 문자열과
  tag·section·span만 포함한다. focused hwp-hwp5 **36 tests**, clippy, wasm32와 quick 전체가 green이고,
  full은 Rust/PDF51/canonical **8/18/24·98.9%+**/corpus84/oracle82/HWPX/wasm/licenses, JS build,
  Vitest **1,018**, 실제 Chromium **85 pass/3 intentional skip/0 fail**을 통과했다. 임시 링크 제거 후
  production route, generated asset, `external/rhwp` diff 0. **다음:** commit/push/PR #160→필수 CI·댓글
  확인→green 자율 병합→#161 column IR/LOCKSTEP 구현.

- 갱신: 2026-08-23 · Codex(sol) — **#160 quick 전체 green**.
  strict STYLE/ref와 content-free break reason의 security/diff review에서 STYLE 문자열은 검증 후 폐기되고,
  next/active shape ref는 linear pass로 범위 확인하며 unknown attr/tail·standalone/compound multi-column·column·
  range tag는 거부한다. 첫 quick은 코드가 아닌 완료 worktree build cache 누적으로 117MiB만 남아 PDF parity
  compile에서 ENOSPC였고, 병합 완료 #156/#158의 Cargo 산출물만 `cargo clean`해 21GiB를 회수했다.
  재실행한 quick 전체는 workspace tests, PDF 51/parity, canonical **8/18/24·98.9%+**, corpus 84,
  oracle 82, HWPX locks, wasm32, licenses가 green이다. `external/rhwp`/generated/production route diff 0.
  **다음:** full→final diff→commit/PR/CI/병합; 이후 #161 column IR/LOCKSTEP.

- 갱신: 2026-08-23 · Codex(sol) — **#160 STYLE focused green · 다단 blocker #161 분리**.
  공개 benchmark의 `PARA_HEADER 0x42/section0/0..28` 원인은 content-free 분해 결과
  `multi-column break`다. 현재 `PageSetup.columns`를 두 paginator가 소비하지 않아 rhwp의 section-priority를
  모방하는 것은 거짓 지원이므로 거부를 유지하고, shared IR·`place_doc`/`NaiveLayout` LOCKSTEP 범위를
  #161로 issue-first 분리했다. #160은 strict UTF-16 STYLE, kind/next/active shape ref, 기본 record와
  실측 optional zero tail을 소유하고 paragraph style ref 및 break/range 사유를 정적으로 분류한다.
  hwp-hwp5 **36 tests** green, 공개 경계는 정확한 reason으로 잠겼다. **다음:** clippy/wasm→quick/security/full→
  commit/PR/CI/병합. production route와 `external/rhwp`는 불변이다.

- 갱신: 2026-08-23 · Codex(sol) — **PR #159 병합 · #160 STYLE/PARA_HEADER slice 착수**.
  #159는 head `1df8e2f`에서 issue-link·build-test 6m37s·licenses green, CLEAN/MERGEABLE,
  리뷰/일반/인라인 댓글 0을 확인한 뒤 main `40026f6`으로 squash 병합했고 #158이 close됐다.
  원격 브랜치를 정리하고 #94에 완료 근거를 동기화했다. 공개 benchmark의 다음 경계
  `PARA_HEADER tag 0x42 start 0 end 28`을 계약으로 child #160을 만들고 정확한 최신 main에서
  `codex/issue-160-hwp5-style`을 시작했다. **다음:** content-free 원인 분해→strict STYLE pool과
  owned style/break refs; columns/range tags는 fail-closed. production route와 `external/rhwp`는 불변이다.

- 갱신: 2026-08-23 · Codex(sol) — **#158 PR #159 게시**.
  검증 완료 commit `5b57498`을 push하고 PR #159(`Closes #158`, `Refs #94 #87 #95`)을 만들었다.
  exact support-pool parsing, active unsupported fail-closed, public boundary `0x19→0x42`, no production
  cutover/no rhwp fallback과 quick/full/Chromium 85 pass·3 intentional skip·generated/rhwp diff 0을
  본문에 명시했다. **다음:** 이 상태 commit push→issue-link/build-test/licenses·mergeability·review/comment를
  추적하고 전부 green이면 자율 병합·원격 브랜치 정리→`PARA_HEADER 0x42` child를 issue-first로 착수한다.

- 갱신: 2026-08-23 · Codex(sol) — **#158 전체 검증 완료 · PR 준비**.
  first-party support-pool slice의 최종 보안/diff review에서 HWP 5.1 numbering 확장은 실측 구조를
  정확히 소비하되 의미 소유 전 active use를 계속 fail-closed하는 경계를 명시했다. focused
  hwp-hwp5 **34 tests**, clippy, wasm32와 quick 전체가 green이고, full은 Rust/PDF51/canonical
  **8/18/24·98.9%+**/corpus84/oracle82/HWPX/wasm/licenses, JS build, Vitest **1,018**, 실제 Chromium
  **85 pass/3 intentional skip/0 fail**을 통과했다. 임시 의존성 링크 제거 후 production route,
  generated asset, `external/rhwp` diff 0. **다음:** commit/push/PR #158→필수 CI·댓글 확인→green
  자율 병합→공개 benchmark `PARA_HEADER 0x42` 경계를 다음 child issue로 분리한다.

- 갱신: 2026-08-23 · Codex(sol) — **#158 quick 전체 green**.
  support-pool parser의 모든 count×payload는 overflow/정확 길이를 먼저 검증하고, base numbering/bullet
  char-shape 및 para tab/numbering/border refs는 범위를 확인한다. known border style만 축약 매핑하며 unknown,
  pattern/image/gradient/alpha/mixed fill은 거부한다. hostile 경로의 `expect`는 앞선 exact-bound 검사 뒤뿐이고
  오류는 tag·section·offset 정적 문구만 담는다. quick 전체에서 workspace tests, PDF 51, canonical
  **8/18/24·98.9%+**, corpus 84, PDF parity, oracle 82, HWPX locks, wasm32, licenses가 green이다.
  `external/rhwp`/generated/production route diff 0. **다음:** `verify-local --full`→final diff→commit/PR/CI/병합.

- 갱신: 2026-08-23 · Codex(sol) — **#158 support pools focused green**.
  first-party lane이 BORDER_FILL의 4 edge·solid shade·diagonal을 shared `BorderFillDef`로 옮기고,
  TAB_DEF/NUMBERING(5.1 확장 8–10레벨 포함)/BULLET 가변 payload와 모든 pool ref를 strict 검증한다.
  pool 존재와 active use를 분리해 기본 tab/비활성 ref는 보존하되 custom tab·목록/글머리·가시 paragraph
  border/fill은 거짓 렌더 없이 content-free fail-closed한다. 공개 benchmark의 첫 경계는 기존
  DocInfo PARA_SHAPE(tag 0x19) pool-ref 실패에서 BodyText PARA_HEADER(tag 0x42)로 전진했다.
  합성 정상/적대 7건 추가, hwp-hwp5 **34 tests**, clippy `-D warnings`, wasm32 green.
  **다음:** quick 전체 게이트→security/diff review→full→commit/push/PR #158→필수 CI·자율 병합.
  production route와 `external/rhwp`는 불변이다.

- 갱신: 2026-08-23 · Codex(sol) — **PR #157 병합 · #158 support-pool slice 착수**.
  #157은 head `60cc790`에서 issue-link·build-test 8m02s·licenses green, CLEAN/MERGEABLE,
  리뷰/일반/인라인 댓글 0을 확인한 뒤 main `82ca4e6`로 squash 병합했고 #156이 close됐다.
  원격 브랜치를 정리하고 #94에 완료 근거를 동기화했다. 공개 benchmark의 다음 실패점이
  PARA_SHAPE support-pool 참조임을 재현해 child #158을 만들고 정확한 최신 main에서
  `codex/issue-158-hwp5-support-pools`를 시작했다. **다음:** BORDER_FILL/TAB_DEF/NUMBERING/BULLET를
  strict parse하되 inert presence와 active semantics를 나눠, 표현 불가능한 탭·목록·border는 계속
  fail-closed한다. production route와 `external/rhwp`는 바꾸지 않는다.

- 갱신: 2026-08-23 · Codex(sol) — **#156 PR #157 게시**.
  검증 완료 commit `01b637c`를 push하고 PR #157(`Closes #156`, `Refs #94 #87`)을 만들었다.
  strict PAGE_DEF/source metrics, unsupported fail-closed, no production cutover/no rhwp fallback과
  quick/full/Chromium 85 pass·3 intentional skip·generated/rhwp diff 0을 본문에 명시했다.
  **다음:** 이 상태 문서 commit push→issue-link/build-test/licenses·mergeability·review/comment를 추적하고
  전부 green이면 자율 병합·원격 브랜치 정리→#94 다음 first-party child를 issue-first로 착수한다.

- 갱신: 2026-08-23 · Codex(sol) — **#156 전체 검증 완료 · PR 준비**.
  strict secd/PAGE_DEF와 blank-only PARA_LINE_SEG 구현을 최종 보안/diff review했고 오류 진단은
  content-free tag·section·span만 유지한다. focused hwp-hwp5 **27 tests**, clippy, wasm32와 quick 전체
  게이트가 green이며 canonical 8/18/24·98.9%+, PDF 51, corpus 84, oracle 82, HWPX locks, licenses를
  보존했다. full의 Rust/PDF/wasm/JS/Vitest 1,018도 green; 샌드박스 포트 EPERM만 분리해 전용
  `PW_PORT=31856` 실제 Chromium을 재실행한 결과 **85 pass/3 intentional skip/0 fail**. generated asset와
  `external/rhwp` diff 0, production route 무변경. **다음:** commit/push/PR #156→필수 CI·댓글 확인→green
  자율 병합→#94 완료 근거와 다음 first-party child를 issue-first로 착수한다.

- 갱신: 2026-08-23 · Codex(sol) — **#156 PAGE_DEF/source metrics focused green**.
  first-party lane이 첫 문단 `0x0002/secd` marker↔CTRL_HEADER↔단일 PAGE_DEF 계층을 대조하고,
  40B page size·6 margins·gutter·landscape·positive body box를 `Section.page`로 만든다. duplex/top-flip,
  column/deco/border/note/unknown child는 거짓 지원 없이 거부한다. 36B PARA_LINE_SEG는 declared count,
  scalar/control boundary, ordered start, nonnegative geometry를 검증하고 true blank에만 source metric을
  주며 zero-height/visible text/control-host에는 권위를 주지 않는다. 합성 정상/적대 11건 포함
  hwp-hwp5 **27 tests**, clippy `-D warnings`, wasm32 green. **다음:** security/diff review→quick 전체 게이트→
  full 검증→commit/push/PR #156→필수 CI·자율 병합. production route/rhwp는 불변이다.

- 갱신: 2026-08-23 · Codex(sol) — **PR #155 병합 · #156 HWP5 source-layout slice 착수**.
  #155는 head `d4eb9df`에서 issue-link·build-test 9m52s·licenses green, CLEAN/MERGEABLE,
  리뷰/일반/인라인 댓글 0을 확인한 뒤 main `c16e231`로 squash 병합했고 #154가 close됐다.
  #94에 완료 근거를 동기화하고 child #156을 만든 뒤 정확한 최신 main에서
  `codex/issue-156-hwp5-layout`을 시작했다. **다음:** section-definition/PAGE_DEF와
  non-authoritative PARA_LINE_SEG source metrics를 strict hierarchy/count/span 검증으로 구현한다.
  production HWP5 route와 `external/rhwp`는 바꾸지 않는다.

- 갱신: 2026-08-23 · Codex(sol) — **#154 PR #155 게시**.
  검증 완료 commit `a6acbca`를 push하고 PR #155(`Closes #154`, `Refs #94 #87`)를 만들었다.
  PR 본문에 text-only candidate/no production cutover, unsupported fail-closed, no rhwp fallback,
  full Rust/조판/PDF/WASM/licenses·Vitest 1,018·Chromium 85 pass/3 skip·generated/submodule diff 0을
  명시했다. **다음:** 이 상태 commit push → issue-link/build-test/licenses, mergeability, review/comment를
  추적해 green이면 자율 병합·원격 브랜치 정리 → #94 다음 first-party slice를 issue-first로 착수한다.

- 갱신: 2026-08-23 · Codex(sol) — **#154 구현·전체 검증 완료 · PR 준비**.
  final security review에서 run 경계 처리를 O(runs×chars)에서 binary-search+linear slice로 바꿔
  적대적 대형 입력의 CPU 증폭을 막고, unsupported body 오류를 정확한 tag·section·raw byte span으로
  고정했다. 최종 focused 16 tests+clippy+wasm32와 quick 전체가 재통과했다. 앞선 full은 Rust workspace,
  PDF51, canonical 8/18/24+98.9%, corpus84, oracle82, HWPX locks, optimized wasm 7,793,352B,
  JS build/crosscheck/i18n, Vitest 269+64+427+247+11=1,018을 통과했다. E2E 첫 시도는 기본 3100에
  다른 factsheet 앱이 떠 있어 잘못 재사용된 환경 실패였고, 전용 `PW_PORT=31854` 재실행은 실제
  Chromium **85 pass/3 intentional skip**다. 임시 node_modules symlink 전부 제거, generated wasm/
  public assets/rhwp submodule diff 0. **다음:** final diff→commit/push→PR `Closes #154`/`Refs #94 #87`
  → 필수 CI·review/comment 확인→green 자율 병합→#94 다음 first-party slice issue.

- 갱신: 2026-08-23 · Codex(sol) — **#154 HWP5 text-only SemanticDoc slice · quick green**.
  first-party `hwp-hwp5`가 26B DOCUMENT_PROPERTIES·15+optional MemoShape ID_MAPPINGS와
  FACE_NAME/CHAR_SHAPE/PARA_SHAPE를 strict count/reference로 읽고, 22B PARA_HEADER의 declared
  run/control counts와 UTF-16LE(서로게이트·탭·줄바꿈·HWP blank)를 검증해 direct text paragraph/run을
  우리 `SemanticDoc`으로 만든다. table/image/field/note/equation/chart/unknown body record는 tag·section·
  offset만으로 fail-closed하고 rhwp fallback은 없다. production `Engine::open`은 rhwp bootstrap 그대로다.
  정상/적대 합성 8건+공개 benchmark no-fallback, workspace/clippy/PDF51/canonical 8·18·24+98.9%/
  corpus84/oracle82/HWPX locks/wasm/licenses quick가 green이다. **다음:** 문서·diff 최종 review →
  `verify-local --full`(JS/Chromium 포함) → commit/push/PR #154/CI/자율 병합 → #94 다음 slice issue.

- 갱신: 2026-08-23 · Codex(sol) — **PR #153 병합 · #154 semantic slice 착수**.
  #107 PR #153은 head `8e8315b`에서 issue-link·build-test 8m12s·licenses green,
  CLEAN/MERGEABLE·리뷰/일반/인라인 댓글 0을 확인한 뒤 main `aab77c0`으로 squash 병합했고 원격
  브랜치를 삭제했다. #107은 close됐고 #94에 완료 증거/다음 범위를 기록했다. 중복 검색 후 child
  #154(DocInfo pools + fail-closed text-only SemanticDoc)를 만들고 정확한 최신 main에서
  `codex/issue-154-hwp5-text`를 시작했다. **다음:** `hwp-hwp5` record spans 위에 strict
  DOCUMENT_PROPERTIES/ID_MAPPINGS/FACE_NAME/CHAR_SHAPE/PARA_SHAPE와 text-only paragraph/run을
  설계한다. control/object가 하나라도 있으면 partial success 없이 거부하고 production route는 불변이다.

- 갱신: 2026-08-23 · Codex(sol) — **#107 PR #153 게시**.
  검증 완료 commit `513e8e2`를 push하고 PR #153(`Closes #107`, `Refs #94 #87`)을 만들었다.
  production route 불변, own-only fail-closed, content-free differential, hostile bounds, public benchmark
  gap(1/1 sections·353/352 paragraphs·389/382 runs·32/32 tables·38/32 controls)을 본문에 명시했다.
  **다음:** 상태 commit push→issue-link/build-test/licenses·mergeability·review/comment 감시→green 자율
  병합·원격 브랜치 정리→#94 첫 child issue로 DocInfo pool/paragraph text slice를 분리 착수한다.

- 갱신: 2026-08-23 · Codex(sol) — **#107 전체 검증 green·게시 준비**.
  rhwp boundary 6, fmt/clippy/workspace, 신규 8 + patch 11 + core differential 2, PDF visual 51,
  canonical 8/18/24·line 98.9%+, public corpus contract 84, oracle 82, HWPX locks, wasm32+optimized
  7,793,352B, licenses가 green이다. 새 worktree의 node_modules 부재로 full script가 JS 진입에서
  한 번 환경 실패했으나 동일 lockfile의 기존 설치본을 symlink 재사용해 JS build/crosscheck/i18n,
  Vitest 269+64+427+247+11=1,018과 실제 Chromium Playwright 85 pass/3 intentional skip를 완료했다.
  generated wasm/JS·external/rhwp diff는 없다. 최종 diff/security review에서 production `unsafe`·
  credential/path/text/hash 유출·silent fallback을 발견하지 않았고, missing DocInfo/Section0와 section
  gap도 fail-closed로 보강 후 focused test/clippy/wasm을 재통과했다. **다음:** commit·push→PR `Closes #107`/
  `Refs #94 #87`→필수 CI·리뷰/댓글 확인→자율 병합→#94 첫 child issue/branch.

- 갱신: 2026-08-23 · Codex(sol) — **#107 first-party HWP5 skeleton·differential 구현**.
  신규 wasm-clean `hwp-hwp5`가 CFB/FileHeader 11개 flag, 64MiB raw·256MiB cumulative inflate·
  4096 entry·1M record 상한, normal/extended bounded record walk와 unknown tag의 stream-relative
  raw-span provenance를 소유한다. `hwp-hwp5-patch`도 이 워커를 재사용해 중복 parser truth를 없앴다.
  `open_hwp5_own`은 DocInfo/text slice 전까지 명시적으로 fail-closed하고 rhwp fallback이 없으며,
  `hwp5_differential`은 native↔rhwp 구조 8축과 본문/경로/원본 hash 없는 SemanticDoc topology
  fingerprint를 낸다. production `Engine::open` 기본은 불변이다. focused 8+11+2 tests와 wasm32
  check green. 디스크 부족으로 완료/현재 worktree의 재생성 가능 `target/` 35GiB를 정리했다.
  **다음:** 문서 계약→clippy/workspace/전체 조판 게이트→commit·push·PR #107→CI·병합, 이어 #94
  DocInfo pool+PARA_TEXT 최소 SemanticDoc slice를 별도 issue-first 단위로 착수한다.

- 갱신: 2026-08-23 · Codex(sol) — **PR #152 병합 · #107 자체 HWP5 skeleton 착수**.
  #151 PR #152는 head `d65c844`에서 issue-link·build-test·licenses green, CLEAN/MERGEABLE,
  리뷰/댓글 0을 확인한 뒤 main `1b272844`로 squash 병합했고 원격 브랜치를 삭제했다. #87에는
  F0 완료 증거를 남기되 F1+ epic이라 open 유지했고, #94/#107을 blocked→ready로 전환했다.
  최신 main에서 `codex/issue-107-hwp5-skeleton`을 만들었다. **다음:** `hwp-hwp5-patch`의 CFB·
  FileHeader·record walker를 읽고 재사용 가능한 first-party `hwp-hwp5` 경계를 설계한다. 첫 PR은
  production default/fallback을 바꾸지 않고 FileHeader security flags·bounded record walk·unknown
  raw-span provenance·content-free dual-parser report를 구현한다. `external/rhwp`는 변경하지 않는다.

- 갱신: 2026-08-23 · Codex(sol) — **#151 전체 검증·공개 truth surface 정합 완료**.
  `verify-local.sh --full`의 Rust workspace/clippy·HWP5 feature·canonical 8/18/24와 98.9%+·
  PDF visual 51·public corpus 84·oracle 82·HWPX locks·WASM 7,793,352B·licenses·JS builds와
  Vitest 269+64+427+247+11이 green이다. 샌드박스 port EPERM만 분리해 실제 Chromium
  Playwright 전수 85 pass/3 intentional skip를 완료했고 `/bench` truth 문구 수정 뒤 Next production
  build 20 routes도 green이다. CONTRIBUTING·bench·viewer·benchmark/caret/strategy 문서까지 현재
  예외 목록으로 동기화했고, 재벤더링 blocker는 해소로 교정했다. submodule gitlink/content diff 0,
  생성물 diff 0이다. **다음:** 최종 staged diff 검수→commit·push→PR `Closes #151`/`Refs #87`→
  필수 CI·리뷰·자율 병합→#87 F0 close/요약→#107 자체 HWP5 skeleton 착수.

- 갱신: 2026-08-23 · Codex(sol) — **#151 rhwp fork boundary 구현·focused 검증 green**.
  machine-readable policy와 governance를 v0.7.19/f137b4c에 고정하고, fork/upstream·월간 sync·
  security SLA·immutable patch tag·bump/rollback 절차를 명문화했다. 현재 사실은 “완전 종속 아님”:
  HWPX parse/write와 live layout/render/PDF/edit는 자체 엔진이고, HWP5/HWP3 decode·read-only
  original/lineseg oracle·수식/차트 derived SVG enrichment만 rhwp에 남는다. dormant
  `Engine::assemble()`과 실제로 NotImplemented였던 rhwp LayoutEngine/Renderer trait impl을 제거했다.
  network-free verifier는 policy/gitlink/submodule HEAD/Cargo.lock/vendor/core/HWPX 독립/docs를
  fail-closed로 잠그고 URL·version·tag·commit·code/docs 변조 6 tests를 통과했다. hwp-core 29건,
  hwp-rhwp 34건 green, `external/rhwp` gitlink/content diff 0. **다음:** `verify-local.sh --full` →
  diff/security review → commit·push·PR `Closes #151`/`Refs #87` → CI·자율 병합, 이어 #107.

- 갱신: 2026-08-23 · Codex(sol) — **PR #150 병합 · #151 rhwp fork governance 착수**.
  #149 PR #150은 보정 head `52210c1`에서 issue-link·build-test·licenses green,
  CLEAN/MERGEABLE·리뷰/댓글 0을 확인한 뒤 main `82e0269`로 squash 병합했고 원격 브랜치를
  정리했다. #149는 close됐고 exact-main/checksum/read-only preflight가 main 정본이다. #144에는
  실제 Apple/Windows 서명 자격증명·updater 키 수명주기·clean-machine QA가 없이는 완료를 주장하지
  않는 blocker를 공개 기록하고 `status:blocked`로 전환했다. #87 F0 하위 #151을 만들고 최신 main
  기반 `codex/issue-151-rhwp-governance`를 시작했다. pinned submodule은 fork URL
  `kwakseongjae/rhwp`, tag v0.7.19, commit `f137b4c`로 확인했다. **다음:** Cargo/vendor 문구와
  production call graph·dormant `Engine::assemble()`을 감사하고, network-free fork boundary verifier,
  governance 문서, CI/verify-local 게이트를 구현한다. `external/rhwp` content/gitlink는 변경하지 않는다.

- 갱신: 2026-08-23 · Codex(sol) — **#149 exact-main 데스크톱 릴리스 신뢰 기반 구현**.
  #144 감사에서 현재 desktop release/updater workflow가 없고 macOS config는 로컬 ad-hoc
  `signingIdentity: "-"`뿐임을 확인했다. 실제 인증서 없이 #144를 닫지 않도록 하위 #149를 만들고,
  strict release manifest/CLI·읽기 전용 수동 preflight·CI/verify-local 계약·공식 근거 문서를
  구현했다. source SHA는 별도 current main SHA와 같아야 하고 preview/stable SemVer·macOS
  universal/Windows x64 완전 matrix·안전 basename/non-symlink·byte length/SHA-256·unknown field
  거부를 강제한다. Linux/Windows arm64는 native clean-machine QA 전까지 지원을 주장하지 않는다.
  Actions checkout은 공식 v6.0.2 commit `d23441a`로 고정했고 signing/publish/upload/secret 권한은
  없다. 공격적/변조 입력 포함 Node 8건과 정본 quick 전체가 green이다(canonical 8/18/24·98.9%+,
  PDF 51, corpus 계약 84, oracle 82, HWPX 잠금, Rust/WASM/licenses). **다음:**
  commit `c25102d`·PR #150(`Closes #149`, `Refs #144`)까지 게시했다. 첫 CI는 issue-link/licenses와
  신규 release 8건 모두 green이었으나 기존 desktop-shell 정적 테스트가 CI 명령의 한 줄 문자열만
  허용해, 두 테스트 파일을 multiline로 묶은 동등한 명령을 거부했다(제품/계약 실패 아님).
  **다음:** 기존 정적 단언을 whitespace-safe로 고쳐 두 파일 결합 실행을 로컬 재현 → 보정 commit/push
  → 필수 CI·리뷰·병합. #144는 Developer ID/notary,
  Authenticode, mandatory updater key/signature, SBOM/provenance, rollback/clean-machine QA까지 open 유지.

- 갱신: 2026-08-23 · Codex(sol) — **PR #148 병합 · #144 Desktop GA release trust 착수**.
  #143 PR #148은 head `824f112`에서 issue-link·build-test·licenses green,
  CLEAN/MERGEABLE·리뷰/댓글 0을 재확인한 뒤 main `eed9786`으로 squash 병합했고 원격 브랜치를
  정리했다. #143은 close됐고 own-PDF native print 계약이 main 정본이다. #140~#143 선행이 모두
  병합되어 #144를 `status:blocked`에서 `status:ready`로 전환했고, 정확한 최신 main에서
  `codex/issue-144-release`를 만들었다. **다음:** release workflow/config/권한과 기존 패키징
  상태를 먼저 감사하고, 비밀키를 요구하지 않는 검증 가능한 층(정확한 main SHA·target matrix·
  checksums/SBOM/provenance·updater manifest fail-closed·preview/stable/rollback 정책)을 구현한다.
  실제 Developer ID/Authenticode 자격증명·notarization은 protected release environment 경계로만
  연결하고, 자격증명 없는 로컬/PR에서는 서명 성공을 꾸며내지 않는다.

- 갱신: 2026-08-23 · Codex(sol) — **#143 네이티브 own-PDF 인쇄 구현·실앱 QA 완료**.
  `print_doc_pdf`는 live doc을 기존 `place_doc → PaintOp → krilla`의 `emit_pdf`로만 만들고,
  page별 text/table/image/equation/chart replay가 전량 non-stub·diagnostic-free일 때만 macOS
  PDFKit/AppKit 인메모리 spool을 main thread에서 연다. temp/path/webview `window.print()`는 없고,
  UI 버튼·⌘P·취소/실패/기능 진단 메시지를 연결했다. synthetic production PDF는 2개 section의
  portrait/landscape media와 5개 object lane을 모두 통과한다. 첫 ad-hoc `.app` QA가 nil
  `NSPrintInfo`의 AppKit SIGSEGV를 발견해 `sharedPrintInfo`로 수정했고, 두 번째 QA가
  ScaleDownToFit의 A4 약 10% 축소를 발견해 `kPDFPrintPageScaleNone`으로 고정했다. 최종 공개
  benchmark.hwp는 8쪽 렌더→native Print 8-page preview→취소 복귀→Print ▸ Save as PDF 8쪽 A4를
  통과했다. own export↔print PDF report-only 144 DPI 비교는 구조 불일치 0, 이동 0px, clipped ink 0,
  bbox delta 0~1px, edge F1 0.999891~1.0, ink F1 0.884169~0.989237다. full verify 본체는 canonical
  8/18/24·98.9%+, PDF 51/51, oracle 82, Rust/wasm/licenses green; JS build와 Vitest
  269+64+427+247, Playwright 85 pass/3 intentional skip도 별도 완료했다. **다음:** 임시 QA
  의존성/앱을 정리하고 commit·push→PR(`Closes #143`)→필수 CI·자율 병합, 이어 #144 release
  packaging/update 트랙을 착수한다.

- 갱신: 2026-08-23 · Codex(sol) — **PR #147 병합 · #143 네이티브 own-PDF 인쇄 착수**.
  #142 PR #147은 head `8f5a01e`에서 issue-link·build-test·licenses green,
  CLEAN/MERGEABLE·리뷰/댓글 0을 재확인한 뒤 main `246733a`로 squash 병합했고 원격 브랜치를
  정리했다. #142는 close됐고 최근 문서·창 상태 계약이 main 정본이다. 최신 main에서
  `codex/issue-143-native-print`를 만들었다. #143은 #101/#102와 데스크톱 open 선행이 모두
  병합되어 unblocked다. **다음:** 기존 own-PDF bytes/replay diagnostics를 유일 인쇄 입력으로
  재사용하고, webview `window.print()` 없이 macOS 네이티브 print panel·private bounded temp·
  취소/실패/cleanup 계약을 구현한다. synthetic table/equation/chart와 public calibration으로
  dialog 직전 object ink를 증명하고 패키지 print-to-PDF QA 뒤 PR/CI/병합한다.

- 갱신: 2026-08-23 · Codex(sol) — **#137/#145/#146/#138 병합 · #142 구현·패키지 QA 완료**.
  PR #137(PDF calibration)은 main `6574a6d`, #145(데스크톱 OS open)은 `3fd9740`,
  #146(#141 무손실 복구)은 `e963f5c`, #138(equation/chart SVG→PDF vector replay)은 최신 main
  `fa7d803`으로 각각 squash 병합했고 작업 브랜치를 정리했다. #138은 main 기반 독립 12파일로
  재배치한 뒤 issue-link·build-test·licenses green, CLEAN/MERGEABLE을 다시 확인했다.
  `codex/issue-142-desktop-home`은 최신 main 위에서 최근 문서 최대 9건(최신순·중복 제거·재열기·
  개별/전체 삭제·누락/이름변경/권한상실 자동 prune)과 SIZE/POSITION/MAXIMIZED 창 상태 복원을
  구현했다. app-data에는 경로+마지막 연 시각만 저장하고 bytes/text/hash/thumbnail/AI context는
  금지하며 0700/0600·64KiB 상한·atomic write·symlink 거부·손상/스키마 reset을 강제한다.
  full verify는 canonical 8/18/24·98.9%+, PDF 51/51, oracle 82, Rust/wasm/JS/Vitest를 통과했고,
  샌드박스 포트 차단 뒤 별도 Playwright 전수는 85 pass/3 intentional skip였다. ad-hoc 서명
  `.app` QA에서 첫 빌드의 숨은 창 결함을 발견해 plugin 복원 뒤 명시적 `window.show()`로 수정했고,
  공개 benchmark.hwp 8쪽 렌더, 재시작 최근 목록/재열기, 누락 파일의 경로 비노출 경고+자동 제거,
  개별/전체 삭제, 저장 JSON 최소 필드·0600, 최대화 재시작 복원을 확인했다. 테스트 목록은 비웠고
  창은 일반 크기로 되돌렸다. **다음:** docs 포함 commit·push → PR(`Closes #142`) → 필수 CI·병합;
  이어 #143 네이티브 인쇄/메뉴/단축키, #144 release packaging/update 트랙으로 진행한다.

- 갱신: 2026-08-23 · Codex(sol) — **#141 데스크톱 무손실 복구 구현·실앱 QA 완료, 게시 준비**.
  `codex/issue-141-desktop-recovery`를 #145 head `c190e8e` 위에 쌓아 Rust authoritative
  revision/dirty 상태, 원본 identity(경로는 메모리 전용)와 외부 변경 덮어쓰기 차단, app-data
  HWPX 복구본(문서당 2세대·총 256MiB·디렉터리 0700/파일 0600·경로/파일명 무저장), 손상/스키마
  격리 경고, dirty 교체/닫기의 저장·버리기·취소, 재시작 복구/삭제, 복구본의 새 미저장 문서 열기를
  구현했다. 시작 시 복구 스캔보다 OS open 큐가 먼저 빠지는 경쟁과 저장/autosave 경합도 차단했다.
  headless 회귀는 hwp-viewer 29건(복구 root symlink 거부·다문서 격리 충돌·discard/autosave
  경합 포함), React 427건, JS 전체 1,007건, PDF visual 51/51,
  canonical 8/18/24·98.9%+, Playwright 85 pass/3 intentional skip, licenses green이다. 실제 ad-hoc
  서명 `.app`에서 공개 benchmark.hwp 8쪽 열기→편집→dirty bullet→닫기 차단/취소→0600 snapshot→
  강제종료→복구 제안→최신 rev 복원→새 HWPX 저장→clean 종료를 확인했다. 앱 번들은 성공했고
  최종 코드도 `--bundles app` 패키징·ad-hoc 서명이 PASS했다(DMG 기본 실행만 로컬 샌드박스의
  bundle_dmg 단계에서 실패). full verify의 기본 3100은 실행 중인 타 FACTSHEET 앱을 재사용해
  file-input timeout이 났고, 기존 앱을 건드리지 않은 `PW_PORT=3141` 전수 재실행은 85/85 PASS했다.
  테스트 복구본/출력은 정리했다.
  사용자 승인 후 PR #137은 main `6574a6d`로 squash 병합했고 #138은 main 위에 #102 커밋만
  재배치해 원래 head와 byte-identical tree로 새 CI를 실행 중이다. #145도 최신 main 위로 기능
  트리를 그대로 보존해 재배치하고 새 CI를 실행 중이다. **다음:** 이 변경을 단일 커밋으로 만든 뒤
  #145 green/병합 → 최신 main 위 rebase → push/PR(`Closes #141`) → 필수 CI, 이어 #142 착수.

- 갱신: 2026-08-23 · Codex(sol) — **#102 PR #138 개설 · 3단 stacked merge 승인 대기**.
  `eb94323`을 push하고 PR #138(`Closes #102`, base=`codex/issue-101-pdf-calibration`)을
  개설했으며 MERGEABLE이다. 공개 이슈 #102에도 bounded parser/vector replay, fail-closed stub,
  계수 불변식, public HWPX·rhwp fragment 회귀와 시각 수치를 기록했다. 현재 #136은 main 기준
  MERGEABLE이고 필수 CI `issue-link`·`build-test`·`licenses` green, #137과 #138은 각각 부모
  브랜치 기준 MERGEABLE이라 checks가 없는 정상 stacked 상태다. **다음:** 사용자 승인 후 #136
  병합 → #137 main retarget·필수 CI·승인 병합 → #138 main retarget·필수 CI·승인 병합.

- 갱신: 2026-08-23 · Codex(sol) — **#102 equation/chart SVG→PDF vector replay 구현·검증 완료**.
  #101 head `92f7a63` 위 `codex/issue-102-pdf-svg-replay`에서 PDF sink가 버리던
  `PaintOp::Image.svg`를 외부 fetch 없는 제한 SVG parser로 해석해 krilla vector로 재생한다.
  허용 subset은 group/basic shape/path/text이며 script·event·foreignObject·external URL·namespace와
  크기/깊이/명령 한도를 위반하면 빈칸 대신 visible stub+stable diagnostic으로 fail-closed한다.
  페이지별 text/table/image/equation/chart produced=replayed+stubbed 불변식을 export가 강제하며,
  synthetic 수식·차트, public `SimpleEquation.hwpx`, 실제 vendored rhwp chart fragment 회귀를 잠갔다.
  own SVG↔PDF 144 DPI 실측은 equation ink 535/505(1.059), chart 18753/19014(0.986),
  ink F1 0.9759·edge F1 0.9870; placeholder border가 아닌 내부 ink를 CI에서 강제한다.
  `verify-local --full`은 Rust/wasm/JS·Vitest 269+64+425+247와 별도 Playwright 85 pass/3 skip,
  최종 quick도 canonical 8/18/24·98.9%+, PDF 51, oracle 82, licenses까지 PASS했다.
  **다음:** commit·push → #102 stacked PR(base=#101 branch, `Closes #102`) → #136 사용자 승인
  병합 → #137 main retarget/CI/승인 → #102 main retarget/CI/승인 순서를 지킨다.

- 갱신: 2026-08-23 · Codex(sol) — **PR #136 병합 · 데스크톱 #139 로드맵/#140 구현·실앱 QA**.
  사용자 승인에 따라 #136을 squash 병합(main `0c354cb`, #100 close)했고 #137은 main 위
  `ad55605`로 재배치해 필수 checks 3종 green·MERGEABLE, #138은 그 위 `e18a396`로 정리했다.
  데스크톱 레퍼런스(HOP/Tauri/한컴과 공개 이슈)를 바탕으로 #139 우산과 #140~#144를 만들었고,
  #140 브랜치에서 기존 엔진을 복제하지 않는 OS 경계를 구현했다: 단일 인스턴스 우선 등록,
  local regular HWP/HWPX만 받는 8건 제한 큐, cold/warm/macOS Opened 수렴, focus/unminimize,
  Rust→webview 무경로 이벤트, 앱 내부 교체 확인. 공개 패키지 QA에서 HWP 8쪽 콜드 열기·확대,
  HWPX 22쪽 웜 요청의 취소/승인, 단일 프로세스를 확인했다. QA가 발견한 기존 HWP open의
  원본 옆 자동 HWPX 생성도 제거해 재검증에서 파일 생성 0이다. hwp-viewer 15건·desktop shell
  계약 5건(1 sandbox skip)·패키징과 `verify-local --full`이 PASS했다: canonical 8/18/24,
  PDF 51/51, Vitest 269+64+425+247+11, Playwright 85 pass/3 intentional skip, licenses green.
  커밋 `ef5c4c8`을 push하고 PR **#145**(`Closes #140`)를 열었다. 첫 CI가 Linux에서 macOS
  전용 `paths_from_urls` dead-code를 잡아 macOS 또는 test에서만 컴파일하도록 cfg 경계를
  좁혔고, 최종 head `4b4188b`에서 issue-link·build-test·licenses가 모두 green·MERGEABLE이다.
  **다음:** #145 리뷰/사용자 병합 승인에서 정지; #137도 별도 사용자 승인 대기이며, 승인 뒤
  #138을 main으로 retarget한다.

- 갱신: 2026-08-23 · Codex(sol) — **#101 T1 PDF calibration 구현·재현 완료 · stacked PR 준비**.
  #100 PR #136(`d803ab1`)은 MERGEABLE이고 필수 CI 3종 green이나 비사소 PR이라 사용자 병합
  승인 대기다. 그 헤드 위 `codex/issue-101-pdf-calibration`에서 국가법령정보센터 공식 HWP5/PDF
  20쌍을 T1 provenance·권리·SHA·Hancom PDF producer·OS disclosure·`pdffonts` 지문과 함께
  metadata-only manifest로 고정했다. 자체 `export-pdf`→구조→144 DPI 비교 full run은 20/20
  재현됐고 committed baseline과 byte-identical: scored 18건/19쪽, page-count structural mismatch
  2건(`17184503`, `17184525`)은 pixel score 0건. HTML/PNG/바이너리는 private/ignored다.
  새 validator/runner/4 tests, 기존 PDF 51 tests, `verify-local` quick가 PASS했고 canonical
  8/18/24·98.9%+, 오라클 82건 무변경. **다음:** commit·push → #101 stacked PR(Closes #101,
  base=#100 branch) → #136 사용자 승인 병합 → #101 base를 main으로 전환·CI → 사용자 병합 승인
  → #102 PaintOp/SVG↔PDF parity.

- 갱신: 2026-08-23 · Codex(sol) — **#100 구현·실수집 완료 · 커밋/PR 전 최종 diff 검수**.
  `codex/issue-100-public-corpus`에서 공식 HWP5 20건·HWPX 20건·같은 서식의 PDF pair
  10쌍(총 50)을 권리·privacy·접근성 재검토 후 `corpus/private/`에 수집했고, 재실행 50/50
  SHA·크기·컨테이너 일치 및 production `tag-layout` 40/40 open을 확인했다. 공개 diff에는
  바이너리·본문·로컬 경로·격리 메타데이터가 없고 `public-corpus-manifest.json`의 provenance,
  license scope, retrieval time, SHA, magic, size, feature tag, pair id만 남는다. 수집기는 HTTPS,
  redirect host, 매 hop public DNS pin, 30초·32MiB, HWP5 CFB/HWPX ZIP/PDF 구조, exclusive
  no-overwrite를 강제한다. 공개 계약 72건과 `verify-local` quick가 PASS했고 canonical
  8/18/24쪽·98.9%+, PDF visual 51/51도 유지됐다. **다음:** 전체 diff/보안 검수 → commit·push →
  PR(`Closes #100`) 필수 CI → 사용자 병합 승인. 이후 #101 calibration → #102 parity.

- 갱신: 2026-08-23 · Codex(sol) — **P0 보안 수정·공개 완료 · #100 unblocked**.
  GHSA-5jw4-mcv6-c6gv를 공개했고 production 수정은 main `2ec233f`, Linux inode 재사용까지
  잠근 테스트 보강 뒤 최신 main은 `6af878c`다. public-main CI `32579085452`에서 Rust/native,
  wasm, 공공 코퍼스 안전 계약, canonical 조판, PDF visual, desktop adapter, licenses가 모두
  PASS했다. Advisory 병합 중 필요한 최소 관리자 예외는 즉시 원복했고 main은 필수 checks
  `build-test`·`licenses`·`issue-link`, enforce-admins, force-push/deletion 금지를 그대로 유지한다.
  temporary private fork는 공개 절차에 따라 정리됐고 private artifact는 public history에 없다.
  #100을 `status:ready`로 전환했다. **다음:** #100(20 HWP5·20 HWPX·공식 PDF pair 10+) →
  #101(20쌍+ report-only visual calibration) → #102(equation/chart PaintOp PDF parity).

- 갱신: 2026-08-22 · Codex(sol) — **#118/#130 완료 · PR #131 병합, 비공개 Advisory가 다음**.
  PR #131을 squash 병합(main `18d00d1`)했고 #118·#130은 close됐다. 루트가 추적하는
  first-party lockfile 4개와 demo proxy의 필수 exact override만 nanoid 3.3.18로 맞췄으며,
  unrelated graph·`undici` override·vendored `external/rhwp`는 바꾸지 않았다. 각 패키지의
  fresh npm ci/audit(취약점 0), 독립 리뷰(P0~P2 없음), `verify-local --full`이 PASS했다:
  canonical 8/18/24쪽·줄정확 98.9%+, PDF visual oracle 51/51, 오라클 82문서,
  Vitest 269+64+425+247+11, Playwright 85 pass/3 intentional skip. 필수 checks
  `issue-link`·`build-test`·`licenses`도 최종 head `4e93601`에서 green이었고 병합 브랜치와
  worktree를 정리했다. **다음:** 공개 트랙과 완전히 분리해 비공개 Security Advisory의
  수정·회귀 테스트·비공개 검수를 완료한다. 세부·영향 경로·재현법은 공개 이슈/PR/CI에
  남기지 않는다. 그 뒤 #100 → #101 → #102 순서를 유지한다.

- 갱신: 2026-08-22 · Codex(sol) — **#116 완료 · PR #125 병합, #118 착수**.
  사용자 승인에 따라 PR #125를 squash 병합(main `241e70c`)했고 #116은 close됐다.
  hwp-lab의 nanoid 3.3.17→3.3.18만 반영했으며 필수 checks와 독립 검수는 green이다.
  병합 브랜치와 깨끗한 worktree 정리도 완료했다. 다음은 #118: `packages/ai-protocol` ·
  `packages/editor-core` · `packages/react` · `services/demo-ai-proxy`의 독립 lockfile만
  nanoid 3.3.18 이상으로 갱신하고, 관련 없는 그래프 변경 없이 각 npm ci/audit와 관련
  test/build, 저장소 전수 검사를 통과시킨다. 이후 비공개 Advisory를 공개 트랙과 분리해 완료한 뒤
  #100(권리·PII 안전 승격) → #101(20쌍+ calibration) → #102(PaintOp/SVG↔PDF parity) 순이다.

- 갱신: 2026-08-22 · Codex(sol) — **#116 dependency remediation · PR #125 green, 병합 승인 대기**.
  `codex/issue-116-nanoid-security`를 최신 main `24c2f1a` 위로 fast-forward하고 기존 2파일
  WIP를 보존·재적용했다. PR #125(`7cd4083`)는 hwp-lab의 exact override와 같은 app lock
  entry만 nanoid 3.3.17→3.3.18로 바꾼다(2 files, 4+/4-). 독립 lockfile 4개는 #118 소유로
  건드리지 않았다. fresh `npm ci --ignore-scripts`·`npm audit --audit-level=low`는 취약점 0,
  앱 247/247·typecheck·server build·static demo build(`/models` 복원)·`verify-local` quick가
  모두 PASS했다. registry tarball/integrity와 byte-exact 일치하고 독립 리뷰 P0~P2 없음,
  필수 checks `issue-link`·`build-test`·`licenses`도 green이다. **비사소 PR이므로 병합하지
  말고 사용자 승인을 기다린다.** 승인·병합 뒤 #118은 별도 lockfile sweep으로 유지한다.
  #100은 비공개 보안 트랙 완료 전까지 blocked이며, 이후 #100 → #101 → #102 순서다.
  비공개 Advisory 세부는 공개 이슈/PR/CI에 남기지 않는다.

- 갱신: 2026-08-22 · Codex(sol) — **R15 증거 배치 병합 완료 · 다음 실행 순서 확정**.
  사용자 승인 순서대로 PR #97(`eaf08f1`) → #115(`0dae4ac`) → #119(`2160af3`) →
  #120(`9bb76e3`) → #122(`73ea1d3`)를 모두 squash 병합했고 필수 checks
  `issue-link`·`build-test`·`licenses`는 각 최종 head에서 green이었다. 이에 #69·#98·#117·
  #99·#121은 close됐고, 전체 HWP/HWPX→own PDF→시각 비교 파이프라인 우산 #93은 open이다.
  남은 증거는 다음과 같다: 데스크톱 workspace 셸/clean checkout 결정론, canonical 조판 게이트
  8/18/24쪽·98.9/99.2/99.7% 줄정확·91/257/365 본문 오라클, `/models` 서버/정적 빌드
  fail-closed, 공식 12개 출처군 후보 259건·pair 120개 metadata-only 카탈로그, 144 DPI·±3px
  정렬의 report-only PDF 비교기(51/51). 공개 바이너리 수집은 아직 하지 않았고 #100이
  권리·PII·magic bytes·SHA·quarantine을 통과한 자료만 안전 승격한다.
  **다음 실행 순서:** #116(nanoid 앱 패치; #117 병합으로 unblocked) → #100(공공 샘플 안전
  승격) → #101(20쌍 이상 PDF calibration/임계치) → #102(PaintOp/object replay와 SVG↔PDF
  sink parity). rhwp는 HWP5/HWP3 decode와 일부 수식·차트 fragment/oracle에 아직 의존하지만
  HWPX·IR·조판·SVG/PDF·ops/AI는 자체 코어다. fork 고유 commit 0인 pinned mirror 상태를
  #87(거버넌스) → #107(자체 HWP5 parser+differential) → #94(단계적 cutover)로 바꾼다.
  #84는 #89 선행 전까지 보존·차단한다. 보안 수정은 비공개 Advisory에서만 계속하며 공개
  이슈/PR/CI에 세부 내용을 남기지 않는다. `auto-hwp-github` 09:30 KST 추적은 계속한다.

- 갱신: 2026-08-22 · Codex(sol) — **#114 실행 로드맵 · #98/#69/#117/#99/#121 구현 체크포인트**.
  공개 로드맵 #114와 R15~R18 마일스톤에 실행 이슈 #98~#118 및 #121을 의존 순서와 수용 기준으로
  등재했다. 구조 재감사 결과 HWPX parser/writer·SemanticDoc·조판·live SVG·PDF·편집 op-bus는
  자체 Rust 코어가 소유한다. 반면 출하 Web/Tauri/service의 HWP5/HWP3 decode는 rhwp 하드
  의존이고, 수식·차트 SVG fragment와 original/lineseg oracle에도 좁은 렌더 의존이 남는다.
  `kwakseongjae/rhwp` URL+SHA pin은 했지만 fork 고유 commit이 0개라 현재는 유지 포크보다 고정
  mirror에 가깝다. #87(fork 거버넌스) → #107(자체 parser skeleton/differential) → #94(cutover)로
  제거하며, 버전 문구 drift·예외 경계·미사용 façade 부채는 #87 댓글에 기록했다.
  **PR #115(#98) all checks green·MERGEABLE**: canonical gate가 8/18/24쪽,
  98.9/99.2/99.7% 줄정확, 91/257/365 본문 오라클, missing=0을 quick/full/CI에 강제한다.
  **PR #97(#69) main 동기화·all checks green·MERGEABLE**: 워크스페이스 셸 실행 경로와
  clean checkout 빌드 계약을 검증했으며 비사소 변경이라 사용자 병합 대기다.
  **PR #119(#117) all checks green·MERGEABLE**: Next 15 `/models` 빌드를 literal dynamic으로 고치고
  정적 demo의 api/models 격리·복원 실패·Host 스푸핑을 fail-closed로 잠갔다. 로컬 검증은
  앱 247, 전체 Playwright 85 pass/3 intentional skip, 서버/정적 build와 독립 리뷰 PASS.
  **PR #120(#99) all checks green·MERGEABLE**: 바이너리 없이 공식 12개 출처군의 HWP5 119·HWPX 19·
  PDF 121 = 후보 259건과 pair 120개를 provenance·privacy·license와 함께 metadata-only로
  등재했다. 8개 조판 빈칸을 우선순위화했고 계약 54/54·quick·독립 리뷰가 모두 PASS;
  라이선스 재검토 6건과 URL·magic bytes·SHA·바이너리 PII 검증은 #100에서 승격 전 수행한다.
  **PR #122(#121) all checks green·MERGEABLE**: 이미 export된 own PDF와 명시적 reference PDF를
  구조 우선(page/box/rotation/orientation)으로 비교하고, JSON·HTML·side-by-side·aligned·overlay·
  heatmap과 최악 5쪽/영역을 report-only로 만든다. 51/51·quick·필수 CI·독립 보안/범위 검수 PASS;
  20쌍 T0/T1 calibration/manifest는 #101, object/PaintOp replay·SVG↔PDF parity는 #102가 소유한다.
  #116 nanoid 앱 패치는 로컬 240/240·audit 0이나 #117 clean build 선행으로 blocked;
  나머지 독립 lockfile은 #118. 비공개 보안 트랙은 공개 이슈와 분리해 유지한다.
  커뮤니티 #42/#50 후속 답변과 외부 PR/이슈 점검을 마쳤고 악성·스팸 신호는 0건;
  `auto-hwp-github`가 매일 09:30 KST 추적한다. 겹치는 CI/상태 파일 때문에 다음 순서를 지킨다:
  #97 병합 → #115 rebase·CI·병합 → #119 병합 → #120 rebase·CI·병합 → #122 rebase·CI·병합 승인 →
  #116 → #100 안전 승격 → #101 calibration → #102 PDF replay.

- 갱신: 2026-08-22 · Codex(sol) — **rhwp 경계 감사 · #84 차단 · #69 재진단/QA**.
  결론: auto-hwp는 rhwp 완전 종속이 아니다. **HWP5 ingest/lift와 일부 수식·차트 보강**은
  rhwp에 의존하지만, HWPX 파서/직렬화 · SemanticDoc IR · 조판 · SVG/PDF 렌더 · 세션/ops/AI는
  자체 엔진이다. 다만 `external/rhwp`는 사용자 fork URL을 가리킬 뿐 upstream 대비 고유 commit 0,
  upstream 18 commit 뒤인 pinned mirror라 “우리가 고치는 active fork” 상태는 아니다. 공개 후속:
  #87(self-owned HWP5 ingest/fork governance) · #88(HWP/HWPX pair oracle) · #89(inline object atom flow).
  #84 dirty branch는 보존했으나 own-render가 수식 44개 중 11개만 배치해 **33개를 잃으므로 PR 금지**;
  공개 blocker 댓글 후 워커를 중단했고 #89 선행이다.
  #69는 env 유실·PNG 오라벨 진단이 모두 반증됐다. 실제 결함은 실패한 Vite 대신 stale 1420에
  붙을 수 있는 경로다. `codex/issue-69-desktop-shell-qa`에서 explicit workspace mode + 전용 1421 +
  bind guard/strictPort + WORKSPACE 마커를 구현. 디버그 `.app`에서 공개 HWPX 1쪽과 HWP5 5쪽을
  네이티브 다이얼로그로 열고 페이지 이동·90→99% 줌까지 실측. clean checkout 패키징을 위해
  workspace build hook도 editor-core → react → UI 순서를 보장한다. `verify-local --full`은 조판
  8==8/18==18/24==24 · 82건 커밋 오라클 산출물 계약 · wasm/JS/vitest · Playwright
  85 pass/3 skip로 전부 그린. 상태: PR #97 open(`Closes #69`, 머지 금지). main `80c2c4a`
  동기화 과정의 문서 충돌은 #84→#89 차단 판단을 보존해 해결했으며 필수 checks 재실행 대기.

- 갱신: 2026-08-21 · Grok 4.6 — **#82 T2-C · .hwp lift 그림 문단 누수**.
  브랜치 `fix/issue-82-hwp-lift-leak`. 원인: lift가 Picture를 호스트 뒤에
  `object_paragraph`로 한 장 더 넣어 본문 zip이 밀림(issue_265: 199 vs 195).
  메모/머리말/캡션/글상자는 이 경로에서 안 샜다. 수리: 그림을 호스트에 붙이고
  `treat_as_char=false`는 본문 높이를 안 잡음. 직렬화는 텍스트+그림 섞인 문단의
  본문을 지킴. 오라클: issue_265 19→17쪽 / 62.6%→91.3%. header_footer 쪽수일치
  40→60 · 본문줄 87.6→93.3. 일치 52→53 · 쪽격차 13→10. 게이트 8==8/18==18/24==24.
  남은: issue_265 +1쪽. 수식/차트 object_paragraph는 이번 특정 밖. **머지 금지**.

- 갱신: 2026-08-21 · Grok 4.6 — **#80 T2-B · 머리말/꼬리말 축**.
  브랜치 `fix/issue-80-header-footer-axis`. 원인: HWPX `drawText`/`caption` subList가
  본문 문단 스트림으로 샘(#78 메모와 같은 구멍, 다른 태그). 재난안전 +82문단·짝 밀림.
  수리: 섹션 루트로 새는 경우만 Overlay 프레임 격리(셀 안은 rhwp 짝 유지).
  오라클: header_footer 본문줄 **81.9%→87.6%** · 쪽수일치 40% 무변.
  재난안전 85→82쪽 / 69.9%→98.2%. 일치 51→52. 게이트 8==8/18==18/24==24.
  남은: 재난안전 +6쪽(빈 pageBreak·이미지 개쪽), issue_265는 .hwp 그림 문단 +4(미수리).
  **머지 금지**.

- 갱신: 2026-08-21 · Grok 4.6 — **#78 T2-A · 조판 최약 축**.
  브랜치 `fix/issue-78-typeset-weak-axes`. 원인: HWPX `fieldBegin type="MEMO"` 풍선
  본문이 셀/본문 조판으로 샘 → 11mm 셀이 74줄, 다쪽 표 +3쪽.
  수리: 메모 본문을 header/note와 같은 SubFrame으로 격리. 게이트 8==8/18==18/24==24.
  오라클: multipage_table 쪽수일치 **33.3%→46.7%** · 본문줄 91.8%→95.1%.
  header_footer **미개선**(40% / 81.9%) — 밴드 overflow·body_box 미차감은 기각.
  회귀 0(변경 파일 2건=메모 쌍둥이). **머지 금지**.

- 갱신: 2026-08-21 · Grok 4.6 — **#72 T1-R2 · 오라클 전수 스윕**.
  브랜치 `feat/issue-72-oracle-sweep`. `layout-check --json` + `scripts/oracle-sweep.mjs`.
  82건: 채점가능 79 · 채점불가 3 · 일치 51 · 줄격차 12 · 쪽격차 16.
  점수는 한/글 참값이 아니라 저장 lineseg 회귀 잠금. 최저 축: header_footer 81.9% /
  footnote 90% / multicolumn 91.7%. 기존 게이트 8==8/18==18/24==24 무변경.
  CI는 `--check-committed`만. **머지 금지**.

- 갱신: 2026-08-21 · Grok 4.6 — **#71 T1-R1 · PR #76**.
  https://github.com/kwakseongjae/auto-hwp/pull/76 `Closes #71`.
  코퍼스 82건 tag-layout 태깅. 빈칸: 가로세로 혼합 0 · 각주 1 · 차트 1.
  hwpxlib 데이터 49 + GOV 양식/서식 4 (KOGL-1 실측). **머지 금지**.

- 갱신: 2026-08-20 · Grok 4.6 — **#64 D0 · PR #68**. 
  https://github.com/kwakseongjae/auto-hwp/pull/68 `Closes #64` · #51 흡수.
  3종 Intent 래퍼 + 필수 목록 + CI vitest. normalize는 #65. **머지 금지** — CI 3종 green 대기.

- 갱신: 2026-08-22 · Claude(Fable) — **sol 인수인계 킷 + 조판 T2 4연타 현황**.
  인수인계 정본 `docs/handoff/CODEX-SOL-2026-08-22.md`(#85) — 진행 중 작업 확인법·백로그
  의존도 지도·계측기 사용법·붙여넣기 프롬프트 4벌(A #84 / B #73 / C #69 / D #62)·
  소유자 전용 작업·오늘 실측 함정 7종. **sol은 이 문서 하나로 착수 가능**.
  조판 트랙: #72 전수 오라클(82건) 위에 같은 버그 계열 3건 수리 머지 —
  #78(메모 풍선→셀, PR #79) · #80(도형 글상자·표 캡션→본문, PR #81) ·
  #82(.hwp 그림 object 문단→본문, PR #83, main `9c497d1`). 누적: 다쪽표 쪽수일치
  33.3%→66.7% · 중첩표 40%→70% · 머리말 40%→60%(본문줄 81.9%→93.3%) ·
  도형/OLE 75.8%→87.9% · 일치 51→53 · 쪽격차 16→10. **3건 모두 점수 하락 0건 ·
  채점 로직 무변경 · 게이트 8==8/18==18/24==24 검수자 직접 재현.**
  **#84**(수식·차트 extra 문단)는 **워커 중단 — WIP 보존**: 브랜치
  `fix/issue-84-object-paragraph-leak` 커밋 `93d493d`(미검증). 디스크 풀 복구 직후
  workspace clippy 정체로 `--full` 미완, PR 없음. 검수자 확인분: 게이트 3종 통과 ·
  채점 로직 무변경 · 스윕 하락 0건 · equation 축 본문줄 92.1%→97.3%(math-001 3→2쪽).
  남은 일은 **검증 완주 → PR**이며 재구현 불필요 — 절차는 핸드오프 §2.

- 갱신: 2026-08-20 · Claude(Fable) — **#64 머지 + 데스크톱 셸 결함 2건 발견 + T1 계획 확정**.
  PR #68 머지(main `9b3b659`, #64·#51 close): 3종(blockRunsPath·tableGrid·docProfile)이
  read-only Intent 래퍼로 배선, `desktopRequired.ts` 필수 목록 + CI 계약 테스트(존재·
  non-stub·Intent 라운드트립·커맨드 24종 등록)가 `build-test` 신규 node 스텝에서 실행,
  normalize 2종 명시적 제외. 게이트 8==8/18==18/24==24 검수자 직접 재현.
  ⚠️ **QA 경로 결함 발견(#69)**: `VITE_SHELL=workspace cargo tauri dev`로 띄워도
  `beforeDevCommand`가 env를 주입하지 않아 vite 프로세스에 플래그가 안 닿는다(`ps eww`로
  실측) → `__WORKSPACE_SHELL__=false`로 **레거시 App.tsx가 부팅**된다. 그래서 PR #68의
  증거 `2026-08-20-d0-workspace-shell.png`는 **이름과 달리 워크스페이스 셸이 아니다** —
  3종의 가시 효과는 아직 미확증(코드·게이트·CI는 독립 검증됨). 소유자 실사용에서 확인된
  셸 UI 갭은 **#70**(Figma형 인플레이스 편집·우측 바이브 패널·모델 연결·열기/저장 배치).
  **T1 실행 계획**을 TYPESET-ROADMAP §4에 확정: 실사 결과 오라클(`layout-check`)이
  코퍼스 60여 건 중 **4건에만** 돌고, `bench-corpus.sh`는 "크래시 없음"만 봐서 #42처럼
  **쪽수는 맞는데 비는 문서가 통과**한다. GOV-SOURCES 7건은 전부 보도자료형(양식 편향).
  이슈 **#71**(커버리지 지도+수집 편향) → **#72**(오라클 전수 스윕+baseline) →
  **#73**(제보→픽스처 절차). 다음: Grok 착수 순서 사용자 결정.

- 갱신: 2026-08-20 · Claude(Fable) — **블로그·데스크톱 트랙 우로보로스 구체화 → 이슈 5건**.
  인터뷰 2건(블로그 `interview_20260820_045204`/Seed `seed_e2faaecf79a5`, 데스크톱
  `interview_20260820_062442`/Seed `seed_e31ddce71c7e`) + 수락 가드 6레인. **가드가
  두 계획의 전제를 뒤집었고 레포로 직접 재확인함**:
  ① 블로그 — 제품 활용 3편(벌크·MCP·임베드)은 **이미 `/docs`에 정적 페이지로 존재**하고
  08-13 GSC 실측이 "발견됨 - 색인 생성되지 않음"이라 표면 개수가 문제가 아니었다 →
  창간 3편을 **1차 자료**(조판·포맷·업데이트 노트)로 되돌림. B2 게이트의 유기 지표
  정본은 GA4→**GSC 클릭/노출**(동의 게이트 과소계상), 임계치는 B1 첫 글 머지 전 확정.
  ② 데스크톱 — "34메서드 전부"는 계약과 충돌(**20/34가 optional**, `HwpWorkspace.tsx:3135`가
  "tableGrid는 OPTIONAL, 없으면 강등"을 의도된 설계로 명시) → D0를 hwp-session에 이미
  있는 **얇은 3종**으로 축소, `normalize` 2종(hwp-wasm 상태머신 전용, hwp-viewer 참조
  0건)은 명시적 capability-off. 배선은 신규 커맨드 대신 **read-only Intent 래퍼**.
  ⚠️ `ci.yml` 필수 3종에 **JS 실행 스텝 0건** — CI 계약 테스트는 `build-test`에 node
  스텝 신설 필요. 이슈: **#62**(B0 인프라) **#63**(B1 창간 3편) **#64**(D0 우산, #51 흡수)
  **#65**(normalize 코어 승격) **#66**(본 문서 정합). 다음: Grok 착수 순서 사용자 결정.

- 갱신: 2026-08-20 · Claude(Fable) — **#56 실계정 QA 통과 · PR #59 머지**(main `a53006f`, #56 close).
  소유자 Chrome(claude-in-chrome)으로 종단 검증: `/models` LOCAL ONLY·카드 1장 →
  Connect → OpenRouter 인가(QA 키에 크레딧 상한 $1·라벨 localhost:3000) → 콜백 →
  `connected=true·keySource=session` 전환 → 카탈로그 **403종** 로드 → 모델 명시 선택
  (`anthropic/claude-haiku-4.5`, 기본 grok-4.5와 다름) → sample-8p에서 실제 AI 편집
  (SetTableCell 제안→적용→되돌리기 정상). **`GET /api/hwp-edit`가
  `provider:openrouter·model:anthropic/claude-haiku-4.5·keySource:session`을 반환해
  "선택 모델이 요청을 구동한다"를 확증**. disconnect 후 `keySource:env·model:grok-4.5`로
  정확히 복귀. 게이트 실측: 비루프백 Host → 404, connect는 `code_challenge_method=S256`
  + 요청 오리진 기반 callback_url. dev 로그·status 응답에 키 유출 0건.
  보안 리뷰 MEDIUM 2건(Host 기반 루프백 검사·소비 경로 무게이트)은 v1 잔여 위험으로
  **우산 #50에 후속 하드닝 등록** 후 스레드 해결. ⚠️ 소유자 조치: OpenRouter 대시보드에
  남은 QA 키(`localhost:3000`) 수동 폐기 — disconnect는 서버 메모리만 지운다.
  다음: Grok 트랙은 #51(Tauri blockRunsPath) 또는 T1(제보→픽스처 절차) 또는 B0(블로그).

- 갱신: 2026-08-19 · Grok 4.6 — **#56 OpenRouter PKCE v1 · PR #59 · CI 3종 green**.
  https://github.com/kwakseongjae/auto-hwp/pull/59 `Closes #56` · Part of #50 ·
  설계 크레딧 @SEUNGJU-PARK-KR. 서버 커스터디 키 + 이중 게이트 + 모델 셀렉트.
  `demo.ts` diff 0. Cursor Medium 3건 수리(`0733493`)·스레드 답글만(resolve는 검수자).
  브라우저: Connect → OpenRouter Sign Up/Sign in. 실계정 E2E는 소유자 QA 대기.
  **머지 금지**.

- 갱신: 2026-08-19 · Grok 4.6 — **PR #46 Cursor High 2건 수리 · 머지 대기**.
  `fix/issue-42-layout-gap`: (1) `set_page_size` 여백 안내선이 `display_paper`의
  (pw, ph)에서 빼도록 교정 — landscape에서 margin_right=0/bottom 팽창 해소.
  (2) `section_first_page`를 fresh-page push+`set_page_size` 뒤로 이동 — 다음 섹션
  머리말이 이전 섹션 마지막 쪽에 겹치지 않음. 잠금 테스트 2건. 게이트
  8==8/18==18/24==24 · 줄바꿈 98.9%+ · `hwpx_rhwp_parity` 3/3. 격리 clippy
  hwp-typeset `-D warnings` green. `verify-local --full`은 macOS shared-target
  workspace clippy 정체로 격리 대체(wasm-opt 7,551,556 B · e2e 85 passed /
  3 skipped). 다음: 푸시 후 CI 3종 green + 리뷰 스레드 답글(resolve는 검수자).
  **머지 금지**. #42 제보자 답변은 소유자 게시.

- 갱신: 2026-08-19 · Grok 4.6 — **T0 / PR #46 정합 재정의 완료 · 머지 질문**.
  `fix/issue-42-layout-gap`에 origin/main(#49 중첩 캐럿) 병합. `hwpx_rhwp_parity`는
  부분집합 동등: 본문 22쪽/301줄 잠금, 제외 extras는 ours 0/0/0 · rhwp
  landscape_swaps=1. 살린 요소는 자체 픽스처(머리말 표 XML·폼 표식 글리프·가로+머리말
  7==7 LOCKSTEP). 게이트 8==8/18==18/24==24 · 줄바꿈 98.9%+. 워크스페이스 테스트
  green. macOS workspace clippy는 종전대로 스킵, 격리 target clippy `-D warnings`
  green — Linux CI가 전체 clippy를 본다. sample-8p 브라우저: 업로드+예시 경로
  모두 `HWP · 8쪽`·아웃라인 점프. 제보 원문 .hwp는 레포에 없음. 다음: CI 3종
  green 확인 후 **머지 질문**(비사소). #42 제보자 답변은 소유자 게시.

- 갱신: 2026-08-18 · Claude(Fable) — **#50 인수·계획 확정 (우로보로스 인터뷰 D1–D9)**.
  PR #53(#33·#29 close)·PR #55(#54 로드맵 트랙) 머지 완료. #50(모델 프로바이더 허브,
  외부 제안)은 타당성 검증(Copilot SDK 2026-06 GA·OpenRouter PKCE 공식·Codex CLI 격리
  실증) 후 **즉시 인수** — 크레딧 댓글 게시, 우산 유지, 첫 슬라이스는 서브이슈
  **#56**(OpenRouter PKCE v1). 핵심 결정: 어댑터 계약 3종 동시 설계·구현은 OpenRouter부터
  / **서버 커스터디 키**(globalThis 메모리만, 브라우저는 connected+키출처 메타) /
  **이중 게이트**(`AUTO_HWP_LOCAL_MODELS=1`+루프백 검사 — 서버형 데모 demo.ts가 Vercel에
  실려 빌드 게이팅만으론 부족) / 첫 PR에 모델 셀렉트 포함(no-silent-fallback 테스트) /
  demo.ts 무접촉·프로덕션 무변경. Ouroboros Seed `seed_8e464381dc64`(수락 기준·verify
  커맨드 구조화 — Grok 착수 프롬프트로 사용). 착수 순서: Grok은 **T0(#46 조판 정합
  재정의) 먼저** → #56 → #51 → B0. 상세 계약·함정은 #56 본문이 정본.

- 갱신: 2026-08-18 · Claude(Fable) — **#48 머지 완료 + 장기 로드맵 트랙 3종 + 역할 분담**.
  PR #49는 Cursor 리뷰 2건을 검수해 수리 후 머지(main `773c52f`, #48 close): High(Tauri
  `blockRunsPath` 부재 → 입력이 침묵하는 죽은 캐럿)는 심기 가드+계약 테스트로 막고
  후속 #51(Tauri 배선)·#52(본문 Home/End 시각 줄)로 분리. #33은 Brave 5일차 0건을
  pending으로 기록한 증거 PR #53(`Closes #33`; 머지 후 상위 #29도 close). 이 브랜치
  `docs/issue-54-roadmap-tracks`(#54): `TYPESET/BLOG/DESKTOP-ROADMAP.md` 신설(조판
  장기전 근거=PR #46 정합 301vs282 충돌), AGENTS 역할 분담(Fable=기획·검수·조율 /
  Grok 4.6=실작업), THREADS 다음 시리즈 방향 3종. #42 답변 초안은 TYPESET-ROADMAP
  부록 — 소유자가 게시. 다음: #53·#54 CI green 후 머지, T0(#46 정합 재정의)는 Grok.

- 갱신: 2026-08-15 · Grok 4.6 — **#48 중첩 셀 캐럿 구현**. 브랜치
  `feat/issue-48-nested-caret`. `cell_text_hit` min-area+path, `CaretRectCell.path`
  additive, `CellCaretAnchor.path` + Home/End. sample-8p: 1클릭=표(#19),
  더블클릭=캐럿, Home/End leaf 줄, ⌘A+Backspace는 생산품만, undo 복구.
  PR https://github.com/kwakseongjae/auto-hwp/pull/49 `Closes #48`.
  다음: CI 3종 green 후 머지 질문. #42/#46과 분리.

- 갱신: 2026-08-15 · Grok 4.6 — **#48 중첩 셀 캐럿**. 공개 이슈
  https://github.com/kwakseongjae/auto-hwp/issues/48 . 브랜치
  `feat/issue-48-nested-caret`. 계약 테스트(ignore/fixme) 선설치. 구현 전.
  머지 후보는 이슈 체크리스트+CI 3종+sample-8p 실브라우저. #42와 분리.

- 갱신: 2026-08-15 · Grok 4.6 — **에이전트 규율 #43 (PR만, 병합은 질문)**.
  #40/#41은 main `dbc76ef`에 이미 병합. 이번 브랜치 `docs/issue-43-ask-before-merge`:
  비사소 PR은 체크 green 후 멈추고 묻는다. UI는 chrome-devtools로 업로드/클릭
  검수. 전역 `~/.grok`에도 동일 규칙·`browser-qa` 스킬·MCP 핀. 다음: 사용자
  병합 승인. 082 한컴 게이트는 별건. 선재 사용자 문서 무접촉.

- 갱신: 2026-08-15 · Grok 4.6 — **#42 조판 네 결함 한 PR 구현 중**.
  브랜치 `fix/issue-42-layout-gap`. 원인: HWP5 가로 미교환, `Control::Form` 드롭,
  머리말 decorations 미조판. 원본 `.hwp`는 로컬에 없음(이슈 PDF만). 공개 게이트
  유지. 다음: 테스트·브라우저 검수 후 PR `Closes #42`, 머지는 질문. 사용자 문서
  무접촉.


- 갱신: 2026-08-13 · Codex(sol) — **성장 계측 production·Google/Naver 등록·Brave 제출 완료**.
  main `097929767fd8bec6df42acb18ca74835aa342a24`의 자동 production run `31691376098`은 전체 success.
  라이브에서 동의 전 GA script/request/cookie 0, 허용 뒤 page_view, 철회 즉시 disable을 확인했고 샘플
  8쪽 `ws_document_open` payload가 hwp/sample/success/6-10 enum·bucket만 포함함을 검증했다. GA4 별도
  오토한글 property Realtime 수신, Enhanced Measurement off, custom dimension 6개, `ws_export`·
  `ws_layout_report_open` key event를 설정했다. Google URL-prefix meta verified, sitemap 15 URL success,
  homepage indexed/HTTPS; `/docs`·`/bulk`·`/privacy`는 발견됨-pending이고 privacy는 수동 요청했다. Naver
  meta verified+sitemap+핵심 URL 4개 수집 요청, Brave homepage Submit URL success. 증거=
  `docs/launch/evidence/2026-08-13-growth-search-registration.md`. 사용자가 즉시 해야 할 인증·로그인 작업은
  없다. 다음 비동기: 2026-08-20 Brave 실제 색인, GA `ws_document_open result=success` 파생 key event,
  Google/Naver 하위 URL 자연 색인 재확인. 7월 일회성 진단 뒤 미추적으로 남은
  `crates/hwp-rhwp/examples/control-audit.rs`는 이슈 #36에서 용도·비참조·feature 부적합을 확인하고 삭제했다.
  생성물이 아닌 소스라 `.gitignore`에는 추가하지 않았다.

- 갱신: 2026-08-13 · Codex(sol) — **이슈 #26 Vercel main 자동 production prebuilt 배포 실증 완료**.
  PR #27 필수 checks green→main `dd527d8` 병합. 별도 수동 실행 없이 동일 SHA의 push event가
  production run 31680139716을 시작해 6m30s success했다. engine wasm·JS deps·production env pull·
  Vercel prebuild/deploy가 모두 green이고, autohwp.com `/` 200·`/og.png` 200·canonical·CSP/HSTS/
  nosniff/frame deny를 재확인했다. native Vercel Git build는 계속 off, 수동 preview/production도 유지.
  증거=`docs/launch/evidence/2026-08-13-vercel-main-auto-production.md`. 다음: 이 docs-only 증거 PR의
  필수 CI→merge 뒤 path filter가 추가 production run을 만들지 않는지 확인. 선재
  `crates/hwp-rhwp/examples/` 무접촉.

- 갱신: 2026-08-13 · Codex(sol) — **이슈 #26 Vercel main→production 자동 prebuilt 배포 구현 완료·PR 전**.
  Vercel native Git build는 계속 `deploymentEnabled=false`로 두고, `vercel-deploy.yml`에 관련 경로
  main push 트리거를 추가했다. push에는 `inputs.target`이 없으므로 event name으로 DEPLOY_TARGET=
  production·PROD_FLAG=--prod·production environment/smoke를 명시 정규화했다. 수동 dispatch의 preview
  기본값과 production 선택은 유지한다. paths는 hwp-lab/packages/crates/external submodule/Cargo manifests/
  root vercel config/workflow로 제한해 docs-only merge는 배포하지 않는다. launch regression 8/8,
  automated 30/30, actionlint(YAML/expression; shellcheck 연동 제외) green. 다음: commit/push→PR `Closes #26`
  →필수 CI→merge→merge가 자동 생성한 production run과 autohwp.com smoke 확인. 선재
  `crates/hwp-rhwp/examples/` 무접촉.

- 갱신: 2026-08-13 · Codex(sol) — **npm 4종 lockstep 0.0.5 발행·fresh consumer 검증 완료**.
  이슈 #23→PR #24 필수 checks green 후 main `7a41cb6` 병합. 같은 SHA의 publish workflow
  run 31678071089를 `dry_run=false`로 실행해 engine→editor-core→ai-protocol→react 네 패키지를
  모두 발행했다. registry version/license/shasum/unpacked size와 React 의존 `^0.0.5`를 재조회했다.
  빈 temp에서 Vite·Next production build, Node 24.14.0·Bun 1.3.8 실제 sample-8p 8쪽 렌더
  (SVG 61,957 B)·HWPX export(25,216 B)까지 green. 증거=`docs/launch/evidence/2026-08-13-npm-0.0.5.md`.
  Vercel Git auto deploy는 꺼져 있고 수동 prebuilt workflow만 사용하므로 프로덕션은 미배포 상태다.
  선재 `crates/hwp-rhwp/examples/` 무접촉.

- 갱신: 2026-08-13 · Codex(sol) — **npm lockstep 0.0.5 릴리스 후보 준비·PR 전 검증 완료**.
  소유자 발행 승인에 따라 공개 이슈 #23과 브랜치 `codex/issue-23-npm-0.0.5`를 만들었다. 네 패키지,
  lockfile, engine CDN 핀, 현재 설치 안내를 0.0.5로 맞추고 CHANGELOG Unreleased를 0.0.5(파괴 변경 없음)
  절로 확정했다. launch automated 30/30, ai-protocol 64, editor-core 262, React 418, 네 tarball dry-run
  green; engine wasm 7,560KB, React tarball의 형제 의존 `^0.0.5`와 source `file:` 복원도 확인했다.
  `verify-local --full`은 종전 macOS shared-target Tauri/rhwp clippy 저CPU 정체가 재현되어 진단 오류 없이
  중단했다. 다음: 명시 commit/push→PR `Closes #23`→Linux CI green→merge→publish.yml dry_run=false→
  registry 4종/fresh consumer 검증. Vercel은 Git auto deploy가 아니라 수동 prebuilt workflow이며 이번 npm
  릴리스 비범위다. 선재 `crates/hwp-rhwp/examples/` 무접촉.

- 갱신: 2026-08-13 · Codex(sol) — **이슈 #19 중첩 표 삭제·즉시 undo 수정 main 병합 완료**.
  공개 이슈 #19→PR #20으로 진행해 필수 checks(issue-link, build-test, licenses) green 후 보호된 main
  `f32f0ca`에 병합했고 이슈는 자동 close됐다. `TableBox`가
  중첩 표의 부모 CellPath+cell 내부 block index를 보존하고, 수동 전용 additive
  `DeleteNestedBlock` Intent/Op가 해당 자식 블록만 제거한다. 최상위 `DeleteBlock`은 그대로다.
  삭제 중 들어온 undo는 커밋 완료 뒤 직렬화하며, 선택 삭제로 Design→Vibe 탭이 돌아올 때 채팅
  textarea가 자동 포커스를 훔치던 두 번째 원인도 `AI에게 전달` focusToken 증가 때만 포커스하도록
  교정했다. 공개 `sample-8p.hwp` E2E에서 중첩 예시만 삭제·바깥 `창업아이템명` 보존·undo 복구·
  재삭제 직후 무클릭 undo 복구 1/1 green. hwp-ops 98, MCP schema 14, editor-core 262, React 418,
  hwp-lab 198, 격리 target clippy `-D warnings`, wasm 재빌드+wasm-opt(7,560KB), 게이트
  8==8/18==18/24==24 green. `verify-local --full`은 코드 오류 전 macOS shared-target Tauri/rhwp
  clippy가 CPU 0%로 재정체되어 중단했고 동일 범위를 격리 target과 PR Linux CI로 green 확인했다.
  npm 네 패키지의 latest는 모두 `0.0.4`이나 #19 변경은 아직 미배포다. 다음 패키지 배포 시 additive
  Intent/공개 DTO 변경을 포함해 `0.0.5`로 올린다. 프로덕션 배포는 별도 승인·워크플로 대상이며,
  선재 `crates/hwp-rhwp/examples/`는 무접촉.

- 갱신: 2026-08-13 · Codex(sol) — **정식 런칭 후 버그 2건 수정·프로덕션 배포·issue-first 전환 완료**.
  이슈 #11/#12/#13 → PR #14로 진행해 필수 checks(issue-link 3s, build-test 5m28s, licenses 2m45s)
  green 후 보호된 main `2eb29d7`에 병합했고 세 이슈는 자동 close됐다. 같은 전체 SHA
  `2eb29d7f54f946e7a74206120e9d9e9fc5b96afa`를 Vercel production run 31667859879로 배포해
  6m16s success, autohwp.com 별칭 smoke와 실제 CSP `frame-src 'self' blob:`을 확인했다. 인앱 브라우저
  공개 샘플 8쪽에서 PDF blob 미리보기(기존 차단 아이콘·콘솔 오류 없음), AI 제안→`✓ 적용됨`→undo
  오류 0건을 실검증했다. main 외 종전 브랜치는 로컬·원격 모두 삭제됐다. main 보호는 strict
  `issue-link`+`build-test`+`licenses`, PR/admin/대화해결 적용, force-push/delete 금지다. 배포 성공 로그의
  유일했던 Node20 deprecation 경고는 이슈 #15→PR #16의 공식 setup-node v7(Node24) 전환으로 닫았다.
  필수 checks(issue-link 5s, build-test 6m10s, licenses 2m46s) green 후 main `86a4cff`에 병합했고, 같은
  전체 SHA `86a4cff81cc35b403d3e0d6997f03bd00839121e`의 production run 31668877992가 6m8s success,
  `setup-node@v7`·autohwp.com 별칭 smoke green·Node20 annotation 0을 확인했다. 선재 `control-audit.rs` 무접촉.

- 갱신: 2026-08-13 · Codex(sol) — **정식 런칭 후 버그 #11·#12 수정 및 issue-first 파이프라인 검증 중**.
  공개 GitHub 이슈 #11(병합 셀 covered 좌표 `no active cell`), #12(PDF blob iframe CSP 차단),
  #13(issue-first 파이프라인)을 생성했다. hwp-ops는 병합 영역 내부 좌표를 유일한 active origin으로
  정규화하고 범위 밖은 계속 거절하며 회귀 테스트 97/97 green. 사이트 CSP는 외부 프레임을 닫은 채
  `frame-src 'self' blob:`만 추가했고 실제 Next 응답 헤더+PDF 다운로드 e2e 2/2 green. PR에
  `Closes #`를 강제하는 `issue-link` check, CODEOWNERS, CONTRIBUTING/AGENTS 절차를 추가했다. 기존
  main 외 브랜치는 패치 동등성/merge 여부 확인 후 로컬·원격 모두 정리했고 현재 작업 브랜치만 존재.
  검증: fmt, hwp-ops clippy/97 tests, wasm rebuild+wasm-opt, JS 64+261+416+198, Next production build,
  launch 29/29, smoke 2/2. macOS shared target의 workspace clippy는 종전처럼 CPU 0% 정체되어 중단했고
  격리 target hwp-ops clippy는 green; PR Linux CI로 전체를 독립 검증한다. 다음: 명시 파일만 commit/push
  → PR(Closes #11/#12/#13) → 필수 checks green → main merge → main SHA Vercel production → 라이브
  PDF/AI smoke → 이슈 close·브랜치 삭제. 선재 `control-audit.rs` 무접촉.

- 정본 배포: **https://autohwp.com** (Vercel full Next — 2026-08-06 컷오버, Actions vercel-deploy.yml).
  GitHub Pages(kwakseongjae.github.io/auto-hwp)는 병행 유지 중 — 리다이렉트 스텁 전환 예정.
  GitHub: https://github.com/kwakseongjae/auto-hwp (public, 홈페이지·description=autohwp.com)
- 갱신: 2026-08-12 · Codex(sol) — **인앱 브라우저 라이브 퍼널 smoke·최종 홍보 촬영 완료**.
  autohwp.com 랜딩→기여 CTA→예시 `.hwp`→8 SVG 렌더→레이아웃 제보 링크를 실검증했다. GitHub 초안
  URL을 디코딩해 샘플 파일명·문서 본문 대표 문자열·해시가 모두 없음 확인. 라이브 PNG 2컷과 인앱
  브라우저 실제 프레임 88장으로 만든 22초 1280×720 MP4를 `assets/launch/live-production-*`에 저장하고
  Threads 2/6·3/6·5/6 미디어를 라이브 자산으로 교체했다. `release_candidate_live_smoke=pass`;
  런칭 report는 durable Upstash와 final ready만 red라 `beta-live` 유지. PR #10에 증거 반영 후 CI/merge가
  다음. 선재 `control-audit.rs` 무접촉.
- 갱신: 2026-08-12 · Codex(sol) — **오픈소스 공개 베타 RC 동일 SHA 배포 완료, 최종 브라우저 smoke 중**.
  PR #9 CI build-test 6m17s·licenses 2m49s green 후 보호된 main `31f205f` 병합. 같은 전체 SHA
  `31f205f8355df892d9a7233b2c8b4eeb432bb13e`로 `oss-launch-2026.08.12` 태그·GitHub prerelease·
  Vercel production workflow run 31593516444를 고정했다. 배포 success, autohwp.com `/`·`/og.png` 200,
  canonical 정상. 라이브 launch Playwright는 4/6: 정본/보안/Docs pass, Upstash 유예 1건 expected red,
  privacy 링크 2개를 정확히 1개로 기대한 테스트 불일치 1건. Chrome remote-debugging 재허용 뒤 실제
  8쪽 렌더·비식별 제보·최종 PNG/MP4를 확인한다. 브랜치 `codex/live-launch-evidence`; durable gate는
  pending, stage=`beta-live`(ready 아님), 선재 `control-audit.rs` 무접촉.
- 갱신: 2026-08-12 · Codex(sol) — **집단지성 베타 랜딩·실화면 홍보 자산 완료, RC 검증 중**.
  랜딩에 “문서 하나를 열어 보는 것부터 컨트리뷰션” 3단계 퍼널과 실제 8쪽 HWP 화면을 추가하고,
  README 한·영문·Threads 6개 초안에 실제 `레이아웃 문제 제보` 스크린샷과 20초 제품 화면 녹화를
  연결했다. 자산=`docs/assets/launch-layout-report.png`, `assets/launch/live-landing-contribution.png`,
  `assets/launch/live-contribution-flow.mp4`. vitest 198, typecheck, production build, 격리 포트 Playwright
  6/6 green. 첫 E2E는 3100을 다른 Factsheet 앱이 점유한 환경 충돌이었고 `PW_PORT=3102`로 재실행해
  통과했다. `verify-local --full`은 macOS Tauri clippy 링크가 CPU 0%로 20분 정체돼 중단했으며 진단
  메시지나 코드 실패는 없었다(직전 배치와 같은 로컬 환경 현상; PR Linux CI로 독립 검증). 소유자 지시로 Upstash는
  공개 베타에서 유예하되 pass로 가장하지 않고 durable gate pending·전역 비용 상한 부재를 명시했다.
  제품 커밋 `844bff3`은 origin에 push했고 PR #9(https://github.com/kwakseongjae/auto-hwp/pull/9)를
  만들었다. CI run `31588176341`의 `build-test`·`licenses`가 진행 중이던 시점에 사용자 요청으로 감시를
  안전 중단했다. **재개 첫 순서**: `bash scripts/context_restore.sh` → `gh pr checks 9` → 둘 다 green이면
  PR #9 병합 → origin/main 병합 SHA를 RC로 고정 → 동일 SHA tag/Release/Vercel production → 라이브
  smoke·최종 스크린샷/영상. red면 로그 진단부터 하고 병합 금지. 태그·배포·라이브 변경은 아직 없음.
  선재 미추적 `control-audit.rs` 무접촉.
- 갱신: 2026-08-12 · Codex(sol) — **소유자 문구 승인 반영 + 브라우저 레이아웃 제보 퍼널 완료**.
  AI 문맥은 동의 뒤 전송되지만 오토한글(auto-hwp)은 원본·전송 문맥·응답을 자체 DB/스토리지에
  저장·보유하지 않는다고 privacy·동의 모달·README에 고정했다(문서 콘텐츠 없는 IP·날짜별 횟수 키
  약 25시간 예외). 열린 문서 헤더에 파일명·본문·해시 없이 형식과 빈 비교 항목만 GitHub 공개 이슈
  초안으로 여는 `레이아웃 문제 제보`를 추가하고 이슈 템플릿을 1분 참여형으로 줄였다. 첫 Threads 6개
  초안·생성 이미지 2컷·HWPX 한계 정본도 `docs/launch/THREADS-DRAFT-KO.md`에 확정. 소유자 수동 게이트
  2개 pass로 launch automated 29/29·report 35/40·pre-live 35/38; 남은 3개는 Production Upstash →
  RC SHA 고정 → 동일 SHA tag/Release다. 검증: hwp-lab vitest 198, typecheck, production build,
  Playwright 80 passed/2 expected skip, browser-harness 실제 HWP 8쪽·비식별 이슈 초안, 전체 clippy green
  (18m49s). `verify-local --full`의 workspace test는 macOS `tauri-utils` 링크가 CPU 0%로 20분 정체돼
  중단했으며 코드 실패는 없음. 배포/tag/live smoke/npm publish는 미실행. 선재 미추적
  `crates/hwp-rhwp/examples/control-audit.rs`는 보존·무접촉.
- 갱신: 2026-08-12 · Codex(sol) — **오픈소스 런칭 pre-live 안전 정지점 확정, 단독 처리 가능분 완료**.
  제품·STATUS 검증 기준점은 최종 증빙 PR #5 merge `a7e3a85`이며, 이후 커밋은 이 상태를 보존하는
  docs-only 핸드오프다. 자동 게이트 29/29, 전체 report
  33/40, `--pre-live --strict`는 33/38이며 남은 P0 5개만 정확히 red다: `release_commit` 미고정,
  소유자 개인정보 문구 승인, Vercel Production durable Upstash, tag/GitHub Release, 소유자 런칭 문구
  승인. Dependabot open 0; main 보호는 strict `build-test`+`licenses`, PR/admin/대화해결 적용,
  force-push/delete 금지 상태를 재확인했다. 다음 순서는 ①소유자가 `docs/launch/OWNER-APPROVAL.md`
  두 항목 승인 ②Production에 `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` 등록 ③그 뒤 단일
  RC SHA를 STATUS에 고정 ④같은 SHA로 tag/Release/prebuilt production 배포 ⑤pre-live strict green 후
  종합 live smoke ⑥성공 증거와 `stage=ready`. tag/Release/배포/live smoke/npm publish는 실행하지 않았다.
  선재 미추적 `crates/hwp-rhwp/examples/control-audit.rs`는 계속 보존·무접촉.
- 갱신: 2026-08-12 · Codex(sol) — **Dependabot actionable open 0, dependency gate 최종 증빙 중**.
  후속 PR #4는 필수 `build-test` 6m19s·`licenses` 9m25s green 뒤 보호된 `main`의 `3a1b030`으로
  병합됐다. GitHub는 #16을 `fixed_at=2026-08-11T20:09:34Z`로 재평가했고 전체 분류는 fixed 12·
  auto-dismissed 3·dismissed 1(`glib` 비도달 위험 수용)·open 0이다. 최종 증빙 브랜치
  `codex/open-source-launch-final-evidence`에서 STATUS dependency_security를 pass로 전환한다.
  이 PR 병합 후 자동 게이트는 29/29, 전체는 33/40 예상이다. 남는 7개는 소유자 개인정보/런칭 문구
  승인→Vercel Production Upstash URL/token→RC SHA·tag/Release·prebuilt 배포→live smoke→ready 순서다.
  외부 3조건 전 tag/Release/배포/live smoke 금지, npm publish는 별도 명시 승인 없이는 금지.
- 갱신: 2026-08-12 · Codex(sol) — **PR #2 main 병합 완료, Dependabot 후속 High 패치 검증 중**.
  오픈소스 런칭 RC는 보호된 `main`의 `76cdd8c`로 병합됐다. 병합 후 기존 npm/pnpm actionable alert는
  모두 닫혔으나 새 #16(`quinn-proto 0.11.14`, `GHSA-4w2j-m93h-cj5j`, High)이 유일한 open으로
  나타났다. 활성 cargo graph에는 없는 lockfile 항목이지만 dismiss하지 않고 후속 브랜치
  `codex/open-source-launch-security-evidence`에서 0.11.15로 갱신했다. metadata locked·deny licenses·
  fmt·workspace all-targets locked(11m45s)·launch 29/29·diff가 green이다. 다음은 명시 커밋→PR→필수
  checks→main 병합→Dependabot open 0 재조회→최종 증빙 PR 순서로 닫는다. 그 전까지 dependency gate는
  pending이다. 라이브 진입 외부 차단은 소유자 개인정보/런칭 문구 승인과 Vercel Production Upstash
  URL/token 2개이며, 해결 전 tag/Release/배포/live smoke 금지. npm publish는 별도 명시 승인 없이는 금지.
- 갱신: 2026-08-12 · Codex(sol) — **082+085 RC 검증·PR CI green·main 보호 적용, 증거 반영 후 merge 직전**.
  브랜치 `codex/open-source-launch-085`(base `9784fd2`), 원격 커밋은 `ff0c584`(082 guarded resave)와
  `5bb471e`(agent-first launch RC). 컨셉은 “local-first Rust 코어가 본체, AI는 명시 동의 뒤
  Intent→미리보기→승인→undo를 따르는 선택 어댑터”로 고정했다. README 한·영문은
  `@auto-hwp/react@0.0.4`+`ai-protocol@0.0.4` 직접 설치/BYOK 복붙 계약, `/docs` 단일 프롬프트 CTA,
  사이트·레포 llms.txt, privacy/security/community, CSP·PR CI까지 정합화했다. 공개 데모는 실청구
  $0.0124 기준 전역 400/IP 20, Upstash 실 `PING` 도달성 probe, 첨부는 네트워크 전 거부(BYOK만 허용).
  GitHub private reporting·Dependabot·secret scanning/push protection은 실제 활성화했다. 첫 push에서
  발견한 Dependabot 9건 중 npm/pnpm 8건은 `undici 7.29.0`·`postcss 8.5.23`·`nanoid 3.3.17`로 고정해
  세 audit 0건; Rust `glib 0.18.5` 1건은 Linux Tauri GTK3 전이·취약 API 비도달을 입증해 `not_used`
  위험 수용했다. Tauri 2.11.5/plugin-dialog 2.7.2 갱신 후 `cargo check -p hwp-viewer` green(13m58s).
  `verify-launch --automated` **29/29**, 전체 report **32/40**(pending 8), fmt·deny·diff green.
  `verify-local --full` EXIT=0: 게이트 8==8/18==18/24==24/6==6, HWPX ±1 98.2%, wasm/wasm-opt,
  vitest 261+64+416+195+11, e2e 79 passed/2 expected skip. fresh Vite/Next/Node/Bun과 browser-harness
  업로드→8 SVG→셀 편집→undo도 green. 082는 `rhwp` feature 뒤 `experimental_guarded` 소스만 존재하며
  한/글·한컴독스 증거 전 공개 지원 **제외**. `external/rhwp` 무수정, 선재 미추적
  `crates/hwp-rhwp/examples/control-audit.rs` 무접촉. 다음: 보안 변경 명시 커밋/push→PR checks→실제
  check 이름으로 main 보호→merge→Dependabot open 0 재조회·gate pass. PR #2 첫 CI는 Ubuntu에 Tauri
  네이티브 라이브러리가 없어 `glib-sys`에서 red(코드 clippy 아님); 공식 Tauri Debian prerequisite 설치
  step을 추가했고 actionlint green. 같은 PR의 Vercel Git preview는 독립 `file:` 패키지의 `vite`를
  설치하지 못해 red였으나 이 경로는 비지원이다. 모든 브랜치의 Git 자동 배포를 끄고 Rust/wasm 포함
  `vercel-deploy.yml --prebuilt`만 허용하는 P0 자동 게이트를 추가했다. launch **28/28**·actionlint·
  JSON·diff green. PR CI에서 `checkout@v4` Node 20 강제 전환 경고가 확인돼 CI·배포·발행 전 레인을
  공식 Node 24 기반 `checkout@v6`로 올리고 정적 회귀 게이트를 추가했다. launch **29/29**·전체 workflow
  actionlint·diff green. PR #2 최종 후보 `b2258e2`에서 `build-test`(11m11s)·`licenses`(2m47s)가
  경고 없이 green. 이 실제 context로 main 보호를 적용·재조회했다(strict, admin 적용, PR 필수/승인 0,
  대화 해결 필수, force-push/delete 금지). 증거 반영 커밋/push→CI 재통과 후 merge가 다음이다.
  외부 차단은 소유자 개인정보/
  런칭 문구 승인과 Vercel Upstash Production 변수 2개이며, 없이는 tag/Release/배포/live smoke 금지.
  증거=`docs/launch/evidence/2026-08-12-vercel-preflight.md`. 사용자 지시로 커밋·push·PR·main 병합은
  진행 가능하나 npm publish는 별도 명시 승인 없이는 금지.
- 갱신: 2026-08-11 · Codex(sol) — **이슈 082 `.hwp` 재저장 v1 구현 완료·실물 게이트 대기**.
  신규 `hwp-hwp5-patch`: 원본 레코드→`section+CellPath+block` 주소 관찰, UTF-16 PARA_TEXT 최소 패치,
  nchars MSB/CHAR_SHAPE 보정, 네이티브 빈 문단, CFB same-chain/FAT·mini→regular·전체 재작성 폴백,
  PrvText/PrvImage 무효화. 3종 전수 매핑 sample-8p=352/352, benchmark1=1096/1096,
  inner-table-01=82/82 + depth-2; 무편집 원본 바이트 동일, 편집본 strict CFB/rhwp 재파싱, preview
  잔존 바이트 제거 포함 물리 23섹터 변화·미편집 스트림/FileHeader 동일. `hwp-mcp`에
  `hwp_export_capability`/`export_hwp`(`rhwp` feature)를
  추가했고 실제 SetParagraphText→export→재오픈 및 구조 편집 무출력 거부를 잠갔다. claw-hwp MIT 고지는
  NOTICE 반영. `scripts/verify-local.sh --full` EXIT=0: 게이트 8==8/18==18/24==24/6==6, HWPX ±1
  98.2%, vitest 261+64+416+192+11, e2e 79 passed/2 expected skip. `external/rhwp` 무수정, 기존 미추적
  `crates/hwp-rhwp/examples/control-audit.rs` 무접촉. 남음: 공개 샘플 편집본을 한/글 또는 한컴독스에서
  열어 수용 확인(`docs/HWP5-RESAVE-MANUAL-VALIDATION.md`). 사용자 확인 전 커밋·푸시 금지.
- 갱신: 2026-08-11 · Codex(sol) — **이슈 084 MCP `render_page` 자체 렌더 교체 완료·main 반영**.
  기본 `render_page`/typed `Intent::Render`를 편집된 live IR→`hwp_session::render_svg`로 전환하고,
  `Session.render`에 revision별 페이지 SVG 캐시(동일 revision 재조판 1회)를 추가. `page_count`도
  `hwp_session::place` 캐시로 웹·PDF와 같은 provider를 사용한다. 종전 rhwp 렌더/파싱 캐시는
  `source:"original"` 옵트인으로 분리했고 무편집 전용·기존 편집 거부 문구를 그대로 보존했다.
  red→green: 종전 default 비-rhwp 오류를 재현 후 편집 반영 문구·JSON/typed 캐시 공유·원본 옵트인·
  `export_pdf` 페이지/대표 글리프 픽스처로 잠금. feature 실측 default 38, rhwp 42, pdf 39,
  no-default 23, rhwp+pdf 전체 64 green; wasm32 no-default check green. `Dockerfile.service` 실제 빌드
  성공(`tf-hwp-service:issue-084`, Linux release `rhwp pdf`). `verify-local.sh --full` EXIT=0 — 게이트
  8==8/18==18/24==24/6==6·wasm/JS/vitest(261+64+416+192+11)·e2e 79 passed/2 expected skip.
  착수 전 있던 `crates/hwp-rhwp/examples/control-audit.rs`는 7월 진단 예제로 판정, 그대로 보존·무접촉.
  다음: 퍼널 트랙 B인 082 `.hwp` 재저장 착수.
- 갱신: 2026-08-11 · Claude(Fable) — **codex(sol) 인수인계 킷 완성 — 퍼널 트랙 착수 준비 완료**.
  F1을 이슈 [084](issues/084-mcp-render-ownrender.md)로 승격(MCP render_page 자체 렌더 교체 — 설계·
  수용 기준·함정 확정). `docs/handoff/CODEX-SOL-2026-08-11.md`: 공통 인수인계 절차(복원→AGENTS→
  베이스라인 그린 확인→체크포인트 규율) + 붙여넣기용 착수 프롬프트 4벌(A=084부터 시작, B=082,
  C=081 병행 가능, D=083 병행 가능) + 동시 작업 조율 규칙(트랙 간 파일 비중첩·git status 선확인).
  작업 자체는 미착수 — codex 측 착수 대기.
  `docs/AGENT-FUNNEL-ROADMAP.md`: 에이전트→호스팅 서버(.hwp 첨부)→중간 사용자 검토→최종 .hwp/PDF
  export 퍼널. 실사 결과 뼈대 기존재(hwp-mcp `--http-network` 서비스 모드+Docker 178MB+제안 흐름
  propose/commit+export_pdf/hwpx) — 갭 4개: F1 render_page가 P1 잔재(rhwp 원본 전용, 편집 문서 거부
  → own-render 교체, 반나절급) / F2 검토 링크 서버측 세션(/d/는 localStorage 전용) / F3=**082**
  `.hwp` 재저장 v1(claw-hwp patchInPlaceSectors Rust 포팅, 텍스트 레인만+capability report, 한컴독스=
  진짜 게이트) / F5 호스팅 운영. 순서 제안 F1→F3→F2→F5→F4. **083**=README 비주얼 개편(7컷·
  결정적 재촬영 스크립트·autohwp.com 절대 URL·압축 규율 유지). 다음: 착수 순서 사용자 결정 대기
  (후보: 081 캐럿 / F1+082 퍼널 / 083 README).
  rhwp 상류 중첩 표 스레드 전수 조사(`docs/research/rhwp-nested-tables-2026-08.md`: 그들이 같은 가드를
  통과하며 남긴 5계층 사슬 #2792·래칫 #4252·min-area 착지 #857·by_path 병설 함정 #2755) +
  claw-hwp 분석(`docs/research/claw-hwp-2026-08.md`: 에이전트 스킬 플러그인 — 캐럿 해법 없음, 가치는
  `.hwp` 재저장 지식·fit·secure-fill 등 아이디어 축, MIT). 계획 정본=`docs/issues/081-…md`
  (설계 6항+수용 기준 6항+함정+비범위). **작업 미착수 — 사용자 지시(계획만)**. 다음: 081 착수 승인 대기.
  (wf_2fbcd88a): 5.5건 수리 + 1건 엔진 갭 명시**. 레벨 진단 확정: ①셀 안 안내 문구 삭제 불가=
  **engine**(place.rs:1682 `cell_text_hit`가 중첩 표 캐럿 차단 — 그 문구는 셀 안 1×1 중첩 표에 있다.
  **미수리**, 수리 설계는 `apps/hwp-lab/e2e/nested-cell-caret-gap.spec.ts` test.fixme에 CellPath 관통
  설계로 보존) ②행/칸 정밀 선택=editor(앵커 계약은 있었고 생산자·어포던스 0 — RowHeadOverlay 행 머리
  +Shift 칸/행 범위+`rangeLabel` 칩+ANCHOR SCOPE 프롬프트 신설) ③적용 전 프리뷰=editor(ghost.ts+
  GhostPreviewOverlay: hover=단건·토글=고정, 덮어쓰기만 그리고 삽입/삭제는 정직 안내) ④되돌리기 실패=
  editor(**진범: applyBatch 부분 실패 시 고아 op** — session.ts 원자적 롤백+실패 시에도 refresh+빈 배치
  유령 제거, ⌘Z 빈 스택은 침묵 대신 토스트) ⑤불릿 채움 크기·위치 이상=**protocol 주범**(모델이 6~8pt
  스페이서 문단을 타겟 — paraRuns 문맥+`문단서식=[불릿/스페이서]` 라벨+프롬프트 규칙)+**engine 부수**
  (InsertParagraphAt height-0 합성 — hwp-ops `neighbour_shapes` 이웃 서식 상속, INTENT-SCHEMA §6.9)
  ⑥PDF 상이=**engine**(emit_pdf_with_fonts가 화면과 다른 provider로 재조판 — wasm에서 Approx 강등.
  `own_render_fonts_with(injected)`로 통일+serif_bold 슬롯+`<family> Bold` 라우팅)+editor(058 명조 등록이
  useEffect cleanup 레이스로 매번 취소+PdfPreviewDialog 신설 — 즉시 다운로드→미리보기 모달).
  검증(통합): verify-local --full EXIT=0 (게이트 8/18/24/6·HWPX축·LOCKSTEP 불변·external clean),
  vitest 944 전건·e2e **79 passed/2 skip**(신규: batch-atomicity 2·precision-select-preview 2)·라이브
  실크롬 시나리오 ②~⑥ green. 잔여: ①의 엔진 수리(CellPath 캐럿 관통), 중첩 캐럿 Backspace가 은닉
  undo 단위를 만드는 관찰(미확인 위험, fixme에 기록), 실 LLM 종단 ⑤ 확증, react vitest가 editor-core를
  src 별칭으로 봐 dist 트립와이어 한 레인 상실(주석 명시). ⚠️ wasm 재빌드 필수였고 --full이 수행함.
- 갱신: 2026-08-06 · Claude(Opus 5) — **실도메인 디테일 6건(사용자 스크린샷 피드백) — 커밋 없음(워킹트리)**.
  ① **문서 세션 URL `/d/<불투명 12자>`**(신규 `apps/hwp-lab/src/lib/docUrl.ts`): 열면 pushState,
  새로고침/직접 방문이면 이 브라우저 매핑(localStorage)→스냅샷으로 **기존 재개 레이어 그대로** 복원.
  주소가 마커보다 우선이고, 매핑이 없으면(다른 기기) 정직한 안내 후 홈. 닫기/처음부터/뒤로가기 → `/`.
  두 빌드 경로가 다르다: **Vercel=rewrite `/d/:key`→`/`**, **Pages=404.html 폴백(app/not-found.tsx가
  문서 주소면 앱을 태운다)** — Pages mock 서버로 실검증(안내·재개·닫기·평범한 404 4케이스).
  ② 에디터 로고=홈 앵커(확인 없이 이동 — 자동저장 근거) ③ 재개 배너→**플로팅 토스트**(12s 자동 소멸,
  pointer-events:none·닫기 버튼 없음 — 닫기 버튼이 채팅 보내기 클릭을 가로챈 것을 e2e로 실측)
  ④ 바이브 탭 Sparkles 제거(두 탭 대칭) ⑤ 배지 "실 LLM 모드"→**"AI 켜짐" + 모델 툴팁**(모델명은
  서버 `GET /api/hwp-edit`의 `model`, 폴백 `NEXT_PUBLIC_AI_MODEL`; 데모/BYOK 문구 분기) ⑥ 랜딩 헤더
  "데모" 네비 제거(로고가 홈). robots에 `/d/` disallow. 검증: tsc·vitest 183(+11 docUrl)·**e2e 75/1skip
  전부 그린**·next build·build:demo 그린. ⚠️ 기존 e2e 2건 정합: "새 탭 재방문"은 이제 `goto("/")`
  (문서 주소 새로고침은 재개가 정답). ⚠️ 선재 결함 2건 발견: docs-site 스펙의 `/docs/embed` 셀렉터가
  trailingSlash와 어긋나 항상 0건(테스트만 수정), `packages/react` vitest는 pnpm 재설치(오늘 15:57)로
  editor-core dist 해석이 깨져 35파일 로드 실패(별칭 주입 시 402 전부 통과 — 환경 문제, 미수정).
- 갱신: 2026-08-08 · Claude(오케스트레이터)+Opus 워커 — **다중 셀 바이브 재발 원인 확정·수리 라이브**
  (14차 배포 success — 라이브 실호출 다중 SetTableCell 정상). 진범: OpenRouter가 혼잡 시 **HTTP
  200 본문에 429 봉투** 반환 → 라우트가 정상 취급 → "적용할 편집을 찾지 못했습니다" 오탐(지시
  문제 아님 — 상류 원문 확보, 판별 트리 a~e 전부 실측 기각/확정). 수리: 봉투/choices-부재 판정→
  502 정직 안내·자동 재시도(무과금 429 최대 4·과금 2 상한·백오프·15s 가드)·0건 사유 3분기·
  maxDuration 30(정상 1회 ~9s vs 기본 10s 잠재 504). 문제 문장 원문 3회 연속 성공(16/14/16
  intents) 실증 후 배포. ⚠️ **비용 실측 10배 정정**: 요청당 $0.0124(주석 추정 $0.0005~0.0037
  틀림 — 실단가·실전 docContext 6082tok). 무캡 최악 $25/일 — DAILY_CAP=400(≈$5/일) 재활성 권고,
  사용자 결정 대기. 부수: .env.local 키 만료(로컬 BYOK 죽음 — 루트 .env는 유효).
- 갱신: 2026-08-08 · Claude(오케스트레이터)+Opus 워커 — **캘리그래피 로고 시스템 라이브**(a585ce4,
  13차 배포 success — favicon 8,423B·brand/wordmark·seal·새 OG 131KB 전부 200 실측). codex
  gpt-image 5안 생성→사용자 선택: **A "오토한글" 붓글씨 워드마크(히어로)+C 보라 낙관(파비콘·헤더)**.
  파생 규율: 알파 언매트(갈필 보존)·낙관 팔레트 PNG 226KB·파비콘 크기별 타일(16px 침식·안쪽
  블록 — "오·토" 식별 실검증)·다크 재채색 파생+배경이미지 토글(단일 요청)·README 배너 A+C 재합성.
  후보 4안(B 한 모노그램·D 획 심볼·E 엔소 등) assets/brand/logo-candidates/ 보존.
- 갱신: 2026-08-06 · Claude(오케스트레이터)+Opus 워커 — **실도메인 디테일 배치 라이브**(364e167,
  12차 배포 success — /d rewrite 200·llms.txt 신 URL 실측). ① 문서 URL `/d/<불투명 해시>`:
  pushState(쿼리 보존)·이 기기 스냅샷 복원(URL>마커)·타 기기 정직 안내·Vercel rewrite/Pages 404
  폴백 이원화·robots disallow. ② 로고=홈(confirm 없음 — 자동저장 근거) ③ 복구 배너→우하단 12s
  토스트(pointer-events:none — 클릭 삼킴 e2e 자가 발견) ④ 패널 탭 대칭(아이콘 제거) ⑤ "AI 켜짐"
  배지+모델 툴팁(서버 응답 기반·BYOK 안내) ⑥ 랜딩 데모 태그 제거. + 문서 URL 스윕(7파일 18링크
  autohwp.com·전송 경로 서술 정합·레포 description/homepage). e2e 75/1skip·양쪽 빌드 그린.
  잔여 동일: VERCEL_TOKEN 재발급(노출분)·Upstash·Pages 리다이렉트 스텁·GIF 재촬영 대상 URL.
- 갱신: 2026-08-06 · Claude(오케스트레이터)+Opus 워크플로 — **🚀 autohwp.com 프로덕션 컷오버 완주**
  (11차 파이프라인 success — /docs 200·sitemap 200·**AI 실호출 SetTableCell 정상 반환**). 배치:
  ① 도메인 attach·www 308·가비아 DNS(사용자)·Git 연동(main 자동배포 가드) ② 일일 캡 기본 비활성·
  IP 캡 유지·동의 인앱 모달 최초 1회 ③ /docs 허브(마크다운 10종 SSG·네비·TOC)+랜딩 보강+sitemap/
  robots ④ Actions prebuilt 파이프라인(vercel-deploy.yml). **파이프라인 정착 11차 삽질 로그**(전부
  실측 규명): pnpm 11 CI 하드에러→--config 플래그(로컬 CI=true A/B 재현), vercel pull 실패→신형
  vcp_ 토큰을 CLI 54가 인증 불가(사용자 로컬 58.7.1 실증)→CLI 58.7.1 + Secret 재등록으로 해소.
  Linguist 오버라이드(.gitattributes — 데모·예제 vendored)로 레포 주 언어 Rust 전환. ⚠️ 잔여:
  VERCEL_TOKEN 재발급 권장(채팅 노출분 폐기 — 사용자), Upstash(IP 캡 durable화 — 권장), Pages
  리다이렉트 스텁(설계 완료·컷오버 안정 후), OG/README의 GitHub Pages URL 참조 정리.
- 갱신: 2026-08-06 · Claude(오케스트레이터)+Opus 워커 — **Vercel 이전 준비 완료(f17b511) +
  BYOK 확장성 진단**. ① 데모 AI를 Worker→`/api/hwp-edit` 데모 모드로 포팅(하드닝 전량·max_tokens
  4096=절단 구조 소멸·reason/message 클라 배선 완료). 프리뷰
  https://auto-afprbfull-kwakseongjaes-projects.vercel.app (Vercel Auth 보호, 프로덕션 미승격).
  BYOK 경로 무변경. Pages·build:demo 병행 유지. **컷오버 최대 블로커: Vercel Git 빌드는 wasm
  불가(pkg gitignore+Rust 툴체인) → 권장 = GH Actions prebuilt 배포(deploy-demo 툴체인 재사용)**.
  ⚠️ 비용: 4096 기준 최악 $7.4/일(캡 2000) — $5선 원하면 DAILY_CAP 1300. ⚠️ 키만 넣고
  DEMO_AI_MODE=1 누락 시 BYOK 무인증 공개(.env.example 경고). 사용자 env 목록은 f17b511 보고 참조.
  ② BYOK 진단(읽기 전용): **부분 성립 — 구조 70%·문서 35%**. 텍스트 단발은 provider 무한 실증
  (Anthropic/OpenRouter 동일 조립기·Rust Ollama 기존재), 갭 P0=공식 스니펫이 buildDocContext
  2인자(프로필·그리드 누락 — 문서대로 붙인 호스트가 067 이전 품질로 회귀)·BASE_URL env 부재·
  RAG 슬롯 부재·에이전틱 레퍼런스 Next 전용·reason이 SDK까지 안 옴(onOutcome additive 필요)·
  ai-protocol README 절반 미문서화. 갭 배치는 사용자 승인 대기.
- 갱신: 2026-08-05 · Claude(오케스트레이터)+Opus 워크플로 — **데모 품질 배치(피드백 8건) 커밋
  45ad7fd push·Pages 재배포 중 · ⚠️ Worker 배포만 CF 토큰 만료로 대기**. ① 바이브 다중 셀 실패
  실측 규명: Luna 추론 토큰이 max_tokens 합산 — 1024에서 **간헐** length 절단→전량 드롭+침묵
  (검증자 교차 실측: 구코드도 4/4 성공하는 런 존재 = 간헐성 확정). 수리: 2048+reasoning
  effort=low(env 롤백)+salvage(deny_unknown 유지)+reason/message additive. **워커 미배포 상태 —
  wrangler login 후 deploy 필요.** ② 채팅 소실 실원인=탭 아닌 **접기 언마운트** → display 토글
  보존. ③ 시드 스냅샷(편집 전 새로고침 재개)+"처음부터" — 시드가 편집본 밀어내는 버그 e2e 발견·
  수리. ④ SDK 아이콘 26종 인라인(의존 0)+정렬 4버튼 전부 ≡이던 실버그+찾기 캡슐 겹침 수리.
  ⑤ 데모 툴바 간소화(줌·undo·HTML·PDF — ?toolbar=full 탈출구)+기본 툴바 회귀 e2e+verify에 워커
  vitest 편입. ⑥ README 문구 4건(산출=HTML/PDF/HWPX·hwp 재저장 없음 명시 등). 검증: vitest
  402/235/120·워커 11·e2e 62+2/1skip. 잔여: **wrangler login→worker deploy→다중 셀 실호출 스모크**
  (오늘 이 IP는 재현 테스트로 PER_IP 20 소진 — 429 정상), 빈 제안 reason/message 클라 표시([ui]
  미배선 — 후속), SDK 0.0.5 발행 여부.
- 갱신: 2026-08-05 · Claude(오케스트레이터)+Opus 워크플로 — **README 대개편 배치 출하**(48fd14a
  4커밋 push·deploy success·라이브 /llms.txt 200). 사용자 피드백 10건: ① 라이트 톤 히어로
  (codex 장면+실폰트 워드마크 합성 — 후보 4안 candidates/ 보존) ② 가이드 GIF 3종(엔진·바이브·벌크
  — 라이브 실촬영·자기검증) ③ README 전면(엔진+에디터 구도·자체 서버 뉘앙스·데모/BYOK 분리·React
  포지셔닝 명문화·능력 표 윤문·철학 산문·Apache-2.0+크레딧 — rhwp 귀속은 검증자 지적으로 원저자
  edwardkim 상류 정정) ④ llms.txt+LLM-GUIDE(레시피·함정·0.0.4 대조) ⑤ SELF-HOST(013 Docker 실측·
  Node 스모크 독립 재현·Bun) — 통합 검증 yellow→지적 2건 정정 후 출하. 다음 후보: 히어로 후보
  교체 여부(사용자)·guide-bulk 중간 빈 프레임 개선·B1 줄 델타 오라클 착수·런치.
- 갱신: 2026-08-05 · Claude(오케스트레이터)+Opus 워커 — **로컬 벤치 기여 퍼널 + rhwp 지형 리서치**
  (커밋 없음 — 워킹트리). ① `scripts/bench-local.sh` 신설: `benchmarks/local/`(신규 gitignore,
  README만 추적)에 기여자가 자기 공문서를 넣으면 `layout-check` 전수 스윕 → 판정 5종(일치/줄격차/
  쪽격차/오라클없음/실패) 표 + **이슈 붙여넣기용 마크다운**(수치·구조만, 파일명·본문 제외) 출력.
  `--pipeline`은 `bench-corpus.sh`에 위임(BENCH_ROOT env 신설 + `find -L` — 기존 동작 무변경,
  49건 ALL PASS 재확인). ② CONTRIBUTING "조판 이슈 기여" 절 + `.github/ISSUE_TEMPLATE/layout-gap.md`.
  ③ 실측(오늘): bench-public 25건 = 일치9/줄격차8/쪽격차8, bench-local-2026 24건 = 6/6/12,
  **실패 0**. 포맷별로 갈리는 게 핵심 — `.hwpx` 12건 중 쪽격차 10·셀오라클없음 9 vs `.hwp` 12건 중
  2·1. ④ `docs/research/rhwp-landscape-2026-08.md`: rhwp 최근 고민(각주 예약 #4054·트림 한도 #3798·
  중첩표 #4042/4069·HWPX왕복 #4056·native↔wasm #4046·에이전트 로드맵 #3907) + 메인테이너 공표
  ("조판 축 국소 레버 소진, 상한 +1.8pp — 다음은 세로 공간 계산 재설계", discussions/3582) +
  breakthrough 후보 5(B1 줄 델타 오라클 ★ / B2 HWPX 오라클 공백 지도 / B3 각주 per-page /
  B4 3-way 판정 / B5 격차 지문). **핵심 발견: rhwp가 "저장 줄 좌표 대조가 필요하다"고 이슈에 적어
  둔 도구가 우리 `layout_fidelity`다**(그들 PI 오라클은 문단 시작 쪽만 봐서 줄 어긋남이 침묵).
  위생 후속: `external/rhwp` v0.7.19 → v0.8.x(저장 왕복 대공사) 승급 검토 · native↔wasm SVG
  바이트 게이트 부재.
- 갱신: 2026-08-04 · Claude(오케스트레이터)+Opus 워커 — **새로고침 자동 재개 라이브**(8b358da,
  deploy success — 라이브 dynamic 청크에서 마커 코드 실측). 052 위 재개 레이어: sessionStorage
  마커("auto-hwp:live-doc") 있고 스냅샷 살아 있으면 배너 없이 즉시 재개+시각 토스트 / 명시적
  "문서 닫기"(신설 버튼 — 재개 도입으로 설계상 필수)·새 탭·다른 날은 현행 배너. 마커 제거 4경로
  전수 문서화, pagehide best-effort flush(보장 아님 — 토스트 시각 표기). 함정 실측: StrictMode
  이중 실행이 useRef 1회 가드 태움 → 마커 자체가 유일한 가드(멱등). autosave.ts는 getter +6줄뿐
  (052 계약 무변경). vitest 111/111·e2e 57/1skip(신규 재개 3본). 후속 후보: /bulk 퍼널 지속화.
- 갱신: 2026-07-31 · Claude(오케스트레이터)+Opus 워커 — **라이트 디폴트 + lucide 아이콘 라이브**
  (26883fc, deploy success). 기본 테마 규칙: 저장값 > 무조건 light(OS 무관 — matchMedia 구독 제거).
  lucide-react@1.28.0 앱 전용, 이모지 글리프 24종 교체(SDK 무접촉), 번들 +11.5kB(+0.93%)·공유 청크
  0 증가(트리셰이킹 실측). vitest 98/98·e2e 54/1skip·fresh 방문 light 실측(라이브 포함).
- 갱신: 2026-07-31 · Claude(오케스트레이터)+Opus 워커 — **/bulk 5단계 퍼널 재설계 라이브**
  (f57c420, deploy success — 사용자 UX 피드백 "AI 왕복·export까지가 혼란"). 스테퍼(양식→채울 칸→
  명단→생성·검수→내려받기, 현재만 펼침·완료=요약 칩 복귀·양식 교체 시 정직 무효화), ③ 이중 경로
  분리(기본 붙여넣기→미리보기+매칭 칩 / "AI로 명단 정리하기" 번호 3단계 위저드 — PII 고지 이 자리로,
  실패 정직 거부), ④→⑤ 단방향(진행률→자동 검수→하단 고정 CTA(집계=report 동수)→zip→⑤).
  채움 로직 무변경(파서만 bulkRoster.ts 이동+동치 12테스트). vitest 96/96·e2e 6/6(신규 퍼널 스펙)·
  testid 이동 5건 문서화. BULK-GUIDE 5단계 어휘 정합. 샘플 체험은 스테퍼 시각 전이로 퍼널 학습.
- 갱신: 2026-07-31 · Claude(오케스트레이터)+Opus 워커 — **데모 AI 모델 GLM 5.2 → GPT-5.6 Luna
  교체·배포·실증**(워커 버전 fc416b33). OpenRouter 실측 단가 1/7(~$0.0005/건, 최악 $0.001) →
  DAILY_CAP 1200→**2000 복원**(일 $1.0~2.1 < $5). zdr:true·PER_IP 20·MAX_TOKENS 1024 불변.
  배포 후 실호출 스모크: 200 + 정확한 SetTableCell Intent 반환 — **ZDR 라우팅·CF 출구 리전·Intent
  형식 준수 실증**(Gemini류 리전 차단 없음). 동의 문구·README 한/영 표기 갱신, 단위 테스트에 상류
  model assert 잠금. (이 항목이 07-30자 "82a1a8ca=GLM 5.2 고정" 상태 서술을 대체한다.)
- 갱신: 2026-07-30 · Claude(오케스트레이터)+Opus 워커 — **데모 라이트 모드 + chrome 정리 라이브
  배포**(ce22e95, run 30547121457 success). 사용자 피드백 4건: "정적 데모·AI" 태그·상시 AI 인포
  배너·"편집 모드" 태그 제거, 패널 빈 상태 중앙 정렬 — **첫 호출 동의 게이트는 무손상**(배너 고유
  정보는 동의 문구에 흡수, 프라이버시 계약 유지). 라이트 모드: `--ah-*` 토큰 40여 개(다크=기본·
  light=data-theme), prefers-color-scheme+토글+localStorage, FOUC 0 부트 스크립트, 라이트 에디터는
  hw-studio 탈착으로 SDK 기본 테마 재사용(컴포넌트 무수정), 랜딩·/bulk·/bench 커버. 이미지는 전수
  조사 결과 CSS 처리로 충분(codex 생성 불요). vitest 84/84·e2e 51+신규 테마 2본·라이브 실측 그린.
- 갱신: 2026-07-30 · Claude(오케스트레이터)+Opus 워커 — **런치 준비 3종 완료: Apache-2.0
  단일화·README 전면 압축·npm 0.0.4 발행**. ① 라이선스 MIT OR Apache-2.0→**Apache-2.0 단일**
  (5905efd — LICENSE-MIT 삭제·루트 LICENSE·4패키지 필드·Cargo workspace·NOTICE. 발견: 0.0.1~0.0.3
  tarball엔 라이선스 파일 미동봉이었음→동봉 체계 신설). ② README 359→**176줄**(da0a21b — 바로
  써보기 3트랙 중심·flat-square 배지 3종·§프레임워크 정직 고지(React=완성 UI, 바닐라/Svelte/Vue=
  엔진+헤드리스 가능, 웹컴포넌트=로드맵)·철학은 docs/WHY.md 무손실 이관. **quickstart가 CDN
  기본값으로 wasm 복사 0** — fresh 소비자에서 바이트 동일 코드 실렌더 검증). ③ **0.0.4 발행**
  (f27d185 — 라이선스 정리 릴리스·코드 무변경): 레지스트리 license=**Apache-2.0** 실측·tarball
  내 package/LICENSE 동봉 실측·jsDelivr @0.0.4 200. ④ 데모 AI 모델 확인: 활성 워커 배포
  82a1a8ca=GLM 5.2 고정(wrangler.toml MODEL) — 랜딩 고지와 정합. **런치 전 잔여: 벌크 실물
  100명 1회(사용자)·런치 포스트 초안·(선택) GA4.** 런치 후: 웹컴포넌트 래퍼·075·076·xlsx.
  ① 4패키지 0.0.3 실발행(dry_run→실발행 그린, run 30517644781) — react 의존 `^0.0.3` 실버전,
  CHANGELOG [0.0.3] 확정(파괴 변경 0·Added 3·Fixed 3·자기호스팅 5파일 고지). ② **fresh 스모크**:
  react 단독 설치→전이 해석→import 115 exports→`@auto-hwp/engine/cdn` 기본 URL이
  jsDelivr **@0.0.3 자기 버전 pin**으로 해석 + jsDelivr @0.0.3 wasm 200 실측 — "npm i 한 줄"
  임베드가 레지스트리 실물로 성립. ③ 첫 dry_run 실패는 **W6.1 버전 핀 가드의 정상 작동**
  (cdn.js ENGINE_VERSION 범프 누락을 fail-closed 차단 — d8ff8fa로 정합. 가드 실전 검증됨.
  범프 체크리스트: package.json 4 + cdn.js ENGINE_VERSION + 락 5곳 + examples ^버전).
  ④ 배치 3 Pages 재배포 success(라이브 wasm 7,725,936B — 벌크 워커화·수식 실렌더·080 조판 반영).
  잔여 선택: WASM_BYTES를 발행 실물 크기로 다음 범프 때 정합(경고 전용·현 편차 0.3%).
- 갱신: 2026-07-30 · Claude(오케스트레이터)+Opus 워크플로 — **고도화 배치 3 완주(080+W4.4 ∥
  W6.1/6.2/6.4 ∥ 077 ∥ 073 워커화)**. ① **080 done**: `section_page_breaks` 단일 진실(3조판 경로
  공유 — LOCKSTEP이 규율→구조), 표 호스트 break는 스팬 포함 관계로 하이스트(lift 순서 함정 테스트
  잠금). **발견 축②**: bizinfo 24↔25는 누락 break(−1)×noAdjust 표 과다 예약(+1) 상쇄였음 →
  `Table::fixed_row_heights`(HWPX 파서 전용·.hwp 무영향) 신설, bizinfo-mss 붙임1 **25==25** 게이트
  ③ 추가. 되돌리기 레시피: apply_row_overrides 분기+파서 세팅 2곳(되돌리면 26). 잔여 오차는 흐름
  높이 축=075 이관(최선명 표본 bizinfo-mss__2026-144호 흐름 break 한컴 3 vs 우리 7). ② **W4.4**:
  HWPX 수식 스텁→실렌더 44/44(equation_svg 공개 진입점, verbatim 불변). ③ **W6.1/6.2**: wasm CDN
  기본값(jsDelivr **자기 버전 pin** — latest 금지)+onProgress 702틱 실측+랜딩 prefetch, fresh 소비자
  tarball→jsDelivr 실다운로드 검증(7,718,539B==선언, brotli 2.96MB). ⚠️ 신규 cdn.js는 자기호스팅
  4→5파일(0.0.3+) — 가이드 3곳 정정됨. ④ **077 done(구현)**: WorkspaceMessages+koKR(이관 365건
  누락 0 독립 검증)+DeepPartial 주입+AST 게이트 verify 배선. 잔여: enUS 실브라우저 e2e(랩 셸
  ?lang=en 배선 후 fixme 해제)·fonts.ts 라벨 값단위 allowlist. ⑤ **073 워커화 2단계**: 생성이
  engine worker.js 경유(메인스레드 점유 제거)·검수 SVG lazy·진행률 — e2e 60행 실증. **통합 verify
  green**: --full exit 0·게이트 전종·vitest 761/761·e2e 50/50+skip 1(정직 fixme)·경계 오염 0.
  080 문서의 재현 불가 집계 1문장은 verify 재실측(35건 |오차| 29·정확 19)으로 교정. **다음 결정:
  0.0.3 발행 여부**(CDN 기본값·i18n·진행률이 SDK 변경 — 발행해야 npm 사용자에 도달).
  커밋 c8d1ffb/989d03d/1daf003 push·Pages 재배포**. ① W4.2: 파서 run-provenance→`text_zone`으로
  구조 문단(섹션 첫 문단=제목·개체 문단)의 텍스트 편집 개방 — ops는 창만 splice, 직렬화는
  reemit_paragraph_text_zone(불안전 시 기존 레인 강등), verbatim 골든 불변. Split/Merge는 종전
  거부 유지(경계 이동 미해결 — 후속). ② W4.3: verify에 HWPX 축 게이트 신설(benchmark1.hwpx 쪽수
  22 **회귀 잠금**(참값 아님·075 몫)+줄수 바닥+셀 lineseg FormattingShowcase 5/5·footnote-01 9/9)
  + hwpx 편집 e2e 4종. ③ W2: `/bench` 공개 벤치 페이지(정적 서버 컴포넌트·수치 전부 3cb5a7a 실측
  +재현 커맨드·한계 6항 정직 고지) + docs/BENCHMARK.md 정본. ④ W5.2: README 한/영 GIF(라이브
  실녹화)·quickstart(0.0.2 API 대조)·3열 비교표·HWPX 의무화 카피·AGENTS 34메서드 정정.
  통합 검증 `--full` 그린(게이트 전종 포함 e2e 47/47 — 신규 스펙 어서션 리터럴 1건은 검증자 수정),
  검증자 지적 2건(README /bench 소개 과장·p95 표기 불일치)은 오케스트레이터가 정정 후 커밋.
  ⚠️ 수치 갱신 규율: /bench의 MEASURED_REV(3cb5a7a)와 BENCHMARK.md 기준 커밋은 조판 변경 머지 시
  재실행 출력으로 **함께** 갱신. 다음 후보: W5.5 GeekNews 런치(재료 완성)·W6(CDN·i18n)·076/078/080.
- 갱신: 2026-07-29 · Claude(오케스트레이터)+Opus 워커 — **🚀 W1 출시 절차 완주**. ① 논리 커밋
  15개(C1 `8240acc`~C15 `5fc40cd`) push — Codex 대기분 전체+Opus 배치 1, MM 3파일 hunk 경계 보존,
  modu-startup 실물은 corpus/private 사유화(게이트 6==6은 존재 시 강제·부재 시 정직 skip).
  ② Pages 재배포 라이브 실측: 새 wasm(11:53, 7,718,539B — 구 7,657,643B 교체. ⚠️ 로컬 7,728,658B와
  소폭 차이는 CI 툴체인 차이 추정, 후속 확인 항목), OG/twitter/favicon/가치제안 description 라이브,
  구 모순 카피 부재, /bulk 200. ③ Worker 하드닝 배포(버전 82a1a8ca) + fail-closed 프로브 3/3
  (무Origin 403·비허용 Origin 403·GET 405). ④ **npm 0.0.2 4종 실발행**(dry_run→실발행 그린) +
  fresh 단독 설치 스모크 통과 — **0.0.1 `file:` 결함 공식 종결**. CHANGELOG 날짜 확정.
  잔여 사용자 액션: **0.0.1 deprecate 4종**(로컬 npm E401 — `npm login` 후 deprecate) ·
  OpenRouter 키 회전(선택 — 새 키 실검증 후 구 키 폐기). 다음 배치 후보: W2 /bench(수치만·확정),
  W4.2/W4.3(HWPX 편집 개방·게이트 편입), W5.2 README GIF/비교표, W6(CDN·i18n), GeekNews 런치(W5.5).
- 갱신: 2026-07-29 · Claude(오케스트레이터)+Opus 워커 — **배치 1(승인 불요분) 구현 완료·부분 검증
  그린·`--full` 통합 검증 대기**. 구현: ① W3 벌크 5건 — 샘플 체험 원클릭(`src/lib/bulkFill.ts` 신규,
  데모=인스펙션 위 키 필터라 하드코딩 pin 아님)·drag&drop·MessageChannel yield+행단위 try/catch
  (row_failed·완성분 보존·wasm free 누수 방지)·명단 키↔필드 키 양방향 unmatched 진단(칩 ✓/✕)·PII
  고지, ② W1.3a CHANGELOG.md 신설(0.x 정책+Intent 안정축 구분, 0.0.1 결함 2건 — **신발견: 0.0.1
  wasm은 wasm-opt 미적용 12.29MB 발행**(binaryen 수정 3커밋이 발행 10분 뒤)), ③ W3.5a 073 헤더
  'v1 done·후속 open' 정정+진행표 행, ④ W5.1 OG/twitter/favicon/description(가치제안형)+trailing
  slash 수정, ⑤ **W4.1 HWPX 문단 삽입/분리 끝-append 수리**(serialize.rs 앵커 레인 — placeholder
  2단 구조, 표 src_span 함정 회피, 레드→그린 5테스트+verbatim 골든 불변+파리티 3/3+clippy/fmt 클린).
  검증자(Opus) 판정 yellow→ /bulk canonical 루트 상속 1건은 수리 워커 진행 중. 오케스트레이터가
  serialize.rs·layout.tsx·CHANGELOG·bulk 로직 diff 직접 검수 완료(보고-실물 일치).
  **종결(같은 날 후속): canonical 수리 완료(신규 bulk/layout.tsx — /bulk canonical·og:url 정상화
  실측) 후 `CARGO_BUILD_JOBS=1 PW_PORT=3388 verify-local.sh --full` exit 0 — 게이트
  8==8/18==18/24==24/6==6·파리티 3/3·E2E 43/43 재시도 없이 그린. 배치 1 전체 무회귀 확정.**
  사용자 결정 3건: ① "ㄱㄱ" = W1 출시 절차 일괄 승인(커밋→push→0.0.2 발행→Pages 재배포),
  ② benchmarks/modu-startup 실물은 **corpus/private로 사유화**(공개 커밋 불가 — 테스트/게이트를
  부재-내성 skip으로 전환 작업 진행), ③ /bench 벤치 페이지는 **수치+재현 커맨드만**(원본 비교
  이미지 비공개). + 무명 커밋 플래너가 워킹트리 135항목 → **논리 커밋 15개(C1~C15) 계획** 확정
  (C1=기존 staged 인덱스 그대로, 혼합 파일 4개 식별, CHANGELOG (미커밋) 마커 8곳 치환 목록,
  `__pycache__` gitignore, control-audit.rs 예제는 cfg 가드 부재로 미커밋 유지).
  ⚠️ named 팀메이트 무음 정지 재발(2026-07-29) → 사용자 확정 지시: **tmux·named 팀메이트 금지,
  무명 백그라운드 Agent/Workflow만**. **다음: modu 사유화 완료 → C1~C15 커밋 실행 → push →
  publish dry_run → npm 0.0.2 실발행 → 0.0.1 deprecate → fresh 스모크 → Pages 재배포.**
- 갱신: 2026-07-29 · Claude — **채택 격차 리서치+감사+작업 계획 확정** → 정본
  `docs/ADOPTION-GAP-PLAN-2026-07-29.md` (Fable Workflow 9에이전트: 외부 리서치 2 ∥ 감사 4 →
  매트릭스 19행 → W1~W6 → 완결성 검증 통과. 재실행 `.claude/workflows/adoption-gap-research-plan.js`).
  핵심 판정: 격차는 엔진 부족이 아니라 **미출하** — ①레지스트리 0.0.1은 `file:` 의존 결함(실측)이고
  문서는 미발행 API 안내, ②라이브는 동의 없는 AI 전송+모순 카피(수정본 로컬 완성·미배포),
  ③충실도 게이트 수치가 내부 문서에만, ④벌크(차별화 1축)가 샘플 부재로 체험 불가.
  경쟁 실측: rhwp 3,615★·@rhwp/editor 월 12,646 DL vs 우리 1★·월 116 DL → 정면승부 회피,
  4공백 축(충실도 공개증명·일괄작성·바이브·React SDK) 집중. 엔진 critical 1건 신규 확정:
  HWPX 원본 문단 삽입/Enter 분리 저장 시 섹션 끝 append(문서 순서 파손, serialize.rs 문단 레인 —
  057 표 수리와 동형·미수리, .hwp 전용 게이트라 가려짐) → W4. **다음: W1.1 사용자 일괄 승인**
  (커밋→0.0.2 발행→Worker→Pages) — 승인 전 착수 가능: W1.3 CHANGELOG·W3 벌크 전체·W3.6 PII 고지·W5.1 OG.
- 갱신: 2026-07-29 · Codex — **컴포저블 오픈소스 에디터 셸 + 벌크 랜딩 고도화 로컬 완료
  (미커밋·미push·미배포)**. 기존 `sidePanel(api)` 헤드리스 경계와 `chatSidePanel` 호환은 유지하면서,
  공개 `workspacePanel()`·`WorkspacePanelFrame`을 추가했다. 기본 바이브/디자인 UI는
  `rail | bottom | modal | unstyled` 배치, `tab/open` 제어형·비제어형 상태를 지원하고, 임의 children
  또는 React portal로 워크스페이스 밖 제품 셸에도 같은 `WorkspaceSidePanel` API를 연결할 수 있다.
  벌크 `/bulk` 업로드 전 화면은 4단계 흐름·로컬 처리 설명·양식→N개 HWPX→zip 비주얼·집중형 업로드
  surface로 재설계했다. README/영문 README에는 생성형 구조 일러스트
  `docs/assets/composable-editor-shells.png`와 실제 Browser Harness 캡처
  `docs/assets/bulk-studio-home.png`를 추가했고, EMBED 가이드에 프리셋·제어 상태·portal 조립법을
  문서화했다. 실제 Chrome에서 홈·벌크·8쪽 샘플 에디터(다크 캔버스, `hw-sidepanel-rail`,
  바이브/디자인 탭, 개발 오류 없음)를 확인했다.
  **최종 증거**: `CARGO_BUILD_JOBS=1 PW_PORT=3288 scripts/verify-local.sh --full` 전부 그린 —
  fmt·clippy·전체 Rust/unit/doc/feature, 쪽수 **8==8/18==18/24==24/6==6**, wasm 7,728,658B
  재빌드·cargo-deny, 캐럿 page-local 1825/1825·rect→hit 431/431·p95 0.106ms, Vitest
  **225/51/369/53**, Chromium E2E **42/42 재시도 없이 PASS**. 이미지 생성은 built-in imagegen,
  실제 UI 캡처는 Browser Harness를 사용했다. 마지막 커밋/배포 상태는 변경하지 않았다.
- 갱신: 2026-07-28 · Codex — **모두의창업 실물 충실도 + Figma식 웹 편집 최종 로컬 완료
  (미커밋·미push·미배포)**. hwp-lab은 다크 스튜디오 홈/편집 화면과 한 줄 전역 문서 도구를 쓰며,
  우측은 기본 `바이브 편집` → 문단·셀·범위 선택 시 `디자인` inspector 자동 전환, 좁은 창에서는
  overlay/collapse로 종이를 보존한다. 텍스트 편집은 own-render SVG 위치를 유지하는 엔진 캐럿이며
  틴트·셀 팔레트를 제거했다. 단순 캐럿의 디자인 변경은 문단/셀 전체 run 보존, 실제 글자 범위는 그
  범위만 토글한다. Escape는 캐럿→요소 선택 순서의 2단계 해제다. 중앙정렬 시트가 가로 overflow로
  바뀌는 줌 경계도 실제 sheet anchor 재측정으로 커서 고정 ±2px를 복구했다.
  `모두의창업` 원본은 CSS 그라데이션이 아니라 borderFill 10/11의 **1949×35 래스터 2장**이고,
  제목 앞 빈 문단은 source line height 1500 + gap 900이다. HWP lift가 cell image brush와 이 빈
  spacer metrics를 보존하고 render가 셀 배경 이미지를 테두리/글자 아래에 그리도록 수정했다. 적용은
  image-fill 장식 양식의 진짜 빈 문단으로 한정해 기존 문서 회귀를 막았다. HWP/PDF를
  `corpus/private/modu-startup/`(로컬 전용 — 공개 커밋 불가)에 두고 `scripts/compare-modu-startup.sh`와
  `modu_startup_fidelity.rs`를 추가했다. 상용 H2hdrM/HYwulB/HCRDotum/Malgun Gothic 자체는
  재배포하지 않으며 OFL 명조/고딕·실제 bold 대체라 글리프 메트릭의 미세 차이는 남는다.
  **최종 증거**: `CARGO_BUILD_JOBS=1 PW_PORT=3288 scripts/verify-local.sh --full` 전부 그린 —
  fmt·clippy·전체 Rust/unit/doc/feature, 쪽수 **8==8/18==18/24==24/6==6**, wasm 7,728,658B
  재빌드·cargo-deny, 캐럿 page-local 1825/1825·rect→hit 431/431·p95 0.081ms, Vitest
  **225/51/368/53**, Chromium E2E **42/42 재시도 없이 PASS**. `git diff --check` PASS,
  `external/` 무변경, 비교 스크립트 HWP/PDF 체크섬·6쪽·page2 양쪽 산출 PASS.
- 갱신: 2026-07-28 · Codex — **Figma식 수동 디자인/원위치 엔진 캐럿 로컬 구현 완료
  (미커밋·미push·미배포)**. hwp-lab은 전체 박스를 덮는 좌측정렬 contentEditable 대신 own-render SVG를
  유지하는 글리프 캐럿을 사용하며, 편집 중 셀 색상 팔레트는 숨긴다. 우측 레일에 `바이브 편집/디자인`
  탭을 추가해 선택한 문단·셀·범위의 X/Y/W/H, 서체, 크기, 굵게/기울임, 글자색, 셀 배경·정렬을 표시·
  수정한다. 문단 변경은 run 보존 `SetParagraphRuns`, 셀/범위는 기존 `SetCellRangeFmt/Shade` 계약을
  재사용한다. SDK는 `preferEngineCaretEditing=false` 기본과 optional inspector API로 호환 유지.
  React **47파일/364테스트**, hwp-lab **6파일/53테스트**, 양쪽 production build, `git diff --check`
  PASS. Browser Harness는 Chrome 미실행·연결 0이라 localhost 육안 QA와 새 UX 기준 Playwright E2E
  이행/`verify-local --full`은 대기한다. 재개 시 Chrome 실행+remote debugging 허용 후 실제 모두의창업
  문서에서 제목 원위치 편집·디자인 탭·폰트/색/정렬·팔레트 미노출을 먼저 확인한다.
- 갱신: 2026-07-28 · Codex — **sol medium 재개 · 로컬 구현/패키징 전체 검증 완료
  (미커밋·미push·미릴리스, 외부 Secret/키/워크플로 무변경)**.
  W1 완료: 셀 lineseg 재귀 게이트(benchmark 261/261, b1 826/839·±1 839/839, b2
  1042/1059·±1 1059/1059) + 실제 좌우 cell/table inMargin을 조판·그리기·캐럿에 단일 적용.
  페이지 게이트 8==8/18==18/24==24, 한컴저작 HWPX 5종 전부 ±1쪽. bizinfo 24↔25 잔여는
  table-host `pageBreak` 보존 문제로 080 분리.
  W2 완료: 같은 문단/셀 마우스 드래그 범위, plain-text paste(단일 Set*Runs·undo 1회), 048의
  physical pointer-up/async stale-gesture race 수정. editor-core 225·React 358, 048 repeat 10/10,
  cell paste E2E 2/2. 문단 넘는 선택은 076, 구조적 multiline paste는 atomic op 전까지 이연.
  W3 완료: 본문 캐럿 정본 API·revision-keyed placed-doc cache·페이지 visual-affinity. 563 band,
  page-local 1825/1825, rect→hit 431/431, p95 0.096ms; session 5·MCP 52·파리티 3/3·viewer check·wasm
  재빌드 통과. 릴리스 보안 리뷰에서 공개 데모의 제3자 문맥 전송 무고지와 unbounded
  anchor/config fail-open을 P0로 확인 → 첫 호출 동의·정확한 README, known-field/128KiB/8KiB caps,
  fail-closed CORS/limits, R5 fence escape, OpenRouter `zdr:true`, Worker 단위 테스트를 추가함.
  패키징 보완도 완료: consumer lock 0.0.2 정합, fresh `vendor/` 생성, publish auth fail-fast +
  부분발행 resume, Worker `npm ci`·Vitest 5/5.
  **전체 검증 증거**: `verify-local --full`의 fmt·clippy·workspace/unit/doc/feature tests·8==8/18==18/
  24==24·wasm check/rebuild·cargo-deny·JS build·Vitest 225/51/358/53 전부 PASS. 캐럿 교차검증
  page-local 1825/1825·rect→hit 431/431, p95 0.155ms. 첫 E2E에서 W2 최신-pointer-up 계약과 충돌한
  구식 무대기 격자 스캐너 5실패·6 flaky를 발견해, 표 선택 settle→셀 드릴 settle→편집/캐럿을 공유하는
  `e2e/cell-gesture.ts`로 8개 스펙을 통일했다. 실패 5파일 12/12, 잔여 flaky 3파일 repeat 14/14,
  최종 전체 E2E **44/44 재시도 없이 PASS**. 최초 샌드박스 포트 EPERM과 고아 Next 재사용은 코드
  실패가 아니며 정확히 식별한 검증 프로세스만 정리함.
  그 뒤 의존성 보안 고도화도 적용했다: Vite 7.3.6·plugin-react 4.7.0, Vitest 4.1.10, Next
  15.5.22, Wrangler 4.114.0으로 올렸고 6개 JS workspace audit 0, Vitest 225/51/358/53/5,
  React Vite·Next production build, Worker typecheck/dry-run을 통과했다. 4패키지 0.0.2 pack과 fresh
  Vite 소비자 install/build/audit 0도 통과. Vite 예제의 누락된 `chatSidePanel()`을 호스트
  `App.tsx`에 명시적으로 연결해 published-tarball E2E **1/1 PASS**(8쪽 렌더→셀 마킹→mock
  SetTableCell 적용→undo)로 복구했다. 4패키지를 재pack한 완전 새 temp 소비자에서도
  install 79패키지·Vite production build·audit 0·동일 E2E **1/1 PASS**를 재현했다.
  여섯 JS workspace audit도 모두 0. 최종 `CARGO_BUILD_JOBS=1 PW_PORT=3288
  scripts/verify-local.sh --full`은 fmt·clippy·전체 Rust/unit/doc/feature·게이트 8/18/24·wasm
  rebuild·cargo-deny·JS build·Vitest 225/51/358/53·E2E **44/44** 전부 PASS. 본문 캐럿은
  page-local 1825/1825·rect→hit 431/431·p95 0.086ms. 최초 병렬 cargo는 hwp-viewer rustc 두 개가
  CPU 0/linker 없음으로 5분 정지해 중단했으며 단일 job 동일 스크립트는 완주했다.
  완료 감사에서 `git diff --check` PASS·`external/` 무변경을 확인했고, Vite 7 예제의 Node 선언도
  `>=20.19`로 교정 후 build+E2E 1/1 PASS. W1 11파일은 첫 논리 커밋으로 **staged**했으나 commit은
  명시적 사용자 승인 부재로 안전 심사에서 거부되어 우회하지 않았다. 따라서 HEAD/origin은 여전히
  `c49d829`, npm 네 패키지는 모두 0.0.1뿐이고, Worker/Pages 마지막 배포는 2026-07-25다.
  추가 패키징 실패 주입에서 기존 React prepack이 npm cache 오류 뒤 `postpack`을 못 타 source manifest를
  `^0.0.2`로 남기는 결함을 발견했다. direct pack/publish는 fail-closed하고, 새 safe wrapper가
  build→실버전 치환→`--ignore-scripts` pack/publish→`finally` file: 복원을 소유하도록 교체했다.
  성공/의도적 ENOENT 실패 모두 manifest SHA 불변, `publish:safe --dry-run`, pack-deps, 소비자 E2E 1/1,
  `actionlint` 전부 PASS. Vite 예제 lock은 최초 설계부터 의도적 ignore(재생성 tarball integrity)로 유지.
  라이브 Pages는 구 문구("AI…곧")와 wasm **7,657,643 bytes**를 서빙(200)하며 새 wasm은
  **7,725,724 bytes**다. 다음은 사용자에게 commit/push/외부 출시 승인을 받은 뒤 논리 커밋→push→
  publish dry-run→npm 0.0.2 실제 발행→fresh registry smoke→hardened Worker→Pages 순으로 출시한다.
  키 회전은 새 키 실검증 후에만 구 키를 폐기한다.
- 갱신: 2026-07-26 · Claude — **074 done(047fc14) + 캐럿 심화(26c0de5)**.
  ⚠️ **074 전제 정정**: 내가 근거로 삼은 "오라클 25쪽"은 인공물(H2Orestart 가 NARROWLY 를 가로로 읽어
  본문 높이 반토막 — PDF MediaBox 841×595). 오라클 지표는 **세로 렌더 확인 후에만** 쓸 것.
  그럼에도 과소계산은 실재: ①본문상자에서 머리말/꼬리말/제본여백 누락(한컴 규칙 top+header — lineseg
  실측 71891 이 근거) ②세로 병합셀 높이 균등분배(짧은 행 부풀림 → 쪽 낭비) ③ragged 표를 균일격자로
  가정(Cell::width 도입) ④stored_row_heights 바닥 미적용. **총량 오차 0.08%** — 높이 모델은 이미
  정확했고 갭은 전부 패킹 낭비였다. pps 표본 3→4쪽=오라클 일치.
  부수: 열너비 드래그가 Cell::width 때문에 화면 미반영이던 실버그 수정(geometry_edited 단일 판정).
  LOCKSTEP 구조 보장(place::row_heights → table_row_heights 위임) → benchmark2 가 place_doc 25 vs
  NaiveLayout 24 로 갈려 있던 것이 24 로 정렬(한컴도 24) → e2e PAGES=25 기대값을 근거와 함께 24 로.
  캐럿: **범위선택({anchor,focus}·⌘B 부분서식)** + **Enter 문단분리/병합**(새 op SplitParagraph/
  MergeParagraph — AI 화이트리스트 비공개, 수동 편집 전용). 빈 문단 캐럿도 열림.
  검증: 게이트 8==8/18==18/24==24 불변 · 파리티 22==22 · vitest 219/352 · **e2e 43/43**.
  남은 것: 셀 안 줄바꿈 게이트 부재(24×13 표 한컴2줄 vs 우리4줄) · bizinfo-mss 24 vs 28 ·
  format-ribbon-048 flaky(베이스라인부터·커밋/리프레시 레이스) · 문단 넘는 범위선택 · 드래그 선택.
- 갱신: 2026-07-25(3) · Claude — **남은 축 3종 병렬 완료**(e0b38f5/9229604/80484b6).
  ① **본문 글자 캐럿 열림**: rhwp 히트테스트 경로는 좌표계가 화면과 달라 못 쓴다고 판정 →
  packages 표면 3개(hitTest 밴드 + pageSvg 글리프 + blockRuns)로 우회. 렌더 규약(글리프1=text1,
  공백생략) 기반 1:1 정렬 **382밴드 중 379(99.2%)**, 클릭→오프셋 1516/1516 정확. 클릭·좌우·상하·
  타이핑·백스페이스·IME 동작. ⚠️ 안 되는 것: Enter 문단분리(InsertParagraphAt 필요)·Shift 범위선택
  (단일 오프셋 모델 — 셀도 동일)·빈문단·페이지경계 분할문단(캐럿 미제공=틀린자리 방지).
  정본은 엔진의 body_text_hit/body_caret_rect(053 셀 함수 쌍둥이) — 그때 레이어 교체.
  ② **수식·필드 회수**: 수식이 렌더에서 완전 소실이던 것 → 박스 0→44, 쪽수 2→3(=.hwp 쌍둥이).
  하이퍼링크 필드쌍 0/0→1/1. ⚠️ 함정 잡음: project_block 이 수식 문단의 **텍스트를 버리던 것**
  (HWPX 는 수식을 텍스트 옆 run 에 둔다). 차트는 근거 부재로 기각(코퍼스 0건·렌더러가 rhwp 안).
  ③ **074 신설**: hwpx 입력 쪽수 **20~25% 과소 계산**을 오라클로 확정(benchmark1 .hwpx 25 vs 우리
  20, 한컴저작 4 vs 3). IR 은 파리티가 rhwp 와 일치 확인 → **조판 축**. 가설 4종·재현법 기록.
- 갱신: 2026-07-25(2) · Claude — **정적 데모 AI 라이브 배포 완료**: 워커(autohwp-demo-ai.gkffhdnls13.workers.dev)
  배포+시크릿+레포변수+Pages 재배포까지. ⚠ 모델은 **GLM 5.2로 확정**(Gemini Flash-Lite는 Cloudflare Worker
  출구 리전을 구글이 지역 차단 "not available in your region" — 실배포에서 발견). GLM 요청당 ~$0.0038이라
  DAILY_CAP 2000→**1200**(≈$4.6<$5)으로 하향. 워커 실호출 검증(Replace intent 반환). 사용자 액션 잔여:
  OpenRouter 키에 월 지출한도 설정 권장(현재 limit null) + 노출 키 회전(선택).
- 갱신: 2026-07-25(2) · Claude — **세 축 병렬 완료**(59f784e/0844e4d/ca664af/79b81dd/8142b83).
  ① **HWPX 파서**: .hwp는 rhwp(성숙), .hwpx는 자체 1,605줄 파서라 갈렸다. 값기준 dedup이라 안 읽는
  속성이 많을수록 charPr이 뭉갠다(214→87). 장평·자간·스크립트별글꼴·줄간격종류·쪽나눔 읽기 복원 +
  구조갭 3종(섹션 spine 순서·머리말/각주 본문 누출·표 세로 이중오차) → **조판이 rhwp와 301줄 완전
  일치**(전 368). ⚠️ 트레이드오프: 코퍼스 한컴쪽수 대비 불일치 22→25(가려져 있던 기존 갭이 드러남 —
  되돌리려면 outMargin+is_table_anchor 두 지점을 **함께**). `hwpx_rhwp_parity.rs` = 입력을 잠그는 오라클.
  ⚠️ 당시 **`layout-check <f>.hwpx`는 우리 파서를 안 탔다**. 2026-07-28 배치에서 production HWPX
  parser→own layout vs rhwp lineseg 경로로 교정됨(정규화본 cache 부재는 missing-oracle로 별도 보고).
  ② **에디터**: 채팅 UI를 SDK에서 분리 — `WorkspaceSidePanel` 슬롯(13값), 호스트가 패널 조립.
  `chatSidePanel()`은 참조 배선(제품 계약 아님). + ⌘Z/⌘⇧Z/⌘Y·⌘C(TSV) 키보드 기본기.
  ③ **문서**: 능력 중심 재구성(README 한/영 11섹션 1:1) + CLI-GUIDE·BULK-GUIDE 신설 + FIGMA-GRADE-UX
  스테일 경고(9종이 이미 구현됨 — 재기획 사고 방지) + 6월자 6종 격리.
  잔여: 본문 글자 캐럿·범위선택(엔진 축)·⌘V·수식/차트/필드 노드화·변환 hwpx 쪽수 과소계산 갭.
- 갱신: 2026-07-25 · Claude — **정적 데모 AI(OpenRouter) 붙임**: 정적 사이트는 키를 못 담으므로 키를 쥔
  Cloudflare Worker 프록시(`services/demo-ai-proxy`) 경유. 모델 **Gemini 3.5 Flash-Lite**(입력 위주 작업
  최저가·요청당 ~$0.002 → $5/일에 8배 여유) 서버 고정, IP별+전체 일일 한도로 비용 상한 강제, CORS 잠금,
  프롬프트는 워커가 ai-protocol로 조립(앱과 한 계약·남용 저항). 클라 데모 분기가 `NEXT_PUBLIC_DEMO_AI_URL`
  있으면 단발 위임(스트리밍/웹검색 off — 비용 최소). 워커 단위검증 10/10·브라우저 실증(채팅→제안 카드·429
  정직 안내). ⚠ 배포는 사용자 액션: wrangler login→KV 생성→`secret put OPENROUTER_API_KEY`→deploy→URL을
  데모 빌드 env(`NEXT_PUBLIC_DEMO_AI_URL`)로. 키 없이 진행(내 쪽 과금 0).
- 갱신: 2026-07-23(9) · Claude — **정적 데모 로컬 작업 루프 + 홈 개선**: `npm run dev:demo`(DEMO_STATIC=1
  핫리로드 :3311) / `npm run preview:demo`(실제 export 산출물 :3312) — **배포 없이 로컬에서 수정·확인**.
  홈: 랜딩 헤더 제거(문서 열면 복귀 — ⚠ hidden 속성은 display:flex에 밀림, 조건부 렌더로), 캐럿 18→14px·
  부드러운 점멸(+reduced-motion), 지표 배지 3종 제거, 할 수 있는 일 2갈래 카드(문서 편집 / 양식 일괄 작성),
  랜딩 파일 입력 .hwp 전용(+.hwpx 알파 고지), 4개 소개 문구 자연어 재작성(이모지·비문 제거).
  용어: "벌크 채움" → **"양식 일괄 작성"**(랜딩·/bulk 헤더 — URL은 /bulk 유지).
- 갱신: 2026-07-23(8) · Claude — **.hwp 변환 리플로 원인 1호 수정**(사용자 실양식 모두의창업 .hwp):
  pagePr landscape 토큰 직관 매핑이 OWPML 실관례와 반전(세로=WIDELY가 옳음 — 실물 26/29 실측) →
  외부 리더(한글/LibreOffice)에서 가로 렌더·2쪽→6쪽. synth.rs 스왑+hwp-core 테스트 갱신. 오라클
  실측 6→2쪽 복원. verify quick 그린·e2e bulk 통과. ⚠ npm 0.0.2 발행 시 반영 필요. 잔여: 문단번호
  아티팩트·신청서 +1쪽 축·라틴 어간.
- 갱신: 2026-07-23(7) · Claude — **073 실사용 피드백 반영**: .hwp 양식 업로드 시 변환 리플로(쪽나눔·너비)
  정직 고지 + ".hwpx로 저장한 양식 권장" 배너 / HWPX면 바이트 보존 배지. 포맷 답: hwpx→hwpx 지원·
  hwp→hwp 불가(저장은 HWPX 단일 — 우회: 한글에서 .hwp 재저장). 073에 실사용 리포트 절 추가.
  잔여 충실도 축 = .hwp 변환(F2 계보) + 웹 렌더 라틴 근사.
- 갱신: 2026-07-23(6) · Claude — **073 3단계 온보딩(그래서-어쩌라는-거지 해소)**: ① "AI 프롬프트 복사" —
  사용자 정의 필드·규정(타입/필수) 그대로 담긴 프롬프트를 아무 AI에 원본 자료와 붙여넣으면 우리 "키: 값"
  형식 명단이 나옴(채움은 계속 결정론) ② "형식 예시 넣기"(필드 스켈레톤 자동) ③ 키 칩 스트립+동적
  placeholder+2단계 하단 다리 문구. 버튼명 "완성본 만들기+검증". e2e 온보딩 어서션 추가.
- 갱신: 2026-07-23(5) · Claude — **073 스튜디오 매끄러움+다크 UI**: 호버 셀 미리보기(ref 직접 스타일 —
  마우스무브 리렌더 0)·오버레이↔카드 양방향 선택 동기화(스크롤 추적)·이름 인라인 편집 포커스 버그 수정
  (⚠ 이름을 React key로 쓰면 키스트로크마다 리마운트 — 안정 id 도입)·중복 이름 생성 전 거부. UI 전면
  다크 브랜드(스텝 칩 스티키 헤더·그라데이션 액센트·문서 화이트 카드). e2e 43 유지.
- 갱신: 2026-07-23(4) · Claude — **073 필드 스튜디오**(사용자 방향 "영역 지정→네이밍→규정→규격화"):
  /bulk 2단계 = 문서 클릭 영역 지정(결정론 히트테스트)·이름 편집·형식 규정(날짜/전화/사업자/금액+필수)·
  규격 저장/불러오기(.fillmap.json + sha256 지문). 명단 4형식 자동 감지(CSV/TSV/"키: 값" txt/JSON +
  EUC-KR 폴백). 형식 위반·필수 누락 = 검수 보고(조용한 통과 금지). e2e bulk-fill-073 잠금(43번째).
  LLM/BYOK는 선택 보조 설계만(다음 배치 — 핵심 경로는 결정론 유지).
- 갱신: 2026-07-23(3) · Claude — **073 웹 테스트 환경 /bulk 완성 — 라이브 검증 통과**(https://kwakseongjae.github.io/auto-hwp/bulk 실브라우저 드라이브: 업로드→7필드→생성→캐러셀→zip·에러 0. 로컬 레포 d3d8c91 동기화 완료): 업로드→자동 인스펙션(fill-map 검수 표 —
  중복 배지·pin·예시값·필수 토글)→명단(CSV/JSON 붙여넣기)→생성+재개봉 검증→**검수 캐러셀**(실렌더+채운 셀
  하이라이트+이전값 취소선)→STORE zip(+report.json, 의존성 0). **전 과정 결정론·LLM 0콜·100% 클라이언트**
  (정적 데모에서도 동작). 실브라우저 드라이브 실증(7필드 유도·3명 채움·캐러셀·zip 다운로드·에러 0).
  함정 수정: 프로필 표 캡(20)이 인스펙션·검증을 누락시킴 → blocksInRect 전 표 열거로 통일(거짓 value_not_found 해소).
- 갱신: 2026-07-23(2) · Claude — **073 v1 구현 완료(커밋)**: `auto-hwp inspect`(fill-map 초안 유도) +
  `auto-hwp fill`(pin 결정론 적용 → 재개봉 검증(값+쪽수 기준선) → zip+report.json, --strict 분기).
  실물 E2E 5명·유닛 3·clippy·게이트 8==8. 리서치 확정: fillmap.v1(pin 2단·한글 키·3단 누락 정책)·검수
  3층 UI+인문서 하이라이트(목업 전달). ⚠️ 로컬 Desktop 세션 권한 차단 지속 — 스크래치 클론으로 작업,
  로컬 레포는 사용자 권한 복구 후 `git pull` 필요. 잔여: 검수 UI(hwp-lab)·XLSX·실 100명 파일럿.
- 갱신: 2026-07-23 · Claude — **073 벌크 채움 타당성 완료**(PoC+생태계 조사, `docs/issues/073-bulk-fill.md`).
  실물 신청서 3인분 채움 60ms/부·zip·재검증 OK. **HWPX 템플릿=프로덕션급**(바이트동일·쪽수불변) /
  .hwp 템플릿=변환 리플로 축 잔여. 생태계 공백지대 확인(무한컴+.hwp무훼손+벌크+MCP 완비물 없음).
  권고=같은 레포 새 표면(`auto-hwp fill` v1) — **스코프 승인 대기**.
- 갱신: 2026-07-22(15) · Claude — **임팩트 배치**: README 한/영 why-서사 재작성(AI 인식 3성질) + 배너 v2(실렌더
  합성) + 데모 랜딩 다크 브랜드 리디자인(.lab-demo 스코프 — 에디터 크롬 무접촉). tsc·vitest 50 그린, 데모 프리뷰
  스크린샷 3회 반복 검증. 랜딩 프리뷰는 DEMO_STATIC=1 dev 기동(함정).
- 갱신: 2026-07-22(14) · Claude — **CI wasm 다이어트 근본 해소**(77b2ae6): apt binaryen 108→공식 119 고정 —
  재배포 라이브 실측 **11.13→7.30MB(-34%)**, 로그 "wasm-opt 적용 7478KB". README "발행 전"→npm i 커맨드 반영.
  다음 발행(0.0.2)부터 레지스트리도 자동 적용. 잔여 사용자 액션: 노출 NPM 토큰 폐기·재발급.
- 갱신: 2026-07-22(13) · Claude — **npm 첫 발행 완료**: `@auto-hwp/{engine,editor-core,ai-protocol,react}` 0.0.1
  퍼블릭 레지스트리 라이브(발행 CI success + 신선 `npm i` 스모크: ai-protocol 프로필 렌더·whitelist 19·wasm 동봉).
  잔여: ①발행 wasm 11.6MB(CI binaryen 부재 — 0.0.2 전 publish.yml에 설치 스텝) ②노출 토큰 폐기·재발급(사용자).
  README의 "발행 전" 문구 → 발행됨으로 갱신 필요(다음 배치).
- 갱신: 2026-07-22(12) · Claude — **전면 리브랜딩: tf-hwp → auto-hwp (오토한글)**(e41efa0). 컨셉 정본 = "AI와
  함께 한 화면을 보면서 작성하는 한글". ① GitHub 레포 `kwakseongjae/auto-hwp` 리네임(구 URL 리다이렉트)
  ② 소스 204파일 치환(@auto-hwp 스코프·auto-hwp-cli/바이너리·AUTO_HWP_* — JOURNAL/history는 역사 보존)
  ③ 배너 `assets/brand/autohwp-banner.png`(타이포+AI 캐럿, banner.html+shot.mjs 재생성) — README 한/영 히어로
  ④ 데모 헤더/타이틀 오토한글. 검증: 게이트 8==8/18==18 · vitest 321/50 · **e2e 42/42**. ⚠️ 함정: 타 프로젝트가
  3100 선점 시 reuseExistingServer 가 엉뚱한 앱 테스트 → `PW_PORT` 손잡이(구 타임아웃 전부 이 원인 — 리네임 무결).
- 갱신: 2026-07-22(11) · Claude — **잔여 마감 + 문서 정리**(fbe7e0d). ① **MCP 신선 설치 실검증**: 퍼블릭 레포
  `cargo install --git` → 서브모듈 클론→빌드→핸드셰이크→.hwp 열기 완주(가이드 레시피 실증 — 단 원격 HEAD 기준).
  ② **fetch-gov-corpus.mjs**: GOV-SOURCES 재현 스크립트, 빈 디렉토리 실검증 7/7. ③ README 한/영 재정리(문서
  프로필·19종·위치 보기·실물 49종+130p 실측·서체 절)+EMBED-GUIDE 카탈로그 온디맨드 절. ④ **npm 실발행 블로킹
  = 사용자 액션**: NPM_TOKEN 시크릿 없음+로컬 npm 미인증 — npmjs 토큰 발급→`gh secret set NPM_TOKEN`→
  publish.yml dry_run=false (또는 npm login 후 로컬 발행). ⚠️ **로컬 13커밋 미푸시**(원격=4568a39) — 데모/설치
  레시피 반영엔 push 필요(명시 승인 대기).
- 갱신: 2026-07-22(10) · Claude — **잔여 배포 표면 일괄 처리**. ① **MCP 포장 done(757a240, 승인분)**: hwp-mcp
  stdio 바이너리 완동 실증(initialize·15도구·open→8쪽→텍스트) + docs/MCP-GUIDE.md + README 한/영 절 — 공용 서버 0.
  ② **Claude Code 스킬 신설**: skills/hwp/SKILL.md(CLI 래핑 — 변환·추출·미리보기·편집 팔레트+정직 고지). ③ **npm
  publish dry_run 성공**(run 29896883076) — 실발행은 dry_run=false 승인 대기. ④ **KOGL 25건 전수 실측**: 0/1유형
  8건·4유형 2건·불명 15건 → 바이너리 재배포 대신 `corpus/GOV-SOURCES.md`(검증 7건 URL+sha256) 공개 — korea.kr
  "텍스트 한정" 정책+전건 임베드 이미지라 제3자 이미지 리스크 회피. private manifest 판정 정정.
- 갱신: 2026-07-22(9) · Claude — **072 위치 보기 + wasm 다이어트 + 플레이키 격리 완료**(4adc541). ① 072: AI 카드
  "⊙ 위치 보기"→blocksInRect 스캔→jumpToPage+1.8s 플래시. ② wasm **11.26→8.07MB**(-28%, 전용 [profile.wasm-size]
  opt-z·fat LTO·cgu1 — 정본 3경로 전환. 트레이드오프: 편집 20→27ms@18p, 워커라 체감 무해). ③ 048/039 플레이키:
  자동 기본폰트 등록 토스트 silent화(.hw-status 슬롯 경합 제거)+retries:1 안전망 → **전체 e2e 42/42**(재시도 0). react 321.
- 갱신: 2026-07-22(8) · Claude — **rhwp v0.7.19 재벤더링(fa72e42) + 폰트 카탈로그 온디맨드 제공 구현**.
  ① 062 needsExternal 해소(미러에 upstream 태그 푸시, lift.rs BinDataBytes .load() 적응) — 게이트/벤치 49/49 불변,
  ⚠️ wasm 9.5→11.0MB(+1.5MB upstream 성장). ② 폰트 제공(진단 U8/보강 G): explicit-family bypass(has_family →
  place.rs display_font → pdf.rs EmbedFont.extra per-family 임베드) + HwpWorkspace.ensureCatalogFont(리본/AI 지정 시
  fetch→registerFont→@font-face) — **카탈로그 8종(전부 OFL: Pretendard·Noto Sans/Serif KR·나눔·IBM Plex·고운) 화면·PDF
  실서체 반영**. e2e 41~42/42(048 순서 플레이키 — 격리 그린, 039 계열). 072(카드 위치 보기) 설계 이슈 신설.
- 갱신: 2026-07-22(7) · Claude — **071 undo 메모리 버짓 구현 완료**. 070의 첫 병목(130p 스냅샷 딥카피 ~8MB×50
  = RSS +403MB) 해소: 직렬화 스냅샷은 round-trip/rhwp 노드 훼손으로 **기각**, `SemanticDoc::approx_heap_bytes`
  추정기 + `EditSession::with_budget`(단일 push 경로·바닥 4) + 라이브 레인 **128MiB 버짓**. 실측: 130p RSS
  +403→**+0.1MB**·깊이 50→10 정직 축소, **18p 실물 깊이 50 무회귀**. 게이트 8==8/18==18 · workspace 56 스위트 ·
  vitest 170/320/50 · e2e 42/42 · wasm 재빌드.
- 갱신(6): 2026-07-22 · Claude — **070 대형 문서 실측 완료(보강 F)**. 실 wasm 사다리(8~130p, 실물 4+합성 2):
  편집→화면 **~1ms/쪽 선형**(41p 실물 16ms·130p 136ms, 워커 비차단) → **증분 조판 보류**(재평가 임계 150p+ 실물).
  **첫 병목 = undo 스냅샷 딥카피**(130p·편집50회 RSS +403MB vs 직렬화 0.2MB) → HWPX-바이트 스냅샷 전환이
  ~40배 절감 후속 후보. 벤치 재실행: `node packages/engine/bench/large-doc-bench.mjs`(--synth 지원).
- 갱신(5): 2026-07-22 · Claude — **진단 보강 B+E 구현 완료**. B(fb1268a): AI 화이트리스트 **15→19**
  (Replace·SetCharFmt·SetTableColWidths·SetPageMargins — FOOTER 스탠자·describeIntent 구체 카드·mock Replace
  분기. SetRunCharFmt/SetTableRowHeights는 보수적 폐쇄 유지). **실 Grok 마킹0 실증**: "전부 바꿔줘"→
  Replace{all:true} 카드. E: PDF 스텁 경고 토스트(docProfile 수식/차트 카운트 재사용)+**HWPX 다운로드 버튼**
  (toHwpx 사용자 노출)+README 한/영 "알려진 제약" 절. vitest 47/170/320/50 · **e2e 42/42**.
- 갱신(4): 2026-07-22 · Claude — **069 해소 + 067/진단 커밋 완료**(87834a2 feat 067 · a6cfaf0 docs 진단/068/069).
  069 근본 = **드릴 모델(59fef4f) 미정렬 e2e 3스펙**(048·050·052 — 당시 5스펙만 정렬, 이 3개 누락. 그립 인터셉트는
  표면화 경로). 제품 동작 정상 판정 → 테스트를 드릴로 정렬(표 마킹→500ms→더블클릭 드릴, page.mouse 절대좌표)
  → **전체 e2e 42/42 그린**. 039 간헐 플레이키 1회는 아래 "알려진 flaky"로 추적.
- 갱신(3): 2026-07-22 · Claude — **067 문서 프로필 구현·검증 완료**. `hwp_session::doc_profile`(순수 모델
  walk: 제목후보·구성카운트·헤딩·표 인벤토리[s/b]·to_markdown 발췌) → wasm `docProfile` → adapter optional →
  `DocMeta.profile` → buildDocContext 앵커-우선 예산 삽입(2500자 캡) + 프롬프트 DOC PROFILE 스탠자. **LLM 0콜**.
  검증: workspace 테스트·게이트 8==8/18==18(98.9/99.2%)·wasm 재빌드(9.79MB)+copy·vitest 169/46/316/50·
  e2e 신규 doc-profile-067+066 통과·**실 Grok 마킹0 실증**(사고로그가 프로필 읽고 `TableAppendRow{s0,i1}` 제안).
  ⚠️ 부수 발견: **e2e 사전존재 실패 5건**(052×2·048×2·050×1, HEAD 재현 확정 — hw-row-grip 클릭 인터셉트 의심)
  → **069 신설**. 커밋은 사용자 요청 대기.
- 갱신(2): 2026-07-22 · Claude — **진단 후속 확정**: ① **067 신설**(문서 프로필 = **LLM 0콜 결정론** 확정 — native
  `to_markdown`/`outline` 완비, 병목은 wasm 노출뿐. 배관 5단계 additive 설계 고정) ② **068 실물 벤치 확보** —
  bench-local-2026(archive 24건, must-pass=`2026_*` 8건) + bench-public(공공 25건, HWPX 17/HWP5 8, manifest·KOGL 기록)
  = **49/49 ALL PASS**(detect·own-render·PDF·텍스트), 게이트 `scripts/bench-corpus.sh`(corpus/private=gitignore, 레포 public 주의).
  ⚠️ 게이트는 파이프라인 통과 보증 — 시각 파리티는 별개(딥테크 쌍 25p vs 18p 실측). issues/README stale 표(064~066) 갱신.
- 갱신(1): 2026-07-22 · Claude — **사용자 관점 병목 진단 발행**(`docs/USER-BOTTLENECK-DIAGNOSIS.md`, 분석-only·코드 무변경).
  4축 조사(엔진·에디터/SDK·docs·외부 생태계) → U1~U12(최종 사용자)/D1~D6(임베드 개발자)/S1~S5(전략) + 보강 A~G.
  헤드라인: **AI 문서이해 층 부재(U1)**·npm 미발행+온보딩 6단계(D1·D2)·**rhwp upstream v0.7.19 전면 경쟁 확인**(S1,
  vendored 0.7.15 대비 4버전 갭 — 재벤더링은 여전히 needsExternal)·**정부 HWPX 의무화 2026-05-18 시행**(S3, 전략 순위 급등).
  이후 관련 작업은 이 문서의 ID로 참조. 보강 우선순위는 사용자 승인 대기.
- 갱신(직전): 2026-07-16 · Claude — **HWPX 줄간격 근본진단 + 레이아웃 정리 토글**(4d74c11). 통제실험(동일문서 .hwp/.hwpx)으로
  "hwp vs hwpx 괴리"=파일 열화(한글 hwpx저장이 본문 78%를 바탕글 160%로 리매핑, 한글도 20p로 벌어지게 렌더)임을 증명. 우리 읽기는
  충실. **정규화 옵트인 토글** 추가(hwp-model::normalize_line_spacing → wasm setNormalize → 툴바 "레이아웃 정리"): 열화지문
  감지 시 160%→130% 복원(렌더-IR only·가역·moat보존). 브라우저 실검증: 충실18p(1~10행)↔정규화17p(1~12행=.hwp). 게이트 8==8/18==18.
  직전 시각 파리티 배치(c51e5ef): ①행높이(7a06e9f) ②볼드 weight-700(021a08f) ③serif 명조번들(c51e5ef).

## 지금 (현재 위치)
- 로드맵 기준: **R12 + R13 + R14 완료 + 후속 배치 진행** — R12(051~057), R13(058·059·060),
  R14 062(배포용복호=056해소·옛한글·금칙·대각선·수식v1·차트v1) + 063 웹 이식 패키징.
- **후속 배치(2026-07-13, 트리아지 90항목→7 actionable)**: ✅ flaky 028툴바 격리(Date.now 고정, 3회 296/296) ·
  ✅ IME Chrome CDP e2e(059 회귀락, main 통과) · ✅ BMP PDF 임베드(순수 Rust 파서, stub 제거) ·
  ✅ FaceName PANOSE 분류(rhwp type_info, 게이트 before==after) · ✅ rhwp upstream/kordoc 조사(→062 문서).
  ❌ 중첩표 토스트=엔진 nested 미방출 speculative→**revert, 064 신설**(엔진 선행). 
  남은 후속: **#7 npm 발행 자동화 = 063에서 이미 완료**(중복 계산이었음). **rhwp 재벤더링 v0.7.18 = 블로킹**
  (미러 포크에 태그 없음 → needsExternal, 062에 실행 스텝). → **지금 처리 가능한 후속 전부 완료.**

## 실물 QA 발견 → 수정 완료 (2026-07-13, ~/Desktop/archive 24개 실물 + Grok 4.5 실호출)
OpenRouter/Grok 4.5 웹 생성 연동 완료(`.env.local` BYOK). 실물 스윕 발견 P0 2건 = **둘 다 수정·병합·검증 완료**:
- **065 ✅ done (79ecd1a 푸시)**: 압축 mimetype HWPX 거부 → 실물 6/24(25%, 작성완료본) 안 열림. detect fallback으로
  ZIP 중앙디렉토리 엔트리 NAME(`Contents/header.xml`) 스캔(DOCX식, inflate 0 → wasm-clean·압축폭탄 0). 6개 전부 회복.
- **066 ✅ done (dab3e87)**: 바이브 표 편집 컨텍스트 blindness. hwp-session `table_grid`(edit_target 언랩·active 셀만)
  → wasm `tableGrid` → WasmAdapter → buildDocContext 그리드 첨부(`(rNcM)`+`_빈칸_`, dedup·truncate·회귀 바이트동일).
  프롬프트 FOOTER에 TABLE GRID/ADDING ROWS 규약. **실 Grok 4.5 실경로 실증**: 그리드+"표 채워줘"→col1 값칸에만
  SetTableCell(col0 라벨 미접촉), 066 이전 intents:[] 완전 해소. 구조편집(행 추가) 프롬프트도 동반 보강(F3).
- 정상 확인: .hwp 렌더/export/게이트(8==8~25==25, 99.4%) OK, 문단 편집 Grok 정상, PDF/HTML export OK(작성완료본 제외).
- 스윕 도구: `scripts/`(임시 qa-sweep는 scratchpad), CLI own-render/export-html/export-pdf/layout-check.

## 웹 QA 2차 피드백 배치 (2026-07-14, 사용자 실사용 스크린샷) — 진행 중
사용자가 웹에서 표 편집 QA 중 발견한 4건. 착수 전 병렬 조사(wrong-cell/선택모델/deselect/인라인diff)로 근본 매핑:
- **#1 라벨 덮어쓰기 (P0, 데이터손상) ✅ 수정·커밋(0f09ac4)**: "아이디어명은 여명거리로"가 대표자명 라벨칸(r0c0)을
  덮음. 근본 = **스테일 `packages/ai-protocol/dist`** — 066은 src만 고치고 dist 재빌드 안 함(앱은 컴파일 dist 소비).
  스테일 buildDocContext가 grids 드롭 → 얇은 컨텍스트 → 모델 라벨칸 추측. durable 수정: hwp-lab `predev`/`prebuild`가
  `build:deps`(ai-protocol→editor-core→react) 선행 → `npm run dev` 항상 최신 dist. verify-local.sh --full에도
  ai-protocol 빌드 추가(스테일이 그린으로 새던 구멍). playwright webServer는 provider 키 비워 e2e mock 고정.
  e2e chat-table-grid-066 mock 통과(docContext에 표 그리드 실림 확인). **⚠️ 실 Grok으로 프레임표 최종 육안 재확인 권장.**
- **#2 빈바탕 클릭 미해제 ✅ 수정·커밋(0f09ac4)**: `finishClick`이 `block_at` nearest-band 폴백(x무시)을 신뢰 →
  빈 공간 클릭이 가장 가까운 문단을 잡음. strict-containment 재검사로 교정. editor-core vitest 157(+1 회귀).
- **#4 Figma식 표 선택 ✅ 병합(59fef4f)**: 클릭=부모 표 → 더블클릭=셀 진입 → 재더블클릭/Enter=텍스트 편집(사용자 승인).
  editor-core `drill` 상태 + finishClick 우선순위 반전(표 히트=전체표, drill시 셀) + `drillInto`/`currentCell` +
  React `handleDoubleClick`(드릴 vs 에디터)/placeCaretAt 게이트/우클릭 드릴. editor-core 162·react 301.
  e2e 9건이 옛 상호작용(셀 단일클릭·더블클릭편집)으로 깨져 **드릴 모델로 정렬(5693ecb, 5스펙)** → 21 통과.
  ⚠️ **Enter=편집은 실앱서 053 캐럿이 Enter를 삼켜 안 열림**(재더블클릭은 됨) → 후속 수정 대상. 실포인터 육안은 로컬 QA.
- **#3 인라인 편집 ✅ 병합(c1a9476)**: 선택 요소 우하단 `✨ 여기서 편집` → 요소 아래 InlineEditPanel(compose→busy→
  applied→error) → 지시 제출 시 `onAiRequest`(채팅과 동일 그리드 컨텍스트)로 즉시 apply(1 undo 배치) → 변경본
  in-place 표시 + `적용 유지`/`되돌리기`(session.undo). 이중 revert 가드(외부편집·클릭어웨이 = close-and-keep).
  셀/문단/표/이미지 전부. react +4 테스트(총 301). **잔여 UX 판단(사용자 확인)**: AI 진입점 2개(툴바 채팅 ∥ 인라인 필)
  공존 → 통합 여부 · 인라인에 수동 텍스트 직접편집 추가 여부.

## 웹 QA 3차 피드백 배치 (2026-07-14) — ✅ 병합·검증 완료 (미푸시)
QA에서 #1(표 자동인식·채우기) 실 Grok 프레임표 작동 확인 후 신규 3건. 조사 4건 → 3 병렬 워크트리 → ①→②→③ 순 병합(전부 clean cherry-pick). 승인 범위 = ①②③-C·A-v1(스트리밍 투명성 ③-v2는 다음 배치).
- **① 채우기 색상 검정화 ✅ (32f521b, Rust)**: `Op::SetTableCell`/`SetParagraphRuns`가 빈칸 첫 run char_shape 전체(색 포함) 물려줘 예시 파랑/빨강 반영되던 것을, plain-run 분기에서 char_shape clone→`text_color=Color::default()` reintern(폰트·크기 유지)로 교정. 수동 명시색 run은 non-plain이라 자동 우회(스코핑). hwp-ops 65 테스트, **게이트 before==after 8==8/18==18, wasm 재빌드+복사 완료**.
- **② 다중페이지 드래그 ✅ (c6e5319, JS)**: `pointerMoveMultipage(client, slices)` 신설(React가 캡처 하 교차페이지+sub-rect 계산, core DOM-free 유지)+edge auto-scroll, `finishMarquee` 페이지별 loop+union, `SelMarquee.boxes` 확장, MarqueeLayer 페이지별 슬라이스. editor-core 163·react 301(030 렌더격리 유지). **⚠️ 실제 교차페이지 지오메트리·auto-scroll은 로컬 육안 QA**(jsdom은 페이지 스택 불가).
- **③-C 챗카드 revert + ③-A 웹검색+인용 ✅ (4aa1083, JS)**: (C) `DocSession.undoDepth()` + ChatPanel 적용카드 지속 `되돌리기`(top-of-stack만 활성, off-top은 비활성+툴팁) → `revertChatEdit`→session.undo. (A) `🔎 웹 검색` **토글**(휴리스틱 대신) → `OnAiRequest` additive 4th param `opts?:{webSearch?,onCitations?}`(InlineEditPanel 무영향) → route.ts `plugins:[{id:"web"}]` when webSearch → `EditResponse.citations?`(additive)+`extractCitations`(url_citation) → 챗 "🔎 근거" 링크. 스트리밍 없음. ai-protocol 23·react 305·hwp-lab 44.
- 통합 검증: 빌드 OK, vitest 23/163/305/44, 게이트 8==8/18==18, 챗/smoke/editing e2e 11 통과. **잔여(사용자 판단)**: always-revert 완전형(주소화 배치/보상편집=오래된 편집 개별 revert) + 스트리밍 투명성(③-v2, 검색어→결과→구성→반영 실시간)은 다음 배치.

## 웹 QA 4차 피드백 — 대형 다배치 (2026-07-15, 설계 완료·사용자 승인) — 진행 중
QA에서 8건 피드백. 6레인 병렬 설계조사(qa4-design-explore workflow) 완료. **엔진레벨 통일 원칙: 엔진은 항상 Intent를 낸다** — AI 사고/검색=스트리밍 AgentEvent 로그, 첨부=컨텍스트(새 Intent 아님), 표생성=기존 InsertTableAt, 선택주소=CellPath(중첩), 썸네일=기존 SVG 재사용. 사용자 승인: 권장 배치순서·중첩표 Tier2까지·멀티모달 이미지+문서 둘다.
- **배치1 ✅ 완료 (fd473f0·dd3f0ff·13535fc, 미푸시→푸시예정)**: ⓐ **호버 빈배경 색변**(13535fc)=`useHover.ts` runQuery에 strict-containment(pointInBox) 가드 → 실제 객체 위에서만 hover(회귀 테스트). ⓑ **표 생성**(dd3f0ff, 프롬프트갭)=prompt.ts에 내용채움 예시(팀 4×2)+"데이터→표" 스탠자(엔진 InsertTableAt 완비). ⓒ **중첩표 Tier1 데이터손실**(fd473f0, Rust)=`Op::SetTableCell` **보존방식**(문단만 splice·중첩 Block::Table 보존)+CellHit.nested 엔진세팅+정직한 토스트("중첩표는 아직 편집할 수 없습니다", 064 Tier1). cargo workspace 444, 게이트 before==after, wasm 재빌드. 통합: vitest 25/163/307/44, 8==8/18==18.
- **배치2 ✅ 완료 (fa7e22c·3fbb841, 푸시예정)**: ⓓ **페이지 썸네일**(fa7e22c)=OutlinePanel이 adapter.pageSvg→sanitizeSvg→래스터(Blob img)+IntersectionObserver lazy+클릭 점프+active 하이라이트(자기완결 030, 헤딩모드 보존). ⓔ **멀티모달 입력**(3fbb841)=`Attachment{kind,dataUrl?,text?}`+ChatPanel 📎/붙여넣기/칩+이미지=content-parts image_url(**grok-4.5 비전 확인**=input_modalities text/image/file)+doc=TXT/텍스트류 클라 추출(HWP/PDF/DOCX는 정직한 "미지원" 칩·deps 0). additive(EditRequest.attachments·buildUserMessageParts·AiRequestOptions.attachments, InlinePanel 무영향). ⚠️R5 펜스 유지. 통합: vitest 31/163/313/47, 8==8/18==18.
- **배치3 ✅ 완료 (22cbc58, XL, 푸시예정)**: ⓕ **에이전틱 AI**=`POST ?stream=1` NDJSON ReadableStream(비스트리밍 JSON+InlineEditPanel 유지=back-compat). 모델주도 툴콜링 루프(tools/tool_choice:auto/stream:true) — web_search는 OpenRouter `plugins:[{id:web}]` 서브콜로 실행+url_citation, emit_intents 종료(whitelist 재검증), max 5 iter. AgentEvent 유니온(status/thinking_delta/tool_call/tool_result/intents/error)+NDJSON parser. 대화 메모리=최근 6턴·각 ≤800자(클라 MEMORY_TURNS+서버 readHistory 이중강제, assistant는 편집 다이제스트). ChatPanel `thinking` 변형+StepTimeline, **🔎 토글 제거**(검색=모델주도). R5(검색결과·첨부=DATA 펜스)·R6(키 서버측). 통합: vitest 40/163/318/50, 8==8/18==18. **⚠️ 실 스트리밍 웹검색은 로컬 수동 QA**(테스트는 mock). Anthropic 경로는 미니멀 타임라인(웹검색 없음).
- **배치4**: ⓖ **중첩표 Tier2 ✅ 완료 (8afc6e3, 푸시예정)**=`CellPath`(descending, flat quad=length-1 fast case로 back-compat)를 전 스택 배선: place_nested_table provenance(rfind topmost가 inner 승리·additive 무기하변화)+hwp-session hit/read(resolve_cell_path·block_runs_path)+`Op::SetTableCellPath`(비파괴 rebuild 공유)+editor-core 드릴 스택({section,path})+react. Tier1 토스트 제거→중첩표 더블클릭 편집. **게이트 before==after·LOCKSTEP 확인**(place.rs flush_fragment 핀인덱스·band find ancestors 가드 수정). cargo workspace·editor-core 168·react 318·wasm 재빌드. 안전이연: 캐럿레인 flat(중첩은 더블클릭 편집)·Tauri flat·컨텍스트메뉴 행삽입=외곽표. ⓗ **차트/도표 생성 ✅ 완료 (80d2607)**=신규 `InsertChartAt`(막대/원/선). `chart_gen.rs`(순수 Rust SVG, deps 0)가 데이터→SVG 생성, **062 `ChartRef`→PaintOp::Image.svg 채널 재사용**(렌더/HTML/PDF 신규코드 0), Op이 InsertImageAt처럼 object 문단 삽입. LOCKSTEP(place_doc↔NaiveLayout 박스예약, 062가 이미 chart-aware)·게이트 before==after. PDF=예약박스 스텁(062처럼 벡터화 이연). whitelist 40→41, 프롬프트+describeIntent 카드+mock. **QA4 8/8 완료.**
- **배치3 실 Grok 스트리밍 웹검색 검증됨**: `?stream=1`에 검색요청→status=thinking→thinking_delta→searching→tool_call(web_search)→tool_result(citations=4)→composing→intents. 모델주도 검색·사고스트림·출처 실작동(합성앵커라 intents=0이지만 파이프라인 정상).
- 설계 근거 전문: workflow wf_ec4aacad-4cf journal. 3차까지=2fe44d3, QA4 배치1=16898c1·2=4e239d5·3=d890d37·4=8afc6e3.

## 웹 QA 5차 피드백 (2026-07-15) — #1 완료, #2·#3 조사 중
- **#1 에이전틱 편집 "제안된 편집 없음" 멈춤 ✅ 수정·푸시(59101a6)**: 근본=Grok이 `emit_intents` 터미널 툴콜에서 degenerate(인텐트명 오염 'SetTableCell纺'·공백 폭주)→화이트리스트 드롭→intents 0. + 러너 핫리로드됐지만 프롬프트(ai-protocol dist)가 서버 캐시 스테일이라 모델이 없는 툴 시도. 수정: **emit_intents 툴 제거→최종 편집을 JSON 배열 텍스트로 출력**(비스트리밍과 동일 검증 경로)+AGENT_PREAMBLE JSON계약+웹검색 캡(AGENT_MAX_SEARCHES=3, tool_choice:"none" 강제). 실 Grok 실증: 명시 채우기→SetTableCell 1건, 검색+채우기→3검색후 1건. ai-protocol 42·hwp-lab 50·react 318·게이트 불변.
- **#2 Figma식 컨트롤 ✅ 수정(86ad5b9, 푸시예정)**: 조사서 **지속 리본(FormatRibbon/048)이 이미 존재·마운트**됨을 발견 — 플로팅 툴바(028)는 중복이었음. FloatingToolbar 렌더 제거 → 서식은 지속 리본에만, 리본에 **서체 피커 추가**(applyRibbon 양 arm→setFont/applyLiveStyle), **컴팩트 ✨AI에게 전달 pill**(hw-ai-send, marks>0·union bbox 앵커, 여기서편집 pill과 stacked, aiFocusToken만 bump). react 316, 게이트 8==8/18==18. 테스트·e2e(editing-027/ribbon) 갱신.
- **#3 HWPX 렌더 깨짐 (근본 확정, Batch A+B 구현 중)**: **통제실험 근본** = 렌더 엔진은 공유·정상(place_doc→SvgSink source-agnostic). HWP는 rhwp lift(풍부 IR), **HWPX는 얕은 자체 파서 `hwp-hwpx/parse.rs`가 run을 char_shape 0·문단 para_shape 0으로 하드코딩** → 전 텍스트 10pt 검정(볼드·크기·색·명조 소실)·페이지수 오류(청창사 PDF 18 vs 우리 25). **풀(header_pools)은 이미 파싱돼 메모리에 있으나 char_ref→char_shape 배선 누락** = 싼 수정. secPr 여백·표·이미지도 드롭. **Batch A+B ✅ 수정(88e9d31, 푸시예정)**: `resolve_shape_pools`(parse_semantic 말미)가 run.char_ref→char_shape·paraPrIDRef→para_shape 해석(셀 문단 para_ref 캡처 포함), `parse_page_setup`이 secPr 여백→Section.page. **실측(export-html): 폰트 크기 1→4종·검정만→#0000FF/#FF0000+음영색** 회복(HWP 렌더 근접). 페이지수 개선(청창사 25→22). **round-trip moat 보존**(hwpx_pool_* 추적·build_synth_plan 미편집분 재synth 스킵). cargo workspace 466·hwp-hwpx 42+3·게이트 before==after·wasm 재빌드. 덤: hwp-jsx CSS 파서 brace-depth 버그 수정.
**Batch C+D ✅ 완료(0f894b8, 푸시예정)**: C=cellSz→col_widths/row_heights(span-aware)+borderFill 풀 파서→테두리/음영/대각선/cellMargin padding. D=hp:pic→Inline::Image+content.hpf opf:item→bin_data, fontface 풀→font_family(명조/고딕). **실측(창도약): 음영 81·테두리·비균등열·폰트패밀리 다수(함초롬바탕 serif 등), 청창사 이미지 임베드.** round-trip moat 보존(Table.geometry_edited 플래그·이미지 dedup). cargo workspace 475·hwp-hwpx 51·게이트 before==after·wasm 재빌드. **HWPX = HWP 수준 렌더 도달.** 이연: 수식/차트/필드(mark_not_simple 유지)·잔여 페이지수 갭(폰트메트릭 근사, 지오메트리 밖).
`cd apps/hwp-lab && rm -rf .next && npm run dev` → Chrome. **QA.md 시나리오 ⑪~⑱**(이번 세션 신규 렌더:
수식·차트·대각선·옛한글·IME·명조고딕·금칙·배포용복호/BMP)을 원본 PDF/한컴 뷰어와 대조. 기존 ①~⑩도 회귀 확인.
QA 발견사항 → 이슈로 정리해 다음 배치. WKWebView IME 실기(059)는 데스크톱 Tauri에서 별도 수동.
- **062 렌더러 승격 요약**: 배포용복호·옛한글·금칙·대각선·수식·차트 = rhwp(MIT) 승격 완료.
  **잔여(후속)**: ① 수식/차트 자체 PaintOp 이식 v2(Path/Bezier 프리미티브 필요, XL) + krilla PDF 렌더
  ② 레거시 OLE VtChart(rhwp도 미렌더) ③ rhwp upstream(>v0.7.15) 델타 미확인 ④ 폰트메트릭=디스코프(영구).
- **063 = 병합 완료**: file:→실버전(prepack 치환)·prepack 빌드훅 4패키지·발행 CI(publish.yml dry_run 기본)·
  Vite 임베드 예제(published tarball 설치→렌더 스모크 그린)·AI 프록시 Express 템플릿·EMBED-GUIDE. `npm pack`
  4종 tarball 실측(pkg/dist 포함·file:의존 0). ai-protocol dist ESM `.js` 결함 수정. **실 npm publish는 미실행(pack까지).**
  → 외부 사이트에 `npm i @auto-hwp/react @auto-hwp/engine` 임베드 준비 완료(발행은 사람이 workflow_dispatch로).
- **오픈소스 조사 헤드라인(2026-07-13)**: 우리 약점 상당수(배포용복호·금칙·정렬·다단·대각선·수식·옛한글·
  폰트메트릭)가 이미 external/rhwp(MIT, 우리 소유)에 완성 — 파스전용이라 미배선. → **062 신설**(라이선스 0 승격).
  056 crypto는 062-1(배포용 복호화 quick win)로 해소 경로 확정. 웹 이식 갭 → 063 승격 대기(패키징 최종 1마일).
- 로드맵 정본: `docs/PRODUCT-DIRECTION-V2.md`(북극성 = 브라우저 프로덕션: 업로드→바이브+수동 편집→PDF) + 진행표 `docs/issues/README.md`(상태 진실은 git log — 복원 스크립트가 대조).
- 제품 현 수준: 웹(`apps/hwp-lab`)에서 업로드→수동+챗 편집→PDF/HWPX export가 전부 클라이언트사이드로 동작. 판정 = "강한 내부 데모/프라이빗 베타, GA 아님"(격차 5개가 이슈 051~056).

## 다음 (사용자 승인 완료 2026-07-13 — 이 순서로 자율 진행)
1. **060 프레임표(R13 마감)** — 구현 중. 병합 후 →
2. **062 quick win 배치** — external/rhwp(MIT, 우리소유) 승격. 착수 순서: 062-1 배포용복호화(=056 해소,
   난이도 낮음·rhwp crypto.rs NIST벡터) → 062-2 옛한글 PUA(Public Domain) → 062-3 금칙(줄바꿈 향상).
   ⚠️ 062는 조판 입력 변경 가능(금칙) → 게이트 V5 필수 재확인. rhwp는 읽어서 우리 crate에 재구현(vendored 수정 금지).
3. **063 웹 이식 패키징** — 이슈 파일 신설 필요(README 웹이식 절 근거). 블로커: file:→실버전 + prepublish훅 +
   발행CI + 비-Next wasm서빙 레시피 + 임베드 예제. npm 발행 준비.
- **웹 QA(사용자, 로컬)**: `cd apps/hwp-lab && npm run dev` → localhost:3000 (QA.md). WKWebView IME 4항목 수동 큐(059).
- 검증 정본: `scripts/verify-local.sh` (--full 포함). CI는 수동 전용(`gh workflow run ci`).

## 알려진 flaky (추적 — 실회귀 아님)
- `packages/react/.../workspace.editing.test.tsx` "in-place 에디터 열림 중 028 툴바 숨김" — 전체 스위트에서
  간헐 실패(063 --full에서 1회), **격리·재실행 시 296/296 그린**. 테스트 순서/타이밍 격리 결함(소스 회귀 아님).
  후속: 이 테스트의 공유 상태(타이머/DOM leak) 격리. verify 실패 시 이 테스트면 재실행으로 판별.
- e2e `context-menu-039` "셀 우클릭 → 굵게 → SetCellRangeFmt 토스트" — 전체 스위트에서 간헐 실패
  (2026-07-22 1회), **격리 2회·풀스위트 재실행 그린(42/42)**. 순서/타이밍 계열(069 마감 시 확인).

## 막힘 / 대기 (없으면 "없음")
- 없음. (056 배포용 crypto는 "수요 확인" 게이트 — 미착수가 정상 상태)

## 진행 중 레인 (병렬 작업 시에만)
| 레인/ID | owner | 상태 | 다음 체크포인트 |
|---|---|---|---|
| (없음 — 062 잔여 배치 B1·B2·B3 전부 병합·검증 완료) | | | |
