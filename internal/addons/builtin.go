package addons

// Builtin lists integrations that ship compiled into Cyber Life but are
// presented through the same addon registry, so the manager UI shows one
// consistent catalog. They have no Dir/Entry and are configured through
// their own Settings sections.
func Builtin() []Addon {
	mk := func(id, name, icon, desc, category string, tags ...string) Addon {
		return Addon{
			Manifest: Manifest{
				ID: id, Name: name, Icon: icon, Version: "built-in",
				Description: desc, Category: category, Tags: tags,
			},
			BuiltIn: true,
			Enabled: true,
		}
	}
	return []Addon{
		mk("gmail", "Gmail", "✉️", "Mail module, unread-mail widget and the gmail agent skill for linked Google accounts", "integrations", "mail"),
		mk("jira", "Jira", "🧩", "Two-way kanban board sync with Jira projects", "integrations", "kanban"),
		mk("elevenlabs", "Voice Dictation", "🎙️", "ElevenLabs speech-to-text for the terminal input (⌘R)", "integrations", "voice"),
		mk("health", "Project Health", "🏥", "Health checks per project: library, custom checks, agent evaluation", "productivity", "quality"),
		mk("pomodoro", "Pomodoro", "🍅", "Focus timer widget", "productivity", "focus"),
		mk("iterm", "iTerm2 Escape Hatch", "🖥️", "Open any session in iTerm2 (macOS)", "terminal", "macos"),
	}
}

func IsBuiltin(id string) bool {
	for _, a := range Builtin() {
		if a.ID == id {
			return true
		}
	}
	return false
}

// Enabled reports whether an addon is on: built-ins default to on,
// installed addons default to off until explicitly enabled
func Enabled(id string, enabled map[string]bool) bool {
	if v, ok := enabled[id]; ok {
		return v
	}
	return IsBuiltin(id)
}
