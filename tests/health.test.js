const { app, request } = require('./helpers');
const { pool } = require('../src/config/database');

afterAll(async () => {
  await pool.end();
});

describe('GET /api/v1/health', () => {
  it('returns 200 with a healthy status envelope', async () => {
    const res = await request(app).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('status');
    expect(res.body.data).toHaveProperty('service', 'BridgeX API');
    expect(res.body.data).toHaveProperty('dependencies');
  });
});

describe('Unknown route', () => {
  it('returns 404 with a consistent error envelope', async () => {
    const res = await request(app).get('/api/v1/this-route-does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
