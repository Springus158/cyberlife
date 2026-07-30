# Contributing to Cyber Life

Cyber Life has a deliberately split contribution model: **a gate-kept core and an open addon edge**. Read this first — it decides where your work should go.

## The model

### Core is gate-kept — PRs welcome, review is thorough

The core (everything in this repo outside `addons/` and `examples/`) stays small, coherent and keyboard-first. Core PRs are welcome, with expectations:

1. **For anything non-trivial, open an issue first.** Describing the problem and approach before writing code saves everyone a rewrite.
2. **Expect a thorough, conservative review.** The core is a platform every addon builds on — correctness, keyboard support, conventions and scope are all checked, and changes that belong in an addon will be redirected there.
3. Bug fixes with a clear reproduction are the easiest PRs to land.

### Addons are yours — no permission needed

Most ideas belong in an addon, not in core. Addons live in `~/.cyberlife/addons/` on your machine, need no PR, no review and no waiting — build whatever you want. See `docs/AGENT-MANUAL.md` and `examples/addons/hello-world` for the SDK, or just ask your connected agent to scaffold one (`cyberlife-addons` skill).

### Submitting an official addon

If you want your addon shipped with Cyber Life, submit a PR adding a folder under `addons/`. Review checklist:

- [ ] Valid `addon.json` (id = folder name, name, icon, version, description, category, tags)
- [ ] `permissions` lists only the API groups the addon actually calls
- [ ] No secrets, no hardcoded personal paths, no network calls to undisclosed services
- [ ] English-only UI strings; keyboard support for interactive pages (onKey)
- [ ] Works against the current release (state what version you tested)
- [ ] A short README.md inside the addon folder (what it does, how to use it)

## Development setup

```bash
go install github.com/wailsapp/wails/v2/cmd/wails@latest
cd frontend && npm install && cd ..
bash build.sh          # full build (regenerates Wails bindings)
wails dev              # hot-reload development
```

Note: new Go bindings require a full `bash build.sh` once — an npm-only build fails on missing bindings.

## Code style (core)

- **Go**: `gofmt`, explicit error handling; every `catch`/suppressed error must be logged with context.
- **JS**: ES6 modules, vanilla (no framework in core), single-purpose modules; UI strings in English only.
- **Comments**: only for non-obvious *why* — prefer extracting a well-named function over describing a block. No comments that restate the code.
- **Keyboard-first**: every clickable control gets a tooltip that includes its shortcut, and new keys go into `shortcuts-data.js`.
- **Escaping**: use `escapeHtml`/`escapeAttr` from `utils.js`; no inline `on*=` handlers (use `data-act` + delegation).
- **Before pushing**: `go test ./internal/...`, `golangci-lint run ./...`, `cd frontend && npm run lint`.

## Commit messages

`feat:` / `fix:` / `docs:` / `refactor:` / `test:` / `chore:` — clear and scoped, e.g. `feat: addon storage quota`.

## Reporting issues

Include: OS and version, Go/Node versions, steps to reproduce, expected vs actual, screenshots if visual. For security reports see [SECURITY.md](SECURITY.md).

## License

By contributing you agree your contributions are licensed under the MIT License.
