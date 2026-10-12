const { app, request, loginAsAdmin } = require('./helpers');
const { pool } = require('../src/config/database');

let token;

beforeAll(async () => {
  token = await loginAsAdmin();
});

afterAll(async () => {
  await pool.end();
});

describe('GET /api/v1/apis', () => {
  it('returns the list of registered APIs', async () => {
    const res = await request(app).get('/api/v1/apis').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
  });
});

describe('POST /api/v1/apis', () => {
  it('creates a new API entry', async () => {
    const res = await request(app)
      .post('/api/v1/apis')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Jest Test API', protocol: 'REST', base_url: '/api/v1/jest-test' });

    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('Jest Test API');
  });

  it('rejects an invalid protocol value', async () => {
    const res = await request(app)
      .post('/api/v1/apis')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Bad API', protocol: 'FTP', base_url: '/api/v1/bad' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
