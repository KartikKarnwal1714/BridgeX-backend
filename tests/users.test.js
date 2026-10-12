const { app, request, loginAsAdmin } = require('./helpers');
const { pool } = require('../src/config/database');

let token;

beforeAll(async () => {
  token = await loginAsAdmin();
});

afterAll(async () => {
  await pool.end();
});

describe('GET /api/v1/users', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get('/api/v1/users');
    expect(res.status).toBe(401);
  });

  it('returns the user list for an authenticated SUPER_ADMIN', async () => {
    const res = await request(app).get('/api/v1/users').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data[0]).not.toHaveProperty('password_hash');
  });
});

describe('POST /api/v1/users', () => {
  it('creates a user as SUPER_ADMIN', async () => {
    const email = `jest-user-${Date.now()}@example.com`;
    const res = await request(app)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Jest User', email, password: 'Password123!', role: 'VIEWER' });

    expect(res.status).toBe(201);
    expect(res.body.data.email).toBe(email);
  });

  it('rejects a DEVELOPER role from creating a user (RBAC)', async () => {
    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'priya@example.com', password: 'Password123!' });
    const devToken = loginRes.body.data.token;

    const res = await request(app)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${devToken}`)
      .send({ name: 'X', email: `blocked-${Date.now()}@example.com`, password: 'Password123!', role: 'VIEWER' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});
