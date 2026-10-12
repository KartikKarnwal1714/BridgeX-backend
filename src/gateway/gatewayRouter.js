// The BridgeX API gateway: /gateway/:slug/<anything>
//
// Lifecycle (each step can end the request with a gateway-generated error):
//   1 authenticate API key -> 2 rate limit -> 3 find route -> 4 key may use this API? -> 5 route enabled?
//   -> 6 method allowed? -> 7 build safe upstream path -> 8 forward (streamed) -> 9 log + usage counters
//
// Mounted BEFORE the dashboard's JSON parser, request logger and global limiter on purpose: bodies
// must stay raw streams, and gateway traffic gets exactly one (richer) log entry from this file.
const express = require('express');
const { randomUUID } = require('crypto');
const env = require('../config/env');
const logger = require('../utils/logger');
const { redactUrl } = require('../middleware/redact');
const apiKeyService = require('../services/apiKeyService');
const apiKeyModel = require('../models/apiKeyModel');
const apiModel = require('../models/apiModel');
const logService = require('../services/logService');
const { decrypt } = require('../utils/secretBox');
const rateLimiter = require('./rateLimiter');
const { buildUpstreamHeaders } = require('./headers');
const { buildUpstreamPath, PathError } = require('./path');
const { forward } = require('./proxy');
const { GatewayError } = require('./errors');

const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,48}[a-z0-9])?$/;
const SUPPORTED_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
const MAX_FAILED_AUTH_PER_WINDOW = 30;

const router = express.Router();

// ---- request context + single log/usage write when the response is done ---------------------------
router.use((req, res, next) => {
  const incoming = req.headers['x-correlation-id'];
  const requestId = typeof incoming === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(incoming) ? incoming : randomUUID();
  req.correlationId = requestId;
  res.setHeader('X-Request-Id', requestId);

  const gw = {
    start: Date.now(), requestId, api: null, apiSlug: null, apiKeyId: null, forwarded: false,
    outcome: null, errorCategory: null, upstreamStatus: null, upstreamMs: null,
    requestBytes: 0, responseBytes: 0, aborted: false,
  };
  req.gw = gw;

  let finalized = false;
  res.on('close', () => {
    if (finalized) return;
    finalized = true;
    finalize(req, res, gw);
  });
  next();
});

function finalize(req, res, gw) {
  const responseTime = Date.now() - gw.start;
  const status = gw.aborted ? 499 : res.statusCode;

  let outcome = gw.outcome;
  if (gw.aborted) outcome = 'client_aborted';
  else if (!outcome) outcome = gw.forwarded ? (status >= 400 ? 'upstream_error' : 'success') : 'rejected';
  let errorCategory = gw.errorCategory;
  if (!errorCategory && outcome === 'upstream_error') errorCategory = `upstream_${status}`;
  if (gw.aborted) errorCategory = 'client_aborted';

  const endpoint = redactUrl(req.originalUrl);
  logger.info('gateway_request', {
    requestId: gw.requestId, method: req.method, endpoint, status, responseTime, outcome, errorCategory, apiSlug: gw.apiSlug,
  });

  // Best-effort and off the request path: slow storage never delays or fails a client response.
  logService
    .recordRequestLog({
      correlationId: gw.requestId,
      method: req.method,
      endpoint,
      status,
      responseTime,
      service: gw.api ? gw.api.name : 'BridgeX Gateway',
      error: errorCategory,
      metadata: {},
      extra: {
        source: 'gateway',
        apiId: gw.api ? gw.api.id : null,
        apiSlug: gw.apiSlug,
        apiKeyId: gw.apiKeyId, // a numeric id only — never the key or its hash
        outcome,
        errorCategory,
        upstreamStatus: gw.upstreamStatus,
        upstreamTimeMs: gw.upstreamMs,
        requestBytes: gw.requestBytes,
        responseBytes: gw.responseBytes,
      },
    })
    .catch(() => {});

  // Per-API counters used by the dashboard: only requests that were actually sent to the upstream.
  if (gw.forwarded && gw.api) {
    apiModel
      .recordGatewayResult(gw.api.id, status < 400 && outcome !== 'gateway_error', responseTime)
      .catch((err) => logger.warn('Failed to update API usage counters', { error: err.message }));
  }
}

// ---- helpers ---------------------------------------------------------------------------------------
function extractKey(req) {
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(\S+)$/i.exec(auth);
    if (m) return m[1];
  }
  const header = req.headers['x-api-key'];
  return typeof header === 'string' && header.trim() ? header.trim() : null;
}

function isDatabaseDown(err) {
  const code = err && err.code;
  return (
    ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', '57P01', '57P02', '57P03', '08000', '08001', '08003', '08006'].includes(code) ||
    /timeout exceeded when trying to connect|Connection terminated|connection.*(refused|closed)/i.test((err && err.message) || '')
  );
}

function setRateHeaders(res, rl) {
  res.setHeader('X-RateLimit-Limit', String(rl.limit));
  res.setHeader('X-RateLimit-Remaining', String(rl.remaining));
  res.setHeader('X-RateLimit-Reset', String(rl.resetSeconds));
}

async function authenticate(req, res) {
  const rawKey = extractKey(req);
  const unauthorized = (code, message, category) =>
    new GatewayError(401, code, message, { category, headers: { 'WWW-Authenticate': 'Bearer realm="BridgeX Gateway"' } });

  // Failed attempts are counted per IP so password-guessing style floods are cut off cheaply.
  const noteFailure = async () => {
    const rl = await rateLimiter.consume(`authfail:${req.ip}`, MAX_FAILED_AUTH_PER_WINDOW);
    if (!rl.allowed) {
      res.setHeader('Retry-After', String(rl.resetSeconds));
      throw new GatewayError(429, 'TOO_MANY_FAILED_ATTEMPTS', 'Too many failed authentication attempts', {
        category: 'auth_throttled', outcome: 'rate_limited', headers: { 'Retry-After': String(rl.resetSeconds) },
      });
    }
  };

  if (!rawKey) {
    await noteFailure();
    throw unauthorized('UNAUTHORIZED', 'An API key is required (Authorization: Bearer <key> or X-API-Key)', 'auth_missing');
  }
  try {
    return await apiKeyService.verifyKey(rawKey);
  } catch (err) {
    if (err && err.statusCode === 401) {
      if (err.keyId !== undefined) req.gw.apiKeyId = err.keyId;
      await noteFailure();
      throw unauthorized('INVALID_API_KEY', 'Invalid API key', `auth_${err.reason || 'invalid'}`);
    }
    throw err;
  }
}

// ---- the gateway endpoint ---------------------------------------------------------------------------
router.all('/:slug{/*rest}', async (req, res) => {
  const gw = req.gw;

  // 1. Authenticate (gateway API key only — dashboard JWTs are deliberately not accepted here).
  const key = await authenticate(req, res);
  gw.apiKeyId = key.id;
  const slug = req.params.slug;
  if (SLUG_RE.test(slug)) gw.apiSlug = slug;

  // 2. Rate limit per key. Counted before any route lookup so probing unknown routes is limited too.
  const rl = await rateLimiter.consume(`key:${key.id}`, key.rateLimitPerMinute);
  setRateHeaders(res, rl);
  if (!rl.allowed) {
    throw new GatewayError(429, 'RATE_LIMIT_EXCEEDED', 'Rate limit exceeded. Retry after the reset time.', {
      category: 'rate_limited', outcome: 'rate_limited', headers: { 'Retry-After': String(rl.resetSeconds) },
    });
  }

  // 3. Method sanity, then route lookup.
  if (!SUPPORTED_METHODS.includes(req.method)) {
    throw new GatewayError(405, 'METHOD_NOT_ALLOWED', 'This method is not supported by the gateway', {
      category: 'method_not_allowed', headers: { Allow: SUPPORTED_METHODS.join(', ') },
    });
  }
  const api = gw.apiSlug ? await apiModel.findGatewayBySlug(slug) : null;
  if (!api) throw new GatewayError(404, 'ROUTE_NOT_FOUND', 'No gateway route matches this path', { category: 'route_not_found' });
  gw.api = api;

  // 4. Is THIS key allowed to call THIS API?
  if (!(await apiKeyModel.hasGrant(key.id, api.id))) {
    throw new GatewayError(403, 'FORBIDDEN', 'This API key is not authorized for this API', { category: 'forbidden' });
  }

  // 5. Enabled? (checked after the grant so unauthorized keys learn nothing about disabled routes)
  if (!api.gateway_enabled) {
    throw new GatewayError(503, 'SERVICE_DISABLED', 'This API is currently disabled', { category: 'service_disabled' });
  }

  // 6. Method allowed for this route?
  if (!api.allowed_methods.includes(req.method)) {
    throw new GatewayError(405, 'METHOD_NOT_ALLOWED', 'This method is not allowed for this API', {
      category: 'method_not_allowed', headers: { Allow: api.allowed_methods.join(', ') },
    });
  }

  // 7. Safe upstream path + early body-size rejection.
  let target;
  try {
    target = buildUpstreamPath(req.originalUrl, api.base_url);
  } catch (err) {
    if (err instanceof PathError) throw new GatewayError(err.status, err.code, err.message, { category: err.code.toLowerCase() });
    throw err;
  }
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > env.GATEWAY_MAX_BODY_BYTES) {
    throw new GatewayError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large', {
      category: 'payload_too_large', headers: { Connection: 'close' },
    });
  }

  // Upstream credential (decrypted only here, only for the duration of this request).
  let credentialHeader = null;
  if (api.upstream_auth_mode !== 'none') {
    try {
      const secret = decrypt(api.upstream_credential_enc);
      credentialHeader = api.upstream_auth_mode === 'bearer'
        ? { name: 'authorization', value: `Bearer ${secret}` }
        : { name: api.upstream_auth_header, value: secret };
    } catch (err) {
      logger.error('Upstream credential could not be decrypted', { apiId: api.id });
      throw new GatewayError(500, 'GATEWAY_MISCONFIGURED', 'This API is not configured correctly', { category: 'config_error', outcome: 'gateway_error' });
    }
  }

  const headers = buildUpstreamHeaders(req.headers, api.forward_headers, gw.requestId, credentialHeader);

  // 8. Forward (streamed). Rejects only if nothing has been sent to the client yet.
  await forward({ req, res, api, upstreamPath: target.upstreamPath, headers, gw });
});

// Anything under /gateway that is not /gateway/<slug>... (e.g. "/gateway" itself).
router.use(() => {
  throw new GatewayError(404, 'ROUTE_NOT_FOUND', 'No gateway route matches this path', { category: 'route_not_found' });
});

// Gateway-specific error handler: consistent envelope, no stack traces, no secrets.
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  const gw = req.gw;
  let out = err;

  if (!(out instanceof GatewayError)) {
    // Express itself rejects some malformed URLs (e.g. "%zz") with a 400 before our handler runs.
    if (err && (err.status === 400 || err.statusCode === 400) && err instanceof URIError) {
      out = new GatewayError(400, 'INVALID_PATH', 'Request path contains invalid percent-encoding', { category: 'invalid_path' });
    } else if (isDatabaseDown(err)) {
      out = new GatewayError(503, 'SERVICE_UNAVAILABLE', 'The gateway is temporarily unavailable', { category: 'db_unavailable', outcome: 'gateway_error' });
    } else {
      out = new GatewayError(500, 'INTERNAL_SERVER_ERROR', 'Something went wrong. Please try again.', { category: 'internal', outcome: 'gateway_error' });
    }
    logger.error('Gateway internal error', { requestId: gw && gw.requestId, error: err.message, stack: err.stack });
  }

  if (gw) {
    gw.errorCategory = out.category;
    gw.outcome = out.outcome;
  }
  if (res.headersSent) return res.destroy();

  Object.entries(out.headers).forEach(([k, v]) => res.setHeader(k, v));
  res.setHeader('X-BridgeX-Error', 'true');
  return res.status(out.status).json({
    success: false,
    error: { code: out.code, message: out.message, details: [] },
    requestId: gw ? gw.requestId : undefined,
  });
});

module.exports = router;
