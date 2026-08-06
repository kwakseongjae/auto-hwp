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
    `${RELAY[transport]} OpenRouter(GPT-5.6 Luna)로 전송됩니다. 파일 원본 전체는 업로드하지 않습니다.\n` +
    "받은 제안은 적용 전에 카드로 보여 주며, 적용해도 한 번에 되돌릴 수 있습니다.\n\n전송하고 AI 편집을 사용할까요?"
  );
}

/** 기본(정적 데모 = Worker 경유) 문구 — 기존 계약 그대로. */
export const DEMO_AI_CONSENT_MESSAGE = demoAiConsentMessage("worker");

export interface DemoAiConsentState {
  granted: boolean;
}

/** Ask once per mounted page. A rejection leaves state untouched, so a later explicit AI action asks
 *  again; an acceptance suppresses only subsequent prompts in the same page lifetime. */
export function ensureDemoAiConsent(
  state: DemoAiConsentState,
  confirm: (message: string) => boolean,
  transport: DemoAiTransport = "worker",
): boolean {
  if (state.granted) return true;
  if (!confirm(demoAiConsentMessage(transport))) return false;
  state.granted = true;
  return true;
}
