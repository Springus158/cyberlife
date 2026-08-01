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

export async function fvSendToKsef({ http }, company, fvId) {
  return fvRequest(http, company, `/invoices/${fvId}.json?send_to_ksef=yes`);
}

export async function fvGovStatus({ http }, company, fvId) {
  return fvRequest(http, company,
    `/invoices/${fvId}.json?fields[invoice]=gov_status,gov_id,gov_error_messages,number`);
}

export async function fvSetPaid({ http }, company, fvId, paid, paidDate) {
  return fvRequest(http, company, `/invoices/${fvId}.json`, {
    method: 'PUT',
    body: { invoice: paid ? { status: 'paid', paid_date: paidDate } : { status: 'issued', paid_date: '' } },
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
    paidDate: f.paid_date || '',
    kind: f.kind || 'vat',
  };
}

export async function importFromFakturownia({ http, store }, company, onProgress, { period = 'all' } = {}) {
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
        url: `${base}/invoices.json?period=${period}&page=${page}&per_page=${PER_PAGE}${extraQuery}&api_token=${encodeURIComponent(fk.token)}`,
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
  await walkPages('');
  await walkPages('&income=no');

  if (period === 'all') {
    await store.setSyncState(company.id, { fakturowniaImportedAt: new Date().toISOString() });
  }
  return { total: tally.total, added: tally.added, updated: tally.updated, truncated: tally.truncated };
}
