const app = require('./app');
const env = require('./config/env');
const logger = require('./utils/logger');
const { connectPostgres } = require('./config/database');
const { connectMongo } = require('./config/mongo');
const { connectRedis } = require('./config/redis');

async function start() {
  // Postgres is required — the API cannot function without it.
  await connectPostgres();

  // Mongo and Redis degrade gracefully (see their config modules) so a
  // missing log store or cache never takes the whole API down.
  await connectMongo();
  await connectRedis();

  app.listen(env.PORT, () => {
    logger.info(`BridgeX API listening on port ${env.PORT}`, {
      env: env.NODE_ENV,
      docs: `http://localhost:${env.PORT}/api-docs`,
    });
  });
}

start().catch((err) => {
  logger.error('Failed to start BridgeX API', { error: err.message });
  process.exit(1);
});
