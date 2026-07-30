#!/bin/bash
# Check (and optionally install) everything Cyber Life needs to build and run.
#
#   bash scripts/doctor.sh              report only
#   bash scripts/doctor.sh --install    install what is missing
#
# Nothing is installed without --install: the fixes need sudo or touch your Go
# and npm setup, and that is not a side effect a status check should have.
set -uo pipefail

INSTALL=0
[ "${1:-}" = "--install" ] && INSTALL=1

OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM=mac ;;
  Linux)  PLATFORM=linux ;;
  *) echo "Unsupported platform: $OS — macOS and Linux are supported." >&2; exit 1 ;;
esac

missing=()
optional_missing=()

say()  { printf '%s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %-22s %s\n' "$1" "${2:-}"; }
bad()  { printf '  \033[31m✗\033[0m %-22s %s\n' "$1" "$2"; }
warn() { printf '  \033[33m!\033[0m %-22s %s\n' "$1" "$2"; }

# have <name> <label> <required|optional> <fix-command> [version-command]
have() {
  local bin="$1" label="$2" need="$3" fix="$4" vercmd="${5:-}"
  if command -v "$bin" >/dev/null 2>&1; then
    local detail
    detail="$(command -v "$bin")"
    if [ -n "$vercmd" ]; then
      detail="$($vercmd 2>/dev/null | head -1)"
    fi
    ok "$label" "$detail"
    return 0
  fi
  if [ "$need" = required ]; then
    bad "$label" "missing — $fix"
    missing+=("$fix")
  else
    warn "$label" "missing (optional) — $fix"
    optional_missing+=("$fix")
  fi
  return 1
}

say ""
say "Cyber Life doctor — $PLATFORM"
say ""
say "Build toolchain"

if [ "$PLATFORM" = mac ]; then
  PKG_GO="brew install go"
  PKG_NODE="brew install node"
  PKG_TMUX="brew install tmux"
else
  PKG_GO="sudo apt install -y golang-go"
  PKG_NODE="sudo apt install -y nodejs npm"
  PKG_TMUX="sudo apt install -y tmux"
fi

have go "Go (1.25+)" required "$PKG_GO" "go version"

# wails installs into GOPATH/bin, which is often not on PATH yet
WAILS_BIN="$(command -v wails || true)"
[ -z "$WAILS_BIN" ] && [ -x "$HOME/go/bin/wails" ] && WAILS_BIN="$HOME/go/bin/wails"
if [ -n "$WAILS_BIN" ]; then
  # The version matters beyond "present": wails regenerates
  # frontend/wailsjs/runtime/ on every build, so a different CLI rewrites those
  # tracked files. Show it, so a surprise diff has an obvious cause.
  ok "Wails CLI" "$("$WAILS_BIN" version 2>/dev/null | head -1) ($WAILS_BIN)"
else
  bad "Wails CLI" "missing — go install github.com/wailsapp/wails/v2/cmd/wails@latest"
  missing+=("go install github.com/wailsapp/wails/v2/cmd/wails@latest")
fi

have node "Node.js" required "$PKG_NODE" "node --version"

if [ "$PLATFORM" = mac ]; then
  if xcode-select -p >/dev/null 2>&1; then
    ok "Xcode CLI tools" "$(xcode-select -p)"
  else
    bad "Xcode CLI tools" "missing — xcode-select --install"
    missing+=("xcode-select --install")
  fi
else
  # Wails on Linux links against GTK3 and WebKit2GTK. Package names differ by
  # WebKit generation, so accept whichever this distro ships.
  GTK_FIX="sudo apt install -y libgtk-3-dev libwebkit2gtk-4.1-dev build-essential pkg-config"
  if pkg-config --exists gtk+-3.0 2>/dev/null; then
    ok "GTK 3 dev" "$(pkg-config --modversion gtk+-3.0)"
  else
    bad "GTK 3 dev" "missing — $GTK_FIX"
    missing+=("$GTK_FIX")
  fi
  webkit_found=""
  for mod in webkit2gtk-4.1 webkit2gtk-4.0; do
    if pkg-config --exists "$mod" 2>/dev/null; then
      webkit_found="$mod $(pkg-config --modversion "$mod")"
      break
    fi
  done
  if [ -n "$webkit_found" ]; then
    ok "WebKit2GTK dev" "$webkit_found"
  else
    bad "WebKit2GTK dev" "missing — $GTK_FIX"
    missing+=("$GTK_FIX")
  fi
fi

say ""
say "Runtime"
have tmux "tmux" required "$PKG_TMUX" "tmux -V"
have git "git" required "sudo apt install -y git" "git --version"
have claude "Claude Code CLI" optional "npm install -g @anthropic-ai/claude-code" "claude --version"

if [ "$PLATFORM" = mac ]; then
  if [ -d /Applications/iTerm.app ]; then
    ok "iTerm2" "optional escape hatch"
  else
    warn "iTerm2" "missing (optional) — brew install --cask iterm2"
    optional_missing+=("brew install --cask iterm2")
  fi
  if command -v swiftc >/dev/null 2>&1; then
    ok "swiftc" "dictation helper can be built"
  else
    warn "swiftc" "missing (optional) — comes with Xcode CLI tools; dictation will not build"
  fi
else
  warn "Dictation" "macOS only (Speech.framework) — use the ElevenLabs engine"
  warn "iTerm2" "macOS only — sessions still run and stream through tmux"
fi

# GTK and WebKit are fixed by the same apt line; asking for it twice is noise.
# Written for bash 3.2, which is what macOS still ships.
unique=()
for fix in ${missing[@]+"${missing[@]}"}; do
  duplicate=0
  for seen in ${unique[@]+"${unique[@]}"}; do
    [ "$seen" = "$fix" ] && duplicate=1 && break
  done
  [ "$duplicate" -eq 0 ] && unique+=("$fix")
done
missing=(${unique[@]+"${unique[@]}"})

say ""
if [ ${#missing[@]} -eq 0 ]; then
  say "All required dependencies are present. Build with: bash build.sh"
  [ ${#optional_missing[@]} -gt 0 ] && say "Optional extras are listed above."
  exit 0
fi

say "${#missing[@]} required item(s) missing."
if [ "$INSTALL" -eq 0 ]; then
  say ""
  say "Re-run with --install to fix, or run these yourself:"
  printf '  %s\n' "${missing[@]}"
  exit 1
fi

say ""
say "Installing…"
if [ "$PLATFORM" = linux ] && command -v apt >/dev/null 2>&1; then
  sudo apt update
fi
status=0
for fix in "${missing[@]}"; do
  say "→ $fix"
  # shellcheck disable=SC2086
  if ! eval "$fix"; then
    say "  failed: $fix"
    status=1
  fi
done

say ""
if [ "$status" -eq 0 ]; then
  say "Done. Re-run without --install to verify, then: bash build.sh"
  say "If wails is still not found, add Go's bin directory to PATH:"
  say "  export PATH=\"\$PATH:\$(go env GOPATH)/bin\""
else
  say "Some installs failed — see above."
fi
exit "$status"
