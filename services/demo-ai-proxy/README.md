# autohwp-demo-ai-proxy — 정적 데모용 OpenRouter 프록시

정적 데모(GitHub Pages)는 서버가 없어 OpenRouter 키를 담을 데가 없다. 이 Cloudflare Worker가 키를
쥐고 **모델 고정 · 일일 한도 · CORS 잠금**으로 하루 비용을 강제한다. 클라이언트는 키를 절대 보지 않는다.

- 모델: `google/gemini-3.5-flash-lite`(입력 $0.30 / 출력 $2.50 per M). 입력 위주 작업이라 요청당 ~$0.002.
- 비용 상한: `DAILY_CAP`(전체) + `PER_IP_CAP`(1인) 로 강제. 2000건 ≈ $4/일. 예산에 맞춰 조절.
- 프롬프트는 워커가 `@auto-hwp/ai-protocol`로 조립(앱과 같은 계약) → 출력은 우리 JSON Intent로 제한.

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
npx wrangler deploy
```

배포가 끝나면 `https://autohwp-demo-ai.<계정>.workers.dev` 같은 URL이 나온다. 이 URL을 데모 빌드에
`NEXT_PUBLIC_DEMO_AI_URL`로 넣으면(아래) 정적 페이지의 AI 편집이 켜진다.

## 데모에 연결

```bash
# 로컬 미리보기
NEXT_PUBLIC_DEMO_AI_URL="https://autohwp-demo-ai.<계정>.workers.dev" npm --prefix apps/hwp-lab run dev:demo

# 정적 배포(Pages)
NEXT_PUBLIC_DEMO_AI_URL="https://autohwp-demo-ai.<계정>.workers.dev" node apps/hwp-lab/scripts/build-demo.mjs
```

`NEXT_PUBLIC_DEMO_AI_URL`이 비어 있으면 데모는 기존대로 "AI 편집은 로컬(BYOK)에서" 안내만 뜬다(회귀 없음).

## 한도 조정

`wrangler.toml`의 `DAILY_CAP`/`PER_IP_CAP`/`MAX_TOKENS`를 고치고 `npx wrangler deploy`. 실사용 비용은
OpenRouter 대시보드에서 확인. 카운터는 UTC 자정에 자동 리셋(키에 날짜 + TTL 25h).

## 로그

```bash
npx wrangler tail   # 실시간 요청 로그(429 한도 도달 등)
```
