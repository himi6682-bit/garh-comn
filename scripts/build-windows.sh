#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
npm install
npm install --no-save electron electron-builder
npx electron-builder --win portable --x64
mkdir -p "$ROOT/dist"
find "$ROOT/dist" -maxdepth 2 -type f -name '*.exe' -print
if [[ -d /opt/cursor/artifacts ]]; then
  find "$ROOT/dist" -maxdepth 2 -type f -name '*.exe' -exec cp {} /opt/cursor/artifacts/ \;
fi
