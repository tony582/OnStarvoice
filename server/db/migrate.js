import 'dotenv/config'; // 独立运行迁移时也要加载 .env(否则 DATABASE_URL 缺失会回落到默认弱密码)
import { readdir, readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { getPool, closePool } from './pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function ensureMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export async function runMigrations() {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await ensureMigrationTable(client);
    const migrationsDir = join(__dirname, 'migrations');
    const files = (await readdir(migrationsDir))
      .filter(file => file.endsWith('.sql'))
      .sort();

    const appliedRows = await client.query('SELECT version FROM schema_migrations');
    const applied = new Set(appliedRows.rows.map(row => row.version));

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(migrationsDir, file), 'utf8');
      console.log(`[DB] Applying migration ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    client.release();
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === __filename;
if (isMain) {
  runMigrations()
    .then(async () => {
      console.log('[DB] Migrations complete');
      await closePool();
    })
    .catch(async err => {
      console.error('[DB] Migration failed:', err);
      await closePool();
      process.exit(1);
    });
}
