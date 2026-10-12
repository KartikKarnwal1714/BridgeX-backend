// Logs, analytics and system-health behaviour that needs MongoDB. No MongoDB
// server is available where these tests run, so the log MODEL is replaced by a
// mock: this verifies our filters, pagination, calculations, permissions and
// redaction. It does NOT verify that the aggregation pipelines return the
// right rows on a real MongoDB (see "Known limitations" in the Phase 2 report).
const mockModel = {
  find: jest.fn(),
  findById: jest.fn(),
  countDocuments: jest.fn(),
  aggregate: jest.fn(),
  create: jest.fn(),
};
const mockMongo = { connected: true };

jest.mock('../src/models/logModel', () => mockModel);
jest.mock('../src/config/mongo', () => ({
  isMongoConnected: () => mockMongo.connected,
  connectMongo: jest.fn(),
  mongoose: {
    isValidObjectId: (id) => /^[a-f0-9]{24}$/.test(id),
    connection: { db: { admin: () => ({ ping: async () => {} }) } },
  },
}));

const { app, request, loginAsAdmin } = require('./helpers');
const { pool } = require('../src/config/database');
const { redactUrl } = require('../src/middleware/redact');
const healthMonitor = require('../src/services/healthMonitor');
const { summariseTotals, fillBuckets } = require('../src/services/logService');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
let adminToken;
let viewerToken;

// find().sort().skip().limit().select().lean() -> items
function findChain(items) {
  const chain = {};
  ['sort', 'skip', 'limit', 'select'].forEach((m) => {
    chain[m] = jest.fn(() => chain);
  });
  chain.lean = jest.fn(async () => items);
  return chain;
}

beforeAll(async () => {
  adminToken = await loginAsAdmin();
  viewerToken = (
    await request(app).post('/api/v1/auth/login').send({ email: 'rahul@example.com', password: 'Password123!' })
  ).body.data.token;
});

beforeEach(() => {
  mockMongo.connected = true;
  Object.values(mockModel).forEach((fn) => fn.mockReset());
  mockModel.create.mockResolvedValue({});
});

afterAll(async () => {
  await pool.end();
});

describe('GET /api/v1/logs - filters and pagination', () => {
  it('builds the query from method, status class, text and date range, and paginates', async () => {
    const items = [{ _id: 'a'.repeat(24), method: 'GET', endpoint: '/x', status: 500 }];
    const chain = findChain(items);
    mockModel.find.mockReturnValue(chain);
    mockModel.countDocuments.mockResolvedValue(23);

    const res = await request(app)
      .get('/api/v1/logs')
      .query({ method: 'get', status: '5xx', q: 'users', from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z', page: 2, limit: 10 })
      .set(bearer(adminToken));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(items);
    expect(res.body.meta).toEqual({ page: 2, limit: 10, total: 23, totalPages: 3, available: true });

    const filter = mockModel.find.mock.calls[0][0];
    expect(filter.method).toBe('GET');
    expect(filter.status).toEqual({ $gte: 500, $lt: 600 });
    expect(filter.timestamp.$gte).toEqual(new Date('2026-10-01T00:00:00Z'));
    expect(filter.timestamp.$lte).toEqual(new Date('2026-10-02T00:00:00Z'));
    expect(filter.$or).toHaveLength(3);
    expect(chain.skip).toHaveBeenCalledWith(10);
    expect(chain.limit).toHaveBeenCalledWith(10);
    // metadata (user ids) is not part of the list payload
    expect(chain.select).toHaveBeenCalledWith('-metadata -__v');
  });

  it('treats search text literally (regex characters are escaped)', async () => {
    mockModel.find.mockReturnValue(findChain([]));
    mockModel.countDocuments.mockResolvedValue(0);

    await request(app).get('/api/v1/logs').query({ q: '(a+)+$.*' }).set(bearer(adminToken));

    const regex = mockModel.find.mock.calls[0][0].$or[0].endpoint;
    expect(regex.source).toBe('\\(a\\+\\)\\+\\$\\.\\*');
    expect(regex.test('/users')).toBe(false);
    expect(regex.test('xx(a+)+$.*yy')).toBe(true);
  });

  it('accepts an exact status code', async () => {
    mockModel.find.mockReturnValue(findChain([]));
    mockModel.countDocuments.mockResolvedValue(0);
    await request(app).get('/api/v1/logs').query({ status: '404' }).set(bearer(adminToken));
    expect(mockModel.find.mock.calls[0][0].status).toBe(404);
  });

  it('caps the page size at 100', async () => {
    const chain = findChain([]);
    mockModel.find.mockReturnValue(chain);
    mockModel.countDocuments.mockResolvedValue(0);

    const res = await request(app).get('/api/v1/logs').query({ limit: 100000 }).set(bearer(adminToken));
    expect(res.body.meta.limit).toBe(100);
    expect(chain.limit).toHaveBeenCalledWith(100);
  });

  it.each([
    [{ status: '999' }],
    [{ status: 'abc' }],
    [{ method: 'FETCH' }],
    [{ limit: 'abc' }],
    [{ page: '0' }],
    [{ from: 'yesterday' }],
    [{ from: '2026-10-05', to: '2026-10-01' }],
  ])('rejects invalid filter %j with 400', async (query) => {
    const res = await request(app).get('/api/v1/logs').query(query).set(bearer(adminToken));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockModel.find).not.toHaveBeenCalled();
  });

  it('returns an empty, clearly flagged page when MongoDB is down', async () => {
    mockMongo.connected = false;
    const res = await request(app).get('/api/v1/logs').set(bearer(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.available).toBe(false);
    expect(mockModel.find).not.toHaveBeenCalled();
  });

  it('returns 500 with a safe message (no internals) when the database query fails', async () => {
    mockModel.find.mockImplementation(() => {
      throw new Error('mongo exploded: password=hunter2');
    });
    const res = await request(app).get('/api/v1/logs').set(bearer(adminToken));
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    expect(res.body.error.code).toBe('INTERNAL_SERVER_ERROR');
  });
});

describe('GET /api/v1/logs - permissions', () => {
  it('rejects unauthenticated requests', async () => {
    expect((await request(app).get('/api/v1/logs')).status).toBe(401);
  });

  it('forbids VIEWER accounts from reading logs, details and system health', async () => {
    expect((await request(app).get('/api/v1/logs').set(bearer(viewerToken))).status).toBe(403);
    expect((await request(app).get(`/api/v1/logs/${'a'.repeat(24)}`).set(bearer(viewerToken))).status).toBe(403);
    expect((await request(app).get('/api/v1/system-health').set(bearer(viewerToken))).status).toBe(403);
    expect((await request(app).get('/api/v1/system-health/alerts').set(bearer(viewerToken))).status).toBe(403);
    expect(mockModel.find).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/logs/:id', () => {
  const id = 'b'.repeat(24);

  it('returns one entry', async () => {
    const lean = jest.fn(async () => ({ _id: id, method: 'GET', endpoint: '/x', status: 200, metadata: { userId: 1 } }));
    mockModel.findById.mockReturnValue({ select: () => ({ lean }) });

    const res = await request(app).get(`/api/v1/logs/${id}`).set(bearer(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data._id).toBe(id);
  });

  it('404s for an unknown id, 400 for a malformed id, 503 when the store is down', async () => {
    mockModel.findById.mockReturnValue({ select: () => ({ lean: async () => null }) });
    expect((await request(app).get(`/api/v1/logs/${id}`).set(bearer(adminToken))).status).toBe(404);
    expect((await request(app).get('/api/v1/logs/not-an-id').set(bearer(adminToken))).status).toBe(400);

    mockMongo.connected = false;
    const down = await request(app).get(`/api/v1/logs/${id}`).set(bearer(adminToken));
    expect(down.status).toBe(503);
    expect(down.body.error.code).toBe('LOG_STORE_UNAVAILABLE');
  });
});

describe('request log recording and redaction', () => {
  it('masks sensitive query values and never stores headers or bodies', async () => {
    await request(app)
      .post('/api/v1/auth/login?token=SUPERSECRET&page=1&api_key=ABC123')
      .set('Authorization', 'Bearer should-never-be-logged')
      .send({ email: 'kartik@example.com', password: 'Password123!' });
    await new Promise((r) => setTimeout(r, 50)); // log is written after the response finishes

    expect(mockModel.create).toHaveBeenCalled();
    const stored = JSON.stringify(mockModel.create.mock.calls[0][0]);
    expect(stored).toContain('token=[REDACTED]');
    expect(stored).toContain('api_key=[REDACTED]');
    expect(stored).toContain('page=1');
    for (const secret of ['SUPERSECRET', 'ABC123', 'should-never-be-logged', 'Password123!']) {
      expect(stored).not.toContain(secret);
    }
  });

  it('records the user id and role (not the token) for authenticated requests', async () => {
    mockModel.find.mockReturnValue(findChain([]));
    mockModel.countDocuments.mockResolvedValue(0);
    mockModel.create.mockClear();

    await request(app).get('/api/v1/logs').set(bearer(adminToken));
    await new Promise((r) => setTimeout(r, 50));

    const entry = mockModel.create.mock.calls[0][0];
    expect(entry.metadata).toEqual({ userId: expect.any(Number), role: 'SUPER_ADMIN' });
    expect(JSON.stringify(entry)).not.toContain(adminToken);
  });

  it('redactUrl leaves clean URLs alone and bounds the length', () => {
    expect(redactUrl('/api/v1/users?page=2')).toBe('/api/v1/users?page=2');
    expect(redactUrl('/a?password=x&Authorization=y&secret=z')).toBe('/a?password=[REDACTED]&Authorization=[REDACTED]&secret=[REDACTED]');
    expect(redactUrl(`/a?x=${'y'.repeat(2000)}`).length).toBeLessThanOrEqual(500);
  });
});

describe('analytics calculations', () => {
  const range = { from: '2026-10-01T00:00:00Z', to: '2026-10-03T12:00:00Z' };

  it('computes success, failure, error rate and average latency from known totals', async () => {
    mockModel.aggregate.mockResolvedValue([{ _id: null, total: 10, failed: 3, responseTimeSum: 1500 }]);

    const res = await request(app).get('/api/v1/analytics/cards').query(range).set(bearer(adminToken));
    const v = Object.fromEntries(res.body.data.map((c) => [c.label, c.value]));

    expect(v['Total Requests']).toBe(10);
    expect(v['Successful Requests']).toBe(7);
    expect(v['Failed Requests']).toBe(3);
    expect(v['Error Rate']).toBe(30);
    expect(v['Avg Response Time']).toBe(150);
    expect(res.body.meta).toMatchObject({ available: true, interval: 'day', source: 'request_logs' });

    // The range filter is part of the aggregation
    const match = mockModel.aggregate.mock.calls[0][0][0].$match;
    expect(match.timestamp.$gte).toEqual(new Date(range.from));
    expect(match.timestamp.$lte).toEqual(new Date(range.to));
  });

  it('handles an empty dataset without NaN or division by zero', async () => {
    mockModel.aggregate.mockResolvedValue([]);
    const res = await request(app).get('/api/v1/analytics/cards').query(range).set(bearer(adminToken));
    const v = Object.fromEntries(res.body.data.map((c) => [c.label, c.value]));
    expect(v['Total Requests']).toBe(0);
    expect(v['Error Rate']).toBe(0);
    expect(v['Avg Response Time']).toBe(0);
    expect(summariseTotals()).toMatchObject({ errorRate: 0, averageResponseTime: 0 });
  });

  it('rounds the error rate to two decimals', () => {
    expect(summariseTotals({ total: 3, failed: 1, responseTimeSum: 10 }).errorRate).toBe(33.33);
  });

  it('fills days with no traffic with real zeros and counts each request once', async () => {
    mockModel.aggregate.mockResolvedValue([{ _id: '2026-10-02T00:00:00.000Z', requests: 5, failed: 2 }]);

    const res = await request(app).get('/api/v1/analytics/traffic').query(range).set(bearer(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.map((p) => p.requests)).toEqual([0, 5, 0]);
    expect(res.body.data[1]).toMatchObject({ failed: 2, responses: 3, date: 'Oct 2' });
    expect(res.body.data.reduce((sum, p) => sum + p.requests, 0)).toBe(5); // total preserved

    const group = mockModel.aggregate.mock.calls[0][0][1].$group;
    expect(group.requests).toEqual({ $sum: 1 }); // one count per log entry
  });

  it('supports hourly buckets', () => {
    const from = new Date('2026-10-01T10:30:00Z');
    const to = new Date('2026-10-01T12:10:00Z');
    const series = fillBuckets([{ _id: '2026-10-01T11:00:00.000Z', requests: 4, failed: 1 }], { from, to, interval: 'hour' });
    expect(series.map((p) => p.requests)).toEqual([0, 4, 0]);
    expect(series[1].date).toBe('Oct 1 11:00');
  });

  it('groups top endpoints by path, ignoring query strings', async () => {
    mockModel.aggregate.mockResolvedValue([{ endpoint: '/api/v1/users', requests: 9 }]);
    const res = await request(app).get('/api/v1/analytics/top-endpoints').query(range).set(bearer(adminToken));
    expect(res.body.data).toEqual([{ endpoint: '/api/v1/users', requests: 9 }]);
    const group = mockModel.aggregate.mock.calls[0][0][1].$group;
    expect(JSON.stringify(group._id)).toContain('$split');
  });

  it('reports available=false and zero data when the log store is down', async () => {
    mockMongo.connected = false;
    const cards = await request(app).get('/api/v1/analytics/cards').set(bearer(adminToken));
    expect(cards.body.meta.available).toBe(false);
    const traffic = await request(app).get('/api/v1/analytics/traffic').set(bearer(adminToken));
    expect(traffic.body.data).toEqual([]);
    expect(mockModel.aggregate).not.toHaveBeenCalled();
  });

  it.each([
    [{ interval: 'week' }],
    [{ from: 'nope' }],
    [{ from: '2026-10-05T00:00:00Z', to: '2026-10-01T00:00:00Z' }],
    [{ from: '2026-01-01T00:00:00Z', to: '2026-10-01T00:00:00Z', interval: 'day' }],
    [{ from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z', interval: 'hour' }],
  ])('rejects an invalid range %j with 400', async (query) => {
    const res = await request(app).get('/api/v1/analytics/traffic').query(query).set(bearer(adminToken));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('requires authentication', async () => {
    expect((await request(app).get('/api/v1/analytics/cards')).status).toBe(401);
  });
});

describe('system health - healthy and failing dependencies', () => {
  const byName = (body) => Object.fromEntries(body.data.map((c) => [c.name, c]));

  it('reports a healthy database and a healthy log store', async () => {
    const res = await request(app).get('/api/v1/system-health').set(bearer(adminToken));
    const c = byName(res.body);
    expect(c['Database (PostgreSQL)']).toMatchObject({ status: 'Healthy', required: true });
    expect(c.MongoDB).toMatchObject({ status: 'Healthy', required: false });
  });

  it('shows a missing OPTIONAL service as Degraded, not as an outage', async () => {
    mockMongo.connected = false;
    const res = await request(app).get('/api/v1/system-health').set(bearer(adminToken));
    const c = byName(res.body);
    expect(res.status).toBe(200);
    expect(c.MongoDB.status).toBe('Degraded');
    expect(c.MongoDB.detail).toMatch(/optional/i);
    expect(c['Redis Cache'].status).toBe('Degraded'); // Redis is not running in tests
    expect(c['Database (PostgreSQL)'].status).toBe('Healthy');
    expect(c['API Gateway'].status).toBe('Healthy');
  });

  it('shows a failed REQUIRED dependency as Error without leaking the error text', async () => {
    const spy = jest.spyOn(pool, 'query').mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2'));
    try {
      const res = await request(app).get('/api/v1/system-health').set(bearer(adminToken));
      expect(res.status).toBe(200);
      expect(byName(res.body)['Database (PostgreSQL)'].status).toBe('Error');
      expect(JSON.stringify(res.body)).not.toMatch(/hunter2|10\.0\.0\.5|ECONNREFUSED/);
    } finally {
      spy.mockRestore();
    }
  });

  it('a hung dependency check is cut off by the timeout', async () => {
    const result = await healthMonitor.timed(() => new Promise(() => {}), 50);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/);
    expect(result.ms).toBeLessThan(1000);
  });

  it('requires authentication', async () => {
    expect((await request(app).get('/api/v1/system-health')).status).toBe(401);
  });
});

describe('liveness and readiness', () => {
  it('live: 200 and checks no dependency', async () => {
    const spy = jest.spyOn(pool, 'query');
    const res = await request(app).get('/api/v1/health/live');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('alive');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('ready: 200 when PostgreSQL works, 503 when it does not, even while the process is alive', async () => {
    expect((await request(app).get('/api/v1/health/ready')).status).toBe(200);

    const spy = jest.spyOn(pool, 'query').mockRejectedValue(new Error('db down'));
    try {
      const ready = await request(app).get('/api/v1/health/ready');
      expect(ready.status).toBe(503);
      expect(ready.body.error.code).toBe('NOT_READY');
      expect((await request(app).get('/api/v1/health/live')).status).toBe(200);

      const summary = await request(app).get('/api/v1/health');
      expect(summary.body.data.status).toBe('degraded');
      expect(summary.body.data.dependencies.postgres).toBe('unhealthy');
    } finally {
      spy.mockRestore();
    }
  });

  it('ready ignores optional services (MongoDB down is still ready)', async () => {
    mockMongo.connected = false;
    expect((await request(app).get('/api/v1/health/ready')).status).toBe(200);
  });
});
