-- BridgeX Phase 3 — API gateway configuration, per-key rate limits and API grants.
-- Additive and idempotent: no existing column, table or row is dropped or rewritten.
-- Reverse with: migrations/004_gateway.down.sql

-- 1) Upstream / route configuration lives on the existing "apis" table.
ALTER TABLE apis
  ADD COLUMN IF NOT EXISTS gateway_slug VARCHAR(50),
  ADD COLUMN IF NOT EXISTS gateway_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS allowed_methods TEXT[] NOT NULL DEFAULT ARRAY['GET','POST','PUT','PATCH','DELETE'],
  ADD COLUMN IF NOT EXISTS timeout_ms INT NOT NULL DEFAULT 10000,
  ADD COLUMN IF NOT EXISTS upstream_auth_mode VARCHAR(10) NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS upstream_auth_header VARCHAR(100),
  ADD COLUMN IF NOT EXISTS upstream_credential_enc TEXT,   -- AES-256-GCM ciphertext, never plaintext
  ADD COLUMN IF NOT EXISTS forward_headers TEXT[] NOT NULL DEFAULT '{}';

-- 2) Per-key gateway settings on the existing "api_keys" table.
ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS rate_limit_per_minute INT NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- 3) Constraints (guarded so the file can be re-run).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'apis_gateway_slug_format') THEN
    ALTER TABLE apis ADD CONSTRAINT apis_gateway_slug_format
      CHECK (gateway_slug IS NULL OR gateway_slug ~ '^[a-z0-9]([a-z0-9-]{0,48}[a-z0-9])?$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'apis_gateway_timeout_range') THEN
    ALTER TABLE apis ADD CONSTRAINT apis_gateway_timeout_range CHECK (timeout_ms BETWEEN 100 AND 60000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'apis_upstream_auth_mode_valid') THEN
    ALTER TABLE apis ADD CONSTRAINT apis_upstream_auth_mode_valid
      CHECK (upstream_auth_mode IN ('none', 'bearer', 'header'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'apis_enabled_requires_slug') THEN
    ALTER TABLE apis ADD CONSTRAINT apis_enabled_requires_slug
      CHECK (NOT gateway_enabled OR gateway_slug IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_rate_limit_range') THEN
    ALTER TABLE api_keys ADD CONSTRAINT api_keys_rate_limit_range
      CHECK (rate_limit_per_minute BETWEEN 1 AND 10000);
  END IF;
END $$;

-- Route conflicts are impossible at the database level: one slug, one API.
CREATE UNIQUE INDEX IF NOT EXISTS idx_apis_gateway_slug ON apis (gateway_slug) WHERE gateway_slug IS NOT NULL;

-- 4) Which API keys may call which APIs. No row = no access (explicit grants only).
CREATE TABLE IF NOT EXISTS api_key_apis (
  api_key_id INT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  api_id INT NOT NULL REFERENCES apis(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (api_key_id, api_id)
);
CREATE INDEX IF NOT EXISTS idx_api_key_apis_api ON api_key_apis (api_id);
