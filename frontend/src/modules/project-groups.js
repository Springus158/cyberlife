// Project groups - collapsible sidebar groups for projects

import { state } from './state.js';
import { escapeHtml } from './utils.js';
import { renderTabbedIconPicker, getPickedIcon } from './icon-catalog.js';
import {
  CreateProjectGroup, UpdateProjectGroup, DeleteProjectGroup,
} from '../../wailsjs/go/main/App';

let editingGroupId = null;

export function renderGroupModals() {
  return `
    <!-- Add Choice Modal (Project or Group) -->
    <div id="addChoiceModal" class="modal hidden">
      <div class="modal-content add-choice-content">
        <h2>What do you want to add?</h2>
        <div class="add-choice-buttons">
          <button type="button" class="add-choice-btn" id="addChoiceProject">
            <span class="add-choice-icon">📁</span>
            <span class="add-choice-label">Project</span>
          </button>
          <button type="button" class="add-choice-btn" id="addChoiceGroup">
            <span class="add-choice-icon">🗂️</span>
            <span class="add-choice-label">Group</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Add/Edit Group Modal -->
    <div id="groupModal" class="modal hidden">
      <div class="modal-content">
        <h2 id="groupModalTitle">Add Group</h2>
        <form id="groupForm">
          <div class="form-group">
            <label>Name</label>
            <input type="text" id="groupName" required placeholder="My Group">
          </div>
          <div class="form-group">
            <label>Icon</label>
            <div id="groupIconPicker" class="icon-picker"></div>
          </div>
          <div class="form-group">
            <label>Color <span class="form-hint">shown as the accent on every project in this group</span></label>
            <div id="groupColorPicker" class="color-picker"></div>
          </div>
          <div class="form-actions">
            <button type="button" id="cancelGroupModal" class="secondary-btn">Cancel</button>
            <button type="submit" class="primary-btn" id="groupModalSubmit">Add Group</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

export function buildGroupOptions(selectedGroupId) {
  const options = (state.projectGroups || []).map(g => `
    <option value="${escapeHtml(g.id)}" ${g.id === selectedGroupId ? 'selected' : ''}>${g.icon ? escapeHtml(g.icon) + ' ' : ''}${escapeHtml(g.name)}</option>
  `).join('');
  return `<option value="">No group</option>${options}`;
}

function renderGroupIconPicker(selectedIcon) {
  renderTabbedIconPicker(document.getElementById('groupIconPicker'), selectedIcon);
}

function renderGroupColorPicker(selectedColor) {
  const host = document.getElementById('groupColorPicker');
  if (!host) return;
  host.innerHTML = (state.colors || []).map(c => `
    <div class="color-option ${c === selectedColor ? 'selected' : ''}" data-color="${c}" style="background:${c}"></div>
  `).join('');
  host.querySelectorAll('.color-option').forEach(opt => {
    opt.addEventListener('click', () => {
      host.querySelectorAll('.color-option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
    });
  });
}

function pickedGroupColor() {
  return document.querySelector('#groupColorPicker .color-option.selected')?.dataset.color || '';
}

export function openAddChoiceModal() {
  document.getElementById('addChoiceModal')?.classList.remove('hidden');
}

// Groups manager: list with edit/delete + create, opened from Projects
export function openGroupsManager() {
  document.getElementById('groupsManagerModal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'groupsManagerModal';
  modal.className = 'modal';
  document.body.appendChild(modal);

  const close = () => modal.remove();
  const rerender = () => {
    const groups = state.projectGroups || [];
    const countOf = (g) => (state.projects || []).filter(p => p.groupId === g.id).length;
    modal.innerHTML = `
      <div class="modal-content groups-manager-modal">
        <h2>Groups</h2>
        <div class="settings-widget-list">
          ${groups.length ? groups.map(g => `
            <div class="settings-widget-row" data-group="${g.id}">
              <span class="groups-manager-swatch" style="background:${g.color || 'var(--border)'}"></span>
              <span class="settings-widget-name">${g.icon ? escapeHtml(g.icon) + ' ' : ''}${escapeHtml(g.name)}</span>
              <span class="board-chip">${countOf(g)} projects</span>
              <span class="fc-spacer"></span>
              <button class="fc-btn fc-btn-secondary fc-btn-sm" data-act="edit">Edit</button>
              <button class="fc-btn fc-btn-danger fc-btn-sm" data-act="delete">×</button>
            </div>
          `).join('') : '<div class="settings-prompt-empty">No groups yet</div>'}
        </div>
        <div class="fc-actions">
          <button type="button" class="fc-btn fc-btn-primary" id="gmNew">+ New group</button>
          <span class="fc-spacer"></span>
          <button type="button" class="fc-btn fc-btn-secondary" id="gmClose">Close</button>
        </div>
      </div>
    `;
    modal.querySelector('#gmClose').addEventListener('click', close);
    modal.querySelector('#gmNew').addEventListener('click', () => {
      close();
      openGroupModal();
    });
    modal.querySelectorAll('.settings-widget-row').forEach(row => {
      row.addEventListener('click', async (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (!act) return;
        const group = (state.projectGroups || []).find(g => g.id === row.dataset.group);
        if (!group) return;
        if (act === 'edit') {
          close();
          openGroupModal(group.id);
        }
        if (act === 'delete') {
          if (!confirm(`Delete group "${group.name}"? Projects keep working, just lose the tag.`)) return;
          try {
            await deleteGroup(group.id);
            rerender();
            window.itermRefreshDashboard?.();
            import('./projects-module.js').then(({ renderProjectsPanel }) => renderProjectsPanel())
              .catch((err) => { console.warn('projects rerender failed:', err); });
          } catch (err) {
            console.error('Group delete failed:', err);
          }
        }
      });
    });
  };

  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modal.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
  });
  rerender();
}

export function openGroupModal(groupId = null) {
  const modal = document.getElementById('groupModal');
  if (!modal) return;

  editingGroupId = groupId;
  const group = groupId ? (state.projectGroups || []).find(g => g.id === groupId) : null;

  document.getElementById('groupModalTitle').textContent = group ? 'Edit Group' : 'Add Group';
  document.getElementById('groupModalSubmit').textContent = group ? 'Save' : 'Add Group';
  document.getElementById('groupName').value = group?.name || '';
  renderGroupIconPicker(group?.icon || '');
  renderGroupColorPicker(group?.color || '');

  modal.classList.remove('hidden');
}

export function setupGroupModals(onGroupsChanged) {
  const choiceModal = document.getElementById('addChoiceModal');
  const groupModal = document.getElementById('groupModal');
  const groupForm = document.getElementById('groupForm');
  if (!choiceModal || !groupModal || !groupForm) return;

  document.getElementById('addChoiceProject')?.addEventListener('click', () => {
    choiceModal.classList.add('hidden');
    window.openAddProjectModal();
  });

  document.getElementById('addChoiceGroup')?.addEventListener('click', () => {
    choiceModal.classList.add('hidden');
    openGroupModal();
  });

  document.getElementById('cancelGroupModal')?.addEventListener('click', () => {
    groupModal.classList.add('hidden');
  });

  [choiceModal, groupModal].forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.add('hidden');
    });
  });

  groupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('groupName').value.trim();
    if (!name) return;
    const icon = getPickedIcon('groupIconPicker');
    const color = pickedGroupColor();

    try {
      if (editingGroupId) {
        const group = (state.projectGroups || []).find(g => g.id === editingGroupId);
        if (group) {
          group.name = name;
          group.icon = icon;
          group.color = color;
          await UpdateProjectGroup(group);
        }
      } else {
        const group = await CreateProjectGroup(name, icon, color);
        state.projectGroups.push(group);
      }
      groupModal.classList.add('hidden');
      groupForm.reset();
      onGroupsChanged?.();
    } catch (err) {
      alert('Error saving group: ' + err);
    }
  });
}

export async function toggleGroupCollapsed(groupId) {
  const group = (state.projectGroups || []).find(g => g.id === groupId);
  if (!group) return;
  group.collapsed = !group.collapsed;
  try {
    await UpdateProjectGroup(group);
  } catch (err) {
    console.error('Failed to persist group collapse state:', err);
  }
}

export async function deleteGroup(groupId) {
  await DeleteProjectGroup(groupId);
  const idx = (state.projectGroups || []).findIndex(g => g.id === groupId);
  if (idx >= 0) state.projectGroups.splice(idx, 1);
  (state.projects || []).forEach(p => {
    if (p.groupId === groupId) p.groupId = '';
  });
}
