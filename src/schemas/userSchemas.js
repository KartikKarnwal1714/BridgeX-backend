const ROLES = ['SUPER_ADMIN', 'DEVELOPER', 'VIEWER', 'SUPPORT'];
const STATUSES = ['Active', 'Inactive'];

const createUserSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'email', 'password', 'role'],
  properties: {
    name: { type: 'string', minLength: 2, maxLength: 100 },
    email: { type: 'string', format: 'email' },
    password: { type: 'string', minLength: 8, maxLength: 128 },
    role: { type: 'string', enum: ROLES },
    status: { type: 'string', enum: STATUSES },
  },
};

const updateUserSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: { type: 'string', minLength: 2, maxLength: 100 },
    email: { type: 'string', format: 'email' },
    role: { type: 'string', enum: ROLES },
    status: { type: 'string', enum: STATUSES },
  },
};

module.exports = { createUserSchema, updateUserSchema };
