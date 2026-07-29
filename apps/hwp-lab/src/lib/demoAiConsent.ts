/** Public-demo disclosure shown before any document-derived context is read or transmitted. */
export const DEMO_AI_CONSENT_MESSAGE =
  "데모 AI 편집을 위해 입력한 지시와 현재 문서의 제목·본문 발췌·표 내용·선택 위치가 " +
  "오토한글의 Cloudflare Worker를 거쳐 OpenRouter(GLM 5.2)로 전송됩니다. 파일 원본 전체는 업로드하지 않습니다.\n\n전송하고 AI 편집을 사용할까요?";

export interface DemoAiConsentState {
  granted: boolean;
}

/** Ask once per mounted page. A rejection leaves state untouched, so a later explicit AI action asks
 *  again; an acceptance suppresses only subsequent prompts in the same page lifetime. */
export function ensureDemoAiConsent(
  state: DemoAiConsentState,
  confirm: (message: string) => boolean,
): boolean {
  if (state.granted) return true;
  if (!confirm(DEMO_AI_CONSENT_MESSAGE)) return false;
  state.granted = true;
  return true;
}
