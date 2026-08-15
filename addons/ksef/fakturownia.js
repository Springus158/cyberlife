// Fakturownia.pl integration: idempotent history import, and — in the
// per-company "dual" mode — two-way sync where Fakturownia stays the system
// of record: invoices created here are created there (their numbering),
// KSeF submission goes through their integration, and payment status flows
// both ways.

import { normalizeNip } from './store.js';

const PER_PAGE = 100;
const MAX_PAGES = 500;

// 'dual' = Fakturownia is the system of record (create/send/paid go through
// it); 'off' = this app talks to KSeF directly. Credentials without an
// explicit mode mean dual — that is why they were configured.
export function fakturowniaMode(company) {
  const fk = company.fakturownia || {};
  if (!fk.subdomain || !fk.token) return 'off';
  return fk.mode === 'off' ? 'off' : 'dual';
}

async function fvRequest(http, company, path, { method = 'GET', body } = {}) {
  const fk = company.fakturownia || {};
  if (!fk.subdomain || !fk.token) {
    throw new Error(`company "${company.name}": set the Fakturownia subdomain and API token first`);
  }
  const sep = path.includes('?') ? '&' : '?';
  const res = await http({
    url: `https://${fk.subdomain}.fakturownia.pl${path}${sep}api_token=${encodeURIComponent(fk.token)}`,
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify({ ...body, api_token: fk.token }) : undefined,
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Fakturownia rejected the token (${res.status}) — check subdomain and api_token`);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Fakturownia ${method} ${path} → ${res.status} ${String(res.body || '').slice(0, 300)}`);
  }
  return res.body ? JSON.parse(res.body) : null;
}

// The combined "post_code city" line splits back into Fakturownia's separate
// fields only when it actually starts with a postal code
function splitAddress2(address2) {
  const m = /^(\d{2}-\d{3})\s+(.+)$/.exec(String(address2 || '').trim());
  return m ? { post_code: m[1], city: m[2] } : { post_code: '', city: String(address2 || '').trim() };
}

export async function createInFakturownia({ http }, company, input, lines) {
  const addr2 = splitAddress2(input.buyerAddress2);
  const created = await fvRequest(http, company, '/invoices.json', {
    method: 'POST',
    body: {
      invoice: {
        kind: input.kind === 'proforma' ? 'proforma' : 'vat',
        // null → Fakturownia numbers the document by the account's own
        // pattern, which keeps the sequence shared with invoices issued there
        number: input.number || null,
        issue_date: input.issueDate,
        sell_date: input.sellDate || input.issueDate,
        ...(input.paymentTo ? { payment_to_kind: 'other_date', payment_to: input.paymentTo } : {}),
        buyer_name: input.buyerName,
        buyer_tax_no: input.buyerNip || '',
        buyer_company: Boolean(input.buyerNip),
        buyer_street: input.buyerAddress1 || '',
        buyer_post_code: addr2.post_code,
        buyer_city: addr2.city,
        currency: input.currency || 'PLN',
        positions: lines.map((l) => ({
          name: l.name,
          quantity: l.quantity,
          quantity_unit: l.unit || 'szt',
          tax: l.vatRate,
          price_net: l.unitNetPrice,
        })),
      },
    },
  });
  if (!created?.id) throw new Error(`Fakturownia did not return the created invoice: ${JSON.stringify(created).slice(0, 200)}`);
  return created;
}

// Expense document (income: 0). Fakturownia keeps cost documents with the
// roles INVERTED: the account's own company is the "seller" side — and it
// must be referenced by department_id (free-text seller data trips the
// account-security check "creating a department is not allowed"); buyer_*
// is the issuing counterparty. The single position carries the gross total
// with the document's VAT rate; 'disabled' skips the VAT split.
export async function createCostInFakturownia({ http }, company, data) {
  const departments = await fvRequest(http, company, '/departments.json');
  const department = departments?.[0];
  if (!department?.id) throw new Error('Fakturownia returned no department for the account');
  const created = await fvRequest(http, company, '/invoices.json', {
    method: 'POST',
    body: {
      invoice: {
        income: 0,
        kind: 'vat',
        number: data.number || null,
        issue_date: data.issueDate,
        sell_date: data.issueDate,
        currency: data.currency || 'PLN',
        department_id: department.id,
        ...(data.clientId ? { client_id: data.clientId } : {}),
        buyer_name: data.sellerName,
        buyer_tax_no: data.sellerNip || data.sellerVatId || '',
        buyer_company: true,
        ...(data.sellerAddress1 ? { buyer_street: data.sellerAddress1 } : {}),
        ...(data.sellerAddress2 ? (() => {
          const m = /^([A-Z0-9 -]{3,10})\s+(.+?)(?:,\s*(.+))?$/i.exec(data.sellerAddress2.trim());
          return m
            ? { buyer_post_code: m[1], buyer_city: m[2], ...(m[3] ? { buyer_country: m[3] } : {}) }
            : { buyer_city: data.sellerAddress2 };
        })() : {}),
        status: data.paid ? 'paid' : 'issued',
        ...(data.paid && data.paidDate ? { paid_date: data.paidDate } : {}),
        positions: [{
          name: data.positionName || `Zakup wg dokumentu ${data.number || ''}`.trim(),
          quantity: 1,
          total_price_gross: data.gross,
          tax: data.vatRate ?? 'disabled',
        }],
      },
    },
  });
  if (!created?.id) throw new Error(`Fakturownia did not return the created expense: ${JSON.stringify(created).slice(0, 200)}`);
  return created;
}

// Internal evidence document (dowód wewnętrzny) — how salaries, ZUS and
// tax payments show up as expenses in Fakturownia reports. Numbered by the
// account's own DW pattern.
export async function createDwInFakturownia({ http }, company, data) {
  const departments = await fvRequest(http, company, '/departments.json');
  const department = departments?.[0];
  if (!department?.id) throw new Error('Fakturownia returned no department for the account');
  const created = await fvRequest(http, company, '/invoices.json', {
    method: 'POST',
    body: {
      invoice: {
        income: 0,
        kind: 'dw',
        number: null,
        issue_date: data.issueDate,
        sell_date: data.issueDate,
        currency: data.currency || 'PLN',
        department_id: department.id,
        buyer_name: data.counterparty,
        buyer_company: false,
        status: 'paid',
        paid_date: data.paidDate || data.issueDate,
        positions: [{ name: data.positionName, quantity: 1, total_price_gross: data.gross, tax: 'disabled' }],
      },
    },
  });
  if (!created?.id) throw new Error(`Fakturownia did not return the created DW: ${JSON.stringify(created).slice(0, 200)}`);
  return created;
}

export async function fvSendToKsef({ http }, company, fvId) {
  return fvRequest(http, company, `/invoices/${fvId}.json?send_to_ksef=yes`);
}

export async function fvGovStatus({ http }, company, fvId) {
  return fvRequest(http, company,
    `/invoices/${fvId}.json?fields[invoice]=gov_status,gov_id,gov_error_messages,number`);
}

// Read-only mirror of the Fakturownia client book (dual mode); the local
// contractors store plays this role when Fakturownia is off
export async function fetchFakturowniaClients(deps, company, onProgress, { accountsOnly = false } = {}) {
  const { http, store } = deps;
  const out = [];
  for (let page = 1; page <= 200; page++) {
    const list = await fvRequest(http, company, `/clients.json?page=${page}&per_page=100`);
    if (!Array.isArray(list) || list.length === 0) break;
    for (const c of list) {
      out.push({
        fvId: c.id,
        name: c.name || '',
        nip: normalizeNip(c.tax_no),
        address1: [c.street, c.street_no].filter(Boolean).join(' '),
        address2: [c.post_code, c.city].filter(Boolean).join(' '),
        email: c.email || '',
        phone: c.phone || c.mobile_phone || '',
        note: c.note || '',
        kind: c.kind || '',
        bankAccount: (c.bank_account || '').trim(),
      });
    }
    onProgress?.({ page, total: out.length });
  }
  if (!accountsOnly) await store.saveClients(company.id, out);

  // Accounts kept in Fakturownia flow into the local register (without
  // overwriting locally-added numbers), so statement matching sees them
  const register = store.clientAccounts(company.id).slice();
  const keyOf = (e) => normalizeNip(e.nip) || `n:${String(e.name || '').toLowerCase()}`;
  let merged = 0;
  for (const c of out) {
    if (!c.bankAccount) continue;
    const i = register.findIndex((e) => keyOf(e) === keyOf(c));
    const norm = (s) => String(s).replace(/[^0-9A-Za-z]/g, '');
    if (i < 0) {
      register.push({ name: c.name, nip: c.nip, accounts: [c.bankAccount] });
      merged++;
    } else if (!register[i].accounts.some((a) => norm(a) === norm(c.bankAccount))) {
      register[i] = { ...register[i], accounts: [...register[i].accounts, c.bankAccount] };
      merged++;
    }
  }
  if (merged) await store.saveClientAccounts(company.id, register);
  return { total: out.length, accountsMerged: merged };
}

// The rendered PDF of any Fakturownia document (sales invoice, expense,
// DW) — the proxy base64-encodes binary responses
export async function fetchFvPdf({ http }, company, fvId) {
  const fk = company.fakturownia || {};
  if (!fk.subdomain || !fk.token) throw new Error('Fakturownia is not configured');
  const res = await http({
    url: `https://${fk.subdomain}.fakturownia.pl/invoices/${fvId}.pdf?api_token=${encodeURIComponent(fk.token)}`,
  });
  if (res.status !== 200) throw new Error(`Fakturownia PDF #${fvId}: ${res.status}`);
  if (!res.bodyBase64) throw new Error(`Fakturownia PDF #${fvId}: unexpected text response`);
  return res.body;
}

export async function fvUpdateClientBankAccount({ http }, company, fvClientId, bankAccount) {
  return fvRequest(http, company, `/clients/${fvClientId}.json`, {
    method: 'PUT',
    body: { client: { bank_account: bankAccount } },
  });
}

// Read-only snapshot of the Fakturownia account: who the seller is there,
// which numbering patterns the account uses (each account differs — never
// assume one), plan and volume. Stored for display; editing happens in
// Fakturownia itself.
export async function fetchFakturowniaInfo(deps, company) {
  const { http, store } = deps;
  const account = await fvRequest(http, company, '/account.json');
  const departments = await fvRequest(http, company, '/departments.json');
  const dep = (Array.isArray(departments) ? departments : []).find((d) => d.main && !d.deleted)
    || (Array.isArray(departments) ? departments[0] : null);
  const info = {
    fetchedAt: new Date().toISOString(),
    account: {
      prefix: account?.prefix || '',
      plan: account?.plan || '',
      paidTo: account?.paid_to || '',
      invoices: account?.invoices ?? null,
      lang: account?.lang || '',
    },
    seller: dep ? {
      name: dep.name || '',
      shortcut: dep.shortcut || '',
      nip: dep.tax_no || '',
      street: dep.street || '',
      postCode: dep.post_code || '',
      city: dep.city || '',
      country: dep.country || '',
      email: dep.email || '',
      bank: dep.bank || '',
      bankAccount: dep.bank_account || '',
    } : null,
    patterns: dep ? {
      'Faktura VAT': dep.invoice_pattern || '',
      'Proforma': dep.invoice_pattern_proforma || '',
      'Korekta': dep.invoice_pattern_correction || '',
      'Zaliczkowa': dep.invoice_pattern_advance || '',
      'Końcowa': dep.invoice_pattern_final || '',
      'Rachunek': dep.invoice_pattern_bill || '',
    } : {},
  };
  await store.setFvInfo(company.id, info);
  return info;
}

export async function fvSetPaid({ http, cl }, company, fvId, paid, paidDate) {
  try {
    return await fvRequest(http, company, `/invoices/${fvId}.json`, {
      method: 'PUT',
      body: { invoice: paid ? { status: 'paid', paid_date: paidDate } : { status: 'issued', paid_date: '' } },
    });
  } catch (err) {
    // Documents already submitted to KSeF reject full edits (422); the
    // status-only endpoint still works for them
    if (!/422/.test(String(err?.message || err))) throw err;
    cl?.log?.('fvSetPaid: PUT rejected (KSeF-locked document), using change_status:', err.message);
    return fvRequest(http, company, `/invoices/${fvId}/change_status.json?status=${paid ? 'paid' : 'issued'}`, {
      method: 'POST',
    });
  }
}

export const FV_APPROVALS = ['received', 'accepted', 'rejected'];

// Fakturownia's expense acceptance flow (Otrzymana / Zatwierdzona /
// Odrzucona) lives in approval_status — separate from the payment status
export async function fvSetApproval({ http }, company, fvId, approval) {
  if (!FV_APPROVALS.includes(approval)) {
    throw new Error(`approval must be one of ${FV_APPROVALS.join(', ')}, got "${approval}"`);
  }
  return fvRequest(http, company, `/invoices/${fvId}.json`, {
    method: 'PUT',
    body: { invoice: { approval_status: approval } },
  });
}

function isSale(f) {
  return String(f.income) === '1' || f.income === true;
}

// status alone misses accounts that record the payment amount without
// flipping the status, so a fully covered gross also counts as paid
function isPaid(f) {
  if (f.status === 'paid') return true;
  const paid = Number(f.paid);
  const gross = Number(f.price_gross);
  return Number.isFinite(paid) && Number.isFinite(gross) && gross > 0 && paid >= gross;
}

// Cash documents, drafts and notes that Fakturownia keeps in the same
// endpoint but which are not invoices in any accounting sense
const SKIPPED_KINDS = new Set(['kp', 'kw', 'estimate', 'client_order', 'correction_note', 'accounting_note']);

function mapInvoice(f, company) {
  const dir = isSale(f) ? 'sale' : 'cost';
  // On cost invoices Fakturownia inverts the roles: seller_* fields are the
  // buyer (us) and buyer_* the actual issuer — per the API README ("W
  // przypadku faktur kosztowych wszystkie pola zaczynające się od seller_
  // zostaną wyświetlone na fakturze w sekcji 'Nabywca'…")
  const seller = dir === 'sale' ? 'seller' : 'buyer';
  const buyer = dir === 'sale' ? 'buyer' : 'seller';
  return {
    // Fakturownia ids are per-account, so they must be namespaced or two
    // companies' invoices would collide on lookup and updates
    id: f.gov_id ? `ksef:${f.gov_id}` : `fv:${company.id}:${f.id}`,
    fvId: f.id,
    src: 'fakturownia',
    dir,
    number: f.number || '',
    ksefNumber: f.gov_id || '',
    issueDate: f.issue_date || '',
    sellDate: f.sell_date || '',
    paymentTo: f.payment_to || '',
    sellerNip: normalizeNip(f[`${seller}_tax_no`] || (dir === 'sale' ? company.nip : '')),
    sellerName: f[`${seller}_name`] || (dir === 'sale' ? company.name : ''),
    buyerNip: normalizeNip(f[`${buyer}_tax_no`]),
    buyerName: f[`${buyer}_name`] || (dir === 'cost' ? company.name : ''),
    net: Number(f.price_net) || 0,
    vat: Number(f.price_tax) || 0,
    gross: Number(f.price_gross) || 0,
    currency: f.currency || 'PLN',
    paid: isPaid(f),
    paidAmount: Number(f.paid) || 0,
    paidDate: f.paid_date || '',
    kind: f.kind || 'vat',
    ...(f.approval_status ? { fvApproval: f.approval_status } : {}),
    // Positions say what the document was issued FOR — kept slim; tax can
    // be a rate or 'zw'/'np', so it stays as-is for display
    ...(Array.isArray(f.positions) && f.positions.length ? {
      lines: f.positions.map((p) => ({
        name: p.name || '',
        quantity: Number(p.quantity) || 1,
        unit: p.quantity_unit || 'szt',
        unitNetPrice: Number(p.price_net) || 0,
        vatRate: Number.isFinite(Number(p.tax)) ? Number(p.tax) : String(p.tax ?? ''),
      })),
    } : {}),
  };
}

export async function importFromFakturownia({ http, store }, company, onProgress, { period = 'all', income = 'both' } = {}) {
  const fk = company.fakturownia || {};
  if (!fk.subdomain || !fk.token) {
    throw new Error(`company "${company.name}": set the Fakturownia subdomain and API token first`);
  }
  const base = `https://${fk.subdomain}.fakturownia.pl`;
  const tally = { total: 0, added: 0, updated: 0, pages: 0, truncated: false };

  async function walkPages(extraQuery) {
    let page = 1;
    for (; page <= MAX_PAGES; page++) {
      const res = await http({
        url: `${base}/invoices.json?period=${period}&page=${page}&per_page=${PER_PAGE}&include_positions=true${extraQuery}&api_token=${encodeURIComponent(fk.token)}`,
      });
      if (res.status === 401 || res.status === 403) {
        throw new Error(`Fakturownia rejected the token (${res.status}) — check subdomain and api_token`);
      }
      if (res.status !== 200) {
        throw new Error(`Fakturownia → ${res.status} ${String(res.body || '').slice(0, 200)}`);
      }
      const list = JSON.parse(res.body);
      // Only an empty page ends the walk: the server may cap per_page below
      // what we asked for, and stopping on a short page would silently import
      // a fraction of the history while reporting success
      if (!Array.isArray(list) || list.length === 0) break;

      const invoices = list.filter((f) => !SKIPPED_KINDS.has(f.kind));
      const result = await store.upsertInvoices(company.id, invoices.map((f) => mapInvoice(f, company)));
      tally.added += result.added;
      tally.updated += result.updated;
      tally.total += invoices.length;
      tally.pages++;

      // Batched: one storage write per page instead of per invoice, which
      // would otherwise be thousands of IPC round-trips on the UI thread
      await store.upsertContractors(company.id, invoices
        .filter((f) => isSale(f) && f.buyer_name)
        .map((f) => ({
          nip: f.buyer_tax_no || '',
          name: f.buyer_name,
          address1: f.buyer_street || '',
          address2: [f.buyer_post_code, f.buyer_city].filter(Boolean).join(' '),
        })));

      onProgress?.({ page: tally.pages, total: tally.total });
    }
    if (page > MAX_PAGES) tally.truncated = true;
  }

  // Two passes: /invoices.json returns income (sales) invoices only, and
  // needs income=no for the cost side
  if (income !== 'cost') await walkPages('');
  if (income !== 'sale') await walkPages('&income=no');

  if (period === 'all' && income === 'both') {
    await store.setSyncState(company.id, { fakturowniaImportedAt: new Date().toISOString() });
    await fetchFakturowniaInfo({ http, store }, company)
      .catch((err) => console.warn('[addon:ksef] fakturownia account info fetch failed:', err));
    await fetchFakturowniaClients({ http, store }, company)
      .catch((err) => console.warn('[addon:ksef] fakturownia clients fetch failed:', err));
  }
  return { total: tally.total, added: tally.added, updated: tally.updated, truncated: tally.truncated };
}
