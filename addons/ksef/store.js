// Data layer on top of cl.storage. Invoices are slim records chunked per
// company+quarter — the app caps addon storage at 256 keys x 64KB, so a
// quarter that outgrows the value cap spills into "#2", "#3" … parts, and
// full line items are kept only for invoices created in the addon.
//
// Invoice record: {id, src: ksef|fakturownia|local, dir: sale|cost, number,
// ksefNumber, issueDate, sellDate, paymentTo, sellerNip, sellerName,
// buyerNip, buyerName, net, vat, gross, currency, paid, paidDate, kind,
// lines?, sendState?}

const MAX_CHUNK_BYTES = 52 * 1024; // below the host's 64KB value cap
const utf8 = new TextEncoder();
const MAX_CONTRACTORS = 500;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function normalizeNip(nip) {
  return String(nip || '').replace(/\D/g, '');
}

export function assertDate(value, field) {
  if (!DATE_RE.test(String(value || ''))) {
    throw new Error(`${field} must be YYYY-MM-DD, got "${value}"`);
  }
  return value;
}

export function createStore(cl) {
  let cache = null;

  async function init() {
    cache = await cl.storage.all();
  }

  // Persist first: a value rejected by the host (size or key-count cap) must
  // not linger in the cache, or the UI reports invoices that were never saved
  async function put(key, value) {
    await cl.storage.set(key, value);
    cache[key] = value;
  }

  async function drop(key) {
    await cl.storage.remove(key);
    delete cache[key];
  }

  // ---- companies ----

  function companies() {
    return cache.companies || [];
  }

  async function saveCompany(company) {
    const normalized = { ...company, nip: normalizeNip(company.nip) };
    const list = companies().slice();
    const i = list.findIndex((c) => c.id === normalized.id);
    if (i >= 0) list[i] = normalized;
    else list.push({ ...normalized, id: normalized.id || `c${Date.now()}` });
    await put('companies', list);
    return list;
  }

  async function deleteCompany(id) {
    for (const key of Object.keys(cache)) {
      if (key.startsWith(`inv:${id}:`) || key === `contractors:${id}` || key === `sync:${id}` || key === `fvinfo:${id}`) {
        await drop(key);
      }
    }
    await put('companies', companies().filter((c) => c.id !== id));
  }

  function company(id) {
    return companies().find((c) => c.id === id) || null;
  }

  // ---- invoice chunks ----

  function quarterOf(issueDate) {
    const [y, m] = String(issueDate || '').split('-').map(Number);
    if (!y || !m || m < 1 || m > 12) return null;
    return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
  }

  function chunkPrefix(companyId, issueDate) {
    return `inv:${companyId}:${quarterOf(issueDate) || 'undated'}`;
  }

  function chunkKeysFor(companyId) {
    return Object.keys(cache).filter((k) => k.startsWith(`inv:${companyId}:`)).sort();
  }

  function partsOf(prefix) {
    return Object.keys(cache)
      .filter((k) => k === prefix || k.startsWith(`${prefix}#`))
      .sort();
  }

  function sameInvoice(a, b) {
    if (a.dir !== b.dir) return false;
    if (a.ksefNumber && b.ksefNumber) return a.ksefNumber === b.ksefNumber;
    if (!a.number || a.number !== b.number) return false;
    // Invoice numbers restart per issuer, so a number alone identifies
    // nothing — require a matching party, or failing that the same document
    if (a.sellerNip && b.sellerNip) return a.sellerNip === b.sellerNip;
    return a.issueDate === b.issueDate && a.gross === b.gross;
  }

  // Fakturownia/local records carry payment state, kind and lines that KSeF
  // metadata lacks, so they win the merge; "local" additionally survives as
  // the source, or the invoice would lose its send/print actions
  function mergeInvoice(existing, incoming) {
    const preferExisting = existing.src !== 'ksef' && incoming.src === 'ksef';
    const merged = preferExisting ? { ...incoming, ...existing } : { ...existing, ...incoming };
    merged.src = existing.src === 'local' ? 'local' : merged.src;
    merged.id = existing.id;
    merged.ksefNumber = existing.ksefNumber || incoming.ksefNumber || '';
    merged.fvId = existing.fvId || incoming.fvId || undefined;
    // Fakturownia is the payment authority when it delivered the record (in
    // dual mode our own paid toggles are pushed there first), so its state
    // replaces ours — including back to unpaid. KSeF knows nothing about
    // payments, so its records must never clear a local flag.
    if (incoming.src === 'fakturownia') {
      merged.paid = incoming.paid || false;
      merged.paidDate = incoming.paidDate || '';
    } else {
      merged.paid = existing.paid || incoming.paid || false;
      merged.paidDate = existing.paidDate || incoming.paidDate || '';
    }
    merged.lines = existing.lines || incoming.lines;
    // "seen" marks arrival, so a re-fetch of the same invoice must not make
    // it look new to the today widget
    merged.seen = existing.seen || incoming.seen || '';
    return merged;
  }

  // Writes a quarter back, splitting across "#n" parts so no single value
  // approaches the host's 64KB cap
  async function writeChunk(prefix, list) {
    list.sort((a, b) => String(b.issueDate).localeCompare(String(a.issueDate)));
    // Sizes are exact and incremental: JSON.stringify of an array is
    // '[' + records joined by ',' + ']', and the cap is UTF-8 bytes (the
    // host's limit — Polish diacritics take two per character)
    const parts = [];
    let current = [];
    let currentBytes = 2;
    for (const rec of list) {
      const recBytes = utf8.encode(JSON.stringify(rec)).length;
      if (current.length && currentBytes + recBytes + 1 > MAX_CHUNK_BYTES) {
        parts.push(current);
        current = [];
        currentBytes = 2;
      }
      currentBytes += recBytes + (current.length ? 1 : 0);
      current.push(rec);
    }
    parts.push(current);

    for (let i = 0; i < parts.length; i++) {
      await put(i === 0 ? prefix : `${prefix}#${i + 1}`, parts[i]);
    }
    for (const stale of partsOf(prefix)) {
      const index = stale === prefix ? 0 : Number(stale.split('#')[1]) - 1;
      if (index >= parts.length) await drop(stale);
    }
  }

  async function upsertInvoices(companyId, records) {
    const byChunk = new Map();
    for (const rec of records) {
      const prefix = chunkPrefix(companyId, rec.issueDate);
      if (!byChunk.has(prefix)) byChunk.set(prefix, []);
      byChunk.get(prefix).push(rec);
    }
    let added = 0;
    let updated = 0;
    for (const [prefix, recs] of byChunk) {
      const list = partsOf(prefix).flatMap((k) => cache[k] || []);
      for (const rec of recs) {
        const i = list.findIndex((x) => sameInvoice(x, rec));
        if (i < 0) {
          list.push(rec);
          added++;
          continue;
        }
        const merged = mergeInvoice(list[i], rec);
        if (JSON.stringify(merged) !== JSON.stringify(list[i])) updated++;
        list[i] = merged;
      }
      await writeChunk(prefix, list);
    }
    return { added, updated };
  }

  function listInvoices({ companyId, dir, unpaid, from, to, query, limit } = {}) {
    const ids = companyId ? [companyId] : companies().map((c) => c.id);
    let out = [];
    for (const cid of ids) {
      for (const key of chunkKeysFor(cid)) {
        for (const inv of cache[key] || []) out.push({ ...inv, companyId: cid });
      }
    }
    if (dir) out = out.filter((i) => i.dir === dir);
    if (unpaid) out = out.filter((i) => !i.paid && i.kind !== 'proforma');
    if (from) out = out.filter((i) => i.issueDate >= from);
    if (to) out = out.filter((i) => i.issueDate <= to);
    if (query) {
      const q = query.toLowerCase();
      out = out.filter((i) =>
        [i.number, i.ksefNumber, i.sellerName, i.buyerName, i.sellerNip, i.buyerNip]
          .some((v) => String(v || '').toLowerCase().includes(q)));
    }
    out.sort((a, b) => String(b.issueDate).localeCompare(String(a.issueDate)));
    return limit ? out.slice(0, limit) : out;
  }

  function getInvoice(id) {
    return listInvoices().find((i) => i.id === id) || null;
  }

  async function updateInvoice(id, patch) {
    for (const cid of companies().map((c) => c.id)) {
      for (const key of chunkKeysFor(cid)) {
        const list = cache[key] || [];
        const i = list.findIndex((x) => x.id === id);
        if (i < 0) continue;
        const next = list.slice();
        next[i] = { ...next[i], ...patch };
        await put(key, next);
        return { ...next[i], companyId: cid };
      }
    }
    throw new Error(`invoice ${id} not found`);
  }

  // ---- numbering ----
  // Pattern tokens mirror Fakturownia: {nr} sequence, {mm} month, {yyyy}
  // year. The sequence continues from the highest number already issued
  // under the same resolved prefix, keeping any zero padding it used.

  function nextNumber(comp, issueDate) {
    assertDate(issueDate, 'issueDate');
    const pattern = comp.numberingPattern || '{nr}/{mm}/{yyyy}';
    if (!pattern.includes('{nr}')) {
      throw new Error(`numbering pattern "${pattern}" has no {nr} — every invoice would get the same number`);
    }
    const [y, m] = issueDate.split('-');
    const resolved = pattern.replaceAll('{mm}', m).replaceAll('{yyyy}', y);
    const re = new RegExp(`^${resolved.split('{nr}').map((s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('(\\d+)')}$`);
    let max = 0;
    let width = 0;
    for (const inv of listInvoices({ companyId: comp.id, dir: 'sale' })) {
      const match = re.exec(inv.number || '');
      if (!match) continue;
      const n = parseInt(match[1], 10);
      if (n > max) {
        max = n;
        width = match[1].length;
      }
    }
    return resolved.replace('{nr}', String(max + 1).padStart(width, '0'));
  }

  // ---- contractors ----

  function contractors(companyId) {
    return cache[`contractors:${companyId}`] || [];
  }

  // Batched on purpose: one storage round-trip per invoice would mean
  // thousands of IPC calls during a history import
  async function upsertContractors(companyId, incoming) {
    const list = contractors(companyId).slice();
    for (const c of incoming) {
      if (!c.name) continue;
      const nip = normalizeNip(c.nip);
      const i = list.findIndex((x) => (nip && normalizeNip(x.nip) === nip) || x.name === c.name);
      if (i >= 0) list[i] = { ...list[i], ...c, nip };
      else list.push({ ...c, nip });
    }
    const kept = list.slice(-MAX_CONTRACTORS);
    kept.sort((a, b) => a.name.localeCompare(b.name));
    await put(`contractors:${companyId}`, kept);
  }

  // ---- sync cursors ----

  function syncState(companyId) {
    return cache[`sync:${companyId}`] || {};
  }

  async function setSyncState(companyId, patch) {
    await put(`sync:${companyId}`, { ...syncState(companyId), ...patch });
  }

  // ---- Fakturownia account snapshot (read-only display) ----

  function fvInfo(companyId) {
    return cache[`fvinfo:${companyId}`] || null;
  }

  async function setFvInfo(companyId, info) {
    await put(`fvinfo:${companyId}`, info);
  }

  return {
    init,
    companies,
    company,
    saveCompany,
    deleteCompany,
    upsertInvoices,
    listInvoices,
    getInvoice,
    updateInvoice,
    nextNumber,
    contractors,
    upsertContractors,
    syncState,
    setSyncState,
    fvInfo,
    setFvInfo,
  };
}
