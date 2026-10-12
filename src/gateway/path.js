// Builds the upstream path from the client's raw URL without ever re-encoding or decoding what is
// sent: encoding is preserved byte-for-byte, but unsafe shapes (traversal, encoded separators,
// control characters) are rejected before a request is made.
const MAX_URL_LENGTH = 8192;

class PathError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * @param originalUrl  e.g. "/gateway/orders/items/42?status=open"
 * @param baseUrl      the configured upstream base, e.g. "https://api.example.com/v2"
 * @returns { path, query, upstreamPath } — upstreamPath is what goes on the request line
 */
function buildUpstreamPath(originalUrl, baseUrl) {
  if (originalUrl.length > MAX_URL_LENGTH) throw new PathError('URI_TOO_LONG', 'Request URL is too long', 414);

  const match = /^\/gateway\/[^/?#]+(.*)$/s.exec(originalUrl);
  if (!match) throw new PathError('INVALID_PATH', 'Invalid gateway path');
  const rest = match[1];

  const qIndex = rest.indexOf('?');
  const rawPath = qIndex === -1 ? rest : rest.slice(0, qIndex);
  const query = qIndex === -1 ? '' : rest.slice(qIndex + 1);

  // Printable ASCII only, no spaces, no backslashes: anything else must arrive percent-encoded.
  if (/[^\x21-\x7e]/.test(rawPath) || rawPath.includes('\\') || /[^\x21-\x7e]/.test(query)) {
    throw new PathError('INVALID_PATH', 'Request path contains invalid characters');
  }
  if (rawPath !== '' && !rawPath.startsWith('/')) throw new PathError('INVALID_PATH', 'Invalid gateway path');

  const segments = rawPath.split('/').slice(1);
  const kept = [];
  segments.forEach((segment, index) => {
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new PathError('INVALID_PATH', 'Request path contains invalid percent-encoding');
    }
    if (decoded === '.' || decoded === '..') throw new PathError('INVALID_PATH', 'Path traversal is not permitted');
    if (/[/\\\x00-\x1f\x7f]/.test(decoded)) throw new PathError('INVALID_PATH', 'Request path contains an encoded separator or control character');
    // Collapse "//" (empty middle segments); keep one trailing slash if the client sent it.
    if (segment === '' && index !== segments.length - 1) return;
    kept.push(segment);
  });

  const path = kept.length ? `/${kept.join('/')}` : '';
  const base = new URL(baseUrl).pathname.replace(/\/+$/, '');
  const upstreamPath = `${base}${path}` || '/';
  return { path, query, upstreamPath: query ? `${upstreamPath}?${query}` : upstreamPath };
}

module.exports = { buildUpstreamPath, PathError };
