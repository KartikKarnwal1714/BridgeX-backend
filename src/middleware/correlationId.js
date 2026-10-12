const { randomUUID } = require('crypto');

function correlationId(req, res, next) {
  const incoming = req.headers['x-correlation-id'];
  const id = incoming && incoming.trim() ? incoming : randomUUID();

  req.correlationId = id;
  res.setHeader('X-Correlation-ID', id);
  next();
}

module.exports = correlationId;
