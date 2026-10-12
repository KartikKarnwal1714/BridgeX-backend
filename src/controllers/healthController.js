const { pool } = require('../config/database');
const { isMongoConnected } = require('../config/mongo');
const { isRedisConnected } = require('../config/redis');
const { success, ApiError } = require('../utils/response');
const healthMonitor = require('../services/healthMonitor');

const VERSION = '1.0.0';

async function health(req, res) {
  const check = await healthMonitor.timed(() => pool.query('SELECT 1'));
  const postgres = check.ok ? 'healthy' : 'unhealthy';

  const data = {
    status: postgres === 'healthy' ? 'healthy' : 'degraded',
    service: 'BridgeX API',
    timestamp: new Date().toISOString(),
    version: VERSION,
    dependencies: {
      postgres,
      mongo: isMongoConnected() ? 'healthy' : 'unavailable',
      redis: isRedisConnected() ? 'healthy' : 'unavailable',
    },
  };

  return success(res, data);
}

// Liveness: "is the process up?" — deliberately checks nothing else, so a
// database outage does not make an orchestrator restart a working process.
function live(req, res) {
  return success(res, { status: 'alive', uptimeSeconds: Math.round(process.uptime()) });
}

// Readiness: "can this instance serve real traffic?" — requires PostgreSQL.
// MongoDB and Redis are optional and do not affect readiness.
async function ready(req, res, next) {
  const check = await healthMonitor.timed(() => pool.query('SELECT 1'));
  if (!check.ok) {
    return next(new ApiError(503, 'NOT_READY', 'Database is not reachable'));
  }
  return success(res, { status: 'ready' });
}

module.exports = { health, live, ready };
