const apiModel = require('../models/apiModel');
const { ApiError } = require('../utils/response');
const { validateUpstreamUrl } = require('../utils/ssrf');
const { encrypt } = require('../utils/secretBox');
const { FORBIDDEN_FORWARD_HEADERS } = require('../gateway/headers');


function invalid(field, message) {
  return new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', [{ field: `/${field}`, message }]);
}

function originOf(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/**
 * Validates the gateway part of an API's configuration after merging a request onto the stored
 * values. Throws a 400 describing the first problem. Only runs when the API is gateway-enabled
 * (or is being given a route), because older "registry" entries legitimately hold relative paths.
 */
function validateGatewayConfig(merged, { hasCredential }) {
  const routed = merged.gateway_enabled || merged.gateway_slug;
  if (!routed) return;

  if (merged.gateway_enabled && !merged.gateway_slug) {
    throw invalid('gateway_slug', 'is required before the gateway can be enabled');
  }
  validateUpstreamUrl(merged.base_url); // throws 400 on any unsafe/malformed upstream

  if (merged.upstream_auth_mode === 'header') {
    if (!merged.upstream_auth_header) throw invalid('upstream_auth_header', 'is required when upstream_auth_mode is "header"');
    if (FORBIDDEN_FORWARD_HEADERS.has(merged.upstream_auth_header.toLowerCase()) && merged.upstream_auth_header.toLowerCase() !== 'authorization') {
      throw invalid('upstream_auth_header', 'is not an allowed header name');
    }
  }
  if (merged.upstream_auth_mode !== 'none' && !hasCredential) {
    throw invalid('upstream_credential', `is required when upstream_auth_mode is "${merged.upstream_auth_mode}"`);
  }
  for (const h of merged.forward_headers || []) {
    if (FORBIDDEN_FORWARD_HEADERS.has(h.toLowerCase())) {
      throw invalid('forward_headers', `"${h}" cannot be forwarded to upstreams`);
    }
  }
}

// Splits the write-only credential off the request and returns the columns to persist.
function toColumns(body, existing) {
  const cols = { ...body };
  delete cols.upstream_credential;
  if (body.upstream_credential !== undefined) {
    cols.upstream_credential_enc = body.upstream_credential === null ? null : encrypt(body.upstream_credential);
  }
  if (body.gateway_slug !== undefined && body.gateway_slug === null && existing) {
    cols.gateway_enabled = false; // an API without a route cannot be enabled
  }
  return cols;
}

async function listApis() {
  return apiModel.findAll();
}

async function getApi(id) {
  const api = await apiModel.findById(id);
  if (!api) {
    throw new ApiError(404, 'NOT_FOUND', 'API not found');
  }
  return api;
}

async function assertSlugFree(slug, exceptId) {
  if (!slug) return;
  const owner = await apiModel.findGatewayBySlug(slug);
  if (owner && String(owner.id) !== String(exceptId)) {
    throw new ApiError(409, 'GATEWAY_ROUTE_CONFLICT', `The gateway route "${slug}" is already used by another API`);
  }
}

async function createApi(payload) {
  const merged = {
    gateway_enabled: false, gateway_slug: null, upstream_auth_mode: 'none', forward_headers: [], ...payload,
  };
  validateGatewayConfig(merged, { hasCredential: Boolean(payload.upstream_credential) });
  await assertSlugFree(payload.gateway_slug, null);
  try {
    return await apiModel.create(toColumns(payload, null));
  } catch (err) {
    if (err.code === '23505' && /gateway_slug/.test(err.constraint || err.detail || '')) {
      throw new ApiError(409, 'GATEWAY_ROUTE_CONFLICT', 'That gateway route is already used by another API');
    }
    throw err;
  }
}

async function updateApi(id, fields) {
  const existing = await apiModel.findByIdWithSecret(id);
  if (!existing) {
    throw new ApiError(404, 'NOT_FOUND', 'API not found');
  }

  const merged = { ...existing, ...fields };
  if (fields.gateway_slug === null) merged.gateway_enabled = false;
  const credentialAfter =
    fields.upstream_credential !== undefined ? Boolean(fields.upstream_credential) : Boolean(existing.upstream_credential_enc);

  // A stored credential must never silently follow a change of upstream host.
  if (
    fields.base_url !== undefined &&
    originOf(fields.base_url) !== originOf(existing.base_url) &&
    existing.upstream_credential_enc &&
    fields.upstream_credential === undefined
  ) {
    throw invalid('upstream_credential', 'must be provided again when the upstream host changes');
  }

  validateGatewayConfig(merged, { hasCredential: credentialAfter });
  if (fields.gateway_slug) await assertSlugFree(fields.gateway_slug, id);

  try {
    return await apiModel.update(id, toColumns(fields, existing));
  } catch (err) {
    if (err.code === '23505' && /gateway_slug/.test(err.constraint || err.detail || '')) {
      throw new ApiError(409, 'GATEWAY_ROUTE_CONFLICT', 'That gateway route is already used by another API');
    }
    throw err;
  }
}

async function deleteApi(id) {
  const existing = await apiModel.findById(id);
  if (!existing) {
    throw new ApiError(404, 'NOT_FOUND', 'API not found');
  }
  await apiModel.remove(id);
}

module.exports = { listApis, getApi, createApi, updateApi, deleteApi };
