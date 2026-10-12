// SSRF protection for the gateway. Two layers:
//   1. validateUpstreamUrl()  — static checks when an upstream is configured and again on every request.
//   2. guardedLookup()        — runs at connection time: DNS answers are checked and the connection is made
//                               to the very address that was checked, which defeats DNS rebinding.
const net = require('net');
const dns = require('dns');
const env = require('../config/env');
const { ApiError } = require('./response');

const blocked = new net.BlockList();
[
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].forEach(([net_, prefix]) => blocked.addSubnet(net_, prefix, 'ipv4'));
[
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['64:ff9b::', 96],
].forEach(([net_, prefix]) => blocked.addSubnet(net_, prefix, 'ipv6'));

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.lan', '.home.arpa'];
const BLOCKED_HOSTS = new Set(['localhost', 'metadata', 'metadata.google.internal', 'instance-data']);
const SELF_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

function stripBrackets(host) {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function isBlockedAddress(address) {
  const family = net.isIP(address);
  if (family === 0) return true; // not an IP at all — refuse rather than guess
  // BlockList also evaluates IPv4-mapped IPv6 (::ffff:127.0.0.1) against the IPv4 rules.
  return blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

function portOf(url) {
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

function hostPortKey(url) {
  const host = stripBrackets(url.hostname.toLowerCase());
  return `${host}:${portOf(url)}`;
}

function isDevAllowed(url) {
  return env.devAllowedUpstreams().includes(hostPortKey(url));
}

function isSelf(url) {
  return SELF_HOSTS.has(stripBrackets(url.hostname.toLowerCase())) && portOf(url) === env.PORT;
}

function reject(message) {
  return new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', [{ field: '/base_url', message }]);
}

/**
 * Validates an upstream base URL and returns { url, normalized, devAllowed }.
 * Throws ApiError(400) when the URL is unsafe or malformed.
 */
function validateUpstreamUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw reject('must be an absolute URL such as https://api.example.com');
  }

  const production = env.NODE_ENV === 'production';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !production)) {
    throw reject(production ? 'must use https://' : 'must use http:// or https://');
  }
  if (url.username || url.password) throw reject('must not contain credentials');
  if (url.search || url.hash) throw reject('must not contain a query string or fragment');
  if (!url.hostname) throw reject('must include a host name');

  const host = stripBrackets(url.hostname.toLowerCase());
  if (isSelf(url)) throw reject('must not point at the BridgeX server itself');

  if (isDevAllowed(url)) {
    return { url, devAllowed: true, normalized: normalize(url) };
  }

  if (BLOCKED_HOSTS.has(host) || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw reject('points at an internal or local host name, which is not permitted');
  }
  if (net.isIP(host) && isBlockedAddress(host)) {
    throw reject('points at a private, loopback, link-local or reserved address, which is not permitted');
  }
  if (!net.isIP(host) && !host.includes('.')) {
    throw reject('must be a fully qualified domain name');
  }

  return { url, devAllowed: false, normalized: normalize(url) };
}

function normalize(url) {
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * Drop-in replacement for dns.lookup used by the upstream connection. Every address the name
 * resolves to must be public, and the connection is made to the address returned here.
 */
function guardedLookup(allowPrivate) {
  return function lookup(hostname, options, callback) {
    const opts = typeof options === 'object' && options ? options : { family: options };
    dns.lookup(hostname, { ...opts, all: true, verbatim: true }, (err, addresses) => {
      if (err) return callback(err);
      if (!allowPrivate && addresses.some((a) => isBlockedAddress(a.address))) {
        const e = new Error('Upstream resolved to a non-public address');
        e.code = 'EBLOCKEDADDRESS';
        return callback(e);
      }
      if (opts.all) return callback(null, addresses);
      return callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

module.exports = { validateUpstreamUrl, guardedLookup, isBlockedAddress, isDevAllowed, portOf };
