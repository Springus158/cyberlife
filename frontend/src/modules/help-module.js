// Help module: left section nav, rendered markdown content, `/` search.
// Guides are hand-maintained (help-content.js); Shortcuts, Modules and
// Agents & API generate themselves from the live registries, so those pages
// can never drift from the code.

import { getModules } from './shell.js';
import { searchNormalize } from './utils.js';
import { renderHelpMarkdown, decorateCodeBlocks } from './help-components.js';
import { generalSections, moduleSections, renderSingleSection } from './shortcuts-data.js';
import { HELP_GUIDES } from './help-content.js';
import { GetAgentSkills } from '../../wailsjs/go/main/App';

export const HELP_TAB_ID = 'help-tab';

const helpState = {
  activeId: 'getting-started',
  query: '',
  agentSkills: [],
};

export function showHelpPanel(show) {
  const panel = document.getElementById('helpPanel');
  if (panel) panel.style.display = show ? 'flex' : 'none';
}

function generatedSections() {
  return [
    {
      id: 'shortcuts',
      title: 'Keyboard Shortcuts',
      html: () => `
        <h1>Keyboard Shortcuts</h1>
        <h2>General — work everywhere</h2>
        <div class="shortcuts-grid help-shortcuts">${generalSections().map(renderSingleSection).join('')}</div>
        <h2>Per module</h2>
        <div class="shortcuts-grid help-shortcuts">${moduleSections().map(renderSingleSection).join('')}</div>
      `,
      text: () => 'keyboard shortcuts keys',
    },
    {
      id: 'modules',
      title: 'Modules',
      html: () => `
        <h1>Modules</h1>
        <p>Everything is a full-screen module on the top bar. Digits switch to the first nine.</p>
        <table class="help-table">
          <tr><th></th><th>Module</th><th>Key</th></tr>
          ${getModules().map((m, i) => `
            <tr><td>${m.icon}</td><td>${m.label}</td><td>${i < 9 ? `<kbd>${i + 1}</kbd>` : ''}</td></tr>
          `).join('')}
        </table>
      `,
      text: () => 'modules tabs ' + getModules().map(m => m.label).join(' '),
    },
    {
      id: 'agents-api',
      title: 'Agents & API',
      html: () => `
        <h1>Agents &amp; API</h1>
        <p>The local agent API runs at <code>http://127.0.0.1:8377</code> (REST + MCP at <code>/mcp</code>).
        Built-in skills below are installed to <code>~/.claude/skills</code>; toggle them in
        Settings → Agent Skills.</p>
        <table class="help-table">
          <tr><th>Skill</th><th>Description</th><th>Status</th></tr>
          ${helpState.agentSkills.map(s => `
            <tr><td><strong>${s.title}</strong></td>
            <td>${s.description}${s.available ? '' : `<br><em class="help-off">${s.note || ''}</em>`}</td>
            <td class="${!s.available ? 'help-off' : s.enabled ? 'help-on' : 'help-off'}">${!s.available ? 'not available' : s.enabled ? 'enabled' : 'disabled'}</td></tr>
          `).join('') || '<tr><td colspan="3">No built-in skills.</td></tr>'}
        </table>
      `,
      text: () => 'agents api mcp rest skills permissions ' + helpState.agentSkills.map(s => s.title).join(' '),
    },
  ];
}

function allSections() {
  const guides = HELP_GUIDES.map(g => ({
    id: g.id,
    title: g.title,
    html: () => renderHelpMarkdown(g.body),
    text: () => g.body.toLowerCase(),
  }));
  return [...guides, ...generatedSections()];
}

function matchingSections() {
  const q = searchNormalize(helpState.query.trim());
  const sections = allSections();
  if (!q) return sections;
  return sections.filter(s => searchNormalize(s.title).includes(q) || searchNormalize(s.text()).includes(q));
}

export async function renderHelpPanel() {
  const panel = document.getElementById('helpPanel');
  if (!panel) return;

  try {
    helpState.agentSkills = await GetAgentSkills() || [];
  } catch (err) {
    console.warn('Help: agent skills unavailable:', err);
  }

  const sections = matchingSections();
  if (!sections.some(s => s.id === helpState.activeId) && sections.length > 0) {
    helpState.activeId = sections[0].id;
  }
  const active = sections.find(s => s.id === helpState.activeId);

  panel.innerHTML = `
    <div class="help-layout">
      <div class="help-nav">
        <input type="text" id="helpSearchInput" class="board-filter" placeholder="/ search help"
               value="${helpState.query.replace(/"/g, '&quot;')}" autocomplete="off" spellcheck="false" />
        ${sections.map(s => `
          <button class="help-nav-item ${s.id === helpState.activeId ? 'active' : ''}" data-help-id="${s.id}">${s.title}</button>
        `).join('')}
        ${sections.length === 0 ? '<div class="help-empty">Nothing found</div>' : ''}
      </div>
      <div class="help-content" id="helpContent">
        ${active ? active.html() : ''}
      </div>
    </div>
  `;

  decorateCodeBlocks(panel.querySelector('#helpContent'));

  panel.querySelectorAll('.help-nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      helpState.activeId = btn.dataset.helpId;
      renderHelpPanel();
    });
  });
  const search = panel.querySelector('#helpSearchInput');
  search?.addEventListener('input', () => {
    helpState.query = search.value;
    const caret = search.selectionStart;
    renderHelpPanel().then(() => {
      const el = document.getElementById('helpSearchInput');
      if (el) {
        el.focus();
        el.setSelectionRange(caret, caret);
      }
    });
  });
}

export function helpModuleOnKey(e) {
  const sections = matchingSections();
  const idx = sections.findIndex(s => s.id === helpState.activeId);
  switch (e.key) {
    case 'j':
    case 'ArrowDown':
      if (idx < sections.length - 1) {
        e.preventDefault();
        helpState.activeId = sections[idx + 1].id;
        renderHelpPanel();
        return true;
      }
      return false;
    case 'k':
    case 'ArrowUp':
      if (idx > 0) {
        e.preventDefault();
        helpState.activeId = sections[idx - 1].id;
        renderHelpPanel();
        return true;
      }
      return false;
    case '/': {
      const input = document.getElementById('helpSearchInput');
      if (input) {
        e.preventDefault();
        input.focus();
        return true;
      }
      return false;
    }
  }
  return false;
}
