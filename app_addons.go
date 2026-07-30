package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/kalor62/cyberlife/internal/addons"
	"github.com/kalor62/cyberlife/internal/platform"
	"github.com/kalor62/cyberlife/internal/version"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// Wails bindings for the addon platform — the UI and the addon loader use
// these directly (unlike agents, which go through the gated API/MCP).

type AddonsInfo struct {
	Addons     []addons.Addon `json:"addons"`
	Dir        string         `json:"dir"`
	Categories []string       `json:"categories"`
}

func (a *App) AddonsList() AddonsInfo {
	dir, _ := addons.Dir()
	list := addons.LoadAll(a.stateManager.GetAddonsEnabled())
	if list == nil {
		list = []addons.Addon{}
	}
	return AddonsInfo{Addons: list, Dir: dir, Categories: addons.Categories}
}

func (a *App) SetAddonEnabled(id string, enabled bool) error {
	addon, ok := addons.Get(id, a.stateManager.GetAddonsEnabled())
	if !ok {
		return fmt.Errorf("addon %q not found", id)
	}
	if enabled && addon.Error != "" {
		return fmt.Errorf("addon %q has a manifest problem: %s", id, addon.Error)
	}
	a.stateManager.SetAddonEnabled(id, enabled)
	a.syncAgentSkills()
	runtime.EventsEmit(a.ctx, "addons-changed", nil)
	return nil
}

func (a *App) addonOn(id string) bool {
	return addons.Enabled(id, a.stateManager.GetAddonsEnabled())
}

func (a *App) GetAppVersion() string {
	return version.Number
}

// AddonsReload rescans the addons directory and asks the frontend to
// re-import enabled entries
func (a *App) AddonsReload() AddonsInfo {
	runtime.EventsEmit(a.ctx, "addons-changed", nil)
	return a.AddonsList()
}

// AddonStorageAll returns an addon's KV store as key -> JSON text
func (a *App) AddonStorageAll(addonID string) map[string]string {
	out := make(map[string]string)
	for k, v := range a.stateManager.GetAddonData(addonID) {
		out[k] = string(v)
	}
	return out
}

func (a *App) AddonStorageSet(addonID, key, valueJSON string) error {
	if !json.Valid([]byte(valueJSON)) {
		return fmt.Errorf("value must be valid JSON")
	}
	return a.stateManager.SetAddonKey(addonID, key, json.RawMessage(valueJSON))
}

func (a *App) AddonStorageDelete(addonID, key string) {
	a.stateManager.DeleteAddonKey(addonID, key)
}

// OpenAddonsDir reveals ~/.cyberlife/addons in the system file manager
func (a *App) OpenAddonsDir() error {
	dir, err := addons.Dir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return platform.OpenExternal(dir)
}
