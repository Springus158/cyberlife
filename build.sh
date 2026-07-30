#!/bin/bash
# Build Cyber Life: voice helper, Wails bundle, custom icon, ad-hoc signature.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"
APP="build/bin/CyberLife.app"

# Recompile the voice input helper so engine changes in voice_input.swift take
# effect (Go only lazily compiles it when the binary is missing).
if [ -f scripts/voice_input.swift ]; then
  swiftc -O -o scripts/voice_input scripts/voice_input.swift \
    -framework Speech -framework AVFoundation || echo "WARN: voice_input compile failed"
fi

WAILS="${WAILS:-$HOME/go/bin/wails}"
"$WAILS" build -devtools "$@"

# Wails generates its own icon; install ours and invalidate the icon cache
if [ -f build/appicon.icns ]; then
  cp build/appicon.icns "$APP/Contents/Resources/iconfile.icns"
  touch "$APP"
fi

# Re-sign with entitlements so macOS remembers microphone permission across rebuilds
codesign --force --deep --sign - \
  --entitlements build/darwin/entitlements.plist "$APP"

echo "✓ Build complete: $PROJECT_DIR/$APP"
