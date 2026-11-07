import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {projectDiscoveryTaskResult} from '../server/services/capture-discovery/detail-projection.js';
import {
  DISCOVERY_AUTO_RETRY_LIMIT,
  DISCOVERY_LATE_RECEIPT_GRACE_MS,
  shouldAutoRetryDiscovery,
} from '../server/services/capture-discovery/auto-retry.js';

const AGENT = '2fe8a43c-3eaa-42ae-a226-597de3e73f95';
const EARLIER = '943c9954-76ed-4efb-8431-e533b861ed3d';
const timeout = {code: 'TARGET_RUNNER_TAB_TIMEOUT', message: '定向作品采集页打开超时'};

function fixture({task: taskOverrides = {}, candidate: candidateOverrides = {}} = {}) {
  const task = {id: 'detail-task', status: 'running', assigned_agent_id: AGENT,
    metadata: {candidateId: 'candidate'}, ...taskOverrides};
  const candidate = {id: 'candidate', item_id: 'item', record_id: null, observation_id: null,
    attempt_count: 1, assignment_revision: 1, status: 'capturing', last_error: {}, ...candidateOverrides};
  const writes = [];
  const tx = {
    async execute(sql, values) { writes.push({sql, values}); },
    async queryOne(sql, values) {
      if (sql.includes('SELECT candidate.*')) return candidate;
      writes.push({sql, values});
      if (sql.includes("SET status='queued'")) return {id: candidate.id};
      return {...task, status: values[2], error: values[3], counts: values[4], progress: values[5], message: values[6]};
    },
  };
  const requeues = () => writes.filter(write => write.sql.includes("SET status='queued'"));
  const escalations = () => writes.filter(write =>
    write.sql.includes("SET status='failed',last_error") || write.sql.includes("demand_status='needs_action'"));
  return {writes, requeues, escalations,
    run: snapshot => projectDiscoveryTaskResult(tx, {tenantId: 'tenant', task, snapshot})};
}

test('a failed detail capture is handed to another browser instead of a person', async () => {
  const f = fixture({candidate: {last_error: {autoRetry: {count: 0, excludedAgentIds: [EARLIER]}}}});
  const task = await f.run({status: 'failed', error: timeout});
  assert.equal(task.status, 'failed');
  assert.equal(task.error.code, 'detail_auto_requeued');
  assert.equal(task.error.sourceCode, timeout.code);
  assert.equal(task.error.autoRetry, 1);
  assert.match(task.message, /已自动换节点重试（第 1\/2 次）/u);
  assert.doesNotMatch(task.message, /需要处理/u);
  const [requeue] = f.requeues();
  assert.ok(requeue, 'candidate goes back to the queue');
  assert.deepEqual(JSON.parse(requeue.values[4]), [EARLIER, AGENT], 'both failed browsers are excluded');
  assert.equal(requeue.values[5], 0, 'a real capture failure is retried at once');
  assert.equal(f.escalations().length, 0, 'demand stays active and the candidate is not failed');
});

test('a completed snapshot without a receipt waits for its late upload before another browser repeats it', async () => {
  const f = fixture();
  const task = await f.run({status: 'completed', error: null});
  assert.equal(task.error.code, 'detail_auto_requeued');
  assert.equal(f.requeues()[0].values[5], DISCOVERY_LATE_RECEIPT_GRACE_MS);
});

test('a replayed terminal snapshot keeps the handoff and never requeues or escalates again', async () => {
  const first = await fixture().run({status: 'failed', error: timeout});
  const replay = fixture({task: {status: first.status, error: first.error, message: first.message},
    candidate: {status: 'queued', last_error: {autoRetry: {count: 1, excludedAgentIds: [AGENT]}}}});
  const task = await replay.run({status: 'failed', error: timeout});
  assert.equal(task.status, 'failed');
  assert.equal(task.error.code, 'detail_auto_requeued');
  assert.equal(replay.requeues().length, 0);
  assert.equal(replay.escalations().length, 0);
});

test('only outcomes another browser cannot change, or exhausted retries, wait for a person', async () => {
  const unavailable = fixture();
  const task = await unavailable.run({status: 'failed', error: {code: 'TARGET_POST_UNAVAILABLE', message: '作品不可用'}});
  assert.equal(task.status, 'needs_action');
  assert.equal(unavailable.requeues().length, 0);
  const exhausted = fixture({candidate: {last_error: {autoRetry: {count: DISCOVERY_AUTO_RETRY_LIMIT}}}});
  assert.equal((await exhausted.run({status: 'failed', error: timeout})).status, 'needs_action');
  assert.equal(exhausted.requeues().length, 0);
  assert.equal(shouldAutoRetryDiscovery({candidate: {record_id: 'stored'}}), false);
  assert.equal(shouldAutoRetryDiscovery({candidate: {}, sourceCode: 'TARGET_IDENTITY_MISMATCH'}), true,
    'a different browser may land on the right work');
});

test('dispatch skips browsers that already failed a requeued post and keeps the retry ledger', async () => {
  const dispatch = await readFile(new URL('../server/services/capture-discovery/detail-dispatch.js', import.meta.url), 'utf8');
  assert.match(dispatch, /last_error->'autoRetry'->>'notBefore'/u);
  assert.match(dispatch, /last_error->'autoRetry'->'excludedAgentIds','\[\]'::jsonb\) \? \$2::text/u);
  assert.match(dispatch, /last_error=CASE WHEN last_error \? 'autoRetry' THEN jsonb_build_object\('autoRetry'/u);
  assert.match(dispatch, /readAgentPlatformHealth\(tx/u);
  const lifecycle = await readFile(new URL('../server/services/capture-discovery/detail-lifecycle.js', import.meta.url), 'utf8');
  assert.match(lifecycle, /shouldAutoRetryDiscovery\(\{candidate,sourceCode:'detail_create_expired'\}\)/u);
  const receipt = await readFile(new URL('../server/services/capture-discovery/detail-receipt.js', import.meta.url), 'utf8');
  assert.match(receipt, /requeuedLate=task\.error\?\.code===DISCOVERY_AUTO_REQUEUED_CODE&&candidate\?\.status==='queued'/u);
});
