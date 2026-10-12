const { verifyToken } = require('../utils/jwt');
const { ApiError } = require('../utils/response');

function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next(new ApiError(401, 'UNAUTHORIZED', 'Missing or malformed Authorization header'));
  }

  try {
    const payload = verifyToken(token);
    req.user = payload; // { id, email, role }
    next();
  } catch (err) {
    return next(new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired token'));
  }
}

/**
 * Usage: authorize('SUPER_ADMIN', 'DEVELOPER')
 * Must run after `authenticate`.
 */
function authorize(...allowedRoles) {
  const middleware = (req, res, next) => {
    if (!req.user) {
      return next(new ApiError(401, 'UNAUTHORIZED', 'Authentication required'));
    }
    if (!allowedRoles.includes(req.user.role)) {
      return next(new ApiError(403, 'FORBIDDEN', 'You do not have permission to perform this action'));
    }
    next();
  };
  // Exposed so the generated API documentation can list required roles.
  middleware.allowedRoles = allowedRoles;
  return middleware;
}

module.exports = { authenticate, authorize };
