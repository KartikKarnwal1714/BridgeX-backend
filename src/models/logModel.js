const { mongoose } = require('../config/mongo');

const logSchema = new mongoose.Schema(
  {
    timestamp: { type: Date, default: Date.now },
    correlationId: { type: String, index: true },
    method: { type: String },
    endpoint: { type: String },
    status: { type: Number },
    responseTime: { type: Number }, // milliseconds
    service: { type: String },
    error: { type: String, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },

    // Gateway fields (Phase 3). Older documents simply lack them; source defaults to 'dashboard'.
    source: { type: String, enum: ['dashboard', 'gateway'], default: 'dashboard' },
    apiId: { type: Number, default: null },
    apiSlug: { type: String, default: null },
    apiKeyId: { type: Number, default: null }, // numeric id only; secrets and hashes are never stored
    outcome: { type: String, default: null }, // success | upstream_error | rejected | rate_limited | gateway_error | client_aborted
    errorCategory: { type: String, default: null },
    upstreamStatus: { type: Number, default: null },
    upstreamTimeMs: { type: Number, default: null },
    requestBytes: { type: Number, default: null },
    responseBytes: { type: Number, default: null },
  },
  { collection: 'logs' }
);

// Retention: MongoDB deletes log documents automatically once they are older
// than LOG_RETENTION_DAYS (default 30), so the collection cannot grow forever.
const retentionDays = require('../config/env').LOG_RETENTION_DAYS;
logSchema.index({ source: 1, timestamp: -1 });
logSchema.index({ apiSlug: 1, timestamp: -1 });
logSchema.index({ apiKeyId: 1, timestamp: -1 });
logSchema.index({ timestamp: 1 }, { expireAfterSeconds: retentionDays * 24 * 60 * 60 });

module.exports = mongoose.models.Log || mongoose.model('Log', logSchema);
