const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function normalizeTimeout(timeoutMs) {
  const value = timeoutMs === undefined ? DEFAULT_DRAIN_TIMEOUT_MS : Number(timeoutMs);
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIMER_DELAY_MS) {
    throw new TypeError('drain timeoutMs must be a non-negative integer');
  }
  return value;
}

/**
 * Track asynchronous work behind a stop-accepting/drain boundary.
 *
 * stopAccepting() prevents future run() calls from invoking their work.
 * waitForIdle() is bounded and may be called again after a timeout to observe
 * eventual quiescence.
 */
export function createDrainController({
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
    throw new TypeError('setTimer and clearTimer must be functions');
  }
  const inFlight = new Set();
  let accepting = true;

  function stopAccepting() {
    if (!accepting) return false;
    accepting = false;
    return true;
  }

  function run(work) {
    if (typeof work !== 'function') {
      return Promise.reject(new TypeError('tracked work must be a function'));
    }
    if (!accepting) return Promise.resolve(undefined);

    const pending = Promise.resolve().then(work);
    inFlight.add(pending);
    pending.then(
      () => inFlight.delete(pending),
      () => inFlight.delete(pending),
    );
    return pending;
  }

  async function waitForIdle({ timeoutMs } = {}) {
    const boundedTimeoutMs = normalizeTimeout(timeoutMs);
    const pending = [...inFlight];
    if (pending.length === 0) {
      return Object.freeze({
        drained: true,
        timedOut: false,
        pending: 0,
      });
    }

    let timeoutHandle;
    let timerScheduled = false;
    const timeoutMarker = Symbol('drain-timeout');
    const settled = Promise.allSettled(pending);
    const timeout = new Promise(resolve => {
      timerScheduled = true;
      timeoutHandle = setTimer(() => resolve(timeoutMarker), boundedTimeoutMs);
    });
    const result = await Promise.race([settled, timeout]);
    if (timerScheduled) clearTimer(timeoutHandle);

    const timedOut = result === timeoutMarker;
    return Object.freeze({
      drained: !timedOut,
      timedOut,
      pending: timedOut ? inFlight.size : 0,
    });
  }

  return Object.freeze({
    run,
    stopAccepting,
    waitForIdle,
    get inFlightCount() {
      return inFlight.size;
    },
  });
}

export const DRAIN_TIMEOUT_DEFAULT_MS = DEFAULT_DRAIN_TIMEOUT_MS;
