# autohwp-demo-ai-proxy — 정적 데모용 OpenRouter 프록시

정적 데모(GitHub Pages)는 서버가 없어 OpenRouter 키를 담을 데가 없다. 이 Cloudflare Worker가 키를
쥐고 **모델 고정 · 일일 한도 · CORS 잠금**으로 비용을 방어한다. 클라이언트는 키를 절대 보지 않는다.

- 모델: `openai/gpt-5.6-luna`($0.10/M 입력 · $0.60/M 출력). 모델·단가를 바꾸면 한도도 함께 재산정한다.
- 비용 방어선: `DAILY_CAP=2000`(전체) + `PER_IP_CAP=20`(1인). 유효한 요청만 차감한다.
  요청당 ~$0.0005(출력 상한 1024토큰을 다 써도 ~$0.001)이라 하루 최대 $1.0~2.1(<$5).
- 프롬프트는 워커가 `@auto-hwp/ai-protocol`로 조립(앱과 같은 계약) → 출력은 우리 JSON Intent로 제한.

> `RATELIMIT`은 Workers KV라 **eventual consistency**이며, 동시 요청에 대한 절대 비용 상한은 아니다.
> Cloudflare도 원자적 read-modify-write에는 Durable Objects를 권장한다. 현재 값은 소규모 공개 데모의
> 방어선이고, 절대 상한이 필요한 운영 전에는 Durable Object 카운터로 승격한다.

## 배포 (Cloudflare 무료 계정, 1회)

```bash
cd services/demo-ai-proxy
npm install
npx wrangler login                          # 브라우저로 Cloudflare 로그인(무료)

# 1) 일일 카운터용 KV 네임스페이스 생성 → 출력된 id를 wrangler.toml의 REPLACE_WITH_KV_ID에 붙여넣기
npx wrangler kv namespace create RATELIMIT

# 2) OpenRouter 키를 secret으로(레포/설정에 안 남는다)
npx wrangler secret put OPENROUTER_API_KEY  # 프롬프트에 sk-or-... 붙여넣기

# 3) wrangler.toml의 ALLOWED_ORIGIN을 실제 Pages 오리진으로 확인 후 배포
npm run deploy
```

배포가 끝나면 `https://autohwp-demo-ai.<계정>.workers.dev` 같은 URL이 나온다. 이 URL을 데모 빌드에
`NEXT_PUBLIC_DEMO_AI_URL`로 넣으면(아래) 정적 페이지의 AI 편집이 켜진다.

`npm run deploy`는 먼저 공유 `@auto-hwp/ai-protocol` dist를 다시 빌드한다. 직접
`npx wrangler deploy`만 실행하면 gitignore된 dist가 신선한 clone에서 없을 수 있으므로 쓰지 않는다.
상류 요청은 `provider.zdr=true`를 강제하며, ZDR endpoint가 없으면 개인정보 정책을 조용히 완화하지
않고 요청을 실패시킨다.

## 데모에 연결

```bash
# 로컬 미리보기
NEXT_PUBLIC_DEMO_AI_URL="https://autohwp-demo-ai.<계정>.workers.dev" npm --prefix apps/hwp-lab run dev:demo

# 정적 배포(Pages)
NEXT_PUBLIC_DEMO_AI_URL="https://autohwp-demo-ai.<계정>.workers.dev" node apps/hwp-lab/scripts/build-demo.mjs
```

`NEXT_PUBLIC_DEMO_AI_URL`이 비어 있으면 데모는 기존대로 "AI 편집은 로컬(BYOK)에서" 안내만 뜬다(회귀 없음).

## 한도 조정

`wrangler.toml`의 `DAILY_CAP`/`PER_IP_CAP`/`MAX_TOKENS`를 고치고 `npm run deploy`. 실사용 비용은
OpenRouter 대시보드에서 확인. 카운터는 UTC 자정에 자동 리셋(키에 날짜 + TTL 25h).

## 로그

```bash
npx wrangler tail   # 실시간 요청 로그(429 한도 도달 등)
```
