// Explicit one-time operator job. No scheduler, no status/sentiment relabel.
import 'dotenv/config';
import {randomUUID} from 'node:crypto';
import {getPool, closePool} from '../db/pool.js';
import {callDeepSeekWithPrompt} from '../services/ai-labeler.js';
import {CONTENT_TOPIC_INITIALIZATION_PROMPT, contentTopicInitializationInput, parseContentTopicInitialization, persistInitializedContentTopic} from '../services/content-topic-initialization.js';

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const tenantId = option('--tenant', ''), apply = args.includes('--apply');
const batchSize = Math.min(60, Math.max(1, Number(option('--batch-size', 36)) || 36));
const concurrency = Math.min(6, Math.max(1, Number(option('--concurrency', 4)) || 4));
const limit = Math.min(50000, Math.max(1, Number(option('--limit', 50000)) || 50000));
if (!/^[a-f0-9-]{36}$/i.test(tenantId)) throw new Error('--tenant is required');
const pool = getPool(), lock = await pool.connect(), runId = `topic-init:${randomUUID()}`;
const totals = {runId, apply, total: 0, processed: 0, updated: 0, skipped: 0, failed: 0, topics: {}, promptTokens: 0, completionTokens: 0};
const db = {queryOne: async (sql, params) => (await pool.query(sql, params)).rows[0]};
try {
  const locked = (await lock.query("SELECT pg_try_advisory_lock(hashtext('content-topic-initialization'),hashtext($1)) AS locked", [tenantId])).rows[0].locked;
  if (!locked) throw new Error('Topic initialization already running for this tenant');
  const rows = (await pool.query(`SELECT id,title,content,transcript,transcript_status,transcript_source_url,video_url,audio_url,
      jsonb_build_object('videoUrl',payload->'videoUrl','video_url',payload->'video_url','awemeVideoUrl',payload->'awemeVideoUrl',
        'videoUrls',payload->'videoUrls','audioUrl',payload->'audioUrl','musicUrl',payload->'musicUrl','audioUrls',payload->'audioUrls') AS payload
    FROM records WHERE tenant_id=$1 AND content_topic IS NULL
      AND NOT (COALESCE(manual_overrides,'{}'::jsonb) ? 'content_topic')
    ORDER BY (business_visibility='eligible') DESC, created_at DESC, id LIMIT $2`, [tenantId, limit])).rows;
  totals.total = rows.length;
  console.log(JSON.stringify({stage: 'start', ...totals, batchSize, concurrency}));
  let cursor = 0;
  await Promise.all(Array.from({length: concurrency}, async () => {
    while (cursor < rows.length) {
      const batch = rows.slice(cursor, cursor += batchSize);
      try {
        let outcome, classifications;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            outcome = await callDeepSeekWithPrompt(tenantId, CONTENT_TOPIC_INITIALIZATION_PROMPT, contentTopicInitializationInput(batch),
              {priority: 'background', kind: 'content_topic_initialization', thinking: false, returnMetadata: true, maxTokens: 8000, timeoutMs: 120000, maxAttempts: 2});
            classifications = parseContentTopicInitialization(outcome.data, batch);
            break;
          } catch (error) { if (attempt === 2) throw error; }
        }
        totals.promptTokens += Number(outcome.promptTokens || 0);
        totals.completionTokens += Number(outcome.completionTokens || 0);
        if (!apply) console.log(JSON.stringify({stage:'preview',runId,results:classifications.map((result,index)=>({...result,title:batch[index].title}))}));
        for (let i = 0; i < batch.length; i++) {
          const result = classifications[i];
          if (apply) {
            const saved = await persistInitializedContentTopic(db, tenantId, batch[i], result, runId);
            if (saved) totals.updated++; else totals.skipped++;
          }
          totals.topics[result.topic] = (totals.topics[result.topic] || 0) + 1;
        }
        totals.processed += batch.length;
        console.log(JSON.stringify({stage: 'progress', ...totals}));
      } catch (error) {
        totals.failed += batch.length;
        console.log(JSON.stringify({stage: 'batch_failed', runId, recordIds: batch.map(row => row.id), error: String(error.code || error.name || 'classification_failed')}));
      }
    }
  }));
  if (apply) await pool.query(`INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,target_type,target_id,metadata)
    VALUES($1,'system','content-topic-initialization','records.content_topics_initialized','tenant',$1::text,$2::jsonb)`, [tenantId, JSON.stringify(totals)]);
  console.log(JSON.stringify({stage: 'complete', ...totals}));
  if (totals.failed) process.exitCode = 1;
} finally {
  await lock.query("SELECT pg_advisory_unlock(hashtext('content-topic-initialization'),hashtext($1))", [tenantId]).catch(() => {});
  lock.release(); await closePool();
}
