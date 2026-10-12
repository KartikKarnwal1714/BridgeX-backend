-- BridgeX Phase 2 — initial schema
-- Run with: psql "$DATABASE_URL" -f migrations/001_init.sql

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(150) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('SUPER_ADMIN', 'DEVELOPER', 'VIEWER', 'SUPPORT')),
  status VARCHAR(20) NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS apis (
  id SERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  description VARCHAR(500),
  protocol VARCHAR(20) NOT NULL CHECK (protocol IN ('REST', 'GRAPHQL', 'SOAP')),
  base_url VARCHAR(300) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'Healthy' CHECK (status IN ('Healthy', 'Degraded', 'Error')),
  request_count BIGINT NOT NULL DEFAULT 0,
  success_rate NUMERIC(5,2) NOT NULL DEFAULT 100,
  average_response_time INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS integrations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  type VARCHAR(100) NOT NULL,
  protocol VARCHAR(20) NOT NULL CHECK (protocol IN ('REST', 'GRAPHQL', 'SOAP')),
  endpoint VARCHAR(300) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'Pending' CHECK (status IN ('Connected', 'Error', 'Pending')),
  last_sync TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
CREATE INDEX IF NOT EXISTS idx_apis_protocol ON apis (protocol);
CREATE INDEX IF NOT EXISTS idx_integrations_status ON integrations (status);
