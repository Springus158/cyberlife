package state

import (
	"fmt"
	"os"

	"github.com/google/uuid"
)

func defaultWidgetSettings() *WidgetSettings {
	return &WidgetSettings{Sidebar: []string{"git", "pomodoro"}}
}

func (m *Manager) GetWidgetSettings() WidgetSettings {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.state.Widgets == nil {
		return *defaultWidgetSettings()
	}
	out := *m.state.Widgets
	out.Sidebar = append([]string{}, m.state.Widgets.Sidebar...)
	return out
}

func (m *Manager) SetWidgetSettings(s WidgetSettings) {
	m.mu.Lock()
	m.state.Widgets = &s
	m.mu.Unlock()
	m.Save()
}

func (m *Manager) GetProjectWidgets(projectID string) []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if p, ok := m.state.Projects[projectID]; ok {
		return append([]string{}, p.SidebarWidgets...)
	}
	return nil
}

func (m *Manager) SetProjectWidgets(projectID string, ids []string) error {
	m.mu.Lock()
	p, ok := m.state.Projects[projectID]
	if !ok {
		m.mu.Unlock()
		return os.ErrNotExist
	}
	p.SidebarWidgets = ids
	m.mu.Unlock()
	m.Save()
	return nil
}

func (m *Manager) GetModuleOrder() []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return append([]string{}, m.state.ModuleOrder...)
}

func (m *Manager) SetModuleOrder(ids []string) {
	m.mu.Lock()
	m.state.ModuleOrder = ids
	m.mu.Unlock()
	m.Save()
}

func (m *Manager) GetHiddenModules() []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return append([]string{}, m.state.HiddenModules...)
}

func (m *Manager) SetHiddenModules(ids []string) {
	m.mu.Lock()
	m.state.HiddenModules = ids
	m.mu.Unlock()
	m.Save()
}

func defaultHomeDashboard() Dashboard {
	return Dashboard{
		ID:      "home",
		Name:    "HOME",
		Icon:    "🏠",
		Widgets: []string{"board-summary", "recent-automations", "unread-mail"},
	}
}

// GetDashboards always returns HOME first; it is created on first read
func (m *Manager) GetDashboards() []Dashboard {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := []Dashboard{}
	hasHome := false
	for _, d := range m.state.Dashboards {
		if d.ID == "home" {
			hasHome = true
			out = append([]Dashboard{d}, out...)
		} else {
			out = append(out, d)
		}
	}
	if !hasHome {
		out = append([]Dashboard{defaultHomeDashboard()}, out...)
	}
	return out
}

func (m *Manager) SaveDashboard(d Dashboard) (Dashboard, error) {
	if d.Name == "" {
		return Dashboard{}, fmt.Errorf("name is required")
	}
	m.mu.Lock()
	if d.ID == "" {
		d.ID = uuid.New().String()
		m.state.Dashboards = append(m.state.Dashboards, d)
	} else {
		found := false
		for i := range m.state.Dashboards {
			if m.state.Dashboards[i].ID == d.ID {
				m.state.Dashboards[i] = d
				found = true
				break
			}
		}
		// HOME exists virtually until first customized — materialize it
		if !found && d.ID == "home" {
			m.state.Dashboards = append(m.state.Dashboards, d)
			found = true
		}
		if !found {
			m.mu.Unlock()
			return Dashboard{}, os.ErrNotExist
		}
	}
	m.mu.Unlock()
	m.Save()
	return d, nil
}

func (m *Manager) DeleteDashboard(id string) error {
	if id == "home" {
		return fmt.Errorf("the HOME dashboard cannot be deleted")
	}
	m.mu.Lock()
	dashboards := m.state.Dashboards[:0]
	for _, d := range m.state.Dashboards {
		if d.ID != id {
			dashboards = append(dashboards, d)
		}
	}
	m.state.Dashboards = dashboards
	m.mu.Unlock()
	m.Save()
	return nil
}
