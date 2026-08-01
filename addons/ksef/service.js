// Domain operations: KSeF sync (incremental, PermanentStorage cursor),
// invoice creation with Fakturownia-style numbering, and FA(3) submission.

import { KsefClient } from './ksef-client.js';
import { buildFa3Xml, computeTotals, lineNet, lineVat } from './fa3.js';
import { assertDate, normalizeNip } from './store.js';

// KSeF caps a metadata query at 3 months; a cursor older than this would
// make every sync fail, and since the cursor only advances on success the
// failure would be permanent
const MAX_LOOKBACK_DAYS = 80;

const KIND_BY_KSEF_TYPE = {
  Vat: 'vat', Zal: 'advance', Kor: 'correction', Roz: 'settlement',
  Upr: 'simplified', KorZal: 'correction', KorRoz: 'correction',
  VatPef: 'vat', VatPefSp: 'vat', KorPef: 'correction',
  VatRr: 'vat', KorVatRr: 'correction',
};

const tokenCache = new Map(); // companyId -> {accessToken, obtainedAt}
const TOKEN_TTL_MS = 10 * 60 * 1000;

async function accessTokenFor(http, company) {
  const cached = tokenCache.get(company.id);
  if (cached && Date.now() - cached.obtainedAt < TOKEN_TTL_MS) return cached.accessToken;
  const nip = normalizeNip(company.nip);
  if (!company.ksefToken || !nip) {
    throw new Error(`company "${company.name}": set NIP and KSeF token first`);
  }
  if (nip.length !== 10) {
    throw new Error(`company "${company.name}": NIP must be 10 digits, got "${company.nip}"`);
  }
  const client = new KsefClient({ http, env: company.env || 'prod' });
  const auth = await client.authenticate({ token: company.ksefToken, nip });
  tokenCache.set(company.id, { accessToken: auth.accessToken, obtainedAt: Date.now() });
  return auth.accessToken;
}

export function clearTokenCache(companyId) {
  if (companyId) tokenCache.delete(companyId);
  else tokenCache.clear();
}

// Local date, not UTC: an invoice issued at 00:30 Warsaw time belongs to the
// day (and the VAT month) that has just started, not the previous one
export function today() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function mapKsefMeta(m, dir) {
  return {
    id: `ksef:${m.ksefNumber}`,
    src: 'ksef',
    dir,
    number: m.invoiceNumber || '',
    ksefNumber: m.ksefNumber,
    issueDate: (m.issueDate || '').slice(0, 10),
    sellDate: '',
    paymentTo: '',
    sellerNip: normalizeNip(m.seller?.nip),
    sellerName: m.seller?.name || '',
    buyerNip: m.buyer?.identifier?.type === 'Nip' ? normalizeNip(m.buyer.identifier.value) : '',
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

const MAX_PAGES = 100;

async function queryAll(client, accessToken, subjectType, from, log) {
  const out = [];
  let hwm = null;
  let pageOffset = 0;
  for (; pageOffset < MAX_PAGES; pageOffset++) {
    const res = await client.queryMetadata({
      accessToken,
      subjectType,
      from,
      dateType: 'PermanentStorage',
      pageOffset,
      pageSize: 100,
    });
    const page = res.invoices || [];
    out.push(...page);
    hwm = res.permanentStorageHwmDate || hwm;
    // isTruncated marks the server's 10k-record ceiling for this dateRange;
    // more pageOffset pages would silently repeat, not continue
    if (res.isTruncated) {
      log?.(`KSeF ${subjectType}: query hit the server's 10k-record ceiling — some invoices were not fetched`);
      return { invoices: out, hwm: null, truncated: true };
    }
    if (!res.hasMore || page.length === 0) break;
  }
  if (pageOffset >= MAX_PAGES) {
    log?.(`KSeF ${subjectType}: stopped at the ${MAX_PAGES}-page ceiling — some invoices were not fetched`);
    return { invoices: out, hwm: null, truncated: true };
  }
  return { invoices: out, hwm };
}

// Pulls new invoices (both directions) since the last cursor, with a 2-day
// overlap; dedup happens in the store. KSeF caps a query range at 3 months,
// so the first sync starts 80 days back — older history comes from the
// Fakturownia import.
export async function syncCompany(deps, company) {
  const { http, store, cl } = deps;
  const log = (msg) => cl?.log(msg);
  try {
    const client = new KsefClient({ http, env: company.env || 'prod' });
    const accessToken = await accessTokenFor(http, company);
    const cursor = store.syncState(company.id).cursor;
    const floor = Date.now() - MAX_LOOKBACK_DAYS * 24 * 3600 * 1000;
    const wanted = cursor ? Date.parse(cursor) - 2 * 24 * 3600 * 1000 : floor;
    const from = new Date(Math.max(Number.isFinite(wanted) ? wanted : floor, floor)).toISOString();

    const sales = await queryAll(client, accessToken, 'Subject1', from, log);
    const costs = await queryAll(client, accessToken, 'Subject2', from, log);

    const records = [
      ...sales.invoices.map((m) => mapKsefMeta(m, 'sale')),
      ...costs.invoices.map((m) => mapKsefMeta(m, 'cost')),
    ];
    const result = await store.upsertInvoices(company.id, records);
    await refreshPendingSends(deps, company, client, accessToken);
    // The cursor is shared by both directions, so a truncated page walk on
    // either side must not advance it past invoices it never saw — the other
    // side's hwm would skip them for good
    const truncated = sales.truncated || costs.truncated;
    const hwms = [sales.hwm, costs.hwm].filter(Boolean).sort();
    await store.setSyncState(company.id, {
      cursor: truncated ? cursor : (hwms[0] || new Date().toISOString()),
      lastSync: new Date().toISOString(),
      lastError: '',
    });
    return { ...result, fetched: records.length };
  } catch (err) {
    await store.setSyncState(company.id, { lastError: String(err?.message || err) })
      .catch((e) => log(`could not record sync error: ${e}`));
    throw err;
  }
}

// An invoice whose KSeF number did not arrive before the send call gave up
// is still in flight; without this it would sit as "processing" forever
async function refreshPendingSends({ store, cl }, company, client, accessToken) {
  const pending = store.listInvoices({ companyId: company.id, dir: 'sale' })
    .filter((i) => i.sendState === 'processing' && i.sessionRef && i.invoiceRef);
  for (const inv of pending) {
    try {
      const ksefNumber = await client.waitForKsefNumber({
        accessToken,
        sessionReferenceNumber: inv.sessionRef,
        invoiceReferenceNumber: inv.invoiceRef,
      }, 1);
      if (ksefNumber) await store.updateInvoice(inv.id, { ksefNumber, sendState: 'sent' });
    } catch (err) {
      // Only a real rejection ends the wait; a transient error (network,
      // expired token) must keep the invoice in 'processing' so the next
      // sync retries the status check
      if (err?.ksefRejected) {
        await store.updateInvoice(inv.id, {
          sendState: 'error', sendError: String(err?.message || err), sessionRef: '', invoiceRef: '',
        });
      } else {
        cl?.log?.(`status check for ${inv.number} failed, will retry next sync:`, err);
      }
    }
  }
}

export async function checkSendStatus({ http, store }, company, invoiceId) {
  const inv = store.getInvoice(invoiceId);
  if (!inv?.sessionRef || !inv?.invoiceRef) throw new Error('this invoice has no pending KSeF session');
  const client = new KsefClient({ http, env: company.env || 'prod' });
  const accessToken = await accessTokenFor(http, company);
  try {
    const ksefNumber = await client.waitForKsefNumber({
      accessToken,
      sessionReferenceNumber: inv.sessionRef,
      invoiceReferenceNumber: inv.invoiceRef,
    }, 1);
    return ksefNumber
      ? store.updateInvoice(invoiceId, { ksefNumber, sendState: 'sent' })
      : inv;
  } catch (err) {
    // Persist the verdict so the invoice stops looking in-flight; the
    // rethrow still surfaces the rejection message to the caller
    if (err?.ksefRejected) {
      await store.updateInvoice(invoiceId, {
        sendState: 'error', sendError: String(err?.message || err), sessionRef: '', invoiceRef: '',
      });
    }
    throw err;
  }
}

export async function downloadXml({ http }, company, ksefNumber) {
  const client = new KsefClient({ http, env: company.env || 'prod' });
  const accessToken = await accessTokenFor(http, company);
  return client.downloadInvoiceXml({ accessToken, ksefNumber });
}

// input: {buyerNip, buyerName, buyerAddress1, buyerAddress2, lines, issueDate?,
// sellDate?, paymentTo?, currency?, number?, kind?}
export async function createInvoice({ store }, company, input) {
  const issueDate = assertDate(input.issueDate || today(), 'issueDate');
  if (input.paymentTo) assertDate(input.paymentTo, 'paymentTo');
  if (input.sellDate) assertDate(input.sellDate, 'sellDate');
  const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  const lines = (input.lines || []).map((l) => ({
    name: l.name,
    unit: l.unit || 'szt',
    quantity: num(l.quantity, 1),
    unitNetPrice: num(l.unitNetPrice, 0),
    vatRate: num(l.vatRate, 23),
  }));
  if (!lines.length) throw new Error('at least one line is required');
  if (!input.buyerName) throw new Error('buyer name is required');
  if (lines.some((l) => !l.name)) throw new Error('every line needs a name');

  const totals = computeTotals(lines);
  const net = lines.reduce((s, l) => s + lineNet(l), 0);
  const vat = lines.reduce((s, l) => s + lineVat(l), 0);
  const kind = input.kind || 'vat';
  const number = input.number
    || (kind === 'proforma' ? store.nextNumber({ ...company, numberingPattern: company.proformaPattern || 'PRO {nr}/{mm}/{yyyy}' }, issueDate)
      : store.nextNumber(company, issueDate));

  const record = {
    id: `loc:${company.id}:${crypto.randomUUID()}`,
    src: 'local',
    dir: 'sale',
    number,
    ksefNumber: '',
    issueDate,
    sellDate: input.sellDate || issueDate,
    paymentTo: input.paymentTo || '',
    sellerNip: normalizeNip(company.nip),
    sellerName: company.name,
    buyerNip: normalizeNip(input.buyerNip),
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
  await store.upsertContractors(company.id, [{
    nip: record.buyerNip,
    name: input.buyerName,
    address1: input.buyerAddress1 || '',
    address2: input.buyerAddress2 || '',
  }]);
  return record;
}

export function invoiceToFa3(company, inv) {
  return buildFa3Xml({
    number: inv.number,
    issueDate: inv.issueDate,
    currency: inv.currency,
    paymentTo: inv.paymentTo,
    bankAccount: company.bankAccount,
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
  // Re-sending an in-flight document files it twice, and only a korekta can
  // undo that — check the pending session instead
  if (inv.sendState === 'sending' || inv.sendState === 'processing') {
    throw new Error(`invoice ${inv.number} is already in flight (${inv.sendState}) — check its KSeF status instead of re-sending`);
  }

  const client = new KsefClient({ http, env: company.env || 'prod' });
  const accessToken = await accessTokenFor(http, company);
  const xml = invoiceToFa3(company, inv);

  await store.updateInvoice(invoiceId, { sendState: 'sending', sendError: '' });
  let sent = null;
  try {
    sent = await client.sendInvoice({ accessToken, xml });
    // Once KSeF has accepted the payload the document is filed, so the
    // references are recorded before anything else can fail — losing them
    // would leave a filed invoice looking unsent and invite a duplicate
    await store.updateInvoice(invoiceId, {
      sendState: 'processing',
      sessionRef: sent.sessionReferenceNumber,
      invoiceRef: sent.invoiceReferenceNumber,
    });

    const ksefNumber = await client.waitForKsefNumber({ accessToken, ...sent });
    await client.closeSession({ accessToken, sessionReferenceNumber: sent.sessionReferenceNumber })
      .catch((err) => console.warn('[addon:ksef] close session failed:', err));
    return ksefNumber
      ? store.updateInvoice(invoiceId, { ksefNumber, sendState: 'sent' })
      : store.getInvoice(invoiceId);
  } catch (err) {
    const message = String(err?.message || err);
    // A rejection (schema, decryption) means the document was NOT filed —
    // that is an 'error' the user can fix and re-send; only an unknown
    // failure after submission has to stay 'processing' for a status check
    const inFlight = sent && !err?.ksefRejected;
    await store.updateInvoice(invoiceId, {
      sendState: inFlight ? 'processing' : 'error',
      sendError: message,
      // A dead session must not keep blocking the "Send to KSeF" button —
      // the rejected document was never filed, so a re-send is legitimate
      ...(err?.ksefRejected ? { sessionRef: '', invoiceRef: '' } : {}),
    });
    throw inFlight
      ? new Error(`${message} — the invoice reached KSeF; use "Check KSeF status" rather than re-sending`)
      : err;
  }
}
