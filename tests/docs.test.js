const YAML = require('yamljs');
const path = require('path');
const { app, request, loginAsAdmin } = require('./helpers');
const { pool } = require('../src/config/database');
const apiRouter = require('../src/routes');
const { listRoutes } = require('../src/utils/routeIntrospection');
const { DESCRIPTIONS } = require('../src/services/docsService');

let token;
beforeAll(async () => {
  token = await loginAsAdmin();
});
afterAll(async () => {
  await pool.end();
});

const realRoutes = listRoutes(apiRouter);
const key = (r) => `${r.method} ${r.path}`;

describe('API documentation matches the real routes', () => {
  it('the Documentation endpoint lists exactly the registered routes', async () => {
    const res = await request(app).get('/api/v1/docs/endpoints').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);

    const documented = Object.values(res.body.data).flat().map(key).sort();
    expect(documented).toEqual(realRoutes.map(key).sort());
  });

  it('every route has a human description (add one in docsService when adding a route)', () => {
    const missing = realRoutes.map(key).filter((k) => !DESCRIPTIONS[k]);
    expect(missing).toEqual([]);
  });

  it('has no description for a route that no longer exists', () => {
    const real = new Set(realRoutes.map(key));
    const stale = Object.keys(DESCRIPTIONS).filter((k) => !real.has(k));
    expect(stale).toEqual([]);
  });

  it('openapi.yaml (Swagger) documents exactly the registered routes', () => {
    const doc = YAML.load(path.join(__dirname, '../src/docs/openapi.yaml'));
    const methods = ['get', 'post', 'put', 'patch', 'delete'];
    const inSpec = [];
    for (const [p, ops] of Object.entries(doc.paths)) {
      for (const m of Object.keys(ops)) if (methods.includes(m)) inSpec.push(`${m.toUpperCase()} /api/v1${p}`);
    }
    expect(inSpec.sort()).toEqual(realRoutes.map(key).sort());
  });

  it('marks public vs protected endpoints and required roles correctly', async () => {
    const res = await request(app).get('/api/v1/docs/endpoints').set('Authorization', `Bearer ${token}`);
    const all = Object.values(res.body.data).flat();
    const find = (m, p) => all.find((e) => e.method === m && e.path === p);

    expect(find('POST', '/api/v1/auth/login').auth).toBe('Public');
    expect(find('GET', '/api/v1/health/ready').auth).toBe('Public');
    expect(find('GET', '/api/v1/users').roles).toEqual(['SUPER_ADMIN', 'SUPPORT']);
    expect(find('GET', '/api/v1/logs').roles).toEqual(['SUPER_ADMIN', 'DEVELOPER', 'SUPPORT']);
    expect(find('DELETE', '/api/v1/api-keys/{id}').roles).toEqual(['SUPER_ADMIN']);
  });

  it('does not claim API-key authentication of requests', () => {
    const doc = YAML.load(path.join(__dirname, '../src/docs/openapi.yaml'));
    expect(Object.keys(doc.components.securitySchemes)).toEqual(['bearerAuth']);
  });

  it('requires authentication to read the documentation endpoint', async () => {
    const res = await request(app).get('/api/v1/docs/endpoints');
    expect(res.status).toBe(401);
  });
});
