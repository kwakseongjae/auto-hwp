"use client";

import { Check, Crosshair, ExternalLink, FolderOpen, RotateCcw, Sparkles, X as XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HwpWorkspace, WasmAdapter, FONT_CATALOG, chatSidePanel, type AiRequestOptions, type Anchor, type Citation, type DocContext, type Intent, type WasmAdapterOptions, type WorkspaceToolbarItem } from "@auto-hwp/react";
import { buildDocContext, createAgentEventParser, type AgentEvent } from "@auto-hwp/ai-protocol";
import { isTrapError, resetEngine, type EngineLoadProgress } from "@auto-hwp/engine";
import { AutosaveController, IdbSnapshotStore, findRecoverable, formatAge, recoveredName, type SnapshotRecord } from "@/lib/autosave";
import { clearLiveDoc, decideResume, readLiveDoc, resumeToastMessage, writeLiveDoc } from "@/lib/resumeSession";
import { DOC_URL_MISSING_MESSAGE, docUrlPath, homePath, lookupDocUrl, parseDocUrl, rememberDocUrl, shortDocKey } from "@/lib/docUrl";
import { limitMessage, oversizeMessage } from "@/lib/limits";
import {
  demoAiAttachmentError,
  ensureDemoAiConsent,
  splitConsentMessage,
  type DemoAiConsentState,
  type DemoAiTransport,
} from "@/lib/demoAiConsent";
import { demoAiHttpError, readDemoAiResponse } from "@/lib/demoAiResponse";
import DemoAiConsentDialog from "./DemoAiConsentDialog";
import { ThemeToggle, useTheme } from "./ThemeToggle";
// 사이트 크롬([site] 스트림). 랜딩(=문서 열기 전)에만 붙는다 — 문서를 열면 기존 앱 헤더가 돌아온다.
import { SiteHeader } from "./site/SiteHeader";
import { SiteFooter } from "./site/SiteFooter";
import { LandingShowcase } from "./site/LandingShowcase";
import { docHref, siteHref } from "./site/paths";

type Mode = "loading" | "mock" | "live" | "static";
type Doc = { bytes: Uint8Array; name: string };

// 정적 데모(OSS): DEMO_STATIC=1 빌드(next.config.mjs)는 서버가 없으므로 AI 프록시 프로브를 건너뛰고
// "정적 데모" 모드로 동작한다. BASE 는 프로젝트 페이지(basePath) 배포 시 절대경로 fetch(/hwp, /fonts,
// /samples)에 접두된다 — Next 정적 에셋은 basePath 아래에 서빙되지만 코드의 fetch 는 자동 접두되지 않는다.
const IS_DEMO = process.env.NEXT_PUBLIC_DEMO === "1";
const BASE = process.env.NEXT_PUBLIC_BASE_PATH || "";
// 정적 데모 AI: 서버가 없으므로 키를 쥔 외부 프록시(Cloudflare Worker — services/demo-ai-proxy)로 위임.
// 이 값이 배포 시 주입되면(NEXT_PUBLIC_DEMO_AI_URL) 데모 AI 편집이 켜지고, 비면 기존 "로컬(BYOK)에서"
// 안내만 뜬다(회귀 없음). 키는 워커 시크릿에만 있고 클라이언트 번들엔 절대 들어오지 않는다(R6).
const DEMO_AI_URL = process.env.NEXT_PUBLIC_DEMO_AI_URL || "";
// full Next 배포(Vercel)로 옮기면 중계자가 **우리 서버 자신**이 된다: 워커 URL 없이
// `NEXT_PUBLIC_DEMO_AI=route` 만 켜면 same-origin `/api/hwp-edit`(DEMO_AI_MODE=1 로 하드닝된
// 데모 경로 — src/app/api/hwp-edit/demo.ts)를 같은 단발 계약으로 부른다. 워커 URL 이 있으면 그쪽이
// 이긴다(Pages 병행 기간 동안 기존 배포 무변경).
// ⚠️ `!IS_DEMO` 는 안전장치다: DEMO_STATIC=1 정적 export 에는 `/api/hwp-edit` 자체가 없다(빌드에서
// 들어낸다). 그 조합으로 잘못 배포돼도 채팅이 404 를 치는 대신 "AI 꺼짐" 안내로 정직하게 격하된다.
const DEMO_AI_ROUTE = !IS_DEMO && !DEMO_AI_URL && process.env.NEXT_PUBLIC_DEMO_AI === "route";
// 데모 AI 가 켜져 있는가 = (정적 데모 + 워커) 또는 (라우트 모드). 정적/동적 배포를 통틀어 이 한 값이
// "동의 게이트를 세우고 단발 데모 계약으로 보낸다"를 결정한다.
const DEMO_AI_ON = (IS_DEMO && !!DEMO_AI_URL) || DEMO_AI_ROUTE;
// 배지 툴팁의 모델명 **폴백**. 1순위는 언제나 서버 상태 응답(GET /api/hwp-edit 의 `model`)이고,
// 서버가 알려 주지 않는 배포(정적 데모 등)에서만 이 빌드타임 값이 쓰인다. 둘 다 없으면 모델명을
// 지어내지 않고 성격만 설명한다(거짓말 금지).
const AI_MODEL_FALLBACK = process.env.NEXT_PUBLIC_AI_MODEL || null;
/** 재개 토스트 자동 소멸(ms). 큰 문서의 첫 렌더가 끝난 뒤에도 한동안 보이도록 넉넉히 잡는다. */
const RESUME_TOAST_MS = 12_000;
// 중계 경로(동의 문구가 말하는 대상)는 컴포넌트 안에서 정한다 — QA 스위치(`?demoAi=1`)가 런타임에
// 라우트 모드를 켤 수 있기 때문(아래 demoAiTransport).

// 기본 폰트: 레포 자산 NanumGothic(OFL) — copy-fonts.mjs 가 public/fonts 로 복사하므로 오프라인에서도
// 항상 존재한다. 열기 직후 자동 등록되어 화면·조판·PDF 가 즉시 이 폰트로 일치하고 PDF 버튼이 활성화된다.
// 카탈로그의 나머지 폰트(scripts/fetch-fonts.mjs, git 제외)는 툴바 FontPicker 에서 선택/업로드한다.
const DEFAULT_FONT_PATH = `${BASE}/fonts/NanumGothic-Regular.ttf`;
const DEFAULT_FONT_FAMILY = "Nanum Gothic";
const FONT_URL_BASE = `${BASE}/fonts`;

// 랜딩의 원클릭 샘플(scripts/copy-samples.mjs 가 public/samples 에 복사하는 레포 벤치마크 문서).
const SAMPLES: { file: string; label: string; hint: string }[] = [
  { file: "sample-8p.hwp", label: "예시 샘플", hint: "바이너리 HWP5 파싱 + 표/병합셀" },
  { file: "sample-18p.hwpx", label: "신청서 샘플 (.hwpx · 18쪽)", hint: "손실 변환 자동 감지 → 레이아웃 정리" },
];

// 데모 문서 툴바에 남길 항목(이슈 4). 나머지는 화면에서만 접는다 — 기능은 우클릭 메뉴·디자인 탭·
// 단축키에 그대로 있고, SDK 기본값(prop 미지정)은 여전히 전 항목 노출이다.
const DEMO_TOOLBAR_ITEMS: readonly WorkspaceToolbarItem[] = ["zoom", "undo", "redo", "exportHtml", "exportPdf"];

const msg = (e: unknown): string => {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
};

// wasm 트랩(패닉)은 전역 인스턴스를 오염시킨다. 손상 파일 프로브 열기가 트랩나면 다음 업로드를 위해
// 인스턴스를 재생성해야 한다(이슈 §QA ⑨ 트랩 복구 안내). 분류기는 @auto-hwp/engine 의 `isTrapError`
// 단일 소스를 소비한다(이슈 055 사후 #8 — 로컬 사본은 'table index is out of bounds' 패턴이 빠져
// 메인스레드 폴백(?engineWorker=off)에서 트랩을 놓치고 resetEngine 을 건너뛰었다).

// 마킹된 앵커/문서 메타를 프록시가 R5 펜스로 감쌀 "문서 콘텐츠" 문자열로 만드는 로직은 이제
// @auto-hwp/ai-protocol 의 buildDocContext 가 소유한다(이슈 026) — 서버 route.ts 의 프롬프트/펜스
// 조립과 같은 모듈에서 나와 계약이 어긋날 수 없다. 앵커의 `text`는 문서 파생 신뢰불가 데이터.

export default function LabWorkspace() {
  // 화면 테마(라이트/다크). CSS 로 풀 수 없는 단 한 곳 — 워크스페이스의 `hw-studio`(다크 스튜디오
  // 팔레트) 클래스 — 을 위해서만 React 상태로 읽는다. 나머지 크롬은 `:root[data-theme]` 로 분기한다.
  const theme = useTheme();
  const [mode, setMode] = useState<Mode>("loading");
  // 배지 툴팁이 말할 "지금 이 데모가 도는 모델". 서버 프로브(GET /api/hwp-edit)가 알려 주면 그 값,
  // 아니면 빌드타임 env 폴백, 그것도 없으면 null(모델명 없이 성격만 설명한다). 하드코딩 금지.
  const [aiModel, setAiModel] = useState<string | null>(AI_MODEL_FALLBACK);
  const [aiProvider, setAiProvider] = useState<string | null>(null);
  const [badgeTip, setBadgeTip] = useState(false);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [labError, setLabError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // 기본 폰트 바이트(NanumGothic) — 열기 직후 자동 등록되도록 HwpWorkspace 에 defaultFont 로 전달.
  const [defaultFont, setDefaultFont] = useState<{ family: string; bytes: Uint8Array } | null>(null);

  // ── 이슈 052: 자동저장 + 세션 복구 상태 ─────────────────────────────────────────────────────────
  // 열기 화면의 미복구 스냅샷(배너), 자동저장/복구 안내 문구, 마지막 자동저장 라벨(헤더 표시 + e2e 신호).
  const [recovery, setRecovery] = useState<SnapshotRecord | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [savedLabel, setSavedLabel] = useState<string | null>(null);
  // ── 새로고침 자동 재개(052 위의 재개 규칙 레이어 — lib/resumeSession.ts) ────────────────────────
  // 같은 탭 새로고침이면 배너를 묻지 않고 즉시 그 스냅샷으로 돌아간다. 진행 표시(resuming)와 결과
  // 토스트(resumeToast — **마지막 자동저장 시각을 반드시 표기**)는 이 두 상태가 그린다.
  const [resuming, setResuming] = useState(false);
  const [resumeToast, setResumeToast] = useState<string | null>(null);
  // ── 문서 세션 URL(/d/<불투명 키> — lib/docUrl.ts) ────────────────────────────────────────────────
  // 열린 문서 ↔ 그 문서를 가리키는 URL 키. `doc` 객체 동일성으로 묶어 둔다: StrictMode 이중 실행에서는
  // 같은 `doc` 이라 키를 재사용하고(주소가 흔들리지 않는다), **다른 문서를 열면** 객체가 바뀌므로 새
  // 키를 만든다(옛 주소가 새 문서를 가리키는 사고 방지).
  const docUrlRef = useRef<{ doc: Doc; urlKey: string } | null>(null);
  // 이 주소로 들어와 재개하는 중 — 재개는 새 세션 키를 만들지만 **사용자가 들고 있는 주소는 유지**한다.
  const pendingUrlKeyRef = useRef<string | null>(null);
  // 주소가 가리키는 문서를 이 브라우저에서 찾지 못했다 = 안내 후 홈. 이때는 마커 자동 재개도 하지
  // 않는다(주소가 이긴다 — 엉뚱한 다른 문서를 대신 열어 주는 것이 가장 나쁜 답이다).
  const urlMissRef = useRef(false);

  // ⚠️ 경로만 바꾸고 **쿼리·해시는 그대로 들고 간다**: `?toolbar=full`·`?engineWorker=off`·`?demoAi=1`
  // 같은 스위치가 주소를 갈아끼우는 순간 조용히 사라지면, 새로고침 한 번에 앱이 다른 앱이 된다
  // (e2e 실측: `?demoAi=1` 이 날아가 데모 계약이 꺼졌다).
  const keepSearch = () => window.location.search + window.location.hash;

  /** 주소를 이 문서로 바꾼다. 홈에서 열었으면 새 히스토리 항목(뒤로가기=홈), 이미 문서 주소면 교체. */
  const applyDocUrl = useCallback((urlKey: string) => {
    const path = docUrlPath(urlKey, BASE);
    if (window.location.pathname === path) return;
    const atDoc = parseDocUrl(window.location.pathname, BASE) !== null;
    window.history[atDoc ? "replaceState" : "pushState"]({ docUrl: urlKey }, "", path + keepSearch());
  }, []);

  /** 주소를 홈으로 되돌린다(문서 닫기·처음부터·죽은 주소). */
  const restoreHomeUrl = useCallback(() => {
    const path = homePath(BASE);
    if (window.location.pathname === path) return;
    window.history.pushState({ docUrl: null }, "", path + keepSearch());
  }, []);
  // 복구 클릭으로 연 문서: 열기 성공 시 adoptRecovered(재귀속 + 옛 키 삭제)할 원본 레코드.
  const pendingRecoveryRef = useRef<SnapshotRecord | null>(null);
  // 포인터 제스처(드래그) 진행 중엔 자동저장 flush 를 미룬다(렌더-0 규율). 이슈 055 워커화로 toHwpx
  // 는 이제 비차단이지만, 제스처 중 불필요한 직렬화/RPC 왕복을 피하는 유휴 게이트는 그대로 유효하다.
  const pointerDownRef = useRef(false);
  // 공개 데모의 첫 AI 네트워크 호출 전에만 묻는다. 사용자 결정(2026-07-30): 동의는 **최초 1회**만
  // 받고 이 브라우저에 기억한다(localStorage — lib/demoAiConsent.ts). 이 ref 는 그 위의 페이지-로컬
  // 캐시라 저장소를 매 요청 읽지 않는다. 거부는 아무 것도 기록하지 않으므로 다음 요청에 다시 묻는다.
  const demoAiConsentRef = useRef<DemoAiConsentState>({ granted: false });
  // 인앱 동의 모달(네이티브 confirm 대체): 열려 있는 동안 요청은 이 promise 에 매달려 대기한다.
  const [consentParagraphs, setConsentParagraphs] = useState<readonly string[] | null>(null);
  const consentResolveRef = useRef<((granted: boolean) => void) | null>(null);
  // 대기 중인 동의를 한 방향으로만 끝낸다(중복 resolve·유실 방지). 새 요청이 겹치면 앞의 것은 거부로
  // 마감한다 — 모달이 하나이므로 "누가 이 대답의 주인인가"가 모호해선 안 된다.
  const settleConsent = useCallback((granted: boolean) => {
    const resolve = consentResolveRef.current;
    consentResolveRef.current = null;
    setConsentParagraphs(null);
    resolve?.(granted);
  }, []);
  const askDemoAiConsent = useCallback(
    (message: string) =>
      new Promise<boolean>((resolve) => {
        consentResolveRef.current?.(false); // 겹친 앞 요청 마감
        consentResolveRef.current = resolve;
        // 모달은 게이트가 만든 **그 문구**를 문단으로 쪼개 그대로 렌더한다(계약 드리프트 없음).
        setConsentParagraphs(splitConsentMessage(message));
      }),
    [],
  );
  // 언마운트(라우팅/닫기)로 모달이 사라지면 대기 중인 요청이 영원히 매달린다 — 거부로 끝낸다.
  useEffect(() => () => consentResolveRef.current?.(false), []);

  // ssr:false 로 로드되므로 window 존재. wasm은 public 정적 에셋을 명시적 URL로 fetch(번들러 마법 X).
  const wasmUrl = useMemo(() => new URL(`${BASE}/hwp/hwp_wasm_bg.wasm`, window.location.origin), []);
  // 이슈 055(FG-14): 엔진은 기본적으로 Web Worker 에서 돈다(파싱/재조판/export/toHwpx 가 메인스레드를
  // 멈추지 않는다). 워커 스크립트도 public 정적 에셋(모듈 워커 — copy-wasm.mjs 가 배치). 계측/롤백용
  // 탈출구: `?engineWorker=off` 로 열면 기존 메인스레드 엔진으로 동작한다(BEFORE/AFTER 실측이 이 스위치).
  const workerMode = useMemo(() => new URLSearchParams(window.location.search).get("engineWorker") !== "off", []);
  // QA/e2e 탈출구(`?engineWorker=off` 와 같은 계열): 데모 화면은 간소화된 툴바를 쓰지만, SDK 전 항목을
  // 실브라우저로 검증해야 하는 스펙(이미지 삽입·HWPX 저장·표 추가 버튼 i18n)은 `?toolbar=full` 로 원래
  // 툴바를 그대로 받는다. 기능이 아니라 **노출**만 바뀌는 스위치라는 사실이 이 파라미터로 드러난다.
  const fullToolbar = useMemo(() => new URLSearchParams(window.location.search).get("toolbar") === "full", []);
  // QA/e2e 탈출구(`?demoAi=1`): 데모 AI 계약(동의 게이트 + 단발 위임)을 **빌드 env 없이** 켠다.
  // 왜 필요한가: NEXT_PUBLIC_DEMO_AI 는 빌드 타임에 번들로 인라인되므로, e2e 서버 전체를 데모 모드로
  // 띄우지 않고는 동의 모달을 실브라우저로 검증할 수 없다(그러면 다른 챗 스펙이 전부 모달에 걸린다).
  // ⚠️ 이 스위치는 **없던 AI 를 켜 주지 않는다**: 정적 export(IS_DEMO)에는 `/api/hwp-edit` 자체가
  // 없으므로 그 빌드에서는 무시한다(DEMO_AI_ROUTE 와 같은 안전장치). 켜 봐야 우리 서버로 가는 경로가
  // 하나 열릴 뿐이고, 키가 없으면 라우트가 기존대로 mock/503 으로 정직하게 답한다.
  const qaDemoAi = useMemo(() => !IS_DEMO && new URLSearchParams(window.location.search).get("demoAi") === "1", []);
  const demoAiOn = DEMO_AI_ON || qaDemoAi;
  // 중계 경로(동의 문구가 말하는 대상): QA 스위치도 same-origin 라우트를 부르므로 "route" 다.
  const demoAiTransport: DemoAiTransport = DEMO_AI_ROUTE || qaDemoAi ? "route" : "worker";
  const adapterOptions = useMemo<WasmAdapterOptions | undefined>(
    () => (workerMode ? { worker: { url: new URL(`${BASE}/hwp/worker.js`, window.location.origin) } } : undefined),
    [workerMode],
  );

  // ── W6.2: 엔진 내려받기 진행률 ────────────────────────────────────────────────────────────────────
  // wasm 은 비압축 7.7MB(이 사이트 전송은 gzip 3.1MB — 실측)라 무정보 대기가 길다. 어댑터의 onProgress
  // (Response body reader) 를 받아 랜딩에 진행률을 띄운다. 1%마다만 setState 한다(무의미한 리렌더 방지).
  const [engineLoad, setEngineLoad] = useState<{ pct: number | null; loaded: number; done: boolean } | null>(null);
  const enginePctRef = useRef(-1);
  const onEngineProgress = useCallback((p: EngineLoadProgress) => {
    const pct = p.ratio == null ? null : Math.round(p.ratio * 100);
    // 리렌더 단위: %를 알면 1%, 모르면 0.5MB(음수 키라 % 값과 섞이지 않는다). 청크당 tick 은
    // 수백 개라 그대로 setState 하면 랜딩이 로딩 중 수백 번 리렌더된다.
    const key = pct ?? -1 - Math.floor(p.loaded / 524288);
    if (!p.done && key === enginePctRef.current) return;
    enginePctRef.current = key;
    setEngineLoad({ pct, loaded: p.loaded, done: p.done });
  }, []);
  // 진행률은 **메인 어댑터**(화면 렌더 담당)에만 붙인다 — 열기 프로브(openBytes)는 매번 새 어댑터라
  // 그쪽 진행률까지 받으면 표시가 뒤로 되감긴다.
  const mainAdapterOptions = useMemo<WasmAdapterOptions>(
    () => ({ ...(adapterOptions ?? {}), onProgress: onEngineProgress }),
    [adapterOptions, onEngineProgress],
  );
  const adapter = useMemo(() => new WasmAdapter(wasmUrl, mainAdapterOptions), [wasmUrl, mainAdapterOptions]);
  // 열기(프로브) 진행 중 취소용 핸들 — 워커 모드에선 dispose()가 프로브 워커를 종료해 파싱을 즉시 중단한다.
  const probeRef = useRef<WasmAdapter | null>(null);

  // 자동저장 파이프라인(052): 성공한 편집(onMutation) → 2s 유휴 디바운스 → adapter.toHwpx() →
  // IndexedDB(문서당 최신 1개 · 전체 상한 · TTL 7일). IndexedDB 실패는 1회 안내 후 비활성 —
  // 메모리 최신본으로 트랩 직후 복구는 계속 동작한다.
  const store = useMemo(() => new IdbSnapshotStore(), []);
  const autosave = useMemo(
    () =>
      new AutosaveController(store, adapter, {
        canFlushNow: () => !pointerDownRef.current,
        onSaved: (rec) => setSavedLabel(`자동저장됨 rev ${rec.rev} · ${new Date(rec.savedAt).toLocaleTimeString()}`),
        onDisabled: () =>
          setNotice(
            "자동저장을 사용할 수 없습니다(시크릿 모드/저장공간 거부). 이 세션에서는 복구 스냅샷이 브라우저에 저장되지 않습니다 — 트랩 직후 복구만 동작합니다.",
          ),
      }),
    [store, adapter],
  );

  // 어댑터 ↔ 자동저장 배선: 편집 신호(onMutation), 트랩 복구의 스냅샷 우선(setRecoverySource),
  // 복구 결과의 정직한 안내(onRecovered — 스냅샷 복구 vs 원본 폴백+사유).
  useEffect(() => {
    adapter.onMutation = () => autosave.noteEdit();
    adapter.setRecoverySource(() => autosave.getRecoverySnapshot());
    adapter.onRecovered = (info) => {
      if (info.source === "snapshot") {
        setNotice(`엔진 트랩 복구: 마지막 자동저장 편집본(${info.label ?? "최신"})으로 복구했습니다. 스냅샷 이후의 편집은 소실되었을 수 있습니다.`);
      } else if (info.reason) {
        setNotice(`엔진 트랩 복구: 자동저장 편집본을 열지 못해(${info.reason}) 원본 파일로 복구했습니다 — 편집 내용이 소실되었습니다.`);
      }
      // reason 없는 original(스냅샷이 아예 없던 경우)은 기존 워크스페이스 토스트만으로 충분.
    };
    return () => {
      adapter.onMutation = null;
      adapter.setRecoverySource(null);
      adapter.onRecovered = null;
    };
  }, [adapter, autosave]);

  // 드래그 게이트 소스: 포인터가 눌린 동안 flush 금지(캡처 단계 — 워크스페이스 내부 제스처 모두 포착).
  useEffect(() => {
    const down = () => (pointerDownRef.current = true);
    const up = () => (pointerDownRef.current = false);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
    };
  }, []);

  // 문서 수명 → 자동저장 세션: 열기 성공 시 세션 시작(+복구본이면 재귀속), 닫힘/언마운트 시 정리.
  // 재개 마커: 세션이 열리는 **바로 이 자리**가 유일한 세팅 지점이다(문서 교체·복구본 열기·자동
  // 재개가 전부 이 경로를 지나므로 마커는 항상 "지금 열려 있는 문서"의 스냅샷 키를 가리킨다).
  // ⚠️ doc 이 null 인 분기에서는 마커를 지우지 **않는다** — 이 이펙트는 마운트 직후(문서 없음)에도
  // 돌기 때문에, 여기서 지우면 새로고침 직후 마커를 스스로 태워 자동 재개가 영영 성립하지 않는다.
  // 마커 제거는 "명시적 닫기 / 재개 실패 강등 / 스냅샷 소멸 / 복구 무시" 네 곳에서만 한다.
  useEffect(() => {
    if (doc) {
      autosave.openSession(doc.name);
      const key = autosave.sessionKey();
      if (key) {
        writeLiveDoc(key);
        // 문서 세션 URL: 키는 **스냅샷 키의 해시**(불투명 — 파일명·내용은 주소로 나가지 않는다).
        // 이 주소로 들어와 재개 중이면(pendingUrlKeyRef) 그 키를 그대로 쓴다.
        const urlKey = (docUrlRef.current?.doc === doc ? docUrlRef.current.urlKey : null) ?? pendingUrlKeyRef.current ?? shortDocKey(key);
        pendingUrlKeyRef.current = null;
        urlMissRef.current = false;
        docUrlRef.current = { doc, urlKey };
        rememberDocUrl(urlKey, key); // 주소 → 스냅샷 매핑(이 브라우저 안에만 산다)
        applyDocUrl(urlKey);
      }
      setSavedLabel(null);
      const rec = pendingRecoveryRef.current;
      if (rec) {
        pendingRecoveryRef.current = null;
        void autosave.adoptRecovered(rec).then(() => setRecovery(null));
      } else {
        // U2 — 열기 직후 **시드 스냅샷 1회**(원본 바이트 그대로, toHwpx 호출 없음). 이게 없으면
        // "샘플만 열고 편집 없이 새로고침"은 마커만 있고 스냅샷이 없어 랜딩으로 떨어졌다.
        // 복구본/자동 재개로 연 경우(rec)는 adoptRecovered 가 이미 rev0 재귀속을 하므로 건너뛴다.
        void autosave.seedSession(doc.bytes, doc.name);
      }
    } else {
      autosave.closeSession();
      setSavedLabel(null);
      docUrlRef.current = null;
    }
  }, [doc, autosave, applyDocUrl]);
  useEffect(() => () => autosave.dispose(), [autosave]);

  // ── 뒤로/앞으로 가기 ────────────────────────────────────────────────────────────────────────────
  // 문서를 열면 히스토리 항목이 하나 쌓이므로(홈 → /d/<키>) 뒤로가기는 "문서 닫기"여야 정직하다.
  // 다른 문서 주소로 이동하면(앞으로가기·주소 붙여넣기) 재개 경로를 그대로 타도록 새로 읽는다.
  useEffect(() => {
    const onPop = () => {
      const key = parseDocUrl(window.location.pathname, BASE);
      const current = docUrlRef.current;
      if (key && current && key === current.urlKey) return; // 같은 문서 — 할 일 없음
      if (!key) {
        // 홈으로 돌아왔다 = 닫기(마커만 제거, 스냅샷은 보존). 주소는 이미 브라우저가 되돌렸다.
        if (current) {
          docUrlRef.current = null;
          clearLiveDoc();
          setDoc(null);
          setLabError(null);
          setResumeToast(null);
        }
        return;
      }
      // 다른 문서 주소 — 재개 판정을 처음부터 다시 하는 것이 가장 정직하다(부분 상태 이월 금지).
      window.location.reload();
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // ── pagehide best-effort flush ──────────────────────────────────────────────────────────────────
  // 탭이 사라지기 직전(새로고침·이동·닫기) 미저장 편집이 있으면 스냅샷을 한 번 더 시도한다.
  // ⚠️ **보장이 아니다** — toHwpx 는 워커 왕복(비동기)이라 브라우저가 페이지를 회수하는 쪽이 빠르면
  // 그대로 잘린다. unload 를 await 로 붙잡으려 들지 않는다(그건 앱을 막고 브라우저가 무시한다).
  // 그래서 재개 토스트가 "마지막 자동저장 HH:MM"을 표기한다 — 사용자는 어디까지 살아남았는지 본다.
  // 제스처 게이트(canFlushNow)와의 관계: 페이지가 사라지는 마당에 드래그 유휴를 기다릴 이유가 없으니
  // 포인터 플래그만 내려 게이트를 통과시킨다(컨트롤러의 지연 규율 자체는 손대지 않는다).
  useEffect(() => {
    const flush = () => {
      pointerDownRef.current = false;
      void autosave.flush();
    };
    const onHidden = () => {
      if (window.document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    window.document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.document.removeEventListener("visibilitychange", onHidden);
    };
  }, [autosave]);

  // 프록시 모드(mock/live)를 조회해 배지에 표시. 키는 서버 전용이므로 여기서 알 수 있는 건 모드와
  // (서버가 알려 주면) **모델 이름**뿐이다 — 배지 툴팁이 "지금 뭘로 도는지"를 말할 근거가 그것이다.
  // 정적 데모 빌드에는 서버가 없으므로 프로브를 건너뛰고 "static"으로 확정한다(404 fetch 소음 방지).
  useEffect(() => {
    if (IS_DEMO) {
      setMode("static");
      return;
    }
    let cancelled = false;
    fetch(`${BASE}/api/hwp-edit`, { method: "GET" })
      .then((r) => r.json())
      .then((d: { mode?: Mode; provider?: string; model?: string | null }) => {
        // 데모 라우트 모드에서 서버 키가 없으면 프로브가 "static"(=AI 없음)을 답한다 — mock 배지를
        // 띄우면 "가짜 편집이라도 동작한다"는 거짓말이 되므로 그 값을 그대로 살린다.
        if (cancelled) return;
        setMode(d.mode === "live" ? "live" : d.mode === "static" ? "static" : "mock");
        // 모델명은 **서버가 말한 것만** 쓴다(하드코딩 금지 — env 를 바꾸면 툴팁도 따라온다).
        // 서버가 안 알려 주면 빌드타임 env 폴백, 그것도 없으면 모델명 없이 성격만 설명한다.
        if (typeof d.model === "string" && d.model.trim()) setAiModel(d.model.trim());
        if (typeof d.provider === "string" && d.provider.trim()) setAiProvider(d.provider.trim());
      })
      .catch(() => {
        if (!cancelled) setMode("mock");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── W6.2: 랜딩 유휴 시 엔진 프리페치 ─────────────────────────────────────────────────────────────
  // 문서를 열기 전(랜딩)에 wasm 을 미리 받아 인스턴스화해 둔다 → 샘플/파일을 고르는 순간 다운로드+컴파일
  // 대기가 없다. 유휴(requestIdleCallback)에서만 시작하므로 첫 화면 페인트를 밀어내지 않는다. 실패는
  // 조용히 무시한다(오프라인/차단 — 실제 열기에서 정직한 오류로 다시 드러난다).
  // ⚠️ 정직하게: 이건 **메인 어댑터**(문서 렌더 lane)를 데운다. 열기 프로브는 매번 새 워커라 컴파일을
  // 공유하지 않지만, 같은 URL 이라 브라우저 HTTP 캐시 덕에 다운로드는 즉시 끝난다.
  useEffect(() => {
    if (doc) return; // 이미 문서가 열렸으면 엔진은 당연히 로드됨
    let cancelled = false;
    const start = () => {
      if (!cancelled) void adapter.prefetch();
    };
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
      .requestIdleCallback;
    const cic = (window as unknown as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback;
    const handle = ric ? ric(start, { timeout: 3000 }) : (setTimeout(start, 1200) as unknown as number);
    return () => {
      cancelled = true;
      if (ric && cic) cic(handle);
      else clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
    };
  }, [adapter, doc]);

  // 기본 폰트(NanumGothic)를 한 번 fetch 해 둔다 — HwpWorkspace 가 문서를 열면 이 바이트를 자동
  // registerFont 하여(메트릭+PDF) 화면/PDF 가 즉시 일치하고 PDF 버튼이 활성화된다. copy-fonts.mjs 가
  // public/fonts 에 레포 자산을 복사하므로 오프라인에서도 성공한다(실패 시 FontPicker 업로드로 폴백).
  useEffect(() => {
    let cancelled = false;
    fetch(DEFAULT_FONT_PATH)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((buf) => {
        if (!cancelled) setDefaultFont({ family: DEFAULT_FONT_FAMILY, bytes: new Uint8Array(buf) });
      })
      .catch(() => {
        /* 기본 폰트 미배치 — copy-fonts.mjs 실행 전이거나 오프라인. FontPicker 로 직접 선택/업로드 가능. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 열기 시퀀스 번호(이슈 055 사후 #5): 두 파일을 연이어 열면 먼저 시작한 open 의 finally 가 나중
  // open 의 probe/busy 를 지우고, 늦게 끝난 쪽 setDoc 이 이기는 경합이 있었다. 규칙은 ctxMenuSeqRef 와
  // 동일 — "최신 open 만이 doc/busy/probe/에러 표면을 만진다". 새 open 은 이전 인플라이트 프로브를
  // dispose 로 취소한다(그쪽 catch 는 worker_terminated 로 조용히 접힌다).
  const openSeqRef = useRef(0);

  // 바이트 → 문서 열기: 파일 픽커와 (HwpWorkspace 의) 문서 드롭이 공유하는 단일 경로. 손상/악성 파일이
  // 현재 세션을 깨지 않도록 프로브 어댑터로 먼저 검증한다(이슈 050: 문서 드롭=열기 분기가 여기로 온다).
  // 열기 성공 여부를 돌려준다(이슈 052: 복구 배너가 성공/실패 분기를 정직하게 처리).
  // 이슈 055 사후 #2: 거부/취소/실패 경로는 busy/probe 상태만 정리하고 **현재 doc 은 유지**한다 — 두
  // 번째 파일 열기가 거부됐다고 이미 열린 문서를 언마운트하지 않는다(열린 문서가 없었다면 그대로 없음).
  const openBytes = useCallback(
    async (bytes: Uint8Array, name: string): Promise<boolean> => {
      if (!/\.(hwp|hwpx)$/i.test(name)) {
        setLabError(`지원하지 않는 형식입니다: ${name}\n.hwp 또는 .hwpx 파일만 열 수 있습니다.`);
        return false;
      }
      if (bytes.length === 0) {
        setLabError(`빈 파일입니다: ${name}`);
        return false;
      }
      // 이슈 055 한도 UX: 엔진(hwp-ingest limits.rs MAX_RAW_FILE=64MiB)이 어차피 거부할 파일은
      // 파싱(워커 복사)을 시작하기 전에 정직한 사유로 거부한다.
      const tooBig = oversizeMessage(bytes.length, name);
      if (tooBig) {
        setLabError(tooBig);
        return false;
      }
      const seq = ++openSeqRef.current;
      const latest = () => openSeqRef.current === seq;
      probeRef.current?.dispose(); // 이 open 이 최신 — 이전 인플라이트 프로브는 취소(워커 종료)
      setBusy("문서 여는 중…");
      setLabError(null);
      const probe = new WasmAdapter(wasmUrl, adapterOptions);
      probeRef.current = probe; // 취소 버튼이 이 핸들의 dispose()로 파싱을 중단한다(워커 종료)
      try {
        await probe.open(bytes, name);
        probe.dispose();
        if (!latest()) return false; // 더 새 open 이 시작됨 — 그쪽 결과가 이긴다
        setDoc({ bytes, name });
        return true;
      } catch (err) {
        // 이슈 055: 사용자가 취소(워커 종료)한 경우 — 오류가 아니다. 조용히 접는다(현재 문서 유지).
        if ((err as { code?: string })?.code === "worker_terminated") {
          return false;
        }
        if (workerMode) {
          // 워커 모드: 트랩이 나도 프로브 워커에 격리된다(어댑터가 자체 reset까지 수행). 프로브
          // 워커를 종료해 자원만 회수하면 된다 — 메인 어댑터/엔진은 애초에 오염되지 않았다.
          probe.dispose();
        } else if (isTrapError(err)) {
          // 메인스레드 모드(폴백): 전역 wasm 인스턴스가 오염됨 → 다음 업로드를 위해 재생성(트랩 복구).
          try {
            await resetEngine(wasmUrl);
          } catch {
            /* 재생성 실패는 다음 상호작용에서 다시 시도됨 */
          }
        }
        if (!latest()) return false; // 뒤에 새 open 이 시작됐다 — 그쪽 표면을 어지럽히지 않는다
        // 이슈 055 한도 UX: DocLimit/형식 계열 오류는 사람이 읽는 사유로 매핑, 모르는 오류는 기존 문구.
        const friendly = limitMessage(msg(err));
        setLabError(
          friendly
            ? `파일을 열 수 없습니다: ${name}\n${friendly}`
            : `파일을 열 수 없습니다: ${name}\n${msg(err)}\n` +
                `손상되었거나 지원하지 않는 파일일 수 있습니다. 다른 파일을 시도하거나 원본을 다시 저장해 보세요.`,
        );
        return false;
      } finally {
        if (latest()) {
          probeRef.current = null;
          setBusy(null);
        }
      }
    },
    [wasmUrl, adapterOptions, workerMode],
  );

  // 이슈 055: 파싱 취소 — 진행 중 프로브의 워커를 종료한다(위 catch 가 worker_terminated 로 접는다).
  const cancelOpen = useCallback(() => {
    probeRef.current?.dispose();
  }, []);

  const onFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = ""; // 같은 파일 재선택 허용
      if (!file) return;
      await openBytes(new Uint8Array(await file.arrayBuffer()), file.name);
    },
    [openBytes],
  );

  // 랜딩 원클릭 샘플(OSS 데모): public/samples 의 레포 벤치마크 문서를 fetch 해 일반 열기 경로로 넘긴다.
  // 미배치(404 — copy-samples.mjs 미실행)면 정직하게 안내한다.
  const openSample = useCallback(
    async (file: string) => {
      setLabError(null);
      try {
        const r = await fetch(`${BASE}/samples/${file}`);
        if (!r.ok) throw new Error(`샘플이 배치되지 않았습니다 (${r.status}) — apps/hwp-lab에서 npm run dev/build를 다시 실행하세요.`);
        await openBytes(new Uint8Array(await r.arrayBuffer()), file);
      } catch (e) {
        setLabError(msg(e));
      }
    },
    [openBytes],
  );

  // ── 열기 화면 진입 규칙: ⓪ 주소(/d/<키>) → ① 새로고침 마커 → ② 고아 스냅샷 배너 ────────────────
  // ⓪ 주소가 문서를 가리키면 **주소가 이긴다**(즐겨찾기·새 탭·주소 공유). 주소는 스냅샷 키를 직접
  //    싣지 않고 이 브라우저의 매핑(localStorage)을 거치므로, 다른 기기/브라우저에서 열면 매핑이
  //    없어 정직하게 안내하고 홈으로 돌린다 — 이때 마커 재개도 하지 않는다(엉뚱한 문서 금지).
  // ① 마커(sessionStorage · 탭 수명)가 있으면 = 같은 탭에서 새로고침한 것 = 사용자는 "하던 문서"를
  //    기대한다 → 묻지 않고 그 스냅샷을 즉시 연다(+ 마지막 자동저장 시각 토스트).
  // ② 마커가 없으면(새 탭·다른 날·명시적 닫기 뒤) = 고아 스냅샷 → **현행 배너 그대로**(opt-in).
  // 실패는 전부 ②로 강등한다: 손상된 스냅샷도, IndexedDB 거부(시크릿)도 앱을 막지 않는다.
  //
  // ⚠️ "마운트당 1회" 플래그(useRef)로 재시도를 막지 마라 — StrictMode 는 이펙트를 mount→cleanup→
  //    mount 로 두 번 돌리므로, 첫(취소된) 실행이 플래그를 태워 자동 재개가 통째로 사라진다(실측:
  //    e2e 가 배너로 떨어졌다). **마커 자체가 유일한 가드**다: 모든 랜딩 경로가 마커를 지우므로
  //    이 이펙트는 몇 번 돌아도 같은 결론에 수렴한다(멱등). 주소 경로도 같은 규율이다 — 죽은 주소는
  //    urlMissRef 하나로만 기억하고(그 뒤엔 평범한 랜딩), 살아 있는 주소는 스냅샷 키로 환원된다.
  useEffect(() => {
    if (doc) return;
    let cancelled = false;
    void (async () => {
      // ⓪ 주소 우선: /d/<키> → (이 브라우저 매핑) → 스냅샷 키. 마커보다 앞선다.
      const urlKey = parseDocUrl(window.location.pathname, BASE);
      let marker = readLiveDoc();
      let fromUrl = false;
      if (urlKey) {
        const mapped = lookupDocUrl(urlKey);
        if (mapped) {
          fromUrl = true;
          marker = mapped;
          pendingUrlKeyRef.current = urlKey; // 재개 후에도 이 주소를 유지한다
        } else {
          if (cancelled) return;
          urlMissRef.current = true;
          marker = null;
          setNotice(DOC_URL_MISSING_MESSAGE);
          restoreHomeUrl();
        }
      } else if (urlMissRef.current) {
        // 죽은 주소를 방금 홈으로 되돌린 직후(이펙트 재실행) — 다른 문서를 대신 열지 않는다.
        marker = null;
      }
      /** 주소로 들어왔는데 되살릴 수 없을 때: 같은 안내 + 홈 복귀(추측해서 다른 문서를 열지 않는다). */
      const failUrl = () => {
        if (!fromUrl) return false;
        urlMissRef.current = true;
        pendingUrlKeyRef.current = null;
        setNotice(DOC_URL_MISSING_MESSAGE);
        restoreHomeUrl();
        return true;
      };
      // ① 자동 재개
      if (marker) {
        let decision = decideResume(marker, [], Date.now());
        try {
          decision = decideResume(marker, await store.list(), Date.now());
        } catch {
          /* IndexedDB 접근 불가(시크릿/거부) — 재개 불가. 아래에서 마커만 정리하고 조용히 랜딩. */
        }
        if (cancelled) return;
        if (decision.action === "resume") {
          const rec = decision.record;
          pendingRecoveryRef.current = rec; // 열기 성공 시 [doc] 이펙트가 adoptRecovered 로 재귀속
          setResuming(true);
          // 시드(편집 전 원본)는 원래 파일명 그대로 연다 — 바이트가 .hwp 인데 " (복구본).hwpx" 로
          // 열면 확장자와 내용이 어긋난다. 편집본 스냅샷은 진짜 HWPX 라 기존 이름 규칙 유지.
          const ok = await openBytes(rec.bytes, rec.seed && rec.sourceName ? rec.sourceName : recoveredName(rec.docName));
          if (cancelled) return;
          setResuming(false);
          if (ok) {
            // 편집 전 시드면 "복구했다"가 아니라 "이어서 본다"가 정직하다(되살릴 편집이 없었다).
            if (rec.seed) setResumeToast("새로고침 전 보던 문서를 다시 열었습니다 — 아직 편집한 내용은 없습니다.");
            else setResumeToast(resumeToastMessage(rec.savedAt, Date.now()));
            return; // doc 세팅 → 이 이펙트는 재실행되고 곧바로 early-return 한다
          }
          // 열기 실패(손상 등) — 정직한 사유를 남기고 배너 경로로 강등한다. 스냅샷은 보존한다.
          pendingRecoveryRef.current = null;
          clearLiveDoc();
          if (!failUrl()) setNotice("새로고침 전 문서를 자동으로 열지 못했습니다 — 아래 복구 배너에서 다시 시도하거나 무시할 수 있습니다.");
        } else {
          // 마커는 있는데 스냅샷이 없다(편집 전 새로고침 · 명시 내보내기로 정리됨 · 만료 · 시크릿).
          // 되살릴 것이 없으므로 조용히 랜딩한다(빈 배너·거짓 안내 금지). 마커만 정리.
          clearLiveDoc();
          failUrl(); // 주소로 들어온 경우만 안내 — 평소 새로고침은 지금처럼 조용히 랜딩.
        }
      }
      // ② 미복구(고아) 스냅샷 배너 — 만료분은 findRecoverable 이 이 자리에서 청소한다.
      try {
        const rec = await findRecoverable(store);
        if (!cancelled) setRecovery(rec);
      } catch {
        if (!cancelled) setRecovery(null); // IndexedDB 접근 불가 — 배너 없음(저장도 곧 1회 안내 후 비활성)
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doc, store, openBytes, restoreHomeUrl]);

  // ── 이슈 052: 복구 배너 액션 ─────────────────────────────────────────────────────────────────────
  // 복구 = 스냅샷 바이트(편집된 HWPX본)를 " (복구본).hwpx" 이름으로 연다. 열기 성공 시(위 doc 이펙트)
  // adoptRecovered 가 새 세션으로 재귀속 + 옛 키 삭제 — 콘텐츠는 절대 유실되지 않는다. 열기 실패 시
  // 스냅샷을 지우지 않고 정직한 사유를 남긴다(배너 유지 — 다시 시도/무시는 사용자의 선택).
  const onRestore = useCallback(async () => {
    if (!recovery) return;
    pendingRecoveryRef.current = recovery; // 열기 성공 시 [doc] 이펙트가 소비(adoptRecovered)한다
    const ok = await openBytes(recovery.bytes, recoveredName(recovery.docName));
    if (!ok) {
      // 열기 실패 — 재귀속되지 않았다. 스냅샷은 보존하고 사유만 알린다(다시 시도/무시는 사용자의 선택).
      pendingRecoveryRef.current = null;
      setNotice("복구본을 여는 데 실패했습니다 — 스냅샷은 보존됩니다. 다시 시도하거나 무시를 눌러 삭제하세요.");
    }
  }, [recovery, openBytes]);

  // 무시 = 스냅샷 삭제(설계 확정) — 배너도 내려간다. 지운 스냅샷을 가리키는 마커가 남아 있으면
  // 같이 정리한다(존재하지 않는 문서로 자동 재개를 시도하지 않게 — 마커 제거 지점 ①).
  const onDismissRecovery = useCallback(async () => {
    if (!recovery) return;
    await store.delete(recovery.key).catch(() => {});
    if (readLiveDoc() === recovery.key) clearLiveDoc();
    setRecovery(null);
  }, [recovery, store]);

  // ── 명시적 닫기 ─────────────────────────────────────────────────────────────────────────────────
  // 자동 재개가 생기면서 **필요해진** 출구다: 재개가 없던 시절엔 새로고침이 곧 "닫기"였지만, 이제
  // 새로고침은 문서를 되살린다. 그래서 "이 문서 그만 보기"를 사용자가 명시할 수 있어야 한다.
  // 규칙(마커 제거 지점 ②): **마커만 지우고 스냅샷은 남긴다** — 사용자 콘텐츠 삭제 금지. 닫은
  // 편집본은 고아 스냅샷이 되어 곧바로 현행 복구 배너로 다시 제안된다(원하면 되살릴 수 있다).
  // 주소도 함께 홈으로 되돌린다 — 문서를 닫았는데 주소창에만 문서가 남아 있으면 거짓말이 된다.
  const onCloseDoc = useCallback(() => {
    clearLiveDoc();
    restoreHomeUrl();
    docUrlRef.current = null;
    pendingUrlKeyRef.current = null;
    setDoc(null);
    setLabError(null);
    setResumeToast(null);
  }, [restoreHomeUrl]);

  // ── 로고(홈) ────────────────────────────────────────────────────────────────────────────────────
  // 편집 화면의 좌상단 로고 = 홈 앵커. **확인을 묻지 않는다**: 자동저장이 이미 스냅샷을 남기고 있고
  // (헤더의 "자동저장됨" 라벨이 그 근거다) 닫기는 스냅샷을 지우지 않으므로, 홈으로 나가도 잃는 것이
  // 없다 — 되돌아오면 복구 배너가 그 편집본을 그대로 제안한다. 지우는 출구는 "처음부터" 하나뿐이다.
  const onGoHome = useCallback(() => {
    void autosave.flush(); // 나가기 전 마지막 편집을 한 번 더 남긴다(best-effort — 실패해도 진행)
    onCloseDoc();
  }, [autosave, onCloseDoc]);

  // ── "처음부터"(초기화) ───────────────────────────────────────────────────────────────────────────
  // 닫기와의 차이는 **스냅샷까지 지운다**는 것 하나다. 닫기는 "그만 보기"(편집본은 배너로 남는다),
  // 이건 "이 문서 흔적을 치우고 첫 화면으로"다. 사용자 콘텐츠를 지우므로 **확인을 1회 받는다**(배너의
  // "무시"와 같은 등급의 명시적 삭제). 다른 문서의 스냅샷은 건드리지 않는다.
  const onResetAll = useCallback(async () => {
    if (!window.confirm("처음부터 다시 시작할까요?\n\n지금 열린 문서를 닫고 이 문서의 자동저장 스냅샷을 삭제합니다. 되돌릴 수 없습니다.\n(내려받은 파일은 그대로 남습니다.)")) return;
    await autosave.discardSession();
    clearLiveDoc();
    restoreHomeUrl();
    docUrlRef.current = null;
    pendingUrlKeyRef.current = null;
    setDoc(null);
    setRecovery(null);
    setLabError(null);
    setNotice(null);
    setResumeToast(null);
    setSavedLabel(null);
  }, [autosave, restoreHomeUrl]);

  // ── 이슈 052: 명시 내보내기 성공 시 스냅샷 정리 (v1 R13) ─────────────────────────────────────────
  // HwpWorkspace 의 onExport 시임(이슈 044)을 받아 웹 기본 동작(브라우저 <a download>)을 그대로 수행한
  // 뒤 markExported 로 이 세션의 스냅샷을 정리한다. 다운로드가 곧 "명시 저장"인 웹 셸의 규칙.
  const onExport = useCallback(
    async (data: Uint8Array | string, filename: string, mime: string) => {
      const part = typeof data === "string" ? data : (() => {
        const c = new Uint8Array(data.length);
        c.set(data);
        return c;
      })();
      const a = window.document.createElement("a");
      a.href = URL.createObjectURL(new Blob([part], { type: mime }));
      a.download = filename;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      await autosave.markExported();
      setSavedLabel(null);
    },
    [autosave],
  );

  // 채팅 바이브편집 브리지(R6): 패키지는 LLM/키를 갖지 않는다. 서버 프록시(/api/hwp-edit)로 위임.
  // 에이전틱 스트리밍: opts.onEvent 가 있으면(=채팅 타임라인) `?stream=1` 경로로 POST 하고 NDJSON AgentEvent
  // 를 읽어 각 이벤트를 onEvent 로 흘린 뒤 최종 intents 로 resolve 한다. onEvent 가 없으면(=InlineEditPanel)
  // 기존 단발 res.json() 경로 그대로(back-compat). 대화 메모리(opts.history)는 본문에 실어 서버가 모델
  // messages 에 접는다. 키/검색은 전부 서버사이드(R6).
  const onAiRequest = useCallback(async (instruction: string, anchors: Anchor[], ctx: DocContext, opts?: AiRequestOptions): Promise<Intent[]> => {
    // 정적 데모: 프록시 URL이 설정돼 있으면 그리로 위임(아래 별도 블록), 없으면 정직하게 안내하고 끝낸다.
    if (IS_DEMO && !demoAiOn) {
      throw new Error("정적 데모에서는 AI 편집을 지원하지 않습니다 — 레포를 클론해 로컬 실행(.env.local에 OPENROUTER_API_KEY) 시 사용할 수 있습니다.");
    }
    if (demoAiOn) {
      // 공개 데모의 비용·데이터 경계는 텍스트 문맥만 허용한다(maxAttachments=0). ChatPanel의 SDK
      // 첨부 UI가 보이더라도 payload를 same-origin route까지 조용히 버리거나 보내지 않는다.
      const attachmentError = demoAiAttachmentError(opts?.attachments?.length ?? 0);
      if (attachmentError) throw new Error(attachmentError);
      // 동의 문구는 **실제 중계 경로**를 말한다(worker=Cloudflare Worker / route=우리 서버(Vercel)).
      // 게이트는 인앱 모달로 묻고(askDemoAiConsent), 동의는 이 브라우저에 1회만 기억된다.
      if (!(await ensureDemoAiConsent(demoAiConsentRef.current, askDemoAiConsent, demoAiTransport))) {
        throw new Error("AI 전송에 동의하지 않아 요청을 보내지 않았습니다. 수동 편집과 내보내기는 계속 사용할 수 있습니다.");
      }
    }
    // 066: 표/셀 앵커마다 엔진에서 그 표의 셀 그리드(행×열·각 셀 텍스트·빈칸)를 조회해 doc-context 에
    // 첨부한다 — 그래야 모델이 "표 채워줘"·라벨 옆 값칸 지정·구조편집(행 N개)을 정확히 한다(얇은 앵커
    // 컨텍스트에선 intents 0 이었음). 표가 아니거나 조회 실패면 null(첨부 없음 → 기존 동작, 회귀 방지).
    // 067: 문서 프로필(제목·구성 카운트·목차·표 목록·본문 발췌)을 엔진에서 결정론으로 뽑아 매 요청의
    // doc-context 에 상시 첨부한다 — 사용자가 "이 문서가 뭔지"를 설명하거나 앵커를 찍기 전에도 모델이
    // 문서를 인지한다(U1·U2). 순수 모델 read 라 요청마다 조회해도 싸고, 편집 직후에도 스테일이 없다.
    // 어댑터 미지원/실패면 undefined → 기존 얇은 컨텍스트 그대로(바이트 동일, 회귀 방지).
    // 불릿 채움: 문단 앵커마다 엔진의 `blockRuns`(런 텍스트 + 저작 pt)를 조회해 doc-context 의 그 앵커
    // 줄에 "문단서식=[…]" 힌트로 붙인다. 한국 양식의 개요 목록은 12~14pt 마커 문단("◦"/"-") 사이에
    // 6~8pt **빈 스페이서 문단**이 끼어 있는데, 앵커만 보면 둘 다 그냥 text="" / text="◦" 라 구분이
    // 불가능하다 — 실사고에서 모델이 스페이서(6pt)에 본문을 써서 글자가 아주 작게, 불릿과 분리된
    // 줄로 렌더됐다. 크기는 엔진만 아는 사실이라 여기서 실어 보낸다. 어댑터 미지원/실패 → null
    // (힌트 없음 = 기존 컨텍스트 바이트 동일, 회귀 방지).
    const [profile, grids, paraRuns] = await Promise.all([
      adapter.docProfile ? adapter.docProfile().catch(() => undefined) : Promise.resolve(undefined),
      Promise.all(
        anchors.map((a) =>
          // 이슈 2: `range`(행/칸 범위) 앵커도 표 앵커다 — 그리드를 빼면 좁게 가리킬수록 모델이
          // 더 못 보는 역설이 생긴다(앵커는 좁히되 표 문맥은 유지).
          (a.kind === "table" || a.kind === "cell" || a.kind === "range") && adapter.tableGrid
            ? adapter.tableGrid(a.section, a.block).catch(() => null)
            : Promise.resolve(null),
        ),
      ),
      Promise.all(
        anchors.map((a) =>
          a.kind === "paragraph" && adapter.blockRuns
            ? adapter.blockRuns(a.section, a.block).catch(() => null)
            : Promise.resolve(null),
        ),
      ),
    ]);
    const requestBody = {
      instruction,
      anchors,
      // R5-펜스용 doc-context 문자열 — ai-protocol 이 서버와 공유하는 조립기(이슈 026). 066: 그리드 첨부.
      docContext: buildDocContext({ format: ctx.format, pages: ctx.pages, editable: ctx.editable, sections: ctx.sections, profile }, anchors, { grids, paraRuns }),
      // Feature A(비스트리밍 경로 back-compat): 웹 검색 grounding 플래그. 스트리밍 에이전트는 검색을 스스로
      // 결정하므로 채팅은 더 이상 이 값을 켜지 않는다(InlineEditPanel 등이 쓰면 서버가 web 플러그인을 켠다).
      webSearch: opts?.webSearch ?? false,
      // 멀티모달: 첨부(이미지=vision dataUrl, 문서=추출 텍스트)를 서버로 전달. 서버가 이미지 present면
      // OpenAI content-parts로, 문서 텍스트는 R5 <attachment> 펜스로 조립한다. 키/모델은 서버사이드(R6).
      ...(opts?.attachments?.length ? { attachments: opts.attachments } : {}),
      // 대화 메모리(에이전틱 스트리밍): 직전 채팅 턴(바운드). 서버가 모델 messages 에 접는다.
      ...(opts?.history?.length ? { history: opts.history } : {}),
    };

    // ── 데모 프록시 경로 ──────────────────────────────────────────────────────────────────────────
    // 키 보관 + 일일/IP 한도를 쥔 하드닝 엔드포인트로 단발 위임한다. 전송 대상은 두 가지:
    //   worker : 정적 데모(Pages) — 별도 Cloudflare Worker(services/demo-ai-proxy).
    //   route  : full Next 배포(Vercel) — same-origin `/api/hwp-edit`(DEMO_AI_MODE=1).
    // 둘 다 **같은 요청·응답 계약**이라 분기는 URL 하나뿐이다. 에이전틱 스트리밍/웹검색은 데모에서
    // 끈다(비용·복잡도 최소화) — 채팅은 최종 intents 로 제안 카드를 그대로 만든다.
    if (demoAiOn) {
      const res = await fetch(DEMO_AI_URL || `${BASE}/api/hwp-edit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instruction, anchors, docContext: requestBody.docContext }),
      });
      let payload: Record<string, unknown> | null = null;
      try {
        payload = (await res.json()) as Record<string, unknown>;
      } catch {
        /* 비-JSON(프록시 장애/게이트웨이 오류) */
      }
      // 429(한도)·503(미구성)은 서버 문구가 그대로 완성된 안내다 — 접두 없이 그대로 띄운다.
      if (!res.ok) throw new Error(demoAiHttpError(res.status, payload));
      // 빈/부분 제안의 **이유**를 반드시 표시한다(어제까지는 조용히 "제안 0건"으로 끝났다):
      //  · 0건 → 오류 말풍선으로 이유를 말하고 끝낸다.
      //  · 부분(절단 구제) → 카드는 살리되 타임라인에 "일부만 반영" 경고를 남긴다.
      const outcome = readDemoAiResponse<Intent>(payload);
      if (outcome.error) throw new Error(outcome.error);
      if (outcome.warning) opts?.onEvent?.({ type: "thinking_delta", text: `⚠️ ${outcome.warning}` });
      return outcome.intents;
    }

    // ── 스트리밍 경로(채팅 타임라인) ──────────────────────────────────────────────────────────────
    if (opts?.onEvent) {
      const res = await fetch(`${BASE}/api/hwp-edit?stream=1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      if (!res.ok || !res.body) {
        let detail = `${res.status}`;
        try {
          const j = (await res.json()) as { error?: string };
          if (j?.error) detail = j.error;
        } catch {
          /* 비-JSON 오류 본문 */
        }
        throw new Error(`AI 서버 오류: ${detail}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = createAgentEventParser();
      let finalIntents: Intent[] = [];
      const citations: Citation[] = [];
      let streamError: string | null = null;
      const handle = (ev: AgentEvent) => {
        opts.onEvent!(ev); // 각 이벤트를 채팅 타임라인으로 흘린다(THINKING TRANSPARENCY)
        if (ev.type === "tool_result" && ev.citations?.length) citations.push(...ev.citations);
        else if (ev.type === "intents") finalIntents = ev.intents;
        else if (ev.type === "error") streamError = ev.message;
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const ev of parser.push(decoder.decode(value, { stream: true }))) handle(ev);
      }
      for (const ev of parser.flush()) handle(ev);
      if (opts.onCitations) opts.onCitations(citations); // 근거(출처)를 채팅으로(intents 반환 계약 불변)
      if (streamError) throw new Error(streamError);
      return finalIntents;
    }

    // ── 비스트리밍 경로(InlineEditPanel · back-compat) ───────────────────────────────────────────
    const res = await fetch(`${BASE}/api/hwp-edit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    if (!res.ok) {
      let detail = `${res.status}`;
      try {
        const j = (await res.json()) as { error?: string };
        if (j?.error) detail = j.error;
      } catch {
        /* 비-JSON 오류 본문 */
      }
      throw new Error(`AI 서버 오류: ${detail}`);
    }
    const data = (await res.json()) as { intents?: Intent[]; citations?: Citation[] };
    // Feature A: 근거(출처)를 채팅으로 전달 — intents 반환 계약(Promise<Intent[]>)은 불변(InlineEditPanel 안전).
    if (opts?.onCitations) opts.onCitations(data.citations ?? []);
    return data.intents ?? [];
  }, [adapter, askDemoAiConsent, demoAiOn, demoAiTransport]);

  // R8: 폰트는 번들하지 않는다. 기본 NanumGothic 이 자동 등록되므로 PDF 는 곧바로 활성화되지만,
  // (기본 폰트 fetch 실패 등으로) 미주입 상태에서 PDF 를 누르면 이 폴백이 호출된다: 기본 폰트를 다시
  // 시도하고, 그래도 없으면 툴바 FontPicker(카탈로그/업로드)로 안내한다.
  const requestFont = useCallback(async (): Promise<{ family: string; bytes: Uint8Array } | null> => {
    if (defaultFont) return defaultFont;
    try {
      const r = await fetch(DEFAULT_FONT_PATH);
      if (r.ok) return { family: DEFAULT_FONT_FAMILY, bytes: new Uint8Array(await r.arrayBuffer()) };
    } catch {
      /* 기본 폰트 미배치 — FontPicker 로 폴백 */
    }
    setLabError(
      `PDF용 폰트가 없습니다.\n상단 툴바의 "글꼴" 선택기에서 카탈로그 폰트를 고르거나 .ttf/.otf 를 업로드하세요. ` +
        `(scripts/fetch-fonts.mjs 로 카탈로그를 내려받을 수 있습니다. 한컴/함초롬 폰트는 재배포 불가로 번들하지 않습니다.)`,
    );
    return null;
  }, [defaultFont]);

  // 재개 토스트는 사용자 액션이 필요 없는 정보성 알림 — 몇 초 뒤 스스로 사라진다(수동 닫기도 가능).
  // 문서 렌더가 끝나기 전에 사라지면 "복구됐다"는 사실 자체를 못 보므로 넉넉히 잡는다.
  useEffect(() => {
    if (!resumeToast) return;
    const t = setTimeout(() => setResumeToast(null), RESUME_TOAST_MS);
    return () => clearTimeout(t);
  }, [resumeToast]);

  // 배지 툴팁을 클릭으로 열어 두면 바깥 클릭·Esc 로 닫는다(호버 표시는 CSS 가 담당 — 터치 기기에는
  // 호버가 없으므로 클릭 토글이 유일한 진입점이다).
  useEffect(() => {
    if (!badgeTip) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest(".lab-badge-wrap")) return; // 배지 자신의 클릭은 토글에 맡긴다
      setBadgeTip(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setBadgeTip(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [badgeTip]);

  // 배지는 **로컬(서버 있는) 실행의 QA 신호**다: 키가 꽂혔는지(live) 아닌지(mock)를 화면에 명시한다.
  // 공개 정적 데모(static)에서는 배지를 띄우지 않는다 — 사용자가 고를 수 있는 모드가 아니라 배포
  // 형태일 뿐이고, 우상단에 상시 붙은 "정적 데모 · AI" 라벨은 제품 화면에 잡음만 더한다.
  // AI 전송 고지는 첫 요청 전 동의 게이트(lib/demoAiConsent.ts)가 계속 담당한다.
  //
  // 문구는 개발자 톤("실 LLM 모드")에서 사용자 톤("AI 켜짐")으로 바꾸고, **어떤 모델로 도는지**는
  // 배지가 아니라 툴팁이 말한다(호버/클릭). 모델명은 서버 상태 응답에서 오고(하드코딩 금지 —
  // 클라이언트 번들에 모델 리터럴을 박지 않는다), 없으면 성격만 설명한다.
  // 공개 데모(우리가 비용을 내는 중계)와 셀프호스트(BYOK — 이 배포 소유자의 키)는 **사실이 다르다**.
  // 한 문구로 뭉뚱그리면 둘 중 하나에는 거짓말이 되므로 갈라서 말한다.
  const isPublicDemoAi = demoAiOn || aiProvider === "demo";
  const modelLine = aiModel
    ? `${aiModel} 모델로 동작합니다${aiProvider === "demo" || aiProvider === "openrouter" ? " (OpenRouter 경유)" : ""}.`
    : "서버에 설정된 모델로 동작합니다.";
  const badgeTipText =
    mode === "live"
      ? [
          `${isPublicDemoAi ? "지금 이 데모는 " : "이 배포는 "}${modelLine}`,
          isPublicDemoAi
            ? "체험용이라 우리 서버가 중계하고 사용량 한도가 있습니다. 직접 임베드하면 모델과 API 키는 호스트가 소유합니다(BYOK)."
            : "이 서버에 설정된 키로 직접 호출합니다 — 모델과 키는 이 배포의 소유자 몫입니다(BYOK).",
        ]
      : ["서버에 API 키가 없어 결정적 mock 제안으로 동작합니다.", "제안 카드·적용·되돌리기까지 전체 흐름은 그대로 체험할 수 있습니다."];
  const badge =
    mode === "loading" ? (
      <span className="lab-badge lab-badge-loading">모드 확인 중…</span>
    ) : mode === "static" ? null : (
      <span className="lab-badge-wrap">
        <button
          type="button"
          className={`lab-badge ${mode === "live" ? "lab-badge-live" : "lab-badge-mock"}`}
          data-testid="ai-badge"
          aria-expanded={badgeTip}
          onClick={() => setBadgeTip((v) => !v)}
        >
          {mode === "live" ? "AI 켜짐" : "mock 모드"}
        </button>
        <span className={`lab-tip${badgeTip ? " is-open" : ""}`} role="tooltip" data-testid="ai-badge-tip">
          {badgeTipText.map((t) => (
            <span key={t}>{t}</span>
          ))}
        </span>
      </span>
    );

  return (
    // `lab-landing` = 문서 열기 전 화면을 앱 셸(height:100vh + 세로 중앙)이 아니라 문서처럼 자연
    // 스크롤시킨다. 데모/QA 공통 — 고정 높이면 히어로가 커질 때 위쪽으로 오버플로해 상단 콘텐츠
    // (복구 배너 등)가 화면 밖으로 밀려 클릭조차 안 된다(e2e 052 실패로 발현).
    <div className={`lab-root lab-demo${doc ? "" : " lab-landing"}`}>
      {/* 헤더는 두 벌이다.
          · 랜딩(문서 열기 전) = **사이트 크롬**(SiteHeader): 로고·데모·양식 일괄 작성·벤치마크·Docs·GitHub.
            /docs, /bench 와 같은 헤더를 써서 랜딩도 사이트의 한 페이지로 읽히게 한다.
          · 문서를 연 뒤(=편집 모드) = 기존 앱 헤더(.lab-header): 파일 열기·닫기·자동저장 상태·모드 배지.
            편집 화면의 크롬은 건드리지 않는다(사이트 네비가 편집 중에 끼어들지 않게).
          ⚠ `hidden` 속성은 .lab-header의 display:flex에 밀린다 — 조건부 렌더로 지운다. */}
      {!doc && <SiteHeader current="home" />}
      {doc && (
      <header className="lab-header">
        {/* 로고 = 홈 앵커(사용자 피드백). 자동저장이 스냅샷을 남기고 닫기는 그것을 지우지 않으므로
            **확인 없이** 홈으로 간다 — 되돌아오면 복구 배너가 그 편집본을 그대로 제안한다. 진짜
            링크(<a href="/">)로 두어 새 탭/가운데 클릭도 자연스럽게 동작하되, 좌클릭은 앱 안에서
            상태를 정리하며 홈으로 간다(전체 새로고침 없이 = 엔진 재로딩 없이). */}
        <a
          className="lab-title lab-title-link"
          href={homePath(BASE)}
          data-testid="doc-home"
          title="첫 화면으로 — 편집본은 자동저장되어 남습니다"
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // 새 탭/새 창은 브라우저에 맡긴다
            e.preventDefault();
            onGoHome();
          }}
        >
          {/* 낙관(도장)은 장식 — alt 를 비워 두면 링크 이름은 옆 글자("오토한글 한글 문서 편집")
              그대로다. 이 앵커의 e2e 계약(data-testid="doc-home" 클릭 → 홈)은 바뀌지 않는다. */}
          <img className="lab-title-seal" src={`${BASE}/brand/seal.png`} alt="" width={19} height={19} />
          오토한글
          <small>한글 문서 편집</small>
        </a>
        {/* 공개 데모 크롬(레포 링크)은 정적 데모(Pages)와 라우트 데모(Vercel) 양쪽에 붙는다 —
            full Next 배포에는 NEXT_PUBLIC_DEMO=1 이 없으므로 IS_DEMO 만으로는 사라진다. */}
        {(IS_DEMO || DEMO_AI_ROUTE) && (
          <a className="lab-gh-link" href="https://github.com/kwakseongjae/auto-hwp" target="_blank" rel="noreferrer" title="GitHub 저장소">
            GitHub <ExternalLink size={12} />
          </a>
        )}

        {/* 헤더 액션은 앱 디자인 토큰(lab-hbtn)으로 통일한다 — 이전엔 브라우저 기본 버튼처럼 보여
            "시스템 UI가 문서 위에 끼어 있다"는 인상을 줬다(사용자 피드백 이슈 4). */}
        <label className="lab-btn lab-hbtn" title="내 컴퓨터의 .hwp/.hwpx 파일을 엽니다">
          <FolderOpen size={14} />
          파일 열기
          <input type="file" accept=".hwp,.hwpx" hidden onChange={onFile} data-testid="file-input" />
        </label>

        {/* 명시적 닫기 — 새로고침 자동 재개의 출구(마커 제거). 편집본 스냅샷은 지우지 않으므로
            닫은 뒤에도 열기 화면의 복구 배너로 되살릴 수 있다. */}
        <button className="lab-btn lab-hbtn" data-testid="doc-close" onClick={onCloseDoc} title="문서를 닫고 열기 화면으로 — 편집본은 복구 배너로 남습니다">
          <XIcon size={14} />
          문서 닫기
        </button>

        {/* 처음부터 — 닫기와 달리 이 문서의 스냅샷까지 지우고 첫 화면으로 돌아간다(확인 1회). */}
        <button className="lab-btn lab-hbtn" data-testid="doc-reset" onClick={() => void onResetAll()} title="이 문서를 닫고 자동저장 스냅샷도 삭제한 뒤 첫 화면으로 (확인 후 실행)">
          <RotateCcw size={14} />
          처음부터
        </button>

        {/* 글꼴 선택은 문서 툴바의 FontPicker(카탈로그+업로드)가 담당한다 — 화면·조판·PDF 일치. */}

        <span className="lab-spacer" />

        {busy && (
          <span className="lab-status lab-status-busy" role="status">
            {busy}
            {workerMode && (
              // 이슈 055: 워커 모드에선 파싱이 비차단이라 취소가 실제로 가능하다(프로브 워커 종료).
              <button className="lab-btn lab-cancel-open" data-testid="open-cancel" onClick={cancelOpen}>
                취소
              </button>
            )}
          </span>
        )}
        {savedLabel && (
          <span className="lab-status" role="status" data-testid="autosave-status" title="자동저장: 편집 2초 유휴 후 편집본(HWPX)을 브라우저(IndexedDB)에 보관">
            {savedLabel}
          </span>
        )}
        {badge}
        <ThemeToggle />
      </header>
      )}

      {labError && (
        <div className="lab-error" role="alert" data-testid="lab-error">
          {labError}
        </div>
      )}

      {notice && (
        <div className="lab-error lab-notice" role="status" data-testid="autosave-notice">
          {notice}
          <button className="lab-btn lab-notice-close" onClick={() => setNotice(null)}>
            닫기
          </button>
        </div>
      )}

      {/* 자동 재개 토스트: "이미 되돌려 놨다 + 어디까지 살아 있다(시각)"를 사후 통지한다.
          pagehide flush 는 보장이 아니므로 시각 표기가 이 토스트의 핵심 정보다.
          ⚠️ 전폭 배너였을 때는 이 정보성 문구가 **레이아웃을 밀어내** 문서가 아래로 내려갔다(사용자
          피드백). 사용자가 할 일이 없는 알림이므로 문서 위에 떠 있다가 스스로 사라지는 토스트가 맞다
          (RESUME_TOAST_MS). 계약(testid)은 그대로 — e2e 는 같은 이름으로 계속 검증한다. */}
      {resumeToast && (
        // ⚠️ 닫기 버튼이 없다(그리고 토스트 전체가 pointer-events:none 이다). 우하단은 채팅 입력창의
        // 보내기 버튼 자리라, 닫기 버튼을 달았더니 그 위를 덮어 **전송 클릭을 가로챘다**(e2e 실측:
        // elementFromPoint(보내기 중앙) = .lab-toast-close). 사용자 액션이 필요 없는 알림이므로
        // 클릭을 통과시키고 스스로 사라지는 쪽이 옳다.
        <div className="lab-toast" role="status" data-testid="resume-toast">
          {resumeToast}
        </div>
      )}

      <div className="lab-body">
        {doc ? (
          <HwpWorkspace
            adapter={adapter}
            brand="오토한글"
            document={doc}
            onAiRequest={onAiRequest}
            // 채팅 UI는 에디터(SDK)가 아니라 **이 앱**이 조립한다 — 워크스페이스는 편집 표면만
            // 제공하고 오른쪽 패널은 호스트 몫이다(`WorkspaceSidePanel`). 우리 채팅은 데모용
            // 참조 구현이라 제품 계약에 넣지 않는다.
            // 패널 상단 notice 는 **기능이 꺼져 있을 때만** 띄운다(그건 사용자가 모르면 안 되는 사실).
            // AI 가 켜진 데모의 전송 고지는 배너가 아니라 **첫 요청 전 동의 게이트**가 담당한다
            // (lib/demoAiConsent.ts — 전송 대상·범위·되돌리기까지 그 문구가 싣는다). 상시 배너는
            // 같은 말을 매 화면 반복하면서 정작 전송 시점에는 아무 것도 막지 못했다.
            sidePanel={chatSidePanel({
              onAiRequest,
              isMock: mode === "mock",
              notice:
                IS_DEMO && !DEMO_AI_ON
                  ? "정적 데모라 AI 편집은 꺼져 있습니다 — 클릭 선택·수동 편집·HTML/PDF 저장은 전부 동작합니다. AI 바이브 편집은 레포를 클론해 로컬 실행(BYOK)하면 켜집니다."
                  : DEMO_AI_ROUTE && mode === "static"
                    ? "데모 AI가 아직 구성되지 않았습니다(서버 키 미설정) — 문서 열기·수동 편집·HTML/PDF 저장은 전부 동작합니다."
                    : undefined,
            })}
            requestFont={requestFont}
            fontCatalog={FONT_CATALOG}
            defaultFont={defaultFont}
            fontUrlBase={FONT_URL_BASE}
            // 이슈 058: 명조(serif) 서체를 OFL 대체(Nanum Myeongjo)로 화면 @font-face + PDF 임베드까지 라우팅.
            // fetch-fonts.mjs 가 public/fonts 에 Nanum Myeongjo 를 받아 두면 명조/고딕이 구분 렌더된다.
            injectSerifSubstitute
            // 이슈 027: 수동 편집 UI(표 추가·룰러·열너비 드래그·더블클릭 텍스트·서식 툴바) 옵트인.
            enableEditing
            // 공개/QA 앱은 원본 SVG를 덮는 contentEditable 대신 엔진 글리프 캐럿을 쓴다. 편집 중에도
            // 한컴 정렬·폰트·위치가 그대로 보이고, 색상/서식은 우측 디자인 탭에서 수정한다.
            preferEngineCaretEditing
            // 선택 서식은 우측 디자인 inspector 한 곳에만 둔다. 상단은 문서/삽입/내보내기 전역 도구,
            // 우측은 현재 선택 요소라는 Figma식 역할 분리를 유지한다.
            formatSurface="inspector"
            // 이슈 4(툴바 정리): 데모 문서 툴바는 **읽고 고치고 내보내는 최소 세트**만 노출한다.
            // 숨긴 것(HWPX 내려받기·표 추가·이미지·레이아웃 정리)은 SDK 에서 제거된 게 아니라 이
            // 화면에서만 접는 것이다 — 표 추가/이미지/서식은 우클릭 메뉴와 디자인 탭에 그대로 있고,
            // toolbarItems 를 넘기지 않는 다른 호스트는 전 항목을 그대로 받는다(기본값 = 현행).
            toolbarItems={fullToolbar ? undefined : DEMO_TOOLBAR_ITEMS}
            // 다크에서만 스튜디오 팔레트를 입힌다. 라이트에서는 클래스를 떼어 SDK 기본 테마(이미
            // 라이트로 설계돼 있다)를 그대로 쓴다 — 컴포넌트 수정 없이 색을 되칠할 필요가 없다.
            // (앱 CSS 의 미세 조정은 globals.css §라이트 에디터.)
            className={theme === "light" ? undefined : "hw-studio"}
            // 이슈 050: 페이지 위에 이미지를 드롭하면 삽입, .hwp/.hwpx 를 드롭하면 이 콜백으로 열기.
            onOpenFile={async (bytes, name) => {
              await openBytes(bytes, name); // 성공 여부는 복구 배너 전용 — 드롭 열기는 결과 무시(050 동작 유지)
            }}
            // 이슈 052: 내보내기는 웹 기본(브라우저 다운로드)을 그대로 수행하고 스냅샷을 정리한다.
            onExport={onExport}
            // 이슈 6: PDF 는 곧장 내려받지 않고 **방금 만든 그 바이트**를 미리보기로 먼저 보여준다.
            // "다운로드"를 눌러야 위 onExport(다운로드 + 스냅샷 정리)가 돈다 — 화면과 대조한 뒤 저장.
            pdfPreview
          />
        ) : (
          <div className="lab-empty">
            {/* 테마 토글은 이제 사이트 헤더(SiteHeader) 안에 산다 — 떠 있는 토글은 헤더와 겹쳐
                두 개로 보였다. `ThemeToggle` 은 여전히 이 파일에서 import 되어 편집 모드 헤더가 쓴다. */}
            {resuming && (
              // 자동 재개 중 — 랜딩 히어로가 잠깐 보이는 동안 "왜 아무 일도 없는가"를 설명한다.
              <div className="lab-recovery" role="status" data-testid="resume-progress">
                <div className="lab-recovery-text">새로고침 전 문서를 다시 여는 중…</div>
              </div>
            )}
            {recovery && !busy && !resuming && (
              // 이슈 052: 재방문 복구 배너 — 복구본은 "편집된 HWPX본"(원본 .hwp 아님)임을 명시한다.
              <div className="lab-recovery" role="alert" data-testid="recovery-banner">
                <div className="lab-recovery-text">
                  <b>『{recovery.docName}』</b>의 {formatAge(Date.now() - recovery.savedAt)} 편집본이 있습니다 (편집 {recovery.rev}회).
                  <br />
                  <small>복구본은 편집 내용이 반영된 <b>HWPX본</b>이며 원본 .hwp 파일이 아닙니다. 무시를 누르면 스냅샷이 삭제됩니다.</small>
                </div>
                <div className="lab-recovery-actions">
                  <button className="lab-btn lab-btn-accent" data-testid="recovery-restore" onClick={() => void onRestore()}>
                    복구
                  </button>
                  <button className="lab-btn" data-testid="recovery-dismiss" onClick={() => void onDismissRecovery()}>
                    무시
                  </button>
                </div>
              </div>
            )}
            <div className="lab-hero" data-testid="lab-hero">
              <div className="lab-hero-grid">
                <div className="lab-hero-copy">
                  <div className="lab-kicker"><b>오토한글</b> · 한글 문서를 직접 다루는 엔진</div>
                  {/* 워드마크는 붓글씨 이미지다. 라이트/다크에서 잉크색이 반대라 두 장이 필요한데,
                      <img> 두 장을 넣고 CSS 로 하나를 숨기면 **둘 다** 내려받는다 — 그래서 배경
                      이미지 + CSS 변수로 둔다(테마에 맞는 한 장만 요청된다). basePath 접두가
                      필요해 URL 은 인라인 변수로 넘긴다(CSS 파일은 env 를 못 읽는다).
                      h1 안의 텍스트는 시각적으로만 숨긴다 — 제목의 실제 글자가 DOM 에 남아야
                      스크린리더와 검색엔진이 읽는다(이미지 alt 로 대신하지 않는다). */}
                  <h1 className="lab-hero-title">
                    <span
                      className="lab-mark"
                      aria-hidden
                      style={
                        {
                          "--wm-light": `url(${BASE}/brand/wordmark.png)`,
                          "--wm-dark": `url(${BASE}/brand/wordmark-dark.png)`,
                        } as React.CSSProperties
                      }
                    />
                    <span className="lab-sr-only">오토한글</span>
                    <span className="lab-caret" aria-hidden />
                  </h1>
                  <p className="lab-tagline">AI와 함께, 한 화면을 보면서 쓰는 한글</p>
                  <p className="lab-hero-sub">
                    AI가 <b>읽는 문서</b>와 <b>화면에 그려지는 문서</b>가 같은 엔진에서 나옵니다 — 그래서
                    말로 고친 편집이 검증되고, 한글에서 그대로 열립니다. 파일 열기·렌더·수동 편집·내보내기는
                    이 브라우저에서 처리됩니다.
                  </p>
                </div>
                {/* 그리드 영역(copy/stage/ways)으로 배치 — 데스크톱은 좌: 카피+카드 / 우: 스테이지,
                    좁은 화면은 카피 → 스테이지(제품 그림) → 카드 순서가 된다. */}
                <div className="lab-ways-block">
                  {/* 이 데모에서 할 수 있는 일 두 가지 — 문서 편집 / 양식 일괄 작성. */}
                  <div className="lab-ways">
                    <div className="lab-way">
                      {/* 제목+설명을 한 열로 묶는다 — 좁은 화면에서 카드가 가로로 접힐 때
                          제목이 버튼과 나란히 놓여 글자가 쪼개지는 것을 막는다. */}
                      <div className="lab-way-text">
                        <span className="n">문서 편집</span>
                        <p className="lab-way-long">내 한글 파일을 열어 화면에서 바로 고치고, HTML·PDF·HWPX로 저장합니다.</p>
                        {/* 좁은 화면 전용 축약본 — 카드가 한 줄로 접힌다(미디어쿼리로 전환). */}
                        <p className="lab-way-short">열고 고쳐서 저장</p>
                      </div>
                      <p className="lab-way-note">
                        창에 끌어다 놓아도 열립니다. <b>.hwpx는 알파 테스트 중</b>이라 이 데모에서는 .hwp만 받습니다.
                      </p>
                      {/* 버튼은 카드 하단에 정렬(margin-top:auto) — 두 카드의 행동 지점이 같은 높이에 온다. */}
                      <div className="lab-way-actions">
                        <label className="lab-btn lab-btn-accent lab-hero-open">
                          한글 파일 열기
                          <input type="file" accept=".hwp" hidden onChange={onFile} data-testid="file-input" />
                        </label>
                        {SAMPLES.filter((s) => s.file.endsWith(".hwp")).map((s) => (
                          <button key={s.file} className="lab-btn lab-sample-btn" data-testid={`sample-${s.file}`} title={s.hint} onClick={() => void openSample(s.file)}>
                            {s.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="lab-way">
                      <div className="lab-way-text">
                        <span className="n">양식 일괄 작성</span>
                        <p className="lab-way-long">양식 하나에 채울 자리를 정해 두고 명단을 넣으면, 사람 수만큼 완성본을 만들어 묶어 줍니다.</p>
                        <p className="lab-way-short">명단 수만큼 한 번에</p>
                      </div>
                      <p className="lab-way-note">채우는 과정은 전부 규칙 기반이라 AI 없이도 값이 정확히 들어갑니다.</p>
                      <div className="lab-way-actions">
                        <a className="lab-btn lab-btn-accent" href={`${BASE}/bulk`} data-testid="bulk-link" title="양식 1개 + 명단 N행 → 완성본 N부 zip">
                          일괄 작성 열기
                        </a>
                      </div>
                    </div>
                  </div>
                  <p className="lab-hero-note">
                    {DEMO_AI_ON
                      ? "파일 원본은 업로드하지 않습니다 · AI 사용 시 필요한 문서 문맥만 OpenRouter로 전송하며 첫 요청 전에 동의를 받습니다"
                      : "파일 원본은 브라우저 밖으로 나가지 않습니다 · AI 연동 시 전송 범위와 제공자는 호스트가 결정합니다"}
                  </p>
                  {/* W6.2: 엔진(wasm) 내려받기 상태. 유휴 프리페치가 랜딩에서 미리 돌므로 대부분 파일을
                      고르기 전에 "준비 완료"가 된다. 스타일은 인라인 — 이 배치에서 globals.css 는 다른
                      스트림 소유라 건드리지 않는다. */}
                  {engineLoad && (
                    <p
                      className="lab-hero-note"
                      role="status"
                      data-testid="engine-load"
                      data-engine-done={engineLoad.done ? "1" : "0"}
                      style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}
                    >
                      <span>
                        {engineLoad.done
                          ? "엔진 준비 완료 — 파일을 고르면 바로 렌더됩니다"
                          : engineLoad.pct == null
                            ? `엔진 내려받는 중 · ${(engineLoad.loaded / 1048576).toFixed(1)}MB`
                            : `엔진 내려받는 중 · ${engineLoad.pct}% (압축 전송 약 3.1MB)`}
                      </span>
                      {!engineLoad.done && (
                        <span
                          aria-hidden
                          style={{
                            display: "inline-block",
                            width: "7rem",
                            height: "3px",
                            borderRadius: "3px",
                            background: "rgba(127,127,127,0.25)",
                            overflow: "hidden",
                          }}
                        >
                          <span
                            style={{
                              display: "block",
                              height: "100%",
                              width: engineLoad.pct == null ? "35%" : `${engineLoad.pct}%`,
                              background: "currentColor",
                              opacity: 0.6,
                              transition: "width 120ms linear",
                            }}
                          />
                        </span>
                      )}
                    </p>
                  )}
                </div>
                <div className="lab-stage" aria-hidden>
                  <div className="lab-page"><img src={`${BASE}/brand/render-p0.svg`} alt="" /><div className="lab-shade" /></div>
                  <div className="lab-hl" />
                  <div className="lab-bubble lab-user">“사업 개요 표 채워줘”</div>
                  <div className="lab-bubble lab-ai">
                    <div className="h"><span className="ic"><Sparkles size={12} /></span> 표 채우기 제안 <span className="loc"><Crosshair size={11} /> s0·b3 위치 보기</span></div>
                    <div className="b">빈 값칸 6곳을 채웠습니다 — 라벨은 건드리지 않았어요.</div>
                    <div className="a"><span className="ok"><Check size={12} /> 적용</span><span className="no">되돌리기</span></div>
                  </div>
                </div>
              </div>

              <div className="lab-features">
                <div className="lab-feature">
                  <b>AI가 문서를 실제로 읽습니다</b>
                  <span>화면에 그려지는 문서와 AI가 받아 보는 문서가 같은 엔진에서 나옵니다. 어느 표의 어느 칸인지 사람이 짚어 주지 않아도 AI가 스스로 찾아갑니다.</span>
                </div>
                <div className="lab-feature">
                  <b>AI가 할 수 있는 일이 정해져 있습니다</b>
                  <span>AI는 정해진 편집 명령만 낼 수 있고, 모든 제안은 적용 전에 카드로 보여 줍니다. 바뀔 위치를 미리 확인하고 한 번에 되돌릴 수 있습니다.</span>
                </div>
                <div className="lab-feature">
                  <b>한글에서 열었을 때가 기준입니다</b>
                  <span>쪽 나눔과 줄바꿈을 한글이 계산한 결과와 대조해 검증하고, 손대지 않은 부분은 원본 그대로 보존합니다.</span>
                </div>
                <div className="lab-feature">
                  <b>원하는 방식으로 가져다 씁니다</b>
                  <span>엔진만, 화면 없는 편집 상태만, 문서 캔버스만 가져갈 수 있습니다. 기본 바이브·디자인 패널도 우측 레일·하단·모달로 바꿔 쓸 수 있고, 서비스 UI를 직접 넣어도 됩니다. 엔진의 열기·렌더·편집·내보내기는 로컬에서 실행됩니다.</span>
                </div>
              </div>

              {/* 사이트화: 기능 GIF 3종 + /docs·/bench 진입 동선. 히어로 아래(첫 화면 밖)에 두고
                  GIF 는 전부 lazy — 랜딩 첫 페인트와 엔진 프리페치를 방해하지 않는다. */}
              <LandingShowcase />

              <div className="lab-hero-dev">
                {/* 문서 링크는 이제 GitHub blob 이 아니라 **사이트 라우트**로 간다(/docs/[slug]).
                    레포 원문 링크는 각 문서 페이지 상단의 "원문:" 줄이 그대로 제공한다. */}
                <a href={siteHref("/docs")} data-testid="docs-hub-link" title="임베드·CLI·MCP·Intent 스키마 — 레포 마크다운 원문">문서</a>
                <span aria-hidden>·</span>
                <a href={`${BASE}/bench/`} data-testid="bench-link" title="쪽수·줄바꿈·캐럿을 한컴 저장값과 대조한 수치 + 재현 커맨드">충실도 벤치마크</a>
                <span aria-hidden>·</span>
                <a href={docHref("embed")}>임베드 가이드</a>
                <span aria-hidden>·</span>
                <a href={docHref("mcp")}>MCP</a>
                <span aria-hidden>·</span>
                <a href={docHref("why")}>왜 만들었나</a>
                <span aria-hidden>·</span>
                <a href="https://github.com/kwakseongjae/auto-hwp" target="_blank" rel="noreferrer">GitHub <ExternalLink size={12} /></a>
              </div>
            </div>
          </div>
        )}
        {busy && doc && <div className="lab-loading-overlay">{busy}</div>}
      </div>
      {/* 사이트 푸터 — 랜딩(사이트 화면)에만. 편집 모드는 앱 셸(100vh)이라 푸터가 붙을 자리가 없다. */}
      {!doc && <SiteFooter />}

      {/* 데모 AI 전송 동의 — 첫 요청 전 **1회**. 네이티브 confirm 을 대체하는 인앱 모달이라 메인스레드를
          멈추지 않고(엔진 워커·자동저장 계속), 문구는 lib/demoAiConsent.ts 원문 그대로다. */}
      <DemoAiConsentDialog
        open={consentParagraphs !== null}
        paragraphs={consentParagraphs ?? []}
        onAccept={() => settleConsent(true)}
        onDecline={() => settleConsent(false)}
      />
    </div>
  );
}
