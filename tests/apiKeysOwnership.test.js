const { app, request, loginAsAdmin } = require('./helpers');
const { pool } = require('../src/config/database');
const apiKeyService = require('../src/services/apiKeyService');

let adminToken;
let priyaToken;
let nehaToken;
let viewerToken;
const createdIds = [];

const login = async (email) =>
  (await request(app).post('/api/v1/auth/login').send({ email, password: 'Password123!' })).body.data.token;
const bearer = (t) => ({ Authorization: `Bearer ${t}` });

async function createKey(token, name = 'Ownership Test Key', environment = 'Test') {
  const res = await request(app).post('/api/v1/api-keys').set(bearer(token)).send({ name, environment });
  if (res.body.data) createdIds.push(res.body.data.id);
  return res;
}

beforeAll(async () => {
  adminToken = await loginAsAdmin();
  priyaToken = await login('priya@example.com'); // DEVELOPER
  nehaToken = await login('neha@example.com'); // DEVELOPER
  viewerToken = await login('rahul@example.com'); // VIEWER
});

afterAll(async () => {
  if (createdIds.length) await pool.query('DELETE FROM api_keys WHERE id = ANY($1)', [createdIds]);
  await pool.end();
});

describe('API key ownership and permissions', () => {
  it('a developer sees their own keys, another developer does not', async () => {
    const created = await createKey(priyaToken);
    expect(created.status).toBe(201);

    const own = await request(app).get('/api/v1/api-keys').set(bearer(priyaToken));
    expect(own.body.data.map((k) => k.id)).toContain(created.body.data.id);

    const other = await request(app).get('/api/v1/api-keys').set(bearer(nehaToken));
    expect(other.body.data.map((k) => k.id)).not.toContain(created.body.data.id);

    const admin = await request(app).get('/api/v1/api-keys').set(bearer(adminToken));
    expect(admin.body.data.map((k) => k.id)).toContain(created.body.data.id);
  });

  it("a developer cannot revoke someone else's key (404, not 403, so ids can't be probed)", async () => {
    const created = await createKey(priyaToken);
    const res = await request(app).patch(`/api/v1/api-keys/${created.body.data.id}/revoke`).set(bearer(nehaToken));
    expect(res.status).toBe(404);

    const mine = await request(app).patch(`/api/v1/api-keys/${created.body.data.id}/revoke`).set(bearer(priyaToken));
    expect(mine.status).toBe(200);
    expect(mine.body.data.status).toBe('Revoked');
  });

  it('SUPER_ADMIN can revoke any key; developers cannot delete keys', async () => {
    const created = await createKey(priyaToken);
    const del = await request(app).delete(`/api/v1/api-keys/${created.body.data.id}`).set(bearer(priyaToken));
    expect(del.status).toBe(403);

    const revoke = await request(app).patch(`/api/v1/api-keys/${created.body.data.id}/revoke`).set(bearer(adminToken));
    expect(revoke.status).toBe(200);
  });

  it('a viewer cannot create keys and sees an empty list', async () => {
    const create = await request(app).post('/api/v1/api-keys').set(bearer(viewerToken)).send({ name: 'Nope' });
    expect(create.status).toBe(403);

    const list = await request(app).get('/api/v1/api-keys').set(bearer(viewerToken));
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([]);
  });
});

describe('API key secret handling', () => {
  it('the raw key appears only in the creation response, never in lists', async () => {
    const created = await createKey(adminToken, 'Secret Handling Key', 'Live');
    const raw = created.body.data.key;
    expect(raw).toMatch(/^bx_live_[a-f0-9]{48}$/);

    const list = await request(app).get('/api/v1/api-keys').set(bearer(adminToken));
    const text = JSON.stringify(list.body);
    expect(text).not.toContain(raw);
    expect(text).not.toContain('key_hash');
    expect(text).not.toContain('keyHash');

    const { rows } = await pool.query('SELECT key_hash FROM api_keys WHERE id = $1', [created.body.data.id]);
    expect(rows[0].key_hash).not.toBe(raw); // only a hash is stored
    expect(rows[0].key_hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('apiKeyService.verifyKey (building block for Phase 3 - not yet used by any route)', () => {
  it('accepts an active key and records last_used', async () => {
    const created = await createKey(adminToken, 'Verify Me');
    const info = await apiKeyService.verifyKey(created.body.data.key);
    expect(info.id).toBe(created.body.data.id);

    const { rows } = await pool.query('SELECT last_used FROM api_keys WHERE id = $1', [created.body.data.id]);
    expect(rows[0].last_used).not.toBeNull();
  });

  it('rejects a revoked key', async () => {
    const created = await createKey(adminToken, 'Revoked Verify');
    await request(app).patch(`/api/v1/api-keys/${created.body.data.id}/revoke`).set(bearer(adminToken));

    await expect(apiKeyService.verifyKey(created.body.data.key)).rejects.toMatchObject({
      statusCode: 401,
      code: 'INVALID_API_KEY',
    });
  });

  it('rejects malformed and unknown keys', async () => {
    await expect(apiKeyService.verifyKey('not-a-key')).rejects.toMatchObject({ statusCode: 401 });
    await expect(apiKeyService.verifyKey(undefined)).rejects.toMatchObject({ statusCode: 401 });
    await expect(apiKeyService.verifyKey(`bx_live_${'a'.repeat(48)}`)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('a bx_ key is not accepted as a dashboard login token', async () => {
    const created = await createKey(adminToken, 'Not A JWT');
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${created.body.data.key}`);
    expect(res.status).toBe(401);
  });
});
