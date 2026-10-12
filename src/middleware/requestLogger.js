const { recordRequestLog } = require('../services/logService');
const logger = require('../utils/logger');
const { redactUrl } = require('./redact');

function requestLogger(req, res, next) {
  const start = Date.now();

  res.on('finish', () => {
    const responseTime = Date.now() - start;

    const endpoint = redactUrl(req.originalUrl);

    logger.info('request', {
      correlationId: req.correlationId,
      method: req.method,
      endpoint,
      status: res.statusCode,
      responseTime,
    });

    recordRequestLog({
      correlationId: req.correlationId,
      method: req.method,
      endpoint,
      status: res.statusCode,
      responseTime,
      service: 'BridgeX API',
      error: res.statusCode >= 500 ? 'internal_error' : null,
      // req.user is set by the auth middleware (when the request had a valid
      // token). Only the id and role are stored — never the token itself.
      metadata: req.user ? { userId: req.user.id, role: req.user.role } : {},
    }).catch(() => {
      /* best-effort — already logged inside the service */
    });
  });

  next();
}

module.exports = requestLogger;
