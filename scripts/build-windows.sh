#!/usr/bin/env bash
# Cross-compiles the Windows x64 build from macOS (GNU toolchain, no MSVC SDK needed).
#
# One-time setup:
#   brew install mingw-w64 makensis rustup
#   rustup toolchain install stable --profile minimal --target x86_64-pc-windows-gnu
#
# Outputs in dist/:
#   AgentTracker_<ver>_x64-setup.exe(.sig)   NSIS installer (+ updater signature)
#   AgentTracker_<ver>_x64-portable.zip  exe + WebView2Loader.dll, no install needed
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET=x86_64-pc-windows-gnu
# Homebrew's rust has no Windows std; use rustup's toolchain for this build.
export PATH="$(rustup run stable rustc --print sysroot)/bin:$PATH"
export CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=x86_64-w64-mingw32-gcc
# makensis crashes (std::bad_alloc) under the C locale.
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
# Updater signing key (signs the installer for in-app updates).
export TAURI_SIGNING_PRIVATE_KEY="${TAURI_SIGNING_PRIVATE_KEY:-$HOME/.tauri/agenttracker.key}"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
# `tauri signer sign` only accepts the key's contents, not a path.
if [[ -f "$TAURI_SIGNING_PRIVATE_KEY" ]]; then
  export TAURI_SIGNING_PRIVATE_KEY="$(cat "$TAURI_SIGNING_PRIVATE_KEY")"
fi

npx tauri build --target "$TARGET" --bundles nsis

VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
OUT=src-tauri/target/$TARGET/release
mkdir -p dist
cp "$OUT/bundle/nsis/AgentTracker_${VERSION}_x64-setup.exe" "$OUT/bundle/nsis/AgentTracker_${VERSION}_x64-setup.exe.sig" dist/
STAGE=$(mktemp -d)
mkdir "$STAGE/AgentTracker"
cp "$OUT/agent-tracker.exe" "$STAGE/AgentTracker/AgentTracker.exe"
cp "$OUT/WebView2Loader.dll" "$STAGE/AgentTracker/"
(cd "$STAGE" && zip -qr - AgentTracker) > "dist/AgentTracker_${VERSION}_x64-portable.zip"
rm -rf "$STAGE"
ls -lh dist/
