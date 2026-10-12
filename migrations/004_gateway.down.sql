-- Rollback for 004_gateway.sql. WARNING: deletes gateway configuration, key grants,
-- and encrypted upstream credentials. Back up first: pg_dump "$DATABASE_URL" > backup.sql
DROP TABLE IF EXISTS api_key_apis;
DROP INDEX IF EXISTS idx_apis_gateway_slug;
ALTER TABLE apis
  DROP CONSTRAINT IF EXISTS apis_gateway_slug_format,
  DROP CONSTRAINT IF EXISTS apis_gateway_timeout_range,
  DROP CONSTRAINT IF EXISTS apis_upstream_auth_mode_valid,
  DROP CONSTRAINT IF EXISTS apis_enabled_requires_slug,
  DROP COLUMN IF EXISTS gateway_slug, DROP COLUMN IF EXISTS gateway_enabled,
  DROP COLUMN IF EXISTS allowed_methods, DROP COLUMN IF EXISTS timeout_ms,
  DROP COLUMN IF EXISTS upstream_auth_mode, DROP COLUMN IF EXISTS upstream_auth_header,
  DROP COLUMN IF EXISTS upstream_credential_enc, DROP COLUMN IF EXISTS forward_headers;
ALTER TABLE api_keys
  DROP CONSTRAINT IF EXISTS api_keys_rate_limit_range,
  DROP COLUMN IF EXISTS rate_limit_per_minute, DROP COLUMN IF EXISTS expires_at;
