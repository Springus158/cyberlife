package main

import (
	"fmt"

	"github.com/kalor62/cyberlife/internal/state"
)

// GetGlobalPromptPrefix returns the global prompt prefix
func (a *App) GetGlobalPromptPrefix() string {
	if a.stateManager == nil {
		return ""
	}
	return a.stateManager.GetGlobalPromptPrefix()
}

// SetGlobalPromptPrefix saves the global prompt prefix
func (a *App) SetGlobalPromptPrefix(s string) {
	if a.stateManager != nil {
		a.stateManager.SetGlobalPromptPrefix(s)
	}
}

// GetGlobalPromptSuffix returns the global prompt suffix
func (a *App) GetGlobalPromptSuffix() string {
	if a.stateManager == nil {
		return ""
	}
	return a.stateManager.GetGlobalPromptSuffix()
}

// SetGlobalPromptSuffix saves the global prompt suffix
func (a *App) SetGlobalPromptSuffix(s string) {
	if a.stateManager != nil {
		a.stateManager.SetGlobalPromptSuffix(s)
	}
}

// GetProjectPrompts returns all prompts for a project
func (a *App) GetProjectPrompts(projectID string) []state.Prompt {
	if a.stateManager == nil {
		return []state.Prompt{}
	}
	return a.stateManager.GetProjectPrompts(projectID)
}

// CreatePrompt creates a new prompt in a project
func (a *App) CreatePrompt(projectID string, prompt state.Prompt) (*state.Prompt, error) {
	if a.stateManager == nil {
		return nil, fmt.Errorf("state manager not initialized")
	}
	return a.stateManager.CreatePrompt(projectID, prompt)
}

// UpdatePrompt updates an existing prompt in a project
func (a *App) UpdatePrompt(projectID, promptID string, prompt state.Prompt) error {
	if a.stateManager == nil {
		return fmt.Errorf("state manager not initialized")
	}
	return a.stateManager.UpdatePrompt(projectID, promptID, prompt)
}

// DeletePrompt deletes a prompt from a project
func (a *App) DeletePrompt(projectID, promptID string) error {
	if a.stateManager == nil {
		return fmt.Errorf("state manager not initialized")
	}
	return a.stateManager.DeletePrompt(projectID, promptID)
}

// IncrementPromptUsage increments the usage count for a prompt
func (a *App) IncrementPromptUsage(projectID, promptID string, isGlobal bool) error {
	if a.stateManager == nil {
		return fmt.Errorf("state manager not initialized")
	}
	return a.stateManager.IncrementPromptUsage(projectID, promptID, isGlobal)
}

// TogglePromptPinned toggles the pinned status of a prompt
func (a *App) TogglePromptPinned(projectID, promptID string, isGlobal bool) error {
	if a.stateManager == nil {
		return fmt.Errorf("state manager not initialized")
	}
	return a.stateManager.TogglePromptPinned(projectID, promptID, isGlobal)
}

// GetGlobalPrompts returns all global prompts
func (a *App) GetGlobalPrompts() []state.Prompt {
	if a.stateManager == nil {
		return []state.Prompt{}
	}
	return a.stateManager.GetGlobalPrompts()
}

// CreateGlobalPrompt creates a new global prompt
func (a *App) CreateGlobalPrompt(prompt state.Prompt) (*state.Prompt, error) {
	if a.stateManager == nil {
		return nil, fmt.Errorf("state manager not initialized")
	}
	return a.stateManager.CreateGlobalPrompt(prompt)
}

// UpdateGlobalPrompt updates an existing global prompt
func (a *App) UpdateGlobalPrompt(promptID string, prompt state.Prompt) error {
	if a.stateManager == nil {
		return fmt.Errorf("state manager not initialized")
	}
	return a.stateManager.UpdateGlobalPrompt(promptID, prompt)
}

// DeleteGlobalPrompt deletes a global prompt
func (a *App) DeleteGlobalPrompt(promptID string) error {
	if a.stateManager == nil {
		return fmt.Errorf("state manager not initialized")
	}
	return a.stateManager.DeleteGlobalPrompt(promptID)
}

// GetPromptCategories returns all categories for a project
func (a *App) GetPromptCategories(projectID string) []state.PromptCategory {
	if a.stateManager == nil {
		return []state.PromptCategory{}
	}
	return a.stateManager.GetPromptCategories(projectID)
}

// GetGlobalPromptCategories returns all global categories
func (a *App) GetGlobalPromptCategories() []state.PromptCategory {
	if a.stateManager == nil {
		return []state.PromptCategory{}
	}
	return a.stateManager.GetGlobalPromptCategories()
}

// CreatePromptCategory creates a new prompt category
func (a *App) CreatePromptCategory(projectID, name string, isGlobal bool) (*state.PromptCategory, error) {
	if a.stateManager == nil {
		return nil, fmt.Errorf("state manager not initialized")
	}
	return a.stateManager.CreatePromptCategory(projectID, name, isGlobal)
}

// DeletePromptCategory deletes a prompt category
func (a *App) DeletePromptCategory(projectID, categoryID string, isGlobal bool) error {
	if a.stateManager == nil {
		return fmt.Errorf("state manager not initialized")
	}
	return a.stateManager.DeletePromptCategory(projectID, categoryID, isGlobal)
}

// GetPromptHistory returns prompt history for a project (newest first)
func (a *App) GetPromptHistory(projectID string, limit, offset int) []state.PromptHistoryItem {
	if a.stateManager == nil {
		return []state.PromptHistoryItem{}
	}
	return a.stateManager.GetPromptHistory(projectID, limit, offset)
}

// GetPromptHistoryCount returns total count of prompt history items
func (a *App) GetPromptHistoryCount(projectID string) int {
	if a.stateManager == nil {
		return 0
	}
	return a.stateManager.GetPromptHistoryCount(projectID)
}

// AddPromptHistory adds a prompt to the project history
func (a *App) AddPromptHistory(projectID string, content string) (*state.PromptHistoryItem, error) {
	if a.stateManager == nil {
		return nil, fmt.Errorf("state manager not initialized")
	}
	return a.stateManager.AddPromptHistory(projectID, content)
}

// DeletePromptHistory deletes a single prompt history item
func (a *App) DeletePromptHistory(projectID, itemID string) error {
	if a.stateManager == nil {
		return fmt.Errorf("state manager not initialized")
	}
	return a.stateManager.DeletePromptHistory(projectID, itemID)
}

// ClearPromptHistory clears all prompt history for a project
func (a *App) ClearPromptHistory(projectID string) error {
	if a.stateManager == nil {
		return fmt.Errorf("state manager not initialized")
	}
	return a.stateManager.ClearPromptHistory(projectID)
}
