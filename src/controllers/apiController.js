const apiService = require('../services/apiService');
const { success } = require('../utils/response');

async function list(req, res, next) {
  try {
    const apis = await apiService.listApis();
    return success(res, apis);
  } catch (err) {
    return next(err);
  }
}

async function getOne(req, res, next) {
  try {
    const api = await apiService.getApi(req.params.id);
    return success(res, api);
  } catch (err) {
    return next(err);
  }
}

async function create(req, res, next) {
  try {
    const api = await apiService.createApi(req.body);
    return success(res, api, 'API created', 201);
  } catch (err) {
    return next(err);
  }
}

async function update(req, res, next) {
  try {
    const api = await apiService.updateApi(req.params.id, req.body);
    return success(res, api, 'API updated');
  } catch (err) {
    return next(err);
  }
}

async function remove(req, res, next) {
  try {
    await apiService.deleteApi(req.params.id);
    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
}

module.exports = { list, getOne, create, update, remove };
