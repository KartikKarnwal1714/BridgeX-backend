-- BridgeX Phase 3 — API Keys + Settings
-- Run with: psql "$DATABASE_URL" -f migrations/003_phase3.sql

CREATE TABLE IF NOT EXISTS api_keys (
  id SERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  key_hash TEXT NOT NULL,
  key_preview VARCHAR(40) NOT NULL,
  environment VARCHAR(10) NOT NULL DEFAULT 'Live' CHECK (environment IN ('Live', 'Test')),
  status VARCHAR(20) NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Revoked')),
  owner_id INT REFERENCES users(id) ON DELETE SET NULL,
  last_used TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_owner ON api_keys (owner_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_status ON api_keys (status);

-- Single-row table holding platform-wide settings as JSON so new fields can
-- be added on the frontend without another migration.
CREATE TABLE IF NOT EXISTS app_settings (
  id INT PRIMARY KEY DEFAULT 1,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT app_settings_single_row CHECK (id = 1)
);

INSERT INTO app_settings (id, data)
VALUES (
  1,
  '{
    "applicationName": "BridgeX",
    "timezone": "(GMT+5:30) India Standard Time",
    "dateFormat": "DD/MM/YYYY",
    "jwtExpiry": "1 hour",
    "sessionTimeout": "30 minutes",
    "passwordPolicy": "Strong (min. 12 characters)",
    "emailNotifications": true,
    "systemAlerts": true,
    "apiFailureAlerts": false,
    "theme": "Light"
  }'::jsonb
)
ON CONFLICT (id) DO NOTHING;
