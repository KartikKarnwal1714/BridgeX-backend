const env = require('../config/env');

const PROTOCOLS = ['REST', 'GRAPHQL', 'SOAP'];
const STATUSES = ['Healthy', 'Degraded', 'Error'];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];

// Shared by create and update. Cross-field rules (e.g. "bearer mode needs a credential") need the
// stored values too, so they live in apiService.validateGatewayConfig, not here.
const gatewayProperties = {
  gateway_slug: { type: ['string', 'null'], pattern: '^[a-z0-9]([a-z0-9-]{0,48}[a-z0-9])?$' },
  gateway_enabled: { type: 'boolean' },
  allowed_methods: { type: 'array', items: { type: 'string', enum: METHODS }, minItems: 1, uniqueItems: true },
  timeout_ms: { type: 'integer', minimum: 100, maximum: env.GATEWAY_MAX_TIMEOUT_MS },
  upstream_auth_mode: { type: 'string', enum: ['none', 'bearer', 'header'] },
  upstream_auth_header: { type: ['string', 'null'], pattern: '^[A-Za-z0-9-]{1,100}$' },
  // Write-only. Stored encrypted; never returned by any endpoint.
  upstream_credential: { type: ['string', 'null'], pattern: '^[\\x20-\\x7e]{1,2000}$' },
  forward_headers: { type: 'array', items: { type: 'string', pattern: '^[A-Za-z0-9-]{1,64}$' }, maxItems: 20, uniqueItems: true },
};

const baseProperties = {
  name: { type: 'string', minLength: 2, maxLength: 150 },
  description: { type: 'string', maxLength: 500 },
  protocol: { type: 'string', enum: PROTOCOLS },
  base_url: { type: 'string', minLength: 1, maxLength: 300 },
  status: { type: 'string', enum: STATUSES },
  ...gatewayProperties,
};

const createApiSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'protocol', 'base_url'],
  properties: baseProperties,
};

const updateApiSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: baseProperties,
};

module.exports = { createApiSchema, updateApiSchema };
