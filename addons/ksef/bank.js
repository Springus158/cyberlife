// Bank statements: parsers (per bank), the invoice matcher and the
// month-keyed storage layer. Parsing is deterministic — an iPKO Biznes PDF
// (via the host's pdftotext bridge) yields one head line per operation
// followed by description lines carrying the transfer title.

import { normalizeNip } from './store.js';

// ---- iPKO Biznes (PKO BP) PDF layout ----

// Page 1 indents the table; later pages start at column 0 — the anchor is
// the line shape (date, operation id, type, amount, balance), not indent
const IPKO_HEAD_RE = /^\s*(\d{2}\.\d{2}\.\d{4})\s+(\S{10,25})\s+(.+?)\s{2,}(-?[\d\s]+,\d{2})\s+(-?[\d\s]+,\d{2})\s*$/;
const IPKO_NOISE_RE = /Saldo do przeniesienia|Saldo z przeniesienia|Saldo końcowe|Saldo poprzednie|strona \d|Obroty (MA|WN)|Infolinia|Informacja o Bankowym|Data operacji|Data waluty|Nr rachunku\/karty|Nr IBAN|Rodzaj rachunku|Waluta rachunku|WYCI.G za okres|opłata zgodna|informacje dostępne/;

function plAmount(s) {
  return Number(s.replace(/\s/g, '').replace(',', '.'));
}

function isoDate(ddmmyyyy) {
  const [d, m, y] = ddmmyyyy.split('.');
  return `${y}-${m}-${d}`;
}

export function parseIpkoStatement(text) {
  let account = '';
  let currency = 'PLN';
  let period = '';
  let stmtNo = '';
  const txs = [];
  let cur = null;
  let seq = 0;
  const flush = () => {
    if (cur) {
      cur.desc = cur.descLines.join(' ').replace(/\s+/g, ' ').trim();
      delete cur.descLines;
      txs.push(cur);
    }
    cur = null;
  };
  for (const line of text.split('\n')) {
    const acc = /Nr rachunku\/karty:\s*([\d ]+)/.exec(line);
    if (acc) {
      account = acc[1].replace(/\s/g, '');
      continue;
    }
    const curr = /Waluta rachunku:\s*(\w+)/.exec(line);
    if (curr) {
      currency = curr[1];
      continue;
    }
    const per = /WYCI.G za okres (\d{2}\.\d{2}\.\d{4}) - (\d{2}\.\d{2}\.\d{4})/.exec(line);
    if (per) period = `${per[1]} – ${per[2]}`;
    const nr = /^\s*Nr:\s*(\S+)/.exec(line);
    if (nr) stmtNo = nr[1];
    if (IPKO_NOISE_RE.test(line)) continue;
    const head = IPKO_HEAD_RE.exec(line);
    if (head) {
      flush();
      cur = {
        id: head[2],
        seq: seq++,
        date: isoDate(head[1]),
        valueDate: '',
        type: head[3].trim(),
        amount: plAmount(head[4]),
        saldo: plAmount(head[5]),
        descLines: [],
      };
      continue;
    }
    if (cur) {
      const vd = /^(\d{2}\.\d{2}\.\d{4})\s+/.exec(line.trim());
      if (vd && !cur.valueDate) cur.valueDate = isoDate(vd[1]);
      const s = line.trim().replace(/^\d{2}\.\d{2}\.\d{4}\s+/, '');
      if (s) cur.descLines.push(s);
    }
  }
  flush();
  return { bank: 'PKO BP (iPKO Biznes)', account, currency, period, stmtNo, txs };
}

// Every parser gets a sniff + parse pair; new banks slot in here
const PARSERS = [
  { sniff: (t) => t.includes('iPKO') || /PKO BP/.test(t) || /Nr rachunku\/karty/.test(t), parse: parseIpkoStatement },
];

export function parseStatement(text) {
  const p = PARSERS.find((x) => x.sniff(text));
  if (!p) throw new Error('nierozpoznany format wyciągu — obsługiwane: iPKO Biznes (PDF)');
  return p.parse(text);
}

// ---- matcher ----

function ascii(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toUpperCase();
}

function normToken(s) {
  return ascii(s).replace(/[^A-Z0-9/]/g, '');
}

// Aliases for card/web charges where the statement shows the brand, not the
// invoice issuer's legal name
const NAME_ALIASES = [
  ['AWS', 'AMAZON'], ['AMAZON', 'AMAZON'], ['GOOGLE', 'GOOGLE'],
  ['ALLEGRO', 'ALLEGRO'], ['X-KOM', 'XKOM'], ['ORLEN', 'ORLEN'],
];

export function categorize(tx) {
  const d = ascii(`${tx.type} ${tx.desc}`);
  if (/OPLATA|PROWADZENIE RACHUNKU|PROWIZJA|PRZEJECIE ODPOWIEDZIALNOSCI/.test(d)) return 'opłata bankowa';
  if (/ZUS|US URZAD|URZAD SKARBOWY|PODATEK|VAT-7|PIT|CIT/.test(d)) return 'podatek / ZUS';
  if (/OPERACJA SKARBOWA|FX\d|PRZEWALUT/.test(d)) return 'przewalutowanie';
  if (/WYNAGRODZENIE/.test(d)) return 'wynagrodzenie';
  if (/ODSETKI/.test(d)) return 'odsetki';
  return '';
}

// A transaction matches an invoice by (in order of confidence): the invoice
// number in the transfer title + matching amount, the number alone, or the
// amount + counterparty name. Purely numeric invoice numbers only count on
// word boundaries AND with the amount agreeing — short digit runs appear in
// every card ref number.
export function matchTransactions(txs, invoices) {
  const byNumber = new Map();
  for (const inv of invoices) {
    const key = normToken(inv.number);
    if (key) {
      if (!byNumber.has(key)) byNumber.set(key, []);
      byNumber.get(key).push(inv);
    }
  }
  // An invoice consumed by any amount-based rule in this run cannot be
  // handed to a second transaction — identical amounts would otherwise all
  // point at the same document
  const used = new Set(txs.map((t) => t.invoiceId).filter(Boolean));
  return txs.map((tx) => {
    if (tx.invoiceId || tx.category) return tx;
    const wantDir = tx.amount < 0 ? 'cost' : 'sale';
    const amountOk = (inv) => Math.abs(Math.abs(tx.amount) - inv.gross) < 0.015;
    const descNorm = normToken(tx.desc);
    const descAscii = ascii(tx.desc);

    let best = null;
    let how = '';
    for (const [key, invs] of byNumber) {
      const numeric = !/[A-Z/]/.test(key);
      const present = numeric
        ? new RegExp(`(^|[^0-9])${key}([^0-9]|$)`).test(descAscii.replace(/[^A-Z0-9]/g, ' '))
        : key.length >= 4 && descNorm.includes(key);
      if (!present) continue;
      for (const inv of invs) {
        if (inv.dir !== wantDir) continue;
        if (amountOk(inv)) {
          used.add(inv.id);
          return { ...tx, invoiceId: inv.id, matchedBy: 'numer + kwota', auto: true };
        }
        if (!numeric && key.length >= 6 && !best) {
          best = inv;
          how = 'numer (inna kwota)';
        }
      }
    }
    if (best) {
      used.add(best.id);
      return { ...tx, invoiceId: best.id, matchedBy: how, auto: true };
    }

    // Recurring identical amounts (monthly retainers) must land on the
    // invoice issued closest to the operation date, not the oldest unpaid
    const txTime = Date.parse(tx.date);
    const dateDist = (inv) => (inv.issueDate ? Math.abs(Date.parse(inv.issueDate) - txTime) : Number.MAX_SAFE_INTEGER);
    const byCloseness = [...invoices].sort((a, b) => dateDist(a) - dateDist(b));
    for (const inv of byCloseness) {
      if (inv.dir !== wantDir || !amountOk(inv) || used.has(inv.id)) continue;
      const other = ascii(wantDir === 'cost' ? inv.sellerName : inv.buyerName);
      const otherNip = wantDir === 'cost' ? inv.sellerNip : inv.buyerNip;
      if (otherNip && normalizeNip(tx.desc).includes(otherNip)) {
        used.add(inv.id);
        return { ...tx, invoiceId: inv.id, matchedBy: 'NIP + kwota', auto: true };
      }
      const words = other.split(/[^A-Z0-9]+/).filter((w) => w.length >= 5);
      if (words.some((w) => descAscii.includes(w))) {
        used.add(inv.id);
        return { ...tx, invoiceId: inv.id, matchedBy: 'kontrahent + kwota', auto: true };
      }
      if (NAME_ALIASES.some(([mark, who]) => descAscii.includes(mark) && other.replace(/[^A-Z0-9]/g, '').includes(who))) {
        used.add(inv.id);
        return { ...tx, invoiceId: inv.id, matchedBy: 'kontrahent + kwota', auto: true };
      }
    }

    // Last resort for card/web charges whose merchant name has nothing in
    // common with the issuer's legal name (e.g. a shop domain): a UNIQUE
    // amount among invoices issued within two weeks of the operation.
    // Uniqueness is the safety valve — two candidates mean no match.
    const near = invoices.filter((inv) => inv.dir === wantDir && amountOk(inv) && !used.has(inv.id)
      && inv.issueDate && Math.abs(Date.parse(inv.issueDate) - Date.parse(tx.date)) <= 14 * 86400e3);
    if (near.length === 1) {
      used.add(near[0].id);
      return { ...tx, invoiceId: near[0].id, matchedBy: 'kwota + data (do weryfikacji)', auto: true };
    }

    const category = categorize(tx);
    return category ? { ...tx, category, auto: true } : tx;
  });
}
