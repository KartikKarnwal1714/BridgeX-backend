const { Pool } = require('pg');
const env = require('./env');
const logger = require('../utils/logger');

const pool = new Pool({
  connectionString: env.DATABASE_URL,
});

pool.on('error', (err) => {
  logger.error('Unexpected PostgreSQL pool error', { error: err.message });
});

async function connectPostgres() {
  try {
    const client = await pool.connect();
    client.release();
    logger.info('PostgreSQL connected');
  } catch (err) {
    logger.error('PostgreSQL connection failed', { error: err.message });
    throw err;
  }
}

module.exports = { pool, connectPostgres };
