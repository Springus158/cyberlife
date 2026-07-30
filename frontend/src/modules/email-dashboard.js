// Gmail client tab: accounts bar, labels sidebar, thread list, reading pane.
// Actions are optimistic with a 5s undo toast (acorn-style); everything syncs
// straight to Gmail via the Go backend.

import { API_BASE, escapeAttr, escapeHtml } from './utils.js';
import {
  GetGmailConfig, GmailListLabels, GmailListThreads, GmailGetThread,
  GmailModifyThread, GmailTrashThread, GmailUntrashThread,
  GmailGetAttachment, GmailSaveAttachment, GmailOpenAttachment,
  GmailListThreadDrafts, GmailUpdateDraft, GmailSendDraft, GmailDeleteDraft,
  GmailCreateDraft, GmailSendMessage, GmailGetSignature, GmailListContacts, GmailPickAttachments,
  GmailInboxUnread
} from '../../wailsjs/go/main/App';
import { BrowserOpenURL } from '../../wailsjs/runtime/runtime';
import { createSelectableList } from './selectable-list.js';
import { uiIcon } from './ui-icons.js';

export const EMAIL_TAB_ID = 'email-tab';

const UNDO_WINDOW_MS = 5000;
const POLL_INTERVAL_MS = 60000;

const emailState = {
  enabled: false,
  accounts: [],
  account: null,
  labels: [],
  labelId: 'INBOX',
  query: '',
  threads: [],
  nextPageToken: '',
  prevTokens: [],       // page tokens leading to the current page
  currentToken: '',
  selectedId: null,
  threadCache: new Map(),
  openThread: null,
  loadingList: false,
  loadingLabels: false,
  loadingThread: false,
  undo: null,           // {label, thread, index, revert: async fn, timer, deadline}
  pollTimer: null,
  visible: false,
  markReadTimer: null,
  mcpEnabled: false,
  threadDrafts: [],
  draftEditor: null,     // {draftId, to, subject, body, attachments, includeSignature}
  draftFloating: false,  // compose floats over the thread; a reply docks under it
  draftPollTimer: null,
  draftWaiting: false,
  contactsByAccount: {},   // account -> [{name, email, count}]
  signatureByAccount: {},  // account -> signature HTML
  bulkSelected: new Set(), // thread ids selected for bulk actions
  unreadByAccount: {},     // account -> INBOX unread count
  mcpAccounts: new Set(),  // emails exposed to the built-in Gmail MCP server
  // Mail keeps Gmail's light chrome even though the rest of the app is dark
  theme: localStorage.getItem('mailTheme') || 'light',
  openLabels: new Set(readOpenLabels()),
};

function readOpenLabels() {
  try {
    return JSON.parse(localStorage.getItem('mailLabelsOpen') || '[]');
  } catch (err) {
    console.warn('mail: stored label expansion is unreadable, starting collapsed', err);
    return [];
  }
}

function toggleLabelBranch(path) {
  if (emailState.openLabels.has(path)) emailState.openLabels.delete(path);
  else emailState.openLabels.add(path);
  localStorage.setItem('mailLabelsOpen', JSON.stringify([...emailState.openLabels]));
  renderLabelsSidebar();
}

function toggleMailTheme() {
  emailState.theme = emailState.theme === 'light' ? 'dark' : 'light';
  localStorage.setItem('mailTheme', emailState.theme);
  document.querySelector('.email-layout')?.setAttribute('data-theme', emailState.theme);
  renderThemeToggle();
}

function renderThemeToggle() {
  const btn = document.getElementById('emailThemeBtn');
  if (!btn) return;
  const next = emailState.theme === 'light' ? 'dark' : 'light';
  btn.innerHTML = uiIcon(emailState.theme === 'light' ? 'darkMode' : 'lightMode');
  btn.title = `Switch to ${next} mode`;
}

function applyAccountConfig(cfg) {
  const infos = cfg?.accounts || [];
  emailState.accounts = infos.map(a => a.email);
  emailState.mcpAccounts = new Set(infos.filter(a => a.mcpEnabled).map(a => a.email));
}

const SYSTEM_LABELS = [
  { id: 'INBOX', name: 'Inbox', icon: 'inbox' },
  { id: 'STARRED', name: 'Starred', icon: 'star' },
  { id: 'SENT', name: 'Sent', icon: 'send' },
  { id: 'DRAFT', name: 'Drafts', icon: 'draft' },
  { id: 'ALL', name: 'All Mail', icon: 'mail' },
  { id: 'SPAM', name: 'Spam', icon: 'spam' },
  { id: 'TRASH', name: 'Trash', icon: 'trash' },
];

export function showEmailPanel(show) {
  const panel = document.getElementById('emailPanel');
  if (panel) panel.style.display = show ? 'flex' : 'none';
  emailState.visible = show;
  document.querySelector('.app-container')?.classList.toggle('email-fullscreen', show);
  if (show) {
    startPolling();
  } else {
    stopPolling();
  }
}

export async function updateEmailButton() {
  try {
    const cfg = await GetGmailConfig();
    emailState.enabled = !!cfg?.enabled;
    applyAccountConfig(cfg);
    // Legacy sidebar button — kept working if some layout still renders it
    const btn = document.getElementById('openEmailBtn');
    if (btn) {
      btn.style.display = emailState.enabled && (cfg?.accounts || []).length > 0 ? 'flex' : 'none';
    }
  } catch (err) {
    console.error('Failed to load Gmail config:', err);
  }
}
window.emailUpdateButton = updateEmailButton;

export function getEmailUnread() {
  const inbox = emailState.labels.find(l => l.id === 'INBOX');
  return inbox?.unread || 0;
}

function updateUnreadBadge() {
  const unread = getEmailUnread();
  const badge = document.getElementById('emailUnreadBadge');
  if (badge) {
    badge.textContent = unread > 99 ? '99+' : String(unread);
    badge.style.display = unread > 0 ? 'inline-flex' : 'none';
  }
  import('./shell.js').then(({ refreshBadges }) => refreshBadges())
    .catch((err) => { console.warn('shell badge refresh failed:', err); });
}

// ============================================
// Data loading
// ============================================

async function loadLabels() {
  // Unread counts cost one API call per label, so a second concurrent pass
  // doubles the slowest part of opening Mail for nothing.
  if (!emailState.account || emailState.loadingLabels) return;
  emailState.loadingLabels = true;
  try {
    emailState.labels = await GmailListLabels(emailState.account) || [];
    updateUnreadBadge();
    renderLabelsSidebar();
  } catch (err) {
    console.error('Failed to load labels:', err);
  } finally {
    emailState.loadingLabels = false;
  }
}

async function loadThreads({ token = '', direction = 'reset' } = {}) {
  if (!emailState.account || emailState.loadingList) return;
  emailState.loadingList = true;
  renderThreadList();
  try {
    const labelId = emailState.labelId === 'ALL' ? '' : emailState.labelId;
    const page = await GmailListThreads(emailState.account, emailState.query ? '' : labelId, emailState.query, token);
    if (direction === 'older') {
      emailState.prevTokens.push(emailState.currentToken);
    } else if (direction === 'newer') {
      emailState.prevTokens.pop();
    } else {
      emailState.prevTokens = [];
      emailState.bulkSelected.clear();
    }
    emailState.currentToken = token;
    emailState.threads = page?.threads || [];
    emailState.nextPageToken = page?.nextPageToken || '';
    if (!emailState.threads.some(t => t.id === emailState.selectedId)) {
      emailState.selectedId = null;
    }
  } catch (err) {
    console.error('Failed to load threads:', err);
    const msg = String(err);
    if (/401|unauthorized|invalid_grant/i.test(msg)) {
      showToast(`✗ ${emailState.account} needs re-authorization — Settings → Gmail → Re-auth`, true);
    } else {
      showToast(`✗ ${msg}`, true);
    }
  } finally {
    emailState.loadingList = false;
    renderThreadList();
  }
}

async function openThread(threadId, { forceFresh = false } = {}) {
  if (emailState.selectedId !== threadId) {
    stopDraftPolling();
    emailState.threadDrafts = [];
    // A floating new message is not tied to the thread being left behind
    if (!emailState.draftFloating) emailState.draftEditor = null;
  }
  emailState.selectedId = threadId;
  paintSelection();
  // Opening (keyboard, mouse or hint click) always lands the cursor here
  mailList.syncTo(el => el.dataset.thread === threadId);
  loadThreadDrafts(threadId);

  if (!forceFresh && emailState.threadCache.has(threadId)) {
    emailState.openThread = emailState.threadCache.get(threadId);
    renderReadingPane();
  } else {
    emailState.loadingThread = true;
    emailState.openThread = null;
    renderReadingPane();
    try {
      const detail = await GmailGetThread(emailState.account, threadId);
      emailState.threadCache.set(threadId, detail);
      if (emailState.selectedId === threadId) {
        emailState.openThread = detail;
      }
    } catch (err) {
      console.error('Failed to load thread:', err);
      showToast(`✗ ${err}`, true);
    } finally {
      emailState.loadingThread = false;
      if (emailState.selectedId === threadId) renderReadingPane();
    }
  }

}

// ============================================
// Actions (optimistic, with undo)
// ============================================

function adjustLabelUnread(delta) {
  const label = emailState.labels.find(l => l.id === (emailState.labelId === 'ALL' ? 'INBOX' : emailState.labelId));
  if (label) label.unread = Math.max(0, (label.unread || 0) + delta);
  const inbox = emailState.labels.find(l => l.id === 'INBOX');
  if (inbox) updateUnreadBadge();
  if (emailState.labelId === 'INBOX' || emailState.labelId === 'ALL') {
    const acc = emailState.account;
    emailState.unreadByAccount[acc] = Math.max(0, (emailState.unreadByAccount[acc] || 0) + delta);
    renderAccountsBar();
  }
  renderLabelsSidebar();
}

async function setThreadRead(threadId, read) {
  const row = emailState.threads.find(t => t.id === threadId);
  if (row) {
    if (row.unread === !read) return;
    row.unread = !read;
    repaintRow(threadId);
    adjustLabelUnread(read ? -1 : 1);
  }
  try {
    await GmailModifyThread(emailState.account, threadId,
      read ? [] : ['UNREAD'], read ? ['UNREAD'] : []);
  } catch (err) {
    console.error('Failed to change read state:', err);
    if (row) { row.unread = read; repaintRow(threadId); adjustLabelUnread(read ? 1 : -1); }
    showToast(`✗ ${err}`, true);
  }
}

async function setThreadStarred(threadId, starred) {
  const row = emailState.threads.find(t => t.id === threadId);
  if (row) { row.starred = starred; repaintRow(threadId); }
  try {
    await GmailModifyThread(emailState.account, threadId,
      starred ? ['STARRED'] : [], starred ? [] : ['STARRED']);
  } catch (err) {
    console.error('Failed to change star:', err);
    if (row) { row.starred = !starred; repaintRow(threadId); }
    showToast(`✗ ${err}`, true);
  }
}

function removeRow(threadId) {
  const index = emailState.threads.findIndex(t => t.id === threadId);
  if (index < 0) return { row: null, index: -1 };
  const wasSelected = emailState.selectedId === threadId;
  const [row] = emailState.threads.splice(index, 1);
  if (wasSelected) {
    emailState.selectedId = null;
    emailState.openThread = null;
  }
  renderThreadList();
  if (wasSelected) {
    // Gmail-style auto-advance: open whatever now sits at this position
    const next = emailState.threads[Math.min(index, emailState.threads.length - 1)];
    if (next) {
      openThread(next.id);
    } else {
      renderReadingPane();
    }
  }
  return { row, index };
}

function restoreRow(row, index) {
  emailState.threads.splice(Math.min(index, emailState.threads.length), 0, row);
  renderThreadList();
}

async function archiveThread(threadId) {
  const { row, index } = removeRow(threadId);
  if (!row) return;
  if (row.unread) adjustLabelUnread(-1);
  try {
    await GmailModifyThread(emailState.account, threadId, [], ['INBOX']);
    armUndo(`Archived "${truncate(row.subject, 40)}"`, async () => {
      await GmailModifyThread(emailState.account, threadId, ['INBOX'], []);
      restoreRow(row, index);
      if (row.unread) adjustLabelUnread(1);
    });
  } catch (err) {
    console.error('Archive failed:', err);
    restoreRow(row, index);
    if (row.unread) adjustLabelUnread(1);
    showToast(`✗ ${err}`, true);
  }
}

async function trashThread(threadId) {
  const { row, index } = removeRow(threadId);
  if (!row) return;
  if (row.unread) adjustLabelUnread(-1);
  try {
    await GmailTrashThread(emailState.account, threadId);
    armUndo(`Deleted "${truncate(row.subject, 40)}"`, async () => {
      await GmailUntrashThread(emailState.account, threadId);
      restoreRow(row, index);
      if (row.unread) adjustLabelUnread(1);
    });
  } catch (err) {
    console.error('Trash failed:', err);
    restoreRow(row, index);
    if (row.unread) adjustLabelUnread(1);
    showToast(`✗ ${err}`, true);
  }
}

async function toggleUserLabel(threadId, labelId, apply) {
  try {
    await GmailModifyThread(emailState.account, threadId,
      apply ? [labelId] : [], apply ? [] : [labelId]);
    const row = emailState.threads.find(t => t.id === threadId);
    if (row) {
      row.labelIds = apply
        ? [...new Set([...(row.labelIds || []), labelId])]
        : (row.labelIds || []).filter(l => l !== labelId);
      renderThreadList();
    }
  } catch (err) {
    console.error('Label change failed:', err);
    showToast(`✗ ${err}`, true);
  }
}

// ============================================
// Drafts + Claude MCP reply
// ============================================

async function loadThreadDrafts(threadId) {
  try {
    const drafts = await GmailListThreadDrafts(emailState.account, threadId) || [];
    if (emailState.selectedId !== threadId) return;
    emailState.threadDrafts = drafts;
    // This lands after the message is already on screen, so repainting the
    // whole pane would reload every message iframe — a visible flash for a
    // button that is usually not even there. Only the button is touched.
    renderThreadDraftsButton();
  } catch (err) {
    console.error('Failed to load thread drafts:', err);
  }
}

function renderThreadDraftsButton() {
  const host = document.getElementById('emailDraftsBadge');
  if (!host) return;
  const count = emailState.threadDrafts.length;
  host.innerHTML = count > 0 && !emailState.draftEditor
    ? `<button class="email-pill" data-act="opendraft">${uiIcon('draft', 18)}<span>Draft (${count})</span></button>`
    : '';
  host.querySelector('[data-act="opendraft"]')
    ?.addEventListener('click', () => openDraftEditor(emailState.threadDrafts[0]));
}

function claudeDraftReply(thread) {
  const last = thread.messages[thread.messages.length - 1];
  const subject = (thread.messages[0]?.subject || '').replace(/"/g, '');
  const prompt = [
    `Use the gmail MCP tools with account="${emailState.account}".`,
    `1) Call gmail_search with query 'subject:"${subject}"' to find the message from ${last?.from || 'unknown'} (${last?.dateText || ''}) and note its id.`,
    `2) Call gmail_read on that id to read it.`,
    `3) Write a reply and create it as a DRAFT with gmail_draft_reply (same id).`,
    `Do NOT use gmail_send or gmail_reply — nothing may be sent. Reply in the same language as the thread, concise and helpful.`,
    `Confirm briefly once the draft exists.`
  ].join(' ');

  if (typeof window.itermSendText !== 'function') {
    showToast('✗ No Claude terminal available', true);
    return;
  }
  window.itermSendText(prompt);
  emailState.draftWaiting = true;
  renderReadingPane();
  showToast('🤖 Prompt sent to Claude — waiting for the draft…');
  startDraftPolling(thread.id);
}

function startDraftPolling(threadId) {
  stopDraftPolling();
  const started = Date.now();
  const known = new Set(emailState.threadDrafts.map(d => d.draftId));
  emailState.draftPollTimer = setInterval(async () => {
    if (Date.now() - started > 240000 || emailState.selectedId !== threadId) {
      stopDraftPolling();
      renderReadingPane();
      return;
    }
    try {
      const drafts = await GmailListThreadDrafts(emailState.account, threadId) || [];
      const fresh = drafts.find(d => !known.has(d.draftId));
      if (fresh) {
        stopDraftPolling();
        emailState.threadDrafts = drafts;
        openDraftEditor(fresh);
        showToast('🤖 Claude draft is ready — edit it below');
      }
    } catch (err) {
      console.error('Draft polling failed:', err);
    }
  }, 5000);
}

function stopDraftPolling() {
  if (emailState.draftPollTimer) {
    clearInterval(emailState.draftPollTimer);
    emailState.draftPollTimer = null;
  }
  emailState.draftWaiting = false;
}

// Reply to the open thread. all=true replies to everyone from the last
// message except me; all=false only to the sender (or, when the last
// message is mine, back to its recipients).
function replyToOpenThread(all) {
  const thread = emailState.openThread;
  const last = thread?.messages?.[thread.messages.length - 1];
  if (!last) return false;
  const me = (emailState.account || '').toLowerCase();
  const seen = new Set();
  const recipients = [];
  const collect = (s) => (s || '').split(',').forEach(raw => {
    const addr = raw.trim();
    if (!addr) return;
    const email = ((addr.match(/<([^>]+)>/) || [])[1] || addr).toLowerCase();
    if (!email || email === me || seen.has(email)) return;
    seen.add(email);
    recipients.push(addr);
  });
  collect(last.from);
  if (all || recipients.length === 0) {
    collect(last.to);
    if (all) collect(last.cc);
  }
  if (recipients.length === 0) return false;

  const subject = last.subject || thread.messages[0]?.subject || '';
  emailState.draftFloating = false;
  emailState.draftEditor = {
    draftId: null,
    to: recipients.join(', '),
    subject: /^re:/i.test(subject) ? subject : 'Re: ' + subject,
    body: '',
    attachments: [],
    includeSignature: true,
  };
  ensureComposeMeta();
  renderDraftEditor();
  setTimeout(() => document.getElementById('emailDraftBody')?.focus(), 0);
  return true;
}

function forwardOpenThread() {
  const thread = emailState.openThread;
  const last = thread?.messages?.[thread.messages.length - 1];
  if (!last) return false;
  const subject = last.subject || thread.messages[0]?.subject || '';
  const quoted = last.bodyText || htmlToText(last.bodyHtml || '');
  emailState.draftFloating = false;
  emailState.draftEditor = {
    draftId: null,
    to: '',
    subject: /^fwd:/i.test(subject) ? subject : 'Fwd: ' + subject,
    body: [
      '',
      '---------- Forwarded message ----------',
      `From: ${last.from || ''}`,
      `Date: ${last.dateText || ''}`,
      `Subject: ${subject}`,
      `To: ${last.to || ''}`,
      '',
      quoted,
    ].join('\n'),
    attachments: [],
    includeSignature: true,
  };
  ensureComposeMeta();
  renderDraftEditor();
  setTimeout(() => document.getElementById('emailDraftTo')?.focus(), 0);
  return true;
}

function openDraftEditor(draft) {
  emailState.draftFloating = false;
  emailState.draftEditor = {
    draftId: draft.draftId,
    to: draft.to || '',
    subject: draft.subject || '',
    body: draft.bodyText || htmlToText(draft.bodyHtml || ''),
    attachments: [],
    includeSignature: true,
  };
  ensureComposeMeta();
  renderDraftEditor();
  document.getElementById('emailDraftBody')?.focus();
}

async function ensureComposeMeta() {
  const acc = emailState.account;
  if (!(acc in emailState.signatureByAccount)) {
    try {
      emailState.signatureByAccount[acc] = await GmailGetSignature(acc) || '';
    } catch (err) {
      console.error('Signature load failed:', err);
      emailState.signatureByAccount[acc] = '';
    }
    updateSignaturePreview();
  }
  if (!(acc in emailState.contactsByAccount)) {
    try {
      emailState.contactsByAccount[acc] = await GmailListContacts(acc) || [];
    } catch (err) {
      console.error('Contacts load failed:', err);
      emailState.contactsByAccount[acc] = [];
    }
  }
}

function updateSignaturePreview() {
  const block = document.getElementById('emailSigBlock');
  const content = document.getElementById('emailSigPreviewContent');
  const sig = emailState.signatureByAccount[emailState.account] || '';
  if (block) block.style.display = sig ? '' : 'none';
  if (content) content.innerHTML = sig;
}

function currentSignature() {
  const editor = emailState.draftEditor;
  if (!editor?.includeSignature) return '';
  return emailState.signatureByAccount[emailState.account] || '';
}

function readDraftEditorForm() {
  return {
    to: document.getElementById('emailDraftTo')?.value || '',
    subject: document.getElementById('emailDraftSubject')?.value || '',
    body: document.getElementById('emailDraftBody')?.value || '',
  };
}

async function saveDraft() {
  const editor = emailState.draftEditor;
  if (!editor) return;
  const form = readDraftEditorForm();
  try {
    if (editor.draftId) {
      await GmailUpdateDraft(emailState.account, editor.draftId, form.to, form.subject, form.body, currentSignature(), editor.attachments);
    } else {
      editor.draftId = await GmailCreateDraft(emailState.account, form.to, form.subject, form.body, currentSignature(), editor.attachments);
    }
    Object.assign(editor, form);
    showToast('💾 Draft saved to Gmail');
  } catch (err) {
    console.error('Draft save failed:', err);
    showToast(`✗ ${err}`, true);
  }
}

async function sendDraft() {
  const editor = emailState.draftEditor;
  if (!editor) return;
  const form = readDraftEditorForm();
  if (!form.to.trim()) {
    showToast('✗ Add a recipient first', true);
    return;
  }
  try {
    if (editor.draftId) {
      await GmailUpdateDraft(emailState.account, editor.draftId, form.to, form.subject, form.body, currentSignature(), editor.attachments);
      await GmailSendDraft(emailState.account, editor.draftId);
    } else {
      await GmailSendMessage(emailState.account, form.to, form.subject, form.body, currentSignature(), editor.attachments);
    }
    const wasFloating = emailState.draftFloating;
    emailState.draftEditor = null;
    emailState.draftFloating = false;
    emailState.threadDrafts = emailState.threadDrafts.filter(d => d.draftId !== editor.draftId);
    showToast('📤 Sent');
    closeComposeWindow();
    if (!wasFloating && emailState.selectedId) {
      openThread(emailState.selectedId, { forceFresh: true });
    } else if (!wasFloating) {
      renderReadingPane();
    }
  } catch (err) {
    console.error('Draft send failed:', err);
    showToast(`✗ ${err}`, true);
  }
}

async function discardDraft() {
  const editor = emailState.draftEditor;
  if (!editor) return;
  try {
    if (editor.draftId) {
      await GmailDeleteDraft(emailState.account, editor.draftId);
      emailState.threadDrafts = emailState.threadDrafts.filter(d => d.draftId !== editor.draftId);
      showToast('Draft discarded');
    }
    emailState.draftEditor = null;
    renderDraftEditor();
  } catch (err) {
    console.error('Draft discard failed:', err);
    showToast(`✗ ${err}`, true);
  }
}

function htmlToText(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.innerText || '';
}

function toggleAllOnPage() {
  const all = emailState.threads.every(t => emailState.bulkSelected.has(t.id));
  emailState.threads.forEach(t => {
    if (all) emailState.bulkSelected.delete(t.id);
    else emailState.bulkSelected.add(t.id);
  });
}

// bulkAction runs trash/archive/read over the selection; trash+archive get a joint undo
async function bulkAction(kind) {
  const ids = [...emailState.bulkSelected].filter(id => emailState.threads.some(t => t.id === id));
  if (ids.length === 0) return;
  emailState.bulkSelected.clear();

  if (kind === 'read') {
    for (const id of ids) {
      const row = emailState.threads.find(t => t.id === id);
      if (row?.unread) await setThreadRead(id, true);
    }
    renderThreadList();
    return;
  }

  // Capture rows + positions, remove optimistically
  const removed = ids
    .map(id => ({ index: emailState.threads.findIndex(t => t.id === id) }))
    .filter(r => r.index >= 0)
    .sort((a, b) => a.index - b.index)
    .map(r => ({ index: r.index, row: emailState.threads[r.index] }));
  for (let i = removed.length - 1; i >= 0; i--) {
    emailState.threads.splice(removed[i].index, 1);
  }
  const unreadCount = removed.filter(r => r.row.unread).length;
  if (unreadCount > 0) adjustLabelUnread(-unreadCount);
  if (removed.some(r => r.row.id === emailState.selectedId)) {
    emailState.selectedId = null;
    emailState.openThread = null;
    renderReadingPane();
  }
  renderThreadList();

  const act = kind === 'trash'
    ? (id) => GmailTrashThread(emailState.account, id)
    : (id) => GmailModifyThread(emailState.account, id, [], ['INBOX']);
  const revertOne = kind === 'trash'
    ? (id) => GmailUntrashThread(emailState.account, id)
    : (id) => GmailModifyThread(emailState.account, id, ['INBOX'], []);

  const results = await Promise.allSettled(removed.map(r => act(r.row.id)));
  const failed = removed.filter((r, i) => results[i].status === 'rejected');
  if (failed.length > 0) {
    // Put failures back where they were
    failed.forEach(f => restoreRow(f.row, f.index));
    if (failed.some(f => f.row.unread)) adjustLabelUnread(failed.filter(f => f.row.unread).length);
    showToast(`✗ ${failed.length} of ${removed.length} failed`, true);
  }
  const succeeded = removed.filter((r, i) => results[i].status === 'fulfilled');
  if (succeeded.length > 0) {
    armUndo(`${kind === 'trash' ? 'Deleted' : 'Archived'} ${succeeded.length} conversation${succeeded.length > 1 ? 's' : ''}`, async () => {
      await Promise.allSettled(succeeded.map(r => revertOne(r.row.id)));
      succeeded.forEach(r => restoreRow(r.row, r.index));
      const restoredUnread = succeeded.filter(r => r.row.unread).length;
      if (restoredUnread > 0) adjustLabelUnread(restoredUnread);
    });
  }
}

// ============================================
// Undo toast
// ============================================

function armUndo(label, revert) {
  cancelUndo(false);
  const deadline = Date.now() + UNDO_WINDOW_MS;
  emailState.undo = {
    label, revert, deadline,
    timer: setTimeout(() => { emailState.undo = null; renderUndoToast(); }, UNDO_WINDOW_MS),
  };
  renderUndoToast();
}

function cancelUndo(render = true) {
  if (emailState.undo) {
    clearTimeout(emailState.undo.timer);
    emailState.undo = null;
  }
  if (render) renderUndoToast();
}

async function fireUndo() {
  const undo = emailState.undo;
  if (!undo) return;
  cancelUndo(false);
  renderUndoToast();
  try {
    await undo.revert();
    showToast('Restored');
  } catch (err) {
    console.error('Undo failed:', err);
    showToast(`✗ Undo failed: ${err}`, true);
  }
}

function renderUndoToast() {
  const host = document.getElementById('emailToastHost');
  if (!host) return;
  const undo = emailState.undo;
  if (!undo) {
    host.querySelector('.email-undo-toast')?.remove();
    return;
  }
  host.innerHTML = `
    <div class="email-undo-toast">
      <span>${escapeHtml(undo.label)}</span>
      <button class="email-undo-btn" id="emailUndoBtn">Undo</button>
      <div class="email-undo-progress"><div class="email-undo-progress-fill" style="animation-duration:${UNDO_WINDOW_MS}ms"></div></div>
    </div>
  `;
  document.getElementById('emailUndoBtn')?.addEventListener('click', fireUndo);
}

let toastTimer = null;
function showToast(text, isError = false) {
  const host = document.getElementById('emailToastHost');
  if (!host || emailState.undo) return;
  host.innerHTML = `<div class="email-undo-toast ${isError ? 'error' : ''}"><span>${escapeHtml(String(text))}</span></div>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { if (!emailState.undo) host.innerHTML = ''; }, isError ? 6000 : 2500);
}

// ============================================
// Keyboard (shell NORMAL-mode module hook)
// ============================================

const threadIdOf = (el) => el?.dataset?.thread || null;

const mailList = createSelectableList({
  getItems: () => [...document.querySelectorAll('#emailPanel .email-row')],
  getKey: (el) => el.dataset.thread,
  anchor: () => emailState.selectedId ? (el) => el.dataset.thread === emailState.selectedId : null,
  onOpen: (el) => {
    const id = threadIdOf(el);
    if (id) openThread(id);
  },
  // Reading pane open: j/k browse mails directly (cursor and open thread
  // stay one thing); pane closed: j/k only move the cursor
  onMove: (el) => {
    if (!emailState.selectedId) return;
    const id = threadIdOf(el);
    if (id && id !== emailState.selectedId) openThread(id);
  },
  verbs: {
    o: (el) => { const id = threadIdOf(el); if (id) openThread(id); },
    e: (el) => { const id = threadIdOf(el); if (id) archiveThread(id); },
    '#': (el) => { const id = threadIdOf(el); if (id) trashThread(id); },
    z: () => fireUndo(),
    u: (el) => {
      const id = threadIdOf(el);
      const row = id && emailState.threads.find(t => t.id === id);
      if (row) setThreadRead(id, row.unread);
    },
    s: (el) => {
      const id = threadIdOf(el);
      const row = id && emailState.threads.find(t => t.id === id);
      if (row) setThreadStarred(id, !row.starred);
    },
    a: (el) => replyVerb(el, true),
    R: (el) => replyVerb(el, false),
    f: async (el) => {
      if (!emailState.openThread) {
        const id = threadIdOf(el) || emailState.selectedId;
        if (!id) return;
        await openThread(id);
      }
      forwardOpenThread();
    },
    x: (el) => {
      const id = threadIdOf(el);
      if (!id) return;
      if (emailState.bulkSelected.has(id)) emailState.bulkSelected.delete(id);
      else emailState.bulkSelected.add(id);
      renderThreadList();
    },
    '*': () => { toggleAllOnPage(); renderThreadList(); },
    I: () => { if (emailState.selectedId) setThreadRead(emailState.selectedId, true); },
    U: () => { if (emailState.selectedId) setThreadRead(emailState.selectedId, false); },
    c: () => document.getElementById('emailComposeBtn')?.click(),
    r: () => document.getElementById('emailRefreshBtn')?.click(),
    '/': () => document.getElementById('emailSearchInput')?.focus(),
  },
});

// Reply works from anywhere: open thread first when needed (cursor row,
// last selection, or the first visible thread)
async function replyVerb(el, all) {
  if (!emailState.openThread) {
    const id = threadIdOf(el) || emailState.selectedId || emailState.threads[0]?.id;
    if (!id) return;
    await openThread(id);
  }
  replyToOpenThread(all);
}

export function emailModuleOnKey(e) {
  // Esc: attachment preview first, then the reading pane, then global
  if (e.key === 'Escape') {
    const overlay = document.getElementById('emailPreviewOverlay');
    if (overlay && overlay.style.display !== 'none') {
      e.preventDefault();
      overlay.style.display = 'none';
      overlay.innerHTML = '';
      return true;
    }
    if (emailState.openThread || emailState.selectedId) {
      e.preventDefault();
      closeReadingPane();
      return true;
    }
    return false;
  }
  return mailList.onKey(e);
}

// ============================================
// Render
// ============================================

export async function renderEmailPanel() {
  const panel = document.getElementById('emailPanel');
  if (!panel) return;
  addEmailStyles();

  const cfg = await GetGmailConfig().catch(() => null);
  emailState.enabled = !!cfg?.enabled;
  emailState.mcpEnabled = !!cfg?.mcpEnabled;
  applyAccountConfig(cfg);

  if (!emailState.enabled || emailState.accounts.length === 0) {
    panel.innerHTML = `
      <div class="email-empty-state">
        <div class="email-empty-icon">✉️</div>
        <h2>Gmail is not set up</h2>
        <p>Enable the Gmail client and connect an account in <strong>Settings → Gmail</strong>.</p>
        <button class="settings-btn primary" id="emailGoSettings">Open Settings</button>
      </div>
    `;
    document.getElementById('emailGoSettings')?.addEventListener('click', () => {
      import('./module-host.js').then(({ switchToSettingsTab }) => switchToSettingsTab());
    });
    return;
  }

  if (!emailState.account || !emailState.accounts.includes(emailState.account)) {
    emailState.account = emailState.accounts[0];
  }

  panel.innerHTML = `
    <div class="email-layout" data-theme="${escapeAttr(emailState.theme)}">
      <div class="email-topbar">
        <div class="email-search">
          <span class="email-search-icon">${uiIcon('search', 20)}</span>
          <input type="text" id="emailSearchInput" placeholder="Search mail"
            value="${escapeAttr(emailState.query)}" spellcheck="false" autocomplete="off">
          ${emailState.query ? `<button class="email-icon-btn email-search-clear" id="emailSearchClear" title="Clear search">${uiIcon('close', 20)}</button>` : ''}
        </div>
        <div class="email-accounts" id="emailAccounts" data-hint-priority></div>
        <button class="email-icon-btn" id="emailThemeBtn"></button>
        <button class="email-icon-btn" id="emailRefreshBtn" title="Refresh (r)">${uiIcon('refresh', 20)}</button>
        <button class="email-icon-btn" id="emailTabCloseBtn" title="Close Mail">${uiIcon('close', 20)}</button>
      </div>
      <div class="email-body">
        <div class="email-labels" id="emailLabels"></div>
        <div class="email-list" id="emailThreadList"></div>
        <div class="email-reading" id="emailReadingPane"></div>
      </div>
      <div class="email-compose-window" id="emailComposeWindow" style="display:none"></div>
      <div id="emailToastHost"></div>
      <div id="emailPreviewOverlay" style="display:none"></div>
    </div>
  `;

  renderThemeToggle();
  document.getElementById('emailThemeBtn')?.addEventListener('click', toggleMailTheme);
  renderAccountsBar();
  renderLabelsSidebar();
  renderThreadList();
  renderReadingPane();
  loadAccountUnreads();

  document.getElementById('emailTabCloseBtn')?.addEventListener('click', () => {
    import('./module-host.js').then(({ switchToDashboardTab }) => switchToDashboardTab());
  });
  document.getElementById('emailRefreshBtn')?.addEventListener('click', () => {
    emailState.threadCache.clear();
    loadLabels();
    loadThreads();
  });
  const search = document.getElementById('emailSearchInput');
  search?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      emailState.query = search.value.trim();
      loadThreads();
      renderEmailPanel();
    }
    if (e.key === 'Escape') { search.blur(); }
    e.stopPropagation();
  });
  document.getElementById('emailSearchClear')?.addEventListener('click', () => {
    emailState.query = '';
    loadThreads();
    renderEmailPanel();
  });

  if (emailState.labels.length === 0 || emailState.threads.length === 0) {
    await loadLabels();
    await loadThreads();
  }
}

async function loadAccountUnreads() {
  await Promise.allSettled(emailState.accounts.map(async (email) => {
    try {
      emailState.unreadByAccount[email] = await GmailInboxUnread(email);
    } catch (err) {
      console.error('Unread count failed for', email, err);
    }
  }));
  renderAccountsBar();
}

function renderAccountsBar() {
  const host = document.getElementById('emailAccounts');
  if (!host) return;
  host.innerHTML = emailState.accounts.map(email => {
    const unread = emailState.unreadByAccount[email] || 0;
    return `
    <button class="email-account-chip ${email === emailState.account ? 'active' : ''}"
      data-email="${escapeAttr(email)}" title="${escapeAttr(email)}">
      <span class="email-avatar" style="background:${avatarColor(email)}">${escapeHtml(email[0].toUpperCase())}</span>
      <span class="email-account-addr">${escapeHtml(email.split('@')[0])}</span>
      ${unread > 0 ? `<span class="email-account-unread">${unread > 99 ? '99+' : unread}</span>` : ''}
    </button>`;
  }).join('');
  host.querySelectorAll('.email-account-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      if (chip.dataset.email === emailState.account) return;
      emailState.account = chip.dataset.email;
      emailState.labels = [];
      emailState.threads = [];
      emailState.threadCache.clear();
      emailState.selectedId = null;
      emailState.openThread = null;
      emailState.labelId = 'INBOX';
      emailState.query = '';
      mailList.reset();
      // renderEmailPanel refetches on its own once the lists above are empty;
      // calling load* here as well fetched every label and thread twice.
      renderEmailPanel();
    });
  });
}

function buildLabelTree(labels) {
  const roots = [];
  const byPath = new Map();
  for (const label of labels) {
    let path = '';
    let siblings = roots;
    for (const segment of label.name.split('/')) {
      path = path ? `${path}/${segment}` : segment;
      let node = byPath.get(path);
      if (!node) {
        node = { path, name: segment, label: null, children: [] };
        byPath.set(path, node);
        siblings.push(node);
      }
      siblings = node.children;
    }
    byPath.get(label.name).label = label;
  }
  return roots.map(collapseUnlabelledPath);
}

// A path segment with no label of its own is not a row in Gmail: with only
// "Git CI/CD" defined, the sidebar shows that one entry rather than an empty
// "Git CI" parent wrapping a "CD" child.
function collapseUnlabelledPath(node) {
  let row = node;
  while (!row.label && row.children.length === 1) {
    const child = row.children[0];
    row = { ...child, name: `${row.name}/${child.name}` };
  }
  return { ...row, children: row.children.map(collapseUnlabelledPath) };
}

function branchUnread(node) {
  return (node.label?.unread || 0) + node.children.reduce((sum, child) => sum + branchUnread(child), 0);
}

function renderLabelsSidebar() {
  const host = document.getElementById('emailLabels');
  if (!host) return;
  const byId = new Map(emailState.labels.map(l => [l.id, l]));
  const userLabels = emailState.labels
    .filter(l => l.type === 'user' && !l.hidden)
    .sort((a, b) => a.name.localeCompare(b.name));

  const renderRow = ({ id, name, icon, color, unread = 0, depth = 0, branch = null, open = false }) => {
    const glyph = icon
      ? uiIcon(icon)
      : `<span class="email-label-dot" style="background:${color || 'currentColor'}">${uiIcon('label')}</span>`;
    const active = id && emailState.labelId === id && !emailState.query;
    return `
      <div class="email-label-row ${active ? 'active' : ''} ${unread > 0 ? 'unread' : ''}" style="--depth:${depth}">
        ${branch
          ? `<button class="email-label-twisty ${open ? 'open' : ''}" data-toggle="${escapeAttr(branch)}"
               title="${open ? 'Collapse' : 'Expand'}">${uiIcon('triangleRight', 18)}</button>`
          : '<span class="email-label-twisty"></span>'}
        <button class="email-label-item" ${id ? `data-label="${escapeAttr(id)}"` : `data-toggle="${escapeAttr(branch)}"`}>
          <span class="email-label-icon">${glyph}</span>
          <span class="email-label-name">${escapeHtml(name)}</span>
          ${unread > 0 ? `<span class="email-label-unread">${unread}</span>` : ''}
        </button>
      </div>
    `;
  };

  const activePath = byId.get(emailState.labelId)?.name || '';
  const renderBranch = (node, depth) => {
    const open = emailState.openLabels.has(node.path) || activePath.startsWith(node.path + '/');
    const row = renderRow({
      id: node.label?.id,
      name: node.name,
      color: node.label?.color,
      // A collapsed branch answers for its children: it carries their unread
      // count so nothing waiting is hidden. Expanded, each row speaks for itself.
      unread: open ? node.label?.unread || 0 : branchUnread(node),
      depth,
      branch: node.children.length > 0 ? node.path : null,
      open,
    });
    if (!open) return row;
    return row + node.children.map(child => renderBranch(child, depth + 1)).join('');
  };

  const tree = buildLabelTree(userLabels);
  host.innerHTML = `
    <button class="email-compose-btn" id="emailComposeBtn" title="Compose (c)">
      ${uiIcon('pencil', 22)}<span>Compose</span>
    </button>
    <div class="email-label-nav">
      ${SYSTEM_LABELS.map(s => renderRow({
        id: s.id, name: s.name, icon: s.icon, unread: byId.get(s.id)?.unread || 0,
      })).join('')}
      ${tree.length > 0 ? `
      <div class="email-label-heading">
        <span>Labels</span>
        <span class="email-label-heading-count">${userLabels.length}</span>
      </div>` : ''}
      ${tree.map(node => renderBranch(node, 0)).join('')}
    </div>
  `;

  document.getElementById('emailComposeBtn')?.addEventListener('click', () => {
    // The thread underneath stays open and readable — a new message floats
    // over it rather than replacing it.
    stopDraftPolling();
    emailState.draftFloating = true;
    emailState.draftEditor = { draftId: null, to: '', subject: '', body: '', attachments: [], includeSignature: true };
    ensureComposeMeta();
    renderDraftEditor();
    document.getElementById('emailDraftTo')?.focus();
  });

  host.querySelectorAll('[data-toggle]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleLabelBranch(btn.dataset.toggle);
    });
  });

  host.querySelectorAll('.email-label-item[data-label]').forEach(btn => {
    btn.addEventListener('click', () => {
      emailState.labelId = btn.dataset.label;
      emailState.query = '';
      emailState.selectedId = null;
      emailState.openThread = null;
      mailList.reset();
      const search = document.getElementById('emailSearchInput');
      if (search) search.value = '';
      renderLabelsSidebar();
      renderReadingPane();
      loadThreads();
    });
  });
}

function userLabelIndex() {
  return new Map(emailState.labels.filter(l => l.type === 'user').map(l => [l.id, l]));
}

function threadRowHtml(t, userLabelById) {
  const chips = (t.labelIds || [])
    .filter(id => userLabelById.has(id))
    .slice(0, 3)
    .map(id => {
      const l = userLabelById.get(id);
      return `<span class="email-row-chip" style="background:${l.color || '#334155'};color:${l.textColor || '#e2e8f0'}">${escapeHtml(l.name)}</span>`;
    }).join('');
  return `
      <div class="email-row ${t.unread ? 'unread' : ''} ${t.id === emailState.selectedId ? 'selected' : ''} ${emailState.bulkSelected.has(t.id) ? 'bulk-checked' : ''}" data-thread="${escapeAttr(t.id)}">
        <input type="checkbox" class="email-row-check" data-action="select" ${emailState.bulkSelected.has(t.id) ? 'checked' : ''}>
        <span class="email-row-star ${t.starred ? 'starred' : ''}" data-action="star" title="Star">${uiIcon(t.starred ? 'starFilled' : 'star', 18)}</span>
        <div class="email-row-main">
          <div class="email-row-top">
            <span class="email-row-from">${t.unread ? '<span class="email-unread-dot"></span>' : ''}${escapeHtml(t.from || '(unknown)')}${t.msgCount > 1 ? ` <span class="email-row-count">${t.msgCount}</span>` : ''}</span>
            <span class="email-row-date">${escapeHtml(t.dateText || '')}</span>
          </div>
          <div class="email-row-subject">${chips}<span class="email-row-subject-text">${escapeHtml(t.subject || '(no subject)')}</span></div>
          <div class="email-row-snippet">${escapeHtml(decodeEntities(t.snippet || ''))}</div>
        </div>
        <div class="email-row-actions">
          <button class="email-icon-btn" data-action="archive" title="Archive (e)">${uiIcon('archive')}</button>
          <button class="email-icon-btn" data-action="trash" title="Delete (#)">${uiIcon('trash')}</button>
          <button class="email-icon-btn" data-action="read" title="${t.unread ? 'Mark as read' : 'Mark as unread'}">${uiIcon(t.unread ? 'mailOpen' : 'mail')}</button>
        </div>
      </div>`;
}

// Moving the cursor changes one class on two rows. Rebuilding all fifty for
// that is what made j/k feel heavy.
function paintSelection() {
  document.querySelectorAll('#emailThreadList .email-row').forEach(row => {
    row.classList.toggle('selected', row.dataset.thread === emailState.selectedId);
  });
}

// Star and read/unread change a single row; swap that row in place instead of
// the whole list, then let the cursor re-resolve to the new node.
function repaintRow(threadId) {
  const row = emailState.threads.find(t => t.id === threadId);
  const el = document.querySelector(`#emailThreadList .email-row[data-thread="${CSS.escape(threadId)}"]`);
  if (!row || !el) {
    renderThreadList();
    return;
  }
  el.outerHTML = threadRowHtml(row, userLabelIndex());
  mailList.refresh();
}

function renderThreadList() {
  const host = document.getElementById('emailThreadList');
  if (!host) return;

  const userLabelById = userLabelIndex();

  if (emailState.loadingList && emailState.threads.length === 0) {
    host.innerHTML = '<div class="email-list-note">Loading…</div>';
    return;
  }
  if (emailState.threads.length === 0) {
    host.innerHTML = `<div class="email-list-note">${emailState.query ? 'No results for this search.' : 'Nothing here.'}</div>`;
    return;
  }

  const selectedOnPage = emailState.threads.filter(t => emailState.bulkSelected.has(t.id)).length;
  host.innerHTML = `
    <div class="email-bulk-bar">
      <input type="checkbox" id="emailBulkToggleAll" title="Select all on this page (*)"
        ${selectedOnPage === emailState.threads.length ? 'checked' : ''}>
      <span class="email-toolbar-divider"></span>
      <button class="email-icon-btn" id="emailBulkArchive" title="Archive" ${selectedOnPage ? '' : 'disabled'}>${uiIcon('archive')}</button>
      <button class="email-icon-btn" id="emailBulkTrash" title="Delete" ${selectedOnPage ? '' : 'disabled'}>${uiIcon('trash')}</button>
      <button class="email-icon-btn" id="emailBulkRead" title="Mark as read" ${selectedOnPage ? '' : 'disabled'}>${uiIcon('mailOpen')}</button>
      ${selectedOnPage > 0 ? `
      <span class="email-bulk-count">${selectedOnPage} selected</span>
      <button class="email-icon-btn" id="emailBulkClear" title="Clear selection">${uiIcon('close')}</button>` : ''}
    </div>
    ${emailState.loadingList ? '<div class="email-list-refreshing">refreshing…</div>' : ''}
    ${emailState.threads.map(t => threadRowHtml(t, userLabelById)).join('')}
    <div class="email-list-pager">
      ${emailState.prevTokens.length > 0 ? '<button id="emailPageNewer">‹ Newer</button>' : ''}
      ${emailState.nextPageToken ? '<button id="emailPageOlder">Older ›</button>' : ''}
    </div>
  `;

  // One delegated listener for the whole list: rows come and go on every
  // repaint, and fifty listeners would have to be rebuilt with them.
  if (!host.dataset.rowsWired) {
    host.dataset.rowsWired = '1';
    host.addEventListener('click', (e) => {
      const rowEl = e.target.closest('.email-row');
      if (!rowEl) return;
      const threadId = rowEl.dataset.thread;
      const action = e.target.closest('[data-action]')?.dataset.action;
      const thread = emailState.threads.find(t => t.id === threadId);
      if (action === 'select') {
        if (emailState.bulkSelected.has(threadId)) {
          emailState.bulkSelected.delete(threadId);
        } else {
          emailState.bulkSelected.add(threadId);
        }
        renderThreadList();
        return;
      }
      if (action === 'star') { setThreadStarred(threadId, !thread?.starred); return; }
      if (action === 'read') { setThreadRead(threadId, !!thread?.unread); return; }
      if (action === 'archive') { archiveThread(threadId); return; }
      if (action === 'trash') { trashThread(threadId); return; }
      openThread(threadId);
    });
  }
  const toggleAll = document.getElementById('emailBulkToggleAll');
  if (toggleAll) {
    toggleAll.indeterminate = selectedOnPage > 0 && selectedOnPage < emailState.threads.length;
  }
  toggleAll?.addEventListener('click', () => {
    toggleAllOnPage();
    renderThreadList();
  });
  document.getElementById('emailBulkClear')?.addEventListener('click', () => {
    emailState.bulkSelected.clear();
    renderThreadList();
  });
  document.getElementById('emailBulkTrash')?.addEventListener('click', () => bulkAction('trash'));
  document.getElementById('emailBulkArchive')?.addEventListener('click', () => bulkAction('archive'));
  document.getElementById('emailBulkRead')?.addEventListener('click', () => bulkAction('read'));
  document.getElementById('emailPageOlder')?.addEventListener('click', () =>
    loadThreads({ token: emailState.nextPageToken, direction: 'older' }));
  document.getElementById('emailPageNewer')?.addEventListener('click', () =>
    loadThreads({ token: emailState.prevTokens[emailState.prevTokens.length - 1] || '', direction: 'newer' }));

  // Repaint the cursor on its thread — re-renders replace the row nodes
  // but must never move the cursor itself
  mailList.refresh();
}

function closeReadingPane() {
  clearTimeout(emailState.markReadTimer);
  stopDraftPolling();
  emailState.selectedId = null;
  emailState.openThread = null;
  // Closing the mail you were reading must not throw away a message you are
  // still writing — the compose window is independent of the pane.
  if (!emailState.draftFloating) emailState.draftEditor = null;
  emailState.threadDrafts = [];
  renderThreadList();
  renderReadingPane();
}

function renderReadingPane() {
  const host = document.getElementById('emailReadingPane');
  if (!host) return;

  if (emailState.loadingThread) {
    host.innerHTML = '<div class="email-reading-empty">Loading message…</div>';
    return;
  }
  const thread = emailState.openThread;
  if (!thread) {
    host.innerHTML = '<div class="email-reading-empty">Select a conversation to read it here.<br><span class="email-hint-keys">j/k navigate · e archive · # delete · u read/unread · x select · * select all · z undo</span></div>';
    return;
  }

  const row = emailState.threads.find(t => t.id === thread.id);
  const userLabels = emailState.labels.filter(l => l.type === 'user');

  host.innerHTML = `
    <div class="email-reading-toolbar">
      <button class="email-icon-btn" data-act="archive" title="Archive (e)">${uiIcon('archive')}</button>
      <button class="email-icon-btn" data-act="trash" title="Delete (#)">${uiIcon('trash')}</button>
      <button class="email-icon-btn" data-act="read" title="${row?.unread ? 'Mark as read' : 'Mark as unread'} (u)">${uiIcon(row?.unread ? 'mailOpen' : 'mail')}</button>
      <span class="email-toolbar-divider"></span>
      <div class="email-label-menu-wrap">
        <button class="email-icon-btn" data-act="labels" title="Labels">${uiIcon('label')}</button>
        <div class="email-label-menu" id="emailLabelMenu" style="display:none">
          ${userLabels.length === 0 ? '<div class="email-label-menu-empty">No labels in this account</div>' : userLabels.map(l => `
            <label class="email-label-menu-item">
              <input type="checkbox" data-labelid="${escapeAttr(l.id)}" ${(row?.labelIds || []).includes(l.id) ? 'checked' : ''}>
              <span class="email-label-dot" style="background:${l.color || 'currentColor'}">${uiIcon('label')}</span>
              ${escapeHtml(l.name)}
            </label>
          `).join('')}
        </div>
      </div>
      ${emailState.mcpEnabled && emailState.mcpAccounts.has(emailState.account) ? `
      <button class="email-pill email-claude-btn" data-act="claude" ${emailState.draftWaiting ? 'disabled' : ''}>
        ${uiIcon('robot', 18)}<span>${emailState.draftWaiting ? 'Waiting for Claude…' : 'Draft with Claude'}</span>
      </button>` : ''}
      <span id="emailDraftsBadge"></span>
      <button class="email-icon-btn email-reading-close" data-act="close" title="Close (Esc)">${uiIcon('close')}</button>
    </div>
    <div class="email-reading-head">
      <div class="email-reading-subject">${escapeHtml(thread.messages[0]?.subject || '(no subject)')}</div>
      <span class="email-icon-btn email-reading-star ${row?.starred ? 'starred' : ''}" data-act="star" title="Star">${uiIcon(row?.starred ? 'starFilled' : 'star')}</span>
    </div>
    <div class="email-messages">
      ${thread.messages.map((m, i) => renderMessage(m, i === thread.messages.length - 1)).join('')}
      <div class="email-reply-row">
        <button class="email-pill" data-act="reply">${uiIcon('reply', 18)}<span>Reply</span></button>
        <button class="email-pill" data-act="replyall">${uiIcon('replyAll', 18)}<span>Reply all</span></button>
        <button class="email-pill" data-act="forward">${uiIcon('forward', 18)}<span>Forward</span></button>
      </div>
    </div>
    <div class="email-draft-host" id="emailDraftHost"></div>
  `;
  renderDraftEditor();

  host.querySelector('[data-act="close"]')?.addEventListener('click', closeReadingPane);
  host.querySelector('[data-act="reply"]')?.addEventListener('click', () => replyToOpenThread(false));
  host.querySelector('[data-act="replyall"]')?.addEventListener('click', () => replyToOpenThread(true));
  host.querySelector('[data-act="forward"]')?.addEventListener('click', forwardOpenThread);
  host.querySelector('[data-act="claude"]')?.addEventListener('click', () => claudeDraftReply(thread));
  renderThreadDraftsButton();
  host.querySelector('[data-act="archive"]')?.addEventListener('click', () => archiveThread(thread.id));
  host.querySelector('[data-act="trash"]')?.addEventListener('click', () => trashThread(thread.id));
  host.querySelector('[data-act="read"]')?.addEventListener('click', () => setThreadRead(thread.id, !!row?.unread));
  host.querySelector('[data-act="star"]')?.addEventListener('click', () => setThreadStarred(thread.id, !row?.starred));
  const labelMenu = document.getElementById('emailLabelMenu');
  host.querySelector('[data-act="labels"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (labelMenu) labelMenu.style.display = labelMenu.style.display === 'none' ? 'block' : 'none';
  });
  labelMenu?.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', () => toggleUserLabel(thread.id, cb.dataset.labelid, cb.checked));
  });

  // Collapsible older messages
  host.querySelectorAll('.email-message.collapsed .email-message-header').forEach(header => {
    header.addEventListener('click', () => header.parentElement.classList.toggle('collapsed'));
  });

  // Attachments
  host.querySelectorAll('.email-att-tile').forEach(tile => {
    tile.querySelector('.email-att-preview')?.addEventListener('click', () =>
      previewAttachment(tile.dataset.msg, tile.dataset.att, tile.dataset.name, tile.dataset.mime));
    tile.querySelector('.email-att-save')?.addEventListener('click', async () => {
      try {
        const path = await GmailSaveAttachment(emailState.account, tile.dataset.msg, tile.dataset.att, tile.dataset.name);
        showToast(`Saved to ${path}`);
      } catch (err) { showToast(`✗ ${err}`, true); }
    });
    tile.querySelector('.email-att-open')?.addEventListener('click', async () => {
      try {
        await GmailOpenAttachment(emailState.account, tile.dataset.msg, tile.dataset.att, tile.dataset.name);
      } catch (err) { showToast(`✗ ${err}`, true); }
    });
  });

  // Message bodies via sandboxed iframes
  host.querySelectorAll('iframe.email-body-frame').forEach(frame => {
    frame.addEventListener('load', () => {
      try {
        const doc = frame.contentDocument;
        if (!doc) return;
        frame.style.height = Math.min(doc.documentElement.scrollHeight + 24, 20000) + 'px';
        doc.querySelectorAll('a[href]').forEach(a => {
          a.addEventListener('click', (e) => {
            e.preventDefault();
            const href = a.getAttribute('href');
            if (href && /^https?:/i.test(href)) BrowserOpenURL(href);
          });
        });
      } catch (err) {
        console.error('email iframe post-process failed:', err);
      }
    });
  });
}

// Repaint only the editor. Rebuilding the whole reading pane would reload every
// message iframe, and their post-load growth pushes the editor out of view.
// A reply docks under its thread; a new message floats over everything so the
// mail being answered stays readable.
function renderDraftEditor() {
  if (emailState.draftFloating) {
    renderComposeWindow();
    return;
  }
  closeComposeWindow();
  const host = document.getElementById('emailDraftHost');
  if (!emailState.openThread || !host) {
    renderReadingPane();
    return;
  }
  host.innerHTML = emailState.draftEditor
    ? draftEditorHtml(`📝 Draft reply${emailState.mcpEnabled ? ' (written by Claude — edit before sending)' : ''}`)
    : '';
  const openDraftBtn = document.querySelector('#emailReadingPane [data-act="opendraft"]');
  if (openDraftBtn) openDraftBtn.style.display = emailState.draftEditor ? 'none' : '';
  wireDraftEditor();
}

function closeComposeWindow() {
  const win = document.getElementById('emailComposeWindow');
  if (win) {
    win.style.display = 'none';
    win.innerHTML = '';
  }
}

function renderComposeWindow() {
  const win = document.getElementById('emailComposeWindow');
  if (!win) return;
  if (!emailState.draftEditor) {
    emailState.draftFloating = false;
    closeComposeWindow();
    return;
  }
  win.style.display = 'flex';
  applyComposeGeometry(win);
  win.innerHTML = draftEditorHtml('New message');
  wireDraftEditor();
  makeComposeDraggable(win);
}

// Position and size survive reopening — a window that jumps back to the corner
// every time is worse than a docked panel.
function composeGeometry() {
  try {
    return JSON.parse(localStorage.getItem('mailComposeBox') || 'null') || {};
  } catch (err) {
    console.warn('mail: stored compose geometry is unreadable', err);
    return {};
  }
}

function saveComposeGeometry(box) {
  localStorage.setItem('mailComposeBox', JSON.stringify(box));
}

function applyComposeGeometry(win) {
  const box = composeGeometry();
  if (box.width) win.style.width = `${box.width}px`;
  if (box.height) win.style.height = `${box.height}px`;
  if (box.left != null && box.top != null) {
    win.style.left = `${box.left}px`;
    win.style.top = `${box.top}px`;
    win.style.right = 'auto';
    win.style.bottom = 'auto';
  }
}

function makeComposeDraggable(win) {
  const handle = win.querySelector('.email-draft-header');
  if (!handle) return;
  handle.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return;
    e.preventDefault();
    const start = win.getBoundingClientRect();
    const layout = win.parentElement.getBoundingClientRect();
    const grabX = e.clientX - start.left;
    const grabY = e.clientY - start.top;

    const move = (ev) => {
      // Keep the header reachable: the window may hang off the right and
      // bottom, but never far enough to lose the bar you drag it back by.
      const maxLeft = layout.width - 80;
      const maxTop = layout.height - 40;
      const left = Math.min(Math.max(ev.clientX - layout.left - grabX, 0), maxLeft);
      const top = Math.min(Math.max(ev.clientY - layout.top - grabY, 0), maxTop);
      win.style.left = `${left}px`;
      win.style.top = `${top}px`;
      win.style.right = 'auto';
      win.style.bottom = 'auto';
    };
    const drop = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', drop);
      const box = win.getBoundingClientRect();
      const layoutNow = win.parentElement.getBoundingClientRect();
      saveComposeGeometry({
        left: box.left - layoutNow.left,
        top: box.top - layoutNow.top,
        width: box.width,
        height: box.height,
      });
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', drop);
  });

  // CSS resize gives no event; record the size whenever the pointer leaves it
  win.addEventListener('mouseup', () => {
    const box = win.getBoundingClientRect();
    const layout = win.parentElement.getBoundingClientRect();
    saveComposeGeometry({
      left: box.left - layout.left,
      top: box.top - layout.top,
      width: box.width,
      height: box.height,
    });
  });
}

function draftEditorHtml(title) {
  const editor = emailState.draftEditor;
  if (!editor) return '';
  const sig = emailState.signatureByAccount[emailState.account] || '';
  return `
    <div class="email-draft-editor">
      <div class="email-draft-header">
        <span>${escapeHtml(title)}</span>
        <button id="emailDraftClose" title="Close editor">&times;</button>
      </div>
      <div class="email-draft-fields">
        <label>To
          <span class="email-to-wrap">
            <input type="text" id="emailDraftTo" value="${escapeAttr(editor.to)}" spellcheck="false"
              autocomplete="off" placeholder="Start typing a name or address…">
            <div class="email-to-dropdown" id="emailToDropdown" style="display:none"></div>
          </span>
        </label>
        <label>Subject <input type="text" id="emailDraftSubject" value="${escapeAttr(editor.subject)}" spellcheck="false"></label>
      </div>
      <textarea id="emailDraftBody" rows="8">${escapeHtml(editor.body)}</textarea>
      <div class="email-draft-extras">
        <div class="email-draft-attach-row">
          <button id="emailDraftAttach">📎 Attach files</button>
          <div class="email-draft-att-chips">
            ${(editor.attachments || []).map((p, i) => `
              <span class="email-draft-att-chip" title="${escapeAttr(p)}">
                ${escapeHtml(p.split('/').pop())}
                <button data-attidx="${i}" class="email-att-chip-remove">&times;</button>
              </span>`).join('')}
          </div>
        </div>
        <div class="email-sig-block" id="emailSigBlock" style="${sig ? '' : 'display:none'}">
          <label class="email-sig-toggle">
            <input type="checkbox" id="emailSigInclude" ${editor.includeSignature ? 'checked' : ''}>
            Include Gmail signature
          </label>
          <div class="email-sig-preview" id="emailSigPreviewContent">${sig}</div>
        </div>
      </div>
      <div class="email-draft-actions">
        <button class="email-draft-send" id="emailDraftSend">📤 Send</button>
        <button id="emailDraftSave">💾 Save draft</button>
        <button class="email-draft-discard" id="emailDraftDiscard">🗑 Discard</button>
      </div>
    </div>
  `;
}

function syncEditorFromForm() {
  const editor = emailState.draftEditor;
  if (editor) Object.assign(editor, readDraftEditorForm());
}

function wireDraftEditor() {
  const editor = emailState.draftEditor;
  if (!editor) return;
  document.getElementById('emailDraftClose')?.addEventListener('click', () => {
    emailState.draftEditor = null;
    renderDraftEditor();
  });
  document.getElementById('emailDraftSave')?.addEventListener('click', saveDraft);
  document.getElementById('emailDraftSend')?.addEventListener('click', sendDraft);
  document.getElementById('emailDraftDiscard')?.addEventListener('click', discardDraft);

  document.getElementById('emailDraftAttach')?.addEventListener('click', async () => {
    try {
      const paths = await GmailPickAttachments();
      if (paths && paths.length > 0) {
        syncEditorFromForm();
        editor.attachments = [...new Set([...(editor.attachments || []), ...paths])];
        renderDraftEditor();
      }
    } catch (err) {
      console.error('Attachment pick failed:', err);
      showToast(`✗ ${err}`, true);
    }
  });
  document.querySelectorAll('.email-att-chip-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      syncEditorFromForm();
      editor.attachments.splice(parseInt(btn.dataset.attidx, 10), 1);
      renderDraftEditor();
    });
  });
  document.getElementById('emailSigInclude')?.addEventListener('change', (e) => {
    editor.includeSignature = e.target.checked;
  });

  wireToAutocomplete();
}

// --- recipient autocomplete (Gmail-style) ---

let acIndex = -1;

function wireToAutocomplete() {
  const input = document.getElementById('emailDraftTo');
  const dropdown = document.getElementById('emailToDropdown');
  if (!input || !dropdown) return;

  const close = () => { dropdown.style.display = 'none'; acIndex = -1; };

  const matchesFor = (segment) => {
    const contacts = emailState.contactsByAccount[emailState.account] || [];
    const q = segment.toLowerCase();
    if (!q) return contacts.slice(0, 8);
    return contacts.filter(c =>
      c.email.toLowerCase().includes(q) || (c.name || '').toLowerCase().includes(q)
    ).slice(0, 8);
  };

  const currentSegment = () => {
    const parts = input.value.split(',');
    return parts[parts.length - 1].trim();
  };

  const applyContact = (contact) => {
    const parts = input.value.split(',');
    parts[parts.length - 1] = ' ' + (contact.name ? `${contact.name} <${contact.email}>` : contact.email);
    input.value = parts.join(',').replace(/^ /, '') + ', ';
    close();
    input.focus();
  };

  const show = () => {
    const matches = matchesFor(currentSegment());
    if (matches.length === 0) { close(); return; }
    acIndex = -1;
    dropdown.innerHTML = matches.map((c, i) => `
      <div class="email-to-option" data-idx="${i}">
        <span class="email-to-avatar">${escapeHtml((c.name || c.email)[0].toUpperCase())}</span>
        <span class="email-to-details">
          ${c.name ? `<span class="email-to-name">${escapeHtml(c.name)}</span>` : ''}
          <span class="email-to-addr">${escapeHtml(c.email)}</span>
        </span>
      </div>`).join('');
    dropdown.style.display = 'block';
    dropdown.querySelectorAll('.email-to-option').forEach(opt => {
      opt.addEventListener('mousedown', (e) => {
        e.preventDefault();
        applyContact(matches[parseInt(opt.dataset.idx, 10)]);
      });
    });
    dropdown._matches = matches;
  };

  input.addEventListener('input', show);
  input.addEventListener('focus', show);
  input.addEventListener('blur', () => setTimeout(close, 150));
  input.addEventListener('keydown', (e) => {
    if (dropdown.style.display === 'none') return;
    const options = dropdown.querySelectorAll('.email-to-option');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      acIndex = e.key === 'ArrowDown'
        ? Math.min(acIndex + 1, options.length - 1)
        : Math.max(acIndex - 1, 0);
      options.forEach((o, i) => o.classList.toggle('active', i === acIndex));
    } else if (e.key === 'Enter' && acIndex >= 0) {
      e.preventDefault();
      applyContact(dropdown._matches[acIndex]);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  });
}

function renderMessage(m, expanded) {
  const body = m.bodyHtml
    ? `<iframe class="email-body-frame" sandbox="allow-same-origin" srcdoc="${escapeAttr(wrapHtmlBody(m.bodyHtml))}"></iframe>`
    : `<pre class="email-body-text">${escapeHtml(m.bodyText || '(empty message)')}</pre>`;
  const atts = (m.attachments || []).map(a => `
    <div class="email-att-tile" data-msg="${escapeAttr(a.messageId)}" data-att="${escapeAttr(a.attachmentId)}"
         data-name="${escapeAttr(a.filename)}" data-mime="${escapeAttr(a.mimeType)}">
      <span class="email-att-icon">${attIcon(a.mimeType)}</span>
      <span class="email-att-info">
        <span class="email-att-name email-att-preview" title="Preview">${escapeHtml(a.filename)}</span>
        <span class="email-att-size">${formatSize(a.size)}</span>
      </span>
      <button class="email-icon-btn email-att-save" title="Save to Downloads">${uiIcon('download', 18)}</button>
      <button class="email-icon-btn email-att-open" title="Open">${uiIcon('openNew', 18)}</button>
    </div>
  `).join('');
  const display = senderDisplay(m.from);
  return `
    <div class="email-message ${expanded ? '' : 'collapsed'}">
      <div class="email-message-header">
        <span class="email-avatar" style="background:${avatarColor(display.key)}">${escapeHtml(display.initial)}</span>
        <span class="email-message-who">
          <span class="email-message-from">${escapeHtml(display.name)}</span>
          <span class="email-message-meta">to ${escapeHtml(m.to || '')}${m.cc ? ` · cc ${escapeHtml(m.cc)}` : ''}</span>
        </span>
        <span class="email-message-date">${escapeHtml(m.dateText)}</span>
      </div>
      <div class="email-message-body">
        ${body}
        ${atts ? `<div class="email-att-row">${atts}</div>` : ''}
      </div>
    </div>
  `;
}

// Gmail colours the fallback avatar by the sender, so the same person keeps
// the same circle across the thread list and the reading pane.
const AVATAR_COLORS = ['#1a73e8', '#d93025', '#188038', '#e37400', '#8430ce', '#0b8043', '#c5221f', '#3f51b5'];

function avatarColor(key) {
  let hash = 0;
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) % 997;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function senderDisplay(from) {
  const raw = (from || '').trim();
  const email = (raw.match(/<([^>]+)>/) || [])[1] || raw;
  const name = raw.replace(/\s*<[^>]*>\s*/, '').replace(/^"|"$/g, '').trim() || email;
  return { name, key: email.toLowerCase(), initial: (name || email || '?')[0].toUpperCase() };
}

// Remote images are routed through the local proxy: the webview CSP allows no
// other host, and the proxy strips cookies and referrer so a tracking pixel
// learns nothing about the reader.
function proxyRemoteImages(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('img[src]').forEach(img => {
    const src = img.getAttribute('src');
    if (/^https?:/i.test(src)) {
      img.setAttribute('src', `${API_BASE}/api/mail/image?u=${encodeURIComponent(src)}`);
    }
  });
  return doc.body.innerHTML;
}

function wrapHtmlBody(html) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { font-family: -apple-system, Helvetica, Arial, sans-serif; font-size: 14px;
           color: #1f2937; background: #ffffff; margin: 12px; word-break: break-word; }
    img { max-width: 100%; height: auto; }
    pre { white-space: pre-wrap; }
  </style></head><body>${proxyRemoteImages(html)}</body></html>`;
}

// ============================================
// Attachment preview overlay
// ============================================

async function previewAttachment(messageId, attachmentId, filename, mime) {
  const overlay = document.getElementById('emailPreviewOverlay');
  if (!overlay) return;
  const previewable = /^image\//.test(mime) || mime === 'application/pdf' || /^text\//.test(mime);
  if (!previewable) {
    try {
      await GmailOpenAttachment(emailState.account, messageId, attachmentId, filename);
    } catch (err) { showToast(`✗ ${err}`, true); }
    return;
  }
  overlay.style.display = 'flex';
  overlay.innerHTML = `<div class="email-preview-box"><div class="email-preview-loading">Loading ${escapeHtml(filename)}…</div></div>`;
  try {
    const b64 = await GmailGetAttachment(emailState.account, messageId, attachmentId);
    let content;
    if (/^image\//.test(mime)) {
      content = `<img src="data:${mime};base64,${b64}" alt="${escapeAttr(filename)}">`;
    } else if (mime === 'application/pdf') {
      content = `<embed src="data:application/pdf;base64,${b64}" type="application/pdf" class="email-preview-pdf">`;
    } else {
      content = `<pre class="email-preview-text">${escapeHtml(atob(b64))}</pre>`;
    }
    overlay.innerHTML = `
      <div class="email-preview-box">
        <div class="email-preview-header">
          <span>${escapeHtml(filename)}</span>
          <button id="emailPreviewClose" title="Close">&times;</button>
        </div>
        <div class="email-preview-content">${content}</div>
      </div>
    `;
  } catch (err) {
    overlay.innerHTML = `<div class="email-preview-box"><div class="email-preview-loading">✗ ${escapeHtml(String(err))}</div></div>`;
  }
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.id === 'emailPreviewClose') {
      overlay.style.display = 'none';
      overlay.innerHTML = '';
    }
  }, { once: true });
}

// ============================================
// Keyboard + polling
// ============================================

// (legacy document-level hotkey handler removed — mailList + the shell
// keyboard router own every Mail key now)

function startPolling() {
  stopPolling();
  emailState.pollTimer = setInterval(() => {
    if (!emailState.visible || !emailState.account) return;
    loadLabels();
    loadAccountUnreads();
    if (!emailState.loadingList && emailState.prevTokens.length === 0 && !emailState.currentToken) {
      loadThreads();
    }
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (emailState.pollTimer) {
    clearInterval(emailState.pollTimer);
    emailState.pollTimer = null;
  }
}

// ============================================
// Helpers
// ============================================

function attIcon(mime) {
  if (/^image\//.test(mime)) return '🖼️';
  if (mime === 'application/pdf') return '📄';
  if (/zip|compressed|tar/.test(mime)) return '🗜️';
  if (/word|document/.test(mime)) return '📝';
  if (/sheet|excel|csv/.test(mime)) return '📊';
  if (/^text\//.test(mime)) return '📃';
  return '📎';
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function truncate(s, n) {
  s = s || '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function decodeEntities(s) {
  const el = document.createElement('textarea');
  el.innerHTML = s;
  return el.value;
}


function addEmailStyles() {
  if (document.getElementById('email-dashboard-styles')) return;
  const style = document.createElement('style');
  style.id = 'email-dashboard-styles';
  style.textContent = `
    #emailPanel { flex: 1; overflow: hidden; }
    .email-layout[data-theme="light"] {
      --m-bg: #ffffff;
      --m-surface: #ffffff;
      --m-surface-2: #f6f8fc;
      --m-search-bg: #e9eef6;
      --m-hover: #f1f3f4;
      --m-selected: #d3e3fd;
      --m-selected-text: #041e49;
      --m-accent: #0b57d0;
      --m-compose-bg: #c2e7ff;
      --m-compose-text: #001d35;
      --m-text: #202124;
      --m-text-2: #5f6368;
      --m-text-3: #80868b;
      --m-border: #dadce0;
      --m-divider: #f1f3f4;
      --m-star: #f4b400;
      --m-row-shadow: inset 1px 0 0 #dadce0, inset -1px 0 0 #dadce0, 0 1px 2px 0 rgba(60,64,67,0.3);
      --m-lift: 0 1px 3px 0 rgba(60,64,67,0.3), 0 4px 8px 3px rgba(60,64,67,0.15);
    }
    .email-layout[data-theme="dark"] {
      --m-bg: #1b1b1b;
      --m-surface: #1f1f1f;
      --m-surface-2: #232426;
      --m-search-bg: #333438;
      --m-hover: #2f3033;
      --m-selected: #004a77;
      --m-selected-text: #c2e7ff;
      --m-accent: #a8c7fa;
      --m-compose-bg: #004a77;
      --m-compose-text: #c2e7ff;
      --m-text: #e3e3e3;
      --m-text-2: #9aa0a6;
      --m-text-3: #80868b;
      --m-border: #3c4043;
      --m-divider: #2d2e30;
      --m-star: #fdd663;
      --m-row-shadow: inset 1px 0 0 #3c4043, inset -1px 0 0 #3c4043, 0 1px 2px 0 rgba(0,0,0,0.5);
      --m-lift: 0 1px 3px 0 rgba(0,0,0,0.5), 0 4px 8px 3px rgba(0,0,0,0.3);
    }
    .email-layout {
      display: flex; flex-direction: column; height: 100%; width: 100%; position: relative;
      background: var(--m-bg); color: var(--m-text);
      font-family: 'Google Sans', 'Google Sans Text', Roboto, -apple-system, BlinkMacSystemFont,
                   'Helvetica Neue', Arial, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    .email-layout .mail-icon { fill: currentColor; display: block; flex-shrink: 0; }

    .email-icon-btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 40px; height: 40px; flex-shrink: 0; padding: 0;
      background: none; border: none; border-radius: 50%;
      color: var(--m-text-2); cursor: pointer;
    }
    .email-icon-btn:hover:not(:disabled) { background: var(--m-hover); color: var(--m-text); }
    .email-icon-btn:disabled { color: var(--m-text-3); opacity: 0.45; cursor: default; }
    .email-pill {
      display: inline-flex; align-items: center; gap: 8px; height: 36px; padding: 0 16px;
      background: none; border: 1px solid var(--m-border); border-radius: 18px;
      color: var(--m-text); font-size: 14px; font-family: inherit; cursor: pointer;
      white-space: nowrap;
    }
    .email-pill:hover:not(:disabled) { background: var(--m-hover); }
    .email-pill:disabled { color: var(--m-text-3); cursor: default; }
    .email-toolbar-divider { width: 1px; height: 20px; background: var(--m-border); margin: 0 6px; flex-shrink: 0; }
    .email-avatar {
      width: 32px; height: 32px; border-radius: 50%; color: #fff; flex-shrink: 0;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 14px; font-weight: 500;
    }

    .email-topbar {
      display: flex; align-items: center; gap: 8px; padding: 6px 12px; flex-shrink: 0;
      background: var(--m-bg);
    }
    .email-search { flex: 1; max-width: 720px; position: relative; display: flex; align-items: center; }
    .email-search-icon {
      position: absolute; left: 14px; color: var(--m-text-2); pointer-events: none; display: flex;
    }
    .email-search input {
      width: 100%; height: 48px; padding: 0 48px; box-sizing: border-box;
      background: var(--m-search-bg); border: 1px solid transparent; border-radius: 24px;
      color: var(--m-text); font-size: 16px; font-family: inherit;
    }
    .email-search input::placeholder { color: var(--m-text-2); }
    .email-search input:focus {
      outline: none; background: var(--m-surface); border-radius: 8px; box-shadow: var(--m-lift);
    }
    .email-search-clear { position: absolute; right: 4px; }
    .email-accounts { display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none; }
    .email-accounts::-webkit-scrollbar { display: none; }
    .email-account-chip {
      display: flex; align-items: center; gap: 8px; padding: 4px 12px 4px 4px; flex-shrink: 0;
      background: none; border: 1px solid transparent; border-radius: 20px;
      color: var(--m-text-2); font-size: 13px; font-family: inherit; cursor: pointer; white-space: nowrap;
    }
    .email-account-chip:hover { background: var(--m-hover); }
    .email-account-chip.active {
      background: var(--m-selected); color: var(--m-selected-text); font-weight: 500;
    }
    .email-account-chip .email-avatar { width: 26px; height: 26px; font-size: 12px; }
    .email-account-unread {
      background: var(--m-accent); color: var(--m-bg); font-size: 11px; font-weight: 700;
      border-radius: 10px; padding: 1px 6px;
    }

    .email-body { flex: 1; display: flex; overflow: hidden; min-height: 0; }
    .email-labels {
      width: 248px; flex-shrink: 0; overflow-y: auto; padding: 0 0 16px;
      display: flex; flex-direction: column; background: var(--m-bg);
    }
    .email-compose-btn {
      display: flex; align-items: center; gap: 12px; align-self: flex-start;
      height: 48px; margin: 8px 16px 16px; padding: 0 24px 0 20px;
      background: var(--m-compose-bg); border: none; border-radius: 16px;
      color: var(--m-compose-text); font-size: 14px; font-weight: 500; font-family: inherit;
      cursor: pointer;
    }
    .email-compose-btn:hover { box-shadow: var(--m-lift); }
    .email-label-nav { display: flex; flex-direction: column; padding-right: 12px; }
    .email-label-row {
      display: flex; align-items: center; height: 32px; border-radius: 0 16px 16px 0;
      padding-left: calc(var(--depth, 0) * 12px);
      color: var(--m-text); font-size: 14px;
    }
    .email-label-row:hover { background: var(--m-hover); }
    .email-label-row.unread { font-weight: 700; }
    .email-label-row.active {
      background: var(--m-selected); color: var(--m-selected-text); font-weight: 500;
    }
    .email-label-row.active.unread { font-weight: 700; }
    .email-label-twisty {
      width: 24px; height: 24px; margin-left: 2px; padding: 0; flex-shrink: 0;
      display: inline-flex; align-items: center; justify-content: center;
      background: none; border: none; border-radius: 50%;
      color: var(--m-text-2); cursor: pointer;
    }
    button.email-label-twisty:hover { background: rgba(128,128,128,0.28); color: var(--m-text); }
    .email-label-twisty .mail-icon { transition: transform 0.12s ease; }
    .email-label-twisty.open .mail-icon { transform: rotate(90deg); }
    .email-label-item {
      flex: 1; min-width: 0; display: flex; align-items: center; gap: 16px; height: 100%;
      padding: 0 12px 0 4px;
      background: none; border: none; border-radius: 0 16px 16px 0;
      color: inherit; font: inherit; cursor: pointer; text-align: left;
    }
    .email-label-icon { display: flex; color: var(--m-text-2); }
    .email-label-row.active .email-label-icon { color: inherit; }
    .email-label-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .email-label-unread { font-size: 12px; font-weight: 700; }
    .email-label-dot { display: flex; }
    .email-label-heading {
      display: flex; align-items: center; justify-content: space-between;
      padding: 20px 12px 6px 26px; font-size: 14px; color: var(--m-text);
    }
    .email-label-heading-count { font-size: 12px; color: var(--m-text-3); }

    .email-list {
      width: 400px; flex-shrink: 0; overflow-y: auto; display: flex; flex-direction: column;
      position: relative; background: var(--m-surface); border-right: 1px solid var(--m-divider);
    }
    .email-list-note { padding: 40px 24px; color: var(--m-text-2); font-size: 14px; text-align: center; }
    .email-list-refreshing { padding: 4px 16px; color: var(--m-text-3); font-size: 11px; }
    .email-bulk-bar {
      position: sticky; top: 0; z-index: 6; display: flex; align-items: center; gap: 2px;
      height: 48px; padding: 0 8px 0 14px; flex-shrink: 0;
      background: var(--m-surface); border-bottom: 1px solid var(--m-divider);
    }
    .email-bulk-bar #emailBulkToggleAll {
      accent-color: var(--m-accent); width: 18px; height: 18px; cursor: pointer; margin: 0 6px 0 0;
    }
    .email-bulk-count {
      margin-left: 6px; font-size: 13px; font-weight: 500; color: var(--m-text-2);
    }
    .email-row {
      display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px 10px 14px;
      cursor: pointer; position: relative; border-bottom: 1px solid var(--m-divider);
      background: var(--m-surface);
    }
    .email-row:hover { z-index: 2; box-shadow: var(--m-row-shadow); }
    .email-row.bulk-checked { background: var(--m-selected); }
    .email-row.selected {
      background: var(--m-selected); box-shadow: inset 4px 0 0 var(--m-accent);
    }
    .email-row.selected .email-row-from, .email-row.selected .email-row-subject-text { color: var(--m-selected-text); }
    .email-row-check {
      accent-color: var(--m-accent); width: 18px; height: 18px; margin: 1px 0 0; cursor: pointer;
      opacity: 0; transition: opacity 0.1s;
    }
    .email-row:hover .email-row-check, .email-row-check:checked,
    .email-row.bulk-checked .email-row-check { opacity: 1; }
    .email-row-star { display: flex; color: var(--m-text-3); cursor: pointer; padding-top: 1px; }
    .email-row-star:hover { color: var(--m-text); }
    .email-row-star.starred { color: var(--m-star); }
    .email-row-main { flex: 1; min-width: 0; }
    .email-row-top { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
    .email-row-from {
      font-size: 14px; color: var(--m-text-2);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      display: flex; align-items: center; gap: 7px; min-width: 0;
    }
    .email-row.unread .email-row-from { font-weight: 700; color: var(--m-text); }
    .email-unread-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--m-accent); flex-shrink: 0; }
    .email-row-count { color: var(--m-text-3); font-weight: 400; font-size: 12px; }
    .email-row-date { font-size: 12px; color: var(--m-text-2); white-space: nowrap; }
    .email-row.unread .email-row-date { color: var(--m-text); font-weight: 700; }
    .email-row-subject {
      font-size: 14px; line-height: 1.4; color: var(--m-text-2); margin-top: 2px;
      display: flex; align-items: center; gap: 5px; min-width: 0;
    }
    .email-row-subject-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .email-row.unread .email-row-subject { color: var(--m-text); font-weight: 700; }
    .email-row-chip {
      font-size: 11px; font-weight: 500; border-radius: 4px; padding: 1px 6px; flex-shrink: 0;
      max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .email-row-snippet {
      font-size: 13px; color: var(--m-text-3); overflow: hidden; text-overflow: ellipsis;
      white-space: nowrap; margin-top: 1px; line-height: 1.4;
    }
    .email-row-actions {
      position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
      display: none; gap: 2px; background: var(--m-surface); border-radius: 8px; padding: 2px;
    }
    .email-row:hover .email-row-actions { display: flex; }
    .email-row-actions .email-icon-btn { width: 32px; height: 32px; }
    .email-list-pager { display: flex; justify-content: center; gap: 8px; padding: 14px; }
    .email-list-pager button {
      background: none; border: 1px solid var(--m-border); border-radius: 16px;
      color: var(--m-text-2); padding: 6px 16px; cursor: pointer; font-size: 13px; font-family: inherit;
    }
    .email-list-pager button:hover { background: var(--m-hover); color: var(--m-text); }

    .email-reading {
      flex: 1; overflow-y: auto; display: flex; flex-direction: column; background: var(--m-surface);
    }
    .email-reading-empty {
      flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
      color: var(--m-text-2); font-size: 14px; text-align: center; line-height: 2.2;
    }
    .email-hint-keys { font-size: 12px; color: var(--m-text-3); }
    .email-reading-toolbar {
      display: flex; align-items: center; gap: 2px; height: 48px; padding: 0 8px 0 12px;
      position: sticky; top: 0; z-index: 5; flex-shrink: 0;
      background: var(--m-surface); border-bottom: 1px solid var(--m-divider);
    }
    .email-reading-close { margin-left: auto; }
    .email-label-menu-wrap { position: relative; }
    .email-label-menu {
      position: absolute; top: 100%; left: 0; margin-top: 4px; z-index: 20;
      background: var(--m-surface); border: 1px solid var(--m-border); border-radius: 8px; padding: 6px;
      min-width: 200px; max-height: 280px; overflow-y: auto; box-shadow: var(--m-lift);
    }
    .email-label-menu-item {
      display: flex; align-items: center; gap: 10px; padding: 7px 10px; font-size: 13px;
      color: var(--m-text); cursor: pointer; border-radius: 4px;
    }
    .email-label-menu-item:hover { background: var(--m-hover); }
    .email-label-menu-empty { padding: 10px; font-size: 13px; color: var(--m-text-2); }
    .email-reading-head { display: flex; align-items: flex-start; gap: 8px; padding: 18px 20px 8px; }
    .email-reading-subject {
      flex: 1; font-size: 22px; font-weight: 400; line-height: 1.35; color: var(--m-text);
      word-break: break-word;
    }
    .email-reading-star { color: var(--m-text-2); }
    .email-reading-star.starred { color: var(--m-star); }
    .email-messages { padding: 0 20px 28px; }
    .email-message { border-bottom: 1px solid var(--m-divider); padding-bottom: 14px; margin-bottom: 14px; }
    .email-message:last-of-type { border-bottom: none; }
    .email-message-header {
      display: flex; align-items: flex-start; gap: 14px; padding: 8px 0 12px; cursor: default;
    }
    .email-message.collapsed .email-message-header { cursor: pointer; padding-bottom: 8px; }
    .email-message-who { display: flex; flex-direction: column; min-width: 0; flex: 1; }
    .email-message-from { font-size: 14px; font-weight: 700; color: var(--m-text); }
    .email-message-meta {
      font-size: 12px; color: var(--m-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .email-message-date { font-size: 12px; color: var(--m-text-2); white-space: nowrap; }
    .email-message.collapsed .email-message-body { display: none; }
    .email-message-body { border-radius: 8px; overflow: hidden; }
    .email-body-frame { width: 100%; border: none; display: block; min-height: 80px; background: #fff; }
    .email-body-text {
      margin: 0; padding: 4px 0 0; font-size: 14px; line-height: 1.5; color: var(--m-text);
      background: none; white-space: pre-wrap; word-break: break-word; font-family: inherit;
    }
    .email-reply-row { display: flex; gap: 12px; padding: 20px 0 4px; }

    .email-att-row {
      display: flex; flex-wrap: wrap; gap: 10px; padding: 14px 0 0; background: none;
    }
    .email-att-tile {
      display: flex; align-items: center; gap: 8px; padding: 8px 10px;
      background: var(--m-surface); border: 1px solid var(--m-border); border-radius: 8px; max-width: 280px;
    }
    .email-att-tile:hover { background: var(--m-hover); }
    .email-att-icon { font-size: 18px; }
    .email-att-info { display: flex; flex-direction: column; min-width: 0; }
    .email-att-name {
      font-size: 13px; color: var(--m-text); font-weight: 500; cursor: pointer;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 150px;
    }
    .email-att-name:hover { color: var(--m-accent); text-decoration: underline; }
    .email-att-size { font-size: 11px; color: var(--m-text-2); }
    .email-att-tile .email-icon-btn { width: 30px; height: 30px; }

    .email-claude-btn { color: var(--m-accent); border-color: var(--m-accent); }
    .email-compose-window {
      position: absolute; right: 24px; bottom: 0; z-index: 40;
      width: 560px; height: 460px; min-width: 360px; min-height: 260px;
      max-width: calc(100% - 32px); max-height: calc(100% - 16px);
      display: flex; flex-direction: column; overflow: hidden;
      resize: both;
      background: var(--m-surface); border: 1px solid var(--m-border);
      border-radius: 12px 12px 0 0; box-shadow: var(--m-lift);
    }
    .email-compose-window .email-draft-editor {
      margin: 0; border: none; border-radius: 0; box-shadow: none;
      flex: 1; min-height: 0; display: flex; flex-direction: column;
    }
    .email-compose-window .email-draft-header { cursor: move; user-select: none; }
    .email-compose-window .email-draft-editor textarea { flex: 1; min-height: 80px; }
    .email-compose-window .email-draft-extras { flex-shrink: 0; }
    .email-compose-window .email-draft-actions { flex-shrink: 0; }
    .email-draft-host {
      position: sticky; bottom: 0; z-index: 6; margin-top: auto;
      background: var(--m-surface); box-shadow: 0 -8px 20px rgba(0,0,0,0.12);
    }
    .email-draft-host:empty { display: none; box-shadow: none; }
    .email-draft-editor {
      margin: 12px 20px 20px; border: 1px solid var(--m-border); border-radius: 12px;
      background: var(--m-surface); overflow: hidden; box-shadow: var(--m-lift);
    }
    .email-draft-header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 10px 8px 10px 16px; font-size: 13px; font-weight: 500; color: var(--m-text);
      background: var(--m-surface-2);
    }
    .email-draft-header button {
      background: none; border: none; color: var(--m-text-2); font-size: 20px; line-height: 1; cursor: pointer;
    }
    .email-draft-fields { display: flex; flex-direction: column; }
    .email-draft-fields label {
      display: flex; align-items: center; gap: 10px; padding: 0 16px;
      font-size: 13px; color: var(--m-text-2); border-bottom: 1px solid var(--m-divider);
    }
    .email-draft-fields input {
      flex: 1; padding: 10px 0; background: none; border: none;
      color: var(--m-text); font-size: 13px; font-family: inherit;
    }
    .email-draft-editor textarea {
      width: 100%; box-sizing: border-box; margin: 0; padding: 14px 16px;
      background: none; border: none; color: var(--m-text);
      font-size: 14px; line-height: 1.5; resize: vertical; font-family: inherit;
    }
    .email-draft-editor textarea:focus, .email-draft-fields input:focus { outline: none; }
    .email-to-wrap { position: relative; flex: 1; display: flex; }
    .email-to-wrap input { width: 100%; }
    .email-to-dropdown {
      position: absolute; top: 100%; left: 0; right: 0; margin-top: 3px; z-index: 40;
      background: var(--m-surface); border: 1px solid var(--m-border); border-radius: 8px;
      max-height: 280px; overflow-y: auto; box-shadow: var(--m-lift);
    }
    .email-to-option { display: flex; align-items: center; gap: 10px; padding: 8px 12px; cursor: pointer; }
    .email-to-option:hover, .email-to-option.active { background: var(--m-hover); }
    .email-to-avatar {
      width: 28px; height: 28px; border-radius: 50%; background: var(--m-accent); color: var(--m-bg);
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 13px; font-weight: 500; flex-shrink: 0;
    }
    .email-to-details { display: flex; flex-direction: column; min-width: 0; }
    .email-to-name { font-size: 13px; color: var(--m-text); font-weight: 500; }
    .email-to-addr { font-size: 12px; color: var(--m-text-2); overflow: hidden; text-overflow: ellipsis; }
    .email-draft-extras { padding: 12px 16px 0; }
    .email-draft-attach-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .email-draft-attach-row > button {
      background: none; border: 1px solid var(--m-border); border-radius: 16px;
      color: var(--m-text-2); padding: 6px 14px; cursor: pointer; font-size: 13px; font-family: inherit;
    }
    .email-draft-attach-row > button:hover { background: var(--m-hover); color: var(--m-text); }
    .email-draft-att-chips { display: flex; gap: 6px; flex-wrap: wrap; }
    .email-draft-att-chip {
      display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px;
      background: var(--m-hover); border-radius: 14px; font-size: 12px; color: var(--m-text);
      max-width: 240px; overflow: hidden; white-space: nowrap;
    }
    .email-att-chip-remove {
      background: none; border: none; color: var(--m-text-2); cursor: pointer; font-size: 14px; padding: 0;
    }
    .email-att-chip-remove:hover { color: #d93025; }
    .email-sig-block { margin-top: 12px; }
    .email-sig-toggle {
      display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--m-text-2); cursor: pointer;
    }
    .email-sig-preview {
      margin-top: 6px; padding: 10px 12px; background: #fff; border-radius: 8px;
      font-size: 13px; color: #202124; max-height: 140px; overflow-y: auto;
    }
    .email-sig-preview img { max-height: 60px; }
    .email-draft-actions { display: flex; align-items: center; gap: 10px; padding: 12px 16px 16px; }
    .email-draft-actions button {
      background: none; border: 1px solid var(--m-border); border-radius: 18px;
      color: var(--m-text); padding: 8px 18px; cursor: pointer; font-size: 14px; font-family: inherit;
    }
    .email-draft-actions button:hover { background: var(--m-hover); }
    .email-draft-send {
      background: var(--m-accent) !important; border-color: transparent !important;
      color: var(--m-bg) !important; font-weight: 500;
    }
    .email-draft-send:hover { filter: brightness(1.1); }
    .email-draft-discard:hover { color: #d93025 !important; border-color: #d93025 !important; }

    #emailToastHost { position: absolute; bottom: 18px; left: 50%; transform: translateX(-50%); z-index: 50; }
    .email-undo-toast {
      display: flex; align-items: center; gap: 16px; background: #323232; color: #fff;
      border-radius: 8px; padding: 12px 18px; font-size: 14px;
      box-shadow: var(--m-lift); position: relative; overflow: hidden;
    }
    .email-undo-toast.error { background: #d93025; }
    .email-undo-btn {
      background: none; border: none; color: #8ab4f8; font-weight: 500; font-size: 14px;
      cursor: pointer; font-family: inherit;
    }
    .email-undo-btn:hover { color: #aecbfa; }
    .email-undo-progress { position: absolute; bottom: 0; left: 0; right: 0; height: 2px; background: rgba(255,255,255,0.2); }
    .email-undo-progress-fill {
      height: 100%; background: #8ab4f8; width: 100%; transform-origin: left;
      animation-name: email-undo-shrink; animation-timing-function: linear; animation-fill-mode: forwards;
    }
    @keyframes email-undo-shrink { from { transform: scaleX(1); } to { transform: scaleX(0); } }

    #emailPreviewOverlay {
      position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 100;
      display: flex; align-items: center; justify-content: center;
    }
    .email-preview-box {
      background: var(--m-surface); border-radius: 12px; box-shadow: var(--m-lift);
      max-width: 86vw; max-height: 88vh; display: flex; flex-direction: column; overflow: hidden;
    }
    .email-preview-header {
      display: flex; justify-content: space-between; align-items: center; gap: 20px;
      padding: 12px 16px; border-bottom: 1px solid var(--m-divider); color: var(--m-text); font-size: 14px;
    }
    .email-preview-header button {
      background: none; border: none; color: var(--m-text-2); font-size: 22px; line-height: 1; cursor: pointer;
    }
    .email-preview-content { overflow: auto; display: flex; align-items: center; justify-content: center; }
    .email-preview-content img { max-width: 84vw; max-height: 78vh; display: block; }
    .email-preview-pdf { width: 80vw; height: 78vh; }
    .email-preview-text {
      margin: 0; padding: 16px; font-size: 13px; color: var(--m-text); max-width: 80vw; max-height: 78vh;
      overflow: auto; white-space: pre-wrap;
    }
    .email-preview-loading { padding: 40px; color: var(--m-text-2); font-size: 14px; }

    .email-empty-state {
      flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 10px; color: #94a3b8; height: 100%;
    }
    .email-empty-icon { font-size: 42px; }
    .email-empty-state h2 { color: #f1f5f9; margin: 0; }
    .email-empty-state p { margin: 0 0 10px; font-size: 13px; }

    .email-open-btn { position: relative; }
    .email-unread-badge {
      position: absolute; right: 10px; top: 50%; transform: translateY(-50%);
      background: #4f46e5; color: #fff; font-size: 10px; font-weight: 700;
      border-radius: 10px; padding: 2px 7px; align-items: center;
    }
  `;
  document.head.appendChild(style);
}
