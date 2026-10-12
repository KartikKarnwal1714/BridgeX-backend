const systemHealthService = require('../services/systemHealthService');
const { success } = require('../utils/response');

async function status(req, res, next) {
  try {
    const data = await systemHealthService.getSystemHealth();
    return success(res, data);
  } catch (err) {
    return next(err);
  }
}

async function alerts(req, res, next) {
  try {
    const data = await systemHealthService.getRecentAlerts();
    return success(res, data);
  } catch (err) {
    return next(err);
  }
}

module.exports = { status, alerts };
