const { app, request, loginAsAdmin } = require('./helpers');
const { pool } = require('../src/config/database');

let token;

beforeAll(async () => {
  token = await loginAsAdmin();
});

afterAll(async () => {
  await pool.end();
});

describe('API Keys lifecycle', () => {
  it('lists keys (starts empty or with prior keys)', async () => {
    const res = await request(app).get('/api/v1/api-keys').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('creates a key and returns the full raw key exactly once', async () => {
    const res = await request(app)
      .post('/api/v1/api-keys')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Jest Key', environment: 'Test' });

    expect(res.status).toBe(201);
    expect(res.body.data.key).toMatch(/^bx_test_[a-f0-9]{48}$/);
    expect(res.body.data.preview).toContain('\u2022\u2022\u2022\u2022');
  });

  it('rejects a key with no name', async () => {
    const res = await request(app)
      .post('/api/v1/api-keys')
      .set('Authorization', `Bearer ${token}`)
      .send({ environment: 'Test' });

    expect(res.status).toBe(400);
  });

  it('revokes a key', async () => {
    const created = await request(app)
      .post('/api/v1/api-keys')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Revoke Me', environment: 'Live' });

    const res = await request(app)
      .patch(`/api/v1/api-keys/${created.body.data.id}/revoke`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('Revoked');
  });

  it('deletes a key', async () => {
    const created = await request(app)
      .post('/api/v1/api-keys')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Delete Me', environment: 'Live' });

    const res = await request(app)
      .delete(`/api/v1/api-keys/${created.body.data.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
  });

  it('404s when deleting a key that does not exist', async () => {
    const res = await request(app).delete('/api/v1/api-keys/999999').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});
