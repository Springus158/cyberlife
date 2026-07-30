package iterm

import (
	"reflect"
	"testing"
)

func TestSplitTmuxFields(t *testing.T) {
	tests := []struct {
		name string
		line string
		n    int
		want []string
	}{
		{
			name: "raw separator (tmux < 3.4)",
			line: "Sample-Project-1\x1f/home/user/project",
			n:    2,
			want: []string{"Sample-Project-1", "/home/user/project"},
		},
		{
			name: "octal-escaped separator (tmux 3.4+)",
			line: `Sample-Project-1\037/home/user/project`,
			n:    2,
			want: []string{"Sample-Project-1", "/home/user/project"},
		},
		{
			name: "three escaped fields",
			line: `0\037/dev/pts/2\037main`,
			n:    3,
			want: []string{"0", "/dev/pts/2", "main"},
		},
		{
			name: "no separator",
			line: "just-a-name",
			n:    2,
			want: []string{"just-a-name"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := splitTmuxFields(tt.line, tt.n); !reflect.DeepEqual(got, tt.want) {
				t.Errorf("splitTmuxFields(%q, %d) = %v, want %v", tt.line, tt.n, got, tt.want)
			}
		})
	}
}

func TestSplitCaptureDims(t *testing.T) {
	tests := []struct {
		name       string
		out        string
		wantScreen string
		wantDims   string
	}{
		{
			name:       "raw marker (tmux < 3.4)",
			out:        "line one\nline two\n\x1f80 24 5 3",
			wantScreen: "line one\nline two",
			wantDims:   "80 24 5 3",
		},
		{
			name:       "escaped marker (tmux 3.4+)",
			out:        "line one\nline two\n" + `\037` + "80 24 5 3",
			wantScreen: "line one\nline two",
			wantDims:   "80 24 5 3",
		},
		{
			name:       "raw marker wins over escaped text in pane content",
			out:        "pane shows \\037 literally\n\x1f80 24 0 0",
			wantScreen: "pane shows \\037 literally",
			wantDims:   "80 24 0 0",
		},
		{
			name:       "escaped marker wins over raw byte in pane content",
			out:        "pane holds a raw \x1f byte\n" + `\037` + "80 24 0 0",
			wantScreen: "pane holds a raw \x1f byte",
			wantDims:   "80 24 0 0",
		},
		{
			name:       "no marker at all",
			out:        "just a screen",
			wantScreen: "just a screen",
			wantDims:   "",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			screen, dims := splitCaptureDims(tt.out)
			if screen != tt.wantScreen || dims != tt.wantDims {
				t.Errorf("splitCaptureDims(%q) = (%q, %q), want (%q, %q)",
					tt.out, screen, dims, tt.wantScreen, tt.wantDims)
			}
		})
	}
}
