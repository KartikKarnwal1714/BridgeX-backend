const { app, request, loginAsAdmin } = require('./helpers');
const { pool } = require('../src/config/database');

let token;

beforeAll(async () => {
  token = await loginAsAdmin();
});

afterAll(async () => {
  await pool.end();
});

describe('GET /api/v1/system-health', () => {
  it('returns live status for each dependency', async () => {
    const res = await request(app).get('/api/v1/system-health').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const names = res.body.data.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(['API Gateway', 'Database (PostgreSQL)', 'MongoDB', 'Redis Cache'])
    );
    // Postgres must be healthy since these tests are themselves hitting it.
    const pg = res.body.data.find((c) => c.name === 'Database (PostgreSQL)');
    expect(pg.status).toBe('Healthy');
  });
});

describe('GET /api/v1/system-health/alerts', () => {
  it('returns an array (empty when MongoDB is unavailable)', async () => {
    const res = await request(app).get('/api/v1/system-health/alerts').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe('GET /api/v1/docs/endpoints', () => {
  it('returns endpoints grouped by section', async () => {
    const res = await request(app).get('/api/v1/docs/endpoints').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('Authentication');
    expect(res.body.data).toHaveProperty('API Keys');
    expect(Array.isArray(res.body.data.Authentication)).toBe(true);
  });
});
