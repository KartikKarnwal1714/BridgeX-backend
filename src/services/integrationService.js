const integrationModel = require('../models/integrationModel');
const { ApiError } = require('../utils/response');

async function listIntegrations() {
  return integrationModel.findAll();
}

async function getIntegration(id) {
  const integration = await integrationModel.findById(id);
  if (!integration) {
    throw new ApiError(404, 'NOT_FOUND', 'Integration not found');
  }
  return integration;
}

async function createIntegration(payload) {
  return integrationModel.create(payload);
}

async function updateIntegration(id, fields) {
  const existing = await integrationModel.findById(id);
  if (!existing) {
    throw new ApiError(404, 'NOT_FOUND', 'Integration not found');
  }
  return integrationModel.update(id, fields);
}

async function deleteIntegration(id) {
  const existing = await integrationModel.findById(id);
  if (!existing) {
    throw new ApiError(404, 'NOT_FOUND', 'Integration not found');
  }
  await integrationModel.remove(id);
}

module.exports = {
  listIntegrations,
  getIntegration,
  createIntegration,
  updateIntegration,
  deleteIntegration,
};
