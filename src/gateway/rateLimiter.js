// Fixed-window rate limiter keyed by identity (an API key id, or an IP for failed logins).
//   * Redis (shared by every BridgeX instance): one Lua script does INCR + expiry atomically and uses
//     Redis's own clock, so concurrent requests cannot slip past the limit and instances agree.
//   * If Redis is down, a bounded in-memory store takes over so limits are still enforced per instance.
// A fixed window allows a burst of up to 2x the limit across a window boundary — documented trade-off.
const env = require('../config/env');
const { redisClient, isRedisConnected } = require('../config/redis');
const logger = require('../utils/logger');

const MAX_MEMORY_ENTRIES = 10000;
const memory = new Map(); // identity -> { count, windowStart }
let lastFallbackWarning = 0;

const SCRIPT = `
local t = redis.call('TIME')
local nowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local window = tonumber(ARGV[1])
local key = KEYS[1] .. ':' .. math.floor(nowMs / window)
local count = redis.call('INCR', key)
if count == 1 then redis.call('PEXPIRE', key, window * 2) end
return { count, window - (nowMs % window) }
`;

function sweep(now, windowMs) {
  for (const [id, entry] of memory) {
    if (now - entry.windowStart >= windowMs) memory.delete(id);
  }
}

function consumeMemory(identity, windowMs) {
  const now = Date.now();
  if (memory.size >= MAX_MEMORY_ENTRIES) {
    sweep(now, windowMs);
    // Still full of live entries: drop the oldest so memory stays bounded.
    while (memory.size >= MAX_MEMORY_ENTRIES) memory.delete(memory.keys().next().value);
  }
  const windowStart = Math.floor(now / windowMs) * windowMs;
  let entry = memory.get(identity);
  if (!entry || entry.windowStart !== windowStart) {
    entry = { count: 0, windowStart };
    memory.delete(identity); // re-insert so Map order tracks recency
    memory.set(identity, entry);
  }
  entry.count += 1;
  return { count: entry.count, resetMs: windowStart + windowMs - now, store: 'memory' };
}

async function consumeRedis(identity, windowMs) {
  const [count, resetMs] = await redisClient.eval(SCRIPT, { keys: [`bx:rl:${identity}`], arguments: [String(windowMs)] });
  return { count: Number(count), resetMs: Number(resetMs), store: 'redis' };
}

/**
 * Counts one request against `identity`.
 * @returns {{allowed:boolean, limit:number, remaining:number, resetSeconds:number, store:string}}
 */
async function consume(identity, limit) {
  const windowMs = env.GATEWAY_RATE_WINDOW_MS;
  let result;
  if (isRedisConnected()) {
    try {
      result = await consumeRedis(identity, windowMs);
    } catch (err) {
      const now = Date.now();
      if (now - lastFallbackWarning > 30000) {
        lastFallbackWarning = now;
        logger.warn('Redis rate limiter failed, using in-memory fallback', { error: err.message });
      }
    }
  }
  if (!result) result = consumeMemory(identity, windowMs);

  return {
    allowed: result.count <= limit,
    limit,
    remaining: Math.max(0, limit - result.count),
    resetSeconds: Math.max(1, Math.ceil(result.resetMs / 1000)),
    store: result.store,
  };
}

function _resetMemoryForTests() {
  memory.clear();
}

module.exports = { consume, _resetMemoryForTests, MAX_MEMORY_ENTRIES };
