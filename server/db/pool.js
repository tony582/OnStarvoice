import pg from 'pg';

const { Pool, types } = pg;

// COUNT(*) returns int8 in PostgreSQL. The dashboard expects ordinary numbers.
types.setTypeParser(20, value => Number(value));

let pool = null;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

/**
 * Keep one PostgreSQL pool for compatibility, but publish one process-local
 * connection budget that query.js can divide between critical control work,
 * ordinary work and reporting.  A deployment with more than one Node process
 * must set PG_DATABASE_INSTANCE_COUNT to the total number of database-using
 * instances so each process receives only its share of PG_POOL_MAX.
 */
export function resolvePoolBudget(env = process.env) {
  const totalBudget = boundedInteger(env.PG_POOL_MAX, 10, 1, 100);
  const production = String(env.NODE_ENV || '').trim().toLowerCase() === 'production';
  const processRole = String(env.PROCESS_ROLE || '').trim().toLowerCase();
  if (
    production &&
    processRole &&
    processRole !== 'all' &&
    (env.PG_DATABASE_INSTANCE_COUNT === undefined ||
      env.PG_DATABASE_INSTANCE_COUNT === null ||
      String(env.PG_DATABASE_INSTANCE_COUNT).trim() === '')
  ) {
    const error = new Error(
      'Split production runtimes must set PG_DATABASE_INSTANCE_COUNT.',
    );
    error.code = 'PG_DATABASE_INSTANCE_COUNT_REQUIRED';
    throw error;
  }
  const instanceCount = boundedInteger(
    env.PG_DATABASE_INSTANCE_COUNT,
    1,
    1,
    100,
  );
  return {
    configuredTotal: totalBudget,
    instanceCount,
    processMax: Math.max(1, Math.floor(totalBudget / instanceCount)),
  };
}

export function getPool() {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL
    || 'postgres://onstarvoice:onstarvoice@localhost:5432/onstarvoice';

  const budget = resolvePoolBudget();
  pool = new Pool({
    connectionString,
    max: budget.processMax,
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 5000),
  });

  pool.on('error', err => {
    console.error('[DB] PostgreSQL pool error:', err.message);
  });

  return pool;
}

export async function assertDbConnection() {
  await getPool().query('SELECT 1');
}

export async function closePool() {
  if (!pool) return;
  await pool.end();
  pool = null;
}
