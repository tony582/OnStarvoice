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
import {evaluateTerminalControlAuthority, TERMINAL_CONTROL_ACTION, TERMINAL_CONTROL_AUTHORITY_SQL} from '../../../server/services/capture-control-authority.js';
import {createCaptureControlAuthorityRouter} from '../../../server/routes/capture-control-authority.js';

const root = new URL('../../../', import.meta.url);
const read = file => readFileSync(new URL(file, root), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const selected = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key]]));

function declaration(source, name) {
  const starts = [...source.matchAll(new RegExp(`^(?:async )?function ${name}\\(`, 'gm'))];
  assert.equal(starts.length, 1, name);
  let end = starts[0].index;
  while ((end = source.indexOf('\n}', end + 1)) >= 0) {
    const body = source.slice(starts[0].index, end + 2);
    try {new vm.Script(`(${body})`); return body;} catch {}
  }
  assert.fail(`unclosed production function ${name}`);
}

// The database fixture starts at the existing normal settlement producer. Only
// storage/physical-cleanup ports are inert; no collecting, sync or browser call
// is made. Raw summary is deliberately NOT invented on the server snapshot.
async function producerFixture(ids, base = Date.now() - 10000) {
  const background = read('background.js');
  const constant = name => {
    const start = background.indexOf(`const ${name} = `);
    assert.ok(start >= 0, name);
    return background.slice(start, background.indexOf('\n', background.indexOf(';', start)));
  };
  class FixedDate extends Date {
    constructor(...args) {super(...(args.length ? args : [base]));}
    static now() {return base;}
  }
  const context = vm.createContext({Date: FixedDate, console,
    DOUYIN_SEARCH_SERVICE_ABNORMAL_CODE: 'DOUYIN_SEARCH_SERVICE_ABNORMAL'});
  vm.runInContext(read('utils/unattended-keyword-run.js').replace(/^import[^\n]+\n/, '').replace(/^export /gm, ''), context);
  for (const file of ['utils/task-center.js', 'utils/cloud-task-agent.js', 'utils/capture/task-center-projection.js']) {
    vm.runInContext(read(file), context, {filename: file});
  }
  vm.runInContext(read('sidebar/task-controller/unattended-run.js').replace(/^export /gm, ''), context);
  const functions = ['normalizePlatformId', 'normalizeScheduleMode', 'normalizeStartTime',
    'normalizeNonNegativeInteger', 'normalizePositiveInteger', 'normalizeKeywordList', 'normalizeSearchFilters',
    'normalizeCalendarDate', 'normalizeDateListText', 'normalizeUnattendedRunProgress', 'normalizeUnattendedKeywordPlan',
    'normalizeUnattendedRunRequest', 'normalizeOrchestrationExecutionContext', 'buildUnattendedTaskRun',
    'parseTimestampMs', 'resolveUnattendedBusinessProgressAt', 'buildUnattendedBusinessProgressFingerprint',
    'buildUnattendedRecoveryMilestoneFingerprint', 'updateUnattendedKeywordRun'];
  vm.runInContext(`${['DEFAULT_UNATTENDED_KEYWORD_PLAN', 'UNATTENDED_RUN_SCHEMA_VERSION',
    'UNATTENDED_MAX_RECOVERY_ATTEMPTS', 'UNATTENDED_PROGRESS_VOLATILE_FIELDS', 'UNATTENDED_SETTLED_CHECKPOINT_STATUSES'].map(constant).join('\n')}
    const SCHEDULE_MODES = new Set(['daily','weekdays','weekends','custom_dates']);
    const UNATTENDED_RUN_REPORTABLE_STATUSES = new Set(['running','completed_with_failures']);
    const {buildTaskCenterCheckpointFromUnattendedRequest, buildUnattendedTaskCounts} = OnStarvoiceCaptureTaskCenterProjection;
    ${functions.map(name => declaration(background, name)).join('\n')}
    const runUnattendedRunMutation = callback => callback();
    const isTerminalUnattendedRunStatus = status => status === 'completed_with_failures';
    let fixtureRequest = null;
    const readUnattendedKeywordRunRequest = async () => fixtureRequest;
    const persistUnattendedRunMutation = async request => {fixtureRequest=request; return {request};};
    const unattendedRunRequiresLocalClosureProof = () => false;
    const cleanupTerminalUnattendedRuntime = async request => ({request});
    const controller = createUnattendedRunController({controllerState:{},controllerOperations:{},
      controllerPorts:{summarizeUnattendedKeywordCheckpoint,hasSyncReconciliationSignal:()=>false}});
    globalThis.producer = {controller,settleUnattendedKeywordCheckpoint,summarizeUnattendedKeywordCheckpoint,
      normalizeUnattendedKeywordPlan,updateUnattendedKeywordRun,setRequest:request=>{fixtureRequest=request;},
      project:request=>{
        const run=OnStarvoiceTaskCenterCore.normalizeTaskRun(buildUnattendedTaskRun(request,null),{now:request.updatedAt});
        return {run,snapshot:OnStarvoiceCloudTaskAgent.buildTaskSnapshot(run,request.id,{}, {allowLiveHealth:false})};
      }};`, context);
  const {producer} = context;
  const at = offset => new Date(base + offset).toISOString();
  const keywords = ['隔离甲', '隔离乙'];
  const plan = normalizeRemoteTaskInput({executionMode:'one_time',platform:'xiaohongshu',keywords}).planSnapshot;
  let checkpoint = producer.settleUnattendedKeywordCheckpoint({keywords,keyword:keywords[0],originalIndex:0,
    result:{ok:true},recordIds:['isolated-saved-result'],now:at(-2000)}).checkpoint;
  checkpoint = producer.settleUnattendedKeywordCheckpoint({checkpoint,keywords,keyword:keywords[1],originalIndex:1,
    attempt:2,result:{ok:false,error:'isolated non-safety failure'},recordIds:[],now:at(-1000)}).checkpoint;
  const summary = producer.summarizeUnattendedKeywordCheckpoint(checkpoint);
  const request = {id:ids.task,attemptId:ids.localAttempt,attemptNumber:1,progressSeq:1,status:'running',
    cloudAssigned:true,cloudCommandId:ids.command,cloudAgentScopeId:ids.agent,executionMode:'one_time',
    createdAt:at(-600000),startedAt:at(-599000),updatedAt:at(-3000),heartbeatAt:at(-3000),businessProgressAt:at(-3000),
    planSnapshot:producer.normalizeUnattendedKeywordPlan(plan)};
  producer.setRequest(request);
  const finishedAt = at(-500);
  const progress = producer.controller.buildUnattendedTerminalProgress({status:'completed_with_failures',summary,
    finishedAt,taskTotal:keywords.length,keywords,requestId:ids.task,attemptId:ids.localAttempt,
    streamingSync:{enabled:true,drainCompleted:true,enqueuedCount:1,processedCount:1,successCount:0,failedCount:1,
      skippedCount:0,pendingCount:0,activeCount:0,remainingCount:0,capturedUniqueCount:1,enqueuedUniqueCount:1,
      excludedUniqueCount:0,succeededUniqueCount:0,blocked:false,canceled:false}});
  const result = await producer.updateUnattendedKeywordRun({requestId:ids.task,attemptId:ids.localAttempt,
    patch:{status:'completed_with_failures',finishedAt,checkpoint,summary,progress,progressSeq:2,
      counts:producer.controller.buildUnattendedTaskCounts(checkpoint,summary,{total:keywords.length})}});
  assert.equal(result.accepted, true);
  const raw = clone(result.data), projection = producer.project(raw);
  const snapshot = normalizeCloudTaskSnapshot(clone(projection.snapshot));
  assert.equal(Object.hasOwn(snapshot, 'summary'), false);
  assert.equal(Object.hasOwn(snapshot.progress, 'progressScope'), false);
  assert.equal(snapshot.counts.failed, raw.summary.failed);
  assert.equal(snapshot.counts.retried, raw.summary.retries);
  return {raw, snapshot, plan};
}

// Requires an explicitly authorized, already prepared integration database.
// Deliberately does not initialize/migrate/reset a database or call verification,
// heartbeat, task dispatch or any live platform/customer endpoint.
test('current authority uses real SELECT-only PostgreSQL provenance and real HTTP Router', async t => {
  validatePostgresIntegrationTarget({testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true});
  const pool = getPool();
  const ids = Object.fromEntries(['tenant', 'agent', 'code', 'binding', 'newBinding', 'task', 'attempt', 'localAttempt', 'command', 'token'].map(key => [key, randomUUID()]));
  let client;
  let server;
  let seeded = false;
  t.after(async () => {
    if (server) await new Promise((resolve, reject) => {
      server.closeAllConnections?.(); server.close(error => error ? reject(error) : resolve());
    });
    if (client) {
      await client.query('ROLLBACK');
      if (seeded) await client.query('DELETE FROM tenants WHERE id = $1 AND name = $2', [ids.tenant, `terminal-authority-${ids.tenant}`]);
      client.release();
    }
    await closePool();
  });
  client = await pool.connect();
  const schema = await client.query(`SELECT to_regclass('capture_task_snapshots') AS snapshots,
    to_regclass('capture_agent_tokens') AS tokens, to_regclass('capture_recovery_intents') AS current_schema`);
  assert.ok(schema.rows[0].snapshots && schema.rows[0].tokens && schema.rows[0].current_schema,
    'This test requires an already prepared current schema; it will not run migrations.');
  const {snapshot, plan} = await producerFixture(ids);
  const at = snapshot.updatedAt;
  const finishedAt = snapshot.finishedAt;
  const token = `isolated-terminal-authority-${randomUUID()}`;
  const {counts, progress, checkpoint} = snapshot;
  const keywordResults = checkpoint.keywordResults.map(result => selected(result,
    ['round','index','keyword','status','attemptCount','savedCount','finishedAt']));
  const metadata = {...snapshot.metadata, createCommandId: ids.command};
  const commandPayload = {taskId: ids.task, clientTaskId: ids.task, authCodeId: ids.code, authBindingId: ids.binding, planSnapshot: plan};
  await client.query('BEGIN');
  try {
    await client.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [ids.tenant, `terminal-authority-${ids.tenant}`]);
    await client.query("INSERT INTO auth_codes (id, tenant_id, code, type) VALUES ($1,$2,$3,'permanent')", [ids.code, ids.tenant, `INTEGRATION-${ids.code}`]);
    await client.query('INSERT INTO auth_bindings (id, code_id, fingerprint) VALUES ($1,$2,$3)', [ids.binding, ids.code, `isolated-${ids.binding}`]);
    await client.query(`INSERT INTO capture_agents (id, tenant_id, auth_code_id, auth_binding_id, client_uuid)
      VALUES ($1,$2,$3,$4,$5)`, [ids.agent, ids.tenant, ids.code, ids.binding, `isolated-${ids.agent}`]);
    await client.query(`INSERT INTO capture_agent_tokens (id, agent_id, auth_code_id, auth_binding_id, token_hash)
      VALUES ($1,$2,$3,$4,$5)`, [ids.token, ids.agent, ids.code, ids.binding, hashCaptureAgentToken(token)]);
    await client.query(`INSERT INTO capture_tasks (id, tenant_id, origin_agent_id, assigned_agent_id,
      client_task_id, control_task_id, task_type, platform, status, attempt_number, progress_seq,
      progress, checkpoint, counts, metadata, source_updated_at, finished_at)
      VALUES ($1::uuid,$2::uuid,$3::uuid,$3::uuid,$1::text,$1::text,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14)`,
    [ids.task, ids.tenant, ids.agent, snapshot.taskType, snapshot.platform, snapshot.status, snapshot.attemptNumber,
      snapshot.progressSeq, JSON.stringify(progress), JSON.stringify(checkpoint), JSON.stringify(counts), JSON.stringify(metadata), at, finishedAt]);
    await client.query(`INSERT INTO capture_task_attempts (id, tenant_id, task_id, agent_id, client_attempt_id,
      attempt_number, progress_seq, status, progress, checkpoint, finished_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11)`,
    [ids.attempt, ids.tenant, ids.task, ids.agent, snapshot.attemptId, snapshot.attemptNumber, snapshot.progressSeq,
      snapshot.status, JSON.stringify(progress), JSON.stringify(checkpoint), finishedAt]);
    await client.query(`INSERT INTO capture_agent_commands (id, tenant_id, task_id, agent_id,
      command_type, status, payload, finished_at) VALUES ($1,$2,$3,$4,'create','completed',$5::jsonb,$6)`,
    [ids.command, ids.tenant, ids.task, ids.agent, JSON.stringify(commandPayload), at]);
    await client.query(`INSERT INTO capture_task_snapshots (tenant_id, task_id, attempt_id, agent_id,
      client_task_id, control_task_id, client_attempt_id, attempt_number, progress_seq, task_type,
      platform, status, progress, checkpoint, counts, metadata, finished_at, source_updated_at, snapshot_fingerprint)
      VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$2::text,$2::text,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15,$16,$17)`,
    [ids.tenant, ids.task, ids.attempt, ids.agent, snapshot.attemptId, snapshot.attemptNumber, snapshot.progressSeq,
      snapshot.taskType, snapshot.platform, snapshot.status, JSON.stringify(progress), JSON.stringify(checkpoint),
      JSON.stringify(counts), JSON.stringify(snapshot.metadata), finishedAt, at, captureTaskSnapshotFingerprint(snapshot)]);
    await client.query('COMMIT');
    seeded = true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  const body = {action: TERMINAL_CONTROL_ACTION, source: {clientTaskId: ids.task, controlTaskId: ids.task,
    clientAttemptId: snapshot.attemptId, attemptNumber: snapshot.attemptNumber, progressSeq: snapshot.progressSeq,
    sourceUpdatedAt: at, finishedAt, cloudCommandId: ids.command, platform: snapshot.platform,
    settlement: {counts, progress: selected(progress, ['phase','current','total']), keywordResults}}};
  const queries = [];
  const app = express();
  app.use(express.json());
  app.use('/api/capture-cloud', createCaptureControlAuthorityRouter({evaluate: args => evaluateTerminalControlAuthority(args, {
    readOne: async (sql, params) => {
      queries.push(sql);
      await client.query('BEGIN READ ONLY');
      try {
        const result = await client.query(sql, params);
        await client.query('COMMIT');
        return result.rows[0];
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    },
  })}));
  app.use((error, _req, res, _next) => res.status(500).json({ok: false, error: error.message}));
  server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function request(requestBody = body, requestToken = token) {
    const response = await fetch(`${origin}/api/capture-cloud/agent/control-authority`, {method: 'POST',
      headers: {'content-type': 'application/json', authorization: `Bearer ${requestToken}`}, body: JSON.stringify(requestBody)});
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return {status: response.status, body: await response.json()};
  }
  const readRows = async () => (await client.query(`SELECT
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
  const before = await readRows();
  const positive = await request();
  assert.equal(positive.status, 200, JSON.stringify(positive.body));
  assert.equal(positive.body.source.serverAttemptId, ids.attempt);
  assert.deepEqual(await readRows(), before, 'SELECT-only authority does not rotate tokens or update task/last_seen fields');
  assert.equal((await request({...body, source: {...body.source, clientAttemptId: randomUUID()}})).status, 409);
  assert.equal((await request(body, 'not-the-synthetic-token')).status, 403);

  await client.query('UPDATE capture_agent_tokens SET revoked_at=now() WHERE id=$1', [ids.token]);
  assert.equal((await request()).status, 403);
  await client.query('UPDATE capture_agent_tokens SET revoked_at=NULL WHERE id=$1', [ids.token]);
  await client.query('INSERT INTO auth_bindings (id, code_id, fingerprint) VALUES ($1,$2,$3)', [ids.newBinding, ids.code, `isolated-${ids.newBinding}`]);
  await client.query('UPDATE capture_agents SET auth_binding_id=$1 WHERE id=$2', [ids.newBinding, ids.agent]);
  assert.equal((await request()).status, 403, 'same agent ID cannot retain old binding authority');
  const reboundToken = `isolated-rebound-authority-${randomUUID()}`;
  await client.query(`INSERT INTO capture_agent_tokens (id, agent_id, auth_code_id, auth_binding_id, token_hash)
    VALUES ($1,$2,$3,$4,$5)`, [randomUUID(), ids.agent, ids.code, ids.newBinding, hashCaptureAgentToken(reboundToken)]);
  const rebound = await request(body, reboundToken);
  assert.equal(rebound.status, 409, 'a valid current token after rebinding cannot control a task created under the original binding');
  assert.equal(rebound.body.reason, 'terminal_source_unproven');
  await client.query('UPDATE capture_agents SET auth_binding_id=$1 WHERE id=$2', [ids.binding, ids.agent]);
  await client.query("UPDATE auth_codes SET expires_at=now()-interval '1 second' WHERE id=$1", [ids.code]);
  assert.equal((await request()).status, 403);
  await client.query('UPDATE auth_codes SET expires_at=NULL WHERE id=$1', [ids.code]);
  await client.query("UPDATE capture_tasks SET status='needs_action' WHERE id=$1", [ids.task]);
  assert.equal((await request()).status, 409);
  await client.query("UPDATE capture_tasks SET status='completed_with_failures' WHERE id=$1", [ids.task]);
  const conflictingCommand = randomUUID();
  await client.query("INSERT INTO capture_agent_commands (id,tenant_id,task_id,agent_id,command_type) VALUES ($1,$2,$3,$4,'stop')", [conflictingCommand, ids.tenant, ids.task, ids.agent]);
  assert.equal((await request()).status, 409);
  await client.query('DELETE FROM capture_agent_commands WHERE id=$1 AND tenant_id=$2', [conflictingCommand, ids.tenant]);
  assert.equal((await request()).status, 200, 'restored provenance authorizes the original exact target');
  assert.ok(queries.length >= 9);
  assert.ok(queries.every(sql => sql === TERMINAL_CONTROL_AUTHORITY_SQL));

  // This is a bounded local SQL-scale check, not a production latency percentile.
  // Every unrelated task uses the same terminal status, agent and tenant, so neither
  // the exact target nor the successor-conflict lookup can appear cheap merely
  // because another status/tenant's rows are excluded. The settlement fields are
  // copied from the actual completed-with-failures producer fixture above.
  // Each has a retained attempt, snapshot and completed command. No new index,
  // schema object, dispatch or real collection is used to create this synthetic load.
  const scaleRowType = 'task uuid, attempt uuid, local_attempt text, command uuid';
  async function addCompletedScaleRows(count) {
    const rows = JSON.stringify(Array.from({length: count}, () => ({task: randomUUID(), attempt: randomUUID(),
      local_attempt: randomUUID(), command: randomUUID()})));
    await client.query('BEGIN');
    try {
      await client.query(`INSERT INTO capture_tasks (id, tenant_id, origin_agent_id, assigned_agent_id,
        client_task_id, control_task_id, task_type, platform, status, attempt_number, progress_seq,
        progress, checkpoint, counts, metadata, source_updated_at, finished_at)
        SELECT added.task, seed.tenant_id, seed.origin_agent_id, seed.assigned_agent_id,
          added.task::text, added.task::text, seed.task_type, seed.platform, seed.status, seed.attempt_number,
          seed.progress_seq, seed.progress, seed.checkpoint, seed.counts,
          seed.metadata || jsonb_build_object('cloudCommandId', added.command, 'createCommandId', added.command),
          seed.source_updated_at, seed.finished_at
        FROM jsonb_to_recordset($1::jsonb) AS added(${scaleRowType})
        CROSS JOIN capture_tasks seed WHERE seed.id=$2::uuid`, [rows, ids.task]);
      await client.query(`INSERT INTO capture_task_attempts (id, tenant_id, task_id, agent_id, client_attempt_id,
        attempt_number, progress_seq, status, progress, checkpoint, finished_at)
        SELECT added.attempt, seed.tenant_id, added.task, seed.agent_id, added.local_attempt,
          seed.attempt_number, seed.progress_seq, seed.status, seed.progress, seed.checkpoint, seed.finished_at
        FROM jsonb_to_recordset($1::jsonb) AS added(${scaleRowType})
        CROSS JOIN capture_task_attempts seed WHERE seed.id=$2::uuid`, [rows, ids.attempt]);
      await client.query(`INSERT INTO capture_agent_commands (id, tenant_id, task_id, agent_id,
        command_type, status, payload, finished_at)
        SELECT added.command, seed.tenant_id, added.task, seed.agent_id, 'create', 'completed',
          seed.payload || jsonb_build_object('taskId', added.task::text, 'clientTaskId', added.task::text), seed.finished_at
        FROM jsonb_to_recordset($1::jsonb) AS added(${scaleRowType})
        CROSS JOIN capture_agent_commands seed WHERE seed.id=$2::uuid`, [rows, ids.command]);
      await client.query(`INSERT INTO capture_task_snapshots (tenant_id, task_id, attempt_id, agent_id,
        client_task_id, control_task_id, client_attempt_id, attempt_number, progress_seq, task_type,
        platform, status, progress, checkpoint, counts, metadata, finished_at, source_updated_at, snapshot_fingerprint)
        SELECT seed.tenant_id, added.task, added.attempt, seed.agent_id, added.task::text, added.task::text,
          added.local_attempt, seed.attempt_number, seed.progress_seq, seed.task_type, seed.platform, seed.status,
          seed.progress, seed.checkpoint, seed.counts, seed.metadata || jsonb_build_object('cloudCommandId', added.command),
          seed.finished_at, seed.source_updated_at, seed.snapshot_fingerprint
        FROM jsonb_to_recordset($1::jsonb) AS added(${scaleRowType})
        CROSS JOIN capture_task_snapshots seed WHERE seed.task_id=$2::uuid`, [rows, ids.task]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
  function planNodes(plan) {
    return [plan, ...(plan.Plans || []).flatMap(planNodes)];
  }
  const queryParams = [hashCaptureAgentToken(token), ids.task, ids.task, snapshot.attemptId,
    snapshot.attemptNumber, snapshot.progressSeq, at, ids.command];
  let scaleCount = 0;
  for (const count of [1500, 10000]) {
    await addCompletedScaleRows(count - scaleCount);
    scaleCount = count;
    for (const table of ['capture_tasks', 'capture_task_attempts', 'capture_task_snapshots', 'capture_agent_commands']) {
      const retained = await client.query(`SELECT count(*)::integer AS count FROM ${table} WHERE tenant_id=$1`, [ids.tenant]);
      assert.equal(retained.rows[0].count, count + 1, `${table} retains the exact bounded synthetic cohort`);
      await client.query(`ANALYZE ${table}`);
    }
    assert.equal((await request()).status, 200, `the actual Router still authorizes at ${count} unrelated tasks`);
    await client.query('BEGIN READ ONLY');
    try {
      for (let sample = 1; sample <= 3; sample += 1) {
        const planResult = await client.query(`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ${TERMINAL_CONTROL_AUTHORITY_SQL}`, queryParams);
        const measured = planResult.rows[0]['QUERY PLAN'][0];
        assert.ok(Number.isFinite(measured['Planning Time']) && Number.isFinite(measured['Execution Time']));
        assert.ok(measured['Planning Time'] + measured['Execution Time'] <= 2000,
          `local SQL coarse 2s gate exceeded: ${JSON.stringify(measured)}`);
        assert.equal(measured.Plan['Actual Rows'], 1);
        const nodes = planNodes(measured.Plan);
        const targetLookups = ['task', 'attempt', 'snapshot', 'command'].map(alias => {
          const node = nodes.find(node => node.Alias === alias);
          assert.ok(node, `exact ${alias} evidence lookup is present`);
          assert.match(node['Node Type'], /Index|Bitmap/u, `exact ${alias} evidence uses an existing index`);
          assert.ok(node['Actual Rows'] <= 2 && node['Actual Loops'] <= 2,
            `exact ${alias} evidence lookup must not grow with unrelated retained tasks`);
          assert.ok((node['Rows Removed by Filter'] || 0) <= 2,
            `exact ${alias} lookup must not scan unrelated terminal evidence behind an index filter`);
          return {alias, node: node['Node Type'], index: node['Index Name'] || '',
            rows: node['Actual Rows'], removed: node['Rows Removed by Filter'] || 0, loops: node['Actual Loops']};
        });
        const successor = nodes.find(node => node['Relation Name'] === 'capture_tasks' && node.Alias !== 'task');
        t.diagnostic(JSON.stringify({kind: 'isolated_sql_scale_not_production_p95', unrelatedTasks: count,
          rowsPerRetainedTable: count + 1, sample, planningMs: measured['Planning Time'], executionMs: measured['Execution Time'],
          targetLookups, successorLookup: successor ? {node: successor['Node Type'], index: successor['Index Name'] || '',
            rows: successor['Actual Rows'], removed: successor['Rows Removed by Filter'] || 0,
            loops: successor['Actual Loops']} : null}));
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
  assert.deepEqual(await readRows(), before, 'scale checks leave the original authority rows unchanged');
});
