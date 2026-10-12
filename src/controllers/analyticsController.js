const analyticsService = require('../services/analyticsService');
const { success } = require('../utils/response');

function handler(serviceFn) {
  return async (req, res, next) => {
    try {
      const { data, meta } = await serviceFn(req.query);
      return success(res, data, 'Request successful', 200, meta);
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = {
  cards: handler(analyticsService.getCards),
  traffic: handler(analyticsService.getTraffic),
  topEndpoints: handler(analyticsService.getTopEndpoints),
  gateway: handler(analyticsService.getGatewayUsage),
};
