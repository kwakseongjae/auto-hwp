# 셀프호스팅 가이드 — Docker · Node/Bun · 정적 wasm

> auto-hwp는 **공용 서버를 운영하지 않는다.** 브라우저에서 돌리든 서버에서 돌리든, 실행 주체는 언제나
> 당신의 인프라다. 이 문서는 "우리 인프라 안에서 auto-hwp를 돌리고 싶다"는 세 가지 방식을 실물로 다룬다.
>
> 이 문서의 모든 커맨드와 수치는 **실제로 실행해 확인**했다(2026-08-05, macOS arm64 / Docker 29.4.3 /
> Node v24.14.0 / Bun 1.3.8 / npm `@auto-hwp/engine@0.0.5`). 확인하지 못한 것은 그렇게 적었다.

---

## 0. 어느 것을 고를 것인가

| | **A. Docker 서비스** | **B. Node/Bun 엔진** | **C. 정적 wasm** |
|---|---|---|---|
| 실체 | `hwp-mcp` 컨테이너 (`--http-network`) | `@auto-hwp/engine` (wasm) | `@auto-hwp/engine` 파일 5개 |
| 어디서 도나 | 당신의 서버(사설망) | 당신의 서버 프로세스 | 사용자 브라우저 |
| 인터페이스 | JSON-RPC over HTTP (툴 15종) | JS API (`HwpDoc`) | JS API + React |
| 편집 | `apply_content`(AI 콘텐츠 JSON) | Intent JSON 전량 | Intent JSON 전량 |
| 언제 | 에이전트/백엔드가 파일 경로로 문서를 다룸 | 배치 변환·서버사이드 미리보기 | 파일이 기기를 안 떠나야 할 때 |
| 설치 부담 | Rust 빌드 1회(이미지 178 MB) | `npm i` 하나 | 정적 파일 서빙 |
| 문서 | 본문 §2 · [SERVICE-DEPLOY](SERVICE-DEPLOY.md) | 본문 §3 | 본문 §4 · [EMBED-GUIDE §2.2](EMBED-GUIDE.md) |

셋은 배타적이지 않다. §5의 조합 아키텍처가 실제 프로덕션 모양이다.

---

## 1. 공통 원칙

1. **우리가 호스팅하는 API는 없다.** 어떤 문서도 이 프로젝트로 전송되지 않는다. 유일한 예외는 호스트가
   직접 붙이는 **AI(BYOK) 경로**이며, 그건 당신의 서버 → 당신이 고른 LLM 벤더로 간다(§5).
2. **키는 서버 전용(R6).** npm 패키지 4종 중 어느 것도 API 키를 읽지 않는다.
3. **폰트는 번들하지 않는다(R8).** 호스트가 재배포 가능한(OFL) 서체 바이트를 주입한다 →
   [LICENSE-POLICY](LICENSE-POLICY.md).
4. **저장 포맷은 HWPX.** `.hwp`로 되돌려 저장하는 경로는 없다.

---

## 2. A. Docker — 헤드리스 서비스 컨테이너

### 2.1 이미 존재하는 것

레포 루트의 [`Dockerfile.service`](../Dockerfile.service)가 `hwp-mcp` 바이너리를 **네트워크 모드**
(`--http-network`)로 패키징한다. 새로 만들 것이 없다. 보안 계약의 정본은
[SERVICE-DEPLOY](SERVICE-DEPLOY.md)이고, 이 절은 그것을 **실행 절차로** 옮긴 것이다.

노출되는 툴은 15종(실측 `tools/list`):

```
open_document, get_context, apply_content, export_hwpx, extract_text, render_page, page_count,
undo, redo, propose_content, commit_proposal, find_text, replace_text, close_document, export_pdf
```

각 툴의 인자는 `tools/list` 응답의 `inputSchema`가 정본이다(런타임에서 직접 읽어라).

### 2.2 빌드

```bash
git clone --recurse-submodules https://github.com/kwakseongjae/auto-hwp && cd auto-hwp
docker build -f Dockerfile.service -t auto-hwp-service .
```

`--recurse-submodules`가 빠지면 `external/rhwp`가 없어 빌드가 실패한다(`.hwp` 열기가 그 크레이트다).

**실측 (macOS arm64, Docker 29.4.3, cold cache):**

| 항목 | 값 |
|---|---|
| 최종 이미지 | **178 MB** (`auto-hwp-service:latest`, linux/arm64) |
| `cargo build --release -p hwp-mcp --features "rhwp pdf"` 단계 | 70.3 s |
| 전체 빌드 (베이스 pull 포함) | 약 100 s |
| 실행 사용자 | 비-root `uid=999(hwp) gid=999(hwp)` |

> 이미지에는 컴파일러도, 소스도 들어가지 않는다(2-stage). PDF 한글 서체는 벤더링된 NanumGothic(OFL)이
> 컴파일된 첫 탐색 경로에 놓여 로컬 CLI와 같은 서체를 임베드한다.

### 2.3 기동 — fail-closed

```bash
mkdir -p work
docker run -d --name hwp-svc -p 8752:8752 \
  --memory=1g --cpus=1 \
  -e HWP_MCP_TOKEN="$(openssl rand -hex 32)" \
  -v "$PWD/work:/work" \
  auto-hwp-service
```

기동 로그(실측):

```
hwp-mcp http-network: bound 0.0.0.0:8752 — workspace /work — Host policy: ALLOWED_HOSTS unset (require a private net / reverse proxy)
```

| 환경변수 | 필수 | 의미 |
|---|---|---|
| `HWP_MCP_TOKEN` | **●** | Bearer 시크릿. **없으면 소켓을 열기 전에 종료(exit 2)** — 실측 확인 |
| `HWP_WORKSPACE_ROOT` | (이미지 고정 `/work`) | 모든 문서 경로가 이 밑으로 감금 |
| `BIND_ADDR` | | 기본 `0.0.0.0:8752` |
| `ALLOWED_HOSTS` | | 콤마 구분 Host allowlist. 비면 Host 검사 생략(→ **반드시** 사설망/프록시 뒤) |
| `ANTHROPIC_API_KEY` | | keyring 없는 컨테이너에서 auto-hwp 내부 LLM 경로용(선택). MCP 표면 자체는 LLM을 부르지 않는다 |

**볼륨 권한(실측):** Docker Desktop(macOS)에서는 bind mount가 자동 remap되어 그대로 쓰기가 된다
(`touch /work/.probe` → OK, 호스트에 `out.pdf` 생성 확인). **Linux 호스트에서는 remap이 없으므로**
마운트할 디렉토리를 미리 `chown 999:999 work` 하거나 `--user "$(id -u):$(id -g)"`로 실행해야 한다
(이 경우 `/work` 소유권을 맞춰 주는 것은 당신 몫이다). Linux 실검증은 하지 못했다.

### 2.4 3콜로 완주 — 열기 → 편집 → 내보내기

엔드포인트는 **`POST /mcp` 하나뿐이다**(GET은 405). 아래는 실제 응답이다.

```bash
TOKEN=<위에서 넣은 토큰>
docker cp corpus/hwpx/FormattingShowcase.hwpx hwp-svc:/work/doc.hwpx   # 볼륨을 쓰면 그냥 복사해도 된다

# ① 열기
curl -s localhost:8752/mcp -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"open_document","arguments":{"path":"/work/doc.hwpx"}}}'
# → "opened /work/doc.hwpx (HWPX (editable), 1 section(s))"

# ② 편집 (AI 콘텐츠 JSON — 스키마는 get_context가 돌려준다)
curl -s localhost:8752/mcp -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"apply_content","arguments":{"content":"{\"blocks\":[{\"type\":\"heading\",\"text\":\"서비스로 추가\"}]}"}}}'
# → "applied 1 block(s) → 1 op(s)"

# ③ 내보내기
curl -s localhost:8752/mcp -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"export_hwpx","arguments":{"path":"/work/out.hwpx"}}}'
# → "exported /work/out.hwpx (20392 bytes); editor-open-safety: OK"

curl -s localhost:8752/mcp -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"export_pdf","arguments":{"path":"/work/out.pdf"}}}'
# → "exported /work/out.pdf (20577 bytes, 1 page(s))"   ← %PDF-1.7 확인함
```

바이너리 `.hwp`도 같은 경로다(실측: `benchmarks/benchmark.hwp` → `HWP5 → HWPX (converted, editable)`,
`page_count` = **8**, `render_page` → `<svg …`, `export_pdf` → 93,841 B / 8쪽).

> `render_page`는 **편집 전 문서**에만 SVG를 준다. 편집을 적용한 뒤 호출하면 "편집된 문서는 HTML
> 미리보기로" 안내 문자열이 돌아온다 — 에이전트는 이 응답을 SVG로 착각하면 안 된다.

### 2.5 보안 게이트 — 실측 결과

`docs/SERVICE-DEPLOY.md §2`의 계약이 실제 컨테이너에서 그대로 나오는지 전부 확인했다.

| 시나리오 | 기대 | 실측 |
|---|---|---|
| 토큰 헤더 없음 | 401 | **401** ✔ |
| 잘못된 토큰 | 401 (상수시간 비교) | **401** ✔ |
| `Origin` 헤더 존재(값 무관) | 403 (CSRF 차단) | **403** ✔ |
| `GET /mcp` | 405 | **405** ✔ |
| 루트 밖 경로(`/etc/hosts`) | 툴 에러 | **`isError:true`** — `path "/etc/hosts" is outside the workspace root /work — refused` ✔ |
| 문서 열린 채 재open, `force` 없음 | 툴 에러 | **`isError:true`** — `pass "force": true to replace it` ✔ |
| `HWP_MCP_TOKEN` 미주입 | 기동 거부 | **exit 2** + `network mode refused to start: HWP_MCP_TOKEN env is required (fail-closed …)` ✔ |
| 프로세스 사용자 | 비-root | **uid=999(hwp)** ✔ |

### 2.6 운영 모델 — 1 컨테이너 = 1 동시 작업

멀티테넌시는 **코드가 아니라 배포로** 푼다. 서버는 단일 스레드 순차 수락이고 세션 맵이 없다.
동시에 여러 문서를 다루려면 **컨테이너를 여러 개** 띄운다(요청자별/작업별 사이드카).

```yaml
# docker-compose.yml — 작업 슬롯 2개(사이드카). 공인망 노출 금지: 리버스 프록시/사설망 뒤에만 둔다.
services:
  hwp-a:
    image: auto-hwp-service
    environment: { HWP_MCP_TOKEN: "${HWP_MCP_TOKEN}", ALLOWED_HOSTS: "hwp.svc.internal" }
    volumes: ["./work-a:/work"]
    mem_limit: 1g
    cpus: 1
    networks: [internal]
  hwp-b:
    image: auto-hwp-service
    environment: { HWP_MCP_TOKEN: "${HWP_MCP_TOKEN}", ALLOWED_HOSTS: "hwp.svc.internal" }
    volumes: ["./work-b:/work"]
    mem_limit: 1g
    cpus: 1
    networks: [internal]
networks:
  internal: { internal: true }
```

**헬스체크는 `POST /mcp`로 해야 한다** — GET은 405라 HTTP GET 프로브는 항상 실패로 뜬다:

```yaml
    healthcheck:
      test: ["CMD-SHELL", "curl -sf -X POST localhost:8752/mcp -H \"Authorization: Bearer $$HWP_MCP_TOKEN\" -d '{\"jsonrpc\":\"2.0\",\"id\":0,\"method\":\"tools/list\"}' >/dev/null"]
      interval: 30s
```

(이미지에 `curl`이 없다면 TCP 프로브를 쓰거나 오케스트레이터의 포트 체크를 써라 — 실측하지 않았다.)

### 2.7 지원하지 않는 것 (정직 고지)

- **공인 인터넷 직노출은 어떤 경우에도 지원하지 않는다.** TLS를 종료하지 않고 사용자 인증도 하지 않는다.
- 세션/테넌트 격리 없음 — 위 사이드카 모델이 유일한 답이다.
- 동시 요청 처리 없음(순차 수락).
- 컨테이너 `export_pdf` 산출이 브라우저/Node wasm 산출과 **바이트 동일하지는 않다**(같은 문서에서
  19,991 B vs 19,975 B — 폰트 탐색 경로가 다르다). 컨테이너 ↔ 로컬 CLI 대조 기준은
  [SERVICE-DEPLOY §8](SERVICE-DEPLOY.md)에 있다.

---

## 3. B. Node / Bun에서 엔진 돌리기

`@auto-hwp/engine`은 브라우저 전용이 아니다. **같은 wasm이 Node와 Bun에서 그대로 돈다** — 서버에서
문서를 열고 페이지 SVG를 만들어 브라우저(에디터/뷰어)로 넘기는 구성이 가능하다.

### 3.1 설치와 초기화

```bash
mkdir hwp-server && cd hwp-server && npm init -y && npm pkg set type=module
npm i @auto-hwp/engine
```

```js
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { initEngine, HwpDoc } from "@auto-hwp/engine";

const require = createRequire(import.meta.url);
// ⚠ 서버에서는 CDN 기본값(인자 없는 initEngine)에 기대지 마라. Node 24에서 동작하기는 하지만,
//   부팅이 외부 CDN 가용성에 묶인다. 패키지 안의 wasm '바이트'를 직접 넘기는 것이 정답이다.
const wasm = await readFile(require.resolve("@auto-hwp/engine/pkg/hwp_wasm_bg.wasm"));
await initEngine(wasm);
```

`initEngine`은 **모듈 전역에 한 번**만 인스턴스를 만든다(멱등). 프로세스 시작 시 한 번 호출하고,
요청마다 `HwpDoc.open` → … → `doc.free()`를 반복하는 것이 기본형이다.

### 3.2 열기 → 렌더 → export (실행 검증한 전체 스모크)

```js
const doc = HwpDoc.open(new Uint8Array(await readFile("문서.hwp")), "문서.hwp");

doc.pageCount();                    // 쪽수
doc.renderPageSvg(0);               // 페이지 SVG 문자열 (0-based)
doc.docProfile();                   // {title, sections, paragraph_count, table_count, headings, tables, excerpt}
doc.exportHtml();                   // 자체 완결 HTML 1개
doc.toHwpx();                       // Uint8Array — 고치지 않은 영역은 바이트 보존

doc.registerFont("Nanum Gothic", new Uint8Array(await readFile("NanumGothic-Regular.ttf")));
// ⚠ registerFont 는 재조판을 유발한다 → 쪽수/렌더를 여기서 다시 질의하라
const pdf = doc.exportPdf();        // Uint8Array. 폰트 미등록이면 {code:"font_missing"} 로 거부한다

// 편집도 서버에서 된다 (Intent JSON — docs/INTENT-SCHEMA.md)
doc.applyIntent({ intent_version: 0, intent: "SetParagraphRuns", section: 0, block: 1,
                  runs: [{ text: "서버사이드 편집", bold: true }] });
doc.undo();
doc.free();                         // 문서 스왑마다 명시 호출
```

**실측 결과 (Node v24.14.0, `@auto-hwp/engine@0.0.5`):**

| 문서 | 입력 | open | 전 페이지 SVG | PDF |
|---|---|---|---|---|
| `benchmarks/benchmark.hwp` | 67 KB | 14 ms | 8쪽 / 1 ms / 465 KB | 61 ms / 92 KB |
| `benchmarks/benchmark1.hwp` | 280 KB | 10 ms | 19쪽 / 3 ms / 2.4 MB | 164 ms / 365 KB |
| `corpus/hwp/k-water-rfp.hwp` | 2.7 MB | 67 ms | 31쪽 / 33 ms / 26 MB | 260 ms / 2.0 MB |

`initEngine(bytes)` 자체는 **23 ms**(로컬 바이트, 캐시 없음). 바이너리 `.hwp`와 `.hwpx` 모두 동작하며,
폰트 등록 후 쪽수가 바뀌는 것(19→18, 31→30)까지 그대로 재현된다.

### 3.3 Bun

**동작한다.** 위 스모크를 `bun smoke.mjs`로 그대로 돌려 **Node와 완전히 동일한 출력**을 얻었다
(Bun 1.3.8, macOS arm64). 별도 배선이 필요 없다 — `require.resolve` + `initEngine(bytes)` 그대로다.

확인하지 못한 것: Bun에서의 장시간 부하·메모리 거동, Deno, Cloudflare Workers/엣지 런타임.
엣지 런타임은 `fetch`+`instantiateStreaming` 대신 번들에 박힌 `WebAssembly.Module`을
`initEngineSync(module)`로 주입해야 하며 전용 진입점은 아직 없다(백로그).

### 3.4 패턴 — 서버가 렌더하고 브라우저가 본다

서버에서 만든 SVG를 그대로 브라우저에 넘기면, 브라우저는 wasm(7.7 MB)을 받지 않고도 문서를 볼 수 있다.
편집까지 하려면 브라우저에도 엔진이 필요하지만, **읽기 전용 미리보기/썸네일/OG 이미지**에는 이 구성이 옳다.

```js
// server.mjs — Express
import express from "express";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { initEngine, HwpDoc } from "@auto-hwp/engine";

const require = createRequire(import.meta.url);
await initEngine(await readFile(require.resolve("@auto-hwp/engine/pkg/hwp_wasm_bg.wasm")));

const app = express();
app.get("/doc/:id/page/:n.svg", async (req, res) => {
  // pathFor 는 당신의 저장소 조회 함수다 — 반드시 경로를 감금하라(사용자 입력으로 경로를 만들지 말 것).
  const doc = HwpDoc.open(new Uint8Array(await readFile(pathFor(req.params.id))), req.params.id);
  try {
    const n = Number(req.params.n);
    if (!Number.isInteger(n) || n < 0 || n >= doc.pageCount()) return res.sendStatus(404);
    res.type("image/svg+xml").send(doc.renderPageSvg(n));   // ← 클라이언트에서 다시 sanitize 한다
  } finally {
    doc.free();                                             // 반드시 finally 로
  }
});
app.listen(8080);
```

```html
<!-- 클라이언트: 받은 SVG는 여전히 '문서에서 나온 신뢰불가 문자열'이다 -->
<script type="module">
  import { sanitizeSvg } from "https://cdn.jsdelivr.net/npm/@auto-hwp/engine@0.0.5/index.js";
  const svg = await (await fetch("/doc/abc/page/0.svg")).text();
  document.querySelector("#page").innerHTML = sanitizeSvg(svg);   // raw innerHTML 금지
</script>
```

> ⚠ **Node의 `sanitizeSvg`는 약하다.** 브라우저에서는 `DOMParser`로 파싱해 정리하지만, **Node에는
> `DOMParser`가 없어 정규식 폴백**으로 떨어진다(실측 확인). 서버에서 한 번 걸렀더라도 **삽입하는
> 쪽(브라우저)에서 반드시 다시** `sanitizeSvg`를 통과시켜라. React `<HwpPageView>`는 이미 그렇게 한다.

편집까지 브라우저에서 하려면 §4(정적 wasm) + [EMBED-GUIDE](EMBED-GUIDE.md)로 간다.

### 3.5 서버 운영 주의 (실측 기반)

1. **wasm 선형 메모리는 `free()`로 OS에 반환되지 않는다.** 측정: init 후 79 MB rss → 문서 3개 동시
   오픈 126 MB → 전부 `free()` 후 128 MB → 2.7 MB 문서를 30회 열고 닫은 뒤 **224 MB**. `free()`는
   *다음 문서가 재사용할 힙*을 돌려주는 것이지 프로세스 메모리를 줄이지 않는다.
   → 장수 프로세스라면 **N건마다 워커 프로세스를 재활용**하고, 컨테이너에 메모리 상한을 걸어라.
2. **한 프로세스에 인스턴스는 하나.** `HwpDoc` 여러 개를 동시에 열 수는 있다(실측: 3개 동시 오픈 후
   각각 정상 렌더). 하지만 **wasm trap 하나가 인스턴스 전체를 오염**시켜 살아 있는 모든 핸들이 죽는다.
   `isTrapError(e)` → `resetEngine()` → 문서 재오픈이 회복 절차다. 격리가 필요하면 프로세스를 나눠라.
3. **`@auto-hwp/engine/worker-client`는 Node에서 못 쓴다.** 실측: `Worker is not defined`
   (브라우저 `Worker` API 전용이며 `node:worker_threads`와 다르다). 서버 병렬화는
   `node:cluster`/`child_process`/컨테이너 복제로 한다.
4. **엔진은 동기 API다.** `renderPageSvg`/`exportPdf`는 이벤트 루프를 블로킹한다. 위 실측(31쪽 26 MB
   SVG = 33 ms, PDF 260 ms)이 그대로 응답 지연이 되므로, 큰 문서는 워커 프로세스로 밀어라.
5. **입력을 신뢰하지 마라.** 업로드 파일은 크기 상한을 걸고, 열기는 try/catch로 감싸라. 암호가 걸린
   `.hwp`는 정직하게 거부되고(에러), 손상 파일도 구조화된 `{code}` 에러로 온다.

---

## 4. C. wasm을 우리 도메인에서 직접 서빙 (오프라인·폐쇄망·엄격 CSP)

기본값은 자기 버전으로 pin된 jsDelivr지만, **CDN은 기본값일 뿐 요구사항이 아니다.** 파일 5개를
**상대구조 그대로** 정적 루트에 복사하고 명시 URL을 주면 외부 네트워크가 전혀 필요 없다.

```
public/hwp/hwp_wasm_bg.wasm       ← node_modules/@auto-hwp/engine/pkg/hwp_wasm_bg.wasm  (런타임에 명시 URL로 fetch)
public/hwp/worker.js              ← .../worker.js         (모듈 워커 엔트리)
public/hwp/index.js               ← .../index.js          (worker.js 가 import)
public/hwp/cdn.js                 ← .../cdn.js            (index.js 가 import — 빠지면 워커가 404로 즉사)
public/hwp/pkg/hwp_wasm.js        ← .../pkg/hwp_wasm.js   (wasm-bindgen 글루 — 반드시 pkg/ 아래)
```

wasm 바이너리의 위치는 자유다(어댑터에 준 URL로 fetch한다). 자유롭지 **않은** 것은
`worker.js → ./index.js → ./cdn.js` + `./pkg/hwp_wasm.js`의 **상대 import 체인**이다.

```tsx
const adapter = new WasmAdapter(
  new URL("/hwp/hwp_wasm_bg.wasm", location.origin),
  { worker: { url: new URL("/hwp/worker.js", location.origin) } },
);
```

절차·CSP·Vite 설정의 정본은 [EMBED-GUIDE §2.2 / §4](EMBED-GUIDE.md), 복사 스크립트 실물은
[`examples/vite-embed/scripts/copy-assets.mjs`](../examples/vite-embed/scripts/copy-assets.mjs).
자기 빌드를 서빙한다면 진행률 분모를 `expectedBytes`로 직접 줘라(참고: 발행본 wasm은 비압축
**7,725,936 B**).

---

## 5. 조합 아키텍처 — 셋을 함께 쓸 때

읽기·편집은 브라우저에서(파일이 기기를 안 떠난다), 배치·에이전트 작업은 서버에서, LLM은 당신의
프록시를 통해서. **키는 프록시에만, 문서 원본은 어디로도 나가지 않는다.**

```
  ┌─ 사용자 브라우저 ────────────────────────────────────────────────┐
  │                                                                  │
  │   React 앱 <HwpWorkspace/>                                       │
  │     @auto-hwp/react → @auto-hwp/engine (wasm)                    │
  │     @auto-hwp/ai-protocol · buildDocContext                      │
  │                                                                  │
  │   ★ 파일 원본은 이 상자를 떠나지 않는다 (열기·조판·렌더·적용)    │
  │                                                                  │
  └──┬─────────────────────────┬──────────────────────────▲──────────┘
     │                         │                          │
     │ ① wasm 로드             │ ② 지시문 + docContext    │ ③ 검증된 Intent[]
     │   (§4 자기 호스팅       │   (POST · 파일 원본은    │   (프록시가 통과시킨
     │    또는 jsDelivr)       │    보내지 않는다)        │    편집 명령만)
     │                         │                          │
═════╪═════════════════════════╪══════════════════════════╪═══════════  당신의 인프라
     │                         │                          │             (사설망)
  ┌──▼────────────────┐     ┌──▼──────────────────────────┴──────────┐
  │ 정적 호스팅       │     │ AI 프록시 (BYOK)                       │
  │  /hwp/* 파일 5개  │     │  examples/ai-proxy-express             │
  │  (§4)             │     │  @auto-hwp/ai-protocol                 │
  └───────────────────┘     │   buildSystemPrompt                    │
                            │   validateRequest / validateResponse   │
                            │  ★ API 키는 오직 여기에 존재한다       │
                            └────────────────┬───────────────────────┘
                                             │ ④ 프롬프트 + 문서 컨텍스트
                                             │    (원본 파일은 보내지 않는다)
                                    ┌────────▼─────────────┐
                                    │ LLM 벤더 (당신 선택) │
                                    │  Anthropic / OpenAI  │
                                    │  OpenRouter / 자체   │
                                    └──────────────────────┘

  ┌─ 브라우저를 거치지 않는 경로 (배치 · 에이전트) ──────────────────────────┐
  │                                                                          │
  │  배치 스크립트 / 워커  ──라이브러리 호출──▶  Node·Bun 엔진 (§3)          │
  │                                             open → renderPageSvg → PDF   │
  │                                                                          │
  │  외부 에이전트 / 서비스 ──JSON-RPC over HTTP──▶  Docker hwp-mcp (§2)     │
  │  (파일 경로로 문서 처리)                        POST /mcp · Bearer       │
  │                                                /work 경로 감금           │
  │                                                1 컨테이너 = 1 동시 작업  │
  │                                                                          │
  └──────────────────────────────────────────────────────────────────────────┘
```

- **① 정적 wasm**(§4)은 선택이다 — 생략하면 jsDelivr 기본값이 쓰인다.
- **② 지시문 + `docContext`** 만 프록시로 간다. `buildDocContext`가 문서 컨텍스트를
  `<document-content>` 펜스로 감싸 "데이터이지 지시가 아님"을 고정한다(R5). **파일 원본은 보내지 않는다.**
- **③ 프록시는 검증된 Intent 배열만** 돌려준다(`validateResponse` 화이트리스트). 브라우저 엔진이 적용한다.
- **④ 벤더 호출은 프록시 안에서만** 일어난다. API 키는 이 상자를 벗어나지 않고, 벤더 교체는
  `examples/ai-proxy-express`의 `import(...)` 한 줄이다. 이 경로가 **문서 컨텍스트가 외부로 나가는
  유일한 지점**이므로 사용자 동의 없이 켜지 마라.
- 배치/에이전트 경로는 브라우저를 거치지 않는다: Node 엔진(§3)을 라이브러리로 부르거나,
  Docker 서비스(§2)에 JSON-RPC를 던진다.

---

## 6. 검증 커맨드 모음 (복붙)

```bash
# ── A. Docker ─────────────────────────────────────────────────────────────
docker build -f Dockerfile.service -t auto-hwp-service .
docker images auto-hwp-service --format "{{.Size}}"                  # 실측: 178MB
docker run --rm auto-hwp-service; echo "exit=$?"                     # 실측: exit=2 (토큰 없음 → 기동 거부)

TOKEN=$(openssl rand -hex 32)
docker run -d --name hwp-svc -p 8752:8752 --memory=1g --cpus=1 -e HWP_MCP_TOKEN="$TOKEN" auto-hwp-service
docker cp corpus/hwpx/FormattingShowcase.hwpx hwp-svc:/work/doc.hwpx
curl -s -o /dev/null -w "no-token=%{http_code}\n"  localhost:8752/mcp -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
curl -s -o /dev/null -w "origin=%{http_code}\n"    localhost:8752/mcp -H "Authorization: Bearer $TOKEN" -H 'Origin: http://x' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
curl -s -o /dev/null -w "get=%{http_code}\n"       localhost:8752/mcp -H "Authorization: Bearer $TOKEN"
# 기대: no-token=401  origin=403  get=405
curl -s localhost:8752/mcp -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"open_document","arguments":{"path":"/work/doc.hwpx"}}}'
docker rm -f hwp-svc

# ── B. Node / Bun ─────────────────────────────────────────────────────────
mkdir -p /tmp/hwp-smoke && cd /tmp/hwp-smoke && npm init -y >/dev/null && npm pkg set type=module
npm i @auto-hwp/engine
cat > smoke.mjs <<'EOF'
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { initEngine, HwpDoc, ENGINE_VERSION } from "@auto-hwp/engine";
const require = createRequire(import.meta.url);
await initEngine(await readFile(require.resolve("@auto-hwp/engine/pkg/hwp_wasm_bg.wasm")));
const doc = HwpDoc.open(new Uint8Array(await readFile(process.argv[2])), "smoke");
console.log(ENGINE_VERSION, "| pages", doc.pageCount(), "| svg0", doc.renderPageSvg(0).length, "B");
try { doc.exportPdf(); } catch (e) { console.log("no-font guard →", e.code); }
doc.free();
EOF
node smoke.mjs /경로/문서.hwpx     # 기대: 0.0.5 | pages N | svg0 >0 B  /  no-font guard → font_missing
bun  smoke.mjs /경로/문서.hwpx     # 동일 출력

# ── C. 정적 wasm ──────────────────────────────────────────────────────────
cd examples/vite-embed && npm install && npm run test:e2e   # 업로드→8쪽 렌더→셀 마킹→mock 편집→undo
```

---

## 7. 관련 문서

- LLM 에이전트용 통합 가이드 → [LLM-GUIDE](LLM-GUIDE.md) (진입 인덱스: 루트 [`llms.txt`](../llms.txt))
- 웹 임베드 정본 → [EMBED-GUIDE](EMBED-GUIDE.md)
- 컨테이너 보안 계약 전문 → [SERVICE-DEPLOY](SERVICE-DEPLOY.md)
- 편집 명령 스펙 → [INTENT-SCHEMA](INTENT-SCHEMA.md)
- 로컬 MCP(stdio) → [MCP-GUIDE](MCP-GUIDE.md) · 터미널 → [CLI-GUIDE](CLI-GUIDE.md)
- 서체 재배포 정책 → [LICENSE-POLICY](LICENSE-POLICY.md)
