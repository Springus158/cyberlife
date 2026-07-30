package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/kalor62/cyberlife/internal/logging"
	"github.com/kalor62/cyberlife/internal/state"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// taskBranchName builds "<jirakey>-<title>" as a lowercase dash slug (e.g. "acre-123-fix-login-flow")
func taskBranchName(name, jiraKey string) string {
	source := strings.TrimSpace(name)
	if jiraKey != "" {
		if strings.HasPrefix(strings.ToLower(source), strings.ToLower(jiraKey)) {
			source = source[len(jiraKey):]
		}
		source = jiraKey + " " + source
	}
	var b strings.Builder
	lastDash := true
	for _, r := range strings.ToLower(source) {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
			b.WriteRune(r)
			lastDash = false
		default:
			if !lastDash {
				b.WriteByte('-')
				lastDash = true
			}
		}
		if b.Len() >= 48 {
			break
		}
	}
	slug := strings.Trim(b.String(), "-")
	if slug == "" {
		slug = "task"
	}
	return slug
}

// taskTabName keeps terminal tab names short: the Jira key alone, or a truncated task name
func taskTabName(task *state.TaskState) string {
	if task.JiraKey != "" {
		return task.JiraKey
	}
	runes := []rune(task.Name)
	if len(runes) > 30 {
		return string(runes[:29]) + "…"
	}
	return task.Name
}

// CreateProjectTask creates a task: one git worktree per involved repo on a shared
// branch, plus task state. For umbrella projects (folder of repos) the worktrees
// live under a task root folder that also receives the umbrella's Claude config.
func (a *App) CreateProjectTask(projectID, name, jiraKey, branch, baseBranch, claudeConfigDir string, repoPaths []string) (*state.TaskState, error) {
	if a.stateManager == nil || a.gitManager == nil {
		return nil, fmt.Errorf("not initialized")
	}
	project := a.stateManager.GetProject(projectID)
	if project == nil {
		return nil, fmt.Errorf("project not found")
	}

	if len(repoPaths) == 0 {
		if !a.gitManager.IsGitRepo(project.Path) {
			return nil, fmt.Errorf("select at least one repository for this task")
		}
		repoPaths = []string{project.Path}
	}
	for _, rp := range repoPaths {
		if !a.gitManager.IsGitRepo(rp) {
			return nil, fmt.Errorf("not a git repository: %s", rp)
		}
	}

	branch = strings.ReplaceAll(strings.TrimSpace(branch), " ", "-")
	if branch == "" {
		branch = taskBranchName(name, jiraKey)
	}
	tasksDir := filepath.Join(filepath.Dir(project.Path), filepath.Base(project.Path)+"-tasks")
	if err := os.MkdirAll(tasksDir, 0755); err != nil {
		return nil, err
	}

	baseFor := func(repoPath string) string {
		if baseBranch != "" {
			return baseBranch
		}
		return a.gitManager.GetCurrentBranch(repoPath)
	}

	single := len(repoPaths) == 1 && repoPaths[0] == project.Path
	repos := []state.TaskRepoState{}
	var sessionCwd string

	cleanup := func() {
		for _, r := range repos {
			if err := a.gitManager.RemoveWorktree(r.RepoPath, r.WorktreePath, true); err != nil {
				logging.Warn("Failed to clean up worktree after task creation error", "worktree", logging.MaskPath(r.WorktreePath), "error", err)
			}
		}
	}

	if single {
		worktreePath := uniquePath(filepath.Join(tasksDir, branch))
		if err := a.gitManager.AddWorktree(project.Path, worktreePath, branch, baseFor(project.Path)); err != nil {
			logging.Error("Failed to create task worktree", "project", project.Name, "branch", branch, "error", err)
			return nil, err
		}
		a.seedWorktree(project.Path, worktreePath)
		repos = append(repos, state.TaskRepoState{RepoName: filepath.Base(project.Path), RepoPath: project.Path, WorktreePath: worktreePath, Branch: branch})
		sessionCwd = worktreePath
	} else {
		taskRoot := uniquePath(filepath.Join(tasksDir, branch))
		if err := os.MkdirAll(taskRoot, 0755); err != nil {
			return nil, err
		}
		for _, rp := range repoPaths {
			worktreePath := filepath.Join(taskRoot, filepath.Base(rp))
			if err := a.gitManager.AddWorktree(rp, worktreePath, branch, baseFor(rp)); err != nil {
				logging.Error("Failed to create task worktree", "repo", filepath.Base(rp), "branch", branch, "error", err)
				cleanup()
				if rmErr := os.RemoveAll(taskRoot); rmErr != nil {
					logging.Warn("Failed to remove task root after error", "path", logging.MaskPath(taskRoot), "error", rmErr)
				}
				return nil, fmt.Errorf("%s: %w", filepath.Base(rp), err)
			}
			a.seedWorktree(rp, worktreePath)
			repos = append(repos, state.TaskRepoState{RepoName: filepath.Base(rp), RepoPath: rp, WorktreePath: worktreePath, Branch: branch})
		}
		// Inherit the umbrella folder's Claude config and env in the task root
		for _, rel := range []string{"CLAUDE.md", ".env", ".env.local"} {
			if err := copySeedFile(project.Path, taskRoot, rel); err != nil && !os.IsNotExist(err) {
				logging.Warn("Failed to copy umbrella seed file", "file", rel, "error", err)
			}
		}
		umbrellaClaude := filepath.Join(project.Path, ".claude")
		if _, err := os.Stat(umbrellaClaude); err == nil {
			if err := copyDirRecursive(umbrellaClaude, filepath.Join(taskRoot, ".claude")); err != nil {
				logging.Warn("Failed to copy umbrella .claude dir", "error", err)
			}
		}
		sessionCwd = taskRoot
	}

	task, err := a.stateManager.CreateTask(projectID, &state.TaskState{
		Name:            name,
		JiraKey:         jiraKey,
		Branch:          branch,
		WorktreePath:    sessionCwd,
		Repos:           repos,
		ClaudeConfigDir: claudeConfigDir,
	})
	if err != nil {
		cleanup()
		return nil, err
	}
	logging.Info("Created task", "project", project.Name, "task", name, "branch", branch, "repos", len(repos))
	return task, nil
}

// OpenProjectTask opens an iTerm tab in the task's worktree and starts or resumes its Claude session
func (a *App) OpenProjectTask(projectID, taskID string) (*state.TaskState, error) {
	if a.stateManager == nil {
		return nil, fmt.Errorf("state manager not initialized")
	}
	if a.itermController == nil {
		return nil, fmt.Errorf("iTerm controller not initialized")
	}
	task := a.stateManager.GetTask(projectID, taskID)
	if task == nil {
		return nil, fmt.Errorf("task not found")
	}
	if _, err := os.Stat(task.WorktreePath); err != nil {
		return nil, fmt.Errorf("task worktree missing: %s", task.WorktreePath)
	}

	claudeArgs := "--session-id " + task.ClaudeSessionID
	if task.SessionStarted {
		claudeArgs = "--resume " + task.ClaudeSessionID
	}

	if err := a.itermController.CreateTab(task.WorktreePath, taskTabName(task), task.ClaudeConfigDir, claudeArgs); err != nil {
		return nil, err
	}

	a.stateManager.MarkTaskOpened(projectID, taskID)
	return a.stateManager.GetTask(projectID, taskID), nil
}

// UpdateProjectTask updates a task's name, status or Claude account
func (a *App) UpdateProjectTask(projectID string, task state.TaskState) error {
	if a.stateManager == nil {
		return fmt.Errorf("state manager not initialized")
	}
	return a.stateManager.UpdateTask(projectID, &task)
}

// DeleteProjectTask removes the task's worktrees (and optionally their branches), then the task itself
func (a *App) DeleteProjectTask(projectID, taskID string, deleteBranch, force bool) error {
	if a.stateManager == nil {
		return fmt.Errorf("state manager not initialized")
	}
	project := a.stateManager.GetProject(projectID)
	task := a.stateManager.GetTask(projectID, taskID)
	if project == nil || task == nil {
		return fmt.Errorf("task not found")
	}

	repos := task.Repos
	if len(repos) == 0 && task.WorktreePath != "" {
		repos = []state.TaskRepoState{{RepoPath: project.Path, WorktreePath: task.WorktreePath, Branch: task.Branch}}
	}

	for _, r := range repos {
		if _, err := os.Stat(r.WorktreePath); err == nil {
			if err := a.gitManager.RemoveWorktree(r.RepoPath, r.WorktreePath, force); err != nil {
				return fmt.Errorf("%s: %w", r.RepoName, err)
			}
		}
		if deleteBranch && r.Branch != "" && a.gitManager.BranchExists(r.RepoPath, r.Branch) {
			if err := a.gitManager.DeleteBranch(r.RepoPath, r.Branch, force); err != nil {
				return fmt.Errorf("%s: %w", r.RepoName, err)
			}
		}
	}

	// Multi-repo tasks own a task root folder distinct from any single worktree
	ownRoot := task.WorktreePath != ""
	for _, r := range repos {
		if r.WorktreePath == task.WorktreePath {
			ownRoot = false
		}
	}
	if ownRoot {
		if err := os.RemoveAll(task.WorktreePath); err != nil {
			logging.Warn("Failed to remove task root folder", "path", logging.MaskPath(task.WorktreePath), "error", err)
		}
	}

	return a.stateManager.DeleteTask(projectID, taskID)
}

func (a *App) automationMoveTask(projectID, taskID, column string) error {
	columns, _, err := a.stateManager.GetKanban(projectID)
	if err != nil {
		return err
	}
	columnID := ""
	for _, c := range columns {
		if c.ID == column || strings.EqualFold(c.Name, column) {
			columnID = c.ID
			break
		}
	}
	if columnID == "" {
		return fmt.Errorf("column %q not found", column)
	}
	// stateManager directly, not App.MoveKanbanTask — automation moves must
	// not re-enter the engine (no rule cascades)
	if err := a.stateManager.MoveKanbanTask(projectID, taskID, columnID, 1<<30); err != nil {
		return err
	}
	go a.pushJiraTransition(projectID, taskID, columnID)
	runtime.EventsEmit(a.ctx, "kanban-changed", projectID)
	return nil
}
