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

// Shipped lists addons that live in the repo's addons/ folder and are
// installed into ~/.cyberlife/addons by build.sh. They are ordinary addons —
// files on disk, editable, hot-reloadable — but they come with the app, so
// they default to on instead of waiting to be switched on by hand.
var Shipped = []string{"terminarz"}

func IsShipped(id string) bool {
	for _, s := range Shipped {
		if s == id {
			return true
		}
	}
	return false
}

// Enabled reports whether an addon is on: built-ins and addons shipped with
// the app default to on, anything installed by the user defaults to off until
// explicitly enabled
func Enabled(id string, enabled map[string]bool) bool {
	if v, ok := enabled[id]; ok {
		return v
	}
	return IsBuiltin(id) || IsShipped(id)
}
