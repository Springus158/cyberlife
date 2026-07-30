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
