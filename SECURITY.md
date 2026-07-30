# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 3.x     | ✅        |
| < 3.0   | ❌        |

## Threat model — read this before poking at the port

Cyber Life is a **local desktop app for a single trusted user**. Its security posture is deliberate and worth understanding:

### The agent API is unauthenticated by design

While the app runs, it listens on `127.0.0.1:8377` (REST + MCP). There is **no authentication**: the API exists so local AI agents can drive the app without credential plumbing. Consequences you should accept before running Cyber Life:

- **Any process on your machine can call the API.** That includes terminal control (`/api/term/*` can type into your sessions), project/task/notes management, mail operations and addon management. If you run untrusted local software, this API is reachable by it.
- **Skill toggles are capability gates, not a security boundary.** Disabling a skill in *Settings → Agent Skills* uninstalls it and makes the API group refuse calls — that keeps cooperative agents in bounds, but a malicious local process is not stopped by a toggle.
- **Websites cannot reach it.** Every request must carry a loopback `Host`, must not look cross-site (`Origin` / `Sec-Fetch-Site`), and must use `Content-Type: application/json` — which together rule out the no-preflight "simple requests" a web page can send, and defeat DNS rebinding. The app's own webview origin is the single allowlisted exception. Rejections are logged.
- **The server binds to loopback only** and is never exposed to the network by the app. Do not port-forward, reverse-proxy or tunnel it — the checks above assume the port is local.
- **The webview runs under a strict CSP** (no inline scripts, no remote code, network limited to the local API), so injected markup cannot execute.

### Inbound webhooks

Automation rules can listen on `POST /api/hooks/<slug>`. The slug is the only secret — pick unguessable slugs and treat them like tokens if any local software is untrusted.

### Secrets on disk

`~/.cyberlife/state.json` stores integration credentials **in plaintext** (Gmail OAuth client/refresh tokens, Jira API token, ElevenLabs key), file mode 0600. Protection relies on your OS user account and disk encryption (FileVault). Anything running as you can read them.

### Addons run with full privileges

Addons are JavaScript loaded into the app's webview and can use the full agent API surface. Manifest permissions are enforced client-side for cooperative addons — they are not a sandbox. **Treat addons like browser extensions: install only code you trust or wrote.** New addons are disabled until you enable them explicitly. Addon files are served only from inside the addons directory (symlinks out of it, dotfiles and directory listings are refused).

### Outbound webhooks

Automation webhook URLs (Slack/Discord/Telegram etc.) often embed tokens. They are stored in state and never echoed by the built-in skills, but any agent with the `auto` skill can read rule definitions — by design, since agents manage automations.

## What Cyber Life does NOT do

- No telemetry, no analytics, no phoning home.
- No network listeners beyond loopback `:8377` (plus a short-lived loopback OAuth callback while linking a Gmail account, and the Wails dev server in `wails dev`).
- No credentials in the repository — bring your own keys via Settings.

## Reporting a Vulnerability

Report vulnerabilities via [GitHub Security Advisories](https://github.com/kalor62/cyberlife/security/advisories) or a GitHub issue (for non-sensitive reports). Include reproduction steps and impact. Expect an acknowledgment within a few days.
