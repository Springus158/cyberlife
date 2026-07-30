// Board module: per-project kanban replacing the todo list. Two views
// (columns / flat list, `v` toggles), full keyboard grammar, native HTML5
// drag & drop. Column IDs are the surface automation rules will bind to.

import { state } from './state.js';
import { escapeAttr, escapeHtml, searchNormalize } from './utils.js';
import { EventsOn, BrowserOpenURL } from '../../wailsjs/runtime/runtime';
import { GetKanban, UpsertKanbanTask, MoveKanbanTask, DeleteKanbanTask, SaveKanbanColumns, DeleteKanbanColumn, AddKanbanComment, GetJiraSettings, SetProjectJira, SyncJiraBoard } from '../../wailsjs/go/main/App';
import { refreshAutomationRules, automationColumnHints } from './auto-module.js';

export const BOARD_TAB_ID = 'board-tab';

const boardState = {
  columns: [],
  tasks: [],
  view: localStorage.getItem('boardView') || 'board', // board | list
  cursor: { col: 0, row: -1 },
  filter: '',
  projectId: null,
  jira: null,          // {enabled, baseUrl} from settings
  jiraSyncing: false,
  jiraLastSync: 0,
  jiraNote: '',
  autoHints: {},       // columnId -> automation rule names (⚡ indicator)
};

export function showBoardPanel(show) {
  const panel = document.getElementById('boardPanel');
  if (panel) panel.style.display = show ? 'flex' : 'none';
}

// Agents mutate the board through the local API; repaint live when they do
let changeListenerAttached = false;
function attachChangeListener() {
  if (changeListenerAttached) return;
  changeListenerAttached = true;
  EventsOn('kanban-changed', (projectId) => {
    if (isPanelVisible() && projectId === boardState.projectId) {
      loadBoard().then(renderBoardPanel).catch((err) => {
        console.error('Board live refresh failed:', err);
      });
    }
  });
}

function isPanelVisible() {
  const panel = document.getElementById('boardPanel');
  return panel && panel.style.display !== 'none';
}

// ============================================
// Data
// ============================================

async function loadBoard() {
  if (boardState.jira === null) {
    try {
      const j = await GetJiraSettings();
      boardState.jira = { enabled: !!j?.enabled, baseUrl: (j?.baseUrl || '').replace(/\/+$/, '') };
    } catch (err) {
      console.warn('Jira settings unavailable:', err);
      boardState.jira = { enabled: false, baseUrl: '' };
    }
  }
  const projectId = state.activeProject?.id;
  if (!projectId) {
    boardState.columns = [];
    boardState.tasks = [];
    return;
  }
  try {
    const board = await GetKanban(projectId);
    boardState.projectId = projectId;
    boardState.columns = board.columns || [];
    boardState.tasks = board.tasks || [];
    await refreshAutomationRules();
    boardState.autoHints = automationColumnHints(projectId, boardState.columns);
  } catch (err) {
    console.error('Failed to load kanban:', err);
  }
}

function visibleTasks(columnId) {
  const f = searchNormalize(boardState.filter);
  return boardState.tasks
    .filter(t => t.columnId === columnId && !t.archived)
    .filter(t => !f || searchNormalize(t.title).includes(f) || searchNormalize(t.category).includes(f))
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || a.order - b.order);
}

async function mutate(fn) {
  try {
    await fn();
    await loadBoard();
    renderBoardPanel();
  } catch (err) {
    console.error('Board update failed:', err);
  }
}

// ============================================
// Render
// ============================================

export async function renderBoardPanel() {
  const panel = document.getElementById('boardPanel');
  if (!panel) return;
  attachChangeListener();
  if (boardState.projectId !== state.activeProject?.id || boardState.columns.length === 0) {
    await loadBoard();
  }
  // Quietly refresh from Jira when the board opens and the sync is stale
  if (boardState.jira?.enabled && jiraProjectKey() && !boardState.jiraSyncing &&
      Date.now() - boardState.jiraLastSync > 60000) {
    boardState.jiraLastSync = Date.now();
    syncJiraNow();
  }

  const total = boardState.tasks.filter(t => !t.archived).length;
  panel.innerHTML = `
    <div class="board-header">
      <h3>Board</h3>
      <span class="board-count">${total} tasks</span>
      <input type="text" id="boardFilterInput" class="board-filter" placeholder="/ filter"
             value="${escapeAttr(boardState.filter)}" autocomplete="off" spellcheck="false" />
      ${renderJiraControls()}
      <div class="board-header-actions">
        <button class="small-btn" id="boardViewToggle" title="Toggle board / list (v)">${boardState.view === 'board' ? '☰' : '▦'}</button>
        <button class="small-btn" id="boardColumnsBtn" title="Manage columns (C)">⚙</button>
        <button class="small-btn" id="boardAddBtn" title="New task (n)">+</button>
      </div>
    </div>
    ${boardState.view === 'board' ? renderColumns() : renderList()}
  `;

  panel.querySelector('#boardViewToggle')?.addEventListener('click', toggleView);
  panel.querySelector('#boardJiraBtn')?.addEventListener('click', openJiraMapModal);
  panel.querySelector('#boardJiraSync')?.addEventListener('click', syncJiraNow);
  panel.querySelector('#boardColumnsBtn')?.addEventListener('click', openColumnsModal);
  panel.querySelector('#boardAddBtn')?.addEventListener('click', () => openTaskModal(null));
  const filter = panel.querySelector('#boardFilterInput');
  filter?.addEventListener('input', () => {
    boardState.filter = filter.value;
    refreshBody();
  });

  bindCardEvents(panel);
}

function jiraProjectKey() {
  return state.activeProject?.jiraProject || '';
}

function jiraFilter() {
  return state.activeProject?.jiraFilter || '';
}

// Ready-made JQL for the filters people actually want on a board
const JIRA_FILTER_PRESETS = [
  { label: 'Everything in the project', jql: '' },
  { label: 'Assigned to me', jql: 'assignee = currentUser()' },
  { label: 'Open sprints', jql: 'sprint in openSprints()' },
  { label: 'Assigned to me, open sprints', jql: 'assignee = currentUser() AND sprint in openSprints()' },
];

function renderJiraControls() {
  if (!boardState.jira?.enabled) return '';
  const key = jiraProjectKey();
  return `
    <button class="board-jira-chip ${key ? 'mapped' : ''}" id="boardJiraBtn"
            title="${key ? 'Synced with Jira project ' + escapeAttr(key) + (jiraFilter() ? ' · filter: ' + escapeAttr(jiraFilter()) : '') + ' — click to change' : 'Map this board to a Jira project'}">
      🧩 ${escapeHtml(key || 'Map Jira')}${key && jiraFilter() ? ' <span class="board-jira-filtered">filtered</span>' : ''}
    </button>
    ${key ? `<button class="small-btn" id="boardJiraSync" title="Sync with Jira (r)">${boardState.jiraSyncing ? '⏳' : '⇄'}</button>` : ''}
    ${boardState.jiraNote ? `<span class="board-jira-note">${boardState.jiraNote}</span>` : ''}
  `;
}

async function syncJiraNow() {
  if (!jiraProjectKey() || boardState.jiraSyncing) return;
  boardState.jiraSyncing = true;
  boardState.jiraNote = '';
  renderBoardPanel();
  try {
    const res = await SyncJiraBoard(boardState.projectId);
    boardState.jiraLastSync = Date.now();
    boardState.jiraNote = `synced ${res.total} issues (+${res.created} · ~${res.updated})`;
  } catch (err) {
    boardState.jiraNote = `✗ ${err}`;
    console.error('Jira sync failed:', err);
  }
  boardState.jiraSyncing = false;
  await loadBoard();
  renderBoardPanel();
  setTimeout(() => { boardState.jiraNote = ''; refreshHeaderNote(); }, 6000);
}

function refreshHeaderNote() {
  const note = document.querySelector('#boardPanel .board-jira-note');
  if (note && !boardState.jiraNote) note.remove();
}

function openJiraMapModal() {
  document.getElementById('boardJiraModal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'boardJiraModal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content board-columns-modal">
      <h2>Jira sync</h2>
      <p class="settings-section-desc">Map this board to a Jira project. Issues sync in
      (status → column by name, else by category) and moving a jira-backed card
      pushes the matching transition back to Jira.</p>
      <div class="fc-field">
        <label>Jira project key</label>
        <input type="text" class="fc-input fc-mono" id="bjmKey" placeholder="e.g. ACRE"
               value="${escapeAttr(jiraProjectKey())}" autocomplete="off" spellcheck="false" />
      </div>
      <div class="fc-field">
        <label>Which issues (optional filter)</label>
        <select class="fc-select" id="bjmPreset">
          ${JIRA_FILTER_PRESETS.map(p => `<option value="${escapeAttr(p.jql)}" ${p.jql === jiraFilter() ? 'selected' : ''}>${escapeHtml(p.label)}</option>`).join('')}
          <option value="__custom" ${jiraFilter() && !JIRA_FILTER_PRESETS.some(p => p.jql === jiraFilter()) ? 'selected' : ''}>Custom JQL…</option>
        </select>
        <input type="text" class="fc-input fc-mono" id="bjmFilter" placeholder='e.g. labels = frontend AND priority >= High'
               value="${escapeAttr(jiraFilter())}" autocomplete="off" spellcheck="false" />
        <p class="fc-hint">ANDed onto the sync query, so the board mirrors a slice of the
        project instead of every issue in it.</p>
      </div>
      <div class="fc-actions">
        ${jiraProjectKey() ? '<button class="fc-btn fc-btn-danger" id="bjmUnlink">Unlink</button>' : ''}
        <span class="fc-spacer"></span>
        <button class="fc-btn fc-btn-secondary" id="bjmCancel">Cancel</button>
        <button class="fc-btn fc-btn-primary" id="bjmSave">Save & sync</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modal.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
    if (e.key === 'Enter') modal.querySelector('#bjmSave').click();
  });
  const presetSelect = modal.querySelector('#bjmPreset');
  const filterInput = modal.querySelector('#bjmFilter');
  const syncFilterVisibility = () => {
    filterInput.style.display = presetSelect.value === '__custom' ? '' : 'none';
  };
  presetSelect.addEventListener('change', () => {
    if (presetSelect.value !== '__custom') filterInput.value = presetSelect.value;
    syncFilterVisibility();
  });
  syncFilterVisibility();

  modal.querySelector('#bjmCancel').addEventListener('click', close);
  modal.querySelector('#bjmUnlink')?.addEventListener('click', async () => {
    close();
    await SetProjectJira(boardState.projectId, '', '');
    if (state.activeProject) {
      state.activeProject.jiraProject = '';
      state.activeProject.jiraFilter = '';
    }
    renderBoardPanel();
  });
  modal.querySelector('#bjmSave').addEventListener('click', async () => {
    const key = modal.querySelector('#bjmKey').value.trim().toUpperCase();
    const filter = presetSelect.value === '__custom' ? filterInput.value.trim() : presetSelect.value;
    close();
    try {
      await SetProjectJira(boardState.projectId, key, filter);
      if (state.activeProject) {
        state.activeProject.jiraProject = key;
        state.activeProject.jiraFilter = filter;
      }
      if (key) await syncJiraNow();
      else renderBoardPanel();
    } catch (err) {
      console.error('Failed to map Jira project:', err);
    }
  });
  modal.querySelector('#bjmKey').focus();
}

function refreshBody() {
  const panel = document.getElementById('boardPanel');
  if (!panel) return;
  const old = panel.querySelector('.board-columns, .board-list');
  if (!old) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = boardState.view === 'board' ? renderColumns() : renderList();
  old.replaceWith(wrap.firstElementChild);
  bindCardEvents(panel);
}

function renderColumns() {
  return `
    <div class="board-columns">
      ${boardState.columns.map((col, colIdx) => {
        const tasks = visibleTasks(col.id);
        return `
          <div class="board-column" data-column-id="${col.id}">
            <div class="board-column-header">
              <span class="board-column-name">${escapeHtml(col.name)}</span>
              ${boardState.autoHints?.[col.id]?.length ? `<span class="board-column-auto" title="Automations: ${escapeAttr(boardState.autoHints[col.id].join(', '))}">⚡</span>` : ''}
              <span class="board-column-count ${col.wipLimit && tasks.length > col.wipLimit ? 'over-wip' : ''}">${tasks.length}${col.wipLimit ? '/' + col.wipLimit : ''}</span>
            </div>
            <div class="board-column-body" data-column-id="${col.id}">
              ${tasks.map((t, rowIdx) => renderCard(t, colIdx, rowIdx)).join('')}
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function renderList() {
  return `
    <div class="board-list">
      ${boardState.columns.map((col, colIdx) => {
        const tasks = visibleTasks(col.id);
        if (tasks.length === 0) return '';
        return `
          <div class="board-list-group">
            <div class="board-list-group-header">${escapeHtml(col.name)} <span class="board-column-count">${tasks.length}</span></div>
            ${tasks.map((t, rowIdx) => renderCard(t, colIdx, rowIdx, true)).join('')}
          </div>
        `;
      }).join('')}
    </div>
  `;
}

const PRIORITY_COLORS = { high: '#ef4444', medium: '#e3b341', low: '#6b7280' };

function renderCard(t, colIdx, rowIdx, listRow = false) {
  const selected = boardState.cursor.col === colIdx && boardState.cursor.row === rowIdx;
  return `
    <div class="board-card ${listRow ? 'board-card-row' : ''} ${selected ? 'kb-selected' : ''} ${t.blocked ? 'blocked' : ''}"
         draggable="true" data-task-id="${t.id}" data-col-idx="${colIdx}" data-row-idx="${rowIdx}">
      ${t.priority ? `<span class="board-priority-dot" style="background:${PRIORITY_COLORS[t.priority] || '#6b7280'}"></span>` : ''}
      <span class="board-card-title">${t.pinned ? '📌 ' : ''}${t.jiraKey ? `<span class="board-card-key" data-jira-key="${escapeAttr(t.jiraKey)}" title="Open in Jira">${escapeHtml(t.jiraKey)}</span> ` : ''}${escapeHtml(t.title)}</span>
      <span class="board-card-chips">
        ${t.blocked ? '<span class="board-chip board-chip-blocked">blocked</span>' : ''}
        ${t.category ? `<span class="board-chip">${escapeHtml(t.category)}</span>` : ''}
      </span>
    </div>
  `;
}

function bindCardEvents(panel) {
  panel.querySelectorAll('.board-card-key').forEach(chip => {
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      if (boardState.jira?.baseUrl) {
        BrowserOpenURL(boardState.jira.baseUrl + '/browse/' + chip.dataset.jiraKey);
      }
    });
  });
  panel.querySelectorAll('.board-card').forEach(card => {
    card.addEventListener('click', () => {
      const task = boardState.tasks.find(t => t.id === card.dataset.taskId);
      if (task) openTaskModal(task);
    });
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', card.dataset.taskId);
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
  });

  panel.querySelectorAll('.board-column-body').forEach(body => {
    body.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      body.classList.add('drag-over');
    });
    body.addEventListener('dragleave', () => body.classList.remove('drag-over'));
    body.addEventListener('drop', (e) => {
      e.preventDefault();
      body.classList.remove('drag-over');
      const taskId = e.dataTransfer.getData('text/plain');
      if (!taskId) return;
      const cards = [...body.querySelectorAll('.board-card:not(.dragging)')];
      let index = cards.length;
      for (let i = 0; i < cards.length; i++) {
        if (e.clientY < cards[i].getBoundingClientRect().top + cards[i].offsetHeight / 2) {
          index = i;
          break;
        }
      }
      mutate(() => MoveKanbanTask(boardState.projectId, taskId, body.dataset.columnId, index));
    });
  });
}

// ============================================
// Task modal
// ============================================

function openTaskModal(task) {
  document.getElementById('boardTaskModal')?.remove();

  const categories = [...new Set(boardState.tasks.map(t => t.category).filter(Boolean))];
  const cursorCol = boardState.columns[boardState.cursor.col];
  const modal = document.createElement('div');
  modal.id = 'boardTaskModal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content board-task-modal">
      <h2>${task ? 'Edit Task' : 'New Task'}</h2>
      <div class="fc-field">
        <label>Title</label>
        <input type="text" class="fc-input" id="btmTitle" value="${escapeAttr(task?.title || '')}" autocomplete="off" spellcheck="false" />
      </div>
      <div class="fc-field">
        <label>Description</label>
        <textarea class="fc-textarea" id="btmDesc" rows="4" spellcheck="false">${escapeHtml(task?.description || '')}</textarea>
      </div>
      <div class="fc-row">
        <div class="fc-field">
          <label>Column</label>
          <select class="fc-select" id="btmColumn">
            ${boardState.columns.map(c => `<option value="${c.id}" ${(task?.columnId || cursorCol?.id) === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
          </select>
        </div>
        <div class="fc-field">
          <label>Priority</label>
          <select class="fc-select" id="btmPriority">
            ${['', 'low', 'medium', 'high'].map(p => `<option value="${p}" ${(task?.priority || '') === p ? 'selected' : ''}>${p || '—'}</option>`).join('')}
          </select>
        </div>
        <div class="fc-field">
          <label>Category</label>
          <input type="text" class="fc-input" id="btmCategory" value="${escapeAttr(task?.category || '')}" list="btmCategoryList" autocomplete="off" />
          <datalist id="btmCategoryList">${categories.map(c => `<option value="${escapeAttr(c)}">`).join('')}</datalist>
        </div>
      </div>
      ${task ? `
      <div class="board-comments">
        <label>Comments</label>
        <div class="board-comments-list">
          ${(task.comments || []).map(c => `
            <div class="board-comment">
              <span class="board-comment-meta">${escapeHtml(c.author)} · ${new Date(c.createdAt).toLocaleString()}</span>
              <div class="board-comment-text">${escapeHtml(c.text)}</div>
            </div>
          `).join('') || '<div class="board-comments-empty">No comments</div>'}
        </div>
        <div class="board-comment-add">
          <input type="text" class="fc-input" id="btmCommentInput" placeholder="Add a comment…" autocomplete="off" spellcheck="false" />
          <button type="button" class="fc-btn fc-btn-secondary fc-btn-sm" id="btmCommentAdd">Add</button>
        </div>
      </div>` : ''}
      <div class="fc-actions">
        ${task ? '<button type="button" class="fc-btn fc-btn-danger" id="btmDelete">Delete</button>' : ''}
        <span class="fc-spacer"></span>
        <button type="button" class="fc-btn fc-btn-secondary" id="btmCancel">Cancel</button>
        <button type="button" class="fc-btn fc-btn-primary" id="btmSave">${task ? 'Save' : 'Add'}</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const close = () => modal.remove();
  const save = () => {
    const title = modal.querySelector('#btmTitle').value.trim();
    if (!title) return;
    const updated = {
      ...(task || {}),
      title,
      description: modal.querySelector('#btmDesc').value,
      columnId: modal.querySelector('#btmColumn').value,
      priority: modal.querySelector('#btmPriority').value,
      category: modal.querySelector('#btmCategory').value.trim(),
    };
    close();
    mutate(() => UpsertKanbanTask(boardState.projectId, updated));
  };

  modal.querySelector('#btmCancel').addEventListener('click', close);
  modal.querySelector('#btmSave').addEventListener('click', save);
  modal.querySelector('#btmCommentAdd')?.addEventListener('click', async () => {
    const input = modal.querySelector('#btmCommentInput');
    const text = input.value.trim();
    if (!text || !task) return;
    try {
      await AddKanbanComment(boardState.projectId, task.id, 'me', text);
      await loadBoard();
      close();
      openTaskModal(boardState.tasks.find(t => t.id === task.id));
    } catch (err) {
      console.error('Failed to add comment:', err);
    }
  });
  modal.querySelector('#btmCommentInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      modal.querySelector('#btmCommentAdd').click();
    }
  });
  modal.querySelector('#btmDelete')?.addEventListener('click', () => {
    close();
    mutate(() => DeleteKanbanTask(boardState.projectId, task.id));
  });
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modal.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && (e.metaKey || e.target.id === 'btmTitle')) {
      e.preventDefault();
      save();
    }
  });
  modal.querySelector('#btmTitle').focus();
}

// ============================================
// Columns manager
// ============================================

function openColumnsModal() {
  document.getElementById('boardColumnsModal')?.remove();
  // Working copy: rename/reorder/WIP/add are batched on Save, deletes are immediate
  const working = boardState.columns.map(c => ({ ...c }));

  const modal = document.createElement('div');
  modal.id = 'boardColumnsModal';
  modal.className = 'modal';

  const renderRows = () => `
    ${working.map((c, i) => `
      <div class="board-col-row" data-idx="${i}">
        <button type="button" class="fc-btn fc-btn-secondary fc-btn-sm" data-act="up" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="fc-btn fc-btn-secondary fc-btn-sm" data-act="down" ${i === working.length - 1 ? 'disabled' : ''}>↓</button>
        <input type="text" class="fc-input board-col-name" value="${escapeAttr(c.name)}" />
        <input type="number" class="fc-input board-col-wip" min="0" placeholder="WIP" title="WIP limit (0 = none)" value="${c.wipLimit || ''}" />
        <button type="button" class="fc-btn fc-btn-danger fc-btn-sm board-col-delete" data-act="delete" ${working.length <= 1 ? 'disabled' : ''}>×</button>
      </div>
    `).join('')}
  `;

  modal.innerHTML = `
    <div class="modal-content board-columns-modal">
      <h2>Columns</h2>
      <div id="bcmRows">${renderRows()}</div>
      <button type="button" class="fc-btn fc-btn-secondary" id="bcmAdd">+ Add column</button>
      <div class="fc-actions">
        <span class="fc-spacer"></span>
        <button type="button" class="fc-btn fc-btn-secondary" id="bcmCancel">Cancel</button>
        <button type="button" class="fc-btn fc-btn-primary" id="bcmSave">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  const rowsEl = modal.querySelector('#bcmRows');

  const syncFromInputs = () => {
    rowsEl.querySelectorAll('.board-col-row').forEach((row) => {
      const i = parseInt(row.dataset.idx);
      working[i].name = row.querySelector('.board-col-name').value;
      working[i].wipLimit = parseInt(row.querySelector('.board-col-wip').value) || 0;
    });
  };
  const rerender = () => { rowsEl.innerHTML = renderRows(); };

  rowsEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    syncFromInputs();
    const i = parseInt(btn.closest('.board-col-row').dataset.idx);
    const act = btn.dataset.act;
    if (act === 'up' && i > 0) {
      [working[i - 1], working[i]] = [working[i], working[i - 1]];
      rerender();
    } else if (act === 'down' && i < working.length - 1) {
      [working[i + 1], working[i]] = [working[i], working[i + 1]];
      rerender();
    } else if (act === 'delete') {
      const col = working[i];
      if (col.id && boardState.columns.some(c => c.id === col.id)) {
        try {
          await DeleteKanbanColumn(boardState.projectId, col.id);
        } catch (err) {
          console.error('Failed to delete column:', err);
          return;
        }
      }
      working.splice(i, 1);
      rerender();
    }
  });

  modal.querySelector('#bcmAdd').addEventListener('click', () => {
    syncFromInputs();
    working.push({ id: '', name: 'New column', order: working.length, wipLimit: 0 });
    rerender();
    const inputs = rowsEl.querySelectorAll('.board-col-name');
    const last = inputs[inputs.length - 1];
    last?.focus();
    last?.select();
  });

  const close = () => modal.remove();
  modal.querySelector('#bcmCancel').addEventListener('click', close);
  modal.querySelector('#bcmSave').addEventListener('click', async () => {
    syncFromInputs();
    const columns = working
      .filter(c => c.name.trim())
      .map((c, i) => ({ ...c, name: c.name.trim(), order: i, id: c.id || crypto.randomUUID() }));
    close();
    mutate(() => SaveKanbanColumns(boardState.projectId, columns));
  });
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modal.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
  });
}

// ============================================
// Keyboard (shell NORMAL-mode module hook)
// ============================================

function cursorTask() {
  const col = boardState.columns[boardState.cursor.col];
  if (!col) return null;
  return visibleTasks(col.id)[boardState.cursor.row] || null;
}

function clampCursor() {
  const c = boardState.cursor;
  c.col = Math.max(0, Math.min(boardState.columns.length - 1, c.col));
  const col = boardState.columns[c.col];
  const count = col ? visibleTasks(col.id).length : 0;
  c.row = Math.max(count > 0 ? 0 : -1, Math.min(count - 1, c.row));
}

function moveCursor(dCol, dRow) {
  boardState.cursor.col += dCol;
  boardState.cursor.row += dRow;
  if (boardState.cursor.row < 0) boardState.cursor.row = 0;
  clampCursor();
  refreshBody();
  document.querySelector('#boardPanel .kb-selected')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// In list view the cursor walks all groups as one flat sequence
function flatCursorMove(delta) {
  const seq = [];
  boardState.columns.forEach((col, colIdx) => {
    visibleTasks(col.id).forEach((t, rowIdx) => seq.push({ colIdx, rowIdx }));
  });
  if (seq.length === 0) return;
  let pos = seq.findIndex(p => p.colIdx === boardState.cursor.col && p.rowIdx === boardState.cursor.row);
  pos = pos === -1 ? 0 : Math.max(0, Math.min(seq.length - 1, pos + delta));
  boardState.cursor.col = seq[pos].colIdx;
  boardState.cursor.row = seq[pos].rowIdx;
  refreshBody();
  document.querySelector('#boardPanel .kb-selected')?.scrollIntoView({ block: 'nearest' });
}

function moveTaskToColumn(delta) {
  const task = cursorTask();
  if (!task) return;
  const targetIdx = boardState.cursor.col + delta;
  const target = boardState.columns[targetIdx];
  if (!target) return;
  boardState.cursor.col = targetIdx;
  mutate(() => MoveKanbanTask(boardState.projectId, task.id, target.id, visibleTasks(target.id).length));
}

function reorderTask(delta) {
  const task = cursorTask();
  if (!task) return;
  const col = boardState.columns[boardState.cursor.col];
  const newIndex = boardState.cursor.row + delta;
  if (newIndex < 0 || newIndex >= visibleTasks(col.id).length) return;
  boardState.cursor.row = newIndex;
  mutate(() => MoveKanbanTask(boardState.projectId, task.id, col.id, newIndex));
}

function cycleStatus() {
  const task = cursorTask();
  if (!task) return;
  const colIdx = boardState.columns.findIndex(c => c.id === task.columnId);
  const next = boardState.columns[(colIdx + 1) % boardState.columns.length];
  mutate(() => MoveKanbanTask(boardState.projectId, task.id, next.id, visibleTasks(next.id).length));
}

function toggleView() {
  boardState.view = boardState.view === 'board' ? 'list' : 'board';
  localStorage.setItem('boardView', boardState.view);
  renderBoardPanel();
}

export function boardModuleOnKey(e) {
  const isBoard = boardState.view === 'board';
  switch (e.key) {
    case 'j':
    case 'ArrowDown':
      e.preventDefault();
      isBoard ? moveCursor(0, 1) : flatCursorMove(1);
      return true;
    case 'k':
    case 'ArrowUp':
      e.preventDefault();
      isBoard ? moveCursor(0, -1) : flatCursorMove(-1);
      return true;
    case 'h':
    case 'ArrowLeft':
      if (!isBoard) return false;
      e.preventDefault();
      moveCursor(-1, 0);
      return true;
    case 'l':
    case 'ArrowRight':
      if (!isBoard) return false;
      e.preventDefault();
      moveCursor(1, 0);
      return true;
    case 'H':
      e.preventDefault();
      moveTaskToColumn(-1);
      return true;
    case 'L':
      e.preventDefault();
      moveTaskToColumn(1);
      return true;
    case 'J':
      if (!cursorTask()) return false; // no card selected: ⇧J/⇧K cycle modules
      e.preventDefault();
      reorderTask(1);
      return true;
    case 'K':
      if (!cursorTask()) return false;
      e.preventDefault();
      reorderTask(-1);
      return true;
    case 'Enter': {
      const task = cursorTask();
      if (!task) return false;
      e.preventDefault();
      openTaskModal(task);
      return true;
    }
    case 'n':
      e.preventDefault();
      openTaskModal(null);
      return true;
    case 's':
      e.preventDefault();
      cycleStatus();
      return true;
    case 'b': {
      const task = cursorTask();
      if (!task) return false;
      e.preventDefault();
      mutate(() => UpsertKanbanTask(boardState.projectId, { ...task, blocked: !task.blocked }));
      return true;
    }
    case 'x': {
      const task = cursorTask();
      if (!task) return false;
      e.preventDefault();
      mutate(() => UpsertKanbanTask(boardState.projectId, { ...task, archived: true }));
      return true;
    }
    case 'v':
      e.preventDefault();
      toggleView();
      return true;
    case 'C':
      e.preventDefault();
      openColumnsModal();
      return true;
    case 'r':
      if (jiraProjectKey()) {
        e.preventDefault();
        syncJiraNow();
        return true;
      }
      return false;
    case '/': {
      const input = document.getElementById('boardFilterInput');
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


