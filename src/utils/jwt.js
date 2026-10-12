const jwt = require('jsonwebtoken');
const env = require('../config/env');

function signToken(payload, expiresIn = env.JWT_EXPIRES_IN) {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn, algorithm: 'HS256' });
}

function verifyToken(token) {
  return jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
}

module.exports = { signToken, verifyToken };
