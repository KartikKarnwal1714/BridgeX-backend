const LEVELS = ['error', 'warn', 'info', 'debug'];

function log(level, message, meta = {}) {
  if (process.env.NODE_ENV === 'test') return;

  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...meta,
  };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

const logger = {};
for (const level of LEVELS) {
  logger[level] = (message, meta) => log(level, message, meta);
}

module.exports = logger;
