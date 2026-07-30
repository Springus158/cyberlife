package iterm

import (
	"bufio"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/kalor62/cyberlife/internal/logging"
)

// Size given to our control client when it is the only client attached;
// without it detached tmux windows fall back to 80x24.
const tmuxControlCols, tmuxControlRows = 200, 50

// tmuxControlWatcher keeps one `tmux -C` client attached to the watched session
// and recaptures the pane whenever tmux reports activity, so styled content
// streams without iTerm2 or the Python bridge.
type tmuxControlWatcher struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout io.ReadCloser
	events chan struct{}
	stop   chan struct{}
	done   chan struct{}
}

func (c *Controller) startTmuxControlWatch(virtualID, name string, styledHandler func(*StyledContent)) error {
	bin := findTmuxPath()
	if bin == "" {
		return fmt.Errorf("tmux not found")
	}
	cmd := exec.Command(bin, "-C", "attach-session", "-t", "="+name)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}

	w := &tmuxControlWatcher{
		cmd:    cmd,
		stdin:  stdin,
		stdout: stdout,
		events: make(chan struct{}, 1),
		stop:   make(chan struct{}),
		done:   make(chan struct{}),
	}
	c.tmuxMu.Lock()
	c.tmuxControl = w
	c.tmuxMu.Unlock()

	// Windows keep their 80x24 default size unless some client dictates one;
	// only do it when no real client is attached so we never fight iTerm.
	if tty, _ := tmuxHostClient(); tty == "" {
		fmt.Fprintf(stdin, "refresh-client -C %dx%d\n", tmuxControlCols, tmuxControlRows)
	}

	go w.readLoop()
	go w.captureLoop(c, virtualID, name, styledHandler)
	logging.Info("tmux control-mode watch started", "session", name)
	return nil
}

// readLoop turns control-mode notifications into coalesced dirty signals
func (w *tmuxControlWatcher) readLoop() {
	defer close(w.done)
	scanner := bufio.NewScanner(w.stdout)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "%") {
			continue
		}
		switch strings.SplitN(line, " ", 2)[0] {
		case "%begin", "%end", "%error":
			continue
		case "%exit":
			return
		}
		select {
		case w.events <- struct{}{}:
		default:
		}
	}
}

func (w *tmuxControlWatcher) captureLoop(c *Controller, virtualID, name string, styledHandler func(*StyledContent)) {
	emit := func() {
		if content := c.captureStyledTmuxScreen(virtualID, name); content != nil {
			styledHandler(content)
		}
	}
	emit()

	// Safety net for changes with no notification (copy-mode scroll, missed events)
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-w.stop:
			return
		case <-w.done:
			// Client died (session killed, server gone) — final state stays on screen;
			// the status poller removes the card when the session is gone.
			logging.Info("tmux control client exited", "session", name)
			return
		case <-w.events:
			// Let a burst of output settle, then drain and capture once;
			// kept short so typed characters echo without visible lag
			time.Sleep(20 * time.Millisecond)
			select {
			case <-w.events:
			default:
			}
			emit()
		case <-ticker.C:
			emit()
		}
	}
}

func (w *tmuxControlWatcher) close() {
	close(w.stop)
	// Ask the client to detach; fall back to killing it
	fmt.Fprintln(w.stdin, "detach-client")
	select {
	case <-w.done:
	case <-time.After(500 * time.Millisecond):
		if w.cmd.Process != nil {
			if err := w.cmd.Process.Kill(); err != nil {
				logging.Debug("tmux control client kill", "error", err)
			}
		}
	}
	go func() {
		if err := w.cmd.Wait(); err != nil {
			logging.Debug("tmux control client exited", "error", err)
		}
	}()
}

// captureStyledTmuxScreen grabs the visible pane with colors plus dims/cursor
// in a single tmux invocation, skipping emission when nothing changed. The
// cursor position is part of the change hash, so bare cursor moves emit too.
func (c *Controller) captureStyledTmuxScreen(virtualID, name string) *StyledContent {
	target := tmuxPaneTarget(name)
	out, err := tmuxExec("capture-pane", "-p", "-e", "-t", target,
		";", "display-message", "-p", "-t", target, "\x1f#{pane_width} #{pane_height} #{cursor_x} #{cursor_y}")
	if err != nil {
		logging.Debug("tmux capture-pane failed", "session", name, "error", err)
		return nil
	}

	c.tmuxMu.Lock()
	changed := out != c.tmuxPollHash
	if changed {
		c.tmuxPollHash = out
	}
	c.tmuxMu.Unlock()
	if !changed {
		return nil
	}

	screen, dims := splitCaptureDims(out)

	content := &StyledContent{
		SessionID: virtualID,
		Lines:     parseStyledScreen(screen),
		Cols:      80,
	}
	content.Rows = len(content.Lines)
	if parts := strings.Fields(dims); len(parts) == 4 {
		content.Cols, _ = strconv.Atoi(parts[0])
		content.Rows, _ = strconv.Atoi(parts[1])
		content.Cursor.X, _ = strconv.Atoi(parts[2])
		content.Cursor.Y, _ = strconv.Atoi(parts[3])
	}
	return content
}

// splitCaptureDims separates the captured screen from the trailing
// display-message dims line. The \x1f marker between them is escaped to the
// literal `\037` by tmux 3.4+ (format output only — the captured screen keeps
// its raw bytes). Whichever form occurs last is the real marker: the dims line
// follows the captured screen, so pane content can never sit past it.
func splitCaptureDims(out string) (screen, dims string) {
	idx, sepLen := strings.LastIndex(out, "\x1f"), 1
	if j := strings.LastIndex(out, `\037`); j > idx {
		idx, sepLen = j, len(`\037`)
	}
	if idx < 0 {
		return out, ""
	}
	return strings.TrimSuffix(out[:idx], "\n"), out[idx+sepLen:]
}
