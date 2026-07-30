package state

import (
	"fmt"
	"os"
	"sort"
	"time"

	"github.com/google/uuid"
)

func defaultKanbanColumns() []KanbanColumn {
	return []KanbanColumn{
		{ID: uuid.New().String(), Name: "Backlog", Order: 0},
		{ID: uuid.New().String(), Name: "In Progress", Order: 1},
		{ID: uuid.New().String(), Name: "Done", Order: 2},
	}
}

// ensureKanban gives a project its default columns on first board use.
// Caller must hold the write lock. Returns true when state changed.
func (m *Manager) ensureKanban(project *ProjectState) bool {
	if len(project.KanbanColumns) > 0 {
		return false
	}
	project.KanbanColumns = defaultKanbanColumns()
	return true
}

func (m *Manager) GetKanban(projectID string) ([]KanbanColumn, []KanbanTask, error) {
	m.mu.Lock()
	project, ok := m.state.Projects[projectID]
	if !ok {
		m.mu.Unlock()
		return nil, nil, os.ErrNotExist
	}
	migrated := m.ensureKanban(project)
	columns := append([]KanbanColumn{}, project.KanbanColumns...)
	tasks := append([]KanbanTask{}, project.KanbanTasks...)
	m.mu.Unlock()

	if migrated {
		m.Save()
	}
	sort.Slice(columns, func(i, j int) bool { return columns[i].Order < columns[j].Order })
	sort.Slice(tasks, func(i, j int) bool { return tasks[i].Order < tasks[j].Order })
	return columns, tasks, nil
}

func (m *Manager) UpsertKanbanTask(projectID string, task KanbanTask) (KanbanTask, error) {
	m.mu.Lock()
	project, ok := m.state.Projects[projectID]
	if !ok {
		m.mu.Unlock()
		return KanbanTask{}, os.ErrNotExist
	}
	m.ensureKanban(project)

	now := time.Now()
	task.UpdatedAt = now

	if task.ColumnID == "" {
		task.ColumnID = project.KanbanColumns[0].ID
	}

	if task.ID == "" {
		task.ID = uuid.New().String()
		task.CreatedAt = now
		task.Order = len(m.tasksInColumn(project, task.ColumnID))
		project.KanbanTasks = append(project.KanbanTasks, task)
	} else {
		found := false
		for i := range project.KanbanTasks {
			if project.KanbanTasks[i].ID == task.ID {
				task.CreatedAt = project.KanbanTasks[i].CreatedAt
				task.Order = project.KanbanTasks[i].Order
				if project.KanbanTasks[i].ColumnID != task.ColumnID {
					task.Order = len(m.tasksInColumn(project, task.ColumnID))
				}
				project.KanbanTasks[i] = task
				found = true
				break
			}
		}
		if !found {
			m.mu.Unlock()
			return KanbanTask{}, fmt.Errorf("task %s not found", task.ID)
		}
	}
	m.mu.Unlock()

	m.Save()
	return task, nil
}

func (m *Manager) tasksInColumn(project *ProjectState, columnID string) []*KanbanTask {
	var tasks []*KanbanTask
	for i := range project.KanbanTasks {
		if project.KanbanTasks[i].ColumnID == columnID && !project.KanbanTasks[i].Archived {
			tasks = append(tasks, &project.KanbanTasks[i])
		}
	}
	sort.Slice(tasks, func(i, j int) bool { return tasks[i].Order < tasks[j].Order })
	return tasks
}

// MoveKanbanTask places a task at index within columnID and renumbers both
// affected columns
func (m *Manager) MoveKanbanTask(projectID, taskID, columnID string, index int) error {
	m.mu.Lock()
	project, ok := m.state.Projects[projectID]
	if !ok {
		m.mu.Unlock()
		return os.ErrNotExist
	}

	var moved *KanbanTask
	for i := range project.KanbanTasks {
		if project.KanbanTasks[i].ID == taskID {
			moved = &project.KanbanTasks[i]
			break
		}
	}
	if moved == nil {
		m.mu.Unlock()
		return fmt.Errorf("task %s not found", taskID)
	}

	fromColumn := moved.ColumnID
	moved.ColumnID = columnID
	moved.UpdatedAt = time.Now()

	target := m.tasksInColumn(project, columnID)
	// Remove the moved task from its current position in the target ordering
	filtered := target[:0]
	for _, t := range target {
		if t.ID != taskID {
			filtered = append(filtered, t)
		}
	}
	if index < 0 {
		index = 0
	}
	if index > len(filtered) {
		index = len(filtered)
	}
	order := 0
	for i, t := range filtered {
		if i == index {
			moved.Order = order
			order++
		}
		t.Order = order
		order++
	}
	if index >= len(filtered) {
		moved.Order = order
	}

	if fromColumn != columnID {
		for i, t := range m.tasksInColumn(project, fromColumn) {
			t.Order = i
		}
	}
	m.mu.Unlock()

	m.Save()
	return nil
}

func (m *Manager) DeleteKanbanTask(projectID, taskID string) error {
	m.mu.Lock()
	project, ok := m.state.Projects[projectID]
	if !ok {
		m.mu.Unlock()
		return os.ErrNotExist
	}
	tasks := project.KanbanTasks[:0]
	for _, t := range project.KanbanTasks {
		if t.ID != taskID {
			tasks = append(tasks, t)
		}
	}
	project.KanbanTasks = tasks
	m.mu.Unlock()

	m.Save()
	return nil
}

func (m *Manager) SaveKanbanColumns(projectID string, columns []KanbanColumn) error {
	m.mu.Lock()
	project, ok := m.state.Projects[projectID]
	if !ok {
		m.mu.Unlock()
		return os.ErrNotExist
	}
	project.KanbanColumns = columns
	m.mu.Unlock()

	m.Save()
	return nil
}

func (m *Manager) AddKanbanComment(projectID, taskID, author, text string) (KanbanComment, error) {
	m.mu.Lock()
	project, ok := m.state.Projects[projectID]
	if !ok {
		m.mu.Unlock()
		return KanbanComment{}, os.ErrNotExist
	}
	comment := KanbanComment{
		ID:        uuid.New().String(),
		Author:    author,
		Text:      text,
		CreatedAt: time.Now(),
	}
	found := false
	for i := range project.KanbanTasks {
		if project.KanbanTasks[i].ID == taskID {
			project.KanbanTasks[i].Comments = append(project.KanbanTasks[i].Comments, comment)
			project.KanbanTasks[i].UpdatedAt = comment.CreatedAt
			found = true
			break
		}
	}
	m.mu.Unlock()
	if !found {
		return KanbanComment{}, fmt.Errorf("task %s not found", taskID)
	}
	m.Save()
	return comment, nil
}

// DeleteKanbanColumn removes a column and moves its tasks to the first
// remaining column; the last column cannot be deleted
func (m *Manager) DeleteKanbanColumn(projectID, columnID string) error {
	m.mu.Lock()
	project, ok := m.state.Projects[projectID]
	if !ok {
		m.mu.Unlock()
		return os.ErrNotExist
	}
	if len(project.KanbanColumns) <= 1 {
		m.mu.Unlock()
		return fmt.Errorf("cannot delete the last column")
	}
	columns := project.KanbanColumns[:0]
	for _, c := range project.KanbanColumns {
		if c.ID != columnID {
			columns = append(columns, c)
		}
	}
	if len(columns) == len(project.KanbanColumns) {
		m.mu.Unlock()
		return fmt.Errorf("column %s not found", columnID)
	}
	project.KanbanColumns = columns
	fallback := columns[0].ID
	next := len(m.tasksInColumn(project, fallback))
	for i := range project.KanbanTasks {
		if project.KanbanTasks[i].ColumnID == columnID {
			project.KanbanTasks[i].ColumnID = fallback
			project.KanbanTasks[i].Order = next
			next++
		}
	}
	m.mu.Unlock()
	m.Save()
	return nil
}

// ResolveProject finds a project by ID, exact name, or path prefix — the
// lookup agents use ("the project I'm working in")
func (m *Manager) ResolveProject(ref string) (*ProjectState, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if p, ok := m.state.Projects[ref]; ok {
		return clone(p), true
	}
	for _, p := range m.state.Projects {
		if p.Name == ref || p.Path == ref {
			return clone(p), true
		}
	}
	for _, p := range m.state.Projects {
		if p.Path != "" && len(ref) > len(p.Path) && ref[:len(p.Path)+1] == p.Path+"/" {
			return clone(p), true
		}
	}
	return nil, false
}

func (m *Manager) GetAgentSkills() map[string]bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := map[string]bool{}
	for k, v := range m.state.AgentSkills {
		out[k] = v
	}
	return out
}

func (m *Manager) SetAgentSkill(id string, enabled bool) {
	m.mu.Lock()
	if m.state.AgentSkills == nil {
		m.state.AgentSkills = map[string]bool{}
	}
	m.state.AgentSkills[id] = enabled
	m.mu.Unlock()
	m.Save()
}

func (m *Manager) SetProjectJira(projectID, jiraProject, jiraFilter string) error {
	m.mu.Lock()
	project, ok := m.state.Projects[projectID]
	if !ok {
		m.mu.Unlock()
		return os.ErrNotExist
	}
	project.JiraProject = jiraProject
	project.JiraFilter = jiraFilter
	m.mu.Unlock()
	m.Save()
	return nil
}

// JiraSyncItem is one Jira issue mapped onto the local board
type JiraSyncItem struct {
	Key      string
	Title    string
	Priority string
	ColumnID string
}

// ApplyJiraSync upserts jira-backed tasks in one pass: existing tasks (matched
// by JiraKey) get title/priority/column updates, unknown keys become new tasks.
// Local-only fields (description, comments, pinned, category) are untouched.
func (m *Manager) ApplyJiraSync(projectID string, items []JiraSyncItem) (created, updated int, err error) {
	m.mu.Lock()
	project, ok := m.state.Projects[projectID]
	if !ok {
		m.mu.Unlock()
		return 0, 0, os.ErrNotExist
	}
	m.ensureKanban(project)

	byKey := map[string]*KanbanTask{}
	for i := range project.KanbanTasks {
		if project.KanbanTasks[i].JiraKey != "" {
			byKey[project.KanbanTasks[i].JiraKey] = &project.KanbanTasks[i]
		}
	}

	now := time.Now()
	orders := map[string]int{}
	for _, t := range project.KanbanTasks {
		if t.Order >= orders[t.ColumnID] {
			orders[t.ColumnID] = t.Order + 1
		}
	}

	for _, item := range items {
		if existing, ok := byKey[item.Key]; ok {
			changed := existing.Title != item.Title ||
				existing.Priority != item.Priority ||
				existing.ColumnID != item.ColumnID ||
				existing.Archived
			if changed {
				existing.Title = item.Title
				existing.Priority = item.Priority
				if existing.ColumnID != item.ColumnID {
					existing.ColumnID = item.ColumnID
					existing.Order = orders[item.ColumnID]
					orders[item.ColumnID]++
				}
				existing.Archived = false
				existing.UpdatedAt = now
				updated++
			}
			continue
		}
		task := KanbanTask{
			ID:        uuid.New().String(),
			Title:     item.Title,
			ColumnID:  item.ColumnID,
			Order:     orders[item.ColumnID],
			Priority:  item.Priority,
			JiraKey:   item.Key,
			CreatedAt: now,
			UpdatedAt: now,
		}
		orders[item.ColumnID]++
		project.KanbanTasks = append(project.KanbanTasks, task)
		created++
	}
	m.mu.Unlock()

	if created > 0 || updated > 0 {
		m.Save()
	}
	return created, updated, nil
}

// ============================================
// Health selection + custom checks
// ============================================

func (m *Manager) GetHealthSelection(projectID string) []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if p, ok := m.state.Projects[projectID]; ok {
		return append([]string{}, p.HealthSelected...)
	}
	return nil
}

func (m *Manager) SetHealthSelection(projectID string, checkIDs []string) error {
	m.mu.Lock()
	p, ok := m.state.Projects[projectID]
	if !ok {
		m.mu.Unlock()
		return os.ErrNotExist
	}
	p.HealthSelected = checkIDs
	m.mu.Unlock()
	m.Save()
	return nil
}

func (m *Manager) GetCustomHealthChecks() []CustomHealthCheck {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return append([]CustomHealthCheck{}, m.state.CustomHealthChecks...)
}

func (m *Manager) SaveCustomHealthCheck(c CustomHealthCheck) (CustomHealthCheck, error) {
	if c.Title == "" {
		return CustomHealthCheck{}, fmt.Errorf("title is required")
	}
	if c.Stack == "" {
		c.Stack = "custom"
	}
	if c.Category == "" {
		c.Category = "Custom"
	}
	m.mu.Lock()
	if c.ID == "" {
		c.ID = "custom:" + uuid.New().String()
		m.state.CustomHealthChecks = append(m.state.CustomHealthChecks, c)
	} else {
		found := false
		for i := range m.state.CustomHealthChecks {
			if m.state.CustomHealthChecks[i].ID == c.ID {
				m.state.CustomHealthChecks[i] = c
				found = true
				break
			}
		}
		if !found {
			m.mu.Unlock()
			return CustomHealthCheck{}, os.ErrNotExist
		}
	}
	m.mu.Unlock()
	m.Save()
	return c, nil
}

func (m *Manager) DeleteCustomHealthCheck(id string) error {
	m.mu.Lock()
	checks := m.state.CustomHealthChecks[:0]
	for _, c := range m.state.CustomHealthChecks {
		if c.ID != id {
			checks = append(checks, c)
		}
	}
	m.state.CustomHealthChecks = checks
	for _, p := range m.state.Projects {
		kept := p.HealthSelected[:0]
		for _, sel := range p.HealthSelected {
			if sel != id {
				kept = append(kept, sel)
			}
		}
		p.HealthSelected = kept
	}
	m.mu.Unlock()
	m.Save()
	return nil
}
