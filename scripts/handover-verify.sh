#!/usr/bin/env bash
# handover-verify.sh — docs/INTEGRATION-HANDOVER.md 의 §2(패키지 준비/빌드 체인)와
# §3(Next.js 통합)의 커맨드 시퀀스를 **그대로** 재현하는 실행 가능한 계약이다(issue 029).
#
# 하는 일: 클린화(dist/pkg/.next 제거) → 빌드 체인(engine wasm → editor-core → ai-protocol
# → react) → lab 기동(next dev) → curl / 200 + /api/hwp-edit mock 200 → 종료.
# 문서와 이 스크립트의 커맨드가 어긋나면(드리프트) 인수인계가 깨진 것이다 — 둘을 함께 고쳐라.
#
# 사용:  bash scripts/handover-verify.sh
# 성공 시 exit 0, 어느 단계든 실패하면 즉시 비-0 으로 종료한다.
set -euo pipefail

# cargo/wasm-bindgen 을 PATH 에 올린다(문서 §2 전제).
export PATH="$HOME/.cargo/bin:$PATH"

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"
echo "== repo: $REPO_ROOT"

# ── 전제 도구 확인 (문서 §2) ─────────────────────────────────────────────────
need() { command -v "$1" >/dev/null 2>&1 || { echo "!! '$1' 가 PATH 에 없습니다"; exit 1; }; }
need cargo; need wasm-bindgen; need node; need npm
# wasm-bindgen 은 crates/hwp-wasm 의 `wasm-bindgen = "=0.2.125"` 와 정확히 일치해야 한다.
WB_VER="$(wasm-bindgen --version | awk '{print $2}')"
PIN_VER="$(grep -oE 'wasm-bindgen = "=[0-9.]+"' crates/hwp-wasm/Cargo.toml | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"
if [ "$WB_VER" != "$PIN_VER" ]; then
  echo "!! wasm-bindgen CLI $WB_VER != 크레이트 핀 $PIN_VER — 'cargo install wasm-bindgen-cli --version $PIN_VER' 로 맞추세요"
  exit 1
fi
echo "== wasm-bindgen $WB_VER (핀 $PIN_VER 일치)"

# ── 클린화: 재생성 가능한 빌드 산출물만 제거(node_modules/target 은 보존) ──────────
echo "== 클린화 (dist / pkg / .next / public 정적 에셋 제거)"
rm -rf packages/engine/pkg
rm -rf packages/editor-core/dist packages/ai-protocol/dist packages/react/dist
rm -rf apps/hwp-lab/.next apps/hwp-lab/public/hwp apps/hwp-lab/public/fonts

# ── §2 빌드 체인 (순서 필수: react dist 가 editor-core dist entry 를 참조) ──────────
echo "== [1/5] 엔진 wasm 빌드 (release, wasm32)"
cargo build -q -p hwp-wasm --release --target wasm32-unknown-unknown

echo "== [2/5] wasm-bindgen → packages/engine/pkg"
wasm-bindgen --target web --out-dir packages/engine/pkg \
  target/wasm32-unknown-unknown/release/hwp_wasm.wasm

echo "== [3/5] editor-core 빌드"
( cd packages/editor-core && npm install && npm run build )

echo "== [4/5] ai-protocol 빌드"
( cd packages/ai-protocol && npm install && npm run build )

echo "== [5/5] react 빌드 (editor-core dist 선행 필수)"
( cd packages/react && npm install && npm run build )

# ── §3 lab 기동 → curl 계약 ─────────────────────────────────────────────────
echo "== hwp-lab 의존성 설치"
( cd apps/hwp-lab && npm install )

# 포트 점유 회피(개발 머신은 흔히 3000/3002 에 다른 Next 앱이 떠 있다 — §9 트러블슈팅).
pick_free_port() {
  for p in 3939 4517 4788 5123 5678 6123 6789; do
    if ! lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then echo "$p"; return 0; fi
  done
  echo "!! 여유 포트를 찾지 못했습니다" >&2; return 1
}
PORT="$(pick_free_port)"
BASE="http://localhost:${PORT}"
echo "== lab dev 기동: ${BASE} (predev 훅이 wasm+폰트를 public 으로 복사)"

DEV_LOG="$(mktemp)"
( cd apps/hwp-lab && PORT="$PORT" npm run dev >"$DEV_LOG" 2>&1 ) &
DEV_PID=$!

cleanup() {
  # next dev 는 자식 프로세스를 남긴다 — npm PID + 포트 리스너를 모두 정리한다.
  kill "$DEV_PID" >/dev/null 2>&1 || true
  local lp; lp="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true)"
  [ -n "$lp" ] && kill $lp >/dev/null 2>&1 || true
  rm -f "$DEV_LOG"
}
trap cleanup EXIT

# GET / 가 200 이 될 때까지 폴링(next dev 는 첫 요청에 lazy 컴파일).
ok=0
for i in $(seq 1 90); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/" 2>/dev/null || echo 000)"
  if [ "$code" = "200" ]; then ok=1; echo "== GET / → 200 (${i}s)"; break; fi
  # dev 서버가 죽었으면(EADDRINUSE 등) 즉시 실패 처리.
  kill -0 "$DEV_PID" >/dev/null 2>&1 || { echo "!! dev 서버가 종료됨:"; cat "$DEV_LOG"; exit 1; }
  sleep 1
done
[ "$ok" = "1" ] || { echo "!! GET / 가 200 이 되지 않음:"; cat "$DEV_LOG"; exit 1; }

# 포트 점유 함정 방지: 루트 200 만으로는 부족(다른 앱일 수 있음). 앱 아이덴티티를 확인한다.
TITLE="$(curl -s "$BASE/" | grep -o '<title>[^<]*</title>' | head -1 || true)"
echo "== title: ${TITLE}"
case "$TITLE" in
  *hwp-lab*) : ;;
  *) echo "!! 루트가 hwp-lab 이 아님(포트 점유?): ${TITLE}"; exit 1 ;;
esac

# GET /api/hwp-edit → mock 모드(키 없음). JSON 아이덴티티가 강한 확인 신호.
GET_BODY="$(curl -s -w '\n%{http_code}' "$BASE/api/hwp-edit")"
GET_CODE="$(printf '%s' "$GET_BODY" | tail -1)"
GET_JSON="$(printf '%s' "$GET_BODY" | sed '$d')"
echo "== GET /api/hwp-edit → ${GET_CODE} ${GET_JSON}"
[ "$GET_CODE" = "200" ] || { echo "!! GET /api/hwp-edit 가 200 이 아님"; exit 1; }
printf '%s' "$GET_JSON" | grep -q '"mode":"mock"' || { echo "!! mock 모드가 아님"; exit 1; }

# POST /api/hwp-edit (table 앵커) → SetTableCell 'PoC ✔' mock intent.
POST_BODY="$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/hwp-edit" \
  -H 'Content-Type: application/json' \
  -d '{"instruction":"이 칸을 채워줘","anchors":[{"kind":"table","section":0,"block":1}],"docContext":"<document-content>x</document-content>"}')"
POST_CODE="$(printf '%s' "$POST_BODY" | tail -1)"
POST_JSON="$(printf '%s' "$POST_BODY" | sed '$d')"
echo "== POST /api/hwp-edit → ${POST_CODE} ${POST_JSON}"
[ "$POST_CODE" = "200" ] || { echo "!! POST /api/hwp-edit 가 200 이 아님"; exit 1; }
printf '%s' "$POST_JSON" | grep -q '"SetTableCell"' || { echo "!! mock intent(SetTableCell) 부재"; exit 1; }

echo
echo "✅ handover-verify: 빌드 체인 + lab 기동 + curl 계약 전부 통과 (port ${PORT})"
