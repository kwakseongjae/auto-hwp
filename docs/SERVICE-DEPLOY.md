# tf-hwp 헤드리스 서비스 배포 (issue 013)

`hwp-mcp`를 **네트워크 서비스**로 배포하는 방법과 그 **보안 계약**을 정의한다. 대상 사용자는
business_plan_k(현 `services/hwp-converter` Python 서비스)와 에르메스 에이전트로, 컨테이너에
`open_document → apply_content → export_{hwpx,pdf}` 를 표준 Intent(008)로 호출한다.

> ⚠️ **공인망 직노출은 어떤 경우에도 지원하지 않는다.** 이 서비스는 TLS를 종료하지 않고,
> 사용자 인증을 강화하지 않는다(스코프 밖 — 리버스 프록시의 몫). 반드시 **사설망 / 리버스
> 프록시 뒤**에 둔다.

---

## 1. 두 개의 HTTP 모드 — 루프백 vs 네트워크

`hwp-mcp` 바이너리는 세 가지 트랜스포트를 가진다. **013은 세 번째(네트워크)만 신설했고,
앞의 둘은 코드·동작·테스트가 전부 무변경이다.**

| 모드 | 실행 | 바인딩 | 토큰 | 용도 |
|------|------|--------|------|------|
| stdio | `hwp-mcp` | — | — | `claude mcp add --transport stdio` |
| 루프백 HTTP | `hwp-mcp --http [--port N]` | `127.0.0.1` | per-launch 0600 cred 파일 | 데스크톱/로컬 에이전트 |
| **네트워크(신설)** | `hwp-mcp --http-network` | `BIND_ADDR`(기본 `0.0.0.0:8752`) | **`HWP_MCP_TOKEN` env(필수)** | 컨테이너 서비스 |

네트워크 모드는 별도 함수(`network::run`)·별도 요청 경로(`server::process_request_network`)로
구현되어 루프백 경로(`server::process_request`)를 전혀 건드리지 않는다.

## 2. 네트워크 모드 보안 모델 (R1·R2·R3)

네트워크 모드는 **fail-closed**다. 아래 중 하나라도 어긋나면 기동을 거부하거나 요청을 막는다.

1. **토큰 필수 (fail-closed) — R1.** `HWP_MCP_TOKEN` env가 없으면(또는 비면) 서버는 소켓을
   바인딩하기 전에 종료(exit 2)한다. 루프백 모드의 per-launch cred 파일 폴백은 네트워크
   모드에 **없다** — 시크릿 부재가 "열린 서버"를 의미해서는 안 된다. 토큰 비교는 상수시간
   (`subtle::ConstantTimeEq`)이며, 없는 토큰도 잘못된 토큰과 똑같이 401이다.
2. **Origin 무조건 403 — R1(CSRF).** 네트워크 API는 브라우저가 호출할 일이 없다. `Origin`
   헤더가 **존재하기만 하면** 값과 무관하게 403이다(루프백의 allowlist보다 **엄격**하다).
3. **Host allowlist — R1.** `ALLOWED_HOSTS`(콤마 구분)가 설정되면 Host(포트 제거 후)가 그
   목록에 있어야 한다. 비어 있으면 Host 검사를 건너뛰되(위 경고대로 반드시 사설망/프록시
   뒤), 설정 시엔 그대로 강제한다.
4. **경로 감금 — R3.** `HWP_WORKSPACE_ROOT` env가 **필수**이며 기동 시 canonicalize된다.
   `open_document`(입력·존재 필수)·`export_hwpx`/`export_pdf`(출력) 경로는 canonicalize
   후 루트 밖이면 **명시적 툴 에러**다. canonicalize가 심볼릭 링크를 먼저 해석하므로,
   루트 안에 만든 심링크가 루트 밖을 가리켜도 우회되지 않는다.
5. **재open force 가드 — R2.** "1 컨테이너 = 1 동시 작업" 모델이므로, 문서가 열린 상태에서
   다른 `open_document`가 오면 조용히 교체하지 않고 **`"force": true`를 요구**한다(에이전트
   버그로 인한 교차 오염 방지). `close_document`로 명시적으로 닫을 수도 있다.
6. **sequential accept.** v1은 단일 스레드 순차 수락을 유지한다("1 컨테이너 1 작업" 계약과
   정합 — 성급한 스레드풀은 R2를 코드 레벨로 다시 연다).
7. **로그에 토큰/키 없음.** `NetworkConfig`는 `Debug`에서도 토큰을 `<redacted>`로 가린다.

이 규율의 단위 테스트: `cargo test -p hwp-mcp`
(`network::tests`, `server::tests` — 시나리오 ①토큰 없음→기동 거부 ②Origin→403
③루트 밖/심링크→에러 ④재open→force 요구).

## 3. 배포 모델 — 사이드카 (R2 회피 전략)

멀티테넌시는 **코드가 아니라 배포로** 푼다. 세션 맵을 만들지 않는다.

- **1 컨테이너 = 1 동시 작업.** 요청자(business_plan_k / 에이전트)마다, 혹은 작업 단위마다
  컨테이너를 **사이드카로 하나씩** 띄운다. 여러 문서를 동시에 다루려면 컨테이너를 여러 개
  띄운다(스케줄러/오케스트레이터가 담당).
- 위반 감지는 코드가 한다: §2.5 재open force 가드.

## 4. 시크릿 주입 & 리소스 상한

```bash
# 이미지 빌드
docker build -f Dockerfile.service -t tf-hwp-service .

# 강한 랜덤 토큰 생성 + 주입, 메모리/CPU 상한(R4 최후 방어선), 작업 볼륨 마운트
docker run --rm -p 8752:8752 \
  --memory=1g --cpus=1 \
  -e HWP_MCP_TOKEN="$(openssl rand -hex 32)" \
  -v "$PWD/work:/work" \
  tf-hwp-service
```

- **`HWP_MCP_TOKEN`** — 필수. 없으면 컨테이너가 즉시 종료(fail-closed).
- **`HWP_WORKSPACE_ROOT`** — 이미지에서 `/work`로 고정(볼륨). 모든 문서 경로가 이 밑으로 감금.
- **`ALLOWED_HOSTS`** — 선택. 리버스 프록시의 내부 호스트명을 넣는다(예: `hwp.svc.internal`).
- **`ANTHROPIC_API_KEY`** (R6) — 선택. tf-hwp가 자체 LLM 호출(hwp-ai BYOK)을 하는 경로에서
  keyring이 없는 컨테이너를 위해 **env가 우선**으로 해석된다(`hwp-ai::secret::resolve_anthropic_key`
  — env → keyring 순, 이미 구현·단위테스트됨). `docker run -e ANTHROPIC_API_KEY=...`로 주입하며
  **로그에 남지 않는다**. (MCP 표면 자체는 사전 저작된 content JSON을 받으므로 LLM을 직접
  호출하지 않는다 — 이 키는 CLI `ai-edit`/`ai-fill` 등 tf-hwp 내부 LLM 경로용이다.)
- **`--memory=1g --cpus=1`** — R4의 마지막 방어선. 입력 하드닝(014)이 파싱 단계에서 대부분을
  막지만, 컨테이너 상한이 최종 안전망이다.

## 5. HWP5(.hwp) vs HWPX — view-only vs editable

`open_document` 응답의 format 문자열이 편집 가능성을 명시한다: `HWPX (editable)` /
`HWP5 → HWPX (converted, editable)` / `HWP3 (view-only)` / `PDF (view-mostly)`. 에이전트는
이 구분으로 편집 round-trip 가능 여부(HWPX 전용)를 판단한다.

## 6. 통합 검증 — 컨테이너 안 3콜 (curl)

`open_document → apply_content → export_hwpx`(그리고 `export_pdf`)를 curl로 완주시키고,
출력 바이트를 로컬 CLI와 대조한다. 재현 스크립트는 §8.

```bash
TOKEN=$(openssl rand -hex 32)
docker run -d --name hwp-svc -p 8752:8752 --memory=1g --cpus=1 \
  -e HWP_MCP_TOKEN="$TOKEN" tf-hwp-service
docker cp corpus/hwpx/FormattingShowcase.hwpx hwp-svc:/work/doc.hwpx

curl -s localhost:8752/mcp -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"open_document","arguments":{"path":"/work/doc.hwpx"}}}'
curl -s localhost:8752/mcp -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"apply_content","arguments":{"content":"{\"blocks\":[{\"type\":\"heading\",\"text\":\"서비스로 추가\"}]}"}}}'
curl -s localhost:8752/mcp -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"export_hwpx","arguments":{"path":"/work/out.hwpx"}}}'
docker cp hwp-svc:/work/out.hwpx /tmp/container-out.hwpx
```

### 보안 시나리오 (컨테이너 대상 curl)
- **토큰 없음** → `HTTP/1.1 401`. (env 미주입 시 컨테이너 자체가 기동 거부.)
- **Origin 존재** (`-H 'Origin: http://x'`) → `HTTP/1.1 403`.
- **루트 밖 경로** (`"path":"/etc/hosts"`) → 툴 에러(`isError:true`, "outside the workspace root").
- **재open force 없음** → 툴 에러(`isError:true`, "force").

## 7. business_plan_k 패리티 (R12)

기존 Python 서비스(`services/hwp-converter`)는 **삭제하지 않고 병행 운용**한다(사용자 자산).
스위치 여부는 사용자 결정. 패리티 기준은 그쪽 `test_e2e.py`의 구조 보존 계약이다:
`/convert`가 HWP→HTML로 표/셀/병합을 보존하는지(`stats` = tables/cells/merged_cell_attrs/text_chars).

tf-hwp의 등가 경로는 `open_document`(.hwp를 rhwp로 lift) → HTML 투영(CLI `export-html`)이다.
아래 스크립트는 **business_plan_k 픽스처를 읽기만** 하고(수정/삭제 없음), 같은 임계값을 통과함을
보인다:

```bash
BP=~/Desktop/projects/business_plan_k/services/hwp-converter/fixtures
for f in growth-package-form initial-package-form; do
  cargo run -q -p tf-hwp-cli --features "shaper rhwp" -- export-html "$BP/$f.hwp" -o "/tmp/$f.html"
  tables=$(grep -o "<table" /tmp/$f.html | wc -l)
  cells=$(grep -o "<td" /tmp/$f.html | wc -l)
  merged=$(grep -oE "colspan|rowspan" /tmp/$f.html | wc -l)
  echo "$f: tables=$tables cells=$cells merged=$merged"
done
```

**측정 결과 (2026-07-03, 이 브랜치):**

| fixture | test_e2e 임계값 | tf-hwp export-html | 판정 |
|---------|----------------|--------------------|------|
| growth-package-form.hwp  | tables≥30, cells≥300, merged>0, text>1000 | tables=38, cells=361, merged=62, text_chars=104021 | ✅ PASS |
| initial-package-form.hwp | tables≥20, cells≥200, merged>0, text>1000 | tables=30, cells=220, merged=40, text_chars=95085  | ✅ PASS |

즉 tf-hwp 엔진이 pyhwp 기반 서비스와 동등하게 표/셀/병합 구조를 보존한다.

## 8. 바이트 대조 (로컬 CLI vs 컨테이너)

- **HWPX(결정적, 폰트 무관)**: 컨테이너 `open→apply_content→export_hwpx` 결과는 로컬
  `tf-hwp ai-apply <doc> <content.json> -o out.hwpx`(둘 다 `serialize_hwpx`)와 **바이트 동일**해야
  한다. 이것이 패리티의 하드 기준이다.
- **PDF(폰트 discover 의존)**: 컨테이너 `export_pdf`는 로컬 `tf-hwp export-pdf`(둘 다
  `hwp_session::emit_pdf`)와 같은 문서·같은 폰트일 때 동일하다. 컨테이너는 벤더링된
  NanumGothic(OFL)을 컴파일된 첫 discover 경로에 두어 로컬과 같은 폰트를 임베드한다. 폰트
  discover 환경이 다르면(예: 로컬 macOS 시스템 폰트) 바이트가 달라질 수 있으며, 그 경우
  사유를 함께 보고한다(krilla 서브셋 결정성 + title 메타데이터는 문서 stem으로 일치시킴).
