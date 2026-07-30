import { state } from './state.js';
import { escapeHtml } from './utils.js';
import { marked } from 'marked';
import { createModuleLogger } from './logger.js';

const logger = createModuleLogger('ToolsPanel');
import {
  GetProjectPrompts,
  CreatePrompt,
  UpdatePrompt,
  DeletePrompt,
  IncrementPromptUsage,
  TogglePromptPinned,
  GetGlobalPrompts,
  CreateGlobalPrompt,
  UpdateGlobalPrompt,
  DeleteGlobalPrompt,
  WriteITermText,
  GetGlobalPromptPrefix,
  SetGlobalPromptPrefix,
  GetGlobalPromptSuffix,
  SetGlobalPromptSuffix
} from '../../wailsjs/go/main/App';
import { registerStateHandler } from './project-switcher.js';

// Tools Panel State
export const toolsState = {
  // Prompts state
  prompts: [],           // project prompts
  globalPrompts: [],     // global prompts
  promptCategories: [],
  globalPromptCategories: [],
  activePromptCategory: 'all',
  promptAutoSubmit: true, // auto-press Enter after sending prompt
  globalPromptPrefix: '',
  globalPromptSuffix: '',
  globalPromptWrapperLoaded: false,
  globalPromptWrapperExpanded: false,
  wrappersEnabled: true,
  // Current modal context
  modalMode: null, // 'view' | 'edit' | 'info' | 'create'
  modalItem: null
};

async function loadGlobalPromptWrapper() {
  try {
    const [pre, post] = await Promise.all([GetGlobalPromptPrefix(), GetGlobalPromptSuffix()]);
    toolsState.globalPromptPrefix = pre || '';
    toolsState.globalPromptSuffix = post || '';
    toolsState.globalPromptWrapperLoaded = true;
  } catch (err) {
    logger.warn('Failed to load global prompt wrapper', { err: err?.message || String(err) });
  }
}

let _wrapperSavePrefixTimer = null;
let _wrapperSaveSuffixTimer = null;
function scheduleWrapperSave(which) {
  const t = which === 'prefix' ? _wrapperSavePrefixTimer : _wrapperSaveSuffixTimer;
  if (t) clearTimeout(t);
  const handle = setTimeout(async () => {
    try {
      if (which === 'prefix') {
        await SetGlobalPromptPrefix(toolsState.globalPromptPrefix);
      } else {
        await SetGlobalPromptSuffix(toolsState.globalPromptSuffix);
      }
    } catch (err) {
      logger.warn('Failed to save global prompt wrapper', { err: err?.message || String(err), which });
    }
  }, 400);
  if (which === 'prefix') _wrapperSavePrefixTimer = handle;
  else _wrapperSaveSuffixTimer = handle;
}

export function isPromptWrappersEnabled() {
  return toolsState.wrappersEnabled !== false;
}

function describeWrappersContent() {
  const pre = (toolsState.globalPromptPrefix || '').trim();
  const post = (toolsState.globalPromptSuffix || '').trim();
  const parts = [];
  if (pre) parts.push('Pre');
  if (post) parts.push('After');
  return parts.length ? parts.join('+') : 'none set';
}

function wrappersToggleTitle() {
  const setUp = describeWrappersContent();
  return isPromptWrappersEnabled()
    ? `Wrappers ON (${setUp}) — click to disable`
    : `Wrappers OFF (${setUp}) — click to enable`;
}

function syncWrappersToggleButton() {
  const btn = document.getElementById('wrappersToggleBtn');
  if (!btn) return;
  btn.classList.toggle('active', isPromptWrappersEnabled());
  btn.title = wrappersToggleTitle();
}

window.isPromptWrappersEnabled = isPromptWrappersEnabled;
window.wrappersToggleTitle = wrappersToggleTitle;

window.itermToggleWrappers = function() {
  toolsState.wrappersEnabled = !isPromptWrappersEnabled();
  syncWrappersToggleButton();
};

export function applyPromptWrappers(text) {
  if (!text || !isPromptWrappersEnabled()) return text;
  const pre = (toolsState.globalPromptPrefix || '').trim();
  const post = (toolsState.globalPromptSuffix || '').trim();
  let result = text;
  if (pre) result = pre + '\n\n' + result;
  if (post) result = result + '\n\n' + post;
  return result;
}
window.applyPromptWrappers = applyPromptWrappers;

export const PROMPTS_TAB_ID = 'prompts-tab';

export function showPromptsPanel(show) {
  const panel = document.getElementById('promptsPanel');
  if (panel) panel.style.display = show ? 'flex' : 'none';
}

export function setupToolsPanel() {
  loadGlobalPromptWrapper();

  // Modal event listeners
  document.getElementById('closeToolsModal')?.addEventListener('click', closeToolsModal);
  document.getElementById('cancelToolsModal')?.addEventListener('click', closeToolsModal);
  document.getElementById('toolsModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'toolsModal') closeToolsModal();
  });
  document.getElementById('fullscreenToolsModal')?.addEventListener('click', toggleModalFullscreen);

  // Initial render of tools
  renderToolsPanel();
}

export function renderToolsPanel() {
  renderPromptsTab();
}

// ============================================
// Prompts Tab
// ============================================

// Calculate prompt size based on usage
function calculatePromptSize(usageCount, maxUsage, totalPrompts) {
  if (maxUsage === 0 || totalPrompts <= 3) return 'prompt-size-medium';

  const score = usageCount / maxUsage;

  if (score >= 0.6) return 'prompt-size-large';      // Top 60%+
  if (score >= 0.25) return 'prompt-size-medium';    // 25-60%
  return 'prompt-size-small';                         // <25%
}

// Sort prompts: pinned first, then by usage desc, then by updatedAt desc
function sortPrompts(prompts) {
  return [...prompts].sort((a, b) => {
    // Pinned always first
    if (a.pinned !== b.pinned) return b.pinned ? 1 : -1;
    // Then by usage
    if (b.usageCount !== a.usageCount) return b.usageCount - a.usageCount;
    // Then by date
    return new Date(b.updatedAt) - new Date(a.updatedAt);
  });
}

// Get all unique categories from prompts
function getAllCategories(prompts, globalPrompts) {
  const categories = new Set();
  [...prompts, ...globalPrompts].forEach(p => {
    if (p.category) categories.add(p.category);
  });
  return Array.from(categories).sort();
}

async function renderPromptsTab() {
  const container = document.getElementById('promptsContainer');
  if (!container) return;

  if (!state.activeProject) {
    container.innerHTML = `
      <div class="tools-empty-state">
        <div class="empty-icon">💬</div>
        <p>Select a project to view prompts</p>
      </div>
    `;
    return;
  }

  try {
    // Load prompts
    const projectPrompts = await GetProjectPrompts(state.activeProject.id);
    const globalPrompts = await GetGlobalPrompts();

    toolsState.prompts = projectPrompts || [];
    toolsState.globalPrompts = globalPrompts || [];

    // Combine and filter by category
    let allPrompts = [
      ...toolsState.prompts.map(p => ({ ...p, isGlobal: false })),
      ...toolsState.globalPrompts.map(p => ({ ...p, isGlobal: true }))
    ];

    if (toolsState.activePromptCategory !== 'all') {
      allPrompts = allPrompts.filter(p => p.category === toolsState.activePromptCategory);
    }

    // Sort prompts
    const sortedPrompts = sortPrompts(allPrompts);

    // Separate pinned and regular prompts
    const pinnedPrompts = sortedPrompts.filter(p => p.pinned);
    const regularPrompts = sortedPrompts.filter(p => !p.pinned);

    // Calculate max usage for sizing
    const maxUsage = Math.max(...allPrompts.map(p => p.usageCount), 1);

    // Get all categories for filter bar
    const categories = getAllCategories(toolsState.prompts, toolsState.globalPrompts);

    let html = '';

    html += renderPromptWrapperSection();

    html += `
      <div class="prompts-filter-bar">
        <button class="prompt-category-btn ${toolsState.activePromptCategory === 'all' ? 'active' : ''}" data-category="all">
          All (${toolsState.prompts.length + toolsState.globalPrompts.length})
        </button>
        ${categories.map(cat => {
          const count = allPrompts.filter(p => p.category === cat).length;
          return `
            <button class="prompt-category-btn ${toolsState.activePromptCategory === cat ? 'active' : ''}" data-category="${escapeHtml(cat)}">
              ${escapeHtml(cat)} (${count})
            </button>
          `;
        }).join('')}
        <button class="prompt-category-btn add-category-btn" title="Add Category">+</button>
        <label class="prompt-auto-submit">
          <input type="checkbox" id="promptAutoSubmit" ${toolsState.promptAutoSubmit ? 'checked' : ''} />
          Auto Submit
        </label>
      </div>
    `;

    // Pinned prompts section
    if (pinnedPrompts.length > 0) {
      html += `
        <div class="prompts-section-header">📌 Pinned</div>
        <div class="prompts-list">
          ${pinnedPrompts.map(prompt => renderPromptItem(prompt, maxUsage, allPrompts.length)).join('')}
        </div>
      `;
    }

    // All prompts section
    if (regularPrompts.length > 0) {
      html += `
        <div class="prompts-section-header">All Prompts</div>
        <div class="prompts-list">
          ${regularPrompts.map(prompt => renderPromptItem(prompt, maxUsage, allPrompts.length)).join('')}
        </div>
      `;
    }

    // Empty state or create button
    if (allPrompts.length === 0) {
      html += `
        <div class="tools-empty-state">
          <div class="empty-icon">💬</div>
          <p>No prompts yet</p>
          <button class="tools-item-btn create-prompt-btn primary" style="margin-top: 12px;">+ Create Prompt</button>
        </div>
      `;
    } else {
      html += `
        <div class="prompts-create-row">
          <button class="tools-item-btn create-prompt-btn primary">+ Create New Prompt</button>
        </div>
      `;
    }

    container.innerHTML = html;

    // Add event handlers
    setupPromptEventHandlers(container);

  } catch (err) {
    logger.error('Failed to load prompts', { error: err.message || String(err) });
    container.innerHTML = `
      <div class="tools-empty-state">
        <div class="empty-icon">⚠️</div>
        <p>Error loading prompts</p>
        <p style="font-size:11px;color:var(--text-muted);margin-top:8px;">${escapeHtml(err.toString())}</p>
      </div>
    `;
  }
}

function renderPromptWrapperSection() {
  const expanded = toolsState.globalPromptWrapperExpanded;
  const pre = toolsState.globalPromptPrefix || '';
  const post = toolsState.globalPromptSuffix || '';
  const preActive = pre.trim().length > 0;
  const postActive = post.trim().length > 0;
  const anyActive = preActive || postActive;

  return `
    <div class="prompt-wrapper-section ${expanded ? 'expanded' : ''}">
      <button class="prompt-wrapper-header" id="promptWrapperToggle" title="Add fixed text before/after every prompt sent to terminal">
        <span class="prompt-wrapper-caret">${expanded ? '▾' : '▸'}</span>
        <span class="prompt-wrapper-title">Wrapper</span>
        <span class="prompt-wrapper-scope">Global</span>
        <span class="prompt-wrapper-badges">
          <span class="prompt-wrapper-badge ${preActive ? 'on' : 'off'}">Pre ${preActive ? '●' : '○'}</span>
          <span class="prompt-wrapper-badge ${postActive ? 'on' : 'off'}">After ${postActive ? '●' : '○'}</span>
        </span>
      </button>
      ${expanded ? `
        <div class="prompt-wrapper-body">
          <label class="prompt-wrapper-label">
            <span>Pre Prompt</span>
            <span class="prompt-wrapper-hint">added before, then a blank line</span>
          </label>
          <textarea id="promptWrapperPre" class="prompt-wrapper-textarea" rows="3" placeholder="e.g. Use TypeScript strict mode.">${escapeHtml(pre)}</textarea>
          <label class="prompt-wrapper-label">
            <span>After Prompt</span>
            <span class="prompt-wrapper-hint">a blank line, then added after</span>
          </label>
          <textarea id="promptWrapperPost" class="prompt-wrapper-textarea" rows="3" placeholder="e.g. Run tests when done.">${escapeHtml(post)}</textarea>
        </div>
      ` : ''}
    </div>
  `;
}

function renderPromptItem(prompt, maxUsage, totalPrompts) {
  const sizeClass = calculatePromptSize(prompt.usageCount, maxUsage, totalPrompts);
  const pinnedClass = prompt.pinned ? 'pinned' : '';

  return `
    <div class="prompt-item-wrapper">
      <button class="prompt-menu-btn" data-prompt-id="${prompt.id}" data-is-global="${prompt.isGlobal}" title="Options">⋮</button>
      <div class="prompt-item ${sizeClass} ${pinnedClass}"
           data-prompt-id="${prompt.id}"
           data-is-global="${prompt.isGlobal}">
        <span class="prompt-item-icon">${prompt.pinned ? '📌' : '💬'}</span>
        <span class="prompt-item-title">${escapeHtml(prompt.title)}</span>
        ${prompt.isGlobal ? '<span class="prompt-item-badge global">🌐</span>' : ''}
        ${prompt.usageCount > 0 ? `<span class="prompt-item-usage">${prompt.usageCount}</span>` : ''}
      </div>
    </div>
  `;
}

function attachWrapperHandlers(container) {
  const toggle = container.querySelector('#promptWrapperToggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      toolsState.globalPromptWrapperExpanded = !toolsState.globalPromptWrapperExpanded;
      renderPromptsTab();
    });
  }

  const pre = container.querySelector('#promptWrapperPre');
  if (pre) {
    pre.addEventListener('input', (e) => {
      toolsState.globalPromptPrefix = e.target.value;
      scheduleWrapperSave('prefix');
      updateWrapperBadge(container, 1, 'Pre', e.target.value);
      syncWrappersToggleButton();
    });
  }
  const post = container.querySelector('#promptWrapperPost');
  if (post) {
    post.addEventListener('input', (e) => {
      toolsState.globalPromptSuffix = e.target.value;
      scheduleWrapperSave('suffix');
      updateWrapperBadge(container, 2, 'After', e.target.value);
      syncWrappersToggleButton();
    });
  }
}

function updateWrapperBadge(container, nth, label, value) {
  const badge = container.querySelector(`.prompt-wrapper-badge:nth-child(${nth})`);
  if (!badge) return;
  const on = value.trim().length > 0;
  badge.classList.toggle('on', on);
  badge.classList.toggle('off', !on);
  badge.textContent = `${label} ${on ? '●' : '○'}`;
}

function setupPromptEventHandlers(container) {
  attachWrapperHandlers(container);

  container.querySelectorAll('.prompt-category-btn:not(.add-category-btn)').forEach(btn => {
    btn.addEventListener('click', () => {
      toolsState.activePromptCategory = btn.dataset.category;
      renderPromptsTab();
    });
  });

  // Add category button
  container.querySelector('.add-category-btn')?.addEventListener('click', () => {
    showCreateCategoryModal();
  });

  // Auto-submit checkbox
  container.querySelector('#promptAutoSubmit')?.addEventListener('change', (e) => {
    toolsState.promptAutoSubmit = e.target.checked;
  });

  // Create prompt button
  container.querySelectorAll('.create-prompt-btn').forEach(btn => {
    btn.addEventListener('click', () => showCreatePromptModal());
  });

  // Prompt item click - send to iTerm2
  container.querySelectorAll('.prompt-item').forEach(item => {
    item.addEventListener('click', async (e) => {
      const promptId = item.dataset.promptId;
      const isGlobal = item.dataset.isGlobal === 'true';
      await sendPromptToTerminal(promptId, isGlobal);
    });
  });

  // Menu button click - show context menu
  container.querySelectorAll('.prompt-menu-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const promptId = btn.dataset.promptId;
      const isGlobal = btn.dataset.isGlobal === 'true';
      showPromptContextMenu(e, promptId, isGlobal);
    });
  });

  // Prompt item right-click - context menu (edit/pin/delete)
  container.querySelectorAll('.prompt-item').forEach(item => {
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const promptId = item.dataset.promptId;
      const isGlobal = item.dataset.isGlobal === 'true';
      showPromptContextMenu(e, promptId, isGlobal);
    });
  });
}

async function sendPromptToTerminal(promptId, isGlobal) {
  // Find the prompt
  const prompts = isGlobal ? toolsState.globalPrompts : toolsState.prompts;
  const prompt = prompts.find(p => p.id === promptId);
  if (!prompt) return;

  try {
    // Send prompt text to iTerm2 (wrapped with global Pre/After if set)
    // The second parameter controls whether to press Enter after the text
    await WriteITermText(applyPromptWrappers(prompt.content), toolsState.promptAutoSubmit);

    // Increment usage
    await IncrementPromptUsage(state.activeProject?.id, promptId, isGlobal);

    // Refresh the tab
    renderPromptsTab();
  } catch (err) {
    logger.error('Failed to send prompt to iTerm2', { error: err.message || String(err) });
    alert('Failed to send prompt: ' + err);
  }
}

async function togglePromptPin(promptId, isGlobal) {
  try {
    await TogglePromptPinned(state.activeProject?.id, promptId, isGlobal);
    renderPromptsTab();
  } catch (err) {
    logger.error('Failed to toggle pin', { error: err.message || String(err) });
    alert('Failed to toggle pin: ' + err);
  }
}

function showCreatePromptModal() {
  const modal = document.getElementById('toolsModal');
  const title = document.getElementById('toolsModalTitle');
  const body = document.getElementById('toolsModalBody');
  const footer = document.getElementById('toolsModalFooter');

  if (!modal || !title || !body || !footer) return;

  // Get categories for dropdown
  const categories = getAllCategories(toolsState.prompts, toolsState.globalPrompts);

  title.textContent = 'Create New Prompt';
  body.innerHTML = `
    <div class="prompt-form">
      <div class="form-group">
        <label for="promptTitle">Title</label>
        <input type="text" id="promptTitle" class="tools-input" placeholder="e.g. Explain Error" />
      </div>
      <div class="form-group">
        <label for="promptCategory">Category</label>
        <div class="prompt-category-input">
          <select id="promptCategory" class="tools-select">
            <option value="">None</option>
            ${categories.map(cat => `<option value="${escapeHtml(cat)}">${escapeHtml(cat)}</option>`).join('')}
          </select>
          <input type="text" id="promptNewCategory" class="tools-input" placeholder="or enter new..." style="margin-left: 8px;" />
        </div>
      </div>
      <div class="form-group">
        <label>
          <input type="checkbox" id="promptIsGlobal" />
          Global (available in all projects)
        </label>
      </div>
      <div class="form-group">
        <label for="promptContent">Prompt Content</label>
        <textarea id="promptContent" class="tools-editor" placeholder="Enter your prompt text here...

Example:
Look at the error message and explain:
1. What is causing the error
2. How to fix it
3. How to prevent it in the future"></textarea>
      </div>
    </div>
  `;

  footer.innerHTML = `
    <button id="cancelPromptBtn" class="secondary-btn">Cancel</button>
    <button id="savePromptBtn" class="primary-btn">Create</button>
  `;

  footer.querySelector('#cancelPromptBtn')?.addEventListener('click', closeToolsModal);
  footer.querySelector('#savePromptBtn')?.addEventListener('click', async () => {
    const promptTitle = document.getElementById('promptTitle').value.trim();
    const categorySelect = document.getElementById('promptCategory').value;
    const newCategory = document.getElementById('promptNewCategory').value.trim();
    const isGlobal = document.getElementById('promptIsGlobal').checked;
    const content = document.getElementById('promptContent').value;

    if (!promptTitle) {
      alert('Please enter a title');
      return;
    }

    if (!content) {
      alert('Please enter prompt content');
      return;
    }

    const category = newCategory || categorySelect;

    const prompt = {
      title: promptTitle,
      content: content,
      category: category,
      usageCount: 0,
      pinned: false
    };

    try {
      if (isGlobal) {
        await CreateGlobalPrompt(prompt);
      } else {
        await CreatePrompt(state.activeProject.id, prompt);
      }

      closeToolsModal();
      renderPromptsTab();
    } catch (err) {
      logger.error('Failed to create prompt', { error: err.message || String(err) });
      alert('Failed to create prompt: ' + err);
    }
  });

  modal.classList.remove('hidden');
}

function showEditPromptModal(promptId, isGlobal) {
  const prompts = isGlobal ? toolsState.globalPrompts : toolsState.prompts;
  const prompt = prompts.find(p => p.id === promptId);
  if (!prompt) return;

  const modal = document.getElementById('toolsModal');
  const title = document.getElementById('toolsModalTitle');
  const body = document.getElementById('toolsModalBody');
  const footer = document.getElementById('toolsModalFooter');

  if (!modal || !title || !body || !footer) return;

  // Get categories for dropdown
  const categories = getAllCategories(toolsState.prompts, toolsState.globalPrompts);

  title.textContent = 'Edit Prompt';
  body.innerHTML = `
    <div class="prompt-form">
      <div class="form-group">
        <label for="promptTitle">Title</label>
        <input type="text" id="promptTitle" class="tools-input" value="${escapeHtml(prompt.title)}" />
      </div>
      <div class="form-group">
        <label for="promptCategory">Category</label>
        <div class="prompt-category-input">
          <select id="promptCategory" class="tools-select">
            <option value="">None</option>
            ${categories.map(cat => `<option value="${escapeHtml(cat)}" ${prompt.category === cat ? 'selected' : ''}>${escapeHtml(cat)}</option>`).join('')}
          </select>
          <input type="text" id="promptNewCategory" class="tools-input" placeholder="or enter new..." style="margin-left: 8px;" />
        </div>
      </div>
      <div class="form-group">
        <label>
          <input type="checkbox" id="promptIsGlobal" ${isGlobal ? 'checked' : ''} />
          Global (available in all projects)
        </label>
      </div>
      <div class="form-group">
        <label for="promptContent">Prompt Content</label>
        <textarea id="promptContent" class="tools-editor">${escapeHtml(prompt.content)}</textarea>
      </div>
    </div>
  `;

  footer.innerHTML = `
    <button id="deletePromptBtn" class="secondary-btn danger-btn">🗑️ Delete</button>
    <div style="flex:1"></div>
    <button id="cancelPromptBtn" class="secondary-btn">Cancel</button>
    <button id="savePromptBtn" class="primary-btn">Save</button>
  `;

  footer.querySelector('#cancelPromptBtn')?.addEventListener('click', closeToolsModal);

  footer.querySelector('#deletePromptBtn')?.addEventListener('click', async () => {
    if (confirm(`Delete prompt "${prompt.title}"?`)) {
      try {
        if (isGlobal) {
          await DeleteGlobalPrompt(promptId);
        } else {
          await DeletePrompt(state.activeProject.id, promptId);
        }
        closeToolsModal();
        renderPromptsTab();
      } catch (err) {
        logger.error('Failed to delete prompt', { error: err.message || String(err) });
        alert('Failed to delete prompt: ' + err);
      }
    }
  });

  footer.querySelector('#savePromptBtn')?.addEventListener('click', async () => {
    const promptTitle = document.getElementById('promptTitle').value.trim();
    const categorySelect = document.getElementById('promptCategory').value;
    const newCategory = document.getElementById('promptNewCategory').value.trim();
    const newIsGlobal = document.getElementById('promptIsGlobal').checked;
    const content = document.getElementById('promptContent').value;

    if (!promptTitle) {
      alert('Please enter a title');
      return;
    }

    if (!content) {
      alert('Please enter prompt content');
      return;
    }

    const category = newCategory || categorySelect;

    const updatedPrompt = {
      title: promptTitle,
      content: content,
      category: category,
      usageCount: prompt.usageCount,
      pinned: prompt.pinned
    };

    try {
      // Check if scope changed
      if (isGlobal !== newIsGlobal) {
        // Delete from old location
        if (isGlobal) {
          await DeleteGlobalPrompt(promptId);
        } else {
          await DeletePrompt(state.activeProject.id, promptId);
        }
        // Create in new location
        if (newIsGlobal) {
          await CreateGlobalPrompt(updatedPrompt);
        } else {
          await CreatePrompt(state.activeProject.id, updatedPrompt);
        }
      } else {
        // Just update in same location
        if (isGlobal) {
          await UpdateGlobalPrompt(promptId, updatedPrompt);
        } else {
          await UpdatePrompt(state.activeProject.id, promptId, updatedPrompt);
        }
      }

      closeToolsModal();
      renderPromptsTab();
    } catch (err) {
      logger.error('Failed to update prompt', { error: err.message || String(err) });
      alert('Failed to update prompt: ' + err);
    }
  });

  modal.classList.remove('hidden');
}

function showCreateCategoryModal() {
  const categoryName = prompt('Enter new category name:');
  if (categoryName && categoryName.trim()) {
    // Categories are derived from prompts, so we just need to create a prompt with this category
    // For now, we'll just switch to that category filter
    toolsState.activePromptCategory = categoryName.trim();
    renderPromptsTab();
  }
}

function showPromptContextMenu(e, promptId, isGlobal) {
  // Remove any existing context menu
  const existingMenu = document.querySelector('.prompt-context-menu');
  if (existingMenu) existingMenu.remove();

  const prompts = isGlobal ? toolsState.globalPrompts : toolsState.prompts;
  const prompt = prompts.find(p => p.id === promptId);
  if (!prompt) return;

  const menu = document.createElement('div');
  menu.className = 'prompt-context-menu';
  menu.innerHTML = `
    <button class="context-menu-item" data-action="edit">✏️ Edit</button>
    <button class="context-menu-item" data-action="pin">${prompt.pinned ? '📍 Unpin' : '📌 Pin'}</button>
    <button class="context-menu-item danger" data-action="delete">🗑️ Delete</button>
  `;

  menu.style.position = 'fixed';
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;

  document.body.appendChild(menu);

  // Handle menu item clicks
  menu.querySelectorAll('.context-menu-item').forEach(item => {
    item.addEventListener('click', async () => {
      const action = item.dataset.action;
      menu.remove();

      switch (action) {
        case 'edit':
          showEditPromptModal(promptId, isGlobal);
          break;
        case 'pin':
          await togglePromptPin(promptId, isGlobal);
          break;
        case 'delete':
          if (confirm(`Delete prompt "${prompt.title}"?`)) {
            try {
              if (isGlobal) {
                await DeleteGlobalPrompt(promptId);
              } else {
                await DeletePrompt(state.activeProject.id, promptId);
              }
              renderPromptsTab();
            } catch (err) {
              logger.error('Failed to delete prompt', { error: err.message || String(err) });
              alert('Failed to delete prompt: ' + err);
            }
          }
          break;
      }
    });
  });

  // Close menu on click outside
  const closeMenu = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener('click', closeMenu);
    }
  };
  setTimeout(() => document.addEventListener('click', closeMenu), 0);
}

export function closeToolsModal() {
  const modal = document.getElementById('toolsModal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('fullscreen');
  }
  toolsState.modalMode = null;
  toolsState.modalItem = null;
}

function toggleModalFullscreen() {
  const modal = document.getElementById('toolsModal');
  const btn = document.getElementById('fullscreenToolsModal');
  if (modal) {
    modal.classList.toggle('fullscreen');
    if (btn) {
      btn.textContent = modal.classList.contains('fullscreen') ? '⛶' : '⛶';
      btn.title = modal.classList.contains('fullscreen') ? 'Exit fullscreen' : 'Toggle fullscreen';
    }
  }
}

// Refresh tools panel when project changes
export function refreshToolsPanel() {
  // Reset prompts state when project changes
  toolsState.prompts = [];
  toolsState.promptCategories = [];
  toolsState.activePromptCategory = 'all';
  // Note: globalPrompts persist across project switches

  if (state.activeProject) {
    renderToolsPanel();
  }
}

// ============================================
// Project Switcher Handler
// ============================================

/**
 * Initialize tools panel handler for project switching
 * Call this during app initialization
 */
export function initToolsPanelHandler() {
  registerStateHandler('toolsPanel', {
    priority: 100,

    onBeforeSwitch: async (ctx) => {
      // Nothing to cleanup for tools panel
    },

    onSave: async (ctx) => {
      // Tools panel state is saved as needed
    },

    onLoad: async (ctx) => {
      // Tools panel will be refreshed in onAfterSwitch
    },

    onAfterSwitch: async (ctx) => {
      // Refresh tools panel after project switch
      refreshToolsPanel();
    }
  });
}
