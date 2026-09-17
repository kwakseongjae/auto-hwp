#!/usr/bin/env bash
# 이슈 #144 — 서명·공증이 **실제로** 붙었는지 확인한다.
#
# 빌드 툴체인이 자격증명을 못 찾으면 조용히 미서명 번들을 내놓을 수 있다. 그런 산출물이 "릴리스"로
# 나가는 것이 이 스크립트가 막으려는 사고다. 로그는 사실만 찍고, 하나라도 어긋나면 실패한다.
#
#   scripts/verify-desktop-signing.sh <bundle-dir>
#
# 로컬 미서명 빌드에도 돌릴 수 있다 — 그때는 "미서명"이라고 **정확히** 말하고 실패한다. 미서명 자체가
# 잘못은 아니지만(로컬 빌드는 정상), 릴리스 경로에서는 실패여야 한다.
set -euo pipefail

BUNDLE_DIR="${1:-}"
if [ -z "$BUNDLE_DIR" ] || [ ! -d "$BUNDLE_DIR" ]; then
  echo "usage: $0 <bundle-dir>   (예: target/release/bundle)" >&2
  exit 2
fi

if [ "$(uname -s)" != "Darwin" ]; then
  echo "이 검증은 macOS 에서만 의미가 있다 (codesign/spctl/stapler)." >&2
  exit 2
fi

APP="$(find "$BUNDLE_DIR" -maxdepth 3 -name "*.app" -type d | head -1)"
if [ -z "$APP" ]; then
  echo "::error::번들 디렉터리에서 .app 을 찾지 못했다: $BUNDLE_DIR" >&2
  exit 1
fi
echo "검증 대상: $APP"

fail=0
step() { printf '\n── %s\n' "$1"; }

step "codesign --verify --deep --strict"
if codesign --verify --deep --strict --verbose=2 "$APP" 2>&1; then
  echo "✓ 서명 유효"
else
  echo "::error::codesign 검증 실패 — 미서명이거나 서명이 깨졌다"
  fail=1
fi

step "서명 주체 (Developer ID 인지)"
# 주체 이름만 찍는다. 팀 ID 는 비밀이 아니지만 굳이 로그에 남기지 않는다.
authority="$(codesign -dv --verbose=4 "$APP" 2>&1 | grep -m1 '^Authority=' || true)"
if [ -z "$authority" ]; then
  echo "::error::서명 주체가 없다 — ad-hoc 이거나 미서명"
  fail=1
else
  echo "$authority"
  case "$authority" in
    *"Developer ID Application"*) echo "✓ Developer ID 로 서명됨" ;;
    *) echo "::error::Developer ID 가 아니다 — 배포용 서명이 아님"; fail=1 ;;
  esac
fi

step "hardened runtime"
# 플래그는 `CodeDirectory … flags=0x10000(runtime)` 줄에 있다. `--verbose` 만으로는 그 줄이 안 나와
# 거짓 음성이 났었다 — 검증기가 정상 릴리스를 막는 건 통과시키는 것만큼 나쁘다. `-d --verbose=2` 로
# CodeDirectory 를 받아 괄호 안 토큰을 본다.
runtime_flags="$(codesign -d --verbose=2 "$APP" 2>&1 | grep -m1 -o 'flags=0x[0-9a-f]*([^)]*)' || true)"
if [ -z "$runtime_flags" ]; then
  echo "::error::CodeDirectory 플래그를 읽지 못했다 — 서명이 없거나 형식이 예상과 다르다"
  fail=1
elif printf '%s' "$runtime_flags" | grep -q "runtime"; then
  echo "✓ hardened runtime 켜짐 ($runtime_flags)"
else
  echo "::error::hardened runtime 이 꺼져 있다 ($runtime_flags) — 공증이 거부된다"
  fail=1
fi

step "공증 staple"
if xcrun stapler validate "$APP" 2>&1; then
  echo "✓ 공증 티켓이 붙어 있다"
else
  echo "::error::stapler 검증 실패 — 공증이 안 됐거나 티켓이 없다"
  fail=1
fi

step "Gatekeeper 평가 (spctl)"
if spctl --assess --type execute --verbose=4 "$APP" 2>&1; then
  echo "✓ Gatekeeper 통과"
else
  echo "::error::Gatekeeper 가 거부했다 — 사용자 기기에서 열리지 않는다"
  fail=1
fi

# 사용자는 `.app` 이 아니라 **`.dmg` 를 내려받는다.** Tauri 는 앱만 공증하고 dmg 는 그대로 두므로,
# 앱이 통과해도 dmg 가 격리(quarantine)에 걸려 첫 실행에서 경고가 뜰 수 있다. 배포하는 바이트를
# 검사하지 않으면 "경고 없이 열린다" 는 약속을 지켰는지 알 수 없다.
step "배포 산출물(.dmg) 공증"
dmg="$(find "$BUNDLE_DIR" -maxdepth 2 -name "*.dmg" -type f | head -1)"
if [ -z "$dmg" ]; then
  echo "· .dmg 없음 — app 만 만든 빌드다"
elif xcrun stapler validate "$dmg" >/dev/null 2>&1; then
  echo "✓ dmg 에도 공증 티켓이 붙어 있다 — 내려받아 여는 경로가 깨끗하다"
else
  echo "::error::dmg 에 공증 티켓이 없다 ($(basename "$dmg"))"
  echo "  앱만 공증하면 내려받은 dmg 가 격리에 걸린다. 다음으로 해결한다:"
  echo "    xcrun notarytool submit <dmg> --keychain-profile auto-hwp --wait"
  echo "    xcrun stapler staple <dmg>"
  fail=1
fi

step "업데이터 서명 (.sig)"
# 업데이터 아티팩트는 **배포 채널을 쓸 때만** 필수다(`REQUIRE_UPDATER_SIG=1`). 로컬 서명 빌드에는
# 없는 게 정상이므로 기본값에서는 경고만 남긴다 — 없다고 실패시키면 사람이 검증기를 무시하기 시작한다.
sig_count="$(find "$BUNDLE_DIR" -name "*.sig" -type f | wc -l | tr -d ' ')"
if [ "$sig_count" -gt 0 ]; then
  echo "✓ 업데이터 서명 $sig_count 개"
  find "$BUNDLE_DIR" -name "*.sig" -type f -exec basename {} \;
elif [ "${REQUIRE_UPDATER_SIG:-0}" = "1" ]; then
  echo "::error::.sig 가 없다 — 배포 채널에는 업데이터 서명이 필수다"
  fail=1
else
  echo "· .sig 없음 — 로컬 서명 빌드에서는 정상이다"
  echo "  (배포용은 createUpdaterArtifacts + TAURI_SIGNING_PRIVATE_KEY, 검사는 REQUIRE_UPDATER_SIG=1)"
fi

printf '\n'
if [ "$fail" -eq 0 ]; then
  echo "✅ 서명·공증 검증 전부 통과"
else
  echo "❌ 검증 실패 — 위 항목을 해결하기 전에는 릴리스가 아니다"
fi
exit "$fail"
