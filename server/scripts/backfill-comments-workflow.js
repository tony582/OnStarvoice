import { pathToFileURL } from 'node:url';

import { queryAll } from '../db/init.js';
import { upsertRecordComments } from '../services/comment-workflow.js';

function arrayFromPayload(payload, key) {
  if (!payload || typeof payload !== 'object') return [];
  return Array.isArray(payload[key]) ? payload[key] : [];
}

export async function runCommentsWorkflowBackfill() {
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
      preserveExisting: true,
    });
    processed += 1;
    comments += Number(stats.inserted || 0) + Number(stats.updated || 0);
    officialResponses += Number(stats.officialResponses || 0);
  }

  return Object.freeze({ processed, comments, officialResponses });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  console.error(
    'Direct execution is disabled. Use: npm run maintenance -- run comments-workflow-backfill',
  );
  process.exitCode = 2;
}
