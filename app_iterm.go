package main

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"

	"github.com/kalor62/cyberlife/internal/iterm"
	"github.com/kalor62/cyberlife/internal/logging"
	"github.com/kalor62/cyberlife/internal/state"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// GetITermStatus returns the current iTerm2 status (running state and tabs)
func (a *App) GetITermStatus() *iterm.ITermStatus {
	if a.itermController == nil {
		return &iterm.ITermStatus{Running: false, Tabs: []iterm.ITermTab{}}
	}
	status, err := a.itermController.GetStatus()
	if err != nil {
		return &iterm.ITermStatus{Running: false, Tabs: []iterm.ITermTab{}}
	}
	return status
}

// LaunchITerm launches iTerm2 application
func (a *App) LaunchITerm() error {
	if a.itermController == nil {
		return fmt.Errorf("iTerm controller not initialized")
	}
	if !a.addonOn("iterm") {
		return fmt.Errorf("iTerm2 addon is disabled (Settings → Addons)")
	}
	return a.itermController.LaunchITerm()
}

// SwitchITermTab switches to a specific tab in iTerm2
func (a *App) SwitchITermTab(windowID, tabIndex int) error {
	if a.itermController == nil {
		return fmt.Errorf("iTerm controller not initialized")
	}
	return a.itermController.SwitchTab(windowID, tabIndex)
}

// SwitchITermTabBySessionID switches to a tab by its session ID (more reliable)
func (a *App) SwitchITermTabBySessionID(sessionID string) error {
	if a.itermController == nil {
		return fmt.Errorf("iTerm controller not initialized")
	}
	return a.itermController.SwitchTabBySessionID(sessionID)
}

// OpenTmuxInITerm shows a tmux-backed terminal in iTerm2, creating the host
// tab (and window) when needed — the explicit escape hatch to a real terminal
func (a *App) OpenTmuxInITerm(sessionID string) error {
	if a.itermController == nil {
		return fmt.Errorf("iTerm controller not initialized")
	}
	if !a.addonOn("iterm") {
		return fmt.Errorf("iTerm2 addon is disabled (Settings → Addons)")
	}
	if !strings.HasPrefix(sessionID, "tmux:") {
		return a.itermController.SwitchTabBySessionID(sessionID)
	}
	return a.itermController.OpenTmuxInITerm(strings.TrimPrefix(sessionID, "tmux:"))
}

// RenameITermTab renames an iTerm2 tab
func (a *App) RenameITermTab(windowID, tabIndex int, newName string) error {
	if a.itermController == nil {
		return fmt.Errorf("iTerm controller not initialized")
	}
	return a.itermController.RenameTab(windowID, tabIndex, newName)
}

// RenameITermTabBySessionID renames an iTerm2 tab by session ID
func (a *App) RenameITermTabBySessionID(sessionID, newName string) error {
	if a.itermController == nil {
		return fmt.Errorf("iTerm controller not initialized")
	}
	return a.itermController.RenameTabBySessionID(sessionID, newName)
}

// CreateITermTab creates a new tab in iTerm2 at the specified directory with a name
func (a *App) CreateITermTab(workingDir, tabName, claudeConfigDir string) error {
	return a.CreateITermTabWithRunner(workingDir, tabName, claudeConfigDir, "")
}

// CreateITermTabWithRunner launches a session with the chosen runner; empty
// or "claude" keeps the built-in default (with optional account config dir)
func (a *App) CreateITermTabWithRunner(workingDir, tabName, claudeConfigDir, runnerID string) error {
	if a.itermController == nil {
		return fmt.Errorf("iTerm controller not initialized")
	}
	if runnerID == "" || runnerID == state.ClaudeRunnerID {
		return a.itermController.CreateTab(workingDir, tabName, claudeConfigDir, "")
	}
	if a.stateManager == nil {
		return fmt.Errorf("state manager not initialized")
	}
	runner := a.stateManager.GetRunner(runnerID)
	command := strings.TrimSpace(runner.Command)
	if runner.Args != "" {
		command += " " + runner.Args
	}
	env := map[string]string{}
	for k, v := range runner.Env {
		env[k] = v
	}
	return a.itermController.CreateTabWithCommand(workingDir, tabName, env, command)
}

// CloseITermTab closes a specific tab in iTerm2
func (a *App) CloseITermTab(windowID, tabIndex int) error {
	if a.itermController == nil {
		return fmt.Errorf("iTerm controller not initialized")
	}
	return a.itermController.CloseTab(windowID, tabIndex)
}

// CloseITermTabBySessionID closes the tab containing a specific session
func (a *App) CloseITermTabBySessionID(sessionID string) error {
	if a.itermController == nil {
		return fmt.Errorf("iTerm controller not initialized")
	}
	return a.itermController.CloseTabBySessionID(sessionID)
}

// FocusITerm brings iTerm2 to the foreground
func (a *App) FocusITerm() error {
	if a.itermController == nil {
		return fmt.Errorf("iTerm controller not initialized")
	}
	return a.itermController.FocusITerm()
}

// WriteITermText writes text to the active iTerm2 session
func (a *App) WriteITermText(text string, pressEnter bool) error {
	if a.itermController == nil {
		return fmt.Errorf("iTerm controller not initialized")
	}
	return a.itermController.WriteText(text, pressEnter)
}

// GetITermSessionContents returns the last N lines from the active iTerm2 session
func (a *App) GetITermSessionContents(lines int) (string, error) {
	if a.itermController == nil {
		return "", fmt.Errorf("iTerm controller not initialized")
	}
	return a.itermController.GetSessionContents(lines)
}

// GetITermSessionInfo returns information about the active iTerm2 session
func (a *App) GetITermSessionInfo() (*iterm.SessionInfo, error) {
	if a.itermController == nil {
		return nil, fmt.Errorf("iTerm controller not initialized")
	}
	return a.itermController.GetSessionInfo()
}

// GetITermSessionContentsByID returns the last N lines from a specific iTerm2 session
func (a *App) GetITermSessionContentsByID(sessionID string, lines int) (string, error) {
	if a.itermController == nil {
		return "", fmt.Errorf("iTerm controller not initialized")
	}
	return a.itermController.GetSessionContentsByID(sessionID, lines)
}

// WriteITermTextBySessionID writes text to a specific iTerm2 session
func (a *App) WriteITermTextBySessionID(sessionID string, text string, pressEnter bool) error {
	if a.itermController == nil {
		return fmt.Errorf("iTerm controller not initialized")
	}
	return a.itermController.WriteTextBySessionID(sessionID, text, pressEnter)
}

// PasteClipboardToSession pastes the OS clipboard into a session as one
// bracketed paste, so multi-line text arrives without firing Enter per line
func (a *App) PasteClipboardToSession(sessionID string) error {
	if a.itermController == nil {
		return fmt.Errorf("iTerm controller not initialized")
	}
	text, err := runtime.ClipboardGetText(a.ctx)
	if err != nil {
		return fmt.Errorf("clipboard read failed: %w", err)
	}
	if text == "" {
		// Wails only exposes clipboard text; a copied image must be delivered
		// as Ctrl+V so Claude Code inside the session reads the OS clipboard itself
		if clipboardHasImage() {
			return a.itermController.SendSpecialKeyBySessionID(sessionID, "ctrl-v")
		}
		logging.Debug("PasteClipboardToSession: clipboard empty", "sessionId", sessionID)
		return nil
	}
	return a.itermController.PasteTextBySessionID(sessionID, text)
}

func clipboardHasImage() bool {
	out, err := exec.Command("osascript", "-e", "clipboard info").Output()
	if err != nil {
		logging.Debug("clipboard info failed", "err", err)
		return false
	}
	info := string(out)
	return strings.Contains(info, "PNGf") || strings.Contains(info, "TIFF") || strings.Contains(info, "JPEG")
}

// SendITermSpecialKey sends a special key sequence to a specific iTerm2 session
func (a *App) SendITermSpecialKey(sessionID string, key string) error {
	if a.itermController == nil {
		return fmt.Errorf("iTerm controller not initialized")
	}
	return a.itermController.SendSpecialKeyBySessionID(sessionID, key)
}

// WatchITermSession starts watching a session's styled content via Python bridge.
// Returns an error string if the bridge is not available.
func (a *App) WatchITermSession(sessionID string) string {
	logging.Info("WatchITermSession called", "sessionId", sessionID)
	if a.itermController == nil {
		return "ERROR: iTerm controller not initialized"
	}

	err := a.itermController.StartStyledContentWatching(
		sessionID,
		func(content *iterm.StyledContent) {
			linesJSON, err := json.Marshal(content.Lines)
			if err != nil {
				logging.Error("Failed to marshal styled lines", "error", err)
				return
			}
			runtime.EventsEmit(a.ctx, "iterm-session-styled-content", map[string]interface{}{
				"sessionId":   content.SessionID,
				"lines":       string(linesJSON),
				"cursor":      map[string]interface{}{"x": content.Cursor.X, "y": content.Cursor.Y},
				"cols":        content.Cols,
				"rows":        content.Rows,
				"historySize": content.HistorySize,
			})
		},
		func(profile *iterm.ProfileData) {
			runtime.EventsEmit(a.ctx, "iterm-session-profile", map[string]interface{}{
				"sessionId": profile.SessionID,
				"colors": map[string]interface{}{
					"fg":     profile.Colors.Fg,
					"bg":     profile.Colors.Bg,
					"cursor": profile.Colors.Cursor,
					"ansi":   profile.Colors.Ansi,
				},
			})
		},
	)

	if err != nil {
		logging.Warn("WatchITermSession failed", "error", err)
		return "ERROR: " + err.Error()
	}
	return ""
}

// UnwatchITermSession stops watching any session content
func (a *App) UnwatchITermSession() {
	if a.itermController == nil {
		return
	}
	a.itermController.StopStyledContentWatching()
}
