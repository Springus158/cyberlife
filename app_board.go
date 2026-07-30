package main

import (
	"fmt"

	"github.com/kalor62/cyberlife/internal/state"
)

func (a *App) GetKanban(projectID string) (KanbanBoard, error) {
	if a.stateManager == nil {
		return KanbanBoard{}, fmt.Errorf("state manager not initialized")
	}
	columns, tasks, err := a.stateManager.GetKanban(projectID)
	if err != nil {
		return KanbanBoard{}, err
	}
	return KanbanBoard{Columns: columns, Tasks: tasks}, nil
}

func (a *App) UpsertKanbanTask(projectID string, task state.KanbanTask) (state.KanbanTask, error) {
	if a.stateManager == nil {
		return state.KanbanTask{}, fmt.Errorf("state manager not initialized")
	}
	return a.stateManager.UpsertKanbanTask(projectID, task)
}

func (a *App) MoveKanbanTask(projectID, taskID, columnID string, index int) error {
	if a.stateManager == nil {
		return fmt.Errorf("state manager not initialized")
	}
	if err := a.stateManager.MoveKanbanTask(projectID, taskID, columnID, index); err != nil {
		return err
	}
	go a.onBoardMove(projectID, taskID, columnID)
	return nil
}

func (a *App) DeleteKanbanTask(projectID, taskID string) error {
	if a.stateManager == nil {
		return fmt.Errorf("state manager not initialized")
	}
	return a.stateManager.DeleteKanbanTask(projectID, taskID)
}

func (a *App) SaveKanbanColumns(projectID string, columns []state.KanbanColumn) error {
	if a.stateManager == nil {
		return fmt.Errorf("state manager not initialized")
	}
	return a.stateManager.SaveKanbanColumns(projectID, columns)
}

func (a *App) DeleteKanbanColumn(projectID, columnID string) error {
	if a.stateManager == nil {
		return fmt.Errorf("state manager not initialized")
	}
	return a.stateManager.DeleteKanbanColumn(projectID, columnID)
}

func (a *App) AddKanbanComment(projectID, taskID, author, text string) (state.KanbanComment, error) {
	if a.stateManager == nil {
		return state.KanbanComment{}, fmt.Errorf("state manager not initialized")
	}
	return a.stateManager.AddKanbanComment(projectID, taskID, author, text)
}
