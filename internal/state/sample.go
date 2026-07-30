package state

import (
	"os"
	"path/filepath"
	"time"

	"github.com/google/uuid"
	"github.com/kalor62/cyberlife/internal/paths"
)

const sampleRepoReadme = `# Sample Project

This folder backs the Cyber Life Sample Project — a guided tour that lives
on your kanban board. Open the Board module (press 3 or g b) and work
through the cards. Delete the project whenever you're done with it.
`

const sampleNotes = `# Welcome to Cyber Life 👋

Three things worth knowing before anything else:

1. **Everything is keyboard-driven.** Press ` + "`?`" + ` anywhere for the
   shortcuts of the current view, and ` + "`⌘K`" + ` for the command palette —
   every palette entry shows its direct key, so it teaches you as you go.
2. **Your agent can drive all of it.** Every module you see — projects,
   the board, widgets, automations, addons — has an API through the
   built-in MCP server. Connect Claude Code with:
   ` + "`claude mcp add --transport http cyberlife http://127.0.0.1:8377/mcp`" + `
   and then simply ask for things ("create a project for ~/my-repo",
   "move that task to Done", "add a widget to my sidebar").
3. **Automations let your agent work while you sleep.** The Auto module (⚡)
   fires rules on board moves, schedules, incoming mail or webhooks — a rule
   can launch an agent session with a prompt at 3 AM. An example (disabled)
   ships with this project.

The board of this Sample Project is your onboarding checklist. Start there,
then create your own project — ideally by asking your agent to do it.
`

func sampleTask(col string, order int, title, desc, priority string) KanbanTask {
	now := time.Now()
	return KanbanTask{
		ID: uuid.New().String(), Title: title, Description: desc,
		ColumnID: col, Order: order, Priority: priority, Category: "start-here",
		CreatedAt: now, UpdatedAt: now,
	}
}

// SeedSampleData runs once on a fresh install (no projects yet): it creates
// a Sample Project whose board, notes and example automation walk the user
// through their first steps.
func (m *Manager) SeedSampleData() error {
	m.mu.Lock()
	if m.state.SampleSeeded || len(m.state.Projects) > 0 {
		m.mu.Unlock()
		return nil
	}
	m.state.SampleSeeded = true
	m.mu.Unlock()

	dir, err := paths.Sub("sample-project")
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte(sampleRepoReadme), 0o644); err != nil {
		return err
	}

	project, err := m.CreateProject("Sample Project", dir)
	if err != nil {
		return err
	}

	m.mu.Lock()
	p := m.state.Projects[project.ID]
	p.Icon = "🚀"
	p.Notes = sampleNotes
	m.ensureKanban(p)
	backlog := p.KanbanColumns[0].ID
	inProgress := p.KanbanColumns[1].ID
	done := p.KanbanColumns[2].ID
	p.KanbanTasks = []KanbanTask{
		sampleTask(inProgress, 0, "Learn the keyboard",
			"Cyber Life is fully keyboard-driven — it's worth learning the keys.\n\n"+
				"- `?` shows the shortcuts for wherever you are\n"+
				"- `⌘K` opens the command palette; every result displays its direct shortcut, so the palette teaches you\n"+
				"- `1…9` switch modules, `⇧T` reorders tabs, `⇧F` clicks anything by letters\n\n"+
				"Practice now: select this card with j/k, then press ⇧L to move it to Done.", "high"),
		sampleTask(inProgress, 1, "Connect your agent",
			"Everything you see here — projects, this board, widgets, automations, addons — "+
				"can be configured and driven by your agent through the built-in MCP server.\n\n"+
				"For Claude Code:\n`claude mcp add --transport http cyberlife http://127.0.0.1:8377/mcp`\n\n"+
				"Skills install themselves into ~/.claude/skills while the app runs. "+
				"Then just ask: \"move the 'Connect your agent' card to Done\" — and watch it happen.", "high"),
		sampleTask(backlog, 0, "Create your own project (ask your agent!)",
			"The best way to start: tell your connected agent —\n\n"+
				"> create a Cyber Life project for ~/path/to/my-repo\n\n"+
				"…or do it by hand: Projects module (2), then `n`. "+
				"Once you have your own project, feel free to delete this sample one (e on the card view → delete).", "high"),
		sampleTask(backlog, 1, "Set up an automation — your agent works while you sleep",
			"Open the Auto module (⚡). Rules fire on board moves, schedules (cron), incoming mail or webhooks, "+
				"and can launch agent sessions, move tasks, notify you, call webhooks or broadcast events to addons.\n\n"+
				"This project ships with a disabled example: \"Nightly agent (example)\" — a 03:00 rule that would "+
				"start an agent to review the day's work. Open it, adapt it, enable it.", "medium"),
		sampleTask(backlog, 2, "Make it yours with addons",
			"Addons add whole pages, widgets and integrations — like plugins in WordPress.\n\n"+
				"Browse Settings → Addons (built-in integrations live there too and can be switched off). "+
				"Then ask your agent to build one: \"build me a Cyber Life addon that tracks my habits\" — "+
				"the cyberlife-addons skill teaches it everything. Template: examples/addons/hello-world.", "medium"),
		sampleTask(backlog, 3, "Link your tools",
			"Settings → Integrations: Gmail (mail module + mail-triggered automations), Jira (board sync), "+
				"ElevenLabs (voice dictation with ⌘R). Each one is a built-in addon you can toggle.", "low"),
		sampleTask(done, 0, "Install Cyber Life",
			"Done — you're looking at it. 🎉", "low"),
	}
	m.mu.Unlock()
	m.Save()

	if _, err := m.SaveAutomationRule(AutomationRule{
		Name:      "Nightly agent (example)",
		ProjectID: project.ID,
		Enabled:   false,
		Trigger:   AutomationTrigger{Type: "cron", DailyAt: "03:00"},
		Actions: []AutomationAction{{
			Type:   "run-agent",
			Prompt: "Review yesterday's changes in this project, update the board (move finished tasks to Done, comment on progress) and leave a summary in the project notes.",
		}},
	}); err != nil {
		return err
	}

	m.SetActiveProject(project.ID)
	return nil
}
