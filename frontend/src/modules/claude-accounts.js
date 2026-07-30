// Claude accounts - named CLAUDE_CONFIG_DIR profiles selectable per project/terminal

import { escapeAttr } from './utils.js';
import { state } from './state.js';
import { GetClaudeAccounts, SetClaudeAccounts, SelectDirectory } from '../../wailsjs/go/main/App';

const ADD_OPTION_VALUE = '__add_account__';
const FALLBACK_ACCOUNTS = [{ id: 'default', name: 'Personal · Max', configDir: '' }];

export async function loadClaudeAccounts() {
  try {
    const accounts = await GetClaudeAccounts();
    state.claudeAccounts = accounts && accounts.length ? accounts : FALLBACK_ACCOUNTS;
  } catch (err) {
    console.error('Failed to load Claude accounts:', err);
    state.claudeAccounts = FALLBACK_ACCOUNTS;
  }
  return state.claudeAccounts;
}

export function getClaudeAccounts() {
  return state.claudeAccounts && state.claudeAccounts.length ? state.claudeAccounts : FALLBACK_ACCOUNTS;
}

export function findAccountByConfigDir(configDir) {
  const dir = (configDir || '').trim();
  return getClaudeAccounts().find(a => (a.configDir || '').trim() === dir) || null;
}

function accountBasename(dir) {
  return dir.replace(/\/+$/, '').split('/').pop() || dir;
}


export function buildAccountOptions(selectedConfigDir) {
  const selected = (selectedConfigDir || '').trim();
  const accounts = getClaudeAccounts();
  const options = accounts.map(a => {
    const dir = (a.configDir || '').trim();
    return `<option value="${escapeAttr(dir)}" ${dir === selected ? 'selected' : ''}>${escapeAttr(a.name)}</option>`;
  });
  const isKnown = accounts.some(a => (a.configDir || '').trim() === selected);
  if (selected && !isKnown) {
    options.push(`<option value="${escapeAttr(selected)}" selected>${escapeAttr(accountBasename(selected))} (custom)</option>`);
  }
  options.push(`<option value="${ADD_OPTION_VALUE}">➕ Add account…</option>`);
  return options.join('');
}

export function attachAccountSelect(selectEl) {
  selectEl.dataset.prevValue = selectEl.value;
  selectEl.onchange = async () => {
    if (selectEl.value !== ADD_OPTION_VALUE) {
      selectEl.dataset.prevValue = selectEl.value;
      return;
    }
    const account = await promptNewAccount();
    if (account) {
      selectEl.innerHTML = buildAccountOptions(account.configDir);
    } else {
      selectEl.value = selectEl.dataset.prevValue || '';
    }
    selectEl.dataset.prevValue = selectEl.value;
  };
}

function newAccountId() {
  return `acc-${Date.now()}`;
}

async function persistNewAccount(name, configDir) {
  const accounts = getClaudeAccounts().slice();
  const account = { id: newAccountId(), name, configDir };
  accounts.push(account);
  try {
    await SetClaudeAccounts(accounts);
    state.claudeAccounts = accounts;
    return account;
  } catch (err) {
    console.error('Failed to save Claude account:', err);
    alert('Error saving account: ' + err);
    return null;
  }
}

function promptNewAccount() {
  return new Promise((resolve) => {
    document.querySelector('.account-popup-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'newtab-popup-overlay account-popup-overlay';
    overlay.innerHTML = `
      <div class="newtab-popup account-popup">
        <div class="newtab-popup-header">
          <span class="newtab-popup-title">Add Claude account</span>
        </div>
        <div class="newtab-popup-body">
          <label class="account-popup-label">Name</label>
          <input type="text" class="newtab-popup-input account-popup-name" placeholder="e.g. Enterprise" spellcheck="false" autocomplete="off">
          <label class="account-popup-label">Config dir (CLAUDE_CONFIG_DIR)</label>
          <div class="path-input">
            <input type="text" class="newtab-popup-input account-popup-dir" placeholder="~/.claude-enterprise" spellcheck="false" autocomplete="off">
            <button type="button" class="small-btn account-popup-browse">Browse</button>
          </div>
          <span class="form-hint">Leave empty for the default account (~/.claude)</span>
        </div>
        <div class="newtab-popup-actions">
          <button class="newtab-popup-cancel">Cancel</button>
          <button class="newtab-popup-create">Add</button>
        </div>
      </div>
    `;

    const nameInput = overlay.querySelector('.account-popup-name');
    const dirInput = overlay.querySelector('.account-popup-dir');

    const close = (result) => {
      overlay.remove();
      resolve(result);
    };

    const submit = async () => {
      const name = nameInput.value.trim();
      if (!name) {
        nameInput.focus();
        return;
      }
      const account = await persistNewAccount(name, dirInput.value.trim());
      close(account);
    };

    overlay.querySelector('.account-popup-browse').addEventListener('click', async () => {
      const path = await SelectDirectory();
      if (path) dirInput.value = path;
    });
    overlay.querySelector('.newtab-popup-cancel').addEventListener('click', () => close(null));
    overlay.querySelector('.newtab-popup-create').addEventListener('click', submit);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
    });

    document.body.appendChild(overlay);
    nameInput.focus();
  });
}
