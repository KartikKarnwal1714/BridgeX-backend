# BridgeX Backend

## Description

The backend foundation for **BridgeX — A Resilient Multi-Protocol API
Integration and Management Platform**. This is Phase 2: a clean, layered
Express API with authentication, role-based authorization, CRUD for users /
APIs / integrations, dashboard aggregation, AJV validation, centralized
error handling, correlation IDs, and Swagger docs — connected to the
existing React frontend.

## Technology Stack

- **Runtime:** Node.js, Express.js (CommonJS)
- **Databases:** PostgreSQL (relational data), MongoDB (event/API logs,
  degrades gracefully if unavailable), Redis (infrastructure in place for
  caching/rate limiting in a later phase)
- **Auth:** JWT (`jsonwebtoken`) + `bcrypt`
- **Validation:** AJV (+ `ajv-formats`)
- **Docs:** OpenAPI 3.0, served via `swagger-ui-express`
- **Testing:** Jest + Supertest
- **Security:** helmet, CORS (env-based), express-rate-limit
- **Config:** dotenv

## Project Structure

```
backend/
├── src/
│   ├── config/        env, database (pg), mongo, redis
│   ├── controllers/    auth, user, api, integration, dashboard, health
│   ├── routes/         one router per resource + index.js
│   ├── middleware/     auth (JWT + RBAC), validation (AJV), correlationId,
│   │                   requestLogger, notFound, errorHandler
│   ├── models/          userModel, apiModel, integrationModel (parameterized
│   │                   SQL), logModel (Mongoose)
│   ├── services/        business logic layer, one per resource
│   ├── schemas/         AJV JSON schemas per resource
│   ├── utils/           logger, response envelope, jwt, password
│   ├── docs/openapi.yaml
│   ├── app.js           Express app (no listen — testable)
│   └── server.js        connects DBs, then starts listening
├── migrations/
│   ├── 001_init.sql     creates users / apis / integrations tables
│   └── 002_seed.sql     seed data matching the frontend's original mocks
├── tests/                Jest + Supertest suite
├── .env.example
└── package.json
```

## Environment Variables

Copy `.env.example` to `.env` and adjust as needed:

```env
PORT=5000
NODE_ENV=development

DATABASE_URL=postgresql://postgres:postgres@localhost:5432/bridgex
MONGO_URI=mongodb://localhost:27017/bridgex_logs
REDIS_URL=redis://localhost:6379

JWT_SECRET=change-this-to-a-long-random-string
JWT_EXPIRES_IN=1h
BCRYPT_SALT_ROUNDS=10

CLIENT_URL=http://localhost:5173
```

Never commit `.env`. Never hardcode secrets, DB credentials, or API keys.

## Database Setup

You need a running PostgreSQL instance. MongoDB and Redis are optional —
the API starts and runs without them (Mongo log persistence and Redis
caching simply stay inactive; `/api/v1/health` reports their status).

```bash
# 1. Create the database
createdb bridgex
# or: psql -c "CREATE DATABASE bridgex;"

# 2. Run the schema migration
npm run migrate
# (equivalent to: psql "$DATABASE_URL" -f migrations/001_init.sql)

# 3. Seed sample data (matches the frontend's original mock data)
npm run seed
# (equivalent to: psql "$DATABASE_URL" -f migrations/002_seed.sql)
```

Seeded accounts (all use password `Password123!`):

| Email                | Role         |
|-----------------------|--------------|
| kartik@example.com    | SUPER_ADMIN  |
| priya@example.com     | DEVELOPER    |
| rahul@example.com     | VIEWER       |
| amit@example.com      | SUPPORT      |
| neha@example.com      | DEVELOPER    |

## Installation

```bash
npm install
```

## Run

```bash
npm run dev     # nodemon, auto-restart
npm start       # plain node
```

The API listens on `http://localhost:5000` by default.

## Testing

```bash
npm test          # run once
npm run test:watch
```

19 tests across 5 suites, run against a real PostgreSQL database (create
`bridgex_test` or point `DATABASE_URL` at a disposable DB before running in
CI — the suite exercises the seeded admin user and does not otherwise fake
the database layer).

## API Documentation

Interactive Swagger UI: **`http://localhost:5000/api-docs`**
Raw spec: `src/docs/openapi.yaml`

## Health Check

**`GET /api/v1/health`** — reports overall status plus the live state of
Postgres, MongoDB, and Redis.

## Architecture rule

Every request flows: **Route → Middleware → Controller → Service →
Model/Database**. Controllers never touch SQL directly; that logic lives in
`models/`, orchestrated by `services/`.

## API gateway (Phase 3)

**Call format** (server-to-server; no CORS):

```
<any method> http://localhost:5000/gateway/<route>/<path>?<query>
Authorization: Bearer bx_live_...      (or:  X-API-Key: bx_live_...)
```

Dashboard JWTs are NOT accepted by the gateway and gateway keys are NOT accepted by `/api/v1`.

**Setup flow (dashboard, as SUPER_ADMIN):**
1. *APIs & Services* → create/edit an API: upstream base URL (`https://…`), **Gateway route** slug, methods, timeout, optional upstream credential, enable.
2. *API Keys* → create a key (copy the secret once) → ⚙ *Gateway settings*: rate limit, expiry, and **which APIs the key may call** (a new key can call nothing until granted).
3. Call `/gateway/<slug>/…` with the key. Inspect *Logs* (filter "Gateway traffic") and *Analytics → Gateway usage*.

**Lifecycle:** authenticate key → per-key rate limit → find route → key granted this API? → route enabled? → method allowed? → safe path → stream to upstream → log + usage counters.

**Gateway errors** use `{ success:false, error:{ code, message, details }, requestId }` plus header `X-BridgeX-Error: true`; upstream responses (including upstream 4xx/5xx) are passed through untouched. Codes: `UNAUTHORIZED`/`INVALID_API_KEY` 401, `FORBIDDEN` 403, `ROUTE_NOT_FOUND` 404, `METHOD_NOT_ALLOWED` 405, `PAYLOAD_TOO_LARGE` 413, `RATE_LIMIT_EXCEEDED`/`TOO_MANY_FAILED_ATTEMPTS` 429, `INVALID_PATH` 400, `UPSTREAM_*` 502, `UPSTREAM_TIMEOUT` 504, `SERVICE_DISABLED`/`SERVICE_UNAVAILABLE` 503. Rate-limit headers: `X-RateLimit-Limit/-Remaining/-Reset`, `Retry-After`.

**Rate limiting:** fixed 60 s window per key, atomic in Redis (shared across instances). If Redis is down it falls back to a bounded in-memory store (per instance only). A fixed window allows up to 2× the limit across a window boundary.

**Migration:** `npm run migrate` (adds `migrations/004_gateway.sql`, idempotent). Rollback: `migrations/004_gateway.down.sql` (destroys gateway config — back up first).

**Security controls:** https-only upstreams in production; private/loopback/link-local/metadata ranges blocked; DNS answers validated and the connection pinned to the validated address (anti-rebinding); redirects never followed; path traversal/encoded separators rejected; request header allow-list; gateway credentials and cookies never forwarded; upstream secrets AES-256-GCM encrypted; TLS verification always on; body/response size caps and timeouts; secret-free logs.

**Known limitations**
- Gateway logs and analytics live in MongoDB (Phase 2 design). If Mongo is down, requests still work and PostgreSQL counters (`apis.request_count` etc.) still update, but Logs/Analytics are empty.
- APIs have no per-user owner; grants are administrator-assigned. Rotating a key's secret = create new + revoke old.
- No per-key quotas (only rate limits), no automatic retries, no WebSocket/upgrade support, no CORS for browsers, `req.ip` is the socket address (set `trust proxy` behind a load balancer).
- `apis.status` (Healthy/Degraded/Error) is not auto-updated from gateway failures.
- Secrets in URL *paths* are not redacted from logs (only sensitive query parameters are).
