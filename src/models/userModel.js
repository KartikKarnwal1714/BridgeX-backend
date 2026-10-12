const { pool } = require('../config/database');

const PUBLIC_COLUMNS = `id, name, email, role, status, created_at, updated_at, last_active`;

async function findAll() {
  const { rows } = await pool.query(
    `SELECT ${PUBLIC_COLUMNS} FROM users ORDER BY created_at DESC`
  );
  return rows;
}

async function findById(id) {
  const { rows } = await pool.query(
    `SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

// Includes password_hash — only for internal auth use, never returned to clients.
async function findByEmail(email) {
  const { rows } = await pool.query(`SELECT * FROM users WHERE email = $1`, [email]);
  return rows[0] || null;
}

async function create({ name, email, passwordHash, role, status = 'Active' }) {
  const { rows } = await pool.query(
    `INSERT INTO users (name, email, password_hash, role, status)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${PUBLIC_COLUMNS}`,
    [name, email, passwordHash, role, status]
  );
  return rows[0];
}

async function update(id, fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return findById(id);

  const setClause = keys.map((key, i) => `${key} = $${i + 2}`).join(', ');
  const values = keys.map((key) => fields[key]);

  const { rows } = await pool.query(
    `UPDATE users SET ${setClause}, updated_at = NOW()
     WHERE id = $1
     RETURNING ${PUBLIC_COLUMNS}`,
    [id, ...values]
  );
  return rows[0] || null;
}

async function remove(id) {
  const { rowCount } = await pool.query(`DELETE FROM users WHERE id = $1`, [id]);
  return rowCount > 0;
}

module.exports = { findAll, findById, findByEmail, create, update, remove };
