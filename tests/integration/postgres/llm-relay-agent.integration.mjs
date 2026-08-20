import assert from 'node:assert/strict';
import test from 'node:test';

import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';

async function waitForQueuedJob(pool, tenantId) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const row = await pool.query(`
      SELECT id FROM llm_relay_jobs
      WHERE tenant_id = $1 AND status = 'queued'
      ORDER BY created_at DESC LIMIT 1
    `, [tenantId]);
    if (row.rows[0]) return row.rows[0];
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for relay job');
}

test('outbound AI Agent claims and completes a tenant-isolated PostgreSQL job', async t => {
  validatePostgresIntegrationTarget({
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL,
    requireDatabaseUrl: true,
  });

  const {runMigrations} = await import('../../../server/db/migrate.js');
  const {closePool, getPool} = await import('../../../server/db/pool.js');
  const {
    completeLlmRelayJob,
    createLlmRelayAgentToken,
    hashLlmRelayAgentToken,
    heartbeatLlmRelayAgent,
    requestLlmRelayAgentCompletion,
    claimNextLlmRelayJob,
  } = await import('../../../server/services/llm-relay-jobs.js');
  const {callRelevancePrefilterWithPrompt} = await import(
    '../../../server/services/ai-labeler.js'
  );

  await runMigrations();
  const pool = getPool();
  const tenant = (await pool.query(`
    INSERT INTO tenants (name) VALUES ($1)
    ON CONFLICT (name) DO UPDATE SET status = 'active', updated_at = now()
    RETURNING id
  `, ['LLM Relay Integration Tenant'])).rows[0];
  t.after(async () => {
    try {
      await pool.query('DELETE FROM tenants WHERE id = $1', [tenant.id]);
    } finally {
      await closePool();
    }
  });

  const rawToken = createLlmRelayAgentToken();
  const agent = (await pool.query(`
    INSERT INTO llm_relay_agent_tokens (
      tenant_id, name, token_hash, last_seen_at
    ) VALUES ($1, 'Integration Agent', $2, now())
    RETURNING id, tenant_id, name
  `, [tenant.id, hashLlmRelayAgentToken(rawToken)])).rows[0];

  const completionPromise = requestLlmRelayAgentCompletion({
    tenantId: tenant.id,
    model: 'gemini-3.7-flash-low',
    systemPrompt: 'Return one JSON object.',
    userMessage: 'Synthetic integration request.',
    timeoutMs: 10_000,
    requestOptions: {kind: 'integration'},
  });
  await waitForQueuedJob(pool, tenant.id);
  await assert.rejects(
    requestLlmRelayAgentCompletion({
      tenantId: tenant.id,
      model: 'gemini-3.7-flash-low',
      userMessage: 'Busy overflow must go straight to cloud.',
      timeoutMs: 5000,
    }),
    error => error?.code === 'LLM_RELAY_BUSY',
  );
  const claimed = await claimNextLlmRelayJob(agent);
  assert.equal(claimed.model, 'gemini-3.7-flash-low');
  assert.equal(claimed.userMessage, 'Synthetic integration request.');

  const secondClaim = await claimNextLlmRelayJob(agent);
  assert.equal(secondClaim, null, 'one Agent token must not run two jobs concurrently');

  await pool.query(`
    UPDATE llm_relay_agent_tokens
    SET last_seen_at = now() - interval '1 minute'
    WHERE id = $1
  `, [agent.id]);
  const heartbeat = await heartbeatLlmRelayAgent(agent);
  assert.equal(heartbeat.id, agent.id);
  assert.ok(Date.now() - new Date(heartbeat.last_seen_at).getTime() < 5000);

  const completed = await completeLlmRelayJob(agent, claimed.id, {
    leaseToken: claimed.leaseToken,
    success: true,
    result: {ok: true, source: 'integration'},
  });
  assert.equal(completed.status, 'succeeded');
  assert.deepEqual(await completionPromise, {ok: true, source: 'integration'});

  const stored = (await pool.query(`
    SELECT status, system_prompt, user_message, lease_token_hash, result
    FROM llm_relay_jobs WHERE id = $1
  `, [claimed.id])).rows[0];
  assert.equal(stored.status, 'succeeded');
  assert.equal(stored.system_prompt, '');
  assert.equal(stored.user_message, '');
  assert.equal(stored.lease_token_hash, '');
  assert.deepEqual(stored.result, {ok: true, source: 'integration'});

  await pool.query(`
    INSERT INTO tenant_settings (tenant_id, key, value)
    VALUES
      ($1, 'llm_provider', 'deepseek'),
      ($1, 'llm_model', 'deepseek-v4-flash'),
      ($1, 'llm_api_key', 'integration-cloud-fallback-key'),
      ($1, 'llm_relay_mode', 'primary'),
      ($1, 'llm_relay_model', 'gemini-3.7-flash-low')
    ON CONFLICT (tenant_id, key)
    DO UPDATE SET value = excluded.value, updated_at = now()
  `, [tenant.id]);
  const prefilterPromise = callRelevancePrefilterWithPrompt(
    tenant.id,
    'Return one prefilter JSON object.',
    'Synthetic list prefilter request.',
    {
      timeoutMs: 20_000,
      maxTokens: 1800,
      returnMetadata: true,
      priority: 'capture',
      kind: 'relevance_prefilter',
    },
  );
  await waitForQueuedJob(pool, tenant.id);
  const prefilterJob = await claimNextLlmRelayJob(agent);
  assert.equal(prefilterJob.requestOptions.kind, 'relevance_prefilter');
  assert.equal(prefilterJob.requestOptions.timeoutMs, 9000);
  assert.equal(prefilterJob.requestOptions.maxTokens, 1800);
  const prefilterResult = {
    items: [{itemId: 'integration-item', decision: 'keep'}],
  };
  await completeLlmRelayJob(agent, prefilterJob.id, {
    leaseToken: prefilterJob.leaseToken,
    success: true,
    result: prefilterResult,
  });
  assert.deepEqual(await prefilterPromise, {
    data: prefilterResult,
    provider: 'antigravity',
    model: 'gemini-3.7-flash-low',
    route: 'relay',
    finishReason: '',
    responseLength: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
  });

  await pool.query(`
    UPDATE llm_relay_agent_tokens
    SET last_seen_at = now() - interval '1 minute'
    WHERE id = $1
  `, [agent.id]);
  await assert.rejects(
    requestLlmRelayAgentCompletion({
      tenantId: tenant.id,
      model: 'gemini-3.7-flash-low',
      userMessage: 'This must fail before enqueue.',
      timeoutMs: 5000,
    }),
    error => error?.code === 'LLM_RELAY_AGENT_OFFLINE',
  );
  const active = await pool.query(`
    SELECT COUNT(*)::int AS count
    FROM llm_relay_jobs
    WHERE tenant_id = $1 AND status IN ('queued', 'leased')
  `, [tenant.id]);
  assert.equal(active.rows[0].count, 0);
});
