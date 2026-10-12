const { pool } = require('../config/database');

const PUBLIC_COLUMNS = `
  ak.id, ak.name, ak.key_preview, ak.environment, ak.status,
  ak.last_used, ak.created_at, ak.rate_limit_per_minute, ak.expires_at,
  COALESCE((SELECT array_agg(g.api_id ORDER BY g.api_id) FROM api_key_apis g WHERE g.api_key_id = ak.id), '{}') AS api_ids,
  u.id AS owner_id, u.name AS owner_name
`;
const RETURNING = `id, name, key_preview, environment, status, last_used, created_at, owner_id,
  rate_limit_per_minute, expires_at,
  COALESCE((SELECT array_agg(g.api_id ORDER BY g.api_id) FROM api_key_apis g WHERE g.api_key_id = api_keys.id), '{}') AS api_ids`;

// ownerId === undefined -> every key (SUPER_ADMIN); otherwise only that owner's keys.
async function findAll({ ownerId } = {}) {
  const filtered = ownerId !== undefined;
  const { rows } = await pool.query(
    `SELECT ${PUBLIC_COLUMNS}
     FROM api_keys ak
     LEFT JOIN users u ON u.id = ak.owner_id
     ${filtered ? 'WHERE ak.owner_id = $1' : ''}
     ORDER BY ak.created_at DESC`,
    filtered ? [ownerId] : []
  );
  return rows;
}

// Internal use only (key verification): includes the hash, never sent to clients.
async function findByHash(keyHash) {
  const { rows } = await pool.query(
    `SELECT ak.id, ak.name, ak.environment, ak.status, ak.owner_id, ak.expires_at,
            ak.rate_limit_per_minute, u.status AS owner_status
     FROM api_keys ak
     LEFT JOIN users u ON u.id = ak.owner_id
     WHERE ak.key_hash = $1`,
    [keyHash]
  );
  return rows[0] || null;
}

// Throttled to one write per minute per key so authenticating a request never costs a write
// on the hot path (last_used is informational, so minute precision is enough).
async function touchLastUsed(id) {
  await pool.query(
    `UPDATE api_keys SET last_used = NOW()
     WHERE id = $1 AND (last_used IS NULL OR last_used < NOW() - INTERVAL '1 minute')`,
    [id]
  );
}

async function hasGrant(keyId, apiId) {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM api_key_apis WHERE api_key_id = $1 AND api_id = $2`,
    [keyId, apiId]
  );
  return rowCount > 0;
}

// Updates gateway settings and (when apiIds is given) replaces the key's API grants atomically.
async function updateGatewaySettings(id, { rateLimitPerMinute, expiresAt, apiIds }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sets = [];
    const values = [id];
    if (rateLimitPerMinute !== undefined) {
      values.push(rateLimitPerMinute);
      sets.push(`rate_limit_per_minute = $${values.length}`);
    }
    if (expiresAt !== undefined) {
      values.push(expiresAt);
      sets.push(`expires_at = $${values.length}`);
    }
    if (sets.length) {
      const { rowCount } = await client.query(`UPDATE api_keys SET ${sets.join(', ')} WHERE id = $1`, values);
      if (rowCount === 0) {
        await client.query('ROLLBACK');
        return null;
      }
    }
    if (apiIds !== undefined) {
      await client.query(`DELETE FROM api_key_apis WHERE api_key_id = $1`, [id]);
      if (apiIds.length) {
        await client.query(
          `INSERT INTO api_key_apis (api_key_id, api_id) SELECT $1, UNNEST($2::int[])`,
          [id, apiIds]
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return findById(id);
}

async function findById(id) {
  const { rows } = await pool.query(
    `SELECT ${PUBLIC_COLUMNS}
     FROM api_keys ak
     LEFT JOIN users u ON u.id = ak.owner_id
     WHERE ak.id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function create({ name, keyHash, keyPreview, environment, ownerId }) {
  const { rows } = await pool.query(
    `INSERT INTO api_keys (name, key_hash, key_preview, environment, owner_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${RETURNING}`,
    [name, keyHash, keyPreview, environment, ownerId]
  );
  return rows[0];
}

async function updateStatus(id, status) {
  const { rows } = await pool.query(
    `UPDATE api_keys SET status = $2 WHERE id = $1
     RETURNING ${RETURNING}`,
    [id, status]
  );
  return rows[0] || null;
}

async function remove(id) {
  const { rowCount } = await pool.query(`DELETE FROM api_keys WHERE id = $1`, [id]);
  return rowCount > 0;
}

module.exports = { findAll, findById, findByHash, touchLastUsed, hasGrant, updateGatewaySettings, create, updateStatus, remove };
