const crypto = require('crypto');
const apiKeyModel = require('../models/apiKeyModel');
const { ApiError } = require('../utils/response');

function hashKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

function generateRawKey(environment) {
  const prefix = environment === 'Test' ? 'bx_test_' : 'bx_live_';
  const secret = crypto.randomBytes(24).toString('hex'); // 48 hex chars
  return `${prefix}${secret}`;
}

function previewOf(rawKey) {
  const visibleSuffix = rawKey.slice(-4);
  const prefix = rawKey.startsWith('bx_test_') ? 'bx_test_' : 'bx_live_';
  return `${prefix}\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022${visibleSuffix}`;
}

// SUPER_ADMIN manages every key; everyone else only sees and manages their own.
function canManageAll(user) {
  return user.role === 'SUPER_ADMIN';
}

async function listKeys(user) {
  const rows = await apiKeyModel.findAll(canManageAll(user) ? {} : { ownerId: user.id });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    preview: r.key_preview,
    environment: r.environment,
    status: r.status,
    owner: r.owner_name || 'Unknown',
    lastUsed: r.last_used,
    created: r.created_at,
    rateLimitPerMinute: r.rate_limit_per_minute,
    expiresAt: r.expires_at,
    apiIds: r.api_ids || [],
  }));
}

async function createKey({ name, environment = 'Live' }, ownerId) {
  const rawKey = generateRawKey(environment);
  const keyHash = hashKey(rawKey);
  const keyPreview = previewOf(rawKey);

  const row = await apiKeyModel.create({ name, keyHash, keyPreview, environment, ownerId });

  return {
    id: row.id,
    name: row.name,
    // The only time the full, usable key is ever returned — the caller
    // must store it now, since only the preview is retrievable later.
    key: rawKey,
    preview: row.key_preview,
    environment: row.environment,
    status: row.status,
    created: row.created_at,
    rateLimitPerMinute: row.rate_limit_per_minute,
    expiresAt: row.expires_at,
    apiIds: row.api_ids || [],
  };
}

async function revokeKey(id, user) {
  const existing = await apiKeyModel.findById(id);
  // Same 404 for "missing" and "someone else's key" so key ids cannot be probed.
  if (!existing || (!canManageAll(user) && existing.owner_id !== user.id)) {
    throw new ApiError(404, 'NOT_FOUND', 'API key not found');
  }
  return apiKeyModel.updateStatus(id, 'Revoked');
}

async function deleteKey(id) {
  const deleted = await apiKeyModel.remove(id);
  if (!deleted) throw new ApiError(404, 'NOT_FOUND', 'API key not found');
}

/**
 * Authenticates a raw gateway API key. Returns the key's metadata when it is valid, otherwise
 * throws 401 INVALID_API_KEY. The response is deliberately the same for every failure (unknown,
 * revoked, expired, owner disabled) so it cannot be used to probe key states; the real reason is
 * attached as a non-serialised `reason` property for the gateway's own (secret-free) logs.
 */
async function verifyKey(rawKey) {
  const fail = (reason, keyId) => {
    const err = new ApiError(401, 'INVALID_API_KEY', 'Invalid API key');
    err.reason = reason;
    if (keyId !== undefined) err.keyId = keyId; // numeric id only, for audit logs
    return err;
  };

  if (typeof rawKey !== 'string' || !/^bx_(live|test)_[a-f0-9]{48}$/.test(rawKey)) throw fail('malformed');

  const row = await apiKeyModel.findByHash(hashKey(rawKey));
  if (!row) throw fail('unknown');
  if (row.status !== 'Active') throw fail('revoked', row.id);
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) throw fail('expired', row.id);
  // A key is only as valid as its owner: deleted (NULL) or deactivated owners disable their keys.
  if (row.owner_status !== 'Active') throw fail('owner_inactive', row.id);

  // last_used is informational — a failed write must never fail the caller's request.
  apiKeyModel.touchLastUsed(row.id).catch(() => {});

  return {
    id: row.id,
    name: row.name,
    environment: row.environment,
    ownerId: row.owner_id,
    rateLimitPerMinute: row.rate_limit_per_minute,
  };
}

async function updateGatewaySettings(id, body) {
  const existing = await apiKeyModel.findById(id);
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'API key not found');

  if (body.expiresAt && new Date(body.expiresAt).getTime() <= Date.now()) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', [
      { field: '/expiresAt', message: 'must be a date in the future' },
    ]);
  }
  try {
    const row = await apiKeyModel.updateGatewaySettings(id, {
      rateLimitPerMinute: body.rateLimitPerMinute,
      expiresAt: body.expiresAt === undefined ? undefined : body.expiresAt,
      apiIds: body.apiIds,
    });
    return {
      id: row.id,
      name: row.name,
      preview: row.key_preview,
      environment: row.environment,
      status: row.status,
      rateLimitPerMinute: row.rate_limit_per_minute,
      expiresAt: row.expires_at,
      apiIds: row.api_ids || [],
    };
  } catch (err) {
    // 23503 = foreign key violation: one of the apiIds does not exist.
    if (err && err.code === '23503') {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', [
        { field: '/apiIds', message: 'contains an API that does not exist' },
      ]);
    }
    throw err;
  }
}

module.exports = { listKeys, createKey, revokeKey, deleteKey, verifyKey, updateGatewaySettings };
