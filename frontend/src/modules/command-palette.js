// Cmd+K command palette: fuzzy search over modules, projects and every
// action in the shortcut registry. Each result shows its keyboard shortcut
// — the palette doubles as a key coach: run anything from here, and the
// hint on the right teaches you the direct key for next time.

import { state } from './state.js';
import { searchNormalize, escapeHtml } from './utils.js';
import { getModules, getVisibleModules, openModuleOrderModal } from './shell.js';
import { SHORTCUT_SECTIONS } from './shortcuts-data.js';
import { openProjectSwitcher } from './quick-switcher.js';
import { togglePomodoro } from './pomodoro.js';
import { toggleWidgetSidebar } from './widgets.js';

let paletteState = null; // { entries, filtered, selected }

export function isCommandPaletteOpen() {
  return !!document.getElementById('commandPalette');
}

// Digits follow the user's tab order; hidden modules (Health, user-hidden
// tabs) are still runnable here, just without a digit
function moduleEntries() {
  const visible = getVisibleModules();
  const entries = visible.map((m, i) => ({
    icon: m.icon,
    title: `Go to ${m.label}`,
    group: 'Modules',
    keys: i < 9 ? [String(i + 1)] : [],
    run: () => m.switchTo(),
  }));
  for (const m of getModules()) {
    if (!visible.includes(m)) {
      entries.push({ icon: m.icon, title: `Go to ${m.label}`, group: 'Modules', keys: [], run: () => m.switchTo() });
    }
  }
  return entries;
}

function projectEntries() {
  return (state.projects || []).map(p => ({
    icon: p.icon || '📁',
    title: `Project: ${p.name}`,
    group: 'Projects',
    keys: ['p'],
    run: () => window.itermSelectProject?.(p.name),
  }));
}

function commandEntries() {
  return [
    { icon: '🔀', title: 'Project switcher', group: 'Commands', keys: ['p'], run: () => openProjectSwitcher() },
    { icon: '🧱', title: 'Toggle widget sidebar', group: 'Commands', keys: ['w'], run: () => toggleWidgetSidebar() },
    { icon: '🍅', title: 'Pomodoro', group: 'Commands', keys: ['⌘', 'P'], run: () => togglePomodoro() },
    { icon: '🎙️', title: 'Voice input', group: 'Commands', keys: ['⌘', 'R'], run: () => window.itermToggleVoice?.() },
    { icon: '⌨️', title: 'Keyboard shortcuts', group: 'Commands', keys: ['?'], run: () => window.showShortcutsModal?.() },
    { icon: '⇅', title: 'Reorder module tabs', group: 'Commands', keys: ['⇧', 'T'], run: () => openModuleOrderModal() },
  ];
}

// Every module-scoped shortcut row becomes a "key coach" entry: running it
// navigates to the module; the shown key is the lesson
function shortcutEntries() {
  const modules = getModules();
  const out = [];
  for (const section of SHORTCUT_SECTIONS) {
    if (!section.moduleId) continue;
    const mod = modules.find(m => m.id === section.moduleId);
    if (!mod) continue;
    for (const row of section.rows) {
      out.push({
        icon: mod.icon,
        title: `${section.title}: ${row.desc}`,
        group: 'Actions',
        keys: row.keys,
        run: () => mod.switchTo(),
      });
    }
  }
  return out;
}

function buildEntries() {
  return [...moduleEntries(), ...projectEntries(), ...commandEntries(), ...shortcutEntries()];
}

export function openCommandPalette() {
  closeCommandPalette();
  paletteState = { entries: buildEntries(), filtered: [], selected: 0, query: '' };

  const overlay = document.createElement('div');
  overlay.id = 'commandPalette';
  overlay.className = 'palette-overlay';
  overlay.innerHTML = `
    <div class="palette-box">
      <input type="text" id="paletteInput" class="palette-input" placeholder="Type a command, module, project or action…"
             autocomplete="off" spellcheck="false" />
      <div class="palette-results" id="paletteResults"></div>
      <div class="palette-hint">↑↓ move · ↵ run · the key on the right is the direct shortcut · Esc close</div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = overlay.querySelector('#paletteInput');
  input.addEventListener('input', () => {
    paletteState.query = input.value;
    paletteState.selected = 0;
    renderResults();
  });
  overlay.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      closeCommandPalette();
      return;
    }
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
      e.preventDefault();
      paletteState.selected = Math.min(paletteState.filtered.length - 1, paletteState.selected + 1);
      renderResults();
      return;
    }
    if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
      e.preventDefault();
      paletteState.selected = Math.max(0, paletteState.selected - 1);
      renderResults();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      runSelected();
    }
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeCommandPalette();
  });

  renderResults();
  input.focus();
}

export function closeCommandPalette() {
  document.getElementById('commandPalette')?.remove();
  paletteState = null;
}

function filterEntries() {
  const q = searchNormalize(paletteState.query.trim());
  if (!q) {
    // Empty query: navigation first, actions on demand
    return paletteState.entries.filter(e => e.group !== 'Actions').slice(0, 14);
  }
  const terms = q.split(/\s+/);
  return paletteState.entries
    .filter(e => {
      const hay = searchNormalize(`${e.group} ${e.title}`);
      return terms.every(t => hay.includes(t));
    })
    .slice(0, 14);
}

function renderResults() {
  const host = document.getElementById('paletteResults');
  if (!host || !paletteState) return;
  paletteState.filtered = filterEntries();
  if (!paletteState.filtered.length) {
    host.innerHTML = '<div class="palette-empty">No matches</div>';
    return;
  }
  let lastGroup = null;
  host.innerHTML = paletteState.filtered.map((entry, i) => {
    const groupHeader = entry.group !== lastGroup
      ? `<div class="palette-group">${entry.group}</div>` : '';
    lastGroup = entry.group;
    return `
      ${groupHeader}
      <div class="palette-row ${i === paletteState.selected ? 'active' : ''}" data-index="${i}">
        <span class="palette-icon">${entry.icon}</span>
        <span class="palette-title">${escapeHtml(entry.title)}</span>
        <span class="palette-keys">${entry.keys.map(k => k === '…' ? '…' : `<kbd>${escapeHtml(k)}</kbd>`).join('')}</span>
      </div>
    `;
  }).join('');
  host.querySelectorAll('.palette-row').forEach(row => {
    row.addEventListener('click', () => {
      paletteState.selected = parseInt(row.dataset.index);
      runSelected();
    });
  });
  host.querySelector('.palette-row.active')?.scrollIntoView({ block: 'nearest' });
}

function runSelected() {
  const entry = paletteState?.filtered[paletteState.selected];
  if (!entry) return;
  closeCommandPalette();
  try {
    entry.run();
  } catch (err) {
    console.error('Palette command failed:', err, entry.title);
  }
}
