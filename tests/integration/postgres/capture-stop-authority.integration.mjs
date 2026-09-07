import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import express from '../../../server/node_modules/express/index.js';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {getPool, closePool} from '../../../server/db/pool.js';
import {hashCaptureAgentToken, normalizeCloudTaskSnapshot, normalizeRemoteTaskInput} from '../../../server/services/capture-cloud.js';
import {captureTaskSnapshotFingerprint} from '../../../server/routes/capture-cloud.js';
import {evaluateActiveStopAuthority, ACTIVE_STOP_ACTION, ACTIVE_STOP_AUTHORITY_SQL} from '../../../server/services/capture-stop-authority.js';
import {createCaptureStopAuthorityRouter} from '../../../server/routes/capture-stop-authority.js';

const clone = value => JSON.parse(JSON.stringify(value));
function projectedFixture(ids) {
  const at = new Date(Date.now() - 10000).toISOString();
  const context = vm.createContext({Date, URL, AbortController, setTimeout, clearTimeout});
  for (const file of ['utils/capture/task-center-projection.js', 'utils/task-center.js', 'utils/cloud-task-agent.js']) {
    vm.runInContext(readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8'), context, {filename: file});
  }
  const plan = normalizeRemoteTaskInput({executionMode: 'one_time', platform: 'xiaohongshu', keywords: ['隔离甲', '隔离乙']}).planSnapshot;
  const raw = {id: ids.task, attemptId: ids.localAttempt, attemptNumber: 1, progressSeq: 7,
    status: 'running', platform: plan.platform, createdAt: at, updatedAt: at, finishedAt: '', planSnapshot: plan,
    checkpoint: {round: 1, keywordResults: [
      {round: 1, index: 0, keyword: '隔离甲', status: 'completed', attemptCount: 1, savedCount: 3, finishedAt: at},
    ]}, progress: {phase: 'keyword_running', current: 1, total: 2},
  };
  const projection = context.OnStarvoiceCaptureTaskCenterProjection;
  const run = context.OnStarvoiceTaskCenterCore.normalizeTaskRun({...raw,
    taskType: 'unattended_keyword_capture', featureKey: 'unattended_keyword_plan', source: 'cloud_assignment',
    counts: projection.buildUnattendedTaskCounts(raw), checkpoint: projection.buildTaskCenterCheckpointFromUnattendedRequest(raw),
    metadata: {cloudCommandId: ids.command, cloudAssigned: true, cloudAgentScopeId: ids.agent},
  }, {now: at});
  const snapshot = normalizeCloudTaskSnapshot(clone(context.OnStarvoiceCloudTaskAgent.buildTaskSnapshot(
    run, raw.id, {}, {allowLiveHealth: false},
  )));
  assert.equal(snapshot.status, 'running');
  assert.equal(snapshot.updatedAt, at);
  assert.equal(snapshot.metadata.cloudAssigned, true);
  return {snapshot, plan};
}

// This file is not self-initializing: only an explicitly authorized, previously
// prepared synthetic test DB may be used. It never migrates, verifies a real
// identity, dispatches a task or accesses a platform/customer endpoint.
test('active stop authority has real read-only SQL provenance, conflicts and Router semantics', async t => {
  validatePostgresIntegrationTarget({testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true});
  const ids = Object.fromEntries(['tenant', 'agent', 'code', 'binding', 'newBinding', 'task',
    'attempt', 'localAttempt', 'command', 'token', 'otherTask', 'otherCommand'].map(key => [key, randomUUID()]));
  const pool = getPool();
  let client, server, seeded = false;
  t.after(async () => {
    if (server) await new Promise((resolve, reject) => {
      server.closeAllConnections?.(); server.close(error => error ? reject(error) : resolve());
    });
    if (client) {
      await client.query('ROLLBACK');
      if (seeded) await client.query('DELETE FROM tenants WHERE id=$1 AND name=$2', [ids.tenant, `active-stop-authority-${ids.tenant}`]);
      client.release();
    }
    await closePool();
  });
  client = await pool.connect();
  const schema = await client.query(`SELECT to_regclass('capture_task_snapshots') AS snapshots,
    to_regclass('capture_agent_tokens') AS tokens, to_regclass('capture_recovery_intents') AS current_schema`);
  assert.ok(schema.rows[0].snapshots && schema.rows[0].tokens && schema.rows[0].current_schema,
    'An already prepared current schema is required; this test does not run migrations.');
  const {snapshot, plan} = projectedFixture(ids);
  const at = snapshot.updatedAt, token = `isolated-active-stop-${randomUUID()}`;
  const metadata = {...snapshot.metadata, createCommandId: ids.command};
  const payload = {taskId: ids.task, clientTaskId: ids.task, authCodeId: ids.code, authBindingId: ids.binding, planSnapshot: plan};
  await client.query('BEGIN');
  try {
    await client.query('INSERT INTO tenants (id,name) VALUES ($1,$2)', [ids.tenant, `active-stop-authority-${ids.tenant}`]);
    await client.query("INSERT INTO auth_codes (id,tenant_id,code,type) VALUES ($1,$2,$3,'permanent')", [ids.code, ids.tenant, `INTEGRATION-${ids.code}`]);
    await client.query('INSERT INTO auth_bindings (id,code_id,fingerprint) VALUES ($1,$2,$3)', [ids.binding, ids.code, `isolated-${ids.binding}`]);
    await client.query('INSERT INTO capture_agents (id,tenant_id,auth_code_id,auth_binding_id,client_uuid) VALUES ($1,$2,$3,$4,$5)',
      [ids.agent, ids.tenant, ids.code, ids.binding, `isolated-${ids.agent}`]);
    await client.query('INSERT INTO capture_agent_tokens (id,agent_id,auth_code_id,auth_binding_id,token_hash) VALUES ($1,$2,$3,$4,$5)',
      [ids.token, ids.agent, ids.code, ids.binding, hashCaptureAgentToken(token)]);
    await client.query(`INSERT INTO capture_tasks (id,tenant_id,origin_agent_id,assigned_agent_id,
      client_task_id,control_task_id,task_type,platform,status,attempt_number,progress_seq,
      progress,checkpoint,counts,metadata,source_updated_at)
      VALUES ($1::uuid,$2::uuid,$3::uuid,$3::uuid,$1::text,$1::text,$4,$5,'running',$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12)`,
    [ids.task, ids.tenant, ids.agent, snapshot.taskType, snapshot.platform, snapshot.attemptNumber, snapshot.progressSeq,
      JSON.stringify(snapshot.progress), JSON.stringify(snapshot.checkpoint), JSON.stringify(snapshot.counts), JSON.stringify(metadata), at]);
    await client.query(`INSERT INTO capture_task_attempts (id,tenant_id,task_id,agent_id,client_attempt_id,
      attempt_number,progress_seq,status,progress,checkpoint) VALUES ($1,$2,$3,$4,$5,$6,$7,'running',$8::jsonb,$9::jsonb)`,
    [ids.attempt, ids.tenant, ids.task, ids.agent, snapshot.attemptId, snapshot.attemptNumber, snapshot.progressSeq,
      JSON.stringify(snapshot.progress), JSON.stringify(snapshot.checkpoint)]);
    await client.query(`INSERT INTO capture_agent_commands (id,tenant_id,task_id,agent_id,command_type,status,payload,finished_at)
      VALUES ($1,$2,$3,$4,'create','completed',$5::jsonb,$6)`, [ids.command, ids.tenant, ids.task, ids.agent, JSON.stringify(payload), at]);
    await client.query(`INSERT INTO capture_task_snapshots (tenant_id,task_id,attempt_id,agent_id,client_task_id,
      control_task_id,client_attempt_id,attempt_number,progress_seq,task_type,platform,status,progress,checkpoint,
      counts,metadata,source_updated_at,snapshot_fingerprint)
      VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$2::text,$2::text,$5,$6,$7,$8,$9,'running',$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15)`,
    [ids.tenant, ids.task, ids.attempt, ids.agent, snapshot.attemptId, snapshot.attemptNumber, snapshot.progressSeq,
      snapshot.taskType, snapshot.platform, JSON.stringify(snapshot.progress), JSON.stringify(snapshot.checkpoint),
      JSON.stringify(snapshot.counts), JSON.stringify(snapshot.metadata), at, captureTaskSnapshotFingerprint(snapshot)]);
    await client.query('COMMIT'); seeded = true;
  } catch (error) {await client.query('ROLLBACK'); throw error;}
  const body = {action: ACTIVE_STOP_ACTION, source: {clientTaskId: ids.task, controlTaskId: ids.task,
    clientAttemptId: snapshot.attemptId, attemptNumber: snapshot.attemptNumber, progressSeq: snapshot.progressSeq,
    sourceUpdatedAt: at, cloudCommandId: ids.command, platform: snapshot.platform, status: 'running'}};
  const queries = [], app = express();
  app.use(express.json());
  app.use('/api/capture-cloud', createCaptureStopAuthorityRouter({evaluate: args => evaluateActiveStopAuthority(args, {
    readOne: async (sql, params) => {
      queries.push(sql);
      await client.query('BEGIN READ ONLY');
      try {
        const result = await client.query(sql, params);
        await client.query('COMMIT'); return result.rows[0];
      } catch (error) {await client.query('ROLLBACK'); throw error;}
    },
  })}));
  app.use((error, _req, res, _next) => res.status(500).json({ok: false, error: error.message}));
  server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function request(requestBody = body, requestToken = token, {expectedQueries = 1} = {}) {
    const previousQueries = queries.length;
    const response = await fetch(`${origin}/api/capture-cloud/agent/stop-authority`, {method: 'POST',
      headers: {'content-type': 'application/json', authorization: `Bearer ${requestToken}`}, body: JSON.stringify(requestBody)});
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(queries.length - previousQueries, expectedQueries,
      'each valid request uses one current SQL view; invalid actions must not query');
    return {status: response.status, body: await response.json()};
  }
  const rows = async () => (await client.query(`SELECT
    (SELECT to_jsonb(t) FROM tenants t WHERE id=$1) AS tenant,
    (SELECT to_jsonb(c) FROM auth_codes c WHERE id=$2) AS code,
    (SELECT to_jsonb(b) FROM auth_bindings b WHERE id=$3) AS binding,
    (SELECT to_jsonb(a) FROM capture_agents a WHERE id=$4) AS agent,
    (SELECT to_jsonb(t) FROM capture_agent_tokens t WHERE id=$5) AS token,
    (SELECT to_jsonb(t) FROM capture_tasks t WHERE id=$6) AS task,
    (SELECT jsonb_agg(a) FROM capture_task_attempts a WHERE task_id=$6) AS attempts,
    (SELECT jsonb_agg(s) FROM capture_task_snapshots s WHERE task_id=$6) AS snapshots,
    (SELECT jsonb_agg(c) FROM capture_agent_commands c WHERE task_id=$6) AS commands`,
  [ids.tenant, ids.code, ids.binding, ids.agent, ids.token, ids.task])).rows[0];
  const before = await rows();
  const positive = await request();
  assert.equal(positive.status, 200, JSON.stringify(positive.body));
  assert.equal(positive.body.action, ACTIVE_STOP_ACTION);
  assert.equal(positive.body.source.serverAttemptId, ids.attempt);
  assert.deepEqual(await rows(), before, 'permission query leaves all identity/task/Attempt/snapshot/command data untouched');
  assert.equal((await request({...body, action: 'resume'}, token, {expectedQueries: 0})).status, 400);
  assert.equal((await request({...body, action: 'dismiss_terminal_recovery_metadata'}, token, {expectedQueries: 0})).status, 400);
  assert.equal((await request({...body, source: {...body.source, clientAttemptId: randomUUID()}})).status, 409);
  assert.equal((await request(body, `invalid-isolated-${randomUUID()}`)).status, 403);

  await client.query('UPDATE capture_agent_tokens SET revoked_at=now() WHERE id=$1', [ids.token]);
  assert.equal((await request()).status, 403);
  await client.query('UPDATE capture_agent_tokens SET revoked_at=NULL WHERE id=$1', [ids.token]);
  await client.query("UPDATE auth_codes SET expires_at=now()-interval '1 second' WHERE id=$1", [ids.code]);
  assert.equal((await request()).status, 403);
  await client.query('UPDATE auth_codes SET expires_at=NULL WHERE id=$1', [ids.code]);
  await client.query('INSERT INTO auth_bindings (id,code_id,fingerprint) VALUES ($1,$2,$3)', [ids.newBinding, ids.code, `isolated-${ids.newBinding}`]);
  await client.query('UPDATE capture_agents SET auth_binding_id=$1 WHERE id=$2', [ids.newBinding, ids.agent]);
  assert.equal((await request()).status, 403);
  const reboundToken = `isolated-rebound-stop-${randomUUID()}`;
  await client.query('INSERT INTO capture_agent_tokens (id,agent_id,auth_code_id,auth_binding_id,token_hash) VALUES ($1,$2,$3,$4,$5)',
    [randomUUID(), ids.agent, ids.code, ids.newBinding, hashCaptureAgentToken(reboundToken)]);
  assert.equal((await request(body, reboundToken)).status, 409, 'current token must not inherit the old create binding');
  await client.query('UPDATE capture_agents SET auth_binding_id=$1 WHERE id=$2', [ids.binding, ids.agent]);

  await client.query("UPDATE capture_tasks SET status='completed',finished_at=now() WHERE id=$1", [ids.task]);
  assert.equal((await request()).status, 409);
  await client.query("UPDATE capture_tasks SET status='running',finished_at=NULL WHERE id=$1", [ids.task]);
  await client.query('UPDATE capture_tasks SET progress_seq=progress_seq+1 WHERE id=$1', [ids.task]);
  assert.equal((await request()).status, 409);
  await client.query('UPDATE capture_tasks SET progress_seq=progress_seq-1 WHERE id=$1', [ids.task]);
  await client.query('UPDATE capture_task_snapshots SET progress_seq=progress_seq+1 WHERE task_id=$1 AND tenant_id=$2', [ids.task, ids.tenant]);
  assert.equal((await request()).status, 409, 'matching task/Attempt cannot replace the exact snapshot version');
  await client.query('UPDATE capture_task_snapshots SET progress_seq=progress_seq-1 WHERE task_id=$1 AND tenant_id=$2', [ids.task, ids.tenant]);
  assert.equal((await request()).status, 200, 'restoring the exact snapshot restores authorization');
  const nextAttempt = randomUUID();
  await client.query(`INSERT INTO capture_task_attempts (id,tenant_id,task_id,agent_id,client_attempt_id,
    attempt_number,progress_seq,status) VALUES ($1,$2,$3,$4,$5,$6,0,'claimed')`,
  [nextAttempt, ids.tenant, ids.task, ids.agent, randomUUID(), snapshot.attemptNumber + 1]);
  assert.equal((await request()).status, 409, 'a newer Attempt conflicts even while the original source rows still match');
  await client.query('DELETE FROM capture_task_attempts WHERE id=$1 AND task_id=$2 AND tenant_id=$3', [nextAttempt, ids.task, ids.tenant]);
  assert.equal((await request()).status, 200, 'removing the synthetic conflict restores authorization');
  await client.query("UPDATE capture_agent_commands SET payload=payload || $2::jsonb WHERE id=$1", [ids.command, JSON.stringify({orchestration: {parentTaskId: randomUUID()}})]);
  assert.equal((await request()).status, 409);
  await client.query("UPDATE capture_agent_commands SET payload=payload-'orchestration' WHERE id=$1", [ids.command]);

  await client.query(`INSERT INTO capture_tasks (id,tenant_id,origin_agent_id,assigned_agent_id,client_task_id,control_task_id,status)
    VALUES ($1::uuid,$2,$3,$3,$1::text,$1::text,'pending')`, [ids.otherTask, ids.tenant, ids.agent]);
  assert.equal((await request()).status, 409, 'another active task on this Agent conflicts');
  await client.query("UPDATE capture_tasks SET status='completed' WHERE id=$1", [ids.otherTask]);
  await client.query(`INSERT INTO capture_agent_commands (id,tenant_id,task_id,agent_id,command_type,status)
    VALUES ($1,$2,$3,$4,'stop','pending')`, [ids.otherCommand, ids.tenant, ids.otherTask, ids.agent]);
  assert.equal((await request()).status, 409, 'a pending command on another task is not ignored');
  await client.query('DELETE FROM capture_agent_commands WHERE id=$1 AND tenant_id=$2', [ids.otherCommand, ids.tenant]);
  await client.query('DELETE FROM capture_tasks WHERE id=$1 AND tenant_id=$2', [ids.otherTask, ids.tenant]);
  assert.equal((await request()).status, 200, 'restored exact source authorizes stopping again');
  assert.equal(queries.length, 17, '19 HTTP requests: 17 SELECT evaluations plus 2 rejected actions with no SQL');
  assert.ok(queries.every(sql => sql === ACTIVE_STOP_AUTHORITY_SQL));
  t.diagnostic('19 real Router requests; 17 actual authority evaluations inside BEGIN READ ONLY; only the dedicated synthetic tenant was changed.');
});
