package state

import (
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
)

const maxAutomationRuns = 200

var validTriggerTypes = map[string]bool{
	"task-status": true, "cron": true, "mail": true, "webhook": true, "manual": true,
}

var validActionTypes = map[string]bool{
	"run-agent": true, "move-task": true, "comment": true, "notify": true, "send-mail": true, "webhook": true, "emit-event": true,
}

var webhookSlugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,63}$`)

func validateAutomationRule(r *AutomationRule) error {
	if r.Name == "" {
		return fmt.Errorf("name is required")
	}
	if !validTriggerTypes[r.Trigger.Type] {
		return fmt.Errorf("unknown trigger type %q (task-status | cron | mail | manual)", r.Trigger.Type)
	}
	if r.Trigger.Type == "task-status" && r.Trigger.Column == "" {
		return fmt.Errorf("task-status trigger needs a column")
	}
	if r.Trigger.Type == "cron" && r.Trigger.EveryMinutes <= 0 && r.Trigger.DailyAt == "" {
		return fmt.Errorf("cron trigger needs everyMinutes or dailyAt")
	}
	if r.Trigger.Type == "cron" && r.Trigger.DailyAt != "" {
		if _, err := time.Parse("15:04", r.Trigger.DailyAt); err != nil {
			return fmt.Errorf("dailyAt must be HH:MM (24h)")
		}
	}
	if r.Trigger.Type == "webhook" && !webhookSlugPattern.MatchString(r.Trigger.Slug) {
		return fmt.Errorf("webhook trigger needs a slug (lowercase letters, digits, dashes)")
	}
	if len(r.Actions) == 0 {
		return fmt.Errorf("at least one action is required")
	}
	for _, a := range r.Actions {
		if !validActionTypes[a.Type] {
			return fmt.Errorf("unknown action type %q (run-agent | move-task | comment | notify | send-mail | webhook | emit-event)", a.Type)
		}
		if a.Type == "webhook" && !strings.HasPrefix(a.URL, "http") {
			return fmt.Errorf("webhook action needs a valid url")
		}
	}
	return nil
}

func (m *Manager) GetAutomationRules() []AutomationRule {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return append([]AutomationRule{}, m.state.Automations...)
}

func (m *Manager) GetAutomationRule(id string) (AutomationRule, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, r := range m.state.Automations {
		if r.ID == id {
			return r, true
		}
	}
	return AutomationRule{}, false
}

func (m *Manager) SaveAutomationRule(r AutomationRule) (AutomationRule, error) {
	if err := validateAutomationRule(&r); err != nil {
		return AutomationRule{}, err
	}
	if r.ProjectID != "" {
		if _, ok := m.ResolveProject(r.ProjectID); !ok {
			return AutomationRule{}, fmt.Errorf("project %q not found", r.ProjectID)
		}
	}
	now := time.Now()
	r.UpdatedAt = now
	m.mu.Lock()
	if r.ID == "" {
		r.ID = uuid.New().String()
		r.CreatedAt = now
		m.state.Automations = append(m.state.Automations, r)
	} else {
		found := false
		for i := range m.state.Automations {
			if m.state.Automations[i].ID == r.ID {
				r.CreatedAt = m.state.Automations[i].CreatedAt
				r.LastRunAt = m.state.Automations[i].LastRunAt
				m.state.Automations[i] = r
				found = true
				break
			}
		}
		if !found {
			m.mu.Unlock()
			return AutomationRule{}, os.ErrNotExist
		}
	}
	m.mu.Unlock()
	m.Save()
	return r, nil
}

func (m *Manager) DeleteAutomationRule(id string) error {
	m.mu.Lock()
	rules := m.state.Automations[:0]
	for _, r := range m.state.Automations {
		if r.ID != id {
			rules = append(rules, r)
		}
	}
	if len(rules) == len(m.state.Automations) {
		m.mu.Unlock()
		return os.ErrNotExist
	}
	m.state.Automations = rules
	m.mu.Unlock()
	m.Save()
	return nil
}

func (m *Manager) SetAutomationRuleEnabled(id string, enabled bool) error {
	m.mu.Lock()
	found := false
	for i := range m.state.Automations {
		if m.state.Automations[i].ID == id {
			m.state.Automations[i].Enabled = enabled
			m.state.Automations[i].UpdatedAt = time.Now()
			found = true
			break
		}
	}
	m.mu.Unlock()
	if !found {
		return os.ErrNotExist
	}
	m.Save()
	return nil
}

func (m *Manager) TouchAutomationRule(id string, at time.Time) {
	m.mu.Lock()
	for i := range m.state.Automations {
		if m.state.Automations[i].ID == id {
			t := at
			m.state.Automations[i].LastRunAt = &t
			break
		}
	}
	m.mu.Unlock()
	m.Save()
}

// AppendAutomationRun prepends a run record and trims the log to its cap
func (m *Manager) AppendAutomationRun(run AutomationRun) AutomationRun {
	if run.ID == "" {
		run.ID = uuid.New().String()
	}
	if run.StartedAt.IsZero() {
		run.StartedAt = time.Now()
	}
	m.mu.Lock()
	m.state.AutomationRuns = append([]AutomationRun{run}, m.state.AutomationRuns...)
	if len(m.state.AutomationRuns) > maxAutomationRuns {
		m.state.AutomationRuns = m.state.AutomationRuns[:maxAutomationRuns]
	}
	m.mu.Unlock()
	m.Save()
	return run
}

func (m *Manager) GetAutomationRuns(limit int) []AutomationRun {
	m.mu.RLock()
	defer m.mu.RUnlock()
	runs := m.state.AutomationRuns
	if limit > 0 && limit < len(runs) {
		runs = runs[:limit]
	}
	return append([]AutomationRun{}, runs...)
}
