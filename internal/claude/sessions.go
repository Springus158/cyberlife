package claude

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"

	"github.com/kalor62/cyberlife/internal/logging"
)

// SessionInfo is the live state of one Claude Code process, read from the
// heartbeat files Claude Code maintains under ~/.claude/sessions/<pid>.json.
type SessionInfo struct {
	SessionID  string `json:"sessionId"`
	PID        int    `json:"pid"`
	Status     string `json:"status"` // working | waiting | idle
	WaitingFor string `json:"waitingFor"`
	UpdatedAt  int64  `json:"updatedAt"`
	Cwd        string `json:"cwd"`
}

const maxSessionFileBytes = 64 * 1024

// LiveSessions scans the heartbeat directory and returns sessions whose
// process is actually alive — stale files from crashed sessions linger, so
// the pid check is what separates history from reality.
func LiveSessions() []SessionInfo {
	home, err := os.UserHomeDir()
	if err != nil {
		logging.Debug("claude sessions: no home dir", "error", err)
		return nil
	}
	dir := filepath.Join(home, ".claude", "sessions")
	entries, err := os.ReadDir(dir)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			logging.Debug("claude sessions: cannot read dir", "dir", dir, "error", err)
		}
		return nil
	}
	var out []SessionInfo
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		info, ok := parseSessionFile(filepath.Join(dir, e.Name()))
		if ok {
			out = append(out, info)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Status != out[j].Status {
			return statusRank(out[i].Status) < statusRank(out[j].Status)
		}
		return out[i].UpdatedAt > out[j].UpdatedAt
	})
	return out
}

func parseSessionFile(path string) (SessionInfo, bool) {
	bytes, err := os.ReadFile(path)
	if err != nil || len(bytes) > maxSessionFileBytes {
		return SessionInfo{}, false
	}
	var raw struct {
		SessionID  string `json:"sessionId"`
		PID        int    `json:"pid"`
		Status     string `json:"status"`
		WaitingFor string `json:"waitingFor"`
		UpdatedAt  int64  `json:"updatedAt"`
		Cwd        string `json:"cwd"`
	}
	if err := json.Unmarshal(bytes, &raw); err != nil {
		logging.Debug("claude sessions: malformed state file", "path", path, "error", err)
		return SessionInfo{}, false
	}
	if raw.SessionID == "" || raw.PID <= 0 || !processAlive(raw.PID) {
		return SessionInfo{}, false
	}
	return SessionInfo{
		SessionID:  raw.SessionID,
		PID:        raw.PID,
		Status:     mapStatus(raw.Status),
		WaitingFor: raw.WaitingFor,
		UpdatedAt:  raw.UpdatedAt,
		Cwd:        raw.Cwd,
	}, true
}

// Claude Code v2.1 writes busy|idle|waiting|shell (older builds: running).
// The file is authoritative — a long agentic turn keeps "busy" with an old
// timestamp, exactly the sessions that must show as working. Unknown values
// degrade to idle rather than guessing.
func mapStatus(raw string) string {
	switch raw {
	case "busy", "running":
		return "working"
	case "waiting":
		return "waiting"
	default:
		return "idle"
	}
}

func statusRank(s string) int {
	switch s {
	case "waiting":
		return 0
	case "working":
		return 1
	default:
		return 2
	}
}

// Signal 0 checks existence without delivering anything; EPERM means the
// process exists but belongs to someone else — still alive.
func processAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

// KillSession terminates a Claude Code process. Only pids currently present
// in the heartbeat dir count — this must never become a generic kill(1).
func KillSession(pid int, force bool) error {
	for _, s := range LiveSessions() {
		if s.PID != pid {
			continue
		}
		sig := syscall.SIGTERM
		if force {
			sig = syscall.SIGKILL
		}
		if err := syscall.Kill(pid, sig); err != nil {
			return fmt.Errorf("kill pid %d: %w", pid, err)
		}
		logging.Info("claude session killed", "pid", pid, "cwd", s.Cwd, "force", force)
		return nil
	}
	return fmt.Errorf("pid %d is not a live Claude Code session", pid)
}
