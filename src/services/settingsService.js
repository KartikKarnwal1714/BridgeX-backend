const settingsModel = require('../models/settingsModel');
const env = require('../config/env');
const { JWT_EXPIRY_OPTIONS } = require('../schemas/settingsSchemas');

async function getSettings() {
  const row = await settingsModel.get();
  return row ? { ...row.data, updatedAt: row.updated_at } : {};
}

async function updateSettings(patch) {
  const row = await settingsModel.update(patch);
  return { ...row.data, updatedAt: row.updated_at };
}

/**
 * The "JWT expiry" setting is the one security setting that is actually
 * enforced: new logins get a token that lasts this long. Falls back to the
 * JWT_EXPIRES_IN environment value if the setting is missing or unreadable.
 */
async function getJwtLifetime() {
  try {
    const row = await settingsModel.get();
    const mapped = row && JWT_EXPIRY_OPTIONS[row.data.jwtExpiry];
    return mapped || env.JWT_EXPIRES_IN;
  } catch {
    return env.JWT_EXPIRES_IN;
  }
}

module.exports = { getSettings, updateSettings, getJwtLifetime };
