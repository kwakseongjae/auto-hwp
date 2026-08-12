# 오픈소스 런칭 RC 체크리스트

목표는 “라이브에서 한 번 눌러보기”가 아니라, 라이브 smoke를 시작할 때 이미 되돌릴 수 있는 단일 RC와
재현 증거가 준비돼 있게 하는 것이다. 정본 상태는 `STATUS.json`, 자동 판정은
`scripts/verify-launch.sh`다.

## 릴리스 정책

- 공개 npm stable은 `@auto-hwp/{engine,editor-core,ai-protocol,react}@0.0.4`다.
- main에는 0.0.4 이후 package 소스 변경이 있으므로 이를 0.0.4의 기능처럼 쓰지 않고
  `CHANGELOG.md`의 `Unreleased`에 기록한다.
- 오픈소스 런칭은 저장소 태그 후보 `oss-launch-2026.08.12`와 GitHub Release, autohwp.com 배포를
  하나의 `release_commit`에 고정한다. 내용 변화 없는 npm 재발행은 하지 않는다.
- 다음 npm 발행은 네 패키지를 새 버전으로 lockstep 발행하는 별도 릴리스다.
- Vercel Git 자동 빌드는 모든 브랜치에서 끈다. preview와 production 모두 Rust·wasm을 먼저 만든
  `vercel-deploy.yml`의 수동 `--prebuilt` 경로만 사용한다.
- 082의 구현 코드는 `hwp-mcp`의 `rhwp` feature 뒤에 `experimental_guarded` 상태로 존재하지만, 한/글·
  한컴독스 수용 전에는 공개 지원 범위와 런칭 메시지에서 제외한다. 소스 존재를 지원 약속으로 해석하지 않는다.

## 현재 게이트와 닫는 방법

| 게이트 | 담당 | 현재 | 닫는 정확한 방법 | 증거 |
|---|---|---:|---|---|
| GitHub 보안 설정 | 작업 에이전트 | 완료 | private reporting·Dependabot·secret scanning·push protection 재조회 | `evidence/2026-08-12-github-security.md` |
| 의존성 보안 | 작업 에이전트 | 완료 | npm/pnpm 경고 해소+감사 0, `quinn-proto` 0.11.15 패치, glib 비도달 위험 수용. PR #4 병합 뒤 REST API open 0 | `evidence/2026-08-12-dependency-security.md` |
| 개인정보 문구 | 소유자 | 대기 | 실제 운영과 `/privacy`를 대조한 뒤 `OWNER-APPROVAL.md`에 승인자/시각 기록 | 승인된 `OWNER-APPROVAL.md` |
| 런칭 문구 | 소유자 | 대기 | CONTENT-BRIEF의 허용/금지 주장과 README 한·영문 승인 | 승인된 `OWNER-APPROVAL.md` |
| durable rate limit | 소유자(저장소 생성)→작업 에이전트(연결 검증) | 차단 | Vercel Production에 `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`을 등록하고 RC 배포 | `evidence/2026-08-12-vercel-preflight.md` + 아래 probe 로그 |
| fresh consumer | 작업 에이전트 | 완료 | 빈 temp에서 Vite·Next production build, Node·Bun 실제 8쪽 렌더, Vite 브라우저 편집/undo | `evidence/2026-08-12-fresh-consumer.md` |
| PR CI | 작업 에이전트 | 완료 | RC PR에서 `build-test`, `licenses` 실제 성공 | [run 31527277416](https://github.com/kwakseongjae/auto-hwp/actions/runs/31527277416) |
| main 보호 | 작업 에이전트 | 완료 | 실제 PR check context 이름으로 strict checks+PR 필수+admin 적용, API 재조회 | `evidence/2026-08-12-branch-protection.md` |
| tag/Release/site | 작업 에이전트 | 대기 | 보호된 main의 RC SHA를 태그·Release·Vercel workflow `--ref`에 동일 사용 | tag/Release/deploy URL+SHA |
| 라이브 smoke | 작업 에이전트 | 최종 대기 | 배포 뒤 `LAUNCH_BASE_URL=https://autohwp.com scripts/verify-launch.sh --browser`와 실제 문서 퍼널 | live evidence |

## 현재 안전 정지점

제품·STATUS 검증 기준점 `a7e3a85`에서 자동 게이트는 29/29였다. 2026-08-12 소유자가 개인정보·런칭
문구를 승인해 현재 기대치는 전체 report 35/40, 라이브 smoke와 최종 ready를 제외한
`node scripts/launch-readiness.mjs --pre-live --strict` 35/38이다. 아래 3개만 남는다.

1. Vercel Production durable Upstash 연결
2. 그 뒤 확정할 단일 `release_commit`
3. 같은 SHA의 tag/GitHub Release

1은 계정·운영 정책·비용 선택이 필요한 외부 조건이다. 이 조건이 닫히기 전에 2~3이나 production
배포를 선행하지 않는다. 3까지 닫힌 뒤 pre-live strict를 다시 통과시키고 그 다음에만 종합 라이브
smoke를 한다.

## durable rate-limit 판정

비밀 값은 증거에 기록하지 않는다. 배포 뒤 다음 공개 probe 결과만 저장한다.

```bash
curl -fsS https://autohwp.com/api/hwp-edit | jq '.rate_limit'
```

통과값은 아래와 같다.

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

`store=memory`이면 기능은 동작해도 서버리스 인스턴스 수만큼 예산이 새므로 런칭 P0 실패다.

## 실행 순서

1. `scripts/verify-launch.sh --automated`
2. `scripts/verify-launch.sh --consumer`
3. 네 package의 `npm pack --dry-run`과 `scripts/verify-local.sh --full`
4. RC 커밋→PR→실제 PR checks 통과
5. main protection 활성화→API 재검증→PR merge
6. 소유자 승인과 Upstash 확인
7. RC SHA 고정→tag/GitHub Release/Vercel을 같은 SHA에서 실행
8. `scripts/launch-readiness.mjs --pre-live --strict` 통과
9. 그 다음에만 종합 라이브 smoke를 실행하고, 성공 후 `stage=ready`

실패한 항목은 “나중에”라고만 남기지 않는다. `STATUS.json`은 pending을 유지하고 이 표에 담당·다음
명령·필요 증거를 남긴다.
