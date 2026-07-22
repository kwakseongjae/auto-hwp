# auto-hwp 프로덕션 로드맵 — "사용 가능한 수준"까지의 정직한 경로 (2026-06-18)

> 6개 차원(입력·export 충실도·레이아웃/렌더·편집/사용자플로우·맥 패키징·신뢰/AI)을 실제 코드 대비 진단 →
> 완결성 비평 → 종합한 결과. 이전 `PRODUCTION-DIAGNOSIS.md`를 대체한다. 핵심 P0 주장은 코드에서 직접 검증함.

## 0. 정직한 한 줄 평가 (Verdict)

auto-hwp는 **"AI가 붙은 충실한 뷰어"로는 이미 동작하지만, "한글을 대체하는 에디터"로는 아직 출발선**이다. 가장 결정적인 한계는 **문서 위에 커서를 놓고 글자를 칠 수 없다**는 것 — 일반 사용자가 .hwp를 열어 오타를 고치려 클릭하면 아무 일도 일어나지 않으므로, 카테고리명("에디터")이 약속하는 단 하나의 동사를 수행하지 못한다. 여기에 더해 (a) Raw 인라인(도형/차트/OLE/텍스트박스)이 편집 시 **조용히 손실**되는 무결성 위험, (b) `open/render/export`가 전부 동기 호출이라 실파일 크기에서 **UI 프리징**, (c) 저장 경로가 `fs::write` 단발이라 **저장 중 크래시 = 원본 덮어쓰기 손상**, (d) `csp: null` + `withGlobalTauri` + `innerHTML` SVG 주입으로 **악성 문서 → JS 실행** 경로가 열려 있다. 반대로 좋은 소식: 레이아웃 엔진은 측정·검증되어 있고(line-break 98.9% exact, 페이지네이션 clean 문서 정확), round-trip 바이트 안정성과 editor-open-safety 게이트가 살아 있으며, rhwp는 MIT라 in-process GPL 제약을 위반하지 않는다. **본 로드맵은 "타이핑 가능한 에디터"를 헤드라인으로 두고, 며칠짜리 안전·패키징 수선을 P0로 먼저 막은 뒤, 표준 워드프로세서 기능을 채워 GA로 간다.**

---

## 1. 사용자 플로우 기준 현황 (USER FLOW)

전체 플로우: **발견/열기 (.hwp + .hwpx) → 충실히 보기 → 편집 → 충실한 .hwpx 저장(한글에서 열림)**

### 1-1. 발견 / 열기

| 항목 | 지금 (TODAY) | 갭 | usable bar |
|---|---|---|---|
| 포맷 감지 | magic-byte로 HWP5(CFB)/HWPX(zip+mimetype)/Unknown 판별, HWP3는 rhwp가 세분화 | 양호 | 유지 |
| .hwp 열기 | rhwp로 view, 옆에 편집용 .hwpx 자동 변환 | rhwp 기본 ON(viewer `default=["rhwp"]`) — 출하 앱은 rhwp 의존 | 변환 .hwpx가 한글에서 열림 |
| .hwpx 열기 | 직접 편집 가능 파싱 | 양호 | 유지 |
| Finder 더블클릭 | **불가** — `bundle.active=false`, fileAssociations 없음 | .hwp/.hwpx 더블클릭 시 auto-hwp가 안 뜸 | 더블클릭 → 2~3초 내 열림 |
| 대용량/동기 로드 | `open_doc`/`render_page`/`export_hwpx`가 **동기 `fn`** (lib.rs 47/81/105) | 수십MB에서 **수초 하드 프리징**, 스피너 없음 = 행/크래시처럼 보임 | 백그라운드 로드 + 진행 표시 |
| 배포용/암호 문서 | `decrypt_distribution()` 스텁 = NotImplemented | 기관 배포용 문서 **열 수 없음** | 명확한 에러 또는 복호화 |
| 최근 문서 / 드래그-드롭 | **없음** | 발견 루프 단절 | "최근 문서" + 창에 드롭 |

### 1-2. 충실히 보기

| 항목 | 지금 | 갭 | usable bar |
|---|---|---|---|
| 페이지 렌더 | **100% rhwp SVG** (충실), 스크롤 lazy-load | 자체 엔진 렌더는 hwp-render 스텁(빈 ops) | 원본 .hwp 충실 표시 (TODAY 충족) |
| 변환 .hwpx 렌더 | rhwp가 linesegarray 없는 변환본을 **오버플로**로 잘못 페이지네이션 | 자체 LayoutResult→paint IR 미구현 | 편집본도 화면에 반영 |
| 글꼴/글리프 | rhwp가 시스템 폰트 사용 | **함초롬/맑은고딕 등 미설치 시 tofu "?"** (별개의 "?" 문제) | 핵심 한글 폰트 번들 또는 폴백 체인 |
| 텍스트 선택/복사 | **불가** (커서 없음) | 뷰어인데 한 문장 복사도 안 됨 | 선택 → 복사 |
| 보안 | `innerHTML` SVG 주입 + `csp:null` + `withGlobalTauri` | **악성 .hwp의 SVG `<script>`가 Tauri 전역 API와 함께 실행** | CSP + SVG 새니타이즈 |

### 1-3. 편집

| 항목 | 지금 | 갭 | usable bar |
|---|---|---|---|
| op-bus | InsertText/DeleteRange/SetCharPr/SetParaPr/Table*/Append* + EditSession undo/redo (스냅샷, 원자적) | 견고 | 유지 |
| propose→commit | 스크래치 클론 dry-run → 1 undo 단위 commit | rationale·op 요약만, **시각 diff/페이지 델타 없음** | 커밋 전 페이지 영향 표시 |
| **WYSIWYG 타이핑** | **전무** — 캐럿/선택 모델 없음, 화면↔문서 좌표 매핑 없음, IME 없음 | **THE 핵심 갭**: 클릭해도 커서 안 생김, 입력 캡처 안 됨 | 페이지에 캐럿 → 타이핑 |
| 찾기/바꾸기 | **없음** | 워드프로세서 2번째로 많이 쓰는 기능 부재 | Ctrl+F / 바꾸기 |
| 서식 툴바 | 없음 (op는 있으나 선택 UI 없음) | 단어 선택→Bold 불가 | 선택 후 B/I/U/색/크기 |
| 표 셀/머리글/주석 편집 | non-simple 문단 in-place 편집 거부 (append-only) | 기존 구조 내부 수정 불가 | 셀 내용 직접 편집 |
| Raw 인라인 보존 | 편집된 문단의 `Inline::Raw`(도형/차트/OLE)가 재방출에서 **손실** | **무결성 블로커**: 편집 후 도형 증발, 경고 없음 | 경고 또는 편집 거부 |

### 1-4. 충실한 .hwpx 저장

| 항목 | 지금 | 갭 | usable bar |
|---|---|---|---|
| HWPX-only export | from-scratch 합성 + Skeleton seed, **HWPX 전용** (제약 준수) | 양호 | 유지 |
| open-safety 게이트 | `validate_synthesis_safety` (IDRef/itemCnt/manifest/field pairing) | manifest 검증이 regex 문자열 기반, 한글 오라클 미확인 | "필요조건이되 충분조건 아님"으로 정직화 |
| round-trip 바이트 안정 | HWPX-in 무편집 시 바이트 동일 (SOURCE_PART_TAG) | from-scratch는 의도적 lossy | 유지 (조건부로 정직 표기) |
| linesegarray | **의도적 strip** → 한글이 reflow | object-heavy/대형 문서 페이지 차이(test-image 2vs5, k-water 37vs27) | 빈 linesegarray(한글 정상 reflow) 우선 |
| 원자적 저장 | **`fs::write` 단발** (hwp-mcp lib.rs:284) | **저장 중 크래시 = 원본 손상** | temp+fsync+rename |
| 변환 정확도 | 텍스트/charPr/표/이미지/수식/하이퍼링크/주석/머리글·바닥글 변환 | 번호매기기/불릿/교차참조/밑줄색/강조 드롭 | 핵심 콘텐츠 무손실 |

---

## 2. 단계별 로드맵 (NOW/P0 → usable v1 → GA)

하드 제약은 전 단계 불변: **export는 HWPX 전용**, rhwp는 **feature-gated(MIT라 GPL 위반 아님) 오라클/부트스트랩**, round-trip + editor-open-safety는 **양보 불가(단, "필요조건" 위상으로 정직화)**. 검수는 `auto-hwp layout-check`(레이아웃 오라클)와 `validate_synthesis_safety`(open-safety 게이트)를 구체적 acceptance gate로 사용한다.

| 단계 | 목표 | 핵심 산출물 | 해금 (unlocks) | 검수 게이트 (measurable) |
|---|---|---|---|---|
| **P0 — 안전·신뢰 수선 (며칠)** | "박살난 느낌" 제거: 손상·프리징·조용한 손실·악성문서 차단 | ① export 원자적 쓰기(temp+fsync+rename) ② open/render/export `spawn_blocking` + 스피너 ③ `Inline::Raw` 편집 시 경고/거부 ④ CSP 설정 + SVG 새니타이즈 + `withGlobalTauri` 제거 ⑤ 앱 아이콘 .icns + .hwp/.hwpx fileAssociations + ad-hoc 서명 | 발견 루프(더블클릭) 복구, 실파일 안전 저장, 무결성 가시화 | • 큰 파일 open 시 메인스레드 블록 0(스피너) • 저장 중 kill 후 원본 무손상 • Raw 보유 문단 편집 시 경고(테스트) • build → Dock 아이콘 + Finder 더블클릭 실행 |
| **P1 — usable v1 (수주)** | "타이핑되는 에디터" + 표준 기능 | ① **WYSIWYG 캐럿/선택/IME** (화면↔문서 매핑, hit-test, InsertText/DeleteRange 연동) ② hwp-render: LayoutResult→PageLayerTree paint IR ③ 찾기/바꾸기 ④ 인쇄/PDF 내보내기 ⑤ 복사-선택·최근 문서·드래그-드롭 ⑥ 서식 툴바 ⑦ 핵심 한글 폰트 번들 + 라이선스 검토 ⑧ 이미지 삽입 UI | 일반 사용자가 열기→오타 수정→서식→저장 완주 | • layout-check: 편집 후 clean/table 페이지네이션 EXACT 유지, line-break ≥98% exact • 캐럿 hit-test 왕복 테스트 • 찾기/바꾸기 round-trip 무손상 • 모든 export가 open-safety 통과 |
| **P2 — 충실도·구조 편집 (수주~)** | object-heavy 문서 신뢰 + 구조 편집 | ① 머리글/바닥글/각주 수직 공간 예약 ② per-column 표 너비(`<hp:colInfo>`) ③ 번호매기기/불릿 lift+합성 ④ 표 셀/머리글/바닥글 in-place 편집 ⑤ linesegarray export(플래그, **빈 것보다 틀린 것이 더 나쁨**) ⑥ 배포용 복호화(필요 시) ⑦ autosave + 세션 복구 | 복합 문서도 일관 페이지네이션, 크래시 복구 | • layout-check: object-heavy 페이지 divergence ≤±2 • 배포용 → 복호화 → HWPX 열림 • 크래시 후 세션 복구 |
| **GA — 배포 가능 (수개월)** | 공개 배포 + 한글 오라클 검증 | ① Developer ID 서명 + notarization + DMG + auto-update ② **실 한글(VM/Win) 오라클을 critical path에** ③ 벡터 도형/텍스트박스 편집 ops(task #19) ④ 실 글리프 셰이핑(harfrust/rustybuzz) ⑤ kinsoku/justification/세로쓰기 ⑥ telemetry opt-in | 외부 배포, "한글 대체" 후보 | • notarized 빌드 Gatekeeper 통과 • 실 한글에서 코퍼스 N개 무손상 열림 • harfrust 후 object-heavy EXACT band 확대 |

---

## 3. 맥 앱 패키징 & "?" 아이콘 해결

**세 가지 "?"를 구분한다 — 원인과 해법이 전부 다르다:**

1. **앱 아이콘 "?"** (Dock/Finder의 앱) — `bundle.active=false` + .icns 부재. **시스템 레벨, 폰트 무관.**
2. **Finder 파일 아이콘 "?"** (.hwp/.hwpx 문서) — fileAssociations / CFBundleDocumentTypes 부재. **시스템 레벨, 폰트 무관.**
3. **렌더 글리프 "?" (tofu)** — 함초롬/맑은고딕 등 **폰트 미설치** 시 본문에 뜨는 결손 글리프. **위 둘과 별개**. P1 폰트 번들로 해결.

### 3-1. 앱 아이콘 (.icns)

```bash
# 1) 1024×1024 마스터 PNG 준비 (현재 icon.png는 32×32, 115 bytes 플레이스홀더 → 불가)
# 2) tauri icon으로 .icns + 멀티사이즈 세트 자동 생성
cargo tauri icon /path/to/icon-1024.png
#  → crates/hwp-viewer/icons/ 에 icon.icns, icon.ico, 32x32.png, 128x128.png, 128x128@2x.png 생성
```

### 3-2. `tauri.conf.json` 변경 (현재 → 목표)

현재: `"app": { "withGlobalTauri": true, "security": { "csp": null } }`, `"bundle": { "active": false, "icon": ["icons/icon.png"] }`

목표 (P0):
```json
"app": {
  "withGlobalTauri": false,
  "security": {
    "csp": "default-src 'self'; img-src 'self' data: asset: https://asset.localhost; style-src 'self' 'unsafe-inline'; script-src 'self'"
  }
},
"bundle": {
  "active": true,
  "targets": ["app", "dmg"],
  "icon": ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.icns", "icons/icon.ico"],
  "fileAssociations": [
    { "ext": ["hwp"],  "name": "HWP Document",  "description": "한글 문서",        "role": "Viewer", "icon": "icons/hwp-doc.icns",  "mimeType": "application/x-hwp" },
    { "ext": ["hwpx"], "name": "HWPX Document", "description": "한글 문서 (HWPX)", "role": "Editor", "icon": "icons/hwpx-doc.icns", "mimeType": "application/hwp+zip" }
  ],
  "macOS": { "signingIdentity": "-", "minimumSystemVersion": "11.0" }
}
```

- `fileAssociations`는 Tauri v2에서 Info.plist의 **CFBundleDocumentTypes**를 생성한다. 문서 아이콘은 별도 512px+ 에셋 권장(초기엔 `icon` 생략 시 앱 아이콘 재사용).
- 엄격한 Mac App Store 경로는 **UTImportedTypeDeclarations**(UTI)도 필요하지만, **외부 배포엔 CFBundleDocumentTypes로 충분**.
- 더블클릭 파일을 기존 창으로 받으려면 `tauri-plugin-single-instance` + open-file 이벤트 핸들러(P1).

### 3-3. 서명/공증/배포 — 단계 구분

- **P0 (본인 검증 루프):** `signingIdentity: "-"` (ad-hoc). 첫 실행 시 우클릭→열기 1회면 동작. **notarization 불필요.** 사용자가 직접 한글-파일-열기 검증에 충분. **blocker로 두지 않는다.**
- **GA (공개 배포):** Apple Developer($99/년) + `Developer ID Application` → `signingIdentity` 교체, `xcrun notarytool` + `stapler`, `dmg` 타깃, `tauri-plugin-updater`. **여기서만 notarization이 진짜 blocker.**
- entitlements: 최소 `com.apple.security.files.user-selected.read-write`(파일 다이얼로그) + 필요 시 `com.apple.security.network.client`(BYOK), `hardenedRuntime: true`.

---

## 4. 정직한 한계 (Honest Limits) + 스마트 시퀀싱

1. **object-heavy/대형 문서 페이지네이션은 근사다.** ApproxFontMetrics는 줄수 정확도(98.9%)엔 충분하나, harfrust 부재로 정밀 레이아웃은 불가. header/footer/각주 예약(P2)으로 줄여도 수식 metrics·float/wrap 도형은 **실 셰이퍼 없이는 미해결**. → **변환본에 linesegarray를 "확신에 차 틀리게" 넣지 말 것. 빈 것이 틀린 것보다 낫다.** export는 P2에서 플래그 뒤에.
2. **WYSIWYG 캐럿이 v1 이전엔 없다.** P0 안전 수선 후 P1 착수. 그 전까진 "충실한 뷰어 + AI append + 구조 편집"으로 정직 포지셔닝.
3. **벡터 도형/차트/OLE/마스터페이지는 deferred (task #19).** `Inline::Raw`로 verbatim 보존하되 편집 시 재방출 안 함 → **P0에서 경고/거부로 조용한 손실만 막는다.** 풀 편집은 GA.
4. **번호매기기/불릿/교차참조/밑줄색은 현재 드롭.** P2에서 lift+합성.
5. **open-safety 게이트는 필요조건이되 충분조건이 아니다.** GA 실 한글 VM 오라클 전까지 "한글이 무조건 연다"고 마케팅하지 않는다.
6. **round-trip 바이트 안정성은 무편집 HWPX-in에 한해 무조건적**, 편집·from-scratch는 best-effort.

**스마트 시퀀싱:** (지금 출하 가능) rhwp 충실 뷰 + AI propose→commit + round-trip-safe export → **P0 안전 수선만 얹으면 "AI 문서 어시스턴트 + 뷰어"로 즉시 베타.** (다음) P1 캐럿/타이핑 + 찾기·바꾸기 + 인쇄 → 비로소 "에디터". (완전 대체) P2 구조 편집 → GA 실 한글 오라클·실 셰이퍼·도형 편집.

**v1 명시적 비목표:** .docx/.doc 상호운용, 다중 사용자 협업, 접근성/스크린리더, 앱 크롬 i18n. 모두 v1 out-of-scope 선언.

---

## 5. 지금 당장 (이번 주) 할 일 — leverage 순

1. **export 원자적 쓰기** — `hwp-mcp/src/lib.rs:284`의 `fs::write`를 temp+fsync+rename으로 교체(CLI 경로도 동일). **수시간, 저장-중-크래시 원본 손상 차단.** (최고 레버리지: 신뢰의 순간 보호)
2. **`spawn_blocking` + 스피너** — `hwp-viewer/src/lib.rs` 47/81/105 동기 커맨드를 `spawn_blocking`로 감싸고 로딩 인디케이터. **수시간, 실파일 프리징 제거.**
3. **Raw 인라인 편집 경고/거부** — `serialize.rs:reemit_paragraph()`에서 `Inline::Raw` 감지 시 경고(또는 upstream 편집 거부). **수시간, 조용한 도형 손실 → 알려진 한계로 전환.**
4. **CSP + SVG 새니타이즈 + `withGlobalTauri:false`** — `csp:null` 교체, `App.tsx:279` innerHTML 주입 전 SVG에서 `<script>`/이벤트핸들러/`<foreignObject>` 스트립. **수시간, 악성 문서 → JS 실행 차단.**
5. **아이콘 + 파일 연결 (ad-hoc 서명)** — 1024px 마스터 → `cargo tauri icon` → §3-2 적용. **2~3시간, Finder 더블클릭 발견 루프 + Dock 아이콘.**
6. **(검증 보조) 코퍼스 panic-safety 매트릭스** — 기존 CI(`.github/workflows/ci.yml`)에 truncated zip/missing section0/zero-byte malformed 코퍼스 매트릭스 **추가**. **1~2시간.**

> 1~5번은 모두 **수시간 단위**이며, P1의 무거운 WYSIWYG 착수 **전에** "박살난 느낌"의 5대 원인(손상·프리징·조용한 손실·악성문서·발견불가)을 제거한다.
