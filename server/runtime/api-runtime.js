import { createApp } from '../app.js';
import { startVerifyRateLimitCleanup, stopVerifyRateLimitCleanup } from '../routes/verify.js';
import { startAsrMediaCleanup, stopAsrMediaCleanup } from '../services/asr-media-host.js';
import { ensureMediaDirs } from '../services/media-store.js';

const DEFAULT_HTTP_DRAIN_TIMEOUT_MS = 30_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export const API_RUNTIME_RESPONSIBILITIES = Object.freeze([
  'http-listener',
  'media-directories',
  'verify-rate-limit-cleanup',
  'asr-staged-media-cleanup',
]);

function positiveTimeout(value, fallback = DEFAULT_HTTP_DRAIN_TIMEOUT_MS) {
  const candidate = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > MAX_TIMER_DELAY_MS) {
    throw new TypeError('HTTP drain timeout must be a positive integer');
  }
  return candidate;
}

function listen(app, port, host) {
  return new Promise((resolve, reject) => {
    let server;
    const onError = error => reject(error);
    const onListening = () => {
      server.off('error', onError);
      resolve(server);
    };

    server = host
      ? app.listen(port, host, onListening)
      : app.listen(port, onListening);
    server.once('error', onError);
  });
}

function beginServerClose(server) {
  return new Promise((resolve, reject) => {
    server.close(error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function trackInFlightRequests(server) {
  let inFlight = 0;
  let draining = false;

  const closeIdleWhenDraining = () => {
    if (draining) server.closeIdleConnections?.();
  };
  const onRequest = (request, response) => {
    inFlight += 1;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      inFlight = Math.max(0, inFlight - 1);
      closeIdleWhenDraining();
    };
    response.once('finish', settle);
    response.once('close', settle);
    if (response.writableFinished) settle();
  };

  server.prependListener('request', onRequest);
  return Object.freeze({
    beginDrain() {
      draining = true;
      closeIdleWhenDraining();
    },
    destroy() {
      server.removeListener('request', onRequest);
    },
    get inFlight() {
      return inFlight;
    },
  });
}

function waitWithTimeout(promise, timeoutMs, onTimeout) {
  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => {
      onTimeout?.();
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
  });
  return Promise.race([
    Promise.resolve(promise).then(() => true),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

export async function startApiRuntime({
  port = process.env.PORT || 3000,
  host = process.env.HOST,
  health,
  logger = console,
  buildApp = createApp,
  prepareMediaDirectories = ensureMediaDirs,
  startVerifyCleanup = startVerifyRateLimitCleanup,
  stopVerifyCleanup = stopVerifyRateLimitCleanup,
  startMediaCleanup = startAsrMediaCleanup,
  stopMediaCleanup = stopAsrMediaCleanup,
} = {}) {
  let server;
  try {
    prepareMediaDirectories();
    startVerifyCleanup();
    startMediaCleanup();
    server = await listen(buildApp({ health, logger }), port, host);
  } catch (error) {
    try { stopVerifyCleanup(); } catch (cleanupError) {
      logger?.error?.(`[API] Verify cleanup rollback failed: ${cleanupError?.message || cleanupError}`);
    }
    try { stopMediaCleanup(); } catch (cleanupError) {
      logger?.error?.(`[API] ASR cleanup rollback failed: ${cleanupError?.message || cleanupError}`);
    }
    throw error;
  }

  let actualPort;
  let requestTracker;
  try {
    const address = server.address();
    actualPort = typeof address === 'object' && address ? address.port : port;
    requestTracker = trackInFlightRequests(server);
    try { logger?.info?.(`[API] HTTP listener ready on port ${actualPort}`); } catch {}
  } catch (error) {
    try { stopVerifyCleanup(); } catch {}
    try { stopMediaCleanup(); } catch {}
    try { await beginServerClose(server); } catch {}
    throw error;
  }

  let closeStarted = false;
  let closePromise;
  let closeResult;

  function stopNewWork() {
    if (closeStarted) return false;
    closeStarted = true;
    try { stopVerifyCleanup(); } catch (error) {
      logger?.error?.(`[API] Verify cleanup stop failed: ${error?.message || error}`);
    }
    try { stopMediaCleanup(); } catch (error) {
      logger?.error?.(`[API] ASR cleanup stop failed: ${error?.message || error}`);
    }
    closePromise = beginServerClose(server).finally(() => requestTracker.destroy());
    // Node 18 does not automatically reap a keep-alive connection that turns
    // idle after server.close(). Re-checking on every response settlement keeps
    // the drain bounded without terminating active requests.
    requestTracker.beginDrain();
    return true;
  }

  async function drain({ timeoutMs } = {}) {
    stopNewWork();
    const boundedTimeout = positiveTimeout(timeoutMs);
    const drained = await waitWithTimeout(closePromise, boundedTimeout, () => {
      server.closeAllConnections?.();
    });
    closeResult = Object.freeze({ drained, inFlight: requestTracker.inFlight });
    return closeResult;
  }

  let stopPromise;
  function stop(options = {}) {
    stopPromise ||= drain(options);
    return stopPromise;
  }

  return Object.freeze({
    kind: 'api',
    responsibilities: API_RUNTIME_RESPONSIBILITIES,
    server,
    port: actualPort,
    stopNewWork,
    drain,
    stop,
    get closeResult() {
      return closeResult;
    },
  });
}
