// UI of the Wyciągi (bank statements) module: pick a month, drop the PDF
// statements, review the automatic invoice matching, assign the leftovers
// by hand (or a category for non-invoice entries) and print the monthly
// report for the accountant.

import { parseStatement, matchTransactions, categorize } from './bank.js';
import { setPaid } from './service.js';
import {
  injectStyle, currentMonth, monthAdd, monthLabel, periodBarHtml, bindPeriodBar, periodOf, printDocHtml, invDesc,
  activeCompany,
} from './page.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = (n, cur = 'PLN') => `${(Number(n) || 0).toFixed(2)} ${cur}`;

const CATEGORIES = ['opłata bankowa', 'podatek / ZUS', 'przewalutowanie', 'wynagrodzenie', 'odsetki', 'karta / prywatne', 'inne'];

const bankView = {
  query: '',
  mode: 'month',
  month: currentMonth(),
  from: '',
  to: '',
  busy: '',
  error: '',
  info: '',
  show: { ok: true, warn: true, bad: true, in: true },
};

// Incoming operations (uznania) are their own visual bucket; the
// settlement column still shows whether they were paired with a sale
function txState(tx) {
  if (tx.amount > 0) return 'in';
  if (tx.invoiceId) return 'ok';
  return (tx.category || categorize(tx)) ? 'warn' : 'bad';
}

// Transactions live in buckets keyed by their OWN operation month — the
// picker only selects what is shown, never where an upload lands
function txsForView(store, company) {
  const period = periodOf(bankView);
  const months = store.bankMonths(company.id)
    .filter((m) => (!period.from || m >= period.from.slice(0, 7)) && (!period.to || m <= period.to.slice(0, 7)));
  return months
    .flatMap((m) => store.bankMonth(company.id, m))
    .filter((t) => (!period.from || t.date >= period.from) && (!period.to || t.date <= period.to))
    .sort((a, b) => a.account.localeCompare(b.account)
      || (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER)
      || a.date.localeCompare(b.date));
}

async function patchTx(store, company, tx, patch) {
  const month = tx.date.slice(0, 7);
  const list = store.bankMonth(company.id, month);
  await store.saveBankMonth(company.id, month, list.map((t) => (t.id === tx.id ? { ...t, ...patch } : t)));
}

function fmtAccount(acc) {
  return String(acc || '').replace(/(\d{2})(?=(\d{4})+$)/, '$1 ').replace(/(\d{4})(?=\d)/g, '$1 ');
}

function invoiceLabel(store, id) {
  const inv = id ? store.getInvoice(id) : null;
  if (!inv) return '';
  return `${inv.number || inv.ksefNumber} · ${money(inv.gross, inv.currency)} · ${inv.dir === 'cost' ? inv.sellerName : inv.buyerName}`;
}

export function bankOnKey(e, el, deps) {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (document.querySelector('.ksefad-overlay')) return false;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false;
  if (e.key === '/') {
    el.querySelector('#bankQuery')?.focus();
    e.preventDefault();
    return true;
  }
  if ((e.key === '[' || e.key === ']') && bankView.mode === 'month') {
    bankView.month = monthAdd(bankView.month, e.key === '[' ? -1 : 1);
    renderBankPage(el, deps);
    return true;
  }
  return false;
}

export function renderBankPage(el, deps) {
  injectStyle();
  const { store } = deps;
  const companies = store.companies();
  if (!companies.length) {
    el.innerHTML = '<div class="ksefad"><h2>🏦 Wyciągi bankowe</h2><p>Najpierw dodaj firmę w Ustawieniach → Addons → KSeF.</p></div>';
    return;
  }
  const company = activeCompany(store);
  const txs = company ? txsForView(store, company) : [];
  // Free-text search sweeps every column the table shows: dates, type,
  // description, amounts, account, category and the paired invoice
  const q = bankView.query.trim().toLowerCase();
  const matchesQuery = (t) => !q || [
    t.date, t.valueDate, t.type, t.desc, t.account, t.currency,
    String(t.amount), t.amount.toFixed(2), t.amount.toFixed(2).replace('.', ','),
    t.category || categorize(t), t.matchedBy,
    t.invoiceId ? invoiceLabel(store, t.invoiceId) : '',
  ].some((v) => String(v || '').toLowerCase().includes(q));
  const shown = txs.filter((t) => bankView.show[txState(t)] && matchesQuery(t));
  const byAccount = new Map();
  for (const tx of shown) {
    const key = `${tx.account}|${tx.currency}`;
    if (!byAccount.has(key)) byAccount.set(key, []);
    byAccount.get(key).push(tx);
  }
  const counts = { ok: 0, warn: 0, bad: 0, in: 0 };
  for (const t of txs) counts[txState(t)]++;
  const { ok: matched, warn: categorized, bad: open, in: incoming } = counts;
  const months = company ? store.bankMonths(company.id) : [];

  el.innerHTML = `
    <div class="ksefad">
      <div class="ksefad-bar">
        <h2 style="margin:0; font-size:17px">🏦 Wyciągi bankowe</h2>
        ${periodBarHtml(bankView)}
        <input id="bankQuery" placeholder="szukaj… (/)" value="${esc(bankView.query)}" style="flex:1; min-width:110px">
        <input type="file" id="bankFiles" multiple accept=".pdf" style="display:none">
        <button class="ksefad-btn primary" id="bankUpload" ${bankView.busy ? 'disabled' : ''}>${bankView.busy === 'parse' ? 'Analizuję…' : '+ Wgraj wyciągi (PDF)'}</button>
        <span style="flex:1"></span>
        ${txs.length ? `
          <button class="ksefad-btn" id="bankRematch">Dopasuj ponownie</button>
          <button class="ksefad-btn" id="bankMarkPaid">Oznacz dopasowane jako zapłacone</button>
          <button class="ksefad-btn primary" id="bankReport">Raport dla księgowej</button>` : ''}
      </div>
      ${bankView.error ? `<div class="ksefad-error">${esc(bankView.error)}</div>` : ''}
      ${bankView.info ? `<div class="ksefad-muted">${esc(bankView.info)}</div>` : ''}
      ${txs.length ? `
        <div class="ksefad-bar ksefad-muted" style="gap:16px">
          <span>${txs.length} operacji, pokazuję ${shown.length}:</span>
          <label style="color:var(--success, #a6e3a1)"><input type="checkbox" data-show="ok" ${bankView.show.ok ? 'checked' : ''}> przypisane (${matched})</label>
          <label style="color:var(--warning, #f9e2af)"><input type="checkbox" data-show="warn" ${bankView.show.warn ? 'checked' : ''}> opłaty / kategorie (${categorized})</label>
          <label style="color:var(--error, #f38ba8)"><input type="checkbox" data-show="bad" ${bankView.show.bad ? 'checked' : ''}> nieprzypisane (${open})</label>
          <label style="color:#94e2d5"><input type="checkbox" data-show="in" ${bankView.show.in ? 'checked' : ''}> uznania (${incoming})</label>
        </div>` : ''}
      <div class="ksefad-scroll">
        ${[...byAccount.entries()].map(([key, list]) => {
          const [account, currency] = key.split('|');
          return `
          <h3 style="margin:14px 0 6px">${esc(list[0].bank || 'Bank')} · ${esc(fmtAccount(account))} <span class="ksefad-muted">(${esc(currency)})</span></h3>
          <table class="ksefad-table">
            <thead><tr><th>Data</th><th>Typ</th><th>Opis</th><th style="text-align:right">Kwota</th><th>Faktura / kategoria</th></tr></thead>
            <tbody>
              ${list.map((tx) => `
                <tr data-tx="${esc(tx.id)}" class="ksefad-row-${txState(tx)}">
                  <td style="white-space:nowrap">${esc(tx.date)}</td>
                  <td>${esc(tx.type)}</td>
                  <td title="${esc(tx.desc)}">${esc(tx.desc.length > 80 ? `${tx.desc.slice(0, 80)}…` : tx.desc)}</td>
                  <td style="text-align:right; white-space:nowrap; color:${tx.amount < 0 ? 'var(--error, #f38ba8)' : 'var(--success, #a6e3a1)'}">${money(tx.amount, currency)}</td>
                  <td>
                    ${tx.invoiceId
                      ? `<span class="ksefad-ok">✓</span> ${esc(invoiceLabel(store, tx.invoiceId))}
                         <span class="ksefad-muted">(${esc(tx.matchedBy || 'ręcznie')})</span>
                         <button class="ksefad-btn" data-unassign="${esc(tx.id)}" title="Odepnij">×</button>`
                      : `<button class="ksefad-btn" data-assign="${esc(tx.id)}">Przypisz fakturę</button>
                         <select data-category="${esc(tx.id)}">
                           <option value="">— kategoria —</option>
                           ${CATEGORIES.map((c) => `<option ${tx.category === c ? 'selected' : ''}>${c}</option>`).join('')}
                         </select>`}
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>`;
        }).join('')
        || `<p class="ksefad-muted" style="padding:14px">${txs.length
          ? 'Wszystkie operacje odfiltrowane — zaznacz któryś z checkboxów powyżej.'
          : `Brak operacji w tym okresie. Wgraj pliki PDF z wyciągami (iPKO Biznes) — trafią do miesięcy wynikających z dat operacji${months.length ? `; zapisane miesiące: ${months.join(', ')}` : ''}.`}</p>`}
      </div>
      <div class="ksefad-muted">[/]: miesiąc · klik w wiersz: szczegóły operacji</div>
    </div>`;

  const rerender = () => renderBankPage(el, deps);
  bindPeriodBar(el, bankView, rerender);
  el.querySelectorAll('[data-show]').forEach((cb) => {
    cb.onchange = () => { bankView.show[cb.dataset.show] = cb.checked; rerender(); };
  });
  const query = el.querySelector('#bankQuery');
  // Re-rendering replaces the input the user is typing into, so focus and
  // caret have to be put back or only the first keystroke ever lands
  query.oninput = (e) => {
    bankView.query = e.target.value;
    const caret = e.target.selectionStart;
    rerender();
    const next = el.querySelector('#bankQuery');
    next.focus();
    next.setSelectionRange(caret, caret);
  };
  el.querySelector('#bankUpload').onclick = () => el.querySelector('#bankFiles').click();
  el.querySelector('#bankFiles').onchange = (e) => ingestFiles(el, deps, company, e.target.files);
  el.querySelector('#bankRematch')?.addEventListener('click', async () => {
    const invoices = store.listInvoices({ companyId: company.id });
    const cleared = matchTransactions(
      txs.map((t) => (t.auto ? { ...t, invoiceId: '', matchedBy: '', category: '' } : t)),
      invoices,
    );
    for (const t of cleared) await patchTx(store, company, t, t);
    rerender();
  });
  el.querySelector('#bankMarkPaid')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    let n = 0;
    for (const tx of txs) {
      if (!tx.invoiceId) continue;
      const inv = store.getInvoice(tx.invoiceId);
      if (inv && !inv.paid && inv.dir === 'cost') {
        try {
          await setPaid(deps, company, inv.id, true, tx.date);
          n++;
        } catch (err) {
          deps.cl.log('bank mark paid failed:', err);
          bankView.error = `${inv.number}: ${err.message || err}`;
        }
      }
    }
    bankView.info = `Oznaczono ${n} faktur kosztowych jako zapłacone.`;
    rerender();
  });
  el.querySelector('#bankReport')?.addEventListener('click', () => printReport(deps, company,
    bankView.mode === 'month' ? monthLabel(bankView.month) : `${bankView.from} — ${bankView.to}`, txs));
  el.querySelectorAll('[data-tx]').forEach((row) => {
    row.onclick = (e) => {
      if (e.target.closest('button, select')) return;
      openTxDetail(el, deps, company, txs.find((t) => t.id === row.dataset.tx));
    };
  });
  el.querySelectorAll('[data-assign]').forEach((btn) => {
    btn.onclick = () => openAssignModal(el, deps, company, txs.find((t) => t.id === btn.dataset.assign));
  });
  el.querySelectorAll('[data-unassign]').forEach((btn) => {
    btn.onclick = async () => {
      const tx = txs.find((t) => t.id === btn.dataset.unassign);
      if (tx) await patchTx(store, company, tx, { invoiceId: '', matchedBy: '', auto: false });
      rerender();
    };
  });
  el.querySelectorAll('[data-category]').forEach((sel) => {
    sel.onchange = async () => {
      const tx = txs.find((t) => t.id === sel.dataset.category);
      if (tx) await patchTx(store, company, tx, { category: sel.value, auto: false });
      rerender();
    };
  });
}

async function ingestFiles(el, deps, company, files) {
  const { store, cl } = deps;
  if (!company) {
    bankView.error = 'Wybierz firmę.';
    renderBankPage(el, deps);
    return;
  }
  bankView.busy = 'parse';
  bankView.error = '';
  bankView.info = '';
  renderBankPage(el, deps);
  try {
    const accountsSeen = new Set();
    let parsed = [];
    for (const file of files) {
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      }
      const st = parseStatement(await cl.pdfText(btoa(bin)));
      accountsSeen.add(st.account);
      parsed.push(...st.txs.map((t) => ({
        ...t, account: st.account, currency: st.currency, bank: st.bank, stmtPeriod: st.period, stmtNo: st.stmtNo,
      })));
    }
    const invoices = store.listInvoices({ companyId: company.id });
    // Every operation lands in the bucket of its own month; re-uploading a
    // statement replaces that account's rows in the affected months but
    // keeps other accounts and every manual assignment made before
    const byMonth = new Map();
    for (const t of parsed) {
      const m = t.date.slice(0, 7);
      if (!byMonth.has(m)) byMonth.set(m, []);
      byMonth.get(m).push(t);
    }
    for (const [month, list] of byMonth) {
      const existing = store.bankMonth(company.id, month);
      const keepManual = new Map(existing.filter((t) => t.invoiceId || t.category).map((t) => [t.id, t]));
      const kept = existing.filter((t) => !accountsSeen.has(t.account));
      const merged = list.map((t) => {
        const old = keepManual.get(t.id);
        return old ? { ...t, invoiceId: old.invoiceId, matchedBy: old.matchedBy, category: old.category, auto: old.auto } : t;
      });
      await store.saveBankMonth(company.id, month,
        [...kept, ...matchTransactions(merged, invoices)]
          .sort((a, b) => a.account.localeCompare(b.account)
            || (a.seq ?? 0) - (b.seq ?? 0)
            || a.date.localeCompare(b.date)));
    }
    // Jump the view to where the data actually went
    const monthsTouched = [...byMonth.keys()].sort();
    if (monthsTouched.length) {
      bankView.mode = 'month';
      bankView.month = monthsTouched[0];
    }
    bankView.info = `Wczytano ${files.length} plik(i): ${parsed.length} operacji z ${accountsSeen.size} kont → ${monthsTouched.map(monthLabel).join(', ') || 'brak operacji'}.`;
  } catch (err) {
    deps.cl.log('bank ingest failed:', err);
    bankView.error = String(err.message || err);
  }
  bankView.busy = '';
  renderBankPage(el, deps);
}

function openAssignModal(el, deps, company, tx) {
  if (!tx) return;
  const { store } = deps;
  const dir = tx.amount < 0 ? 'cost' : 'sale';
  const overlay = document.createElement('div');
  overlay.className = 'ksefad-overlay modal-overlay';
  const candidates = () => {
    const q = overlay.querySelector('#bankAssignQuery').value.toLowerCase();
    return store.listInvoices({ companyId: company.id, dir, query: q || undefined })
      .sort((a, b) => Math.abs(a.gross - Math.abs(tx.amount)) - Math.abs(b.gross - Math.abs(tx.amount)))
      .slice(0, 25);
  };
  overlay.innerHTML = `
    <div class="ksefad-modal lg" style="width:min(760px, 92vw)">
      <h2 style="margin-bottom:8px">Przypisz fakturę</h2>
      <div class="ksefad-muted" style="margin-bottom:12px">${esc(tx.date)} · ${money(tx.amount, tx.currency)} · ${esc(tx.desc.slice(0, 110))}</div>
      <input id="bankAssignQuery" placeholder="szukaj po numerze / kontrahencie…" style="width:100%; margin-bottom:10px">
      <div id="bankAssignList" class="ksefad-scroll" style="max-height:46vh"></div>
      <div class="adk-actions"><span style="flex:1"></span><button class="adk-btn" id="bankAssignCancel">Anuluj</button></div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  overlay.querySelector('#bankAssignCancel').onclick = close;
  const renderList = () => {
    overlay.querySelector('#bankAssignList').innerHTML = `
      <table class="ksefad-table"><tbody>
        ${candidates().map((inv) => `
          <tr data-pick="${esc(inv.id)}">
            <td>${esc(inv.number || inv.ksefNumber || '—')}</td>
            <td>${esc(inv.issueDate)}</td>
            <td>${esc(dir === 'cost' ? inv.sellerName : inv.buyerName)}
              ${inv.lines?.length ? `<div class="ksefad-muted" style="font-size:.9em">${esc(invDesc(inv, 55))}</div>` : ''}</td>
            <td style="text-align:right">${money(inv.gross, inv.currency)}</td>
          </tr>`).join('') || '<tr><td class="ksefad-muted">Brak faktur.</td></tr>'}
      </tbody></table>`;
    overlay.querySelectorAll('[data-pick]').forEach((row) => {
      row.onclick = async () => {
        await patchTx(store, company, tx, { invoiceId: row.dataset.pick, matchedBy: '', category: '', auto: false });
        close();
        renderBankPage(el, deps);
      };
    });
  };
  overlay.querySelector('#bankAssignQuery').oninput = renderList;
  renderList();
  overlay.querySelector('#bankAssignQuery').focus();
}

// Full-detail popup for one statement operation, with the assignment
// actions available from the row inline controls too
function openTxDetail(el, deps, company, tx) {
  if (!tx) return;
  const { store } = deps;
  const inv = tx.invoiceId ? store.getInvoice(tx.invoiceId) : null;
  const overlay = document.createElement('div');
  overlay.className = 'ksefad-overlay modal-overlay';
  overlay.innerHTML = `
    <div class="ksefad-modal lg" style="width:min(720px, 92vw)">
      <div class="ksefad-doc-head">
        <h2>${esc(tx.type)}</h2>
        <div class="ksefad-doc-dates">
          <div><span>Data operacji</span><b>${esc(tx.date)}</b></div>
          <div><span>Kwota</span><b style="color:${tx.amount < 0 ? 'var(--error, #f38ba8)' : 'var(--success, #a6e3a1)'}">${money(tx.amount, tx.currency)}</b></div>
        </div>
      </div>
      <div class="adk-kv" style="margin-bottom:14px">
        <div><b>Rachunek:</b> ${esc(fmtAccount(tx.account))} (${esc(tx.currency)}) · ${esc(tx.bank || '')}</div>
        <div><b>Identyfikator operacji:</b> ${esc(tx.id)}</div>
        <div><b>Pełny opis:</b></div>
        <div style="white-space:pre-wrap; background:var(--bg-surface, #313244); border-radius:8px; padding:10px 12px">${esc(tx.desc)}</div>
        ${inv ? `
          <div style="margin-top:6px"><b>Przypisana faktura:</b> ${esc(inv.number || inv.ksefNumber)}
            <span class="adk-muted">(${esc(tx.matchedBy || 'ręcznie')})</span></div>
          <div class="adk-muted">${esc(inv.dir === 'cost' ? inv.sellerName : inv.buyerName)} · ${money(inv.gross, inv.currency)}
            · ${inv.paid ? 'opłacona' : 'nieopłacona'}${inv.ksefNumber ? ` · KSeF ${esc(inv.ksefNumber)}` : ''}</div>
          ${inv.lines?.length ? `<div class="adk-muted">${esc(invDesc(inv, 90))}</div>` : ''}`
        : `<div style="margin-top:6px"><b>Faktura:</b> <span class="ksefad-no">brak przypisania</span>
            ${tx.category ? `· kategoria: <b>${esc(tx.category)}</b>` : ''}</div>`}
      </div>
      <div class="adk-actions">
        ${inv ? `<button class="adk-btn" id="txUnassign">Odepnij fakturę</button>`
          : `<button class="adk-btn primary" id="txAssign">Przypisz fakturę</button>`}
        <span style="flex:1"></span>
        <button class="adk-btn" id="txClose">Zamknij (Esc)</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  overlay.querySelector('#txClose').onclick = close;
  overlay.querySelector('#txAssign')?.addEventListener('click', () => {
    close();
    openAssignModal(el, deps, company, tx);
  });
  overlay.querySelector('#txUnassign')?.addEventListener('click', async () => {
    await patchTx(store, company, tx, { invoiceId: '', matchedBy: '', auto: false });
    close();
    renderBankPage(el, deps);
  });
}

// The accountant report mirrors the source statement 1:1 — same order,
// same per-operation fields (both dates, operation id, amount, running
// balance) — so the original can be laid next to it. One template per
// bank; new banks add a parser in bank.js and a template here.
const plMoney = (n) => (Number(n) || 0).toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function txStatus(store, tx) {
  if (tx.invoiceId) {
    const inv = store.getInvoice(tx.invoiceId);
    return {
      color: '#e3f1e3',
      label: `<b>${esc(inv?.number || inv?.ksefNumber || tx.invoiceId)}</b>`
        + `${inv ? `<br>${esc(inv.dir === 'cost' ? inv.sellerName : inv.buyerName)}` : ''}`
        + `<br><span style="color:#555">${esc(tx.matchedBy || 'przypisano ręcznie')}</span>`,
    };
  }
  const category = tx.category || categorize(tx);
  if (category) return { color: '#fbf3d2', label: `${esc(category)}<br><span style="color:#555">bez faktury</span>` };
  return { color: '#f8dcdc', label: '<b>DO WYJAŚNIENIA</b>' };
}

function ipkoReportSection(store, company, account, currency, list) {
  const first = list[0] || {};
  const sumMa = list.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const sumWn = list.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0);
  const hasSaldo = list.every((t) => typeof t.saldo === 'number');
  const saldoStart = hasSaldo && list.length ? list[0].saldo - list[0].amount : null;
  const saldoEnd = hasSaldo && list.length ? list[list.length - 1].saldo : null;
  const cell = 'border:1px solid #bbb; padding:3px 6px; vertical-align:top;';
  return `
    <div style="border-top:2px solid #333; margin-top:20px; padding-top:8px">
      <table style="width:100%; margin-bottom:8px"><tr>
        <td style="vertical-align:top">
          <div style="font-size:14px"><b>WYCIĄG za okres ${esc(first.stmtPeriod || '')}</b> — raport rozliczenia</div>
          <div>Nr: ${esc(first.stmtNo || '—')} · ${esc(first.bank || '')}</div>
          <div>Nr rachunku: <b>${esc(fmtAccount(account))}</b> · Waluta: ${esc(currency)}</div>
        </td>
        <td style="vertical-align:top; text-align:right">
          <div>${esc(company.name)}</div>
          <div>Obroty MA: <b>${plMoney(sumMa)}</b> · Obroty WN: <b>${plMoney(sumWn)}</b></div>
          ${saldoStart !== null ? `<div>Saldo poprzednie: <b>${plMoney(saldoStart)}</b> · Saldo końcowe: <b>${plMoney(saldoEnd)}</b></div>` : ''}
        </td>
      </tr></table>
      <table style="width:100%; border-collapse:collapse; font-size:10.5px">
        <thead><tr>
          ${['Data operacji<br>Data waluty', 'Identyfikator operacji<br>Opis operacji', 'TYP OPERACJI', 'Kwota operacji', 'Saldo', 'Rozliczenie']
            .map((h) => `<th style="${cell} background:#e8e8e8; text-align:left">${h}</th>`).join('')}
        </tr></thead>
        <tbody>
          ${list.map((t) => {
            const st = txStatus(store, t);
            return `
            <tr style="background:${st.color}">
              <td style="${cell} border-bottom:none; white-space:nowrap">${esc(t.date)}</td>
              <td style="${cell} border-bottom:none">${esc(t.id)}</td>
              <td style="${cell} border-bottom:none">${esc(t.type)}</td>
              <td style="${cell} border-bottom:none; text-align:right; white-space:nowrap"><b>${plMoney(t.amount)}</b></td>
              <td style="${cell} border-bottom:none; text-align:right; white-space:nowrap">${typeof t.saldo === 'number' ? plMoney(t.saldo) : ''}</td>
              <td style="${cell}" rowspan="2">${st.label}</td>
            </tr>
            <tr style="background:${st.color}">
              <td style="${cell} border-top:none; white-space:nowrap">${esc(t.valueDate || '')}</td>
              <td style="${cell} border-top:none" colspan="4"><span style="color:#333">${esc(t.desc)}</span></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}

const REPORT_TEMPLATES = {
  'PKO BP (iPKO Biznes)': ipkoReportSection,
};

function printReport(deps, company, month, txs) {
  const { store } = deps;
  const byAccount = new Map();
  for (const tx of txs) {
    const key = `${tx.account}|${tx.currency}`;
    if (!byAccount.has(key)) byAccount.set(key, []);
    byAccount.get(key).push(tx);
  }
  const counts = {
    ok: txs.filter((t) => t.invoiceId).length,
    warn: txs.filter((t) => !t.invoiceId && (t.category || categorize(t))).length,
  };
  counts.bad = txs.length - counts.ok - counts.warn;
  const legend = (color, label) =>
    `<span style="display:inline-block; padding:1px 10px; background:${color}; border:1px solid #bbb; margin-right:8px">${label}</span>`;
  const body = `
    <div style="font-family: Arial, Helvetica, sans-serif; font-size:12px; padding:24px; max-width:980px; margin:0 auto">
      <h2 style="margin-bottom:2px">Rozliczenie wyciągów bankowych — ${esc(month)}</h2>
      <div style="color:#555; margin-bottom:6px">${esc(company.name)} · NIP ${esc(company.nip)} · wygenerowano ${new Date().toISOString().slice(0, 10)}</div>
      <div style="margin-bottom:4px">
        ${legend('#e3f1e3', `przypisane do faktury (${counts.ok})`)}
        ${legend('#fbf3d2', `bez faktury — opłaty/podatki (${counts.warn})`)}
        ${legend('#f8dcdc', `do wyjaśnienia (${counts.bad})`)}
      </div>
      ${[...byAccount.entries()].map(([key, list]) => {
        const [account, currency] = key.split('|');
        const template = REPORT_TEMPLATES[list[0]?.bank] || ipkoReportSection;
        return template(store, company, account, currency, list);
      }).join('')}
    </div>`;
  const title = `Rozliczenie wyciągów ${month} — ${company.name}`;
  deps.cl.openPreview(printDocHtml(title, body), title).catch((err) => {
    deps.cl.log('report preview failed:', err);
    bankView.error = `Nie udało się otworzyć raportu: ${err.message || err}`;
  });
}
