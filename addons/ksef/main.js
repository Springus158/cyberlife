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
import { renderFilesPage, filesOnKey } from './files-page.js';
import { renderFvPage, fvOnKey } from './fv-page.js';
import { syncCompany, createInvoice, createCostFromFile, sendToKsef, setPaid, backfillFvSalePdfs } from './service.js';
import { importFromFakturownia, fakturowniaMode, fvUpdateClientBankAccount } from './fakturownia.js';
import { parseStatement, matchTransactions, categorize } from './bank.js';
import { extractFields, matchFileToInvoice } from './files.js';

export default async function activate(cl) {
  const store = createStore(cl);
  await store.init();
  const deps = { cl, http: cl.http.bind(cl), store };

  let pageEl = null;
  let clientsEl = null;
  let bankEl = null;
  let filesEl = null;
  let fvEl = null;
  let companyBarEl = null;

  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const rerenderPages = () => {
    if (pageEl) renderPage(pageEl, deps);
    if (clientsEl) renderClientsPage(clientsEl, deps);
    if (bankEl) renderBankPage(bankEl, deps);
    if (filesEl) renderFilesPage(filesEl, deps);
    if (fvEl) renderFvPage(fvEl, deps);
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
      {
        id: 'files',
        label: 'Pliki',
        icon: '📄',
        render(el) {
          filesEl = el;
          renderFilesPage(el, deps);
        },
        onKey(e) {
          return filesEl ? filesOnKey(e, filesEl, deps) : false;
        },
        onShow: () => updateCompanyBar(),
      },
      {
        id: 'fv',
        label: 'Fakturownia',
        icon: '🔄',
        render(el) {
          fvEl = el;
          renderFvPage(el, deps);
        },
        onKey(e) {
          return fvEl ? fvOnKey(e, fvEl, deps) : false;
        },
        onShow: () => {
          updateCompanyBar();
          if (fvEl) renderFvPage(fvEl, deps);
        },
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

  // ---- bank & files agent tools (the same operations the Wyciągi and
  // Pliki pages do by hand) ----

  const txStateOf = (t) => {
    if (t.amount > 0) return 'in';
    if (t.invoiceId) return 'ok';
    return (t.category || categorize(t)) ? 'warn' : 'bad';
  };

  const slimTx = (t) => ({
    id: t.id,
    date: t.date,
    amount: t.amount,
    currency: t.currency,
    account: (t.account || '').slice(-4),
    type: t.type,
    desc: (t.desc || '').slice(0, 220),
    state: txStateOf(t),
    invoiceId: t.invoiceId || '',
    matchedBy: t.matchedBy || '',
    category: t.category || '',
  });

  cl.registerAgentTool('list_bank_transactions', async (args) => {
    const company = resolveCompany(args.company);
    const months = args.month
      ? [args.month]
      : store.bankMonths(company.id).filter((m) =>
        (!args.from || m >= args.from.slice(0, 7)) && (!args.to || m <= args.to.slice(0, 7)));
    let txs = months.flatMap((m) => store.bankMonth(company.id, m));
    if (args.from) txs = txs.filter((t) => t.date >= args.from);
    if (args.to) txs = txs.filter((t) => t.date <= args.to);
    if (args.state) txs = txs.filter((t) => txStateOf(t) === args.state);
    if (args.query) {
      const q = String(args.query).toLowerCase();
      txs = txs.filter((t) => [t.date, t.type, t.desc, t.account, String(t.amount), t.matchedBy, t.category]
        .some((v) => String(v || '').toLowerCase().includes(q)));
    }
    txs.sort((a, b) => a.date.localeCompare(b.date));
    return { count: txs.length, transactions: txs.slice(0, args.limit || 200).map(slimTx) };
  });

  cl.registerAgentTool('assign_bank_transaction', async (args) => {
    const company = resolveCompany(args.company);
    for (const month of store.bankMonths(company.id)) {
      const list = store.bankMonth(company.id, month);
      const i = list.findIndex((t) => t.id === args.txId);
      if (i < 0) continue;
      const tx = { ...list[i] };
      if (args.unassign) {
        tx.invoiceId = '';
        tx.matchedBy = '';
        tx.auto = false;
      } else if (args.invoiceId) {
        if (!store.getInvoice(args.invoiceId)) throw new Error(`invoice ${args.invoiceId} not found`);
        tx.invoiceId = args.invoiceId;
        tx.matchedBy = args.matchedBy || 'agent';
        tx.category = '';
        tx.auto = false;
      } else if (args.category) {
        tx.category = args.category;
        tx.auto = false;
      } else if (args.verify) {
        tx.matchedBy = `${(tx.matchedBy || '').replace(/\s*\(do weryfikacji\)/, '')} (zweryfikowane)`;
        tx.auto = false;
      } else {
        throw new Error('pass invoiceId, category, unassign or verify');
      }
      await store.saveBankMonth(company.id, month, list.map((t, j) => (j === i ? tx : t)));
      return { transaction: slimTx(tx) };
    }
    throw new Error(`transaction ${args.txId} not found in any month`);
  });

  cl.registerAgentTool('import_statement', async (args) => {
    const company = resolveCompany(args.company);
    const text = await cl.pdfText(args.dataBase64);
    const stmt = parseStatement(text);
    if (!stmt.txs.length) return { account: stmt.account, period: stmt.period, imported: 0, note: 'statement has no operations' };
    const invoices = store.listInvoices({ companyId: company.id });
    const byMonth = new Map();
    for (const tx of stmt.txs) {
      const mo = tx.date.slice(0, 7);
      if (!byMonth.has(mo)) byMonth.set(mo, []);
      byMonth.get(mo).push({ ...tx, account: stmt.account, currency: stmt.currency, stmtPeriod: stmt.period, stmtNo: stmt.stmtNo });
    }
    const months = {};
    for (const [mo, incoming] of byMonth) {
      const existing = store.bankMonth(company.id, mo);
      const byId = new Map(existing.map((t) => [t.id, t]));
      let added = 0;
      for (const tx of incoming) {
        if (!byId.has(tx.id)) {
          byId.set(tx.id, tx);
          added++;
        }
      }
      let list = [...byId.values()].sort((a, b) => a.account.localeCompare(b.account)
        || a.date.slice(0, 7).localeCompare(b.date.slice(0, 7)) || (a.seq ?? 0) - (b.seq ?? 0));
      const usedElsewhere = new Set();
      for (const m of store.bankMonths(company.id)) {
        if (m === mo) continue;
        for (const t of store.bankMonth(company.id, m)) if (t.invoiceId) usedElsewhere.add(t.invoiceId);
      }
      list = matchTransactions(list, invoices, { accounts: store.clientAccounts(company.id), usedInvoiceIds: usedElsewhere });
      await store.saveBankMonth(company.id, mo, list);
      months[mo] = { total: list.length, added, matched: list.filter((t) => t.invoiceId).length };
    }
    if (bankEl) renderBankPage(bankEl, deps);
    return { bank: stmt.bank, account: stmt.account, currency: stmt.currency, period: stmt.period, months };
  });

  cl.registerAgentTool('add_invoice_file', async (args) => {
    const company = resolveCompany(args.company);
    const bytes = Uint8Array.from(atob(args.dataBase64), (c) => c.charCodeAt(0));
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    const sha = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const dup = store.files(company.id).find((f) => f.sha256 === sha);
    if (dup) return { duplicate: true, file: dup };
    const safe = String(args.name || 'dokument').normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9._-]+/g, '_').replace(/\.(png|jpe?g|pdf)$/i, '').slice(0, 70);
    const isPdf = bytes[0] === 0x25 && bytes[1] === 0x50; // %P
    let fields = { nips: [], vatIds: [], seller: null, dates: [], amounts: { strong: [], all: [] }, numbers: [], currency: '', vatRate: null };
    if (isPdf) {
      try {
        fields = extractFields(await cl.pdfText(args.dataBase64), company.nip);
      } catch (err) {
        cl.log('add_invoice_file: pdfText failed (scan?):', err);
      }
    }
    const month = (fields.dates[0] || '').slice(0, 7) || new Date().toISOString().slice(0, 7);
    const key = `files/${month.replace('-', '/')}/${sha.slice(0, 12)}-${safe}.pdf`;
    await cl.putDataFile(key, args.dataBase64, { toPdf: true });
    const match = matchFileToInvoice(fields, store.listInvoices({ companyId: company.id }), { dir: 'cost' })
      || matchFileToInvoice(fields, store.listInvoices({ companyId: company.id }), { dir: 'sale' });
    const rec = {
      id: sha.slice(0, 16),
      sha256: sha,
      key,
      name: args.name || safe,
      month,
      source: 'agent',
      invoiceId: match?.invoice.id || '',
      matchedBy: match?.how || '',
      nip: fields.nips[0] || '',
      vatId: fields.vatIds?.[0] || '',
      sellerName: fields.seller?.name || '',
      sellerAddress1: fields.seller?.address1 || '',
      sellerAddress2: fields.seller?.address2 || '',
      number: fields.numbers[0] || '',
      docDate: fields.dates[0] || '',
      gross: fields.amounts.strong[0] || 0,
      currency: fields.currency || '',
      vatRate: fields.vatRate ?? null,
    };
    await store.upsertFiles(company.id, [rec]);
    if (filesEl) renderFilesPage(filesEl, deps);
    return { file: rec, matched: !!match, matchedInvoice: match ? { id: match.invoice.id, number: match.invoice.number } : null };
  });

  cl.registerAgentTool('update_invoice', async (args) => {
    const inv = store.getInvoice(args.id);
    if (!inv) throw new Error(`invoice ${args.id} not found`);
    const patch = {};
    for (const field of ['number', 'issueDate', 'currency', 'gross', 'net', 'vat', 'sellerName', 'sellerNip',
      'sellerVatId', 'sellerAddress1', 'sellerAddress2', 'buyerName', 'buyerNip', 'buyerAddress1', 'buyerAddress2']) {
      if (args[field] !== undefined) patch[field] = args[field];
    }
    if (patch.issueDate) assertDate(patch.issueDate, 'issueDate');
    if (!Object.keys(patch).length) throw new Error('nothing to update');
    const updated = await store.updateInvoice(args.id, patch);
    if (pageEl) renderPage(pageEl, deps);
    return { invoice: updated };
  });

  const clientKey = (e) => normalizeNip(e.nip) || `n:${String(e.name || '').toLowerCase()}`;

  function clientsOf(company) {
    const dual = fakturowniaMode(company) === 'dual';
    const base = dual ? store.fvClients(company.id) : store.contractors(company.id);
    const accounts = store.clientAccounts(company.id);
    const out = base.filter((c) => c.name && c.name !== '-').map((c) => ({
      ...c,
      nip: normalizeNip(c.nip),
      readonly: dual,
      bankAccounts: accounts.find((e) => clientKey(e) === clientKey(c))?.accounts || [],
    }));
    for (const e of accounts) {
      if (!out.some((c) => clientKey(c) === clientKey(e))) {
        out.push({ name: e.name, nip: normalizeNip(e.nip), readonly: false, note: 'local account-register entry', bankAccounts: e.accounts });
      }
    }
    return out;
  }

  cl.registerAgentTool('list_clients', async (args) => {
    const company = resolveCompany(args.company);
    let list = clientsOf(company);
    if (args.query) {
      const q = String(args.query).toLowerCase();
      list = list.filter((c) => `${c.name} ${c.nip} ${(c.bankAccounts || []).join(' ')}`.toLowerCase().includes(q));
    }
    return {
      count: list.length,
      source: fakturowniaMode(company) === 'dual' ? 'fakturownia (read-only; bankAccounts are a local overlay)' : 'local',
      clients: list.slice(0, args.limit || 100),
    };
  });

  cl.registerAgentTool('update_client', async (args) => {
    const company = resolveCompany(args.company);
    const dual = fakturowniaMode(company) === 'dual';
    const ref = String(args.client || '').toLowerCase();
    const existing = clientsOf(company).find((c) => c.nip === normalizeNip(args.client) || c.name.toLowerCase() === ref);

    let fvSync = null;
    if (args.bankAccounts !== undefined) {
      const target = existing || { name: args.client, nip: '' };
      const list = store.clientAccounts(company.id).slice();
      const key = clientKey(target);
      const i = list.findIndex((e) => clientKey(e) === key);
      const entry = { name: target.name, nip: target.nip || '', accounts: args.bankAccounts };
      if (i >= 0) list[i] = entry;
      else list.push(entry);
      await store.saveClientAccounts(company.id, list.filter((e) => e.accounts.length));
      if (dual && existing?.fvId) {
        try {
          await fvUpdateClientBankAccount(deps, company, existing.fvId, args.bankAccounts[0] || '');
          fvSync = `primary account pushed to Fakturownia client #${existing.fvId}`;
        } catch (err) {
          cl.log('update_client: Fakturownia bank_account push failed:', err);
          fvSync = `saved locally but Fakturownia rejected the update: ${err.message || err}`;
        }
      }
    }

    const dataFields = ['name', 'nip', 'address1', 'address2', 'email', 'phone', 'note'];
    const patch = Object.fromEntries(dataFields.filter((f) => args[f] !== undefined).map((f) => [f, args[f]]));
    if (Object.keys(patch).length) {
      if (dual) {
        throw new Error('client data comes from Fakturownia (read-only here) — edit it in Fakturownia; only bankAccounts are stored locally');
      }
      if (!existing && !patch.name) throw new Error(`client "${args.client}" not found — pass name to create one`);
      await store.upsertContractors(company.id, [{ ...(existing || {}), name: patch.name || existing.name, ...patch }]);
    }

    const updated = clientsOf(company).find((c) => c.nip === normalizeNip(patch.nip || args.client)
      || c.name.toLowerCase() === String(patch.name || args.client).toLowerCase());
    return { client: updated || null, ...(fvSync ? { fakturownia: fvSync } : {}) };
  });

  cl.registerAgentTool('list_unmatched_files', async (args) => {
    const company = resolveCompany(args.company);
    const files = store.files(company.id).filter((f) => !f.invoiceId);
    return {
      count: files.length,
      files: files.slice(0, args.limit || 100).map((f) => ({
        id: f.id, name: f.name, key: f.key, month: f.month, docDate: f.docDate,
        nip: f.nip, number: f.number, gross: f.gross, source: f.source,
      })),
    };
  });

  cl.registerAgentTool('attach_file', async (args) => {
    const company = resolveCompany(args.company);
    const rec = store.files(company.id).find((f) => f.id === args.fileId);
    if (!rec) throw new Error(`file ${args.fileId} not found`);
    if (args.invoiceId) {
      const inv = store.getInvoice(args.invoiceId);
      if (!inv) throw new Error(`invoice ${args.invoiceId} not found`);
      const updated = await store.updateFileRec(company.id, rec.id, {
        invoiceId: inv.id,
        matchedBy: args.matchedBy || 'agent',
      });
      return { file: updated };
    }
    if (args.createInvoice) {
      const c = args.createInvoice;
      const { record, fv, fvError } = await createCostFromFile(deps, company, {
        fileId: rec.id,
        number: c.number || rec.number || '',
        issueDate: c.issueDate || rec.docDate || `${rec.month}-01`,
        sellerNip: c.sellerNip || rec.nip || '',
        sellerName: c.sellerName || rec.sellerName || rec.name,
        sellerVatId: c.sellerVatId || rec.vatId || '',
        sellerAddress1: c.sellerAddress1 || rec.sellerAddress1 || '',
        sellerAddress2: c.sellerAddress2 || rec.sellerAddress2 || '',
        gross: Number(c.gross) || rec.gross || 0,
        currency: c.currency || rec.currency || 'PLN',
        vatRate: c.vatRate ?? rec.vatRate ?? 'disabled',
        paid: !!c.paid,
        paidDate: c.paidDate || '',
      });
      const updated = await store.updateFileRec(company.id, rec.id, {
        invoiceId: record.id,
        matchedBy: args.matchedBy || 'agent (nowa)',
      });
      return {
        file: updated,
        invoice: record,
        fakturownia: fv ? { id: fv.id, number: fv.number } : null,
        ...(fvError ? { fakturowniaError: `created locally but NOT in Fakturownia: ${fvError}` } : {}),
      };
    }
    throw new Error('pass invoiceId or createInvoice');
  });

  cl.registerAgentTool('backfill_fv_pdfs', async (args) => {
    const company = resolveCompany(args.company);
    const result = await backfillFvSalePdfs(deps, company, { limit: args.limit || 30 });
    if (filesEl) renderFilesPage(filesEl, deps);
    return result;
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
    filesEl = null;
    fvEl = null;
    companyBarEl = null;
  };
}
