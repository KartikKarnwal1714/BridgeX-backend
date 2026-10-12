const settingsService = require('../services/settingsService');
const { success } = require('../utils/response');

async function get(req, res, next) {
  try {
    const data = await settingsService.getSettings();
    return success(res, data);
  } catch (err) {
    return next(err);
  }
}

async function update(req, res, next) {
  try {
    const data = await settingsService.updateSettings(req.body);
    return success(res, data, 'Settings updated');
  } catch (err) {
    return next(err);
  }
}

module.exports = { get, update };
