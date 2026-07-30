// The local agent API; the webview reaches it over HTTP like any other client
export const API_BASE = 'http://127.0.0.1:8377';

// Truncate string to a given length
export function truncate(str, maxLen) {
  if (!str) return '';
  return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
}

// Escape HTML to prevent XSS. Quotes are escaped too: the same values end up
// inside attributes all over the app, where textContent-based escaping (which
// leaves " and ' alone) would let a value break out of the attribute.
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

// Alias kept for call sites that read better as attribute escaping
export const escapeAttr = escapeHtml;

/**
 * Convert text to base64, handling Unicode properly.
 * Uses TextEncoder for UTF-8 encoding, then converts to base64.
 * Safe for large strings (avoids stack overflow with spread operator).
 * @param {string} text - Text to encode
 * @returns {string} Base64 encoded string
 */
export function textToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Normalize URL input (handle shortcuts like :3000, localhost:3000, etc.)
export function normalizeUrl(input) {
  if (!input || !input.trim()) return null;

  let url = input.trim();

  // Handle port-only shortcuts like ":3000" or "3000"
  if (/^:?\d{2,5}$/.test(url)) {
    const port = url.replace(':', '');
    return `http://localhost:${port}`;
  }

  // Handle localhost with port like "localhost:3000"
  if (/^localhost(:\d+)?/.test(url)) {
    return `http://${url}`;
  }

  // Handle 127.0.0.1 with port
  if (/^127\.0\.0\.1(:\d+)?/.test(url)) {
    return `http://${url}`;
  }

  // Already has protocol
  if (/^https?:\/\//.test(url)) {
    return url;
  }

  // Default to https for external sites
  return `https://${url}`;
}

// Check if URL is localhost (same-origin capable)
export function isLocalhostUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

// Diacritics-insensitive matching, so "muller" finds "Müller".
// The stroked l is mapped by hand — it has no NFD decomposition to strip.
export function searchNormalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}
