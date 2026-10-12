const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { ApiError } = require('../utils/response');

const ajv = new Ajv({ allErrors: true, removeAdditional: 'failing' });
addFormats(ajv);

/**
 * Usage: validate(createUserSchema)
 * Validates req.body against the given JSON schema and rejects with 400
 * on failure using the standard error response shape.
 */
function validate(schema) {
  const validateFn = ajv.compile(schema);

  return (req, res, next) => {
    const valid = validateFn(req.body);
    if (!valid) {
      const details = (validateFn.errors || []).map((e) => ({
        field: e.instancePath || e.params?.missingProperty || '(root)',
        message: e.message,
      }));
      return next(new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', details));
    }
    next();
  };
}

module.exports = validate;
