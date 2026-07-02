# 013 — P3: 헤드리스 서비스 컨테이너 (에이전트용 Shell B)

- 상태: **open**
- 우선순위: P3 (목표 2 전반부)
- 영역: 서비스 / 배포 / 보안
- 선행: **012 (hwp-session), 014 (입력 하드닝)** — 둘 다 완료 전 착수 금지
- 레드팀: **R1, R2, R3, R6, R12, R13** — 이 이슈의 수용 기준 대부분이 레드팀 항목이다

## 목표
`hwp-mcp`를 **stdio MCP + HTTP 겸용 헤드리스 바이너리 + Docker 이미지**로 패키징해,
business_plan_k(`services/hwp-converter` Python 서비스 대체)와 에르메스 에이전트가
`open → ai_edit(티키타카) → export_pdf` 를 표준 Intent(008)로 호출하게 한다.

**보안 모델을 먼저 읽어라.** 현 HTTP 서버(`hwp-mcp/src/server.rs`)의 안전성은
루프백 3중 가정(127.0.0.1 바인딩 + Host/Origin 루프백 allowlist + per-launch 토큰) 위에
있다. 이 이슈는 그 가정을 깨므로, **"네트워크 모드"를 별도 opt-in으로 신설**하고
기존 루프백 모드는 그대로 둔다.

## 컨텍스트
- stdio MCP·HTTP 서버·토큰 생성(`gen_token`, 0600 파일)은 이미 있다. 없는 것:
  네트워크 모드, 경로 감금, 멀티테넌시 전략, 컨테이너화, env 기반 LLM 키.
- business_plan_k 현황: `services/hwp-converter`(Python, Dockerfile, test_e2e.py 보유) —
  전환 시 이 테스트가 패리티 기준이 된다.
- `hwp-ai`의 BYOK는 keyring 기반 — 컨테이너엔 keyring이 없다(R6).

## 파일 지도
- `crates/hwp-mcp/src/main.rs`, `server.rs`, `lib.rs` — 모드 분기/경로 감금
- `crates/hwp-ai/src/lib.rs` — LlmProvider env-var 경로
- 신규: `Dockerfile.service`, `docs/SERVICE-DEPLOY.md`
- 패리티 기준: `~/Desktop/projects/business_plan_k/services/hwp-converter/test_e2e.py` (읽기 전용 참고)

## 구현 단계
1. **모드 분기**: `hwp-mcp --http`(기존 루프백, 무변경) / `hwp-mcp --http-network`(신규).
   네트워크 모드는:
   - `BIND_ADDR`(기본 0.0.0.0:8752)와 **`HWP_MCP_TOKEN` env 필수** — 없으면 기동 거부
     (fail-closed). per-launch 토큰 파일 방식은 루프백 모드 전용으로 유지.
   - Host 검사: 루프백 allowlist 대신 `ALLOWED_HOSTS` env(콤마 구분, 기본 없음=Host 검사
     스킵하되 문서에 "반드시 사설망/리버스프록시 뒤" 명시). Origin: 네트워크 모드에선
     브라우저 접근 자체가 비정상 → Origin 헤더 존재 시 **무조건 403**(CSRF 원천 차단).
   - 토큰 비교는 기존 `token_ok`(상수시간) 재사용.
2. **경로 감금(R3)**: env `HWP_WORKSPACE_ROOT`(네트워크 모드 필수). `open_document`/`save`의
   경로를 canonicalize 후 root 밖이면 명시적 에러. 심볼릭 링크 우회를 canonicalize가
   막는지 테스트로 고정. 루프백/데스크톱 모드는 무변경.
3. **멀티테넌시(R2) — v1은 회피 전략**: 코드로 세션 맵을 만들지 **말고**, "1 컨테이너
   = 1 동시 작업" 사이드카 모델을 문서로 계약한다(`docs/SERVICE-DEPLOY.md`).
   단, 위반을 감지는 해야 한다: 문서가 열린 상태에서 다른 `open_document`가 오면
   에러 대신 **명시 플래그(`force: true`)를 요구** — 에이전트 버그로 인한 조용한
   교차 오염을 막는다.
4. **LLM 키(R6)**: LlmProvider에 `ANTHROPIC_API_KEY` env 폴백 추가(keyring 미존재 환경).
   키는 로그에 절대 남기지 않는다(기존 토큰과 동일 규율).
5. **세션 위생(R13)**: undo 스택 상한(010과 동일 상수 재사용), `close_document` 툴
   추가(없으면), 문서 교체 시 렌더 캐시 해제 확인.
6. **컨테이너화**: `Dockerfile.service` — 멀티스테이지(cargo build → distroless/debian-slim),
   비루트 USER, `HWP_WORKSPACE_ROOT=/work` 볼륨, 메모리 상한은 배포 문서에 명시
   (`docker run --memory=1g --cpus=1`, R4의 마지막 방어선).
7. **business_plan_k 패리티(R12)**: hwp-converter의 test_e2e.py가 검증하는 계약
   (입력/출력 형식)을 읽고, 같은 픽스처로 새 서비스를 통과시키는 패리티 스크립트를
   `docs/SERVICE-DEPLOY.md`에 기록. **기존 Python 서비스는 삭제하지 말고**(사용자 자산)
   병행 운용→스위치는 사용자 결정 사항으로 남긴다.

## 검증
- 공통 스위트(§4.2) + `cargo test -p hwp-mcp`(신규 보안 술어 테스트 포함).
- 보안 시나리오 테스트(단위): ① 네트워크 모드 + 토큰 env 없음 → 기동 거부
  ② Origin 헤더 존재 → 403 ③ root 밖 경로/심링크 → 에러 ④ 문서 열림 중 재open → force 요구.
- 통합: `docker build -f Dockerfile.service` → 컨테이너에서
  `open_document → apply_content → export pdf` 3콜이 curl로 완주, PDF 바이트가 로컬 CLI
  `export-pdf` 출력과 동일.

## 수용 기준
- [ ] 루프백 모드 동작/보안 **무변경** (기존 테스트 그대로 통과)
- [ ] 네트워크 모드: env 토큰 fail-closed + Origin 무조건 403 + 경로 감금 + force 재open
- [ ] Docker 이미지 빌드·기동, 컨테이너 안 3콜(open/edit/export-pdf) 완주
- [ ] env 기반 LLM 키로 ai 편집이 컨테이너 안에서 동작
- [ ] `docs/SERVICE-DEPLOY.md`: 배포 모델(사이드카), 시크릿 주입, 리소스 상한, 패리티 절차
- [ ] business_plan_k 픽스처 패리티 확인 (Python 서비스는 보존)

## 함정
- **공인망 직노출은 어떤 경우에도 지원하지 않는다** — TLS 종료/인증 강화를 여기서
  구현하려 들지 마라(스코프 밖, 리버스 프록시의 일). 문서에 명시로 충분.
- sequential accept(단일 스레드)는 v1에서 유지 — "1 컨테이너 1 작업" 계약과 정합.
  성급한 스레드풀 도입은 R2를 코드 레벨로 다시 연다.
- HWP5(.hwp) 입력은 파싱만 되고 편집 round-trip은 HWPX 전용이다 — 서비스 응답에
  이 구분(view-only vs editable)을 명시 필드로 넣어 에이전트가 혼동하지 않게 하라.
