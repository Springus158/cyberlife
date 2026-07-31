// FA(3) invoice XML: builder for the common domestic single-currency sale
// (ported from a working KSeF 2.0 integration) and a tolerant parser used to
// display invoices downloaded from KSeF.

export const FA3_NAMESPACE = 'http://crd.gov.pl/wzor/2025/06/25/13775/';

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function money(n) {
  return (Math.round(Number(n) * 100) / 100).toFixed(2);
}

export function lineNet(line) {
  return Math.round(line.quantity * line.unitNetPrice * 100) / 100;
}

export function lineVat(line) {
  return Math.round(lineNet(line) * (line.vatRate / 100) * 100) / 100;
}

// FA(3) VAT bucket index for the standard rates (P_13_x net / P_14_x VAT)
const RATE_BUCKET = { 23: 1, 8: 2, 5: 3, 0: 6 };

export const SUPPORTED_VAT_RATES = Object.keys(RATE_BUCKET).map(Number);

export function computeTotals(lines) {
  const buckets = new Map();
  let gross = 0;
  for (const line of lines) {
    // An unmapped rate would vanish from P_13/P_14 while still counting
    // towards P_15 — a filed invoice understating its own VAT
    if (RATE_BUCKET[line.vatRate] === undefined) {
      throw new Error(`VAT rate ${line.vatRate}% is not supported (use ${SUPPORTED_VAT_RATES.join(', ')})`);
    }
    const net = lineNet(line);
    const vat = lineVat(line);
    gross += net + vat;
    const b = buckets.get(line.vatRate) || { net: 0, vat: 0 };
    b.net += net;
    b.vat += vat;
    buckets.set(line.vatRate, b);
  }
  return { buckets, gross: Math.round(gross * 100) / 100 };
}

function partyXml(tag, p) {
  const addr = p.address
    ? `<Adres><KodKraju>${esc(p.address.country || 'PL')}</KodKraju><AdresL1>${esc(p.address.line1)}</AdresL1>${
        p.address.line2 ? `<AdresL2>${esc(p.address.line2)}</AdresL2>` : ''
      }</Adres>`
    : '';
  const nip = String(p.nip || '').replace(/\D/g, '');
  if (nip && nip.length !== 10) {
    throw new Error(`NIP "${p.nip}" must be 10 digits`);
  }
  // An empty <NIP/> violates the schema pattern; a buyer without one is
  // declared as having no identifier
  const ident = nip
    ? `<NIP>${nip}</NIP><Nazwa>${esc(p.name)}</Nazwa>`
    : `<BrakID>1</BrakID><Nazwa>${esc(p.name)}</Nazwa>`;
  return `<${tag}><DaneIdentyfikacyjne>${ident}</DaneIdentyfikacyjne>${addr}</${tag}>`;
}

function paymentXml(invoice) {
  const parts = [];
  if (invoice.paymentTo) parts.push(`<TerminPlatnosci><Termin>${esc(invoice.paymentTo)}</Termin></TerminPlatnosci>`);
  if (invoice.bankAccount) {
    parts.push(`<RachunekBankowy><NrRB>${esc(String(invoice.bankAccount).replace(/\s/g, ''))}</NrRB></RachunekBankowy>`);
  }
  return parts.length ? `<Platnosc>${parts.join('')}</Platnosc>` : '';
}

// invoice: {number, issueDate, currency, paymentTo?, bankAccount?,
// seller{nip,name,address?}, buyer{...}, lines[{name,unit,quantity,unitNetPrice,vatRate}]}
export function buildFa3Xml(invoice) {
  const totals = computeTotals(invoice.lines);
  const createdAt = invoice.createdAt || `${invoice.issueDate}T00:00:00Z`;

  const vatBuckets = [];
  for (const [rate, sum] of [...totals.buckets.entries()].sort((a, b) => b[0] - a[0])) {
    const idx = RATE_BUCKET[rate];
    if (idx === undefined) continue;
    vatBuckets.push(`<P_13_${idx}>${money(sum.net)}</P_13_${idx}>`);
    if (rate > 0) vatBuckets.push(`<P_14_${idx}>${money(sum.vat)}</P_14_${idx}>`);
  }

  const rows = invoice.lines
    .map((line, i) =>
      `<FaWiersz>`
      + `<NrWierszaFa>${i + 1}</NrWierszaFa>`
      + `<P_7>${esc(line.name)}</P_7>`
      + `<P_8A>${esc(line.unit || 'szt')}</P_8A>`
      + `<P_8B>${money(line.quantity)}</P_8B>`
      + `<P_9A>${money(line.unitNetPrice)}</P_9A>`
      + `<P_11>${money(lineNet(line))}</P_11>`
      + `<P_12>${line.vatRate === 0 ? '0' : String(line.vatRate)}</P_12>`
      + `</FaWiersz>`)
    .join('');

  const adnotacje =
    `<Adnotacje>`
    + `<P_16>2</P_16><P_17>2</P_17><P_18>2</P_18><P_18A>2</P_18A>`
    + `<Zwolnienie><P_19N>1</P_19N></Zwolnienie>`
    + `<NoweSrodkiTransportu><P_22N>1</P_22N></NoweSrodkiTransportu>`
    + `<P_23>2</P_23>`
    + `<PMarzy><P_PMarzyN>1</P_PMarzyN></PMarzy>`
    + `</Adnotacje>`;

  return (
    `<?xml version="1.0" encoding="UTF-8"?>`
    + `<Faktura xmlns="${FA3_NAMESPACE}">`
    + `<Naglowek>`
    + `<KodFormularza kodSystemowy="FA (3)" wersjaSchemy="1-0E">FA</KodFormularza>`
    + `<WariantFormularza>3</WariantFormularza>`
    + `<DataWytworzeniaFa>${esc(createdAt)}</DataWytworzeniaFa>`
    + `<SystemInfo>CyberLife</SystemInfo>`
    + `</Naglowek>`
    + partyXml('Podmiot1', invoice.seller)
    + partyXml('Podmiot2', invoice.buyer)
    + `<Fa>`
    + `<KodWaluty>${esc(invoice.currency || 'PLN')}</KodWaluty>`
    + `<P_1>${esc(invoice.issueDate)}</P_1>`
    + `<P_2>${esc(invoice.number)}</P_2>`
    + vatBuckets.join('')
    + `<P_15>${money(totals.gross)}</P_15>`
    + adnotacje
    + `<RodzajFaktury>VAT</RodzajFaktury>`
    + paymentXml(invoice)
    + rows
    + `</Fa>`
    + `</Faktura>`
  );
}

// ---- parsing (downloaded KSeF invoices) ----

function text(el, name) {
  if (!el) return '';
  for (const child of el.children) {
    if (child.localName === name) return child.textContent.trim();
  }
  return '';
}

function find(el, name) {
  if (!el) return null;
  for (const child of el.children) {
    if (child.localName === name) return child;
  }
  return null;
}

function parseParty(el) {
  const ident = find(el, 'DaneIdentyfikacyjne');
  const addr = find(el, 'Adres');
  return {
    nip: text(ident, 'NIP'),
    name: text(ident, 'Nazwa') || text(ident, 'ImiePierwsze'),
    address: addr ? { line1: text(addr, 'AdresL1'), line2: text(addr, 'AdresL2') } : null,
  };
}

// Returns a display-oriented view of any FA(2)/FA(3) invoice XML; unknown or
// missing fields degrade to empty values rather than throwing
export function parseFaXml(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const root = doc.documentElement;
  if (!root || root.localName !== 'Faktura') {
    throw new Error('not an FA invoice XML');
  }
  const fa = find(root, 'Fa');
  const lines = [];
  if (fa) {
    for (const child of fa.children) {
      if (child.localName !== 'FaWiersz') continue;
      lines.push({
        name: text(child, 'P_7'),
        unit: text(child, 'P_8A'),
        quantity: Number(text(child, 'P_8B')) || 0,
        unitNetPrice: Number(text(child, 'P_9A')) || 0,
        net: Number(text(child, 'P_11')) || 0,
        vatRate: text(child, 'P_12'),
      });
    }
  }
  return {
    number: text(fa, 'P_2'),
    issueDate: text(fa, 'P_1'),
    currency: text(fa, 'KodWaluty') || 'PLN',
    gross: Number(text(fa, 'P_15')) || 0,
    kind: text(fa, 'RodzajFaktury'),
    seller: parseParty(find(root, 'Podmiot1')),
    buyer: parseParty(find(root, 'Podmiot2')),
    paymentDue: text(find(find(fa, 'Platnosc'), 'TerminPlatnosci') || null, 'Termin')
      || text(find(fa, 'Platnosc'), 'TerminPlatnosci'),
    lines,
  };
}
