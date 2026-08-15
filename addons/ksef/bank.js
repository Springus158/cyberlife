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

// iPKO "HISTORIA BIEŻĄCA" export (account history print, not a formal
// statement): two head lines per operation — date + title + type + amount,
// then value date + balance — followed by detail lines
// Money amounts group thousands with a SINGLE space — a looser digit
// pattern would swallow reference numbers standing before the amount
const HIST_AMOUNT = String.raw`-?\d{1,3}(?: \d{3})*,\d{2}`;
const HIST_HEAD_RE = new RegExp(`^(\\d{4}-\\d{2}-\\d{2})\\s{2,}(.*?)\\s{2,}(${HIST_AMOUNT}) (PLN|EUR|USD|GBP|CHF)$`);
const HIST_SECOND_RE = new RegExp(`^(\\d{4}-\\d{2}-\\d{2})\\s{2,}(.*?)\\s*(${HIST_AMOUNT}) (?:PLN|EUR|USD|GBP|CHF)$`);

export function parseIpkoHistory(text) {
  let account = '';
  let currency = 'PLN';
  let from = '';
  let to = '';
  const txs = [];
  let cur = null;
  let seq = 0;
  const flush = () => {
    if (cur) {
      const idMatch = /Identyfikator transakcji:\s*(\d+)/.exec(cur.descLines.join(' '))
        || /Numer referencyjny:\s*(\S+)/.exec(cur.descLines.join(' '));
      cur.id = idMatch ? idMatch[1] : `${cur.date}:${cur.amount}:${cur.saldo}`;
      cur.desc = cur.descLines.join(' ').replace(/\s+/g, ' ').trim();
      delete cur.descLines;
      txs.push(cur);
    }
    cur = null;
  };
  for (const line of text.split('\n')) {
    const acc = /Rachunek:\s*.*?((?:\d[ ]?){26})/.exec(line);
    if (acc) {
      account = acc[1].replace(/\s/g, '');
      continue;
    }
    const f = /Data operacji od:\s*(\d{4}-\d{2}-\d{2})/.exec(line);
    if (f) from = f[1];
    const t = /Data operacji do:\s*(\d{4}-\d{2}-\d{2})/.exec(line);
    if (t) to = t[1];
    const head = HIST_HEAD_RE.exec(line.trimEnd());
    if (head && cur === null) {
      const mid = head[2].split(/\s{2,}/);
      cur = {
        seq: seq++,
        date: head[1],
        valueDate: '',
        type: mid.length > 1 ? mid[mid.length - 1].trim() : '',
        amount: plAmount(head[3]),
        saldo: null,
        descLines: mid.length ? [mid[0].trim()] : [],
      };
      currency = head[4];
      continue;
    }
    if (cur && cur.saldo === null) {
      const second = HIST_SECOND_RE.exec(line.trimEnd())
        || /^(\d{4}-\d{2}-\d{2})\s*$/.exec(line.trim());
      if (second) {
        cur.valueDate = second[1];
        if (second[3] !== undefined) cur.saldo = plAmount(second[3]);
        else cur.saldo = 0;
        if (second[2]) cur.descLines.push(second[2].trim());
        continue;
      }
    }
    if (cur) {
      const nextHead = HIST_HEAD_RE.exec(line.trimEnd());
      if (nextHead) {
        flush();
        const mid = nextHead[2].split(/\s{2,}/);
        cur = {
          seq: seq++,
          date: nextHead[1],
          valueDate: '',
          type: mid.length > 1 ? mid[mid.length - 1].trim() : '',
          amount: plAmount(nextHead[3]),
          saldo: null,
          descLines: mid.length ? [mid[0].trim()] : [],
        };
        continue;
      }
      const s = line.trim();
      if (s && !/^Strona \d|^Dokument elektroniczny|^Powszechna Kasa|^www\./.test(s)) cur.descLines.push(s);
    }
  }
  flush();
  return {
    bank: 'PKO BP (historia iPKO)',
    account,
    currency,
    period: from && to ? `${from} – ${to}` : '',
    stmtNo: '',
    txs,
  };
}

// Every parser gets a sniff + parse pair; new banks slot in here
const PARSERS = [
  { sniff: (t) => /HISTORIA BIE[Żż][ĄĄa]?CA|HISTORIA RACHUNKU/i.test(t), parse: parseIpkoHistory },
  { sniff: (t) => t.includes('iPKO') || /PKO BP/.test(t) || /Nr rachunku\/karty/.test(t), parse: parseIpkoStatement },
];

export function parseStatement(text) {
  const p = PARSERS.find((x) => x.sniff(text));
  if (!p) throw new Error('nierozpoznany format wyciągu — obsługiwane: iPKO Biznes (PDF)');
  return p.parse(text);
}

// ---- counterparty account extraction (shared with the UI column) ----

export function normAcct(s) {
  let t = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (/^PL\d{26}$/.test(t)) t = t.slice(2);
  return t;
}

const NRB_RE = /\b\d{2}(?: ?\d{4}){6}\b/;
// Foreign IBANs appear as one unbroken token in iPKO descriptions
const IBAN_RE = /(?:^|[^A-Z0-9])((?:GB|DE|IE|NL|FR|ES|IT|CZ|SK|LT|LV|EE|BE|AT|CH|SE|NO|DK|FI|LU|PT|HR|SI|HU|RO|BG|GR|MT|CY)\d{2}[A-Z0-9]{10,30})(?![A-Z0-9])/;

export function counterAccount(desc) {
  const d = String(desc || '');
  const nrb = NRB_RE.exec(d);
  if (nrb) return normAcct(nrb[0]);
  const iban = IBAN_RE.exec(d);
  return iban ? normAcct(iban[1]) : '';
}

export function buildAccountIndex(accounts) {
  const map = new Map();
  for (const e of accounts || []) {
    for (const a of e.accounts || []) map.set(normAcct(a), e);
  }
  return map;
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
export function matchTransactions(txs, invoices, opts = {}) {
  const accountIndex = opts.accounts ? buildAccountIndex(opts.accounts) : null;
  const byNumber = new Map();
  for (const inv of invoices) {
    const key = normToken(inv.number);
    if (key) {
      if (!byNumber.has(key)) byNumber.set(key, []);
      byNumber.get(key).push(inv);
    }
  }
  // An invoice consumed by any amount-based rule cannot be handed to a
  // second transaction — identical monthly amounts (ZUS, salaries) would
  // otherwise all point at the same document. opts.usedInvoiceIds extends
  // the guard across months, since a run usually covers just one bucket.
  const used = new Set([...txs.map((t) => t.invoiceId).filter(Boolean), ...(opts.usedInvoiceIds || [])]);
  return txs.map((tx) => {
    if (tx.invoiceId || tx.category || tx.refundTxId) return tx;
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
        if (inv.dir !== wantDir || used.has(inv.id)) continue;
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

    // The client-accounts register identifies the counterparty from the
    // transfer's account number — the strongest signal for documents whose
    // titles carry no invoice number (salary DWs above all)
    if (accountIndex) {
      const entry = accountIndex.get(counterAccount(tx.desc));
      if (entry) {
        const nameA = ascii(entry.name);
        const hit = byCloseness.find((inv) => inv.dir === wantDir && amountOk(inv) && !used.has(inv.id)
          && ascii(wantDir === 'cost' ? inv.sellerName : inv.buyerName) === nameA);
        if (hit) {
          used.add(hit.id);
          return { ...tx, invoiceId: hit.id, matchedBy: 'konto klienta + kwota', auto: true };
        }
      }
    }
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

    // Cross-currency: a card charge lands in the account currency while the
    // invoice is billed in another (Hetzner EUR invoice → PLN debit). Same
    // counterparty + the amount ratio inside a plausible FX band + a close
    // date, and only when the candidate is unique.
    const fx = invoices.filter((inv) => inv.dir === wantDir && !used.has(inv.id)
      && inv.currency && inv.currency !== (tx.currency || 'PLN')
      && inv.issueDate && Math.abs(Date.parse(inv.issueDate) - Date.parse(tx.date)) <= 21 * 86400e3
      && fxPlausible(Math.abs(tx.amount), tx.currency || 'PLN', inv.gross, inv.currency)
      && counterpartyMatches(tx, inv, wantDir, descAscii));
    if (fx.length === 1) {
      used.add(fx[0].id);
      return { ...tx, invoiceId: fx[0].id, matchedBy: `kwota ${fx[0].currency}→${tx.currency || 'PLN'} (do weryfikacji)`, auto: true };
    }

    const category = categorize(tx);
    return category ? { ...tx, category, auto: true } : tx;
  });
}

// Plausible PLN value per unit across 2021-2026 — wide on purpose; the
// counterparty-name requirement carries the precision
const FX_PLN_BAND = { PLN: [1, 1], EUR: [4.0, 5.0], USD: [3.4, 4.6], GBP: [4.6, 5.8], CHF: [4.0, 5.2] };

function fxPlausible(txAmount, txCur, invGross, invCur) {
  const from = FX_PLN_BAND[invCur];
  const to = FX_PLN_BAND[txCur];
  if (!from || !to || !(invGross > 0) || !(txAmount > 0)) return false;
  const ratio = txAmount / invGross;
  return ratio >= from[0] / to[1] && ratio <= from[1] / to[0];
}

// ---- tax alerts: statutory payments every monthly statement must contain ----

// minAmount filters out correction transfers (a 1,04 zł ZUS adjustment must
// not count as the month's contribution)
export const DEFAULT_TAX_RULES = [
  { id: 'zus', label: 'ZUS składki', pattern: '(^|[^A-Z])N?ZUS([^A-Z]|$)|ZAKLAD UBEZPIECZEN', minAmount: 500, hint: 'zwykle 7–9. dnia, termin 20.' },
  { id: 'pit4r', label: 'Zaliczka PIT-4R', pattern: 'PIT[- ]?4R', minAmount: 100, hint: 'zwykle 7–16. dnia, termin 20.' },
];

const TAX_PERIOD_RE = /\b(\d{2}M\d{2})\b/;

export function scanTaxRules(txs, rules = DEFAULT_TAX_RULES) {
  return rules.filter((r) => r.enabled !== false).map((rule) => {
    const re = new RegExp(rule.pattern, 'i');
    const hits = txs
      .filter((t) => t.amount < 0 && Math.abs(t.amount) >= (rule.minAmount || 0)
        && re.test(ascii(`${t.type} ${t.desc}`)))
      .map((t) => ({
        txId: t.id,
        date: t.date,
        amount: t.amount,
        period: (TAX_PERIOD_RE.exec(t.desc) || [])[1] || '',
      }));
    return { id: rule.id, label: rule.label, hint: rule.hint || '', found: hits.length > 0, hits };
  });
}

// A payment due in month M settles the previous month: '2026-07' → '26M06'
function prevPeriodMarker(month) {
  const [y, mo] = month.split('-').map(Number);
  const prev = mo === 1 ? [y - 1, 12] : [y, mo - 1];
  return `${String(prev[0]).slice(2)}M${String(prev[1]).padStart(2, '0')}`;
}

// Cross-month view: a gap month goes 'paid-late' when the catch-up payment
// shows up on a LATER statement — matched by the period marker in the title
// (PIT-4R), or for markerless transfers (ZUS) by a later month carrying more
// payments than it needs for itself.
// byMonth: {'YYYY-MM': txs[]}. Returns {'YYYY-MM': [{id, label, hint,
// status: found|paid-late|missing, hits, lateNote}]}
export function scanTaxCalendar(byMonth, rules = DEFAULT_TAX_RULES) {
  const months = Object.keys(byMonth).sort();
  const out = Object.fromEntries(months.map((m) => [m, []]));
  for (const rule of rules.filter((r) => r.enabled !== false)) {
    const hitsOf = new Map(months.map((m) => [
      m, scanTaxRules(byMonth[m], [rule])[0].hits.map((h) => ({ ...h, stmtMonth: m })),
    ]));
    const allHits = months.flatMap((m) => hitsOf.get(m));
    const spare = new Map(months.map((m) => [m, hitsOf.get(m).length - 1]));
    for (const m of months) {
      const own = hitsOf.get(m);
      const expected = prevPeriodMarker(m);
      // A month whose only transfers carry OTHER period markers is a pure
      // catch-up month — those hits belong to the gap months, not to it
      const ownForMonth = own.filter((h) => !h.period || h.period === expected);
      let row;
      if (ownForMonth.length) {
        row = { status: 'found', hits: ownForMonth, lateNote: '' };
      } else {
        const late = allHits.filter((h) => h.period === expected && h.stmtMonth > m);
        if (late.length) {
          row = { status: 'paid-late', hits: late, lateNote: `zapłacone ${late[0].date} (wyciąg ${late[0].stmtMonth})` };
        } else {
          const donor = months.find((lm) => lm > m && spare.get(lm) > 0
            && hitsOf.get(lm).every((h) => !h.period));
          if (donor) {
            spare.set(donor, spare.get(donor) - 1);
            row = {
              status: 'paid-late',
              hits: hitsOf.get(donor),
              lateNote: `prawdopodobnie nadrobione — ${hitsOf.get(donor).length} przelewy na wyciągu ${donor} (do potwierdzenia)`,
            };
          } else {
            row = { status: 'missing', hits: [], lateNote: '' };
          }
        }
      }
      out[m].push({ id: rule.id, label: rule.label, hint: rule.hint || '', ...row });
    }
  }
  return out;
}

function counterpartyMatches(tx, inv, wantDir, descAscii) {
  const otherNip = wantDir === 'cost' ? inv.sellerNip : inv.buyerNip;
  if (otherNip && normalizeNip(tx.desc).includes(otherNip)) return true;
  const other = ascii(wantDir === 'cost' ? inv.sellerName : inv.buyerName);
  const words = other.split(/[^A-Z0-9]+/).filter((w) => w.length >= 5);
  if (words.some((w) => descAscii.includes(w))) return true;
  return NAME_ALIASES.some(([mark, who]) => descAscii.includes(mark) && other.replace(/[^A-Z0-9]/g, '').includes(who));
}
