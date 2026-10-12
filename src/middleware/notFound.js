const { ApiError } = require('../utils/response');

function notFound(req, res, next) {
  next(new ApiError(404, 'NOT_FOUND', `Route ${req.method} ${req.originalUrl} not found`));
}

module.exports = notFound;
