# Changelog

auto-hwp(오토한글)의 **사용자 가시 변경**을 기록한다. 대상은 npm 패키지 4종
(`@auto-hwp/engine` · `@auto-hwp/editor-core` · `@auto-hwp/ai-protocol` · `@auto-hwp/react`),
`auto-hwp` CLI, 그리고 공개 데모다. 내부 리팩터·문서·CI는 사용자에게 보이는 결과가 있을 때만 적는다.

형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/)를 따르되, 아래 정책 때문에
`파괴 변경` 카테고리를 하나 더 쓴다. 각 항목은 한국어가 정본이고 영어 한 줄을 병기한다.

## 버저닝 정책 (0.x)

- 이 프로젝트는 [유의적 버저닝](https://semver.org/lang/ko/)을 따르지만 **아직 0.x다.**
  0.x 동안에는 **patch·minor 어느 자리가 올라가도 파괴 변경이 있을 수 있다.**
  1.0 이전에 "minor는 안전하다"는 semver의 보장은 적용되지 않는다.
- 대신 **모든 파괴 변경은 예외 없이 이 파일의 해당 릴리스 `파괴 변경` 절에 기록한다.**
  마이그레이션 방법을 같은 줄에 적는 것을 규칙으로 한다. 여기에 없는 파괴 변경은 결함이다.
- **안정 축 — Intent 스키마 v0는 다르다.** `docs/INTENT-SCHEMA.md`가 동결한 Intent JSON 표면은
  0.x 전체에 걸쳐 **additive-only**다: 필드 추가는 `Option<T>`(생략 가능)로만 하고, 의미 변경·필드
  삭제·필수화는 `intent_version` 범프로만 한다. 디코더는 `deny_unknown_fields`라 **알 수 없는
  intent 태그나 오타 필드를 조용히 무시하지 않고 하드 에러로 거부**한다(에이전트가 오타를 "성공"으로
  오인하는 것을 막기 위해). 즉 **TypeScript SDK 표면은 0.x 동안 불안정하고, Intent 계약은 안정이다.**
- npm 패키지 4종은 **한 버전으로 함께 올린다**(버전 동기). `@auto-hwp/react`는 발행 시점의 형제
  패키지 버전을 읽어 `^<버전>`으로 요구한다.
- **Rust 워크스페이스(`auto-hwp` CLI 포함)는 별도 릴리스가 없다.** `Cargo.toml`의
  `workspace.package.version`은 `0.0.1`에 머물러 있고 crates.io 발행도 없다 — CLI는 소스에서
  빌드해 쓴다. 그래서 CLI 변경도 npm 릴리스 절에 함께 적되 이 사실을 명시한다.

*(EN — Versioning: this project is pre-1.0. During 0.x any version bump may contain breaking changes;
every one of them is recorded in this file with a migration note. The exception is the Intent JSON
schema (v0), which is additive-only and rejects unknown intents/fields with a hard error. The four npm
packages are released in lockstep.)*

---

## [Unreleased]

0.0.4 발행 이후의 변경이다. 아래 SDK 항목은 **main에만 있고 아직 npm stable 0.0.4에는 포함되지
않는다.** 오픈소스 런칭 태그와 npm 버전을 억지로 맞추기 위해 재발행하지 않으며, 다음 lockstep npm
릴리스에서 별도 버전으로 낸다.

### 추가 (Added)

- **실험적 HWP5 텍스트 재저장 레인(공개 지원 제외).** `hwp-mcp`의 `rhwp` feature에서 원본 바이트를
  보존하는 텍스트 전용 `hwp_export_capability`/`export_hwp`를 추가했다. 구조·서식·이미지 편집은 출력
  없이 거부한다. 한/글 또는 한컴독스 실물 수용 증거가 끝나기 전에는 공식 지원 기능으로 주장하지 않는다.
- **`@auto-hwp/react` — 호스트 툴바 확장과 의존성 없는 아이콘 세트.** `toolbarItems`로 제품 고유
  액션을 전역 툴바에 넣고, SDK와 같은 글리프를 `icons` 네임스페이스로 재사용할 수 있다.
- **정밀 선택과 적용 전 고스트 프리뷰.** `@auto-hwp/editor-core`의 `rangeLabel`/`rangeText`,
  `intentGhost*`와 React `RowHeadOverlay`/`GhostPreviewOverlay`를 공개했다. 행 머리 및 Shift 범위 선택과
  제안이 덮어쓸 위치의 반투명 미리보기를 같은 주소 계약으로 제공한다.
- **PDF 미리보기 표면.** `PdfPreviewDialog`를 공개하고 데모 다운로드 경로가 저장 전에 결과를 검토할 수
  있게 했다.
- **AI 결과 진단과 문단 run 문맥.** `DocProfile`/`ParaRun`, `EditFailureReason`, 응답의 optional
  `reason`/`message`, 완결된 JSON 항목만 복구하는 `salvageJsonArrayItems`를 additive로 추가했다.

### 수정 (Fixed)

- **런칭 의존성 보안.** demo worker의 `undici` 7.29.0, lab의 `nanoid` 3.3.17, Tauri UI의
  `postcss` 8.5.23을 override/lockfile에 고정하고 각 npm/pnpm audit 0건을 확인했다. Tauri는 2.11.5로
  갱신했다.
- **`DocSession.applyBatch` 원자성.** 중간 Intent가 실패하면 앞서 적용된 op까지 롤백하고 refresh하여
  “실패했는데 일부만 남는” 고아 편집을 막는다.
- **패널/편집 UX 회귀.** 패널 접기 뒤 채팅 상태를 보존하고, 탭 라벨 정렬·행/칸 선택·undo 안내와
  PDF 화면 동일 경로를 보강했다.

### 변경 (Changed)

- **공개 데모 AI 모델 GLM 5.2 → GPT-5.6 Luna(OpenRouter).** 실제 6,082-token 문맥 청구는 요청당
  약 **$0.0124**로 초기 표면 단가 추정($0.0005)이 틀렸음을 확인했다. 공개 런칭 전 Vercel 경로의
  전체 일일 기본 한도를 **400회**(IP당 20회)로 다시 켰다. Upstash 미구성 시 인스턴스별 best-effort라는
  한계도 개인정보 안내와 런칭 게이트에 공개한다.
  *(EN — the demo model moved to GPT-5.6 Luna. A real 6,082-token request billed about $0.0124,
  invalidating the earlier $0.0005 estimate; the Vercel demo now defaults to a 400-request global cap
  plus 20 per IP. Without Upstash the global counter is per-instance best effort.)*

---

## [0.0.4] — 2026-07-30

라이선스 정리 릴리스 — 코드 변경 없음(0.0.3과 기능 동일).

### 변경 (Changed)

- **라이선스 `MIT OR Apache-2.0` → `Apache-2.0` 단일화.** 루트 `LICENSE-APACHE`가 `LICENSE`로
  바뀌고 `LICENSE-MIT`은 삭제됐다. npm 패키지 4종의 `license` 필드가 `Apache-2.0`이며, **이번
  발행부터 tarball에 `LICENSE` 파일을 동봉한다**(0.0.1~0.0.3 tarball에는 라이선스 파일이 없었고
  발행 시점 라이선스 표기를 그대로 유지한다). (`5905efd`)
  *(EN — License simplified to `Apache-2.0`; starting with this release the tarballs bundle the
  `LICENSE` file. Already-published 0.0.1–0.0.3 keep the license they shipped with.)*

---

## [0.0.3] — 2026-07-30

파괴 변경 없음 — 전부 additive. 기존 마운트 코드는 무수정으로 동작한다.

### 추가 (Added)

- **`@auto-hwp/engine/cdn` 서브패스** — wasm/워커 기본 URL이 jsDelivr로, **설치된 패키지 자신의
  버전에 pin**된다(`latest` 아님 — JS↔wasm 버전 불일치 차단). 이제 wasm 파일 복사·번들러 설정
  없이 `npm i` 만으로 렌더가 뜬다. 명시 URL 지정은 오버라이드로 계속 동작. (`0756f32`)
  *(EN — new `/cdn` subpath: wasm/worker default URLs point to jsDelivr, pinned to the installed
  package's own version. Explicit URLs still override.)*
- **다운로드 진행률** — `WasmAdapter`/engine 로더에 `onProgress` 콜백(수신 바이트 기반, 단조 증가
  실측). 데모 랜딩은 idle prefetch로 샘플 클릭 시 컴파일 완료 상태. (`0756f32`)
- **`@auto-hwp/react` i18n 주입 계약(이슈 077)** — `HwpWorkspaceProps.messages`에 typed catalog
  `WorkspaceMessages`를 DeepPartial로 주입(미지정 키는 한국어 기본값 폴백). 하드코딩 한글 365건을
  카탈로그로 이관(누락 0 독립 검증), 신규 bare literal은 AST 게이트가 차단. `@auto-hwp/editor-core`
  의 사용자 노출 문구도 같은 계약. (`11bd3de`)
  *(EN — inject a typed message catalog via `messages` prop; unspecified keys fall back to Korean.)*

### 수정 (Fixed)

- **HWPX 구조 문단 텍스트 편집 개방** — 섹션 첫 문단(대개 제목)·개체 품은 문단에서 타이핑이
  거부되던 것. 파서가 문단별 편집 가능 텍스트 창(`text_zone`)을 산출하고 ops/직렬화가 그 창만
  교체(secPr·개체 런 보존, 무편집 왕복 byte-verbatim 불변). (`c8d1ffb`)
- **HWPX 명시적 쪽나누기 소실(이슈 080)** — `pageBreak` 문단·표 앞 강제 개쪽이 조판에 반영되지
  않아 정부 양식류 쪽수가 어긋나던 것 + noAdjust 표 행높이 과다 예약. bizinfo-mss 붙임1이 한컴과
  **25==25** 일치(게이트 신설). `.hwp` 경로는 구조적으로 무영향. (`1f18305`)
- **HWPX 수식 실렌더** — HWPX로 저장/재개봉 시 수식이 회색 스텁 박스로 나오던 것 → `.hwp` 쌍둥이와
  동일한 실렌더(표본 44/44). (`6b3b66f`)

### 변경 (Changed)

- **자기 호스팅 파일 목록 4→5개** — `/cdn` 도입으로 `cdn.js`가 추가됐다. 자기 호스팅(오프라인/CSP)
  구성은 EMBED-GUIDE §2.2의 갱신된 5파일 목록을 따를 것(구 4파일 목록대로면 워커 로드 404).
  *(EN — self-hosting now requires 5 files including `cdn.js`; see EMBED-GUIDE §2.2.)*

### 데모 사이트 (npm 미포함)

충실도 공개 벤치마크 `/bench`(수치+재현 커맨드, `989d03d`) · 벌크 생성 워커화(대량 배치 중 UI
비블로킹·검수 lazy, `43a9463`) · 벌크 샘플 원클릭 체험·drag&drop·키 매칭 진단·PII 고지(`b60bde9`) ·
OG/파비콘/공유 카드(`e8bc7ee`) · README 편집 루프 GIF·quickstart·비교표(`1daf003`).

---

## [0.0.2] — 2026-07-29

npm 4종 발행 완료(publish.yml dry_run→실발행, publish:safe 경유). 발행 직후 fresh 디렉토리에서
`@auto-hwp/react` **단독** `npm i` → 형제 패키지 전이 해석 → import 성공을 실측했다(0.0.1의
`file:` 의존 결함 재발 없음 — react@0.0.2 dependencies는 `^0.0.2` 실버전).

*(EN — Published 2026-07-29. Verified post-publish: standalone `npm i @auto-hwp/react` in a fresh
directory resolves sibling packages from the registry and imports cleanly.)*

### 파괴 변경 (Breaking)

- **`@auto-hwp/react` — `HwpWorkspace`가 더 이상 채팅 UI를 렌더하지 않는다.** 워크스페이스는
  **문서 표면만**(페이지·선택·오버레이·수동 편집) 소유하고, 오른쪽 패널은 호스트가 조립한다.
  새 prop `sidePanel?: (api: WorkspaceSidePanel) => ReactNode`를 주면 그 자리에 호스트 패널이
  마운트되고, 생략하면 순수 에디터(뷰어 + 수동 편집)가 된다. 우리 채팅은 제품 계약이 아니라 데모용
  참조 구현이라는 판단. — *마이그레이션*: 기존 채팅을 그대로 쓰려면
  `sidePanel={workspacePanel({ onAiRequest, isMock, notice })}` 한 줄. (`79b81dd`)
  *(EN — `HwpWorkspace` no longer renders the chat UI. It owns the document surface only; the right
  panel is a host-supplied `sidePanel` slot. Restore the old layout with `workspacePanel(...)`.)*

- **`@auto-hwp/react` — `onAiRequest` 계약 변경: 워크스페이스가 더 이상 직접 호출하지 않는다.**
  콜백은 `WorkspaceSidePanel`을 통해 패널에 **전달만** 되고, 실제 호출은 패널이 한다.
  따라서 `sidePanel`을 주지 않으면 `onAiRequest`는 **한 번도 호출되지 않는다**(예외·경고 없이 조용히).
  0.0.1에서 `onAiRequest`만 넘겨 채팅이 동작하던 호스트는 반드시 패널을 배선해야 한다. (`79b81dd`)
  *(EN — `onAiRequest` is now handed to the side panel instead of being invoked by the workspace.
  Without a `sidePanel` it is never called — silently. Wire a panel to keep AI editing.)*

- **`@auto-hwp/react` — 채팅 전용 prop `isMock` · `aiNotice` 제거.** 패널의 관심사로 이동했다.
  — *마이그레이션*: `workspacePanel({ onAiRequest, isMock, notice })`의 같은 이름 옵션으로 옮긴다
  (`aiNotice` → `notice`). (`79b81dd`)
  *(EN — Removed the chat-only `isMock`/`aiNotice` props; pass them to `workspacePanel()` instead
  (`aiNotice` is renamed `notice`).)*

### 추가 (Added)

- **`@auto-hwp/react` — 공개 패널 조립 API: `workspacePanel()` · `WorkspacePanel` ·
  `WorkspacePanelFrame`.** 프레임은 배치만 담당하는 셸로 `rail | bottom | modal | unstyled` 프리셋과
  `open` / `onOpenChange` 제어형·비제어형 상태를 지원하며, children이 임의라서 React portal로
  워크스페이스 **밖** 제품 셸에 같은 `WorkspaceSidePanel` API를 연결할 수 있다. 기존
  `chatSidePanel`은 `workspacePanel`의 별칭으로 남는다(하위호환 유지). (`00be7a7`)
  *(EN — Public panel-assembly API: `workspacePanel()`, `WorkspacePanel`, and a placement-only
  `WorkspacePanelFrame` (rail/bottom/modal/unstyled, controlled or uncontrolled). `chatSidePanel`
  stays as an alias.)*

- **`@auto-hwp/react` — 디자인 인스펙터 표면.** `DesignPanel` 컴포넌트와,
  `WorkspaceSidePanel`의 optional 확장 4종 — `designSelection`(현재 단일 선택의 종류·라벨·페이지·
  own-render px 박스·서식 스냅샷), `applyDesign(patch)`, `designFonts`, `textEditing`. 전부 optional이라
  기존 패널 구현은 손대지 않아도 된다. (`00be7a7`)
  *(EN — `DesignPanel` plus four optional `WorkspaceSidePanel` fields for a host-owned Figma-style
  inspector. All optional — existing panels keep working untouched.)*

- **`@auto-hwp/react` — 새 prop 3종.** `brand`(전역 툴바 제품 라벨),
  `preferEngineCaretEditing`(own-render SVG 위에 엔진 글리프 캐럿으로 편집 — **기본 `false`**로 기존
  계약 보존), `formatSurface: "ribbon" | "inspector"`(**기본 `"ribbon"`** — 기존 두 번째 툴바 행 유지).
  (`00be7a7`)
  *(EN — Three new props: `brand`, `preferEngineCaretEditing` (default `false`), and
  `formatSurface` (default `"ribbon"`) — both defaults preserve the 0.0.1 behaviour.)*

- **`@auto-hwp/react` — 키보드 기본기: ⌘Z/Ctrl+Z 실행취소, ⌘⇧Z·⌘Y 재실행, ⌘C 선택 복사.**
  툴바 버튼과 같은 레인(`core.session.undo/redo`)이라 새 op·새 상태가 없다. 텍스트 입력 표면과 IME
  조합 중에는 가로채지 않고, 제자리 편집기가 열려 있으면 미커밋 텍스트를 지키기 위해 문서 단위
  undo를 막는다. ⌘C는 표/범위를 **TSV**(탭=열, 줄바꿈=행)로 복사해 스프레드시트에 격자로 붙는다.
  ⌘V는 대응 op가 없어 **범위 밖**이다(반쪽 기능 금지). (`ca664af`)
  *(EN — ⌘Z / ⌘⇧Z / ⌘Y undo-redo and ⌘C copy (tables/ranges as TSV). Never intercepted while typing
  or composing (IME). ⌘V is deliberately out of scope — no matching op yet.)*

- **`@auto-hwp/engine` — 본문 문단 캐럿 API 2종.** `bodyTextHit(page, x, y)`는 own-render px 클릭을
  편집 가능한 `(section, block, offset)`으로 해석하고, `bodyCaretRect(page, section, block, offset)`은
  그 위치의 zero-width 캐럿 사각형을 돌려준다. 둘 다 캐시된 PlacedGlyph 스트림에서 나오며 SVG 마크업이나
  rhwp 좌표를 쓰지 않는다. 새 `Outcome` variant `hitBody` / `caretBody`. (`e0b38f5`)
  *(EN — Two body-paragraph caret APIs, `bodyTextHit` and `bodyCaretRect` (own-render px), served from
  the cached glyph stream. Adds the `hitBody` / `caretBody` outcomes.)*

- **Intent 스키마 v0 (additive) — `SplitParagraph` · `MergeParagraph`.**
  `SplitParagraph{section, block, at}`은 캐럿 위치에서 문단을 둘로 나눈다. **머리가 정체성을
  유지**하고(NodeId·원본 바이트 스팬·문단모양 그대로 → 무편집 왕복의 바이트 보존 유지) 꼬리만
  `block+1`에 새로 삽입된다. `MergeParagraph{section, block}`은 그 정확한 역연산이다. 둘 다 구조
  문단(이미지/필드/복합)과 표 앵커 문단은 거부한다. **AI 화이트리스트
  (`DEFAULT_ALLOWED_INTENTS`)는 바뀌지 않았다** — 캐럿 상대 오프셋은 모델이 알 수 없으므로 수동
  편집 전용으로 둔다. (`26c0de5`, `docs/INTENT-SCHEMA.md`)
  *(EN — Two additive intents, `SplitParagraph` / `MergeParagraph` (exact inverses). The head keeps its
  identity so byte-verbatim round-trips survive. Not added to the AI allowlist — manual caret editing only.)*

- **`@auto-hwp/ai-protocol` (additive) — `Anchor.path?`** (중첩 셀 하강 경로,
  `{block,row,col}` 배열)과 `RequestLimits`의 optional 상한 4종 `maxAnchorLabel` · `maxAnchorText` ·
  `maxAnchorPath` · `maxAnchorsJson`. 기존 요청은 그대로 파싱된다. (`c080c3a`)
  *(EN — Additive `Anchor.path?` for nested cells plus four optional anchor caps in `RequestLimits`.
  Existing requests parse unchanged.)*

- **`auto-hwp` CLI (소스 빌드 — crates.io 미발행) — 벌크 채움 2단 서브커맨드 `inspect` / `fill`.**
  `inspect`가 양식에서 라벨→값칸 fill-map 초안(`autohwp.fillmap.v1`)을 유도하고(모호한 것은 표시), 사람이 pin으로 확정한 뒤 `fill`이
  명단(JSON 또는 단순 CSV)을 **결정론으로**(LLM 0콜) 적용해 인원별 HWPX + `output.zip` +
  `report.json`을 낸다. 재개봉 검증(값 존재 + 쪽수 == 무편집 왕복 기준선)을 거치고, 문제 행은 기본
  `needsReview`로 보고하며 `--strict`면 스킵한다 — **조용한 빈칸은 금지**. (`f94c4ed`, 이슈 073)
  *(EN — New CLI subcommands `inspect` / `fill`: derive a fill-map draft, pin it, then deterministically
  (zero LLM calls) produce one HWPX per row plus a zip and a per-row report. Never silently blank.)*

### 변경 (Changed)

- **`@auto-hwp/engine` — 발행 wasm에 `wasm-opt -Oz` 다이어트가 실제로 적용된다.** 0.0.1을 발행한
  CI는 apt의 binaryen 108을 쓰는데 이것이 최신 rustc wasm에서 실패했고, 빌드 스크립트가
  `stdio: ignore`였던 탓에 **조용히 미적용인 채로 발행**됐다(그래서 0.0.1의
  `dist.unpackedSize`가 12,292,723 B다). 공식 릴리스 119로 교체해 근본 해소. 참고로 현재 로컬
  `packages/engine/pkg/hwp_wasm_bg.wasm`은 7,728,658 B다. (`77b2ae6`)
  *(EN — `wasm-opt -Oz` now actually runs for published builds; in 0.0.1 the apt binaryen 108 failed
  silently and shipped an unoptimized binary (0.0.1 unpacked size 12,292,723 B; current local wasm is
  7,728,658 B).)*

- **`@auto-hwp/react` — 발행 파이프라인을 `publish:safe` / `pack:safe`로 교체.** 소스 매니페스트는
  로컬 개발을 위해 `file:` 링크를 유지하고, 새 래퍼(`scripts/with-publish-deps.mjs`)가
  빌드 → `file:` → `^<실버전>` 치환 → **lifecycle을 끈** `npm pack`/`publish` → `finally` 복원을
  **한 프로세스에서 소유**한다. `npm publish`·`npm pack` 직접 호출은 `prepack`
  (`scripts/require-safe-pack.mjs`)이 즉시 실패시킨다. 아래 0.0.1 결함의 근본 수정이다. (`332e250`)
  *(EN — Publishing now goes through `publish:safe` / `pack:safe`, which owns build → dep rewrite →
  lifecycle-disabled npm → restore-in-`finally` in one process. Direct `npm publish`/`npm pack` is
  hard-blocked. This is the root fix for the 0.0.1 defect below.)*

- **`@auto-hwp/ai-protocol` — LLM user turn 조립이 프롬프트 인젝션에 대해 닫힌다.** 앵커를
  `<document-content>` 펜스 **안으로** 옮기고, 문서 파생 텍스트(docContext·앵커 라벨/본문·첨부
  이름/MIME/본문)의 `<`·`>`를 이스케이프한다. `<attachment>`의 메타데이터+본문은 하나의 escaped
  JSON 값이 된다. 앵커 텍스트나 파일명이 DATA 펜스를 닫고 새 지시로 위장하는 경로를 막는다.
  ⚠️ **조립된 프롬프트 바이트가 달라진다** — 프롬프트 문자열을 스냅샷 테스트하는 호스트는 갱신이
  필요하다(공개 타입·함수 시그니처는 그대로). (`c080c3a`)
  *(EN — Anchors moved inside the `<document-content>` fence and all document-derived text is
  `<`/`>`-escaped, so anchor text or filenames can no longer close a DATA fence and pose as
  instructions. The assembled prompt bytes change — update prompt snapshot tests.)*

### 수정 (Fixed)

- **`@auto-hwp/engine` (HWPX 파서) — 안 읽는 속성 때문에 서로 다른 글자모양이 하나로 뭉개지던 것.**
  같은 문서를 `.hwp`로 열면 조판 충실도 99.2%인데 `.hwpx`로 열면 86.9%로 떨어졌다. 원인은 값 기준
  dedup(`intern_shape`)이라 **안 읽는 필드가 많을수록 서로 다른 `charPr`이 병합**되는 것 —
  benchmark1에서 214개가 87개(41%)로 붕괴했다(rhwp로 같은 파일을 읽으면 214가 그대로). 장평·스크립트별
  글꼴 등 미독 속성을 복원하고 rhwp 파리티 오라클을 붙였다. (`8142b83`)
  *(EN — HWPX character/paragraph properties the parser never read caused value-based shape dedup to
  collapse distinct `charPr`s (214 → 87), dropping `.hwpx` layout fidelity to 86.9% vs 99.2% for the
  same `.hwp`. Properties restored, with an rhwp parity oracle.)*

- **`@auto-hwp/engine` (HWPX 파서) — 구조 갭 3종.** ① 섹션 순서를 `content.hpf`의 `<opf:spine>`에서
  읽는다(`section*.xml`을 **사전식** 정렬하던 탓에 섹션이 10개를 넘으면 `section10`이 `section2` 앞에
  왔다 — spine 부재 시 숫자 순 폴백, spine이 빠뜨린 섹션은 뒤에 붙여 콘텐츠 삭제 없음),
  ② 머리말/각주가 본문으로 누출되던 것, ③ 표 세로 회계 이중 오차. (`59f784e`)
  *(EN — Three HWPX structural gaps: section order now comes from the `content.hpf` spine (lexical
  sorting put `section10` before `section2`), header/footnote text no longer leaks into the body, and a
  double-count in table vertical accounting is fixed.)*

- **`@auto-hwp/engine` (HWPX 파서) — 수식이 렌더에서 통째로 사라지던 것.** `.hwp`는 rhwp lift가
  수식/필드를 의미 노드로 승격하는데 `.hwpx` 자체 파서는 폴백에서 **내용을 버려** 스텁 박스조차
  그려지지 않았다. `<hp:equation>` → `Inline::Equation`, 필드도 IR 노드로 회수. (`9229604`)
  *(EN — Equations were dropped entirely by the HWPX parser (not even a stub box rendered). Equations
  and fields are now lifted into IR nodes.)*

- **`@auto-hwp/engine` (조판) — HWPX 입력의 쪽수 과소 계산 4갈래.** 본문 상자·병합셀·ragged 표·행높이
  바닥이 각각 원인이었고 `.hwp` 경로에서는 서로 상쇄돼 숨어 있었다. (`047fc14`, 이슈 074)
  *(EN — Four separate causes of HWPX page undercount (body boxes, merged cells, ragged tables, row-height
  floor) — they cancelled out on the `.hwp` path and stayed hidden.)*

- **`@auto-hwp/engine` (HWPX 직렬화) — 우리가 쓴 세로 문서가 외부 리더에서 가로로 리플로되던 것.**
  `synth.rs`가 `pagePr`의 landscape 토큰을 직관대로(가로=`WIDELY`) 썼는데 OWPML 실제 관례는 반대다
  (한컴 저작 세로 HWPX 26/29건이 `landscape="WIDELY"`이고 H2Orestart도 `NARROWLY`를 가로로 읽는다).
  우리 파서는 토큰을 무시하고 치수로 방향을 유도하므로 자체 왕복·게이트에는 보이지 않던
  **외부 리더 전용** 결함이었다 — 한글/LibreOffice에서 세로 2쪽이 가로 6쪽이 됐다. (`5f21179`)
  *(EN — Our vertical HWPX output reflowed to landscape in Hancom/LibreOffice: the `pagePr` landscape
  token was serialized inverted vs the real OWPML convention. Invisible to our own round-trip because
  our parser derives orientation from dimensions, not the token.)*

- **`@auto-hwp/engine` (HWPX 직렬화) — 원본 문단 삽입·Enter 분리 저장 시 새 문단이 섹션 끝
  append로 문서 순서가 깨지던 것.** `serialize.rs` 앵커 레인(placeholder 2단)으로 수리 — 새 문단이
  원본 문단 사이 제자리에 직렬화된다. (`c3fe608`)
  *(EN — Newly inserted or Enter-split paragraphs were appended at the end of the section, breaking
  document order on save. Fixed with a two-pass placeholder anchor lane in `serialize.rs`.)*

- **`@auto-hwp/engine` (조판) — 표 셀 조판이 실 `inMargin` 대신 근사치를 쓰던 것.** `layout-check`에
  셀 lineseg 오라클(`--cells`)을 붙이고 입력을 production HWPX parser로 열어 한컴 stored lineseg와
  대조하도록 바꾸자 드러났다 — HWPX 5종에서 ±1쪽 오차. 쪽수 게이트에 24==24가 추가된다. (`8240acc`)
  *(EN — Table cells were laid out with an approximated inset instead of the real `inMargin` — ±1 page
  on five HWPX documents. Found by a new cell-lineseg oracle (`layout-check --cells`) that now reads
  input through the production HWPX parser.)*

- **`@auto-hwp/engine` (렌더/조판) — 셀 배경 image brush 누락 + 빈 spacer 행높이 붕괴.** 셀
  borderFill의 래스터 배경이 그려지지 않았고, 장식용 빈 문단 행의 높이가 바닥값으로 눌렸다.
  쪽수 게이트에 6==6이 추가된다. 실물 대조 벤치는 저작권 때문에 `corpus/private` 로컬 전용이며,
  부재 시 테스트·비교 스크립트가 missing-oracle로 정직하게 건너뛴다. (`0a231f3`)
  *(EN — Cell background image brushes were never painted and decorative empty spacer rows collapsed to
  the height floor. Adds a 6==6 page gate. The real-world comparison corpus stays local
  (`corpus/private`); tests skip honestly as missing-oracle when it is absent.)*

### 지원 중단 예고 (Deprecated)

- **`@auto-hwp/react`** — `FormatToolbar` · `FloatingToolbar`를 `@deprecated`로 명시했다.
  `HwpWorkspace`는 이들을 더 이상 렌더하지 않는다(서식은 상시 `FormatRibbon`으로 이동). 자체 chrome을
  만든 호스트를 위해 **export는 유지**하며, 제거는 major에서만 한다. `CellTextPopover`(이슈 032부터
  deprecated)도 같은 정책임을 주석에 명시했다. (`00be7a7`)
  *(EN — `FormatToolbar` and `FloatingToolbar` are marked `@deprecated` — `HwpWorkspace` no longer
  renders them. Exports stay for hosts with custom chrome; removal only in a major.)*

### 데모 사이트 (npm 미포함)

아래는 GitHub Pages 데모(`apps/hwp-lab`)와 그 AI 프록시 Worker의 변경이다. **npm 패키지에는 들어가지
않는다** — 버전이 아니라 배포 시점에 반영된다.

- **`/bulk` 웹 벌크 채움 신설** — 양식 + 명단 → N부 HWPX, **100% 클라이언트·LLM 0콜 결정론**.
  라벨→값칸을 지정·네이밍하는 필드 스튜디오, 3단계 명단 온보딩(AI 프롬프트 제공 + 형식 예시),
  명단 4형식, 검수 캐러셀, `.hwp` 변환 리플로 경고와 HWPX 보존 배지(포맷 정직 고지).
  (`dbf6e27`, `e4b5c5b`, `d1ad5c5`, `ede936f`, `2160b6c`, 이슈 073)
- **`/bulk` 첫 화면 재설계 + 체험 경로** — 파일 없이 눌러보는 **샘플 원클릭 체험**, 드래그드롭 업로드,
  **행 격리**(한 행 실패가 나머지를 죽이지 않음), **키 매칭 진단**(매칭·미매칭 키 표시), 그리고 AI로
  명단을 만들 때 개인정보가 외부 서비스로 나간다는 **PII 고지**. (`b60bde9`, 이슈 073)
- **정적 데모의 AI 경로** — Cloudflare Worker를 경유한 OpenRouter 연결. 모델은 Gemini Flash-Lite로
  시작했다가 Worker 리전이 Cloudflare에서 차단되어 GLM 5.2로 전환했다. (`27060b3`, `80baf1e`)
- **첫 AI 호출 동의 게이트** — 문서 내용이 외부 모델로 나가기 전 명시적 동의를 받는다. 위 AI 프록시
  경로(`27060b3`, 2026-07-25 배포)가 생기면서 라이브 카피("문서는 브라우저 밖으로 나가지 않습니다")와
  실동작이 어긋났고, 그 수정이다. (`2e96329` — **아직 미배포이므로 라이브에는 여전히 모순이 남아 있다**)
- **다크 스튜디오 셸 + 디자인 인스펙터 배치** — 편집 화면이 `formatSurface="inspector"`로 서식을
  우측 인스펙터 한 곳에 모으고, 상단은 문서/삽입/내보내기 전역 도구만 남긴다. (`2e96329`)
- **OG/트위터 카드 · 파비콘 4종 · 가치제안 description** — 데모 링크가 SNS/메신저에서 맨 URL로만
  보이던 것을 해소. 정적 export 경로 안정화를 위한 `trailingSlash` 포함. (`e8bc7ee`)
- **랜딩 리디자인** — 다크 브랜드, 모바일 레이아웃, 실렌더 합성 배너.
  (`b1a37c8`, `5ae7d4c`, `fe2fa89`, `b9952b4`, `87ad6ab`)

*(EN — Demo-only changes (GitHub Pages app + AI proxy Worker), not part of any npm package: the new
`/bulk` bulk-fill studio (fully client-side, zero LLM calls) plus its redesigned entry screen —
one-click sample run, drag-and-drop, per-row isolation, key-matching diagnostics and a PII notice; an
OpenRouter path via a Cloudflare Worker; a first-call consent gate before any document text leaves the
browser (still undeployed, so the live site still contradicts its own privacy copy); a dark studio shell
with the design inspector; OG/Twitter cards and favicons; and a landing redesign.)*

---

## [0.0.1] — 2026-07-22

`@auto-hwp` 스코프 **첫 npm 발행**. 4종 모두 같은 날 같은 분에 올라갔다
(engine · editor-core · ai-protocol · react, `2026-07-22T10:01Z`). (`aacd1a9` 시점의 트리)

> **2026-07-29 deprecate 완료** — 아래 결함 때문에 4종 전부 레지스트리에서 deprecated 처리했다
> (react: "broken file: deps", engine: "wasm-opt not applied"). `>=0.0.2`를 쓰라.

*(EN — First npm publish of all four `@auto-hwp` packages, 2026-07-22. All four 0.0.1 releases were
deprecated on 2026-07-29 in favor of >=0.0.2.)*

### 알려진 결함 (Known issues)

- **🔴 `@auto-hwp/react@0.0.1`은 단독으로 설치할 수 없다 — `file:` 의존이 그대로 발행됐다.**

  ```console
  $ npm view @auto-hwp/react@0.0.1 dependencies
  {
    '@auto-hwp/editor-core': 'file:../editor-core',
    '@auto-hwp/engine': 'file:../engine'
  }
  ```

  두 의존이 레지스트리 버전이 아니라 **로컬 파일 경로**(모노레포 형제 디렉터리)를 가리킨다.
  발행 tarball에는 그 디렉터리가 들어 있지 않고 소비자 머신에도 없으므로, `npm i @auto-hwp/react`
  단독 설치로는 두 의존을 가져올 수 없다. 이 결함은 0.0.2에서 수정된다(위 `publish:safe` 항목).

  *원인*: 이 저장소는 루트 pnpm workspace가 없고 패키지별 독립 `package-lock.json`을 쓰는 npm
  구성이라, 소스 매니페스트는 로컬 심링크를 위해 `file:`을 유지하고 npm의 `prepack`/`postpack`
  lifecycle이 발행 직전에 `^<실버전>`으로 갈아끼우는 방식이었다. 그 치환이 발행 tarball에
  반영되지 않았다. (`postpack`은 npm이 pack 도중 실패하면 실행 보장이 없어서, 이 lifecycle 의존
  자체가 안전하지 않다 — 그래서 0.0.2는 래퍼 프로세스가 전 과정을 소유한다.)

  *영향 범위*: **`@auto-hwp/react`만 해당한다.** `@auto-hwp/engine@0.0.1` ·
  `@auto-hwp/editor-core@0.0.1` · `@auto-hwp/ai-protocol@0.0.1`은 `dependencies`가 **비어 있어**
  (`npm view … dependencies` → 출력 없음) 단독 설치·사용에 문제가 없다. 즉 **engine 직접 사용
  경로는 0.0.1에서도 동작한다.** React 컴포넌트가 필요하면 0.0.2를 기다리는 것이 맞다.

  *(EN — 🔴 `@auto-hwp/react@0.0.1` shipped its two workspace dependencies as `file:` links pointing at
  the publisher's local paths, so a standalone `npm i @auto-hwp/react` cannot resolve them. The
  `prepack`/`postpack` rewrite of `file:` → `^version` never made it into the published tarball. Only
  `react` is affected — `engine`, `editor-core` and `ai-protocol` have no dependencies at all and work
  standalone, so the engine-only path is usable on 0.0.1. Fixed in 0.0.2.)*

- **`@auto-hwp/engine@0.0.1`의 wasm은 `wasm-opt` 다이어트가 적용되지 않은 채 발행됐다.**
  발행 CI의 binaryen 108이 최신 rustc wasm에서 실패했는데 오류가 삼켜졌다. 동작에는 문제가 없고
  **다운로드 크기만 손해**다(`dist.unpackedSize` 12,292,723 B). 0.0.2에서 수정.
  *(EN — The 0.0.1 wasm shipped without the `wasm-opt -Oz` diet (a silently failing binaryen in CI).
  Functionally fine, just larger than necessary. Fixed in 0.0.2.)*

---

> 릴리스 비교 링크는 아직 없다 — 이 저장소에는 릴리스 태그가 하나도 없어서(`git tag -l` 0건)
> Keep a Changelog의 diff 링크를 정직하게 걸 수 없다. 0.0.2 발행 때 `v0.0.2` 태그를 만들고
> 그때부터 링크를 붙인다.
>
> *(EN — No release-comparison links yet: the repository has zero tags, so a Keep a Changelog diff link
> would be fabricated. Tag `v0.0.2` at publish time and start linking from there.)*
