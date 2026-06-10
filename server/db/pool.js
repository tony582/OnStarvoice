import pg from 'pg';

const { Pool, types } = pg;

// COUNT(*) returns int8 in PostgreSQL. The dashboard expects ordinary numbers.
types.setTypeParser(20, value => Number(value));

let pool = null;

export function getPool() {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL
    || 'postgres://onstarvoice:onstarvoice@localhost:5432/onstarvoice';

  pool = new Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX || 10),
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
