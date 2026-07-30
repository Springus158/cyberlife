// Package platform wraps the small set of OS-specific operations so the
// rest of the codebase stays portable (macOS today, Linux-ready).
package platform

import (
	"fmt"
	"os/exec"
	"runtime"

	"github.com/kalor62/cyberlife/internal/logging"
)

// OpenExternal opens a file or URL with the system default handler
func OpenExternal(target string) error {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", target).Start()
	case "linux":
		return exec.Command("xdg-open", target).Start()
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", target).Start()
	default:
		return fmt.Errorf("no opener for %s", runtime.GOOS)
	}
}

// Notify shows a desktop notification; a missing mechanism only logs
func Notify(title, message string) error {
	switch runtime.GOOS {
	case "darwin":
		script := fmt.Sprintf("display notification %q with title %q", message, title)
		return exec.Command("osascript", "-e", script).Run()
	case "linux":
		return exec.Command("notify-send", title, message).Run()
	default:
		logging.Info("notification (no desktop mechanism)", "title", title, "message", message)
		return nil
	}
}

// IsMac reports whether mac-only integrations (AppleScript, iTerm) apply
func IsMac() bool {
	return runtime.GOOS == "darwin"
}
