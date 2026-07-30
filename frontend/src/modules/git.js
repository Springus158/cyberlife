import { state, getActiveRepoPath } from './state.js';
import {
  IsGitRepo,
  GetGitChangedFiles,
  GetGitCurrentBranch
} from '../../wailsjs/go/main/App';
import { registerStateHandler } from './project-switcher.js';

// Callback for showing diff
let onShowGitDiff = null;

export function setGitCallbacks(callbacks) {
  onShowGitDiff = callbacks.showGitDiff;
}

export function setupGitSection() {
  const header = document.getElementById('gitHeader');
  const refreshBtn = document.getElementById('refreshGit');
  const refreshDiffBtn = document.getElementById('refreshDiff');

  if (header) {
    header.addEventListener('click', (e) => {
      if (e.target.id === 'refreshGit' || e.target.closest('#refreshGit')) return;
      toggleGitSection();
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      refreshGitStatus();
    });
  }

  if (refreshDiffBtn) {
    refreshDiffBtn.addEventListener('click', () => {
      if (state.git.currentDiffFile && onShowGitDiff) {
        onShowGitDiff(state.git.currentDiffFile);
      }
    });
  }
}

export function toggleGitSection() {
  state.git.expanded = !state.git.expanded;
  const content = document.getElementById('gitContent');
  const toggle = document.querySelector('.git-toggle');

  if (content && toggle) {
    if (state.git.expanded) {
      content.classList.remove('collapsed');
      toggle.textContent = '▼';
      if (state.activeProject) {
        refreshGitStatus();
      }
    } else {
      content.classList.add('collapsed');
      toggle.textContent = '▶';
    }
  }
}

export async function refreshGitStatus() {
  if (!state.activeProject) {
    state.git.isRepo = false;
    state.git.changedFiles = [];
    state.git.branch = '';
    renderGitFileList();
    return;
  }

  const path = getActiveRepoPath();

  try {
    state.git.isRepo = await IsGitRepo(path);

    if (state.git.isRepo) {
      state.git.branch = await GetGitCurrentBranch(path);
      state.git.changedFiles = await GetGitChangedFiles(path) || [];
    } else {
      state.git.branch = '';
      state.git.changedFiles = [];
    }
  } catch (err) {
    console.error('Failed to get git status:', err);
    state.git.isRepo = false;
    state.git.changedFiles = [];
    state.git.branch = '';
  }

  renderGitFileList();
  updateGitDisplay();
  repaintInlinePanels();
}

export function updateGitDisplay() {
  const statsEl = document.getElementById('gitStats');
  const branchBar = document.getElementById('gitBranchBar');

  if (!state.git.isRepo) {
    if (statsEl) statsEl.innerHTML = '<span class="git-no-repo-badge">No repo</span>';
    if (branchBar) branchBar.innerHTML = '';
    return;
  }

  const staged = state.git.changedFiles.filter(f => f.staged).length;
  const modified = state.git.changedFiles.filter(f => !f.staged && f.status !== '?').length;
  const untracked = state.git.changedFiles.filter(f => f.status === '?').length;
  const total = state.git.changedFiles.length;

  if (statsEl) {
    if (total === 0) {
      statsEl.innerHTML = '<span class="git-clean-badge">✓</span>';
    } else {
      let badges = '';
      if (staged > 0) badges += `<span class="git-badge staged">${staged}</span>`;
      if (modified > 0) badges += `<span class="git-badge modified">${modified}</span>`;
      if (untracked > 0) badges += `<span class="git-badge untracked">${untracked}</span>`;
      statsEl.innerHTML = badges;
    }
  }

  if (branchBar) {
    const repos = state.activeTaskRepos || [];
    const repoSwitcher = repos.length > 1 ? `
      <select class="git-repo-switcher" id="gitRepoSwitcher">
        ${repos.map(r => `<option value="${r.worktreePath}" ${r.worktreePath === state.activeTaskPath ? 'selected' : ''}>${r.repoName}</option>`).join('')}
      </select>` : '';
    if (state.git.branch || repoSwitcher) {
      branchBar.innerHTML = `${repoSwitcher}<span class="git-branch-icon">⎇</span> ${state.git.branch || ''}`;
    } else {
      branchBar.innerHTML = '';
    }
    document.getElementById('gitRepoSwitcher')?.addEventListener('change', (e) => {
      state.activeTaskPath = e.target.value;
      refreshGitStatus();
    });
  }
}

export function renderGitFileList() {
  const container = document.getElementById('gitFileList');
  if (!container) return;

  if (!state.git.isRepo) {
    container.innerHTML = '<p class="git-no-repo">Not a git repository</p>';
    return;
  }

  if (state.git.changedFiles.length === 0) {
    container.innerHTML = '<p class="git-no-changes">No changes</p>';
    return;
  }

  const stagedFiles = state.git.changedFiles.filter(f => f.staged);
  const unstagedFiles = state.git.changedFiles.filter(f => !f.staged && f.status !== '?');
  const untrackedFiles = state.git.changedFiles.filter(f => f.status === '?');

  let html = '';

  if (stagedFiles.length > 0) {
    html += '<div class="git-file-group"><div class="git-group-header">Staged Changes</div>';
    html += stagedFiles.map(f => renderGitFileItem(f)).join('');
    html += '</div>';
  }

  if (unstagedFiles.length > 0) {
    html += '<div class="git-file-group"><div class="git-group-header">Changes</div>';
    html += unstagedFiles.map(f => renderGitFileItem(f)).join('');
    html += '</div>';
  }

  if (untrackedFiles.length > 0) {
    html += '<div class="git-file-group"><div class="git-group-header">Untracked</div>';
    html += untrackedFiles.map(f => renderGitFileItem(f)).join('');
    html += '</div>';
  }

  container.innerHTML = html;

  container.querySelectorAll('.git-file-item').forEach(item => {
    item.addEventListener('click', () => {
      if (onShowGitDiff) {
        onShowGitDiff(item.dataset.path);
      }
    });
  });
}

function renderGitFileItem(file) {
  const statusIcon = getStatusIcon(file.status);
  const fileName = file.path.split('/').pop();
  const dirPath = file.path.includes('/') ? file.path.substring(0, file.path.lastIndexOf('/')) + '/' : '';

  return `
    <div class="git-file-item" data-path="${file.path}" title="${file.path}">
      <span class="git-status ${getStatusClass(file.status)}">${statusIcon}</span>
      <span class="git-file-name">${fileName}</span>
      <span class="git-file-dir">${dirPath}</span>
    </div>
  `;
}

function getStatusIcon(status) {
  switch (status) {
    case 'M': return 'M';
    case 'A': return 'A';
    case 'D': return 'D';
    case 'R': return 'R';
    case '?': return 'U';
    default: return status;
  }
}

function getStatusClass(status) {
  switch (status) {
    case 'M': return 'modified';
    case 'A': return 'added';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    case '?': return 'untracked';
    default: return '';
  }
}

// ============================================
// Inline git panels (instance-safe)
// ============================================

// Containers registered here repaint on every status refresh — used by the
// Files module's always-present diff panel (the sidebar widget keeps its own
// legacy fixed-id rendering above)
const inlinePanels = new Set();

export function attachGitPanel(container) {
  if (!container) return;
  inlinePanels.add(container);
  renderInlinePanel(container);
  refreshGitStatus();
}

function repaintInlinePanels() {
  for (const c of [...inlinePanels]) {
    if (!c.isConnected) {
      inlinePanels.delete(c);
      continue;
    }
    renderInlinePanel(c);
  }
}

function renderInlinePanel(container) {
  if (!state.git.isRepo) {
    container.innerHTML = `
      <div class="git-inline-header"><span class="git-inline-title">Git</span>
      <span class="git-no-repo-badge">No repo</span></div>
    `;
    return;
  }
  const files = state.git.changedFiles || [];
  const groups = [
    ['Staged', files.filter(f => f.staged)],
    ['Changes', files.filter(f => !f.staged && f.status !== '?')],
    ['Untracked', files.filter(f => f.status === '?')],
  ].filter(([, list]) => list.length > 0);

  container.innerHTML = `
    <div class="git-inline-header">
      <span class="git-inline-title">Git</span>
      <span class="git-inline-branch">⎇ ${state.git.branch || ''}</span>
      <span class="git-inline-count">${files.length ? files.length : '✓'}</span>
      <button class="small-btn git-inline-refresh" title="Refresh">↻</button>
    </div>
    <div class="git-inline-files">
      ${files.length === 0 ? '<p class="git-no-changes">No changes</p>' : groups.map(([label, list]) => `
        <div class="git-file-group">
          <div class="git-group-header">${label}</div>
          ${list.map(f => renderGitFileItem(f)).join('')}
        </div>
      `).join('')}
    </div>
  `;
  container.querySelector('.git-inline-refresh')?.addEventListener('click', () => refreshGitStatus());
  container.querySelectorAll('.git-file-item').forEach(item => {
    item.addEventListener('click', () => {
      if (onShowGitDiff) onShowGitDiff(item.dataset.path);
    });
  });
}

// ============================================
// Project Switcher Handler
// ============================================

/**
 * Initialize git handler for project switching
 * Call this during app initialization
 */
export function initGitHandler() {
  registerStateHandler('git', {
    priority: 100,

    onBeforeSwitch: async (ctx) => {
      // Nothing to cleanup for git
    },

    onSave: async (ctx) => {
      // Git status is fetched fresh each time
    },

    onLoad: async (ctx) => {
      // Git status will be refreshed in onAfterSwitch
    },

    onAfterSwitch: async (ctx) => {
      // Always refresh git status after project switch
      await refreshGitStatus();
    }
  });
}
