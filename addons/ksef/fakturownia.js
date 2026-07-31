// One-time (re-runnable, idempotent) import of the full invoice history from
// a Fakturownia.pl account. Brings numbers, payment statuses and gov_id
// (the KSeF number, which is what dedups these against KSeF sync results).

import { normalizeNip } from './store.js';

const PER_PAGE = 100;
const MAX_PAGES = 500;

function isSale(f) {
  return String(f.income) === '1' || f.income === true;
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
    paid: f.status === 'paid',
    paidDate: f.paid_date || '',
    kind: f.kind || 'vat',
  };
}

export async function importFromFakturownia({ http, store }, company, onProgress) {
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
        url: `${base}/invoices.json?period=all&page=${page}&per_page=${PER_PAGE}${extraQuery}&api_token=${encodeURIComponent(fk.token)}`,
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

  await store.setSyncState(company.id, { fakturowniaImportedAt: new Date().toISOString() });
  return { total: tally.total, added: tally.added, updated: tally.updated, truncated: tally.truncated };
}
