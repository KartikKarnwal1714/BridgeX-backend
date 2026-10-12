const { pool } = require('../config/database');

async function get() {
  const { rows } = await pool.query(`SELECT data, updated_at FROM app_settings WHERE id = 1`);
  return rows[0] || null;
}

async function update(patch) {
  const { rows } = await pool.query(
    `UPDATE app_settings
     SET data = data || $1::jsonb, updated_at = NOW()
     WHERE id = 1
     RETURNING data, updated_at`,
    [JSON.stringify(patch)]
  );
  return rows[0];
}

module.exports = { get, update };
