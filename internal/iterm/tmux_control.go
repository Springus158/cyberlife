package iterm

import (
	"bufio"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/kalor62/cyberlife/internal/logging"
)

// Size given to our control client when it is the only client attached
// and the dashboard has not reported a view size yet. 200-wide was large
// enough that a fullscreen TUI painted full-width box lines, then wrapped
// them into a stacked mess once the real viewer size arrived.
const tmuxControlCols, tmuxControlRows = 120, 36

// tmuxControlWatcher keeps one `tmux -C` client attached to the watched session
// and recaptures the pane whenever tmux reports activity, so styled content
// streams without iTerm2 or the Python bridge.
type tmuxControlWatcher struct {
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	writeMu sync.Mutex
	stdout  io.ReadCloser
	events  chan struct{}
	stop    chan struct{}
	done    chan struct{}
}

func (w *tmuxControlWatcher) sendCommand(cmd string) error {
	w.writeMu.Lock()
	defer w.writeMu.Unlock()
	_, err := io.WriteString(w.stdin, cmd+"\n")
	return err
}

// tmuxControlCommand runs a tmux command through the attached control client's
// stdin — no process spawn, so keystrokes reach the session with minimal
// latency. Any session can be targeted through it (commands are server-wide).
// Returns false when no control client is attached or the write fails; the
// caller falls back to tmuxExec.
func (c *Controller) tmuxControlCommand(cmd string) bool {
	c.tmuxMu.Lock()
	w := c.tmuxControl
	c.tmuxMu.Unlock()
	if w == nil {
		return false
	}
	if err := w.sendCommand(cmd); err != nil {
		logging.Debug("tmux control write failed, falling back to exec", "error", err)
		return false
	}
	return true
}

// tmuxQuote wraps a value for tmux's control-mode command parser — unlike the
// exec path there is no argv boundary, so spaces and quotes in session names
// must be escaped.
func tmuxQuote(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	return `"` + s + `"`
}

// tmuxSendKeysFast sends literal text hex-encoded (send-keys -H) so no
// control-mode quoting rules apply to the payload, regardless of content.
func (c *Controller) tmuxSendKeysFast(name, text string, pressEnter bool) bool {
	target := tmuxQuote(tmuxPaneTarget(name))
	if text != "" {
		var b strings.Builder
		b.WriteString("send-keys -t ")
		b.WriteString(target)
		b.WriteString(" -H")
		for _, byt := range []byte(text) {
			fmt.Fprintf(&b, " %02x", byt)
		}
		if !c.tmuxControlCommand(b.String()) {
			return false
		}
	}
	if pressEnter {
		return c.tmuxControlCommand("send-keys -t " + target + " Enter")
	}
	return true
}

// SetViewSize records the dashboard viewer's character grid and, when our
// control client is the only one attached, resizes tmux to it so lines wrap
// at the visible width instead of the fixed 200-col default.
func (c *Controller) SetViewSize(cols, rows int) {
	cols = clampInt(cols, 40, 400)
	rows = clampInt(rows, 10, 200)
	c.tmuxMu.Lock()
	changed := cols != c.tmuxViewCols || rows != c.tmuxViewRows
	c.tmuxViewCols, c.tmuxViewRows = cols, rows
	w := c.tmuxControl
	c.tmuxMu.Unlock()
	if !changed || w == nil {
		return
	}
	if tty, _ := tmuxHostClient(); tty != "" {
		return
	}
	if err := w.sendCommand(fmt.Sprintf("refresh-client -C %dx%d", cols, rows)); err != nil {
		logging.Debug("tmux control refresh-client resize failed", "error", err)
	}
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
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
		c.tmuxMu.Lock()
		cols, rows := c.tmuxViewCols, c.tmuxViewRows
		c.tmuxMu.Unlock()
		if cols == 0 {
			cols, rows = tmuxControlCols, tmuxControlRows
		}
		if err := w.sendCommand(fmt.Sprintf("refresh-client -C %dx%d", cols, rows)); err != nil {
			logging.Debug("tmux control refresh-client failed", "error", err)
		}
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

	const minCaptureGap = 25 * time.Millisecond
	var lastCapture time.Time

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
			// Leading edge: an isolated change (a typed character echoing) is
			// captured immediately. Only when changes arrive faster than
			// minCaptureGap does the wait kick in, coalescing output bursts.
			if since := time.Since(lastCapture); since < minCaptureGap {
				time.Sleep(minCaptureGap - since)
				select {
				case <-w.events:
				default:
				}
			}
			emit()
			lastCapture = time.Now()
		case <-ticker.C:
			emit()
		}
	}
}

func (w *tmuxControlWatcher) close() {
	close(w.stop)
	// Ask the client to detach; fall back to killing it
	if err := w.sendCommand("detach-client"); err != nil {
		logging.Debug("tmux control detach failed", "error", err)
	}
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
		";", "display-message", "-p", "-t", target, "\x1f#{pane_width} #{pane_height} #{cursor_x} #{cursor_y} #{history_size}")
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
	if parts := strings.Fields(dims); len(parts) >= 4 {
		content.Cols, _ = strconv.Atoi(parts[0])
		content.Rows, _ = strconv.Atoi(parts[1])
		content.Cursor.X, _ = strconv.Atoi(parts[2])
		content.Cursor.Y, _ = strconv.Atoi(parts[3])
		if len(parts) >= 5 {
			content.HistorySize, _ = strconv.Atoi(parts[4])
		}
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
