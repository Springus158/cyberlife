// Notes module - project notes as a tab panel with auto-save

import { escapeHtml } from './utils.js';
import { state } from './state.js';
import { registerStateHandler } from './project-switcher.js';

// Tab ID for Notes
export const NOTES_TAB_ID = 'notes-tab';

// Callbacks set by main.js
let notesCallbacks = {
  saveNotes: () => {},
  getNotes: () => '',
  insertToTerminal: () => {}
};

export function setNotesCallbacks(callbacks) {
  notesCallbacks = { ...notesCallbacks, ...callbacks };
}

// Auto-save timer
let saveTimer = null;

// Show/hide notes panel
export function showNotesPanel(show) {
  const panel = document.getElementById('notesPanel');
  if (panel) {
    panel.style.display = show ? 'flex' : 'none';
  }
  // Auto-save when hiding
  if (!show) flushSave();
}

// Flush pending save immediately
function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    doSave();
  }
}

// Perform save
async function doSave() {
  if (!state.activeProject) return;
  const textarea = document.getElementById('notesTextarea');
  if (!textarea) return;

  const notes = textarea.value;
  if (notes === state.activeProject.notes) return;

  try {
    await notesCallbacks.saveNotes(state.activeProject.id, notes);
    state.activeProject.notes = notes;
    updateSaveIndicator('saved');
  } catch (err) {
    console.error('Failed to save notes:', err);
    updateSaveIndicator('error');
  }
}

// Schedule auto-save (debounced)
function scheduleSave() {
  updateSaveIndicator('saving');
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    doSave();
  }, 800);
}

// Update save indicator
function updateSaveIndicator(status) {
  const indicator = document.getElementById('notesSaveIndicator');
  if (!indicator) return;
  if (status === 'saving') {
    indicator.textContent = 'Saving...';
    indicator.className = 'notes-save-indicator saving';
  } else if (status === 'saved') {
    indicator.textContent = 'Saved';
    indicator.className = 'notes-save-indicator saved';
    setTimeout(() => {
      if (indicator.textContent === 'Saved') {
        indicator.textContent = '';
        indicator.className = 'notes-save-indicator';
      }
    }, 2000);
  } else if (status === 'error') {
    indicator.textContent = 'Save failed';
    indicator.className = 'notes-save-indicator error';
  }
}

// Render notes panel content
export function renderNotesPanel() {
  const panel = document.getElementById('notesPanel');
  if (!panel) return;

  const notes = state.activeProject?.notes || '';

  panel.innerHTML = `
    <div class="notes-panel-content">
      <div class="notes-panel-header">
        <span class="notes-panel-title">📝 Notes</span>
        <span class="notes-save-indicator" id="notesSaveIndicator"></span>
        <div class="notes-panel-actions">
          <button class="notes-panel-btn" id="notesCopyBtn" title="Copy to clipboard">📋</button>
          <button class="notes-panel-btn" id="notesInsertBtn" title="Insert to terminal">⤴</button>
          <button class="notes-panel-btn notes-close-btn" id="notesCloseBtn" title="Close Notes">&times;</button>
        </div>
      </div>
      <textarea id="notesTextarea" class="notes-panel-textarea" placeholder="Write your project notes here... (Markdown supported)">${escapeHtml(notes)}</textarea>
    </div>
  `;

  // Event listeners
  const textarea = document.getElementById('notesTextarea');
  textarea?.addEventListener('input', scheduleSave);
  textarea?.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      flushSave();
    }
  });

  document.getElementById('notesCopyBtn')?.addEventListener('click', copyNotes);
  document.getElementById('notesInsertBtn')?.addEventListener('click', insertNotesToTerminal);
  document.getElementById('notesCloseBtn')?.addEventListener('click', () => {
    flushSave();
    import('./module-host.js').then(({ switchToDashboardTab }) => switchToDashboardTab());
  });
}

// Render notes section in sidebar (compact preview + open tab link)
export function renderNotesSection() {
  const notesSection = document.getElementById('notesSection');
  if (!notesSection) return;

  const notes = state.activeProject?.notes || '';
  const hasNotes = notes && notes.trim().length > 0;
  const preview = hasNotes ? notes.split('\n')[0].substring(0, 50) : 'No notes yet';

  notesSection.innerHTML = `
    <div class="notes-header" id="notesHeader">
      <span class="notes-toggle">${state.notesExpanded ? '▼' : '▶'}</span>
      <h3>📝 Notes</h3>
    </div>
    <div id="notesContent" class="notes-content ${state.notesExpanded ? '' : 'collapsed'}">
      <div class="notes-preview ${hasNotes ? '' : 'empty'}" id="notesPreview">${hasNotes ? escapeHtml(preview) + (notes.length > 50 ? '...' : '') : 'Click to add notes...'}</div>
      <div class="notes-actions">
        <button class="small-btn notes-edit-btn" id="editNotesBtn">Open</button>
        ${hasNotes ? '<button class="small-btn notes-copy-btn" id="copyNotesBtn">Copy</button>' : ''}
      </div>
    </div>
  `;

  setupNotesEventListeners();
}

function setupNotesEventListeners() {
  const notesHeader = document.getElementById('notesHeader');
  const editNotesBtn = document.getElementById('editNotesBtn');
  const copyNotesBtn = document.getElementById('copyNotesBtn');
  const notesPreview = document.getElementById('notesPreview');

  notesHeader?.addEventListener('click', toggleNotesSection);
  editNotesBtn?.addEventListener('click', openNotesTab);
  copyNotesBtn?.addEventListener('click', copyNotes);
  notesPreview?.addEventListener('click', openNotesTab);
}

// Open notes as a tab
function openNotesTab() {
  // Import dynamically to avoid circular dependency
  import('./module-host.js').then(({ switchToNotesTab }) => {
    switchToNotesTab();
  });
}

// Toggle notes section expand/collapse
export function toggleNotesSection() {
  state.notesExpanded = !state.notesExpanded;
  const content = document.getElementById('notesContent');
  const toggle = document.querySelector('.notes-toggle');
  if (content) content.classList.toggle('collapsed', !state.notesExpanded);
  if (toggle) toggle.textContent = state.notesExpanded ? '▼' : '▶';
}

// Copy notes to clipboard
async function copyNotes() {
  if (!state.activeProject?.notes) return;
  try {
    await navigator.clipboard.writeText(state.activeProject.notes);
    showNotesToast('Notes copied to clipboard');
  } catch (err) {
    console.error('Failed to copy notes:', err);
  }
}

// Insert notes to active terminal
function insertNotesToTerminal() {
  if (!state.activeProject?.notes) return;
  notesCallbacks.insertToTerminal(state.activeProject.notes);
  showNotesToast('Notes inserted to terminal');
}

// Show toast notification
function showNotesToast(message) {
  const toast = document.createElement('div');
  toast.className = 'notes-toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.classList.add('show'), 10);
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 2000);
}


// Stubs for backward compat (modal removed)
export function renderNotesModal() { return ''; }
export function setupNotesModal() {}
export function openNotesEditor() { openNotesTab(); }
export function closeNotesEditor() {}

// ============================================
// Project Switcher Handler
// ============================================

export function initNotesHandler() {
  registerStateHandler('notes', {
    priority: 70,

    onBeforeSwitch: async () => {
      flushSave();
    },

    onSave: async () => {},

    onLoad: async () => {
      renderNotesSection();
      // If notes tab is active, re-render the panel content
      if (state.shell.activeTabId === NOTES_TAB_ID) {
        renderNotesPanel();
      }
    },

    onAfterSwitch: async () => {}
  });
}
