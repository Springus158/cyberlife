// Auto module: visual editor and monitor for automation rules
// (trigger → actions). Rules can be global or scoped to one project; the
// engine itself lives in the Go backend — this view manages and observes it.

import { state } from './state.js';
import { escapeAttr, escapeHtml } from './utils.js';
import { EventsOn } from '../../wailsjs/runtime/runtime';
import {
  GetAutomationRules, SaveAutomationRule, DeleteAutomationRule,
  SetAutomationRuleEnabled, RunAutomationRule, GetAutomationRuns,
  GetRunners, GetGmailConfig, GetProjects,
} from '../../wailsjs/go/main/App.js';

export const AUTO_TAB_ID = 'auto-tab';

const as = {
  rules: [],
  runs: [],
  selected: 0,
  loading: false,
  runners: [],
  gmailAccounts: [],
  projects: [],
};

const TRIGGER_META = {
  'task-status': { icon: '📋', label: 'Task enters column' },
  'cron':        { icon: '⏰', label: 'Schedule' },
  'mail':        { icon: '✉️', label: 'Mail received' },
  'webhook':     { icon: '🪝', label: 'Webhook received' },
  'manual':      { icon: '▶', label: 'Manual' },
};

const ACTION_META = {
  'run-agent': { icon: '🤖', label: 'Run agent' },
  'move-task': { icon: '📋', label: 'Move task' },
  'comment':   { icon: '💬', label: 'Comment' },
  'notify':    { icon: '🔔', label: 'Notify' },
  'send-mail': { icon: '📤', label: 'Send mail' },
  'webhook':   { icon: '🪝', label: 'Call webhook' },
  'emit-event': { icon: '📡', label: 'Emit event' },
};

export function initAutoModule() {
  EventsOn('automations-changed', () => {
    if (isVisible()) loadAutoData();
  });
  EventsOn('automation-run', () => {
    if (isVisible()) loadAutoData();
  });
}

function isVisible() {
  const panel = document.getElementById('autoPanel');
  return panel && panel.style.display !== 'none';
}

export function showAutoPanel(show) {
  const panel = document.getElementById('autoPanel');
  if (panel) panel.style.display = show ? 'flex' : 'none';
}

export async function renderAutoPanel() {
  await loadAutoData();
}

async function loadAutoData() {
  as.loading = true;
  render();
  try {
    const [rules, runs, runners, gmail, projects] = await Promise.all([
      GetAutomationRules(),
      GetAutomationRuns(40),
      GetRunners(),
      GetGmailConfig().catch((err) => { console.warn('Auto: gmail config unavailable', err); return null; }),
      GetProjects(),
    ]);
    as.rules = rules || [];
    as.runs = runs || [];
    as.runners = runners || [];
    as.gmailAccounts = (gmail?.accounts || []).map(a => a.email);
    as.projects = projects || [];
    if (as.selected >= as.rules.length) as.selected = Math.max(0, as.rules.length - 1);
  } catch (err) {
    console.error('Failed to load automations:', err);
  }
  as.loading = false;
  render();
}

function projectName(projectId) {
  if (!projectId) return null;
  return as.projects.find(p => p.id === projectId)?.name || 'unknown project';
}

// ============================================
// Render
// ============================================

function render() {
  const panel = document.getElementById('autoPanel');
  if (!panel) return;

  panel.innerHTML = `
    <div class="auto-header">
      <h3>Automations</h3>
      ${as.rules.length ? `<span class="auto-count">${as.rules.filter(r => r.enabled).length}/${as.rules.length} active</span>` : ''}
      <div class="board-header-actions">
        <button class="fc-btn fc-btn-primary fc-btn-sm" id="autoNewBtn">+ New rule (n)</button>
      </div>
    </div>
    <div class="auto-body">
      <div class="auto-rules">
        ${as.loading && !as.rules.length ? '<div class="health-loading">Loading…</div>'
          : as.rules.length ? as.rules.map((r, i) => renderRuleRow(r, i)).join('')
          : renderEmpty()}
      </div>
      <div class="auto-runs">
        <div class="auto-runs-header">Recent runs</div>
        ${as.runs.length ? as.runs.map(renderRunRow).join('')
          : '<div class="auto-runs-empty">Nothing has run yet</div>'}
      </div>
    </div>
  `;

  panel.querySelector('#autoNewBtn')?.addEventListener('click', () => openRuleModal(null));
  panel.querySelector('#autoEmptyNew')?.addEventListener('click', () => openRuleModal(null));
  panel.querySelectorAll('.auto-rule').forEach(row => {
    row.addEventListener('click', (e) => {
      const idx = parseInt(row.dataset.index);
      as.selected = idx;
      if (e.target.closest('.auto-rule-toggle')) {
        toggleRule(as.rules[idx]);
      } else if (e.target.closest('.auto-rule-run')) {
        runRule(as.rules[idx]);
      } else {
        openRuleModal(as.rules[idx]);
      }
    });
  });
}

function renderEmpty() {
  return `
    <div class="auto-empty">
      <div class="auto-empty-icon">⚡</div>
      <p>No automation rules yet.</p>
      <p class="auto-empty-sub">A rule reacts to a trigger — a task entering a column, a schedule,
      incoming mail — and runs actions: launch an agent, move the task, comment, notify, send mail.</p>
      <p class="auto-empty-sub">Create one here, or just ask an agent — the <code>cyberlife-auto</code>
      skill teaches every agent to manage rules.</p>
      <button class="fc-btn fc-btn-primary" id="autoEmptyNew">+ New rule (n)</button>
    </div>
  `;
}

function triggerChip(t) {
  const meta = TRIGGER_META[t.type] || { icon: '❓', label: t.type };
  let detail = '';
  if (t.type === 'task-status') detail = t.column;
  else if (t.type === 'cron') detail = t.everyMinutes ? `every ${t.everyMinutes}m` : `daily ${t.dailyAt}`;
  else if (t.type === 'mail') detail = [t.account, t.fromContains && `from~${t.fromContains}`, t.subjectContains && `subj~${t.subjectContains}`].filter(Boolean).join(' ') || 'any';
  else if (t.type === 'webhook') detail = `/api/hooks/${t.slug || '?'}`;
  return `<span class="auto-chip auto-chip-trigger" title="${escapeAttr(meta.label)}">${meta.icon} ${escapeHtml(detail || meta.label)}</span>`;
}

function actionChip(a) {
  const meta = ACTION_META[a.type] || { icon: '❓', label: a.type };
  let detail = '';
  if (a.type === 'run-agent') detail = a.runner && a.runner !== 'claude' ? a.runner : 'claude';
  else if (a.type === 'move-task') detail = `→ ${a.column}`;
  else if (a.type === 'send-mail') detail = a.to;
  else if (a.type === 'webhook') detail = (a.url || '').replace(/^https?:\/\//, '').slice(0, 34);
  return `<span class="auto-chip auto-chip-action" title="${escapeAttr(meta.label)}">${meta.icon} ${escapeHtml(detail || meta.label)}</span>`;
}

function renderRuleRow(rule, i) {
  const scope = projectName(rule.projectId);
  const last = rule.lastRunAt ? relTime(rule.lastRunAt) : null;
  return `
    <div class="auto-rule ${i === as.selected ? 'auto-selected' : ''} ${rule.enabled ? '' : 'auto-disabled'}" data-index="${i}">
      <button class="auto-rule-toggle ${rule.enabled ? 'on' : ''}" title="${rule.enabled ? 'Disable (t)' : 'Enable (t)'}"></button>
      <div class="auto-rule-main">
        <div class="auto-rule-title">
          <span class="auto-rule-name">${escapeHtml(rule.name)}</span>
          <span class="board-chip ${scope ? '' : 'auto-chip-global'}">${scope ? escapeHtml(scope) : 'Global'}</span>
          ${last ? `<span class="auto-rule-last">ran ${last}</span>` : ''}
        </div>
        <div class="auto-rule-flow">
          ${triggerChip(rule.trigger)}
          <span class="auto-flow-arrow">→</span>
          ${(rule.actions || []).map(actionChip).join('<span class="auto-flow-arrow">→</span>')}
        </div>
      </div>
      <button class="fc-btn fc-btn-secondary fc-btn-sm auto-rule-run" title="Run now (r)">▶</button>
    </div>
  `;
}

function renderRunRow(run) {
  const dot = run.status === 'ok' ? 'ok' : 'bad';
  return `
    <div class="auto-run" title="${escapeAttr(run.detail || '')}">
      <span class="health-dot ${dot}"></span>
      <div class="auto-run-main">
        <div class="auto-run-title">${escapeHtml(run.ruleName)}</div>
        <div class="auto-run-detail">${escapeHtml(run.trigger)}${run.detail ? ' · ' + escapeHtml(run.detail) : ''}</div>
      </div>
      <span class="auto-run-time">${relTime(run.startedAt)}</span>
    </div>
  `;
}

// ============================================
// Actions
// ============================================

async function toggleRule(rule) {
  try {
    await SetAutomationRuleEnabled(rule.id, !rule.enabled);
    await loadAutoData();
  } catch (err) {
    console.error('Failed to toggle rule:', err);
  }
}

async function runRule(rule) {
  try {
    await RunAutomationRule(rule.id);
    await loadAutoData();
  } catch (err) {
    console.error('Failed to run rule:', err);
  }
}

async function deleteRule(rule) {
  if (!confirm(`Delete rule "${rule.name}"?`)) return;
  try {
    await DeleteAutomationRule(rule.id);
    await loadAutoData();
  } catch (err) {
    console.error('Failed to delete rule:', err);
  }
}

// ============================================
// Rule editor modal
// ============================================

const TRIGGER_FIELDS = {
  'task-status': [
    { key: 'column', label: 'Column (name)', placeholder: 'Done' },
  ],
  'cron': [
    { key: 'everyMinutes', label: 'Every N minutes', type: 'number', placeholder: '30' },
    { key: 'dailyAt', label: 'or daily at (HH:MM)', placeholder: '09:00' },
  ],
  'mail': [
    { key: 'account', label: 'Account (optional)', kind: 'gmail' },
    { key: 'fromContains', label: 'From contains (optional)', placeholder: 'boss@' },
    { key: 'subjectContains', label: 'Subject contains (optional)', placeholder: 'invoice' },
  ],
  'webhook': [
    { key: 'slug', label: 'Hook slug — fires on POST /api/hooks/<slug>', placeholder: 'deploy-done' },
  ],
  'manual': [],
};

const ACTION_FIELDS = {
  'run-agent': [
    { key: 'runner', label: 'Runner', kind: 'runner' },
    { key: 'prompt', label: 'Prompt', kind: 'textarea', placeholder: 'Review {{task.title}} and report on the board' },
    { key: 'workDir', label: 'Working dir (optional, defaults to project)', placeholder: '' },
  ],
  'move-task': [
    { key: 'column', label: 'Move to column', placeholder: 'In Progress' },
  ],
  'comment': [
    { key: 'text', label: 'Comment text', kind: 'textarea', placeholder: '{{rule.name}}: {{task.title}} entered {{column}}' },
  ],
  'notify': [
    { key: 'title', label: 'Title (optional)', placeholder: '' },
    { key: 'message', label: 'Message', placeholder: '{{task.title}} is done' },
  ],
  'send-mail': [
    { key: 'account', label: 'From account (optional)', kind: 'gmail' },
    { key: 'to', label: 'To', placeholder: 'someone@example.com' },
    { key: 'subject', label: 'Subject', placeholder: '' },
    { key: 'body', label: 'Body', kind: 'textarea', placeholder: '' },
  ],
  'webhook': [
    { key: 'url', label: 'URL (Slack/Discord/Telegram webhook or any endpoint)', placeholder: 'https://hooks.slack.com/services/…' },
    { key: 'method', label: 'Method (default POST)', placeholder: 'POST' },
    { key: 'body', label: 'JSON body (placeholders allowed)', kind: 'textarea', placeholder: '{"text": "{{task.title}} reached {{column}}"}' },
  ],
  'emit-event': [
    { key: 'event', label: 'Event name (addons and open views subscribe to it)', placeholder: 'my-addon.task-done' },
    { key: 'body', label: 'Extra payload (optional, placeholders allowed)', kind: 'textarea', placeholder: '{{task.title}} reached {{column}}' },
  ],
};

function fieldInput(prefix, f, value) {
  const id = `${prefix}-${f.key}`;
  if (f.kind === 'textarea') {
    return `<textarea class="fc-textarea" id="${id}" rows="3" spellcheck="false" placeholder="${escapeAttr(f.placeholder || '')}">${escapeHtml(value || '')}</textarea>`;
  }
  if (f.kind === 'runner') {
    return `<select class="fc-select" id="${id}">
      ${as.runners.map(r => `<option value="${r.id}" ${(value || 'claude') === r.id ? 'selected' : ''}>${escapeHtml(r.name)}</option>`).join('')}
    </select>`;
  }
  if (f.kind === 'gmail') {
    return `<select class="fc-select" id="${id}">
      <option value="">default</option>
      ${as.gmailAccounts.map(a => `<option value="${escapeAttr(a)}" ${value === a ? 'selected' : ''}>${escapeHtml(a)}</option>`).join('')}
    </select>`;
  }
  return `<input type="${f.type || 'text'}" class="fc-input" id="${id}" value="${escapeAttr(value ?? '')}" placeholder="${escapeAttr(f.placeholder || '')}" autocomplete="off" spellcheck="false" />`;
}

function renderFieldGroup(prefix, fields, values) {
  if (!fields.length) return '';
  return `
    <div class="fc-row auto-field-row">
      ${fields.map(f => `
        <div class="fc-field">
          <label>${f.label}</label>
          ${fieldInput(prefix, f, values?.[f.key])}
        </div>
      `).join('')}
    </div>
  `;
}

function openRuleModal(rule) {
  document.getElementById('autoRuleModal')?.remove();
  // Working copy the modal mutates until save
  const draft = rule ? JSON.parse(JSON.stringify(rule)) : {
    name: '', projectId: state.activeProject?.id || '', enabled: true,
    trigger: { type: 'task-status', column: 'Done' },
    actions: [{ type: 'notify', message: '{{rule.name}} fired' }],
  };

  const modal = document.createElement('div');
  modal.id = 'autoRuleModal';
  modal.className = 'modal';
  document.body.appendChild(modal);

  const rerender = () => {
    modal.innerHTML = `
      <div class="modal-content auto-rule-modal">
        <h2>${rule ? 'Edit Rule' : 'New Rule'}</h2>
        <div class="fc-row">
          <div class="fc-field auto-field-grow">
            <label>Name</label>
            <input type="text" class="fc-input" id="armName" value="${escapeAttr(draft.name)}" autocomplete="off" spellcheck="false" />
          </div>
          <div class="fc-field">
            <label>Scope</label>
            <select class="fc-select" id="armScope">
              <option value="">🌐 Global — all projects</option>
              ${as.projects.map(p => `<option value="${p.id}" ${draft.projectId === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
            </select>
          </div>
          <div class="fc-field">
            <label>Enabled</label>
            <select class="fc-select" id="armEnabled">
              <option value="true" ${draft.enabled ? 'selected' : ''}>On</option>
              <option value="false" ${draft.enabled ? '' : 'selected'}>Off</option>
            </select>
          </div>
        </div>

        <div class="auto-modal-section">
          <div class="auto-modal-section-title">${TRIGGER_META[draft.trigger.type]?.icon || ''} When</div>
          <div class="fc-field">
            <label>Trigger</label>
            <select class="fc-select" id="armTrigger">
              ${Object.entries(TRIGGER_META).map(([k, m]) => `<option value="${k}" ${draft.trigger.type === k ? 'selected' : ''}>${m.icon} ${m.label}</option>`).join('')}
            </select>
          </div>
          ${renderFieldGroup('armT', TRIGGER_FIELDS[draft.trigger.type] || [], draft.trigger)}
        </div>

        <div class="auto-modal-section">
          <div class="auto-modal-section-title">⚡ Then</div>
          ${draft.actions.map((a, i) => `
            <div class="auto-modal-action">
              <div class="fc-row auto-action-head">
                <div class="fc-field auto-field-grow">
                  <label>Action ${i + 1}</label>
                  <select class="fc-select" data-action-type="${i}">
                    ${Object.entries(ACTION_META).map(([k, m]) => `<option value="${k}" ${a.type === k ? 'selected' : ''}>${m.icon} ${m.label}</option>`).join('')}
                  </select>
                </div>
                <button type="button" class="fc-btn fc-btn-danger fc-btn-sm auto-action-remove" data-action-remove="${i}" ${draft.actions.length === 1 ? 'disabled' : ''}>×</button>
              </div>
              ${renderFieldGroup(`armA${i}`, ACTION_FIELDS[a.type] || [], a)}
            </div>
          `).join('')}
          <button type="button" class="fc-btn fc-btn-secondary fc-btn-sm" id="armAddAction">+ Add action</button>
          <div class="auto-modal-hint">Placeholders: {{task.title}} {{task.id}} {{column}} {{project.name}} {{project.path}} {{mail.from}} {{mail.subject}} {{rule.name}}</div>
        </div>

        <div class="fc-actions">
          ${rule ? '<button type="button" class="fc-btn fc-btn-danger" id="armDelete">Delete</button>' : ''}
          <span class="fc-spacer"></span>
          <button type="button" class="fc-btn fc-btn-secondary" id="armCancel">Cancel</button>
          <button type="button" class="fc-btn fc-btn-primary" id="armSave">${rule ? 'Save' : 'Create'}</button>
        </div>
      </div>
    `;
    bindModal();
  };

  // Pull current input values into the draft before any structural rerender
  const syncDraft = () => {
    draft.name = modal.querySelector('#armName')?.value ?? draft.name;
    draft.projectId = modal.querySelector('#armScope')?.value ?? draft.projectId;
    draft.enabled = (modal.querySelector('#armEnabled')?.value ?? String(draft.enabled)) === 'true';
    for (const f of TRIGGER_FIELDS[draft.trigger.type] || []) {
      const el = modal.querySelector(`#armT-${f.key}`);
      if (el) draft.trigger[f.key] = f.type === 'number' ? (parseInt(el.value) || 0) : el.value;
    }
    draft.actions.forEach((a, i) => {
      for (const f of ACTION_FIELDS[a.type] || []) {
        const el = modal.querySelector(`#armA${i}-${f.key}`);
        if (el) a[f.key] = el.value;
      }
    });
  };

  const close = () => modal.remove();

  const bindModal = () => {
    modal.querySelector('#armTrigger').addEventListener('change', (e) => {
      syncDraft();
      draft.trigger = { type: e.target.value };
      if (draft.trigger.type === 'task-status') draft.trigger.column = 'Done';
      rerender();
    });
    modal.querySelectorAll('[data-action-type]').forEach(sel => {
      sel.addEventListener('change', () => {
        syncDraft();
        const i = parseInt(sel.dataset.actionType);
        draft.actions[i] = { type: sel.value };
        rerender();
      });
    });
    modal.querySelectorAll('[data-action-remove]').forEach(btn => {
      btn.addEventListener('click', () => {
        syncDraft();
        draft.actions.splice(parseInt(btn.dataset.actionRemove), 1);
        rerender();
      });
    });
    modal.querySelector('#armAddAction').addEventListener('click', () => {
      syncDraft();
      draft.actions.push({ type: 'comment' });
      rerender();
    });
    modal.querySelector('#armCancel').addEventListener('click', close);
    modal.querySelector('#armDelete')?.addEventListener('click', () => {
      close();
      deleteRule(rule);
    });
    modal.querySelector('#armSave').addEventListener('click', async () => {
      syncDraft();
      if (!draft.name.trim()) {
        modal.querySelector('#armName').focus();
        return;
      }
      try {
        await SaveAutomationRule(draft);
        close();
        await loadAutoData();
      } catch (err) {
        console.error('Failed to save rule:', err);
        alert('Save failed: ' + (err?.message || err));
      }
    });
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  };

  modal.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && e.metaKey) {
      e.preventDefault();
      modal.querySelector('#armSave').click();
    }
  });

  rerender();
  modal.querySelector('#armName').focus();
}

// ============================================
// Keyboard (shell NORMAL-mode module hook)
// ============================================

export function autoModuleOnKey(e) {
  const rule = as.rules[as.selected];
  switch (e.key) {
    case 'j':
      e.preventDefault();
      as.selected = Math.min(as.selected + 1, as.rules.length - 1);
      render();
      return true;
    case 'k':
      e.preventDefault();
      as.selected = Math.max(as.selected - 1, 0);
      render();
      return true;
    case 'n':
      e.preventDefault();
      openRuleModal(null);
      return true;
    case 'Enter':
    case 'e':
      if (rule) {
        e.preventDefault();
        openRuleModal(rule);
        return true;
      }
      return false;
    case 't':
      if (rule) {
        e.preventDefault();
        toggleRule(rule);
        return true;
      }
      return false;
    case 'r':
      if (rule) {
        e.preventDefault();
        runRule(rule);
        return true;
      }
      return false;
    case 'd':
      if (rule) {
        e.preventDefault();
        deleteRule(rule);
        return true;
      }
      return false;
  }
  return false;
}

// ============================================
// Helpers
// ============================================


function relTime(iso) {
  const t = new Date(iso).getTime();
  if (!t) return '';
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}

// Enabled task-status rules per column name — the board shows ⚡ on those columns
export function automationColumnHints(projectId, columns) {
  const hints = {};
  for (const rule of as.rules) {
    if (!rule.enabled || rule.trigger.type !== 'task-status') continue;
    if (rule.projectId && rule.projectId !== projectId) continue;
    for (const c of columns) {
      if (c.name.toLowerCase() === (rule.trigger.column || '').toLowerCase() || c.id === rule.trigger.column) {
        (hints[c.id] = hints[c.id] || []).push(rule.name);
      }
    }
  }
  return hints;
}

export async function refreshAutomationRules() {
  try {
    as.rules = await GetAutomationRules() || [];
  } catch (err) {
    console.warn('Failed to refresh automation rules:', err);
  }
}
