const registerSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'email', 'password'],
  properties: {
    name: { type: 'string', minLength: 2, maxLength: 100 },
    email: { type: 'string', format: 'email' },
    password: { type: 'string', minLength: 8, maxLength: 128 },
    // Public self-registration may only create VIEWER accounts. Privileged
    // roles are assigned by a SUPER_ADMIN through POST /users.
    role: { type: 'string', enum: ['VIEWER'] },
  },
};

const loginSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['email', 'password'],
  properties: {
    email: { type: 'string', format: 'email' },
    password: { type: 'string', minLength: 1 },
  },
};

module.exports = { registerSchema, loginSchema };
