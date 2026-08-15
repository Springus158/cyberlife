// Widget registry + right-sidebar widget area. Legacy sidebar sections
// (prompt history, git, pomodoro, notes) are adopted as widgets by moving
// their DOM nodes — their one-time event bindings survive the move. New
// widgets are instance-safe render(el) functions, so dashboards (Dash
// module) can host independent copies.

import { state } from './state.js';
import { escapeHtml } from './utils.js';
import { EventsOn } from '../../wailsjs/runtime/runtime';
import { registerStateHandler } from './project-switcher.js';
import { getModules, activeModuleIndex } from './shell.js';
import { builtinOn } from './addon-state.js';
import {
  GetWidgetSettings, SetWidgetSettings, GetKanban, GetAutomationRuns,
  GetGmailConfig, GmailInboxUnread, GetProjectWidgets, SetProjectWidgets,
  GetClaudeSessions, KillClaudeSession,
} from '../../wailsjs/go/main/App.js';

// ============================================
// Registry
// ============================================

// legacy: id of an existing DOM section adopted as-is (sidebar only).
// render: instance-safe renderer usable in both sidebar and dashboards.
export const WIDGETS = [
  { id: 'git', title: 'Git', icon: '🌿', legacy: 'gitSection' },
  { id: 'pomodoro', title: 'Pomodoro', icon: '🍅', legacy: 'pomodoroSection', builtin: 'pomodoro' },
  { id: 'notes', title: 'Notes', icon: '📝', legacy: 'notesSection' },
  { id: 'board-summary', title: 'Board', icon: '📋', render: renderBoardSummary },
  { id: 'recent-automations', title: 'Automations', icon: '⚡', render: renderRecentAutomations },
  { id: 'unread-mail', title: 'Unread Mail', icon: '✉️', render: renderUnreadMail, builtin: 'gmail' },
  { id: 'claude-sessions', title: 'Claude Code', icon: '✳️', render: renderClaudeSessions },
];

export function widgetById(id) {
  return WIDGETS.find(w => w.id === id);
}

// Addon-contributed widgets join the same registry; ids are namespaced
// "<addon-id>.<name>" so removeAddonWidgets can strip them on deactivate
export function registerAddonWidget(desc) {
  const existing = WIDGETS.findIndex(w => w.id === desc.id);
  if (existing >= 0) {
    WIDGETS[existing] = desc;
  } else {
    WIDGETS.push(desc);
  }
  if (ws.loaded) renderSidebarWidgets();
}

export function removeAddonWidgets(addonId) {
  const prefix = `${addonId}.`;
  let removed = false;
  for (let i = WIDGETS.length - 1; i >= 0; i--) {
    if (WIDGETS[i].id.startsWith(prefix)) {
      WIDGETS.splice(i, 1);
      removed = true;
    }
  }
  if (removed && ws.loaded) renderSidebarWidgets();
}

export function widgetAvailable(w) {
  return !w.builtin || builtinOn(w.builtin);
}

export function dashboardCapableWidgets() {
  return WIDGETS.filter(w => w.render && widgetAvailable(w));
}

export function rerenderSidebarWidgets() {
  if (ws.loaded) renderSidebarWidgets();
}

// The sidebar has two layers: global widgets show in every project,
// each project adds its own after them
const DEFAULT_SIDEBAR_WIDTH = 280;

const ws = {
  global: [],
  project: [],
  projectId: null,
  collapsed: false,
  width: 0,          // 0 = built-in default
  moduleWidths: {},  // moduleId -> px override
  loaded: false,
};

function effectiveSidebar() {
  const seen = new Set(ws.global);
  return [...ws.global, ...ws.project.filter(id => !seen.has(id))];
}

// ============================================
// Sidebar widget area
// ============================================

export async function initWidgets() {
  try {
    const s = await GetWidgetSettings();
    ws.global = s.sidebar || [];
    ws.collapsed = !!s.collapsed;
    ws.width = s.width || 0;
    ws.moduleWidths = s.moduleWidths || {};
  } catch (err) {
    console.warn('Widget settings unavailable, using defaults:', err);
    ws.global = ['git', 'pomodoro'];
  }
  await loadProjectWidgets();
  ws.loaded = true;
  renderSidebarWidgets();
  applyCollapsed();
  applySidebarWidth();

  document.getElementById('widgetCollapseBtn')?.addEventListener('click', toggleWidgetSidebar);
  document.addEventListener('shell-module-change', () => applySidebarWidth());

  registerStateHandler('widgets', {
    priority: 300,
    onLoad: async () => {
      await loadProjectWidgets();
      renderSidebarWidgets();
      refreshLiveWidgets('project');
    },
  });
  EventsOn('automation-run', () => refreshLiveWidgets('automation'));
  EventsOn('automations-changed', () => refreshLiveWidgets('automation'));
  EventsOn('kanban-changed', () => refreshLiveWidgets('board'));
  // Agents change the config through the widgets_* API — reload live
  EventsOn('widgets-changed', async () => {
    try {
      const s = await GetWidgetSettings();
      ws.global = s.sidebar || [];
      ws.width = s.width || 0;
      ws.moduleWidths = s.moduleWidths || {};
      await loadProjectWidgets();
      renderSidebarWidgets();
      if (ws.collapsed !== !!s.collapsed) {
        ws.collapsed = !!s.collapsed;
        applyCollapsed();
      }
      applySidebarWidth();
    } catch (err) {
      console.warn('Widget config reload failed:', err);
    }
  });
  setInterval(() => refreshLiveWidgets('interval'), 120_000);
}

async function loadProjectWidgets() {
  const projectId = state.activeProject?.id || null;
  ws.projectId = projectId;
  if (!projectId) {
    ws.project = [];
    return;
  }
  try {
    ws.project = await GetProjectWidgets(projectId) || [];
  } catch (err) {
    console.warn('Project widgets unavailable:', err);
    ws.project = [];
  }
}

// Scope view for the Settings page: where each widget currently lives
export function getWidgetScopes() {
  return { global: [...ws.global], project: [...ws.project], projectId: ws.projectId };
}

// setWidgetScope moves a widget between global / this-project / off
export async function setWidgetScope(id, scope) {
  ws.global = ws.global.filter(x => x !== id);
  ws.project = ws.project.filter(x => x !== id);
  if (scope === 'global') ws.global.push(id);
  if (scope === 'project') ws.project.push(id);
  renderSidebarWidgets();
  await persist();
}

// moveWidget reorders within whichever scope list holds the widget
export async function moveWidget(id, dir) {
  const list = ws.global.includes(id) ? ws.global : ws.project.includes(id) ? ws.project : null;
  if (!list) return;
  const i = list.indexOf(id);
  const j = i + dir;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  renderSidebarWidgets();
  await persist();
}

async function persist() {
  try {
    await SetWidgetSettings({
      sidebar: ws.global,
      collapsed: ws.collapsed,
      width: ws.width,
      moduleWidths: ws.moduleWidths,
    });
    if (ws.projectId) {
      await SetProjectWidgets(ws.projectId, ws.project);
    }
  } catch (err) {
    console.error('Failed to save widget settings:', err);
  }
}

// ============================================
// Width: default + per-module overrides
// ============================================

function activeModuleId() {
  return getModules()[activeModuleIndex()]?.id || null;
}

export function applySidebarWidth() {
  const sidebar = document.getElementById('rightSidebar');
  if (!sidebar || ws.collapsed) return;
  const moduleId = activeModuleId();
  const width = (moduleId && ws.moduleWidths[moduleId]) || ws.width || DEFAULT_SIDEBAR_WIDTH;
  sidebar.style.width = `${width}px`;
}

// Drag persists into the current module's override when one exists,
// otherwise into the default width
export function saveSidebarWidthFromDrag(px) {
  const moduleId = activeModuleId();
  if (moduleId && ws.moduleWidths[moduleId]) {
    ws.moduleWidths[moduleId] = px;
  } else {
    ws.width = px;
  }
  persist();
}

export function getWidthConfig() {
  return { width: ws.width || DEFAULT_SIDEBAR_WIDTH, moduleWidths: { ...ws.moduleWidths }, isDefault: !ws.width };
}

export async function setWidthConfig(width, moduleWidths) {
  ws.width = width || 0;
  ws.moduleWidths = moduleWidths || {};
  applySidebarWidth();
  await persist();
}

function stash() {
  return document.getElementById('widgetStash');
}

// Move every legacy node home first, then lay out the enabled ones in order
function renderSidebarWidgets() {
  const area = document.getElementById('widgetArea');
  if (!area) return;

  for (const w of WIDGETS) {
    if (!w.legacy) continue;
    const node = document.getElementById(w.legacy);
    if (node && node.parentElement !== stash()) stash()?.appendChild(node);
  }
  area.querySelectorAll('.widget-frame').forEach(f => f.remove());

  for (const id of effectiveSidebar()) {
    const w = widgetById(id);
    if (!w || !widgetAvailable(w)) continue;
    if (w.legacy) {
      const node = document.getElementById(w.legacy);
      if (node) area.appendChild(node);
    } else {
      const frame = document.createElement('div');
      frame.className = 'widget-frame sidebar-section';
      frame.dataset.widgetId = w.id;
      frame.innerHTML = `
        <div class="widget-frame-header">
          <span>${w.icon} ${escapeHtml(w.title)}</span>
        </div>
        <div class="widget-frame-body"></div>
      `;
      area.appendChild(frame);
      w.render(frame.querySelector('.widget-frame-body'));
    }
  }
  renderStrip();
}

function renderStrip() {
  const strip = document.getElementById('widgetStrip');
  if (!strip) return;
  strip.innerHTML = effectiveSidebar().map(id => {
    const w = widgetById(id);
    return w ? `<button class="widget-strip-icon" data-widget="${w.id}" title="${escapeHtml(w.title)}">${w.icon}</button>` : '';
  }).join('');
  strip.querySelectorAll('.widget-strip-icon').forEach(btn => {
    btn.addEventListener('click', () => {
      setCollapsed(false);
      const w = widgetById(btn.dataset.widget);
      const node = w?.legacy ? document.getElementById(w.legacy)
        : document.querySelector(`.widget-frame[data-widget-id="${btn.dataset.widget}"]`);
      node?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  });
}

// ============================================
// Collapse to icon strip
// ============================================

export function toggleWidgetSidebar() {
  setCollapsed(!ws.collapsed);
}

function setCollapsed(collapsed) {
  if (ws.collapsed === collapsed) return;
  ws.collapsed = collapsed;
  applyCollapsed();
  persist();
}

function applyCollapsed() {
  const sidebar = document.getElementById('rightSidebar');
  const resizer = document.getElementById('rightSidebarResizer');
  if (!sidebar) return;
  if (ws.collapsed) {
    if (sidebar.style.width) sidebar.dataset.expandedWidth = sidebar.style.width;
    sidebar.style.width = '';
    sidebar.classList.add('collapsed');
    if (resizer) resizer.style.display = 'none';
  } else {
    sidebar.classList.remove('collapsed');
    if (resizer) resizer.style.display = '';
    applySidebarWidth();
  }
  const btn = document.getElementById('widgetCollapseBtn');
  if (btn) btn.textContent = ws.collapsed ? '⟨' : '⟩';
}

// ============================================
// Live refresh of instance widgets
// ============================================

const REFRESH_SCOPES = {
  'board-summary': ['project', 'board', 'interval'],
  'recent-automations': ['automation', 'interval'],
  'unread-mail': ['interval', 'project'],
};

function refreshLiveWidgets(scope) {
  document.querySelectorAll('[data-widget-id]').forEach(frame => {
    const w = widgetById(frame.dataset.widgetId);
    if (!w?.render) return;
    if (!(REFRESH_SCOPES[w.id] || []).includes(scope)) return;
    const body = frame.querySelector('.widget-frame-body');
    if (body) w.render(body);
  });
}

// ============================================
// Instance-safe widget renderers
// ============================================

function switchToModule(id) {
  getModules().find(m => m.id === id)?.switchTo();
}

async function renderBoardSummary(el) {
  const project = state.activeProject;
  if (!project) {
    el.innerHTML = '<div class="widget-empty">No active project</div>';
    return;
  }
  try {
    const board = await GetKanban(project.id);
    const columns = board.columns || [];
    const tasks = (board.tasks || []).filter(t => !t.archived);
    el.innerHTML = `
      <div class="widget-board-cols">
        ${columns.map(c => {
          const n = tasks.filter(t => t.columnId === c.id).length;
          return `<div class="widget-board-col"><span class="widget-board-count ${c.wipLimit && n > c.wipLimit ? 'over-wip' : ''}">${n}</span><span class="widget-board-name">${escapeHtml(c.name)}</span></div>`;
        }).join('')}
      </div>
      ${renderTopTasks(columns, tasks)}
    `;
    el.onclick = () => switchToModule('board-tab');
  } catch (err) {
    console.warn('Board widget load failed:', err);
    el.innerHTML = '<div class="widget-empty">Board unavailable</div>';
  }
}

function renderTopTasks(columns, tasks) {
  const wip = columns.find(c => /progress|doing/i.test(c.name));
  if (!wip) return '';
  const top = tasks.filter(t => t.columnId === wip.id).sort((a, b) => a.order - b.order).slice(0, 4);
  if (!top.length) return '';
  return `
    <div class="widget-board-tasks">
      ${top.map(t => `<div class="widget-board-task">${t.blocked ? '🚫 ' : ''}${escapeHtml(t.title)}</div>`).join('')}
    </div>
  `;
}

async function renderRecentAutomations(el) {
  try {
    const runs = await GetAutomationRuns(6) || [];
    if (!runs.length) {
      el.innerHTML = '<div class="widget-empty">No automation runs yet</div>';
    } else {
      el.innerHTML = runs.map(r => `
        <div class="widget-auto-run" title="${escapeHtml(r.detail || '')}">
          <span class="health-dot ${r.status === 'ok' ? 'ok' : 'bad'}"></span>
          <span class="widget-auto-name">${escapeHtml(r.ruleName)}</span>
          <span class="widget-auto-time">${shortTime(r.startedAt)}</span>
        </div>
      `).join('');
    }
    el.onclick = () => switchToModule('auto-tab');
  } catch (err) {
    console.warn('Automations widget load failed:', err);
    el.innerHTML = '<div class="widget-empty">Automations unavailable</div>';
  }
}

async function renderUnreadMail(el) {
  try {
    const cfg = await GetGmailConfig();
    const accounts = (cfg?.accounts || []).map(a => a.email);
    if (!cfg?.enabled || !accounts.length) {
      el.innerHTML = '<div class="widget-empty">No Gmail account linked</div>';
      return;
    }
    const counts = await Promise.all(accounts.map(async (a) => {
      try {
        return { account: a, unread: await GmailInboxUnread(a) };
      } catch (err) {
        console.warn('Unread widget: account failed', a, err);
        return { account: a, unread: null };
      }
    }));
    el.innerHTML = counts.map(c => `
      <div class="widget-mail-row">
        <span class="widget-mail-account">${escapeHtml(c.account)}</span>
        <span class="widget-mail-count ${c.unread ? 'has-unread' : ''}">${c.unread === null ? '—' : c.unread}</span>
      </div>
    `).join('');
    el.onclick = () => switchToModule('email-tab');
  } catch (err) {
    console.warn('Mail widget load failed:', err);
    el.innerHTML = '<div class="widget-empty">Mail unavailable</div>';
  }
}

// Live Claude Code sessions from ~/.claude/sessions heartbeats (any
// terminal on the machine, not just Cyber Life's own). Statuses follow
// acorn: working gets the sweeping-dot pulse, waiting is amber, idle dim.
// The widget polls itself every 5s — the shared 120s interval scope is far
// too slow for "is it still working?" glances; the timer dies with the DOM
// node, so re-renders and removal need no explicit cleanup.
async function renderClaudeSessions(el) {
  clearInterval(el._claudeTimer);
  const draw = async () => {
    if (!el.isConnected && el._claudeTimer) {
      clearInterval(el._claudeTimer);
      return;
    }
    try {
      const sessions = (await GetClaudeSessions()) || [];
      if (!sessions.length) {
        el.innerHTML = '<div class="widget-empty">Brak aktywnych sesji Claude Code</div>';
        return;
      }
      const badge = {
        working: '<span class="widget-claude-badge working">● working</span>',
        waiting: '<span class="widget-claude-badge waiting">◐ waiting</span>',
        idle: '<span class="widget-claude-badge idle">○ idle</span>',
      };
      el.innerHTML = sessions.map(s => `
        <div class="widget-claude-row ${s.status}" title="${escapeHtml(s.cwd)} · pid ${s.pid}${s.waitingFor ? ` · czeka na: ${escapeHtml(s.waitingFor)}` : ''}">
          <span class="widget-claude-name">${escapeHtml(s.cwd.split('/').pop() || s.cwd)}</span>
          <span class="widget-claude-age">${s.updatedAt ? shortTime(s.updatedAt) : ''}</span>
          ${badge[s.status] || badge.idle}
          ${s.status === 'working' ? '<span class="widget-claude-pulse"><span class="widget-claude-pulse-dot"></span></span>' : ''}
        </div>
      `).join('');
    } catch (err) {
      console.warn('Claude sessions widget load failed:', err);
      el.innerHTML = '<div class="widget-empty">Sesje Claude niedostępne</div>';
    }
  };
  await draw();
  el._claudeTimer = setInterval(draw, 5000);
  el.onclick = () => openClaudeSessionsPopup();
}

// Session manager popup: the widget's row list plus close (SIGTERM) and
// kill (SIGKILL) per session. Refreshes while open so a terminated session
// disappears once its heartbeat dies.
function openClaudeSessionsPopup() {
  document.querySelector('.claude-sessions-modal')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'modal claude-sessions-modal';
  overlay.innerHTML = `
    <div class="modal-content" style="width:520px">
      <h2>✳️ Sesje Claude Code</h2>
      <div class="claude-sessions-list"><div class="widget-empty">Ładowanie…</div></div>
      <div class="claude-sessions-footer">
        <span class="widget-empty">Zamknij = SIGTERM (grzecznie) · Kill = SIGKILL</span>
        <button class="claude-sessions-close-btn">Zamknij okno (Esc)</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const list = overlay.querySelector('.claude-sessions-list');

  const close = () => {
    clearInterval(timer);
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  overlay.querySelector('.claude-sessions-close-btn').onclick = close;

  const badge = {
    working: '<span class="widget-claude-badge working">● working</span>',
    waiting: '<span class="widget-claude-badge waiting">◐ waiting</span>',
    idle: '<span class="widget-claude-badge idle">○ idle</span>',
  };
  const draw = async () => {
    if (!overlay.isConnected) {
      clearInterval(timer);
      return;
    }
    try {
      const sessions = (await GetClaudeSessions()) || [];
      if (!sessions.length) {
        list.innerHTML = '<div class="widget-empty">Brak aktywnych sesji Claude Code</div>';
        return;
      }
      list.innerHTML = sessions.map(s => `
        <div class="claude-sessions-row">
          <div class="claude-sessions-info">
            <span class="widget-claude-name">${escapeHtml(s.cwd.split('/').pop() || s.cwd)}</span>
            <span class="claude-sessions-cwd">${escapeHtml(s.cwd)} · pid ${s.pid}${s.waitingFor ? ` · czeka: ${escapeHtml(s.waitingFor)}` : ''}</span>
          </div>
          <span class="widget-claude-age">${s.updatedAt ? shortTime(s.updatedAt) : ''}</span>
          ${badge[s.status] || badge.idle}
          <button class="claude-sessions-kill" data-pid="${s.pid}" data-force="0" title="Zakończ proces (SIGTERM)">Zamknij</button>
          <button class="claude-sessions-kill force" data-pid="${s.pid}" data-force="1" title="Zabij proces (SIGKILL) — bez zapisu stanu">Kill</button>
        </div>
      `).join('');
      list.querySelectorAll('.claude-sessions-kill').forEach((btn) => {
        btn.onclick = async () => {
          const force = btn.dataset.force === '1';
          if (force && !window.confirm('SIGKILL — proces zginie natychmiast, bez sprzątania. Na pewno?')) return;
          btn.disabled = true;
          try {
            await KillClaudeSession(Number(btn.dataset.pid), force);
            btn.textContent = '✓';
          } catch (err) {
            console.warn('Claude session kill failed:', err);
            btn.textContent = 'błąd';
            btn.disabled = false;
          }
          setTimeout(draw, 700);
        };
      });
    } catch (err) {
      console.warn('Claude sessions popup load failed:', err);
      list.innerHTML = '<div class="widget-empty">Sesje niedostępne</div>';
    }
  };
  draw();
  const timer = setInterval(draw, 3000);
}

function shortTime(iso) {
  const t = new Date(iso).getTime();
  if (!t) return '';
  const diff = Date.now() - t;
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

// renderWidgetInto lets the Dash module reuse the same renderers
export function renderWidgetInto(widgetId, container) {
  const w = widgetById(widgetId);
  if (!w?.render) return false;
  w.render(container);
  return true;
}
