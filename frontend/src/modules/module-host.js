// Module host: registers every full-screen view (core and addon) as a
// shell module from a single descriptor and owns the generic switch
// lifecycle (hide all panels -> show -> onShow -> repaint bar/status).

import { state } from './state.js';
import { renderTerminalDashboard, showTerminalDashboard, stopViewing, termModuleOnKey, DASHBOARD_TAB_ID, showDashboardPanel } from './terminal-dashboard.js';
import { STRUCTURE_TAB_ID, showStructurePanel, switchToStructureTab, structureModuleOnKey } from './structure-panel.jsx';
import { showPromptsPanel } from './tools-panel.js';
import { registerStateHandler } from './project-switcher.js';
import { HEALTH_TAB_ID, showHealthPanel, loadHealthData, healthModuleOnKey } from './health-dashboard.js';
import { NOTES_TAB_ID, showNotesPanel, renderNotesPanel } from './notes.js';
import { SETTINGS_TAB_ID, showSettingsPanel, renderSettingsPanel } from './settings-dashboard.js';
import { EMAIL_TAB_ID, showEmailPanel, renderEmailPanel, getEmailUnread, emailModuleOnKey } from './email-dashboard.js';
import { registerModule, unregisterModule, renderModuleBar, getModules, getVisibleModules } from './shell.js';
import { builtinOn } from './addon-state.js';
import { PROJECTS_TAB_ID, showProjectsPanel, renderProjectsPanel, projectsModuleOnKey } from './projects-module.js';
import { AUTO_TAB_ID, showAutoPanel, renderAutoPanel, autoModuleOnKey } from './auto-module.js';
import { DASH_TAB_ID, showDashPanel, renderDashPanel, dashModuleOnKey } from './dash-module.js';
import { BOARD_TAB_ID, showBoardPanel, renderBoardPanel, boardModuleOnKey } from './board-module.js';
import { HELP_TAB_ID, showHelpPanel, renderHelpPanel, helpModuleOnKey } from './help-module.js';

// Core module descriptors — one entry is all a view needs: show toggles
// its panel, onShow renders content after the panel becomes visible
const CORE_MODULES = [
  {
    id: DASHBOARD_TAB_ID, label: 'Term', icon: '✅', onKey: termModuleOnKey,
    show: showDashboardPanel,
    onShow: () => { showTerminalDashboard(); renderTerminalDashboard(); },
  },
  {
    id: PROJECTS_TAB_ID, label: 'Projects', icon: '📁', onKey: projectsModuleOnKey,
    show: showProjectsPanel, onShow: renderProjectsPanel,
  },
  {
    id: BOARD_TAB_ID, label: 'Board', icon: '📋', onKey: boardModuleOnKey,
    show: showBoardPanel, onShow: renderBoardPanel,
  },
  {
    // Health lives inside Projects — hidden module: no tab/digit, but
    // full keyboard behavior when opened (H on a project, g h)
    id: HEALTH_TAB_ID, label: 'Health', icon: '🏥', hidden: true, onKey: healthModuleOnKey,
    show: showHealthPanel, onShow: loadHealthData,
  },
  {
    id: STRUCTURE_TAB_ID, label: 'Files', icon: '📂', onKey: structureModuleOnKey,
    show: showStructurePanel, onShow: switchToStructureTab,
  },
  {
    id: AUTO_TAB_ID, label: 'Auto', icon: '⚡', onKey: autoModuleOnKey,
    show: showAutoPanel, onShow: renderAutoPanel,
  },
  {
    id: EMAIL_TAB_ID, label: 'Mail', icon: '✉️', badge: getEmailUnread, onKey: emailModuleOnKey,
    hidden: () => !builtinOn('gmail'),
    show: showEmailPanel, onShow: renderEmailPanel,
  },
  {
    id: NOTES_TAB_ID, label: 'Notes', icon: '📝',
    show: showNotesPanel, onShow: renderNotesPanel,
  },
  {
    id: DASH_TAB_ID, label: 'Dash', icon: '📊', onKey: dashModuleOnKey,
    show: showDashPanel, onShow: renderDashPanel,
  },
  {
    id: SETTINGS_TAB_ID, label: 'Settings', icon: '⚙️',
    show: showSettingsPanel, onShow: renderSettingsPanel,
  },
  {
    id: HELP_TAB_ID, label: 'Help', icon: '📖', onKey: helpModuleOnKey,
    show: showHelpPanel, onShow: renderHelpPanel,
  },
];

function hideAllPanels() {
  for (const m of getModules()) {
    try {
      m.show?.(false);
    } catch (err) {
      console.warn(`module ${m.id}: hide failed:`, err);
    }
  }
  showPromptsPanel(false);
}

function activateModule(mod) {
  state.shell.activeTabId = mod.id;
  stopViewing();
  hideAllPanels();
  try {
    mod.show?.(true);
    // Most onShow renderers are async — without awaiting the promise their
    // rejections escape this catch and the module silently shows blank
    Promise.resolve(mod.onShow?.()).catch(err =>
      console.error(`module ${mod.id}: render failed:`, err));
  } catch (err) {
    console.error(`module ${mod.id}: activation failed:`, err);
  }
  renderModuleBar();
  updateModuleStatusBar();
}

function register(desc) {
  registerModule({
    ...desc,
    switchTo: () => activateModule(desc),
    isActive: () => state.shell.activeTabId === desc.id,
  });
}

// Initialize modules — the tab at position 1 is the startup view
export function initModules() {
  for (const desc of CORE_MODULES) register(desc);
  if (!state.shell.activeTabId) {
    const first = getVisibleModules()[0];
    if (first) {
      first.switchTo();
      return;
    }
    state.shell.activeTabId = DASHBOARD_TAB_ID;
  }
  if (state.shell.activeTabId === DASHBOARD_TAB_ID) {
    showDashboardPanel(true);
  }
  renderModuleBar();
}

export function switchToModuleId(id) {
  const mod = getModules().find(m => m.id === id);
  if (mod) {
    mod.switchTo();
    return true;
  }
  return false;
}

// Restore the active module (project switch, startup); unknown or empty
// ids fall back to the user's first visible tab
export function loadActiveModule(activeTabId) {
  if (activeTabId && switchToModuleId(activeTabId)) return;
  const first = getVisibleModules()[0];
  if (first) first.switchTo();
  else switchToModuleId(DASHBOARD_TAB_ID);
}

// Named shortcuts used across modules
export const switchToDashboardTab = () => switchToModuleId(DASHBOARD_TAB_ID);
export const switchToProjectsTab = () => switchToModuleId(PROJECTS_TAB_ID);
export const switchToBoardTab = () => switchToModuleId(BOARD_TAB_ID);
export const switchToHealthTab = () => switchToModuleId(HEALTH_TAB_ID);
export const switchToNotesTab = () => switchToModuleId(NOTES_TAB_ID);
export const switchToSettingsTab = () => switchToModuleId(SETTINGS_TAB_ID);

function updateModuleStatusBar() {
  const iconEl = document.getElementById('browserStatusBarIcon');
  const labelEl = document.getElementById('browserStatusBarLabel');
  if (!iconEl || !labelEl) return;
  const mod = getModules().find(m => m.id === state.shell.activeTabId);
  iconEl.textContent = mod?.icon || '📊';
  labelEl.textContent = mod?.label || '';
}

// ============================================
// Addon modules (full pages contributed by addons)
// ============================================

const addonPanels = new Map(); // module id -> panel element

export function registerAddonModule(addonId, desc) {
  const container = document.querySelector('#browserPanel .browser-content');
  if (!container) return;
  addonPanels.get(desc.id)?.remove();
  const el = document.createElement('div');
  el.className = 'addon-panel';
  el.style.display = 'none';
  container.appendChild(el);
  addonPanels.set(desc.id, el);

  let rendered = false;
  register({
    id: desc.id,
    label: desc.label,
    icon: desc.icon || '🧩',
    addonId,
    onKey: desc.onKey,
    badge: desc.badge,
    show: (visible) => { el.style.display = visible ? 'flex' : 'none'; },
    onShow: () => {
      if (!rendered) {
        rendered = true;
        Promise.resolve(desc.render?.(el)).catch(err => {
          console.warn(`addon module ${desc.id}: render failed:`, err);
        });
      }
      desc.onShow?.(el);
    },
  });
  renderModuleBar();
}

export function unregisterAddonModules(addonId) {
  const owned = getModules().filter(m => m.addonId === addonId);
  if (!owned.length) return;
  for (const mod of owned) {
    addonPanels.get(mod.id)?.remove();
    addonPanels.delete(mod.id);
    unregisterModule(mod.id);
  }
  if (!getModules().some(m => m.id === state.shell.activeTabId)) {
    getVisibleModules()[0]?.switchTo();
  }
  renderModuleBar();
}

// ============================================
// Project switch integration
// ============================================

export function initModuleHostHandler(callbacks = {}) {
  registerStateHandler('modules', {
    priority: 50,
    onLoad: async () => {
      document.getElementById('browserPanel')?.classList.add('active');
      loadActiveModule(state.shell.activeTabId);
    },
    onAfterSwitch: async (ctx) => {
      callbacks.switchTab?.(ctx.projectState?.activeTab || 'browser');
    },
  });
}
