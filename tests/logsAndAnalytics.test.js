const { app, request, loginAsAdmin } = require('./helpers');
const { pool } = require('../src/config/database');

let token;

beforeAll(async () => {
  token = await loginAsAdmin();
});

afterAll(async () => {
  await pool.end();
});

describe('GET /api/v1/logs', () => {
  it('returns an empty page, flagged available=false, when MongoDB is unavailable (never an error)', async () => {
    const res = await request(app).get('/api/v1/logs').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.meta).toMatchObject({ page: 1, limit: 50, total: 0, available: false });
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/v1/logs');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/v1/analytics/* without a log store (MongoDB not running in this test run)', () => {
  // These tests run without MongoDB, so they check the honest "no data" behaviour.
  // Calculations and filters are verified in logsMocked.test.js with a mocked log model.
  it('cards: returns six cards, with zeros (not made-up numbers) and available=false', async () => {
    const res = await request(app).get('/api/v1/analytics/cards').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.map((c) => c.label)).toEqual([
      'Total Requests',
      'Successful Requests',
      'Failed Requests',
      'Error Rate',
      'Avg Response Time',
      'Active APIs',
    ]);
    const byLabel = Object.fromEntries(res.body.data.map((c) => [c.label, c.value]));
    expect(byLabel['Total Requests']).toBe(0);
    expect(byLabel['Error Rate']).toBe(0);
    expect(byLabel['Active APIs']).toBeGreaterThan(0); // real count from the apis table
    expect(res.body.meta.available).toBe(false);
  });

  it('traffic: returns an empty series instead of a fabricated one', async () => {
    const res = await request(app).get('/api/v1/analytics/traffic').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.source).toBe('request_logs');
  });

  it('top-endpoints: returns an empty list instead of falling back to seeded counters', async () => {
    const res = await request(app).get('/api/v1/analytics/top-endpoints').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('dashboard traffic is also real (empty here), not synthetic', async () => {
    const res = await request(app).get('/api/v1/dashboard/traffic').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});
