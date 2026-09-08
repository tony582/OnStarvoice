import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import test from 'node:test';

import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';

const CAPABILITIES = {
  remoteTaskCreate: true,
  remoteTargetedPostCaptureV1: true,
  negativePostPatrol: true,
  negativePatrolTerminalReceiptV1: true,
  supportedPlatforms: ['douyin'],
  taskStateKnown: true,
};

test('negative patrol fair claiming uses real PostgreSQL dispatch and durable assignments', async t => {
  validatePostgresIntegrationTarget({
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL,
    requireDatabaseUrl: true,
  });
  const {runMigrations} = await import('../../../server/db/migrate.js');
  const {getPool, closePool} = await import('../../../server/db/pool.js');
  const {withTransaction} = await import('../../../server/db/init.js');
  const {dispatchNextElasticWorkItem} = await import('../../../server/routes/capture-cloud.js');
  await runMigrations();
  const pool = getPool();
  t.after(closePool);

  async function fixture(st, {agentCount = 2, itemCount = 2} = {}) {
    const tenant = (await pool.query('INSERT INTO tenants (name) VALUES ($1) RETURNING id',
      [`Fair patrol ${randomUUID()}`])).rows[0];
    st.after(() => pool.query('DELETE FROM tenants WHERE id=$1', [tenant.id]));
    const authCode = (await pool.query(`INSERT INTO auth_codes (tenant_id, code, status, expires_at)
      VALUES ($1, $2, 'active', now() + interval '1 day') RETURNING id`,
    [tenant.id, `FAIR-${randomUUID()}`])).rows[0];
    const agents = [];
    for (let index = 0; index < agentCount; index += 1) {
      const binding = (await pool.query(`INSERT INTO auth_bindings (code_id, fingerprint)
        VALUES ($1, $2) RETURNING id`, [authCode.id, randomUUID()])).rows[0];
      agents.push((await pool.query(`INSERT INTO capture_agents (
          tenant_id, client_uuid, display_name, browser_name, app_version,
          allowed_platforms, status, auth_code_id, auth_binding_id, capabilities,
          last_heartbeat_at, last_full_heartbeat_at, last_liveness_at
        ) VALUES ($1, $2, $3, 'Chrome', '0.4.7', ARRAY['douyin'], 'active',
          $4, $5, $6, now() - interval '60 seconds',
          now() - interval '60 seconds', now() - interval '60 seconds') RETURNING *`,
      [tenant.id, randomUUID(), `Fair node ${index}`, authCode.id, binding.id,
        JSON.stringify(CAPABILITIES)])).rows[0]);
      await pool.query(`INSERT INTO capture_agent_tokens (agent_id, auth_code_id, auth_binding_id, token_hash)
        VALUES ($1, $2, $3, $4)`, [agents.at(-1).id, authCode.id, binding.id,
        createHash('sha256').update(randomUUID()).digest('hex')]);
    }
    const parent = (await pool.query(`INSERT INTO capture_tasks (
        tenant_id, client_task_id, task_type, feature_key, platform, status, title, metadata, counts
      ) VALUES ($1, $2, 'capture_orchestration', 'negative_post_patrol', 'douyin', 'running',
        'Fair patrol fixture', $3, $4) RETURNING *`,
    [tenant.id, randomUUID(), JSON.stringify({
      workflow: 'negative_post_patrol', distributionMode: 'elastic_pool', perItemAdmissionV1: true,
      eligibleAgentIds: agents.map(agent => agent.id), captureSettings: {},
    }), JSON.stringify({total: itemCount})])).rows[0];
    const items = [];
    for (let ordinal = 0; ordinal < itemCount; ordinal += 1) {
      const record = (await pool.query(`INSERT INTO records (tenant_id, external_id, platform, title)
        VALUES ($1, $2, 'douyin', 'Fair patrol post') RETURNING *`,
      [tenant.id, String(7000000000000000000n + BigInt(ordinal))])).rows[0];
      items.push((await pool.query(`INSERT INTO capture_task_items (
          tenant_id, task_id, item_key, item_type, record_id, external_id, platform,
          url_snapshot, status, ordinal, metadata
        ) VALUES ($1, $2, $3::text, 'negative_post', $3::uuid, $4, 'douyin',
          $5, 'pending', $6, '{"sourceRecord":{"title":"Fair patrol post"}}') RETURNING *`,
      [tenant.id, parent.id, record.id, record.external_id,
        `https://www.douyin.com/video/${record.external_id}`, ordinal])).rows[0]);
    }

    async function claim(agent = agents[0]) {
      const current = (await pool.query('SELECT * FROM capture_agents WHERE id=$1', [agent.id])).rows[0];
      return withTransaction(tx => dispatchNextElasticWorkItem(tx, {
        agent: current, capabilities: current.capabilities,
      }));
    }
    async function settle(claimed) {
      assert.ok(claimed?.commandId, JSON.stringify(claimed));
      // Advance only this fixture's prior admission timestamp. This exercises
      // real admission SQL without sleeping through the independent 10s gate.
      await pool.query(`UPDATE capture_agent_commands SET status='completed',
        finished_at=now(), admitted_at=now()-interval '1 minute' WHERE id=$1`, [claimed.commandId]);
      await pool.query(`UPDATE capture_task_item_attempts SET status='completed',
        finished_at=now() WHERE execution_task_id=$1`, [claimed.childTaskId]);
      await pool.query(`UPDATE capture_task_items SET status='completed', finished_at=now()
        WHERE id=$1`, [claimed.itemId]);
      await pool.query("UPDATE capture_tasks SET status='completed', finished_at=now() WHERE id=$1", [claimed.childTaskId]);
    }
    async function assertDispatched(claimed, agent) {
      assert.ok(claimed?.commandId, `Expected a real dispatch: ${JSON.stringify(claimed)}`);
      const saved = (await pool.query(`SELECT command.agent_id, command.task_id, command.payload,
          command.admitted_at, item.execution_task_id, item.assignment_revision,
          attempt.id AS attempt_id, attempt.request_hash
        FROM capture_agent_commands command
        JOIN capture_task_items item ON item.id=$2 AND item.execution_task_id=command.task_id
        JOIN capture_task_item_attempts attempt ON attempt.item_id=item.id
          AND attempt.execution_task_id=command.task_id AND attempt.agent_id=command.agent_id
        WHERE command.id=$1`, [claimed.commandId, claimed.itemId])).rows[0];
      assert.equal(saved.agent_id, agent.id);
      assert.equal(saved.payload.targets.length, 1);
      assert.equal(saved.payload.targets[0].itemId, claimed.itemId);
      assert.equal(saved.payload.targets[0].captureTaskItemAttemptId, saved.attempt_id);
      assert.equal(saved.payload.targets[0].captureTaskItemAssignmentRevision, saved.assignment_revision);
      assert.equal(saved.payload.targets[0].captureTaskItemRequestHash, saved.request_hash);
      assert.ok(saved.admitted_at);
    }
    return {tenant, agents, parent, items, claim, settle, assertDispatched};
  }

  await t.test('five quick posts reach five of six idle peers despite one fast polling browser', async st => {
    const f = await fixture(st, {agentCount: 6, itemCount: 5});
    for (let index = 0; index < 5; index += 1) {
      if (index > 0) {
        const before = (await pool.query('SELECT count(*)::int AS n FROM capture_agent_commands WHERE tenant_id=$1', [f.tenant.id])).rows[0].n;
        const fastAgain = await f.claim(f.agents[0]);
        assert.ok(!fastAgain?.commandId, 'A faster heartbeat must yield to eligible peers with fewer assignments');
        const after = (await pool.query('SELECT count(*)::int AS n FROM capture_agent_commands WHERE tenant_id=$1', [f.tenant.id])).rows[0].n;
        assert.equal(after, before, 'Yielding must not create a command or spend an attempt');
      }
      const claimed = await f.claim(f.agents[index]);
      await f.assertDispatched(claimed, f.agents[index]);
      await f.settle(claimed);
    }
    const counts = (await pool.query(`SELECT agent_id, count(*)::int AS n FROM capture_agent_commands
      WHERE tenant_id=$1 GROUP BY agent_id`, [f.tenant.id])).rows;
    assert.equal(counts.length, 5);
    assert.ok(counts.every(row => row.n === 1));
  });

  await t.test('repeated fast polls never extend the 90-second opportunity for slower peers', async st => {
    const f = await fixture(st);
    const first = await f.claim();
    await f.settle(first);
    const before = (await pool.query(`SELECT id, assigned_at, xmin::text AS row_version
      FROM capture_task_item_attempts WHERE parent_task_id=$1`, [f.parent.id])).rows;
    for (let poll = 0; poll < 2; poll += 1) {
      const deferred = await f.claim();
      assert.ok(deferred?.deferred && !deferred?.commandId);
    }
    const after = (await pool.query(`SELECT id, assigned_at, xmin::text AS row_version
      FROM capture_task_item_attempts WHERE parent_task_id=$1`, [f.parent.id])).rows;
    assert.deepEqual(after, before);
    await pool.query(`UPDATE capture_task_item_attempts SET assigned_at=now()-interval '91 seconds'
      WHERE parent_task_id=$1`, [f.parent.id]);
    await f.assertDispatched(await f.claim(), f.agents[0]);
  });

  await t.test('a concurrent peer retries after the fairness parent lock without duplicate or unpaced admission', async st => {
    const f = await fixture(st, {itemCount: 3});
    await f.settle(await f.claim());
    let releaseParent;
    let parentAcquired;
    const holdParent = new Promise(resolve => { releaseParent = resolve; });
    const ready = new Promise(resolve => { parentAcquired = resolve; });
    const fastClaim = withTransaction(async tx => {
      const result = await dispatchNextElasticWorkItem(tx, {agent: f.agents[0], capabilities: CAPABILITIES});
      assert.ok(result?.deferred && !result?.commandId);
      parentAcquired();
      await holdParent;
      return result;
    });
    try {
      await Promise.race([ready, fastClaim]);
      const peerWhileLocked = await f.claim(f.agents[1]);
      assert.equal(peerWhileLocked, null, 'SKIP LOCKED must not create another execution for the locked parent');
    } finally {
      releaseParent();
      await fastClaim;
    }
    const peerAfterRelease = await f.claim(f.agents[1]);
    await f.assertDispatched(peerAfterRelease, f.agents[1]);
    assert.equal(peerAfterRelease.itemId, f.items[1].id);
    const tooSoon = await f.claim();
    assert.equal(tooSoon?.deferred, true);
    assert.equal(tooSoon?.reason, 'global_admission_rate');
    const ledger = (await pool.query(`SELECT
        (SELECT count(*)::int FROM capture_agent_commands WHERE tenant_id=$1) AS commands,
        (SELECT count(*)::int FROM capture_task_item_attempts WHERE tenant_id=$1) AS attempts`,
    [f.tenant.id])).rows[0];
    assert.deepEqual(ledger, {commands: 2, attempts: 2});
  });

  await t.test('assignments on Xiaohongshu do not count against a first Douyin claim in the same parent', async st => {
    const f = await fixture(st);
    await pool.query(`UPDATE capture_agents SET allowed_platforms=ARRAY['xiaohongshu','douyin'],
      capabilities=jsonb_set(capabilities, '{supportedPlatforms}', '["xiaohongshu","douyin"]')
      WHERE tenant_id=$1`, [f.tenant.id]);
    await pool.query(`UPDATE records SET platform='xiaohongshu' WHERE id=$1`, [f.items[0].record_id]);
    await pool.query(`UPDATE capture_task_items SET platform='xiaohongshu',
      url_snapshot='https://www.xiaohongshu.com/explore/' || external_id WHERE id=$1`, [f.items[0].id]);
    const xhs = await f.claim();
    await f.assertDispatched(xhs, f.agents[0]);
    assert.equal(xhs.itemId, f.items[0].id);
    await f.settle(xhs);
    const douyin = await f.claim();
    await f.assertDispatched(douyin, f.agents[0]);
    assert.equal(douyin.itemId, f.items[1].id);
  });

  for (const distribution of ['fixed_batch', 'pinned_elastic']) {
    await t.test(`${distribution} keeps its explicit node assignment without a fairness wait`, async st => {
      const f = await fixture(st);
      if (distribution === 'fixed_batch') {
        await pool.query(`UPDATE capture_tasks SET metadata=jsonb_set(metadata, '{distributionMode}', '"fixed_batch"')
          WHERE id=$1`, [f.parent.id]);
      }
      await pool.query(`UPDATE capture_task_items SET metadata=metadata || jsonb_build_object('pinnedAgentId', $2::text)
        WHERE task_id=$1`, [f.parent.id, f.agents[0].id]);
      await f.settle(await f.claim());
      await f.assertDispatched(await f.claim(), f.agents[0]);
    });
  }

  for (const unavailable of ['offline', 'stale_full_heartbeat', 'busy_task', 'busy_command',
    'missing_capability', 'wrong_platform', 'unsupported_platform', 'not_eligible',
    'paused', 'invalid_binding', 'revoked_tokens', 'unknown_task_state']) {
    await t.test(`a peer that is ${unavailable} does not strand a ready browser`, async st => {
      const f = await fixture(st);
      const [current, peer] = f.agents;
      await f.settle(await f.claim(current));
      if (unavailable === 'offline') {
        await pool.query(`UPDATE capture_agents SET last_heartbeat_at=now()-interval '5 minutes',
          last_full_heartbeat_at=now()-interval '5 minutes', last_liveness_at=now()-interval '5 minutes' WHERE id=$1`, [peer.id]);
      } else if (unavailable === 'stale_full_heartbeat') {
        await pool.query(`UPDATE capture_agents SET last_full_heartbeat_at=now()-interval '5 minutes',
          last_heartbeat_at=now()-interval '5 minutes', last_liveness_at=now() WHERE id=$1`, [peer.id]);
      } else if (unavailable === 'missing_capability') {
        await pool.query("UPDATE capture_agents SET capabilities=capabilities-'negativePatrolTerminalReceiptV1' WHERE id=$1", [peer.id]);
      } else if (unavailable === 'wrong_platform') {
        await pool.query("UPDATE capture_agents SET allowed_platforms=ARRAY['xiaohongshu'] WHERE id=$1", [peer.id]);
      } else if (unavailable === 'unsupported_platform') {
        await pool.query(`UPDATE capture_agents SET capabilities=jsonb_set(capabilities,
          '{supportedPlatforms}', '["xiaohongshu"]') WHERE id=$1`, [peer.id]);
      } else if (unavailable === 'not_eligible') {
        await pool.query(`UPDATE capture_tasks SET metadata=jsonb_set(metadata, '{eligibleAgentIds}', $2::jsonb) WHERE id=$1`,
        [f.parent.id, JSON.stringify([current.id])]);
      } else if (unavailable === 'paused') {
        await pool.query("UPDATE capture_agents SET status='paused' WHERE id=$1", [peer.id]);
      } else if (unavailable === 'invalid_binding') {
        await pool.query('UPDATE capture_agents SET auth_binding_id=NULL WHERE id=$1', [peer.id]);
      } else if (unavailable === 'revoked_tokens') {
        await pool.query('UPDATE capture_agent_tokens SET revoked_at=now() WHERE agent_id=$1', [peer.id]);
      } else if (unavailable === 'unknown_task_state') {
        await pool.query(`UPDATE capture_agents SET capabilities=jsonb_set(capabilities,
          '{taskStateKnown}', 'false') WHERE id=$1`, [peer.id]);
      } else {
        const blocker = (await pool.query(`INSERT INTO capture_tasks (
            tenant_id, assigned_agent_id, client_task_id, task_type, status
          ) VALUES ($1, $2, $3, 'unattended_keyword_capture', $4) RETURNING id`,
        [f.tenant.id, peer.id, randomUUID(), unavailable === 'busy_task' ? 'running' : 'completed'])).rows[0];
        if (unavailable === 'busy_command') {
          await pool.query(`INSERT INTO capture_agent_commands (tenant_id, agent_id, task_id, command_type, status)
            VALUES ($1, $2, $3, 'resume', 'pending')`, [f.tenant.id, peer.id, blocker.id]);
        }
      }
      await f.assertDispatched(await f.claim(current), current);
    });
  }

  for (const failure of ['current_technical_round', 'permanent_item_safety']) {
    await t.test(`a lower-count peer excluded by ${failure} cannot prevent a legal handoff`, async st => {
      const failedAttempts = failure === 'current_technical_round' ? 1 : 2;
      const previousCompletions = failedAttempts + 1;
      const f = await fixture(st, {itemCount: previousCompletions + 1});
      const [current, peer] = f.agents;
      await pool.query("UPDATE capture_agents SET status='paused' WHERE id=$1", [peer.id]);
      for (let index = 0; index < previousCompletions; index += 1) await f.settle(await f.claim(current));
      await pool.query("UPDATE capture_agents SET status='active' WHERE id=$1", [peer.id]);
      const item = f.items.at(-1);
      let previousExecution;
      for (let number = 1; number <= failedAttempts; number += 1) {
        const error = {code: failure === 'permanent_item_safety' && number === 1 ? 'CAPTCHA_REQUIRED' : 'DETAIL_CAPTURE_TIMEOUT'};
        previousExecution = (await pool.query(`INSERT INTO capture_tasks (
            tenant_id, parent_task_id, assigned_agent_id, client_task_id, task_type, status, finished_at
          ) VALUES ($1, $2, $3, $4, 'negative_post_patrol', 'failed', now()-interval '31 minutes') RETURNING id`,
        [f.tenant.id, f.parent.id, peer.id, randomUUID()])).rows[0];
        await pool.query(`INSERT INTO capture_task_item_attempts (
            tenant_id, item_id, parent_task_id, execution_task_id, agent_id, attempt_number,
            assignment_revision, status, error, finished_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $6, 'failed', $7,
            now()-interval '31 minutes', now()-interval '31 minutes')`,
        [f.tenant.id, item.id, f.parent.id, previousExecution.id, peer.id, number, JSON.stringify(error)]);
      }
      await pool.query(`UPDATE capture_task_items SET status='retryable', attempt_count=$2,
        assignment_revision=$2, execution_task_id=$3, assigned_agent_id=NULL WHERE id=$1`,
      [item.id, failedAttempts, previousExecution.id]);
      const claimed = await f.claim(current);
      await f.assertDispatched(claimed, current);
      assert.equal(claimed.itemId, item.id);
    });
  }
});
