# autohwp-demo-ai-proxy — 정적 데모용 OpenRouter 프록시

정적 데모(GitHub Pages)는 서버가 없어 OpenRouter 키를 담을 데가 없다. 이 Cloudflare Worker가 키를
쥐고 **모델 고정 · 일일 한도 · CORS 잠금**으로 비용을 방어한다. 클라이언트는 키를 절대 보지 않는다.

- 모델: `openai/gpt-5.6-luna`. 모델·프롬프트를 바꾸면 실제 usage를 다시 측정한다.
- 비용 방어선: `DAILY_CAP=400`(전체) + `PER_IP_CAP=20`(1인). 유효한 요청만 차감한다.
  2026-08-08 실전 6,082-token 문맥은 약 $0.0124/요청이 청구돼 400회가 약 **$4.96/일**이다
  (과금 재시도 전). 표면 단가만으로 더 낮게 추정하지 않는다.
- 프롬프트는 워커가 `@auto-hwp/ai-protocol`로 조립(앱과 같은 계약) → 출력은 우리 JSON Intent로 제한.
- 출력 예산 `MAX_TOKENS=2048` + `REASONING_EFFORT=low`: gpt-5.6-luna는 **추론 토큰이 `max_tokens`에
  함께 계산**돼, 1024에서는 다중 셀 채움(SetTableCell 약 10건) JSON이 잘리고 전량 드롭됐다(이슈 1-(1)).

## 응답 계약 (사유 코드 — additive)

`200 {"intents": [...]}`가 기본이고, 제안이 비었거나 일부만 살아남았을 때만 필드가 **추가로** 붙는다
(모르는 필드를 무시하는 기존 클라이언트는 그대로 동작 — 불변식 7):

| `reason` | 언제 | `intents` |
|---|---|---|
| `truncated` | 상류가 `finish_reason: "length"` — 응답 JSON이 배열 중간에서 잘림 | 온전히 닫힌 Intent만 구제(반쪽은 폐기) |
| `no_valid_intents` | 모델이 답했으나 화이트리스트/구조 검증을 통과한 게 없음(또는 진짜 변경 없음) | `[]` |
| `upstream_error` | 프로바이더 호출 자체 실패 — 이때만 HTTP 502 + `error` | 없음 |

`message`는 바로 노출 가능한 한국어 문장(폴백)이다. 자체 i18n이 있는 호스트는 `reason`으로 분기하라.

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

⚠ `MAX_TOKENS`는 코드 상한(`MAX_TOKENS_CEILING`)이기도 하다 — 예산을 다시 계산하지 않고는 못 올린다
(상한 초과 설정은 부팅 시 503으로 **실패시킨다**). `REASONING_EFFORT`는 `minimal|low|medium|high`
중 하나이며, 빈 문자열이면 상류에 필드를 보내지 않는다(즉시 롤백 스위치).

## 로그

```bash
npx wrangler tail   # 실시간 요청 로그(429 한도 도달 등)
```

빈/절단 응답에는 워커가 `{"event":"empty_or_truncated", finish_reason, completion_tokens, intents,
salvaged, drops}` 한 줄을 `console.warn`으로 남긴다(**요청 본문은 로그하지 않는다** — 카운트/사유만).
`wrangler tail`은 워커가 배포된 **그 Cloudflare 계정**으로 로그인돼 있어야 한다. 다른 계정으로
로그인돼 있으면 `Authentication error [code: 10000]` 또는 `This Worker does not exist on your
account [code: 10007]`가 뜨고 로그를 전혀 볼 수 없다.
