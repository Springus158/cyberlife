// Projects module: mission control for every project. A live sessions strip
// on top, a full-width grid of project cards (grouped, lazily hydrated with
// board/git data) and a detail pane for the focused project. The quick
// switcher (p) stays the fast path; this page is the deep view.

import { state } from './state.js';
import * as bus from './bus.js';
import { builtinOn } from './addon-state.js';
import { escapeAttr, escapeHtml, searchNormalize } from './utils.js';
import { EventsOn } from '../../wailsjs/runtime/runtime';
import { getAllTerminalTabs } from './terminal-dashboard.js';
import { openEditProjectModal } from './projects.js';
import { uiIcon } from './ui-icons.js';
import {
  GetKanban, IsGitRepo, GetGitCurrentBranch, GetGitChangedFiles, UpdateProject,
  GetSelectedHealthReport,
} from '../../wailsjs/go/main/App.js';

export const PROJECTS_TAB_ID = 'projects-tab';

const pm = {
  focusedId: null,
  filter: '',
  groupFilter: null,     // group id, null = all
  view: localStorage.getItem('projectsView') || 'grid', // grid | list
  hydration: new Map(),  // projectId -> {board, git, at}
  hydrating: new Set(),
  health: new Map(),     // projectId -> {categories, at} — focused project only
};

const HEALTH_TTL_MS = 120_000;

async function hydrateHealth(project) {
  const cached = pm.health.get(project.id);
  if (cached && Date.now() - cached.at < HEALTH_TTL_MS) return;
  try {
    const report = await GetSelectedHealthReport(project.id);
    pm.health.set(project.id, { categories: report?.categories || [], at: Date.now() });
  } catch (err) {
    console.warn('Health hydrate failed:', project.name, err);
    pm.health.set(project.id, { categories: [], at: Date.now() });
  }
  if (isPanelVisible() && focusedProject()?.id === project.id) renderDetail();
}

const HYDRATION_TTL_MS = 60_000;

export function showProjectsPanel(show) {
  const panel = document.getElementById('projectsPanel');
  if (panel) panel.style.display = show ? 'flex' : 'none';
}

function isPanelVisible() {
  const panel = document.getElementById('projectsPanel');
  return panel && panel.style.display !== 'none';
}

export function initProjectsModule() {
  bus.on('session-status-changed', () => {
    if (isPanelVisible()) {
      renderSessionsStrip();
      renderDetail();
    }
  });
  EventsOn('kanban-changed', (projectId) => {
    pm.hydration.delete(projectId);
    if (isPanelVisible()) hydrateVisible();
  });
  EventsOn('projects-changed', () => {
    if (isPanelVisible()) renderProjectsPanel();
  });
}

// ============================================
// Data helpers
// ============================================

function projectForPath(path) {
  if (!path) return null;
  return (state.projects || []).find(p => p.path && (path === p.path || path.startsWith(p.path + '/')));
}

function sessionsOf(project) {
  return getAllTerminalTabs()
    .filter(t => t.sessionId?.startsWith('tmux:'))
    .filter(t => projectForPath(t.path)?.id === project.id);
}

function claudeStatusOf(sessionId) {
  return state.claudeStatus?.get?.(sessionId) || null;
}

function groupOf(project) {
  return (state.projectGroups || []).find(g => g.id === project.groupId) || null;
}

// Flat, alphabetical by default; groups act as tags with a filter on top
function flatProjects() {
  const q = searchNormalize(pm.filter);
  return (state.projects || [])
    .filter(p => !q || searchNormalize(p.name).includes(q))
    .filter(p => !pm.groupFilter || p.groupId === pm.groupFilter)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

function focusedProject() {
  const flat = flatProjects();
  return flat.find(p => p.id === pm.focusedId) || flat[0] || null;
}

// ============================================
// Lazy hydration (board + git per card)
// ============================================

async function hydrate(project) {
  if (pm.hydrating.has(project.id)) return;
  const cached = pm.hydration.get(project.id);
  if (cached && Date.now() - cached.at < HYDRATION_TTL_MS) return;
  pm.hydrating.add(project.id);
  const entry = { board: null, git: null, at: Date.now() };
  try {
    const board = await GetKanban(project.id);
    const tasks = (board.tasks || []).filter(t => !t.archived);
    const cols = board.columns || [];
    const wip = cols.find(c => /progress|doing/i.test(c.name));
    entry.board = {
      total: tasks.length,
      inProgress: wip ? tasks.filter(t => t.columnId === wip.id).length : 0,
      blocked: tasks.filter(t => t.blocked).length,
    };
  } catch (err) {
    console.warn('Project card board load failed:', project.name, err);
  }
  try {
    if (project.path && await IsGitRepo(project.path)) {
      const [branch, files] = await Promise.all([
        GetGitCurrentBranch(project.path),
        GetGitChangedFiles(project.path),
      ]);
      entry.git = { branch: branch || '', dirty: (files || []).length };
    }
  } catch (err) {
    console.warn('Project card git load failed:', project.name, err);
  }
  pm.hydration.set(project.id, entry);
  pm.hydrating.delete(project.id);
  if (isPanelVisible()) {
    updateCard(project.id);
    if (focusedProject()?.id === project.id) renderDetail();
  }
}

// Hydrate a handful at a time, cards first, focused project first
function hydrateVisible() {
  const flat = flatProjects();
  const focused = focusedProject();
  const queue = focused ? [focused, ...flat.filter(p => p.id !== focused.id)] : flat;
  let inFlight = 0;
  const next = () => {
    while (inFlight < 4 && queue.length) {
      const p = queue.shift();
      const cached = pm.hydration.get(p.id);
      if (cached && Date.now() - cached.at < HYDRATION_TTL_MS) continue;
      inFlight++;
      hydrate(p).finally(() => { inFlight--; next(); });
    }
  };
  next();
}

// ============================================
// Render
// ============================================

export function renderProjectsPanel() {
  const panel = document.getElementById('projectsPanel');
  if (!panel) return;
  if (!pm.focusedId) pm.focusedId = state.activeProject?.id || null;

  panel.innerHTML = `
    <div class="pm-header">
      <h3>Projects</h3>
      <input type="text" id="pmFilter" class="board-filter" placeholder="/ filter projects"
             value="${escapeAttr(pm.filter)}" autocomplete="off" spellcheck="false" />
      <div class="board-header-actions">
        ${builtinOn('health') ? '<button class="fc-btn fc-btn-secondary fc-btn-sm" id="pmHealthBtn" title="Health of the focused project (⇧H)">🏥 Health</button>' : ''}
        <button class="fc-btn fc-btn-secondary fc-btn-sm" id="pmGroupsBtn" title="Manage groups (⇧G)">🗂️ Groups</button>
        <button class="fc-btn fc-btn-secondary fc-btn-sm" id="pmViewBtn" title="Toggle grid/list (v)">${pm.view === 'grid' ? '☰' : '▦'}</button>
        <button class="fc-btn fc-btn-primary fc-btn-sm" id="pmAddBtn">+ Add (n)</button>
      </div>
    </div>
    <div class="pm-sessions" id="pmSessions"></div>
    <div class="pm-groups" id="pmGroups"></div>
    <div class="pm-body">
      <div class="pm-grid ${pm.view === 'list' ? 'pm-as-list' : ''}" id="pmGrid"></div>
      <div class="pm-detail" id="pmDetail"></div>
    </div>
  `;

  panel.querySelector('#pmAddBtn')?.addEventListener('click', () => window.openAddChoiceModal?.());
  panel.querySelector('#pmHealthBtn')?.addEventListener('click', () => runVerb('health'));
  panel.querySelector('#pmGroupsBtn')?.addEventListener('click', () => {
    import('./project-groups.js').then(({ openGroupsManager }) => openGroupsManager())
      .catch((err) => { console.error('groups manager failed:', err); });
  });
  panel.querySelector('#pmViewBtn')?.addEventListener('click', toggleView);
  const filter = panel.querySelector('#pmFilter');
  filter?.addEventListener('input', () => {
    pm.filter = filter.value;
    renderGrid();
    renderDetail();
  });
  filter?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || e.key === 'Enter') {
      e.preventDefault();
      filter.blur();
    }
    e.stopPropagation();
  });

  renderSessionsStrip();
  renderGroupFilter();
  renderGrid();
  renderDetail();
  hydrateVisible();
}

function renderGroupFilter() {
  const el = document.getElementById('pmGroups');
  if (!el) return;
  const groups = state.projectGroups || [];
  if (!groups.length) {
    el.style.display = 'none';
    return;
  }
  el.style.display = '';
  const chip = (id, label, icon) => `
    <button class="pm-group-chip ${pm.groupFilter === id ? 'active' : ''}" data-group="${id || ''}">
      ${icon ? `${icon} ` : ''}${escapeHtml(label)}
    </button>`;
  el.innerHTML = `
    <span class="pm-groups-label" title="Cycle with f">Group</span>
    ${chip(null, 'All')}
    ${groups.map(g => chip(g.id, g.name, g.icon)).join('')}
  `;
  el.querySelectorAll('.pm-group-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      pm.groupFilter = btn.dataset.group || null;
      renderGroupFilter();
      renderGrid();
      renderDetail();
      hydrateVisible();
    });
  });
}

// f cycles: All → group 1 → group 2 → … → All
function cycleGroupFilter(direction) {
  const ids = [null, ...(state.projectGroups || []).map(g => g.id)];
  const idx = ids.indexOf(pm.groupFilter);
  pm.groupFilter = ids[(idx + direction + ids.length) % ids.length];
  renderGroupFilter();
  renderGrid();
  renderDetail();
  hydrateVisible();
}

// The strip follows the focused project: its sessions swap in as the
// cursor moves across the grid
function renderSessionsStrip() {
  const el = document.getElementById('pmSessions');
  if (!el) return;
  const project = focusedProject();
  const sessions = project ? sessionsOf(project) : [];
  if (!sessions.length) {
    el.innerHTML = `<span class="pm-sessions-empty">${project ? `No sessions in ${escapeHtml(project.name)} — press s` : 'No running sessions'}</span>`;
    return;
  }
  el.innerHTML = `
    <span class="pm-sessions-label">${project.icon || '📁'} ${escapeHtml(project.name)}</span>
    ${sessions.map(t => {
      const status = claudeStatusOf(t.sessionId);
      return `
      <button class="pm-session-chip" data-session-id="${escapeAttr(t.sessionId)}" data-project-name="${escapeAttr(project.name)}"
              title="${escapeAttr(t.path || '')}">
        <span class="pm-session-dot ${status === 'working' ? 'working' : status === 'waiting' ? 'waiting' : t.isActive ? 'active' : ''}"></span>
        <span class="pm-session-name">${escapeHtml(t.name)}</span>
      </button>
    `;}).join('')}`;
  el.querySelectorAll('.pm-session-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      import('./module-host.js').then(({ switchToDashboardTab }) => {
        const projectName = chip.dataset.projectName;
        if (projectName && projectName !== state.activeProject?.name) {
          window.itermSelectProject?.(projectName);
        }
        switchToDashboardTab();
        window.itermViewSession?.(chip.dataset.sessionId);
      }).catch((err) => { console.error('Failed to open session:', err); });
    });
  });
}

function cardBadges(project) {
  const h = pm.hydration.get(project.id);
  const sessions = sessionsOf(project);
  const working = sessions.filter(s => claudeStatusOf(s.sessionId) === 'working').length;
  const parts = [];
  if (sessions.length) {
    parts.push(`<span class="pm-badge pm-badge-sessions ${working ? 'working' : ''}" title="Sessions${working ? ` (${working} working)` : ''}">▶ ${sessions.length}</span>`);
  }
  if (h?.board?.total) {
    parts.push(`<span class="pm-badge" title="Board tasks (in progress / total)">📋 ${h.board.inProgress}/${h.board.total}</span>`);
    if (h.board.blocked) parts.push(`<span class="pm-badge pm-badge-blocked" title="Blocked tasks">🚫 ${h.board.blocked}</span>`);
  }
  if (h?.git) {
    parts.push(`<span class="pm-badge ${h.git.dirty ? 'pm-badge-dirty' : ''}" title="Git: ${escapeAttr(h.git.branch)}">⎇ ${escapeHtml(shortBranch(h.git.branch))}${h.git.dirty ? ` ±${h.git.dirty}` : ''}</span>`);
  }
  return parts.join('');
}

function badgesRow(project) {
  const group = groupOf(project);
  const tag = group ? `<span class="pm-card-tag">${group.icon || ''} ${escapeHtml(group.name)}</span>` : '';
  return tag + cardBadges(project);
}

function accentOf(project) {
  return groupOf(project)?.color || 'var(--border)';
}

// Every card button is a keyboard verb too — the tooltip teaches the key.
function cardActions(project) {
  const verbs = [
    ['open', 'openNew', 'Open project', '↵'],
    ['session', 'terminal', 'New session', 's'],
    ['board', 'board', 'Board', 'b'],
    ...(builtinOn('health') ? [['health', 'heart', 'Health', '⇧H']] : []),
    ['edit', 'pencil', 'Edit', 'e'],
    ['pin', 'pin', project.pinned ? 'Unpin' : 'Pin', '⇧P'],
  ];
  return verbs.map(([verb, glyph, label, key]) => `
    <button class="pm-card-act ${verb === 'pin' && project.pinned ? 'on' : ''}"
      data-verb="${verb}" title="${escapeAttr(`${label} (${key})`)}">${uiIcon(glyph, 16)}</button>
  `).join('');
}

function renderCard(project) {
  const active = project.id === state.activeProject?.id;
  const focused = project.id === pm.focusedId;
  return `
    <div class="pm-card ${focused ? 'pm-focused' : ''} ${active ? 'pm-active' : ''}" data-project-id="${project.id}"
         style="--pm-accent: ${accentOf(project)}">
      <div class="pm-card-top" title="${escapeAttr(project.name)}">
        <span class="pm-card-icon">${project.icon || '📁'}</span>
        <span class="pm-card-name">${escapeHtml(project.name)}</span>
        ${project.pinned ? '<span class="pm-card-pin">📌</span>' : ''}
      </div>
      <div class="pm-card-badges" data-badges="${project.id}">${badgesRow(project)}</div>
      <div class="pm-card-actions">${cardActions(project)}</div>
    </div>
  `;
}

function renderGrid() {
  const grid = document.getElementById('pmGrid');
  if (!grid) return;
  const projects = flatProjects();
  if (!projects.length) {
    grid.innerHTML = '<div class="auto-empty"><div class="auto-empty-icon">📁</div><p>No projects match.</p></div>';
    return;
  }
  grid.innerHTML = `<div class="pm-group-cards">${projects.map(renderCard).join('')}</div>`;

  grid.querySelectorAll('.pm-card').forEach(card => {
    card.addEventListener('click', (e) => {
      pm.focusedId = card.dataset.projectId;
      const verb = e.target.closest('[data-verb]')?.dataset.verb;
      if (verb) {
        e.stopPropagation();
        refreshFocusClasses();
        runVerb(verb);
        return;
      }
      refreshFocusClasses();
      renderSessionsStrip();
      renderDetail();
      hydrateVisible();
    });
    card.addEventListener('dblclick', () => switchToFocused(true));
  });
}

function refreshFocusClasses() {
  document.querySelectorAll('#pmGrid .pm-card').forEach(c => {
    c.classList.toggle('pm-focused', c.dataset.projectId === pm.focusedId);
  });
  document.querySelector('#pmGrid .pm-focused')?.scrollIntoView({ block: 'nearest' });
}

function updateCard(projectId) {
  const el = document.querySelector(`#pmGrid [data-badges="${projectId}"]`);
  const project = (state.projects || []).find(p => p.id === projectId);
  if (el && project) el.innerHTML = badgesRow(project);
}

function renderDetail() {
  const el = document.getElementById('pmDetail');
  if (!el) return;
  const project = focusedProject();
  if (!project) {
    el.innerHTML = '';
    return;
  }
  const h = pm.hydration.get(project.id);
  const sessions = sessionsOf(project);
  const tasks = (project.tasks || []).filter(t => t.status !== 'done').slice(0, 5);
  const notes = (project.notes || '').trim();

  el.innerHTML = `
    <div class="pm-detail-head" style="--pm-accent: ${accentOf(project)}">
      <span class="pm-detail-icon">${project.icon || '📁'}</span>
      <div class="pm-detail-titles">
        <div class="pm-detail-name">${escapeHtml(project.name)}</div>
        <div class="pm-detail-path">${escapeHtml(shortPath(project.path))}</div>
      </div>
    </div>

    <div class="pm-detail-actions">
      <button class="fc-btn fc-btn-primary fc-btn-sm" data-act="open">Open (↵)</button>
      <button class="fc-btn fc-btn-secondary fc-btn-sm" data-act="session">Session (s)</button>
      <button class="fc-btn fc-btn-secondary fc-btn-sm" data-act="board">Board (b)</button>
      <button class="fc-btn fc-btn-secondary fc-btn-sm" data-act="edit">Edit (e)</button>
    </div>

    <div class="pm-detail-section">
      <div class="pm-detail-label">Health</div>
      ${builtinOn('health') ? renderHealthTags(project) : ''}
    </div>

    <div class="pm-detail-section">
      <div class="pm-detail-label">Sessions</div>
      ${sessions.length ? sessions.map(s => {
        const st = claudeStatusOf(s.sessionId);
        return `<div class="pm-detail-row" data-session="${escapeAttr(s.sessionId)}">
          <span class="pm-session-dot ${st === 'working' ? 'working' : st === 'waiting' ? 'waiting' : ''}"></span>
          <span class="pm-detail-row-main">${escapeHtml(s.name)}</span>
          ${st ? `<span class="pm-detail-muted">${st}</span>` : ''}
        </div>`;
      }).join('') : '<div class="pm-detail-muted">None running — press s</div>'}
    </div>

    ${h?.board ? `
    <div class="pm-detail-section">
      <div class="pm-detail-label">Board</div>
      <div class="pm-detail-row"><span class="pm-detail-row-main">${h.board.inProgress} in progress · ${h.board.total} open${h.board.blocked ? ` · ${h.board.blocked} blocked` : ''}</span></div>
    </div>` : ''}

    ${tasks.length ? `
    <div class="pm-detail-section">
      <div class="pm-detail-label">Worktree tasks</div>
      ${tasks.map(t => `<div class="pm-detail-row"><span class="pm-detail-row-main">${escapeHtml(t.name)}</span><span class="pm-detail-muted">${escapeHtml(t.branch || '')}</span></div>`).join('')}
    </div>` : ''}

    ${notes ? `
    <div class="pm-detail-section">
      <div class="pm-detail-label">Notes</div>
      <div class="pm-detail-notes">${escapeHtml(notes.slice(0, 400))}${notes.length > 400 ? '…' : ''}</div>
    </div>` : ''}
  `;

  el.querySelectorAll('[data-act]').forEach(btn => {
    btn.addEventListener('click', () => runVerb(btn.dataset.act));
  });
  if (builtinOn('health')) hydrateHealth(project);
  el.querySelectorAll('[data-session]').forEach(row => {
    row.addEventListener('click', () => {
      import('./module-host.js').then(({ switchToDashboardTab }) => {
        if (project.name !== state.activeProject?.name) window.itermSelectProject?.(project.name);
        switchToDashboardTab();
        window.itermViewSession?.(row.dataset.session);
      }).catch((err) => { console.error('Failed to open session:', err); });
    });
  });
}

function renderHealthTags(project) {
  const cached = pm.health.get(project.id);
  if (!cached) return '<div class="pm-detail-muted">Checking…</div>';
  const cats = cached.categories;
  if (!cats.length) {
    return '<div class="pm-detail-row" data-act="health"><span class="pm-detail-row-main">No checks tracked — configure (H)</span></div>';
  }
  const tags = cats.map(c => `
    <span class="pm-health-tag ${c.passed === c.total ? 'ok' : 'bad'}" title="${escapeAttr(c.name)}">
      ${c.icon} ${c.passed}/${c.total}
    </span>`).join('');
  return `
    <div class="pm-health-tags">${tags}</div>
    <button class="fc-btn fc-btn-secondary fc-btn-sm pm-health-configure" data-act="health">Configure (H)</button>
  `;
}

// ============================================
// Verbs
// ============================================

function switchToFocused(goTerm) {
  const project = focusedProject();
  if (!project) return;
  if (project.name !== state.activeProject?.name) {
    window.itermSelectProject?.(project.name);
  }
  if (goTerm) {
    import('./module-host.js').then(({ switchToDashboardTab }) => switchToDashboardTab())
      .catch((err) => { console.error('module switch failed:', err); });
  } else {
    renderGrid();
    renderDetail();
  }
}

function runVerb(act) {
  const project = focusedProject();
  if (!project) return;
  const withActive = (fn) => {
    if (project.name !== state.activeProject?.name) window.itermSelectProject?.(project.name);
    // itermSelectProject is async under the hood — give state a beat
    setTimeout(fn, 120);
  };
  switch (act) {
    case 'open':
      switchToFocused(true);
      break;
    case 'session':
      withActive(() => window.itermCreateTab?.());
      break;
    case 'board':
      withActive(() => import('./module-host.js').then(({ switchToBoardTab }) => switchToBoardTab()));
      break;
    case 'edit':
      withActive(() => openEditProjectModal());
      break;
    case 'health':
      if (!builtinOn('health')) break;
      withActive(() => import('./module-host.js').then(({ switchToHealthTab }) => switchToHealthTab()));
      break;
    case 'pin':
      UpdateProject({ ...project, pinned: !project.pinned })
        .then(() => {
          project.pinned = !project.pinned;
          renderGrid();
        })
        .catch((err) => console.error('Pin toggle failed:', err));
      break;
  }
}

function toggleView() {
  pm.view = pm.view === 'grid' ? 'list' : 'grid';
  localStorage.setItem('projectsView', pm.view);
  renderProjectsPanel();
}

// ============================================
// Keyboard (shell NORMAL-mode module hook)
// ============================================

function moveFocus(delta) {
  const flat = flatProjects();
  if (!flat.length) return;
  let idx = flat.findIndex(p => p.id === pm.focusedId);
  if (idx === -1) idx = 0;
  else idx = Math.max(0, Math.min(flat.length - 1, idx + delta));
  pm.focusedId = flat[idx].id;
  refreshFocusClasses();
  renderSessionsStrip();
  renderDetail();
  hydrateVisible();
}

function columnsInFocusedGroup() {
  const card = document.querySelector('#pmGrid .pm-focused');
  const cards = card?.closest('.pm-group-cards');
  if (!card || !cards) return 1;
  const cardW = card.getBoundingClientRect().width;
  const gridW = cards.getBoundingClientRect().width;
  return Math.max(1, Math.round(gridW / Math.max(cardW, 1)));
}

export function projectsModuleOnKey(e) {
  switch (e.key) {
    case 'j':
    case 'ArrowDown':
      e.preventDefault();
      moveFocus(pm.view === 'grid' ? columnsInFocusedGroup() : 1);
      return true;
    case 'k':
    case 'ArrowUp':
      e.preventDefault();
      moveFocus(pm.view === 'grid' ? -columnsInFocusedGroup() : -1);
      return true;
    case 'h':
    case 'ArrowLeft':
      e.preventDefault();
      moveFocus(-1);
      return true;
    case 'l':
    case 'ArrowRight':
      e.preventDefault();
      moveFocus(1);
      return true;
    case 'Enter':
      e.preventDefault();
      switchToFocused(true);
      return true;
    case 'o':
      e.preventDefault();
      switchToFocused(false);
      return true;
    case 's':
      e.preventDefault();
      runVerb('session');
      return true;
    case 'b':
      e.preventDefault();
      runVerb('board');
      return true;
    case 'e':
      e.preventDefault();
      runVerb('edit');
      return true;
    case 'P':
      e.preventDefault();
      runVerb('pin');
      return true;
    case 'H':
      e.preventDefault();
      runVerb('health');
      return true;
    case 'G':
      e.preventDefault();
      import('./project-groups.js').then(({ openGroupsManager }) => openGroupsManager())
        .catch((err) => { console.error('groups manager failed:', err); });
      return true;
    case 'n':
      e.preventDefault();
      window.openAddChoiceModal?.();
      return true;
    case 'r':
      e.preventDefault();
      pm.hydration.clear();
      renderProjectsPanel();
      return true;
    case 'v':
      e.preventDefault();
      toggleView();
      return true;
    case 'f':
      e.preventDefault();
      cycleGroupFilter(1);
      return true;
    case '/': {
      const input = document.getElementById('pmFilter');
      if (input) {
        e.preventDefault();
        input.focus();
        return true;
      }
      return false;
    }
  }
  return false;
}

// ============================================
// Helpers
// ============================================

function shortBranch(b) {
  return b && b.length > 16 ? b.slice(0, 15) + '…' : (b || '');
}

function shortPath(p) {
  if (!p) return '';
  const home = p.replace(/^\/Users\/[^/]+/, '~');
  const parts = home.split('/');
  return parts.length > 4 ? '…/' + parts.slice(-3).join('/') : home;
}

