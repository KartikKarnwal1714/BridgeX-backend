// Header policy for the gateway. Requests use an ALLOW-list (only approved headers reach the
// upstream); responses use a DENY-list (hop-by-hop and cookie headers are removed).

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

// Request headers forwarded to every upstream by default.
const DEFAULT_FORWARD_REQUEST = new Set([
  'accept', 'accept-encoding', 'accept-language', 'content-type', 'user-agent', 'range',
  'if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since', 'cache-control',
]);

// Headers an administrator may NOT add to a route's extra forward list: gateway credentials,
// cookies, anything that spoofs client identity, and framing headers the gateway controls itself.
const FORBIDDEN_FORWARD_HEADERS = new Set([
  ...HOP_BY_HOP, 'host', 'authorization', 'cookie', 'set-cookie', 'x-api-key', 'content-length',
  'expect', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip',
  'x-request-id', 'x-correlation-id',
]);

// Response headers never passed back to the client.
const STRIP_RESPONSE = new Set([
  ...HOP_BY_HOP, 'set-cookie', 'set-cookie2', 'server', 'x-powered-by', 'x-request-id',
]);

function buildUpstreamHeaders(incoming, extraForward, requestId, credentialHeader) {
  const out = {};
  const allowed = new Set([...DEFAULT_FORWARD_REQUEST, ...(extraForward || []).map((h) => h.toLowerCase())]);
  for (const name of allowed) {
    if (FORBIDDEN_FORWARD_HEADERS.has(name)) continue;
    const value = incoming[name];
    if (typeof value === 'string' && value.length > 0) out[name] = value;
  }

  // Body framing: forward the declared length; otherwise Node uses chunked encoding when streaming.
  const length = incoming['content-length'];
  if (typeof length === 'string' && /^\d{1,15}$/.test(length) && incoming['transfer-encoding'] === undefined) {
    out['content-length'] = length;
  }

  out['x-request-id'] = requestId;
  out['x-forwarded-by'] = 'BridgeX';

  // The upstream credential is injected last so a client can never override it.
  if (credentialHeader) out[credentialHeader.name.toLowerCase()] = credentialHeader.value;
  return out;
}

function filterResponseHeaders(upstreamHeaders) {
  const out = {};
  for (const [name, value] of Object.entries(upstreamHeaders)) {
    const lower = name.toLowerCase();
    if (STRIP_RESPONSE.has(lower) || lower.startsWith('x-ratelimit-') || lower.startsWith('x-bridgex-')) continue;
    out[lower] = value;
  }
  return out;
}

module.exports = { buildUpstreamHeaders, filterResponseHeaders, FORBIDDEN_FORWARD_HEADERS, HOP_BY_HOP };
