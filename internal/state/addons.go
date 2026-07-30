package state

import (
	"encoding/json"
	"fmt"
)

const (
	maxAddonKeys      = 256
	maxAddonValueSize = 64 * 1024
)

// GetAddonsEnabled returns a copy of the addon enable map
func (m *Manager) GetAddonsEnabled() map[string]bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make(map[string]bool, len(m.state.AddonsEnabled))
	for k, v := range m.state.AddonsEnabled {
		out[k] = v
	}
	return out
}

// SetAddonEnabled turns an addon on or off. The value is stored
// explicitly because built-ins default to on — an absent key and a
// stored false mean different things there.
func (m *Manager) SetAddonEnabled(id string, enabled bool) {
	m.mu.Lock()
	if m.state.AddonsEnabled == nil {
		m.state.AddonsEnabled = make(map[string]bool)
	}
	m.state.AddonsEnabled[id] = enabled
	m.mu.Unlock()
	m.Save()
}

// GetAddonData returns a copy of one addon's key-value store
func (m *Manager) GetAddonData(addonID string) map[string]json.RawMessage {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make(map[string]json.RawMessage)
	for k, v := range m.state.AddonData[addonID] {
		out[k] = append(json.RawMessage{}, v...)
	}
	return out
}

// SetAddonKey stores one JSON value in an addon's namespace
func (m *Manager) SetAddonKey(addonID, key string, value json.RawMessage) error {
	if key == "" {
		return fmt.Errorf("key is required")
	}
	if len(value) > maxAddonValueSize {
		return fmt.Errorf("value exceeds %d bytes", maxAddonValueSize)
	}
	m.mu.Lock()
	defer func() { m.mu.Unlock(); m.Save() }()
	if m.state.AddonData == nil {
		m.state.AddonData = make(map[string]map[string]json.RawMessage)
	}
	data := m.state.AddonData[addonID]
	if data == nil {
		data = make(map[string]json.RawMessage)
		m.state.AddonData[addonID] = data
	}
	if _, exists := data[key]; !exists && len(data) >= maxAddonKeys {
		return fmt.Errorf("addon storage is full (%d keys max)", maxAddonKeys)
	}
	data[key] = append(json.RawMessage{}, value...)
	return nil
}

// DeleteAddonKey removes one key; an empty key clears the whole namespace
func (m *Manager) DeleteAddonKey(addonID, key string) {
	m.mu.Lock()
	if key == "" {
		delete(m.state.AddonData, addonID)
	} else if data := m.state.AddonData[addonID]; data != nil {
		delete(data, key)
	}
	m.mu.Unlock()
	m.Save()
}
