const { pool } = require('../config/database');
const logService = require('./logService');
const { ApiError } = require('../utils/response');

const DAY_MS = 24 * 3600 * 1000;
const DEFAULT_RANGE_DAYS = 7;
const MAX_RANGE_DAYS = { hour: 7, day: 90 }; // keeps the number of chart points bounded

/**
 * Validates ?from=&to=&interval= . Defaults to the last 7 days, daily.
 * Dates are ISO strings; all bucketing is done in UTC.
 */
function parseRange({ from, to, interval, source } = {}) {
  if (source !== undefined && source !== '' && !['gateway', 'dashboard'].includes(source)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'source must be "gateway" or "dashboard"');
  }
  const resolvedInterval = interval || 'day';
  if (!MAX_RANGE_DAYS[resolvedInterval]) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'interval must be "hour" or "day"');
  }

  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);

  if (Number.isNaN(end.getTime()) || Number.isNaN(start.getTime())) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'from and to must be valid ISO dates');
  }
  if (start >= end) {
    throw new ApiError(400, 'VALIDATION_ERROR', '"from" must be earlier than "to"');
  }
  if (end - start > MAX_RANGE_DAYS[resolvedInterval] * DAY_MS) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      `Range too large for ${resolvedInterval} interval (max ${MAX_RANGE_DAYS[resolvedInterval]} days)`
    );
  }

  return { from: start, to: end, interval: resolvedInterval, ...(source ? { source } : {}) };
}

function metaFor(range, available) {
  return {
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    interval: range.interval,
    source: 'request_logs',
    ...(range.source ? { filter: range.source } : {}),
    available,
  };
}

async function countActiveApis() {
  // "Active" = registered APIs that are not in the Error state.
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM apis WHERE status <> 'Error'`);
  return rows[0].count;
}

async function getCards(query) {
  const range = parseRange(query);
  const [summary, activeApis] = await Promise.all([logService.getSummary(range), countActiveApis()]);

  const cards = [
    { label: 'Total Requests', value: summary.totalRequests },
    { label: 'Successful Requests', value: summary.successfulRequests },
    { label: 'Failed Requests', value: summary.failedRequests },
    { label: 'Error Rate', value: summary.errorRate },
    { label: 'Avg Response Time', value: summary.averageResponseTime },
    { label: 'Active APIs', value: activeApis },
  ];
  return { data: cards, meta: metaFor(range, summary.available) };
}

async function getTraffic(query) {
  const range = parseRange(query);
  const { available, series } = await logService.getTrafficSeries(range);
  return { data: series, meta: metaFor(range, available) };
}

async function getTopEndpoints(query) {
  const range = parseRange(query);
  const { available, items } = await logService.getTopEndpoints({ ...range, limit: 5 });
  return { data: items, meta: metaFor(range, available) };
}

async function getGatewayUsage(query) {
  const range = parseRange(query);
  const usage = await logService.getGatewayUsage(range);

  // Replace opaque key ids with the key's name (never its secret) for display.
  const ids = usage.byKey.map((k) => k.apiKeyId);
  const names = new Map();
  if (ids.length) {
    const { rows } = await pool.query(`SELECT id, name, key_preview FROM api_keys WHERE id = ANY($1::int[])`, [ids]);
    rows.forEach((r) => names.set(r.id, r));
  }
  const apiRows = usage.byApi.length
    ? (await pool.query(`SELECT gateway_slug, name FROM apis WHERE gateway_slug = ANY($1::text[])`, [usage.byApi.map((a) => a.apiSlug)])).rows
    : [];
  const apiNames = new Map(apiRows.map((r) => [r.gateway_slug, r.name]));

  return {
    data: {
      totals: usage.totals,
      byApi: usage.byApi.map((a) => ({ ...a, apiName: apiNames.get(a.apiSlug) || null })),
      byKey: usage.byKey.map((k) => ({
        ...k,
        keyName: names.has(k.apiKeyId) ? names.get(k.apiKeyId).name : `Deleted key #${k.apiKeyId}`,
        keyPreview: names.has(k.apiKeyId) ? names.get(k.apiKeyId).key_preview : null,
      })),
      byOutcome: usage.byOutcome,
    },
    meta: metaFor(range, usage.available),
  };
}

module.exports = { getCards, getTraffic, getTopEndpoints, getGatewayUsage, parseRange };
