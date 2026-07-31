// KSeF 2.0 REST client. All HTTP goes through the app's addon proxy
// (cl.http) because the KSeF API sends no CORS headers. Crypto is WebCrypto:
// RSA-OAEP(SHA-256) for the auth token and the AES session key, AES-256-CBC
// with PKCS#7 for invoice payloads, per CIRFMF/ksef-docs.

export const KSEF_BASE_URLS = {
  test: 'https://api-test.ksef.mf.gov.pl/v2',
  demo: 'https://api-demo.ksef.mf.gov.pl/v2',
  prod: 'https://api.ksef.mf.gov.pl/v2',
};

const enc = new TextEncoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function sha256B64(bytes) {
  return bytesToB64(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

// ---- X.509 handling ----
// WebCrypto imports SPKI, not certificates, so the SubjectPublicKeyInfo has
// to be cut out of the DER: the SEQUENCE whose first child is an
// AlgorithmIdentifier starting with the rsaEncryption OID.

const RSA_OID = [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];

function readTlv(bytes, offset) {
  if (offset + 2 > bytes.length) return null;
  const tag = bytes[offset];
  let len = bytes[offset + 1];
  let lenBytes = 1;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + bytes[offset + 2 + i];
    lenBytes = 1 + n;
  }
  const contentStart = offset + 1 + lenBytes;
  return { tag, contentStart, end: contentStart + len, start: offset };
}

function matchAt(bytes, offset, pattern) {
  for (let i = 0; i < pattern.length; i++) {
    if (bytes[offset + i] !== pattern[i]) return false;
  }
  return true;
}

function findSpki(bytes, start = 0, end = bytes.length) {
  let off = start;
  while (off < end) {
    const tlv = readTlv(bytes, off);
    if (!tlv || tlv.end > end) return null;
    if (tlv.tag === 0x30) {
      const first = readTlv(bytes, tlv.contentStart);
      if (first && first.tag === 0x30 && matchAt(bytes, first.contentStart, RSA_OID)) {
        return bytes.slice(tlv.start, tlv.end);
      }
    }
    if (tlv.tag & 0x20) {
      const inner = findSpki(bytes, tlv.contentStart, tlv.end);
      if (inner) return inner;
    }
    off = tlv.end;
  }
  return null;
}

async function importCertRsaKey(certB64) {
  const spki = findSpki(b64ToBytes(certB64));
  if (!spki) throw new Error('MF certificate: RSA public key not found in DER');
  return crypto.subtle.importKey('spki', spki, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
}

async function rsaOaepEncryptB64(key, bytes) {
  return bytesToB64(new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, bytes)));
}

export class KsefClient {
  constructor({ http, env }) {
    this.http = http;
    this.env = env;
    this.base = KSEF_BASE_URLS[env] || KSEF_BASE_URLS.prod;
  }

  async req(path, { method = 'GET', bearer, body, raw } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (bearer) headers['Authorization'] = `Bearer ${bearer}`;
    const res = await this.http({
      url: `${this.base}${path}`,
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.bodyBase64) {
      throw new Error(`KSeF ${path} → ${res.status} returned a non-text body (${(res.body || '').length} b64 chars)`);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`KSeF ${path} → ${res.status} ${String(res.body || '').slice(0, 300)}`);
    }
    if (raw) return res.body;
    if (!res.body) return null;
    return JSON.parse(res.body);
  }

  async publicCerts() {
    return this.req('/security/public-key-certificates');
  }

  pickCert(certs, usage) {
    const now = Date.now();
    const valid = (certs || []).filter((c) =>
      (c.usage || []).includes(usage)
      && new Date(c.validFrom).getTime() <= now
      && now <= new Date(c.validTo).getTime());
    valid.sort((a, b) => new Date(b.validFrom) - new Date(a.validFrom));
    if (!valid.length) throw new Error(`no valid MF certificate for ${usage}`);
    return valid[0];
  }

  // KSeF-token auth: challenge → RSA-OAEP("token|timestampMs") → poll → redeem JWT
  async authenticate({ token, nip }) {
    const cert = this.pickCert(await this.publicCerts(), 'KsefTokenEncryption');
    const key = await importCertRsaKey(cert.certificate);
    const challenge = await this.req('/auth/challenge', { method: 'POST' });
    const tsMs = challenge.timestampMs ?? new Date(challenge.timestamp).getTime();
    const encryptedToken = await rsaOaepEncryptB64(key, enc.encode(`${token}|${tsMs}`));

    const submitted = await this.req('/auth/ksef-token', {
      method: 'POST',
      body: {
        challenge: challenge.challenge,
        contextIdentifier: { type: 'Nip', value: nip },
        encryptedToken,
        publicKeyId: cert.publicKeyId,
      },
    });

    const temp = submitted.authenticationToken.token;
    let lastStatus = null;
    for (let i = 0; i < 20; i++) {
      const st = await this.req(`/auth/${submitted.referenceNumber}`, { bearer: temp });
      lastStatus = st.status;
      if (st.status?.code === 200) {
        const redeemed = await this.req('/auth/token/redeem', { method: 'POST', bearer: temp });
        return { accessToken: redeemed.accessToken.token, refreshToken: redeemed.refreshToken.token };
      }
      if (st.status?.code >= 400) {
        throw new Error(`KSeF auth rejected: ${st.status.description || st.status.code}`);
      }
      await sleep(1500);
    }
    throw new Error(`KSeF auth did not complete: ${lastStatus?.description || 'timeout'}`);
  }

  // subjectType: Subject1 = our sales, Subject2 = our purchases
  async queryMetadata({ accessToken, subjectType, from, to, dateType = 'Issue', pageOffset = 0, pageSize = 100 }) {
    const dateRange = { dateType, from };
    if (to) dateRange.to = to;
    return this.req(`/invoices/query/metadata?pageOffset=${pageOffset}&pageSize=${pageSize}`, {
      method: 'POST',
      bearer: accessToken,
      body: { subjectType, dateRange },
    });
  }

  async downloadInvoiceXml({ accessToken, ksefNumber }) {
    return this.req(`/invoices/ksef/${encodeURIComponent(ksefNumber)}`, { bearer: accessToken, raw: true });
  }

  // Open an online session, submit one encrypted FA(3) invoice
  async sendInvoice({ accessToken, xml }) {
    const cert = this.pickCert(await this.publicCerts(), 'SymmetricKeyEncryption');
    const rsaKey = await importCertRsaKey(cert.certificate);
    const aesKeyBytes = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(16));

    const session = await this.req('/sessions/online', {
      method: 'POST',
      bearer: accessToken,
      body: {
        formCode: { systemCode: 'FA (3)', schemaVersion: '1-0E', value: 'FA' },
        encryption: {
          encryptedSymmetricKey: await rsaOaepEncryptB64(rsaKey, aesKeyBytes),
          initializationVector: bytesToB64(iv),
          publicKeyId: cert.publicKeyId,
        },
      },
    });

    // The IV travels once in the session's encryption block; prepending it to
    // the ciphertext would make KSeF decrypt it as the first plaintext block
    const xmlBytes = enc.encode(xml);
    const aesKey = await crypto.subtle.importKey('raw', aesKeyBytes, 'AES-CBC', false, ['encrypt']);
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, aesKey, xmlBytes));

    const submitted = await this.req(`/sessions/online/${session.referenceNumber}/invoices`, {
      method: 'POST',
      bearer: accessToken,
      body: {
        invoiceHash: await sha256B64(xmlBytes),
        invoiceSize: xmlBytes.length,
        encryptedInvoiceHash: await sha256B64(encrypted),
        encryptedInvoiceSize: encrypted.length,
        encryptedInvoiceContent: bytesToB64(encrypted),
      },
    });

    return {
      sessionReferenceNumber: session.referenceNumber,
      invoiceReferenceNumber: submitted.referenceNumber,
    };
  }

  async invoiceStatus({ accessToken, sessionReferenceNumber, invoiceReferenceNumber }) {
    return this.req(`/sessions/${sessionReferenceNumber}/invoices/${invoiceReferenceNumber}`, { bearer: accessToken });
  }

  async closeSession({ accessToken, sessionReferenceNumber }) {
    await this.req(`/sessions/online/${sessionReferenceNumber}/close`, { method: 'POST', bearer: accessToken });
  }

  // Waits for the KSeF number after a send; returns null when still processing
  async waitForKsefNumber(params, attempts = 10) {
    for (let i = 0; i < attempts; i++) {
      const st = await this.invoiceStatus(params);
      if (st.ksefNumber) return st.ksefNumber;
      if (st.status?.code >= 400) {
        throw new Error(`KSeF rejected the invoice: ${st.status.description || st.status.code}`);
      }
      await sleep(1500);
    }
    return null;
  }
}
