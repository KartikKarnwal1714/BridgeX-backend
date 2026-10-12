const { authenticate } = require('../middleware/auth');

/**
 * Lists every real route registered under /api/v1 by walking the Express
 * router stacks, together with whether it needs a login and which roles
 * are allowed. Used to generate the Documentation page and to test that
 * the docs never drift from the code.
 *
 * Returns: [{ method: 'GET', path: '/api/v1/users/{id}', prefix: '/users',
 *             auth: true, roles: ['SUPER_ADMIN'] | null }]
 */
function listRoutes(apiRouter, basePath = '/api/v1') {
  const out = [];

  for (const [prefix, subRouter] of apiRouter.mounts) {
    let authRequired = false;
    let routerRoles = null;

    for (const layer of subRouter.stack) {
      if (!layer.route) {
        // router.use(...) middleware that applies to every route below it
        if (layer.handle === authenticate) authRequired = true;
        if (layer.handle.allowedRoles) routerRoles = layer.handle.allowedRoles;
        continue;
      }

      const routePath = layer.route.path === '/' ? '' : layer.route.path;
      const routeRoles = layer.route.stack
        .map((l) => l.handle)
        .filter((h) => h.allowedRoles)
        .flatMap((h) => h.allowedRoles);
      const routeAuth =
        authRequired || layer.route.stack.some((l) => l.handle === authenticate);

      for (const method of Object.keys(layer.route.methods)) {
        out.push({
          method: method.toUpperCase(),
          path: `${basePath}${prefix}${routePath}`.replace(/:([A-Za-z0-9_]+)/g, '{$1}'),
          prefix,
          auth: routeAuth,
          roles: routeRoles.length ? routeRoles : routerRoles,
        });
      }
    }
  }

  return out;
}

module.exports = { listRoutes };
