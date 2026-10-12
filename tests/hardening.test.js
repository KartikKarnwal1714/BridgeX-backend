const { app, request, loginAsAdmin } = require('./helpers');
const { pool } = require('../src/config/database');

let adminToken;
const createdEmails = [];

beforeAll(async () => {
  adminToken = await loginAsAdmin();
});

afterAll(async () => {
  if (createdEmails.length) {
    await pool.query('DELETE FROM users WHERE email = ANY($1)', [createdEmails]);
  }
  await pool.end();
});

const auth = () => ({ Authorization: `Bearer ${adminToken}` });

async function createUser(overrides = {}) {
  const email = `hardening-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  createdEmails.push(email);
  const res = await request(app)
    .post('/api/v1/users')
    .set(auth())
    .send({ name: 'Hardening User', email, password: 'Password123!', role: 'VIEWER', ...overrides });
  return { res, email };
}

describe('self-registration privileges', () => {
  it('refuses to let a public registration choose a privileged role', async () => {
    const email = `escalate-${Date.now()}@example.com`;
    createdEmails.push(email);
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Escalate', email, password: 'Password123!', role: 'SUPER_ADMIN' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('defaults a public registration to VIEWER', async () => {
    const email = `viewer-${Date.now()}@example.com`;
    createdEmails.push(email);
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Plain Viewer', email, password: 'Password123!' });

    expect(res.status).toBe(201);
    expect(res.body.data.user.role).toBe('VIEWER');
  });
});

describe('client errors are 4xx, not 500', () => {
  it('returns 400 for a malformed JSON body', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{ not json');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  it('returns 400 for a non-numeric id', async () => {
    const res = await request(app).get('/api/v1/users/abc').set(auth());
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 for an out-of-range id', async () => {
    const res = await request(app).get('/api/v1/apis/99999999999999').set(auth());
    expect(res.status).toBe(400);
  });

  it('returns 404 for a well-formed id that does not exist', async () => {
    const res = await request(app).get('/api/v1/integrations/2000000000').set(auth());
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 409 when updating a user to an email that is already taken', async () => {
    const { res: created } = await createUser();
    const res = await request(app)
      .put(`/api/v1/users/${created.body.data.id}`)
      .set(auth())
      .send({ email: 'priya@example.com' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_IN_USE');
  });
});

describe('account rules', () => {
  it('rejects login for an Inactive account with 403', async () => {
    const { res: created, email } = await createUser({ status: 'Inactive' });
    expect(created.status).toBe(201);

    const res = await request(app).post('/api/v1/auth/login').send({ email, password: 'Password123!' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_INACTIVE');
  });

  it('treats email as case-insensitive at login', async () => {
    const { email } = await createUser();
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: email.toUpperCase(), password: 'Password123!' });
    expect(res.status).toBe(200);
  });

  it('does not let an admin delete their own account', async () => {
    const me = await request(app).get('/api/v1/auth/me').set(auth());
    const res = await request(app).delete(`/api/v1/users/${me.body.data.id}`).set(auth());

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CANNOT_DELETE_SELF');

    const stillThere = await request(app).get('/api/v1/auth/me').set(auth());
    expect(stillThere.status).toBe(200);
  });
});
