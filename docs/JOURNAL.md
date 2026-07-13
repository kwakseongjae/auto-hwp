# 세션 저널 (newest-first · append-only)

> 세션 시작: 최근 항목 1~2개 확인. 세션 종료: **맨 위에** 5줄 이내 항목 추가. 기존 항목 수정 금지.
> 결정·증거·계획의 정본이 아니다 — "무엇을 하다 어디서 멈췄나"만 기록한다.

---

## 2026-07-13 밤2 (Claude) · 062 잔여 계획(워크플로) + B1 대각선
- 한 일: 062 잔여 4항목 조사·적대검증·계획 워크플로(wf_842c2cd1, 9에이전트) — 발견: 대각선=거의완성(순델타 X자), 차트=rhwp에 이미 있음(이슈 "소스없음" 오류), 폰트메트릭=디스코프(라이선스+V5+실익미미). 전항목 document.rs+lift.rs 공유→순차(B1→B2→B3). B1 062-4 대각선 X자(342b833): DiagonalKind::Cross, render-only, 게이트 8==8·18==18, e2e 39/39.
- 함정: B1 에이전트가 커밋 전 external/rhwp 심링크 제거→워크트리 재검증 불가 → 코드-only 커밋이라 main cherry-pick+거기서 --full로 해소. 향후 rhwp 제거 금지. 하단 고아 에이전트 4개(058 폰트 리서치 하위)도 종료.
- 다음: B2 062-5 수식 렌더 v1(rhwp bootstrap SVG) → B3 차트(tail).

## 2026-07-13 밤 (Claude) · 063 병합·검증 완료 — 승인 배치(060→062→063) 종료
- 한 일: 063 cherry-pick 병합(50db8f0). main --full에서 react vitest 1건(workspace.editing "028 툴바 숨김") 실패 → 격리 재실행 296/296 그린 확인 = **flaky(테스트 순서/타이밍), 063 회귀 아님**. set -e로 e2e 미실행됐던 것 → e2e 별도 39/39 그린으로 검증 완료. 게이트 8==8·18==18, deny ok. flaky는 CURRENT_STATE에 추적 기록.
- **승인 배치 전부 완료**: R13 060 + R14 062 quick win(배포용복호/옛한글/금칙) + 063 웹 이식 패키징. 외부 사이트 npm 임베드 준비 완료(실 publish는 사람이 workflow_dispatch).
- 다음: 062 잔여(대각선·수식·폰트메트릭·차트) R14 후속 / 사용자 웹 QA(로컬) / flaky 테스트 격리.

## 2026-07-13 밤 (Claude) · R14 063 웹 이식 패키징 구현(워크트리)
- 한 일: 063 전 스코프. ① **file:→실버전**: 루트 pnpm-workspace 대신 **prepack 치환 전략** 채택(레포가 npm+독립락, apps/hwp-lab도 npm+file: → `workspace:*`는 npm이 못 읽어 무회귀 위반). react `prepack`이 file:→^ver 텍스트 치환(포맷 보존)·`postpack`이 복원(on-disk는 file: 유지). ② **prepack 빌드 훅** 4패키지(engine=build-wasm.mjs cargo+wasm-bindgen+wasm-opt, react=vite+tsc, editor-core/ai-protocol=tsc) → `npm pack` 4종 tarball 전부 pkg/dist 포함·file:의존 0 실측. ③ **발행 CI**(.github/workflows/publish.yml, workflow_dispatch, engine→editor-core→ai-protocol→react, dry_run 기본, publishConfig access:public). ④ **Vite 임베드 예제**(examples/vite-embed — published tarball 설치→`<HwpWorkspace/>` 렌더, Playwright 스모크 그린: 업로드→8쪽 SVG→셀 마킹→mock 편집→undo). ⑤ **AI 프록시 Express 템플릿**(examples/ai-proxy-express, GET/POST/400 mock 실측). ⑥ 문서(docs/EMBED-GUIDE.md + INTEGRATION-HANDOVER 비-Next 포인터).
- 발견/수정: **ai-protocol dist가 확장자 없는 상대 import**라 순수 Node ESM(Express 프록시)에서 ERR_MODULE_NOT_FOUND — src에 `.js` 확장자 추가로 수정(번들러/Node 양쪽 호환, vitest 15 무회귀). Vite 프로덕션 빌드는 엔진 글루 wasm을 정적에셋으로 1회 더 방출(런타임 미fetch, 무해 — 문서화).
- 함정 준수: 실제 npm publish 안 함(npm pack까지만). Rust 무접촉(빌드만). 워크트리 커밋만, 푸시 금지.
- 다음: 아키텍트가 main 병합 + verify-local --full 재확인 → 062 잔여(대각선·수식·폰트메트릭·차트).

## 2026-07-13 저녁 (Claude) · R14 062 quick win 완결 → 063 착수
- 한 일: 062 quick win 3종 병합·검증 — 062-1 배포용복호(c716e8f, **056 해소**; 발견: 배포용은 이미 rhwp가 복호 중, hwp-crypto를 NIST골든+fail-closed 정본으로 승격) · 062-2 옛한글(6b6d22d, KTUG PublicDomain 5,659매핑, 측정=전각프록시 LOCKSTEP+그리기만 자모확장 additive) · 062-3 금칙(c556114, rhwp 두 집합 verbatim→layout_paragraph kinsoku_adjust, 게이트·줄바꿈 before==after 하락0). 각 병합 후 워크트리에서 게이트 직접확인→cherry-pick, 배치 후 --full 그린(e2e 39/39).
- 패턴 확립: rhwp 승격은 워크트리에서 핵심 Rust 증명(게이트/테스트) 직접 확인 후 cherry-pick, 그다음 main --full. leaf crate(hwp-crypto)는 quick로 충분, render/typeset 접촉(062-2/3)은 --full.
- 다음: 063 웹 이식 패키징(file:→실버전+prepublish훅→npm 발행→Vite 임베드 예제).

## 2026-07-13 오후 (Claude) · R13 마감(060) + 062 착수
- 한 일: 060 프레임표(1778690) 인수·병합 — 060 에이전트가 e2e를 42분 폴링하며 반환 반복(토큰 낭비) → 직접 인수: 워크트리에서 hwp-hwpx 테스트(frame_table_060 3 + 057 골든 5 무회귀)+게이트 확인 후 커밋·cherry-pick. main verify-local --full 그린(e2e 39/39, 게이트 8==8·18==18). ⚠️ e2e가 포트 오염으로 1회 실패 → 프로세스 정리(pkill next/playwright, lsof :3100/:3000 kill)+스모크 확인 후 재실행으로 39/39 회복.
- 교훈: 에이전트가 느린 e2e를 폴링하며 반환 반복하면 직접 인수(핵심 Rust 증명만 확인하고 커밋+병합, e2e는 main에서). e2e 포트 오염 시 pkill+lsof 정리.
- **R12+R13 완료.** 다음: 062 rhwp 승격(062-1 배포용복호=056해소 ∥ 062-2 옛한글) → 063 패키징.

## 2026-07-13 (Claude) · R13 059·058 병합 + 오픈소스/웹이식 조사
- 한 일: 059 IME(1ea3365 — 캐럿추종 hidden textarea+compositionView, 한글 완전무입력 실측 확정, 엔진무변경) ff-병합 + 058 폰트(43a7c48 — 명조/고딕 OFL 라우팅, **디스플레이 전용으로 게이트 V5 원천차단** metric불변·글리프 x 바이트동일) cherry-pick 병합(HwpWorkspace 자동병합). 통합 verify-local --full 그린(게이트 8==8·18==18, vitest 156+15+296+41, e2e 39/39).
- 조사 2건: ①오픈소스 전수 → **헤드라인: 약점 상당수가 이미 external/rhwp(MIT)에 완성**(파스전용이라 미배선) → 062 신설(배포용복호·금칙·정렬·다단·대각선·수식·옛한글·폰트메트릭 승격, 라이선스0). 056은 062-1로 해소경로. ②웹이식 SDK감사 → 아키텍처 준비우수·패키징 최종1마일(file: 의존/prepublish훅/발행CI) 미비 → 063 승격대기.
- 다음: 060 프레임표(R13 마감) → 062 quick win → 063 패키징(사용자 승인 대기).

## 2026-07-11 밤 (Claude Fable 5) · 055 사후 리뷰 → 확정 결함 10건 수정
- 한 일: code-review 워크플로(high, 24에이전트, 발견별 독립 검증)가 055 diff에서 확정 결함 10건 적발 — 기능 e2e가 전부 그린인데도 동시성/수명주기/에러 경로는 구멍(복구 토스트 사장, 취소가 열린 문서 파괴, recover 동시 비행 dead-handle, 실드 boolean 소실, open 중첩, 실패 open이 이전 문서 파괴, init 거부 영구 캐시, 트랩 분류기 3중 발산, setTimeout(0) 실드 잔존 2, ctxMenu dismiss 무반응). 10건 전부 수정 + 잠금 테스트 14개(각 수정을 구 코드로 되돌려 레드 확인 후 복원). react 283/150/15/41, e2e 38/38, tsc 클린.
- 교훈: 워커화 같은 비동기화 diff는 기능 테스트 그린만으론 부족 — 병합 직후 동시성 특화 리뷰를 표준 절차로.
- 다음: R13 착수(061→059∥058→060 — README R13 절 계획 확정).

## 2026-07-11 저녁 (Claude Fable 5) · 055 웹 하드닝 + 알려진 한계 리서치 5레인
- 한 일: 055 웹 하드닝 구현·병합 — 엔진 워커화(FG-14 — @tf-hwp/engine worker.js+worker-client 수제 RPC, WasmAdapter 옵트인+052 재스폰 복구, hwp-lab 기본 ON·?engineWorker=off 롤백) + wasm-opt -Oz(raw −22%/gzip −6%, 골든 바이트동일) + 한도 UX(64MiB·DocLimit 문구·파싱 취소). 실측 458p·CPU4× JS 블로킹 11.5s→3.4s(−71%). 부수: 047 shield 레이스 수리, Cargo exclude ".claude". verify-local --full 그린(e2e 38/38, react 274, hwp-lab 36).
- 알려진 한계 5종 병렬 리서치 → 이슈 승격: 058 폰트(FontKey에 family 이미 흐름), 059 IME(반전: 입력캡처 아키텍처), 060 프레임표(emit 게이트 4곳 비재귀), 061 웹배포(Vercel prebuilt), 056(crypto 착수가능·rhwp crypto.rs MIT).
- 병합 사고: 055가 API 재시작으로 **두 워크트리에서 독립 완성**(7478b11 WasmAdapter통합 vs b5c330d 별도WorkerAdapter). 7478b11 정본 채택했으나 b5c330d만 고친 컨텍스트 메뉴 워커 레이스(늦은 우클릭 해석이 열린 메뉴 detach)가 main e2e 2건 실패로 표면화 → 지운 b5c330d를 객체로 되살려 시퀀스 가드(ctxMenuSeqRef)만 이식 → e2e 38/38 회복. 교훈: 중복 완성 시 각 워크트리가 서로 다른 버그를 고칠 수 있으니 병합 후 반드시 --full 재검증.
- 다음: **R12 전 항목 완료.** R13 후보(058~061+056) 착수 순서 결정(아키텍트). 웹 QA는 로컬 또는 061. 후속 이슈감: 대형문서 SVG 문자열 전송 최적화(034 §함정), 수백p placeholder Layout 스파이크(~1.4s@4×, 워커 무관).

## 2026-07-11 오후 (Claude Fable 5) · CI→로컬 검증 전환
- 한 일: GitHub Actions 전패 원인 2종 해결 — ① fmt 미준수 1,332곳(CI가 로컬 시절 한 번도 안 돌았음) → 전체 포맷+clippy 부채 37건 정리(-D warnings 그린) ② cargo-deny 라이선스 미등록 2종(BSL-1.0/MPL-2.0) allow 추가. CI는 workflow_dispatch 수동 전용으로 전환, 정본은 신설 `scripts/verify-local.sh`(quick/--full). AGENTS.md 검증 절 갱신.
- 검증: fmt/clippy exit 0, 테스트 374/0, 게이트 8==8·18==18, wasm 그린, deny licenses ok.
- 다음: 사용자 웹 QA(apps/hwp-lab, QA.md) → 055 웹 하드닝.

## 2026-07-11 (Claude Fable 5) · R12 배치 B 완료 — 053 병합
- 한 일: 053 v2 완주·병합(dbcc1bd) — P0 own-render 글리프 통일 채택(rhwp 발산 우회), HitTestCell/CaretRectCell(스키마 38→40), CellCaretController+CaretLayer(렌더-0), 해상률 실클릭 0%→100/99.8/100%. place.rs +412/−0 순수 추가로 V4 준수. 최종 통합 검증 후 푸시.
- 사고 기록: v2도 API 연결 오류로 1회 중단 → SendMessage 트랜스크립트 재개로 컨텍스트 보존 완주(재개 패턴 유효 확인).
- 다음: 055(웹 하드닝) 착수 가능. 후속 기획: 1×1 프레임 내부표 미export / F3 / IME(FG-13).

## 2026-07-10 밤 (Claude Fable 5) · R12 배치 B — 054·057 병합, 053 재가동
- 한 일: 057 병합(8a28ce5 — 표 앵커링: src_span+per-cell 수술, verbatim 불변) + 054 병합(8cd4233 — lift F2: 무편집 왕복 8/18/25p 복원, 왕복 손실 4종 수리). 054×057 충돌(document.rs 필드 union, serialize.rs 의미적 합성 — in-place 제외+시퀀스 append, 057 호출부를 054 신 API로 적응) 해소. 통합 검증 그린(Rust 367+30/0, 게이트, hwp-lab 22/22, e2e 34/34), 푸시.
- 사고: 053 v1이 80분 진행부진(내구적 파일 변경 0) → 중단, v2를 병합 main에서 재가동(페이스 규율+서브모듈 .git 포인터 함정 반영).
- 다음: 053 v2 병합 → 055(웹 하드닝). 후속 기획 대기: 1×1 프레임 내부표 미export(057 발견)·F3.

## 2026-07-10 저녁 (Claude Fable 5) · R12 배치 A 완료
- 한 일: 051 구현 병합(2dc92d3 — Intent 2신설·화이트리스트 14종·프리뷰 카드·e2e 32/32·게이트 그린) + 052 구현 병합(d0f0a24 — 2s 유휴 스냅샷·IndexedDB·트랩 우선 복구·배너·V3 잠금), 워크트리 병렬 → ff/cherry-pick 선형 병합
- 발견: 052 golden이 엔진 갭 2건 격리 → 057 신설(hwpx 표 앵커링 오배치), 054에 .hwp 무편집 왕복 8p→6p 기록
- 다음: 통합 검증(빌드+vitest 4종+e2e) 그린 확인 → 푸시 → 배치 B(053∥054, 057 편입 검토)

## 2026-07-10 오후 (Claude Fable 5) · R12 착수
- 한 일: 커밋 4fc37fb + GitHub private 레포 생성/푸시(kwakseongjae/tf-hwp) + 051·052 1단계 완료(결과는 각 이슈 파일 하단 절) — 051 전제 정정: InsertTableAt op 기존재, Intent만 부재 / 052 toHwpx 17ms(25p), V3 무오염 통과
- 사고: named 팀메이트 에이전트 2개 무음 정지(1시간 무작업) → 정지 후 무명 백그라운드로 재가동해 4~6분 완료. 교훈은 메모리(no-teammates-tmux)에
- 다음: 아키텍트 확인 → 051(Intent 2신설+화이트리스트 7+제외 3) ∥ 052(설계대로) 구현

## 2026-07-10 (Claude Fable 5) · 아키텍트
- 한 일: 4-에이전트 전수 감사(상호작용 파이프라인/렌더·최적화/브라우저 이식성/리스크) → 로드맵 v2 수립(`docs/PRODUCT-DIRECTION-V2.md` + 이슈 051–056) + 연속성 킷 설치(CURRENT_STATE/JOURNAL/context_restore.sh/AGENTS·CLAUDE/SessionStart 훅)
- 열린 것: R12 미착수 (첫 배치 = 051 ∥ 052)
- 다음: 051의 조사 표(구조 Intent 유/무 3분류) 또는 052의 toHwpx 스냅샷 비용 실측부터
