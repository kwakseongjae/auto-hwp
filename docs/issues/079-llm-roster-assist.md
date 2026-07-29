# 079 — 073 자유 텍스트 명단 LLM 보조와 프록시 비용·개인정보 하드닝

- 상태: **design-complete / implementation-open** (2026-07-28)
- 우선순위: **P2 (선택 보조; 결정론 코어 비블로커)**
- 선행: 073의 fill-map/검증/재개봉 검수 계약 유지

## 제품 경계

LLM은 자유 텍스트를 `{필드: 값}` record 후보로 구조화하는 **선택적 전처리기**다. 문서를 직접 편집하거나
검증을 우회하지 않는다. 실패하면 현재 CSV/TSV/JSON/키:값 입력으로 즉시 돌아간다.

## 구조화 계약

- fill-map의 key로 요청마다 JSON Schema를 만든다.
- `additionalProperties:false`, 정확한 required key, 값은 `string | null`, record 수 상한을 강제한다.
- OpenRouter 요청은 [`response_format: json_schema`](https://openrouter.ai/docs/guides/features/structured-outputs),
  `strict:true`, [`provider.require_parameters:true`](https://openrouter.ai/docs/guides/routing/provider-selection)를
  사용한다. 모델 이름만 보고 지원을 가정하지 않는다.
- 명단은 줄 번호를 붙여 DATA fence 안에 넣고, 각 record는 근거 줄 번호를 함께 반환한다.
- 로컬 schema/type/필수/정규식 검증과 사용자 검수 표를 통과한 값만 기존 결정론 generator에 넘긴다.
- raw model JSON을 Intent나 op로 변환하지 않는다.

## 개인정보와 실패 UX

- 이름·전화·사업자번호 등 PII 전송 전 명시 동의를 받고, BYOK/로컬 결정론 경로를 함께 제공한다.
- OpenRouter에는 `provider.zdr:true`를 요구한다. 해당 모델의 ZDR endpoint가 없으면 조용히 완화하지 않고
  사용 불가로 처리한다.
- prompt injection 문구는 명단 데이터로만 취급하고, 필드 추가·규칙 변경 요구는 거부한다.
- timeout/schema mismatch/부분 record는 원문과 함께 행별 오류로 보여 주고 자동 채움하지 않는다.

## 비용 방어

2026-07-28 즉시 수정으로 데모 프록시는 JSON·계약 검증을 일일 카운터 차감보다 먼저 수행한다.
다만 현재 Cloudflare Workers KV 카운터는 공식 문서상
[`eventually-consistent`](https://developers.cloudflare.com/kv/concepts/how-kv-works/)이며 원자적
read-modify-write가 아니다. “절대 $5 상한”이라고 부르지 않는다. 운영 전에는 전역/사용자 카운터를
Durable Object로 옮기고, 모델 호출 성공/실패별 과금 정책과 reserve/refund를 한 transaction으로 정의한다.

## 수용 기준

- [ ] 5개 fill-map × 정상/누락/추가키/프롬프트주입/혼합문장 fixture를 고정한다.
- [ ] 스키마 밖 key·근거 없는 값·레코드 상한 초과가 generator에 도달하지 않는다.
- [ ] 사용자 확인 한 번으로 후보 수정/제외 후 기존 재개봉 검증으로 이어진다.
- [ ] ZDR 불가, 모델 실패, quota 초과가 결정론 입력 경로를 막지 않는다.
- [ ] 유효성 실패는 quota를 차감하지 않고, 동시성 테스트가 Durable Object의 절대 일일 상한을 증명한다.

