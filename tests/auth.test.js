const { app, request, SEEDED_ADMIN, loginAsAdmin } = require('./helpers');
const { pool } = require('../src/config/database');

afterAll(async () => {
  await pool.end();
});

describe('POST /api/v1/auth/register', () => {
  it('registers a new user and returns a token', async () => {
    const email = `test-${Date.now()}@example.com`;
    const res = await request(app).post('/api/v1/auth/register').send({
      name: 'Jest Test User',
      email,
      password: 'Password123!',
      role: 'VIEWER',
    });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('token');
    expect(res.body.data.user.email).toBe(email);
    expect(res.body.data.user).not.toHaveProperty('password_hash');
  });

  it('rejects a request that fails validation', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      name: 'A',
      email: 'not-an-email',
    });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(res.body.error.details)).toBe(true);
  });

  it('rejects a duplicate email with 409', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      name: 'Duplicate',
      email: SEEDED_ADMIN.email,
      password: 'Password123!',
    });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_IN_USE');
  });
});

describe('POST /api/v1/auth/login', () => {
  it('logs in with correct credentials and returns a JWT', async () => {
    const res = await request(app).post('/api/v1/auth/login').send(SEEDED_ADMIN);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('token');
    expect(res.body.data.user.email).toBe(SEEDED_ADMIN.email);
  });

  it('rejects an invalid password with 401', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: SEEDED_ADMIN.email, password: 'totally-wrong' });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });
});

describe('GET /api/v1/auth/me', () => {
  it('returns the current user when authenticated', async () => {
    const token = await loginAsAdmin();

    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe(SEEDED_ADMIN.email);
  });

  it('rejects the request when no token is provided', async () => {
    const res = await request(app).get('/api/v1/auth/me');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects the request when the token is invalid', async () => {
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', 'Bearer not-a-real-token');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});
