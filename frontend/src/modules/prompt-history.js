import { escapeHtml } from './utils.js';
import { state } from './state.js';
import { registerStateHandler } from './project-switcher.js';

const {
  GetPromptHistory,
  GetPromptHistoryCount,
  AddPromptHistory,
  DeletePromptHistory,
  ClearPromptHistory
} = window.go.main.App;

const PAGE_SIZE = 10;
let currentOffset = 0;
let totalCount = 0;
let historyItems = [];


function timeAgo(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const seconds = Math.floor((now - date) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

function getPreview(content, maxLines = 2) {
  const lines = content.split('\n').filter(l => l.trim());
  const preview = lines.slice(0, maxLines).join('\n');
  const hasMore = lines.length > maxLines;
  return { preview, hasMore };
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
}

function showCopiedFeedback(btn) {
  const original = btn.textContent;
  btn.textContent = '✓';
  btn.classList.add('copied');
  setTimeout(() => {
    btn.textContent = original;
    btn.classList.remove('copied');
  }, 1000);
}

// Save a prompt to history
export async function savePromptToHistory(content) {
  if (!state.activeProject || !content.trim()) return;
  try {
    await AddPromptHistory(state.activeProject.id, content.trim());
    // Refresh if prompts tab is visible
    const section = document.getElementById('promptHistorySection');
    if (section && !section.classList.contains('hidden')) {
      currentOffset = 0;
      historyItems = [];
      await loadPage();
      renderPromptHistory();
    }
  } catch (err) {
    console.error('Failed to save prompt history:', err);
  }
}

async function loadPage() {
  if (!state.activeProject) return;
  try {
    const items = await GetPromptHistory(state.activeProject.id, PAGE_SIZE, currentOffset);
    totalCount = await GetPromptHistoryCount(state.activeProject.id);
    if (currentOffset === 0) {
      historyItems = items || [];
    } else {
      historyItems = [...historyItems, ...(items || [])];
    }
  } catch (err) {
    console.error('Failed to load prompt history:', err);
  }
}

async function loadMore() {
  currentOffset += PAGE_SIZE;
  await loadPage();
  renderPromptHistory();
}

async function deleteItem(id) {
  if (!state.activeProject) return;
  try {
    await DeletePromptHistory(state.activeProject.id, id);
    historyItems = historyItems.filter(i => i.id !== id);
    totalCount--;
    renderPromptHistory();
  } catch (err) {
    console.error('Failed to delete prompt history item:', err);
  }
}

async function clearAll() {
  if (!state.activeProject) return;
  try {
    await ClearPromptHistory(state.activeProject.id);
    historyItems = [];
    totalCount = 0;
    currentOffset = 0;
    renderPromptHistory();
  } catch (err) {
    console.error('Failed to clear prompt history:', err);
  }
}

function showPromptPopup(item) {
  // Remove existing popup
  const existing = document.getElementById('promptPopupOverlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'promptPopupOverlay';
  overlay.className = 'prompt-popup-overlay';
  overlay.innerHTML = `
    <div class="prompt-popup">
      <div class="prompt-popup-header">
        <span class="prompt-popup-time">${timeAgo(item.createdAt)}</span>
        <div class="prompt-popup-actions">
          <button class="prompt-popup-copy" title="Copy">📋</button>
          <button class="prompt-popup-close" title="Close">✕</button>
        </div>
      </div>
      <div class="prompt-popup-content">${escapeHtml(item.content)}</div>
    </div>
  `;

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  overlay.querySelector('.prompt-popup-close').addEventListener('click', () => overlay.remove());
  overlay.querySelector('.prompt-popup-copy').addEventListener('click', (e) => {
    copyToClipboard(item.content);
    showCopiedFeedback(e.currentTarget);
  });

  document.body.appendChild(overlay);
}

export function renderPromptHistory() {
  const section = document.getElementById('promptHistorySection');
  if (!section) return;

  const hasMore = historyItems.length < totalCount;

  section.innerHTML = `
    <div class="prompt-history-list" id="promptHistoryList">
      ${historyItems.length === 0 ? `
        <div class="prompt-history-empty">No prompts yet</div>
      ` : historyItems.map(item => {
        const { preview, hasMore: truncated } = getPreview(item.content);
        return `
          <div class="prompt-history-item" data-id="${item.id}">
            <div class="prompt-history-preview" data-id="${item.id}">
              <span class="prompt-history-text">${escapeHtml(preview)}${truncated ? '<span class="prompt-history-ellipsis">...</span>' : ''}</span>
            </div>
            <div class="prompt-history-meta">
              <span class="prompt-history-time">${timeAgo(item.createdAt)}</span>
              <div class="prompt-history-actions">
                <button class="prompt-history-btn prompt-copy-btn" data-id="${item.id}" title="Copy">📋</button>
                <button class="prompt-history-btn prompt-delete-btn" data-id="${item.id}" title="Delete">🗑️</button>
              </div>
            </div>
          </div>
        `;
      }).join('')}
      ${hasMore ? `
        <button class="prompt-history-load-more" id="promptLoadMore">
          Load more (${totalCount - historyItems.length} remaining)
        </button>
      ` : ''}
    </div>
  `;

  // Event listeners
  section.querySelectorAll('.prompt-history-preview').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      const item = historyItems.find(i => i.id === id);
      if (item) showPromptPopup(item);
    });
  });

  section.querySelectorAll('.prompt-copy-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const item = historyItems.find(i => i.id === id);
      if (item) {
        copyToClipboard(item.content);
        showCopiedFeedback(btn);
      }
    });
  });

  section.querySelectorAll('.prompt-delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteItem(btn.dataset.id);
    });
  });

  const loadMoreBtn = document.getElementById('promptLoadMore');
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', loadMore);
  }
}

function addPromptHistoryStyles() {
  if (document.getElementById('prompt-history-styles')) return;

  const style = document.createElement('style');
  style.id = 'prompt-history-styles';
  style.textContent = `
    /* Right sidebar tabs */
    .right-sidebar-tabs {
      display: flex;
      border-bottom: 1px solid #334155;
      background: rgba(255, 255, 255, 0.02);
      flex-shrink: 0;
    }

    .right-sidebar-tab {
      flex: 1;
      padding: 10px 12px;
      font-size: 12px;
      font-weight: 500;
      color: #64748b;
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      cursor: pointer;
      transition: all 0.15s;
      text-align: center;
    }

    .right-sidebar-tab:hover {
      color: #94a3b8;
      background: rgba(255, 255, 255, 0.03);
    }

    .right-sidebar-tab.active {
      color: #f1f5f9;
      border-bottom-color: #fab332;
    }

    /* Prompt History Section */
    #promptHistorySection {
      display: flex;
      flex-direction: column;
      flex: 1;
      overflow: hidden;
    }

    #promptHistorySection.hidden {
      display: none;
    }

    .prompt-history-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 8px;
      overflow-y: auto;
      flex: 1;
    }

    .prompt-history-empty {
      color: #64748b;
      font-size: 13px;
      text-align: center;
      padding: 32px 16px;
    }

    .prompt-history-item {
      padding: 8px 10px;
      border-radius: 8px;
      transition: background 0.15s;
      border: 1px solid transparent;
    }

    .prompt-history-item:hover {
      background: #334155;
      border-color: rgba(250, 179, 50, 0.15);
    }

    .prompt-history-preview {
      cursor: pointer;
    }

    .prompt-history-text {
      font-size: 12px;
      color: #cbd5e1;
      line-height: 1.5;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .prompt-history-ellipsis {
      color: #64748b;
      font-weight: 600;
    }

    .prompt-history-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: 4px;
    }

    .prompt-history-time {
      font-size: 10px;
      color: #64748b;
    }

    .prompt-history-actions {
      display: flex;
      gap: 2px;
      opacity: 0;
      transition: opacity 0.15s;
    }

    .prompt-history-item:hover .prompt-history-actions {
      opacity: 1;
    }

    .prompt-history-btn {
      background: none;
      border: none;
      cursor: pointer;
      font-size: 11px;
      padding: 3px 5px;
      border-radius: 4px;
      transition: background 0.15s;
    }

    .prompt-history-btn:hover {
      background: #475569;
    }

    .prompt-history-btn.prompt-delete-btn:hover {
      background: #ef444440;
    }

    .prompt-history-btn.copied {
      color: #22c55e;
    }

    .prompt-history-load-more {
      display: block;
      width: 100%;
      padding: 10px;
      margin-top: 4px;
      background: rgba(250, 179, 50, 0.08);
      border: 1px solid rgba(250, 179, 50, 0.2);
      border-radius: 8px;
      color: #fab332;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.15s;
    }

    .prompt-history-load-more:hover {
      background: rgba(250, 179, 50, 0.15);
      border-color: rgba(250, 179, 50, 0.35);
    }

    /* Prompt Popup */
    .prompt-popup-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
    }

    .prompt-popup {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 12px;
      width: 90%;
      max-width: 600px;
      max-height: 70vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
    }

    .prompt-popup-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      border-bottom: 1px solid #334155;
    }

    .prompt-popup-time {
      font-size: 12px;
      color: #64748b;
    }

    .prompt-popup-actions {
      display: flex;
      gap: 8px;
    }

    .prompt-popup-copy,
    .prompt-popup-close {
      background: none;
      border: none;
      cursor: pointer;
      font-size: 14px;
      padding: 4px 8px;
      border-radius: 6px;
      color: #94a3b8;
      transition: all 0.15s;
    }

    .prompt-popup-copy:hover {
      background: #334155;
    }

    .prompt-popup-copy.copied {
      color: #22c55e;
    }

    .prompt-popup-close:hover {
      background: #ef444430;
      color: #ef4444;
    }

    .prompt-popup-content {
      padding: 16px;
      font-size: 13px;
      color: #e2e8f0;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
      overflow-y: auto;
      flex: 1;
    }

    /* Scrollbar */
    .prompt-history-list::-webkit-scrollbar,
    .prompt-popup-content::-webkit-scrollbar {
      width: 4px;
    }

    .prompt-history-list::-webkit-scrollbar-track,
    .prompt-popup-content::-webkit-scrollbar-track {
      background: transparent;
    }

    .prompt-history-list::-webkit-scrollbar-thumb,
    .prompt-popup-content::-webkit-scrollbar-thumb {
      background: #334155;
      border-radius: 2px;
    }

    /* Adjust todo section when tabs are present */
    .right-sidebar-content {
      display: flex;
      flex-direction: column;
      flex: 1;
      overflow: hidden;
    }
  `;
  document.head.appendChild(style);
}

export function initPromptHistory() {
  addPromptHistoryStyles();
}

export async function loadPromptHistory() {
  currentOffset = 0;
  historyItems = [];
  await loadPage();
}

export function initPromptHistoryHandler() {
  registerStateHandler('promptHistory', {
    priority: 84,
    onBeforeSwitch: async () => {},
    onSave: async () => {},
    onLoad: async () => {
      await loadPromptHistory();
    },
    onAfterSwitch: async () => {
      setTimeout(() => renderPromptHistory(), 100);
    }
  });
}
