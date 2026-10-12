const docsService = require('../services/docsService');
const { success } = require('../utils/response');

async function endpoints(req, res, next) {
  try {
    const data = docsService.getEndpoints();
    return success(res, data);
  } catch (err) {
    return next(err);
  }
}

module.exports = { endpoints };
