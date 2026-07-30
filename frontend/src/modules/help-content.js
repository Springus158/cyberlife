// Hand-maintained Help guides. Authored with the help component syntax
// (see help-components.js): :::tip/:::warning/:::steps/:::cards blocks,
// [[kbd:...]], [[badge:...]], [[tip:text|tooltip]] inline tokens.
// Keep these current as features ship — every stage that changes UX
// should touch this file.

export const HELP_GUIDES = [
  {
    id: 'getting-started',
    title: 'Getting Started',
    body: `
# Getting Started

Cyber Life is a keyboard-first control center for your projects, Claude
sessions, mail and tasks. Everything lives in full-screen **modules** on the
top bar.

## Connect your agent

Do this first — the whole point of Cyber Life is that your agent can drive
it. The app runs a local API while it is open, and one command gives Claude
Code the **general MCP** (board, health, automations, widgets — more groups
as features ship):

\`\`\`bash
claude mcp add --transport http cyberlife http://127.0.0.1:8377/mcp
\`\`\`

Built-in skills install automatically to \`~/.claude/skills\`, so every
agent already knows the REST fallback — other runners just curl
\`http://127.0.0.1:8377/api/…\`. Permissions live in
**Settings → Agent Skills**.

:::info Agents can extend the system itself
The repository ships an **agent manual** — \`docs/AGENT-MANUAL.md\` — with
the architecture map, hard rules and step-by-step checklists for adding
modules, widgets and agent capabilities. Point any agent working on
Cyber Life's own code at that file first.
:::

:::keyboard The three modes
The status bar (bottom) always shows where you are:

- **NORMAL** — letters are commands. This is where you live.
- **INSERT** — you are typing in a field. [[kbd:Esc]] returns to NORMAL.
- **TERM** — every key goes straight to the session. Attach with [[kbd:a]],
  leave with [[kbd:Ctrl U]]. A blinking block cursor and a yellow outline
  mean you are attached.
:::

:::cards
### 🚀 Move fast
[[kbd:1]]–[[kbd:9]] switch modules, [[kbd:g]]+letter jumps by mnemonic,
[[kbd:← →]] cycle.

### 🎯 Click by letters
[[kbd:⇧ F]] overlays hint labels on everything clickable — type the
letters, it clicks. No mouse needed, ever.

### 📋 Lists feel the same
[[kbd:j k]] move, [[kbd:Enter]] opens, single letters act — the same grammar
in Mail, Board, Projects and Help.

### ❓ Help is contextual
[[kbd:?]] opens the shortcut card for the module you are on;
[[kbd:j k]] peeks at other sections without closing.

### ⌘K Command palette
Search modules, projects and every action — each result shows its
direct shortcut, so the palette teaches you the keys as you use it.
:::

## A typical loop

:::steps
1. [[kbd:1]] **Projects** — pick a project or a running session ([[kbd:j k Enter]])
2. [[kbd:3]] **Term** — watch the session; [[kbd:Enter]] or [[kbd:i]] to write a prompt
3. [[kbd:2]] **Board** — track work; agents update it for you
4. [[kbd:7]] **Mail** — inbox with Gmail keys ([[kbd:e]] archive, [[kbd:#]] trash, [[kbd:z]] undo)
:::
`,
  },
  {
    id: 'terminal',
    title: 'Terminal & tmux',
    body: `
# Terminal & tmux

Claude sessions run inside **tmux** — they survive app restarts and crashes.
Cyber Life streams their content directly over
[[tip:tmux control mode|tmux -C: a text protocol that pushes output events to the app with ~60ms latency]]
— styled output with 256/truecolor, no iTerm2 dependency.

:::tip Scrollback just works
History preloads when you open a session, scrolling to the very top loads
more, and the view **freezes while you read** — the live stream resumes when
you return to the bottom. App-created sessions keep 50k lines of history.
:::

:::keyboard On the Term module
- [[kbd:j k]] switch the viewed session
- [[kbd:n]] new terminal · [[kbd:o]] open in iTerm2
- [[kbd:a]] / [[kbd:i]] / [[kbd:Enter]] attach (TERM mode) · [[kbd:Ctrl U]] detach
- [[kbd:m]] (or [[kbd:⌘ M]] from any mode) terminal menu — voice input, saved prompts, voice settings
:::

:::warning iTerm2 is optional
Sessions appear and stream even with iTerm2 closed. The ⤴ button (or
[[kbd:o]]) opens a real terminal window on demand.
:::

Global prompt prefix/suffix (Settings → Global Prompts) wraps prompts sent
from the terminal menu and voice input.
`,
  },
  {
    id: 'board-agents',
    title: 'Board & Agents',
    body: `
# Board & Agents

The Board ([[kbd:2]]) is a per-project kanban. Columns are managed with
[[kbd:C]] — add, rename, reorder, delete, and set a
[[tip:WIP limit|Work-In-Progress cap; the column counter turns red when exceeded]]
per column.

:::danger You are not the only editor
Agents control the board through a local API that starts with the app —
they create tasks, move them and comment as they work. Changes repaint
the board **live**.
:::

## Wire up an agent

Claude Code — one command registers the **general Cyber Life MCP**
(\`board_*\`, \`health_*\`, \`auto_*\`, \`widgets_*\`, \`term_*\`,
\`projects_*\`, \`tasks_*\`, \`notes_*\`, \`prompts_*\`, \`system_info\`):

\`\`\`bash
claude mcp add --transport http cyberlife http://127.0.0.1:8377/mcp
\`\`\`

Any other model that can curl — the REST API (documented in the built-in
\`cyberlife-board\` skill, installed automatically to \`~/.claude/skills\`):

\`\`\`bash
curl -s "http://127.0.0.1:8377/api/board?project=$PWD"
\`\`\`

:::info Permissions
**Settings → Agent Skills** is the gate: disabling a skill uninstalls it
and its API returns 403. Agents physically lose access, not just the docs.
:::

:::hint Conventions agents follow
Comment when moving a task to **Done** · never delete without being asked ·
archive instead ([[kbd:x]] for humans, \`{"archived": true}\` for agents).
:::
`,
  },
  {
    id: 'widgets',
    title: 'Widgets & Dash',
    body: `
# Widgets & Dash

Widgets are small live views — board summary, recent automation runs,
unread mail, git status, pomodoro, prompt history. They live in two places:

## Right sidebar

An ordered stack of widgets, configured in **Settings → Widgets**. Each
widget is either **🌐 Global** (shown in every project) or scoped to the
**current project only** — the sidebar shows global widgets first, then
the project's own, and swaps automatically when you switch projects.

[[kbd:w]] collapses it to a narrow **icon strip** — click an icon (or
[[kbd:w]] again) to expand; the strip icon scrolls straight to its widget.

## Dash — custom dashboards

The **Dash** module ([[kbd:g]][[kbd:w]]) holds user-named tabs of widgets.
**HOME** is the built-in default; create more with [[kbd:n]] (name, icon,
widget picker).

:::steps
1. [[kbd:g]][[kbd:w]] open Dash — [[kbd:h]]/[[kbd:l]] switch dashboards
2. [[kbd:n]] new dashboard, [[kbd:e]] edit the current one
3. Pick widgets — only instance-safe ones can live on dashboards
   (sidebar-only widgets are marked in Settings)
:::

:::info Agents configure this too
The \`cyberlife-widgets\` skill exposes \`widgets_*\` tools: catalog,
sidebar order, dashboards. Ask an agent to "build me an Ops dashboard
with board and automations" and it will. Changes appear live.
:::
`,
  },
  {
    id: 'automations',
    title: 'Automations',
    body: `
# Automations

A rule is **one trigger + a list of actions**, scoped to a single project
or **global** (no project = applies everywhere). The engine runs inside
the app and logs every execution with links to the session, task or mail
thread it touched.

## Triggers

| Trigger | Fires when | Config |
|---|---|---|
| \`task-status\` | a board task enters a column | column (name or id) |
| \`cron\` | on a schedule | \`everyMinutes\` or \`dailyAt: "HH:MM"\` |
| \`mail\` | a new inbox thread arrives | account, from/subject filters |
| \`webhook\` | POST hits \`/api/hooks/<slug>\` | slug; JSON fields become \`{{hook.*}}\` |
| \`manual\` | only via **Run now** | — |

## Actions

| Action | Does | Key fields |
|---|---|---|
| \`run-agent\` | launches an agent session with a prompt | runner, prompt, workDir |
| \`move-task\` | moves the triggering task | column |
| \`comment\` | comments on the triggering task | text |
| \`notify\` | desktop notification | title, message |
| \`send-mail\` | sends through a linked Gmail account | to, subject, body |
| \`webhook\` | calls any HTTP endpoint — Slack, Discord, Telegram, your services | url, method, JSON body |

:::tip Placeholders
Text fields expand \`{{task.title}}\`, \`{{task.id}}\`, \`{{column}}\`,
\`{{project.name}}\`, \`{{project.path}}\`, \`{{mail.from}}\`,
\`{{mail.subject}}\` and \`{{rule.name}}\` at run time.
:::

:::info run-agent uses runners
The action launches any configured runner (Settings → Runners) — the
prompt is passed on the command line, the session opens as a normal Term
tab named \`auto <rule>\`.
:::

:::tip Communicators, without vendor lock-in
Slack, Discord and Telegram all speak incoming webhooks — paste the URL
into a \`webhook\` action and template the JSON body. Inbound, anything
that can POST (git hooks, CI, scripts, other agents) fires
\`/api/hooks/<slug>\` on the local API.
:::

:::danger No cascades
A task move made **by** an automation never fires other rules — chains
must be explicit (one rule, several actions).
:::

## Agents manage rules too

The \`cyberlife-auto\` skill (Settings → Agent Skills) exposes the
\`auto_*\` MCP group:

\`\`\`text
auto_list_rules   → existing rules (global + per project)
auto_save_rule    → create or update a rule
auto_run_rule     → execute now, returns the run record
auto_list_runs    → history with status + linked ids
auto_set_enabled  → pause/resume without deleting
\`\`\`

:::hint Try it
Ask an agent: *"when a task enters Done in this project, comment with a
summary and notify me"* — it creates the rule via \`auto_save_rule\`.
:::
`,
  },
  {
    id: 'health',
    title: 'Health',
    body: `
# Health

Health lives inside **Projects**: the detail pane shows category tags for
the focused project, and [[kbd:⇧ H]] (or the Configure button, or
[[kbd:g]][[kbd:h]]) opens the full view — [[kbd:Esc]] returns to Projects.

It is a **universal, configurable check system**. A library
holds predefined checks grouped by stack — generic, Node.js, Next.js,
Express, Go, Java — plus your custom ones. Each project tracks only the
subset you pick: Next.js ships ~30 checks, your project may track 5.

:::steps
1. [[kbd:c]] opens **Configure** — the library grouped by stack, with
   \`all\` / \`none\` per stack and a [[kbd:/]] filter
2. Tick the checks that matter for this project — the selection saves
   per project
3. Back in the **Report** ([[kbd:c]] again): auto checks evaluate
   themselves, manual ones are checkboxes; [[kbd:r]] re-scans
:::

:::info Two kinds of checks
**auto** — evaluated by Cyber Life (files, deps, CI content, logging
analysis). **manual** — a human or an agent verifies and ticks them.
:::

:::danger Custom checks have an evaluator: the agent
A custom check without a script behind it would be a dead checkbox — so
agents are the script. The \`cyberlife-health\` skill teaches every
agent to define checks, verify them against the codebase and record the
result with a comment (the audit trail).
:::

## Agent workflow (health_* MCP tools / REST)

\`\`\`text
health_get_report   → what the project tracks, what is red
health_library      → every available check with its id
health_track        → {add:[...], remove:[...]} change the tracked set
health_add_check    → define a custom check (title, stack, category)
health_set_check    → after real verification: passed + comment + author
\`\`\`

:::hint Conventions
Never set a check to passed without verifying it · comments must say what
was inspected · auto checks are read-only for agents.
:::
`,
  },
  {
    id: 'mail',
    title: 'Mail',
    body: `
# Mail

Gmail accounts are configured in **Settings → Gmail** (OAuth per account).
The unread count shows as a red [[badge:3]] badge on the Mail tab.

:::keyboard Gmail muscle memory
- [[kbd:j k]] move · [[kbd:Enter]] / [[kbd:o]] open · [[kbd:Esc]] closes the reading pane
- [[kbd:e]] archive · [[kbd:#]] trash — both with a 5-second undo ([[kbd:z]])
- [[kbd:u]] read toggle · [[kbd:s]] star · [[kbd:c]] compose · [[kbd:r]] refresh · [[kbd:/]] search
- [[kbd:a]] reply all · [[kbd:⇧R]] reply · [[kbd:f]] forward
- [[kbd:x]] select the thread · [[kbd:*]] select every thread on the page
:::

:::tip Mail is light by default
Mail mirrors Gmail's light chrome even though the rest of the app is dark —
the sun/moon button in its top bar switches it and the choice sticks.
:::

:::tip Claude drafts replies
From the reading pane, the Claude button drafts a reply in your voice —
review and send from the draft editor.
:::
`,
  },
];
