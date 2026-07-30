package claude

import (
	"bytes"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Status represents the detected state of Claude CLI
type Status string

const (
	StatusNone        Status = "none"
	StatusWorking     Status = "working"
	StatusIdle        Status = "idle"
	StatusNeedsAction Status = "needs_action"
)

// TerminalState tracks the Claude CLI state for a terminal
type TerminalState struct {
	Status          Status
	LastSpinner     time.Time
	LastActivity    time.Time
	HasPrompt       bool
	HasQuestion     bool
	ConsecutiveIdle int
}

// Detector analyzes terminal output to detect Claude CLI status
type Detector struct {
	terminalStates map[string]*TerminalState
	mu             sync.RWMutex

	// Patterns for detection
	questionPatterns []*regexp.Regexp
}

// NewDetector creates a new Claude CLI detector
func NewDetector() *Detector {
	d := &Detector{
		terminalStates: make(map[string]*TerminalState),
	}

	// Compile question patterns for Claude CLI
	d.questionPatterns = []*regexp.Regexp{
		regexp.MustCompile(`\([Yy]/[Nn]\)`),                // (Y/n) or (y/N)
		regexp.MustCompile(`\[[0-9]+\]`),                   // [1], [2], [3] numbered options
		regexp.MustCompile(`(?i)allow|deny|accept|reject`), // Permission prompts
		regexp.MustCompile(`(?i)press enter|hit enter`),    // Press enter prompts
		regexp.MustCompile(`(?i)continue\?`),               // Continue? prompts
		regexp.MustCompile(`(?i)web.?search`),              // Web search permission
		regexp.MustCompile(`(?i)enable.*\?`),               // Enable X?
		regexp.MustCompile(`(?i)would you like`),           // Would you like to...
		regexp.MustCompile(`(?i)do you want`),              // Do you want to...
		regexp.MustCompile(`(?i)proceed\?`),                // Proceed?
		regexp.MustCompile(`(?i)permission`),               // Permission requests
		regexp.MustCompile(`(?i)tool.*use`),                // Tool use permission
		regexp.MustCompile(`(?i)\(yes/no\)`),               // (yes/no)
		regexp.MustCompile(`(?i)approve|approving`),        // Approve prompts
	}

	return d
}

// Analyze processes terminal output and returns the detected Claude status
// Returns (status, changed) where changed indicates if the status has changed
func (d *Detector) Analyze(termID string, data []byte) (Status, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()

	state, exists := d.terminalStates[termID]
	if !exists {
		state = &TerminalState{
			Status:       StatusNone,
			LastActivity: time.Now(),
		}
		d.terminalStates[termID] = state
	}

	oldStatus := state.Status
	state.LastActivity = time.Now()

	// Check for braille spinner characters (Claude CLI spinner)
	if d.hasSpinner(data) {
		state.LastSpinner = time.Now()
		state.Status = StatusWorking
		state.HasPrompt = false
		state.HasQuestion = false
		state.ConsecutiveIdle = 0
		return state.Status, state.Status != oldStatus
	}

	// Check for question patterns (needs user action)
	if d.hasQuestion(data) {
		state.Status = StatusNeedsAction
		state.HasQuestion = true
		state.HasPrompt = false
		state.ConsecutiveIdle = 0
		return state.Status, state.Status != oldStatus
	}

	// Time-based idle detection:
	// If we were working (saw spinner) but haven't seen spinner for 2+ seconds
	// and we're receiving non-spinner output, Claude has likely finished
	timeSinceSpinner := time.Since(state.LastSpinner)
	wasWorking := state.Status == StatusWorking || !state.LastSpinner.IsZero()

	if wasWorking && timeSinceSpinner > 2*time.Second {
		// No spinner for 2+ seconds while receiving output = Claude finished
		// Check if output looks like it could contain a prompt
		if d.hasPrompt(data) || d.looksLikeCompletion(data) {
			state.Status = StatusIdle
			state.HasPrompt = true
			state.HasQuestion = false
			state.ConsecutiveIdle++
			return state.Status, state.Status != oldStatus
		}
	}

	// Check for prompt character ">" at end of visible line
	if d.hasPrompt(data) {
		// Prompt detected - Claude is idle and ready for input
		state.Status = StatusIdle
		state.HasPrompt = true
		state.HasQuestion = false
		state.ConsecutiveIdle++
		return state.Status, state.Status != oldStatus
	}

	// If we saw a spinner recently (within 1.5 seconds), keep working status
	if !state.LastSpinner.IsZero() && timeSinceSpinner < 1500*time.Millisecond {
		state.Status = StatusWorking
		return state.Status, state.Status != oldStatus
	}

	// Reset consecutive idle counter if output doesn't match idle pattern
	state.ConsecutiveIdle = 0

	return state.Status, state.Status != oldStatus
}

// looksLikeCompletion checks if output looks like Claude finished (cost summary, time summary, etc.)
func (d *Detector) looksLikeCompletion(data []byte) bool {
	text := strings.ToLower(string(data))

	// Common patterns when Claude finishes - time/cost summaries
	completionIndicators := []string{
		"for ", // "Sautéed for", "Cooked for", etc.
		"in ",  // "Done in", "Completed in"
		"cost",
		"token",
		"total",
		"ms", // milliseconds in timing
		"s",  // seconds in timing
	}

	// Count how many indicators are present
	matches := 0
	for _, indicator := range completionIndicators {
		if strings.Contains(text, indicator) {
			matches++
		}
	}

	// If we have 2+ indicators, likely a completion message
	return matches >= 2
}

// hasSpinner checks if data contains braille spinner characters
// Claude CLI uses braille pattern characters U+2800-U+28FF
// In UTF-8: 0xE2 0xA0 0x80 to 0xE2 0xA3 0xBF
func (d *Detector) hasSpinner(data []byte) bool {
	// Also check for clear line escape sequence which often precedes spinner
	hasClearLine := bytes.Contains(data, []byte{0x1b, '[', 'K'}) ||
		bytes.Contains(data, []byte{0x1b, '[', '2', 'K'})

	// Check for braille characters
	hasBraille := false
	for i := 0; i < len(data)-2; i++ {
		if data[i] == 0xE2 && data[i+1] >= 0xA0 && data[i+1] <= 0xA3 {
			hasBraille = true
			break
		}
	}

	// Spinner is detected when we have braille with clear line sequence
	// or just braille in a small chunk (spinner update)
	if hasBraille {
		if hasClearLine || len(data) < 100 {
			return true
		}
	}

	return false
}

// hasQuestion checks if data contains question patterns
func (d *Detector) hasQuestion(data []byte) bool {
	text := string(data)
	for _, pattern := range d.questionPatterns {
		if pattern.MatchString(text) {
			return true
		}
	}
	return false
}

// hasPrompt checks if data contains the Claude CLI prompt character
func (d *Detector) hasPrompt(data []byte) bool {
	text := string(data)
	cleaned := d.stripANSI(text)
	cleanedLower := bytes.ToLower([]byte(cleaned))

	// Check for completion indicators that mean Claude finished
	completionPatterns := [][]byte{
		[]byte("cooked"),        // "Cooked in X" or "Cooked for X"
		[]byte("total cost"),    // Cost summary
		[]byte("api cost"),      // API cost summary
		[]byte("input tokens"),  // Token summary
		[]byte("output tokens"), // Token summary
	}

	for _, pattern := range completionPatterns {
		if bytes.Contains(cleanedLower, pattern) {
			return true
		}
	}

	// Check for various Claude CLI prompt patterns:
	// 1. Line starting with "> " (the main prompt)
	// 2. Line containing just ">" at the end
	// 3. Pattern like "> [user input]" after newline

	// Look for newline followed by "> " which is the Claude prompt
	if bytes.Contains([]byte(cleaned), []byte("\n> ")) {
		return true
	}

	// Look for start of text being "> "
	if len(cleaned) >= 2 && cleaned[0] == '>' && cleaned[1] == ' ' {
		return true
	}

	// Check if text ends with just ">" (possibly with whitespace)
	trimmed := bytes.TrimRight([]byte(cleaned), " \t\n\r")
	if len(trimmed) > 0 && trimmed[len(trimmed)-1] == '>' {
		// Check if it's a standalone ">" or preceded by newline
		if len(trimmed) == 1 {
			return true
		}
		// Check if preceded by newline (prompt on its own line)
		if len(trimmed) >= 2 && (trimmed[len(trimmed)-2] == '\n' || trimmed[len(trimmed)-2] == '\r') {
			return true
		}
	}

	// Check for lines that are just ">" followed by space and cursor
	lines := bytes.Split([]byte(cleaned), []byte("\n"))
	for _, line := range lines {
		trimmedLine := bytes.TrimSpace(line)
		if len(trimmedLine) == 1 && trimmedLine[0] == '>' {
			return true
		}
		if len(trimmedLine) >= 2 && trimmedLine[0] == '>' && trimmedLine[1] == ' ' {
			return true
		}
	}

	return false
}

// stripANSI removes ANSI escape sequences from text
func (d *Detector) stripANSI(text string) string {
	ansiRegex := regexp.MustCompile(`\x1b\[[0-9;]*[a-zA-Z]`)
	return ansiRegex.ReplaceAllString(text, "")
}

// GetStatus returns the current status for a terminal
func (d *Detector) GetStatus(termID string) Status {
	d.mu.RLock()
	defer d.mu.RUnlock()

	if state, exists := d.terminalStates[termID]; exists {
		return state.Status
	}
	return StatusNone
}

// RemoveTerminal removes tracking for a terminal
func (d *Detector) RemoveTerminal(termID string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	delete(d.terminalStates, termID)
}

// ResetTerminal resets the status for a terminal
func (d *Detector) ResetTerminal(termID string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if state, exists := d.terminalStates[termID]; exists {
		state.Status = StatusNone
		state.HasPrompt = false
		state.HasQuestion = false
		state.LastSpinner = time.Time{}
		state.ConsecutiveIdle = 0
	}
}
