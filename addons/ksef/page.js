// UI: the Invoices module page (list, filters, create form, detail, print
// view styled after Fakturownia's classic template), the two widgets and the
// Settings section. All rendering is plain DOM into the container the host
// hands us.

import { importFromFakturownia } from './fakturownia.js';
import { syncCompany, createInvoice, sendToKsef, checkSendStatus, clearTokenCache, today } from './service.js';
import { lineNet, lineVat } from './fa3.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const zl = (n, cur = 'PLN') => `${(Number(n) || 0).toFixed(2)} ${cur}`;

const STYLE_ID = 'ksefad-style';

// Keyed by element id, not a module flag: a hot reload re-imports the module
// and would otherwise append a duplicate stylesheet each time
function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .ksefad { display:flex; flex-direction:column; gap:10px; height:100%; font-size: var(--fs-base, 13px); }
    .ksefad-bar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
    .ksefad-bar select, .ksefad-bar input, .ksefad select, .ksefad input, .ksefad textarea {
      background: var(--bg-input, #1e293b); color: inherit; border: 1px solid var(--border, #334155);
      border-radius: 6px; padding: 5px 8px; font: inherit; }
    .ksefad-btn { background: var(--bg-input, #1e293b); border: 1px solid var(--border, #334155);
      color: inherit; border-radius: 6px; padding: 5px 10px; cursor: pointer; font: inherit; }
    .ksefad-btn:hover { border-color: #3b82f6; color: #3b82f6; }
    .ksefad-btn.primary { border-color: #3b82f6; }
    .ksefad-table { width:100%; border-collapse: collapse; }
    .ksefad-table th { text-align:left; opacity:.6; font-weight:600; padding:4px 8px; border-bottom:1px solid var(--border,#334155); }
    .ksefad-table td { padding:5px 8px; border-bottom:1px solid rgba(128,128,128,.15); }
    .ksefad-table tr.sel td, .ksefad-table tbody tr:hover td { background: rgba(59,130,246,.08); cursor:pointer; }
    .ksefad-scroll { overflow:auto; flex:1; min-height:0; }
    .ksefad-badge { font-size:.85em; border:1px solid; border-radius:10px; padding:0 7px; white-space:nowrap; }
    .ksefad-badge.paid { color:#22c55e; border-color:#22c55e; }
    .ksefad-badge.unpaid { color:#eab308; border-color:#eab308; }
    .ksefad-badge.cost { color:#f87171; border-color:#f87171; }
    .ksefad-badge.sale { color:#60a5fa; border-color:#60a5fa; }
    .ksefad-overlay { position:fixed; inset:0; background:rgba(0,0,0,.55); z-index:900;
      display:flex; align-items:center; justify-content:center; }
    .ksefad-modal { background: var(--bg-panel, #0f172a); border:1px solid var(--border,#334155);
      border-radius:10px; padding:18px; width:min(720px, 92vw); max-height:88vh; overflow:auto; }
    .ksefad-grid { display:grid; grid-template-columns: 1fr 1fr; gap:8px; }
    .ksefad-lines td { padding:2px; }
    .ksefad-muted { opacity:.6; }
    .ksefad-error { color:#f87171; white-space:pre-wrap; }
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
  dir: '',
  unpaid: false,
  query: '',
  busy: '',
  error: '',
  selected: 0,
};

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
        <select id="ksefadCompany">
          <option value="">All companies</option>
          ${companies.map((c) => `<option value="${esc(c.id)}" ${c.id === view.companyId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select>
        <select id="ksefadDir">
          <option value="">Sales + costs</option>
          <option value="sale" ${view.dir === 'sale' ? 'selected' : ''}>Sales</option>
          <option value="cost" ${view.dir === 'cost' ? 'selected' : ''}>Costs</option>
        </select>
        <label><input type="checkbox" id="ksefadUnpaid" ${view.unpaid ? 'checked' : ''}> unpaid</label>
        <input id="ksefadQuery" placeholder="search… (/)" value="${esc(view.query)}" style="flex:1; min-width:120px">
        <button class="ksefad-btn" id="ksefadSync" ${view.busy ? 'disabled' : ''}>${view.busy === 'sync' ? 'Syncing…' : '⟳ Sync KSeF (r)'}</button>
        <button class="ksefad-btn primary" id="ksefadNew">+ New invoice (n)</button>
      </div>
      ${view.error ? `<div class="ksefad-error">${esc(view.error)}</div>` : ''}
      <div class="ksefad-scroll">
        <table class="ksefad-table">
          <thead><tr><th>Number</th><th>Date</th><th>Contractor</th><th>Gross</th><th></th><th>Status</th><th>KSeF</th></tr></thead>
          <tbody>
            ${invoices.map((inv, i) => `
              <tr data-id="${esc(inv.id)}" class="${i === view.selected ? 'sel' : ''}">
                <td>${esc(inv.number || '—')}</td>
                <td>${esc(inv.issueDate)}</td>
                <td>${esc(inv.dir === 'sale' ? inv.buyerName : inv.sellerName)}</td>
                <td style="text-align:right">${zl(inv.gross, inv.currency)}</td>
                <td><span class="ksefad-badge ${inv.dir}">${inv.dir}</span></td>
                <td>${inv.kind === 'proforma' ? '<span class="ksefad-muted">proforma</span>'
                  : `<span class="ksefad-badge ${inv.paid ? 'paid' : 'unpaid'}">${inv.paid ? 'paid' : 'unpaid'}</span>`}</td>
                <td class="ksefad-muted">${inv.ksefNumber ? '✓' : (inv.sendState === 'error' ? '⚠' : '—')}</td>
              </tr>`).join('')}
          </tbody>
        </table>
        ${invoices.length ? '' : '<p class="ksefad-muted" style="padding:12px">No invoices match. Run the Fakturownia import (Settings) or Sync KSeF.</p>'}
      </div>
      <div class="ksefad-muted">${invoices.length} shown · j/k select · Enter open · n new · r sync</div>
    </div>`;

  const rerender = () => renderPage(el, deps);
  el.querySelector('#ksefadCompany').onchange = (e) => { view.companyId = e.target.value; rerender(); };
  el.querySelector('#ksefadDir').onchange = (e) => { view.dir = e.target.value; rerender(); };
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
  overlay.innerHTML = `
    <div class="ksefad-modal">
      <h3 style="margin-bottom:8px">${esc(inv.kind === 'proforma' ? 'Proforma' : 'Invoice')} ${esc(inv.number || inv.ksefNumber)}</h3>
      <div class="ksefad-grid" style="margin-bottom:10px">
        <div><b>Seller</b><br>${esc(inv.sellerName)}<br><span class="ksefad-muted">NIP ${esc(inv.sellerNip)}</span></div>
        <div><b>Buyer</b><br>${esc(inv.buyerName)}<br><span class="ksefad-muted">${inv.buyerNip ? `NIP ${esc(inv.buyerNip)}` : ''}</span></div>
        <div>Issue date: <b>${esc(inv.issueDate)}</b></div>
        <div>Payment due: <b>${esc(inv.paymentTo || '—')}</b></div>
        <div>Net ${zl(inv.net, inv.currency)} · VAT ${zl(inv.vat, inv.currency)}</div>
        <div>Gross: <b>${zl(inv.gross, inv.currency)}</b></div>
        <div>Source: ${esc(inv.src)}</div>
        <div>KSeF: ${esc(inv.ksefNumber || inv.sendState || '—')}${inv.sendError ? `<div class="ksefad-error">${esc(inv.sendError)}</div>` : ''}</div>
      </div>
      ${(inv.lines || []).length ? `
        <table class="ksefad-table" style="margin-bottom:10px">
          <thead><tr><th>Item</th><th>Qty</th><th>Net price</th><th>VAT</th><th>Net</th></tr></thead>
          <tbody>${inv.lines.map((l) => `<tr><td>${esc(l.name)}</td><td>${esc(l.quantity)} ${esc(l.unit)}</td>
            <td>${zl(l.unitNetPrice, inv.currency)}</td><td>${esc(l.vatRate)}%</td><td>${zl(lineNet(l), inv.currency)}</td></tr>`).join('')}
          </tbody>
        </table>` : ''}
      <div class="ksefad-bar">
        ${inv.kind !== 'proforma' ? `<button class="ksefad-btn" id="ksefadPaid">${inv.paid ? 'Mark unpaid' : 'Mark paid'}</button>` : ''}
        ${inv.src === 'local' ? `<button class="ksefad-btn" id="ksefadPrint">Print / PDF</button>` : ''}
        ${inv.sendState === 'processing' || (inv.sendState === 'error' && inv.sessionRef)
          ? `<button class="ksefad-btn primary" id="ksefadCheck">Check KSeF status</button>` : ''}
        ${inv.src === 'local' && !inv.ksefNumber && inv.kind !== 'proforma'
          && inv.sendState !== 'processing' && inv.sendState !== 'sending' && !inv.sessionRef
          ? `<button class="ksefad-btn primary" id="ksefadSend">Send to KSeF</button>` : ''}
        <span style="flex:1"></span>
        <button class="ksefad-btn" id="ksefadClose">Close (Esc)</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  overlay.querySelector('#ksefadClose').onclick = close;
  overlay.querySelector('#ksefadPaid')?.addEventListener('click', async () => {
    await store.updateInvoice(inv.id, { paid: !inv.paid, paidDate: inv.paid ? '' : today() });
    close();
    renderPage(el, deps);
  });
  overlay.querySelector('#ksefadPrint')?.addEventListener('click', () => printInvoice(company, store.getInvoice(id)));
  overlay.querySelector('#ksefadCheck')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Checking…';
    try {
      const updated = await checkSendStatus(deps, company, inv.id);
      close();
      if (!updated.ksefNumber) {
        alert('KSeF has not assigned a number yet — the invoice is still being processed.');
      }
    } catch (err) {
      e.target.disabled = false;
      e.target.textContent = 'Check KSeF status';
      alert(`Status check failed: ${err.message || err}`);
    }
    renderPage(el, deps);
  });
  overlay.querySelector('#ksefadSend')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Sending…';
    try {
      await sendToKsef(deps, company, inv.id);
      close();
    } catch (err) {
      e.target.disabled = false;
      e.target.textContent = 'Send to KSeF';
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
    <td><input class="l-name" placeholder="Service / product" value="${esc(l.name || '')}" style="width:100%"></td>
    <td><input class="l-qty" type="number" step="any" value="${esc(l.quantity ?? 1)}" style="width:60px"></td>
    <td><input class="l-unit" value="${esc(l.unit || 'szt')}" style="width:55px"></td>
    <td><input class="l-price" type="number" step="any" value="${esc(l.unitNetPrice ?? '')}" placeholder="net" style="width:90px"></td>
    <td><select class="l-vat">${[23, 8, 5, 0].map((r) => `<option ${r === (l.vatRate ?? 23) ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
  </tr>`;
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
  overlay.innerHTML = `
    <div class="ksefad-modal">
      <h3 style="margin-bottom:10px">New invoice</h3>
      <div class="ksefad-grid" style="margin-bottom:8px">
        <label>Company<br><select id="ksefadFormCompany" style="width:100%">
          ${companies.map((c) => `<option value="${esc(c.id)}" ${c.id === companyId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select></label>
        <label>Kind<br><select id="ksefadFormKind" style="width:100%">
          <option value="vat">VAT invoice</option><option value="proforma">Proforma</option>
        </select></label>
        <label>Buyer<br><input id="ksefadFormBuyer" list="ksefadContractors" style="width:100%" placeholder="name">
          <datalist id="ksefadContractors">${contractors.map((c) => `<option value="${esc(c.name)}">`).join('')}</datalist></label>
        <label>Buyer NIP<br><input id="ksefadFormNip" style="width:100%"></label>
        <label>Issue date<br><input id="ksefadFormDate" type="date" value="${today()}" style="width:100%"></label>
        <label>Payment due<br><input id="ksefadFormDue" type="date" style="width:100%"></label>
      </div>
      <table class="ksefad-table ksefad-lines" style="margin-bottom:8px">
        <thead><tr><th>Item</th><th>Qty</th><th>Unit</th><th>Net price</th><th>VAT %</th></tr></thead>
        <tbody id="ksefadFormLines">${lineRowHtml()}</tbody>
      </table>
      <div class="ksefad-bar">
        <button class="ksefad-btn" id="ksefadAddLine">+ line</button>
        <span style="flex:1"></span>
        <span id="ksefadFormError" class="ksefad-error"></span>
        <button class="ksefad-btn" id="ksefadSave">Save draft</button>
        <button class="ksefad-btn primary" id="ksefadSaveSend">Save + send to KSeF</button>
        <button class="ksefad-btn" id="ksefadCancel">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  overlay.querySelector('#ksefadCancel').onclick = close;
  overlay.querySelector('#ksefadAddLine').onclick = () => {
    overlay.querySelector('#ksefadFormLines').insertAdjacentHTML('beforeend', lineRowHtml());
  };
  overlay.querySelector('#ksefadFormBuyer').addEventListener('change', (e) => {
    const c = store.contractors(overlay.querySelector('#ksefadFormCompany').value)
      .find((x) => x.name === e.target.value);
    if (c) overlay.querySelector('#ksefadFormNip').value = c.nip || '';
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
        ? `Invoice saved as a draft, but: ${err.message || err}`
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
  const sum = items.reduce((s, i) => s + (i.currency === 'PLN' ? i.gross : 0), 0);
  el.innerHTML = items.length
    ? `<div class="ksefad-widget">
        ${items.map((i) => `
          <div class="ksefad-widget-row">
            <span title="${esc(i.number)}">${esc(i.buyerName || i.number)}</span>
            <span>${zl(i.gross, i.currency)}</span>
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
    <div class="ksefad-grid">
      <label>Company name<br><input data-f="name" value="${esc(c.name || '')}" style="width:100%"></label>
      <label>NIP<br><input data-f="nip" value="${esc(c.nip || '')}" style="width:100%"></label>
      <label>Address line 1<br><input data-f="address1" value="${esc(c.address1 || '')}" style="width:100%"></label>
      <label>Address line 2<br><input data-f="address2" value="${esc(c.address2 || '')}" style="width:100%"></label>
      <label>Bank account<br><input data-f="bankAccount" value="${esc(c.bankAccount || '')}" style="width:100%"></label>
      <label>Numbering pattern<br><input data-f="numberingPattern" value="${esc(c.numberingPattern || '{nr}/{mm}/{yyyy}')}" style="width:100%" title="{nr} sequence, {mm} month, {yyyy} year"></label>
      <label>KSeF environment<br><select data-f="env" style="width:100%">
        ${['prod', 'demo', 'test'].map((e) => `<option ${e === (c.env || 'prod') ? 'selected' : ''}>${e}</option>`).join('')}
      </select></label>
      <label>KSeF token<br><input data-f="ksefToken" type="password" value="${esc(c.ksefToken || '')}" style="width:100%"></label>
      <label>Fakturownia subdomain<br><input data-f="fk_subdomain" value="${esc(fk.subdomain || '')}" style="width:100%" placeholder="mycompany (.fakturownia.pl)"></label>
      <label>Fakturownia API token<br><input data-f="fk_token" type="password" value="${esc(fk.token || '')}" style="width:100%"></label>
    </div>`;
}

export function renderSettings(el, deps) {
  injectStyle();
  const { store } = deps;
  const companies = store.companies();
  el.innerHTML = `
    <h2 class="settings-section-title">🧾 KSeF — Polish e-invoicing</h2>
    <p class="settings-section-desc">Companies (each with its own NIP + KSeF token).
    The Fakturownia fields enable the one-time history import.</p>
    <div id="ksefadCompanies">
      ${companies.map((c) => `
        <details class="ksefad" style="margin-bottom:10px" data-id="${esc(c.id)}">
          <summary style="cursor:pointer"><b>${esc(c.name)}</b> · NIP ${esc(c.nip || '—')}
            ${store.syncState(c.id).fakturowniaImportedAt ? ' · imported ✓' : ''}</summary>
          <div style="padding:8px 0">${companyFormHtml(c)}
            <div class="ksefad-bar" style="margin-top:8px">
              <button class="ksefad-btn ksefadSaveCompany">Save</button>
              <button class="ksefad-btn ksefadImport">Import from Fakturownia</button>
              <button class="ksefad-btn ksefadTestKsef">Test KSeF auth</button>
              <span style="flex:1"></span>
              <button class="ksefad-btn ksefadDelete">Delete</button>
            </div>
            <div class="ksefad-status ksefad-muted"></div>
          </div>
        </details>`).join('')}
    </div>
    <button class="ksefad-btn" id="ksefadAddCompany">+ Add company</button>
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
      fakturownia: { subdomain: get('fk_subdomain'), token: get('fk_token') },
    };
  };

  el.querySelectorAll('details[data-id]').forEach((box) => {
    const id = box.dataset.id;
    const status = box.querySelector('.ksefad-status');
    box.querySelector('.ksefadSaveCompany').onclick = async () => {
      await store.saveCompany(readForm(box, id));
      clearTokenCache(id);
      status.textContent = 'Saved.';
    };
    box.querySelector('.ksefadDelete').onclick = async () => {
      if (!confirm('Delete this company configuration? (invoice data stays in storage)')) return;
      await store.deleteCompany(id);
      renderSettings(el, deps);
    };
    box.querySelector('.ksefadImport').onclick = async (e) => {
      e.target.disabled = true;
      const company = readForm(box, id);
      await store.saveCompany(company);
      try {
        const res = await importFromFakturownia(deps, company,
          ({ page, total }) => { status.textContent = `Importing… page ${page}, ${total} invoices`; });
        status.textContent = `Import done: ${res.total} fetched, ${res.added} new, ${res.updated} updated.`;
      } catch (err) {
        deps.cl.log('fakturownia import failed:', err);
        status.textContent = `Import failed: ${err.message || err}`;
      }
      e.target.disabled = false;
    };
    box.querySelector('.ksefadTestKsef').onclick = async (e) => {
      e.target.disabled = true;
      const company = readForm(box, id);
      await store.saveCompany(company);
      clearTokenCache(id);
      status.textContent = 'Authenticating with KSeF…';
      try {
        await syncCompany(deps, company);
        status.textContent = `KSeF OK — sync completed (${store.listInvoices({ companyId: id }).length} invoices total).`;
      } catch (err) {
        deps.cl.log('ksef test failed:', err);
        status.textContent = `KSeF auth/sync failed: ${err.message || err}`;
      }
      e.target.disabled = false;
    };
  });

  el.querySelector('#ksefadAddCompany').onclick = () => {
    const holder = el.querySelector('#ksefadNewCompany');
    holder.innerHTML = `<div style="margin-top:10px">${companyFormHtml()}
      <button class="ksefad-btn" id="ksefadCreateCompany" style="margin-top:8px">Create</button></div>`;
    holder.querySelector('#ksefadCreateCompany').onclick = async () => {
      const company = readForm(holder, `c${Date.now()}`);
      if (!company.name) return;
      await store.saveCompany(company);
      renderSettings(el, deps);
    };
  };
}
