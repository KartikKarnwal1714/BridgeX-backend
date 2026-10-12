const { pool } = require('../config/database');

// Explicit column list: the encrypted upstream credential is NEVER selected for
// dashboard responses. Only a boolean saying whether one is set is exposed.
const PUBLIC_COLUMNS = `
  id, name, description, protocol, base_url, status, request_count, success_rate,
  average_response_time, created_at, updated_at,
  gateway_slug, gateway_enabled, allowed_methods, timeout_ms,
  upstream_auth_mode, upstream_auth_header, forward_headers,
  (upstream_credential_enc IS NOT NULL) AS has_upstream_credential
`;

// Columns the update() helper may write. Anything else is ignored, so column names
// can never come from request data.
const WRITABLE = new Set([
  'name', 'description', 'protocol', 'base_url', 'status',
  'gateway_slug', 'gateway_enabled', 'allowed_methods', 'timeout_ms',
  'upstream_auth_mode', 'upstream_auth_header', 'upstream_credential_enc', 'forward_headers',
]);

async function findAll() {
  const { rows } = await pool.query(`SELECT ${PUBLIC_COLUMNS} FROM apis ORDER BY created_at DESC`);
  return rows;
}

async function findById(id) {
  const { rows } = await pool.query(`SELECT ${PUBLIC_COLUMNS} FROM apis WHERE id = $1`, [id]);
  return rows[0] || null;
}

// Internal: includes the encrypted credential. Used only to merge/validate config and by the gateway.
async function findByIdWithSecret(id) {
  const { rows } = await pool.query(`SELECT * FROM apis WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function findGatewayBySlug(slug) {
  const { rows } = await pool.query(`SELECT * FROM apis WHERE gateway_slug = $1`, [slug]);
  return rows[0] || null;
}

async function create({ name, description = null, protocol, base_url, status = 'Healthy', ...gateway }) {
  const fields = { name, description, protocol, base_url, status, ...gateway };
  const keys = Object.keys(fields).filter((k) => WRITABLE.has(k) && fields[k] !== undefined);
  const cols = keys.join(', ');
  const params = keys.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await pool.query(
    `INSERT INTO apis (${cols}) VALUES (${params}) RETURNING ${PUBLIC_COLUMNS}`,
    keys.map((k) => fields[k])
  );
  return rows[0];
}

async function update(id, fields) {
  const keys = Object.keys(fields).filter((k) => WRITABLE.has(k));
  if (keys.length === 0) return findById(id);

  const setClause = keys.map((key, i) => `${key} = $${i + 2}`).join(', ');
  const values = keys.map((key) => fields[key]);

  const { rows } = await pool.query(
    `UPDATE apis SET ${setClause}, updated_at = NOW()
     WHERE id = $1
     RETURNING ${PUBLIC_COLUMNS}`,
    [id, ...values]
  );
  return rows[0] || null;
}

async function remove(id) {
  const { rowCount } = await pool.query(`DELETE FROM apis WHERE id = $1`, [id]);
  return rowCount > 0;
}

/**
 * Records one forwarded gateway request in the counters the dashboard already reads
 * (request_count, success_rate, average_response_time). One atomic UPDATE: concurrent
 * requests cannot lose increments. "Successful" means status < 400, same as Analytics.
 */
async function recordGatewayResult(id, ok, responseTimeMs) {
  await pool.query(
    `UPDATE apis SET
       success_rate = ROUND(((success_rate * request_count) + $2::numeric) / (request_count + 1), 2),
       average_response_time = ROUND(((average_response_time::numeric * request_count) + $3::numeric) / (request_count + 1))::int,
       request_count = request_count + 1
     WHERE id = $1`,
    [id, ok ? 100 : 0, Math.max(0, Math.round(responseTimeMs))]
  );
}

module.exports = { findAll, findById, findByIdWithSecret, findGatewayBySlug, create, update, remove, recordGatewayResult };
