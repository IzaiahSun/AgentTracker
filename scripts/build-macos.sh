#!/usr/bin/env bash
# Builds a universal (Apple Silicon + Intel) macOS app, signs it with a
# Developer ID certificate (hardened runtime), notarizes and staples it, and
# wraps it in a signed, notarized DMG.
#
# One-time setup:
#   rustup toolchain install stable --profile minimal --target aarch64-apple-darwin x86_64-apple-darwin
#   xcrun notarytool store-credentials AgentTracker --apple-id <you> --team-id <TEAMID>
#
# Env:
#   APPLE_SIGNING_IDENTITY  codesign identity (default: the "Developer ID Application" cert)
#   NOTARY_PROFILE          notarytool keychain profile (default: AgentTracker)
#   SKIP_NOTARIZE=1         sign only
#
# Output: dist/AgentTracker_<ver>_universal.dmg
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET=universal-apple-darwin
export APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-Developer ID Application}"
NOTARY_PROFILE="${NOTARY_PROFILE:-AgentTracker}"
# Homebrew's rust has only the host std; use rustup's toolchain for both arches.
export PATH="$(rustup run stable rustc --print sysroot)/bin:$PATH"

notarize() {
  [[ "${SKIP_NOTARIZE:-}" == 1 ]] && return
  xcrun notarytool submit "$1" --keychain-profile "$NOTARY_PROFILE" --wait
}

# Tauri signs with the hardened runtime and a secure timestamp.
npx tauri build --target "$TARGET" --bundles app

VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
APP=src-tauri/target/$TARGET/release/bundle/macos/AgentTracker.app
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

codesign --verify --strict --deep "$APP"
if [[ "${SKIP_NOTARIZE:-}" != 1 ]]; then
  ditto -c -k --keepParent "$APP" "$WORK/app.zip"
  notarize "$WORK/app.zip"
  xcrun stapler staple "$APP"
fi

mkdir -p dist "$WORK/dmg"
DMG="dist/AgentTracker_${VERSION}_universal.dmg"
cp -R "$APP" "$WORK/dmg/"
ln -s /Applications "$WORK/dmg/Applications"
rm -f "$DMG"
hdiutil create -quiet -volname AgentTracker -srcfolder "$WORK/dmg" -ov -format UDZO "$DMG"
codesign --sign "$APPLE_SIGNING_IDENTITY" --timestamp "$DMG"
if [[ "${SKIP_NOTARIZE:-}" != 1 ]]; then
  notarize "$DMG"
  xcrun stapler staple "$DMG"
fi

spctl -a -vv -t exec "$APP" || true
spctl -a -vv -t open --context context:primary-signature "$DMG" || true
ls -lh "$DMG"
