<p align="center"><img src="./assets/brand/autohwp-banner.png" alt="오토한글 (auto-hwp) — 한글 문서를 직접 다루는 엔진" width="100%"></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@auto-hwp/react"><img src="https://img.shields.io/npm/v/@auto-hwp/react?style=flat-square&label=npm" alt="npm"></a>
  <a href="https://www.npmjs.com/package/@auto-hwp/react"><img src="https://img.shields.io/npm/dm/@auto-hwp/react?style=flat-square&label=downloads" alt="downloads"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/kwakseongjae/auto-hwp?style=flat-square&label=license" alt="license"></a>
</p>

# 오토한글 (auto-hwp)

한글(HWP/HWPX)을 브라우저·터미널에서 열고, 고치고, 내보내는 엔진입니다.
서버가 없습니다 — 전부 사용자 기기에서 돕니다.

[English](./README.en.md) · [데모](https://kwakseongjae.github.io/auto-hwp/) · [벤치마크](https://kwakseongjae.github.io/auto-hwp/bench/) ·
[임베드](./docs/EMBED-GUIDE.md) · [CLI](./docs/CLI-GUIDE.md) · [MCP](./docs/MCP-GUIDE.md) ·
[양식 일괄 작성](./docs/BULK-GUIDE.md) · [설계 배경](./docs/WHY.md) · [기여](./CONTRIBUTING.md)

<p align="center"><img src="./docs/assets/edit-loop.gif" alt="샘플 문서를 열고, 표를 지정하고, 말로 고쳐 적용한 뒤 PDF로 내보내는 편집 루프" width="960"></p>
<p align="center"><sub>실제 데모 화면(2026-07) — 열기 → 표 지정 → 말로 편집 → 카드 확인 후 적용 → PDF. 모델 응답 대기 구간은 빨리 감았습니다.</sub></p>

## 바로 써보기

### 웹 — 설치 0

- **문서 편집**: 한글 파일을 열어 고치고 HTML·PDF·HWPX로 저장 → [열기](https://kwakseongjae.github.io/auto-hwp/)
- **양식 일괄 작성**: 양식 1개 + 명단 N행 → 완성본 N부 zip (규칙 기반, AI 없이 동작) → [열기](https://kwakseongjae.github.io/auto-hwp/bulk) · [가이드](./docs/BULK-GUIDE.md)

파일은 브라우저를 벗어나지 않습니다. 데모에서 **AI 편집을 선택할 때만** 지시문과 문서 프로필·본문 발췌·표
문맥이 동의를 받은 뒤 Cloudflare Worker를 거쳐 OpenRouter(GLM 5.2)로 갑니다(파일 원본은 보내지 않습니다).
데모는 현재 `.hwp`만 받습니다.

### npm — 60초

```bash
npm i @auto-hwp/react     # 엔진(@auto-hwp/engine)·헤드리스 코어가 함께 설치됩니다
```

```tsx
import { useMemo, useState } from 'react';
import { HwpWorkspace, WasmAdapter, workspacePanel, type HwpWorkspaceProps } from '@auto-hwp/react';
import '@auto-hwp/react/styles.css';

// LLM 호출은 당신 서버에서 — 이 저장소의 어떤 패키지도 API 키를 보지 않습니다(BYOK).
const askAi: HwpWorkspaceProps['onAiRequest'] = async (instruction, anchors, docContext) => {
  const res = await fetch('/api/hwp-edit', {
    method: 'POST',
    body: JSON.stringify({ instruction, anchors, docContext }),
  });
  return res.json();                     // 검증된 편집 명령(Intent) 배열
};

export function Editor() {
  // 인자 없음 = wasm을 jsDelivr에서 자기 버전으로 pin해 받습니다 (복사할 파일 0).
  const adapter = useMemo(() => new WasmAdapter(), []);
  const [doc, setDoc] = useState<{ bytes: Uint8Array; name: string } | null>(null);

  return (
    <div style={{ height: '100vh' }}>
      <input type="file" accept=".hwp,.hwpx" onChange={async (e) => {
        const f = e.currentTarget.files?.[0];
        if (f) setDoc({ bytes: new Uint8Array(await f.arrayBuffer()), name: f.name });
      }} />
      <HwpWorkspace
        adapter={adapter}
        document={doc}
        enableEditing
        onAiRequest={askAi}
        sidePanel={workspacePanel({ onAiRequest: askAi })}
      />
    </div>
  );
}
```

열기·조판·렌더·수동 편집·HTML/PDF/HWPX 내보내기가 이 컴포넌트 안에서 끝납니다. `sidePanel`을 빼면
패널 없는 순수 에디터입니다(그때 `onAiRequest`는 호출되지 않습니다). 오프라인·폐쇄망·엄격 CSP라면
wasm을 직접 서빙하세요 — [EMBED-GUIDE §2.2](./docs/EMBED-GUIDE.md#22-오버라이드--자기-호스팅정적-파일-복사).
프록시 예제는 [`examples/ai-proxy-express`](./examples/ai-proxy-express), 동작하는 앱은
[`examples/vite-embed`](./examples/vite-embed).

### CLI

```bash
cargo install --git https://github.com/kwakseongjae/auto-hwp auto-hwp-cli --features rhwp,shaper,pdf
```

변환·조판 검사·양식 일괄 작성이 터미널에서 로컬 실행됩니다 → [CLI 가이드](./docs/CLI-GUIDE.md). 에디터에
상시 장착하려면 [MCP 서버](./docs/MCP-GUIDE.md), 아무 세션에서 쓰려면 [Claude Code 스킬](./skills/hwp/SKILL.md).

## 프레임워크

| 스택 | 오늘 되는 것 | 시작점 |
|---|---|---|
| **React** | 완성 UI `<HwpWorkspace/>` — 페이지·선택·오버레이·수동 편집·패널 슬롯 | `@auto-hwp/react` → 위 quickstart |
| **바닐라 · Svelte · Vue** | 엔진 + 헤드리스 코어. `@auto-hwp/editor-core`는 React·DOM 의존이 **0**이라 어느 프레임워크에도 붙습니다 — 다만 **완성 UI는 직접 조립**해야 합니다 | [`editor-core/examples/vanilla.ts`](./packages/editor-core/examples/vanilla.ts) (열기→선택→편집→undo→export, React 없이) |
| **웹 컴포넌트 래퍼** | 아직 없습니다 (로드맵) | — |

패키지는 4층입니다 — `@auto-hwp/engine`(wasm 엔진) · `@auto-hwp/editor-core`(헤드리스 상태) ·
`@auto-hwp/ai-protocol`(AI 프로토콜, 네트워크·키 0) · `@auto-hwp/react`(선택 UI). 엔진만 쓰면 `HwpDoc.open`
→ `renderPageSvgSanitized` → `applyIntent` → `exportPdf`가 전부이고, 좌표 질의까지 포함한 **34개 메서드**가
[`EngineAdapter` 계약](./packages/editor-core/src/adapter.ts)에 정의돼 있어 자체 에디터를 지을 수 있습니다.

## 할 수 있는 일

| 능력 | 무엇을 주나 | API · CLI |
|---|---|---|
| **열기** | `.hwp`(HWP5)·`.hwpx` 자동 감지 → 편집 가능한 문서 모델. 배포용(DRM) 문서 복호 | `HwpDoc.open` · `auto-hwp info` |
| **조판** | 한글 조판 규칙 재구현(금칙·장평·자간·옛한글), 쪽 나눔·표의 행 단위 분할 포함 | `pageCount` · `auto-hwp layout-check` |
| **렌더 · 좌표 질의** | 페이지별 SVG 문자열 + 점→블록/표/셀/글자 히트테스트, 커서 사각형 | `renderPageSvgSanitized` · `hitTest` · `tableCellAt` |
| **구조화 편집** | 셀·문단 채우기, 표/문단/차트/이미지 삽입, 행 추가, 블록 이동·삭제, 찾아바꾸기, 글자서식, 표 열폭, 쪽 여백 — 전부 타입 있는 편집 명령(Intent), 각각 되돌리기 1단위 | `applyIntent` · `undo`/`redo` |
| **문서 프로필** | 제목·목차·표 인벤토리·본문 발췌를 결정론으로 추출(LLM 호출 0회) — AI 컨텍스트의 정본 | `docProfile` · `auto-hwp ai-context` |
| **내보내기** | PDF(레이아웃 보존·한글 폰트 임베드) · HTML(시맨틱 리플로) · HWPX(고치지 않은 영역은 바이트 그대로) | `exportPdf`·`exportHtml`·`toHwpx` |
| **서체** | TTF/OTF를 등록하면 조판·화면·PDF가 동시에 그 서체로. 카탈로그 8종은 전부 OFL(재배포·PDF 임베딩 적법) | `registerFont` · [폰트 카탈로그](./docs/FONT-CATALOG.md) |
| **양식 일괄 채움** | 양식 + 채울 자리 정의 + 명단 → 완성본 N부 + 행별 검증 리포트 | `auto-hwp inspect`/`fill` · [가이드](./docs/BULK-GUIDE.md) |

AI에게 열려 있는 건 위 편집 명령 중 **19종**뿐이고 스키마 검증을 통과한 것만 문서에 닿습니다 — 제안은 카드로
미리 보고 "위치 보기"로 확인한 뒤 승인하며 카드별로 되돌립니다(에이전틱 모드는 웹 검색→근거 인용까지).
프로토콜은 `@auto-hwp/ai-protocol`, 스펙 전문은 [INTENT-SCHEMA](./docs/INTENT-SCHEMA.md).
없는 것도 분명합니다 — 표의 **행 삭제·열 삽입·열 삭제 명령은 없습니다**(정직하게 비워 둡니다).

## 다른 오픈소스와의 차이

| | **auto-hwp** | rhwp | hwp.js |
|---|---|---|---|
| **라이선스** | Apache-2.0 — 상용 임베드 무료, 동시접속 제한 없음 | MIT | Apache-2.0 |
| React 네이티브 SDK | `@auto-hwp/react`의 `<HwpWorkspace/>` + 헤드리스 코어 | iframe 임베드 웹 컴포넌트(`@rhwp/editor`) | 뷰어·파서 라이브러리(`hwp.js`) |
| 양식 일괄 작성 완제품 | 웹 + CLI (양식 1개 + 명단 N행 → 완성본 N부 zip) | 확인되지 않음 | 확인되지 않음 |
| 바이브(자연어) 편집 | 타입드 편집 명령 19종 · 적용 전 카드 미리보기 · 카드별 되돌리기 | 확인되지 않음 | 확인되지 않음 |
| 충실도 자동 게이트 | 쪽수·줄바꿈 일치율을 커밋마다 검사 ([정확도](#정확도와-한계)) | 확인되지 않음 | 확인되지 않음 |
| 배포 표면 | npm · CLI · MCP 서버 · Claude Code 스킬 · 웹 데모 | 브라우저 확장 · VS Code 확장 · npm · 웹 데모 | npm |
| 최근 npm 릴리스 | `@auto-hwp/engine` 0.0.3 (2026-07) | `@rhwp/core` 0.8.2 (2026-07) | `hwp.js` 0.0.3 (2020-10) |

<sub>2026-07 기준, 각 프로젝트의 공개 저장소와 npm 레지스트리 메타데이터에서 확인한 것만 적었습니다.
"확인되지 않음"은 공개 자료에서 찾지 못했다는 뜻이지 불가능하다는 뜻이 아닙니다. rhwp는 auto-hwp가
`.hwp` 파싱 부트스트랩으로 쓰는 상류이기도 합니다([NOTICE](./NOTICE)).</sub>

2026년 5월 18일부터 지방정부 온나라시스템에도 개방형 포맷(HWPX) 첨부 의무가 확대됐습니다(중앙부처는
2022년부터, [ZDNet](https://zdnet.co.kr/view/?no=20260512173412)). auto-hwp는 `.hwp`와 `.hwpx`를 같은
문서 모델로 열고 HWPX로 저장합니다 — 다만 `.hwpx` **입력**은 아직 알파입니다.

## 정확도와 한계

| 게이트 | 한컴 렌더 | auto-hwp |
|---|---|---|
| benchmark.hwp (정부 양식) | 8쪽 | 8쪽 |
| benchmark1.hwp (신청서) | 18쪽 | 18쪽 |
| 줄바꿈 위치 일치율 | — | 98.9%+ |
| 공공기관 실물 49종 ([출처](./corpus/GOV-SOURCES.md)) | — | 열기→렌더→PDF→텍스트 전 구간 통과 |

`scripts/verify-local.sh`가 매 커밋 이 게이트를 강제하고, 수치 전체와 각각을 직접 재현하는 명령은
**[벤치마크 페이지](https://kwakseongjae.github.io/auto-hwp/bench/)** 에 공개돼 있습니다. 130쪽 문서에서 편집
→ 화면 반영 136ms(워커 스레드, 화면 비차단), 되돌리기 메모리는 128MiB 버짓으로 상한이 잡혀 있습니다.

**알려진 제약**
- **PDF의 수식·차트**: 화면·HTML에서는 실제로 그려지지만 PDF는 아직 **자리표시 상자**입니다(내보내기 전 경고).
- **암호 걸린 `.hwp`**: 지원하지 않고 정직하게 거부합니다(배포용 DRM 문서 복호는 지원).
- **`.hwp`로 재저장 불가**: 저장 포맷은 HWPX입니다. HWPX 입력은 고치지 않은 영역이 바이트 그대로
  보존되지만, `.hwp` 입력의 산출물은 **변환본**이라 쪽 나눔·표 너비가 달라질 수 있습니다.
  (한컴 "다른 이름으로 저장"이 뭉갠 손실 `.hwpx`는 **레이아웃 정리** 모드가 열화를 감지해 원본 근사로 복원합니다.)
- 쪽수 게이트는 위 벤치마크 기준입니다 — 임의 문서에 대한 완전 일치 보증이 아닙니다.

## 문서

| 문서 | 내용 |
|---|---|
| [EMBED-GUIDE](./docs/EMBED-GUIDE.md) | 번들러별 wasm/워커 서빙, 자기 호스팅, CSP, 폰트, AI 프록시, 패널 슬롯 API 전체 |
| [CLI-GUIDE](./docs/CLI-GUIDE.md) · [MCP-GUIDE](./docs/MCP-GUIDE.md) | 터미널 실행 · 에디터 상시 장착 |
| [BULK-GUIDE](./docs/BULK-GUIDE.md) · [INTENT-SCHEMA](./docs/INTENT-SCHEMA.md) | 양식 일괄 작성(웹·CLI) · 편집 명령 스펙 전문 |
| [BENCHMARK](./docs/BENCHMARK.md) · [FONT-CATALOG](./docs/FONT-CATALOG.md) | 게이트 수치와 재현 명령 · 번들 서체 8종과 라이선스 |
| [WHY](./docs/WHY.md) | 왜 엔진을 직접 만들었나 · 파이프라인 · 설계 노트 · 크레이트 지도 · 로컬 빌드 |
| [SDK-LAYERS](./docs/SDK-LAYERS.md) · [CONTRIBUTING](./CONTRIBUTING.md) | 레이어 계약 · 검증 스위트와 불변식 |

## 라이선스 · 기여

Apache-2.0 ([LICENSE](./LICENSE)). 서드파티 고지는 [NOTICE](./NOTICE) — rhwp(MIT)·나눔 폰트(OFL)·
oracle의 GPL 격리 방식 포함. 기여 규칙과 정확도 게이트는 [CONTRIBUTING.md](./CONTRIBUTING.md).
