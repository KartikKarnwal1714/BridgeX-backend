const integrationService = require('../services/integrationService');
const { success } = require('../utils/response');

async function list(req, res, next) {
  try {
    const integrations = await integrationService.listIntegrations();
    return success(res, integrations);
  } catch (err) {
    return next(err);
  }
}

async function getOne(req, res, next) {
  try {
    const integration = await integrationService.getIntegration(req.params.id);
    return success(res, integration);
  } catch (err) {
    return next(err);
  }
}

async function create(req, res, next) {
  try {
    const integration = await integrationService.createIntegration(req.body);
    return success(res, integration, 'Integration created', 201);
  } catch (err) {
    return next(err);
  }
}

async function update(req, res, next) {
  try {
    const integration = await integrationService.updateIntegration(req.params.id, req.body);
    return success(res, integration, 'Integration updated');
  } catch (err) {
    return next(err);
  }
}

async function remove(req, res, next) {
  try {
    await integrationService.deleteIntegration(req.params.id);
    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
}

module.exports = { list, getOne, create, update, remove };
