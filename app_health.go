package main

import (
	"fmt"

	"github.com/kalor62/cyberlife/internal/health"
	"github.com/kalor62/cyberlife/internal/state"
)

func (a *App) GetHealthLibrary() HealthLibrary {
	lib := HealthLibrary{Stacks: append(health.Stacks(), "custom"), Checks: health.BuiltinLibrary()}
	if a.stateManager != nil {
		for _, c := range a.stateManager.GetCustomHealthChecks() {
			lib.Checks = append(lib.Checks, health.CheckDef{
				ID: c.ID, Title: c.Title, Description: c.Description,
				Stack: c.Stack, Category: c.Category, Kind: "manual", Custom: true,
			})
		}
	}
	return lib
}

func (a *App) GetHealthSelection(projectID string) []string {
	if a.stateManager == nil {
		return nil
	}
	return a.stateManager.GetHealthSelection(projectID)
}

func (a *App) SetHealthSelection(projectID string, checkIDs []string) error {
	if a.stateManager == nil {
		return fmt.Errorf("state manager not initialized")
	}
	return a.stateManager.SetHealthSelection(projectID, checkIDs)
}

func (a *App) SaveCustomHealthCheck(c state.CustomHealthCheck) (state.CustomHealthCheck, error) {
	if a.stateManager == nil {
		return state.CustomHealthCheck{}, fmt.Errorf("state manager not initialized")
	}
	return a.stateManager.SaveCustomHealthCheck(c)
}

func (a *App) DeleteCustomHealthCheck(id string) error {
	if a.stateManager == nil {
		return fmt.Errorf("state manager not initialized")
	}
	return a.stateManager.DeleteCustomHealthCheck(id)
}

// GetSelectedHealthReport evaluates only the checks the project tracks
func (a *App) GetSelectedHealthReport(projectID string) *health.ProjectHealthReport {
	if a.stateManager == nil {
		return &health.ProjectHealthReport{}
	}
	project, ok := a.stateManager.ResolveProject(projectID)
	if !ok {
		return &health.ProjectHealthReport{}
	}
	lib := a.GetHealthLibrary()
	selected := a.stateManager.GetHealthSelection(project.ID)
	return health.SelectedReport(project.Path, lib.Checks, selected, a.toolsManager)
}
