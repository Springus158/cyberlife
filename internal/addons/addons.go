// Package addons discovers and validates user-installed addons: directories
// under ~/.cyberlife/addons, each with an addon.json manifest and an optional
// frontend entry module served to the webview by the local API server.
package addons

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/kalor62/cyberlife/internal/paths"
)

var idPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,63}$`)

// Categories is the closed set shown as filters in the Addons manager;
// unknown values are coerced to "other" so filtering stays predictable.
var Categories = []string{
	"productivity", "integrations", "terminal", "widgets",
	"automation", "appearance", "development", "other",
}

// KnownPermissions mirrors the API skill groups an addon may request
// access to via api() calls from its frontend entry.
var KnownPermissions = []string{
	"board", "health", "auto", "widgets", "term",
	"projects", "tasks", "notes", "prompts", "system", "gmail", "addons",
}

type WidgetDecl struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Icon        string `json:"icon,omitempty"`
	Description string `json:"description,omitempty"`
	Dashboard   bool   `json:"dashboard,omitempty"`
}

type ModuleDecl struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Icon  string `json:"icon,omitempty"`
}

type Manifest struct {
	ID          string       `json:"id"`
	Name        string       `json:"name"`
	Icon        string       `json:"icon,omitempty"`
	Version     string       `json:"version"`
	Description string       `json:"description,omitempty"`
	Author      string       `json:"author,omitempty"`
	Category    string       `json:"category,omitempty"`
	Tags        []string     `json:"tags,omitempty"`
	Entry       string       `json:"entry,omitempty"`
	Permissions []string     `json:"permissions,omitempty"`
	Widgets     []WidgetDecl `json:"widgets,omitempty"`
	Modules     []ModuleDecl `json:"modules,omitempty"`
	Homepage    string       `json:"homepage,omitempty"`
}

type Addon struct {
	Manifest
	Dir     string `json:"dir,omitempty"`
	BuiltIn bool   `json:"builtIn,omitempty"`
	Enabled bool   `json:"enabled"`
	Error   string `json:"error,omitempty"`
}

func Dir() (string, error) {
	return paths.Addons()
}

// LoadAll returns built-in addons followed by installed ones from the
// addons directory; a broken manifest yields an entry with Error set
// (visible in the manager UI) instead of being dropped.
func LoadAll(enabled map[string]bool) []Addon {
	out := Builtin()
	for i := range out {
		out[i].Enabled = Enabled(out[i].ID, enabled)
	}
	dir, err := Dir()
	if err != nil {
		return out
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return out
	}
	var installed []Addon
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		a := load(filepath.Join(dir, e.Name()), e.Name())
		if IsBuiltin(a.ID) {
			a.Error = fmt.Sprintf("id %q is taken by a built-in addon", a.ID)
		}
		a.Enabled = a.Error == "" && enabled[a.ID]
		installed = append(installed, a)
	}
	sort.Slice(installed, func(i, j int) bool { return installed[i].ID < installed[j].ID })
	return append(out, installed...)
}

func Get(id string, enabled map[string]bool) (Addon, bool) {
	for _, a := range LoadAll(enabled) {
		if a.ID == id {
			return a, true
		}
	}
	return Addon{}, false
}

// EnabledWidgetDecls returns widget declarations of all enabled addons,
// for merging into the core widget catalog.
func EnabledWidgetDecls(enabled map[string]bool) []WidgetDecl {
	var out []WidgetDecl
	for _, a := range LoadAll(enabled) {
		if !a.Enabled {
			continue
		}
		out = append(out, a.Widgets...)
	}
	return out
}

func load(dir, dirName string) Addon {
	a := Addon{Dir: dir}
	a.ID = dirName
	data, err := os.ReadFile(filepath.Join(dir, "addon.json"))
	if err != nil {
		a.Error = "addon.json missing or unreadable"
		return a
	}
	var m Manifest
	if err := json.Unmarshal(data, &m); err != nil {
		a.Error = fmt.Sprintf("addon.json invalid: %v", err)
		return a
	}
	a.Manifest = m
	if a.ID == "" {
		a.ID = dirName
	}
	a.Category = normalizeCategory(a.Category)
	a.Error = validate(a, dirName)
	return a
}

func validate(a Addon, dirName string) string {
	if !idPattern.MatchString(a.ID) {
		return "id must be 2-64 chars of a-z, 0-9, hyphens"
	}
	if a.ID != dirName {
		return fmt.Sprintf("id %q must match the folder name %q", a.ID, dirName)
	}
	if strings.TrimSpace(a.Name) == "" {
		return "name is required"
	}
	if a.Entry != "" {
		if err := validateEntry(a.Dir, a.Entry); err != "" {
			return err
		}
	}
	for _, p := range a.Permissions {
		if !contains(KnownPermissions, p) {
			return fmt.Sprintf("unknown permission %q (known: %s)", p, strings.Join(KnownPermissions, ", "))
		}
	}
	for _, w := range a.Widgets {
		if !strings.HasPrefix(w.ID, a.ID+".") {
			return fmt.Sprintf("widget id %q must be namespaced as %q", w.ID, a.ID+".<name>")
		}
		if strings.TrimSpace(w.Title) == "" {
			return fmt.Sprintf("widget %q needs a title", w.ID)
		}
	}
	for _, m := range a.Modules {
		if !strings.HasPrefix(m.ID, a.ID+".") {
			return fmt.Sprintf("module id %q must be namespaced as %q", m.ID, a.ID+".<name>")
		}
		if strings.TrimSpace(m.Label) == "" {
			return fmt.Sprintf("module %q needs a label", m.ID)
		}
	}
	return ""
}

func validateEntry(dir, entry string) string {
	if filepath.IsAbs(entry) || strings.Contains(entry, "..") {
		return "entry must be a relative path inside the addon folder"
	}
	full := filepath.Join(dir, filepath.FromSlash(entry))
	if _, err := os.Stat(full); err != nil {
		return fmt.Sprintf("entry %q not found in addon folder", entry)
	}
	return ""
}

func normalizeCategory(c string) string {
	c = strings.ToLower(strings.TrimSpace(c))
	if c == "" || !contains(Categories, c) {
		return "other"
	}
	return c
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}
