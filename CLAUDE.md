# Cyber Life - Project Instructions

**Extending the app? Read `docs/AGENT-MANUAL.md` first** — architecture
map, hard rules and checklists for adding modules, widgets and agent
capabilities (API groups + skills).

## Build & Run

When building and running the app, ALWAYS follow this sequence:

1. Kill any running instance first: `pkill -f "CyberLife.app/Contents/MacOS/CyberLife" 2>/dev/null || true`
2. Build: `bash build.sh`
3. Launch: `open build/bin/CyberLife.app`

One-liner:
```bash
pkill -f "CyberLife.app/Contents/MacOS/CyberLife" 2>/dev/null; bash build.sh && open build/bin/CyberLife.app
```

## Tech Stack

- **Backend**: Go + Wails v2
- **Frontend**: Vanilla JS (no framework)
- **Desktop**: macOS .app bundle
- **Terminal Integration**: tmux control mode (sessions), iTerm2 via AppleScript (optional escape hatch)

## Key Conventions

- Wails event names use hyphens, not colons (e.g. `iterm-session-content`, NOT `iterm:session-content`)
- Frontend modules are in `frontend/src/modules/`
- Wails bindings are auto-generated during build in `frontend/wailsjs/`
- Sessions are tmux-only; content streams via `tmux -C` control mode (no Python bridge)
