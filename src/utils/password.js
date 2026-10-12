const bcrypt = require('bcrypt');
const env = require('../config/env');

async function hashPassword(plainText) {
  return bcrypt.hash(plainText, env.BCRYPT_SALT_ROUNDS);
}

async function comparePassword(plainText, hash) {
  return bcrypt.compare(plainText, hash);
}

module.exports = { hashPassword, comparePassword };
