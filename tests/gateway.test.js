// End-to-end gateway tests: real HTTP in, real local upstream out, real PostgreSQL.
// MongoDB is replaced by a capturing mock (no MongoDB server is available where these tests run),
// so log CONTENT is verified but Mongo's own storage/aggregation is not (see README "Known limitations").
const logDocs = [];
const mockLogModel = {
  create: jest.fn(async (doc) => { logDocs.push(doc); return doc; }),
  find: jest.fn(),
  findById: jest.fn(),
  countDocuments: jest.fn(),
  aggregate: jest.fn(),
};
jest.mock('../src/models/logModel', () => mockLogModel);
jest.mock('../src/config/mongo', () => ({
  isMongoConnected: () => true,
  connectMongo: jest.fn(),
  mongoose: { isValidObjectId: () => true, connection: { db: { admin: () => ({ ping: async () => {} }) } } },
}));

// Small limits keep the size tests fast. Must be set before the app (and config/env) is loaded.
process.env.GATEWAY_MAX_BODY_BYTES = '65536';
process.env.GATEWAY_MAX_RESPONSE_BYTES = '1048576';

const http = require('http');
const net = require('net');
const { request, SEEDED_ADMIN } = require('./helpers');
const app = require('../src/app');
const { pool } = require('../src/config/database');
const apiKeyModel = require('../src/models/apiKeyModel');
const rateLimiter = require('../src/gateway/rateLimiter');

const UPSTREAM_SECRET = 'upstream-secret-123';
const PREFIX = 'GWTEST ';
let upstream; let upstreamPort; let closedPort; let garbageServer; let garbagePort; let server;
let adminToken; let devToken;
const hits = [];
const created = { apiIds: [], keyIds: [], userIds: [] };
let api; let rawKey; let keyId;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await sleep(20);
  }
}
const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const gw = (method, path, key = rawKey) => request(server)[method](path).set('Authorization', `Bearer ${key}`);
const rawGet = (path) => new Promise((resolve, reject) => {
  const r = http.request({ port: server.address().port, path, headers: { Authorization: `Bearer ${rawKey}` } }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  });
  r.on('error', reject);
  r.end();
});
const logsFor = (id) => logDocs.filter((d) => d.correlationId === id);

function startUpstream() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const { pathname, searchParams } = new URL(req.url, 'http://x');
        hits.push({ method: req.method, url: req.url, headers: req.headers, body });
        if (pathname === '/v1/slow') return setTimeout(() => { res.end('late'); }, 1500);
        if (pathname === '/v1/redirect') { res.writeHead(302, { Location: `http://127.0.0.1:${upstreamPort}/v1/secret` }); return res.end(); }
        if (pathname === '/v1/big') { const n = Number(searchParams.get('size')); res.writeHead(200, { 'Content-Length': n }); return res.end(Buffer.alloc(n, 97)); }
        if (pathname === '/v1/bigchunked') {
          res.writeHead(200);
          let sent = 0;
          const pump = () => { while (sent < 3000000) { sent += 100000; if (!res.write(Buffer.alloc(100000, 98))) return res.once('drain', pump); } return res.end(); };
          return pump();
        }
        const m = /^\/v1\/status\/(\d{3})$/.exec(pathname);
        if (m) { res.writeHead(Number(m[1]), { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ upstream: true, status: Number(m[1]) })); }
        if (req.method === 'DELETE') { res.writeHead(204); return res.end(); }
        res.writeHead(req.method === 'POST' ? 201 : 200, {
          'Content-Type': 'application/json', 'X-Upstream-Header': 'yes', 'Set-Cookie': 'sid=upstream-session', Server: 'upstream-server',
        });
        return res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }));
      });
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

function startGarbageServer() {
  return new Promise((resolve) => {
    const s = net.createServer((sock) => { sock.on('data', () => { sock.write('THIS IS NOT HTTP\r\n\r\n'); sock.end(); }); });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

async function getClosedPort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function createApi(overrides = {}) {
  const res = await request(server).post('/api/v1/apis').set(bearer(adminToken)).send({
    name: `${PREFIX}${Math.random().toString(36).slice(2, 8)}`,
    protocol: 'REST',
    base_url: `http://127.0.0.1:${upstreamPort}/v1`,
    gateway_slug: `gwt-${Math.random().toString(36).slice(2, 10)}`,
    gateway_enabled: true,
    ...overrides,
  });
  if (res.status !== 201) throw new Error(`createApi failed: ${res.status} ${JSON.stringify(res.body)}`);
  created.apiIds.push(res.body.data.id);
  return res.body.data;
}

async function createKey({ apiIds = [], rateLimitPerMinute = 1000, name = `${PREFIX}key` } = {}) {
  const res = await request(server).post('/api/v1/api-keys').set(bearer(adminToken)).send({ name, environment: 'Test' });
  created.keyIds.push(res.body.data.id);
  const cfg = await request(server).patch(`/api/v1/api-keys/${res.body.data.id}/gateway`).set(bearer(adminToken)).send({ apiIds, rateLimitPerMinute });
  if (cfg.status !== 200) throw new Error(`key config failed ${cfg.status} ${JSON.stringify(cfg.body)}`);
  return { id: res.body.data.id, key: res.body.data.key };
}

beforeAll(async () => {
  upstream = await startUpstream();
  upstreamPort = upstream.address().port;
  closedPort = await getClosedPort();
  garbageServer = await startGarbageServer();
  garbagePort = garbageServer.address().port;
  // Development-only allowlist: exactly these local test upstreams may bypass the private-address block.
  process.env.GATEWAY_DEV_ALLOWED_UPSTREAMS = `127.0.0.1:${upstreamPort},127.0.0.1:${closedPort},127.0.0.1:${garbagePort}`;

  server = http.createServer(app).listen(0);
  adminToken = (await request(server).post('/api/v1/auth/login').send(SEEDED_ADMIN)).body.data.token;
  devToken = (await request(server).post('/api/v1/auth/login').send({ email: 'priya@example.com', password: 'Password123!' })).body.data.token;

  api = await createApi({
    gateway_slug: 'gwt-orders',
    upstream_auth_mode: 'bearer',
    upstream_credential: UPSTREAM_SECRET,
    forward_headers: ['x-tenant'],
  }).catch(async () => {
    // A previous aborted run may have left the slug behind.
    await pool.query(`DELETE FROM apis WHERE gateway_slug = 'gwt-orders'`);
    return createApi({ gateway_slug: 'gwt-orders', upstream_auth_mode: 'bearer', upstream_credential: UPSTREAM_SECRET, forward_headers: ['x-tenant'] });
  });
  ({ id: keyId, key: rawKey } = await createKey({ apiIds: [api.id] }));
});

beforeEach(() => {
  rateLimiter._resetMemoryForTests();
  hits.length = 0;
});

afterAll(async () => {
  await pool.query(`DELETE FROM api_keys WHERE id = ANY($1::int[])`, [created.keyIds]);
  await pool.query(`DELETE FROM apis WHERE id = ANY($1::int[])`, [created.apiIds]);
  await pool.query(`DELETE FROM apis WHERE name LIKE $1`, [`${PREFIX}%`]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1::int[])`, [created.userIds]);
  delete process.env.GATEWAY_DEV_ALLOWED_UPSTREAMS;
  await new Promise((r) => server.close(r));
  upstream.close();
  garbageServer.close();
  await pool.end();
});

describe('forwarding', () => {
  it('forwards GET, preserving path, URL encoding and query string', async () => {
    const res = await gw('get', '/gateway/gwt-orders/items/a%20b?x=1&y=%26z&x=2');
    expect(res.status).toBe(200);
    expect(hits).toHaveLength(1);
    expect(hits[0].url).toBe('/v1/items/a%20b?x=1&y=%26z&x=2');
    expect(res.body.url).toBe('/v1/items/a%20b?x=1&y=%26z&x=2');
  });

  it('forwards POST with a JSON body and returns the upstream status (201)', async () => {
    const res = await gw('post', '/gateway/gwt-orders/items').send({ name: 'widget', qty: 3 });
    expect(res.status).toBe(201);
    expect(JSON.parse(hits[0].body)).toEqual({ name: 'widget', qty: 3 });
    expect(hits[0].headers['content-type']).toMatch(/application\/json/);
  });

  it('forwards PUT and PATCH bodies, and DELETE (204 with no body)', async () => {
    const put = await gw('put', '/gateway/gwt-orders/items/1').send({ a: 1 });
    const patch = await gw('patch', '/gateway/gwt-orders/items/1').send({ b: 2 });
    const del = await gw('delete', '/gateway/gwt-orders/items/1');
    expect(put.status).toBe(200);
    expect(JSON.parse(hits[0].body)).toEqual({ a: 1 });
    expect(patch.status).toBe(200);
    expect(JSON.parse(hits[1].body)).toEqual({ b: 2 });
    expect(del.status).toBe(204);
    expect(hits.map((h) => h.method)).toEqual(['PUT', 'PATCH', 'DELETE']);
  });

  it('passes upstream 4xx/5xx through unchanged and does NOT mark them as gateway errors', async () => {
    for (const code of [404, 500]) {
      const res = await gw('get', `/gateway/gwt-orders/status/${code}`);
      expect(res.status).toBe(code);
      expect(res.body).toEqual({ upstream: true, status: code });
      expect(res.headers['x-bridgex-error']).toBeUndefined();
    }
  });

  it('streams a large response without altering it', async () => {
    const res = await gw('get', '/gateway/gwt-orders/big?size=900000').buffer(true).parse((r, cb) => {
      let n = 0; r.on('data', (c) => { n += c.length; }); r.on('end', () => cb(null, n));
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe(900000);
  });
});

describe('header policy', () => {
  it('sends the upstream credential, never the gateway key, cookies or arbitrary headers', async () => {
    await gw('get', '/gateway/gwt-orders/echo')
      .set('Cookie', 'dashboard=secret')
      .set('X-Custom-Thing', 'should-not-pass')
      .set('X-Tenant', 'acme')
      .set('Accept-Language', 'en');
    const h = hits[0].headers;
    expect(h.authorization).toBe(`Bearer ${UPSTREAM_SECRET}`);
    expect(JSON.stringify(h)).not.toContain(rawKey);
    expect(h.cookie).toBeUndefined();
    expect(h['x-custom-thing']).toBeUndefined();
    expect(h['x-tenant']).toBe('acme'); // explicitly approved for this route
    expect(h['accept-language']).toBe('en'); // default allow-list
    expect(h['x-api-key']).toBeUndefined();
    expect(h.host).toBe(`127.0.0.1:${upstreamPort}`); // never the client's Host
    expect(h['x-forwarded-by']).toBe('BridgeX');
  });

  it('does not let a client override the upstream credential via X-API-Key auth + Authorization', async () => {
    await request(server).get('/gateway/gwt-orders/echo').set('X-API-Key', rawKey).set('Authorization', 'Basic Zm9vOmJhcg==');
    expect(hits[0].headers.authorization).toBe(`Bearer ${UPSTREAM_SECRET}`);
  });

  it('strips Set-Cookie / Server from upstream responses and adds a request id', async () => {
    const res = await gw('get', '/gateway/gwt-orders/echo');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers.server).toBeUndefined();
    expect(res.headers['x-upstream-header']).toBe('yes');
    expect(res.headers['x-request-id']).toBeTruthy();
  });
});

describe('authentication', () => {
  it('rejects a missing key', async () => {
    const res = await request(server).get('/gateway/gwt-orders/echo');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.headers['x-bridgex-error']).toBe('true');
    expect(res.headers['www-authenticate']).toMatch(/Bearer/);
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
    expect(hits).toHaveLength(0);
  });

  it('rejects an invalid key and a dashboard JWT (the two credential types are never confused)', async () => {
    const bad = await gw('get', '/gateway/gwt-orders/echo', `bx_live_${'0'.repeat(48)}`);
    const jwt = await gw('get', '/gateway/gwt-orders/echo', adminToken);
    expect(bad.status).toBe(401);
    expect(jwt.status).toBe(401);
    expect(jwt.body.error.code).toBe('INVALID_API_KEY');
    expect(hits).toHaveLength(0);
  });

  it('accepts the key via X-API-Key as well as Authorization: Bearer', async () => {
    const res = await request(server).get('/gateway/gwt-orders/echo').set('X-API-Key', rawKey);
    expect(res.status).toBe(200);
  });

  it('does not accept a gateway key on dashboard endpoints', async () => {
    const res = await request(server).get('/api/v1/apis').set(bearer(rawKey));
    expect(res.status).toBe(401);
  });

  it('rejects a revoked key', async () => {
    const k = await createKey({ apiIds: [api.id] });
    expect((await gw('get', '/gateway/gwt-orders/echo', k.key)).status).toBe(200);
    await request(server).patch(`/api/v1/api-keys/${k.id}/revoke`).set(bearer(adminToken));
    const res = await gw('get', '/gateway/gwt-orders/echo', k.key);
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Invalid API key'); // same message: revoked is not distinguishable by callers
    const log = await waitFor(() => logDocs.find((d) => d.errorCategory === 'auth_revoked'));
    expect(log.apiKeyId).toBe(k.id);
  });

  it('rejects an expired key', async () => {
    const k = await createKey({ apiIds: [api.id] });
    await pool.query(`UPDATE api_keys SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [k.id]);
    const res = await gw('get', '/gateway/gwt-orders/echo', k.key);
    expect(res.status).toBe(401);
    await waitFor(() => logDocs.find((d) => d.errorCategory === 'auth_expired' && d.apiKeyId === k.id));
  });

  it('rejects keys whose owner has been deactivated', async () => {
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, status) VALUES ('GWTEST owner', $1, 'x', 'DEVELOPER', 'Active') RETURNING id`,
      [`gwtest-${Date.now()}@example.com`]
    );
    created.userIds.push(rows[0].id);
    const raw = `bx_test_${'ab'.repeat(24)}`;
    const hash = require('crypto').createHash('sha256').update(raw).digest('hex');
    const row = await apiKeyModel.create({ name: `${PREFIX}owned`, keyHash: hash, keyPreview: 'bx_test_…', environment: 'Test', ownerId: rows[0].id });
    created.keyIds.push(row.id);
    await apiKeyModel.updateGatewaySettings(row.id, { apiIds: [api.id] });
    expect((await gw('get', '/gateway/gwt-orders/echo', raw)).status).toBe(200);
    await pool.query(`UPDATE users SET status = 'Inactive' WHERE id = $1`, [rows[0].id]);
    expect((await gw('get', '/gateway/gwt-orders/echo', raw)).status).toBe(401);
  });

  it('throttles repeated failed attempts from one IP (429)', async () => {
    let last;
    for (let i = 0; i < 32; i += 1) last = await request(server).get('/gateway/gwt-orders/echo').set('Authorization', 'Bearer nope');
    expect(last.status).toBe(429);
    expect(last.body.error.code).toBe('TOO_MANY_FAILED_ATTEMPTS');
    // a valid key from the same IP is not locked out by failures
    expect((await gw('get', '/gateway/gwt-orders/echo')).status).toBe(200);
  });
});

describe('authorization and routing', () => {
  it('returns 404 for unknown routes (after authentication)', async () => {
    const res = await gw('get', '/gateway/no-such-api/x');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ROUTE_NOT_FOUND');
    expect((await request(server).get('/gateway/no-such-api/x')).status).toBe(401); // unauthenticated callers cannot probe routes
    expect((await gw('get', '/gateway')).status).toBe(404);
  });

  it('returns 403 when the key is not granted this API', async () => {
    const other = await createApi({ gateway_slug: 'gwt-other' });
    const res = await gw('get', '/gateway/gwt-other/echo');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(hits).toHaveLength(0);
    // …and works once granted
    await request(server).patch(`/api/v1/api-keys/${keyId}/gateway`).set(bearer(adminToken)).send({ apiIds: [api.id, other.id] });
    expect((await gw('get', '/gateway/gwt-other/echo')).status).toBe(200);
    await request(server).patch(`/api/v1/api-keys/${keyId}/gateway`).set(bearer(adminToken)).send({ apiIds: [api.id] });
  });

  it('returns 503 for a disabled route and forwards again once re-enabled', async () => {
    const svc = await createApi({ gateway_slug: 'gwt-toggle' });
    await request(server).patch(`/api/v1/api-keys/${keyId}/gateway`).set(bearer(adminToken)).send({ apiIds: [api.id, svc.id] });
    await request(server).put(`/api/v1/apis/${svc.id}`).set(bearer(adminToken)).send({ gateway_enabled: false });
    const off = await gw('get', '/gateway/gwt-toggle/echo');
    expect(off.status).toBe(503);
    expect(off.body.error.code).toBe('SERVICE_DISABLED');
    expect(hits).toHaveLength(0);
    await request(server).put(`/api/v1/apis/${svc.id}`).set(bearer(adminToken)).send({ gateway_enabled: true });
    expect((await gw('get', '/gateway/gwt-toggle/echo')).status).toBe(200);
    await request(server).patch(`/api/v1/api-keys/${keyId}/gateway`).set(bearer(adminToken)).send({ apiIds: [api.id] });
  });

  it('enforces the per-route method list (405 + Allow)', async () => {
    const ro = await createApi({ gateway_slug: 'gwt-readonly', allowed_methods: ['GET'] });
    await request(server).patch(`/api/v1/api-keys/${keyId}/gateway`).set(bearer(adminToken)).send({ apiIds: [api.id, ro.id] });
    const res = await gw('post', '/gateway/gwt-readonly/x').send({});
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('GET');
    expect(hits).toHaveLength(0);
    await request(server).patch(`/api/v1/api-keys/${keyId}/gateway`).set(bearer(adminToken)).send({ apiIds: [api.id] });
  });

  it('only SUPER_ADMIN can configure routes, grants and rate limits', async () => {
    const create = await request(server).post('/api/v1/apis').set(bearer(devToken)).send({ name: 'nope nope', protocol: 'REST', base_url: 'https://api.example.com' });
    const grant = await request(server).patch(`/api/v1/api-keys/${keyId}/gateway`).set(bearer(devToken)).send({ rateLimitPerMinute: 9999 });
    const toggle = await request(server).put(`/api/v1/apis/${api.id}`).set(bearer(devToken)).send({ gateway_enabled: false });
    expect([create.status, grant.status, toggle.status]).toEqual([403, 403, 403]);
    expect((await request(server).patch(`/api/v1/api-keys/${keyId}/gateway`)).status).toBe(401);
  });
});

describe('rate limiting', () => {
  it('allows up to the limit, then returns 429 with headers; resets after the window', async () => {
    const k = await createKey({ apiIds: [api.id], rateLimitPerMinute: 3 });
    const results = [];
    for (let i = 0; i < 5; i += 1) results.push(await gw('get', '/gateway/gwt-orders/echo', k.key));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 429, 429]);
    expect(results[0].headers['x-ratelimit-limit']).toBe('3');
    expect(results[0].headers['x-ratelimit-remaining']).toBe('2');
    expect(results[2].headers['x-ratelimit-remaining']).toBe('0');
    expect(results[3].body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(Number(results[3].headers['retry-after'])).toBeGreaterThan(0);
    expect(results[3].headers['x-bridgex-error']).toBe('true');
    expect(hits).toHaveLength(3); // limited requests never reach the upstream

    const realNow = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(realNow + 61000); // next window
    try {
      const after = await gw('get', '/gateway/gwt-orders/echo', k.key);
      expect(after.status).toBe(200);
      expect(after.headers['x-ratelimit-remaining']).toBe('2');
    } finally {
      spy.mockRestore();
    }
  });

  it('cannot be bypassed by concurrent requests', async () => {
    const k = await createKey({ apiIds: [api.id], rateLimitPerMinute: 5 });
    const res = await Promise.all(Array.from({ length: 15 }, () => gw('get', '/gateway/gwt-orders/echo', k.key)));
    const ok = res.filter((r) => r.status === 200).length;
    expect(ok).toBe(5);
    expect(res.filter((r) => r.status === 429)).toHaveLength(10);
  });

  it('limits each key independently', async () => {
    const a = await createKey({ apiIds: [api.id], rateLimitPerMinute: 1 });
    const b = await createKey({ apiIds: [api.id], rateLimitPerMinute: 1 });
    expect((await gw('get', '/gateway/gwt-orders/echo', a.key)).status).toBe(200);
    expect((await gw('get', '/gateway/gwt-orders/echo', a.key)).status).toBe(429);
    expect((await gw('get', '/gateway/gwt-orders/echo', b.key)).status).toBe(200);
  });

  it('validates rate-limit settings on the server', async () => {
    for (const bad of [0, -5, 10001, 2.5, 'ten']) {
      const res = await request(server).patch(`/api/v1/api-keys/${keyId}/gateway`).set(bearer(adminToken)).send({ rateLimitPerMinute: bad });
      expect(res.status).toBe(400);
    }
  });
});

describe('upstream failures are controlled gateway errors', () => {
  it('times out slow upstreams (504)', async () => {
    const slow = await createApi({ gateway_slug: 'gwt-slow', timeout_ms: 300 });
    await request(server).patch(`/api/v1/api-keys/${keyId}/gateway`).set(bearer(adminToken)).send({ apiIds: [api.id, slow.id] });
    const started = Date.now();
    const res = await gw('get', '/gateway/gwt-slow/slow');
    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('UPSTREAM_TIMEOUT');
    expect(res.headers['x-bridgex-error']).toBe('true');
    expect(Date.now() - started).toBeLessThan(1400);
    const log = await waitFor(() => logDocs.find((d) => d.correlationId === res.headers['x-request-id']));
    expect(log).toMatchObject({ outcome: 'gateway_error', errorCategory: 'upstream_timeout', status: 504 });
    await request(server).patch(`/api/v1/api-keys/${keyId}/gateway`).set(bearer(adminToken)).send({ apiIds: [api.id] });
  });

  it('reports connection refused as 502 without leaking addresses', async () => {
    const dead = await createApi({ gateway_slug: 'gwt-dead', base_url: `http://127.0.0.1:${closedPort}` });
    await request(server).patch(`/api/v1/api-keys/${keyId}/gateway`).set(bearer(adminToken)).send({ apiIds: [api.id, dead.id] });
    const res = await gw('get', '/gateway/gwt-dead/x');
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('UPSTREAM_UNREACHABLE');
    expect(JSON.stringify(res.body)).not.toMatch(/127\.0\.0\.1|ECONNREFUSED/);
    await request(server).patch(`/api/v1/api-keys/${keyId}/gateway`).set(bearer(adminToken)).send({ apiIds: [api.id] });
  });

  it('reports DNS failure as 502', async () => {
    const nx = await createApi({ gateway_slug: 'gwt-nxdomain', base_url: 'https://bridgex-no-such-host.invalid' });
    await request(server).patch(`/api/v1/api-keys/${keyId}/gateway`).set(bearer(adminToken)).send({ apiIds: [api.id, nx.id] });
    const res = await gw('get', '/gateway/gwt-nxdomain/x');
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('UPSTREAM_DNS_FAILURE');
    await request(server).patch(`/api/v1/api-keys/${keyId}/gateway`).set(bearer(adminToken)).send({ apiIds: [api.id] });
  });

  it('reports a malformed upstream response as 502', async () => {
    const bad = await createApi({ gateway_slug: 'gwt-garbage', base_url: `http://127.0.0.1:${garbagePort}` });
    await request(server).patch(`/api/v1/api-keys/${keyId}/gateway`).set(bearer(adminToken)).send({ apiIds: [api.id, bad.id] });
    const res = await gw('get', '/gateway/gwt-garbage/x');
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('UPSTREAM_INVALID_RESPONSE');
    await request(server).patch(`/api/v1/api-keys/${keyId}/gateway`).set(bearer(adminToken)).send({ apiIds: [api.id] });
  });

  it('does not retry: exactly one upstream attempt per client request', async () => {
    await gw('post', '/gateway/gwt-orders/status/500').send({ a: 1 });
    expect(hits).toHaveLength(1);
  });

  it('returns 503 (no stack, no internals) when the database is unavailable', async () => {
    const spy = jest.spyOn(apiKeyModel, 'findByHash').mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:5432'), { code: 'ECONNREFUSED' }));
    try {
      const res = await gw('get', '/gateway/gwt-orders/echo');
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(JSON.stringify(res.body)).not.toMatch(/10\.1\.2\.3|ECONNREFUSED|at /);
    } finally {
      spy.mockRestore();
    }
  });

  it('returns a generic 500 for unexpected errors', async () => {
    const spy = jest.spyOn(apiKeyModel, 'hasGrant').mockRejectedValue(new Error('boom: internal detail'));
    try {
      const res = await gw('get', '/gateway/gwt-orders/echo');
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_SERVER_ERROR');
      expect(JSON.stringify(res.body)).not.toContain('boom');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('SSRF and request-shape protection', () => {
  const unsafe = [
    'http://169.254.169.254/latest/meta-data', 'http://localhost:9000', 'http://10.0.0.5', 'http://192.168.1.10:8080',
    'http://[::1]:8080', 'http://2130706433/', 'http://metadata.google.internal', 'https://user:pw@example.com',
    'ftp://example.com', 'http://127.0.0.1:5000', 'https://intranet',
  ];
  it.each(unsafe)('rejects unsafe upstream URL %s at configuration time', async (base_url) => {
    const res = await request(server).post('/api/v1/apis').set(bearer(adminToken)).send({
      name: `${PREFIX}unsafe`, protocol: 'REST', base_url, gateway_slug: 'gwt-unsafe', gateway_enabled: true,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe('/base_url');
  });

  it('re-checks the upstream at request time even if the database row was tampered with', async () => {
    const victim = await createApi({ gateway_slug: 'gwt-tamper' });
    await request(server).patch(`/api/v1/api-keys/${keyId}/gateway`).set(bearer(adminToken)).send({ apiIds: [api.id, victim.id] });
    for (const bad of ['http://10.0.0.5:8080', `http://localhost:${upstreamPort}`, 'http://169.254.169.254']) {
      await pool.query(`UPDATE apis SET base_url = $2 WHERE id = $1`, [victim.id, bad]);
      const res = await gw('get', '/gateway/gwt-tamper/x');
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('UPSTREAM_ADDRESS_BLOCKED');
    }
    expect(hits).toHaveLength(0);
    await request(server).patch(`/api/v1/api-keys/${keyId}/gateway`).set(bearer(adminToken)).send({ apiIds: [api.id] });
  });

  it('does not follow upstream redirects', async () => {
    const res = await gw('get', '/gateway/gwt-orders/redirect').redirects(0);
    expect(res.status).toBe(302);
    expect(hits.map((h) => h.url)).toEqual(['/v1/redirect']); // the Location target was never requested
  });

  it.each([
    ['encoded dot-dot', '/gateway/gwt-orders/%2e%2e/admin'],
    ['encoded slash', '/gateway/gwt-orders/a%2fb'],
    ['encoded backslash', '/gateway/gwt-orders/a%5cb'],
    ['null byte', '/gateway/gwt-orders/a%00b'],
    ['bad percent-encoding', '/gateway/gwt-orders/a%zz'],
  ])('rejects %s paths', async (_name, path) => {
    // Raw http client: superagent would "helpfully" normalise %2e%2e before it ever reached the server.
    const { status, body } = await rawGet(path);
    expect(status).toBe(400);
    expect(JSON.parse(body).error.code).toBe('INVALID_PATH');
    expect(hits).toHaveLength(0);
  });

  it('rejects a literal "../" that reaches the gateway un-normalised', async () => {
    const status = await new Promise((resolve) => {
      const req = http.request({ port: server.address().port, path: '/gateway/gwt-orders/a/../../etc/passwd', headers: { Authorization: `Bearer ${rawKey}` } }, (r) => { r.resume(); resolve(r.statusCode); });
      req.end();
    });
    expect(status).toBe(400);
    expect(hits).toHaveLength(0);
  });

  it('rejects oversized bodies (declared and chunked) before/while forwarding', async () => {
    const big = Buffer.alloc(200000, 'a');
    const declared = await gw('post', '/gateway/gwt-orders/items').set('Content-Type', 'application/octet-stream').send(big);
    expect(declared.status).toBe(413);
    expect(hits).toHaveLength(0);

    const chunkedStatus = await new Promise((resolve) => {
      const req = http.request({ port: server.address().port, method: 'POST', path: '/gateway/gwt-orders/items', headers: { Authorization: `Bearer ${rawKey}`, 'Transfer-Encoding': 'chunked', 'Content-Type': 'application/octet-stream' } }, (r) => { r.resume(); resolve(r.statusCode); });
      req.on('error', () => resolve('error'));
      for (let i = 0; i < 4; i += 1) req.write(Buffer.alloc(50000, 'b'));
      req.end();
    });
    expect([413, 'error']).toContain(chunkedStatus);
  });

  it('refuses upstream responses larger than the configured cap', async () => {
    const declared = await gw('get', '/gateway/gwt-orders/big?size=3000000');
    expect(declared.status).toBe(502);
    expect(declared.body.error.code).toBe('UPSTREAM_RESPONSE_TOO_LARGE');

    const aborted = await new Promise((resolve) => {
      const req = http.request({ port: server.address().port, path: '/gateway/gwt-orders/bigchunked', headers: { Authorization: `Bearer ${rawKey}` } }, (r) => {
        let n = 0;
        r.on('data', (c) => { n += c.length; });
        r.on('end', () => resolve({ n, complete: r.complete }));
        r.on('error', () => resolve({ n, complete: false }));
        r.on('aborted', () => resolve({ n, complete: false }));
      });
      req.on('error', () => resolve({ n: 0, complete: false }));
      req.end();
    });
    expect(aborted.complete).toBe(false); // cut off at the cap instead of buffering/forwarding 3 MB
    expect(aborted.n).toBeLessThan(3000000);
  });
});

describe('API configuration (dashboard)', () => {
  it('never exposes the upstream credential, and stores it encrypted', async () => {
    const list = await request(server).get('/api/v1/apis').set(bearer(adminToken));
    const one = await request(server).get(`/api/v1/apis/${api.id}`).set(bearer(devToken));
    for (const body of [JSON.stringify(list.body), JSON.stringify(one.body)]) {
      expect(body).not.toContain(UPSTREAM_SECRET);
      expect(body).not.toContain('upstream_credential_enc');
    }
    expect(one.body.data.has_upstream_credential).toBe(true);
    const { rows } = await pool.query(`SELECT upstream_credential_enc FROM apis WHERE id = $1`, [api.id]);
    expect(rows[0].upstream_credential_enc).toMatch(/^v1:/);
    expect(rows[0].upstream_credential_enc).not.toContain(UPSTREAM_SECRET);
  });

  it('detects route conflicts (409) and persists changes', async () => {
    const dup = await request(server).post('/api/v1/apis').set(bearer(adminToken)).send({ name: `${PREFIX}dup`, protocol: 'REST', base_url: 'https://api.example.com', gateway_slug: 'gwt-orders' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('GATEWAY_ROUTE_CONFLICT');

    const svc = await createApi({ gateway_slug: 'gwt-persist', timeout_ms: 2500, allowed_methods: ['GET', 'POST'] });
    const reread = await request(server).get(`/api/v1/apis/${svc.id}`).set(bearer(adminToken));
    expect(reread.body.data).toMatchObject({ gateway_slug: 'gwt-persist', timeout_ms: 2500, allowed_methods: ['GET', 'POST'], gateway_enabled: true });
    const clash = await request(server).put(`/api/v1/apis/${svc.id}`).set(bearer(adminToken)).send({ gateway_slug: 'gwt-orders' });
    expect(clash.status).toBe(409);
  });

  it('validates gateway settings', async () => {
    const send = (body) => request(server).put(`/api/v1/apis/${api.id}`).set(bearer(adminToken)).send(body);
    expect((await send({ timeout_ms: 5 })).status).toBe(400);
    expect((await send({ timeout_ms: 99999999 })).status).toBe(400);
    expect((await send({ gateway_slug: 'Bad Slug!' })).status).toBe(400);
    expect((await send({ allowed_methods: ['TRACE'] })).status).toBe(400);
    expect((await send({ forward_headers: ['cookie'] })).status).toBe(400);
    expect((await send({ forward_headers: ['x-bad header'] })).status).toBe(400);
    expect((await send({ upstream_auth_mode: 'header' })).status).toBe(400); // header name missing
    const noSlug = await request(server).post('/api/v1/apis').set(bearer(adminToken)).send({ name: `${PREFIX}ns`, protocol: 'REST', base_url: 'https://api.example.com', gateway_enabled: true });
    expect(noSlug.status).toBe(400);
    const noCred = await request(server).post('/api/v1/apis').set(bearer(adminToken)).send({ name: `${PREFIX}nc`, protocol: 'REST', base_url: 'https://api.example.com', gateway_slug: 'gwt-nc', upstream_auth_mode: 'bearer' });
    expect(noCred.status).toBe(400);
  });

  it('requires the credential to be re-entered when the upstream host changes', async () => {
    const svc = await createApi({ gateway_slug: 'gwt-rotate', upstream_auth_mode: 'bearer', upstream_credential: 'first-secret' });
    const moved = await request(server).put(`/api/v1/apis/${svc.id}`).set(bearer(adminToken)).send({ base_url: 'https://other.example.com' });
    expect(moved.status).toBe(400);
    expect(moved.body.error.details[0].field).toBe('/upstream_credential');
    const ok = await request(server).put(`/api/v1/apis/${svc.id}`).set(bearer(adminToken)).send({ base_url: 'https://other.example.com', upstream_credential: 'second-secret' });
    expect(ok.status).toBe(200);
  });

  it('supports header-style upstream credentials', async () => {
    const svc = await createApi({ gateway_slug: 'gwt-hdr', upstream_auth_mode: 'header', upstream_auth_header: 'X-Upstream-Key', upstream_credential: 'abc123' });
    await request(server).patch(`/api/v1/api-keys/${keyId}/gateway`).set(bearer(adminToken)).send({ apiIds: [api.id, svc.id] });
    await gw('get', '/gateway/gwt-hdr/echo');
    expect(hits[0].headers['x-upstream-key']).toBe('abc123');
    expect(hits[0].headers.authorization).toBeUndefined();
    await request(server).patch(`/api/v1/api-keys/${keyId}/gateway`).set(bearer(adminToken)).send({ apiIds: [api.id] });
  });

  it('validates expiry and grants on API keys', async () => {
    const past = await request(server).patch(`/api/v1/api-keys/${keyId}/gateway`).set(bearer(adminToken)).send({ expiresAt: '2001-01-01T00:00:00Z' });
    const ghost = await request(server).patch(`/api/v1/api-keys/${keyId}/gateway`).set(bearer(adminToken)).send({ apiIds: [99999999] });
    const missing = await request(server).patch('/api/v1/api-keys/99999999/gateway').set(bearer(adminToken)).send({ rateLimitPerMinute: 5 });
    expect([past.status, ghost.status, missing.status]).toEqual([400, 400, 404]);
    const list = await request(server).get('/api/v1/api-keys').set(bearer(adminToken));
    expect(list.body.data.find((k) => k.id === keyId).apiIds).toEqual([api.id]); // failed update changed nothing
  });
});

describe('logging, usage counters and dashboard visibility', () => {
  it('writes exactly one secret-free log entry per request, with gateway fields', async () => {
    const res = await gw('post', '/gateway/gwt-orders/items?api_key=SHOULD_NOT_APPEAR&page=2&token=abc').send({ password: 'hunter2', n: 1 });
    const id = res.headers['x-request-id'];
    await waitFor(() => logsFor(id).length > 0);
    await sleep(50);
    const docs = logsFor(id);
    expect(docs).toHaveLength(1); // no double counting with the dashboard request logger
    expect(docs[0]).toMatchObject({
      source: 'gateway', method: 'POST', status: 201, apiId: api.id, apiSlug: 'gwt-orders', apiKeyId: keyId,
      outcome: 'success', upstreamStatus: 201, service: api.name,
    });
    expect(docs[0].responseTime).toBeGreaterThanOrEqual(0);
    expect(docs[0].upstreamTimeMs).toBeGreaterThanOrEqual(0);
    expect(docs[0].requestBytes).toBeGreaterThan(0);
    expect(docs[0].responseBytes).toBeGreaterThan(0);
    expect(docs[0].endpoint).toContain('page=2');
    expect(docs[0].endpoint).toContain('api_key=[REDACTED]');
    expect(docs[0].endpoint).toContain('token=[REDACTED]');

    const everything = JSON.stringify(logDocs);
    expect(everything).not.toContain(rawKey);
    expect(everything).not.toContain(require('crypto').createHash('sha256').update(rawKey).digest('hex'));
    expect(everything).not.toContain(UPSTREAM_SECRET);
    expect(everything).not.toContain('hunter2');
    expect(everything).not.toContain('SHOULD_NOT_APPEAR');
  });

  it('records rejected and rate-limited requests too', async () => {
    const k = await createKey({ apiIds: [api.id], rateLimitPerMinute: 1 });
    await gw('get', '/gateway/gwt-orders/echo', k.key);
    const limited = await gw('get', '/gateway/gwt-orders/echo', k.key);
    const missing = await request(server).get('/gateway/gwt-orders/echo');
    const [l, m] = await Promise.all([
      waitFor(() => logsFor(limited.headers['x-request-id'])[0]),
      waitFor(() => logsFor(missing.headers['x-request-id'])[0]),
    ]);
    expect(l).toMatchObject({ outcome: 'rate_limited', status: 429, errorCategory: 'rate_limited', apiKeyId: k.id });
    expect(m).toMatchObject({ outcome: 'rejected', status: 401, errorCategory: 'auth_missing', apiKeyId: null });
  });

  it('counts usage accurately: only forwarded requests, success = status < 400', async () => {
    const svc = await createApi({ gateway_slug: 'gwt-counter' });
    await pool.query(`UPDATE apis SET request_count = 0, success_rate = 100, average_response_time = 0 WHERE id = $1`, [svc.id]);
    const k = await createKey({ apiIds: [svc.id], rateLimitPerMinute: 4 });

    const ids = [];
    for (const path of ['echo', 'echo', 'echo', 'status/500']) ids.push((await gw('get', `/gateway/gwt-counter/${path}`, k.key)).headers['x-request-id']); // 3 ok + 1 upstream 500
    ids.push((await gw('get', '/gateway/gwt-counter/echo', k.key)).headers['x-request-id']); // 429 — never forwarded, not counted
    ids.push((await gw('get', '/gateway/gwt-counter/echo', `bx_live_${'1'.repeat(48)}`)).headers['x-request-id']); // 401 — not counted
    await waitFor(() => ids.every((id) => logsFor(id).length === 1));

    const row = await waitFor(async () => {
      const { rows } = await pool.query(`SELECT request_count, success_rate::float AS success_rate FROM apis WHERE id = $1`, [svc.id]);
      return rows[0].request_count === '4' || rows[0].request_count === 4 ? rows[0] : null;
    });
    expect(Number(row.request_count)).toBe(4);
    expect(row.success_rate).toBe(75);

    const outcomes = ids.map((id) => logsFor(id)[0].outcome);
    expect(outcomes).toEqual(['success', 'success', 'success', 'upstream_error', 'rate_limited', 'rejected']);

    // The APIs module (and the dashboard KPI widgets that sum these counters) now show real traffic.
    const apis = await request(server).get('/api/v1/apis').set(bearer(adminToken));
    expect(Number(apis.body.data.find((a) => a.id === svc.id).request_count)).toBe(4);
  });

  it('keeps counters correct under concurrency (no lost updates)', async () => {
    const svc = await createApi({ gateway_slug: 'gwt-conc' });
    await pool.query(`UPDATE apis SET request_count = 0, success_rate = 100, average_response_time = 0 WHERE id = $1`, [svc.id]);
    const k = await createKey({ apiIds: [svc.id], rateLimitPerMinute: 100 });
    await Promise.all(Array.from({ length: 25 }, () => gw('get', '/gateway/gwt-conc/echo', k.key)));
    const row = await waitFor(async () => {
      const { rows } = await pool.query(`SELECT request_count::int AS n, success_rate::float AS rate FROM apis WHERE id = $1`, [svc.id]);
      return rows[0].n === 25 ? rows[0] : null;
    });
    expect(row.rate).toBe(100);
  });

  it('exposes gateway traffic through the existing Logs and Analytics endpoints', async () => {
    mockLogModel.find.mockImplementation(() => {
      const chain = {};
      ['sort', 'skip', 'limit', 'select'].forEach((m) => { chain[m] = jest.fn(() => chain); });
      chain.lean = jest.fn(async () => logDocs.filter((d) => d.source === 'gateway').slice(0, 3));
      return chain;
    });
    mockLogModel.countDocuments.mockResolvedValue(3);
    const logs = await request(server).get('/api/v1/logs?source=gateway').set(bearer(adminToken));
    expect(logs.status).toBe(200);
    expect(mockLogModel.find).toHaveBeenLastCalledWith({ source: 'gateway' });
    expect(logs.body.data.every((l) => l.source === 'gateway')).toBe(true);
    expect((await request(server).get('/api/v1/logs?source=bogus').set(bearer(adminToken))).status).toBe(400);

    mockLogModel.aggregate.mockResolvedValue([{
      totals: [{ _id: null, requests: 10, failed: 3, rateLimited: 1, rejected: 1, upstreamErrors: 1, responseTimeSum: 500 }],
      byApi: [{ _id: 'gwt-orders', requests: 10, failed: 3, rateLimited: 1, rejected: 1, upstreamErrors: 1, responseTimeSum: 500 }],
      byKey: [{ _id: keyId, requests: 10, failed: 3, rateLimited: 1, rejected: 1, upstreamErrors: 1, responseTimeSum: 500 }],
      byOutcome: [{ _id: 'success', requests: 7 }, { _id: 'rate_limited', requests: 1 }],
    }]);
    const usage = await request(server).get('/api/v1/analytics/gateway').set(bearer(adminToken));
    expect(usage.status).toBe(200);
    expect(usage.body.data.totals).toMatchObject({ requests: 10, failed: 3, successful: 7, errorRate: 30, averageResponseTime: 50, rateLimited: 1 });
    expect(usage.body.data.byApi[0]).toMatchObject({ apiSlug: 'gwt-orders', apiName: api.name });
    expect(usage.body.data.byKey[0].keyName).toBe(`${PREFIX}key`);
    expect(JSON.stringify(usage.body)).not.toContain(rawKey);
    const viewer = (await request(server).post('/api/v1/auth/login').send({ email: 'rahul@example.com', password: 'Password123!' })).body.data.token;
    expect((await request(server).get('/api/v1/analytics/gateway').set(bearer(viewer))).status).toBe(403);
    const pipeline = mockLogModel.aggregate.mock.calls[mockLogModel.aggregate.mock.calls.length - 1][0];
    expect(pipeline[0].$match.source).toBe('gateway');
  });
});
