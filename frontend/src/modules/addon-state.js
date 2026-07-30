// Enabled-state (and names) of built-in addons, kept fresh by addon-host.
// Core modules consult builtinOn() to hide features whose addon the user
// disabled; before the first sync everything reads as on.

const builtins = new Map(); // id -> { enabled, name }

export function setBuiltinStates(addonsList) {
  builtins.clear();
  for (const a of addonsList || []) {
    if (a.builtIn) builtins.set(a.id, { enabled: !!a.enabled, name: a.name || a.id });
  }
}

export function builtinOn(id) {
  return builtins.has(id) ? builtins.get(id).enabled : true;
}

export function builtinName(id) {
  return builtins.get(id)?.name || id;
}

// Optimistic update for UI that reacts faster than the addon-host sync
export function setBuiltinOn(id, enabled) {
  const entry = builtins.get(id);
  if (entry) entry.enabled = enabled;
}
