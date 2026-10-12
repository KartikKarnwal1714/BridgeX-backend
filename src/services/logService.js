const Log = require('../models/logModel');
const { mongoose } = require('../config/mongo');
const { ApiError } = require('../utils/response');
const { isMongoConnected } = require('../config/mongo');
const logger = require('../utils/logger');

async function recordRequestLog({ correlationId, method, endpoint, status, responseTime, service, error = null, metadata = {}, extra = {} }) {
  if (!isMongoConnected()) {
    // Log persistence is best-effort; never block the response on it.
    return null;
  }

  try {
    return await Log.create({
      correlationId,
      method,
      endpoint,
      status,
      responseTime,
      service,
      error,
      metadata,
      ...extra,
    });
  } catch (err) {
    logger.warn('Failed to persist request log to MongoDB', { error: err.message });
    return null;
  }
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];
const MAX_PAGE_SIZE = 100;
const MAX_SEARCH_LENGTH = 100;

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds the MongoDB filter for the logs and analytics queries.
 * Every value is validated here, so route handlers can pass req.query straight in.
 */
function buildFilter({ q, method, status, from, to, source } = {}) {
  const filter = {};
  Object.assign(filter, sourceFilter(source));

  if (q) {
    // Escaped so user input is matched literally (no regex injection / ReDoS).
    const pattern = new RegExp(escapeRegex(String(q).slice(0, MAX_SEARCH_LENGTH)), 'i');
    filter.$or = [{ endpoint: pattern }, { service: pattern }, { correlationId: pattern }];
  }

  if (method) {
    const upper = String(method).toUpperCase();
    if (!METHODS.includes(upper)) {
      throw new ApiError(400, 'VALIDATION_ERROR', `method must be one of ${METHODS.join(', ')}`);
    }
    filter.method = upper;
  }

  if (status) {
    const value = String(status).toLowerCase();
    const classMatch = /^([1-5])xx$/.exec(value);
    if (classMatch) {
      const base = Number(classMatch[1]) * 100;
      filter.status = { $gte: base, $lt: base + 100 };
    } else if (/^[1-5]\d\d$/.test(value)) {
      filter.status = Number(value);
    } else {
      throw new ApiError(400, 'VALIDATION_ERROR', 'status must be a code like 404 or a class like 5xx');
    }
  }

  if (from || to) {
    filter.timestamp = {};
    if (from) filter.timestamp.$gte = parseDate(from, 'from');
    if (to) filter.timestamp.$lte = parseDate(to, 'to');
    if (from && to && filter.timestamp.$gte > filter.timestamp.$lte) {
      throw new ApiError(400, 'VALIDATION_ERROR', '"from" must be earlier than "to"');
    }
  }

  return filter;
}

// 'gateway' = traffic that passed through the API gateway; 'dashboard' = BridgeX's own management API
// (including log entries written before the gateway existed, which have no source field).
function sourceFilter(source) {
  if (!source) return {};
  if (source === 'gateway') return { source: 'gateway' };
  if (source === 'dashboard') return { source: { $ne: 'gateway' } };
  throw new ApiError(400, 'VALIDATION_ERROR', 'source must be "gateway" or "dashboard"');
}

function parseDate(value, name) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${name} must be a valid ISO date`);
  }
  return date;
}

function parsePositiveInt(value, name, fallback, max) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${name} must be a positive integer`);
  }
  return Math.min(n, max);
}

async function listLogs(query = {}) {
  const page = parsePositiveInt(query.page, 'page', 1, 1000000);
  const limit = parsePositiveInt(query.limit, 'limit', 50, MAX_PAGE_SIZE);
  const filter = buildFilter(query);

  if (!isMongoConnected()) {
    return { items: [], meta: { page, limit, total: 0, totalPages: 0, available: false } };
  }

  const [items, total] = await Promise.all([
    Log.find(filter)
      .sort({ timestamp: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select('-metadata -__v')
      .lean(),
    Log.countDocuments(filter),
  ]);

  return { items, meta: { page, limit, total, totalPages: Math.ceil(total / limit), available: true } };
}

async function getLog(id) {
  if (!isMongoConnected()) {
    throw new ApiError(503, 'LOG_STORE_UNAVAILABLE', 'The log store (MongoDB) is not connected');
  }
  if (!mongoose.isValidObjectId(id)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid log id');
  }
  const log = await Log.findById(id).select('-__v').lean();
  if (!log) throw new ApiError(404, 'NOT_FOUND', 'Log entry not found');
  return log;
}

// ---- Analytics aggregation (all computed inside MongoDB) -------------------
// Definitions used everywhere in BridgeX analytics:
//   request      = one finished HTTP request recorded in the request log
//   failed       = response status >= 400
//   successful   = response status < 400
//   error rate   = failed / total * 100 (0 when there are no requests)
//   avg latency  = mean responseTime in ms across the requests in range

function summariseTotals({ total = 0, failed = 0, responseTimeSum = 0 } = {}) {
  const successful = total - failed;
  return {
    totalRequests: total,
    successfulRequests: successful,
    failedRequests: failed,
    errorRate: total === 0 ? 0 : Number(((failed / total) * 100).toFixed(2)),
    averageResponseTime: total === 0 ? 0 : Math.round(responseTimeSum / total),
  };
}

async function getSummary({ from, to, source }) {
  if (!isMongoConnected()) return { available: false, ...summariseTotals() };

  const [row] = await Log.aggregate([
    { $match: { timestamp: { $gte: from, $lte: to }, ...sourceFilter(source) } },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        failed: { $sum: { $cond: [{ $gte: ['$status', 400] }, 1, 0] } },
        responseTimeSum: { $sum: { $ifNull: ['$responseTime', 0] } },
      },
    },
  ]);

  return { available: true, ...summariseTotals(row) };
}

const BUCKET_FORMATS = { hour: '%Y-%m-%dT%H:00:00.000Z', day: '%Y-%m-%dT00:00:00.000Z' };
const BUCKET_MS = { hour: 3600 * 1000, day: 24 * 3600 * 1000 };

function bucketStart(date, interval) {
  const ms = BUCKET_MS[interval];
  return new Date(Math.floor(date.getTime() / ms) * ms);
}

function bucketLabel(date, interval) {
  const day = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  if (interval === 'day') return day;
  const hour = String(date.getUTCHours()).padStart(2, '0');
  return `${day} ${hour}:00`;
}

/** Turns grouped rows into a continuous series; hours/days with no traffic are real zeros. */
function fillBuckets(rows, { from, to, interval }) {
  const byBucket = new Map(rows.map((r) => [r._id, r]));
  const series = [];
  const step = BUCKET_MS[interval];
  for (let t = bucketStart(from, interval).getTime(); t <= to.getTime(); t += step) {
    const start = new Date(t);
    const row = byBucket.get(start.toISOString());
    const requests = row ? row.requests : 0;
    const failed = row ? row.failed : 0;
    series.push({
      bucket: start.toISOString(),
      date: bucketLabel(start, interval),
      requests,
      failed,
      responses: requests - failed, // successful responses
    });
  }
  return series;
}

async function getTrafficSeries({ from, to, interval, source }) {
  if (!isMongoConnected()) return { available: false, series: [] };

  const rows = await Log.aggregate([
    { $match: { timestamp: { $gte: from, $lte: to }, ...sourceFilter(source) } },
    {
      $group: {
        _id: { $dateToString: { format: BUCKET_FORMATS[interval], date: '$timestamp', timezone: 'UTC' } },
        requests: { $sum: 1 },
        failed: { $sum: { $cond: [{ $gte: ['$status', 400] }, 1, 0] } },
      },
    },
  ]);

  return { available: true, series: fillBuckets(rows, { from, to, interval }) };
}

async function getTopEndpoints({ from, to, limit = 5, source }) {
  if (!isMongoConnected()) return { available: false, items: [] };

  const items = await Log.aggregate([
    { $match: { timestamp: { $gte: from, $lte: to }, ...sourceFilter(source) } },
    // Group by path only, so /users?page=1 and /users?page=2 count as one endpoint.
    { $group: { _id: { $arrayElemAt: [{ $split: ['$endpoint', '?'] }, 0] }, requests: { $sum: 1 } } },
    { $sort: { requests: -1 } },
    { $limit: limit },
    { $project: { _id: 0, endpoint: '$_id', requests: 1 } },
  ]);

  return { available: true, items };
}

async function getRecentAlerts(limit = 5) {
  if (!isMongoConnected()) return [];

  const errorLogs = await Log.find({ status: { $gte: 400 } })
    .sort({ timestamp: -1 })
    .limit(limit)
    .lean();

  return errorLogs.map((l) => ({
    level: l.status >= 500 ? 'error' : 'warning',
    message: `${l.method} ${l.endpoint} responded with ${l.status}`,
    time: l.timestamp,
  }));
}

// Gateway usage, computed in MongoDB from the same log documents as every other metric.
// Same definitions as the rest of Analytics: failed = status >= 400, error rate = failed / total.
// Extra gateway-only counters: rateLimited (outcome rate_limited), rejected (refused before forwarding),
// upstreamErrors (outcome upstream_error or gateway_error: the upstream answered 4xx/5xx or could not be reached).
async function getGatewayUsage({ from, to }) {
  if (!isMongoConnected()) return { available: false, totals: summariseGateway(), byApi: [], byKey: [], byOutcome: [] };

  const counters = {
    requests: { $sum: 1 },
    failed: { $sum: { $cond: [{ $gte: ['$status', 400] }, 1, 0] } },
    rateLimited: { $sum: { $cond: [{ $eq: ['$outcome', 'rate_limited'] }, 1, 0] } },
    rejected: { $sum: { $cond: [{ $eq: ['$outcome', 'rejected'] }, 1, 0] } },
    upstreamErrors: { $sum: { $cond: [{ $in: ['$outcome', ['upstream_error', 'gateway_error']] }, 1, 0] } },
    responseTimeSum: { $sum: { $ifNull: ['$responseTime', 0] } },
  };

  const [row] = await Log.aggregate([
    { $match: { source: 'gateway', timestamp: { $gte: from, $lte: to } } },
    {
      $facet: {
        totals: [{ $group: { _id: null, ...counters } }],
        byApi: [
          { $match: { apiSlug: { $ne: null } } },
          { $group: { _id: '$apiSlug', ...counters } },
          { $sort: { requests: -1 } },
          { $limit: 50 },
        ],
        byKey: [
          { $match: { apiKeyId: { $ne: null } } },
          { $group: { _id: '$apiKeyId', ...counters } },
          { $sort: { requests: -1 } },
          { $limit: 50 },
        ],
        byOutcome: [{ $group: { _id: '$outcome', requests: { $sum: 1 } } }, { $sort: { requests: -1 } }],
      },
    },
  ]);

  const shape = (r) => ({
    requests: r.requests,
    failed: r.failed,
    successful: r.requests - r.failed,
    errorRate: r.requests === 0 ? 0 : Number(((r.failed / r.requests) * 100).toFixed(2)),
    averageResponseTime: r.requests === 0 ? 0 : Math.round(r.responseTimeSum / r.requests),
    rateLimited: r.rateLimited,
    rejected: r.rejected,
    upstreamErrors: r.upstreamErrors,
  });

  return {
    available: true,
    totals: summariseGateway(row && row.totals[0] ? shape(row.totals[0]) : undefined),
    byApi: ((row && row.byApi) || []).map((r) => ({ apiSlug: r._id, ...shape(r) })),
    byKey: ((row && row.byKey) || []).map((r) => ({ apiKeyId: r._id, ...shape(r) })),
    byOutcome: ((row && row.byOutcome) || []).map((r) => ({ outcome: r._id || 'unknown', requests: r.requests })),
  };
}

function summariseGateway(shaped) {
  return shaped || {
    requests: 0, failed: 0, successful: 0, errorRate: 0, averageResponseTime: 0, rateLimited: 0, rejected: 0, upstreamErrors: 0,
  };
}

module.exports = {
  recordRequestLog,
  getGatewayUsage,
  listLogs,
  getLog,
  getSummary,
  getTrafficSeries,
  getTopEndpoints,
  getRecentAlerts,
  // exported for unit tests
  buildFilter,
  summariseTotals,
  fillBuckets,
};
