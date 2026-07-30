// Dash module: user-named dashboards, each a grid of widget instances.
// HOME is the built-in default dashboard; others are created by the user.
// Only instance-safe widgets (registry entries with a render function) can
// live here — legacy sidebar sections are single-instance.

import { escapeHtml } from './utils.js';
import { EventsOn } from '../../wailsjs/runtime/runtime';
import { dashboardCapableWidgets, widgetById, renderWidgetInto } from './widgets.js';
import { GetDashboards, SaveDashboard, DeleteDashboard } from '../../wailsjs/go/main/App.js';

export const DASH_TAB_ID = 'dash-tab';

const ds = {
  dashboards: [],
  active: 0,
  loaded: false,
};

export function initDashModule() {
  const rerenderIfVisible = () => { if (isVisible()) renderGrid(); };
  EventsOn('automation-run', rerenderIfVisible);
  EventsOn('kanban-changed', rerenderIfVisible);
  EventsOn('widgets-changed', () => { if (isVisible()) renderDashPanel(); });
}

function isVisible() {
  const panel = document.getElementById('dashPanel');
  return panel && panel.style.display !== 'none';
}

export function showDashPanel(show) {
  const panel = document.getElementById('dashPanel');
  if (panel) panel.style.display = show ? 'flex' : 'none';
}

export async function renderDashPanel() {
  try {
    ds.dashboards = await GetDashboards() || [];
    if (ds.active >= ds.dashboards.length) ds.active = 0;
    ds.loaded = true;
  } catch (err) {
    console.error('Failed to load dashboards:', err);
  }
  render();
}

function activeDashboard() {
  return ds.dashboards[ds.active];
}

// ============================================
// Render
// ============================================

function render() {
  const panel = document.getElementById('dashPanel');
  if (!panel) return;

  panel.innerHTML = `
    <div class="dash-header">
      <div class="dash-tabs">
        ${ds.dashboards.map((d, i) => `
          <button class="dash-tab ${i === ds.active ? 'active' : ''}" data-dash="${i}">
            ${d.icon ? `${d.icon} ` : ''}${escapeHtml(d.name)}
          </button>
        `).join('')}
        <button class="dash-tab dash-tab-new" id="dashNewBtn" title="New dashboard (n)">+</button>
      </div>
      <div class="board-header-actions">
        <button class="fc-btn fc-btn-secondary fc-btn-sm" id="dashEditBtn">✎ Edit (e)</button>
      </div>
    </div>
    <div class="dash-grid" id="dashGrid"></div>
  `;

  panel.querySelectorAll('[data-dash]').forEach(btn => {
    btn.addEventListener('click', () => {
      ds.active = parseInt(btn.dataset.dash);
      render();
    });
  });
  panel.querySelector('#dashNewBtn')?.addEventListener('click', () => openDashboardModal(null));
  panel.querySelector('#dashEditBtn')?.addEventListener('click', () => {
    const d = activeDashboard();
    if (d) openDashboardModal(d);
  });

  renderGrid();
}

function renderGrid() {
  const grid = document.getElementById('dashGrid');
  const dash = activeDashboard();
  if (!grid || !dash) return;

  const widgets = (dash.widgets || []).filter(id => widgetById(id)?.render);
  if (!widgets.length) {
    grid.innerHTML = `
      <div class="auto-empty">
        <div class="auto-empty-icon">📊</div>
        <p>This dashboard has no widgets yet.</p>
        <p class="auto-empty-sub">Press <kbd>e</kbd> to pick widgets for it.</p>
      </div>
    `;
    return;
  }
  grid.innerHTML = widgets.map(id => {
    const w = widgetById(id);
    return `
      <div class="dash-widget widget-frame" data-widget-id="${w.id}">
        <div class="widget-frame-header"><span>${w.icon} ${escapeHtml(w.title)}</span></div>
        <div class="widget-frame-body"></div>
      </div>
    `;
  }).join('');
  grid.querySelectorAll('.dash-widget').forEach(frame => {
    renderWidgetInto(frame.dataset.widgetId, frame.querySelector('.widget-frame-body'));
  });
}

// ============================================
// Dashboard editor modal (create / edit / delete)
// ============================================

function openDashboardModal(dash) {
  document.getElementById('dashEditModal')?.remove();
  const isHome = dash?.id === 'home';
  const selected = new Set(dash?.widgets || []);

  const modal = document.createElement('div');
  modal.id = 'dashEditModal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content dash-edit-modal">
      <h2>${dash ? 'Edit Dashboard' : 'New Dashboard'}</h2>
      <div class="fc-row">
        <div class="fc-field auto-field-grow">
          <label>Name</label>
          <input type="text" class="fc-input" id="demName" value="${escapeHtml(dash?.name || '')}" ${isHome ? 'disabled' : ''} autocomplete="off" spellcheck="false" />
        </div>
        <div class="fc-field dash-icon-field">
          <label>Icon</label>
          <input type="text" class="fc-input" id="demIcon" value="${escapeHtml(dash?.icon || '📊')}" maxlength="4" autocomplete="off" />
        </div>
      </div>
      <div class="fc-field">
        <label>Widgets</label>
        <div class="dash-widget-picker">
          ${dashboardCapableWidgets().map(w => `
            <label class="fc-checkbox dash-widget-option">
              <input type="checkbox" data-widget="${w.id}" ${selected.has(w.id) ? 'checked' : ''}>
              <span>${w.icon} ${escapeHtml(w.title)}</span>
            </label>
          `).join('')}
        </div>
      </div>
      <div class="fc-actions">
        ${dash && !isHome ? '<button type="button" class="fc-btn fc-btn-danger" id="demDelete">Delete</button>' : ''}
        <span class="fc-spacer"></span>
        <button type="button" class="fc-btn fc-btn-secondary" id="demCancel">Cancel</button>
        <button type="button" class="fc-btn fc-btn-primary" id="demSave">${dash ? 'Save' : 'Create'}</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.querySelector('#demCancel').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modal.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && e.metaKey) modal.querySelector('#demSave').click();
  });

  modal.querySelector('#demSave').addEventListener('click', async () => {
    const name = isHome ? 'HOME' : modal.querySelector('#demName').value.trim();
    if (!name) {
      modal.querySelector('#demName').focus();
      return;
    }
    const widgets = [...modal.querySelectorAll('[data-widget]')]
      .filter(cb => cb.checked)
      .map(cb => cb.dataset.widget);
    try {
      await SaveDashboard({
        id: dash?.id || '',
        name,
        icon: modal.querySelector('#demIcon').value.trim(),
        widgets,
      });
      close();
      await renderDashPanel();
    } catch (err) {
      console.error('Failed to save dashboard:', err);
      alert('Save failed: ' + (err?.message || err));
    }
  });

  modal.querySelector('#demDelete')?.addEventListener('click', async () => {
    if (!confirm(`Delete dashboard "${dash.name}"?`)) return;
    try {
      await DeleteDashboard(dash.id);
      close();
      ds.active = 0;
      await renderDashPanel();
    } catch (err) {
      console.error('Failed to delete dashboard:', err);
    }
  });

  if (!isHome) modal.querySelector('#demName').focus();
}

// ============================================
// Keyboard (shell NORMAL-mode module hook)
// ============================================

export function dashModuleOnKey(e) {
  switch (e.key) {
    case 'h':
    case '[':
      e.preventDefault();
      ds.active = (ds.active - 1 + ds.dashboards.length) % Math.max(ds.dashboards.length, 1);
      render();
      return true;
    case 'l':
    case ']':
      e.preventDefault();
      ds.active = (ds.active + 1) % Math.max(ds.dashboards.length, 1);
      render();
      return true;
    case 'n':
      e.preventDefault();
      openDashboardModal(null);
      return true;
    case 'e':
    case 'Enter': {
      const d = activeDashboard();
      if (d) {
        e.preventDefault();
        openDashboardModal(d);
        return true;
      }
      return false;
    }
    case 'r':
      e.preventDefault();
      renderDashPanel();
      return true;
  }
  return false;
}
