#!/usr/bin/env bash
# 이슈 #144 — 이 맥에서 서명·공증된 데스크톱 번들을 만든다.
#
# `scripts/desktop-notarize-setup.sh` 를 먼저 한 번 돌려야 한다.
#
# ## 앱 암호를 다루는 방식
#
# Tauri 의 공증 단계는 `APPLE_PASSWORD` 를 **환경변수로** 읽는다. 그래서 여기서는 키체인에서 꺼내
# `cargo tauri build` **자식 프로세스에만** 넣는다 — 셸에 export 하지 않으므로 이 스크립트가 끝나면
# 사라지고, 히스토리·파일에도 남지 않는다.
#
# 로컬 **미서명** 빌드가 필요하면 이 스크립트가 아니라 `cargo tauri build` 를 그냥 쓰면 된다.
# 미서명 빌드는 정상이고 하니스로 쓰기에 충분하다 — 다만 그건 릴리스가 아니다.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

PROFILE="${NOTARY_PROFILE:-auto-hwp}"
KEYCHAIN_SERVICE="auto-hwp-notarization"
FEATURES="${DESKTOP_FEATURES:-rhwp,shaper,pdf}"

say() { printf '\n══ %s\n' "$1"; }

say "서명 주체"
IDENTITY_LINE="$(security find-identity -v -p codesigning 2>/dev/null \
  | grep "Developer ID Application" | head -1 || true)"
[ -n "$IDENTITY_LINE" ] || {
  echo "::error::Developer ID Application 인증서가 없다. scripts/desktop-notarize-setup.sh 참고" >&2
  exit 1
}
SIGNING_IDENTITY="$(printf '%s' "$IDENTITY_LINE" | sed -n 's/.*"\(.*\)".*/\1/p')"
TEAM_ID="$(printf '%s' "$SIGNING_IDENTITY" | sed -n 's/.*(\([A-Z0-9]\{10\}\))$/\1/p')"
echo "$SIGNING_IDENTITY"

say "공증 자격증명"
APPLE_ID_VALUE="${APPLE_ID:-$(security find-generic-password -s "$KEYCHAIN_SERVICE" 2>/dev/null \
  | sed -n 's/.*"acct"<blob>="\(.*\)"/\1/p' | head -1)}"
[ -n "$APPLE_ID_VALUE" ] || {
  echo "::error::키체인에서 Apple ID 를 못 찾았다 — scripts/desktop-notarize-setup.sh 를 먼저 돌려라" >&2
  exit 1
}
# `-w` 는 암호만 표준출력으로 준다. 변수에 담고 **자식 환경에만** 전달한다.
APP_PASSWORD="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$APPLE_ID_VALUE" -w 2>/dev/null || true)"
[ -n "$APP_PASSWORD" ] || {
  echo "::error::키체인에서 앱 암호를 못 꺼냈다 (접근을 거부했거나 항목이 없다)" >&2
  exit 1
}
echo "Apple ID: $APPLE_ID_VALUE  ·  Team: $TEAM_ID  ·  암호는 키체인에서 (출력 안 함)"

say "빌드 + 서명 + 공증 (features: $FEATURES)"
echo "공증은 애플 서버 왕복이라 수 분 걸릴 수 있다."
(
  cd crates/hwp-viewer
  # 자식 환경에만 주입한다. 부모 셸에는 export 되지 않는다.
  APPLE_SIGNING_IDENTITY="$SIGNING_IDENTITY" \
  APPLE_ID="$APPLE_ID_VALUE" \
  APPLE_PASSWORD="$APP_PASSWORD" \
  APPLE_TEAM_ID="$TEAM_ID" \
    cargo tauri build --features "$FEATURES"
)
unset APP_PASSWORD

say "검증"
bash scripts/verify-desktop-signing.sh target/release/bundle
