const { ApiError } = require('../utils/response');
const logger = require('../utils/logger');

/**
 * Turns well-known client-caused failures (malformed JSON body, bad id format,
 * unique-constraint violations) into proper 4xx responses instead of 500s.
 * Anything unrecognised is left alone and becomes a generic 500.
 */
function translateKnownError(err) {
  if (err && err.type === 'entity.parse.failed') {
    return new ApiError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  }
  if (err && err.type === 'entity.too.large') {
    return new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  }
  // PostgreSQL: 22P02 invalid_text_representation, 22003 numeric_value_out_of_range
  if (err && (err.code === '22P02' || err.code === '22003')) {
    return new ApiError(400, 'VALIDATION_ERROR', 'Invalid identifier or value in request');
  }
  // PostgreSQL: 23505 unique_violation
  if (err && err.code === '23505') {
    return new ApiError(409, 'CONFLICT', 'A record with these values already exists');
  }
  return err;
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const mapped = err instanceof ApiError ? err : translateKnownError(err);
  const isApiError = mapped instanceof ApiError;

  const statusCode = isApiError ? mapped.statusCode : 500;
  const code = isApiError ? mapped.code : 'INTERNAL_SERVER_ERROR';
  const message = isApiError ? mapped.message : 'Something went wrong. Please try again.';
  const details = isApiError ? mapped.details : [];

  logger.error(message, {
    code,
    statusCode,
    correlationId: req.correlationId,
    path: req.originalUrl,
    method: req.method,
    // Never log request bodies here — they may contain passwords/tokens.
    stack: err.stack,
  });

  res.status(statusCode).json({
    success: false,
    error: { code, message, details },
  });
}

module.exports = errorHandler;
