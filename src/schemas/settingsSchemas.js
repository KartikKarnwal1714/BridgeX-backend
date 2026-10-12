const TIMEZONES = ['(GMT+5:30) India Standard Time', '(GMT+0:00) UTC', '(GMT-5:00) Eastern Time'];

// Allowed JWT lifetimes -> value understood by jsonwebtoken.
const JWT_EXPIRY_OPTIONS = { '1 hour': '1h', '12 hours': '12h', '24 hours': '24h' };

const updateSettingsSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    applicationName: { type: 'string', minLength: 1, maxLength: 100 },
    timezone: { type: 'string', enum: TIMEZONES },
    dateFormat: { type: 'string', enum: ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'] },
    jwtExpiry: { type: 'string', enum: Object.keys(JWT_EXPIRY_OPTIONS) },
    sessionTimeout: { type: 'string', enum: ['30 minutes', '1 hour', '4 hours'] },
    passwordPolicy: {
      type: 'string',
      enum: ['Strong (min. 12 characters)', 'Standard (min. 8 characters)'],
    },
    emailNotifications: { type: 'boolean' },
    systemAlerts: { type: 'boolean' },
    apiFailureAlerts: { type: 'boolean' },
    theme: { type: 'string', enum: ['Light', 'Dark', 'System'] },
  },
};

module.exports = { updateSettingsSchema, JWT_EXPIRY_OPTIONS };
