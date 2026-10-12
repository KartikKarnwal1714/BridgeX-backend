// Streams one request to an upstream and the response back, without buffering either body.
const http = require('http');
const https = require('https');
const net = require('net');
const { Transform, pipeline } = require('stream');
const env = require('../config/env');
const { GatewayError } = require('./errors');
const { filterResponseHeaders } = require('./headers');
const { validateUpstreamUrl, guardedLookup, isBlockedAddress, portOf } = require('../utils/ssrf');

// One-shot connections: nothing is pooled across requests, so a socket verified for one request is
// never reused for another. TLS certificate verification stays at Node's secure default.
const httpAgent = new http.Agent({ keepAlive: false });
const httpsAgent = new https.Agent({ keepAlive: false });

function classify(err) {
  const code = err.code || (err.errors && err.errors[0] && err.errors[0].code) || '';
  const gw = (status, c, msg, category, outcome = 'gateway_error', headers = {}) =>
    new GatewayError(status, c, msg, { category, outcome, headers });

  if (code === 'BX_TIMEOUT' || code === 'ETIMEDOUT') return gw(504, 'UPSTREAM_TIMEOUT', 'The upstream service did not respond in time', 'upstream_timeout');
  if (code === 'BX_BODY_TOO_LARGE') return gw(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large', 'payload_too_large', 'rejected', { Connection: 'close' });
  if (code === 'EBLOCKEDADDRESS') return gw(502, 'UPSTREAM_ADDRESS_BLOCKED', 'The upstream address is not permitted', 'upstream_blocked');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return gw(502, 'UPSTREAM_DNS_FAILURE', 'The upstream host could not be resolved', 'upstream_dns');
  if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return gw(502, 'UPSTREAM_UNREACHABLE', 'The upstream service refused or could not accept the connection', 'upstream_refused');
  if (code === 'ECONNRESET' || code === 'EPIPE' || /socket hang up/i.test(err.message)) return gw(502, 'UPSTREAM_CONNECTION_RESET', 'The upstream connection was closed unexpectedly', 'upstream_reset');
  if (/^(CERT_|DEPTH_ZERO|UNABLE_TO_|SELF_SIGNED|ERR_TLS|ERR_SSL|HOSTNAME_MISMATCH)/.test(code) || /certificate/i.test(err.message)) return gw(502, 'UPSTREAM_TLS_ERROR', 'A secure connection to the upstream could not be established', 'upstream_tls');
  if (/^HPE_/.test(code)) return gw(502, 'UPSTREAM_INVALID_RESPONSE', 'The upstream returned a malformed response', 'upstream_invalid_response');
  if (code === 'ERR_INVALID_CHAR' || code === 'ERR_INVALID_HTTP_TOKEN') return gw(400, 'INVALID_REQUEST', 'Request contains invalid header characters', 'invalid_request', 'rejected');
  return gw(502, 'UPSTREAM_ERROR', 'The upstream request failed', 'upstream_error_other');
}

const stripBrackets = (h) => (h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h);

function counter(onBytes, limit, code) {
  let total = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      total += chunk.length;
      onBytes(total);
      if (total > limit) {
        const err = new Error('size limit exceeded');
        err.code = code;
        return cb(err);
      }
      return cb(null, chunk);
    },
  });
}

/**
 * Resolves when the response has been fully streamed to the client. Rejects with a GatewayError if
 * the failure happened before any response bytes were sent (so the caller can still send a clean error).
 */
function forward({ req, res, api, upstreamPath, headers, gw }) {
  return new Promise((resolve, reject) => {
    let validated;
    try {
      validated = validateUpstreamUrl(api.base_url); // re-checked on every request, not just at save time
    } catch {
      return reject(classify(Object.assign(new Error('blocked'), { code: 'EBLOCKEDADDRESS' })));
    }
    const { url, devAllowed } = validated;
    const hostname = stripBrackets(url.hostname);

    // IP-literal hosts skip DNS entirely, so they are checked here instead of in guardedLookup.
    if (!devAllowed && net.isIP(hostname) && isBlockedAddress(hostname)) {
      return reject(classify(Object.assign(new Error('blocked'), { code: 'EBLOCKEDADDRESS' })));
    }

    const timeoutMs = Math.min(api.timeout_ms, env.GATEWAY_MAX_TIMEOUT_MS);
    const isHttps = url.protocol === 'https:';
    const started = Date.now();
    let responseStarted = false;
    let timer;

    const timeoutError = () => Object.assign(new Error('upstream timeout'), { code: 'BX_TIMEOUT' });

    let upstreamReq;
    try {
      upstreamReq = (isHttps ? https : http).request({
        protocol: url.protocol,
        hostname,
        port: portOf(url),
        method: req.method,
        path: upstreamPath,
        headers,
        agent: isHttps ? httpsAgent : httpAgent,
        lookup: guardedLookup(devAllowed),
      });
    } catch (err) {
      return reject(classify(err));
    }

    gw.forwarded = true;
    timer = setTimeout(() => upstreamReq.destroy(timeoutError()), timeoutMs);

    upstreamReq.on('error', (err) => {
      clearTimeout(timer);
      if (responseStarted) return; // the response pipeline reports mid-stream failures
      reject(classify(err));
    });

    // Client went away: stop talking to the upstream.
    res.on('close', () => {
      if (!res.writableFinished) {
        gw.aborted = true;
        clearTimeout(timer);
        upstreamReq.destroy();
      }
    });

    upstreamReq.on('response', (upRes) => {
      clearTimeout(timer);
      gw.upstreamStatus = upRes.statusCode;
      gw.upstreamMs = Date.now() - started;

      const declared = Number(upRes.headers['content-length']);
      if (Number.isFinite(declared) && declared > env.GATEWAY_MAX_RESPONSE_BYTES) {
        upRes.destroy();
        return reject(new GatewayError(
          502, 'UPSTREAM_RESPONSE_TOO_LARGE', 'The upstream response is too large',
          { category: 'upstream_response_too_large', outcome: 'gateway_error' }
        ));
      }

      responseStarted = true;
      res.status(upRes.statusCode);
      const filtered = filterResponseHeaders(upRes.headers);
      Object.entries(filtered).forEach(([name, value]) => res.setHeader(name, value));

      upRes.setTimeout(timeoutMs, () => upRes.destroy(timeoutError()));

      const limiter = counter((n) => { gw.responseBytes = n; }, env.GATEWAY_MAX_RESPONSE_BYTES, 'BX_RESPONSE_TOO_LARGE');
      pipeline(upRes, limiter, res, (err) => {
        if (err && !gw.aborted) {
          const e = classify(err);
          gw.errorCategory = err.code === 'BX_RESPONSE_TOO_LARGE' ? 'upstream_response_too_large' : e.category;
          gw.outcome = 'gateway_error';
          res.destroy(); // headers are already out, so the only honest signal left is a broken connection
        }
        resolve();
      });
    });

    // Request body: stream with a hard size cap. No body at all -> end immediately.
    const hasBody = req.headers['content-length'] !== undefined || req.headers['transfer-encoding'] !== undefined;
    if (!hasBody) {
      gw.requestBytes = 0;
      upstreamReq.end();
      return undefined;
    }
    const bodyCounter = counter((n) => { gw.requestBytes = n; }, env.GATEWAY_MAX_BODY_BYTES, 'BX_BODY_TOO_LARGE');
    bodyCounter.on('error', (err) => upstreamReq.destroy(err));
    req.on('error', (err) => upstreamReq.destroy(err));
    req.pipe(bodyCounter).pipe(upstreamReq);
    return undefined;
  });
}

module.exports = { forward, classify };
