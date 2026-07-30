# Addons

Addons extend Cyber Life without touching the core: they add widgets, whole
pages and settings sections, read from core modules over the local API, and
talk to each other on a shared event bus.

## Install one

Copy its folder into `~/.cyberlife/addons/` and enable it in
*Settings → Addons* — or ask your agent to do it (`addons_reload`,
`addons_set_enabled`; the `cyberlife-addons` skill covers the whole flow).

## Write one

Start from [`hello-world`](hello-world) — the smallest addon that registers a
widget and reads live data through `cl.api()`. The manifest fields and the
context an addon receives are documented in
[`docs/AGENT-MANUAL.md`](../docs/AGENT-MANUAL.md).

Your own addons need no PR and no review: build them locally and they load on
the next reload. To offer one as an official addon in this folder, follow the
"Submitting an official addon" checklist in
[CONTRIBUTING.md](../CONTRIBUTING.md).

## What is not here

Gmail, Jira, Voice Dictation, Project Health, Pomodoro and the iTerm2 escape
hatch are addons in the catalog too, but they ship compiled into the binary
(`internal/addons/builtin.go`) rather than as folders. They can be switched
off in *Settings → Addons* like any other.
