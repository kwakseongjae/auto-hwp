# 공개 베타 durable rate-limit 유예 결정 — 2026-08-12

- 소유자 결정: 이번 공개 베타와 라이브 smoke에서는 Upstash 연결을 우선순위에서 제외한다.
- 현재 동작: 데모 AI의 일일/IP 제한은 서버리스 인스턴스별 메모리 카운터다.
- 정확한 위험: 인스턴스가 늘거나 재시작되면 카운터가 공유·지속되지 않으므로 전역 비용 상한을 보장하지 않는다.
- 처리 원칙: `durable_rate_limit` 게이트는 pass로 가장하지 않고 pending으로 유지한다.
- 런칭 범위: 저장소·랜딩·문서 기여 퍼널을 공개 베타로 배포하고 라이브 smoke까지 수행한다.
- 후속 완료 조건: Vercel Production에 Upstash URL/token을 등록한 뒤 공개 probe가 `store=upstash`,
  `durable=true`, `configuration_valid=true`를 반환해야 한다.

이 결정은 보안·개인정보 경계를 낮추지 않는다. 문서 원본은 문서 처리 서버로 업로드되지 않으며,
AI 동의 뒤 전송되는 문맥과 응답도 오토한글(auto-hwp) 자체 DB/스토리지에 저장·보유하지 않는다.
