const { pool } = require('../config/database');
const { mongoose, isMongoConnected } = require('../config/mongo');
const { redisClient, isRedisConnected } = require('../config/redis');
const logService = require('./logService');
const healthMonitor = require('./healthMonitor');

// A failed REQUIRED component is an "Error". A failed OPTIONAL component
// (the API keeps working without it) is only "Degraded", so a missing Mongo
// or Redis never looks like a total outage.
async function checkComponent({ name, required, ping, optionalNote }) {
  const { ok, ms } = await healthMonitor.timed(ping);
  healthMonitor.record(name, ok);

  const status = ok ? 'Healthy' : required ? 'Error' : 'Degraded';
  const component = {
    name,
    status,
    required,
    // Share of checks that succeeded since this server process started (last 100 checks).
    uptime: healthMonitor.uptimePercent(name) ?? (ok ? 100 : 0),
    response: `${ms}ms`,
    lastChecked: new Date().toISOString(),
  };
  if (!ok && !required) component.detail = optionalNote;
  return component;
}

async function getSystemHealth() {
  return Promise.all([
    checkComponent({ name: 'API Gateway', required: true, ping: async () => true }), // this request being served IS the check
    checkComponent({ name: 'Database (PostgreSQL)', required: true, ping: () => pool.query('SELECT 1') }),
    checkComponent({
      name: 'MongoDB',
      required: false,
      optionalNote: 'Optional: request logs and analytics are unavailable while MongoDB is down',
      ping: async () => {
        if (!isMongoConnected()) throw new Error('not connected');
        await mongoose.connection.db.admin().ping();
      },
    }),
    checkComponent({
      name: 'Redis Cache',
      required: false,
      optionalNote: 'Optional: gateway rate limits fall back to per-instance memory while Redis is down',
      ping: async () => {
        if (!isRedisConnected()) throw new Error('not connected');
        await redisClient.ping();
      },
    }),
  ]);
}

async function getRecentAlerts() {
  return logService.getRecentAlerts(5);
}

module.exports = { getSystemHealth, getRecentAlerts };
