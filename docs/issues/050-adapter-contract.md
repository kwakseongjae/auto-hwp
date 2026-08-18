# 050 — 모델 프로바이더 어댑터 계약 (GitHub #50)

- 상태: **부분** — OpenRouter PKCE v1은 GitHub **#56**. Copilot SDK·격리 Codex CLI는 우산 #50 잔류.
- 설계 공로: @SEUNGJU-PARK-KR (#50 제안)
- 이 파일은 파일 이슈 `050-image-insert-sdk.md`(이미지 삽입 SDK)와 **다른 문서**다. GitHub 이슈 번호 기준.

우산 이슈 #50의 세 프로바이더를 같은 capability 축으로 설계한다. 구현은 additive로 한 프로바이더씩 착지한다. 첫 슬라이스는 OpenRouter만.

## Capability 축

| 축 | OpenRouter (#56) | Copilot SDK (후속) | 격리 Codex CLI (후속) |
|---|---|---|---|
| 인증 | OAuth PKCE S256, 서버 커스터디 | SDK 번들 CLI OAuth | 앱 격리 `CODEX_HOME` 로그인 |
| 키/세션 보관 | 서버 프로세스 메모리만 (`globalThis` 고정) | SDK confined session | 격리 CLI 저장소 |
| 카탈로그 | `GET https://openrouter.ai/api/v1/models` | SDK model catalog | CLI 카탈로그 |
| 요청 경로 | 기존 `/api/hwp-edit` 하드닝 재사용 | SDK inference 어댑터 | structured exec |
| capability | `AUTO_HWP_LOCAL_MODELS=1` + 루프백 검사 이중 게이트 (additive — 프로바이더별 프로덕션 승격은 별도 이슈) | 동일 | 동일 |
| 상태 표시 | `connected` 불리언 + 키 출처(`session` \| `env`) 메타 | honest status | honest status |

축을 줄이거나 프로바이더 전용 비밀 필드를 브라우저에 노출하는 확장은 금지한다. 새 축은 additive로만 더한다.

## OpenRouter v1 경계 (#56)

- code→key 교환은 서버에서만. 키는 `globalThis` 고정 스토어에만 둔다.
- 브라우저는 `connected`와 `keySource`(`session` \| `env` \| `null`)만 본다. 키·계정 식별자는 브라우저 스토리지·URL·로그·분석·픽스처에 넣지 않는다.
- OAuth `code`가 콜백 URL을 경유하는 것은 정상이다. 노출 금지 경계는 **키**에만 적용한다.
- `resolveOpenRouterKey() = 세션 키 ?? env`. 둘 다 없으면 명시 에러. PKCE 연결 + env 부재 때 Anthropic/mock으로 침묵 폴백하지 않는다.
- 연결 후 카탈로그에서 고른 모델이 스트리밍·비스트리밍 `/api/hwp-edit` 양쪽에 반영된다. 명시 선택은 vision 모델로 조용히 바뀌지 않는다.
- 콜백 URL은 요청 오리진에서 도출한다. 포트 하드코딩 금지 (dev 3000 / e2e 3100 / launch 3110).
- `disconnect`는 서버 메모리를 지운다. OpenRouter 계정에 남은 키 revoke는 대시보드 수동 절차다.

## 이중 게이트

새 라우트(`/api/auth/openrouter/*`, `/models`)는 아래를 **모두** 통과해야 산다.

1. `AUTO_HWP_LOCAL_MODELS=1` (Vercel에 설정하지 않는다)
2. 요청 호스트가 루프백 (`localhost` / `127.0.0.1` / `::1`)

정적 빌드(`DEMO_STATIC=1` / `NEXT_PUBLIC_DEMO=1`)와 서버형 데모(`DEMO_AI_MODE=1`)는 플래그가 켜져 있어도 거부한다. `demo.ts`는 무접촉.

## 비범위 (우산 #50 잔류)

Models 내비 위치·375/768/1280 반응형 검수, Copilot/격리 Codex 어댑터, guided dual action, first-transmission disclosure, 취소·프로세스 정리, 공개 BYOK 프로덕션 승격.
