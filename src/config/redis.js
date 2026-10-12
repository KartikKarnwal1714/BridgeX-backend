const { createClient } = require('redis');
const env = require('./env');
const logger = require('../utils/logger');

const MAX_RECONNECT_ATTEMPTS = 3;
let loggedGiveUp = false;

const redisClient = createClient({
  url: env.REDIS_URL,
  socket: {
    connectTimeout: 3000,
    // Give up after a few tries instead of retrying forever — this is what
    // let the server hang indefinitely at startup when Redis was down.
    reconnectStrategy(retries) {
      if (retries >= MAX_RECONNECT_ATTEMPTS) {
        if (!loggedGiveUp) {
          loggedGiveUp = true;
          logger.warn('Redis unreachable after retries, giving up reconnect attempts', {
            attempts: retries,
          });
        }
        return false; // stop retrying
      }
      return Math.min(retries * 200, 1000);
    },
  },
});

redisClient.on('error', (err) => {
  logger.warn('Redis client error', { error: err.message });
});

let isConnected = false;

redisClient.on('ready', () => {
  isConnected = true;
});
redisClient.on('end', () => {
  isConnected = false;
});

async function connectRedis() {
  try {
    // Never let a missing/unreachable Redis block server startup.
    await Promise.race([
      redisClient.connect(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Redis connect timed out')), 3500)
      ),
    ]);
    isConnected = true;
    logger.info('Redis connected');
  } catch (err) {
    isConnected = false;
    // Redis backs caching/rate-limiting in a later phase — not required
    // for the API to function today, so we degrade gracefully.
    logger.warn('Redis connection failed, continuing without cache layer', {
      error: err.message,
    });
  }
}

function isRedisConnected() {
  return isConnected;
}

module.exports = { redisClient, connectRedis, isRedisConnected };
