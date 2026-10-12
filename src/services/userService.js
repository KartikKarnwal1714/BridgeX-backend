const userModel = require('../models/userModel');
const { hashPassword } = require('../utils/password');
const { ApiError } = require('../utils/response');

async function listUsers() {
  return userModel.findAll();
}

async function getUser(id) {
  const user = await userModel.findById(id);
  if (!user) {
    throw new ApiError(404, 'NOT_FOUND', 'User not found');
  }
  return user;
}

async function createUser({ name, email: rawEmail, password, role, status }) {
  const email = String(rawEmail).trim().toLowerCase();
  const existing = await userModel.findByEmail(email);
  if (existing) {
    throw new ApiError(409, 'EMAIL_IN_USE', 'An account with this email already exists');
  }
  const passwordHash = await hashPassword(password);
  return userModel.create({ name, email, passwordHash, role, status });
}

async function updateUser(id, fields) {
  const existing = await userModel.findById(id);
  if (!existing) {
    throw new ApiError(404, 'NOT_FOUND', 'User not found');
  }
  const changes = { ...fields };
  if (changes.email !== undefined) {
    changes.email = String(changes.email).trim().toLowerCase();
    const taken = await userModel.findByEmail(changes.email);
    if (taken && String(taken.id) !== String(id)) {
      throw new ApiError(409, 'EMAIL_IN_USE', 'An account with this email already exists');
    }
  }
  return userModel.update(id, changes);
}

async function deleteUser(id, requesterId) {
  if (requesterId !== undefined && String(id) === String(requesterId)) {
    throw new ApiError(409, 'CANNOT_DELETE_SELF', 'You cannot delete your own account');
  }
  const existing = await userModel.findById(id);
  if (!existing) {
    throw new ApiError(404, 'NOT_FOUND', 'User not found');
  }
  await userModel.remove(id);
}

module.exports = { listUsers, getUser, createUser, updateUser, deleteUser };
