const authService = require('../services/authService');
const { success } = require('../utils/response');

async function register(req, res, next) {
  try {
    const { token, user } = await authService.register(req.body);
    return success(res, { token, user }, 'Registration successful', 201);
  } catch (err) {
    return next(err);
  }
}

async function login(req, res, next) {
  try {
    const { token, user } = await authService.login(req.body);
    return success(res, { token, user }, 'Login successful');
  } catch (err) {
    return next(err);
  }
}

async function me(req, res, next) {
  try {
    const user = await authService.getCurrentUser(req.user.id);
    return success(res, user);
  } catch (err) {
    return next(err);
  }
}

module.exports = { register, login, me };
