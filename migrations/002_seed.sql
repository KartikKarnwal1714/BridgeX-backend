-- BridgeX Phase 2 — seed data
-- Run with: psql "$DATABASE_URL" -f migrations/002_seed.sql
-- Password for the seeded demo accounts is: Password123!  (DEVELOPMENT ONLY — never seed production)
-- Safe to re-run: rows are matched by email (users) or name (apis, integrations).

INSERT INTO users (name, email, password_hash, role, status, last_active)
VALUES
  ('Kartik Admin', 'kartik@example.com', '$2b$10$4dMQ84k7xsGuk6VYBBjDIOIiqienTh3mDXxtA6Gq5X.h6DvAUntl2', 'SUPER_ADMIN', 'Active', NOW()),
  ('Priya Developer', 'priya@example.com', '$2b$10$4dMQ84k7xsGuk6VYBBjDIOIiqienTh3mDXxtA6Gq5X.h6DvAUntl2', 'DEVELOPER', 'Active', NOW() - INTERVAL '5 minutes'),
  ('Rahul Viewer', 'rahul@example.com', '$2b$10$4dMQ84k7xsGuk6VYBBjDIOIiqienTh3mDXxtA6Gq5X.h6DvAUntl2', 'VIEWER', 'Active', NOW() - INTERVAL '10 minutes'),
  ('Amit Support', 'amit@example.com', '$2b$10$4dMQ84k7xsGuk6VYBBjDIOIiqienTh3mDXxtA6Gq5X.h6DvAUntl2', 'SUPPORT', 'Inactive', NOW() - INTERVAL '2 days'),
  ('Neha Developer', 'neha@example.com', '$2b$10$4dMQ84k7xsGuk6VYBBjDIOIiqienTh3mDXxtA6Gq5X.h6DvAUntl2', 'DEVELOPER', 'Active', NOW() - INTERVAL '1 hour')
ON CONFLICT (email) DO NOTHING;

INSERT INTO apis (name, description, protocol, base_url, status, request_count, success_rate, average_response_time)
SELECT v.*
FROM (VALUES
  ('User Service API', 'Manages user accounts and profiles', 'REST', '/api/v1/users', 'Healthy', 234000, 99.2, 120),
  ('Order Service API', 'Handles order lifecycle', 'REST', '/api/v1/orders', 'Healthy', 188000, 98.6, 210),
  ('Analytics API', 'GraphQL endpoint for analytics queries', 'GRAPHQL', '/graphql', 'Healthy', 156000, 99.1, 98),
  ('Legacy Verification API', 'SOAP adapter for legacy verification', 'SOAP', '/soap/verify', 'Degraded', 98000, 95.3, 4500),
  ('Payment Gateway API', 'Processes payments', 'REST', '/api/v1/payments', 'Healthy', 85000, 97.8, 310),
  ('Notification API', 'Sends email/SMS notifications', 'REST', '/api/v1/notifications', 'Healthy', 76000, 98.9, 140),
  ('Inventory API', 'Tracks warehouse inventory', 'REST', '/api/v1/inventory', 'Healthy', 64000, 99.4, 110)
) AS v(name, description, protocol, base_url, status, request_count, success_rate, average_response_time)
WHERE NOT EXISTS (SELECT 1 FROM apis t WHERE t.name = v.name);

INSERT INTO integrations (name, type, protocol, endpoint, status, last_sync)
SELECT v.*
FROM (VALUES
  ('University Legacy System', 'Legacy System', 'SOAP', '/soap/university', 'Connected', NOW() - INTERVAL '2 minutes'),
  ('Payment Provider', 'Third Party', 'REST', '/api/v1/payments/webhook', 'Connected', NOW() - INTERVAL '1 minute'),
  ('Email Service', 'Third Party', 'REST', '/api/v1/notifications/email', 'Connected', NOW() - INTERVAL '5 minutes'),
  ('Analytics Service', 'Third Party', 'GRAPHQL', '/graphql/analytics', 'Connected', NOW() - INTERVAL '1 minute'),
  ('User Management', 'Internal Service', 'REST', '/api/v1/users', 'Connected', NOW() - INTERVAL '3 minutes'),
  ('Document Service', 'Third Party', 'SOAP', '/soap/documents', 'Error', NOW() - INTERVAL '10 minutes')
) AS v(name, type, protocol, endpoint, status, last_sync)
WHERE NOT EXISTS (SELECT 1 FROM integrations t WHERE t.name = v.name);
