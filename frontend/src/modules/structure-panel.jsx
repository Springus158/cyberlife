// Structure Panel - File tree and code editor with syntax highlighting

import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import hljs from 'highlight.js';

import { state } from './state.js';
import { registerStateHandler } from './project-switcher.js';
import { GetProjectStructure, ReadFileContent, SaveFileContent } from '../../wailsjs/go/main/App';
import { attachGitPanel } from './git.js';

// Import highlight.js theme
import 'highlight.js/styles/github-dark.css';

// ============================================
// Constants
// ============================================

export const STRUCTURE_TAB_ID = 'tab-structure';

// ============================================
// State
// ============================================

let panelRoot = null;
let currentStructure = null;

// ============================================
// File Icons & Language Detection
// ============================================

const FILE_ICONS = {
  '.js': '📜',
  '.jsx': '⚛️',
  '.ts': '💠',
  '.tsx': '⚛️',
  '.mjs': '📜',
  '.mts': '💠',
  '.cjs': '📜',
  '.cts': '💠',
  '.vue': '💚',
  '.svelte': '🔥',
};

const EXT_TO_LANGUAGE = {
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mjs': 'javascript',
  '.mts': 'typescript',
  '.cjs': 'javascript',
  '.cts': 'typescript',
  '.vue': 'xml',
  '.svelte': 'xml',
  '.json': 'json',
  '.css': 'css',
  '.scss': 'scss',
  '.html': 'html',
  '.md': 'markdown',
};

function getFileIcon(filename) {
  const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase();
  return FILE_ICONS[ext] || '📄';
}

function getLanguage(filename) {
  const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase();
  return EXT_TO_LANGUAGE[ext] || 'plaintext';
}

// ============================================
// Custom File Tree Component
// ============================================

function TreeNode({ node, depth = 0, expanded, onToggle, selected, onSelect }) {
  const isExpanded = expanded.has(node.path);
  const isSelected = selected === node.path;
  const hasChildren = node.children && node.children.length > 0;

  const handleClick = (e) => {
    e.stopPropagation();
    onSelect(node.path, node.isDir);
    if (node.isDir && hasChildren) {
      onToggle(node.path);
    }
  };

  return (
    <div className="tree-node">
      <div
        className={`tree-node-item ${isSelected ? 'selected' : ''}`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={handleClick}
      >
        {node.isDir ? (
          <span className="tree-arrow">
            {hasChildren ? (isExpanded ? '▼' : '▶') : '　'}
          </span>
        ) : (
          <span className="tree-arrow">　</span>
        )}
        <span className="tree-icon">
          {node.isDir ? (isExpanded ? '📂' : '📁') : getFileIcon(node.name)}
        </span>
        <span className="tree-name">{node.name}</span>
        {node.isDir && node.fileCount > 0 && (
          <span className="tree-count">{node.fileCount}</span>
        )}
      </div>
      {node.isDir && isExpanded && hasChildren && (
        <div className="tree-children">
          {node.children.map(child => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              selected={selected}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FileTreeComponent({ structure, selectedPath, onSelect }) {
  const [expanded, setExpanded] = useState(new Set());

  const handleToggle = useCallback((path) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  // Auto-expand root on first render
  useEffect(() => {
    if (structure && expanded.size === 0) {
      setExpanded(new Set([structure.path]));
    }
  }, [structure]);

  if (!structure) {
    return <div className="tree-empty">No structure loaded</div>;
  }

  return (
    <div className="file-tree">
      <TreeNode
        node={structure}
        depth={0}
        expanded={expanded}
        onToggle={handleToggle}
        selected={selectedPath}
        onSelect={onSelect}
      />
    </div>
  );
}

// ============================================
// Code Editor Component
// ============================================

const supportsHighlightApi = typeof window.Highlight === 'function' && CSS.highlights;
const SEARCH_MATCH_CAP = 5000;

// Build Ranges over the element's text nodes for sorted [{start, end}] offsets
// in its concatenated textContent — single pass, survives hljs spans.
function buildRangesForOffsets(rootEl, offsetPairs) {
  const ranges = [];
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  let pos = 0;

  for (const { start, end } of offsetPairs) {
    while (node && pos + node.textContent.length <= start) {
      pos += node.textContent.length;
      node = walker.nextNode();
    }
    if (!node) break;

    const range = new Range();
    range.setStart(node, start - pos);

    while (node && pos + node.textContent.length < end) {
      pos += node.textContent.length;
      node = walker.nextNode();
    }
    if (!node) break;

    range.setEnd(node, end - pos);
    ranges.push(range);
  }

  return ranges;
}

function scrollRangeIntoView(range, scroller) {
  if (!scroller) return;
  const rect = range.getBoundingClientRect();
  const scRect = scroller.getBoundingClientRect();
  scroller.scrollTop += rect.top - scRect.top - scroller.clientHeight / 3;
  if (rect.left < scRect.left || rect.right > scRect.right) {
    scroller.scrollLeft += rect.left - scRect.left - 100;
  }
}

function CodeEditor({ filePath, content, originalContent, loading, error, onChange, onSave, onDiscard, saving }) {
  const textareaRef = useRef(null);
  const highlightRef = useRef(null);
  const searchInputRef = useRef(null);
  const lastScrollKey = useRef('');
  const [scrollTop, setScrollTop] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [matchIdx, setMatchIdx] = useState(0);

  const hasChanges = content !== originalContent;

  const matches = useMemo(() => {
    if (!searchQuery || !content) return [];
    const result = [];
    const lowerContent = content.toLowerCase();
    const lowerQuery = searchQuery.toLowerCase();
    let idx = 0;
    while ((idx = lowerContent.indexOf(lowerQuery, idx)) !== -1 && result.length < SEARCH_MATCH_CAP) {
      result.push(idx);
      idx += searchQuery.length;
    }
    return result;
  }, [content, searchQuery]);

  useEffect(() => {
    setMatchIdx(0);
  }, [matches]);

  useEffect(() => {
    if (!supportsHighlightApi) return;
    CSS.highlights.delete('code-search');
    CSS.highlights.delete('code-search-current');
    if (!highlightRef.current || !matches.length) return;

    const pairs = matches.map(start => ({ start, end: start + searchQuery.length }));
    const ranges = buildRangesForOffsets(highlightRef.current, pairs);
    if (!ranges.length) return;

    CSS.highlights.set('code-search', new Highlight(...ranges));
    const current = ranges[matchIdx];
    if (current) {
      CSS.highlights.set('code-search-current', new Highlight(current));
      // Scroll only on query/index change, not while the file is being edited
      const scrollKey = `${filePath}:${searchQuery}:${matchIdx}`;
      if (lastScrollKey.current !== scrollKey) {
        lastScrollKey.current = scrollKey;
        scrollRangeIntoView(current, textareaRef.current);
      }
    }

    return () => {
      CSS.highlights.delete('code-search');
      CSS.highlights.delete('code-search-current');
    };
  }, [matches, matchIdx, searchQuery, filePath, content]);

  const goToMatch = (dir) => {
    if (!matches.length) return;
    setMatchIdx(i => ((i + dir) % matches.length + matches.length) % matches.length);
  };

  const handleSearchKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      goToMatch(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      setSearchQuery('');
      textareaRef.current?.focus();
    }
  };

  const highlightedCode = useMemo(() => {
    if (!content) return '';

    const language = getLanguage(filePath || '');

    try {
      if (language && hljs.getLanguage(language)) {
        return hljs.highlight(content, { language }).value;
      }
      return hljs.highlightAuto(content).value;
    } catch (e) {
      return content
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }
  }, [content, filePath]);

  const lines = useMemo(() => {
    if (!content) return [];
    return content.split('\n');
  }, [content]);

  const handleScroll = (e) => {
    setScrollTop(e.target.scrollTop);
    if (highlightRef.current) {
      highlightRef.current.scrollTop = e.target.scrollTop;
      highlightRef.current.scrollLeft = e.target.scrollLeft;
    }
  };

  const handleChange = (e) => {
    onChange(e.target.value);
  };

  const handleKeyDown = (e) => {
    // Handle Tab key for indentation
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = e.target.selectionStart;
      const end = e.target.selectionEnd;
      const value = e.target.value;
      const newValue = value.substring(0, start) + '  ' + value.substring(end);
      onChange(newValue);
      // Set cursor position after the tab
      setTimeout(() => {
        e.target.selectionStart = e.target.selectionEnd = start + 2;
      }, 0);
    }
    // Ctrl/Cmd + S to save
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      if (hasChanges && !saving) {
        onSave();
      }
    }
    // Ctrl/Cmd + F to focus search
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }
  };

  const fileName = filePath ? filePath.split('/').pop() : '';

  if (!filePath) {
    return (
      <div className="code-editor-empty">
        <div className="empty-icon">📄</div>
        <div className="empty-text">Select a file to view and edit</div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="code-editor-loading">
        <div className="loading-spinner"></div>
        <div>Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="code-editor-error">
        <div className="error-icon">⚠️</div>
        <div className="error-text">{error}</div>
      </div>
    );
  }

  return (
    <div className="code-editor">
      <div className="code-editor-header">
        <span className="file-icon">{getFileIcon(fileName)}</span>
        <span className="file-name">
          {fileName}
          {hasChanges && <span className="unsaved-indicator">●</span>}
        </span>
        <span className="file-path">{filePath}</span>
        <div className="code-search">
          <input
            ref={searchInputRef}
            type="text"
            className="code-search-input"
            placeholder="Search..."
            spellCheck={false}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
          />
          <span className="code-search-count">
            {searchQuery ? (matches.length ? `${matchIdx + 1}/${matches.length}` : '0') : ''}
          </span>
          <button className="code-search-btn" title="Previous match (Shift+Enter)" onClick={() => goToMatch(-1)}>▲</button>
          <button className="code-search-btn" title="Next match (Enter)" onClick={() => goToMatch(1)}>▼</button>
        </div>
        <span className="line-count">{lines.length} lines</span>
      </div>
      <div className="code-editor-content">
        <div className="line-numbers">
          {lines.map((_, i) => (
            <div key={i} className="line-number">{i + 1}</div>
          ))}
        </div>
        <div className="editor-wrapper">
          <pre
            ref={highlightRef}
            className="highlight-layer hljs"
            dangerouslySetInnerHTML={{ __html: highlightedCode + '\n' }}
          />
          <textarea
            ref={textareaRef}
            className="edit-layer"
            value={content}
            onChange={handleChange}
            onScroll={handleScroll}
            onKeyDown={handleKeyDown}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
          />
        </div>
      </div>
    </div>
  );
}

// ============================================
// Main Structure Panel Component
// ============================================

// Always-present git diff panel at the bottom of the file tree — the
// sidebar git widget is optional, this one is not
function FilesGitPanel() {
  const ref = useRef(null);
  useEffect(() => {
    attachGitPanel(ref.current);
  }, []);
  return <div className="files-git-panel" ref={ref}></div>;
}

function StructurePanelComponent({ structure }) {
  const [selectedPath, setSelectedPath] = useState(null);
  const [originalContent, setOriginalContent] = useState(null);
  const [editedContent, setEditedContent] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const hasChanges = editedContent !== null && originalContent !== null && editedContent !== originalContent;

  const handleSelect = useCallback(async (path, isDir) => {
    // If there are unsaved changes, ask for confirmation
    if (hasChanges) {
      const confirm = window.confirm('You have unsaved changes. Discard them?');
      if (!confirm) return;
    }

    setSelectedPath(path);

    if (isDir) {
      setOriginalContent(null);
      setEditedContent(null);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    setOriginalContent(null);
    setEditedContent(null);

    try {
      const content = await ReadFileContent(path);
      setOriginalContent(content);
      setEditedContent(content);
    } catch (err) {
      setError(`Failed to load file: ${err.message || err}`);
    } finally {
      setLoading(false);
    }
  }, [hasChanges]);

  const handleChange = useCallback((newContent) => {
    setEditedContent(newContent);
  }, []);

  const handleSave = useCallback(async () => {
    if (!selectedPath || !hasChanges) return;

    setSaving(true);
    try {
      await SaveFileContent(selectedPath, editedContent);
      setOriginalContent(editedContent);
    } catch (err) {
      setError(`Failed to save file: ${err.message || err}`);
    } finally {
      setSaving(false);
    }
  }, [selectedPath, editedContent, hasChanges]);

  const handleDiscard = useCallback(() => {
    if (originalContent !== null) {
      setEditedContent(originalContent);
    }
  }, [originalContent]);

  if (!structure) {
    return (
      <div className="structure-empty">
        <p>No project selected or no JS/TS files found.</p>
      </div>
    );
  }

  return (
    <div className="structure-panel-content">
      <div className="structure-sidebar">
        <div className="structure-sidebar-header">
          <div className="sidebar-title">
            <span className="structure-icon">🗂️</span>
            <span>Files</span>
          </div>
          <div className="sidebar-actions">
            <button
              className={`action-btn save-btn ${hasChanges ? 'enabled' : 'disabled'}`}
              onClick={handleSave}
              disabled={!hasChanges || saving}
              title="Save (Ctrl+S)"
            >
              {saving ? '...' : 'Save'}
            </button>
            <button
              className={`action-btn discard-btn ${hasChanges ? 'enabled' : 'disabled'}`}
              onClick={handleDiscard}
              disabled={!hasChanges}
              title="Discard changes"
            >
              Discard
            </button>
          </div>
        </div>
        <FileTreeComponent
          structure={structure}
          selectedPath={selectedPath}
          onSelect={handleSelect}
        />
        <FilesGitPanel />
      </div>
      <div className="structure-resizer" id="structureResizer"></div>
      <div className="structure-content">
        <CodeEditor
          filePath={selectedPath}
          content={editedContent}
          originalContent={originalContent}
          loading={loading}
          error={error}
          onChange={handleChange}
          onSave={handleSave}
          onDiscard={handleDiscard}
          saving={saving}
        />
      </div>
    </div>
  );
}

// ============================================
// Vanilla JS API
// ============================================

export function initStructurePanel() {
  addStructurePanelStyles();
}

function renderStructurePanel() {
  const container = document.getElementById('structurePanel');
  if (!container) return;

  if (!panelRoot) {
    panelRoot = createRoot(container);
  }

  panelRoot.render(
    React.createElement(StructurePanelComponent, {
      structure: currentStructure
    })
  );
}

export function showStructurePanel(show) {
  const structurePanel = document.getElementById('structurePanel');
  const testsPanel = document.getElementById('testsPanel');
  const browserInnerContent = document.getElementById('browserInnerContent');
  const dashboardPanel = document.getElementById('dashboardPanel');
  const qaPanel = document.getElementById('qaPanel');
  const gitPanel = document.getElementById('gitHistoryPanel');

  if (structurePanel) {
    structurePanel.style.display = show ? 'flex' : 'none';
  }

  if (show) {
    if (testsPanel) testsPanel.style.display = 'none';
    if (browserInnerContent) browserInnerContent.style.display = 'none';
    if (dashboardPanel) dashboardPanel.style.display = 'none';
    if (qaPanel) qaPanel.style.display = 'none';
    if (gitPanel) gitPanel.style.display = 'none';
    renderStructurePanel();
  }
}

export function switchToStructureTab() {
  document.querySelectorAll('.tab-frame').forEach(iframe => {
    iframe.classList.remove('active');
    iframe.style.display = 'none';
  });
  showStructurePanel(true);
}

export function isStructureTabActive() {
  return state.shell.activeTabId === STRUCTURE_TAB_ID;
}

export async function loadProjectStructure() {
  if (!state.activeProject) {
    currentStructure = null;
    renderStructurePanel();
    return;
  }

  try {
    const structure = await GetProjectStructure(state.activeProject.path);
    currentStructure = structure;

    if (isStructureTabActive()) {
      renderStructurePanel();
    }
  } catch (err) {
    console.error('[Structure] Failed to load project structure:', err);
    currentStructure = null;
  }
}

// ============================================
// Project Switcher Handler
// ============================================

export function initStructureHandler() {
  registerStateHandler('structure', {
    priority: 85,

    onBeforeSwitch: async (ctx) => {
      currentStructure = null;
    },

    onSave: async (ctx) => {},

    onLoad: async (ctx) => {
      await loadProjectStructure();
    },

    onAfterSwitch: async (ctx) => {
      if (isStructureTabActive()) {
        renderStructurePanel();
      }
    }
  });
}

// ============================================
// Styles
// ============================================

function addStructurePanelStyles() {
  if (document.getElementById('structure-panel-styles')) return;

  const style = document.createElement('style');
  style.id = 'structure-panel-styles';
  style.textContent = `
    /* Structure Panel */
    .structure-panel {
      display: flex;
      flex: 1;
      overflow: hidden;
      background: #0f172a;
    }

    .structure-panel-content {
      display: flex;
      flex: 1;
      overflow: hidden;
    }

    .structure-empty {
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 1;
      color: #64748b;
      font-size: 14px;
    }

    /* Sidebar with file tree */
    .structure-sidebar {
      width: 280px;
      min-width: 200px;
      max-width: 400px;
      background: #1e293b;
      border-right: 1px solid #334155;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .structure-sidebar-header {
      padding: 8px 12px;
      border-bottom: 1px solid #334155;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .sidebar-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 500;
      color: #e2e8f0;
      font-size: 13px;
    }

    .sidebar-actions {
      display: flex;
      gap: 6px;
    }

    .action-btn {
      padding: 4px 10px;
      font-size: 11px;
      font-weight: 500;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.15s;
    }

    .action-btn.save-btn {
      background: #22c55e;
      color: #fff;
    }

    .action-btn.save-btn:hover:not(:disabled) {
      background: #16a34a;
    }

    .action-btn.discard-btn {
      background: #475569;
      color: #e2e8f0;
    }

    .action-btn.discard-btn:hover:not(:disabled) {
      background: #64748b;
    }

    .action-btn.disabled,
    .action-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .structure-icon {
      font-size: 16px;
    }

    /* Custom File Tree */
    .file-tree {
      flex: 1;
      overflow-y: auto;
      padding: 8px 0;
    }

    .tree-node-item {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 5px 8px;
      cursor: pointer;
      color: #e2e8f0;
      font-size: 13px;
      border-radius: 4px;
      margin: 1px 4px;
      transition: background 0.15s;
    }

    .tree-node-item:hover {
      background: rgba(139, 92, 246, 0.15);
    }

    .tree-node-item.selected {
      background: rgba(139, 92, 246, 0.25);
      border-left: 2px solid #8b5cf6;
    }

    .tree-arrow {
      width: 14px;
      font-size: 10px;
      color: #64748b;
      flex-shrink: 0;
    }

    .tree-icon {
      font-size: 14px;
      flex-shrink: 0;
    }

    .tree-name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .tree-count {
      font-size: 10px;
      color: #64748b;
      background: #334155;
      padding: 1px 6px;
      border-radius: 10px;
    }

    .tree-empty {
      padding: 20px;
      color: #64748b;
      text-align: center;
    }

    /* Resizer */
    .structure-resizer {
      width: 4px;
      background: #334155;
      cursor: col-resize;
      transition: background 0.2s;
    }

    .structure-resizer:hover,
    .structure-resizer.active {
      background: #8b5cf6;
    }

    /* Content area */
    .structure-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      background: #0f172a;
      overflow: hidden;
    }

    /* Code Editor */
    .code-editor {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .code-editor-header {
      padding: 10px 16px;
      background: #1e293b;
      border-bottom: 1px solid #334155;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
    }

    .code-editor-header .file-icon {
      font-size: 16px;
    }

    .code-editor-header .file-name {
      font-weight: 500;
      color: #e2e8f0;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .unsaved-indicator {
      color: #f59e0b;
      font-size: 10px;
    }

    .code-editor-header .file-path {
      flex: 1;
      color: #64748b;
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .code-editor-header .line-count {
      color: #64748b;
      font-size: 11px;
      background: #334155;
      padding: 2px 8px;
      border-radius: 10px;
    }

    /* Editor search */
    .code-search {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .code-search-input {
      width: 160px;
      padding: 3px 8px;
      background: #0d1117;
      border: 1px solid #334155;
      border-radius: 4px;
      color: #e2e8f0;
      font-size: 11px;
      outline: none;
    }

    .code-search-input:focus {
      border-color: #8b5cf6;
    }

    .code-search-count {
      min-width: 42px;
      text-align: center;
      font-size: 11px;
      color: #64748b;
      font-family: 'SF Mono', 'Fira Code', 'Monaco', 'Consolas', monospace;
      white-space: nowrap;
    }

    .code-search-btn {
      width: 22px;
      height: 22px;
      padding: 0;
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 4px;
      color: #94a3b8;
      font-size: 9px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s;
    }

    .code-search-btn:hover {
      background: #334155;
      color: #a78bfa;
      border-color: #8b5cf6;
    }

    ::highlight(code-search) {
      background-color: rgba(250, 204, 21, 0.3);
    }

    ::highlight(code-search-current) {
      background-color: rgba(250, 204, 21, 0.9);
      color: #1a1a1a;
    }

    .code-editor-content {
      flex: 1;
      display: flex;
      overflow: hidden;
      background: #0d1117;
    }

    .line-numbers {
      flex-shrink: 0;
      padding: 12px 0;
      background: #0d1117;
      border-right: 1px solid #334155;
      text-align: right;
      user-select: none;
      overflow: hidden;
    }

    .line-numbers .line-number {
      padding: 0 12px;
      font-family: 'SF Mono', 'Fira Code', 'Monaco', 'Consolas', monospace;
      font-size: 13px;
      line-height: 1.5;
      color: #64748b;
      height: 20px;
    }

    .editor-wrapper {
      flex: 1;
      position: relative;
      overflow: auto;
    }

    .highlight-layer,
    .edit-layer {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      min-height: 100%;
      margin: 0;
      padding: 12px 16px;
      font-family: 'SF Mono', 'Fira Code', 'Monaco', 'Consolas', monospace;
      font-size: 13px;
      line-height: 1.5;
      white-space: pre;
      overflow: hidden;
      box-sizing: border-box;
    }

    .highlight-layer {
      pointer-events: none;
      color: #e2e8f0;
      z-index: 1;
    }

    .edit-layer {
      background: transparent;
      color: transparent;
      caret-color: #e2e8f0;
      border: none;
      outline: none;
      resize: none;
      z-index: 2;
      overflow: auto;
    }

    .edit-layer::selection {
      background: rgba(139, 92, 246, 0.3);
    }

    /* Empty/Loading/Error states */
    .code-editor-empty,
    .code-editor-loading,
    .code-editor-error {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      color: #64748b;
    }

    .empty-icon,
    .error-icon {
      font-size: 48px;
      opacity: 0.5;
    }

    .empty-text,
    .error-text {
      font-size: 14px;
    }

    .code-editor-error {
      color: #f87171;
    }

    .loading-spinner {
      width: 32px;
      height: 32px;
      border: 3px solid #334155;
      border-top-color: #8b5cf6;
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    /* Browser tab style for Structure */
    .browser-tab.structure-tab {
      background: transparent;
      border: 1px solid transparent;
    }

    .browser-tab.structure-tab:hover {
      background: rgba(139, 92, 246, 0.1);
      border-color: rgba(139, 92, 246, 0.3);
    }

    .browser-tab.structure-tab.active {
      background: rgba(139, 92, 246, 0.15);
      border-color: #8b5cf6;
      color: #a78bfa;
    }

    .browser-tab.structure-tab .tab-icon {
      margin-right: 4px;
    }
  `;
  document.head.appendChild(style);
}

// ============================================
// Keyboard (shell NORMAL-mode module hook): j/k walk the file tree,
// Enter opens the file / toggles the folder — same as a mouse click
// ============================================

export function structureModuleOnKey(e) {
  const items = [...document.querySelectorAll('#structurePanel .tree-node-item')]
    .filter(el => el.offsetParent !== null);
  if (!items.length) return false;

  const cursorIdx = () => {
    const kb = items.findIndex(el => el.classList.contains('kb-selected'));
    if (kb !== -1) return kb;
    return items.findIndex(el => el.classList.contains('selected'));
  };
  const setCursor = (i) => {
    items.forEach((el, n) => el.classList.toggle('kb-selected', n === i));
    items[i]?.scrollIntoView({ block: 'nearest' });
  };

  switch (e.key) {
    case 'j':
    case 'ArrowDown':
      e.preventDefault();
      setCursor(Math.min(items.length - 1, cursorIdx() + 1));
      return true;
    case 'k':
    case 'ArrowUp':
      e.preventDefault();
      setCursor(Math.max(0, cursorIdx() - 1));
      return true;
    case 'Enter':
    case 'l': {
      const i = cursorIdx();
      if (i === -1) return false;
      e.preventDefault();
      items[i].click();
      // React re-renders and wipes the cursor class — repaint on the same row
      setTimeout(() => {
        const fresh = [...document.querySelectorAll('#structurePanel .tree-node-item')]
          .filter(el => el.offsetParent !== null);
        fresh[Math.min(i, fresh.length - 1)]?.classList.add('kb-selected');
      }, 50);
      return true;
    }
  }
  return false;
}
