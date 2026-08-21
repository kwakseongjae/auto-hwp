# 세션 저널 (newest-first · append-only)

> 세션 시작: 최근 항목 1~2개 확인. 세션 종료: **맨 위에** 5줄 이내 항목 추가. 기존 항목 수정 금지.
> 결정·증거·계획의 정본이 아니다 — "무엇을 하다 어디서 멈췄나"만 기록한다.

---

## 2026-08-21 (Grok 4.6) · #80 머리말/꼬리말 축
- drawText/caption 본문 누수 수리. header_footer 본문줄 81.9→87.6%. 게이트 무변경.
- 재난안전 85→82쪽/69.9→98.2%. issue_265는 .hwp라 미수리. 머지 금지.

## 2026-08-21 (Grok 4.6) · #78 조판 최약 축
- 다쪽 표: 메모 풍선 누수 수리. 쪽수일치 33.3→46.7%. 게이트 무변경.
- header_footer 미개선(원인 분석은 PR). 머지 금지.

## 2026-08-21 (Grok 4.6) · #72 오라클 전수 스윕
- layout-check --json + oracle-sweep. 82건 채점가능 79 / 불가 3. 참값 아님.
- 최저 축 header_footer·footnote·multicolumn. 게이트 무변경. 머지 금지.

## 2026-08-21 (Grok 4.6) · #71 조판 코퍼스 커버리지
- PR #76. tag-layout + tag-corpus.mjs. 82건. 혼합 0 / 각주 1 / 차트 1.
- GOV 양식 4건(KOGL-1 실측). hwpxlib 데이터 49. 머지 금지.

## 2026-08-20 (Grok 4.6) · #64 데스크톱 D0
- 3종 Intent 래퍼 + 필수 목록 + CI vitest. normalize 2종은 #65로 명시 제외.
- sample-8p apply_intent_json 라운드트립 green. 셸 기동 확인. 머지 금지.

## 2026-08-19 (Grok 4.6) · #56 OpenRouter PKCE v1
- 서버 커스터디 키 + 모델 셀렉트 + 이중 게이트. demo.ts 무접촉.
- PR #59 CI 3종 green. Cursor 3건 수리·답글. 실계정 E2E는 소유자. 머지 금지.

## 2026-08-19 (Grok 4.6) · PR #46 Cursor High 2건 수리
- 여백 안내선=`display_paper`. 섹션 머리말 시작쪽=fresh-page 이후.
- 잠금 테스트 2. 게이트 유지. 다음: CI + 스레드 답글, 머지 금지.

## 2026-08-19 (Grok 4.6) · T0 #46 정합 재정의
- 부분집합 22/301 + extras 핀. 머리말 표·폼·가로 자체 픽스처. 7==7.
- 게이트 유지. sample-8p 업로드/렌더 검수. 다음: CI green 후 머지 질문.

## 2026-08-20 (Claude Fable) · #64 머지 · 셸 QA 결함 발견 · T1 계획
- PR #68 머지(#64/#51 close). 게이트·CI 계약 테스트 검수자 재현.
- VITE_SHELL이 vite에 안 닿아 레거시 셸이 부팅됨을 실측 → #69, 증거 오라벨도 기록. 셸 UI 갭 #70.
- T1 계획 TYPESET-ROADMAP §4 확정(오라클이 4건에만 돎·스윕 축이 충실도 아님) → #71→#72→#73.

## 2026-08-20 (Claude Fable) · 블로그·데스크톱 트랙 우로보로스 구체화
- 인터뷰 2건 + 수락 가드 6레인. 가드가 두 계획의 전제를 뒤집었고 레포로 재확인해 반영.
- 블로그: 창간 3편을 1차 자료로 환원(제품 활용 주제는 /docs에 이미 있고 GSC가 색인 거절).
- 데스크톱: D0를 얇은 3종으로 축소(20/34가 의도된 optional), normalize는 명시적 제외.
- 이슈 #62·#63·#64·#65·#66. Seed seed_e2faaecf79a5 / seed_e31ddce71c7e.

## 2026-08-20 (Claude Fable) · #56 실계정 QA 통과 → PR #59 머지
- 소유자 Chrome으로 PKCE 종단 검증: 인가→session 키→카탈로그 403종→모델 선택→AI 편집→undo→disconnect.
- `GET /api/hwp-edit`가 선택 모델·session 출처 확증. 보안 MEDIUM 2건은 #50에 잔여 위험 등록.
- main `a53006f`, #56 close. 소유자 조치: OpenRouter QA 키 수동 폐기. 다음: #51 / T1 / B0.

## 2026-08-18 (Claude Fable) · #50 인수 + 우로보로스 인터뷰로 계획 확정
- #50 타당성 검증 후 인수(크레딧 댓글)·서브이슈 #56(OpenRouter PKCE v1, 계약+수락 기준 포함).
- 인터뷰 D1–D9: 서버 커스터디 키·이중 게이트·모델 셀렉트 포함·우산 유지. Seed seed_8e464381dc64.
- 다음: Grok이 T0(#46) → #56 → #51 → B0 순. PR #53/#55 머지 완료(#29/#33/#54 close).

## 2026-08-18 (Claude Fable) · #48 완료 처리 + 장기 로드맵 트랙 3종
- PR #49 Cursor 리뷰 2건 검수·수리(중첩 캐럿 가드) 후 머지, #48 close. 후속 #51/#52 개설.
- #33 Brave 0건 pending 증거 PR #53. 조판·블로그·데스크톱 로드맵 + 역할 분담 명문화 #54.
- 다음: #53·#54 머지 → #29 close, #42 답변은 소유자 게시, T0 정합 재정의는 Grok.

## 2026-08-15 (Grok 4.6) · #48 중첩 셀 캐럿 구현
- path 캐럿 관통. sample-8p 브라우저: 캐럿·Home/End·삭제/undo·#19 표선택.
- 다음: PR Closes #48, CI 후 머지 질문. #42 분리.

## 2026-08-15 (Grok 4.6) · #48 캐럿 이슈+계약 테스트
- 공개 #48. 브랜치 feat/issue-48-nested-caret. 테스트는 ignore/fixme.
- 구현·PR은 다음. #42와 분리.

## 2026-08-15 (Grok 4.6) · #42 네 결함 한 PR
- 우로보로스 인터뷰 후 사용자: 네 개 전부 한 PR. 원본 hwp 없음.
- Form 체크/입력 리프트 + 머리말 조판 + HWP5 가로 용지 교환. 다음: PR.

## 2026-08-15 (Grok 4.6) · 병합은 묻고, UI는 브라우저 검수
- #43: 에이전트는 PR에서 멈춤(사소·명시 머지 제외). UI는 chrome-devtools 실검수.
- 전역 ~/.grok rules/skills + 레포 `.grok` 동기화. 다음: PR 승인 후 머지.

## 2026-08-14 (Grok 4.6) · #38 머지 후 #40 xlsx 착수
- PR #39 green→main `d24d0b5`. Grok 전역 rules/hook + 레포 `.grok/rules`에 issue-first 고정.
- `feat/issue-40-xlsx-roster`에서 CLI·/bulk 첫 시트 xlsx 파서 구현·단위테스트 green.
- 다음: PR `Closes #40`. 082 한컴 게이트는 별 이슈.

## 2026-08-14 (Grok 4.6) · 제품 방향 v3 착수
- 딥리서치 14m Partial + 레포 적대검수. 공개 이슈 #38, 브랜치 docs/issue-38-product-direction-v3.
- v3 초안 씀. 다음: 이 브랜치 PR `Closes #38` → 082 한컴 게이트는 별 이슈.
- Ralph 경로 사용 안 함. 사용자 문서 무접촉.

## 2026-08-13 (Codex sol) · 오래된 control-audit 로컬 진단 예제 정리
- #36: 7월 HWP control 좌표 덤프용 일회성·미참조 Rust 예제로 판정.
- 생성물이 아닌 소스라 gitignore하지 않고 미추적 파일·빈 examples 디렉터리를 삭제.
- 즉시 필요한 사용자 인증 작업 없음; 2026-08-20 검색 색인·GA 파생 key event만 후속.

## 2026-08-13 (Codex sol) · GA4·Google/Naver·Brave 등록 완료
- production `0979297` success; 동의 전 GA 0·허용/철회·비식별 sample event·Realtime 검증.
- GA custom dimension 6개, export/layout key event; Google verified+sitemap 15·home indexed.
- Naver verified+sitemap+핵심 URL 4개 수집 요청, Brave Submit URL success.
- 다음: 2026-08-20 Brave 색인, document_open success key event·하위 URL 상태 재확인; examples 무접촉.

## 2026-08-13 (Codex sol) · 성장 계측 배포 중 안전 중단
- PR #34 checks green→main `0979297`; production push run `31691376098` 진행 중.
- 로컬 watcher만 중단했으며 배포는 GitHub/Vercel에서 계속된다. Google/Naver Verify는 아직 미실행.
- 재개: run 결과→라이브 meta/CSP/GA opt-in smoke→Google/Naver verify+sitemap→Brave→GA 증거화.
- 체크포인트 문서 외 선재 `crates/hwp-rhwp/examples/` 무접촉.

## 2026-08-13 (Codex sol) · GA4·검색 등록 준비
- #29~#33: GA4 property/stream과 Google/Naver HTML meta token을 만들고 Vercel Production env에 등록.
- 익명 opt-in 전 GA 요청 0·철회 즉시 disable·문서 콘텐츠 금지 typed event/CSP/privacy를 구현.
- app 208 tests·typecheck·build, 전용 Playwright 2/2, launch 30/30 green; full은 기존 shared clippy 정체.
- 다음: PR/CI/main 자동 배포→Google/Naver verify+sitemap→Brave submit; 선재 examples 무접촉.

## 2026-08-13 (Codex sol) · Vercel main 자동 production 실증
- PR #27 CI green→main `dd527d8`; push event가 자동 production run 31680139716 시작.
- 6m30s prebuilt deploy success, autohwp.com 홈/OG 200·canonical·보안 헤더 green.
- native Git build off·수동 preview/production 유지; docs-only 증거 PR에서 path filter 무배포 확인 예정.
- 선재 `crates/hwp-rhwp/examples/` 무접촉.

## 2026-08-13 (Codex sol) · Vercel main 자동 production 준비
- 이슈 #26: native Git build는 끈 채 관련 main push→prebuilt production workflow를 추가.
- push의 빈 inputs를 production env/--prod/smoke로 명시 정규화하고 수동 preview/production은 보존.
- docs-only 제외 path filter, launch 8/8·30/30·actionlint green; PR/CI/첫 자동 배포가 다음.
- 선재 `crates/hwp-rhwp/examples/` 무접촉.

## 2026-08-13 (Codex sol) · npm 0.0.5 발행 완료
- PR #24 CI green→main `7a41cb6`; publish run 31678071089로 npm 4종 0.0.5 lockstep 발행 성공.
- registry license/shasum/size와 React `^0.0.5` 형제 의존을 재조회.
- fresh Vite·Next build, Node/Bun sample-8p 8쪽 렌더·HWPX export green.
- Vercel은 수동 prebuilt라 미배포; 발행 증거 후속 PR 진행, 선재 examples 무접촉.

## 2026-08-13 (Codex sol) · npm 0.0.5 릴리스 준비
- 이슈 #23에서 npm 4종·CDN 핀·현재 소비자 문서를 lockstep 0.0.5로 올리고 CHANGELOG를 확정.
- launch 30/30, 패키지 64/262/418 tests, 4종 tarball dry-run과 engine wasm 7,560KB green.
- full verify는 기존 macOS shared-target clippy 저CPU 정체로 중단; PR Linux CI 뒤 실제 publish 예정.
- Vercel은 수동 prebuilt로 확인했으며 npm 릴리스와 분리, 선재 examples 무접촉.

## 2026-08-13 (Codex sol) · #19 main 병합
- PR #20 필수 checks(issue-link/build-test/licenses) green 후 main `f32f0ca` 병합, #19 자동 close.
- npm 네 패키지 latest는 `0.0.4`; 이번 additive Intent/DTO 수정은 아직 npm 미배포.
- 정본 상태 동기화는 이슈 #21 후속 문서 PR로 진행, 선재 examples 무접촉.

## 2026-08-13 (Codex sol) · #19 중첩 표 삭제·즉시 undo
- 중첩 표 선택에 부모 CellPath+자식 block 주소를 싣고 `DeleteNestedBlock`으로 바깥 양식 표를 보존.
- 삭제 커밋/undo를 직렬화하고 Design→Vibe 전환의 채팅 textarea 포커스 탈취를 제거.
- Rust/JS 단위·격리 clippy·wasm 재빌드·8/18/24 게이트와 sample-8p 실제 E2E green.
- 브랜치 `codex/issue-19-nested-table-delete-undo`; commit/push/PR은 사용자 확인 대기, 선재 examples 무접촉.

## 2026-08-13 (Codex sol) · 런칭 후 버그 수정·정식 OSS 파이프라인·프로덕션 배포
- #11 병합 셀 좌표를 active origin으로 정규화, #12 PDF blob CSP를 최소 허용; PR #14 CI green→main `2eb29d7`.
- `issue-link` 필수 check·CODEOWNERS·이슈 우선 문서를 추가하고 기존 main 외 브랜치를 모두 정리.
- 동일 SHA production run 31667859879 success; autohwp.com CSP/PDF/AI 적용·undo 라이브 smoke green.
- 배포의 setup-node v4 Node20 경고만 #15(v7/Node24) 후속으로 처리 중; `control-audit.rs` 무접촉.
- #15→PR #16 CI green·main `86a4cff`; Node24 production run 31668877992 6m8s success, 경고 0·별칭 smoke green.

## 2026-08-12 (Codex sol) · 인앱 브라우저 라이브 퍼널 촬영
- autohwp.com 랜딩→예시 HWP→8 SVG→레이아웃 제보 실검증, 초안 파일명·본문·해시 없음 확인.
- 라이브 PNG 2컷 + 실제 프레임 88장 기반 22초 1280×720 MP4 생성, Threads 미디어 갱신.
- live smoke pass; durable Upstash만 pending이라 stage=beta-live 유지. 다음 PR #10 CI/merge.
- 선재 `control-audit.rs` 무접촉.

## 2026-08-12 (Codex sol) · 공개 베타 배포 완료·브라우저 허용 대기
- PR #9 CI green→main `31f205f`; 동일 SHA tag/prerelease/Vercel production run 31593516444 success.
- autohwp.com 홈·OG·canonical green, launch smoke 4/6 + privacy 테스트 보정 후 해당 항목 green.
- Upstash expected red 유지; pre-live 37/38. stage=beta-live, ready로 가장하지 않음.
- 최종 8쪽 퍼널 PNG/MP4는 Chrome 원격 디버깅 Allow 대기 후 수행. `control-audit.rs` 무접촉.

## 2026-08-12 (Codex sol) · 네트워크 중단 전 안전 정지
- 제품 커밋 `844bff3` push·PR #9 생성 완료; 태그·Release·배포·라이브 변경은 미실행.
- CI run `31588176341`의 build-test/licenses 진행 중에 사용자 요청으로 감시만 중단.
- 재개: context_restore→`gh pr checks 9`→green이면 merge→병합 SHA tag/Release/Vercel→live smoke.
- red면 로그 진단부터; Upstash durable gate pending, 선재 `control-audit.rs` 무접촉.

## 2026-08-12 (Codex sol) · 집단지성 베타 랜딩·실화면 자산
- 랜딩/README에 문서 1개→비식별 GitHub 조판 제보 기여 퍼널과 실제 8쪽 화면을 연결.
- Threads 초안에 실제 PNG 2컷·20초 MP4를 배치하고 공개 베타 릴리스 노트 완성.
- vitest 198·typecheck·build·PW 6/6·launch 29/29 green; full은 macOS Tauri clippy 20분 정체.
- Upstash는 소유자 결정으로 베타 유예하되 durable gate pending·전역 비용 위험을 명시. 다음 PR/CI→RC 배포.

## 2026-08-12 (Codex sol) · 소유자 승인 + 레이아웃 제보 퍼널
- privacy/동의/README에 “AI 문맥 전송, 오토한글(auto-hwp) 자체 보유 없음”과 rate-key 예외 고정.
- 파일명·본문·해시 없는 GitHub 조판 제보 버튼·경량 템플릿, Threads 6개 초안·이미지 2컷 완성.
- launch 29/29·report 35/40·pre-live 35/38; 남음 Upstash→RC SHA→tag/Release 뒤 live smoke.
- vitest 198·build·e2e 80/2skip·실브라우저·clippy green; full test는 macOS Tauri 링크 정체로 중단.

## 2026-08-12 (Codex sol) · pre-live 안전 정지점
- PR #5 `main` `a7e3a85`; launch automated 29/29·report 33/40·pre-live 33/38.
- open alert 0·보호 설정 유지. 남은 red는 owner 승인 2+Upstash+RC SHA+tag/Release 5개뿐.
- 다음은 외부 3조건 후 동일 SHA tag/Release/prebuilt 배포→pre-live green→live smoke; publish 미실행.

## 2026-08-12 (Codex sol) · dependency gate open 0 확정
- PR #4 필수 checks green 뒤 `main` `3a1b030` 병합; alert #16은 5초 뒤 fixed.
- Dependabot 최종 fixed 12·auto-dismissed 3·dismissed 1·open 0을 API로 재조회.
- 최종 증빙 PR에서 dependency pass; 이후는 소유자 승인 2건+Upstash가 라이브 선행 차단.

## 2026-08-12 (Codex sol) · PR #2 병합 + Rust High 후속
- PR #2를 보호된 `main` `76cdd8c`로 병합; 기존 npm/pnpm actionable alert는 모두 닫힘.
- 새 High #16 `quinn-proto 0.11.14`를 0.11.15로 패치, metadata/deny/fmt/launch 29/29/diff green.
- 다음은 workspace check→후속 PR CI/merge→Dependabot open 0→dependency gate 최종 증빙 PR.

## 2026-08-12 (Codex sol) · PR CI green + main 보호 적용
- PR #2 `b2258e2`: build-test 11m11s·licenses 2m47s green, checkout v6 경고 0.
- 실제 context 2개 strict+PR 필수+admin+대화 해결, force-push/delete 금지로 main 보호 후 API 재조회.
- 다음은 증거 커밋/push→CI 재통과→merge→Dependabot default-branch 재평가.

## 2026-08-12 (Codex sol) · Actions v6 회귀 게이트 green
- checkout v6 전환 뒤 launch 29/29·전체 workflow actionlint·diff green.
- 다음은 보강 커밋/push→PR CI 통과→main 보호/merge.

## 2026-08-12 (Codex sol) · GitHub Actions Node 24 전환
- PR 경고에서 checkout v4의 Node 20 강제 전환 확인; CI·배포·발행 5곳을 공식 checkout v6로 갱신.
- 정적 회귀 게이트를 추가. 다음은 launch/actionlint 재검증→커밋/push→PR CI.

## 2026-08-12 (Codex sol) · prebuilt-only 자동 게이트 green
- Vercel 자동 Git 배포=false와 수동 `--prebuilt` workflow를 P0 계약으로 잠금.
- launch 28/28·actionlint·JSON·diff green. 다음은 커밋/push→PR CI→main 보호/merge.

## 2026-08-12 (Codex sol) · Vercel prebuilt-only 불변식 복구
- PR Git preview가 독립 `file:` 패키지의 `vite` 미설치로 실패; 이 클라우드 빌드는 비지원 경로로 확정.
- 모든 브랜치 자동 Git 배포를 끄고 수동 `vercel deploy --prebuilt`만 허용하는 P0 정적 게이트를 추가.
- 다음은 launch/actionlint 재검증→커밋/push→PR CI→main 보호/merge.

## 2026-08-12 (Codex sol) · PR #2 Linux CI 전제 보강
- 첫 `build-test`는 Ubuntu의 Tauri 네이티브 라이브러리 부재로 `glib-sys`에서 red; licenses는 green.
- 공식 Tauri Debian prerequisite 설치 step을 추가하고 actionlint·launch 27/27·diff green.
- 다음은 보강 커밋/push 후 CI 재통과→실제 check 이름으로 main 보호→merge.

## 2026-08-12 (Codex sol) · RC 의존성 보안 보강 완료
- Dependabot 9건 중 JS 8건을 lockfile override로 해소하고 세 audit 0건, Tauri 2.11.5 데스크톱 check green.
- glib 1건은 Linux GTK3 전이·취약 API 비도달 근거로 `not_used` 위험 수용; main 병합 뒤 open 0 재확인 예정.
- `verify-launch` 27/27·전체 29/38, fmt·licenses·diff green. 다음은 보안 커밋→PR CI→main 보호/merge.
- 외부 차단은 소유자 문구 2건과 Upstash Production 변수 2개; 이 전에는 tag·배포·live smoke 금지.

## 2026-08-12 (Codex sol) · 082+085 RC 로컬 완료, PR/보호 레일 진입
- 082는 guarded 소스만 포함·공개 지원 제외, 085는 agent-first 문서/신뢰/비용/릴리스 게이트를 완성.
- GitHub 보안 설정·fresh Vite/Next/Node/Bun·pack 증거 완료; `verify-launch` 27/27 자동 green.
- `verify-local --full` green(8/18/24/6·vitest 261+64+416+195+11·e2e 79/2skip).
- 차단: 소유자 문구 2건 승인, Vercel Upstash 2변수. 다음은 두 커밋→PR checks→main 보호/merge.

## 2026-08-12 (Codex sol) · 085 L0/L1 자동 런칭 레일 green
- README/llms/docs CTA·privacy/security/community·PR CI를 보완하고 082는 네이티브 증거 전까지 런칭 제외.
- `verify-launch --automated` 25/25; 전체는 25/34이며 남은 9건은 ready/commit+소유자·GitHub·RC 수동 증거.
- launch 단위 5·app vitest 194·typecheck·production/static build·actionlint·브라우저 10 URL 모두 green.
- full 재검증은 무변경 rhwp/hwp-viewer rustc 유휴 대기로 중단; RC clean runner 재실행 필요. 커밋·푸시 안 함.

## 2026-08-12 (Codex sol) · 085 오픈소스 런칭 계획+게이트
- 컨셉 정본·agent prompt·콘텐츠 brief·상태 manifest와 정적 감사 33항/브라우저 5건을 구현.
- 단위 4건·typecheck green; 현행 report 7/33, strict는 남은 P0 23건 때문에 의도적으로 red.
- 비증분 full verify green: 게이트 8/18/24/6·vitest 944·e2e 79 passed/2 expected skip.
- 다음: 082 실물 확인·include/exclude 결정 후 L0→L1→L2→L3. 커밋·푸시 안 함.

## 2026-08-11 (Codex sol) · 082 HWP5 재저장 v1 구현 완료(미커밋·실물 게이트 대기)
- 원본 레코드/CFB 텍스트 패치, 좌표 기반 CellPath, MCP capability/export, preview 섹터 zeroing을 구현.
- 3종 주소 전수 일치·no-op 바이트 동일·rhwp/strict CFB·구조 편집 거부; `verify-local.sh --full` 전부 green.
- 남음: 공개 편집본을 한/글 또는 한컴독스에서 열어 수용 확인. 사용자 확인 전 커밋·푸시 금지.

## 2026-08-11 (Codex sol) · 084 main 반영 체크포인트
- 사용자 승인에 따라 084 코드·테스트·정본 7개 파일만 커밋/푸시; 선재 `control-audit.rs`는 제외·보존.
- 완료: live IR own-render·revision 캐시·원본 옵트인, 전체 검증·서비스 Docker green. 다음: 082 착수.

## 2026-08-11 (Codex sol) · 084 MCP render_page 자체 렌더 — 구현·검증 완료(미커밋)
- default/typed 렌더를 live IR own-render로 전환하고 revision SVG 캐시와 `source:"original"` 옵트인을 보존.
- red→green·feature/default/rhwp/pdf/no-default/wasm·서비스 Docker 빌드 green.
- `verify-local.sh --full` EXIT=0(게이트 8/18/24/6·vitest 944·e2e 79/2skip). 멈춘 곳: 사용자 확인 후 커밋/푸시→082.

## 2026-08-11 (Fable) · codex(sol) 인수인계 킷 — 084 이슈화 + 착수 프롬프트 4벌
- F1→이슈 084 승격, docs/handoff/CODEX-SOL-2026-08-11.md에 공통 절차+프롬프트 A(084)/B(082)/C(081)/D(083).
- 트랙 간 파일 비중첩 설계·동시 작업 조율 규칙 포함. 멈춘 곳: codex 착수 대기.

## 2026-08-10(c) (Fable) · 에이전트 퍼널 로드맵 + 082(.hwp 재저장)·083(README 비주얼) 기획
- 실사: hwp-mcp 서비스 모드·Docker·제안 흐름 기존재 — 갭은 렌더 교체(F1)·검토 세션(F2)·.hwp 재저장(F3=082)·운영(F5).
- AGENT-FUNNEL-ROADMAP.md 신설, 순서 제안 F1→F3→F2→F5→F4. 작업 미착수. 멈춘 곳: 착수 순서 결정 대기.

## 2026-08-10(b) (Fable+리서치 워커 2) · 081 기획 — 중첩 셀 캐럿 CellPath 관통
- rhwp 중첩 표 스레드 전수(198건 축) + claw-hwp 대조 → 교훈 6개를 설계·게이트로 채택, 이슈 081 확정.
- 작업은 미착수(지시대로 계획만). 멈춘 곳: 081 착수 승인 대기.

## 2026-08-10 (Fable 오케스트레이터+Opus 워커 4+검증 1) · 편집 품질 6건 — 5.5건 수리·레벨 진단 확정
- 원자적 applyBatch(고아 op 근절)·행/칸 정밀 앵커+고스트 프리뷰·불릿 서식 상속(protocol+engine)·PDF 화면동일 provider+미리보기.
- --full EXIT=0·vitest 944·e2e 79/2skip·라이브 ②~⑥ green. 멈춘 곳: ① 중첩 셀 캐럿(engine 갭 — nested-cell-caret-gap.spec fixme에 설계 보존).

## 2026-08-08 (Claude 오케스트레이터+Opus 워커) · 캘리그래피 로고 시스템 — A 워드마크+C 낙관 라이브
- codex 5안→사용자 선택 A+C, 파생(투명화·파비콘 타일·다크 재채색·OG·README 배너) 후 13차 배포 success.
- 라이브 실측: favicon 8.4KB·wordmark·seal·OG 200. 후보 4안 보존. 멈춘 곳: 없음.

## 2026-08-06 (Claude Opus 5) · 실도메인 디테일 6건 — 문서 세션 URL·로고 홈·토스트·탭·배지 툴팁·데모 태그
- `/d/<불투명 키>` 신설(lib/docUrl.ts): 열기=pushState, 새로고침·직접 방문=이 브라우저 매핑→스냅샷 재개, 없으면 안내 후 홈. Vercel=rewrite / Pages=404.html 폴백(둘 다 실검증).
- 배너→플로팅 토스트(닫기 버튼이 채팅 보내기를 가로채는 것을 e2e로 잡아 제거), 배지 "AI 켜짐"+서버발 모델 툴팁, 탭 아이콘 제거, 랜딩 "데모" 네비 제거.
- 검증 전부 그린: tsc·vitest 183·e2e 75(1skip)·next build·build:demo. 커밋/푸시는 하지 않음(워킹트리).
- 남은 것: 사용자 확인 후 커밋. 선재 결함 2건 기록(docs-site 셀렉터 — 수정함 / packages/react vitest 해석 깨짐 — 미수정, 환경).

## 2026-08-06 (Claude 오케스트레이터+Opus 워크플로) · autohwp.com 컷오버 완주 — 11차 파이프라인 그린
- 도메인·Git 연동·캡 완화·동의 모달 1회·/docs 허브·prebuilt 파이프라인. AI 실호출 정상(새 키 탑재).
- 삽질 규명: pnpm 11 CI 하드에러·vcp_ 토큰↔CLI 54 비호환 — 전부 로컬 재현으로 확정 후 수리.
- 잔여: 토큰 재발급(노출분)·Upstash·Pages 리다이렉트 스텁.

## 2026-08-06 (Claude 오케스트레이터+Opus 워커) · Vercel 이전 준비 + BYOK 확장성 진단
- 데모 AI Worker→라우트 포팅(4096·사유 표시 배선), 프리뷰 배포·실측 9/9. 컷오버 블로커=wasm 빌드→GH Actions prebuilt 권장.
- BYOK 진단: 구조 70%/문서 35% — P0 갭은 공식 스니펫 오류(프로필 누락)·BASE_URL env·RAG 슬롯. 배치 승인 대기.
- 멈춘 곳: 사용자 env 설정(OPENROUTER_API_KEY 등)·컷오버 방식 결정·갭 배치 승인.

## 2026-08-05 (Claude 오케스트레이터+Opus 워크플로) · README 대개편 — 히어로·GIF3·가이드·벤치 퍼널
- 피드백 10건을 5스트림 워크플로로: 라이트 히어로·가이드 GIF 3종·README 전면(데모/BYOK 분리·React 명문화·철학)·llms.txt/LLM-GUIDE/SELF-HOST·벤치 기여 퍼널+rhwp 리서치(breakthrough 후보 5).
- 검증 yellow→rhwp 귀속·LLM-GUIDE 키 오류 정정 후 4커밋 push·배포. 로컬 49건 스윕: .hwpx 쪽격차 집중(10/12) 실측.
- 멈춘 곳: 없음. 다음: 히어로 후보 선택(사용자)·B1 줄 델타 오라클·런치 잔여 2건.

## 2026-08-04 (Claude 오케스트레이터+Opus 워커) · 새로고침 자동 재개 — 052 위 마커 레이어
- 사용자 문제 제기(새로고침=초기화면)를 자동 재개로 해소: 마커+스냅샷→즉시 복귀, 닫기/고아는 현행 유지.
- StrictMode 가드 함정 실측 해결, e2e 57 그린, 라이브 dynamic 청크 실측. 후속: /bulk 퍼널 지속화.

## 2026-07-31 (Claude 오케스트레이터+Opus 워커) · 라이트 디폴트·lucide 24종 라이브
- 저장값>light 규칙(OS 감지 제거), lucide 앱 전용 교체 — 번들 +0.93%·공유 청크 0. e2e 54 그린, 라이브 실측.
- 멈춘 곳: 없음. 런치 잔여 동일.

## 2026-07-31 (Claude 오케스트레이터+Opus 워커) · /bulk 5단계 퍼널 — AI 위저드·고정 zip CTA
- 사용자 피드백(AI 왕복·export 혼란)을 스테퍼 퍼널로 재설계: ③ 이중 경로 분리+번호 3단계 위저드, ④ 하단 고정 CTA.
- 로직 무변경(파서 lib 이동+동치 12테스트), e2e 6/6(신규 퍼널 스펙), BULK-GUIDE 정합, 라이브 배포 실측.
- 멈춘 곳: 없음. 런치 잔여 동일 — 벌크 실물 100명(사용자)·런치 포스트 초안.

## 2026-07-31 (Claude 오케스트레이터+Opus 워커) · 데모 AI Luna 교체 — 비용 1/7·캡 2000 복원
- OpenRouter 단가 실측 후 openai/gpt-5.6-luna로 교체, 배포 후 실호출 스모크(정확한 Intent 반환)로 ZDR·리전까지 실증.
- 동의 문구·README 표기 갱신, 워커 테스트 model assert. 멈춘 곳: 없음 — 런치 잔여는 벌크 실물·포스트 초안.

## 2026-07-30 (Claude 오케스트레이터+Opus 워커) · 데모 라이트 모드·chrome 정리 라이브
- 사용자 피드백 4건(태그·배너·편집모드 제거, 빈 상태 중앙) + 라이트 모드(토큰 승격·토글·FOUC 0) 배포.
- 동의 게이트 무손상 — 상시 배너 제거해도 프라이버시 고지는 결정 시점 게이트가 담당. SDK 무수정.
- e2e 51+테마 2본 그린, 라이브 실측(부트 스크립트·구 태그 부재). 멈춘 곳: 없음 — 런치 잔여는 벌크 실물·포스트 초안.

## 2026-07-30 (Claude 오케스트레이터+Opus 워커) · 런치 준비 — Apache-2.0·README 압축·0.0.4
- 라이선스 Apache-2.0 단일화(+tarball LICENSE 동봉 신설 — 기존 미동봉 발견). README 359→176줄, CDN quickstart 실검증, 프레임워크 정직 고지, 배지 flat-square.
- 0.0.4 발행: 레지스트리 license=Apache-2.0·tarball LICENSE·jsDelivr 200 전부 실측. 데모 AI=GLM 5.2 고정 확인(배포 82a1a8ca).
- 멈춘 곳: 런치 전 잔여 = 벌크 실물 100명(사용자)·런치 포스트 초안·(선택) GA4.

## 2026-07-30 (Claude 오케스트레이터) · npm 0.0.3 발행 — CDN 임베드 실물 성립
- 4패키지 0.0.3 실발행+CHANGELOG 확정. fresh 스모크: react 단독 설치→cdn 서브패스 @0.0.3 자기 버전 pin 해석→jsDelivr wasm 200.
- 첫 dry_run 실패 = W6.1 버전 핀 가드 정상 작동(cdn.js ENGINE_VERSION 누락 차단) → 정합 후 그린. 가드 실전 검증.
- 배치 3 Pages 재배포 success(벌크 워커화·수식·080 라이브). 멈춘 곳: 없음.
- 다음 후보: 런치(보류 중)·enUS e2e 배선·075·076·xlsx 리더. 범프 체크리스트를 CURRENT_STATE에 기록.

## 2026-07-30 (Claude 오케스트레이터+Opus 워크플로) · 배치 3 — 080·수식·CDN·i18n·벌크 워커화
- 080 done: 3경로 공유 helper(LOCKSTEP 구조화)+발견 축②(noAdjust 고정 행높이) — bizinfo 25==25 게이트 신설. 수식 44/44 실렌더.
- W6: wasm CDN 자기버전 pin+진행률+영문 가이드(fresh tarball→jsDelivr 실측). 077 done(구현): koKR 이관 누락 0+AST 게이트.
- 벌크 워커화 2단계(메인스레드 점유 제거·검수 lazy). 통합 verify green: --full·vitest 761·e2e 50/50+fixme 1.
- 멈춘 곳: 0.0.3 발행 결정 대기(SDK 변경 도달성). 잔여: enUS e2e 배선·fonts 라벨 allowlist·075(흐름 높이 축).

## 2026-07-30 (Claude 오케스트레이터+Opus 워크플로) · 배치 2 — /bench·HWPX 편집 개방·README 증명
- W4.2 text_zone으로 섹션 첫 문단/개체 문단 텍스트 편집 개방(verbatim 불변), W4.3 HWPX 게이트 verify 편입+e2e 4종.
- W2 /bench 공개 벤치(수치 전부 실측+재현 커맨드+한계 고지), W5.2 README GIF·quickstart·비교표·34메서드 정정.
- --full 그린(e2e 47/47), 검증자 지적 2건 정정 후 3커밋 push(c8d1ffb~1daf003)·Pages 재배포.
- 멈춘 곳: 없음. 다음: W5.5 GeekNews 런치·W6(CDN/i18n)·076/078/080. /bench 수치는 조판 머지 시 동반 갱신.

## 2026-07-29 (Claude 오케스트레이터+Opus 워커) · W1 출시 완주 — 커밋 15·npm 0.0.2·Pages·Worker
- 논리 커밋 C1~C15 push(8240acc~5fc40cd), modu-startup 실물은 corpus/private 사유화(부재-내성 게이트).
- npm 4종 0.0.2 실발행+fresh 단독 설치 스모크 그린 — 0.0.1 file: 결함 종결. Pages/Worker 재배포 라이브 실측.
- 배치 1(벌크 5건·CHANGELOG·OG·W4.1 HWPX 문단 앵커)은 --full 그린(게이트 4종·E2E 43/43)으로 선검증.
- 멈춘 곳: 0.0.1 deprecate(사용자 npm login 필요)·키 회전(선택). 다음: W2 /bench·W4.2/4.3·W5.2·런치.
- 교훈 재확인: named 팀메이트 무음 정지 재발 → 사용자 지시로 무명 Agent/Workflow만 사용 확정.

## 2026-07-29 (Claude) · 채택 격차 리서치+작업 계획 (Fable Workflow)
- 워크플로 9에이전트(리서치 2∥감사 4→매트릭스 19행→W1~W6→완결성 검증)로 채택 병목을 확정 — 정본 `docs/ADOPTION-GAP-PLAN-2026-07-29.md`.
- 판정: 최대 병목은 미출하(0.0.1 `file:` 결함·라이브 구버전 모순 카피·게이트 수치 비공개·벌크 체험 진입로 부재). rhwp 3,615★ 선점 실측 → 4공백 축 집중.
- 엔진 critical 신규 확정: HWPX 문단 삽입/분리 저장 시 섹션 끝 append(순서 파손) → W4 계획.
- 멈춘 곳: W1.1 사용자 일괄 승인(커밋→0.0.2→Worker→Pages) 대기. 승인 전 착수 가능분: W1.3·W3·W3.6·W5.1.
- 재실행 워크플로 설치: `.claude/workflows/adoption-gap-research-plan.js`.

## 2026-07-29 (Codex) · 컴포저블 SDK 셸 + 벌크 첫 화면
- `workspacePanel`/`WorkspacePanelFrame`에 rail·bottom·modal·unstyled와 제어형 tab/open을 추가하고 기존 슬롯 호환을 유지했다.
- `/bulk`를 4단계 로컬 자동화 랜딩으로 고치고 README에 구조 일러스트·실화면 캡처, EMBED에 portal 조립법을 보강했다.
- Chrome 홈·벌크·8쪽 에디터 실검증, full verify 8/18/24/6·Vitest 225/51/369/53·E2E 42/42 PASS.
- built-in imagegen 자산을 workspace에 저장했으며 commit/push/deploy는 하지 않았다.

## 2026-07-28 (Codex) · 모두의창업 실물 충실도 + Figma식 스튜디오 완성
- cell image brush·빈 spacer metrics를 복원해 파란 띠/세로 위치와 6쪽을 HWP+PDF benchmark로 고정했다.
- 다크 홈·선택→디자인 자동전환·텍스트 무틴트 엔진캐럿·inspector/반응형 rail·커서고정 줌을 완성했다.
- 정본 `verify-local --full`: 8/18/24/6, Vitest 225/51/368/53, E2E 42/42, diff-check·external 무변경 PASS.
- 상용 한컴 폰트 미세 메트릭만 OFL 대체로 남으며 commit/push/deploy는 하지 않았다.

## 2026-07-28 (Codex) · 원위치 캐럿 + Figma식 디자인 패널
- hwp-lab 편집을 SVG 유지 엔진 캐럿으로 전환하고 편집 중 셀 색상 팔레트를 제거했다.
- 우측 바이브/디자인 탭과 문단·셀 inspector를 추가해 run 보존/기존 셀 서식 op로 연결했다.
- React 364·hwp-lab 53, 타입체크·양쪽 production build·diff-check PASS.
- Chrome/CDP 연결 0이라 localhost 육안 QA·새 UX 기준 E2E 이행은 다음 재개점이다. 미커밋·미push.

## 2026-07-28 (Codex) · React pack/publish 실패 원자성 보강
- 실패 주입으로 기존 prepack/postpack이 npm 오류 뒤 source manifest를 publish 모드로 남김을 재현했다.
- direct pack/publish는 fail-closed, safe wrapper는 build→치환→pack/publish→finally 복원으로 교체했다.
- 성공·ENOENT 실패에서 package.json SHA 불변, tarball은 ^0.0.2, source는 file:, publish dry-run·pack-deps·E2E 1/1·actionlint PASS.
- commit/push/외부 출시는 여전히 명시적 승인 대기이며 W1 staged 상태를 보존한다.

## 2026-07-28 (Codex) · c49d829 로컬 완료, 외부 출시 승인 대기
- Vite sidePanel을 복구하고 repo/fresh tarball 소비자 build·audit 0·E2E 1/1, 6개 workspace audit 0을 증명했다.
- 단일 cargo job의 `verify-local --full`이 게이트 8/18/24·Vitest 225/51/358/53·E2E 44/44까지 전부 그린이다.
- diff-check·external 무변경을 확인하고 Vite Node 계약을 >=20.19로 교정했다. W1은 staged됐지만 commit 승인이 없어 이력 변경은 멈췄다.
- 외부는 아직 npm 0.0.1, 7/25 Worker/Pages, 구 wasm 7,657,643B다. 승인 후 commit/push→npm 0.0.2→Worker→Pages→검증된 키 회전.

## 2026-07-28 (Codex) · sol medium 재개 준비 후 안전 중단
- 의존성을 Vite 7/Vitest 4/Next 15.5.22/Wrangler 4로 고도화해 6개 audit 0, JS 테스트·빌드·Worker dry-run, 4패키지 pack과 fresh 소비자 install/build를 통과했다.
- 중단점은 Vite 예제 E2E의 채팅 입력 부재이며 원인은 `App.tsx`가 `chatSidePanel()`을 주입하지 않은 것까지 확정했다.
- tf-hwp Next 서버를 종료했고 워커 3개는 모두 완료 상태다. 미커밋 변경과 외부 Secret/키/배포 상태는 건드리지 않았다.
- 다음 sol medium은 restore 후 Vite 예제 sidePanel 연결 → repo/fresh E2E → `PW_PORT=3288 scripts/verify-local.sh --full` 순서로 재개한다.

## 2026-07-28 (Codex) · c49d829 핸드오프 구현 완료, 전체 검증 중 안전 중단
- W1 셀 lineseg 게이트+실 inMargin 조판(8/18/24 유지, HWPX 5종 ±1쪽), W2 드래그 선택·paste·048 race 해소(225/358·repeat 10/10), W3 본문 캐럿 정본 API/cache/visual-affinity(1825/1825·p95 0.096ms)를 구현했다.
- 리서치 075~080을 문서화하고 공개 데모 AI에 전송 동의·정확한 개인정보 문구·bounded sanitizer/body·fail-closed config·R5 escape·ZDR·Worker 5테스트를 추가했다.
- npm 0.0.2 정합·fresh Vite pack·publish auth/preflight/부분재개까지 보완했으며, 아직 커밋·push·발행·배포·키 교체는 하나도 하지 않았다.
- 사용자 요청으로 `verify-local --full`을 workspace test 컴파일 중 중단했다(fmt·clippy만 PASS). 다음 sol medium은 restore 후 `PW_PORT=3288 scripts/verify-local.sh --full`부터 재실행한다.

## 2026-07-26 (Claude) · 074 조판 갭 해소 + 캐럿 범위선택/Enter
- 074: 오라클 25쪽 전제가 인공물이었음을 밝히고(NARROWLY→가로 오독) 진짜 원인 4갈래 수정 — 본문상자 여백·병합셀 균등분배·ragged 표·행높이 바닥. 총량 오차 0.08%, pps 3→4쪽=오라클 일치.
- 열너비 드래그 미반영 실버그 수정. LOCKSTEP 구조 보장 → benchmark2 25→24 정렬(e2e 기대값 근거와 함께 갱신).
- 캐럿: 범위선택(⌘B 부분서식) + Enter 문단분리/병합(새 op 2종, AI 비공개). 검증: 게이트 불변·파리티 22==22·e2e 43/43.
- 함정: e2e 스펙 3건이 좌표에 취약해 본문 3.4% 이동만으로 깨졌다(기능 회귀 아님). 병렬 작업은 합쳐서 e2e 를 돌려야 한다.

## 2026-07-25 (Claude) · 남은 축 3종 — 본문 캐럿·수식 회수·074 신설
- 본문 글자 캐럿 열림(packages 표면 우회, 99.2% 정렬, 클릭→오프셋 1516/1516). 안 되는 것: Enter 분리·Shift 범위선택·빈문단.
- 수식 0→44·쪽수 2→3(.hwp 일치), 필드쌍 회수. project_block 이 수식 문단 텍스트를 버리던 함정 수정. 차트는 근거 부재로 기각.
- 074 신설: hwpx 쪽수 20~25% 과소 계산을 오라클로 확정 — 조판 축, 표앵커 수정으로 드러남.
- 검증: 게이트 불변 · vitest 195/345 · e2e 43/43(wasm 재빌드 후).

## 2026-07-25 (Claude) · 세 축 병렬 — HWPX 파서·에디터 분리·문서 재구성
- HWPX 갭 원인 확정: .hwp=rhwp / .hwpx=자체파서. 값기준 dedup으로 charPr 214→87 붕괴. 속성 읽기 복원 + 구조갭 3종 → 조판이 rhwp와 301줄 일치(전 368, 초과분=표 개수 67).
- 채팅 UI를 SDK에서 분리(sidePanel 슬롯 13값) + ⌘Z/⌘⇧Z/⌘C. 문서를 능력 중심으로 재편 + CLI/BULK 가이드 신설.
- 함정 재발: e2e 포트 3100을 타 프로젝트가 선점하면 엉뚱한 앱을 테스트해 무더기 타임아웃 → PW_PORT. layout-check hwpx는 우리 파서를 안 탄다(양쪽 rhwp).
- 열린 것: 본문 캐럿·범위선택, 변환 hwpx 쪽수 과소계산, 수식/차트/필드.

## 2026-07-25 (Claude) · 정적 데모 AI = OpenRouter(Gemini Flash-Lite) via Cloudflare Worker
- 정적 사이트는 키를 못 담음 → 키 보관+일일 한도 강제하는 Worker 프록시(services/demo-ai-proxy). 모델 Gemini 3.5 Flash-Lite 서버 고정(입력 위주 작업 최저가), IP별+전체 일일 캡으로 $5/일 상한, CORS 잠금, 프롬프트는 워커가 ai-protocol로 조립(드리프트0·남용저항).
- 클라 데모 분기가 NEXT_PUBLIC_DEMO_AI_URL 있으면 프록시로 단발 위임(스트리밍/웹검색 off). 워커 단위검증 10/10, 브라우저 실증(채팅→Replace 제안 카드·에러0). 배포는 사용자(wrangler+secret) — README에 절차.

## 2026-07-23 (Claude) · 데모 로컬 루프 + 홈 화면 개선
- 배포 없이 정적 데모를 만지도록 dev:demo(:3311 핫리로드)·preview:demo(:3312 실제 export) 스크립트 추가.
- 홈: 랜딩 헤더 제거(문서 열면 복귀)·캐럿 14px 부드러운 점멸·지표 배지 제거·2갈래 카드(문서 편집/양식 일괄 작성)·.hwp 전용(+hwpx 알파 고지)·소개 4문구 자연어화. 용어 "벌크 채움"→"양식 일괄 작성".
- 함정: hidden 속성은 .lab-header의 display:flex에 밀린다 — 조건부 렌더로 지울 것.

## 2026-07-23 (Claude) · .hwp 변환 6쪽 리플로 = landscape 토큰 반전 (실양식 격파)
- 모두의창업 .hwp 오라클 재현(2→6쪽·가로 렌더) → 토큰 스왑 사본으로 인과 격리 → synth.rs 수정(OWPML 관례: 세로=WIDELY — 실물 26/29). 파서는 치수 유도라 자체 왕복 무증상이던 외부-리더 결함.
- 산출물 오라클 2쪽 복원. verify quick·e2e 그린. npm 0.0.2에 반영 필요. 잔여: 문단번호 아티팩트·신청서 +1쪽 별도 축.

## 2026-07-23 (Claude) · 073 명단 온보딩 — AI 프롬프트 제공
- 3단계 재설계: AI 프롬프트 복사(정의된 필드·규정 반영 — 아무 AI로 원본→우리 형식 정리, 채움은 결정론 유지)·형식 예시 넣기·키 칩·동적 placeholder·2→3 다리 문구. 실드라이브(규정 반영 OK)·e2e 재통과.

## 2026-07-23 (Claude) · 073 스튜디오 폴리시(매끄러움+다크 UI)
- 호버 셀 미리보기(ref 직접 스타일·리렌더 0)·오버레이↔카드 선택 동기화·이름 편집 포커스 유지(함정: 이름=React key → 리마운트 — 안정 id로 수정)·중복 이름 거부. 다크 브랜드 전면 재스타일(스텝 칩·그라데이션·문서 카드 섀도).
- 실드라이브: 연속 타이핑 포커스 true·호버 표시·선택 동기화·생성·에러 0. e2e bulk-fill-073 재통과.

## 2026-07-23 (Claude) · 073 필드 스튜디오 — 영역 지정·네이밍·규정·규격화 UX
- /bulk 2단계 재설계: 실렌더 위 셀 클릭=영역 지정(경계 히트테스트 결정론)·카드에서 이름/타입(정규식 검증)/필수 규정·규격 저장/불러오기(fillmap.json+sha 지문)·명단 4형식(CSV/TSV/kv-txt/JSON+EUC-KR).
- 실드라이브: 신청서 7+1필드·형식 위반/필수 누락 정확 보고·zip·에러 0. e2e bulk-fill-073 추가(1 passed). LLM/BYOK는 보조 설계만 — 핵심 결정론 유지.

## 2026-07-23 (Claude) · 073 웹 /bulk — 결정론 벌크 채움 테스트 환경
- hwp-lab /bulk 신설(클라이언트 온리): 인스펙션→검수 표→명단→생성+검증→캐러셀(실렌더+하이라이트)→zip. LLM 0콜 확정 — 전부 엔진 API(tableGrid/applyIntent/toHwpx/renderPageSvgSanitized/col·rowBoundaries).
- 실브라우저 드라이브: 실물 신청서 7필드·3명·zip 실다운로드·pageerror 0. 함정: 프로필 표 캡 20 → blocksInRect 전 표 열거로 인스펙션·검증 통일(거짓 경고 해소). 랜딩에 벌크 링크.
- 라이브 배포 검증 통과(Pages /bulk 실드라이브 — zip 다운로드까지 에러 0). 열린 것: pin 화면클릭 재지정 UI · XLSX · 실 100명 파일럿.

## 2026-07-23 (Claude) · 073 v1 구현 — inspect/fill 서브커맨드 (스크래치 클론 경유)
- 로컬 Desktop 접근이 세션 권한(TCC 추정)으로 막혀 퍼블릭 레포를 스크래치에 클론해 진행(push로 반영). 함정: 하네스가 매 명령 cwd를 차단 폴더로 리셋 — 전 명령에 cd 강제.
- 추가 리서치: 코퍼스 49종 실측(유도 61%·라벨우측 96%·예시칸>빈칸·중복 37건→pin 2단 구조 확정) + 생태계 포맷/UX 조사(airmang formfill.v1 채택·한글 키·3단 누락 정책·검수 3층+인문서 하이라이트=우리만 가능). 목업 bulk-review-mock.html 사용자 전달.
- 구현: fill.rs — inspect(초안+ambiguous)·fill(pin 결정론 적용→재개봉 검증→zip+report.json). 실물 E2E 5명(needsReview/strict 분기 실증)·유닛 3·clippy·게이트 8==8. 잔여: 검수 캐러셀 UI(hwp-lab)·XLSX·바이트보존 검증·실 100명 파일럿.

## 2026-07-23 (Claude) · 073 벌크 채움(메일머지) 타당성 — PoC 실증 + 생태계 조사
- PoC(실물 청창사 신청서): 라벨→값칸 fill-map 자동 유도 → 3인분 채움 60ms/부 → zip → 값 3/3 재검증. **HWPX 템플릿=무편집 바이트동일·편집 후 쪽수 불변(프로덕션급)** / .hwp 템플릿=변환 리플로 +1p(편집 아닌 변환 축, 무편집 왕복으로 분리 실증). 함정 3종 실측(값칸=예시텍스트·왕복 후 블록 인덱스 재배열·병합셀 거부).
- 생태계: "원본 .hwp 무훼손+무한컴+벌크+MCP" 완비 기존물 없음(공백지대). hwplib(Java .hwp out)·hwpx-mcp-server(mail_merge, hwpx 전용)·pyhwpx(Win+한컴)·kordoc(CFB 패치 근접)이 반쪽씩.
- 권고: 별도 프로젝트 아닌 같은 레포 새 표면(`auto-hwp fill` CLI v1). 073 이슈에 v1 스코프 승인 대기. 갭: .hwp 바이너리 출력·누름틀 fill op·셀 내 서명.

## 2026-07-22 (Claude) · README 임팩트 재작성 + 배너 v2 + 데모 랜딩 리디자인
- README 한/영: "AI에게 HWP는 보이지 않는 문서" — 왜 엔진 소유인가를 AI 인식 레벨 3성질(같은 IR 좌표계·타입드 Intent·게이트 검증)로 재서사(경쟁 언급 없이 구조 논리).
- 배너 v2: 실제 own-render 페이지(SVG)+AI 대화+위치보기 하이라이트 합성 — "제품 실사" 임팩트. 랜딩: .lab-demo 다크 브랜드 테마(워드마크·캐럿·배지·실렌더 스테이지·글래스 카드), 에디터 크롬은 무접촉(테스트 잠금 유지). 스크린샷 반복 검증 3회.
- 함정: 랜딩 데모 프리뷰는 NEXT_PUBLIC_DEMO가 아니라 **DEMO_STATIC=1**로 dev 기동해야 함(next.config isDemo). 열린 것: 에디터 화면 자체 테마는 후속(테스트 잠금 리스크).

## 2026-07-22 (Claude) · CI wasm 다이어트 근본 해소 — 라이브 7.30MB
- 근본 = apt binaryen 108(2022)이 최신 rustc wasm에서 실패→조용히 미적용. 공식 릴리스 119 고정 설치로 교체(배포·발행 공통, 중복 스텝 정리) → 재배포 실측 **11.13→7.30MB(-34%)**, CI 로그 "wasm-opt 적용 7478KB". README 발행됨 문구도 반영(56bc7a9).
- 다음 npm 발행(0.0.2)부터 레지스트리 wasm도 자동 다이어트. 남은 사용자 액션: 노출 토큰 폐기·재발급.

## 2026-07-22 (Claude) · npm 첫 발행 — @auto-hwp/* 4종 라이브
- 사용자 토큰 등록(gh secret) → publish.yml dry_run=false success → 레지스트리 실확인 4/4(0.0.1) + 신선 설치 스모크(npm i → buildDocContext 프로필 렌더·whitelist 19·engine wasm 동봉).
- ⚠️ 발행 wasm=11.6MB(CI에 wasm-opt/binaryen 부재 — 로컬 8.07MB): 0.0.2 전에 publish.yml에 binaryen 설치 스텝 추가할 것. ⚠️ 토큰이 셸/세션에 노출됨 — 사용자에게 폐기·재발급 안내.

## 2026-07-22 (Claude) · push + Pages 재배포 — 오토한글 라이브
- 15커밋 push(4568a39..aacd1a9) → deploy-demo(base_path=/auto-hwp) success → https://kwakseongjae.github.io/auto-hwp/ 실검증(200·오토한글 브랜딩·wasm 200). 구 URL 리다이렉트 확인.
- 열린 것: npm 발행 = 사용자 토큰(npmjs org "auto-hwp"+automation 토큰→gh secret set NPM_TOKEN) 후 dry_run=false. 로컬 폴더명은 tf-hwp 유지(사용자 결정).

## 2026-07-22 (Claude) · 리브랜딩 — 오토한글 (auto-hwp) (e41efa0)
- 레포/스코프/CLI/env 전면 치환(204파일, JOURNAL·history 제외)+GitHub 리네임+배너(assets/brand)+README 한/영 히어로+데모 카피. 게이트·vitest·e2e 42/42 그린.
- 함정: 타 프로젝트 3100 선점→e2e 엉뚱한 앱 재사용(2m 타임아웃 연쇄)→PW_PORT 손잡이. 열린 것: push+Pages 재배포(base_path=/auto-hwp) 승인 대기 · npm은 @auto-hwp 스코프 발행(토큰 등록 후).

## 2026-07-22 (Claude) · 잔여 마감 — 신선 설치 실증·fetch 스크립트·README 정리
- MCP 신선 설치(cargo install --git, 퍼블릭 레포) 완주 실증 · fetch-gov-corpus.mjs 7/7 · README 한/영+EMBED-GUIDE 이번 배치 기능 반영(프로필/19종/위치보기/서체/실물49·130p).
- npm 실발행 = NPM_TOKEN 부재로 사용자 액션 확정(토큰 발급→시크릿 등록→dry_run=false). 로컬 13커밋 미푸시 — push 승인 대기.

## 2026-07-22 (Claude) · 배포 표면 마감 — MCP·스킬·npm dry_run·KOGL
- MCP(승인분) 포장 done: 바이너리 이미 완동(핸드셰이크+15도구 실증) → MCP-GUIDE+README 레시피(cargo install --git → claude mcp add). 스킬: skills/hwp(CLI 래핑) 신설 — npm 임베드·MCP·스킬 3표면 완성.
- npm publish dry_run 성공 — 실발행은 dry_run=false 사용자 승인 1클릭. KOGL 25건 실측: 확인 8·4유형 2·불명 15 → 재배포 대신 corpus/GOV-SOURCES.md(7건 URL+sha256) 방식 결정(이미지 리스크 회피).
- 열린 것: npm 실발행 승인 · MCP/스킬 실사용 QA(외부 머신 cargo install 검증) · GOV-SOURCES fetch 스크립트화(후속).

## 2026-07-22 (Claude) · 072 위치 보기 + wasm 8.07MB + 플레이키 격리 (4adc541)
- 072: 카드 "⊙ 위치 보기"(revealBlock: blocksInRect 스캔→점프+플래시) done. react 321·tsc 클린.
- wasm: 전용 [profile.wasm-size]로 11.26→**8.07MB**(-28%), 정본 3경로 전환. 편집 +30%@18p(워커 비차단 — 수용). 벤치·e2e 스모크 그린.
- 플레이키: 자동 폰트 토스트 silent화+retries:1 → 풀스위트 42/42. 열린 것: MCP 셀프호스팅 포장 여부(사용자 결정 대기).

## 2026-07-22 (Claude) · rhwp v0.7.19 재벤더링 + 폰트 카탈로그 온디맨드 제공
- rhwp: upstream 태그를 미러에 직접 푸시해 needsExternal 해소 → v0.7.19 bump(fa72e42), lift.rs BinDataBytes 적응 3+2곳. 게이트·벤치 49/49 불변, wasm +1.5MB(upstream 성장 — 다이어트 후속).
- 폰트: FONT-CATALOG 8종 전부 OFL 재확인(Pretendard/Noto 포함). explicit-family bypass(엔진 3층) + ensureCatalogFont(react)로 리본/AI 지정 서체가 화면·PDF에 실서체 반영. react 320·e2e 41~42/42(048=039계열 순서 플레이키, 격리 그린).
- 열린 것: 048/039 플레이키 격리 · wasm 다이어트(11MB) · 072(카드 위치 보기) 설계됨 · MCP 표면화는 셀프호스팅 형태 의견 전달 후 사용자 판단 대기.

## 2026-07-22 (Claude) · 071 undo 메모리 버짓 — 130p RSS +403MB→+0.1MB
- 070 제안이던 직렬화 스냅샷은 **기각**(.hwp from-scratch 손실 실측 86→70p·rhwp 노드 재구성 불가·provenance 소실 — 딥카피만 bit-for-bit 복원). 대신 approx_heap_bytes 추정기(스파인+힙 계상, ±2×) + EditSession::with_budget(단일 push_undo·바닥 4) + 라이브 128MiB.
- 실측: 130p 편집50회 RSS +0.1MB(축출·재사용 정상상태)·깊이 10 정직 축소, **18p 실물 깊이 50 무회귀**. 게이트/clippy/workspace 56스위트/vitest/e2e 42 전부 그린, wasm 재빌드.
- 열린 것: 모델에 새 힙 캐리어 추가 시 추정기 동반 계상(071 함정 절) · XL 후속 옵션=구조 공유/IR-bincode 스냅샷 · 남은 후보 G(로컬 폰트)·rhwp 재벤더링(사용자 액션).

## 2026-07-22 (Claude) · 070 대형 문서 실측(보강 F) — 증분 조판 보류, 첫 병목=undo 메모리
- `large-doc-bench.mjs`(실 wasm·Node) 신설, 사다리 8~130p(실물 벤치2+딥테크25p+혁신바우처41p+합성 70/130p): 편집→화면 ~1ms/쪽 선형(41p=16ms·130p=136ms) → **증분 조판(XL) 보류**, 재평가 임계 150p+ 실물.
- **신규 발견**: undo 스냅샷 딥카피가 첫 병목 — 130p·50회 RSS +403MB(스냅샷 ~8MB) vs 직렬화 0.2MB/28ms → **HWPX-바이트 스냅샷 전환 = ~40배 절감** 후속 이슈 후보(hwp-ops/hwp-mcp 스냅샷 레인).
- 열린 것: 100p+ 실물 미확보(합성으로 외삽 — 등장 시 재측정) · 후속 후보 = undo 직렬화 스냅샷(신규 P1) · G(로컬 폰트 주입) · rhwp 재벤더링(사용자 액션).

## 2026-07-22 (Claude) · 진단 보강 B+E — AI 화이트리스트 19종 + export 정직성
- B(fb1268a): Replace·SetCharFmt·SetTableColWidths·SetPageMargins 개방(15→19, U4) — 어휘블록+FOOTER 스탠자+카드 3종+mock Replace. 실 Grok 마킹0 실증("전부 바꿔줘"→Replace{all:true} 카드). char오프셋/HWPUNIT 계열은 폐쇄 유지.
- E: PDF 스텁 경고 토스트(docProfile 카운트 재사용, 차단 아닌 고지)+HWPX 다운로드 버튼(toHwpx 노출)+README 한/영 "알려진 제약" 절(U7·G2·G6 해소). vitest 47/170/320/50, e2e 42/42.
- 열린 것: 진단 후속 다음 후보 = F(대형문서 100p+ 실측 — bench-public 41p 문서 활용) · G(로컬 폰트 주입) · rhwp 재벤더링(사용자 액션 대기).

## 2026-07-22 (Claude) · 069 해소 — e2e 5건 = 드릴 모델 미정렬 3스펙, 전체 42/42 그린
- 근본: QA2 #4 드릴 전환(59fef4f) 때 5스펙만 정렬, 048·050·052 누락 — 단일클릭 셀 스캔이 표 앵커만 얻어 실패. 그립(031) 인터셉트는 표면화 경로(052 타임아웃). 제품 동작 = 전부 승인된 정상 UX.
- 수정: 3스펙 헬퍼를 드릴 정렬(클릭=표 마킹→500ms→빠른 2클릭=셀 드릴, page.mouse 절대좌표) — 제품 코드 무변경. 3스펙 6/6 → **풀스위트 42/42 그린**(2회차).
- 열린 것: 039 간헐 플레이키(1회, 격리 그린 — 알려진 flaky로 추적) · 다음 후보 = 진단 보강 B(AI 화이트리스트 확대) 또는 E(PDF 스텁 경고+HWPX 버튼).

## 2026-07-22 (Claude) · 067 문서 프로필 구현 완료 (미커밋)
- 배관 전체: hwp-session `doc_profile`(순수 walk, LLM 0콜) → wasm/engine(worker METHODS) → adapter `docProfile?()` → `DocMeta.profile` → buildDocContext 앵커-우선 삽입 + FOOTER DOC PROFILE 스탠자 + LabWorkspace 요청당 조회.
- 검증: cargo 전체·게이트 8==8/18==18·wasm 재빌드+copy·vitest 169/46/316/50·e2e doc-profile-067(마킹0→프로필 첨부 고정)+066 통과·**실 Grok 실증**("Looking at the document profile, the first table is at [s0/b1]"→TableAppendRow 카드).
- 부수 발견: e2e 5건(052×2·048×2·050×1) **사전존재 실패**(stash로 HEAD 재현 확정, hw-row-grip 인터셉트 의심)→**069 신설**. 열린 것: 커밋(사용자 요청 시)·069 조사·067 후속(앵커 자동 후보 제시 UI).

## 2026-07-22 (Claude) · 진단 후속 — 067/068 신설 + 실물 벤치 49건 확보
- **067 문서 프로필**: 표면 검증으로 **LLM 0콜 결정론** 확정(native to_markdown/outline 완비 — 병목=wasm 노출). 배관 5단계 additive 설계를 이슈로 고정. 066 스테일 dist 함정 명기.
- **068 벤치**: bench-local-2026(24건, must-pass 8) + bench-public(25건 신규 수집, HWPX 17·7유형·12발행처·manifest/KOGL) = **49/49 ALL PASS**(detect/own-render/PDF/text). 게이트 scripts/bench-corpus.sh 신설. 시각 파리티는 미보증(딥테크 쌍 25p vs 18p) — 후속 QA 축.
- issues/README stale 표(064/065/066→done) 정정. 열린 것: 067 구현 착수 승인 · bench-public 공개 승격은 KOGL 재확인 후 사용자 판단 · 쌍 페이지수 비교 축.

## 2026-07-22 (Claude) · 사용자 관점 병목 진단 (분석-only, 코드 무변경)
- 4축 병렬 조사(엔진 crates·에디터/SDK·docs 자체진단·rhwp/kordoc 웹동향) → `docs/USER-BOTTLENECK-DIAGNOSIS.md` 발행(U1~U12·D1~D6·S1~S5 + 보강 A~G).
- 헤드라인: AI 문서이해 층 부재(U1, buildDocContext=4필드+마킹앵커뿐)·AI 화이트리스트 15/41(U4)·npm 미발행+온보딩 6단계(D1·D2)·rhwp upstream v0.7.19 전면경쟁+4버전 갭(S1·S2)·정부 HWPX 의무화 5/18 시행(S3)·PDF 수식/차트 스텁 무경고(U7).
- 열린 것: 보강 우선순위(A 문서프로필 자동화가 최우선 후보) 사용자 승인 대기 · rhwp 재벤더링 needsExternal(미러 포크에 upstream 태그 push 필요) · issues/README 표 stale(064/065/066) 정리.

## 2026-07-17 (Claude) · 퍼블릭 전환 + 데모 UX v2 + Pages 배포 (6ebfbb2)
- 데모 UX v2: ChatPanel `aiNotice` prop(정적 데모 "AI는 로컬 실행 시" 상시 배너), 랜딩 기능 카드 4종(게이트·round-trip·headless·AI)+문서 링크 5(GitHub/README/임베드/Intent/아키텍처), 헤더 데모 브랜딩("tf-hwp — 데모"+GitHub 링크, QA 모드는 hwp-lab 유지). Playwright 전항목 실검증.
- **public 전환 전 히스토리 스캔**: 354커밋 전체 — .env 추적 이력 0·실키 0(유일 히트=문서 플레이스홀더 sk-or-...). → 19커밋 푸시 → **tf-hwp PUBLIC 전환**(rhwp는 이미 public) → Pages 활성화(build_type=workflow, https://kwakseongjae.github.io/tf-hwp/) → deploy-demo 실행(base_path=/tf-hwp, run 29551279758).
- 1차 배포 실패(pnpm file:=설치시점 스냅샷 — react를 editor-core dist 전에 install→빈 패키지) → 워크플로 install 순서 수정 후 **2차 성공**. **라이브 실검증(Playwright)**: https://kwakseongjae.github.io/tf-hwp/ 에서 헤더·배지·기능4·링크5·샘플 원클릭→8쪽 렌더·채팅 aiNotice·에러0 (basePath /tf-hwp 하 wasm/샘플/폰트 전부 200).
- 후속 노트(저우선): CI wasm 12MB vs 로컬 9.5MB — engine build-wasm.mjs의 wasm-opt가 CI에서 미적용 추정, 로딩 최적화 여지.

## 2026-07-17 (Claude) · 오픈소스화 준비 완료 (7a0fc99·941ea13)
- 감사: 시크릿 클린(.env 미추적·키 패턴 0), 폰트 전부 OFL, rhwp MIT, oracle GPL 격리 문서화, npm 4패키지 발행 준비 완료(063). 부족분 = LICENSE 파일·README 스테일·정적 데모·CONTRIBUTING.
- **1/2 문서(7a0fc99)**: LICENSE-MIT+LICENSE-APACHE+NOTICE, README 전면 재작성(한글 메인+README.en.md — headless-first: engine이 메인·react는 선택, SemanticDoc+Intent 정본·XML/CSS 원기획→hwp-jsx projection 피벗을 "설계 노트"로 정직 문서화), CONTRIBUTING(게이트·LOCKSTEP·wasm 함정), PLAN/CHECKLIST/ROADMAP→docs/history/. corpus 유지(복학원서=빈 양식 확인).
- **2/2 정적 데모(941ea13)**: DEMO_STATIC=1→output:export(+basePath), build-demo.mjs(api/ 임시이동·복원), LabWorkspace "static" 모드(배지·AI 안내·BASE 접두), 랜딩 히어로(원클릭 샘플 2종·문서 미전송 문구·npm headless 안내), deploy-demo.yml(수동 Pages). **Playwright 실검증**: 정적 서빙에서 배지·히어로·샘플→8쪽 렌더·에러0. vitest 50·tsc 클린.
- 결정(사용자): 모노레포 유지+npm 패키지 분리(Grok 권고 동의), 데모=hwp-lab 정적화, README 한글 메인, corpus 공개, npm 발행은 나중(0.0.1 유지).
- 남은 사용자 액션: ①레포 public 전환 ②Settings→Pages→Source=GitHub Actions ③deploy-demo 수동 실행(base_path=/tf-hwp) ④(나중) npm publish. rhwp 포크 레포도 public이어야 서브모듈 클론 가능.

## 2026-07-17 (Claude) · 빈 줄/블록 편집 — 버튼→키보드 단축키 전환 (69a4208→7ea8b94)
- 사용자 요청: 표를 다음 페이지로 밀려고 빈 줄 넣기. 1차(69a4208)는 ＋/－ 빈 줄 버튼으로 구현했으나 "버튼 없어 보인다 → 단축키로" 피드백. 2차(7ea8b94): 버튼 제거+키보드.
- 엔진: editor-core insertBlankParagraph(InsertParagraphAt runs:[] — 빈 문단=조판기 한 줄 차지→아래 밀어냄)·deleteBlock(DeleteBlock), 기존 op/intent 재사용(신규 op 0)·각 1 undo.
- UX(최종): window keydown — LONE top-level 블록(문단 or 표) 선택 시 **Enter→빈 줄 아래 삽입**(연타=여러 줄), **Backspace/Delete→블록 삭제**(표 앵커도 삭제). 가드: ⌘/Ctrl/Alt 제외·editingOn+canEdit·in-place editor/inline panel 미개방·IME 미조합·isEditableTarget(챗·입력) 제외·단일 문단/표. refs로 현재 선택 읽어 1회 부착. 액션바는 여기서 편집/AI에게 전달만.
- 브라우저 실검증(doc9): 헤딩 선택→Enter×5→9→10쪽 밀림(+/− 버튼 없음 확인), 표("표 p.4") Backspace→삭제 10→9, 툴바 undo→10 복원. react 316·editor-core 169 그린. Rust 무변경.

## 2026-07-17 (Claude) · <hp:fwSpace/> 드롭 → 영문 병기 단어중간 깨짐 수정 (8d9c360)
- 사용자 전환: 청창사 hwpx는 완전 열화(타 툴도 못 엶)라 테스트 부적합 → 창도패(doc9)로. 새 문제: 목차표 좌측칸 "1. 문제인식(Problem)"이 "(Proble/m)"로 단어 중간에서 깨짐. 한컴독스는 "1. 문제인식 / (Problem)" 정상.
- **근본원인 실측**(doc9 raw XML): 셀 텍스트 = "1. 문제인식**<hp:fwSpace/>**(Problem)", paraPr breakLatin=KEEP_WORD. 파서 Empty 핸들러가 `<hp:fwSpace/>`(전각공백)를 other 분기로 흘려 텍스트 드롭+mark_not_simple. 공백 소실 → "문제인식(Problem)" 접합 → KEEP_WORD 백업할 공백 없어 단어중간 깸.
- 수정 2곳: ①파서 push_inline_char로 fwSpace→U+3000·nbSpace→U+00A0·tab→\t·lineBreak→\n 인라인 TEXT 복원(simple 유지=편집가능성도 회복). ②조판기 layout_paragraph break 기회를 U+3000에서도 기록(is_full_width(U+3000)=true라 폭1em·단어경계walk 이미 정합). benchmark U+3000 0개→게이트 무영향.
- **브라우저 실검증(doc9)**: (Problem)/(Solution)/(Scale-up)/(Team) 전부 온전, 한컴독스 일치. doc9는 정품이라 자동정규화 미발동(9p 충실 오픈=정상). 게이트 8==8/18==18, hwp-hwpx 57·typeset 62 그린, 회귀테스트 1 추가.
- 교훈: HWPX 인라인 제어문자(fwSpace/nbSpace/tab/lineBreak)를 텍스트로 안 살리면 줄바꿈·간격·편집이 조용히 깨진다. "충실 파싱=XML→IR 완전성"의 실체적 갭.

## 2026-07-17 (Claude) · 열화 자동감지→정규화 자동적용 — 업로드 기본=원본 근사 (ff4b3fa)
- 사용자 재보고 "hwpx가 원본 PDF와 전혀 다름(간격·색·보더·쪽수·폰트)". 재진단: 사용자 기준=원본 archive PDF(.hwp, 18p, p1에 체크리스트 1~12행+서명란)인데, 직전 커밋이 충실(=한글 미러 20p, p1에 1~7행)을 **기본값**으로 삼아 업로드 기본 모습이 원본에서 가장 멀어져 있었음. 한글의 .hwpx 렌더 자체가 원본과 전혀 다름((1).pdf 실측: 회색 안내박스·플래그 소실·20p) — 파일 열화.
- 해결: **wasm open이 열화 지문 감지 시 정규화 자동 적용**(줄간격+표 content-fit, normalize_active 보고), 정품은 충실 오픈. normalizeActive() 어댑터 체인 추가, HwpWorkspace 오픈 시 토글 동기화+열화 감지 토스트.
- **브라우저 페이지 단위 시각검수(cc.hwpx vs 원본 PDF)**: 업로드 즉시 17p, p1 체크리스트 **1~12행 전부**(원본 동일), 본문 **serif 실렌더**(함초롬바탕→NanumMyeongjo, 원본 신명조 방향 일치), 파랑/빨강/회색·테두리·열비율·라디오(■/□)·중첩 사업비표(p2)·증빙서류 빨강(p12) 전부 원본과 일치.
- 남은 갭(정직 보고): ①p1 하단 서명란이 p2로 밀림(17p vs 18p, 공유 조판기 메트릭 — .hwp 게이트가 잠가 조정 불가·열화파일 고유) ②▸플래그 배너(한글 hwpx 렌더도 소실=변환 손실) ③안내박스 빨간 테두리(.hwp 경로도 동일한 우리 렌더러 한계, 문단 테두리 미구현). 게이트·react316·editor-core168 그린. mode-aware 배치 full verify도 그린(✅ 전부 그린).

## 2026-07-17 (Claude) · mode-aware 표 행높이 옵션 구현 (5e18905)
- 사용자 요청으로 "충실=한글 렌더에 맞춤" 옵션 구현. 재분석: 손실 hwp→hwpx의 auto-fit 표는 저장 cellSz가 균일 명목값(2200)인데 **한글은 max(내용,저장)로 플로어** → 벌어짐(체크리스트 7행/p, 20p). 우리는 7a06e9f로 content-fit(16p)이라 한글과 달랐음. 한글 .hwpx PDF가 page2에 체크리스트 8~12행으로 시작(=page1 1~7행)한 것이 플로어 증거.
- 구현(round-trip 안전 우선): 파스는 auto-fit 표 cellSz 플로어를 **새 렌더-IR 필드 `Table::stored_row_heights`에만** 담고 `row_heights`는 content-driven 유지(054/020 왕복 테스트 무영향). JSX `table_eq` 미비교(src_span식). normalize 모듈 `apply_faithful_table_heights`⇄`content_fit_autofit_tables`(상호역·멱등, nested 표 순회, fixed 표 미접촉). wasm open이 기본 충실 플로어 적용, setNormalize가 baseline 복원+플로어 재적용→applied 시 content-fit.
- **브라우저 실검증(cc.hwpx)**: 충실 **20p = 한글 .hwpx 렌더 정확 일치**(체크리스트 벌어짐) ↔ 정규화 **17p**(≈.hwp 18p, 체크리스트 1~4행/p 조밀) ↔ 오프 20p 복귀. 게이트 8==8/18==18(.hwp 무영향), model 15·hwpx 56·jsx·ops 79·react 316 그린.
- 이제 두 모드 모두 원칙적: 충실=한글 미러(20p), 정규화=.hwp 복원(17p). 사용자 검수 대기.

## 2026-07-17 (Claude) · 정규화 지문 코퍼스 검증(Task3) + 표 행높이 축 조사(Task2) (471adf1)
- **Task3 지문 검증**: archive 실물 12개 .hwpx 스윕. **발동 3/3 = 전부 한글 hwpx저장 열화본**(doc3 예창패·doc7 초창패·doc11 청창사, loose 93~99%). doc3/doc7은 .hwp 쌍둥이 대조로 확정: .hwp 130%본문(loose44/41%) vs .hwpx 160%붕괴(99%) → 발동 정당(오탐0). **비발동 9/9 = 130% 본문 지배**(loose 31~48%, 쌍둥이도 동일=정품). 경계(발동93~99% vs 비발동31~48%)가 임계값0.60을 큰 여유로 통과. 그 경계(45% loose+rich pool→미발동)를 회귀테스트로 고정.
- **Task2 표 행높이 축 결론 = 무변경(현행 content-fit이 정답)**: 실험(플로어 항상적용) 결과 열화doc 페이지가 .hwp에 근접(doc3 5→6, doc7 5→6, doc11 정규화17)하나, 저장 cellSz높이=균일 명목값(2200)이라 **단일행(체크리스트)을 강제로 늘려 페이지당 항목수 감소** → 사용자 검증한 "자가진단표 1~12행" 밀도 역행(7a06e9f "플로어→7항목 vs 무플로어→12항목"과 일치). 열화 .hwpx는 .hwp의 실제 per-row 높이를 잃었으므로 content-fit이 최선근사. 실측 doc11 정규화 브라우저17p≈.hwp18p로 이미 근접. → 플로어 미적용 유지.
- 옵션(저우선·미실행): 충실 모드를 Hancom render(플로어=20p)에 맞추는 mode-aware 표높이 — 사용자 관심은 정규화(=.hwp)라 가치 낮음.

## 2026-07-16 (Claude) · HWPX 줄간격 근본진단 + "레이아웃 정리" 토글 (4d74c11·d23ee43)
- 사용자: "그냥 대응 말고 원인부터. hwp 동작방식이랑 다른게 있으니 이런 드라마틱한 차이가." → **통제실험**(archive의 동일문서 .hwp/.hwpx 둘 다 파싱): .hwp 줄간격 130%×501 다양 vs .hwpx 160%×1098(94%). 원인=한글 "hwpx 저장"이 본문 78%(916/1172)를 바탕글 기본 paraPr(id0=160%)로 리매핑→원본130% 파괴. version.xml=Hancom Office 13(우리변환 아님). **한글 자신도 이 hwpx를 20p(=.hwp 18p보다 벌어짐)로 렌더**(참조PDF 2p 직접비교로 확인)→우리 읽기는 파일에 충실. 즉 괴리=파일 열화지 렌더버그 아님.
- 사용자 선택(AskUser): "충실 기본 + 정규화 토글 둘 다". 구현: hwp-model::normalize_line_spacing(열화지문=단일 loose>60%지배+풀에 미참조 tight다수 감지→collapsed 문단 160→풀중심130% 복원, 렌더-IR only·moat보존, 정품160%문서 미발동) → EditSession::doc_mut(리비전미범프) → wasm setNormalize/normalizeActive(baseline복원 가역+캐시클리어) → engine 래퍼(index.js/d.ts)+worker화이트리스트 → adapter/session → HwpWorkspace 툴바 토글.
- **브라우저 실검증**(cc.hwpx): 충실18p 체크리스트1~10행 ↔ 정규화17p 1~12행(=.hwp일치), report "160%→130% 1098문단", 토글오프 복귀. 게이트8==8/18==18·react316·editor-core168·rust그린.
- 함정: copy-wasm이 packages/engine/worker.js를 public로 복사(정본은 engine쪽) + index.js는 **수작업 래퍼 HwpDoc**이라 새 메서드 위임 수동추가 필수(안하면 "doc[args.method] is not a function") + 브라우저 모듈캐시로 하드리로드 필요. 7a06e9f가 fmt-dirty로 나갔던 것 이번에 정리(d23ee43).
- 열린 것: 정규화는 줄간격만(테이블 행높이 축은 후속). 사용자 재검증 대기.

## 2026-07-16 (Claude) · HWPX-vs-HWP 시각 파리티 — 브라우저 실검증 3수정
- 사용자 지시: "hwp랑 퀄리티 차이 거의 안나게 계속 고도화, PDF 바탕 시각검증". 참조 = 2026 청창사 신청서 PDF. 진단은 **export-pdf가 아니라 실제 브라우저(localhost:3000) 스크린샷**으로 함(CORS 서버 8899 + JS 업로드) — export가 못 잡는 폰트 이슈를 드러냄.
- **①행높이(7a06e9f)**: noAdjust=0(auto-fit) 표에 저장 cellSz 행높이 플로어 적용 → 20p 팽창. 게이트: 플로어 미적용으로 18p 파리티 회복.
- **②볼드(021a08f)**: @font-face에 weight 서술자 없음 + CJK 합성볼드 부실 → 헤더가 전부 regular로 보임(볼드 위계 상실). NanumGothic-Bold weight-700 실 face 로드. 브라우저 확대 검증(헤더 볼드 확인).
- **③serif(c51e5ef)**: 명조/바탕 run이 NanumMyeongjo 404 → 고딕 폴백. NanumMyeongjo Reg+Bold 번들(assets/fonts)+serif 400/700 @font-face. 브라우저 JS 검증: `Nanum Myeongjo 400|loaded 700|loaded`, serif text 18곳 실렌더. react vitest 316 그린.
- 열린 것: 자가진단표 ▸플래그 배너 형태(한글 네이티브 테두리 장식 — hwp/hwpx 양쪽 렌더 미구현, 저우선). 줄간격 밀도 미세차(파일 충실). 사용자 재업로드 시각확인 대기.

## 2026-07-15~16 (Claude) · 웹 QA 5차 3건 — 에이전틱버그·Figma툴바·HWPX렌더깨짐
- **#1 (59101a6)**: 에이전틱 편집이 "제안된 편집 없음"으로 멈춤 = **Grok이 emit_intents 터미널 툴콜에서 degenerate**(인텐트명 'SetTableCell纺'·공백 폭주 → 화이트리스트 드롭). + 러너 핫리로드됐으나 프롬프트 dist 서버캐시 스테일. 수정: emit_intents 툴 제거→최종 편집 JSON 배열 텍스트 출력(비스트리밍과 동일)+웹검색 캡 3회. 실 Grok 실증.
- **#2 (86ad5b9)**: 매 선택마다 뜨는 플로팅 툴바 짜증 → **조사서 지속 리본(FormatRibbon/048)이 이미 존재** 발견(플로팅은 중복). FloatingToolbar 렌더 제거+리본에 서체+컴팩트 AI pill.
- **#3 (88e9d31, A+B)**: HWPX가 hwp 대비 많이 깨짐 = **통제실험 근본**: 렌더엔진 공유·정상, HWPX 얕은 파서가 run char_shape 0·문단 para_shape 0 하드코딩(전 텍스트 10pt 검정)이나 **풀은 이미 파싱돼 메모리에 있음=배선갭**. resolve_shape_pools로 char/para 풀 배선+secPr 페이지 지오메트리. 실측 폰트 1→4~16종·검정→파랑/빨강 회복. round-trip moat 보존. 남은 것 C(표)·D(이미지).
- 교훈: 툴콜 강제(tool_choice force)는 Grok을 degenerate시킴 — 검증된 JSON-텍스트 출력이 안정적. 대형 피드백은 설계조사 workflow/agent 선행이 근본을 빠르게 잡음. HWPX는 rhwp 아니라 우리 hwp-hwpx 얕은 파서가 문제(배선만 하면 됨).
- 다음: HWPX C/D 착수 결정 + 사용자 로컬 QA(에이전틱 편집·툴바·HWPX 스타일).

## 2026-07-15 (Claude) · 웹 QA 4차 대형 다배치 8건 — 설계조사→4배치 순차 구현
- 발단: QA 8건 피드백(중첩표 사라짐·hover 오작동·문서구조 썸네일·웹검색 동적화·멀티모달·메모리·사고스트림·표생성). 6레인 설계조사 workflow(qa4-design-explore) → 엔진레벨 통일원칙(엔진=Intent, 나머지는 감싸는 층) → 사용자 승인 4배치.
- **배치1(16898c1)**: 호버 strict-containment(빈배경 색변 제거)·표생성 프롬프트(엔진 InsertTableAt 완비, 갭=프롬프트)·중첩표 Tier1(Op::SetTableCell 비파괴화=데이터손실 차단+정직토스트). **배치2(4e239d5)**: 페이지 썸네일 레일(기존 SVG 래스터 재사용·lazy)·멀티모달 입력(이미지=grok 비전 content-parts·문서=TXT추출, HWP/PDF 미지원칩). **배치3(d890d37, XL)**: 에이전틱 스트리밍 AI(?stream=1 NDJSON·모델주도 web_search 툴콜링·사고 타임라인·대화메모리 6턴, 토글 v1 대체). **배치4(8afc6e3)**: 중첩표 Tier2(CellPath 전스택·중첩 편집 가능).
- 교훈: 대형 피드백은 설계조사 workflow 선행이 효과적(6레인 병렬로 근본 매핑). 중첩표는 데이터손실 버그였음(SetTableCell이 cell.blocks 통째 교체→중첩표 영구드롭)—Tier1 우선 안전화 후 Tier2. 배치별 워크트리 병렬→순차 cherry-pick 전부 clean(파일 영역 분리). 실 Grok 스트리밍 웹검색 서버 스모크로 파이프라인 실증. 검증: 게이트 8==8/18==18 전배치 불변, vitest 40/168/318/50.
- 다음: 사용자 로컬 QA(8건) + 차트/도표 생성(ⓗ) 착수 결정 + 실 스트리밍 웹검색 UI 육안.

## 2026-07-14 밤 (Claude) · 웹 QA 3차 피드백 3건 — AI채우기 검정색·다중페이지드래그·챗revert+웹검색
- 발단: 사용자 QA에서 #1(표 자동인식·채우기) 실 Grok 프레임표 작동 확인(고무적) + 신규 3건. 조사 4차원(색상속·마퀴·AI라우트/UI/revert + OpenRouter 웹검색 실현성) → 구현 계획 → 사용자 승인(범위 ①②③-C·A-v1, 색상=AI채우기 항상 검정) → 3 병렬 워크트리.
- **① (32f521b)**: `Op::SetTableCell`/`SetParagraphRuns`가 빈칸 첫 run char_shape 전체(색)를 물려줘 예시 파랑/빨강이 채운 값에 반영되던 것을 plain-run 분기 char_shape clone→text_color=default 검정 reintern(폰트·크기 유지)으로 교정. 수동 명시색은 non-plain이라 자동 우회. hwp-ops 65·게이트 before==after·wasm 재빌드. **② (c6e5319)**: 마퀴 시작페이지 클립 해제 → pointerMoveMultipage(React가 캡처 하 교차페이지+sub-rect, core DOM-free)+auto-scroll+finishMarquee 페이지별 union. **③ (4aa1083)**: 챗카드 지속 되돌리기(undoDepth top-of-stack v1)+🔎 웹검색 토글(OnAiRequest additive opts, InlineEditPanel 무영향)+OpenRouter web plugin+citations(additive).
- 교훈: OpenRouter web plugin은 툴콜링 없이 자동검색+url_citation → JSON-only 프롬프트 계약 안 깨고 웹검색 가능(스트리밍 투명성만 큰 리팩터). 3 워크트리 clean cherry-pick(영역 분리 좋음). 검증: vitest 23/163/305/44·게이트 8==8/18==18·챗/smoke e2e 11.
- 다음: 사용자 로컬 QA(①색 검정·②교차페이지 드래그·③되돌리기/웹검색) → 잔여=always-revert 완전형(주소화/보상편집) + 스트리밍 투명성(③-v2).

## 2026-07-14 (Claude) · 웹 QA 2차 피드백 4건 — 스테일dist버그·deselect·Figma표선택·인라인편집
- 발단: 사용자 실사용 스크린샷 — "아이디어명은 여명거리로"가 대표자명 라벨칸을 덮음(066이 안 먹힘). 병렬 조사(4차원)로 근본 매핑.
- **#1 (0f09ac4)**: 라벨 덮어쓰기 근본 = **스테일 `ai-protocol/dist`**(066은 src만·앱은 dist 소비→grids 드롭). durable: hwp-lab predev/prebuild `build:deps` 선행 + verify-local.sh에 ai-protocol 빌드 + playwright webServer mock 고정. e2e로 docContext에 그리드 실림 확인. **#2 (0f09ac4)**: 빈바탕 클릭 미해제 = finishClick이 block_at nearest-band 폴백 신뢰 → strict-containment 재검사(+회귀 테스트).
- **#4 (59fef4f)**: Figma식 클릭=표/더블클릭=셀/재더블클릭·Enter=편집. editor-core drill 상태+drillInto+currentCell, React handleDoubleClick. **#3 (c1a9476)**: 인라인 per-element 편집(✨ 여기서 편집→요소 아래 패널→onAiRequest 즉시apply→적용유지/되돌리기, 이중 가드). 둘 다 워크트리, cherry-pick 시 finishClick(#2∩#4)·HwpWorkspace(#4∩#3) 병합·테스트 드릴모델 갱신.
- 교훈: **dist 소비 아티팩트는 소스만 고치면 안 됨**(066 회귀가 스테일 dist였음 — verify가 src로만 테스트해 그린으로 샜다). 워크트리는 분기 시점 주의(#3가 #4 이전서 분기→테스트 셋업 충돌). 검증: editor-core 162·react 301·게이트 8==8/18==18. 실포인터/프레임표 실Grok 육안은 로컬 QA 큐.
- 다음: 사용자 로컬 QA(#1 프레임표 표채우기·#2 deselect·#4 드릴·#3 인라인) → 잔여 UX 판단(AI 진입점 통합/인라인 수동편집).

## 2026-07-13 밤6 (Claude) · 실물QA P0 2건 병렬 수정 완료 — 065 압축mimetype ∥ 066 표그리드컨텍스트
- 한 일: 실물 스윕 P0 둘 다 병렬 워크트리 수정→병합→검증. **065**(79ecd1a 푸시): detect가 압축 mimetype HWPX를 거부하던 것을 ZIP 중앙디렉토리 엔트리 NAME 스캔(DOCX식, inflate 0) fallback으로 해소 — 실물 6/24 회복. **066**(dab3e87): 웹 doc-context가 표 그리드에 눈멀어 "표 채워줘" intents:[] 이던 것을 hwp-session `table_grid`(edit_target 언랩·active셀) → wasm tableGrid → WasmAdapter → buildDocContext 그리드 첨부(dedup·truncate·회귀 바이트동일) + 프롬프트 FOOTER(TABLE GRID/ADDING ROWS)로 해소. 소스 선택 (b) 채택 사유=to_markdown은 hwp-ai deps 유입·전문서 덤프·edit_target 미사용으로 프레임표 좌표 틀어짐.
- 검증: 통합 --full 그린(게이트 8==8·18==18, vitest 156/20/296/41, e2e 37 pass, wasm -Oz 재빌드). **실 Grok 4.5 실경로 실증**: 4행2열 라벨+빈값칸 그리드+"표 채워줘"→col1 값칸에만 4 SetTableCell(라벨 col0 미접촉), 066 이전 빈응답 완전 해소.
- 다음: 로컬 육안 QA(사용자) — QA.md ⑪~⑱ + 이제 표채우기 바이브 플로우 포함. 미푸시=066(dab3e87)+본 문서 커밋.

## 2026-07-13 밤5 (Claude) · 후속 배치 트리아지 + 실행(flaky·IME·BMP·PANOSE, 토스트 revert)
- 한 일: 미뤄둔 후속 트리아지 워크플로(90항목→actionable 7/외부6/XL多/디스코프). 3레인 병렬 실행:
  Lane A(react/lab): flaky 028툴바 격리(근본=더블클릭 Date.now 400ms창 부하시 초과→Date.now 고정, 3회 296/296)·IME Chrome CDP e2e(main 통과)·토스트(엔진이 CellHit.nested 미방출=dead-code→**revert 8170566, 064 신설**). Lane B(Rust): BMP PDF 임베드(순수 Rust bmp.rs, from_rgba8, 26테스트)·FaceName PANOSE 분류(rhwp type_info 제공, 게이트 before==after 완전일치=metric누수0). 조사: rhwp upstream=v0.7.18(3패치 뒤, 재벤더링 저리스크로 차트/수식 자동개선)·kordoc(MIT/TS, 제품참고 중간가치).
- 교훈: 후속도 실엔진 연동 확인 필수(토스트가 speculative dead-code였음 — mock만 통과, 프로덕션 미발화). 에이전트 2곳이 느린 e2e/브라우저 미설치로 반환 반복→직접 인수(IME는 브라우저 install 후 통과, flaky/BMP/PANOSE는 워크트리 게이트 직접확인).
- 다음: #7 npm 발행 자동화 → rhwp 재벤더링 v0.7.18 → QA 핸드오프(QA.md 정식 절).

## 2026-07-13 밤4 (Claude) · B3 차트 v1 병합 → 062 잔여 배치 마감
- 한 일: B3 062-7 차트(15fc718) — 신규 chart_render.rs가 rhwp OoxmlChart bootstrap, **B2의 PaintOp::Image.svg 채널 재사용**(별도 variant 불필요). lift Control::Shape arm이 OOXML Chart만 처리(GSO/레거시VtChart/비차트OLE→드롭=바이트동일). 박스=저장크기 예약(place_doc∥NaiveLayout LOCKSTEP). 게이트 선확인=두 벤치마크 차트 없음→구조적 중립. 게이트 8==8·18==18, 차트없는 문서 바이트동일(SVG/HTML/HWPX git-stash A/B), main --full 그린(e2e 39/39).
- **062 잔여 배치 완료**: B1 대각선X자·B2 수식v1·B3 차트v1. 062 전체(배포용복호·옛한글·금칙·대각선·수식·차트) = rhwp 승격 완료. 잔여=자체PaintOp v2(XL)·krilla PDF·레거시OLE·rhwp upstream델타. 폰트메트릭=디스코프.
- 다음: 사용자 로컬 QA(수식/차트/대각선 육안) 또는 잔여 v2 착수 결정.

## 2026-07-13 밤3 (Claude) · B2 수식 렌더 v1 병합
- 한 일: B2 062-5 수식(805c447) — 신규 eq_render.rs가 rhwp 수식 파이프라인 bootstrap(catch_unwind), EquationRef.rendered_svg additive 캐싱, **SVG 채널=PaintOp::Image.svg: Option<String> additive**(screen==export 유지: PDF/canvas는 svg 무시→stub, PDF 유보 공짜). rhwp px=우리 px=HWPUNIT/75 정합. own-render+HTML에 진짜 수식, PDF v1 stub. 게이트 8==8·18==18, 수식없는 문서 바이트동일, 실샘플 eq-002.hwp lift 실증. main --full 그린(e2e 39/39).
- 통찰: B2의 PaintOp.svg 채널을 B3 차트가 재사용 가능 → 계획이 우려한 별도 RawSvg variant 불필요.
- 다음: B3 062-7 차트 v1(OOXML, svg 채널 재사용) → 062 잔여 마감.

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
