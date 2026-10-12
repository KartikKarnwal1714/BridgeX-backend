// Gateway-generated errors. They share the dashboard's error envelope, plus a requestId and an
// X-BridgeX-Error header, so a client can always tell "BridgeX said no" from "the upstream said no".
class GatewayError extends Error {
  /**
   * @param {number} status       HTTP status returned to the client
   * @param {string} code         stable machine-readable code
   * @param {string} message      safe, human-readable message (never contains secrets or internals)
   * @param {object} opts
   * @param {string} opts.category  fine-grained category stored in logs (errorCategory)
   * @param {string} [opts.outcome] rejected | rate_limited | gateway_error
   * @param {object} [opts.headers] extra response headers
   */
  constructor(status, code, message, { category, outcome = 'rejected', headers = {} } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.category = category || code.toLowerCase();
    this.outcome = outcome;
    this.headers = headers;
  }
}

module.exports = { GatewayError };
