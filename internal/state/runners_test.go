package state

import (
	"path/filepath"
	"testing"
)

func testManager(t *testing.T) *Manager {
	t.Helper()
	return &Manager{
		state:     NewAppState(),
		statePath: filepath.Join(t.TempDir(), "state.json"),
	}
}

func TestResolveDefaultRunnerFallsBackToClaude(t *testing.T) {
	m := testManager(t)
	if got := m.ResolveDefaultRunner(""); got != ClaudeRunnerID {
		t.Fatalf("empty state: got %q, want %q", got, ClaudeRunnerID)
	}
}

func TestResolveDefaultRunnerGlobalThenProject(t *testing.T) {
	m := testManager(t)
	grok, err := m.SaveRunner(Runner{Name: "Grok", Command: "grok"})
	if err != nil {
		t.Fatal(err)
	}
	codex, err := m.SaveRunner(Runner{Name: "Codex", Command: "codex"})
	if err != nil {
		t.Fatal(err)
	}
	if err := m.SetDefaultRunner(grok.ID); err != nil {
		t.Fatal(err)
	}
	if got := m.ResolveDefaultRunner(""); got != grok.ID {
		t.Fatalf("global: got %q, want %q", got, grok.ID)
	}

	m.state.Projects["p1"] = NewProjectState("p1", "Alpha", "/tmp/alpha", "#000", "📁")
	m.state.Projects["p1"].DefaultRunner = codex.ID
	if got := m.ResolveDefaultRunner("p1"); got != codex.ID {
		t.Fatalf("project override: got %q, want %q", got, codex.ID)
	}

	m.state.Projects["p2"] = NewProjectState("p2", "Beta", "/tmp/beta", "#000", "📁")
	if got := m.ResolveDefaultRunner("p2"); got != grok.ID {
		t.Fatalf("project inherit: got %q, want %q", got, grok.ID)
	}

	m.state.Projects["p2"].DefaultRunner = ClaudeRunnerID
	if got := m.ResolveDefaultRunner("p2"); got != ClaudeRunnerID {
		t.Fatalf("project forces claude: got %q, want %q", got, ClaudeRunnerID)
	}
}

func TestResolveDefaultRunnerForPath(t *testing.T) {
	m := testManager(t)
	grok, err := m.SaveRunner(Runner{Name: "Grok", Command: "grok"})
	if err != nil {
		t.Fatal(err)
	}
	m.state.Projects["p1"] = NewProjectState("p1", "Alpha", "/tmp/alpha", "#000", "📁")
	m.state.Projects["p1"].DefaultRunner = grok.ID

	if got := m.ResolveDefaultRunnerForPath("/tmp/alpha/src"); got != grok.ID {
		t.Fatalf("nested path: got %q, want %q", got, grok.ID)
	}
	if got := m.ResolveDefaultRunnerForPath("/tmp/other"); got != ClaudeRunnerID {
		t.Fatalf("unknown path: got %q, want %q", got, ClaudeRunnerID)
	}
}

func TestDeleteRunnerClearsDefaults(t *testing.T) {
	m := testManager(t)
	grok, err := m.SaveRunner(Runner{Name: "Grok", Command: "grok"})
	if err != nil {
		t.Fatal(err)
	}
	if err := m.SetDefaultRunner(grok.ID); err != nil {
		t.Fatal(err)
	}
	m.state.Projects["p1"] = NewProjectState("p1", "Alpha", "/tmp/alpha", "#000", "📁")
	m.state.Projects["p1"].DefaultRunner = grok.ID
	m.state.TerminalRunners = map[string]string{"sess-1": grok.ID}

	if err := m.DeleteRunner(grok.ID); err != nil {
		t.Fatal(err)
	}
	if got := m.GetDefaultRunner(); got != "" {
		t.Fatalf("global default survived delete: %q", got)
	}
	if got := m.state.Projects["p1"].DefaultRunner; got != "" {
		t.Fatalf("project default survived delete: %q", got)
	}
	if _, ok := m.GetTerminalRunners()["sess-1"]; ok {
		t.Fatal("terminal runner survived delete")
	}
	if got := m.ResolveDefaultRunner("p1"); got != ClaudeRunnerID {
		t.Fatalf("after delete: got %q, want %q", got, ClaudeRunnerID)
	}
}

func TestSetDefaultRunnerRejectsUnknown(t *testing.T) {
	m := testManager(t)
	if err := m.SetDefaultRunner("missing"); err == nil {
		t.Fatal("expected error for unknown runner")
	}
	if err := m.SetDefaultRunner(ClaudeRunnerID); err != nil {
		t.Fatal(err)
	}
	if got := m.GetDefaultRunner(); got != "" {
		t.Fatalf("claude should store empty, got %q", got)
	}
}
