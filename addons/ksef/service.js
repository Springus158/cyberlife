// Domain operations: KSeF sync (incremental, PermanentStorage cursor),
// invoice creation with Fakturownia-style numbering, and FA(3) submission.

import { KsefClient } from './ksef-client.js';
import { buildFa3Xml, computeTotals, lineNet, lineVat } from './fa3.js';
import { assertDate, normalizeNip } from './store.js';
import { extractFields } from './files.js';
import {
  fakturowniaMode, createInFakturownia, createCostInFakturownia, fvSendToKsef, fvGovStatus, fvSetPaid,
  fvSetApproval, importFromFakturownia, fetchFakturowniaClients, fetchFvPdf,
} from './fakturownia.js';

// Fakturownia first, so a rejected push never leaves the local mirror
// claiming a status Fakturownia does not have
export async function setApproval(deps, company, invoiceId, approval) {
  const inv = deps.store.getInvoice(invoiceId);
  if (!inv) throw new Error(`invoice ${invoiceId} not found`);
  if (fakturowniaMode(company) === 'dual' && inv.fvId) {
    await fvSetApproval(deps, company, inv.fvId, approval);
  }
  return deps.store.updateInvoice(invoiceId, { fvApproval: approval });
}

export function r2Configured(store, companyId) {
  const cfg = store.r2Config(companyId);
  return !!(cfg?.endpoint && cfg?.bucket && cfg?.accessKeyId && cfg?.secretAccessKey);
}

// The blob-store paths carry no company segment, so a company's backup is
// defined by its registries: invoice files + original statements
export function r2KeysFor(store, companyId) {
  return [...new Set([
    ...store.files(companyId).map((f) => f.key),
    ...store.stmtFiles(companyId).map((s) => s.key),
  ])].filter(Boolean);
}

// Mirror one company's files into its R2 bucket and persist the resulting
// manifest, so every file record can show whether its bytes are safe in
// the bucket. One job per company host-side; a start during a run just
// re-attaches.
export async function runR2Backup(deps, company, { onProgress } = {}) {
  const { store, cl } = deps;
  if (!r2Configured(store, company.id)) {
    throw new Error(`Backup R2 firmy ${company.name} nie jest skonfigurowany — uzupełnij dane w Ustawieniach → KSeF`);
  }
  const cfg = store.r2Config(company.id);
  const opts = { job: company.id, keys: r2KeysFor(store, company.id) };
  await cl.backup('start', cfg, opts);
  let st;
  do {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    st = await cl.backup('status', undefined, { job: company.id });
    onProgress?.(st);
  } while (st.running);
  if (st.objects) {
    const entries = Object.entries(st.objects).map(([key, o]) => ({ key, etag: o.etag, size: o.size }));
    await store.saveR2Manifest(company.id, entries, {
      at: st.finishedAt || new Date().toISOString(),
      checked: st.checked,
      uploaded: st.uploaded,
      failed: st.failed,
      error: st.lastError || '',
    });
  }
  return st;
}

function autoR2Backup(deps, company) {
  if (!deps.store.r2Config(company.id)?.auto || !r2Configured(deps.store, company.id)) return;
  runR2Backup(deps, company)
    .then((st) => deps.cl?.log(`R2 auto-backup ${company.name}: ${st.uploaded} wysłanych, ${st.failed} błędów`))
    .catch((err) => deps.cl?.log('R2 auto-backup failed:', err));
}

// Pull the rendered PDF of a Fakturownia document into the file archive
// and register it against the invoice — the permanent copy, not a one-off
export async function saveFvPdfToArchive(deps, company, inv) {
  const { store } = deps;
  const b64 = await fetchFvPdf(deps, company, inv.fvId);
  const key = `files/fv/${inv.fvId}.pdf`;
  await deps.cl.putDataFile(key, b64);
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  const rec = {
    id: sha.slice(0, 16),
    sha256: sha,
    key,
    name: `Fakturownia-${String(inv.number || inv.fvId).replace(/[^\w-]+/g, '_')}.pdf`,
    month: String(inv.issueDate || '').slice(0, 7),
    source: 'fakturownia',
    invoiceId: inv.id,
    matchedBy: 'PDF z Fakturowni',
    number: inv.number || '',
    docDate: inv.issueDate || '',
    gross: inv.gross,
    currency: inv.currency,
  };
  await store.upsertFiles(company.id, [rec]);
  return rec;
}

// Archive the original statement PDF next to its parsed transactions —
// the accountant email attaches originals from here
export async function archiveStatementOriginal(deps, company, dataBase64, name, st) {
  const { store } = deps;
  const bytes = Uint8Array.from(atob(dataBase64), (c) => c.charCodeAt(0));
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  if (store.stmtFiles(company.id).some((e) => e.sha256 === sha)) return { archived: false, duplicate: true };
  let months = [...new Set((st?.txs || []).map((t) => t.date.slice(0, 7)))].sort();
  if (!months.length) {
    // Empty statements (unused VAT account) still belong to the month in
    // their period header — never to "always"
    const m = /(\d{2})\.(\d{2})\.(\d{4})/.exec(st?.period || '');
    if (m) months = [`${m[3]}-${m[2]}`];
  }
  const safe = String(name || 'wyciag.pdf').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 70);
  const key = `statements/${(months[0] || 'inne').slice(0, 4)}/${sha.slice(0, 12)}-${safe}`;
  await deps.cl.putDataFile(key, dataBase64);
  await store.addStmtFile(company.id, {
    key, name, sha256: sha, account: st?.account || '', currency: st?.currency || '',
    period: st?.period || '', months, ops: st ? st.txs.length : null,
  });
  return { archived: true, key };
}

// Every sales invoice mirrored from Fakturownia should carry its PDF in
// the archive; runs bounded so a routine sync never stalls on a large
// backlog — the remainder is picked up by the next run
export async function backfillFvSalePdfs(deps, company, { limit = 20 } = {}) {
  const { store, cl } = deps;
  if (fakturowniaMode(company) !== 'dual') return { added: 0, remaining: 0, errors: [] };
  const have = store.fileByInvoice(company.id);
  const missing = store.listInvoices({ companyId: company.id, dir: 'sale' })
    .filter((i) => i.fvId && i.kind !== 'proforma' && !have.has(i.id));
  let added = 0;
  const errors = [];
  for (const inv of missing.slice(0, limit)) {
    try {
      await saveFvPdfToArchive(deps, company, inv);
      added++;
    } catch (err) {
      cl.log('backfillFvSalePdfs failed for', inv.number, err);
      errors.push(`${inv.number}: ${err.message || err}`);
    }
  }
  return { added, remaining: Math.max(0, missing.length - added - errors.length), errors };
}

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
    // Dual mode refreshes Fakturownia first (new invoices, payment flips in
    // both directions), so the KSeF pass below merges into fresh records.
    // Only the recent window — the full history came from the import.
    if (fakturowniaMode(company) === 'dual' && store.syncState(company.id).fakturowniaImportedAt) {
      await importFromFakturownia(deps, company, null, { period: 'last_12_months' })
        .catch((err) => log(`Fakturownia refresh failed (KSeF sync continues): ${err?.message || err}`));
      await fetchFakturowniaClients(deps, company)
        .catch((err) => log(`Fakturownia clients refresh failed: ${err?.message || err}`));
      await backfillFvSalePdfs(deps, company, { limit: 20 })
        .then((r) => { if (r.added) log(`Fakturownia PDFs archived: ${r.added} (${r.remaining} remaining)`); })
        .catch((err) => log(`Fakturownia PDF backfill failed: ${err?.message || err}`));
    }
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
    // Fire-and-forget: the sync result must not wait on bucket uploads
    autoR2Backup(deps, company);
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

// Payment state lives in two places in dual mode: locally and in
// Fakturownia — Fakturownia first, so a failed push never leaves the two
// silently diverged
export async function setPaid(deps, company, invoiceId, paid, paidDate) {
  const { store } = deps;
  const inv = store.getInvoice(invoiceId);
  if (!inv) throw new Error(`invoice ${invoiceId} not found`);
  if (company && fakturowniaMode(company) === 'dual' && inv.fvId) {
    await fvSetPaid(deps, company, inv.fvId, paid, paidDate || today());
  }
  return store.updateInvoice(invoiceId, {
    paid: Boolean(paid),
    paidAmount: paid ? inv.gross : 0,
    paidDate: paid ? (paidDate || today()) : '',
  });
}

export async function checkSendStatus(deps, company, invoiceId) {
  const { http, store } = deps;
  const inv = store.getInvoice(invoiceId);
  if (fakturowniaMode(company) === 'dual' && inv?.fvId && !inv.ksefNumber) {
    const st = await fvGovStatus(deps, company, inv.fvId);
    if (st?.gov_id) return store.updateInvoice(invoiceId, { ksefNumber: st.gov_id, sendState: 'sent' });
    if (st?.gov_status && st.gov_status.includes('error')) {
      const details = Array.isArray(st.gov_error_messages) ? st.gov_error_messages.join('; ') : '';
      await store.updateInvoice(invoiceId, { sendState: 'error', sendError: `${st.gov_status}${details ? `: ${details}` : ''}` });
    }
    return store.getInvoice(invoiceId);
  }
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
// Cost record created from an archived document (Pliki page / attach_file
// tool). In dual mode the expense goes to Fakturownia first — its id lands
// on the record — and a Fakturownia failure never blocks the local record;
// the caller shows it as a warning instead.
// Older file records (imported before seller extraction existed) lack the
// seller fields, so every invoice-creation path re-reads the stored PDF
// and fills in what is missing — one extractor, no matter how the file got
// in or how the invoice is being made
export async function ensureFileExtraction(deps, company, rec) {
  const { store, cl } = deps;
  if (rec.sellerName && (rec.nip || rec.vatId || rec.sellerAddress1)) return rec;
  try {
    const res = await fetch(cl.dataFileUrl(rec.key));
    if (!res.ok) throw new Error(`stored file fetch: ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    let b64 = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      b64 += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    const fields = extractFields(await cl.pdfText(btoa(b64)), company.nip);
    const patch = {};
    const fill = (key, value) => {
      if (!rec[key] && value) patch[key] = value;
    };
    fill('nip', fields.nips[0]);
    fill('vatId', fields.vatIds?.[0]);
    fill('sellerName', fields.seller?.name);
    fill('sellerAddress1', fields.seller?.address1);
    fill('sellerAddress2', fields.seller?.address2);
    fill('number', fields.numbers[0]);
    fill('docDate', fields.dates[0]);
    fill('gross', fields.amounts.strong[0]);
    fill('currency', fields.currency);
    if (rec.vatRate == null && fields.vatRate != null) patch.vatRate = fields.vatRate;
    if (Object.keys(patch).length) {
      return await store.updateFileRec(company.id, rec.id, patch);
    }
  } catch (err) {
    cl.log('ensureFileExtraction: re-extraction failed (scan?):', err);
  }
  return rec;
}

// An expense document sent without a matching client makes Fakturownia
// invent a new one from the buyer name — dig up the existing client first
function fvClientFor(store, company, data) {
  const tax = normalizeNip(data.sellerNip || data.sellerVatId);
  const name = String(data.sellerName || '').trim().toLowerCase();
  return store.fvClients(company.id).find((c) =>
    (tax && c.nip === tax) || (name && c.name.trim().toLowerCase() === name)) || null;
}

export async function createCostFromFile(deps, company, data) {
  assertDate(data.issueDate, 'issueDate');
  const gross = Number(data.gross) || 0;
  const numericVat = typeof data.vatRate === 'number' && Number.isFinite(data.vatRate);
  const net = numericVat ? Math.round((gross / (1 + data.vatRate / 100)) * 100) / 100 : gross;
  const record = {
    id: `file:${data.fileId}`,
    src: 'file',
    dir: 'cost',
    kind: 'vat',
    number: data.number || '',
    issueDate: data.issueDate,
    sellerNip: normalizeNip(data.sellerNip),
    sellerName: data.sellerName,
    ...(data.sellerVatId ? { sellerVatId: data.sellerVatId } : {}),
    ...(data.sellerAddress1 ? { sellerAddress1: data.sellerAddress1 } : {}),
    ...(data.sellerAddress2 ? { sellerAddress2: data.sellerAddress2 } : {}),
    buyerNip: company.nip,
    buyerName: company.name,
    net,
    vat: Math.round((gross - net) * 100) / 100,
    gross,
    currency: data.currency || 'PLN',
    paid: !!data.paid,
    ...(data.paid && data.paidDate ? { paidDate: data.paidDate } : {}),
  };
  let fv = null;
  let fvError = '';
  if (fakturowniaMode(company) === 'dual') {
    try {
      const client = fvClientFor(deps.store, company, data);
      fv = await createCostInFakturownia(deps, company, {
        ...data, gross, sellerNip: record.sellerNip, ...(client ? { clientId: client.fvId } : {}),
      });
      record.fvId = fv.id;
      if (!record.number && fv.number) record.number = fv.number;
    } catch (err) {
      deps.cl.log('createCostFromFile: Fakturownia expense create failed:', err);
      fvError = String(err?.message || err);
    }
  }
  await deps.store.upsertInvoices(company.id, [record]);
  return { record, fv, fvError };
}

export async function createInvoice(deps, company, input) {
  const { store } = deps;
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
  const dual = fakturowniaMode(company) === 'dual';

  // Dual mode: the document is created in Fakturownia and its number (from
  // the account's own numbering) is authoritative — a locally generated one
  // would collide with the sequence invoices issued there already use
  let fvCreated = null;
  if (dual) {
    fvCreated = await createInFakturownia(deps, company, { ...input, kind, issueDate }, lines);
  }
  const number = fvCreated?.number
    || input.number
    || (kind === 'proforma' ? store.nextNumber({ ...company, numberingPattern: company.proformaPattern || 'PRO {nr}/{mm}/{yyyy}' }, issueDate)
      : store.nextNumber(company, issueDate));

  const record = {
    id: fvCreated ? `fv:${company.id}:${fvCreated.id}` : `loc:${company.id}:${crypto.randomUUID()}`,
    ...(fvCreated ? { fvId: fvCreated.id } : {}),
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

// Dual mode: Fakturownia carries the document to KSeF; we trigger the send
// and poll its gov_* fields for the assigned number
async function sendViaFakturownia(deps, company, inv) {
  const { store } = deps;
  await store.updateInvoice(inv.id, { sendState: 'sending', sendError: '' });
  try {
    await fvSendToKsef(deps, company, inv.fvId);
    await store.updateInvoice(inv.id, { sendState: 'processing' });
    for (let i = 0; i < 10; i++) {
      const st = await fvGovStatus(deps, company, inv.fvId);
      if (st?.gov_id) {
        return store.updateInvoice(inv.id, { ksefNumber: st.gov_id, sendState: 'sent' });
      }
      if (st?.gov_status && st.gov_status.includes('error')) {
        const details = Array.isArray(st.gov_error_messages) ? st.gov_error_messages.join('; ') : '';
        throw Object.assign(new Error(`Fakturownia → KSeF ${st.gov_status}${details ? `: ${details}` : ''}`), { ksefRejected: true });
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return store.getInvoice(inv.id);
  } catch (err) {
    await store.updateInvoice(inv.id, {
      sendState: err?.ksefRejected ? 'error' : 'processing',
      sendError: String(err?.message || err),
    });
    throw err;
  }
}

export async function sendToKsef(deps, company, invoiceId) {
  const { http, store } = deps;
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
  if (fakturowniaMode(company) === 'dual' && inv.fvId) {
    return sendViaFakturownia(deps, company, inv);
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
