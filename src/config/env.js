const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  return value;
}

const env = {
  NODE_ENV: required('NODE_ENV', 'development'),
  PORT: parseInt(required('PORT', '5000'), 10),

  DATABASE_URL: required(
    'DATABASE_URL',
    'postgresql://postgres:postgres@localhost:5432/bridgex'
  ),

  MONGO_URI: required('MONGO_URI', 'mongodb://localhost:27017/bridgex_logs'),

  REDIS_URL: required('REDIS_URL', 'redis://localhost:6379'),

  JWT_SECRET: required('JWT_SECRET', 'dev-secret-change-me'),
  JWT_EXPIRES_IN: required('JWT_EXPIRES_IN', '1h'),

  CLIENT_URL: required('CLIENT_URL', 'http://localhost:5173'),

  BCRYPT_SALT_ROUNDS: parseInt(required('BCRYPT_SALT_ROUNDS', '10'), 10),

  // How long request logs are kept in MongoDB before automatic deletion.
  LOG_RETENTION_DAYS: Math.max(1, parseInt(required('LOG_RETENTION_DAYS', '30'), 10) || 30),

  // ---- API gateway (Phase 3) ----
  GATEWAY_MAX_BODY_BYTES: intEnv('GATEWAY_MAX_BODY_BYTES', 1024 * 1024, 1024, 100 * 1024 * 1024),
  GATEWAY_MAX_RESPONSE_BYTES: intEnv('GATEWAY_MAX_RESPONSE_BYTES', 10 * 1024 * 1024, 1024, 1024 * 1024 * 1024),
  GATEWAY_MAX_TIMEOUT_MS: intEnv('GATEWAY_MAX_TIMEOUT_MS', 30000, 100, 60000),
  GATEWAY_DEFAULT_TIMEOUT_MS: intEnv('GATEWAY_DEFAULT_TIMEOUT_MS', 10000, 100, 60000),
  // Fixed rate-limit window. 60s means "rate_limit_per_minute" is literal; shorter values exist for tests.
  GATEWAY_RATE_WINDOW_MS: intEnv('GATEWAY_RATE_WINDOW_MS', 60000, 1000, 3600000),
};

function intEnv(name, fallback, min, max) {
  const n = parseInt(process.env[name] ?? '', 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Key used to encrypt upstream credentials at rest (AES-256-GCM, 32 bytes = 64 hex chars).
// Production must supply its own; in development/test one is derived from JWT_SECRET so
// the project works out of the box (never rely on that outside local use).
function resolveEncryptionKey() {
  const provided = process.env.GATEWAY_ENCRYPTION_KEY;
  if (provided) {
    if (!/^[a-fA-F0-9]{64}$/.test(provided)) {
      throw new Error('GATEWAY_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
    }
    return provided.toLowerCase();
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('GATEWAY_ENCRYPTION_KEY must be set in production');
  }
  return require('crypto').createHash('sha256').update(`bridgex-gateway:${env.JWT_SECRET}`).digest('hex');
}

// Development-only escape hatch: "host:port" pairs of LOCAL test upstreams that may bypass the
// private-address block. Read at call time (tests set it after starting a mock server).
// It does nothing — and refuses to even load — in production.
env.devAllowedUpstreams = function devAllowedUpstreams() {
  if (env.NODE_ENV === 'production') return [];
  return (process.env.GATEWAY_DEV_ALLOWED_UPSTREAMS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
};

if (env.NODE_ENV === 'test' && process.env.TEST_DATABASE_URL) {
  // Lets the test suite run against a separate database so tests never
  // touch your development data.
  env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

if (
  env.NODE_ENV === 'production' &&
  (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'dev-secret-change-me' || process.env.JWT_SECRET.length < 32)
) {
  throw new Error('JWT_SECRET must be set to a strong value (32+ characters) in production');
}

if (env.NODE_ENV === 'production' && process.env.GATEWAY_DEV_ALLOWED_UPSTREAMS) {
  throw new Error('GATEWAY_DEV_ALLOWED_UPSTREAMS must not be set in production');
}

env.GATEWAY_ENCRYPTION_KEY = resolveEncryptionKey();

module.exports = env;
