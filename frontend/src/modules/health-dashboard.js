// Health module: a universal, configurable check system. The library holds
// predefined checks grouped by stack (generic, node, nextjs, express, go,
// java) plus user-defined custom checks; each project tracks its own subset
// and the report evaluates only that subset.

import { state } from './state.js';
import { searchNormalize } from './utils.js';
import { registerStateHandler } from './project-switcher.js';
import {
  GetHealthLibrary, GetHealthSelection, SetHealthSelection,
  DeleteCustomHealthCheck,
  GetSelectedHealthReport, SetManualCheck,
} from '../../wailsjs/go/main/App.js';

export const HEALTH_TAB_ID = 'health-tab';

const hs = {
  view: 'report',        // report | configure
  library: null,         // {stacks, checks}
  selection: [],         // check IDs tracked for the active project
  report: null,
  loading: false,
  filter: '',
  projectId: null,
};

export function initHealthDashboard() {
  registerStateHandler('health-dashboard', {
    priority: 200,
    onLoad: () => {
      hs.report = null;
      hs.selection = [];
      hs.projectId = null;
      const panel = document.getElementById('healthPanel');
      if (panel && panel.style.display !== 'none') {
        loadHealthData();
      }
    },
  });
}

export function showHealthPanel(show) {
  const panel = document.getElementById('healthPanel');
  if (panel) panel.style.display = show ? 'flex' : 'none';
}

export async function loadHealthData(forceRefresh = false) {
  const projectId = state.activeProject?.id;
  if (!projectId) return;
  if (hs.projectId !== projectId) {
    hs.view = 'report';
    hs.filter = '';
  }
  hs.projectId = projectId;
  hs.loading = true;
  render();
  try {
    const [library, selection, report] = await Promise.all([
      GetHealthLibrary(),
      GetHealthSelection(projectId),
      GetSelectedHealthReport(projectId),
    ]);
    hs.library = library;
    hs.selection = selection || [];
    hs.report = report;
  } catch (err) {
    console.error('Failed to load health data:', err);
  }
  hs.loading = false;
  render();
}

async function saveSelection() {
  try {
    await SetHealthSelection(hs.projectId, hs.selection);
  } catch (err) {
    console.error('Failed to save health selection:', err);
  }
}

// ============================================
// Render
// ============================================

function render() {
  const panel = document.getElementById('healthPanel');
  if (!panel) return;

  const total = hs.report?.categories?.reduce((n, c) => n + c.total, 0) || 0;
  const passed = hs.report?.categories?.reduce((n, c) => n + c.passed, 0) || 0;

  panel.innerHTML = `
    <div class="health-header">
      <h3>Health</h3>
      ${hs.view === 'report' && total > 0 ? `
        <div class="health-score ${passed === total ? 'all-good' : ''}">${passed}/${total}</div>
        <div class="health-progress"><div class="health-progress-fill" style="width:${total ? (passed * 100 / total) : 0}%"></div></div>
      ` : ''}
      ${hs.view === 'configure' ? `
        <input type="text" id="healthFilterInput" class="board-filter" placeholder="/ filter checks"
               value="${hs.filter.replace(/"/g, '&quot;')}" autocomplete="off" spellcheck="false" />
        <span class="health-selected-count">${hs.selection.length} tracked</span>
      ` : ''}
      <div class="board-header-actions">
        ${hs.view === 'report'
          ? `<button class="fc-btn fc-btn-secondary fc-btn-sm" id="healthConfigureBtn">⚙ Configure (c)</button>
             <button class="fc-btn fc-btn-secondary fc-btn-sm" id="healthRefreshBtn" title="Re-scan (r)">↻</button>`
          : `<button class="fc-btn fc-btn-primary fc-btn-sm" id="healthDoneBtn">Done (c)</button>`}
      </div>
    </div>
    <div class="health-body">
      ${hs.loading ? '<div class="health-loading">Scanning…</div>'
        : hs.view === 'report' ? renderReport() : renderConfigure()}
    </div>
  `;

  panel.querySelector('#healthConfigureBtn')?.addEventListener('click', () => switchView('configure'));
  panel.querySelector('#healthDoneBtn')?.addEventListener('click', () => switchView('report'));
  panel.querySelector('#healthRefreshBtn')?.addEventListener('click', () => loadHealthData(true));
  const filter = panel.querySelector('#healthFilterInput');
  filter?.addEventListener('input', () => {
    hs.filter = filter.value;
    const body = panel.querySelector('.health-body');
    if (body) {
      body.innerHTML = renderConfigure();
      bindConfigure(panel);
    }
  });

  if (hs.view === 'report') bindReport(panel);
  else bindConfigure(panel);
}

function switchView(view) {
  hs.view = view;
  if (view === 'report') {
    loadHealthData(true);
  } else {
    render();
  }
}

// ---- report ----

function renderReport() {
  const categories = hs.report?.categories || [];
  if (categories.length === 0) {
    return `
      <div class="health-empty">
        <div class="health-empty-icon">🏥</div>
        <p>No checks tracked for this project yet.</p>
        <p class="health-empty-sub">Pick what matters from the library — a project tracks only
        the checks you choose (e.g. 5 out of 20 Next.js checks).</p>
        <button class="fc-btn fc-btn-primary" id="healthEmptyConfigure">⚙ Configure checks</button>
      </div>
    `;
  }
  return `
    <div class="health-grid">
      ${categories.map(cat => `
        <div class="health-card">
          <div class="health-card-header">
            <span>${cat.icon} ${cat.name}</span>
            <span class="health-card-score ${cat.passed === cat.total ? 'all-good' : ''}">${cat.passed}/${cat.total}</span>
          </div>
          ${cat.items.map(item => renderReportItem(item)).join('')}
        </div>
      `).join('')}
    </div>
  `;
}

function renderReportItem(item) {
  const status = item.status || (item.passed ? 'passed' : 'failed');
  const icon = item.manual
    ? `<input type="checkbox" class="health-manual-toggle" data-manual-id="${item.manualId}" ${item.passed ? 'checked' : ''}>`
    : status === 'passed' ? '<span class="health-dot ok"></span>'
    : status === 'warning' ? '<span class="health-dot warn"></span>'
    : '<span class="health-dot bad"></span>';
  return `
    <div class="health-item ${item.manual ? 'manual' : ''}" title="${(item.description || '').replace(/"/g, '&quot;')}">
      ${icon}
      <span class="health-item-name">${item.name}</span>
      ${item.detail ? `<span class="health-item-detail">${item.detail}</span>` : ''}
    </div>
  `;
}

function bindReport(panel) {
  panel.querySelector('#healthEmptyConfigure')?.addEventListener('click', () => switchView('configure'));
  panel.querySelectorAll('.health-manual-toggle').forEach(box => {
    box.addEventListener('change', async () => {
      try {
        await SetManualCheck(state.activeProject.path, box.dataset.manualId, box.checked, '');
        hs.report = await GetSelectedHealthReport(hs.projectId);
        render();
      } catch (err) {
        console.error('Failed to toggle manual check:', err);
        box.checked = !box.checked;
      }
    });
  });
}

// ---- configure ----

function checksByStack() {
  const q = searchNormalize(hs.filter);
  const checks = (hs.library?.checks || []).filter(c =>
    !q || searchNormalize(c.title).includes(q) || searchNormalize(c.category).includes(q) || searchNormalize(c.stack).includes(q));
  const stacks = hs.library?.stacks || [];
  const grouped = [];
  for (const stack of stacks) {
    const items = checks.filter(c => c.stack === stack);
    if (items.length) grouped.push({ stack, items });
  }
  const known = new Set(stacks);
  const rest = checks.filter(c => !known.has(c.stack));
  if (rest.length) grouped.push({ stack: 'other', items: rest });
  return grouped;
}

const STACK_LABELS = {
  generic: '🧰 Generic — any project',
  node: '🟢 Node.js / TypeScript',
  nextjs: '▲ Next.js / React',
  express: '🚂 Express',
  go: '🐹 Go',
  java: '☕ Java',
  custom: '⭐ Custom — your own checks',
  other: '📦 Other',
};

function renderConfigure() {
  const groups = checksByStack();
  const selected = new Set(hs.selection);
  return `
    <div class="health-configure">
      ${groups.map(g => {
        const chosen = g.items.filter(c => selected.has(c.id)).length;
        return `
        <div class="health-stack">
          <div class="health-stack-header">
            <span class="health-stack-name">${STACK_LABELS[g.stack] || g.stack}</span>
            <span class="health-stack-count">${chosen}/${g.items.length}</span>
            <button class="fc-btn fc-btn-secondary fc-btn-sm" data-stack-all="${g.stack}">all</button>
            <button class="fc-btn fc-btn-secondary fc-btn-sm" data-stack-none="${g.stack}">none</button>
          </div>
          <div class="health-stack-checks">
            ${g.items.map(c => `
              <label class="health-check-row ${selected.has(c.id) ? 'selected' : ''}" title="${(c.description || '').replace(/"/g, '&quot;')}">
                <input type="checkbox" class="health-check-toggle" data-check-id="${c.id}" ${selected.has(c.id) ? 'checked' : ''}>
                <span class="health-check-title">${c.title}</span>
                <span class="board-chip">${c.category}</span>
                <span class="board-chip ${c.kind === 'auto' ? 'health-chip-auto' : 'health-chip-manual'}">${c.kind}</span>
                ${c.custom ? `<button class="fc-btn fc-btn-danger fc-btn-sm health-custom-delete" data-check-id="${c.id}" title="Delete custom check">×</button>` : ''}
              </label>
            `).join('')}
          </div>
        </div>
      `;}).join('')}

    </div>
  `;
}

function bindConfigure(panel) {
  panel.querySelectorAll('.health-check-toggle').forEach(box => {
    box.addEventListener('change', () => {
      const id = box.dataset.checkId;
      if (box.checked) {
        if (!hs.selection.includes(id)) hs.selection.push(id);
      } else {
        hs.selection = hs.selection.filter(x => x !== id);
      }
      box.closest('.health-check-row')?.classList.toggle('selected', box.checked);
      saveSelection();
      const count = panel.querySelector('.health-selected-count');
      if (count) count.textContent = `${hs.selection.length} tracked`;
    });
  });

  panel.querySelectorAll('[data-stack-all]').forEach(btn => {
    btn.addEventListener('click', () => bulkStack(btn.dataset.stackAll, true));
  });
  panel.querySelectorAll('[data-stack-none]').forEach(btn => {
    btn.addEventListener('click', () => bulkStack(btn.dataset.stackNone, false));
  });

  panel.querySelectorAll('.health-custom-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        await DeleteCustomHealthCheck(btn.dataset.checkId);
        hs.selection = hs.selection.filter(x => x !== btn.dataset.checkId);
        hs.library = await GetHealthLibrary();
        render();
      } catch (err) {
        console.error('Failed to delete custom check:', err);
      }
    });
  });

}

function bulkStack(stack, on) {
  const ids = (hs.library?.checks || []).filter(c => c.stack === stack).map(c => c.id);
  const set = new Set(hs.selection);
  for (const id of ids) {
    if (on) set.add(id);
    else set.delete(id);
  }
  hs.selection = [...set];
  saveSelection();
  render();
}

// ============================================
// Keyboard (shell NORMAL-mode module hook)
// ============================================

export function healthModuleOnKey(e) {
  switch (e.key) {
    case 'Escape':
      // Health opens from Projects — Esc goes back there
      e.preventDefault();
      import('./module-host.js').then(({ switchToProjectsTab }) => switchToProjectsTab())
        .catch((err) => { console.warn('back to projects failed:', err); });
      return true;
    case 'c':
      e.preventDefault();
      switchView(hs.view === 'report' ? 'configure' : 'report');
      return true;
    case 'r':
      if (hs.view === 'report') {
        e.preventDefault();
        loadHealthData(true);
        return true;
      }
      return false;
    case '/': {
      const input = document.getElementById('healthFilterInput');
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
