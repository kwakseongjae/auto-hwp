# Vercel Production preflight — 2026-08-12

- Project: `kwakseongjaes-projects/auto-hwp` (`.vercel/project.json`의 `projectName=auto-hwp`)
- Read-only command: `vercel env ls production`
- 확인된 Production 변수 이름: `OPENROUTER_API_KEY`, `DEMO_SITE_URL`, `NEXT_PUBLIC_DEMO_AI`,
  `DEMO_AI_MODE`
- 누락: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
- 비밀 값은 조회·기록하지 않았다.

따라서 현재 프로덕션의 전역 400회/IP 20회 카운터는 새 코드가 배포돼도 서버 인스턴스별 메모리
best-effort로만 동작하며, 공식 런칭의 비용 절대 상한으로 인정할 수 없다. `durable_rate_limit`은
`pending`을 유지한다.

## 닫는 절차

1. 소유자가 선택한 Upstash Redis의 REST URL/token을 Vercel **Production** 환경에 등록한다.
2. 동일 RC SHA를 배포한다.
3. `curl -fsS https://autohwp.com/api/hwp-edit | jq '.rate_limit'`가 아래 값을 보고하는지 확인한다.
4. `LAUNCH_BASE_URL=https://autohwp.com scripts/verify-launch.sh --browser`의 durable 테스트가
   실제 배포에서 통과한 로그를 이 문서에 추가한다.

```json
{
  "store": "upstash",
  "durable": true,
  "store_configured": true,
  "daily_cap": 400,
  "per_ip_cap": 20,
  "configuration_valid": true
}
```

저장소 생성은 계정·과금 선택이 필요한 외부 변경이므로 임의로 수행하지 않았다.
