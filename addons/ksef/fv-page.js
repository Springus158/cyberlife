// Fakturownia page: account parameters, selective synchronization
// (invoices / expenses / clients / client bank accounts — or everything),
// a result grid with per-category counts and a live "our system vs
// Fakturownia" state comparison. Only meaningful in dual mode.

import {
  injectStyle, activeCompany, fvInfoHtml,
} from './page.js';
import {
  fakturowniaMode, importFromFakturownia, fetchFakturowniaClients, fetchFakturowniaInfo,
} from './fakturownia.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fvView = {
  pick: { sale: true, cost: true, clients: true, accounts: true },
  busy: '',
  progress: '',
  error: '',
};

const CATEGORIES = [
  ['sale', 'Faktury (przychody)'],
  ['cost', 'Wydatki'],
  ['clients', 'Klienci'],
  ['accounts', 'Konta bankowe klientów'],
];

function comparisonRows(store, company) {
  const sales = store.listInvoices({ companyId: company.id, dir: 'sale' });
  const costs = store.listInvoices({ companyId: company.id, dir: 'cost' });
  const clients = store.fvClients(company.id);
  const accounts = store.clientAccounts(company.id);
  const fvTotal = store.fvInfo(company.id)?.account?.invoices;
  const noFv = (list) => list.filter((i) => !i.fvId && i.kind !== 'proforma').length;
  return [
    { label: 'Faktury (przychody)', ours: sales.length, withFv: sales.filter((i) => i.fvId).length, missing: noFv(sales) },
    { label: 'Wydatki', ours: costs.length, withFv: costs.filter((i) => i.fvId).length, missing: noFv(costs) },
    { label: 'Klienci (mirror z Fakturowni)', ours: clients.length, withFv: clients.length, missing: 0 },
    { label: 'Klienci z kontami bankowymi', ours: accounts.filter((e) => e.accounts?.length).length, withFv: '—', missing: '—' },
    ...(fvTotal ? [{ label: 'Dokumenty ogółem po stronie Fakturowni', ours: '—', withFv: fvTotal, missing: '—' }] : []),
  ];
}

export function renderFvPage(el, deps) {
  injectStyle();
  el.dataset.ksefadPage = 'fv';
  const { store } = deps;
  const company = activeCompany(store);
  if (!company) {
    el.innerHTML = '<div class="ksefad"><h2>🔄 Fakturownia</h2><p>Najpierw dodaj firmę w Ustawieniach → Addons → KSeF.</p></div>';
    return;
  }
  if (fakturowniaMode(company) !== 'dual') {
    el.innerHTML = `
      <div class="ksefad">
        <h2>🔄 Fakturownia</h2>
        <p class="ksefad-muted">Firma <b>${esc(company.name)}</b> nie ma włączonego trybu dual —
        ta strona pokazuje parametry konta Fakturowni i synchronizację, więc wymaga skonfigurowanej
        Fakturowni (Ustawienia → Addons → KSeF → Tryb Fakturownia: Dual).</p>
      </div>`;
    return;
  }

  const last = store.fvSyncState(company.id);
  const rows = comparisonRows(store, company);

  el.innerHTML = `
    <div class="ksefad">
      <div class="ksefad-bar">
        <h2 style="margin:0; font-size:17px">🔄 Fakturownia <span class="ksefad-muted" style="font-size:.75em">${esc((company.fakturownia || {}).subdomain || '')}.fakturownia.pl</span></h2>
        <span style="flex:1"></span>
        <button class="ksefad-btn" id="fvRefreshInfo" ${fvView.busy ? 'disabled' : ''}>${fvView.busy === 'info' ? 'Odświeżam…' : '⟳ Odśwież parametry'}</button>
      </div>
      ${fvView.error ? `<div class="ksefad-error">${esc(fvView.error)}</div>` : ''}

      <div class="adk-card" style="margin-top:10px">
        <b>Synchronizacja</b>
        <div class="ksefad-bar" style="gap:16px; margin-top:8px">
          ${CATEGORIES.map(([key, label]) => `
            <label><input type="checkbox" data-fvpick="${key}" ${fvView.pick[key] ? 'checked' : ''}> ${label}</label>`).join('')}
          <span style="flex:1"></span>
          <button class="ksefad-btn" id="fvSyncSel" ${fvView.busy ? 'disabled' : ''}>${fvView.busy === 'sync' ? 'Synchronizuję…' : 'Synchronizuj zaznaczone (r)'}</button>
          <button class="ksefad-btn primary" id="fvSyncAll" ${fvView.busy ? 'disabled' : ''}>Wszystko naraz</button>
        </div>
        ${fvView.progress ? `<div class="ksefad-muted" style="margin-top:6px">${esc(fvView.progress)}</div>` : ''}
      </div>

      ${last ? `
      <div class="adk-card" style="margin-top:10px">
        <b>Ostatnia synchronizacja</b> <span class="ksefad-muted">${esc(new Date(last.at).toLocaleString('pl-PL'))}</span>
        <table class="ksefad-table" style="margin-top:8px">
          <thead><tr><th>Kategoria</th><th style="text-align:right">Pobrano</th><th style="text-align:right">Dodane</th><th style="text-align:right">Zaktualizowane</th><th>Status</th></tr></thead>
          <tbody>
            ${last.results.map((r) => `
              <tr>
                <td>${esc(r.label)}</td>
                <td style="text-align:right">${r.total ?? '—'}</td>
                <td style="text-align:right">${r.added ?? '—'}</td>
                <td style="text-align:right">${r.updated ?? '—'}</td>
                <td>${r.error ? `<span class="ksefad-no" title="${esc(r.error)}">✗ ${esc(String(r.error).slice(0, 60))}</span>` : '<span class="ksefad-ok">✓ OK</span>'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
        <div class="ksefad-muted" style="margin-top:6px">
          Razem: pobrano ${last.results.reduce((s, r) => s + (r.total || 0), 0)},
          dodano ${last.results.reduce((s, r) => s + (r.added || 0), 0)},
          zaktualizowano ${last.results.reduce((s, r) => s + (r.updated || 0), 0)}.
        </div>
      </div>` : ''}

      <div class="adk-card" style="margin-top:10px">
        <b>Stan: nasz system ⇄ Fakturownia</b>
        <table class="ksefad-table" style="margin-top:8px">
          <thead><tr><th>Kategoria</th><th style="text-align:right">U nas</th><th style="text-align:right">Powiązane z Fakturownią</th><th style="text-align:right">Bez powiązania</th></tr></thead>
          <tbody>
            ${rows.map((r) => `
              <tr>
                <td>${esc(r.label)}</td>
                <td style="text-align:right">${r.ours}</td>
                <td style="text-align:right">${r.withFv}</td>
                <td style="text-align:right">${typeof r.missing === 'number' && r.missing > 0
                  ? `<span class="ksefad-no">${r.missing}</span>` : esc(String(r.missing))}</td>
              </tr>`).join('')}
          </tbody>
        </table>
        <div class="ksefad-muted" style="margin-top:6px">„Bez powiązania" = rekordy bez dokumentu w
        Fakturowni (proformy pominięte) — filtr „bez Fakt." na stronie Faktury pokaże które.</div>
      </div>

      <div class="adk-card" style="margin-top:10px">
        <b>Parametry konta Fakturowni</b>
        <div class="ksefad-fvinfo" style="margin-top:8px">${fvInfoHtml(store.fvInfo(company.id))}</div>
      </div>
    </div>`;

  el.querySelectorAll('[data-fvpick]').forEach((cb) => {
    cb.onchange = () => { fvView.pick[cb.dataset.fvpick] = cb.checked; };
  });
  el.querySelector('#fvRefreshInfo').onclick = async () => {
    fvView.busy = 'info';
    fvView.error = '';
    renderFvPage(el, deps);
    try {
      await fetchFakturowniaInfo(deps, company);
    } catch (err) {
      deps.cl.log('fv info refresh failed:', err);
      fvView.error = String(err.message || err);
    }
    fvView.busy = '';
    renderFvPage(el, deps);
  };
  el.querySelector('#fvSyncSel').onclick = () => runSync(el, deps, company, fvView.pick);
  el.querySelector('#fvSyncAll').onclick = () => runSync(el, deps, company, { sale: true, cost: true, clients: true, accounts: true });
}

async function runSync(el, deps, company, pick) {
  const { store } = deps;
  fvView.busy = 'sync';
  fvView.error = '';
  const results = [];
  const progress = (label) => (p) => {
    fvView.progress = `${label}: strona ${p.page}, ${p.total} rekordów…`;
    renderFvPage(el, deps);
  };
  renderFvPage(el, deps);

  const steps = [
    ['sale', 'Faktury (przychody)', () => importFromFakturownia(deps, company, progress('Faktury'), { period: 'all', income: 'sale' })],
    ['cost', 'Wydatki', () => importFromFakturownia(deps, company, progress('Wydatki'), { period: 'all', income: 'cost' })],
    ['clients', 'Klienci', () => fetchFakturowniaClients(deps, company, progress('Klienci'))],
    ['accounts', 'Konta bankowe klientów', () => fetchFakturowniaClients(deps, company, progress('Konta'), { accountsOnly: true })],
  ];
  // clients already merges accounts — a second accounts-only pass would just
  // repeat the same walk
  const wanted = steps.filter(([key]) => pick[key] && !(key === 'accounts' && pick.clients));

  for (const [, label, run] of wanted) {
    try {
      const r = await run();
      results.push({
        label,
        total: r.total ?? 0,
        added: r.added ?? r.accountsMerged ?? 0,
        updated: r.updated ?? 0,
      });
    } catch (err) {
      deps.cl.log('fv sync step failed:', label, err);
      results.push({ label, error: String(err.message || err) });
    }
  }
  if (pick.accounts && pick.clients) {
    const merged = results.find((r) => r.label === 'Klienci');
    if (merged) merged.label = 'Klienci (wraz z kontami bankowymi)';
  }
  await store.setFvSyncState(company.id, { at: new Date().toISOString(), results });
  fvView.busy = '';
  fvView.progress = '';
  renderFvPage(el, deps);
}

export function fvOnKey(e, el, deps) {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (document.querySelector('.ksefad-overlay')) return false;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false;
  if (e.key === 'r' && !fvView.busy) {
    el.querySelector('#fvSyncSel')?.click();
    return true;
  }
  return false;
}
