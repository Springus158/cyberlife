// Tasks — per-project work items, each with its own git worktree and a resumable Claude session

import { state } from './state.js';
import { escapeHtml } from './utils.js';
import { buildAccountOptions, attachAccountSelect, loadClaudeAccounts } from './claude-accounts.js';
import {
  GetState, CreateProjectTask, OpenProjectTask, UpdateProjectTask, DeleteProjectTask,
  GetGitCurrentBranch, ListProjectRepos
} from '../../wailsjs/go/main/App';

const STATUS_ORDER = ['active', 'blocked', 'done'];

export function initTasks() {
  addTaskStyles();
}

async function refreshProjectsState() {
  const appState = await GetState();
  state.projects = Object.values(appState.projects || {});
  if (state.activeProject) {
    state.activeProject = state.projects.find(p => p.id === state.activeProject.id) || state.activeProject;
  }
}

function findProject(projectId) {
  return (state.projects || []).find(p => p.id === projectId);
}

function findTask(proj, taskId) {
  return (proj?.tasks || []).find(t => t.id === taskId);
}

function sortedTasks(proj) {
  const rank = t => (t.status === 'done' ? 1 : 0);
  return [...(proj?.tasks || [])].sort((a, b) =>
    rank(a) - rank(b) || String(b.lastOpened || b.createdAt).localeCompare(String(a.lastOpened || a.createdAt)));
}

// ============================================
// Task list popup
// ============================================

window.tasksOpenPopup = function(projectId) {
  const proj = findProject(projectId);
  if (!proj) return;

  document.querySelector('.tasks-popup-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'tasks-popup-overlay';
  overlay.innerHTML = `
    <div class="tasks-popup">
      <div class="tasks-popup-header">
        <span class="tasks-popup-title">${proj.icon || '◫'} ${escapeHtml(proj.name)} — Tasks</span>
        <button class="tasks-popup-close" title="Close">×</button>
      </div>
      <div class="tasks-popup-toolbar">
        <input type="text" class="tasks-popup-search" placeholder="Search tasks…" spellcheck="false" autocomplete="off">
        <button class="tasks-popup-new">+ New task</button>
      </div>
      <div class="tasks-popup-list"></div>
    </div>
  `;

  const searchInput = overlay.querySelector('.tasks-popup-search');
  const renderList = () => {
    overlay.querySelector('.tasks-popup-list').innerHTML = renderTaskRows(findProject(projectId), searchInput.value.trim().toLowerCase());
  };

  searchInput.addEventListener('input', renderList);
  overlay.querySelector('.tasks-popup-close').addEventListener('click', () => overlay.remove());
  overlay.querySelector('.tasks-popup-new').addEventListener('click', () => {
    overlay.remove();
    window.tasksNewTask(projectId);
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') overlay.remove(); });

  overlay.querySelector('.tasks-popup-list').addEventListener('click', async (e) => {
    const row = e.target.closest('.task-row');
    if (!row) return;
    const taskId = row.dataset.taskId;

    if (e.target.closest('.task-status-dot')) {
      await cycleTaskStatus(projectId, taskId);
      renderList();
      return;
    }
    if (e.target.closest('.task-delete-btn')) {
      showDeleteTaskPopup(projectId, taskId, renderList);
      return;
    }
    overlay.remove();
    window.tasksOpen(projectId, taskId);
  });

  document.body.appendChild(overlay);
  renderList();
  searchInput.focus();
};

function renderTaskRows(proj, query) {
  const tasks = sortedTasks(proj).filter(t => {
    if (!query) return true;
    return (t.jiraKey || '').toLowerCase().includes(query) || (t.name || '').toLowerCase().includes(query);
  });

  if (tasks.length === 0) {
    return `<div class="tasks-popup-empty">${proj?.tasks?.length ? 'No tasks match your search' : 'No tasks yet — create one to start working on a ticket in its own worktree'}</div>`;
  }

  return tasks.map(t => `
    <div class="task-row ${t.status}" data-task-id="${t.id}" title="${escapeHtml(t.worktreePath || '')}">
      <button class="task-status-dot ${t.status}" title="Status: ${t.status} (click to change)"></button>
      ${t.jiraKey ? `<span class="task-jira-key">${escapeHtml(t.jiraKey)}</span>` : ''}
      <span class="task-name">${escapeHtml(t.name)}</span>
      ${(t.repos || []).length > 1 ? `<span class="task-repos-count" title="${escapeHtml(t.repos.map(r => r.repoName).join(', '))}">${t.repos.length} repos</span>` : ''}
      <span class="task-branch">⎇ ${escapeHtml(t.branch || '')}</span>
      ${t.sessionStarted ? '<span class="task-resume-hint" title="Has a Claude session to resume">↻</span>' : ''}
      <button class="task-delete-btn" title="Delete task">✕</button>
    </div>
  `).join('');
}

async function cycleTaskStatus(projectId, taskId) {
  const proj = findProject(projectId);
  const task = findTask(proj, taskId);
  if (!task) return;
  task.status = STATUS_ORDER[(STATUS_ORDER.indexOf(task.status) + 1) % STATUS_ORDER.length];
  try {
    await UpdateProjectTask(projectId, task);
  } catch (err) {
    console.error('Failed to update task status:', err);
  }
  window.itermRenderDashboard?.();
}

// ============================================
// Open (start or resume) a task session
// ============================================

window.tasksOpen = async function(projectId, taskId) {
  const proj = findProject(projectId);
  const task = findTask(proj, taskId);
  if (!proj || !task) return;

  window.itermSelectProject?.(proj.name);

  const existingTab = window.itermFindTabByPath?.(task.worktreePath);
  if (existingTab) {
    window.itermSelectTerminal?.(existingTab.sessionId);
    return;
  }

  const tabName = task.jiraKey || (task.name.length > 30 ? task.name.slice(0, 29) + '…' : task.name);
  try {
    const previousIds = window.itermCurrentSessionIds?.() || new Set();
    await OpenProjectTask(projectId, taskId);
    await window.itermAdoptNewTab?.(previousIds, proj.name, tabName, task.claudeConfigDir || proj.claudeConfigDir || '');
    await refreshProjectsState();
  } catch (err) {
    console.error('Failed to open task:', err);
    alert(`Failed to open task: ${err}`);
  }
};

// ============================================
// New task popup
// ============================================

window.tasksNewTask = async function(projectId) {
  const proj = findProject(projectId);
  if (!proj) return;

  await loadClaudeAccounts();
  document.querySelector('.tasks-popup-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'tasks-popup-overlay';
  overlay.innerHTML = `
    <div class="tasks-popup tasks-popup-form">
      <div class="tasks-popup-header">
        <span class="tasks-popup-title">New task — ${escapeHtml(proj.name)}</span>
        <button class="tasks-popup-close" title="Close">×</button>
      </div>
      <div class="tasks-popup-body">
        <label class="tasks-form-label">Task name</label>
        <input type="text" class="tasks-form-input task-name-input" placeholder="What are you working on?" spellcheck="false" autocomplete="off" data-auto="true">
        <div class="tasks-repos-section" style="display:none">
          <label class="tasks-form-label">Repositories <span class="tasks-repos-hint">select the repos this task touches</span></label>
          <div class="tasks-repos-list"></div>
        </div>
        <label class="tasks-form-label">Branch</label>
        <input type="text" class="tasks-form-input task-branch-input" placeholder="auto from task name" spellcheck="false" autocomplete="off" data-auto="true">
        <label class="tasks-form-label">Base branch</label>
        <input type="text" class="tasks-form-input task-base-input" placeholder="repo's current branch" spellcheck="false" autocomplete="off">
        <label class="tasks-form-label">Claude account</label>
        <select class="account-select task-account-select">${buildAccountOptions(proj.claudeConfigDir || '')}</select>
        <div class="tasks-form-error"></div>
      </div>
      <div class="tasks-popup-actions">
        <button class="tasks-popup-cancel">Cancel</button>
        <button class="tasks-popup-create">Create & start</button>
      </div>
    </div>
  `;

  const nameInput = overlay.querySelector('.task-name-input');
  const branchInput = overlay.querySelector('.task-branch-input');
  const baseInput = overlay.querySelector('.task-base-input');
  const accountSelect = overlay.querySelector('.task-account-select');
  const errorBox = overlay.querySelector('.tasks-form-error');
  attachAccountSelect(accountSelect);

  let projectRepos = [];
  ListProjectRepos(proj.id)
    .then(repos => {
      projectRepos = repos || [];
      if (projectRepos.length > 1) {
        overlay.querySelector('.tasks-repos-section').style.display = '';
        overlay.querySelector('.tasks-repos-list').innerHTML = projectRepos.map((r, i) => `
          <label class="tasks-form-check"><input type="checkbox" class="task-repo-check" value="${i}"> ${escapeHtml(r.name)}</label>
        `).join('');
      } else if (projectRepos.length === 1) {
        GetGitCurrentBranch(projectRepos[0].path)
          .then(branch => { if (!baseInput.value) baseInput.value = branch || ''; })
          .catch((err) => { console.warn('Failed to read current branch:', err); });
      } else {
        errorBox.textContent = 'No git repositories found in this project folder';
      }
    })
    .catch((err) => { console.warn('Failed to list project repos:', err); });

  const branchSlug = (name) => {
    return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
  };
  const autofillBranch = () => {
    if (branchInput.dataset.auto === 'false') return;
    branchInput.value = branchSlug(nameInput.value);
    branchInput.dataset.auto = 'true';
  };

  nameInput.addEventListener('input', () => { nameInput.dataset.auto = 'false'; autofillBranch(); });
  branchInput.addEventListener('input', () => { branchInput.dataset.auto = 'false'; });


  const close = () => overlay.remove();
  overlay.querySelector('.tasks-popup-close').addEventListener('click', close);
  overlay.querySelector('.tasks-popup-cancel').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  overlay.querySelector('.tasks-popup-create').addEventListener('click', async () => {
    const name = nameInput.value.trim();
    const jiraKey = '';
    if (!name) {
      errorBox.textContent = 'Task name is required';
      return;
    }
    const repoPaths = projectRepos.length > 1
      ? [...overlay.querySelectorAll('.task-repo-check:checked')].map(cb => projectRepos[Number(cb.value)].path)
      : projectRepos.map(r => r.path);
    if (projectRepos.length > 1 && repoPaths.length === 0) {
      errorBox.textContent = 'Select at least one repository';
      return;
    }
    const createBtn = overlay.querySelector('.tasks-popup-create');
    createBtn.disabled = true;
    createBtn.textContent = 'Creating worktrees…';
    errorBox.textContent = '';
    try {
      const task = await CreateProjectTask(proj.id, name, jiraKey, branchInput.value.trim(), baseInput.value.trim(), accountSelect.value || '', repoPaths);
      await refreshProjectsState();
      close();
      window.itermRenderDashboard?.();
      window.tasksOpen(proj.id, task.id);
    } catch (err) {
      createBtn.disabled = false;
      createBtn.textContent = 'Create & start';
      errorBox.textContent = String(err);
    }
  });

  document.body.appendChild(overlay);
  nameInput.focus();
};

// ============================================
// Delete task popup
// ============================================

function showDeleteTaskPopup(projectId, taskId, onDone) {
  const proj = findProject(projectId);
  const task = findTask(proj, taskId);
  if (!task) return;

  document.querySelector('.tasks-delete-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'tasks-popup-overlay tasks-delete-overlay';
  overlay.innerHTML = `
    <div class="tasks-popup tasks-popup-form">
      <div class="tasks-popup-header">
        <span class="tasks-popup-title">Delete task</span>
        <button class="tasks-popup-close" title="Close">×</button>
      </div>
      <div class="tasks-popup-body">
        <p class="tasks-delete-info">Delete <strong>${escapeHtml(task.name)}</strong>?<br>
        This removes ${(task.repos || []).length > 1
          ? `its ${task.repos.length} worktrees (${escapeHtml(task.repos.map(r => r.repoName).join(', '))}) under <code>${escapeHtml(task.worktreePath || '')}</code>`
          : `its worktree at <code>${escapeHtml(task.worktreePath || '')}</code>`}.</p>
        <label class="tasks-form-check"><input type="checkbox" class="task-del-branch" checked> Also delete branch <code>${escapeHtml(task.branch || '')}</code>${(task.repos || []).length > 1 ? ' in every repo' : ''}</label>
        <label class="tasks-form-check"><input type="checkbox" class="task-del-force"> Force (discard uncommitted / unmerged changes)</label>
        <div class="tasks-form-error"></div>
      </div>
      <div class="tasks-popup-actions">
        <button class="tasks-popup-cancel">Cancel</button>
        <button class="tasks-popup-create danger">Delete</button>
      </div>
    </div>
  `;

  const close = () => overlay.remove();
  overlay.querySelector('.tasks-popup-close').addEventListener('click', close);
  overlay.querySelector('.tasks-popup-cancel').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  overlay.querySelector('.tasks-popup-create').addEventListener('click', async () => {
    const deleteBranch = overlay.querySelector('.task-del-branch').checked;
    const force = overlay.querySelector('.task-del-force').checked;
    const errorBox = overlay.querySelector('.tasks-form-error');
    try {
      await DeleteProjectTask(projectId, taskId, deleteBranch, force);
      await refreshProjectsState();
      close();
      window.itermRenderDashboard?.();
      onDone?.();
    } catch (err) {
      errorBox.textContent = String(err);
    }
  });

  document.body.appendChild(overlay);
}

// ============================================
// Styles
// ============================================

function addTaskStyles() {
  if (document.getElementById('tasks-styles')) return;
  const style = document.createElement('style');
  style.id = 'tasks-styles';
  style.textContent = `
    .project-tasks-badge {
      display: inline-flex; align-items: center; gap: 3px; flex-shrink: 0;
      padding: 1px 6px; border-radius: 8px; font-size: 10px; font-weight: 600;
      background: rgba(99,102,241,0.18); color: #a5b4fc; cursor: pointer;
    }
    .project-tasks-badge:hover { background: rgba(99,102,241,0.35); color: #c7d2fe; }
    .project-tasks-badge.empty { background: rgba(255,255,255,0.06); color: #64748b; }

    .tasks-popup-overlay {
      position: fixed; inset: 0; z-index: 10000; display: flex;
      align-items: flex-start; justify-content: center; padding-top: 12vh;
      background: rgba(0,0,0,0.55);
    }
    .tasks-popup {
      width: 560px; max-width: 92vw; max-height: 70vh; display: flex; flex-direction: column;
      background: #1e293b; border: 1px solid #334155; border-radius: 10px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.5); overflow: hidden;
    }
    .tasks-popup-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 12px 16px; border-bottom: 1px solid #334155;
    }
    .tasks-popup-title { font-size: 14px; font-weight: 600; color: #f1f5f9; }
    .tasks-popup-close {
      background: transparent; border: none; color: #94a3b8; font-size: 20px;
      line-height: 1; cursor: pointer; padding: 0 4px;
    }
    .tasks-popup-close:hover { color: #f1f5f9; }
    .tasks-popup-toolbar { display: flex; gap: 8px; padding: 10px 16px; border-bottom: 1px solid #273449; }
    .tasks-popup-search {
      flex: 1; padding: 7px 10px; background: #0f172a; border: 1px solid #334155;
      border-radius: 6px; color: #f1f5f9; font-size: 12px;
    }
    .tasks-popup-search:focus { outline: none; border-color: #6366f1; }
    .tasks-popup-new {
      padding: 7px 12px; border-radius: 6px; border: 1px solid #4f46e5;
      background: #4f46e5; color: #fff; font-size: 12px; cursor: pointer; white-space: nowrap;
    }
    .tasks-popup-new:hover { background: #4338ca; }
    .tasks-popup-list { overflow-y: auto; padding: 6px; }
    .tasks-popup-empty { padding: 28px 16px; text-align: center; color: #64748b; font-size: 12px; line-height: 1.5; }

    .task-row {
      display: flex; align-items: center; gap: 8px; padding: 8px 10px;
      border-radius: 6px; cursor: pointer; font-size: 12px; color: #e2e8f0;
    }
    .task-row:hover { background: rgba(255,255,255,0.05); }
    .task-row.done { opacity: 0.5; }
    .task-status-dot {
      width: 10px; height: 10px; border-radius: 50%; border: none; padding: 0;
      cursor: pointer; flex-shrink: 0;
    }
    .task-status-dot.active { background: #4ade80; box-shadow: 0 0 6px rgba(74,222,128,0.6); }
    .task-status-dot.blocked { background: #fbbf24; }
    .task-status-dot.done { background: #64748b; }
    .task-jira-key {
      flex-shrink: 0; padding: 1px 6px; border-radius: 4px; font-size: 10px; font-weight: 700;
      background: rgba(56,132,255,0.18); color: #7ab4ff; font-family: ui-monospace, monospace;
    }
    .task-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .task-branch {
      flex-shrink: 0; font-size: 10px; color: #64748b; font-family: ui-monospace, monospace;
      max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .task-resume-hint { flex-shrink: 0; color: #818cf8; font-size: 11px; }
    .task-repos-count {
      flex-shrink: 0; padding: 1px 6px; border-radius: 4px; font-size: 10px; font-weight: 600;
      background: rgba(168,85,247,0.18); color: #c084fc;
    }
    .tasks-repos-hint { font-weight: 400; color: #64748b; }
    .tasks-repos-list {
      display: flex; flex-direction: column; gap: 6px; max-height: 160px; overflow-y: auto;
      padding: 8px 10px; background: #0f172a; border: 1px solid #334155; border-radius: 6px;
    }
    .task-delete-btn {
      flex-shrink: 0; background: transparent; border: none; color: #475569;
      font-size: 12px; cursor: pointer; padding: 2px 4px; border-radius: 4px;
    }
    .task-delete-btn:hover { color: #f87171; background: rgba(248,113,113,0.1); }

    .tasks-popup-form { width: 460px; }
    .tasks-popup-body { padding: 14px 16px; display: flex; flex-direction: column; gap: 6px; }
    .tasks-form-label {
      font-size: 11px; font-weight: 600; color: #94a3b8; margin-top: 6px;
      display: flex; align-items: center; gap: 8px;
    }
    .tasks-form-input {
      padding: 8px 10px; background: #0f172a; border: 1px solid #334155;
      border-radius: 6px; color: #f1f5f9; font-size: 12px;
    }
    .tasks-form-input:focus { outline: none; border-color: #6366f1; }
    .tasks-jira-status { font-weight: 500; font-size: 10px; color: #94a3b8; }
    .tasks-jira-status.ok { color: #4ade80; }
    .tasks-jira-status.err { color: #f87171; }
    .tasks-form-error { color: #f87171; font-size: 11px; min-height: 14px; margin-top: 4px; }
    .tasks-form-check { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #cbd5e1; cursor: pointer; }
    .tasks-form-check code, .tasks-delete-info code {
      background: #0f172a; padding: 1px 5px; border-radius: 4px; font-size: 10px; color: #a5b4fc;
      word-break: break-all;
    }
    .tasks-delete-info { font-size: 12px; color: #cbd5e1; line-height: 1.6; margin: 0 0 8px; }
    .tasks-popup-actions {
      display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px;
      border-top: 1px solid #334155;
    }
    .tasks-popup-cancel {
      padding: 7px 14px; border-radius: 6px; border: 1px solid #334155;
      background: transparent; color: #cbd5e1; font-size: 12px; cursor: pointer;
    }
    .tasks-popup-create {
      padding: 7px 14px; border-radius: 6px; border: 1px solid #4f46e5;
      background: #4f46e5; color: #fff; font-size: 12px; cursor: pointer;
    }
    .tasks-popup-create:hover:not(:disabled) { background: #4338ca; }
    .tasks-popup-create:disabled { opacity: 0.6; cursor: default; }
    .tasks-popup-create.danger { background: #dc2626; border-color: #dc2626; }
    .tasks-popup-create.danger:hover { background: #b91c1c; }

    .git-repo-switcher {
      margin-right: 8px; padding: 2px 4px; background: #0f172a; border: 1px solid #334155;
      border-radius: 4px; color: #e2e8f0; font-size: 10px; max-width: 140px;
    }
  `;
  document.head.appendChild(style);
}
