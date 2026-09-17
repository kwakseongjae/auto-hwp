#!/usr/bin/env bash
# 이슈 #144 — 공증 자격증명을 이 맥에 한 번만 저장한다.
#
# ## 이 스크립트가 지키는 것
#
# **앱 암호가 셸 히스토리·`ps` 인자·로그·파일 어디에도 남지 않는다.** 그래서 암호를 변수로 받아
# 넘기지 않고, `security` 와 `notarytool` **각자의 프롬프트**에 직접 입력하게 한다. 두 번 묻는 대신
# 노출 지점이 0이다 — 자격증명은 한 번 새면 회수가 어렵다.
#
# 인증서는 이미 있어야 한다(`Developer ID Application`). 없으면 여기서 멈춘다 — 이 스크립트는
# 자격증명을 저장할 뿐 발급하지 않는다.
#
#   scripts/desktop-notarize-setup.sh
#
# 저장 후에는 `scripts/desktop-sign-local.sh` 가 이 자격증명으로 서명·공증 빌드를 돈다.
set -euo pipefail

PROFILE="${NOTARY_PROFILE:-auto-hwp}"
KEYCHAIN_SERVICE="auto-hwp-notarization"

say() { printf '\n── %s\n' "$1"; }

# 이 스크립트는 암호를 인자로 받지 않는다 — `security` 와 `notarytool` 의 프롬프트에 직접 입력받는
# 것이 유일한 경로다. 그래서 **진짜 터미널(TTY)** 이 필요하다. 없는데 그냥 시작하면 프롬프트에서
# 조용히 죽어 사람이 원인을 모른다. 먼저 말하고 멈춘다.
if [ ! -t 0 ]; then
  cat >&2 <<'MSG'
::error:: 대화형 터미널이 아니다 — 여기서는 암호를 안전하게 입력받을 수 없다.

이 스크립트는 앱 암호를 인자·환경변수·파일로 받지 않는다(노출 지점을 0으로 두려는 것이다).
`security` 와 `notarytool` 의 프롬프트에 직접 입력해야 하므로 **터미널 창에서 직접** 실행하라:

    cd <저장소>
    scripts/desktop-notarize-setup.sh

Claude Code 의 `!` 실행이나 파이프로는 동작하지 않는다.
MSG
  exit 1
fi

# ── 1. Developer ID 인증서 ───────────────────────────────────────────────────
say "Developer ID 인증서 확인"
IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null \
  | grep "Developer ID Application" | head -1 || true)"
if [ -z "$IDENTITY" ]; then
  cat >&2 <<'MSG'
::error:: "Developer ID Application" 인증서가 이 맥에 없다.

이 스크립트는 자격증명을 **저장**할 뿐 인증서를 발급하지 않는다.
developer.apple.com → Certificates → "Developer ID Application" 을 만들어 설치한 뒤 다시 실행하라.
MSG
  exit 1
fi
# "  4) <hash> "Developer ID Application: Name (TEAMID)"" 에서 이름만 꺼낸다.
SIGNING_IDENTITY="$(printf '%s' "$IDENTITY" | sed -n 's/.*"\(.*\)".*/\1/p')"
TEAM_ID="$(printf '%s' "$SIGNING_IDENTITY" | sed -n 's/.*(\([A-Z0-9]\{10\}\))$/\1/p')"
if [ -z "$TEAM_ID" ]; then
  echo "::error::서명 주체에서 Team ID 를 읽지 못했다: $SIGNING_IDENTITY" >&2
  exit 1
fi
echo "✓ $SIGNING_IDENTITY"
echo "  Team ID: $TEAM_ID"

# ── 2. Apple ID (비밀 아님 — 이메일) ─────────────────────────────────────────
say "Apple ID"
if [ -n "${APPLE_ID:-}" ]; then
  APPLE_ID_VALUE="$APPLE_ID"
  echo "환경변수 APPLE_ID 사용: $APPLE_ID_VALUE"
else
  printf 'Apple ID (이메일): '
  read -r APPLE_ID_VALUE
fi
[ -n "$APPLE_ID_VALUE" ] || { echo "::error::Apple ID 가 비었다" >&2; exit 1; }

# ── 3. 앱 암호를 키체인에 (build 스크립트가 읽는다) ──────────────────────────
# `-w` 를 값 없이 주면 `security` 가 **자기 프롬프트로** 받는다 — 인자에 실리지 않는다.
say "앱 암호를 로그인 키체인에 저장"
cat <<MSG
appleid.apple.com → 로그인 및 보안 → 앱 암호 에서 만든 값을 붙여넣어라.
형식은 xxxx-xxxx-xxxx-xxxx 이고, 입력은 화면에 보이지 않는다.
MSG
security delete-generic-password -s "$KEYCHAIN_SERVICE" -a "$APPLE_ID_VALUE" >/dev/null 2>&1 || true
security add-generic-password \
  -s "$KEYCHAIN_SERVICE" \
  -a "$APPLE_ID_VALUE" \
  -j "auto-hwp 데스크톱 공증용 앱 암호 (이슈 144)" \
  -U -w
echo "✓ 로그인 키체인에 저장됨 (서비스: $KEYCHAIN_SERVICE)"

# ── 4. notarytool 프로파일 (xcrun 계열 도구가 직접 쓴다) ─────────────────────
say "notarytool 자격증명 프로파일 저장"
echo "같은 앱 암호를 한 번 더 묻는다 — 값이 스크립트를 거치지 않게 하려는 것이다."
xcrun notarytool store-credentials "$PROFILE" \
  --apple-id "$APPLE_ID_VALUE" \
  --team-id "$TEAM_ID"

# ── 5. 실제로 되는지 확인 ────────────────────────────────────────────────────
say "자격증명 검증 (애플에 조회)"
if xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1; then
  echo "✓ 애플이 자격증명을 받아들였다"
else
  cat >&2 <<'MSG'
::error::자격증명 검증 실패.

흔한 원인:
  - 앱 암호를 잘못 붙여넣음 (하이픈 포함 xxxx-xxxx-xxxx-xxxx)
  - Apple ID 가 Developer Program 에 속하지 않음
  - 2단계 인증 계정이 아님 (앱 암호는 2FA 계정만 만들 수 있다)
MSG
  exit 1
fi

cat <<MSG

✅ 준비 완료

  서명 주체 : $SIGNING_IDENTITY
  Team ID   : $TEAM_ID
  프로파일   : $PROFILE
  키체인     : $KEYCHAIN_SERVICE / $APPLE_ID_VALUE

다음:  scripts/desktop-sign-local.sh
MSG
