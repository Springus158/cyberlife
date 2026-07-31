// One-time (re-runnable, idempotent) import of the full invoice history from
// a Fakturownia.pl account. Brings numbers, payment statuses and gov_id
// (the KSeF number, which is what dedups these against KSeF sync results).

const PER_PAGE = 100;

function isSale(f) {
  return String(f.income) === '1' || f.income === true;
}

function mapInvoice(f, company) {
  const dir = isSale(f) ? 'sale' : 'cost';
  return {
    id: f.gov_id || `fv:${f.id}`,
    src: 'fakturownia',
    dir,
    number: f.number || '',
    ksefNumber: f.gov_id || '',
    issueDate: f.issue_date || '',
    sellDate: f.sell_date || '',
    paymentTo: f.payment_to || '',
    sellerNip: f.seller_tax_no || (dir === 'sale' ? company.nip : ''),
    sellerName: f.seller_name || (dir === 'sale' ? company.name : ''),
    buyerNip: f.buyer_tax_no || '',
    buyerName: f.buyer_name || '',
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
  let page = 1;
  let total = 0;
  let added = 0;
  let updated = 0;

  for (;;) {
    const res = await http({
      url: `${base}/invoices.json?period=all&page=${page}&per_page=${PER_PAGE}&api_token=${encodeURIComponent(fk.token)}`,
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Fakturownia rejected the token (${res.status}) — check subdomain and api_token`);
    }
    if (res.status !== 200) {
      throw new Error(`Fakturownia → ${res.status} ${String(res.body || '').slice(0, 200)}`);
    }
    const list = JSON.parse(res.body);
    if (!Array.isArray(list) || list.length === 0) break;

    const result = await store.upsertInvoices(company.id, list.map((f) => mapInvoice(f, company)));
    added += result.added;
    updated += result.updated;
    total += list.length;

    for (const f of list) {
      if (isSale(f) && f.buyer_name) {
        await store.upsertContractor(company.id, {
          nip: f.buyer_tax_no || '',
          name: f.buyer_name,
          address1: f.buyer_street || '',
          address2: [f.buyer_post_code, f.buyer_city].filter(Boolean).join(' '),
        });
      }
    }

    onProgress?.({ page, total });
    if (list.length < PER_PAGE) break;
    page++;
  }

  await store.setSyncState(company.id, { fakturowniaImportedAt: new Date().toISOString() });
  return { total, added, updated };
}
