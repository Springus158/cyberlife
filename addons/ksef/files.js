// Invoice files: field extraction from PDF text and matching against the
// invoice registry. Shared by the Pliki page (single upload) and the
// one-off archive import scripts — deterministic first, LLM only for what
// this cannot read.

import { normalizeNip } from './store.js';

function nipChecksumOk(nip) {
  if (!/^\d{10}$/.test(nip)) return false;
  const w = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const sum = w.reduce((s, wi, i) => s + wi * Number(nip[i]), 0);
  return sum % 11 === Number(nip[9]);
}

function plNumber(s) {
  const t = String(s).replace(/[\s ]/g, '');
  // 1.234,56 and 1,234.56 both appear on invoices — the decimal separator
  // is whichever of the two comes last
  const lastComma = t.lastIndexOf(',');
  const lastDot = t.lastIndexOf('.');
  const dec = lastComma > lastDot ? ',' : '.';
  const cleaned = t.split(dec === ',' ? '.' : ',').join('');
  return Number(cleaned.replace(dec, '.'));
}

const DATE_PATTERNS = [
  { re: /\b(\d{4})-(\d{2})-(\d{2})\b/g, ymd: (m) => [m[1], m[2], m[3]] },
  { re: /\b(\d{2})[./](\d{2})[./](\d{4})\b/g, ymd: (m) => [m[3], m[2], m[1]] },
];

const MONTHS_PL = {
  stycznia: '01', lutego: '02', marca: '03', kwietnia: '04', maja: '05', czerwca: '06',
  lipca: '07', sierpnia: '08', wrzesnia: '09', września: '09', pazdziernika: '10',
  października: '10', listopada: '11', grudnia: '12',
};

export function extractDates(text) {
  const out = new Set();
  for (const { re, ymd } of DATE_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const [y, mo, d] = ymd(m);
      if (Number(y) >= 2015 && Number(y) <= 2035 && Number(mo) >= 1 && Number(mo) <= 12 && Number(d) >= 1 && Number(d) <= 31) {
        out.add(`${y}-${mo}-${d}`);
      }
    }
  }
  for (const m of text.matchAll(/\b(\d{1,2})\s+([a-ząćęłńóśźż]+)\s+(\d{4})\b/gi)) {
    const mo = MONTHS_PL[m[2].toLowerCase()];
    if (mo && Number(m[3]) >= 2015 && Number(m[3]) <= 2035) {
      out.add(`${m[3]}-${mo}-${String(m[1]).padStart(2, '0')}`);
    }
  }
  return [...out].sort();
}

export function extractNips(text, ownNip) {
  const own = normalizeNip(ownNip);
  const out = [];
  for (const m of text.matchAll(/(?:NIP|VAT\s*(?:ID|No\.?|Number)?|PL)[:\s.]*((?:\d[\s-]?){10})/gi)) {
    const nip = m[1].replace(/\D/g, '');
    if (nipChecksumOk(nip) && nip !== own && !out.includes(nip)) out.push(nip);
  }
  // Fallback: any standalone 10-digit run with a valid checksum
  if (!out.length) {
    for (const m of text.matchAll(/\b(\d{3}[-\s]?\d{3}[-\s]?\d{2}[-\s]?\d{2}|\d{10})\b/g)) {
      const nip = m[1].replace(/\D/g, '');
      if (nipChecksumOk(nip) && nip !== own && !out.includes(nip)) out.push(nip);
    }
  }
  return out;
}

// Gross candidates, strongest first: amounts on "do zapłaty"-style lines,
// then every plausible money value found anywhere (largest first)
export function extractAmounts(text) {
  const strong = [];
  const all = new Set();
  const MONEY_RE = /(\d{1,3}(?:[\s .,]\d{3})*[.,]\d{2})/g;
  for (const line of text.split('\n')) {
    const amounts = [...line.matchAll(MONEY_RE)].map((m) => plNumber(m[1])).filter((n) => n > 0 && n < 10_000_000);
    if (!amounts.length) continue;
    for (const a of amounts) all.add(a);
    if (/do\s+zap[lł]aty|raz[ae]m\s+do|total\s+due|amount\s+due|grand\s+total|suma\s+brutto|warto[sś][cć]\s+brutto|total(?!\s+net)/i.test(line)) {
      strong.push(...amounts);
    }
  }
  return { strong: [...new Set(strong)], all: [...all].sort((a, b) => b - a) };
}

export function extractInvoiceNumbers(text) {
  const out = [];
  for (const m of text.matchAll(/(?:faktur[aey](?:\s+(?:vat|nr|numer|proforma))*|invoice\s*(?:no\.?|number|#)?|rachunek\s+nr)[:\s]*([A-Za-z0-9][A-Za-z0-9\/\-._]{2,30})/gi)) {
    const num = m[1].replace(/[.,:]$/, '');
    if (/\d/.test(num) && !/^\d{4}-\d{2}-\d{2}$/.test(num) && !out.includes(num)) out.push(num);
  }
  return out;
}

// The document currency is whichever symbol/code appears most often next
// to money amounts; bare counts over the whole text would drown in VAT-law
// boilerplate mentioning PLN
export function extractCurrency(text) {
  const votes = { PLN: 0, EUR: 0, USD: 0, GBP: 0, CHF: 0 };
  const AMOUNT = String.raw`\d(?:[\d\s.,]*\d)?[.,]\d{2}`;
  for (const m of text.matchAll(new RegExp(String.raw`(EUR|USD|GBP|CHF|PLN|€|\$|£|zł)\s*${AMOUNT}|${AMOUNT}\s*(EUR|USD|GBP|CHF|PLN|€|\$|£|zł)`, 'gi'))) {
    const tok = (m[1] || m[2] || '').toUpperCase();
    const cur = { '€': 'EUR', $: 'USD', '£': 'GBP', 'ZŁ': 'PLN' }[tok] || tok;
    if (cur in votes) votes[cur]++;
  }
  const best = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : '';
}

export function extractFields(text, ownNip) {
  const amounts = extractAmounts(text);
  return {
    nips: extractNips(text, ownNip),
    dates: extractDates(text),
    amounts,
    numbers: extractInvoiceNumbers(text),
    currency: extractCurrency(text),
  };
}

const normToken = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9/]/g, '');

// Match extracted fields against the registry. Confidence order: exact
// number + NIP, number + amount, NIP + amount (+ closest date), unique
// amount within the file's date window. Returns {invoice, how} or null.
export function matchFileToInvoice(fields, invoices, { dir = 'cost' } = {}) {
  const pool = invoices.filter((i) => !dir || i.dir === dir);
  const grossOk = (inv, a) => Math.abs(inv.gross - a) < 0.015;
  const candidates = [...fields.amounts.strong, ...fields.amounts.all.slice(0, 8)];
  const dateSet = fields.dates;

  const numTokens = fields.numbers.map(normToken).filter((t) => t.length >= 3);
  for (const inv of pool) {
    const invTok = normToken(inv.number);
    if (!invTok || invTok.length < 3) continue;
    if (!numTokens.some((t) => t === invTok || t.includes(invTok) || invTok.includes(t))) continue;
    const party = dir === 'cost' ? inv.sellerNip : inv.buyerNip;
    if (party && fields.nips.includes(party)) return { invoice: inv, how: 'numer + NIP' };
    if (candidates.some((a) => grossOk(inv, a))) return { invoice: inv, how: 'numer + kwota' };
  }

  const dated = (inv) => dateSet.includes(inv.issueDate)
    || dateSet.some((d) => Math.abs(Date.parse(d) - Date.parse(inv.issueDate)) <= 45 * 86400e3);
  const byNip = pool.filter((inv) => {
    const party = dir === 'cost' ? inv.sellerNip : inv.buyerNip;
    return party && fields.nips.includes(party) && candidates.some((a) => grossOk(inv, a));
  });
  if (byNip.length === 1) return { invoice: byNip[0], how: 'NIP + kwota' };
  if (byNip.length > 1 && dateSet.length) {
    const close = byNip.filter(dated);
    if (close.length === 1) return { invoice: close[0], how: 'NIP + kwota + data' };
    if (close.length > 1) {
      const anchor = Date.parse(dateSet[0]);
      close.sort((a, b) => Math.abs(Date.parse(a.issueDate) - anchor) - Math.abs(Date.parse(b.issueDate) - anchor));
      return { invoice: close[0], how: 'NIP + kwota (najbliższa data)' };
    }
  }

  if (dateSet.length && fields.amounts.strong.length) {
    for (const a of fields.amounts.strong) {
      const near = pool.filter((inv) => grossOk(inv, a) && dated(inv));
      if (near.length === 1) return { invoice: near[0], how: 'kwota + data (do weryfikacji)' };
    }
  }
  return null;
}
