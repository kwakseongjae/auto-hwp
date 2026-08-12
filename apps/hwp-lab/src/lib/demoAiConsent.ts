/** Public-demo disclosure shown before any document-derived context is read or transmitted.
 *
 *  This dialog is the ONLY transmission disclosure the demo shows: the always-on notice that used to sit
 *  above the chat panel was removed as visual noise, so its one piece of unique information — suggestions
 *  are previewed as cards and undoable — was folded in here, at the moment the user actually decides. */
/** 어디를 거쳐 나가는지는 배포 형태마다 다르다 — 문구가 실제 경로와 어긋나면 그 동의는 거짓 동의다.
 *  `worker` = 정적 데모(GitHub Pages) + 별도 Cloudflare Worker 프록시.
 *  `route`  = full Next 배포(Vercel)의 same-origin `/api/hwp-edit` — 중계자가 우리 서버 자신이다. */
export type DemoAiTransport = "worker" | "route";

const RELAY: Record<DemoAiTransport, string> = {
  worker: "오토한글의 Cloudflare Worker를 거쳐",
  route: "오토한글 데모 서버(Vercel)를 거쳐",
};

export function demoAiConsentMessage(transport: DemoAiTransport): string {
  return (
    "데모 AI 편집을 위해 입력한 지시와 현재 문서의 제목·본문 발췌·표 내용·선택 위치가 " +
    `${RELAY[transport]} OpenRouter(GPT-5.6 Luna)로 전송됩니다. 파일 원본 전체는 업로드하지 않습니다. ` +
    "오토한글(auto-hwp)은 원본 문서·전송된 문맥·AI 응답을 자체 데이터베이스나 스토리지에 저장·보유하지 않습니다.\n" +
    "받은 제안은 적용 전에 카드로 보여 주며, 적용해도 한 번에 되돌릴 수 있습니다.\n\n전송하고 AI 편집을 사용할까요?"
  );
}

/** 기본(정적 데모 = Worker 경유) 문구 — 기존 계약 그대로. */
export const DEMO_AI_CONSENT_MESSAGE = demoAiConsentMessage("worker");

/** 공개 데모는 첨부를 보내지 않는다. UI와 서버(maxAttachments=0)가 같은 정책을 쓰도록 네트워크
 *  호출 전에 판정하는 작은 순수 함수다. BYOK 경로에는 적용하지 않는다. */
export function demoAiAttachmentError(count: number): string | null {
  return count > 0
    ? "공개 데모 AI는 이미지·참조 문서 첨부를 전송하지 않습니다. 첨부 없이 다시 요청하거나 BYOK 프록시를 사용하세요."
    : null;
}

/** 인앱 모달용 — **같은 문구**를 문단 단위로 쪼갠다(빈 줄은 버린다). 문구는 위 한 곳에서만 나오므로
 *  다이얼로그가 프라이버시 계약과 어긋날 수 없다(모달로 바꾸면서 문구를 새로 쓰지 않는다는 규율의 구현). */
export function splitConsentMessage(message: string): string[] {
  return message
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function demoAiConsentParagraphs(transport: DemoAiTransport = "worker"): string[] {
  return splitConsentMessage(demoAiConsentMessage(transport));
}

// ── 동의의 영속(브라우저에 1회) ─────────────────────────────────────────────────────────────────────
// 예전 계약은 "마운트된 페이지 1회"였다 — 새로고침·자동 재개마다 같은 질문이 다시 떴고, 자동 재개가
// 생긴 뒤로는 사실상 매 세션 물었다. 사용자 결정(2026-07-30): **동의 자체를 1회만 기억**한다.
// ⚠️ 이것은 "다시 보지 않음" 체크가 아니다: 저장되는 것은 "동의했다"는 사실뿐이고, **거부는 아무
// 것도 기록하지 않는다** — 거부한 사용자는 다음 AI 요청 때 다시 질문을 받는다(조용한 승인 금지).
/** localStorage 키(오리진 단위). 값은 `"1"` 하나만 동의로 친다 — 나중에 JSON 으로 확장해도 옛 값이 산다. */
export const DEMO_AI_CONSENT_STORAGE_KEY = "auto-hwp:demo-ai-consent";
const GRANTED_VALUE = "1";

/** 테스트/SSR 대체 가능한 최소 저장소 계약(localStorage 의 부분집합). */
export interface DemoAiConsentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 브라우저 저장소. 사파리 프라이빗/쿠키 차단은 **접근 자체가 throw** 하므로 전부 감싼다 —
 *  저장소가 없으면 동의는 이 페이지 수명 동안만 유지되고(메모리 state), 다음 방문에 다시 묻는다. */
function defaultStorage(): DemoAiConsentStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function hasDemoAiConsent(storage: DemoAiConsentStorage | null = defaultStorage()): boolean {
  try {
    return storage?.getItem(DEMO_AI_CONSENT_STORAGE_KEY) === GRANTED_VALUE;
  } catch {
    return false;
  }
}

export function grantDemoAiConsent(storage: DemoAiConsentStorage | null = defaultStorage()): void {
  try {
    storage?.setItem(DEMO_AI_CONSENT_STORAGE_KEY, GRANTED_VALUE);
  } catch {
    /* 저장 불가(프라이빗 모드/쿼터) — 메모리 동의만 유지한다 */
  }
}

/** 동의 철회(QA·설정 UI 용). 지우면 다음 AI 요청에서 다시 묻는다. */
export function revokeDemoAiConsent(storage: DemoAiConsentStorage | null = defaultStorage()): void {
  try {
    storage?.removeItem(DEMO_AI_CONSENT_STORAGE_KEY);
  } catch {
    /* 위와 동일 */
  }
}

export interface DemoAiConsentState {
  granted: boolean;
}

/** 첫 AI 네트워크 호출 전 게이트.
 *
 *  `ask` 는 **인앱 모달**이다(네이티브 window.confirm 아님) — 그래서 비동기다. 이미 동의한 브라우저면
 *  묻지 않고 통과하고, 거부하면 상태·저장소 어느 쪽도 건드리지 않아 다음 요청에서 다시 묻는다. */
export async function ensureDemoAiConsent(
  state: DemoAiConsentState,
  ask: (message: string) => boolean | Promise<boolean>,
  transport: DemoAiTransport = "worker",
  storage: DemoAiConsentStorage | null = defaultStorage(),
): Promise<boolean> {
  if (state.granted) return true;
  if (hasDemoAiConsent(storage)) {
    state.granted = true;
    return true;
  }
  if (!(await ask(demoAiConsentMessage(transport)))) return false;
  state.granted = true;
  grantDemoAiConsent(storage);
  return true;
}
