# Cyber Bot 🤖

A Grok-style chat bot for Cyber Life. You talk to it in a chat tab; it answers
through a **Cyber Life agent session** (no external API key of its own) and is
**aware of your active project, board and notes** — the same way `@grok` reads
the tagged post before replying.

## What you get

- **Chat tab "Cyber Bot"** (`💬 Czat`) — scrollable conversation, markdown replies.
- **`🕑 Historia`** page — recent questions, clearable.
- **Widget "Zapytaj Cyber Bota"** — a quick-ask box for the sidebar / a dashboard.
- **Agent tool `cyber-bot_ask`** (MCP) — any other agent or automation can summon
  the bot, e.g. `run cyber-bot_ask {message:"..."}` — the `@grok` analog.
- **Persona presets** (Zadziorny / Rzeczowy / Mentor) + a custom persona, in
  *Settings → Cyber Bot*.

## How the "brain" works

For each message the addon:
1. reads your context (`/api/system`, `/api/board`, `/api/notes`),
2. builds a prompt = persona preamble + context snapshot + your message,
3. spawns a runner session via `/api/term/create`,
4. polls the pane and streams the reply back, stopping at a completion marker.

Everything runs on the Cyber Life agent runner (Claude Code), so it uses
whatever that CLI is already authenticated with.

## Requirement: the "Cyber Bot (auto)" runner

`/api/term` sessions are built for long-lived interactive agents, not clean
request/response. The default interactive `claude` runner (a) stops at the
"trust this folder" prompt and (b) is a full TUI. So the bot prefers a small
**print-mode wrapper runner** that produces a clean, self-terminating answer.

Add it once in **Settings → Runners** (or it may already exist from setup):

| Field | Value |
|-------|-------|
| Name | `Cyber Bot (auto)` |
| Command | `sh` |
| Args | `-c 'claude -p "$0" 2>&1; printf "\n<<<CBEND>>>\n"; exec sleep 86400'` |

The wrapper runs `claude -p <prompt>` (print mode — skips the trust gate, prints
just the answer), then prints `<<<CBEND>>>` and keeps the pane alive so the
addon can read the result before closing the session. The addon auto-selects
this runner when it exists; otherwise pick one in *Settings → Cyber Bot*.

## Storage & limits

Conversation history lives in the addon's `cl.storage` (per-addon KV, capped at
256 keys × 64 KB). The addon keeps the last ~60 messages.

## Notes

- Replies render as markdown (a small built-in renderer — no external deps).
- With a non-wrapper runner selected, the bot falls back to best-effort pane
  scraping and idle detection; output is cleanest with the wrapper runner above.
- Colours come only from the app theme tokens, so it follows every Cyber Life
  theme.
