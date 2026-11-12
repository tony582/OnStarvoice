import assert from 'node:assert/strict';
import test from 'node:test';
import {complete} from '../server/services/android-control/completion.js';
import {completionStats} from '../server/services/android-control/completion-stats.js';
import {completionStats as runnerCompletionStats} from '../runners/android/src/cloud/completion-stats.mjs';
import {receiptStats} from '../server/services/android-control/recovery.js';
import {digest} from '../server/services/android-control/validation.js';

const AGENT = '00000000-0000-4000-8000-00000000000a', TASK = '00000000-0000-4000-8000-00000000000b';
const ITEM = '00000000-0000-4000-8000-00000000000c', ATTEMPT = '00000000-0000-4000-8000-00000000000d';
const SESSION = '00000000-0000-4000-8000-00000000000e', REQUEST = '00000000-0000-4000-8000-00000000000f';
const identity = {discoveryRunId: TASK, taskId: TASK, itemId: ITEM, attemptId: ATTEMPT, assignmentRevision: 1,
  requestHash: 'a'.repeat(64), agentId: AGENT};
const principal = {agentId: AGENT, tenantId: 'tenant-a', authCodeId: 'auth-a', authBindingId: 'binding-a'};

// Exercise the real completion and lineage handlers; only the transaction storage is in memory.
function fixture() {
  const rows = {
    agent: {id: AGENT, status: 'active', capabilities: {agentKind: 'android_mobile', mobileSearchDiscoveryV1: true},
      allowed_platforms: ['wechat_channels']},
    task: {id: TASK, status: 'running', metadata: {workflow: 'wechat_channels_mobile_discovery'}},
    item: {id: ITEM, task_id: TASK, execution_task_id: TASK, status: 'running', assignment_revision: 1,
      attempt_count: 1, metadata: {attemptId: ATTEMPT, deviceHeld: true}},
    attempt: {id: ATTEMPT, status: 'running', checkpoint: {sessionId: SESSION}, result: {}},
  };
  const writes = [];
  const tx = {
    queryOne: async sql => {
      if (sql.includes('capture_task_item_attempts')) return rows.attempt;
      if (sql.includes('capture_task_items')) return rows.item;
      if (sql.includes('capture_tasks')) return rows.task;
      if (sql.includes('capture_agents')) return rows.agent;
      throw new Error(`Unexpected query: ${sql}`);
    },
    queryAll: async sql => {
      assert.match(sql, /capture_task_items/);
      return [rows.item];
    },
    execute: async (sql, args) => {
      if (sql.includes('pg_advisory_xact_lock')) return {rows: []};
      writes.push({sql, args});
      if (sql.startsWith('UPDATE capture_task_item_attempts SET status=')) {
        rows.attempt.status = args[1];
        Object.assign(rows.attempt.checkpoint, args[2]); Object.assign(rows.attempt.result, args[3]);
      } else if (sql.startsWith('UPDATE capture_task_items SET metadata=')) {
        rows.item.metadata = args[1]; rows.item.status = args[2];
      } else if (sql.startsWith('UPDATE capture_tasks SET status=')) rows.task.status = args[1];
      else throw new Error(`Unexpected mutation: ${sql}`);
      return {rows: []};
    },
  };
  return {rows, writes, tx};
}

test('completion persists only known numeric stats and task receipts expose all five T17 fields', async () => {
  const f = fixture();
  const stats = {links: 2, cardsSeen: 9, opened: 4, outsideWindow: 5, stopReason: 2, screens: 3,
    posts: 2, comments: 7, title: '本机标题', author: '本机作者', card: {author: '本机作者'},
    unknownNumeric: 12, swipes: -1, cards: '9'};
  const body = {requestId: REQUEST, identity, sessionId: SESSION, status: 'completed', deviceIdle: true,
    reason: 'time_window_end', checkpoint: {stats, lastEventId: null, originalStatus: 'completed', pendingEvents: 0}};
  assert.deepEqual(await complete(f.tx, principal, body), {accepted: true, deviceHeld: false});
  assert.deepEqual(f.rows.attempt.checkpoint.runner, {...body.checkpoint,
    stats: {links: 2, posts: 2, outsideWindow: 5, comments: 7, cardsSeen: 9, opened: 4, stopReason: 2, screens: 3}});
  assert.deepEqual(receiptStats(f.rows.attempt.checkpoint),
    {links: 2, posts: 2, comments: 7, cardsSeen: 9, opened: 4, outsideWindow: 5, stopReason: 2, screens: 3});
  assert.equal(f.rows.item.status, 'completed');
  assert.equal(f.rows.item.metadata.deviceHeld, false);
  assert.equal(f.rows.task.status, 'completed');
  assert.equal(f.rows.attempt.result.reason, 'time_window_end');

  // Match the old request hashing contract: pending old-phone completions must still replay after this upgrade.
  const {identity: omitted, ...payload} = body;
  assert.equal(f.rows.attempt.result.completion.hash, digest(payload));
  const count = f.writes.length;
  assert.deepEqual(await complete(f.tx, principal, body), {accepted: true, deviceHeld: false, duplicate: true});
  assert.equal(f.writes.length, count);
  await assert.rejects(complete(f.tx, principal, {...body, checkpoint: {...body.checkpoint, stats: {...stats, title: 'changed'}}}),
    {code: 'COMPLETION_CONFLICT'});
  assert.equal(f.writes.length, count, 'dropping unknown stats does not weaken duplicate request checks');
});

test('independently packaged server and runner preserve the same legacy counters and reject unsafe values', () => {
  const old = {links: 2, cards: 7, swipes: 4, skippedCards: 1, keywordElapsedMs: 1000.5, batchElapsedMs: 4000,
    prefilterSkipped: 1, prefilterJudged: 4, prefilterUnjudged: 1, posts: 2, previewFailed: 0, previewUnavailable: 0,
    outsideWindow: 3, comments: 5, partialBodies: 0, unavailableBodies: 0, timeUnverified: 0, pageFailures: 0};
  const t17 = {cardsSeen: 7, opened: 4, stopReason: 0, screens: 2};
  const mixed = {...old, ...t17, author: 'private', title: 'private', card: {title: 'private'}, anything: 1};
  assert.deepEqual(completionStats(mixed), {...old, ...t17});
  assert.deepEqual(completionStats(mixed), runnerCompletionStats(mixed));
  for (const value of [null, undefined, [], 'private', -1]) assert.equal(completionStats(value), null);
  for (const value of [-1, NaN, Infinity, 'end', '2', 2.3, Number.MAX_SAFE_INTEGER + 1]) {
    const unsafe = {cardsSeen: value, stopReason: value, author: 'private'};
    assert.deepEqual(completionStats(unsafe), runnerCompletionStats(unsafe));
    assert.equal(Object.hasOwn(completionStats(unsafe), 'stopReason'), false);
  }
  assert.deepEqual(receiptStats({runner: {stats: {cardsSeen: 1, stopReason: 'time_window_end',
    opened: {title: 'private'}, outsideWindow: -1, screens: Infinity}}}), {cardsSeen: 1});
  assert.deepEqual(completionStats(Object.assign(Object.create({opened: 1}), {screens: 0})), {screens: 0});
});
