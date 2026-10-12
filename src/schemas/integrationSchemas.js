const PROTOCOLS = ['REST', 'GRAPHQL', 'SOAP'];
const STATUSES = ['Connected', 'Error', 'Pending'];

const createIntegrationSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'type', 'protocol', 'endpoint'],
  properties: {
    name: { type: 'string', minLength: 2, maxLength: 150 },
    type: { type: 'string', minLength: 2, maxLength: 100 },
    protocol: { type: 'string', enum: PROTOCOLS },
    endpoint: { type: 'string', minLength: 1, maxLength: 300 },
    status: { type: 'string', enum: STATUSES },
  },
};

const updateIntegrationSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: { type: 'string', minLength: 2, maxLength: 150 },
    type: { type: 'string', minLength: 2, maxLength: 100 },
    protocol: { type: 'string', enum: PROTOCOLS },
    endpoint: { type: 'string', minLength: 1, maxLength: 300 },
    status: { type: 'string', enum: STATUSES },
  },
};

module.exports = { createIntegrationSchema, updateIntegrationSchema };
