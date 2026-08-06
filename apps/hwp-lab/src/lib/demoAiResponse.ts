/** 데모 AI 응답의 **정직한 표시** 계약 (어제 미배선 잔여 — 이슈 1-(1) 후속).
 *
 *  배경: 프록시(Worker)와 라우트(Vercel)는 제안이 비었을 때 `reason`/`message` 를 additive 로 실어
 *  보낸다(truncated / no_valid_intents / upstream_error). 그런데 클라는 그걸 읽지 않아 채팅이 그냥
 *  "제안 0건"으로 조용히 끝났다 — 사용자는 왜 아무 일도 안 일어났는지 알 수 없었다.
 *
 *  이 모듈은 응답 payload 하나를 **화면에 그대로 쓸 결정**으로 바꾼다(순수 함수 — 단위 테스트 대상):
 *   - `error`   : 채팅에 오류 말풍선으로 띄울 문구(제안이 0건이라 보여 줄 카드가 없는 경우).
 *   - `warning` : 제안은 있지만 **부분만** 살아남은 경우의 경고(절단 구제 — 카드 위 타임라인에 적는다).
 *   - `intents` : 그대로 적용할 제안들.
 *
 *  원칙: 모르는 필드는 무시하고(계약 additive), reason 이 없으면 예전 그대로 동작한다(회귀 0). */

export type DemoAiReason = "truncated" | "no_valid_intents" | "upstream_error";

/** reason 코드별 폴백 문구 — 서버가 `message` 를 안 실어 보낸 구버전 프록시(배포 지연)에서도 침묵하지
 *  않도록. 서버 문구가 있으면 그쪽이 우선한다(서버가 salvaged 건수 등 더 구체적 정보를 안다). */
const FALLBACK: Record<DemoAiReason, string> = {
  truncated: "모델 응답이 길이 제한에 걸려 잘렸습니다. 한 번에 채울 항목 수를 줄여 다시 시도해 주세요.",
  no_valid_intents: "이 요청에서 적용할 편집을 찾지 못했습니다. 편집할 표/문단을 선택하고 지시를 더 구체적으로 적어 주세요.",
  upstream_error: "AI 제공자 호출이 실패했습니다. 잠시 후 다시 시도해 주세요.",
};

export interface DemoAiPayload {
  intents?: unknown;
  reason?: unknown;
  message?: unknown;
  error?: unknown;
}

export interface DemoAiOutcome<T> {
  intents: T[];
  /** 제안 0건 — 이 문구를 오류로 띄우고 끝낸다(빈손 침묵 금지). */
  error?: string;
  /** 제안은 있으나 부분 — 카드 위에 경고로 적는다(적용은 그대로 가능). */
  warning?: string;
}

function isReason(v: unknown): v is DemoAiReason {
  return v === "truncated" || v === "no_valid_intents" || v === "upstream_error";
}

function text(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** HTTP 200 응답 payload → 표시 결정. */
export function readDemoAiResponse<T>(payload: DemoAiPayload | null | undefined): DemoAiOutcome<T> {
  const intents = Array.isArray(payload?.intents) ? (payload!.intents as T[]) : [];
  const reason = isReason(payload?.reason) ? payload!.reason : undefined;
  const message = text(payload?.message) ?? (reason ? FALLBACK[reason] : undefined);
  if (!message) return { intents };
  // 제안이 하나도 없으면 보여 줄 카드가 없다 → 오류 말풍선으로 이유를 말한다.
  if (intents.length === 0) return { intents, error: message };
  // 부분 적용: 카드는 그대로 살리되 "전부가 아니다"를 반드시 표시한다(사용자가 나머지를 다시 요청할 수 있게).
  return { intents, warning: `${message} (일부만 반영된 제안입니다 — 나머지는 다시 요청해 주세요.)` };
}

/** HTTP 비-2xx 응답 → 사용자에게 띄울 문구. 429(한도)·503(미구성)은 서버 문구가 이미 완성된 안내라
 *  그대로 쓰고, 나머지는 "AI 데모 오류:" 접두로 정직하게 노출한다. */
export function demoAiHttpError(status: number, payload: DemoAiPayload | null | undefined): string {
  const detail = text(payload?.error) ?? text(payload?.message);
  if (status === 429 || status === 503) return detail ?? FALLBACK.upstream_error;
  if (isReason(payload?.reason) && payload!.reason === "upstream_error") {
    return detail ? `AI 제공자 호출이 실패했습니다 — ${detail}` : FALLBACK.upstream_error;
  }
  return `AI 데모 오류: ${detail ?? status}`;
}
