const { listRoutes } = require('../utils/routeIntrospection');

// Human-written text only. WHICH endpoints exist, and who may call them,
// is read from the real routers (see utils/routeIntrospection.js) so it can
// never drift. If you add a route, add its one-line description here; the
// test suite fails until you do.
const SECTION_NAMES = {
  '/health': 'Health',
  '/auth': 'Authentication',
  '/users': 'Users',
  '/apis': 'APIs & Services',
  '/integrations': 'Integrations',
  '/dashboard': 'Dashboard',
  '/analytics': 'Analytics',
  '/logs': 'Logs',
  '/api-keys': 'API Keys',
  '/system-health': 'System Health',
  '/settings': 'Settings',
  '/docs': 'Documentation',
};

const DESCRIPTIONS = {
  'GET /api/v1/health': 'Public health summary (Postgres, plus optional Mongo/Redis status)',
  'GET /api/v1/health/live': 'Liveness probe: the process is running (no dependency checks)',
  'GET /api/v1/health/ready': 'Readiness probe: 200 only when PostgreSQL is reachable, otherwise 503',
  'POST /api/v1/auth/register': 'Register a new VIEWER account',
  'POST /api/v1/auth/login': 'Log in and receive a JWT',
  'GET /api/v1/auth/me': 'Get the current authenticated user',
  'GET /api/v1/users': 'List all users',
  'GET /api/v1/users/{id}': 'Get a user by ID',
  'POST /api/v1/users': 'Create a user',
  'PUT /api/v1/users/{id}': 'Update a user',
  'DELETE /api/v1/users/{id}': 'Delete a user (you cannot delete yourself)',
  'GET /api/v1/apis': 'List registered APIs (including gateway route settings; upstream credentials are never returned)',
  'GET /api/v1/apis/{id}': 'Get an API by ID',
  'POST /api/v1/apis': 'Register a new API, optionally with a gateway route (gateway_slug) and upstream settings',
  'PUT /api/v1/apis/{id}': 'Update an API, its gateway route, enable/disable it, or rotate its upstream credential',
  'DELETE /api/v1/apis/{id}': 'Delete an API',
  'GET /api/v1/integrations': 'List integrations',
  'GET /api/v1/integrations/{id}': 'Get an integration by ID',
  'POST /api/v1/integrations': 'Create an integration',
  'PUT /api/v1/integrations/{id}': 'Update an integration',
  'DELETE /api/v1/integrations/{id}': 'Delete an integration',
  'GET /api/v1/dashboard/stats': 'Aggregate KPI stats from the registered-API counters',
  'GET /api/v1/dashboard/traffic': 'Last 7 days of real request traffic (empty if no log data)',
  'GET /api/v1/dashboard/protocol-distribution': 'API protocol breakdown',
  'GET /api/v1/dashboard/top-apis': 'Top registered APIs by request counter',
  'GET /api/v1/dashboard/system-status': 'Quick infrastructure status summary',
  'GET /api/v1/analytics/cards': 'Summary cards for a date range (?from, ?to, ?interval)',
  'GET /api/v1/analytics/traffic': 'Requests over time for a date range (?from, ?to, ?interval=hour|day)',
  'GET /api/v1/analytics/top-endpoints': 'Most-requested paths in a date range',
  'GET /api/v1/analytics/gateway': 'Gateway usage per API, per API key and per outcome for a date range (?from, ?to)',
  'GET /api/v1/logs': 'Search request logs (?page, ?limit, ?q, ?method, ?status, ?source=gateway|dashboard, ?from, ?to)',
  'GET /api/v1/logs/{id}': 'Get one request log entry',
  'GET /api/v1/api-keys': 'List API keys (your own, or all for SUPER_ADMIN)',
  'POST /api/v1/api-keys': 'Create an API key (the full key is shown only in this response)',
  'PATCH /api/v1/api-keys/{id}/revoke': 'Revoke an API key (own keys, or any for SUPER_ADMIN)',
  'PATCH /api/v1/api-keys/{id}/gateway': 'Set a key\'s rate limit, expiry and the APIs it may call (SUPER_ADMIN)',
  'DELETE /api/v1/api-keys/{id}': 'Permanently delete an API key',
  'GET /api/v1/system-health': 'Live per-dependency status, latency and sampled availability',
  'GET /api/v1/system-health/alerts': 'Recent error/warning entries from the request log',
  'GET /api/v1/settings': 'Get platform settings',
  'PUT /api/v1/settings': 'Update platform settings',
  'GET /api/v1/docs/endpoints': 'This endpoint list, generated from the registered routes',
};

function getEndpoints() {
  // Required lazily: the routes import the docs controller, which imports this file.
  const apiRouter = require('../routes');
  const grouped = {};
  for (const route of listRoutes(apiRouter)) {
    const section = SECTION_NAMES[route.prefix] || route.prefix;
    (grouped[section] ||= []).push({
      method: route.method,
      path: route.path,
      desc: DESCRIPTIONS[`${route.method} ${route.path}`] || 'No description yet',
      auth: route.auth ? 'Bearer JWT' : 'Public',
      roles: route.roles || (route.auth ? 'Any signed-in role' : 'n/a'),
    });
  }
  return grouped;
}

module.exports = { getEndpoints, DESCRIPTIONS };
