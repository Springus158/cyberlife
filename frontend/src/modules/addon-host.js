// Addon host: imports the frontend entry of every enabled addon from the
// local API server and hands each a scoped context (events, storage, api,
// widget registration). Reacts to "addons-changed" by deactivating and
// re-importing, so agents can hot-reload addons they are building.

import * as bus from './bus.js';
import { registerAddonWidget, removeAddonWidgets, rerenderSidebarWidgets } from './widgets.js';
import { registerAddonModule, unregisterAddonModules } from './module-host.js';
import { registerAddonSettingsSection, removeAddonSettingsSections, refreshSettingsIfOpen } from './settings-dashboard.js';
import { setBuiltinStates } from './addon-state.js';
import { renderModuleBar, getModules, getVisibleModules } from './shell.js';
import { AddonsList, AddonStorageAll, AddonStorageSet, AddonStorageDelete } from '../../wailsjs/go/main/App.js';
import { API_BASE } from './utils.js';

const active = new Map(); // addon id -> { addon, dispose, cleanups }
let reloadNonce = 0;
let syncing = false;

export async function initAddons() {
  bus.on('addons-changed', () => {
    reloadNonce++;
    syncAddons(true);
  });
  await syncAddons(false);
}

export function activeAddonIds() {
  return [...active.keys()];
}

async function syncAddons(reloadActive) {
  if (syncing) return;
  syncing = true;
  try {
    const info = await AddonsList();
    setBuiltinStates(info.addons);
    const enabled = (info.addons || []).filter(a => a.enabled && a.entry && !a.error);
    const wanted = new Set(enabled.map(a => a.id));
    for (const id of [...active.keys()]) {
      if (!wanted.has(id) || reloadActive) deactivate(id);
    }
    for (const addon of enabled) {
      if (!active.has(addon.id)) await activate(addon);
    }
    renderModuleBar();
    rerenderSidebarWidgets();
    refreshSettingsIfOpen();
    const activeMod = getModules().find(m => m.isActive?.());
    if (activeMod && typeof activeMod.hidden === 'function' && activeMod.hidden()) {
      getVisibleModules()[0]?.switchTo();
    }
  } catch (err) {
    console.warn('addon sync failed:', err);
  } finally {
    syncing = false;
  }
}

async function activate(addon) {
  const url = `${API_BASE}/addons/${addon.id}/${addon.entry}?v=${encodeURIComponent(addon.version || '0')}-${reloadNonce}`;
  const inst = { addon, dispose: null, cleanups: [] };
  try {
    const mod = await import(/* @vite-ignore */ url);
    if (typeof mod.default !== 'function') {
      console.warn(`addon ${addon.id}: entry has no default export function`);
      return;
    }
    active.set(addon.id, inst);
    inst.dispose = await mod.default(makeContext(addon, inst));
  } catch (err) {
    console.warn(`addon ${addon.id}: activation failed:`, err);
    active.delete(addon.id);
  }
}

function deactivate(id) {
  const inst = active.get(id);
  if (!inst) return;
  try {
    inst.dispose?.();
  } catch (err) {
    console.warn(`addon ${id}: dispose failed:`, err);
  }
  for (const cleanup of inst.cleanups) {
    try {
      cleanup();
    } catch (err) {
      console.warn(`addon ${id}: cleanup failed:`, err);
    }
  }
  removeAddonWidgets(id);
  unregisterAddonModules(id);
  removeAddonSettingsSections(id);
  active.delete(id);
}

const PATH_GROUPS = [
  ['/api/board', 'board'], ['/api/health', 'health'], ['/api/auto', 'auto'],
  ['/api/widgets', 'widgets'], ['/api/term', 'term'], ['/api/projects', 'projects'],
  ['/api/tasks', 'tasks'], ['/api/notes', 'notes'], ['/api/prompts', 'prompts'],
  ['/api/system', 'system'], ['/api/addons', 'addons'],
];

function requiredGroup(path) {
  return PATH_GROUPS.find(([prefix]) => path.startsWith(prefix))?.[1] || null;
}

function makeContext(addon, inst) {
  const namespaced = (id) => id.startsWith(`${addon.id}.`) ? id : `${addon.id}.${id}`;
  return {
    id: addon.id,
    manifest: addon,

    events: {
      on(name, fn) {
        const offFn = bus.on(name, fn);
        inst.cleanups.push(offFn);
        return offFn;
      },
      off: bus.off,
      emit: bus.emit,
    },

    storage: {
      async all() {
        const raw = await AddonStorageAll(addon.id);
        const out = {};
        for (const [k, v] of Object.entries(raw || {})) {
          try {
            out[k] = JSON.parse(v);
          } catch (err) {
            console.warn(`addon ${addon.id}: bad stored JSON for key ${k}:`, err);
          }
        }
        return out;
      },
      async get(key) {
        const all = await this.all();
        return all[key];
      },
      async set(key, value) {
        await AddonStorageSet(addon.id, key, JSON.stringify(value ?? null));
      },
      async remove(key) {
        await AddonStorageDelete(addon.id, key);
      },
    },

    registerWidget(desc) {
      if (!desc?.id || typeof desc.render !== 'function') {
        throw new Error('registerWidget needs {id, title, render(el)}');
      }
      registerAddonWidget({ ...desc, id: namespaced(desc.id), addonId: addon.id, addonName: addon.name || addon.id });
    },

    registerModule(desc) {
      if (!desc?.id || !desc.label || typeof desc.render !== 'function') {
        throw new Error('registerModule needs {id, label, render(el)}');
      }
      registerAddonModule(addon.id, { ...desc, id: namespaced(desc.id) });
    },

    registerSettingsSection(desc) {
      if (!desc?.label || typeof desc.render !== 'function') {
        throw new Error('registerSettingsSection needs {label, render(el)}');
      }
      const id = namespaced(desc.id || 'settings');
      registerAddonSettingsSection(addon.id, { ...desc, id, icon: desc.icon || addon.icon || '🧩' });
    },

    async api(path, body) {
      const group = requiredGroup(path);
      if (!group) throw new Error(`api(): unsupported path ${path}`);
      if (!(addon.permissions || []).includes(group)) {
        throw new Error(`api(): addon.json does not declare the "${group}" permission for ${path}`);
      }
      const opts = body === undefined
        ? undefined
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
      const res = await fetch(`${API_BASE}${path}`, opts);
      if (!res.ok) {
        throw new Error(`${path}: ${res.status} ${await res.text()}`);
      }
      return res.json();
    },

    log(...args) {
      console.log(`[addon:${addon.id}]`, ...args);
    },
  };
}
