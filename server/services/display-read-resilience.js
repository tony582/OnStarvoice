// Shared helpers for display-only reads (dashboards, sidebar counts, lists).
//
// These reads never decide permissions, dispatch or admission. When the
// database is briefly saturated they may therefore wait a little longer, be
// shared between equal requests and, for a bounded time, fall back to the last
// complete answer instead of failing the whole page.

const TRANSIENT_DATABASE_READ_CODES = new Set([
  'DB_CAPACITY_UNAVAILABLE', // query.js execution gate: queue timeout or full
  '57014', // statement_timeout (query_canceled)
  '55P03', // lock_timeout (lock_not_available)
  'READ_BUDGET_EXCEEDED', // traceReadExecutor: the projection as a whole took too long
]);

export function isTransientDatabaseReadError(error) {
  return TRANSIENT_DATABASE_READ_CODES.has(String(error?.code || ''));
}

export function transientDatabaseReadRetryAfterMs(error, fallbackMs = 1000) {
  const requested = Number(error?.retryAfterMs);
  const base = Number.isFinite(requested) && requested > 0 ? requested : fallbackMs;
  return Math.min(10_000, Math.max(250, Math.round(base)));
}

/**
 * Express cannot tell a slow client from a gone client once the handler is
 * running. The response closing before it was finished is the one reliable
 * sign that nobody waits for the answer any more (browser aborted, or the
 * proxy dropped the upstream request after a client abort).
 */
export function createClientGoneProbe(req, res) {
  let gone = false;
  const onClose = () => {
    if (!res.writableEnded) gone = true;
  };
  res.on?.('close', onClose);
  return () => gone || req?.socket?.destroyed === true;
}

export class ClientGoneError extends Error {
  constructor() {
    super('The client closed the request before the read started.');
    this.name = 'ClientGoneError';
    this.code = 'CLIENT_GONE';
  }
}

export function isClientGoneError(error) {
  return error?.code === 'CLIENT_GONE';
}

/**
 * Last complete answer per key, readable for at most `maxAgeMs`. `loadedAt` is
 * when the load STARTED: of two overlapping loads the one that started later
 * saw the newer data, whichever finishes last, so an older one never replaces
 * it.
 */
export function createLastGoodStore({maxAgeMs, maxEntries = 20} = {}) {
  if (!(Number(maxAgeMs) > 0)) throw new TypeError('last_good_max_age_required');
  const entries = new Map();
  return Object.freeze({
    remember(key, value, loadedAt) {
      const startedAt = Number(loadedAt);
      const stored = entries.get(key);
      if (stored && stored.loadedAt > startedAt) return false;
      entries.delete(key);
      entries.set(key, {value, loadedAt: startedAt});
      while (entries.size > maxEntries) {
        entries.delete(entries.keys().next().value);
      }
      return true;
    },
    read(key, nowMs) {
      const entry = entries.get(key);
      if (!entry) return null;
      const ageMs = Math.max(0, Number(nowMs) - entry.loadedAt);
      if (ageMs > maxAgeMs) {
        entries.delete(key);
        return null;
      }
      return {value: entry.value, ageMs};
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  });
}

/**
 * One running load per key, and answers that never go back in time.
 *
 * - A `fresh` read (the caller just changed data) is answered by a load that
 *   STARTED after it arrived: it waits for the running load to end and shares
 *   ONE follow-up load with every reader that arrives before that follow-up
 *   starts.
 * - An ordinary read joins the follow-up that is waiting, else the load that
 *   is running, else reuses an answer younger than `ttlMs`, else loads. It
 *   joins before it reuses: the page applies the answer to its LATEST request,
 *   so a read sent after a fresh one must not come back with older counts.
 * - A failed load never becomes the cached answer. When the failure is
 *   transient and a complete answer younger than `staleMaxAgeMs` exists, the
 *   caller receives that answer marked `stale`.
 */
export function createSingleFlightReadCache({
  ttlMs,
  staleMaxAgeMs,
  maxEntries = 200,
  now = Date.now,
  isTransientError = isTransientDatabaseReadError,
} = {}) {
  if (!(Number(ttlMs) >= 0)) throw new TypeError('read_cache_ttl_required');
  if (!(Number(staleMaxAgeMs) >= 0)) throw new TypeError('read_cache_stale_age_required');
  const entries = new Map();

  function entryFor(key) {
    let entry = entries.get(key);
    if (!entry) {
      entry = {hasValue: false, value: undefined, loadedAt: 0, running: null, followUp: null};
      entries.set(key, entry);
      if (entries.size > maxEntries) {
        for (const [candidateKey, candidate] of entries) {
          if (candidateKey !== key && !candidate.running && !candidate.followUp) {
            entries.delete(candidateKey);
            if (entries.size <= maxEntries) break;
          }
        }
      }
    }
    return entry;
  }

  function start(entry, loader) {
    const startedAt = Number(now());
    const running = Promise.resolve().then(loader).then(value => {
      entry.hasValue = true;
      entry.value = value;
      entry.loadedAt = startedAt;
      return value;
    }).finally(() => {
      if (entry.running === running) entry.running = null;
    });
    entry.running = running;
    return running;
  }

  // `entry.followUp` is set only while the follow-up WAITS. Once its load has
  // started it is `entry.running`, and a fresh read that arrives then needs
  // the next follow-up, not this one.
  function startAfterRunning(entry, loader) {
    if (!entry.followUp) {
      const followUp = entry.running
        .catch(() => undefined)
        .then(() => {
          if (entry.followUp === followUp) entry.followUp = null;
          return start(entry, loader);
        });
      entry.followUp = followUp;
    }
    return entry.followUp;
  }

  async function read(key, loader, {fresh = false} = {}) {
    if (typeof loader !== 'function') throw new TypeError('read_cache_loader_required');
    const entry = entryFor(String(key));
    const arrivedAt = Number(now());
    let pending;
    if (entry.followUp) {
      // Not started yet, so it starts after this read arrived: it serves
      // every reader, fresh or not.
      pending = entry.followUp;
    } else if (entry.running) {
      pending = fresh ? startAfterRunning(entry, loader) : entry.running;
    } else if (!fresh && entry.hasValue && arrivedAt - entry.loadedAt <= ttlMs) {
      return {value: entry.value, stale: false, ageMs: Math.max(0, arrivedAt - entry.loadedAt)};
    } else {
      pending = start(entry, loader);
    }
    try {
      const value = await pending;
      return {value, stale: false, ageMs: 0};
    } catch (error) {
      const ageMs = Math.max(0, Number(now()) - entry.loadedAt);
      if (entry.hasValue && ageMs <= staleMaxAgeMs && isTransientError(error)) {
        return {value: entry.value, stale: true, ageMs, error};
      }
      throw error;
    }
  }

  return Object.freeze({
    read,
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  });
}

/** At most one line per key and interval; the next line reports what was skipped. */
export function createRateLimitedReporter({intervalMs = 10_000, now = Date.now, sink = console.warn} = {}) {
  const state = new Map();
  return function report(key, message, details = {}) {
    const current = Number(now());
    const entry = state.get(key) || {lastAt: -Infinity, suppressed: 0};
    if (current - entry.lastAt < intervalMs) {
      entry.suppressed += 1;
      state.set(key, entry);
      return false;
    }
    const suppressed = entry.suppressed;
    state.set(key, {lastAt: current, suppressed: 0});
    if (state.size > 500) state.delete(state.keys().next().value);
    sink(message, suppressed > 0 ? {...details, suppressedSinceLastLine: suppressed} : details);
    return true;
  };
}

export class ReadBudgetExceededError extends Error {
  constructor(statement, budgetMs) {
    super(`The projection used its ${budgetMs} ms before "${statement}" could start.`);
    this.name = 'ReadBudgetExceededError';
    this.code = 'READ_BUDGET_EXCEEDED';
    this.readStatement = statement;
  }
}

/**
 * Wraps a transaction executor so a failed or slow projection can say which
 * statement it was. Only labels and durations are recorded, never parameters.
 *
 * `budgetMs` bounds the projection as a whole: statement_timeout bounds one
 * statement, and several slow statements in a row would otherwise keep the
 * connection and its execution slot for their sum. A statement that would
 * start after the budget is not sent.
 */
export function traceReadExecutor(executor, trace, labelOf, {budgetMs = 0, now = Date.now} = {}) {
  const openedAt = Number(now());
  const wrap = method => async (sql, params) => {
    const entry = {statement: String(labelOf(sql) || 'unlabelled'), ms: 0, failed: false};
    trace.push(entry);
    const startedAt = Number(now());
    try {
      if (budgetMs > 0 && startedAt - openedAt > budgetMs) {
        throw new ReadBudgetExceededError(entry.statement, budgetMs);
      }
      return await executor[method](sql, params);
    } catch (error) {
      entry.failed = true;
      if (error && typeof error === 'object' && !error.readStatement) {
        error.readStatement = entry.statement;
      }
      throw error;
    } finally {
      entry.ms = Number(now()) - startedAt;
    }
  };
  return {
    ...executor,
    query: wrap('query'),
    queryAll: wrap('queryAll'),
    queryOne: wrap('queryOne'),
    execute: wrap('execute'),
  };
}
