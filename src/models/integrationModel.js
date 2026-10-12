const { pool } = require('../config/database');

async function findAll() {
  const { rows } = await pool.query(`SELECT * FROM integrations ORDER BY created_at DESC`);
  return rows;
}

async function findById(id) {
  const { rows } = await pool.query(`SELECT * FROM integrations WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function create({ name, type, protocol, endpoint, status = 'Pending' }) {
  const { rows } = await pool.query(
    `INSERT INTO integrations (name, type, protocol, endpoint, status)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [name, type, protocol, endpoint, status]
  );
  return rows[0];
}

async function update(id, fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return findById(id);

  const setClause = keys.map((key, i) => `${key} = $${i + 2}`).join(', ');
  const values = keys.map((key) => fields[key]);

  const { rows } = await pool.query(
    `UPDATE integrations SET ${setClause}, last_sync = NOW(), updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id, ...values]
  );
  return rows[0] || null;
}

async function remove(id) {
  const { rowCount } = await pool.query(`DELETE FROM integrations WHERE id = $1`, [id]);
  return rowCount > 0;
}

module.exports = { findAll, findById, create, update, remove };
