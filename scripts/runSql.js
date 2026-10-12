/**
 * Cross-platform SQL runner (works on Windows without psql installed).
 *
 * Usage: node scripts/runSql.js [--dev-only] <file.sql> [more.sql ...]
 * Reads DATABASE_URL from backend/.env (same as the API). Files run in the
 * order given, each inside the connection's default transaction semantics.
 * All BridgeX migration files use IF NOT EXISTS / ON CONFLICT, so they are
 * safe to run more than once.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const env = require('../src/config/env');

async function main() {
  const args = process.argv.slice(2);
  const devOnly = args.includes('--dev-only');
  const files = args.filter((a) => !a.startsWith('--'));

  if (files.length === 0) {
    console.error('Usage: node scripts/runSql.js [--dev-only] <file.sql> [...]');
    process.exit(1);
  }
  if (devOnly && env.NODE_ENV === 'production') {
    console.error('Refusing to run demo seed data when NODE_ENV=production.');
    process.exit(1);
  }

  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    for (const file of files) {
      const sql = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
      await client.query(sql);
      console.log(`Applied ${file}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
});
