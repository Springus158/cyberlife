// KSeF addon entry. Polish-market e-invoicing: browses and issues invoices
// through the national KSeF 2.0 API, with a one-time history import from
// Fakturownia.pl. Agent tools mirror what the UI can do.

import { createStore, normalizeNip, assertDate } from './store.js';
import {
  renderPage, pageOnKey, renderClientsPage, clientsOnKey,
  renderTodayWidget, renderUnpaidWidget, renderSettings,
  activeCompany, setActiveCompany,
} from './page.js';
import { renderBankPage, bankOnKey } from './bank-page.js';
import { syncCompany, createInvoice, sendToKsef, setPaid } from './service.js';
import { importFromFakturownia } from './fakturownia.js';

export default async function activate(cl) {
  const store = createStore(cl);
  await store.init();
  const deps = { cl, http: cl.http.bind(cl), store };

  let pageEl = null;
  let clientsEl = null;
  let bankEl = null;
  let companyBarEl = null;

  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const rerenderPages = () => {
    if (pageEl) renderPage(pageEl, deps);
    if (clientsEl) renderClientsPage(clientsEl, deps);
    if (bankEl) renderBankPage(bankEl, deps);
  };

  // The company picker is anchored in the module page bar and scopes every
  // page at once — exactly one company is always selected, never "all"
  const updateCompanyBar = () => {
    if (!companyBarEl) return;
    const companies = store.companies();
    const company = activeCompany(store);
    if (!company) {
      companyBarEl.innerHTML = '';
      return;
    }
    if (companies.length === 1) {
      companyBarEl.innerHTML = `<span class="addon-subbar-label">🏢 ${esc(company.name)}</span>`;
      return;
    }
    companyBarEl.innerHTML = `
      <select id="ksefadCompanyBar" title="Firma">
        ${companies.map((c) => `<option value="${esc(c.id)}" ${c.id === company.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
      </select>`;
    companyBarEl.querySelector('#ksefadCompanyBar').onchange = (e) => {
      setActiveCompany(e.target.value);
      rerenderPages();
      updateCompanyBar();
    };
  };

  cl.registerModule({
    id: 'main',
    label: 'KSeF',
    icon: '🧾',
    renderBar(el) {
      companyBarEl = el;
      updateCompanyBar();
    },
    pages: [
      {
        id: 'invoices',
        label: 'Faktury',
        icon: '🧾',
        render(el) {
          pageEl = el;
          renderPage(el, deps);
        },
        onKey(e) {
          return pageEl ? pageOnKey(e, pageEl, deps) : false;
        },
        onShow: () => updateCompanyBar(),
      },
      {
        id: 'clients',
        label: 'Klienci',
        icon: '👥',
        render(el) {
          clientsEl = el;
          renderClientsPage(el, deps);
        },
        onKey(e) {
          return clientsEl ? clientsOnKey(e, clientsEl, deps) : false;
        },
        onShow: () => updateCompanyBar(),
      },
      {
        id: 'bank',
        label: 'Wyciągi',
        icon: '🏦',
        render(el) {
          bankEl = el;
          renderBankPage(el, deps);
        },
        onKey(e) {
          return bankEl ? bankOnKey(e, bankEl, deps) : false;
        },
        onShow: () => updateCompanyBar(),
      },
    ],
  });

  cl.registerWidget({ id: 'today', title: 'KSeF Today', icon: '📥', dashboard: true, render: (el) => renderTodayWidget(el, deps) });
  cl.registerWidget({ id: 'unpaid', title: 'Unpaid Invoices', icon: '💸', dashboard: true, render: (el) => renderUnpaidWidget(el, deps) });
  cl.registerSettingsSection({ id: 'settings', label: 'KSeF', icon: '🧾', render: (el) => renderSettings(el, deps) });

  // ---- agent tools (MCP: ksef_*) ----

  function resolveCompany(ref) {
    const companies = store.companies();
    if (!ref) {
      if (companies.length === 1) return companies[0];
      throw new Error(`company is required; configured: ${companies.map((c) => c.name).join(', ') || 'none'}`);
    }
    const found = companies.find((c) => c.id === ref
      || c.name.toLowerCase() === String(ref).toLowerCase()
      || (normalizeNip(ref) && normalizeNip(c.nip) === normalizeNip(ref)));
    if (!found) throw new Error(`company "${ref}" not found; configured: ${companies.map((c) => c.name).join(', ') || 'none'}`);
    return found;
  }

  cl.registerAgentTool('list_companies', async () => ({
    companies: store.companies().map((c) => ({
      id: c.id, name: c.name, nip: c.nip, env: c.env || 'prod', lastSync: store.syncState(c.id).lastSync || null,
    })),
  }));

  cl.registerAgentTool('list_invoices', async (args) => {
    const companyId = args.company ? resolveCompany(args.company).id : undefined;
    const invoices = store.listInvoices({
      companyId,
      dir: args.direction,
      unpaid: args.unpaid,
      from: args.from,
      to: args.to,
      query: args.query,
      limit: args.limit || 50,
    });
    return {
      count: invoices.length,
      invoices: invoices.map(({ lines, ...rest }) => ({
        ...rest,
        description: lines?.length ? lines.map((l) => l.name).join('; ').slice(0, 200) : '',
      })),
    };
  });

  cl.registerAgentTool('create_invoice', async (args) => {
    const company = resolveCompany(args.company);
    const record = await createInvoice(deps, company, args);
    let sent = null;
    let sendError = '';
    if (args.send && record.kind !== 'proforma') {
      // A throw here would hide the created invoice from the agent, and its
      // natural retry would file a duplicate under the next number — so the
      // record is always returned, with the send failure alongside
      try {
        sent = await sendToKsef(deps, company, record.id);
      } catch (err) {
        cl.log('create_invoice: send failed:', err);
        sendError = String(err?.message || err);
      }
    }
    if (pageEl) renderPage(pageEl, deps);
    const invoice = sent || store.getInvoice(record.id) || record;
    return sendError
      ? { invoice, sendError: `created but not confirmed in KSeF: ${sendError}` }
      : { invoice };
  });

  cl.registerAgentTool('send_invoice', async (args) => {
    const inv = store.getInvoice(args.id);
    if (!inv) throw new Error(`invoice ${args.id} not found`);
    const company = store.company(inv.companyId);
    if (!company) throw new Error(`the company of invoice ${args.id} is no longer configured`);
    const updated = await sendToKsef(deps, company, args.id);
    if (pageEl) renderPage(pageEl, deps);
    return { invoice: updated };
  });

  cl.registerAgentTool('mark_paid', async (args) => {
    if (args.paidDate) assertDate(args.paidDate, 'paidDate');
    const inv = store.getInvoice(args.id);
    if (!inv) throw new Error(`invoice ${args.id} not found`);
    const updated = await setPaid(deps, store.company(inv.companyId), args.id, args.paid !== false, args.paidDate);
    if (pageEl) renderPage(pageEl, deps);
    return { invoice: updated };
  });

  cl.registerAgentTool('sync', async (args) => {
    const targets = args.company ? [resolveCompany(args.company)] : store.companies();
    const results = {};
    for (const company of targets) {
      try {
        results[company.name] = await syncCompany(deps, company);
      } catch (err) {
        cl.log('agent sync failed:', err);
        results[company.name] = { error: String(err.message || err) };
      }
    }
    if (pageEl) renderPage(pageEl, deps);
    return results;
  });

  cl.registerAgentTool('import_fakturownia', async (args) => {
    const company = resolveCompany(args.company);
    const result = await importFromFakturownia(deps, company);
    if (pageEl) renderPage(pageEl, deps);
    return result;
  });

  cl.log('KSeF addon active');

  return () => {
    // The page elements belong to the host and are removed on deactivate;
    // keeping the references would have agent tools render into detached nodes
    pageEl = null;
    clientsEl = null;
    bankEl = null;
    companyBarEl = null;
  };
}
