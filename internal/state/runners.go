package state

import (
	"fmt"
	"os"

	"github.com/google/uuid"
)

// ClaudeRunnerID is the built-in default runner
const ClaudeRunnerID = "claude"

func builtinClaudeRunner() Runner {
	return Runner{
		ID:      ClaudeRunnerID,
		Name:    "Claude",
		Command: "claude",
		Icon:    "✳️",
		Color:   "#d97757",
		BuiltIn: true,
	}
}

// GetRunners returns the built-in Claude runner followed by user-defined ones
func (m *Manager) GetRunners() []Runner {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := []Runner{builtinClaudeRunner()}
	out = append(out, m.state.Runners...)
	return out
}

// GetRunner resolves a runner by ID; empty or unknown falls back to Claude
func (m *Manager) GetRunner(id string) Runner {
	for _, r := range m.GetRunners() {
		if r.ID == id {
			return r
		}
	}
	return builtinClaudeRunner()
}

func (m *Manager) SaveRunner(r Runner) (Runner, error) {
	if r.ID == ClaudeRunnerID || r.BuiltIn {
		return Runner{}, fmt.Errorf("the built-in Claude runner cannot be edited")
	}
	if r.Name == "" || r.Command == "" {
		return Runner{}, fmt.Errorf("name and command are required")
	}
	m.mu.Lock()
	if r.ID == "" {
		r.ID = uuid.New().String()
		m.state.Runners = append(m.state.Runners, r)
	} else {
		found := false
		for i := range m.state.Runners {
			if m.state.Runners[i].ID == r.ID {
				m.state.Runners[i] = r
				found = true
				break
			}
		}
		if !found {
			m.mu.Unlock()
			return Runner{}, os.ErrNotExist
		}
	}
	m.mu.Unlock()
	m.Save()
	return r, nil
}

func (m *Manager) DeleteRunner(id string) error {
	if id == ClaudeRunnerID {
		return fmt.Errorf("the built-in Claude runner cannot be deleted")
	}
	m.mu.Lock()
	runners := m.state.Runners[:0]
	for _, r := range m.state.Runners {
		if r.ID != id {
			runners = append(runners, r)
		}
	}
	m.state.Runners = runners
	m.mu.Unlock()
	m.Save()
	return nil
}

func (m *Manager) GetTerminalRunners() map[string]string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := map[string]string{}
	for k, v := range m.state.TerminalRunners {
		out[k] = v
	}
	return out
}

func (m *Manager) SetTerminalRunner(sessionID, runnerID string) {
	m.mu.Lock()
	if m.state.TerminalRunners == nil {
		m.state.TerminalRunners = map[string]string{}
	}
	if runnerID == "" || runnerID == ClaudeRunnerID {
		delete(m.state.TerminalRunners, sessionID)
	} else {
		m.state.TerminalRunners[sessionID] = runnerID
	}
	m.mu.Unlock()
	m.Save()
}
