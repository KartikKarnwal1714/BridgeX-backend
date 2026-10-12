// Pure unit tests: no database, network (except local DNS for "localhost") or MongoDB needed.
const { spawnSync } = require('child_process');
const path = require('path');
const { validateUpstreamUrl, guardedLookup, isBlockedAddress } = require('../src/utils/ssrf');
const { buildUpstreamPath, PathError } = require('../src/gateway/path');
const { buildUpstreamHeaders, filterResponseHeaders } = require('../src/gateway/headers');
const { encrypt, decrypt } = require('../src/utils/secretBox');
const rateLimiter = require('../src/gateway/rateLimiter');

describe('SSRF: address classification', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe',
  ])('blocks %s', (ip) => expect(isBlockedAddress(ip)).toBe(true));

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows public %s', (ip) =>
    expect(isBlockedAddress(ip)).toBe(false));

  it('treats anything that is not an IP as blocked', () => expect(isBlockedAddress('not-an-ip')).toBe(true));
});

describe('SSRF: guarded DNS lookup (defence against DNS rebinding)', () => {
  const lookup = (host, allowPrivate) => new Promise((resolve) => guardedLookup(allowPrivate)(host, {}, (err, addr) => resolve({ err, addr })));

  it('refuses a name that resolves to loopback, and connects only to what it checked', async () => {
    const { err } = await lookup('localhost', false);
    expect(err).toBeTruthy();
    expect(err.code).toBe('EBLOCKEDADDRESS');
  });

  it('supports the all:true form used by Node\'s happy-eyeballs connect', async () => {
    const result = await new Promise((resolve) => guardedLookup(false)('localhost', { all: true }, (err) => resolve(err)));
    expect(result.code).toBe('EBLOCKEDADDRESS');
  });

  it('only a dev-allow-listed upstream may resolve to a private address', async () => {
    const { err, addr } = await lookup('localhost', true);
    expect(err).toBeNull();
    expect(['127.0.0.1', '::1']).toContain(addr);
  });
});

describe('SSRF: URL validation', () => {
  it('ignores the dev allow-list entirely in production, and refuses to start with it set', () => {
    const script = "require('./src/config/env')";
    const run = (env) => spawnSync(process.execPath, ['-e', script], {
      cwd: path.resolve(__dirname, '..'),
      env: { PATH: process.env.PATH, JWT_SECRET: 'x'.repeat(40), ...env },
      encoding: 'utf8',
    });
    const withBypass = run({ NODE_ENV: 'production', GATEWAY_ENCRYPTION_KEY: 'a'.repeat(64), GATEWAY_DEV_ALLOWED_UPSTREAMS: '127.0.0.1:9999' });
    expect(withBypass.status).not.toBe(0);
    expect(withBypass.stderr).toMatch(/GATEWAY_DEV_ALLOWED_UPSTREAMS must not be set in production/);

    const noKey = run({ NODE_ENV: 'production' });
    expect(noKey.stderr).toMatch(/GATEWAY_ENCRYPTION_KEY must be set in production/);

    const ok = run({ NODE_ENV: 'production', GATEWAY_ENCRYPTION_KEY: 'a'.repeat(64) });
    expect(ok.status).toBe(0);
  });

  it('requires https in production', () => {
    const script = `
      const { validateUpstreamUrl } = require('./src/utils/ssrf');
      try { validateUpstreamUrl('http://api.example.com'); console.log('ACCEPTED'); } catch (e) { console.log('REJECTED ' + e.details[0].message); }
      console.log(validateUpstreamUrl('https://api.example.com/v1/').normalized);`;
    const out = spawnSync(process.execPath, ['-e', script], {
      cwd: path.resolve(__dirname, '..'),
      env: { PATH: process.env.PATH, NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40), GATEWAY_ENCRYPTION_KEY: 'b'.repeat(64) },
      encoding: 'utf8',
    });
    expect(out.stdout).toMatch(/REJECTED must use https/);
    expect(out.stdout).toMatch(/https:\/\/api\.example\.com\/v1/);
  });

  it('normalises trailing slashes and rejects query strings / fragments', () => {
    expect(validateUpstreamUrl('https://api.example.com/v1///').normalized).toBe('https://api.example.com/v1');
    expect(() => validateUpstreamUrl('https://api.example.com/v1?x=1')).toThrow();
    expect(() => validateUpstreamUrl('https://api.example.com/v1#frag')).toThrow();
  });
});

describe('upstream path construction', () => {
  const build = (url, base = 'https://api.example.com/v2') => buildUpstreamPath(url, base).upstreamPath;

  it('joins base path + remainder + raw query without double prefixes or slashes', () => {
    expect(build('/gateway/orders')).toBe('/v2');
    expect(build('/gateway/orders/')).toBe('/v2/');
    expect(build('/gateway/orders/items/42?a=1&b=%20')).toBe('/v2/items/42?a=1&b=%20');
    expect(build('/gateway/orders//items///42')).toBe('/v2/items/42'); // empty segments collapse
    expect(build('/gateway/orders/items', 'https://api.example.com')).toBe('/items');
    expect(build('/gateway/orders/items', 'https://api.example.com/')).toBe('/items');
    expect(build('/gateway/orders/x', 'https://api.example.com/a/b/')).toBe('/a/b/x');
  });

  it('keeps percent-encoding byte-for-byte (including encoded unicode)', () => {
    expect(build('/gateway/o/caf%C3%A9/%E2%9C%93?q=%F0%9F%98%80')).toBe('/v2/caf%C3%A9/%E2%9C%93?q=%F0%9F%98%80');
  });

  it('cannot be redirected to another host', () => {
    // These look like authorities/absolute URLs but are just path text appended to the configured base.
    expect(build('/gateway/o//evil.com/x')).toBe('/v2/evil.com/x');
    expect(build('/gateway/o/@evil.com')).toBe('/v2/@evil.com');
    expect(build('/gateway/o/http://evil.com')).toBe('/v2/http:/evil.com');
  });

  it.each([
    '/gateway/o/..', '/gateway/o/../x', '/gateway/o/a/%2e%2e/b', '/gateway/o/%2E%2E', '/gateway/o/.', '/gateway/o/a%2Fb', '/gateway/o/a%5Cb',
    '/gateway/o/a\\b', '/gateway/o/%00', '/gateway/o/%0d%0a', '/gateway/o/%zz', '/gateway/o/a b', '/gateway/o/a\tb',
  ])('rejects %j', (url) => {
    expect(() => build(url)).toThrow(PathError);
  });

  it('rejects very long URLs with 414', () => {
    try { build(`/gateway/o/${'a'.repeat(9000)}`); } catch (e) { expect(e.status).toBe(414); return; }
    throw new Error('expected rejection');
  });
});

describe('header policy', () => {
  it('forwards only allow-listed request headers and always sets its own identity headers', () => {
    const h = buildUpstreamHeaders(
      { accept: 'application/json', cookie: 'a=b', authorization: 'Bearer gw', 'x-api-key': 'k', host: 'evil', 'x-forwarded-for': '1.2.3.4', connection: 'keep-alive', 'x-extra': 'v', 'content-type': 'text/plain', 'content-length': '5' },
      ['x-extra', 'cookie', 'authorization'], // administrators cannot approve credentials/cookies
      'req-1',
      null
    );
    expect(h).toEqual({ accept: 'application/json', 'content-type': 'text/plain', 'content-length': '5', 'x-extra': 'v', 'x-request-id': 'req-1', 'x-forwarded-by': 'BridgeX' });
  });

  it('ignores a non-numeric content-length and any transfer-encoding conflict', () => {
    expect(buildUpstreamHeaders({ 'content-length': '5, 5' }, [], 'r', null)['content-length']).toBeUndefined();
    expect(buildUpstreamHeaders({ 'content-length': '5', 'transfer-encoding': 'chunked' }, [], 'r', null)['content-length']).toBeUndefined();
  });

  it('injects the upstream credential last, overriding anything the client sent', () => {
    const h = buildUpstreamHeaders({ authorization: 'Bearer client' }, [], 'r', { name: 'authorization', value: 'Bearer upstream' });
    expect(h.authorization).toBe('Bearer upstream');
  });

  it('strips hop-by-hop, cookie and server-identifying response headers', () => {
    const out = filterResponseHeaders({
      'Content-Type': 'application/json', Connection: 'close', 'Transfer-Encoding': 'chunked', 'Set-Cookie': ['a=b'], Server: 'nginx',
      'X-Powered-By': 'PHP', 'X-RateLimit-Remaining': '5', 'X-BridgeX-Error': 'true', ETag: '"1"',
    });
    expect(out).toEqual({ 'content-type': 'application/json', etag: '"1"' });
  });
});

describe('credential encryption', () => {
  it('round-trips, uses a fresh IV each time, and detects tampering', () => {
    const a = encrypt('s3cret!');
    const b = encrypt('s3cret!');
    expect(a).not.toBe(b);
    expect(a).not.toContain('s3cret');
    expect(decrypt(a)).toBe('s3cret!');
    const parts = a.split(':');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => decrypt(parts.join(':'))).toThrow();
    expect(() => decrypt('garbage')).toThrow();
  });
});

describe('in-memory rate limiter (fallback store)', () => {
  beforeEach(() => rateLimiter._resetMemoryForTests());

  it('counts per identity and reports remaining / reset', async () => {
    const results = [];
    for (let i = 0; i < 4; i += 1) results.push(await rateLimiter.consume('key:unit', 3));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0]);
    expect(results[0].store).toBe('memory');
    expect(results[0].resetSeconds).toBeGreaterThan(0);
  });

  it('starts a fresh window after the reset time', async () => {
    const now = Date.now();
    await rateLimiter.consume('key:win', 1);
    expect((await rateLimiter.consume('key:win', 1)).allowed).toBe(false);
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now + 61000);
    try {
      expect((await rateLimiter.consume('key:win', 1)).allowed).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps memory bounded', async () => {
    for (let i = 0; i < rateLimiter.MAX_MEMORY_ENTRIES + 500; i += 1) await rateLimiter.consume(`key:bulk${i}`, 5);
    // The most recent identities are still tracked, and the oldest were evicted rather than growing forever.
    expect((await rateLimiter.consume(`key:bulk${rateLimiter.MAX_MEMORY_ENTRIES + 499}`, 5)).remaining).toBe(3);
    expect((await rateLimiter.consume('key:bulk0', 5)).remaining).toBe(4); // evicted → counts as new
  });
});
