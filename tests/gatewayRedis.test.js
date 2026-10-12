// Rate limiter against a REAL Redis. Skipped (and reported as skipped) when no Redis is reachable,
// e.g. `docker compose up -d redis` was not run.
const { spawnSync } = require('child_process');

const redisUp = spawnSync(process.execPath, ['-e',
  "const s=require('net').connect(6379,'127.0.0.1');s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1));"], { timeout: 3000 }).status === 0;
const maybe = redisUp ? describe : describe.skip;

process.env.GATEWAY_RATE_WINDOW_MS = '1000'; // shortest allowed window so we can observe a real reset

const { connectRedis, redisClient } = require('../src/config/redis');
const rateLimiter = require('../src/gateway/rateLimiter');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const id = () => `key:test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

maybe('rate limiter on Redis', () => {
  beforeAll(connectRedis);
  afterAll(async () => { if (redisClient.isOpen) await redisClient.quit(); });

  it('uses Redis, enforces the limit and resets after the window', async () => {
    const k = id();
    const first = await rateLimiter.consume(k, 2);
    expect(first.store).toBe('redis');
    expect((await rateLimiter.consume(k, 2)).allowed).toBe(true);
    expect((await rateLimiter.consume(k, 2)).allowed).toBe(false);
    await sleep(1100);
    const after = await rateLimiter.consume(k, 2);
    expect(after.allowed).toBe(true);
    expect(after.remaining).toBe(1);
  });

  it('is atomic: 60 concurrent requests against a limit of 20 admit exactly 20', async () => {
    const k = id();
    // retry in the unlikely case the 1s window rolls over mid-burst
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const key = `${k}-${attempt}`;
      const t0 = Date.now() % 1000;
      if (t0 > 600) { await sleep(1000 - t0 + 20); }
      const results = await Promise.all(Array.from({ length: 60 }, () => rateLimiter.consume(key, 20)));
      const allowed = results.filter((r) => r.allowed).length;
      if (results.every((r) => r.store === 'redis')) { expect(allowed).toBe(20); return; }
    }
    throw new Error('Redis store was not used');
  });

  it('shares counts between callers (what makes limits consistent across instances)', async () => {
    const k = id();
    await rateLimiter.consume(k, 5);
    const viaRaw = await redisClient.keys(`bx:rl:${k}:*`);
    expect(viaRaw).toHaveLength(1);
    expect(Number(await redisClient.get(viaRaw[0]))).toBe(1);
    expect(await redisClient.pTTL(viaRaw[0])).toBeGreaterThan(0); // keys always expire — Redis memory stays bounded
  });
});
