# Cyber Life - Project Instructions

**Extending the app? Read `docs/AGENT-MANUAL.md` first** — architecture
map, hard rules and checklists for adding modules, widgets and agent
capabilities (API groups + skills).

## Build & Run

Asked to "run Cyber Life" from a fresh clone? Start with the doctor — it names
everything missing and installs it on request. Do not guess at package names,
and do not skip it because `build.sh` looks like a one-liner: on Linux the
build fails without GTK and WebKit2GTK development headers.

```bash
bash scripts/doctor.sh              # report what is missing
bash scripts/doctor.sh --install    # install it (needs sudo for system packages)
```

If the doctor reports `wails` missing after installing Go, Go's bin directory
is not on PATH yet:

```bash
export PATH="$PATH:$(go env GOPATH)/bin"
```

Then build and launch. `build.sh` picks the right path for the platform, so the
same command works on both:

**macOS** — produces a signed `.app`:
```bash
pkill -f "[C]yberLife.app/Contents/MacOS/CyberLife" 2>/dev/null; bash build.sh && open build/bin/CyberLife.app
```

**Linux** — produces a plain binary:
```bash
pkill -f "[b]uild/bin/CyberLife" 2>/dev/null; bash build.sh && ./build/bin/CyberLife
```

Always kill the running instance first: two instances fight over the same
state file and the same port (8377).

`wails build` regenerates `frontend/wailsjs/runtime/` from whichever CLI you
have, so a different Wails version leaves a diff there that has nothing to do
with your change. Leave those files out of the commit unless updating the
bindings is the point of it — `bash scripts/doctor.sh` prints the version so
the cause is obvious.

The app needs a graphical session. Over plain SSH it will fail to open a
window — say so rather than retrying, and check `$DISPLAY` / `$WAYLAND_DISPLAY`
before blaming the build.

### What is macOS-only

The app runs on Linux; two optional pieces do not, and both degrade quietly:

- **Dictation** — the helper is Swift against `Speech.framework`. On Linux the
  ElevenLabs engine covers speech-to-text instead.
- **iTerm2 escape hatch** — opening a session in a real terminal window uses
  AppleScript. Sessions themselves are tmux on both platforms, so they still
  run, stream and survive restarts.

Never "fix" a Linux build by stripping these — they are already guarded by
`platform.IsMac()` and `runtime.GOOS` checks.

## Tech Stack

- **Backend**: Go + Wails v2
- **Frontend**: Vanilla JS (no framework)
- **Desktop**: macOS `.app` bundle; plain binary on Linux (GTK3 + WebKit2GTK)
- **Terminal Integration**: tmux control mode (sessions), iTerm2 via AppleScript (optional, macOS)

## Key Conventions

- Wails event names use hyphens, not colons (e.g. `iterm-session-content`, NOT `iterm:session-content`)
- Frontend modules are in `frontend/src/modules/`
- Wails bindings are auto-generated during build in `frontend/wailsjs/`
- Sessions are tmux-only; content streams via `tmux -C` control mode (no Python bridge)
- OS-specific work goes through `internal/platform`, never a bare `exec.Command("open", …)`
