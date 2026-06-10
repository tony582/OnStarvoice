import { closeDb, queryAll } from '../db/init.js';
import { upsertRecordComments } from '../services/comment-workflow.js';

function arrayFromPayload(payload, key) {
  if (!payload || typeof payload !== 'object') return [];
  return Array.isArray(payload[key]) ? payload[key] : [];
}

async function main() {
  const rows = await queryAll(`
    SELECT id, tenant_id, platform, author_name, author_id, payload
    FROM records
    WHERE payload ? 'commentsCleanedItems'
      OR payload ? 'officialReplyItems'
    ORDER BY updated_at DESC
  `);

  let processed = 0;
  let comments = 0;
  let officialResponses = 0;
  for (const row of rows) {
    const payload = row.payload || {};
    const stats = await upsertRecordComments(row.id, {
      platform: row.platform,
      author_name: row.author_name,
      author_id: row.author_id,
      comments_cleaned_items: JSON.stringify(arrayFromPayload(payload, 'commentsCleanedItems')),
      official_reply_items: JSON.stringify(arrayFromPayload(payload, 'officialReplyItems')),
    }, {
      tenantId: row.tenant_id,
      authCode: '',
    });
    processed += 1;
    comments += Number(stats.inserted || 0) + Number(stats.updated || 0);
    officialResponses += Number(stats.officialResponses || 0);
  }

  console.log(JSON.stringify({ processed, comments, officialResponses }, null, 2));
}

main()
  .catch(err => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
