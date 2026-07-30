import hljs from 'highlight.js';
import { diffLines } from 'diff';
import { state, getActiveRepoPath } from './state.js';
import { escapeHtml } from './utils.js';
import { GetGitFileDiff } from '../../wailsjs/go/main/App';

// Callback for switching tabs
let onSwitchTab = null;

// Change navigation state
let diffChanges = []; // [{pane, lineEl, index}]
let currentChangeIdx = -1;

// Per-pane search state
const diffSearch = {
  old: { query: '', matches: [], currentIdx: -1 },
  new: { query: '', matches: [], currentIdx: -1 },
};

export function setDiffCallbacks(callbacks) {
  onSwitchTab = callbacks.switchTab;
}

export async function showGitDiff(filePath) {
  if (!state.activeProject) return;

  state.git.currentDiffFile = filePath;

  const diffTab = document.getElementById('diffTab');
  const diffTabName = diffTab?.querySelector('.diff-tab-name');
  if (diffTab && diffTabName) {
    const fileName = filePath.split('/').pop();
    diffTabName.textContent = `Diff: ${fileName}`;
    diffTab.classList.remove('hidden');
  }

  if (onSwitchTab) onSwitchTab('diff');

  const filenameEl = document.getElementById('diffFilename');
  const viewer = document.getElementById('diffViewer');

  filenameEl.textContent = filePath;
  viewer.innerHTML = `
    <div class="diff-split-view">
      <div class="diff-pane old-content">
        <div class="diff-pane-header"><span>Old</span>${diffSearchBarHtml('old')}</div>
        <pre class="diff-content" id="diffOldContent">Loading...</pre>
      </div>
      <div class="diff-pane new-content">
        <div class="diff-pane-header"><span>New</span>${diffSearchBarHtml('new')}</div>
        <pre class="diff-content" id="diffNewContent">Loading...</pre>
      </div>
    </div>
  `;

  setupDiffSearchBar('old');
  setupDiffSearchBar('new');

  try {
    const diff = await GetGitFileDiff(getActiveRepoPath(), filePath);
    const oldContent = document.getElementById('diffOldContent');
    const newContent = document.getElementById('diffNewContent');

    if (diff) {
      highlightDiffContent(oldContent, newContent, diff.oldContent || '', diff.newContent || '', filePath);
      setupDiffSyncScroll(oldContent, newContent);
    } else {
      oldContent.textContent = '(could not load)';
      newContent.textContent = '(could not load)';
    }
  } catch (err) {
    console.error('Failed to get diff:', err);
    viewer.innerHTML = `<div class="diff-error">Error loading diff: ${escapeHtml(err.toString())}</div>`;
  }
}

// Get language for highlight.js based on file extension
function getLanguageFromPath(filePath) {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const langMap = {
    'js': 'javascript',
    'jsx': 'javascript',
    'ts': 'typescript',
    'tsx': 'typescript',
    'py': 'python',
    'rb': 'ruby',
    'go': 'go',
    'rs': 'rust',
    'java': 'java',
    'kt': 'kotlin',
    'swift': 'swift',
    'c': 'c',
    'cpp': 'cpp',
    'cc': 'cpp',
    'h': 'c',
    'hpp': 'cpp',
    'cs': 'csharp',
    'php': 'php',
    'html': 'html',
    'htm': 'html',
    'css': 'css',
    'scss': 'scss',
    'sass': 'scss',
    'less': 'less',
    'json': 'json',
    'xml': 'xml',
    'yaml': 'yaml',
    'yml': 'yaml',
    'md': 'markdown',
    'sql': 'sql',
    'sh': 'bash',
    'bash': 'bash',
    'zsh': 'bash',
    'dockerfile': 'dockerfile',
    'vue': 'html',
    'svelte': 'html',
    'graphql': 'graphql',
    'gql': 'graphql',
    'prisma': 'prisma'
  };
  return langMap[ext] || null;
}

// Highlight code with syntax highlighting
function highlightCode(code, language) {
  if (language && hljs.getLanguage(language)) {
    try {
      return hljs.highlight(code, { language }).value;
    } catch (e) {
      console.warn('Highlight error:', e);
    }
  }
  // Fallback: try auto-detection
  try {
    return hljs.highlightAuto(code).value;
  } catch (e) {
    return escapeHtml(code);
  }
}

function highlightDiffContent(oldEl, newEl, oldText, newText, filePath) {
  const oldLines = (oldText || '').split('\n');
  const newLines = (newText || '').split('\n');
  const language = getLanguageFromPath(filePath);

  // Store raw lines for copy functionality
  state.diffSelection.filePath = filePath;

  // Highlight entire content first, then split by lines
  const oldHighlighted = highlightCode(oldText || '', language);
  const newHighlighted = highlightCode(newText || '', language);

  // Split highlighted content back into lines (preserve HTML tags)
  const oldHighlightedLines = splitHighlightedLines(oldHighlighted, oldLines.length);
  const newHighlightedLines = splitHighlightedLines(newHighlighted, newLines.length);

  const rows = buildAlignedRows(oldText || '', newText || '');

  const renderCell = (cell, pane, highlightedLines, rawLines) => {
    if (!cell) {
      return `<div class="diff-line diff-spacer"><span class="line-num"></span><span class="line-code"></span></div>`;
    }
    const i = cell.num - 1;
    const lineNum = String(cell.num).padStart(4, ' ');
    const highlightedLine = highlightedLines[i] ?? escapeHtml(rawLines[i] ?? '');
    return `<div class="diff-line ${cell.cls}" data-pane="${pane}" data-line="${cell.num}"><span class="line-num">${lineNum}</span><span class="line-code">${highlightedLine}</span></div>`;
  };

  oldEl.innerHTML = rows.map(r => renderCell(r.old, 'old', oldHighlightedLines, oldLines)).join('');
  newEl.innerHTML = rows.map(r => renderCell(r.new, 'new', newHighlightedLines, newLines)).join('');

  // Setup selection handlers
  setupDiffSelection(oldEl, oldLines, 'old');
  setupDiffSelection(newEl, newLines, 'new');

  // Build change index for navigation
  buildChangeIndex(oldEl, newEl);
}

// Align both files into equal-height rows: unchanged lines pair up,
// changed blocks sit side by side, and the shorter side gets spacer cells.
function buildAlignedRows(oldText, newText) {
  const parts = diffLines(oldText, newText);
  const rows = [];
  let oldNum = 1;
  let newNum = 1;
  let i = 0;

  while (i < parts.length) {
    const part = parts[i];
    if (part.removed && parts[i + 1]?.added) {
      const oldCount = part.count;
      const newCount = parts[i + 1].count;
      for (let j = 0; j < Math.max(oldCount, newCount); j++) {
        rows.push({
          old: j < oldCount ? { num: oldNum++, cls: 'diff-removed' } : null,
          new: j < newCount ? { num: newNum++, cls: 'diff-added' } : null,
        });
      }
      i += 2;
    } else if (part.removed) {
      for (let j = 0; j < part.count; j++) {
        rows.push({ old: { num: oldNum++, cls: 'diff-removed' }, new: null });
      }
      i++;
    } else if (part.added) {
      for (let j = 0; j < part.count; j++) {
        rows.push({ old: null, new: { num: newNum++, cls: 'diff-added' } });
      }
      i++;
    } else {
      for (let j = 0; j < part.count; j++) {
        rows.push({ old: { num: oldNum++, cls: '' }, new: { num: newNum++, cls: '' } });
      }
      i++;
    }
  }

  return rows;
}

// Build an index of change "hunks" for navigation
// Groups consecutive changed lines in the NEW pane into single entries
function buildChangeIndex(oldEl, newEl) {
  diffChanges = [];
  currentChangeIdx = -1;

  // Navigate by new pane (added lines) - this is what you want to review
  const changedLines = [...newEl.querySelectorAll('.diff-line.diff-added')];

  // Group consecutive lines into hunks, take first line of each hunk
  let lastLine = -2;
  for (const el of changedLines) {
    const line = parseInt(el.dataset.line);
    if (line > lastLine + 1) {
      diffChanges.push({ pane: 'new', line, el });
    }
    lastLine = line;
  }

  updateChangeCounter();
}

// Navigate to next change
function goToNextChange() {
  if (diffChanges.length === 0) return;
  currentChangeIdx = (currentChangeIdx + 1) % diffChanges.length;
  scrollToChange(currentChangeIdx);
}

// Navigate to previous change
function goToPrevChange() {
  if (diffChanges.length === 0) return;
  currentChangeIdx = (currentChangeIdx - 1 + diffChanges.length) % diffChanges.length;
  scrollToChange(currentChangeIdx);
}

// Scroll both panes to show the current change
function scrollToChange(idx) {
  const change = diffChanges[idx];
  if (!change) return;

  // Remove previous highlight
  document.querySelectorAll('.diff-line.diff-current-change').forEach(el => el.classList.remove('diff-current-change'));

  // Highlight current change line
  change.el.classList.add('diff-current-change');

  // Scroll the pane containing the change
  const paneEl = change.pane === 'old'
    ? document.getElementById('diffOldContent')
    : document.getElementById('diffNewContent');

  const otherPaneEl = change.pane === 'old'
    ? document.getElementById('diffNewContent')
    : document.getElementById('diffOldContent');

  if (paneEl) {
    const lineTop = change.el.offsetTop;
    const paneHeight = paneEl.clientHeight;
    paneEl.scrollTop = lineTop - paneHeight / 3;

    // Sync the other pane
    if (otherPaneEl) {
      const maxScroll = paneEl.scrollHeight - paneEl.clientHeight;
      if (maxScroll > 0) {
        const pct = paneEl.scrollTop / maxScroll;
        const otherMax = otherPaneEl.scrollHeight - otherPaneEl.clientHeight;
        otherPaneEl.scrollTop = pct * otherMax;
      }
    }
  }

  updateChangeCounter();
}

// Update the counter display
function updateChangeCounter() {
  const counter = document.getElementById('diffChangeCounter');
  if (!counter) return;
  if (diffChanges.length === 0) {
    counter.textContent = 'No changes';
  } else if (currentChangeIdx < 0) {
    counter.textContent = `${diffChanges.length} changes`;
  } else {
    counter.textContent = `${currentChangeIdx + 1} / ${diffChanges.length}`;
  }
}

// Expose nav functions globally for toolbar buttons
window.diffGoToPrev = goToPrevChange;
window.diffGoToNext = goToNextChange;

function diffSearchBarHtml(pane) {
  return `
    <div class="diff-search" data-pane="${pane}">
      <input type="text" class="diff-search-input" placeholder="Search..." spellcheck="false">
      <span class="diff-search-count"></span>
      <button class="diff-search-btn" data-dir="prev" title="Previous match (Shift+Enter)">▲</button>
      <button class="diff-search-btn" data-dir="next" title="Next match (Enter)">▼</button>
    </div>
  `;
}

function diffPaneEl(pane) {
  return document.getElementById(pane === 'old' ? 'diffOldContent' : 'diffNewContent');
}

function setupDiffSearchBar(pane) {
  diffSearch[pane] = { query: '', matches: [], currentIdx: -1 };
  clearSearchHighlights(pane);

  const container = document.querySelector(`.diff-search[data-pane="${pane}"]`);
  if (!container) return;
  const input = container.querySelector('.diff-search-input');
  const count = container.querySelector('.diff-search-count');
  diffSearch[pane].countEl = count;

  let debounceTimer = null;
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      diffSearch[pane].query = input.value;
      runDiffSearch(pane);
    }, 250);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(debounceTimer);
      if (input.value !== diffSearch[pane].query) {
        diffSearch[pane].query = input.value;
        runDiffSearch(pane);
      } else {
        goToMatch(pane, diffSearch[pane].currentIdx + (e.shiftKey ? -1 : 1));
      }
    } else if (e.key === 'Escape') {
      clearTimeout(debounceTimer);
      input.value = '';
      diffSearch[pane].query = '';
      runDiffSearch(pane);
      input.blur();
    }
  });

  container.querySelectorAll('.diff-search-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      goToMatch(pane, diffSearch[pane].currentIdx + (btn.dataset.dir === 'prev' ? -1 : 1));
    });
  });
}

function runDiffSearch(pane) {
  const s = diffSearch[pane];
  s.matches = [];
  s.currentIdx = -1;
  clearSearchHighlights(pane);

  const paneEl = diffPaneEl(pane);
  const query = s.query;
  if (!paneEl || !query) {
    updateSearchCount(pane);
    return;
  }

  const lowerQuery = query.toLowerCase();
  paneEl.querySelectorAll('.diff-line .line-code').forEach(codeEl => {
    const lowerText = codeEl.textContent.toLowerCase();
    let idx = 0;
    while ((idx = lowerText.indexOf(lowerQuery, idx)) !== -1) {
      const range = rangeForTextOffsets(codeEl, idx, idx + query.length);
      if (range) s.matches.push({ lineEl: codeEl.closest('.diff-line'), range });
      idx += query.length;
    }
  });

  applySearchHighlights(pane);
  if (s.matches.length) {
    goToMatch(pane, 0);
  } else {
    updateSearchCount(pane);
  }
}

// Build a Range over the element's text nodes for [start, end) offsets
// in its concatenated textContent — survives syntax-highlighting spans.
function rangeForTextOffsets(el, start, end) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let pos = 0;
  let startNode = null;
  let startOffset = 0;
  let node;
  while ((node = walker.nextNode())) {
    const len = node.textContent.length;
    if (!startNode && pos + len > start) {
      startNode = node;
      startOffset = start - pos;
    }
    if (startNode && pos + len >= end) {
      const range = new Range();
      range.setStart(startNode, startOffset);
      range.setEnd(node, end - pos);
      return range;
    }
    pos += len;
  }
  return null;
}

const supportsHighlightApi = typeof window.Highlight === 'function' && CSS.highlights;

function applySearchHighlights(pane) {
  const s = diffSearch[pane];
  if (supportsHighlightApi) {
    if (s.matches.length) {
      CSS.highlights.set(`diff-search-${pane}`, new Highlight(...s.matches.map(m => m.range)));
    }
  } else {
    s.matches.forEach(m => m.lineEl.classList.add('diff-search-line'));
  }
}

function clearSearchHighlights(pane) {
  if (supportsHighlightApi) {
    CSS.highlights.delete(`diff-search-${pane}`);
    CSS.highlights.delete(`diff-search-current-${pane}`);
  }
  const paneEl = diffPaneEl(pane);
  if (paneEl) {
    paneEl.querySelectorAll('.diff-search-line, .diff-search-current-line').forEach(el => {
      el.classList.remove('diff-search-line', 'diff-search-current-line');
    });
  }
}

function goToMatch(pane, idx) {
  const s = diffSearch[pane];
  if (!s.matches.length) return;
  s.currentIdx = ((idx % s.matches.length) + s.matches.length) % s.matches.length;
  const match = s.matches[s.currentIdx];

  if (supportsHighlightApi) {
    CSS.highlights.set(`diff-search-current-${pane}`, new Highlight(match.range));
  } else {
    const paneEl = diffPaneEl(pane);
    paneEl?.querySelectorAll('.diff-search-current-line').forEach(el => el.classList.remove('diff-search-current-line'));
    match.lineEl.classList.add('diff-search-current-line');
  }

  scrollMatchIntoView(pane, match);
  updateSearchCount(pane);
}

function scrollMatchIntoView(pane, match) {
  const paneEl = diffPaneEl(pane);
  if (!paneEl) return;

  paneEl.scrollTop = match.lineEl.offsetTop - paneEl.clientHeight / 3;

  const rect = match.range.getBoundingClientRect();
  const paneRect = paneEl.getBoundingClientRect();
  if (rect.left < paneRect.left || rect.right > paneRect.right) {
    paneEl.scrollLeft += rect.left - paneRect.left - 100;
  }
}

function updateSearchCount(pane) {
  const s = diffSearch[pane];
  if (!s.countEl) return;
  if (!s.query) {
    s.countEl.textContent = '';
  } else if (!s.matches.length) {
    s.countEl.textContent = '0';
  } else {
    s.countEl.textContent = `${s.currentIdx + 1}/${s.matches.length}`;
  }
}

// Split highlighted HTML back into lines while preserving tags
function splitHighlightedLines(highlightedHtml, expectedLines) {
  const lines = [];
  let currentLine = '';
  let openTags = [];

  const chars = highlightedHtml.split('');
  let inTag = false;
  let currentTag = '';

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];

    if (char === '<') {
      inTag = true;
      currentTag = '<';
    } else if (char === '>') {
      inTag = false;
      currentTag += '>';
      currentLine += currentTag;

      // Track open/close tags
      if (currentTag.startsWith('</')) {
        openTags.pop();
      } else if (!currentTag.endsWith('/>') && !currentTag.startsWith('<!')) {
        const tagName = currentTag.match(/<(\w+)/)?.[1];
        if (tagName) openTags.push(tagName);
      }
      currentTag = '';
    } else if (inTag) {
      currentTag += char;
    } else if (char === '\n') {
      // Close all open tags at end of line
      let closeTags = '';
      for (let j = openTags.length - 1; j >= 0; j--) {
        closeTags += `</${openTags[j]}>`;
      }
      lines.push(currentLine + closeTags);

      // Reopen tags at start of next line
      currentLine = '';
      for (const tag of openTags) {
        currentLine += `<span class="hljs-${tag}">`;
      }
    } else {
      currentLine += char;
    }
  }

  // Push last line
  if (currentLine || lines.length < expectedLines) {
    let closeTags = '';
    for (let j = openTags.length - 1; j >= 0; j--) {
      closeTags += `</${openTags[j]}>`;
    }
    lines.push(currentLine + closeTags);
  }

  return lines;
}

// Setup synchronized scrolling between diff panes
function setupDiffSyncScroll(oldEl, newEl) {
  let activeScroller = null;
  let scrollTimeout = null;

  const handleScroll = (source, target, sourceName) => {
    // If another element is actively scrolling, ignore
    if (activeScroller && activeScroller !== sourceName) return;

    activeScroller = sourceName;

    // Sync by scroll percentage
    const maxScroll = source.scrollHeight - source.clientHeight;
    if (maxScroll > 0) {
      const scrollPercentage = source.scrollTop / maxScroll;
      const targetMaxScroll = target.scrollHeight - target.clientHeight;
      target.scrollTop = scrollPercentage * targetMaxScroll;
    }

    // Reset active scroller after scrolling stops
    if (scrollTimeout) clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
      activeScroller = null;
    }, 150);
  };

  oldEl.addEventListener('scroll', () => handleScroll(oldEl, newEl, 'old'), { passive: true });
  newEl.addEventListener('scroll', () => handleScroll(newEl, oldEl, 'new'), { passive: true });
}

// Setup diff line selection
function setupDiffSelection(paneEl, rawLines, paneType) {
  state.diffSelection.rawLines = state.diffSelection.rawLines || {};
  state.diffSelection.rawLines[paneType] = rawLines;

  paneEl.addEventListener('click', (e) => {
    const lineEl = e.target.closest('.diff-line');
    if (!lineEl || !lineEl.dataset.line) return;

    const lineNum = parseInt(lineEl.dataset.line, 10);
    const clickedPane = lineEl.dataset.pane;

    // If shift key is held and we have a start selection in the same pane
    if (e.shiftKey && state.diffSelection.active && state.diffSelection.pane === clickedPane) {
      state.diffSelection.endLine = lineNum;
      updateDiffSelectionHighlight();
      showDiffCopyButton();
    } else {
      // Start new selection
      clearDiffSelection();
      state.diffSelection.active = true;
      state.diffSelection.pane = clickedPane;
      state.diffSelection.startLine = lineNum;
      state.diffSelection.endLine = lineNum;
      updateDiffSelectionHighlight();
      showDiffCopyButton();
    }
  });
}

// Update visual highlighting of selected lines
function updateDiffSelectionHighlight() {
  // Clear previous selection
  document.querySelectorAll('.diff-line.diff-selected').forEach(el => {
    el.classList.remove('diff-selected');
  });

  if (!state.diffSelection.active) return;

  const { pane, startLine, endLine } = state.diffSelection;
  const minLine = Math.min(startLine, endLine);
  const maxLine = Math.max(startLine, endLine);

  // Highlight lines in the selected range
  const paneEl = pane === 'old'
    ? document.getElementById('diffOldContent')
    : document.getElementById('diffNewContent');

  if (!paneEl) return;

  paneEl.querySelectorAll('.diff-line').forEach(el => {
    const lineNum = parseInt(el.dataset.line, 10);
    if (lineNum >= minLine && lineNum <= maxLine) {
      el.classList.add('diff-selected');
    }
  });
}

// Show copy button for selection
function showDiffCopyButton() {
  // Remove existing copy button
  const existingBtn = document.querySelector('.diff-copy-btn');
  if (existingBtn) existingBtn.remove();

  if (!state.diffSelection.active) return;

  const { pane, startLine, endLine } = state.diffSelection;
  const minLine = Math.min(startLine, endLine);
  const maxLine = Math.max(startLine, endLine);

  // Create copy button
  const btn = document.createElement('button');
  btn.className = 'diff-copy-btn';
  btn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
    </svg>
    Copy (${minLine}-${maxLine})
  `;
  btn.onclick = () => copyDiffSelection();

  // Find the diff pane header and append button
  const paneEl = pane === 'old'
    ? document.querySelector('.diff-pane.old-content')
    : document.querySelector('.diff-pane.new-content');

  if (paneEl) {
    const header = paneEl.querySelector('.diff-pane-header');
    if (header) {
      header.appendChild(btn);
    }
  }
}

// Copy selected lines to clipboard
async function copyDiffSelection() {
  if (!state.diffSelection.active) return;

  const { pane, startLine, endLine, filePath, rawLines } = state.diffSelection;
  const minLine = Math.min(startLine, endLine);
  const maxLine = Math.max(startLine, endLine);

  const lines = rawLines[pane] || [];
  const selectedLines = lines.slice(minLine - 1, maxLine);

  // Format: filepath:startLine-endLine\n<content>
  const header = `// ${filePath}:${minLine}-${maxLine}`;
  const content = selectedLines.join('\n');
  const textToCopy = `${header}\n${content}`;

  try {
    await navigator.clipboard.writeText(textToCopy);

    // Show feedback
    const btn = document.querySelector('.diff-copy-btn');
    if (btn) {
      btn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        Copied!
      `;
      btn.classList.add('copied');
      setTimeout(() => {
        clearDiffSelection();
      }, 1500);
    }
  } catch (err) {
    console.error('Failed to copy:', err);
  }
}

// Clear diff selection
export function clearDiffSelection() {
  state.diffSelection.active = false;
  state.diffSelection.pane = null;
  state.diffSelection.startLine = null;
  state.diffSelection.endLine = null;

  // Remove visual selection
  document.querySelectorAll('.diff-line.diff-selected').forEach(el => {
    el.classList.remove('diff-selected');
  });

  // Remove copy button
  const btn = document.querySelector('.diff-copy-btn');
  if (btn) btn.remove();
}
