// Keeps credentials out of stored request logs. Request bodies and headers are
// never logged; the only user-controlled text we store is the URL, so we mask
// sensitive query-string values (e.g. ?token=..., ?api_key=...).
const SENSITIVE_KEY = /pass|secret|token|key|auth|credential|session|cookie/i;
const MAX_URL_LENGTH = 500;

function redactUrl(originalUrl) {
  const raw = String(originalUrl || '');
  const qIndex = raw.indexOf('?');
  if (qIndex === -1) return raw.slice(0, MAX_URL_LENGTH);

  const path = raw.slice(0, qIndex);
  const params = new URLSearchParams(raw.slice(qIndex + 1));
  const cleaned = [];
  for (const [name, value] of params) {
    cleaned.push(`${encodeURIComponent(name)}=${SENSITIVE_KEY.test(name) ? '[REDACTED]' : encodeURIComponent(value)}`);
  }
  return `${path}?${cleaned.join('&')}`.slice(0, MAX_URL_LENGTH);
}

module.exports = { redactUrl };
