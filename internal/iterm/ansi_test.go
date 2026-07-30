package iterm

import "testing"

func TestParseStyledScreenBasicColors(t *testing.T) {
	raw := "\x1b[31mred\x1b[0m plain \x1b[1;32mboldgreen"
	lines := parseStyledScreen(raw)
	if len(lines) != 1 {
		t.Fatalf("expected 1 line, got %d", len(lines))
	}
	runs := lines[0]
	if len(runs) != 3 {
		t.Fatalf("expected 3 runs, got %d: %+v", len(runs), runs)
	}
	if runs[0].Text != "red" || runs[0].FgColor != defaultTmuxColors.Ansi[1] {
		t.Errorf("run0 = %+v", runs[0])
	}
	if runs[1].Text != " plain " || runs[1].FgColor != "" || runs[1].Bold {
		t.Errorf("run1 = %+v", runs[1])
	}
	if runs[2].Text != "boldgreen" || !runs[2].Bold || runs[2].FgColor != defaultTmuxColors.Ansi[2] {
		t.Errorf("run2 = %+v", runs[2])
	}
}

func TestParseStyledScreenStateAcrossLines(t *testing.T) {
	raw := "\x1b[33mfirst\nsecond\x1b[39m end"
	lines := parseStyledScreen(raw)
	if len(lines) != 2 {
		t.Fatalf("expected 2 lines, got %d", len(lines))
	}
	if lines[1][0].FgColor != defaultTmuxColors.Ansi[3] {
		t.Errorf("yellow should carry to line 2: %+v", lines[1][0])
	}
	last := lines[1][len(lines[1])-1]
	if last.Text != " end" || last.FgColor != "" {
		t.Errorf("39 should reset fg: %+v", last)
	}
}

func TestParseStyledScreenExtendedColors(t *testing.T) {
	raw := "\x1b[38;5;196mx\x1b[38;2;10;20;30my\x1b[48;5;21mz"
	runs := parseStyledScreen(raw)[0]
	if len(runs) != 3 {
		t.Fatalf("expected 3 runs, got %d: %+v", len(runs), runs)
	}
	if runs[0].FgColor != "#ff0000" {
		t.Errorf("256-color 196 should be #ff0000: %q", runs[0].FgColor)
	}
	if runs[1].FgColor != "#0a141e" {
		t.Errorf("truecolor: %q", runs[1].FgColor)
	}
	if runs[2].BgColor != "#0000ff" {
		t.Errorf("bg 256-color 21 should be #0000ff: %q", runs[2].BgColor)
	}
}

func TestParseStyledScreenIgnoresNonSGR(t *testing.T) {
	raw := "\x1b[2Jclean\x1b]0;title\x07ed\x1b(Btext"
	runs := parseStyledScreen(raw)[0]
	got := ""
	for _, r := range runs {
		got += r.Text
	}
	if got != "cleanedtext" {
		t.Errorf("non-SGR sequences should vanish, got %q", got)
	}
}

func TestParseStyledScreenAttributes(t *testing.T) {
	raw := "\x1b[3;4;7;9ma\x1b[23;24;27;29mb"
	runs := parseStyledScreen(raw)[0]
	if !runs[0].Italic || !runs[0].Underline || !runs[0].Inverse || !runs[0].Strikethrough {
		t.Errorf("attrs on: %+v", runs[0])
	}
	if runs[1].Italic || runs[1].Underline || runs[1].Inverse || runs[1].Strikethrough {
		t.Errorf("attrs off: %+v", runs[1])
	}
}

func TestXterm256Grayscale(t *testing.T) {
	if got := xterm256Hex(232); got != "#080808" {
		t.Errorf("232 = %q", got)
	}
	if got := xterm256Hex(255); got != "#eeeeee" {
		t.Errorf("255 = %q", got)
	}
}
