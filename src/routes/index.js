const express = require('express');

const healthRoutes = require('./healthRoutes');
const authRoutes = require('./authRoutes');
const userRoutes = require('./userRoutes');
const apiRoutes = require('./apiRoutes');
const integrationRoutes = require('./integrationRoutes');
const dashboardRoutes = require('./dashboardRoutes');
const logRoutes = require('./logRoutes');
const analyticsRoutes = require('./analyticsRoutes');
const apiKeyRoutes = require('./apiKeyRoutes');
const systemHealthRoutes = require('./systemHealthRoutes');
const settingsRoutes = require('./settingsRoutes');
const docsRoutes = require('./docsRoutes');

const router = express.Router();

// Single source of truth for URL prefixes. The generated API documentation
// reads this table, so adding a router here documents it automatically.
const MOUNTS = [
  ['/health', healthRoutes],
  ['/auth', authRoutes],
  ['/users', userRoutes],
  ['/apis', apiRoutes],
  ['/integrations', integrationRoutes],
  ['/dashboard', dashboardRoutes],
  ['/logs', logRoutes],
  ['/analytics', analyticsRoutes],
  ['/api-keys', apiKeyRoutes],
  ['/system-health', systemHealthRoutes],
  ['/settings', settingsRoutes],
  ['/docs', docsRoutes],
];

MOUNTS.forEach(([prefix, subRouter]) => router.use(prefix, subRouter));

router.mounts = MOUNTS;

module.exports = router;
