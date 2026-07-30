# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.0.0] - 2026-07-25

### Changed
- **Project renamed to Cyber Life** (`cyberlife`): Go module
  `github.com/kalor62/cyberlife`, app bundle `CyberLife.app`, state dir
  `~/.cyberlife`, agent skills `cyberlife-*`, MCP server name `cyberlife`
- Module system rewritten around a single-descriptor registry
  (`module-host.js`); the legacy embedded-browser remnants (bookmarks,
  device presets, browser state types) are gone

### Added
- **Addons platform**: drop a folder with `addon.json` + an ES module into
  `~/.cyberlife/addons` to add pages, widgets and integrations; scoped SDK
  (events bus, per-addon storage, permission-gated API access), hot reload,
  categories and tags, manager UI in Settings → Addons, `addons_*` MCP
  tools + `cyberlife-addons` skill so agents can build addons themselves
- Built-in integrations (Gmail, Jira, voice dictation, health checks,
  Pomodoro, iTerm2) presented as toggleable built-in addons — disabling
  one really turns its features, widgets and API groups off
- `emit-event` automation action broadcasting rule payloads to addons
- Status-bar branding with the app version; version reported via MCP

## [2.0.0] - 2026-07-24

### Removed
- **Top tabs**: Skills, Git, QA, Docker and Remote — frontend panels and the Go
  packages behind them (`internal/docker`, `internal/remote`, `internal/testing`)
- **Bottom tool panel** in its entirety: Agents, Teams, Hooks, MCP, Libs and
  CLAUDE.md tabs, plus `internal/teams`, the panel resizer, minimize state and
  persisted panel height
- Remote terminal access over WebSocket, ngrok tunnels, device approval and
  token-based auth that came with them
- Test run history and coverage tracking from persisted state

### Added
- Email tab with Gmail integration: OAuth device flow per account, thread list,
  message viewer, compose/reply, label filtering and contact autocomplete
- Standalone Gmail MCP server (`mcp-gmail/`) exposing the same account store to
  Claude sessions
- Tasks backed by git worktrees, with optional Jira issue import
- Project groups in the sidebar
- tmux single-window mode: every tmux session shows up as a virtual terminal
  behind one iTerm2 host tab
- Per-terminal Claude accounts via `CLAUDE_CONFIG_DIR` profiles
- Settings tab with ElevenLabs Scribe v2 Realtime dictation
- ALL view for pinned terminals with multi-session monitoring
- Health tab with per-project health checks, and project pinning
- Notes as a top-level tab panel

### Changed
- **Prompts moved from the bottom panel to a top tab**, positioned after
  Structure; `Shift+←/→` cycles Dashboard → Health → Structure → Prompts
- Go toolchain requirement raised to 1.25
- Paths in defaults are home-relative instead of hardcoded

### Fixed
- New tmux sessions failing to start: the session command now runs under an
  interactive login shell, so PATH entries defined in `.zshrc` resolve when the
  app is launched from Finder
- Cyber Life now detects a missing tmux host window and opens a fresh iTerm2
  window attached to the session instead of silently doing nothing
- Sessions whose command dies immediately are reported as an error rather than
  appearing to start successfully

## [1.0.0] - 2025-01-30

### Added
- Multi-project workspace with custom colors and icons
- Terminal management with full PTY support (xterm.js)
- Claude CLI status detection and real-time activity display
- Git dashboard with diff viewer, commit history, and branch info
- Docker container monitoring and control
- Test dashboard with auto-detection and coverage tracking
- Remote terminal access via WebSocket
- ngrok tunnel integration for public remote access
- Token-based authentication with expiry and rate limiting
- Permanent approved devices support
- Claude tools panel for managing:
  - Agents
  - Skills
  - Commands
  - Hooks
  - MCP servers
- Project notes with Markdown support
- Browser preview with device emulation
- Screenshot capture and management
- Bookmarks per project
- Structured logging with sensitive data redaction
- Log rotation (3-day retention)

### Security
- Constant-time token comparison
- Rate limiting (50 attempts, 1 min lockout)
- Input validation for terminal resize
- CORS whitelist for localhost and ngrok domains
- Automatic sensitive data redaction in logs
