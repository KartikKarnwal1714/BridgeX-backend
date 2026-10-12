const { pool } = require('../config/database');
const { isMongoConnected } = require('../config/mongo');
const { isRedisConnected } = require('../config/redis');
const logService = require('./logService');

async function getStats() {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)::int AS total_apis,
      COALESCE(SUM(request_count), 0)::bigint AS total_requests,
      COALESCE(AVG(success_rate), 0)::numeric(5,2) AS success_rate,
      COALESCE(AVG(average_response_time), 0)::int AS average_response_time
    FROM apis
  `);

  const row = rows[0];
  const successRate = Number(row.success_rate);

  return {
    totalApis: row.total_apis,
    totalRequests: Number(row.total_requests),
    successRate,
    averageResponseTime: row.average_response_time,
    failedRequests: Number((100 - successRate).toFixed(2)),
  };
}

/**
 * Last 7 days of real request traffic, aggregated from the request log.
 * Returns an empty list (not made-up numbers) when the log store is
 * unavailable or no requests have been recorded yet.
 */
async function getTrafficOverview() {
  const to = new Date();
  const from = new Date(to.getTime() - 6 * 24 * 3600 * 1000);
  const { series } = await logService.getTrafficSeries({ from, to, interval: 'day' });
  return series.map(({ date, requests, responses }) => ({ date, requests, responses }));
}

async function getProtocolDistribution() {
  const { rows } = await pool.query(`
    SELECT protocol, COUNT(*)::int AS count
    FROM apis
    GROUP BY protocol
  `);

  const total = rows.reduce((sum, r) => sum + r.count, 0) || 1;
  const colors = { REST: '#7C5CFC', GRAPHQL: '#22C55E', SOAP: '#3B82F6' };

  return rows.map((r) => ({
    name: r.protocol,
    count: r.count,
    value: Number(((r.count / total) * 100).toFixed(1)),
    color: colors[r.protocol] || '#94A3B8',
  }));
}

async function getTopApis(limit = 5) {
  const { rows } = await pool.query(
    `SELECT id, name, protocol, request_count AS requests, success_rate, average_response_time, status
     FROM apis
     ORDER BY request_count DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

async function getSystemStatus() {
  return [
    { name: 'API Gateway', status: 'Healthy' },
    { name: 'PostgreSQL', status: 'Healthy' }, // this endpoint only runs if PG is up
    { name: 'MongoDB', status: isMongoConnected() ? 'Healthy' : 'Degraded' },
    { name: 'Redis Cache', status: isRedisConnected() ? 'Healthy' : 'Degraded' },
  ];
}

module.exports = {
  getStats,
  getTrafficOverview,
  getProtocolDistribution,
  getTopApis,
  getSystemStatus,
};
