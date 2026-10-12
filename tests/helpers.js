const request = require('supertest');
const app = require('../src/app');

const SEEDED_ADMIN = { email: 'kartik@example.com', password: 'Password123!' };

async function loginAsAdmin() {
  const res = await request(app).post('/api/v1/auth/login').send(SEEDED_ADMIN);
  return res.body.data.token;
}

module.exports = { app, request, SEEDED_ADMIN, loginAsAdmin };
