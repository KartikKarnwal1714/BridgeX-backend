const userService = require('../services/userService');
const { success } = require('../utils/response');

async function list(req, res, next) {
  try {
    const users = await userService.listUsers();
    return success(res, users);
  } catch (err) {
    return next(err);
  }
}

async function getOne(req, res, next) {
  try {
    const user = await userService.getUser(req.params.id);
    return success(res, user);
  } catch (err) {
    return next(err);
  }
}

async function create(req, res, next) {
  try {
    const user = await userService.createUser(req.body);
    return success(res, user, 'User created', 201);
  } catch (err) {
    return next(err);
  }
}

async function update(req, res, next) {
  try {
    const user = await userService.updateUser(req.params.id, req.body);
    return success(res, user, 'User updated');
  } catch (err) {
    return next(err);
  }
}

async function remove(req, res, next) {
  try {
    await userService.deleteUser(req.params.id, req.user.id);
    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
}

module.exports = { list, getOne, create, update, remove };
