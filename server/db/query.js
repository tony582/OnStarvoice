import { getPool } from './pool.js';

export const DB_EXECUTION_CATEGORIES = Object.freeze([
  'critical',
  'general',
  'reporting',
]);

const CATEGORY_SET = new Set(DB_EXECUTION_CATEGORIES);

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

export function resolveDbExecutionBudget(env = process.env) {
  const total = boundedInteger(env.PG_POOL_MAX, 10, 1, 100);
  const instanceCount = boundedInteger(
    env.PG_DATABASE_INSTANCE_COUNT,
    1,
    1,
    100,
  );
  const processMax = Math.max(1, Math.floor(total / instanceCount));
  if (processMax < 3) {
    if (String(env.NODE_ENV || '').trim().toLowerCase() === 'production') {
      const error = new Error(
        'Production database budget must provide at least three connections per instance.',
      );
      error.code = 'DB_EXECUTION_BUDGET_TOO_SMALL';
      throw error;
    }
    // Test/development databases with one or two connections retain a shared
    // compatibility mode. Production fails above because it cannot honestly
    // reserve all three paths with fewer than three physical connections.
    return Object.freeze({
      processMax,
      critical: 1,
      general: 1,
      reporting: 1,
    });
  }
  const reporting = boundedInteger(
    env.PG_REPORTING_CONCURRENCY,
    Math.max(1, Math.floor(processMax * 0.2)),
    1,
    processMax - 2,
  );
  const critical = boundedInteger(
    env.PG_CRITICAL_CONCURRENCY,
    Math.max(1, Math.floor(processMax * 0.4)),
    1,
    processMax - reporting - 1,
  );
  const generalMaximum = Math.max(1, processMax - critical - reporting);
  const general = boundedInteger(
    env.PG_GENERAL_CONCURRENCY,
    generalMaximum,
    1,
    generalMaximum,
  );
  return Object.freeze({processMax, critical, general, reporting});
}

export class DbCapacityError extends Error {
  constructor(category, retryAfterMs, reason = 'queue_timeout') {
    super(`Database ${category} capacity is temporarily unavailable.`);
    this.name = 'DbCapacityError';
    this.code = 'DB_CAPACITY_UNAVAILABLE';
    this.category = category;
    this.reason = reason;
    this.retryAfterMs = retryAfterMs;
  }
}

export function isDbCapacityError(error) {
  return error?.code === 'DB_CAPACITY_UNAVAILABLE';
}

export function createDbExecutionGate({
  limit,
  maxQueue,
  defaultWaitMs,
  category,
} = {}) {
  let active = 0;
  const waiters = [];

  function release() {
    active = Math.max(0, active - 1);
    while (active < limit && waiters.length > 0) {
      const waiter = waiters.shift();
      if (!waiter || waiter.settled) continue;
      waiter.settled = true;
      clearTimeout(waiter.timer);
      active += 1;
      waiter.resolve(release);
    }
  }

  return Object.freeze({
    async acquire(waitMs = defaultWaitMs) {
      if (active < limit) {
        active += 1;
        return release;
      }
      const timeoutMs = boundedInteger(waitMs, defaultWaitMs, 1, 30000);
      if (waiters.length >= maxQueue) {
        throw new DbCapacityError(category, timeoutMs, 'queue_full');
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          resolve,
          reject,
          settled: false,
          timer: null,
        };
        waiter.timer = setTimeout(() => {
          if (waiter.settled) return;
          waiter.settled = true;
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new DbCapacityError(category, timeoutMs));
        }, timeoutMs);
        waiter.timer.unref?.();
        waiters.push(waiter);
      });
    },
    snapshot() {
      return {category, active, queued: waiters.length, limit, maxQueue};
    },
  });
}

const budget = resolveDbExecutionBudget();
const executionGates = Object.freeze({
  critical: createDbExecutionGate({
    category: 'critical',
    limit: budget.critical,
    maxQueue: boundedInteger(process.env.PG_CRITICAL_QUEUE_MAX, 200, 1, 2000),
    defaultWaitMs: boundedInteger(process.env.PG_CRITICAL_WAIT_MS, 500, 10, 30000),
  }),
  general: createDbExecutionGate({
    category: 'general',
    limit: budget.general,
    maxQueue: boundedInteger(process.env.PG_GENERAL_QUEUE_MAX, 100, 1, 2000),
    defaultWaitMs: boundedInteger(process.env.PG_GENERAL_WAIT_MS, 500, 10, 30000),
  }),
  reporting: createDbExecutionGate({
    category: 'reporting',
    limit: budget.reporting,
    maxQueue: boundedInteger(process.env.PG_REPORTING_QUEUE_MAX, 20, 1, 500),
    defaultWaitMs: boundedInteger(process.env.PG_REPORTING_WAIT_MS, 250, 10, 30000),
  }),
});

function normalizeCategory(value) {
  const category = String(value || 'general').trim().toLowerCase();
  return CATEGORY_SET.has(category) ? category : 'general';
}

export function getDbExecutionSnapshot() {
  return {
    budget,
    categories: Object.fromEntries(DB_EXECUTION_CATEGORIES.map(category => [
      category,
      executionGates[category].snapshot(),
    ])),
  };
}

async function withExecutionSlot(options, callback) {
  const category = normalizeCategory(options?.category);
  const release = await executionGates[category].acquire(options?.waitTimeoutMs);
  try {
    return await callback();
  } finally {
    release();
  }
}

async function runQuery(sql, params, client, options) {
  if (client) return client.query(sql, params);
  return withExecutionSlot(options, () => getPool().query(sql, params));
}

export async function queryAll(sql, params = [], client = null, options = {}) {
  const result = await runQuery(sql, params, client, options);
  return result.rows;
}

export async function queryOne(sql, params = [], client = null, options = {}) {
  const result = await runQuery(sql, params, client, options);
  return result.rows[0] || null;
}

export async function execute(sql, params = [], client = null, options = {}) {
  const result = await runQuery(sql, params, client, options);
  return {
    changes: result.rowCount,
    rowCount: result.rowCount,
    rows: result.rows,
    lastInsertRowid: result.rows[0]?.id || null,
  };
}

function optionalTimeoutValue(value, fallback = null, maximum = 120000) {
  if (value === undefined || value === null || value === '') return fallback;
  return boundedInteger(value, fallback, 1, maximum);
}

function shouldDiscardConnection(error) {
  const code = String(error?.code || '');
  return code.startsWith('08') || ['57P01', '57P02', '57P03'].includes(code);
}

export async function withTransaction(callback, options = {}) {
  const category = normalizeCategory(options.category);
  const releaseSlot = await executionGates[category].acquire(
    options.waitTimeoutMs,
  );
  let client = null;
  let discardConnection = false;
  try {
    client = await getPool().connect();
    await client.query('BEGIN');
    const isolationLevel = String(options.isolationLevel || '')
      .trim()
      .toLowerCase()
      .replaceAll('-', '_')
      .replaceAll(' ', '_');
    if (isolationLevel === 'repeatable_read') {
      await client.query(
        `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ${
          options.readOnly === true ? ' READ ONLY' : ''
        }`,
      );
    } else if (isolationLevel === 'serializable') {
      await client.query(
        `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE${
          options.readOnly === true ? ' READ ONLY' : ''
        }`,
      );
    } else if (options.readOnly === true) {
      await client.query('SET TRANSACTION READ ONLY');
    }
    const statementTimeoutMs = optionalTimeoutValue(
      options.statementTimeoutMs,
      category === 'reporting' ? 2000 : null,
    );
    const lockTimeoutMs = optionalTimeoutValue(
      options.lockTimeoutMs,
      category === 'reporting' ? 100 : null,
      30000,
    );
    const idleTimeoutMs = optionalTimeoutValue(
      options.idleInTransactionTimeoutMs,
      statementTimeoutMs ? Math.max(statementTimeoutMs * 2, 5000) : null,
    );
    if (statementTimeoutMs) {
      await client.query(
        "SELECT set_config('statement_timeout', $1, true)",
        [`${statementTimeoutMs}ms`],
      );
    }
    if (lockTimeoutMs) {
      await client.query(
        "SELECT set_config('lock_timeout', $1, true)",
        [`${lockTimeoutMs}ms`],
      );
    }
    if (idleTimeoutMs) {
      await client.query(
        "SELECT set_config('idle_in_transaction_session_timeout', $1, true)",
        [`${idleTimeoutMs}ms`],
      );
    }
    if (options.jitOff === true) {
      await client.query("SELECT set_config('jit', 'off', true)");
    }
    const tx = {
      client,
      category,
      query: (sql, params = []) => client.query(sql, params),
      queryAll: (sql, params = []) => queryAll(sql, params, client),
      queryOne: (sql, params = []) => queryOne(sql, params, client),
      execute: (sql, params = []) => execute(sql, params, client),
    };
    const result = await callback(tx);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    discardConnection = shouldDiscardConnection(err);
    if (client) {
      try { await client.query('ROLLBACK'); }
      catch (rollbackErr) {
        discardConnection = true;
        console.error('[DB] Rollback failed:', rollbackErr.message);
      }
    }
    throw err;
  } finally {
    if (client) client.release(discardConnection);
    releaseSlot();
  }
}
