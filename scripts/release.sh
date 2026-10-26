#!/usr/bin/env bash
# Builds every platform, writes the updater manifest and publishes a GitHub release.
#
#   scripts/release.sh            build + write dist/latest.json, then publish v<version>
#   NO_PUBLISH=1 scripts/release.sh   build + manifest only
#
# Bump "version" in src-tauri/tauri.conf.json first. Installed apps fetch
# releases/latest/download/latest.json, so the newest published release wins.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO=IzaiahSun/AgentTracker
VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
TAG="v$VERSION"
BASE="https://github.com/$REPO/releases/download/$TAG"

rm -rf dist
scripts/build-macos.sh
scripts/build-windows.sh

MAC="AgentTracker_${VERSION}_universal.app.tar.gz"
WIN="AgentTracker_${VERSION}_x64-setup.exe"
VERSION="$VERSION" BASE="$BASE" MAC="$MAC" WIN="$WIN" node -e '
const fs = require("fs");
const { VERSION, BASE, MAC, WIN } = process.env;
const sig = (f) => fs.readFileSync(`dist/${f}.sig`, "utf8").trim();
const mac = { signature: sig(MAC), url: `${BASE}/${MAC}` };
const manifest = {
  version: VERSION,
  notes: process.env.NOTES || `AgentTracker ${VERSION}`,
  pub_date: new Date().toISOString(),
  platforms: {
    "darwin-aarch64": mac,
    "darwin-x86_64": mac,
    "windows-x86_64": { signature: sig(WIN), url: `${BASE}/${WIN}` },
  },
};
fs.writeFileSync("dist/latest.json", JSON.stringify(manifest, null, 2) + "\n");
'
echo "Wrote dist/latest.json"

[[ "${NO_PUBLISH:-}" == 1 ]] && exit 0
gh release create "$TAG" --repo "$REPO" --title "AgentTracker $TAG" --generate-notes \
  dist/AgentTracker_"${VERSION}"_universal.dmg \
  dist/"$MAC" dist/"$MAC".sig \
  dist/"$WIN" dist/"$WIN".sig \
  dist/AgentTracker_"${VERSION}"_x64-portable.zip \
  dist/latest.json
