// server.mjs — 프레임워크 독립 AI 프록시 템플릿 (issue 063 블로커 5).
//
// 정적/비-Next 호스트(Vite/CRA/S3+CloudFront/…)는 Next route handler 가 없다. 이 얇은 Express 서버가
// 그 자리를 대신한다 — 로직은 apps/hwp-lab 의 참조 route.ts 와 **동일**하며, 프롬프트/펜스/검증/화이트리스트는
// 전부 @tf-hwp/ai-protocol 이 소유한다(서버·클라 단일 출처, 계약 드리프트 방지).
//
// R6(키 서버 전용): API 키와 LLM 클라이언트는 이 서버 모듈에만 존재한다. 클라이언트 번들엔 절대 넣지 않는다.
// 벤더 교체는 아래 liveIntents 의 `await import("@anthropic-ai/sdk")` 한 줄만 바꾸면 된다.
//
// 실행:  npm install && node server.mjs           # 키 없으면 mock, ANTHROPIC_API_KEY 있으면 live
//        curl localhost:8787/api/hwp-edit          # → {"mode":"mock"}
import express from "express";
import {
  buildSystemPrompt,
  buildUserMessage,
  validateRequest,
  validateResponse,
} from "@tf-hwp/ai-protocol";

const PORT = process.env.PORT || 8787;
// 교차 출처 임베드(정적 프론트가 다른 도메인)면 프론트 오리진을 지정한다. 기본 "*"는 개발 편의용 —
// 프로덕션에선 실제 오리진으로 좁혀라(자격증명은 어차피 서버에만 있으므로 키 유출 위험은 없다).
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// 결정적 mock — 참조 프록시(route.ts)의 mockIntents 축약본. 키 없이도 전체 플로우 완주.
function mockIntents(instruction, anchors) {
  const a = anchors[0];
  const text = String(instruction || "").trim();
  if (/삭제/.test(text) && a) return [{ intent: "DeleteBlock", section: a.section, index: a.block }];
  if (!a) return [];
  if (a.kind === "table" || a.kind === "range" || a.kind === "cell") {
    return [{ intent: "SetTableCell", section: a.section, index: a.block, row: a.rows?.[0] ?? 0, col: a.cols?.[0] ?? 0, text: "PoC ✔" }];
  }
  if (a.kind === "paragraph") return [{ intent: "SetParagraphText", section: a.section, block: a.block, text: text.slice(0, 60) || "PoC ✔" }];
  return [];
}

// 실 LLM — 서버 전용 동적 import(클라이언트 분석 경로에 절대 안 들어옴). 벤더 교체는 이 함수만.
async function liveIntents(apiKey, instruction, anchors, docContext) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 4096,
    system: buildSystemPrompt(),
    messages: [{ role: "user", content: buildUserMessage({ instruction, anchors, docContext }) }],
  });
  const text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  return validateResponse(text, { onDrop: (reason) => console.warn(`[hwp-edit] ${reason}`) });
}

app.get("/api/hwp-edit", (_req, res) => {
  res.json({ mode: process.env.ANTHROPIC_API_KEY ? "live" : "mock" });
});

app.post("/api/hwp-edit", async (req, res) => {
  const check = validateRequest(req.body);
  if (!check.ok) return res.status(400).json({ error: check.error });
  const { instruction, anchors, docContext } = check.value;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.json({ intents: mockIntents(instruction, anchors), mode: "mock" });
  try {
    const intents = await liveIntents(apiKey, instruction, anchors, docContext);
    res.json({ intents, mode: "live" });
  } catch (e) {
    console.error("[hwp-edit] live LLM 호출 실패:", e?.message || e);
    res.status(502).json({ error: `LLM 호출 실패: ${e?.message || e}` });
  }
});

app.listen(PORT, () => {
  console.log(`[hwp-edit] AI 프록시 → http://localhost:${PORT}/api/hwp-edit (${process.env.ANTHROPIC_API_KEY ? "live" : "mock"} 모드)`);
});
