// Vimium-style hint mode: `f` overlays letter labels on everything clickable
// in the viewport; typing a label clicks it. Universal keyboard escape hatch
// for UI that has no dedicated shortcut yet.

const HINT_ALPHABET = 'asdfghjklqwertyuiopzxcvbnm';

const CLICKABLE_SELECTOR = [
  'button',
  'a[href]',
  '[onclick]',
  '[role="button"]',
  'input:not([type="hidden"])',
  'textarea',
  'select',
  '[data-hint]',
  '.session-row',
  '.email-row',
  '.terminal-list-item',
  '.term-tab-btn',
  '.browser-tab',
  '.todo-item',
  '.board-card',
  '.key-btn',
  '.pinned-prompt-btn',
  '.prompt-card',
  '.right-sidebar-tab',
  '.git-file-item',
].join(', ');

let hints = [];
let buffer = '';

export function isHintMode() {
  return hints.length > 0;
}

function visibleClickables() {
  const seen = new Set();
  const result = [];
  for (const el of document.querySelectorAll(CLICKABLE_SELECTOR)) {
    if (seen.has(el) || el.closest('#hintOverlay')) continue;
    seen.add(el);
    if (el.disabled) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
    if (rect.right < 0 || rect.left > window.innerWidth) continue;
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') continue;
    result.push({ el, rect });
  }
  // Priority targets (e.g. mailbox switcher chips) get the first — shortest —
  // labels regardless of DOM position
  result.sort((a, b) => (b.el.closest('[data-hint-priority]') ? 1 : 0) - (a.el.closest('[data-hint-priority]') ? 1 : 0));
  return result;
}

// When labels must go two-letter, `reserved` priority targets keep
// single-letter labels; doubles are built from the remaining alphabet so
// the set stays prefix-free
function makeLabels(count, reserved = 0) {
  const a = HINT_ALPHABET;
  if (count <= a.length) return [...a.slice(0, count)];
  const singles = Math.min(reserved, 8);
  const rest = a.slice(singles);
  const labels = [...a.slice(0, singles)];
  for (let i = 0; labels.length < count && i < rest.length; i++) {
    for (let j = 0; labels.length < count && j < rest.length; j++) {
      labels.push(rest[i] + rest[j]);
    }
  }
  return labels;
}

export function enterHintMode() {
  exitHintMode();
  const targets = visibleClickables();
  if (targets.length === 0) return;

  const overlay = document.createElement('div');
  overlay.id = 'hintOverlay';
  const reserved = targets.filter(t => t.el.closest('[data-hint-priority]')).length;
  const labels = makeLabels(targets.length, reserved);

  hints = targets.map(({ el, rect }, i) => {
    const label = document.createElement('span');
    label.className = 'hint-label';
    label.textContent = labels[i];
    label.style.left = `${Math.max(0, rect.left - 2)}px`;
    label.style.top = `${Math.max(0, rect.top - 2)}px`;
    overlay.appendChild(label);
    return { el, code: labels[i], label };
  });

  buffer = '';
  document.body.appendChild(overlay);
}

export function exitHintMode() {
  document.getElementById('hintOverlay')?.remove();
  hints = [];
  buffer = '';
}

function activate(el) {
  exitHintMode();
  el.click();
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') el.focus();
}

export function handleHintKey(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) {
    exitHintMode();
    return;
  }
  e.preventDefault();

  if (e.key === 'Escape') {
    exitHintMode();
    return;
  }
  if (e.key === 'Backspace') {
    buffer = buffer.slice(0, -1);
    refreshLabels();
    return;
  }
  if (e.key.length !== 1 || !HINT_ALPHABET.includes(e.key.toLowerCase())) return;

  buffer += e.key.toLowerCase();
  const exact = hints.find(h => h.code === buffer);
  if (exact) {
    activate(exact.el);
    return;
  }
  if (!hints.some(h => h.code.startsWith(buffer))) {
    exitHintMode();
    return;
  }
  refreshLabels();
}

function refreshLabels() {
  for (const h of hints) {
    const match = h.code.startsWith(buffer);
    h.label.classList.toggle('hint-dimmed', !match);
    h.label.innerHTML = match && buffer
      ? `<b>${buffer}</b>${h.code.slice(buffer.length)}`
      : h.code;
  }
}
