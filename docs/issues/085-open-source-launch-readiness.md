# 085 — 오픈소스 런칭 준비: agent-first truth gate + 신뢰·릴리스 레일

- 상태: **L0/L1 자동 게이트 green / fresh consumer green / L2·L3 수동 증거 open** (2026-08-12)
- 우선순위: P0 — 공식 오픈소스 런칭 선행
- 영역: README·사이트 문서·llms.txt·npm 릴리스·GitHub 커뮤니티·보안/개인정보·런칭 콘텐츠
- 비전: **로컬 코어가 본체이고, 사람과 에이전트가 같은 문서 계약으로 안전하게 연결되는 제품**

## 판정

제품과 라이브 데모는 공개 개발자 프리뷰 수준이고 L0/L1 자동 보완은 끝났지만, 공식 런칭은 아직
No-Go다. 에이전트가 따라가는 문서·README 복붙 예제·외부 기여/취약점 제보 레일은 닫혔고, 이제 남은
것은 소유자 문구 승인, 브랜치 보호, durable rate limit, fresh consumer 실증, 동일 커밋 릴리스와
라이브 후검증처럼 자동화만으로 통과시킬 수 없는 증거다. GitHub private vulnerability reporting,
Dependabot, secret scanning과 push protection은 2026-08-12에 실제 저장소에서 활성화했다.

출시 준비는 기능 수를 늘리는 작업이 아니다. 다음 퍼널의 각 경계를 **테스트 가능한 사실**로 만든다.

```
사람/에이전트 유입 → 정본 문서 발견 → 최소 통합 성공 → 로컬 처리 경계 확인
                 → 공개 검증 재현 → 안전한 기여/제보 → 버전 고정 릴리스
```

## 컨셉 불변식

1. **AI보다 로컬 문서 엔진이 먼저다.** AI 없는 열기·편집·내보내기가 기본 경로다.
2. **"파일이 안 나간다"를 과장하지 않는다.** 문서 처리와 선택적 AI 문맥 전송을 반드시 분리해 쓴다.
3. **에이전트도 Intent·프리뷰·승인·undo를 우회하지 않는다.** 숨은 자유 텍스트 패치 경로를 만들지 않는다.
4. **main이 아니라 공개 stable이 README의 기준이다.** 미발행 기능은 Unreleased/roadmap으로 표시한다.
5. **충실도는 형용사가 아니라 재현 커맨드로 말한다.** 지원하지 않는 포맷·폰트·객체는 먼저 고지한다.

메시지 정본은 `docs/launch/CONTENT-BRIEF.md`, 복사용 에이전트 프롬프트 정본은
`docs/launch/AGENT-PROMPT.md`, 현재 통과 상태는 `docs/launch/STATUS.json`이다.

## 작업 계획

### L0 — Truth sweep + 에이전트 첫 성공 (P0)

| 작업 | 산출물 | 완료 테스트 |
|---|---|---|
| 사이트 `llms.txt`를 레포 복사본에서 분리 | 문서 레지스트리 기반 절대 URL; 공용 AI 프록시 사실 교정 | 모든 링크 200, 필수 `/docs/llm·embed·mcp·self-host` 존재 |
| README AI 예제 교정 | `buildDocContext`·JSON 헤더·`.intents ?? []` 한국어/영어 동일 | 예제 계약 정적 게이트 + fresh consumer typecheck |
| 에이전트 CTA | README와 `/docs`에 단일 원문의 복사 버튼 | 새 프로젝트에서 문서 밖 API 추측 0, build+sample smoke |
| 공개 문서 truth sweep | `/75`, Adapter 34, stale 0.0.2 제거, 084 MCP 설명 갱신 | `scripts/verify-launch.sh --strict` 해당 항목 green |

### L1 — Trust surface (P0)

| 작업 | 산출물 | 완료 테스트 |
|---|---|---|
| 취약점 제보 | SECURITY.md + GitHub private reporting | 비공개 제보 경로 확인·공개 이슈로 비밀 유출 없음 |
| 개인정보 | `/privacy`, 푸터·AI 동의 링크, 처리/보유/철회/연락처 | AI 사용 전 링크 노출, 거부 시 전송 0, 소유자 문구 승인 |
| 사이트 헤더 | CSP·frame-ancestors·nosniff·referrer·permissions | 프로덕션 응답 헤더 + wasm/폰트/CDN/AI 정상 동작 |
| 외부 기여 | PR/bug/feature 템플릿, Code of Conduct, Support | 첫 기여자가 로컬 검증·픽스처 비공개 규율을 발견 가능 |
| PR 검증 | bounded `pull_request` CI + main 보호 | 외부 fork PR에서 필수 체크가 자동 실행되고 실패 시 merge 차단 |

### L2 — Release truth (P0)

1. 082 `.hwp` 재저장을 **포함 또는 제외**로 확정한다. 포함은 한컴/한컴독스 실물 수용과
   capability-first 문서 동기화가 모두 끝난 뒤에만 가능하다.
2. 0.0.4 이후 패키지 사용자 가시 변경을 CHANGELOG Unreleased에 전부 적는다. 이번 오픈소스 런칭만을
   위해 내용 변화 없는 npm 버전을 만들지 않으며, 다음 npm 발행은 네 패키지의 별도 lockstep 릴리스다.
3. 빈 디렉터리에서 React 단독 설치, Vite, Next production, Node/Bun engine, MCP 컨테이너를 시험한다.
4. 공개 npm 4종 `0.0.4`의 무결성과 fresh consumer 동작을 확인하고, 같은 저장소 커밋으로 Git tag →
   GitHub Release → autohwp.com을 내 URL/헤더/예제를 재검증한다.
5. `docs/launch/STATUS.json`에 버전·릴리스 커밋·수동 증거를 기록하고 마지막에만 `stage=ready`로 바꾼다.

### L3 — 런칭 콘텐츠 (P1, L0~L2 후)

- 핵심 3자산만 선행: 코어 퍼널 GIF, 임베드 코드+결과, 벤치 수치 카드. 083의 나머지는 후속이다.
- 한국어 정본 → 영어 요약 → 에이전트 연동 레시피 → 보안/충실도 글 순서로 준비한다.
- 모든 게시물은 데모보다 `내 앱에 붙이기`, AI보다 `로컬 코어`, 주장보다 `재현`을 먼저 보여 준다.
- 첫 CTA는 샘플, 둘째는 에이전트 프롬프트, 셋째는 기여 가이드다.

## 2026-08-12 구현 체크포인트

- `scripts/verify-launch.sh --automated`: **25/25 green**. 전체 보고는 **25/34 green, 9 red**이며
  이후 durable rate-limit 수동 게이트와 비용 상한 정적 검사를 추가했다. 현재 수치는 매 실행 보고를
  정본으로 보며 이 문서의 과거 숫자를 출시 판정에 사용하지 않는다.
- README 한·영문, 저장소/사이트 `llms.txt`, `/docs` 복사 CTA가
  `docs/launch/AGENT-PROMPT.md` 단일 정본으로 연결된다. AI 예제는 `buildDocContext`·JSON 헤더·
  `Intent[]` 계약을 그대로 사용한다.
- `/privacy`와 AI 동의 링크, CSP·nosniff·referrer·permissions·frame 헤더, SECURITY/Support/
  행동강령/PR·bug·feature 템플릿, bounded pull-request CI를 추가했다.
- 082는 한컴 네이티브 실물 증거 전까지 **런칭 제외**로 결정했다. 공개 문서는 `.hwp` 재저장을
  지원한다고 주장하지 않는다. 구현 코드는 `rhwp` feature 뒤 `experimental_guarded`로 존재하지만,
  `docs/HWP5-RESAVE-MANUAL-VALIDATION.md` 완료 뒤에만 공개 지원 포함을 재평가한다.
- 현재 변경 범위 검증: launch 단위 5건, 앱 typecheck, 앱 vitest 194건, Next production/static demo
  build, workflow `actionlint`, 브라우저 10개 URL·헤더·복사 UI·runtime error 0 모두 green.
- 직전 082+085 계획 시점의 `verify-local.sh --full`은 green이었다. 이번 사이트 보완 뒤 재실행은
  로컬 rustc가 변경하지 않은 `rhwp`/`hwp-viewer` clippy 컴파일에서 장시간 유휴 대기해 중단했으므로,
  공식 RC에서는 깨끗한 프로세스/러너로 full green 증거를 새로 남겨야 한다.

## 테스트 레일

```bash
# 게이트 코드 자체 단위 테스트 + 현재 부족분 보고(항상 실행 가능, 보고 모드는 exit 0)
scripts/verify-launch.sh --report

# 공식 출시 후보 게이트. 한 항목이라도 미완이면 non-zero
scripts/verify-launch.sh --strict

# 로컬 출시 표면 브라우저 검사(pre-live strict 선행)
scripts/verify-launch.sh --browser

# 배포 후 같은 검사를 프로덕션에 재실행
LAUNCH_BASE_URL=https://autohwp.com scripts/verify-launch.sh --browser

# 코드/패키지 변경을 동반한 출시 후보의 기존 전체 회귀
scripts/verify-local.sh --full
```

PR CI는 수동 출시 증거만 제외한 `verify-launch.sh --automated`를 실행한다. `--strict`는 준비 단계에서
의도적으로 red이며, RC에서 34항 전체가 green이 된 뒤에만 출시 판정으로 사용한다.

### 수동 증거 형식

`docs/launch/STATUS.json`의 각 수동 항목은 `status=pass`만으로 통과하지 않는다. 재현 로그·스크린샷·
GitHub 설정 URL·릴리스 URL 중 하나를 `evidence`에 기록해야 한다. 082는
`docs/HWP5-RESAVE-MANUAL-VALIDATION.md`의 결과가 증거다.

## 수용 기준

- [ ] `scripts/verify-launch.sh --strict` exit 0.
- [ ] `scripts/verify-local.sh --full` exit 0.
- [ ] 라이브 `llms.txt`의 모든 링크 200, 에이전트가 빈 Vite/Next 통합을 무인 완주.
- [ ] 문서 바이트는 AI 사용 여부와 무관하게 외부 서버로 전송되지 않고, AI 거부 시 네트워크 전송 0.
- [ ] npm stable 4종 lockstep·CHANGELOG Unreleased·Git tag·GitHub Release·사이트의 버전/커밋 관계가 정직하게 고정됨.
- [ ] 외부 fork PR이 자동 검사되고 취약점은 비공개로 제보 가능.
- [x] 082는 네이티브 실물 게이트 전까지 제외했고 공개 문서가 지원을 주장하지 않음.
- [ ] 한국어/영어 게시물과 README가 `CONTENT-BRIEF.md`의 금지 주장을 위반하지 않음.

## 병렬·파일 안전

- 현재 082 미커밋 레인은 `crates/hwp-hwp5-patch`, `hwp-mcp`, Cargo/NOTICE와 관련 정본을 소유한다.
- 085의 준비 산출물은 `docs/launch`, 이 파일, `scripts/launch-*`에 격리한다.
- README·llms·사이트·GitHub workflow의 실제 보완은 082 포함/제외 결정 뒤 별도 배치로 수행한다.
- 커밋·push·GitHub 설정·Vercel 배포는 사용자 지시 범위에서만 수행한다. npm publish는 별도 명시 승인 없이는 하지 않는다.

## 비범위

F2 공유 검토 세션 · HWP5 구조 편집 v2 · 신규 렌더 기능 · 계정/결제 · 083의 전체 7컷 완성.
