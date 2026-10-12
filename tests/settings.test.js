const { app, request, loginAsAdmin } = require('./helpers');
const { pool } = require('../src/config/database');

let token;

beforeAll(async () => {
  token = await loginAsAdmin();
});

afterAll(async () => {
  // Leave the settings as the seed defines them so test runs don't pollute dev data.
  await pool.query(
    `UPDATE app_settings SET data = data || '{"applicationName":"BridgeX","jwtExpiry":"1 hour"}'::jsonb WHERE id = 1`
  );
  await pool.end();
});

describe('GET /api/v1/settings', () => {
  it('returns the platform settings object', async () => {
    const res = await request(app).get('/api/v1/settings').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('applicationName');
    expect(res.body.data).toHaveProperty('theme');
  });
});

describe('PUT /api/v1/settings', () => {
  it('updates a subset of fields and persists them', async () => {
    const res = await request(app)
      .put('/api/v1/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ applicationName: 'BridgeX Test Run' });

    expect(res.status).toBe(200);
    expect(res.body.data.applicationName).toBe('BridgeX Test Run');

    const getRes = await request(app).get('/api/v1/settings').set('Authorization', `Bearer ${token}`);
    expect(getRes.body.data.applicationName).toBe('BridgeX Test Run');
  });

  it('silently strips an unknown field rather than applying it', async () => {
    const res = await request(app)
      .put('/api/v1/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ notARealSetting: true, applicationName: 'BridgeX Strip Test' });

    expect(res.status).toBe(200);
    expect(res.body.data.applicationName).toBe('BridgeX Strip Test');
    expect(res.body.data).not.toHaveProperty('notARealSetting');
  });
});

describe('settings validation, permissions and effect', () => {
  const login = async (email) =>
    (await request(app).post('/api/v1/auth/login').send({ email, password: 'Password123!' })).body.data.token;

  it('rejects values that are not one of the allowed options', async () => {
    const res = await request(app)
      .put('/api/v1/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ dateFormat: 'whenever', theme: 'Neon' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('forbids non-admins from changing settings but lets them read', async () => {
    const devToken = await login('priya@example.com');

    const put = await request(app)
      .put('/api/v1/settings')
      .set('Authorization', `Bearer ${devToken}`)
      .send({ applicationName: 'Hacked' });
    expect(put.status).toBe(403);

    const get = await request(app).get('/api/v1/settings').set('Authorization', `Bearer ${devToken}`);
    expect(get.status).toBe(200);
    expect(get.body.data.applicationName).not.toBe('Hacked');
  });

  it('does not expose server secrets through settings', async () => {
    const res = await request(app).get('/api/v1/settings').set('Authorization', `Bearer ${token}`);
    const text = JSON.stringify(res.body).toLowerCase();
    expect(text).not.toContain('jwt_secret');
    expect(text).not.toContain('database_url');
    expect(text).not.toContain('password_hash');
  });

  it('the JWT expiry setting really changes the lifetime of newly issued tokens', async () => {
    const jwt = require('jsonwebtoken');
    await request(app).put('/api/v1/settings').set('Authorization', `Bearer ${token}`).send({ jwtExpiry: '24 hours' });

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'kartik@example.com', password: 'Password123!' });
    const { iat, exp } = jwt.decode(res.body.data.token);
    expect(exp - iat).toBe(24 * 3600);

    await request(app).put('/api/v1/settings').set('Authorization', `Bearer ${token}`).send({ jwtExpiry: '1 hour' });
    const res2 = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'kartik@example.com', password: 'Password123!' });
    const d2 = jwt.decode(res2.body.data.token);
    expect(d2.exp - d2.iat).toBe(3600);
  });
});
