// Data layer on top of cl.storage. Invoices are slim records chunked per
// company+quarter — the app caps addon storage at 256 keys x 64KB, so
// full line items are kept only for invoices created in the addon.
//
// Invoice record: {id, src: ksef|fakturownia|local, dir: sale|cost, number,
// ksefNumber, issueDate, sellDate, paymentTo, sellerNip, sellerName,
// buyerNip, buyerName, net, vat, gross, currency, paid, paidDate, kind,
// lines?, sendState?}

export function createStore(cl) {
  let cache = null;

  async function init() {
    cache = await cl.storage.all();
  }

  async function put(key, value) {
    cache[key] = value;
    await cl.storage.set(key, value);
  }

  // ---- companies ----
  // {id, name, nip, env, ksefToken, address1, address2, bankAccount,
  //  numberingPattern, fakturownia: {subdomain, token}}

  function companies() {
    return cache.companies || [];
  }

  async function saveCompany(company) {
    const list = companies().slice();
    const i = list.findIndex((c) => c.id === company.id);
    if (i >= 0) list[i] = company;
    else list.push({ ...company, id: company.id || `c${Date.now()}` });
    await put('companies', list);
    return list;
  }

  async function deleteCompany(id) {
    await put('companies', companies().filter((c) => c.id !== id));
  }

  function company(id) {
    return companies().find((c) => c.id === id) || null;
  }

  // ---- invoice chunks ----

  function chunkKey(companyId, issueDate) {
    const [y, m] = String(issueDate || '1970-01').split('-').map(Number);
    return `inv:${companyId}:${y}-Q${Math.floor(((m || 1) - 1) / 3) + 1}`;
  }

  function chunkKeysFor(companyId) {
    const prefix = `inv:${companyId}:`;
    return Object.keys(cache).filter((k) => k.startsWith(prefix)).sort();
  }

  function sameInvoice(a, b) {
    if (a.ksefNumber && b.ksefNumber) return a.ksefNumber === b.ksefNumber;
    return a.number && a.number === b.number && a.sellerNip === b.sellerNip;
  }

  // Merge policy: Fakturownia/local records are richer (payment state, kind,
  // lines) so their fields win; the KSeF number is taken from whichever side
  // has it. Returns {added, updated}.
  async function upsertInvoices(companyId, records) {
    const byChunk = new Map();
    for (const rec of records) {
      const key = chunkKey(companyId, rec.issueDate);
      if (!byChunk.has(key)) byChunk.set(key, []);
      byChunk.get(key).push(rec);
    }
    let added = 0;
    let updated = 0;
    for (const [key, recs] of byChunk) {
      const list = (cache[key] || []).slice();
      for (const rec of recs) {
        const i = list.findIndex((x) => sameInvoice(x, rec));
        if (i < 0) {
          list.push(rec);
          added++;
          continue;
        }
        const existing = list[i];
        const preferExisting = existing.src !== 'ksef' && rec.src === 'ksef';
        const merged = preferExisting ? { ...rec, ...existing } : { ...existing, ...rec };
        merged.ksefNumber = existing.ksefNumber || rec.ksefNumber || '';
        merged.paid = existing.paid || rec.paid || false;
        merged.paidDate = existing.paidDate || rec.paidDate || '';
        if (JSON.stringify(merged) !== JSON.stringify(existing)) updated++;
        list[i] = merged;
      }
      list.sort((a, b) => String(b.issueDate).localeCompare(String(a.issueDate)));
      await put(key, list);
    }
    return { added, updated };
  }

  function listInvoices({ companyId, dir, unpaid, from, to, query, limit } = {}) {
    const ids = companyId ? [companyId] : companies().map((c) => c.id);
    let out = [];
    for (const cid of ids) {
      for (const key of chunkKeysFor(cid)) {
        for (const inv of cache[key] || []) {
          out.push({ ...inv, companyId: cid });
        }
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
        return next[i];
      }
    }
    throw new Error(`invoice ${id} not found`);
  }

  // ---- numbering ----
  // Pattern tokens mirror Fakturownia: {nr} sequence, {mm} month, {yyyy} year.
  // The sequence resets per month when {mm} is present, else per year.

  function nextNumber(comp, issueDate) {
    const pattern = comp.numberingPattern || '{nr}/{mm}/{yyyy}';
    const [y, m] = issueDate.split('-');
    const resolved = pattern.replaceAll('{mm}', m).replaceAll('{yyyy}', y);
    const re = new RegExp(`^${resolved.split('{nr}').map((s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('(\\d+)')}$`);
    let max = 0;
    for (const inv of listInvoices({ companyId: comp.id, dir: 'sale' })) {
      const match = re.exec(inv.number || '');
      if (match) max = Math.max(max, parseInt(match[1], 10));
    }
    return resolved.replace('{nr}', String(max + 1));
  }

  // ---- contractors ----

  function contractors(companyId) {
    return cache[`contractors:${companyId}`] || [];
  }

  async function upsertContractor(companyId, contractor) {
    if (!contractor.name) return;
    const list = contractors(companyId).slice();
    const i = list.findIndex((c) => (c.nip && c.nip === contractor.nip) || c.name === contractor.name);
    if (i >= 0) list[i] = { ...list[i], ...contractor };
    else list.push(contractor);
    list.sort((a, b) => a.name.localeCompare(b.name));
    await put(`contractors:${companyId}`, list.slice(0, 500));
  }

  // ---- sync cursors ----

  function syncState(companyId) {
    return cache[`sync:${companyId}`] || {};
  }

  async function setSyncState(companyId, patch) {
    await put(`sync:${companyId}`, { ...syncState(companyId), ...patch });
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
    upsertContractor,
    syncState,
    setSyncState,
  };
}
