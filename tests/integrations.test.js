const { app, request, loginAsAdmin } = require('./helpers');
const { pool } = require('../src/config/database');

let token;

beforeAll(async () => {
  token = await loginAsAdmin();
});

afterAll(async () => {
  await pool.end();
});

describe('GET /api/v1/integrations', () => {
  it('returns the list of integrations', async () => {
    const res = await request(app)
      .get('/api/v1/integrations')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get('/api/v1/integrations');
    expect(res.status).toBe(401);
  });
});
