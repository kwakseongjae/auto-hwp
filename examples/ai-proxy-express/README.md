# auto-hwp AI 프록시 — Express 템플릿 (issue 063)

정적/비-Next 호스트(Vite·CRA·S3+CloudFront 등)는 Next route handler 가 없다. 이 얇은 Express 서버가
채팅 바이브편집의 서버 자리(`/api/hwp-edit`)를 대신한다. 로직은 `apps/hwp-lab` 의 참조
[`route.ts`](../../apps/hwp-lab/src/app/api/hwp-edit/route.ts) 와 **동일**하며, 프롬프트·R5 펜스·검증·
화이트리스트는 전부 [`@auto-hwp/ai-protocol`](../../packages/ai-protocol) 이 소유한다(서버·클라 단일 출처).

## R6 — 키는 서버 전용

API 키/LLM 클라이언트는 `server.mjs` 에만 존재한다. 클라이언트 번들엔 절대 넣지 않는다. 벤더 교체는
`liveIntents` 의 `await import("@anthropic-ai/sdk")` 한 줄만 바꾸면 된다(OpenAI/Gemini/자체 게이트웨이 등).

## 실행

```bash
npm install
node server.mjs                       # 키 없으면 mock 모드
ANTHROPIC_API_KEY=sk-... node server.mjs   # 실 LLM 모드

# 확인
curl localhost:8787/api/hwp-edit                                   # → {"mode":"mock"}
curl -X POST localhost:8787/api/hwp-edit -H 'content-type: application/json' \
  -d '{"instruction":"이 칸을 채워줘","anchors":[{"kind":"cell","section":0,"block":1,"rows":[0,0],"cols":[0,0]}],"docContext":"<document-content>x</document-content>"}'
# → {"intents":[{"intent":"SetTableCell",...,"text":"PoC ✔"}],"mode":"mock"}
```

## 프론트엔드 배선

`examples/vite-embed` 의 `onAiRequest` 로컬 mock 을, 이 프록시로 POST 하는 fetch 로 교체한다:

```ts
const onAiRequest = async (instruction, anchors, ctx) => {
  const res = await fetch("http://localhost:8787/api/hwp-edit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      instruction,
      anchors,
      docContext: buildDocContext(ctx, anchors), // @auto-hwp/ai-protocol (R5 펜스)
    }),
  });
  const { intents } = await res.json();
  return intents ?? [];
};
```

## 외부 호스트로 복사할 때

- `package.json` 의 `"@auto-hwp/ai-protocol": "file:../../packages/ai-protocol"` 를 **`"^0.0.1"`**(npm 발행본)으로 바꾼다.
- 교차 출처면 `ALLOW_ORIGIN` 을 프론트 오리진으로 좁힌다(기본 `*`는 개발 편의용).
- 서버리스(Vercel/Cloudflare/Lambda)면 `app.post` 핸들러 본문을 그 런타임의 함수 시그니처로 옮기면 된다 —
  검증/프롬프트/벤더 호출 로직은 그대로 재사용.
