// Domain operations: KSeF sync (incremental, PermanentStorage cursor),
// invoice creation with Fakturownia-style numbering, and FA(3) submission.

import { KsefClient } from './ksef-client.js';
import { buildFa3Xml, computeTotals, lineNet, lineVat } from './fa3.js';

const KIND_BY_KSEF_TYPE = {
  Vat: 'vat', Zal: 'advance', Kor: 'correction', Roz: 'settlement',
  Upr: 'simplified', KorZal: 'correction', KorRoz: 'correction',
};

const tokenCache = new Map(); // companyId -> {accessToken, obtainedAt}
const TOKEN_TTL_MS = 10 * 60 * 1000;

async function accessTokenFor(http, company) {
  const cached = tokenCache.get(company.id);
  if (cached && Date.now() - cached.obtainedAt < TOKEN_TTL_MS) return cached.accessToken;
  if (!company.ksefToken || !company.nip) {
    throw new Error(`company "${company.name}": set NIP and KSeF token first`);
  }
  const client = new KsefClient({ http, env: company.env || 'prod' });
  const auth = await client.authenticate({ token: company.ksefToken, nip: company.nip });
  tokenCache.set(company.id, { accessToken: auth.accessToken, obtainedAt: Date.now() });
  return auth.accessToken;
}

export function clearTokenCache(companyId) {
  if (companyId) tokenCache.delete(companyId);
  else tokenCache.clear();
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function mapKsefMeta(m, dir) {
  return {
    id: m.ksefNumber,
    src: 'ksef',
    dir,
    number: m.invoiceNumber || '',
    ksefNumber: m.ksefNumber,
    issueDate: (m.issueDate || '').slice(0, 10),
    sellDate: '',
    paymentTo: '',
    sellerNip: m.seller?.nip || '',
    sellerName: m.seller?.name || '',
    buyerNip: m.buyer?.identifier?.type === 'Nip' ? (m.buyer.identifier.value || '') : '',
    buyerName: m.buyer?.name || '',
    net: m.netAmount ?? 0,
    vat: m.vatAmount ?? 0,
    gross: m.grossAmount ?? 0,
    currency: m.currency || 'PLN',
    paid: false,
    paidDate: '',
    kind: KIND_BY_KSEF_TYPE[m.invoiceType] || 'vat',
    seen: today(),
  };
}

async function queryAll(client, accessToken, subjectType, from) {
  const out = [];
  let hwm = null;
  for (let pageOffset = 0; pageOffset < 100; pageOffset++) {
    const res = await client.queryMetadata({
      accessToken,
      subjectType,
      from,
      dateType: 'PermanentStorage',
      pageOffset,
      pageSize: 100,
    });
    out.push(...(res.invoices || []));
    hwm = res.permanentStorageHwmDate || hwm;
    if (!res.hasMore) break;
  }
  return { invoices: out, hwm };
}

// Pulls new invoices (both directions) since the last cursor, with a 2-day
// overlap; dedup happens in the store. KSeF caps a query range at 3 months,
// so the first sync starts 80 days back — older history comes from the
// Fakturownia import.
export async function syncCompany({ http, store }, company) {
  const client = new KsefClient({ http, env: company.env || 'prod' });
  const accessToken = await accessTokenFor(http, company);
  const cursor = store.syncState(company.id).cursor;
  const from = cursor
    ? new Date(new Date(cursor).getTime() - 2 * 24 * 3600 * 1000).toISOString()
    : isoDaysAgo(80);

  const sales = await queryAll(client, accessToken, 'Subject1', from);
  const costs = await queryAll(client, accessToken, 'Subject2', from);

  const records = [
    ...sales.invoices.map((m) => mapKsefMeta(m, 'sale')),
    ...costs.invoices.map((m) => mapKsefMeta(m, 'cost')),
  ];
  const result = await store.upsertInvoices(company.id, records);
  await store.setSyncState(company.id, {
    cursor: sales.hwm || costs.hwm || new Date().toISOString(),
    lastSync: new Date().toISOString(),
    lastError: '',
  });
  return { ...result, fetched: records.length };
}

export async function downloadXml({ http }, company, ksefNumber) {
  const client = new KsefClient({ http, env: company.env || 'prod' });
  const accessToken = await accessTokenFor(http, company);
  return client.downloadInvoiceXml({ accessToken, ksefNumber });
}

// input: {buyerNip, buyerName, buyerAddress1, buyerAddress2, lines, issueDate?,
// sellDate?, paymentTo?, currency?, number?, kind?}
export async function createInvoice({ store }, company, input) {
  const issueDate = input.issueDate || today();
  const lines = (input.lines || []).map((l) => ({
    name: l.name,
    unit: l.unit || 'szt',
    quantity: Number(l.quantity) || 1,
    unitNetPrice: Number(l.unitNetPrice) || 0,
    vatRate: Number(l.vatRate ?? 23),
  }));
  if (!lines.length) throw new Error('at least one line is required');
  if (!input.buyerName) throw new Error('buyer name is required');

  const totals = computeTotals(lines);
  const net = lines.reduce((s, l) => s + lineNet(l), 0);
  const vat = lines.reduce((s, l) => s + lineVat(l), 0);
  const kind = input.kind || 'vat';
  const number = input.number
    || (kind === 'proforma' ? store.nextNumber({ ...company, numberingPattern: company.proformaPattern || 'PRO {nr}/{mm}/{yyyy}' }, issueDate)
      : store.nextNumber(company, issueDate));

  const record = {
    id: `loc:${Date.now()}`,
    src: 'local',
    dir: 'sale',
    number,
    ksefNumber: '',
    issueDate,
    sellDate: input.sellDate || issueDate,
    paymentTo: input.paymentTo || '',
    sellerNip: company.nip,
    sellerName: company.name,
    buyerNip: input.buyerNip || '',
    buyerName: input.buyerName,
    buyerAddress1: input.buyerAddress1 || '',
    buyerAddress2: input.buyerAddress2 || '',
    net: Math.round(net * 100) / 100,
    vat: Math.round(vat * 100) / 100,
    gross: totals.gross,
    currency: input.currency || 'PLN',
    paid: false,
    paidDate: '',
    kind,
    lines,
    sendState: kind === 'proforma' ? 'not-applicable' : 'draft',
    seen: today(),
  };
  await store.upsertInvoices(company.id, [record]);
  if (input.buyerName) {
    await store.upsertContractor(company.id, {
      nip: input.buyerNip || '',
      name: input.buyerName,
      address1: input.buyerAddress1 || '',
      address2: input.buyerAddress2 || '',
    });
  }
  return record;
}

export function invoiceToFa3(company, inv) {
  return buildFa3Xml({
    number: inv.number,
    issueDate: inv.issueDate,
    currency: inv.currency,
    seller: {
      nip: company.nip,
      name: company.name,
      address: company.address1 ? { line1: company.address1, line2: company.address2 || '' } : null,
    },
    buyer: {
      nip: inv.buyerNip || '',
      name: inv.buyerName,
      address: inv.buyerAddress1 ? { line1: inv.buyerAddress1, line2: inv.buyerAddress2 || '' } : null,
    },
    lines: inv.lines || [],
  });
}

export async function sendToKsef({ http, store }, company, invoiceId) {
  const inv = store.getInvoice(invoiceId);
  if (!inv) throw new Error(`invoice ${invoiceId} not found`);
  if (inv.src !== 'local') throw new Error('only invoices created here can be sent');
  if (inv.kind === 'proforma') throw new Error('proformas are not sent to KSeF');
  if (inv.ksefNumber) throw new Error(`already in KSeF as ${inv.ksefNumber}`);

  const client = new KsefClient({ http, env: company.env || 'prod' });
  const accessToken = await accessTokenFor(http, company);
  const xml = invoiceToFa3(company, inv);

  await store.updateInvoice(invoiceId, { sendState: 'sending', sendError: '' });
  try {
    const sent = await client.sendInvoice({ accessToken, xml });
    const ksefNumber = await client.waitForKsefNumber({ accessToken, ...sent });
    await client.closeSession({ accessToken, sessionReferenceNumber: sent.sessionReferenceNumber })
      .catch((err) => console.warn('[addon:ksef] close session failed:', err));
    const patch = ksefNumber
      ? { ksefNumber, id: inv.id, sendState: 'sent' }
      : { sendState: 'processing', sessionRef: sent.sessionReferenceNumber, invoiceRef: sent.invoiceReferenceNumber };
    const updated = await store.updateInvoice(invoiceId, patch);
    return updated;
  } catch (err) {
    await store.updateInvoice(invoiceId, { sendState: 'error', sendError: String(err?.message || err) });
    throw err;
  }
}
