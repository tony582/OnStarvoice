import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { validatePostgresIntegrationTarget } from '../../../scripts/lib/postgres-integration-target.mjs';
import { runMigrations } from '../../../server/db/migrate.js';
import { getPool, closePool } from '../../../server/db/pool.js';
import {
  contentSummaryHash,
  prefilterRelevanceBatch,
  validatePrefilterRequest,
} from '../../../server/services/relevance-prefilter.js';
import { isWellFormed } from '../../../server/utils/well-formed-text.js';

// The prefilter cuts model text with String#slice (reason 1000, evidence and missingSignals 120 units,
// provider error messages 300). A cut between the two halves of an emoji left a lone surrogate,
// JSON.stringify wrote it as \ud83d, and jsonb rejected the parameter (22P02). The whole outcome
// transaction rolled back: no decision rows, no cache entries, the request marked failed, and the
// route answered 503. Clients fail open, so nothing was skipped by mistake, but the batch was lost.
const REPLACEMENT = String.fromCharCode(0xFFFD);

test('prefilter outcome persists when model text is cut through an emoji', async t => {
  validatePostgresIntegrationTarget({ testDatabaseUrl: process.env.TEST_DATABASE_URL, databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true });
  await runMigrations();
  const pool = getPool();
  const tenant = (await pool.query('INSERT INTO tenants(name) VALUES($1) RETURNING id', [`前置筛选代理项验证 ${randomUUID()}`])).rows[0].id;
  await pool.query(`INSERT INTO tenant_settings (tenant_id, key, value)
    VALUES ($1,'llm_provider','deepseek'),($1,'llm_api_key','sk-test-not-real'),
           ($1,'llm_model','deepseek-chat'),($1,'llm_api_endpoint','https://llm.invalid/v1')
    ON CONFLICT (tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = now()`, [tenant]);
  const originalFetch = globalThis.fetch;
  const originalEnv = { key: process.env.LLM_API_KEY, provider: process.env.LLM_PROVIDER };
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_PROVIDER;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (originalEnv.key !== undefined) process.env.LLM_API_KEY = originalEnv.key;
    if (originalEnv.provider !== undefined) process.env.LLM_PROVIDER = originalEnv.provider;
    await pool.query('DELETE FROM tenants WHERE id=$1', [tenant]);
    await closePool();
  });

  // The stub answers every item it was sent with `reply(item)`, or fails the call when `fail` is set.
  let reply = () => ({});
  let fail = null;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /^https:\/\/llm\.invalid\//, 'the stub must be the only model endpoint');
    calls += 1;
    if (fail) return new Response(fail.body, { status: fail.status, headers: { 'Content-Type': 'text/plain' } });
    const sent = JSON.parse(JSON.parse(init.body).messages.at(-1).content);
    const items = sent.items.map(item => ({
      itemId: item.itemId, decision: 'keep', tenantRelevance: 'relevant',
      queryMatch: 0.9, brandMatch: 0.9, confidence: 0.9,
      reason: '标题明确是车机壁纸', evidence: ['车机壁纸'], missingSignals: [],
      ...reply(item),
    }));
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ items }) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const body = (items, overrides = {}) => ({
    requestId: randomUUID(), idempotencyKey: randomUUID(), taskId: 'task-surrogate', runId: 'run-surrogate',
    keywordRunId: 'keyword-surrogate', platform: 'douyin', stage: 'list', keyword: '代理项车机壁纸',
    promptVersion: 'prefilter-list-v4', mode: 'conservative',
    items: items.map(id => ({ itemId: `douyin:${id}`, externalId: id, title: `车机壁纸 ${id}`, author: '车友' })),
    ...overrides,
  });
  async function stored(input) {
    const request = (await pool.query(`SELECT status, response_body FROM relevance_prefilter_requests
      WHERE tenant_id=$1 AND idempotency_key=$2`, [tenant, input.idempotencyKey])).rows[0];
    const decisions = (await pool.query(`SELECT d.item_id, d.reason, d.evidence, d.missing_signals
      FROM relevance_prefilter_decisions d JOIN relevance_prefilter_requests r ON r.id = d.prefilter_request_id
      WHERE d.tenant_id=$1 AND r.idempotency_key=$2 ORDER BY (d.metadata->>'itemIndex')::int`,
    [tenant, input.idempotencyKey])).rows;
    const cache = [];
    for (const item of validatePrefilterRequest(input).value.items) {
      cache.push((await pool.query(`SELECT response_item FROM relevance_prefilter_cache
        WHERE tenant_id=$1 AND content_summary_hash=$2`, [tenant, contentSummaryHash(item)])).rows[0]?.response_item);
    }
    return { request, decisions, cache };
  }

  await t.test('control: a plain reply is stored in decisions, cache and the request ledger', async () => {
    reply = () => ({});
    const input = body(['plain-1', 'plain-2']);
    const response = await prefilterRelevanceBatch({ tenantId: tenant, body: input });
    assert.equal(response.degraded, false);
    const { request, decisions, cache } = await stored(input);
    assert.equal(request.status, 'completed');
    assert.deepEqual(decisions.map(row => row.reason), ['标题明确是车机壁纸', '标题明确是车机壁纸']);
    assert.deepEqual(cache.map(row => row?.reason), ['标题明确是车机壁纸', '标题明确是车机壁纸']);
  });

  await t.test('reason, evidence and missing signals cut inside an emoji persist with whole characters', async () => {
    reply = item => item.itemId === 'douyin:cut-1'
      ? {
          reason: `${'因'.repeat(999)}💰后面还有说明`,
          evidence: [`${'证'.repeat(119)}💰`, '车机壁纸'],
          missingSignals: [`${'缺'.repeat(119)}💰尾巴`],
        }
      : {};
    const input = body(['cut-1', 'cut-2']);
    const response = await prefilterRelevanceBatch({ tenantId: tenant, body: input });
    assert.equal(response.items[0].reason, '因'.repeat(999));

    const { request, decisions, cache } = await stored(input);
    assert.equal(request.status, 'completed', 'the outcome transaction committed');
    assert.equal(decisions.length, 2, 'both decision rows were written');
    assert.equal(decisions[0].reason, '因'.repeat(999), 'the split emoji is dropped whole, not replaced');
    assert.deepEqual(decisions[0].evidence, ['证'.repeat(119), '车机壁纸']);
    assert.deepEqual(decisions[0].missing_signals, ['缺'.repeat(119)]);
    assert.equal(request.response_body.items[0].reason, '因'.repeat(999));
    assert.deepEqual(request.response_body.items[0].evidence, ['证'.repeat(119), '车机壁纸']);
    assert.equal(cache[0]?.reason, '因'.repeat(999), 'the cache entry was written');
    assert.deepEqual(cache[0]?.missingSignals, ['缺'.repeat(119)]);
    assert.equal(cache[1]?.reason, '标题明确是车机壁纸', 'the other item in the batch was cached too');

    // The cached item answers the next batch without a model call.
    const before = calls;
    const replay = await prefilterRelevanceBatch({ tenantId: tenant, body: { ...input, requestId: randomUUID(), idempotencyKey: randomUUID() } });
    assert.equal(calls, before, 'served from cache');
    assert.equal(replay.cacheHitCount, 2);
    assert.equal(replay.items[0].reason, '因'.repeat(999));
  });

  await t.test('a lone surrogate the model sent itself is stored as U+FFFD', async () => {
    reply = () => ({ reason: '理由\uD83D', evidence: ['\uDCB0证据'] });
    const input = body(['lone-1']);
    await prefilterRelevanceBatch({ tenantId: tenant, body: input });
    const { request, decisions, cache } = await stored(input);
    assert.equal(request.status, 'completed');
    assert.equal(decisions[0].reason, `理由${REPLACEMENT}`);
    assert.deepEqual(decisions[0].evidence, [`${REPLACEMENT}证据`]);
    assert.equal(cache[0]?.reason, `理由${REPLACEMENT}`);
  });

  await t.test('request-derived text in the response body (a client intent cut at 80 units) is guarded too', async () => {
    // Clients do not send an intent today, but the API accepts one; its arrays are cut at 80 units
    // and echoed back in response_body. The jsonb guard replaces the half character with U+FFFD.
    const input = body(['intent-1'], { mode: 'disabled', intent: { targetEntity: [`${'车'.repeat(79)}💰`] } });
    const response = await prefilterRelevanceBatch({ tenantId: tenant, body: input });
    assert.equal(response.items[0].executionDisposition, 'collect_full');
    const { request, decisions } = await stored(input);
    assert.equal(request.status, 'completed');
    assert.equal(decisions.length, 1);
    assert.deepEqual(request.response_body.intent.targetEntity, [`${'车'.repeat(79)}${REPLACEMENT}`]);
  });

  await t.test('a provider error message cut at 300 units inside an emoji still fails open and persists', async () => {
    // "LLM API error 400: " is 19 units, so the emoji sits at units 299-300 of the message.
    fail = { status: 400, body: `${'e'.repeat(280)}💰上游返回的原文` };
    try {
      const input = body(['error-1']);
      const response = await prefilterRelevanceBatch({ tenantId: tenant, body: input });
      assert.equal(response.degraded, true);
      assert.equal(response.items[0].status, 'model_error');
      const { request, decisions, cache } = await stored(input);
      assert.equal(request.status, 'completed');
      assert.equal(decisions.length, 1);
      const reason = request.response_body.items[0].reason;
      assert.equal(isWellFormed(reason), true);
      assert.ok(reason.includes(`LLM API error 400: ${'e'.repeat(280)}`), reason);
      assert.ok(!reason.includes('💰') && !reason.includes(REPLACEMENT), 'the split emoji is dropped whole');
      assert.equal(decisions[0].reason, reason);
      assert.equal(cache[0], undefined, 'fail-open results are never cached');
    } finally {
      fail = null;
    }
  });
});
