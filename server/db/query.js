import { getPool } from './pool.js';

function executor(client) {
  return client || getPool();
}

export async function queryAll(sql, params = [], client = null) {
  const result = await executor(client).query(sql, params);
  return result.rows;
}

export async function queryOne(sql, params = [], client = null) {
  const result = await executor(client).query(sql, params);
  return result.rows[0] || null;
}

export async function execute(sql, params = [], client = null) {
  const result = await executor(client).query(sql, params);
  return {
    changes: result.rowCount,
    rowCount: result.rowCount,
    rows: result.rows,
    lastInsertRowid: result.rows[0]?.id || null,
  };
}

export async function withTransaction(callback) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const tx = {
      client,
      query: (sql, params = []) => client.query(sql, params),
      queryAll: (sql, params = []) => queryAll(sql, params, client),
      queryOne: (sql, params = []) => queryOne(sql, params, client),
      execute: (sql, params = []) => execute(sql, params, client),
    };
    const result = await callback(tx);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); }
    catch (rollbackErr) { console.error('[DB] Rollback failed:', rollbackErr.message); }
    throw err;
  } finally {
    client.release();
  }
}
