// Project quick switcher: `p` in NORMAL (or clicking the project label on
// the Term input bar). Vimium-style: every row carries a letter label —
// type it and the project is picked instantly. Digits jump by position,
// `/` switches to text filtering, arrows + Enter always work.

import { state } from './state.js';
import { searchNormalize } from './utils.js';
import { getProjectSessionInfo } from './terminal-dashboard.js';

// j/k/p stay out of the alphabet: j/k navigate the list, p opened the popup
const LABEL_ALPHABET = 'asdfghlqwertuiozxcvbnm';

function orderedProjects() {
  const order = window._projectDisplayOrder;
  const byName = new Map((state.projects || []).map(p => [p.name, p]));
  const out = [];
  if (order) {
    for (const name of order) {
      if (byName.has(name)) {
        out.push(byName.get(name));
        byName.delete(name);
      }
    }
  }
  out.push(...byName.values());
  return out;
}

function makeLabels(count) {
  const a = LABEL_ALPHABET;
  if (count <= a.length) return [...a.slice(0, count)];
  const labels = [];
  for (let i = 0; labels.length < count && i < a.length; i++) {
    for (let j = 0; labels.length < count && j < a.length; j++) {
      labels.push(a[i] + a[j]);
    }
  }
  return labels;
}

let switcher = null; // { projects, labels, selected, filter, buffer }

export function isProjectSwitcherOpen() {
  return !!document.getElementById('projectSwitcher');
}

export function openProjectSwitcher() {
  document.getElementById('projectSwitcher')?.remove();
  const projects = orderedProjects();
  if (projects.length === 0) return;

  switcher = {
    projects,
    sessionInfo: getProjectSessionInfo(),
    selected: 0,
    filter: '',
    buffer: '',
  };
  switcher.selected = Math.max(0, filteredProjects().findIndex(p => p.name === state.activeProject?.name));

  const modal = document.createElement('div');
  modal.id = 'projectSwitcher';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content project-switcher-content">
      <div class="project-switcher-top">
        <h2>Switch project</h2>
        <input type="text" id="psInput" class="board-filter project-switcher-input"
               placeholder="/ filter by name" autocomplete="off" spellcheck="false" />
      </div>
      <div class="project-switcher-sections" id="psList"></div>
      <div class="project-switcher-hint">letters pick (Vimium) · 1-9 jump · j/k move + Enter · / filter · Esc close</div>
    </div>
  `;
  document.body.appendChild(modal);

  modal.addEventListener('click', (e) => { if (e.target === modal) closeSwitcher(); });

  const input = modal.querySelector('#psInput');
  input.addEventListener('input', () => {
    if (!switcher) return;
    switcher.filter = input.value;
    switcher.selected = 0;
    switcher.buffer = '';
    renderList();
  });
  // Filter field keys: Enter picks, arrows move, Esc back to label mode
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      if (input.value) {
        input.value = '';
        switcher.filter = '';
        renderList();
      }
      input.blur();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      pick(filteredProjects()[switcher.selected]?.name);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(e.key === 'ArrowDown' ? 1 : -1);
    }
  });

  renderList();
}

function closeSwitcher() {
  document.getElementById('projectSwitcher')?.remove();
  switcher = null;
}

// Projects with live sessions first, then the rest — each alphabetical;
// the group shows as a tag on each tile
function filteredProjects() {
  if (!switcher) return [];
  const q = searchNormalize(switcher.filter.trim());
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  const matching = switcher.projects.filter(p => !q || searchNormalize(p.name).includes(q));
  return [
    ...matching.filter(p => switcher.sessionInfo.has(p.name)).sort(byName),
    ...matching.filter(p => !switcher.sessionInfo.has(p.name)).sort(byName),
  ];
}

function groupTagOf(p) {
  const g = (state.projectGroups || []).find(g => g.id === p.groupId);
  return g ? `<span class="ps-tag">${g.icon || ''} ${g.name}</span>` : '';
}

function pick(name) {
  closeSwitcher();
  if (name && name !== state.activeProject?.name) {
    window.itermSelectProject?.(name);
  }
}

function moveSelection(delta) {
  const items = filteredProjects();
  switcher.selected = Math.max(0, Math.min(items.length - 1, switcher.selected + delta));
  renderList();
}

function renderTile(p, i) {
  const label = switcher.labels[i];
  const match = !switcher.buffer || label.startsWith(switcher.buffer);
  const s = switcher.sessionInfo.get(p.name);
  return `
    <div class="ps-tile ${i === switcher.selected ? 'kb-selected' : ''} ${p.name === state.activeProject?.name ? 'ps-current' : ''}"
         data-name="${p.name.replace(/"/g, '&quot;')}"
         style="--project-color: ${p.color || '#3b82f6'}">
      <span class="hint-label ps-label ${match ? '' : 'hint-dimmed'}">${
        switcher.buffer && match
          ? `<b>${switcher.buffer}</b>${label.slice(switcher.buffer.length)}`
          : label
      }</span>
      <span class="ps-digit">${!switcher.filter && i < 9 ? i + 1 : ''}</span>
      <span class="ps-tile-icon">${p.icon || '📁'}</span>
      <span class="ps-name">${p.name}</span>
      ${groupTagOf(p)}
      <span class="ps-count">${s ? `${s.count > 1 ? `${s.count} ` : ''}<span class="term-proj-dot claude-dot-${s.status}"></span>` : '&nbsp;'}</span>
    </div>
  `;
}

function renderList() {
  const listEl = document.getElementById('psList');
  if (!listEl || !switcher) return;
  const items = filteredProjects();
  if (switcher.selected >= items.length) switcher.selected = Math.max(0, items.length - 1);
  switcher.labels = makeLabels(items.length);

  const activeCount = items.filter(p => switcher.sessionInfo.has(p.name)).length;
  listEl.innerHTML = items.length
    ? items.map((p, i) =>
        renderTile(p, i) +
        (i === activeCount - 1 && activeCount < items.length ? '<div class="ps-separator"></div>' : '')
      ).join('')
    : '<div class="help-empty">No matching projects</div>';

  listEl.querySelectorAll('.ps-tile').forEach(item => {
    item.addEventListener('click', () => pick(item.dataset.name));
  });
  listEl.querySelector('.kb-selected')?.scrollIntoView({ block: 'nearest' });
}

// Label-mode key handling; wired into the global keydown router. Skipped
// while the filter input has focus (its own listener handles keys then).
export function handleProjectSwitcherKey(e) {
  if (!switcher) return;
  if (document.activeElement?.id === 'psInput') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  const items = filteredProjects();
  switch (e.key) {
    case 'Escape':
      e.preventDefault();
      closeSwitcher();
      return;
    case 'Enter':
      e.preventDefault();
      pick(items[switcher.selected]?.name);
      return;
    case 'j':
    case 'ArrowDown':
    case 'ArrowRight':
      e.preventDefault();
      moveSelection(1);
      return;
    case 'k':
    case 'ArrowUp':
    case 'ArrowLeft':
      e.preventDefault();
      moveSelection(-1);
      return;
    case '/':
      e.preventDefault();
      document.getElementById('psInput')?.focus();
      return;
    case 'Backspace':
      e.preventDefault();
      switcher.buffer = switcher.buffer.slice(0, -1);
      renderList();
      return;
  }

  if (!switcher.filter && e.key >= '1' && e.key <= '9') {
    const idx = parseInt(e.key) - 1;
    if (idx < items.length) {
      e.preventDefault();
      pick(items[idx].name);
    }
    return;
  }

  if (e.key.length === 1 && LABEL_ALPHABET.includes(e.key.toLowerCase())) {
    e.preventDefault();
    switcher.buffer += e.key.toLowerCase();
    const exact = switcher.labels.findIndex(l => l === switcher.buffer);
    if (exact !== -1) {
      pick(items[exact]?.name);
      return;
    }
    if (!switcher.labels.some(l => l.startsWith(switcher.buffer))) {
      switcher.buffer = '';
    }
    renderList();
  }
}

window.openProjectSwitcher = openProjectSwitcher;
