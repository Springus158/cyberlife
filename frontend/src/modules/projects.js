// Projects module - workspace info and project management

import { state } from './state.js';
import { UpdateProject, SelectDirectory, GetRunners, GetDefaultRunner } from '../../wailsjs/go/main/App';
import { switchProject } from './project-switcher.js';
import { renderITermPanel, focusProjectTab } from './iterm-panel.js';
import { refreshGitStatus } from './git.js';
import { loadClaudeAccounts, buildAccountOptions, attachAccountSelect, findAccountByConfigDir } from './claude-accounts.js';
import { buildGroupOptions } from './project-groups.js';
import { renderTabbedIconPicker, getPickedIcon } from './icon-catalog.js';
import { escapeHtml, escapeAttr } from './utils.js';

async function fillProjectRunnerSelect(select, selectedId) {
  if (!select) return;
  let runners = [];
  let globalId = '';
  try {
    runners = await GetRunners() || [];
  } catch (err) {
    console.warn('Failed to load runners:', err);
  }
  try {
    globalId = await GetDefaultRunner() || '';
  } catch (err) {
    console.warn('Failed to load default runner:', err);
  }
  const global = runners.find(r => r.id === (globalId || 'claude')) || runners[0];
  const globalLabel = global ? `${global.icon || ''} ${global.name}`.trim() : 'Claude';
  const options = [`<option value="">Use global default (${escapeHtml(globalLabel)})</option>`];
  for (const r of runners) {
    options.push(`<option value="${escapeAttr(r.id)}" ${r.id === selectedId ? 'selected' : ''}>${r.icon || ''} ${escapeHtml(r.name)}</option>`);
  }
  select.innerHTML = options.join('');
}

// Open edit project modal
export async function openEditProjectModal() {
  if (!state.activeProject) return;

  const modal = document.getElementById('editProjectModal');
  const nameInput = document.getElementById('editProjectName');
  const pathInput = document.getElementById('editProjectPath');

  if (!modal || !nameInput || !pathInput) return;

  // Fill form with current values
  nameInput.value = state.activeProject.name;
  pathInput.value = state.activeProject.path;

  await loadClaudeAccounts();
  const claudeConfigInput = document.getElementById('editClaudeConfigDir');
  if (claudeConfigInput) {
    claudeConfigInput.innerHTML = buildAccountOptions(state.activeProject.claudeConfigDir || '');
    attachAccountSelect(claudeConfigInput);
  }
  await fillProjectRunnerSelect(document.getElementById('editDefaultRunner'), state.activeProject.defaultRunner || '');

  const groupSelect = document.getElementById('editProjectGroup');
  if (groupSelect) {
    groupSelect.innerHTML = buildGroupOptions(state.activeProject.groupId || '');
  }

  // Render color picker
  renderEditColorPicker(state.activeProject.color);

  // Render icon picker
  renderEditIconPicker(state.activeProject.icon);

  modal.classList.remove('hidden');
}

// Render color picker for edit modal
function renderEditColorPicker(selectedColor) {
  const container = document.getElementById('editColorPicker');
  if (!container) return;

  container.innerHTML = state.colors.map(color => `
    <div class="color-option ${color === selectedColor ? 'selected' : ''}"
         data-color="${color}"
         style="background-color: ${color}"></div>
  `).join('');

  container.querySelectorAll('.color-option').forEach(opt => {
    opt.addEventListener('click', () => {
      container.querySelectorAll('.color-option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
    });
  });
}

// Render icon picker for edit modal
function renderEditIconPicker(selectedIcon) {
  renderTabbedIconPicker(document.getElementById('editIconPicker'), selectedIcon);
}

// Setup edit project modal event listeners
export function setupEditProjectModal() {
  const modal = document.getElementById('editProjectModal');
  const form = document.getElementById('editProjectForm');
  const cancelBtn = document.getElementById('cancelEditProject');
  const browseBtn = document.getElementById('editBrowseBtn');

  if (!modal || !form) return;

  // Cancel button
  cancelBtn?.addEventListener('click', () => {
    modal.classList.add('hidden');
  });

  // Close on outside click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.classList.add('hidden');
    }
  });

  // Browse button
  browseBtn?.addEventListener('click', async () => {
    const path = await SelectDirectory();
    if (path) {
      document.getElementById('editProjectPath').value = path;
    }
  });

  // Form submit
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.activeProject) return;

    const name = document.getElementById('editProjectName').value;
    const path = document.getElementById('editProjectPath').value;
    const claudeConfigDir = document.getElementById('editClaudeConfigDir')?.value?.trim() || '';
    const defaultRunner = document.getElementById('editDefaultRunner')?.value || '';
    const groupId = document.getElementById('editProjectGroup')?.value || '';
    const colorEl = document.querySelector('#editColorPicker .color-option.selected');

    const color = colorEl?.dataset.color || state.activeProject.color;
    const icon = getPickedIcon('editIconPicker') || state.activeProject.icon;

    try {
      const updatedProject = {
        ...state.activeProject,
        name,
        path,
        color,
        icon,
        claudeConfigDir,
        defaultRunner,
        groupId
      };

      await UpdateProject(updatedProject);

      // Update local state
      state.activeProject.name = name;
      state.activeProject.path = path;
      state.activeProject.color = color;
      state.activeProject.icon = icon;
      state.activeProject.claudeConfigDir = claudeConfigDir;
      state.activeProject.defaultRunner = defaultRunner;
      state.activeProject.groupId = groupId;

      // Update in projects array
      const idx = state.projects.findIndex(p => p.id === state.activeProject.id);
      if (idx >= 0) {
        state.projects[idx] = { ...state.activeProject };
      }

      // Update UI. The projects-changed event fires too, but it can arrive
      // before the lines above land, so redraw once local state is current.
      updateWorkspaceInfo();
      import('./terminal-dashboard.js').then(m => m.renderTerminalDashboard())
        .catch((err) => console.error('dashboard redraw after project edit failed:', err));
      import('./projects-module.js').then(m => m.renderProjectsPanel())
        .catch((err) => console.error('projects redraw after project edit failed:', err));

      // Refresh git status for new path
      refreshGitStatus();

      // Close modal
      modal.classList.add('hidden');
    } catch (err) {
      console.error('Project update failed:', err);
      alert('Error updating project: ' + err);
    }
  });
}

// Select a project
export async function selectProject(id) {
  if (state.activeProject?.id === id) return;

  // Use the centralized project switcher
  const success = await switchProject(id);

  if (success) {
    updateWorkspaceInfo();

    // Update iTerm panel for new project and focus its tab
    renderITermPanel();
    focusProjectTab();
  }
}

function classifyAccount(name, dir) {
  const haystack = `${name} ${dir}`.toLowerCase();
  if (/enterprise|work|company|firm|biz|corp/.test(haystack)) return 'enterprise';
  if (!dir || /personal|max|private|priv/.test(haystack)) return 'personal';
  return 'custom';
}

// Derive a Claude account badge from a project's CLAUDE_CONFIG_DIR
export function getAccountBadge(claudeConfigDir) {
  const dir = (claudeConfigDir || '').trim();
  const account = findAccountByConfigDir(dir);
  const label = account?.name || (dir ? (dir.replace(/\/+$/, '').split('/').pop() || dir) : 'Personal · Max');
  const title = dir ? `CLAUDE_CONFIG_DIR=${dir}` : 'Default account (~/.claude)';
  return { kind: classifyAccount(label, dir), label, title };
}

// Update workspace info in sidebar
export function updateWorkspaceInfo() {
  const container = document.getElementById('workspaceInfo');
  if (!container) return;

  if (state.activeProject) {
    const account = getAccountBadge(state.activeProject.claudeConfigDir);
    container.innerHTML = `
      <div class="project-info" title="Double-click to edit">
        <div class="project-header">
          <span class="icon" style="color: ${state.activeProject.color}">${state.activeProject.icon}</span>
          <span class="name">${state.activeProject.name}</span>
          <span class="account-badge account-${account.kind}" title="${account.title}">${account.label}</span>
        </div>
        <p class="path">${state.activeProject.path}</p>
      </div>
    `;

    // Add double-click handler to open edit modal
    const projectInfo = container.querySelector('.project-info');
    if (projectInfo) {
      projectInfo.style.cursor = 'pointer';
      projectInfo.addEventListener('dblclick', openEditProjectModal);
    }
  } else {
    container.innerHTML = `<p class="no-project">No project selected</p>`;
  }
}
