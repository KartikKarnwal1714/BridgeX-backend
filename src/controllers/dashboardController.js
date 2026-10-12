const dashboardService = require('../services/dashboardService');
const { success } = require('../utils/response');

async function stats(req, res, next) {
  try {
    const data = await dashboardService.getStats();
    return success(res, data);
  } catch (err) {
    return next(err);
  }
}

async function traffic(req, res, next) {
  try {
    const data = await dashboardService.getTrafficOverview();
    return success(res, data);
  } catch (err) {
    return next(err);
  }
}

async function protocolDistribution(req, res, next) {
  try {
    const data = await dashboardService.getProtocolDistribution();
    return success(res, data);
  } catch (err) {
    return next(err);
  }
}

async function topApis(req, res, next) {
  try {
    const data = await dashboardService.getTopApis();
    return success(res, data);
  } catch (err) {
    return next(err);
  }
}

async function systemStatus(req, res, next) {
  try {
    const data = await dashboardService.getSystemStatus();
    return success(res, data);
  } catch (err) {
    return next(err);
  }
}

module.exports = { stats, traffic, protocolDistribution, topApis, systemStatus };
