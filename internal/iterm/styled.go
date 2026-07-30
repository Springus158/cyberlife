// Package-level styled content types: what the tmux stream produces and the
// frontend renders.
package iterm

// StyledRun represents a run of text with uniform styling
type StyledRun struct {
	Text          string `json:"t"`
	FgColor       string `json:"fg,omitempty"`
	BgColor       string `json:"bg,omitempty"`
	Bold          bool   `json:"b,omitempty"`
	Italic        bool   `json:"i,omitempty"`
	Underline     bool   `json:"u,omitempty"`
	Strikethrough bool   `json:"s,omitempty"`
	Inverse       bool   `json:"inv,omitempty"`
	Faint         bool   `json:"f,omitempty"`
}

// CursorPos represents cursor position
type CursorPos struct {
	X int `json:"x"`
	Y int `json:"y"`
}

// StyledContent represents a full screen of styled terminal content
type StyledContent struct {
	SessionID string        `json:"sessionId"`
	Lines     [][]StyledRun `json:"lines"`
	Cursor    CursorPos     `json:"cursor"`
	Cols      int           `json:"cols"`
	Rows      int           `json:"rows"`
}

// ProfileColors represents the iTerm2 profile color palette
type ProfileColors struct {
	Fg     string   `json:"fg"`
	Bg     string   `json:"bg"`
	Cursor string   `json:"cursor"`
	Ansi   []string `json:"ansi"`
}

// ProfileData is sent from the Python bridge when a session's profile is read
type ProfileData struct {
	SessionID string        `json:"sessionId"`
	Colors    ProfileColors `json:"colors"`
}
