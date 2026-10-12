const createApiKeySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 2, maxLength: 150 },
    environment: { type: 'string', enum: ['Live', 'Test'] },
  },
};

const updateKeyGatewaySchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    rateLimitPerMinute: { type: 'integer', minimum: 1, maximum: 10000 },
    expiresAt: { type: ['string', 'null'], format: 'date-time' },
    apiIds: { type: 'array', items: { type: 'integer', minimum: 1 }, uniqueItems: true, maxItems: 200 },
  },
};

module.exports = { createApiKeySchema, updateKeyGatewaySchema };
