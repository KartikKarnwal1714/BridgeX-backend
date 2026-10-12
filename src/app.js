const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');
const path = require('path');

const env = require('./config/env');
const correlationId = require('./middleware/correlationId');
const requestLogger = require('./middleware/requestLogger');
const notFound = require('./middleware/notFound');
const errorHandler = require('./middleware/errorHandler');
const routes = require('./routes');
const gatewayRouter = require('./gateway/gatewayRouter');

const app = express();

app.use(helmet());

// API gateway. Mounted before express.json(), the dashboard request logger and the dashboard
// rate limiter: gateway bodies must stay raw streams, each gateway request is logged exactly once
// by the gateway itself, and gateway clients are limited per API key rather than by this global cap.
// No CORS here — the gateway is for server-to-server calls, not browsers on other origins.
app.use('/gateway', gatewayRouter);

app.use(
  cors({
    origin: env.CLIENT_URL,
    credentials: true,
  })
);
app.use(express.json());
app.use(correlationId);
app.use(requestLogger);

// Basic global rate limiting. Route-specific limits (e.g. login) arrive in
// a later phase alongside the full Redis-backed limiter.
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// Swagger / OpenAPI docs
const openapiDocument = YAML.load(path.join(__dirname, 'docs', 'openapi.yaml'));
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openapiDocument));

app.use('/api/v1', routes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
