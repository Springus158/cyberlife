// Settings module - multi-tab settings page rendered as a closable main-panel tab.

import { escapeAttr, escapeHtml } from './utils.js';
import {
  GetElevenLabsAPIKey, SetElevenLabsAPIKey,
  GetTranscriptionEngine, SetTranscriptionEngine,
  GetVoiceLang, SetVoiceLang,
  GetVoiceAutoSubmit, SetVoiceAutoSubmit,
  GetTerminalTheme, SetTerminalTheme,
  GetTerminalFontSize, SetTerminalFontSize,
  GetDashboardFullscreen, SetDashboardFullscreen,
  GetGlobalPromptPrefix, SetGlobalPromptPrefix,
  GetGlobalPromptSuffix, SetGlobalPromptSuffix,
  GetJiraSettings, SetJiraSettings,
  GetGmailConfig, GetAgentSkills, SetAgentSkillEnabled, GetRunners, SaveRunner, DeleteRunner, SetGmailConfig, GmailAddAccount, GmailRemoveAccount, SetGmailMcpEnabled,
  GmailSetAccountMcp, GmailInstallMcp, GmailMcpInstalled, GmailReauthAccount,
  GetGlobalPrompts, GetProjectPrompts, CreatePrompt, CreateGlobalPrompt,
  UpdatePrompt, UpdateGlobalPrompt, DeletePrompt, DeleteGlobalPrompt,
  TogglePromptPinned, IncrementPromptUsage, WriteITermText,
  AddonsList, SetAddonEnabled, AddonsReload, OpenAddonsDir
} from '../../wailsjs/go/main/App';
import { applyPromptWrappers } from './tools-panel.js';
import { builtinOn, setBuiltinOn, builtinName } from './addon-state.js';
import { renderTabbedIconPicker, getPickedIcon } from './icon-catalog.js';
import { TERMINAL_THEMES } from './terminal-themes.js';
import { WIDGETS, widgetAvailable, getWidgetScopes, setWidgetScope, moveWidget, getWidthConfig, setWidthConfig } from './widgets.js';
import { getModules } from './shell.js';
import { state as appState } from './state.js';

export const SETTINGS_TAB_ID = 'settings-tab';

const SETTINGS_GROUPS = [
  {
    label: 'General',
    sections: [
      { id: 'appearance', icon: '🎨', label: 'Appearance' },
      { id: 'terminal', icon: '🖥️', label: 'Terminal' },
      { id: 'voice', icon: '🗣️', label: 'Voice & Dictation' },
    ],
  },
  {
    label: 'Workflow',
    sections: [
      { id: 'promptlib', icon: '💬', label: 'Prompts' },
      { id: 'prompts', icon: '🎁', label: 'Prompt Wrappers' },
      { id: 'runners', icon: '🏃', label: 'Runners' },
    ],
  },
  {
    label: 'Agents',
    sections: [
      { id: 'agentskills', icon: '🤖', label: 'Agent Skills' },
    ],
  },
  {
    label: 'Addons',
    sections: [
      { id: 'addons', icon: '🧩', label: 'Manage Addons' },
      { id: 'widgets', icon: '🧱', label: 'Widgets' },
      { id: 'gmail', icon: '✉️', label: 'Gmail', addon: 'gmail' },
      { id: 'jira', icon: '🔄', label: 'Jira', addon: 'jira' },
      { id: 'elevenlabs', icon: '🎙️', label: 'ElevenLabs', addon: 'elevenlabs' },
    ],
  },
];

// Sections contributed by installed addons via cl.registerSettingsSection
// (id -> {addonId, label, icon, render(el)})
const addonSections = new Map();

export function registerAddonSettingsSection(addonId, desc) {
  addonSections.set(desc.id, { ...desc, addonId });
  refreshSettingsIfOpen();
}

export function removeAddonSettingsSections(addonId) {
  let removed = false;
  for (const [id, desc] of addonSections) {
    if (desc.addonId === addonId) {
      addonSections.delete(id);
      removed = true;
    }
  }
  if (removed) refreshSettingsIfOpen();
}

export function refreshSettingsIfOpen() {
  const panel = document.getElementById('settingsPanel');
  if (panel && panel.style.display !== 'none' && panel.innerHTML) renderSettingsPanel();
}

// Sections owned by an addon are only offered while that addon is enabled;
// addon-contributed sections join the Addons group
function visibleSettingsGroups() {
  return SETTINGS_GROUPS
    .map(g => {
      const sections = g.sections.filter(s => !s.addon || builtinOn(s.addon));
      if (g.label === 'Addons') {
        for (const desc of addonSections.values()) {
          sections.push({ id: desc.id, icon: desc.icon || '🧩', label: desc.label });
        }
      }
      return { ...g, sections };
    })
    .filter(g => g.sections.length > 0);
}

const SETTINGS_SECTIONS = SETTINGS_GROUPS.flatMap(g => g.sections);

let activeSection = 'appearance';
let settings = {};

export function showSettingsPanel(show) {
  const panel = document.getElementById('settingsPanel');
  if (panel) panel.style.display = show ? 'flex' : 'none';
}

async function loadSettings() {
  const [
    elevenLabsKey, engine, voiceLang, autoSubmit,
    theme, termFont, fullscreen, prefix, suffix, jira
  ] = await Promise.all([
    GetElevenLabsAPIKey(), GetTranscriptionEngine(), GetVoiceLang(), GetVoiceAutoSubmit(),
    GetTerminalTheme(), GetTerminalFontSize(), GetDashboardFullscreen(),
    GetGlobalPromptPrefix(), GetGlobalPromptSuffix(), GetJiraSettings()
  ]);
  const gmail = await GetGmailConfig().catch(() => null);
  const agentSkills = await GetAgentSkills().catch(() => []);
  const addonsInfo = await AddonsList().catch((err) => {
    console.warn('addons list failed:', err);
    return { addons: [], categories: [], dir: '' };
  });
  const runners = await GetRunners().catch(() => []);
  const globalPrompts = await GetGlobalPrompts().catch(() => []);
  const projectPrompts = appState.activeProject
    ? await GetProjectPrompts(appState.activeProject.id).catch(() => [])
    : [];
  settings = {
    addonsInfo,
    agentSkills: agentSkills || [],
    runners: runners || [],
    globalPrompts: globalPrompts || [],
    projectPrompts: projectPrompts || [],
    elevenLabsKey: elevenLabsKey || '',
    engine: engine || 'native',
    voiceLang: voiceLang || 'en-US',
    autoSubmit: autoSubmit !== false,
    theme: theme || 'dracula',
    termFont: termFont || 12,
    fullscreen: !!fullscreen,
    prefix: prefix || '',
    suffix: suffix || '',
    jira: {
      enabled: !!jira?.enabled,
      baseUrl: jira?.baseUrl || '',
      email: jira?.email || '',
      apiToken: jira?.apiToken || ''
    },
    gmail: {
      enabled: !!gmail?.enabled,
      mcpEnabled: !!gmail?.mcpEnabled,
      clientId: gmail?.clientId || '',
      clientSecret: gmail?.clientSecret || '',
      accounts: gmail?.accounts || []
    }
  };
}

let settingsRenderToken = 0;

export async function renderSettingsPanel() {
  const panel = document.getElementById('settingsPanel');
  if (!panel) return;

  // Several callers (module switch, addon sync, section actions) fire this
  // concurrently; a stale run must not rewrite the panel after a newer one
  const token = ++settingsRenderToken;
  addSettingsStyles();
  await loadSettings();
  if (token !== settingsRenderToken) return;

  const visibleIds = visibleSettingsGroups().flatMap(g => g.sections.map(sec => sec.id));
  if (!visibleIds.includes(activeSection)) activeSection = visibleIds[0] || 'appearance';

  panel.innerHTML = `
    <div class="settings-layout">
      <div class="settings-sidebar">
        <div class="settings-sidebar-header">
          <span class="settings-title">⚙️ Settings</span>
          <button class="settings-close-btn" id="settingsCloseBtn" title="Close Settings">&times;</button>
        </div>
        <div class="settings-nav">
          ${visibleSettingsGroups().map(g => `
            <div class="settings-nav-group">${g.label}</div>
            ${g.sections.map(s => `
              <button class="settings-nav-item ${s.id === activeSection ? 'active' : ''}" data-section="${s.id}">
                <span class="settings-nav-icon">${s.icon}</span>
                <span>${s.label}</span>
              </button>
            `).join('')}
          `).join('')}
        </div>
      </div>
      <div class="settings-content" id="settingsContent">
        ${renderSection(activeSection)}
      </div>
    </div>
  `;

  document.getElementById('settingsCloseBtn')?.addEventListener('click', () => {
    import('./module-host.js').then(({ switchToDashboardTab }) => switchToDashboardTab());
  });

  panel.querySelectorAll('.settings-nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      activeSection = btn.dataset.section;
      panel.querySelectorAll('.settings-nav-item').forEach(b => b.classList.toggle('active', b === btn));
      const content = document.getElementById('settingsContent');
      if (content) content.innerHTML = renderSection(activeSection);
      wireSection(activeSection);
    });
  });

  wireSection(activeSection);
}

function renderSection(id) {
  switch (id) {
    case 'elevenlabs': return renderElevenLabs();
    case 'voice': return renderVoice();
    case 'appearance': return renderAppearance();
    case 'terminal': return renderTerminal();
    case 'prompts': return renderPrompts();
    case 'jira': return renderJira();
    case 'gmail': return renderGmail();
    case 'agentskills': return renderAgentSkills();
    case 'addons': return renderAddonsSection();
    case 'runners': return renderRunners();
    case 'widgets': return renderWidgetsSection();
    case 'promptlib': return renderPromptLib();
    default:
      if (addonSections.has(id)) {
        return `<div class="settings-section" id="addonSettingsHost"></div>`;
      }
      return '';
  }
}

// ============================================
// Prompt library (plain list, Global / per-project)
// ============================================

function sortPrompts(list) {
  return [...list].sort((a, b) =>
    (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.usageCount || 0) - (a.usageCount || 0));
}

function renderPromptRow(p, isGlobal) {
  return `
    <div class="settings-prompt-row" data-prompt="${p.id}" data-global="${isGlobal}">
      <button class="settings-prompt-pin ${p.pinned ? 'pinned' : ''}" data-act="pin" title="${p.pinned ? 'Unpin' : 'Pin'}">${p.pinned ? '★' : '☆'}</button>
      <div class="settings-prompt-main" data-act="edit" title="${escapeHtml(p.content).slice(0, 400)}">
        <span class="settings-prompt-title">${escapeHtml(p.title)}</span>
        <span class="settings-prompt-preview">${escapeHtml(p.content)}</span>
      </div>
      ${p.category ? `<span class="board-chip">${escapeHtml(p.category)}</span>` : ''}
      ${p.usageCount ? `<span class="settings-prompt-usage" title="Times used">${p.usageCount}×</span>` : ''}
      <button class="fc-btn fc-btn-secondary fc-btn-sm" data-act="insert" title="Send to the active session input">▶</button>
      <button class="fc-btn fc-btn-danger fc-btn-sm" data-act="delete" title="Delete">×</button>
    </div>
  `;
}

function renderPromptLib() {
  const project = appState.activeProject;
  return `
    <div class="settings-section">
      <h2 class="settings-section-title">💬 Prompts</h2>
      <p class="settings-section-desc">
        Reusable prompt snippets. <b>Global</b> prompts are available in every
        project; the second list belongs to <b>${escapeHtml(project?.name || 'the active project')}</b>.
        ▶ sends a prompt to the active session (wrappers applied). Agents manage
        these too, via the <code>prompts_*</code> tools.
      </p>

      <div class="settings-prompt-group">
        <div class="settings-prompt-group-head">
          <h3>🌐 Global</h3>
          <button class="fc-btn fc-btn-primary fc-btn-sm" id="promptNewGlobal">+ New global</button>
        </div>
        <div class="settings-prompt-list">
          ${settings.globalPrompts.length
            ? sortPrompts(settings.globalPrompts).map(p => renderPromptRow(p, true)).join('')
            : '<div class="settings-prompt-empty">No global prompts yet</div>'}
        </div>
      </div>

      ${project ? `
      <div class="settings-prompt-group">
        <div class="settings-prompt-group-head">
          <h3>📁 ${escapeHtml(project.name)}</h3>
          <button class="fc-btn fc-btn-primary fc-btn-sm" id="promptNewProject">+ New for this project</button>
        </div>
        <div class="settings-prompt-list">
          ${settings.projectPrompts.length
            ? sortPrompts(settings.projectPrompts).map(p => renderPromptRow(p, false)).join('')
            : '<div class="settings-prompt-empty">No project prompts yet</div>'}
        </div>
        <p class="settings-prompt-switch-note">To add a prompt to a different project, switch with <kbd>p</kbd> and come back here.</p>
      </div>` : ''}
    </div>
  `;
}

async function reloadPromptLib() {
  settings.globalPrompts = await GetGlobalPrompts().catch(() => []);
  settings.projectPrompts = appState.activeProject
    ? await GetProjectPrompts(appState.activeProject.id).catch(() => [])
    : [];
  const content = document.getElementById('settingsContent');
  if (content && activeSection === 'promptlib') {
    content.innerHTML = renderPromptLib();
    wirePromptLib();
  }
}

function openPromptModal(prompt, isGlobal) {
  document.getElementById('promptLibModal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'promptLibModal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content settings-prompt-modal">
      <h2>${prompt ? 'Edit Prompt' : 'New Prompt'} <span class="board-chip">${isGlobal ? '🌐 Global' : `📁 ${escapeHtml(appState.activeProject?.name || '')}`}</span></h2>
      <div class="fc-row">
        <div class="fc-field auto-field-grow">
          <label>Title</label>
          <input type="text" class="fc-input" id="plmTitle" value="${escapeHtml(prompt?.title || '')}" autocomplete="off" spellcheck="false" />
        </div>
        <div class="fc-field">
          <label>Category</label>
          <input type="text" class="fc-input" id="plmCategory" value="${escapeHtml(prompt?.category || '')}" autocomplete="off" />
        </div>
      </div>
      <div class="fc-field">
        <label>Content</label>
        <textarea class="fc-textarea" id="plmContent" rows="10" spellcheck="false">${escapeHtml(prompt?.content || '')}</textarea>
      </div>
      <div class="fc-actions">
        <span class="fc-spacer"></span>
        <button type="button" class="fc-btn fc-btn-secondary" id="plmCancel">Cancel</button>
        <button type="button" class="fc-btn fc-btn-primary" id="plmSave">${prompt ? 'Save' : 'Create'}</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector('#plmCancel').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modal.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && e.metaKey) modal.querySelector('#plmSave').click();
  });
  modal.querySelector('#plmSave').addEventListener('click', async () => {
    const title = modal.querySelector('#plmTitle').value.trim();
    const content = modal.querySelector('#plmContent').value;
    if (!title || !content.trim()) return;
    const data = { ...(prompt || {}), title, content, category: modal.querySelector('#plmCategory').value.trim(), isGlobal };
    try {
      if (prompt) {
        if (isGlobal) await UpdateGlobalPrompt(prompt.id, data);
        else await UpdatePrompt(appState.activeProject.id, prompt.id, data);
      } else {
        if (isGlobal) await CreateGlobalPrompt(data);
        else await CreatePrompt(appState.activeProject.id, data);
      }
      close();
      reloadPromptLib();
    } catch (err) {
      console.error('Failed to save prompt:', err);
      alert('Save failed: ' + (err?.message || err));
    }
  });
  modal.querySelector('#plmTitle').focus();
}

function wirePromptLib() {
  document.getElementById('promptNewGlobal')?.addEventListener('click', () => openPromptModal(null, true));
  document.getElementById('promptNewProject')?.addEventListener('click', () => openPromptModal(null, false));
  document.querySelectorAll('.settings-prompt-row').forEach(row => {
    const isGlobal = row.dataset.global === 'true';
    const list = isGlobal ? settings.globalPrompts : settings.projectPrompts;
    const prompt = list.find(p => p.id === row.dataset.prompt);
    if (!prompt) return;
    row.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      try {
        if (act === 'edit') openPromptModal(prompt, isGlobal);
        if (act === 'pin') {
          await TogglePromptPinned(appState.activeProject?.id || '', prompt.id, isGlobal);
          reloadPromptLib();
        }
        if (act === 'delete') {
          if (!confirm(`Delete prompt "${prompt.title}"?`)) return;
          if (isGlobal) await DeleteGlobalPrompt(prompt.id);
          else await DeletePrompt(appState.activeProject.id, prompt.id);
          reloadPromptLib();
        }
        if (act === 'insert') {
          await WriteITermText(applyPromptWrappers(prompt.content), false);
          await IncrementPromptUsage(appState.activeProject?.id || '', prompt.id, isGlobal);
          import('./module-host.js').then(({ switchToDashboardTab }) => switchToDashboardTab());
        }
      } catch (err) {
        console.error('Prompt action failed:', err, { act });
      }
    });
  });
}

function renderWidgetsSection() {
  const scopes = getWidgetScopes();
  const projectName = appState.activeProject?.name || 'active project';
  const scopeOf = (id) =>
    scopes.global.includes(id) ? 'global' : scopes.project.includes(id) ? 'project' : 'off';
  const ordered = [
    ...scopes.global.map(id => WIDGETS.find(w => w.id === id)).filter(Boolean),
    ...scopes.project.map(id => WIDGETS.find(w => w.id === id)).filter(Boolean),
    ...WIDGETS.filter(w => scopeOf(w.id) === 'off'),
  ].filter(widgetAvailable);
  const providerChip = (w) => {
    if (w.addonId) return `<span class="board-chip addon-chip" title="Provided by the ${escapeHtml(w.addonName || w.addonId)} addon">🧩 ${escapeHtml(w.addonName || w.addonId)}</span>`;
    if (w.builtin) return `<span class="board-chip addon-chip" title="Owned by the built-in ${escapeHtml(builtinName(w.builtin))} addon">🧩 ${escapeHtml(builtinName(w.builtin))}</span>`;
    return '';
  };
  return `
    <div class="settings-section">
      <h2 class="settings-section-title">🧱 Widgets</h2>
      <p class="settings-section-desc">
        Each widget is <b>Global</b> (shown in every project), scoped to
        <b>${escapeHtml(projectName)}</b> only, or off. The sidebar shows global
        widgets first, then the project's own. <kbd>w</kbd> collapses it to an
        icon strip. Dashboards (<kbd>g</kbd><kbd>w</kbd>) have their own picker;
        agents manage all of this via the <code>widgets_*</code> tools.
      </p>
      <div class="settings-widget-list">
        ${ordered.map(w => {
          const scope = scopeOf(w.id);
          return `
          <div class="settings-widget-row ${scope === 'off' ? 'disabled' : ''}" data-widget="${w.id}">
            <span class="settings-widget-name">${w.icon} ${w.title}</span>
            ${w.render ? '<span class="board-chip">sidebar + dash</span>' : '<span class="board-chip">sidebar only</span>'}
            ${providerChip(w)}
            <span class="fc-spacer"></span>
            <select class="fc-select fc-select-sm settings-widget-scope" data-widget="${w.id}">
              <option value="global" ${scope === 'global' ? 'selected' : ''}>🌐 Global — everywhere</option>
              <option value="project" ${scope === 'project' ? 'selected' : ''}>📁 ${escapeHtml(projectName)}</option>
              <option value="off" ${scope === 'off' ? 'selected' : ''}>Off</option>
            </select>
            <button class="fc-btn fc-btn-secondary fc-btn-sm settings-widget-up" data-widget="${w.id}" ${scope === 'off' ? 'disabled' : ''}>↑</button>
            <button class="fc-btn fc-btn-secondary fc-btn-sm settings-widget-down" data-widget="${w.id}" ${scope === 'off' ? 'disabled' : ''}>↓</button>
          </div>
        `;}).join('')}
      </div>
    </div>
  `;
}


function wireWidgetsSection() {
  const rerender = () => {
    const content = document.getElementById('settingsContent');
    if (content) content.innerHTML = renderWidgetsSection();
    wireWidgetsSection();
  };
  document.querySelectorAll('.settings-widget-scope').forEach(sel => {
    sel.addEventListener('change', () => {
      setWidgetScope(sel.dataset.widget, sel.value).then(rerender);
    });
  });
  document.querySelectorAll('.settings-widget-up').forEach(b =>
    b.addEventListener('click', () => moveWidget(b.dataset.widget, -1).then(rerender)));
  document.querySelectorAll('.settings-widget-down').forEach(b =>
    b.addEventListener('click', () => moveWidget(b.dataset.widget, 1).then(rerender)));
}

function renderAgentSkills() {
  const skills = settings.agentSkills || [];
  return `
    <div class="settings-section">
      <h2 class="settings-section-title">🤖 Agent Skills</h2>
      <p class="settings-section-desc">
        Built-in skills every agent gets automatically (installed to ~/.claude/skills).
        Disabling a skill uninstalls it and blocks its API — this is the permission gate
        for agents controlling Cyber Life.
      </p>
      ${skills.map(sk => `
        <div class="settings-field agent-skill-row ${sk.available ? '' : 'agent-skill-unavailable'}">
          <label class="settings-checkbox">
            <input type="checkbox" class="agent-skill-toggle" data-skill="${sk.id}"
                   ${sk.enabled ? 'checked' : ''} ${sk.available ? '' : 'disabled'}>
            <span><strong>${sk.title}</strong> — ${sk.description}</span>
          </label>
          ${sk.available ? '' : `<div class="agent-skill-note">⚠ ${sk.note || 'Integration not configured'}</div>`}
        </div>
      `).join('') || '<p>No built-in skills.</p>'}
    </div>
  `;
}

let addonsCategoryFilter = 'all';

function renderAddonsSection() {
  const info = settings.addonsInfo || { addons: [], dir: '' };
  const addons = info.addons || [];
  const cats = ['all', ...new Set(addons.map(a => a.category).filter(Boolean))];
  const list = addons.filter(a => addonsCategoryFilter === 'all' || a.category === addonsCategoryFilter);
  return `
    <div class="settings-section">
      <h2 class="settings-section-title">🧩 Addons</h2>
      <p class="settings-section-desc">
        Addons extend Cyber Life with pages, widgets and integrations. Install one by
        dropping its folder into <code title="${escapeHtml(info.dir || '')}">~/.cyberlife/addons</code>
        — or ask your agent to build one (cyberlife-addons skill). New addons stay
        disabled until you enable them here.
      </p>
      <div class="addons-toolbar">
        <div class="addons-cats">
          ${cats.map(c => `<button class="addon-cat-chip ${c === addonsCategoryFilter ? 'active' : ''}" data-cat="${c}">${c}</button>`).join('')}
        </div>
        <div class="addons-actions">
          <button class="fc-btn" id="addonsReloadBtn" title="Rescan the addons folder and hot-reload">↻ Reload</button>
          <button class="fc-btn" id="addonsOpenDirBtn" title="Open the addons folder">📂 Open folder</button>
        </div>
      </div>
      ${list.map(a => `
        <div class="settings-field addon-row ${a.error ? 'addon-row-error' : ''}">
          <div class="addon-row-main">
            <span class="addon-icon">${a.icon || '🧩'}</span>
            <div class="addon-row-text">
              <div>
                <strong>${escapeHtml(a.name || a.id)}</strong>
                <span class="addon-version">${escapeHtml(a.version || '')}</span>
                ${a.builtIn ? '<span class="addon-badge">Built-in</span>' : ''}
                ${(a.tags || []).map(t => `<span class="addon-tag">${escapeHtml(t)}</span>`).join('')}
              </div>
              <div class="addon-desc">${escapeHtml(a.description || '')}</div>
              ${a.error ? `<div class="addon-error">⚠ ${escapeHtml(a.error)}</div>` : ''}
            </div>
            <label class="settings-checkbox addon-toggle-label">
              <input type="checkbox" class="addon-toggle" data-addon="${a.id}"
                     ${a.enabled ? 'checked' : ''} ${a.error ? 'disabled' : ''}>
              <span>${a.enabled ? 'Enabled' : 'Disabled'}</span>
            </label>
          </div>
        </div>
      `).join('') || '<p>No addons in this category yet.</p>'}
    </div>
  `;
}

function wireAddonsSection() {
  document.querySelectorAll('.addon-cat-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      addonsCategoryFilter = chip.dataset.cat;
      renderSettingsPanel();
    });
  });
  document.getElementById('addonsReloadBtn')?.addEventListener('click', async () => {
    try {
      await AddonsReload();
    } catch (err) {
      console.warn('addons reload failed:', err);
    }
    renderSettingsPanel();
  });
  document.getElementById('addonsOpenDirBtn')?.addEventListener('click', () => {
    OpenAddonsDir().catch((err) => console.warn('open addons dir failed:', err));
  });
  document.querySelectorAll('.addon-toggle').forEach(box => {
    box.addEventListener('change', async () => {
      try {
        await SetAddonEnabled(box.dataset.addon, box.checked);
        setBuiltinOn(box.dataset.addon, box.checked);
      } catch (err) {
        console.error('addon toggle failed:', err);
        box.checked = !box.checked;
      }
      renderSettingsPanel();
    });
  });
}

function renderRunners() {
  const runners = settings.runners || [];
  return `
    <div class="settings-section">
      <h2 class="settings-section-title">🏃 Runners</h2>
      <p class="settings-section-desc">
        CLIs a session can run. Claude is built-in and always the default;
        add any other model's CLI here (command + optional args and env) and
        pick it when creating a terminal.
      </p>
      <div id="runnersList">
        ${runners.map(r => `
          <div class="runner-row" data-runner-id="${r.id}">
            <span class="runner-icon">${r.icon || '▶️'}</span>
            <span class="runner-name">${r.name}</span>
            <code class="runner-cmd">${r.command}${r.args ? ' ' + r.args : ''}</code>
            ${r.builtIn
              ? '<span class="runner-builtin">built-in</span>'
              : `<button class="small-btn runner-edit" title="Edit">✎</button>
                 <button class="small-btn runner-delete" title="Delete">×</button>`}
          </div>
        `).join('')}
      </div>
      <button class="fc-btn fc-btn-secondary" id="runnerAddBtn">+ Add runner</button>
      <div id="runnerForm" class="fc-card runner-form hidden">
        <input type="hidden" id="runnerFormId" />
        <div class="fc-row">
          <div class="fc-field">
            <label>Name</label>
            <input type="text" class="fc-input" id="runnerFormName" placeholder="Kimi" autocomplete="off" />
          </div>
          <div class="fc-field">
            <label>Command</label>
            <input type="text" class="fc-input fc-mono" id="runnerFormCommand" placeholder="kimi" autocomplete="off" spellcheck="false" />
          </div>
        </div>
        <div class="fc-field">
          <label>Args <span class="fc-optional">optional</span></label>
          <input type="text" class="fc-input fc-mono" id="runnerFormArgs" placeholder="--flag value" autocomplete="off" spellcheck="false" />
        </div>
        <div class="fc-field">
          <label>Env <span class="fc-optional">KEY=VALUE per line</span></label>
          <textarea class="fc-textarea fc-mono" id="runnerFormEnv" rows="3" spellcheck="false" placeholder="API_KEY=..."></textarea>
        </div>
        <div class="fc-field">
          <label>Icon</label>
          <div id="runnerIconPicker" class="runner-icon-picker"></div>
        </div>
        <div class="fc-field">
          <label>Color</label>
          <input type="color" class="fc-color" id="runnerFormColor" value="#8b5cf6" />
        </div>
        <div class="fc-actions">
          <span class="fc-spacer"></span>
          <button class="fc-btn fc-btn-secondary" id="runnerFormCancel">Cancel</button>
          <button class="fc-btn fc-btn-primary" id="runnerFormSave">Save</button>
        </div>
      </div>
    </div>
  `;
}

function jsonEnvToLines(env) {
  return Object.entries(env || {}).map(([k, v]) => `${k}=${v}`).join('\n');
}

function linesToEnv(text) {
  const env = {};
  for (const line of (text || '').split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return env;
}

function wireRunners() {
  const form = document.getElementById('runnerForm');
  const openForm = (runner) => {
    form.classList.remove('hidden');
    document.getElementById('runnerFormId').value = runner?.id || '';
    document.getElementById('runnerFormName').value = runner?.name || '';
    document.getElementById('runnerFormCommand').value = runner?.command || '';
    document.getElementById('runnerFormArgs').value = runner?.args || '';
    document.getElementById('runnerFormEnv').value = runner ? jsonEnvToLines(runner.env) : '';
    renderTabbedIconPicker(document.getElementById('runnerIconPicker'), runner?.icon || '');
    document.getElementById('runnerFormColor').value = runner?.color || '#8b5cf6';
    document.getElementById('runnerFormName').focus();
  };

  document.getElementById('runnerAddBtn')?.addEventListener('click', () => openForm(null));
  document.getElementById('runnerFormCancel')?.addEventListener('click', () => form.classList.add('hidden'));
  document.getElementById('runnerFormSave')?.addEventListener('click', async () => {
    const runner = {
      id: document.getElementById('runnerFormId').value,
      name: document.getElementById('runnerFormName').value.trim(),
      command: document.getElementById('runnerFormCommand').value.trim(),
      args: document.getElementById('runnerFormArgs').value.trim(),
      env: linesToEnv(document.getElementById('runnerFormEnv').value),
      icon: getPickedIcon('runnerIconPicker'),
      color: document.getElementById('runnerFormColor').value,
    };
    if (!runner.name || !runner.command) return;
    try {
      await SaveRunner(runner);
      await loadSettings();
      document.getElementById('settingsContent').innerHTML = renderSection('runners');
      wireSection('runners');
    } catch (err) {
      console.error('Failed to save runner:', err);
    }
  });

  document.querySelectorAll('.runner-row').forEach(row => {
    const id = row.dataset.runnerId;
    row.querySelector('.runner-edit')?.addEventListener('click', () => {
      openForm((settings.runners || []).find(r => r.id === id));
    });
    row.querySelector('.runner-delete')?.addEventListener('click', async () => {
      try {
        await DeleteRunner(id);
        await loadSettings();
        document.getElementById('settingsContent').innerHTML = renderSection('runners');
        wireSection('runners');
      } catch (err) {
        console.error('Failed to delete runner:', err);
      }
    });
  });
}

function renderJira() {
  const j = settings.jira;
  const configured = j.baseUrl.trim() && j.email.trim() && j.apiToken.trim();
  return `
    <div class="settings-section">
      <h2 class="settings-section-title">🧩 Jira</h2>
      <p class="settings-section-desc">
        Connect Jira to auto-fill task details. When enabled, entering an issue key
        (e.g. <strong>ACRE-123</strong>) while creating a task fetches its summary automatically.
      </p>

      <div class="settings-field">
        <label class="settings-checkbox">
          <input type="checkbox" id="settingsJiraEnabled" ${j.enabled ? 'checked' : ''}>
          <span>Enable Jira integration</span>
        </label>
      </div>

      <div class="settings-field">
        <label class="settings-label">Base URL
          <span class="settings-status ${configured ? 'ok' : 'warn'}">${configured ? '● Configured' : '○ Not set'}</span>
        </label>
        <input type="text" id="settingsJiraUrl" class="settings-input" autocomplete="off"
          placeholder="https://yourcompany.atlassian.net" value="${escapeAttr(j.baseUrl)}">
      </div>

      <div class="settings-field">
        <label class="settings-label">Email</label>
        <input type="text" id="settingsJiraEmail" class="settings-input" autocomplete="off"
          placeholder="you@company.com" value="${escapeAttr(j.email)}">
      </div>

      <div class="settings-field">
        <label class="settings-label">API Token</label>
        <div class="settings-key-row">
          <input type="password" id="settingsJiraToken" class="settings-input" autocomplete="off"
            placeholder="ATATT..." value="${escapeAttr(j.apiToken)}">
          <button class="settings-btn-icon" id="settingsJiraTokenVis" title="Show / hide">👁</button>
        </div>
        <p class="settings-hint">
          Stored locally in the app state file. Create a token at
          <a href="#" id="settingsJiraTokenLink">id.atlassian.com → Security → API tokens</a>.
        </p>
      </div>

      <div class="settings-actions">
        <button class="settings-btn primary" id="settingsSaveJira">Save</button>
        <button class="settings-btn" id="settingsTestJira">Test connection</button>
        <span class="settings-save-note" id="settingsJiraNote"></span>
      </div>
    </div>
  `;
}

function renderElevenLabs() {
  const configured = settings.elevenLabsKey.trim().length > 0;
  return `
    <div class="settings-section">
      <h2 class="settings-section-title">🎙️ ElevenLabs</h2>
      <p class="settings-section-desc">
        Connect your ElevenLabs account to use <strong>Scribe v2 Realtime</strong> for voice dictation —
        state-of-the-art transcription in 90+ languages with ~150ms latency, automatic language detection,
        and next-word/punctuation prediction.
      </p>

      <div class="settings-field">
        <label class="settings-label">API Key
          <span class="settings-status ${configured ? 'ok' : 'warn'}">${configured ? '● Configured' : '○ Not set'}</span>
        </label>
        <div class="settings-key-row">
          <input type="password" id="settingsElevenKey" class="settings-input" autocomplete="off"
            placeholder="sk_..." value="${escapeAttr(settings.elevenLabsKey)}">
          <button class="settings-btn-icon" id="settingsToggleKeyVis" title="Show / hide">👁</button>
        </div>
        <p class="settings-hint">
          Stored locally in the app state file. Get a key at
          <a href="#" id="settingsElevenLink">elevenlabs.io → Profile → API Keys</a>.
        </p>
      </div>

      <div class="settings-actions">
        <button class="settings-btn primary" id="settingsSaveEleven">Save API Key</button>
        <span class="settings-save-note" id="settingsElevenNote"></span>
      </div>

      <div class="settings-info-box">
        <div class="settings-info-title">After saving</div>
        Open the microphone settings popup (next to the mic button) and pick
        <strong>ElevenLabs Scribe</strong> as the transcription engine. The engine option only appears once a key is set.
      </div>
    </div>
  `;
}

function renderVoice() {
  const scribeReady = builtinOn('elevenlabs') && settings.elevenLabsKey.trim().length > 0;
  return `
    <div class="settings-section">
      <h2 class="settings-section-title">🗣️ Voice & Dictation</h2>
      <p class="settings-section-desc">Settings for the microphone dictation button in the terminal dashboard.</p>

      <div class="settings-field">
        <label class="settings-label">Transcription engine</label>
        <div class="settings-radio-group">
          <label class="settings-radio">
            <input type="radio" name="settingsEngine" value="native" ${settings.engine !== 'scribe' ? 'checked' : ''}>
            <span><strong>Native macOS Speech</strong> — on-device, no API key, free.</span>
          </label>
          <label class="settings-radio ${scribeReady ? '' : 'disabled'}">
            <input type="radio" name="settingsEngine" value="scribe" ${settings.engine === 'scribe' ? 'checked' : ''} ${scribeReady ? '' : 'disabled'}>
            <span><strong>ElevenLabs Scribe v2 Realtime</strong> — cloud, higher accuracy.
            ${scribeReady ? '' : '<em>(enable the ElevenLabs addon and set an API key in Addons → ElevenLabs)</em>'}</span>
          </label>
        </div>
      </div>

      <div class="settings-field">
        <label class="settings-label">Language</label>
        <div class="settings-radio-group">
          <label class="settings-radio">
            <input type="radio" name="settingsVoiceLang" value="en-US" ${settings.voiceLang === 'en-US' ? 'checked' : ''}> English (en-US)
          </label>
          <label class="settings-radio">
            <input type="radio" name="settingsVoiceLang" value="pl-PL" ${settings.voiceLang === 'pl-PL' ? 'checked' : ''}> Polski (pl-PL)
          </label>
        </div>
      </div>

      <div class="settings-field">
        <label class="settings-checkbox">
          <input type="checkbox" id="settingsAutoSubmit" ${settings.autoSubmit ? 'checked' : ''}>
          <span>Auto-submit transcript to the terminal when dictation stops</span>
        </label>
      </div>
    </div>
  `;
}

function renderAppearance() {
  return `
    <div class="settings-section">
      <h2 class="settings-section-title">🎨 Appearance</h2>

      <div class="settings-field">
        <label class="settings-label">Terminal theme</label>
        <div class="settings-theme-grid">
          ${TERMINAL_THEMES.map(t => `
            <button class="settings-theme-swatch ${settings.theme === t.name ? 'active' : ''}" data-theme="${t.name}"
              style="background:${t.background};color:${t.foreground};border-color:${t.color}">
              ${t.displayName}
            </button>
          `).join('')}
        </div>
      </div>

      <div class="settings-field">
        <label class="settings-label">Terminal font size <span id="settingsTermFontVal">${settings.termFont}px</span></label>
        <input type="range" id="settingsTermFont" class="settings-range" min="8" max="24" value="${settings.termFont}">
      </div>

      <div class="settings-field">
        <label class="settings-checkbox">
          <input type="checkbox" id="settingsFullscreen" ${settings.fullscreen ? 'checked' : ''}>
          <span>Start dashboard in fullscreen (hide tools panel & browser tabs)</span>
        </label>
      </div>

      ${renderSidebarWidth()}
    </div>
  `;
}

function renderSidebarWidth() {
  const cfg = getWidthConfig();
  const modules = getModules();
  return `
    <div class="settings-field">
      <label class="settings-label">Widget sidebar width</label>
      <p class="settings-section-desc">Default applies everywhere; per-module overrides win on that
      module (drag the sidebar edge to adjust the current one). Agents set these via
      <code>widgets_set_width</code>.</p>
      <div class="settings-widget-list settings-width-list">
        <div class="settings-widget-row">
          <span class="settings-widget-name">Default</span>
          <span class="fc-spacer"></span>
          <input type="number" class="fc-input fc-input-sm" id="settingsSidebarWidth"
                 min="180" max="1200" step="10" value="${cfg.width}"> px
        </div>
        ${modules.map(m => `
          <div class="settings-widget-row ${cfg.moduleWidths[m.id] ? '' : 'disabled'}">
            <span class="settings-widget-name">${m.icon} ${m.label}</span>
            <span class="fc-spacer"></span>
            <input type="number" class="fc-input fc-input-sm settings-module-width" data-module="${m.id}"
                   min="180" max="1200" step="10" placeholder="default"
                   value="${cfg.moduleWidths[m.id] || ''}"> px
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function renderGmail() {
  const g = settings.gmail;
  const configured = g.clientId.trim() && g.clientSecret.trim();
  return `
    <div class="settings-section">
      <h2 class="settings-section-title">✉️ Gmail</h2>
      <p class="settings-section-desc">
        Built-in email client for multiple Gmail accounts. Actions (read, archive, labels)
        sync straight back to Gmail. When enabled with at least one account, an
        <strong>Email</strong> button appears above Settings.
      </p>

      <div class="settings-field">
        <label class="settings-checkbox">
          <input type="checkbox" id="settingsGmailEnabled" ${g.enabled ? 'checked' : ''}>
          <span>Enable Gmail client</span>
        </label>
      </div>

      <div class="settings-field">
        <label class="settings-checkbox">
          <input type="checkbox" id="settingsGmailMcp" ${g.mcpEnabled ? 'checked' : ''}>
          <span><strong>Claude MCP integration</strong> — adds a "Draft reply with Claude" button in the
          email view. Uses the Gmail MCP server built into Cyber Life (accounts and tokens are shared —
          tick "MCP" on each account below to expose it to Claude).</span>
        </label>
        <div class="settings-actions" style="margin-top: 8px;">
          <button class="settings-btn" id="settingsGmailInstallMcp">Install MCP server in Claude Code</button>
          <span class="settings-save-note" id="settingsGmailMcpNote"></span>
        </div>
      </div>

      <div class="settings-actions">
        <button class="settings-btn primary" id="settingsSaveGmail">Save</button>
        <span class="settings-save-note" id="settingsGmailNote"></span>
      </div>

      <div class="settings-field" style="margin-top: 28px;">
        <label class="settings-label">Connected accounts</label>
        <div id="settingsGmailAccounts">
          ${g.accounts.length === 0 ? '<p class="settings-hint">No accounts connected yet.</p>' : g.accounts.map(acc => `
            <div class="gmail-account-row">
              <span class="gmail-account-email">${escapeHtml(acc.email)}</span>
              <label class="gmail-account-mcp" title="Expose this account to Claude via the built-in MCP server">
                <input type="checkbox" class="gmail-account-mcp-toggle" data-email="${escapeAttr(acc.email)}" ${acc.mcpEnabled ? 'checked' : ''}>
                MCP
              </label>
              <button class="settings-btn gmail-account-reauth" data-email="${escapeAttr(acc.email)}"
                title="Re-run Google authorization (fixes expired/broken tokens). If this account was added with different credentials, paste them in the Add account fields first.">Re-auth</button>
              <button class="settings-btn gmail-account-remove" data-email="${escapeAttr(acc.email)}">Remove</button>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="settings-field" style="margin-top: 24px;">
        <label class="settings-label">Add account</label>
        <p class="settings-hint" style="margin: 0 0 10px;">
          Each account can use its own OAuth client (e.g. a personal Google Cloud project for
          @gmail.com and a company one for Workspace). Paste the credentials for the account
          you're adding — they're stored per account.
        </p>
        <input type="text" id="settingsGmailClientId" class="settings-input" autocomplete="off"
          placeholder="OAuth Client ID (xxxx.apps.googleusercontent.com)" value=""
          style="margin-bottom: 8px;">
        <div class="settings-key-row">
          <input type="password" id="settingsGmailSecret" class="settings-input" autocomplete="off"
            placeholder="OAuth Client Secret (GOCSPX-...)" value="">
          <button class="settings-btn-icon" id="settingsGmailSecretVis" title="Show / hide">👁</button>
        </div>
        ${g.clientId ? `<p class="settings-hint" style="margin: 6px 0 0;">
          Adding another mailbox from the same Google Cloud project?
          <a href="#" id="settingsGmailUsePrev">Use previous credentials</a>
        </p>` : ''}
        <div class="settings-actions" style="margin-top: 10px;">
          <button class="settings-btn primary" id="settingsGmailAddAccount">+ Authorize &amp; add account</button>
          <span class="settings-save-note" id="settingsGmailAccountNote"></span>
        </div>
      </div>

      <div class="settings-info-box">
        <div class="settings-info-title">One-time Google Cloud setup</div>
        1. Open <a href="#" id="settingsGmailConsoleLink">console.cloud.google.com</a> → create a project.<br>
        2. <em>APIs &amp; Services → Library</em> → enable <strong>Gmail API</strong>.<br>
        3. <em>OAuth consent screen</em> → External → add your Gmail addresses as test users
        (or publish the app so tokens don't expire weekly).<br>
        4. <em>Credentials → Create credentials → OAuth client ID → Desktop app</em> —
        copy the Client ID and Secret above.
      </div>
    </div>
  `;
}

function renderTerminal() {
  return `
    <div class="settings-section">
      <h2 class="settings-section-title">🖥️ Terminal</h2>
      <p class="settings-section-desc">How sessions run.</p>

      <div class="settings-info-box">
        <div class="settings-info-title">tmux-only sessions</div>
        Every session runs inside <strong>tmux</strong> — sessions survive app and iTerm2 restarts,
        stream straight into the dashboard (styled, ~60&nbsp;ms latency) and keep 50k lines of
        scrollback. Requires <strong>tmux ≥ 3.2</strong> (<code>brew install tmux</code>); the Term
        module shows a dependency checklist when it's missing. iTerm2 is optional — the ⤴ button
        (or <code>o</code>) opens a session in a real terminal window on demand.
      </div>
    </div>
  `;
}

function renderPrompts() {
  return `
    <div class="settings-section">
      <h2 class="settings-section-title">💬 Global Prompts</h2>
      <p class="settings-section-desc">Text automatically wrapped around every prompt you send to a terminal.</p>

      <div class="settings-field">
        <label class="settings-label">Prefix (added before)</label>
        <textarea id="settingsPrefix" class="settings-textarea" rows="3" placeholder="e.g. Always respond concisely.">${escapeHtml(settings.prefix)}</textarea>
      </div>

      <div class="settings-field">
        <label class="settings-label">Suffix (added after)</label>
        <textarea id="settingsSuffix" class="settings-textarea" rows="3" placeholder="e.g. Think step by step.">${escapeHtml(settings.suffix)}</textarea>
      </div>

      <div class="settings-actions">
        <button class="settings-btn primary" id="settingsSavePrompts">Save</button>
        <span class="settings-save-note" id="settingsPromptsNote"></span>
      </div>
    </div>
  `;
}

function wireSection(id) {
  const addonSection = addonSections.get(id);
  if (addonSection) {
    const host = document.getElementById('addonSettingsHost');
    if (host) {
      Promise.resolve(addonSection.render(host)).catch((err) =>
        console.warn(`addon settings section ${id} render failed:`, err));
    }
    return;
  }
  if (id === 'runners') {
    wireRunners();
    return;
  }
  if (id === 'addons') {
    wireAddonsSection();
    return;
  }
  if (id === 'widgets') {
    wireWidgetsSection();
    return;
  }
  if (id === 'promptlib') {
    wirePromptLib();
    return;
  }
  if (id === 'agentskills') {
    document.querySelectorAll('.agent-skill-toggle').forEach(box => {
      box.addEventListener('change', async () => {
        try {
          await SetAgentSkillEnabled(box.dataset.skill, box.checked);
        } catch (err) {
          console.error('Failed to toggle agent skill:', err);
          box.checked = !box.checked;
        }
      });
    });
    return;
  }
  if (id === 'elevenlabs') {
    const input = document.getElementById('settingsElevenKey');
    document.getElementById('settingsToggleKeyVis')?.addEventListener('click', () => {
      if (input) input.type = input.type === 'password' ? 'text' : 'password';
    });
    document.getElementById('settingsElevenLink')?.addEventListener('click', (e) => {
      e.preventDefault();
      import('../../wailsjs/runtime/runtime').then(({ BrowserOpenURL }) =>
        BrowserOpenURL('https://elevenlabs.io/app/settings/api-keys'));
    });
    document.getElementById('settingsSaveEleven')?.addEventListener('click', async () => {
      const val = (input?.value || '').trim();
      await SetElevenLabsAPIKey(val);
      settings.elevenLabsKey = val;
      flashNote('settingsElevenNote', 'Saved');
    });
  }

  if (id === 'voice') {
    document.querySelectorAll('input[name="settingsEngine"]').forEach(r => {
      r.addEventListener('change', () => {
        settings.engine = r.value;
        SetTranscriptionEngine(r.value);
      });
    });
    document.querySelectorAll('input[name="settingsVoiceLang"]').forEach(r => {
      r.addEventListener('change', () => {
        settings.voiceLang = r.value;
        SetVoiceLang(r.value);
      });
    });
    document.getElementById('settingsAutoSubmit')?.addEventListener('change', (e) => {
      settings.autoSubmit = e.target.checked;
      SetVoiceAutoSubmit(e.target.checked);
    });
  }

  if (id === 'appearance') {
    document.querySelectorAll('.settings-theme-swatch').forEach(btn => {
      btn.addEventListener('click', () => {
        settings.theme = btn.dataset.theme;
        SetTerminalTheme(btn.dataset.theme);
        document.querySelectorAll('.settings-theme-swatch').forEach(b => b.classList.toggle('active', b === btn));
      });
    });
    const termFont = document.getElementById('settingsTermFont');
    termFont?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      document.getElementById('settingsTermFontVal').textContent = v + 'px';
      SetTerminalFontSize(v);
    });
    document.getElementById('settingsFullscreen')?.addEventListener('change', (e) => {
      SetDashboardFullscreen(e.target.checked);
    });
    const saveWidths = () => {
      const def = parseInt(document.getElementById('settingsSidebarWidth')?.value, 10);
      const overrides = {};
      document.querySelectorAll('.settings-module-width').forEach(inp => {
        const v = parseInt(inp.value, 10);
        if (v >= 180 && v <= 1200) overrides[inp.dataset.module] = v;
      });
      setWidthConfig(Number.isFinite(def) ? Math.min(1200, Math.max(180, def)) : 0, overrides);
    };
    document.getElementById('settingsSidebarWidth')?.addEventListener('change', saveWidths);
    document.querySelectorAll('.settings-module-width').forEach(inp =>
      inp.addEventListener('change', saveWidths));
  }

  if (id === 'gmail') {
    const secretInput = document.getElementById('settingsGmailSecret');
    document.getElementById('settingsGmailSecretVis')?.addEventListener('click', () => {
      if (secretInput) secretInput.type = secretInput.type === 'password' ? 'text' : 'password';
    });
    document.getElementById('settingsGmailConsoleLink')?.addEventListener('click', (e) => {
      e.preventDefault();
      import('../../wailsjs/runtime/runtime').then(({ BrowserOpenURL }) =>
        BrowserOpenURL('https://console.cloud.google.com/apis/credentials'));
    });
    const saveGmail = async () => {
      const enabled = !!document.getElementById('settingsGmailEnabled')?.checked;
      const mcpEnabled = !!document.getElementById('settingsGmailMcp')?.checked;
      // Toggles only — stored default credentials stay untouched
      await SetGmailConfig(enabled, settings.gmail.clientId, settings.gmail.clientSecret);
      await SetGmailMcpEnabled(mcpEnabled);
      settings.gmail.enabled = enabled;
      settings.gmail.mcpEnabled = mcpEnabled;
      window.emailUpdateButton?.();
    };
    document.getElementById('settingsSaveGmail')?.addEventListener('click', async () => {
      await saveGmail();
      flashNote('settingsGmailNote', 'Saved');
    });
    GmailMcpInstalled().then(installed => {
      const btn = document.getElementById('settingsGmailInstallMcp');
      if (btn && installed) btn.textContent = '✓ MCP installed — reinstall';
    }).catch((err) => { console.error('MCP status check failed:', err); });
    document.getElementById('settingsGmailInstallMcp')?.addEventListener('click', async () => {
      const note = document.getElementById('settingsGmailMcpNote');
      if (note) { note.textContent = 'Registering…'; note.style.color = ''; }
      try {
        await GmailInstallMcp();
        if (note) { note.textContent = '✓ Registered (restart Claude sessions to pick it up)'; note.style.color = '#4ade80'; }
        const btn = document.getElementById('settingsGmailInstallMcp');
        if (btn) btn.textContent = '✓ MCP installed — reinstall';
      } catch (err) {
        if (note) { note.textContent = `✗ ${err}`; note.style.color = '#f87171'; }
      }
    });
    document.querySelectorAll('.gmail-account-mcp-toggle').forEach(cb => {
      cb.addEventListener('change', async () => {
        await GmailSetAccountMcp(cb.dataset.email, cb.checked);
        const acc = settings.gmail.accounts.find(a => a.email === cb.dataset.email);
        if (acc) acc.mcpEnabled = cb.checked;
      });
    });
    document.getElementById('settingsGmailUsePrev')?.addEventListener('click', (e) => {
      e.preventDefault();
      const cidInput = document.getElementById('settingsGmailClientId');
      if (cidInput) cidInput.value = settings.gmail.clientId;
      if (secretInput) secretInput.value = settings.gmail.clientSecret;
    });
    document.getElementById('settingsGmailAddAccount')?.addEventListener('click', async () => {
      const note = document.getElementById('settingsGmailAccountNote');
      await saveGmail();
      const clientId = (document.getElementById('settingsGmailClientId')?.value || '').trim();
      const clientSecret = (secretInput?.value || '').trim();
      if (!clientId || !clientSecret) {
        if (note) { note.textContent = '✗ Paste the Client ID and Secret for this account first'; note.style.color = '#f87171'; }
        return;
      }
      if (note) { note.textContent = 'Waiting for browser authorization…'; note.style.color = ''; }
      try {
        const email = await GmailAddAccount(clientId, clientSecret);
        await SetGmailConfig(settings.gmail.enabled, clientId, clientSecret);
        settings.gmail.clientId = clientId;
        settings.gmail.clientSecret = clientSecret;
        if (!settings.gmail.accounts.some(a => a.email === email)) {
          settings.gmail.accounts = [...settings.gmail.accounts, { email, mcpEnabled: false }];
        }
        window.emailUpdateButton?.();
        const content = document.getElementById('settingsContent');
        if (content) { content.innerHTML = renderSection('gmail'); wireSection('gmail'); }
        flashNote('settingsGmailAccountNote', `✓ Connected ${email}`);
      } catch (err) {
        if (note) { note.textContent = `✗ ${err}`; note.style.color = '#f87171'; }
      }
    });
    document.querySelectorAll('.gmail-account-reauth').forEach(btn => {
      btn.addEventListener('click', async () => {
        const note = document.getElementById('settingsGmailAccountNote');
        const clientId = (document.getElementById('settingsGmailClientId')?.value || '').trim();
        const clientSecret = (secretInput?.value || '').trim();
        if (note) { note.textContent = `Re-authorizing ${btn.dataset.email}…`; note.style.color = ''; }
        try {
          await GmailReauthAccount(btn.dataset.email, clientId, clientSecret);
          flashNote('settingsGmailAccountNote', `✓ Re-authorized ${btn.dataset.email}`);
        } catch (err) {
          if (note) { note.textContent = `✗ ${err}`; note.style.color = '#f87171'; }
        }
      });
    });
    document.querySelectorAll('.gmail-account-remove').forEach(btn => {
      btn.addEventListener('click', async () => {
        const email = btn.dataset.email;
        await GmailRemoveAccount(email);
        settings.gmail.accounts = settings.gmail.accounts.filter(a => a.email !== email);
        window.emailUpdateButton?.();
        const content = document.getElementById('settingsContent');
        if (content) { content.innerHTML = renderSection('gmail'); wireSection('gmail'); }
      });
    });
  }

  if (id === 'jira') {
    const readForm = () => ({
      enabled: !!document.getElementById('settingsJiraEnabled')?.checked,
      baseUrl: (document.getElementById('settingsJiraUrl')?.value || '').trim(),
      email: (document.getElementById('settingsJiraEmail')?.value || '').trim(),
      apiToken: (document.getElementById('settingsJiraToken')?.value || '').trim()
    });
    const tokenInput = document.getElementById('settingsJiraToken');
    document.getElementById('settingsJiraTokenVis')?.addEventListener('click', () => {
      if (tokenInput) tokenInput.type = tokenInput.type === 'password' ? 'text' : 'password';
    });
    document.getElementById('settingsJiraTokenLink')?.addEventListener('click', (e) => {
      e.preventDefault();
      import('../../wailsjs/runtime/runtime').then(({ BrowserOpenURL }) =>
        BrowserOpenURL('https://id.atlassian.com/manage-profile/security/api-tokens'));
    });
    document.getElementById('settingsSaveJira')?.addEventListener('click', async () => {
      const values = readForm();
      await SetJiraSettings(values);
      settings.jira = values;
      window.itermSetJiraEnabled?.(values.enabled);
      flashNote('settingsJiraNote', 'Saved');
    });
    document.getElementById('settingsTestJira')?.addEventListener('click', async () => {
      const note = document.getElementById('settingsJiraNote');
      if (note) { note.textContent = 'Testing…'; note.style.color = ''; }
      try {
        const { TestJiraConnection } = await import('../../wailsjs/go/main/App');
        const displayName = await TestJiraConnection(readForm());
        if (note) { note.textContent = `✓ Connected as ${displayName}`; note.style.color = '#4ade80'; }
      } catch (err) {
        if (note) { note.textContent = `✗ ${err}`; note.style.color = '#f87171'; }
      }
    });
  }

  if (id === 'prompts') {
    document.getElementById('settingsSavePrompts')?.addEventListener('click', async () => {
      const prefix = document.getElementById('settingsPrefix')?.value || '';
      const suffix = document.getElementById('settingsSuffix')?.value || '';
      await Promise.all([SetGlobalPromptPrefix(prefix), SetGlobalPromptSuffix(suffix)]);
      settings.prefix = prefix;
      settings.suffix = suffix;
      flashNote('settingsPromptsNote', 'Saved');
    });
  }
}

function flashNote(id, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  setTimeout(() => { el.textContent = ''; }, 2000);
}



function addSettingsStyles() {
  if (document.getElementById('settings-dashboard-styles')) return;
  const style = document.createElement('style');
  style.id = 'settings-dashboard-styles';
  style.textContent = `
    #settingsPanel { flex: 1; overflow: hidden; }
    .addons-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 1em; margin-bottom: 1em; flex-wrap: wrap; }
    .addons-cats { display: flex; gap: 0.4em; flex-wrap: wrap; }
    .addon-cat-chip {
      background: rgba(255,255,255,0.04); border: 1px solid #334155; border-radius: 999px;
      color: #94a3b8; padding: 0.25em 0.9em; cursor: pointer; font-size: 0.85em;
    }
    .addon-cat-chip.active { color: #f1f5f9; border-color: #6366f1; background: rgba(99,102,241,0.15); }
    .addons-actions { display: flex; gap: 0.5em; }
    .addon-row-main { display: flex; gap: 0.75em; align-items: flex-start; }
    .addon-icon { font-size: 1.5em; line-height: 1.2; }
    .addon-row-text { flex: 1; min-width: 0; }
    .addon-version { color: #64748b; font-size: 0.8em; margin-left: 0.4em; }
    .addon-badge {
      background: rgba(99,102,241,0.2); color: #a5b4fc; border-radius: 4px;
      padding: 0.1em 0.5em; font-size: 0.75em; margin-left: 0.5em;
    }
    .addon-tag {
      background: rgba(255,255,255,0.06); color: #94a3b8; border-radius: 4px;
      padding: 0.1em 0.5em; font-size: 0.75em; margin-left: 0.35em;
    }
    .addon-desc { color: #94a3b8; font-size: 0.9em; margin-top: 0.2em; }
    .addon-error { color: #f87171; font-size: 0.85em; margin-top: 0.3em; }
    .addon-toggle-label { white-space: nowrap; }
    .addon-chip { color: #a5b4fc; background: rgba(99,102,241,0.12); }
    .settings-layout { display: flex; height: 100%; width: 100%; }
    .settings-sidebar {
      width: 220px; flex-shrink: 0; background: rgba(255,255,255,0.02);
      border-right: 1px solid #334155; display: flex; flex-direction: column;
    }
    .settings-sidebar-header {
      padding: 16px; border-bottom: 1px solid #334155;
      display: flex; align-items: center; justify-content: space-between;
    }
    .settings-title { font-size: 15px; font-weight: 600; color: #f1f5f9; }
    .settings-close-btn {
      background: transparent; border: none; color: #94a3b8;
      font-size: 22px; line-height: 1; cursor: pointer; padding: 0 4px;
    }
    .settings-close-btn:hover { color: #f1f5f9; }
    .settings-nav { display: flex; flex-direction: column; padding: 8px; gap: 2px; }
    .settings-nav-item {
      display: flex; align-items: center; gap: 10px; padding: 10px 12px;
      background: transparent; border: none; border-radius: 6px; color: #94a3b8;
      font-size: 13px; cursor: pointer; text-align: left; width: 100%;
    }
    .settings-nav-item:hover { background: rgba(255,255,255,0.04); color: #e2e8f0; }
    .settings-nav-item.active { background: #334155; color: #f1f5f9; }
    .settings-nav-icon { font-size: 15px; }
    .settings-content { flex: 1; overflow-y: auto; padding: clamp(24px, 2.5vw, 48px) clamp(28px, 3vw, 56px); font-size: var(--fs-base, 14px); }
    .settings-section { max-width: min(880px, 100%); }
    .settings-section-title { font-size: 1.35em; font-weight: 600; color: #f1f5f9; margin: 0 0 8px; }
    .settings-section-desc { font-size: 0.95em; color: #94a3b8; line-height: 1.55; margin: 0 0 20px; }
    .settings-field { margin-bottom: 22px; }
    .settings-label {
      display: flex; align-items: center; gap: 10px; font-size: 0.95em;
      font-weight: 600; color: #cbd5e1; margin-bottom: 8px;
    }
    .settings-status { font-size: 11px; font-weight: 500; }
    .settings-status.ok { color: #4ade80; }
    .settings-status.warn { color: #fbbf24; }
    .settings-input, .settings-textarea { font-size: 0.95em;
      width: 100%; padding: 9px 12px; background: #0f172a; border: 1px solid #334155;
      border-radius: 6px; color: #f1f5f9; font-size: 13px; box-sizing: border-box;
      font-family: inherit;
    }
    .settings-input:focus, .settings-textarea:focus { outline: none; border-color: #6366f1; }
    .settings-key-row { display: flex; gap: 8px; }
    .settings-btn-icon {
      background: #1e293b; border: 1px solid #334155; border-radius: 6px;
      color: #94a3b8; padding: 0 12px; cursor: pointer; font-size: 14px;
    }
    .settings-btn-icon:hover { background: #334155; }
    .settings-hint { font-size: 11px; color: #64748b; margin: 6px 0 0; }
    .settings-hint a { color: #818cf8; text-decoration: none; }
    .settings-actions { display: flex; align-items: center; gap: 12px; margin-top: 4px; }
    .settings-btn {
      padding: 8px 16px; border-radius: 6px; border: 1px solid #334155;
      background: #1e293b; color: #e2e8f0; font-size: 13px; cursor: pointer;
    }
    .settings-btn.primary { background: #4f46e5; border-color: #4f46e5; color: #fff; }
    .settings-btn.primary:hover { background: #4338ca; }
    .settings-save-note { font-size: 12px; color: #4ade80; }
    .settings-radio-group { display: flex; flex-direction: column; gap: 10px; }
    .settings-radio {
      display: flex; align-items: flex-start; gap: 10px; font-size: 13px;
      color: #cbd5e1; cursor: pointer; line-height: 1.4;
    }
    .settings-radio.disabled { opacity: 0.5; cursor: not-allowed; }
    .settings-radio input, .settings-checkbox input { margin-top: 2px; }
    .settings-radio em { color: #fbbf24; font-style: italic; font-size: 12px; }
    .settings-checkbox {
      display: flex; align-items: flex-start; gap: 10px; font-size: 13px;
      color: #cbd5e1; cursor: pointer; line-height: 1.4;
    }
    .settings-info-box {
      background: rgba(79,70,229,0.08); border: 1px solid rgba(99,102,241,0.3);
      border-radius: 8px; padding: 14px 16px; font-size: 12px; color: #c7d2fe; line-height: 1.5;
    }
    .settings-info-title { font-weight: 600; color: #a5b4fc; margin-bottom: 4px; }
    .settings-theme-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
    .settings-theme-swatch {
      padding: 14px 8px; border-radius: 8px; border: 2px solid transparent;
      font-size: 12px; font-weight: 600; cursor: pointer; opacity: 0.7;
    }
    .settings-theme-swatch:hover { opacity: 1; }
    .settings-theme-swatch.active { opacity: 1; box-shadow: 0 0 0 2px #6366f1; }
    .settings-range { width: 100%; accent-color: #6366f1; }
    .gmail-account-row {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 12px; background: #0f172a; border: 1px solid #334155;
      border-radius: 6px; margin-bottom: 6px;
    }
    .gmail-account-email { font-size: 13px; color: #e2e8f0; flex: 1; }
    .gmail-account-mcp {
      display: flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600;
      color: #94a3b8; cursor: pointer; margin-right: 10px;
    }
    .gmail-account-mcp input { accent-color: #6366f1; }
  `;
  document.head.appendChild(style);
}
