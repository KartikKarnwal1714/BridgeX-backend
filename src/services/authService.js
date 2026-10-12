const userModel = require('../models/userModel');
const { hashPassword, comparePassword } = require('../utils/password');
const { signToken } = require('../utils/jwt');
const { getJwtLifetime } = require('./settingsService');
const { ApiError } = require('../utils/response');

function normalizeEmail(email) {
  return String(email).trim().toLowerCase();
}

function sanitizeUser(user) {
  const { password_hash, ...rest } = user;
  return rest;
}

async function register({ name, email: rawEmail, password, role = 'VIEWER' }) {
  const email = normalizeEmail(rawEmail);
  const existing = await userModel.findByEmail(email);
  if (existing) {
    throw new ApiError(409, 'EMAIL_IN_USE', 'An account with this email already exists');
  }

  const passwordHash = await hashPassword(password);
  const user = await userModel.create({ name, email, passwordHash, role });

  const token = signToken({ id: user.id, email: user.email, role: user.role }, await getJwtLifetime());
  return { token, user };
}

async function login({ email: rawEmail, password }) {
  const email = normalizeEmail(rawEmail);
  const user = await userModel.findByEmail(email);
  if (!user) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
  }

  const matches = await comparePassword(password, user.password_hash);
  if (!matches) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
  }

  if (user.status !== 'Active') {
    throw new ApiError(403, 'ACCOUNT_INACTIVE', 'This account is inactive. Contact an administrator.');
  }

  await userModel.update(user.id, { last_active: new Date() });

  const token = signToken({ id: user.id, email: user.email, role: user.role }, await getJwtLifetime());
  return { token, user: sanitizeUser(user) };
}

async function getCurrentUser(userId) {
  const user = await userModel.findById(userId);
  if (!user) {
    throw new ApiError(404, 'NOT_FOUND', 'User not found');
  }
  return user;
}

module.exports = { register, login, getCurrentUser, sanitizeUser };
