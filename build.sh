#!/bin/bash
# Build Cyber Life. On macOS this also compiles the Swift dictation helper and
# produces a signed .app; on Linux it produces a plain binary.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

WAILS="${WAILS:-$HOME/go/bin/wails}"
if [ ! -x "$WAILS" ]; then
  WAILS="$(command -v wails || true)"
fi
if [ -z "$WAILS" ]; then
  echo "wails not found. Install the toolchain with:" >&2
  echo "  go install github.com/wailsapp/wails/v2/cmd/wails@latest" >&2
  echo "then re-run, or point WAILS= at the binary." >&2
  exit 1
fi

case "$(uname -s)" in
  Darwin)
    APP="build/bin/CyberLife.app"

    # Recompile the dictation helper so engine changes in voice_input.swift take
    # effect (Go only lazily compiles it when the binary is missing).
    if [ -f scripts/voice_input.swift ]; then
      swiftc -O -o scripts/voice_input scripts/voice_input.swift \
        -framework Speech -framework AVFoundation || echo "WARN: voice_input compile failed"
    fi

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
    echo "  Run: open $APP"
    ;;

  Linux)
    # No Swift helper (dictation needs Speech.framework) and no code signing.
    # iTerm2 is absent too, which the app already treats as normal — tmux is
    # the session backend on both platforms.

    # Wails compiles against webkit2gtk-4.0 by default, but newer distros
    # (Ubuntu 24.04+) only ship 4.1 — build with the matching tag.
    TAGS=()
    if ! pkg-config --exists webkit2gtk-4.0 2>/dev/null \
        && pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
      TAGS=(-tags webkit2_41)
    fi

    "$WAILS" build -devtools "${TAGS[@]}" "$@"
    echo "✓ Build complete: $PROJECT_DIR/build/bin/CyberLife"
    echo "  Run: ./build/bin/CyberLife"
    ;;

  *)
    echo "Unsupported platform: $(uname -s) — macOS and Linux are supported." >&2
    exit 1
    ;;
esac
