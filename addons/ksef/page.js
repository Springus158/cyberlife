// UI: the Invoices module page (list, filters, create form, detail, print
// view styled after Fakturownia's classic template), the two widgets and the
// Settings section. All rendering is plain DOM into the container the host
// hands us.

import { importFromFakturownia, fetchFakturowniaInfo } from './fakturownia.js';
import { syncCompany, createInvoice, sendToKsef, checkSendStatus, setPaid, clearTokenCache, today } from './service.js';
import { lineNet, lineVat } from './fa3.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const zl = (n, cur = 'PLN') => `${(Number(n) || 0).toFixed(2)} ${cur}`;

function payBadge(inv) {
  if (inv.kind === 'proforma') return '<span class="ksefad-muted">proforma</span>';
  if (inv.paid) return '<span class="ksefad-badge paid">opłacona</span>';
  if (Number(inv.paidAmount) > 0) {
    return `<span class="ksefad-badge partial" title="opłacono ${zl(inv.paidAmount, inv.currency)} z ${zl(inv.gross, inv.currency)}">◐ częściowo</span>`;
  }
  return '<span class="ksefad-badge unpaid">nieopłacona</span>';
}

const STYLE_ID = 'ksefad-style';

// Keyed by element id, not a module flag: a hot reload re-imports the module
// and would otherwise append a duplicate stylesheet each time
function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .ksefad { display:flex; flex-direction:column; gap:10px; height:100%; font-size: 14px; }
    .ksefad-bar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
    .ksefad-tabs { display:flex; gap:2px; }
    .ksefad-tab { background:transparent; border:1px solid var(--border, #45475a); color:inherit;
      border-radius:6px 6px 0 0; border-bottom:none; padding:6px 16px; cursor:pointer; font:inherit; opacity:.6; }
    .ksefad-tab.active { opacity:1; border-color:var(--accent, #89b4fa); color:var(--accent, #89b4fa); font-weight:600; }
    .ksefad-bar select, .ksefad-bar input, .ksefad select, .ksefad input, .ksefad textarea {
      background: var(--bg-surface, #313244); color: inherit; border: 1px solid var(--border, #45475a);
      border-radius: 6px; padding: 5px 8px; font: inherit; }
    .ksefad-btn { background: var(--bg-surface, #313244); border: 1px solid var(--border, #45475a);
      color: inherit; border-radius: 6px; padding: 5px 10px; cursor: pointer; font: inherit; }
    .ksefad-btn:hover { border-color: var(--accent, #89b4fa); color: var(--accent, #89b4fa); }
    .ksefad-btn.primary { border-color: var(--accent, #89b4fa); }
    .ksefad-table { width:100%; border-collapse: collapse; }
    .ksefad-table th { text-align:left; opacity:.6; font-weight:600; padding:4px 8px; border-bottom:1px solid var(--border, #45475a); }
    .ksefad-table td { padding:5px 8px; border-bottom:1px solid rgba(128,128,128,.15); }
    .ksefad-table tr.sel td, .ksefad-table tbody tr:hover td { background: rgba(137,180,250,.08); cursor:pointer; }
    .ksefad-scroll { overflow:auto; flex:1; min-height:0; }
    .ksefad-badge { font-size:.85em; border:1px solid; border-radius:10px; padding:0 7px; white-space:nowrap; }
    .ksefad-badge.paid { color:var(--success, #a6e3a1); border-color:var(--success, #a6e3a1); }
    .ksefad-badge.unpaid { color:var(--warning, #f9e2af); border-color:var(--warning, #f9e2af); }
    .ksefad-badge.partial { color:var(--success, #a6e3a1); border-color:var(--success, #a6e3a1);
      background:linear-gradient(90deg, rgba(166,227,161,.30) 50%, transparent 50%); }
    .ksefad-badge.cost { color:var(--error, #f38ba8); border-color:var(--error, #f38ba8); }
    .ksefad-badge.sale { color:var(--accent, #89b4fa); border-color:var(--accent, #89b4fa); }
    .ksefad-overlay { position:fixed; inset:0; background:rgba(0,0,0,.55); z-index:900;
      display:flex; align-items:center; justify-content:center; }
    .ksefad-modal { background: var(--bg-secondary, #181825); border:1px solid var(--border, #45475a);
      border-radius:10px; padding:18px; width:min(720px, 92vw); max-height:88vh; overflow:auto; }
    .ksefad-modal.lg { width:min(1060px, 94vw); max-height:92vh; padding:32px 40px; font-size:15px; }
    .ksefad-modal.lg input, .ksefad-modal.lg select { padding:10px 12px; font-size:15px; border-radius:8px; }
    .ksefad-modal.lg .ksefad-btn { padding:10px 18px; font-size:15px; border-radius:8px; }
    .ksefad-modal.lg label { font-weight:600; }
    .ksefad-doc-head { display:flex; justify-content:space-between; align-items:baseline; gap:16px;
      border-bottom:1px solid var(--border, #45475a); padding-bottom:14px; margin-bottom:16px; }
    .ksefad-doc-head h2 { font-size:22px; margin:0; }
    .ksefad-doc-dates div { margin-bottom:4px; }
    .ksefad-doc-parties { display:grid; grid-template-columns:1fr 1fr; gap:24px; margin:18px 0; }
    .ksefad-doc-party .ksefad-party-label { font-size:13px; opacity:.6; margin-bottom:6px; text-transform:uppercase; letter-spacing:.04em; }
    .ksefad-doc-party .ksefad-party-name { font-size:17px; font-weight:700; margin-bottom:4px; }
    .ksefad-doc-table { width:100%; border-collapse:collapse; margin:16px 0; font-size:15px; }
    .ksefad-doc-table th { background:rgba(128,128,128,.12); font-weight:600; text-align:left;
      padding:10px 12px; border:1px solid var(--border, #45475a); }
    .ksefad-doc-table td { padding:10px 12px; border:1px solid var(--border, #45475a); }
    .ksefad-doc-totals { margin-left:auto; width:max-content; font-size:16px; margin-bottom:16px; }
    .ksefad-doc-totals div { display:flex; justify-content:flex-end; gap:24px; padding:3px 0; }
    .ksefad-doc-totals .ksefad-doc-due { font-size:19px; font-weight:700; border-top:1px solid var(--border, #45475a);
      padding-top:8px; margin-top:6px; }
    .ksefad-grid { display:grid; grid-template-columns: 1fr 1fr; gap:8px; }
    .ksefad-modal.lg .ksefad-grid { gap:14px 18px; }
    .ksefad-lines td { padding:2px; }
    .ksefad-modal.lg .ksefad-lines td { padding:4px; }
    .ksefad-modal.lg .ksefad-lines input, .ksefad-modal.lg .ksefad-lines select { padding:9px 10px; }
    .ksefad-muted { opacity:.6; }
    .ksefad-error { color:var(--error, #f38ba8); white-space:pre-wrap; }
    .ksefad-widget { display:flex; flex-direction:column; gap:4px; font-size:.95em; }
    .ksefad-widget-row { display:flex; justify-content:space-between; gap:8px; }
    .ksefad-widget-row span:first-child { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    #ksefad-print { display:none; }
    @media print {
      body > * { display:none !important; }
      #ksefad-print { display:block !important; position:static; color:#000; background:#fff; }
    }
  `;
  document.head.appendChild(style);
}

const view = {
  companyId: '',
  dir: 'sale',
  unpaid: false,
  query: '',
  busy: '',
  error: '',
  selected: 0,
};

function switchTab(el, deps, dir) {
  if (view.dir === dir) return;
  view.dir = dir;
  view.selected = 0;
  renderPage(el, deps);
}

// ---- module page ----

export function renderPage(el, deps) {
  injectStyle();
  const { store } = deps;
  const companies = store.companies();
  if (!companies.length) {
    el.innerHTML = `
      <div class="ksefad">
        <h2>🧾 Invoices — KSeF</h2>
        <p>Polish e-invoicing (KSeF). No companies configured yet — add one in
        <b>Settings → Addons → KSeF</b>: name, NIP, KSeF token, optionally the
        Fakturownia account to import history from.</p>
      </div>`;
    return;
  }
  const invoices = store.listInvoices({
    companyId: view.companyId || undefined,
    dir: view.dir || undefined,
    unpaid: view.unpaid || undefined,
    query: view.query || undefined,
    limit: 300,
  });
  view.selected = Math.min(view.selected, Math.max(0, invoices.length - 1));

  el.innerHTML = `
    <div class="ksefad">
      <div class="ksefad-bar">
        <div class="ksefad-tabs">
          <button class="ksefad-tab ${view.dir === 'sale' ? 'active' : ''}" data-dir="sale">Przychody</button>
          <button class="ksefad-tab ${view.dir === 'cost' ? 'active' : ''}" data-dir="cost">Wydatki</button>
        </div>
        <select id="ksefadCompany">
          <option value="">All companies</option>
          ${companies.map((c) => `<option value="${esc(c.id)}" ${c.id === view.companyId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select>
        <label><input type="checkbox" id="ksefadUnpaid" ${view.unpaid ? 'checked' : ''}> unpaid</label>
        <input id="ksefadQuery" placeholder="search… (/)" value="${esc(view.query)}" style="flex:1; min-width:120px">
        <button class="ksefad-btn" id="ksefadSync" ${view.busy ? 'disabled' : ''}>${view.busy === 'sync' ? 'Syncing…' : '⟳ Sync KSeF (r)'}</button>
        <button class="ksefad-btn primary" id="ksefadNew">+ New invoice (n)</button>
      </div>
      ${view.error ? `<div class="ksefad-error">${esc(view.error)}</div>` : ''}
      <div class="ksefad-scroll">
        <table class="ksefad-table">
          <thead><tr><th>Number</th><th>Date</th><th>Contractor</th><th>Gross</th><th>Status</th><th>KSeF</th></tr></thead>
          <tbody>
            ${invoices.map((inv, i) => `
              <tr data-id="${esc(inv.id)}" class="${i === view.selected ? 'sel' : ''}">
                <td>${esc(inv.number || '—')}</td>
                <td>${esc(inv.issueDate)}</td>
                <td>${esc(inv.dir === 'sale' ? inv.buyerName : inv.sellerName)}</td>
                <td style="text-align:right">${zl(inv.gross, inv.currency)}</td>
                <td>${payBadge(inv)}</td>
                <td class="ksefad-muted">${inv.ksefNumber ? '✓' : (inv.sendState === 'error' ? '⚠' : '—')}</td>
              </tr>`).join('')}
          </tbody>
        </table>
        ${invoices.length ? '' : '<p class="ksefad-muted" style="padding:12px">No invoices match. Run the Fakturownia import (Settings) or Sync KSeF.</p>'}
      </div>
      <div class="ksefad-muted">${invoices.length} shown · h/l lub Tab: przychody/wydatki · j/k select · Enter open · n new · r sync</div>
    </div>`;

  const rerender = () => renderPage(el, deps);
  el.querySelectorAll('.ksefad-tab').forEach((btn) => {
    btn.onclick = () => switchTab(el, deps, btn.dataset.dir);
  });
  el.querySelector('#ksefadCompany').onchange = (e) => { view.companyId = e.target.value; rerender(); };
  el.querySelector('#ksefadUnpaid').onchange = (e) => { view.unpaid = e.target.checked; rerender(); };
  // Re-rendering replaces the input the user is typing into, so focus and
  // caret have to be put back or only the first keystroke ever lands
  el.querySelector('#ksefadQuery').oninput = (e) => {
    view.query = e.target.value;
    const caret = e.target.selectionStart;
    rerender();
    const next = el.querySelector('#ksefadQuery');
    next.focus();
    next.setSelectionRange(caret, caret);
  };
  el.querySelector('#ksefadSync').onclick = () => runSync(el, deps);
  el.querySelector('#ksefadNew').onclick = () => openCreateForm(el, deps);
  el.querySelectorAll('tbody tr').forEach((tr, i) => {
    tr.onclick = () => { view.selected = i; openDetail(el, deps, tr.dataset.id); };
  });
}

async function runSync(el, deps) {
  const { store } = deps;
  view.busy = 'sync';
  view.error = '';
  renderPage(el, deps);
  const targets = view.companyId ? [store.company(view.companyId)] : store.companies();
  const errors = [];
  for (const company of targets.filter(Boolean)) {
    try {
      await syncCompany(deps, company);
    } catch (err) {
      deps.cl.log('sync failed:', err);
      errors.push(`${company.name}: ${err.message || err}`);
      await store.setSyncState(company.id, { lastError: String(err.message || err) });
    }
  }
  view.busy = '';
  view.error = errors.join('\n');
  renderPage(el, deps);
}

// ---- detail ----

function openDetail(el, deps, id) {
  const { store } = deps;
  const inv = store.getInvoice(id);
  if (!inv) return;
  const company = store.company(inv.companyId);
  const overlay = document.createElement('div');
  // modal-overlay is what the host's Esc handling and hasOpenModal() look
  // for; without it Esc would fall through to the terminal and interrupt
  // whatever session is attached
  overlay.className = 'ksefad-overlay modal-overlay';
  const title = inv.kind === 'proforma' ? 'Proforma' : (inv.dir === 'cost' ? 'Faktura kosztowa' : 'Faktura');
  const party = (label, name, nip, addr1, addr2, bank) => `
    <div class="ksefad-doc-party">
      <div class="ksefad-party-label">${label}</div>
      <div class="ksefad-party-name">${esc(name || '—')}</div>
      ${addr1 ? `<div>${esc(addr1)}</div>` : ''}
      ${addr2 ? `<div>${esc(addr2)}</div>` : ''}
      ${nip ? `<div class="ksefad-muted">NIP ${esc(nip)}</div>` : ''}
      ${bank ? `<div class="ksefad-muted" style="margin-top:6px">Rachunek: ${esc(bank)}</div>` : ''}
    </div>`;
  const isSale = inv.dir === 'sale';
  overlay.innerHTML = `
    <div class="ksefad-modal lg">
      <div class="ksefad-doc-head">
        <h2>${esc(title)} <b>${esc(inv.number || inv.ksefNumber)}</b></h2>
        <div class="ksefad-doc-dates">
          <div>Data wystawienia: <b>${esc(inv.issueDate)}</b></div>
          ${inv.sellDate && inv.sellDate !== inv.issueDate ? `<div>Data sprzedaży: <b>${esc(inv.sellDate)}</b></div>` : ''}
          <div>Termin płatności: <b>${esc(inv.paymentTo || '—')}</b></div>
        </div>
      </div>
      <div class="ksefad-doc-parties">
        ${party('Sprzedawca', inv.sellerName, inv.sellerNip, null, null, isSale && inv.src === 'local' ? company?.bankAccount : null)}
        ${party('Nabywca', inv.buyerName, inv.buyerNip, inv.buyerAddress1, inv.buyerAddress2, null)}
      </div>
      ${(inv.lines || []).length ? `
        <table class="ksefad-doc-table">
          <thead><tr><th>LP</th><th>Nazwa towaru / usługi</th><th>Ilość</th><th>Cena netto</th>
            <th>Wartość netto</th><th>VAT %</th><th>Wartość VAT</th><th>Wartość brutto</th></tr></thead>
          <tbody>${inv.lines.map((l, i) => `<tr>
            <td>${i + 1}</td>
            <td>${esc(l.name)}</td>
            <td>${esc(l.quantity)} ${esc(l.unit)}</td>
            <td style="text-align:right">${Number(l.unitNetPrice).toFixed(2)}</td>
            <td style="text-align:right">${lineNet(l).toFixed(2)}</td>
            <td style="text-align:right">${esc(l.vatRate)}</td>
            <td style="text-align:right">${lineVat(l).toFixed(2)}</td>
            <td style="text-align:right">${(lineNet(l) + lineVat(l)).toFixed(2)}</td>
          </tr>`).join('')}
          </tbody>
        </table>` : ''}
      <div class="ksefad-doc-totals">
        <div><span>Wartość netto</span><span>${zl(inv.net, inv.currency)}</span></div>
        <div><span>Wartość VAT</span><span>${zl(inv.vat, inv.currency)}</span></div>
        <div><span>Wartość brutto</span><span><b>${zl(inv.gross, inv.currency)}</b></span></div>
        ${inv.kind !== 'proforma' ? (() => {
          const paidAmt = inv.paid ? inv.gross : (Number(inv.paidAmount) || 0);
          return `
          <div><span>Kwota opłacona</span><span>${zl(paidAmt, inv.currency)}${inv.paidDate ? ` <span class="ksefad-muted">(${esc(inv.paidDate)})</span>` : ''}</span></div>
          <div class="ksefad-doc-due"><span>Do zapłaty</span><span>${zl(Math.max(0, inv.gross - paidAmt), inv.currency)}</span></div>`;
        })() : ''}
      </div>
      <div class="ksefad-muted" style="margin-bottom:14px">
        ${inv.ksefNumber ? `Numer KSeF: <b>${esc(inv.ksefNumber)}</b>` : `KSeF: ${esc(inv.sendState || '—')}`}
        · źródło: ${esc(inv.src)}
        ${inv.sendError ? `<div class="ksefad-error">${esc(inv.sendError)}</div>` : ''}
      </div>
      <div class="ksefad-bar">
        ${inv.kind !== 'proforma' ? `<button class="ksefad-btn" id="ksefadPaid">${inv.paid ? 'Oznacz jako niezapłaconą' : 'Oznacz jako zapłaconą'}</button>` : ''}
        ${inv.src === 'local' ? `<button class="ksefad-btn" id="ksefadPrint">Drukuj / PDF</button>` : ''}
        ${inv.sendState === 'processing' || (inv.sendState === 'error' && inv.sessionRef)
          ? `<button class="ksefad-btn primary" id="ksefadCheck">Sprawdź status KSeF</button>` : ''}
        ${inv.src === 'local' && !inv.ksefNumber && inv.kind !== 'proforma'
          && inv.sendState !== 'processing' && inv.sendState !== 'sending' && !inv.sessionRef
          ? `<button class="ksefad-btn primary" id="ksefadSend">Wyślij do KSeF</button>` : ''}
        <span style="flex:1"></span>
        <button class="ksefad-btn" id="ksefadClose">Zamknij (Esc)</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  overlay.querySelector('#ksefadClose').onclick = close;
  overlay.querySelector('#ksefadPaid')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await setPaid(deps, company, inv.id, !inv.paid);
      close();
    } catch (err) {
      e.target.disabled = false;
      alert(`Nie udało się zmienić statusu płatności: ${err.message || err}`);
    }
    renderPage(el, deps);
  });
  overlay.querySelector('#ksefadPrint')?.addEventListener('click', () => printInvoice(company, store.getInvoice(id)));
  overlay.querySelector('#ksefadCheck')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Sprawdzanie…';
    try {
      const updated = await checkSendStatus(deps, company, inv.id);
      close();
      if (!updated.ksefNumber) {
        alert('KSeF has not assigned a number yet — the invoice is still being processed.');
      }
    } catch (err) {
      e.target.disabled = false;
      e.target.textContent = 'Sprawdź status KSeF';
      alert(`Status check failed: ${err.message || err}`);
    }
    renderPage(el, deps);
  });
  overlay.querySelector('#ksefadSend')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Wysyłanie…';
    try {
      await sendToKsef(deps, company, inv.id);
      close();
    } catch (err) {
      e.target.disabled = false;
      e.target.textContent = 'Wyślij do KSeF';
      alert(`KSeF send failed: ${err.message || err}`);
    }
    renderPage(el, deps);
  });
}

// ---- create form ----

function linesFromForm(modal) {
  return [...modal.querySelectorAll('.ksefad-line')].map((row) => ({
    name: row.querySelector('.l-name').value.trim(),
    quantity: Number(row.querySelector('.l-qty').value) || 1,
    unit: row.querySelector('.l-unit').value.trim() || 'szt',
    unitNetPrice: Number(row.querySelector('.l-price').value) || 0,
    vatRate: Number(row.querySelector('.l-vat').value),
  })).filter((l) => l.name);
}

function lineRowHtml(l = {}) {
  return `<tr class="ksefad-line">
    <td><input class="l-name" placeholder="Nazwa towaru / usługi" value="${esc(l.name || '')}" style="width:100%"></td>
    <td><input class="l-qty" type="number" step="any" value="${esc(l.quantity ?? 1)}" style="width:80px"></td>
    <td><input class="l-unit" value="${esc(l.unit || 'szt')}" style="width:70px"></td>
    <td><input class="l-price" type="number" step="any" value="${esc(l.unitNetPrice ?? '')}" placeholder="netto" style="width:120px"></td>
    <td><select class="l-vat">${[23, 8, 5, 0].map((r) => `<option ${r === (l.vatRate ?? 23) ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
    <td class="l-net" style="text-align:right; min-width:100px">0,00</td>
    <td class="l-gross" style="text-align:right; min-width:100px">0,00</td>
  </tr>`;
}

function recalcFormTotals(overlay) {
  let net = 0;
  let vat = 0;
  for (const row of overlay.querySelectorAll('.ksefad-line')) {
    const line = {
      quantity: Number(row.querySelector('.l-qty').value) || 0,
      unitNetPrice: Number(row.querySelector('.l-price').value) || 0,
      vatRate: Number(row.querySelector('.l-vat').value) || 0,
    };
    const ln = lineNet(line);
    const lv = lineVat(line);
    row.querySelector('.l-net').textContent = ln.toFixed(2);
    row.querySelector('.l-gross').textContent = (ln + lv).toFixed(2);
    net += ln;
    vat += lv;
  }
  overlay.querySelector('#ksefadSumNet').textContent = net.toFixed(2);
  overlay.querySelector('#ksefadSumVat').textContent = vat.toFixed(2);
  overlay.querySelector('#ksefadSumGross').textContent = (net + vat).toFixed(2);
}

function openCreateForm(el, deps) {
  const { store } = deps;
  const companies = store.companies();
  const companyId = view.companyId || companies[0].id;
  const overlay = document.createElement('div');
  // modal-overlay is what the host's Esc handling and hasOpenModal() look
  // for; without it Esc would fall through to the terminal and interrupt
  // whatever session is attached
  overlay.className = 'ksefad-overlay modal-overlay';
  const contractors = store.contractors(companyId);
  const sellerBoxHtml = (c) => `
    <div class="ksefad-party-label">Sprzedawca</div>
    <div class="ksefad-party-name">${esc(c?.name || '')}</div>
    ${c?.address1 ? `<div>${esc(c.address1)}</div>` : ''}
    ${c?.address2 ? `<div>${esc(c.address2)}</div>` : ''}
    <div class="ksefad-muted">NIP ${esc(c?.nip || '—')}</div>
    ${c?.bankAccount ? `<div class="ksefad-muted" style="margin-top:6px">Rachunek: ${esc(c.bankAccount)}</div>` : ''}`;
  overlay.innerHTML = `
    <div class="ksefad-modal lg">
      <h2 style="margin-bottom:20px">Nowa faktura</h2>
      <div class="ksefad-grid" style="grid-template-columns:repeat(4, 1fr); margin-bottom:18px">
        <label>Firma<br><select id="ksefadFormCompany" style="width:100%">
          ${companies.map((c) => `<option value="${esc(c.id)}" ${c.id === companyId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select></label>
        <label>Rodzaj<br><select id="ksefadFormKind" style="width:100%">
          <option value="vat">Faktura VAT</option><option value="proforma">Proforma</option>
        </select></label>
        <label>Data wystawienia<br><input id="ksefadFormDate" type="date" value="${today()}" style="width:100%"></label>
        <label>Termin płatności<br><input id="ksefadFormDue" type="date" style="width:100%"></label>
      </div>
      <div class="ksefad-doc-parties" style="margin-bottom:18px">
        <div class="ksefad-doc-party" id="ksefadFormSeller">${sellerBoxHtml(store.company(companyId))}</div>
        <div class="ksefad-doc-party">
          <div class="ksefad-party-label">Nabywca</div>
          <div class="ksefad-grid" style="grid-template-columns:2fr 1fr">
            <label>Nazwa<br><input id="ksefadFormBuyer" list="ksefadContractors" style="width:100%" placeholder="nazwa firmy / imię i nazwisko">
              <datalist id="ksefadContractors">${contractors.map((c) => `<option value="${esc(c.name)}">`).join('')}</datalist></label>
            <label>NIP<br><input id="ksefadFormNip" style="width:100%"></label>
            <label>Ulica i nr<br><input id="ksefadFormAddr1" style="width:100%"></label>
            <label>Kod i miejscowość<br><input id="ksefadFormAddr2" style="width:100%"></label>
          </div>
        </div>
      </div>
      <div class="ksefad-party-label" style="font-size:13px; opacity:.6; text-transform:uppercase; letter-spacing:.04em; margin-bottom:6px">Pozycje</div>
      <table class="ksefad-table ksefad-lines" style="margin-bottom:10px">
        <thead><tr><th>Nazwa</th><th>Ilość</th><th>Jm</th><th>Cena netto</th><th>VAT %</th>
          <th style="text-align:right">Wartość netto</th><th style="text-align:right">Wartość brutto</th></tr></thead>
        <tbody id="ksefadFormLines">${lineRowHtml()}</tbody>
      </table>
      <div class="ksefad-bar" style="margin-bottom:14px">
        <button class="ksefad-btn" id="ksefadAddLine">+ Nowa pozycja</button>
        <span style="flex:1"></span>
        <div class="ksefad-doc-totals" style="margin:0">
          <div><span>Suma netto</span><span id="ksefadSumNet">0,00</span></div>
          <div><span>Suma VAT</span><span id="ksefadSumVat">0,00</span></div>
          <div class="ksefad-doc-due"><span>Suma brutto</span><span id="ksefadSumGross">0,00</span></div>
        </div>
      </div>
      <div class="ksefad-bar">
        <span id="ksefadFormError" class="ksefad-error"></span>
        <span style="flex:1"></span>
        <button class="ksefad-btn" id="ksefadSave">Zapisz szkic</button>
        <button class="ksefad-btn primary" id="ksefadSaveSend">Zapisz i wyślij do KSeF</button>
        <button class="ksefad-btn" id="ksefadCancel">Anuluj</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  overlay.querySelector('#ksefadCancel').onclick = close;
  overlay.querySelector('#ksefadAddLine').onclick = () => {
    overlay.querySelector('#ksefadFormLines').insertAdjacentHTML('beforeend', lineRowHtml());
    recalcFormTotals(overlay);
  };
  overlay.querySelector('#ksefadFormLines').addEventListener('input', () => recalcFormTotals(overlay));
  recalcFormTotals(overlay);
  overlay.querySelector('#ksefadFormCompany').addEventListener('change', (e) => {
    overlay.querySelector('#ksefadFormSeller').innerHTML = sellerBoxHtml(store.company(e.target.value));
    overlay.querySelector('#ksefadContractors').innerHTML = store.contractors(e.target.value)
      .map((c) => `<option value="${esc(c.name)}">`).join('');
  });
  overlay.querySelector('#ksefadFormBuyer').addEventListener('change', (e) => {
    const c = store.contractors(overlay.querySelector('#ksefadFormCompany').value)
      .find((x) => x.name === e.target.value);
    if (!c) return;
    overlay.querySelector('#ksefadFormNip').value = c.nip || '';
    if (c.address1) overlay.querySelector('#ksefadFormAddr1').value = c.address1;
    if (c.address2) overlay.querySelector('#ksefadFormAddr2').value = c.address2;
  });

  // Retrying after a failed send must not create the invoice a second time,
  // so a successfully created record is remembered across attempts
  let createdId = null;
  async function save(send) {
    const errEl = overlay.querySelector('#ksefadFormError');
    errEl.textContent = '';
    const company = store.company(overlay.querySelector('#ksefadFormCompany').value);
    try {
      if (!createdId) {
        const record = await createInvoice(deps, company, {
          kind: overlay.querySelector('#ksefadFormKind').value,
          buyerName: overlay.querySelector('#ksefadFormBuyer').value.trim(),
          buyerNip: overlay.querySelector('#ksefadFormNip').value.trim(),
          buyerAddress1: overlay.querySelector('#ksefadFormAddr1').value.trim(),
          buyerAddress2: overlay.querySelector('#ksefadFormAddr2').value.trim(),
          issueDate: overlay.querySelector('#ksefadFormDate').value,
          paymentTo: overlay.querySelector('#ksefadFormDue').value,
          lines: linesFromForm(overlay),
        });
        createdId = record.id;
      }
      if (send) await sendToKsef(deps, company, createdId);
      close();
    } catch (err) {
      errEl.textContent = createdId
        ? `Faktura zapisana jako szkic, ale: ${err.message || err}`
        : String(err.message || err);
    }
    renderPage(el, deps);
  }
  overlay.querySelector('#ksefadSave').onclick = () => save(false);
  overlay.querySelector('#ksefadSaveSend').onclick = () => save(true);
}

// ---- print (Fakturownia-style classic template) ----

export function printInvoice(company, inv) {
  document.getElementById('ksefad-print')?.remove();
  const root = document.createElement('div');
  root.id = 'ksefad-print';
  const lines = inv.lines || [];
  const vatGroups = {};
  for (const l of lines) {
    const g = vatGroups[l.vatRate] || { net: 0, vat: 0 };
    g.net += lineNet(l);
    g.vat += lineVat(l);
    vatGroups[l.vatRate] = g;
  }
  root.innerHTML = `
    <div style="font-family: Arial, Helvetica, sans-serif; font-size:12px; padding:24px; max-width:760px; margin:0 auto;">
      <table style="width:100%; margin-bottom:18px"><tr>
        <td style="vertical-align:top">
          <div style="font-size:11px; color:#555">Sprzedawca</div>
          <b>${esc(company?.name || inv.sellerName)}</b><br>
          ${esc(company?.address1 || '')}<br>${esc(company?.address2 || '')}<br>
          NIP: ${esc(inv.sellerNip)}
        </td>
        <td style="vertical-align:top; text-align:right">
          <div style="font-size:20px; margin-bottom:4px">${inv.kind === 'proforma' ? 'Faktura proforma' : 'Faktura VAT'} <b>${esc(inv.number)}</b></div>
          <div>Data wystawienia: ${esc(inv.issueDate)}</div>
          ${inv.sellDate && inv.sellDate !== inv.issueDate ? `<div>Data sprzedaży: ${esc(inv.sellDate)}</div>` : ''}
          ${inv.ksefNumber ? `<div style="font-size:10px; color:#555">KSeF: ${esc(inv.ksefNumber)}</div>` : ''}
        </td>
      </tr></table>
      <div style="margin-bottom:14px">
        <div style="font-size:11px; color:#555">Nabywca</div>
        <b>${esc(inv.buyerName)}</b><br>
        ${esc(inv.buyerAddress1 || '')}<br>${esc(inv.buyerAddress2 || '')}<br>
        ${inv.buyerNip ? `NIP: ${esc(inv.buyerNip)}` : ''}
      </div>
      <table style="width:100%; border-collapse:collapse; margin-bottom:14px">
        <thead><tr>
          ${['Lp', 'Nazwa', 'Ilość', 'Jm', 'Cena netto', 'VAT', 'Wartość netto', 'Wartość brutto']
            .map((h) => `<th style="border:1px solid #999; padding:4px 6px; background:#f0f0f0; text-align:left">${h}</th>`).join('')}
        </tr></thead>
        <tbody>
          ${lines.map((l, i) => `<tr>
            <td style="border:1px solid #999; padding:4px 6px">${i + 1}</td>
            <td style="border:1px solid #999; padding:4px 6px">${esc(l.name)}</td>
            <td style="border:1px solid #999; padding:4px 6px">${esc(l.quantity)}</td>
            <td style="border:1px solid #999; padding:4px 6px">${esc(l.unit)}</td>
            <td style="border:1px solid #999; padding:4px 6px; text-align:right">${esc(Number(l.unitNetPrice).toFixed(2))}</td>
            <td style="border:1px solid #999; padding:4px 6px">${esc(l.vatRate)}%</td>
            <td style="border:1px solid #999; padding:4px 6px; text-align:right">${lineNet(l).toFixed(2)}</td>
            <td style="border:1px solid #999; padding:4px 6px; text-align:right">${(lineNet(l) + lineVat(l)).toFixed(2)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      <table style="border-collapse:collapse; margin-left:auto; margin-bottom:16px">
        <thead><tr>${['Stawka', 'Netto', 'VAT', 'Brutto'].map((h) => `<th style="border:1px solid #999; padding:3px 8px; background:#f0f0f0">${h}</th>`).join('')}</tr></thead>
        <tbody>
          ${Object.entries(vatGroups).map(([rate, g]) => `<tr>
            <td style="border:1px solid #999; padding:3px 8px">${esc(rate)}%</td>
            <td style="border:1px solid #999; padding:3px 8px; text-align:right">${g.net.toFixed(2)}</td>
            <td style="border:1px solid #999; padding:3px 8px; text-align:right">${g.vat.toFixed(2)}</td>
            <td style="border:1px solid #999; padding:3px 8px; text-align:right">${(g.net + g.vat).toFixed(2)}</td>
          </tr>`).join('')}
          <tr><td style="border:1px solid #999; padding:3px 8px"><b>Razem</b></td>
            <td style="border:1px solid #999; padding:3px 8px; text-align:right"><b>${(inv.net).toFixed(2)}</b></td>
            <td style="border:1px solid #999; padding:3px 8px; text-align:right"><b>${(inv.vat).toFixed(2)}</b></td>
            <td style="border:1px solid #999; padding:3px 8px; text-align:right"><b>${(inv.gross).toFixed(2)}</b></td></tr>
        </tbody>
      </table>
      <div style="font-size:14px; margin-bottom:6px"><b>Do zapłaty: ${zl(inv.gross, inv.currency)}</b></div>
      ${inv.paymentTo ? `<div>Termin płatności: ${esc(inv.paymentTo)}</div>` : ''}
      ${company?.bankAccount ? `<div>Nr konta: ${esc(company.bankAccount)}</div>` : ''}
    </div>`;
  document.body.appendChild(root);
  window.print();
  setTimeout(() => root.remove(), 500);
}

// ---- keyboard ----

export function pageOnKey(e, el, deps) {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  const overlay = document.querySelector('.ksefad-overlay');
  if (overlay) {
    if (e.key === 'Escape') {
      overlay.remove();
      return true;
    }
    return false;
  }
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false;
  if (!deps.store.companies().length) return false;
  const invoices = deps.store.listInvoices({
    companyId: view.companyId || undefined,
    dir: view.dir || undefined,
    unpaid: view.unpaid || undefined,
    query: view.query || undefined,
    limit: 300,
  });
  switch (e.key) {
    case 'h': switchTab(el, deps, 'sale'); return true;
    case 'l': switchTab(el, deps, 'cost'); return true;
    case 'Tab':
      e.preventDefault();
      switchTab(el, deps, view.dir === 'sale' ? 'cost' : 'sale');
      return true;
    case 'j': view.selected = Math.min(view.selected + 1, invoices.length - 1); renderPage(el, deps); return true;
    case 'k': view.selected = Math.max(view.selected - 1, 0); renderPage(el, deps); return true;
    case 'Enter':
      if (invoices[view.selected]) openDetail(el, deps, invoices[view.selected].id);
      return true;
    case 'n': openCreateForm(el, deps); return true;
    case 'r':
      if (!view.busy) runSync(el, deps);
      return true;
    case '/': el.querySelector('#ksefadQuery')?.focus(); e.preventDefault(); return true;
    default: return false;
  }
}

// ---- widgets ----

export function renderTodayWidget(el, deps) {
  injectStyle();
  const stamp = today();
  const items = deps.store.listInvoices()
    .filter((i) => i.src === 'ksef' && i.seen === stamp)
    .slice(0, 8);
  el.innerHTML = items.length
    ? `<div class="ksefad-widget">${items.map((i) => `
        <div class="ksefad-widget-row">
          <span title="${esc(i.number)}">${i.dir === 'cost' ? '📥' : '📤'} ${esc((i.dir === 'sale' ? i.buyerName : i.sellerName) || i.number)}</span>
          <span>${zl(i.gross, i.currency)}</span>
        </div>`).join('')}</div>`
    : '<div class="widget-empty">Nothing new from KSeF today</div>';
  el.onclick = () => deps.cl.openModule('invoices');
}

export function renderUnpaidWidget(el, deps) {
  injectStyle();
  const items = deps.store.listInvoices({ dir: 'sale', unpaid: true }).slice(0, 8);
  const remaining = (i) => Math.max(0, i.gross - (Number(i.paidAmount) || 0));
  const sum = items.reduce((s, i) => s + (i.currency === 'PLN' ? remaining(i) : 0), 0);
  el.innerHTML = items.length
    ? `<div class="ksefad-widget">
        ${items.map((i) => `
          <div class="ksefad-widget-row">
            <span title="${esc(i.number)}">${Number(i.paidAmount) > 0 ? '◐ ' : ''}${esc(i.buyerName || i.number)}</span>
            <span>${zl(remaining(i), i.currency)}</span>
          </div>`).join('')}
        <div class="ksefad-widget-row" style="border-top:1px solid rgba(128,128,128,.3); padding-top:3px">
          <span>total</span><b>${zl(sum)}</b>
        </div>
      </div>`
    : '<div class="widget-empty">No unpaid sales invoices 🎉</div>';
  el.onclick = () => deps.cl.openModule('invoices');
}

// ---- settings ----

function companyFormHtml(c = {}) {
  const fk = c.fakturownia || {};
  return `
    <div class="adk-form">
      <label class="adk-field"><span>Nazwa firmy</span><input data-f="name" value="${esc(c.name || '')}"></label>
      <label class="adk-field"><span>NIP</span><input data-f="nip" value="${esc(c.nip || '')}"></label>
      <label class="adk-field"><span>Adres — linia 1</span><input data-f="address1" value="${esc(c.address1 || '')}" placeholder="ulica i numer"></label>
      <label class="adk-field"><span>Adres — linia 2</span><input data-f="address2" value="${esc(c.address2 || '')}" placeholder="kod i miejscowość"></label>
      <label class="adk-field"><span>Rachunek bankowy</span><input data-f="bankAccount" value="${esc(c.bankAccount || '')}"></label>
      <label class="adk-field"><span>Wzorzec numeracji <small>(tylko gdy tryb Fakturownia: wyłączony)</small></span>
        <input data-f="numberingPattern" value="${esc(c.numberingPattern || '{nr}/{mm}/{yyyy}')}" title="{nr} kolejny numer, {mm} miesiąc, {yyyy} rok — w trybie dual numeruje Fakturownia wg własnego wzorca"></label>
      <label class="adk-field"><span>Środowisko KSeF</span><select data-f="env">
        ${['prod', 'demo', 'test'].map((e) => `<option ${e === (c.env || 'prod') ? 'selected' : ''}>${e}</option>`).join('')}
      </select></label>
      <label class="adk-field"><span>Token KSeF</span><input data-f="ksefToken" type="password" value="${esc(c.ksefToken || '')}"></label>
      <label class="adk-field"><span>Fakturownia — subdomena</span><input data-f="fk_subdomain" value="${esc(fk.subdomain || '')}" placeholder="mojafirma (.fakturownia.pl)"></label>
      <label class="adk-field"><span>Fakturownia — token API</span><input data-f="fk_token" type="password" value="${esc(fk.token || '')}"></label>
      <label class="adk-field"><span>Tryb Fakturownia</span><select data-f="fk_mode"
        title="Dual: faktury tworzone tutaj powstają też w Fakturowni (jej numeracja), wysyłka do KSeF idzie przez Fakturownię, płatności synchronizują się w obie strony. Wyłączony: aplikacja rozmawia z KSeF bezpośrednio.">
        <option value="dual" ${(fk.mode || 'dual') !== 'off' ? 'selected' : ''}>Dual — synchronizacja dwustronna</option>
        <option value="off" ${fk.mode === 'off' ? 'selected' : ''}>Wyłączony — tylko KSeF</option>
      </select></label>
    </div>`;
}

function fvInfoHtml(info) {
  if (!info) {
    return '<span class="adk-muted">Parametry konta nie zostały jeszcze pobrane — kliknij „Odśwież" albo uruchom import.</span>';
  }
  const s = info.seller || {};
  const patterns = Object.entries(info.patterns || {}).filter(([, v]) => v);
  return `
    <div class="adk-kv">
      <div><b>Konto:</b> ${esc(info.account?.prefix || '?')}.fakturownia.pl · plan ${esc(info.account?.plan || '—')} · ${esc(String(info.account?.invoices ?? '—'))} dokumentów</div>
      ${s.name ? `<div><b>Sprzedawca:</b> ${esc(s.name)} · NIP ${esc(s.nip || '—')}</div>
      <div class="adk-muted">${esc(s.street || '')}${s.street ? ', ' : ''}${esc(s.postCode || '')} ${esc(s.city || '')}${s.email ? ` · ${esc(s.email)}` : ''}</div>
      ${s.bankAccount ? `<div class="adk-muted">Bank: ${esc(s.bank || '')} ${esc(s.bankAccount)}</div>` : ''}` : ''}
      ${patterns.length ? `<div><b>Wzorce numeracji:</b> ${patterns.map(([k, v]) => `${esc(k)}: <code>${esc(v)}</code>`).join(' · ')}</div>` : ''}
      <div class="adk-muted" style="font-size:.9em">Pobrano ${esc(String(info.fetchedAt || '').replace('T', ' ').slice(0, 19))}</div>
    </div>`;
}

export function renderSettings(el, deps) {
  injectStyle();
  const { store } = deps;
  const companies = store.companies();
  el.innerHTML = `
    <h2 class="settings-section-title">🧾 KSeF — polskie e-fakturowanie</h2>
    <p class="settings-section-desc">Firmy — każda z własnym NIP i tokenem KSeF. Pola Fakturowni
    włączają import historii oraz tryb dual (dwustronna synchronizacja).</p>
    <div id="ksefadCompanies">
      ${companies.map((c) => `
        <details class="adk-card" data-id="${esc(c.id)}" ${companies.length === 1 ? 'open' : ''}>
          <summary><b>${esc(c.name)}</b> <span class="adk-muted">· NIP ${esc(c.nip || '—')}
            ${store.syncState(c.id).fakturowniaImportedAt ? ' · zaimportowano ✓' : ''}</span></summary>
          ${companyFormHtml(c)}
          <div class="adk-actions">
            <button class="adk-btn primary ksefadSaveCompany">Zapisz</button>
            <button class="adk-btn ksefadImport">Import z Fakturowni</button>
            <button class="adk-btn ksefadTestKsef">Test połączenia z KSeF</button>
            <span style="flex:1"></span>
            <button class="adk-btn danger ksefadDelete">Usuń</button>
          </div>
          <div class="ksefad-status adk-status"></div>
          ${(c.fakturownia?.subdomain && c.fakturownia?.token) ? `
            <div class="adk-subcard">
              <div class="adk-subcard-head">
                <b>Parametry Fakturowni</b>
                <span class="adk-muted">tylko do odczytu — edycja w Fakturowni</span>
                <span style="flex:1"></span>
                <button class="adk-btn ksefadFvRefresh">Odśwież</button>
              </div>
              <div class="ksefad-fvinfo">${fvInfoHtml(store.fvInfo(c.id))}</div>
            </div>` : ''}
        </details>`).join('')}
    </div>
    <button class="adk-btn" id="ksefadAddCompany">+ Dodaj firmę</button>
    <div id="ksefadNewCompany"></div>`;

  const readForm = (container, id) => {
    const get = (f) => container.querySelector(`[data-f="${f}"]`)?.value?.trim() || '';
    return {
      id,
      name: get('name'),
      nip: get('nip'),
      address1: get('address1'),
      address2: get('address2'),
      bankAccount: get('bankAccount'),
      numberingPattern: get('numberingPattern'),
      env: get('env') || 'prod',
      ksefToken: get('ksefToken'),
      fakturownia: { subdomain: get('fk_subdomain'), token: get('fk_token'), mode: get('fk_mode') || 'dual' },
    };
  };

  el.querySelectorAll('details[data-id]').forEach((box) => {
    const id = box.dataset.id;
    const status = box.querySelector('.ksefad-status');
    box.querySelector('.ksefadSaveCompany').onclick = async () => {
      await store.saveCompany(readForm(box, id));
      clearTokenCache(id);
      status.textContent = 'Zapisano.';
    };
    box.querySelector('.ksefadDelete').onclick = async () => {
      if (!confirm('Usunąć konfigurację tej firmy? (dane faktur zostają w storage)')) return;
      await store.deleteCompany(id);
      renderSettings(el, deps);
    };
    box.querySelector('.ksefadImport').onclick = async (e) => {
      e.target.disabled = true;
      const company = readForm(box, id);
      await store.saveCompany(company);
      try {
        const res = await importFromFakturownia(deps, company,
          ({ page, total }) => { status.textContent = `Import… strona ${page}, ${total} faktur`; });
        status.textContent = `Import zakończony: pobrano ${res.total}, nowych ${res.added}, zaktualizowanych ${res.updated}.`;
      } catch (err) {
        deps.cl.log('fakturownia import failed:', err);
        status.textContent = `Import nieudany: ${err.message || err}`;
      }
      e.target.disabled = false;
    };
    box.querySelector('.ksefadFvRefresh')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        const info = await fetchFakturowniaInfo(deps, readForm(box, id));
        box.querySelector('.ksefad-fvinfo').innerHTML = fvInfoHtml(info);
      } catch (err) {
        deps.cl.log('fakturownia info fetch failed:', err);
        status.textContent = `Nie udało się pobrać parametrów: ${err.message || err}`;
      }
      e.target.disabled = false;
    });
    box.querySelector('.ksefadTestKsef').onclick = async (e) => {
      e.target.disabled = true;
      const company = readForm(box, id);
      await store.saveCompany(company);
      clearTokenCache(id);
      status.textContent = 'Uwierzytelnianie w KSeF…';
      try {
        await syncCompany(deps, company);
        status.textContent = `KSeF OK — synchronizacja zakończona (łącznie ${store.listInvoices({ companyId: id }).length} faktur).`;
      } catch (err) {
        deps.cl.log('ksef test failed:', err);
        status.textContent = `Błąd KSeF: ${err.message || err}`;
      }
      e.target.disabled = false;
    };
  });

  el.querySelector('#ksefadAddCompany').onclick = () => {
    const holder = el.querySelector('#ksefadNewCompany');
    holder.innerHTML = `<div class="adk-card" style="margin-top:12px">${companyFormHtml()}
      <div class="adk-actions"><button class="adk-btn primary" id="ksefadCreateCompany">Utwórz</button></div></div>`;
    holder.querySelector('#ksefadCreateCompany').onclick = async () => {
      const company = readForm(holder, `c${Date.now()}`);
      if (!company.name) return;
      await store.saveCompany(company);
      renderSettings(el, deps);
    };
  };
}
