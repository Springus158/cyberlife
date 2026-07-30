// Help component library: extends markdown with visual blocks reused across
// all help content (and later: onboarding, empty states, tooltips anywhere).
//
// Block syntax (line-based):
//   :::tip Optional title        -> callout box (tip|info|warning|danger|keyboard|hint)
//   ...markdown body...
//   :::
//   :::steps ... :::             -> numbered visual steps (one <li> per "1. ..." row)
//   :::cards ... :::             -> feature card grid (### Card title + body per card)
//
// Inline syntax:
//   [[kbd:j k Enter]]            -> key caps
//   [[badge:NEW]] [[badge:BETA]] -> colored pill
//   [[tip:text|tooltip body]]    -> dotted underline with hover tooltip

import { marked } from 'marked';

const CALLOUT_META = {
  tip:      { icon: '💡', label: 'Tip' },
  info:     { icon: 'ℹ️', label: 'Info' },
  warning:  { icon: '⚠️', label: 'Warning' },
  danger:   { icon: '🔥', label: 'Important' },
  keyboard: { icon: '⌨️', label: 'Keyboard' },
  hint:     { icon: '👉', label: 'Hint' },
};

function renderInline(html) {
  return html
    .replace(/\[\[kbd:([^\]]+)\]\]/g, (_, keys) =>
      `<span class="hc-kbd-group">${keys.trim().split(/\s+/).map(k => `<kbd>${k}</kbd>`).join('')}</span>`)
    .replace(/\[\[badge:([^\]]+)\]\]/g, (_, text) =>
      `<span class="hc-badge hc-badge-${text.trim().toLowerCase()}">${text.trim()}</span>`)
    .replace(/\[\[tip:([^|\]]+)\|([^\]]+)\]\]/g, (_, text, tip) =>
      `<span class="hc-tooltip" data-tip="${tip.replace(/"/g, '&quot;')}">${text}</span>`);
}

function renderCallout(type, title, body) {
  const meta = CALLOUT_META[type] || CALLOUT_META.info;
  return `
    <div class="hc-callout hc-${type}">
      <div class="hc-callout-head">
        <span class="hc-callout-icon">${meta.icon}</span>
        <span class="hc-callout-title">${title || meta.label}</span>
      </div>
      <div class="hc-callout-body">${marked.parse(body)}</div>
    </div>
  `;
}

function renderSteps(body) {
  const steps = [];
  let current = null;
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*\d+\.\s+(.*)$/);
    if (m) {
      if (current) steps.push(current);
      current = m[1];
    } else if (current !== null) {
      current += '\n' + line;
    }
  }
  if (current) steps.push(current);
  return `
    <div class="hc-steps">
      ${steps.map((s, i) => `
        <div class="hc-step">
          <div class="hc-step-num">${i + 1}</div>
          <div class="hc-step-body">${marked.parse(s)}</div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderCards(body) {
  const cards = body.split(/^###\s+/m).filter(c => c.trim());
  return `
    <div class="hc-cards">
      ${cards.map(c => {
        const nl = c.indexOf('\n');
        const title = nl === -1 ? c : c.slice(0, nl);
        const rest = nl === -1 ? '' : c.slice(nl + 1);
        return `
          <div class="hc-card">
            <div class="hc-card-title">${title.trim()}</div>
            <div class="hc-card-body">${marked.parse(rest)}</div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

// renderHelpMarkdown: split out ::: blocks, render each with its component,
// markdown-parse the rest, then apply inline tokens to the final HTML
export function renderHelpMarkdown(src) {
  const parts = [];
  const lines = src.split('\n');
  let plain = [];
  let block = null; // { type, title, body: [] }

  const flushPlain = () => {
    if (plain.length) {
      parts.push(marked.parse(plain.join('\n')));
      plain = [];
    }
  };

  for (const line of lines) {
    const open = line.match(/^:::(\w+)\s*(.*)$/);
    if (!block && open && open[1] !== '') {
      flushPlain();
      block = { type: open[1], title: open[2].trim(), body: [] };
      continue;
    }
    if (block && line.trim() === ':::') {
      const body = block.body.join('\n');
      if (block.type === 'steps') parts.push(renderSteps(body));
      else if (block.type === 'cards') parts.push(renderCards(body));
      else parts.push(renderCallout(block.type, block.title, body));
      block = null;
      continue;
    }
    if (block) block.body.push(line);
    else plain.push(line);
  }
  if (block) plain.push(...[':::' + block.type, ...block.body]); // unterminated: show raw
  flushPlain();

  return renderInline(parts.join('\n'));
}

// decorateCodeBlocks: add a header bar with language + copy button to every
// <pre><code> inside the container (call after innerHTML is set)
export function decorateCodeBlocks(container) {
  container.querySelectorAll('pre').forEach(pre => {
    if (pre.parentElement?.classList.contains('hc-code')) return;
    const code = pre.querySelector('code');
    const lang = [...(code?.classList || [])]
      .find(c => c.startsWith('language-'))?.replace('language-', '') || 'shell';

    const wrap = document.createElement('div');
    wrap.className = 'hc-code';
    pre.replaceWith(wrap);

    const head = document.createElement('div');
    head.className = 'hc-code-head';
    head.innerHTML = `<span>${lang}</span><button class="hc-code-copy" type="button">copy</button>`;
    wrap.appendChild(head);
    wrap.appendChild(pre);

    head.querySelector('.hc-code-copy').addEventListener('click', (e) => {
      navigator.clipboard.writeText(code?.textContent || pre.textContent).then(() => {
        e.target.textContent = 'copied!';
        setTimeout(() => { e.target.textContent = 'copy'; }, 1500);
      }).catch((err) => { console.warn('copy failed:', err); });
    });
  });
}
