import 'dotenv/config'; // 独立运行迁移时也要加载 .env(否则 DATABASE_URL 缺失会回落到默认弱密码)
import { readdir, readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { getPool, closePool } from './pool.js';
import { parsePublishTimestamp } from '../services/publish-date.js';
import { upsertRecordComments } from '../services/comment-workflow.js';

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

// 一次性回填:把存量的 published_ts/comment_published_ts 从原始发布时间串解析出来
// (迁移 014 先回落成采集时间,这里覆盖成真发布时间;解析不了/无发布时间 → NULL,排序靠后)。
// 用 schema_migrations 标记只跑一次。
async function backfillPublishTs(client) {
  const FLAG = 'publish_ts_backfill_v1';
  const done = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [FLAG]);
  if (done.rowCount) return;
  console.log('[DB] Backfilling published_ts from publish_time …');

  const recs = await client.query('SELECT id, publish_time, created_at FROM records');
  let rUpdated = 0;
  for (const r of recs.rows) {
    const ts = String(r.publish_time || '').trim() ? parsePublishTimestamp(r.publish_time, r.created_at) : null;
    await client.query('UPDATE records SET published_ts = $2 WHERE id = $1', [r.id, ts]);
    rUpdated += 1;
  }
  console.log(`[DB]   records: ${rUpdated} 条`);

  const leads = await client.query(`
    SELECT cl.id, cl.captured_at, rc.published_at
    FROM comment_leads cl LEFT JOIN record_comments rc ON rc.id = cl.comment_id`);
  let cUpdated = 0;
  for (const l of leads.rows) {
    const ts = String(l.published_at || '').trim() ? parsePublishTimestamp(l.published_at, l.captured_at) : null;
    await client.query('UPDATE comment_leads SET comment_published_ts = $2 WHERE id = $1', [l.id, ts]);
    cUpdated += 1;
  }
  console.log(`[DB]   comment_leads: ${cUpdated} 条`);

  await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [FLAG]);
}

// 一次性回填:修复"评论异步入库会丢失"后,把"payload 里有评论、但 record_comments 为空"的
// 记录重新入库一遍。评论数据本就安全存在 records.payload —— 关键词采集嵌在
// payload.items[0].commentsCleanedItems,单篇在 payload 顶层。两处都兜。只跑一次。
async function backfillMissingComments(client) {
  const FLAG = 'comment_promotion_backfill_v2';
  const done = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [FLAG]);
  if (done.rowCount) return;
  console.log('[DB] Backfilling missing comment promotions from payload …');

  const recs = await client.query(`
    SELECT r.id, r.tenant_id, r.platform, r.title, r.content, r.author_name, r.author_id,
           r.url, r.keyword,
           COALESCE(
             CASE WHEN jsonb_typeof(r.payload->'items'->0->'commentsCleanedItems') = 'array'
                  THEN r.payload->'items'->0->'commentsCleanedItems' END,
             CASE WHEN jsonb_typeof(r.payload->'commentsCleanedItems') = 'array'
                  THEN r.payload->'commentsCleanedItems' END,
             '[]'::jsonb) AS cleaned,
           COALESCE(
             CASE WHEN jsonb_typeof(r.payload->'items'->0->'officialReplyItems') = 'array'
                  THEN r.payload->'items'->0->'officialReplyItems' END,
             CASE WHEN jsonb_typeof(r.payload->'officialReplyItems') = 'array'
                  THEN r.payload->'officialReplyItems' END,
             '[]'::jsonb) AS official_reply
    FROM records r
    WHERE NOT EXISTS (SELECT 1 FROM record_comments rc WHERE rc.record_id = r.id)
      AND (
        (jsonb_typeof(r.payload->'items'->0->'commentsCleanedItems') = 'array'
           AND jsonb_array_length(r.payload->'items'->0->'commentsCleanedItems') > 0)
        OR (jsonb_typeof(r.payload->'commentsCleanedItems') = 'array'
           AND jsonb_array_length(r.payload->'commentsCleanedItems') > 0)
      )
  `);

  let fixed = 0;
  let comments = 0;
  for (const r of recs.rows) {
    try {
      const stats = await upsertRecordComments(r.id, {
        platform: r.platform,
        title: r.title,
        content: r.content,
        author_name: r.author_name,
        author_id: r.author_id,
        url: r.url,
        keyword: r.keyword,
        comments_cleaned_items: JSON.stringify(r.cleaned || []),
        official_reply_items: JSON.stringify(r.official_reply || []),
      }, { tenantId: r.tenant_id, authCode: '' });
      fixed += 1;
      comments += Number(stats.inserted || 0);
    } catch (err) {
      console.error(`[DB]   comment backfill failed for record ${r.id}:`, err.message);
    }
  }
  console.log(`[DB]   recovered ${fixed} records, ${comments} comments`);
  await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [FLAG]);
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

    await backfillPublishTs(client);
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
