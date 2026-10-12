// Tracks real ping results for each dependency in a rolling window, since
// the server started. This gives genuine (if short-window) availability and
// latency numbers instead of fabricated ones.
const HISTORY_SIZE = 100;
const CHECK_TIMEOUT_MS = 2000;
const history = {}; // { [component]: boolean[] }

function record(component, ok) {
  if (!history[component]) history[component] = [];
  history[component].push(ok);
  if (history[component].length > HISTORY_SIZE) history[component].shift();
}

function uptimePercent(component) {
  const samples = history[component];
  if (!samples || samples.length === 0) return null;
  const okCount = samples.filter(Boolean).length;
  return Number(((okCount / samples.length) * 100).toFixed(2));
}

/**
 * Runs a dependency check with a hard time limit, so a hung database or
 * cache can never hang the health endpoint.
 */
async function timed(fn, timeoutMs = CHECK_TIMEOUT_MS) {
  const start = Date.now();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    await Promise.race([fn(), timeout]);
    return { ok: true, ms: Date.now() - start };
  } catch (err) {
    return { ok: false, ms: Date.now() - start, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { record, uptimePercent, timed, CHECK_TIMEOUT_MS };
