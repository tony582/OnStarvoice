import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OPERATOR_CLOSE_EXPLAINED_REASONS,
  OPERATOR_CLOSE_REASON_MESSAGES,
  OPERATOR_CLOSE_REASONS,
  normalizeOperatorCloseTaskIds,
  operatorCloseAttemptTransition,
  operatorCloseChildTransition,
  operatorCloseItemTransition,
  operatorClosedTask,
  operatorClosedTaskSql,
} from '../server/services/capture-operator-close.js';

// docs/hotfix/20260927-stuck-retry-and-attention-cleanup.md F3
const closedAt = '2026-09-27T12:00:00.123456+08:00';
const marker = (overrides = {}) => ({closedAt, attemptNumber: 1, orchestrationRevision: 1, ...overrides});

test('every refusal reason has one API message, in the documented order', () => {
  assert.deepEqual(OPERATOR_CLOSE_REASONS, [
    'not_root', 'interrupted', 'status_not_closeable', 'stop_fence', 'stop_pending', 'live_child',
    'live_command', 'device_held', 'live_item', 'negative_patrol_needs_action', 'active_discovery_demand',
  ]);
  assert.deepEqual(Object.keys(OPERATOR_CLOSE_REASON_MESSAGES).sort(), [...OPERATOR_CLOSE_REASONS].sort());
  for (const reason of OPERATOR_CLOSE_REASONS) assert.ok(OPERATOR_CLOSE_REASON_MESSAGES[reason], reason);
  assert.deepEqual(OPERATOR_CLOSE_EXPLAINED_REASONS,
    OPERATOR_CLOSE_REASONS.filter(reason => !['not_root', 'status_not_closeable'].includes(reason)));
  assert.match(OPERATOR_CLOSE_REASON_MESSAGES.stop_fence, /确认旧页面已停止/u);
  assert.match(OPERATOR_CLOSE_REASON_MESSAGES.negative_patrol_needs_action, /恢复失败巡查/u);
});

test('a row is closed only while it is still the execution and revision the operator closed', () => {
  const row = {status: 'failed', attempt_number: 1, orchestration_revision: 1, metadata: {operatorClose: marker()}};
  assert.equal(operatorClosedTask(row), true);
  assert.equal(operatorClosedTask({...row, status: 'completed_with_failures'}), true);
  for (const status of ['needs_action', 'interrupted', 'running', 'completed', 'canceled', 'superseded']) {
    assert.equal(operatorClosedTask({...row, status}), false, `${status} was reopened`);
  }
  assert.equal(operatorClosedTask({...row, attempt_number: 2}), false, 'a new execution is not the closed one');
  assert.equal(operatorClosedTask({...row, orchestration_revision: 2}), false, 'a retried batch is not the closed one');
  assert.equal(operatorClosedTask({...row, metadata: {}}), false);
  assert.equal(operatorClosedTask({...row, metadata: {operatorClose: marker({closedAt: ''})}}), false);
  assert.equal(operatorClosedTask({...row, metadata: {operatorClose: marker({attemptNumber: 'x'})}}), false);
  assert.equal(operatorClosedTask(null), false);
  // Callers that did not select the counters cannot contradict the marker.
  assert.equal(operatorClosedTask({status: 'failed', metadata: {operatorClose: marker()}}), true);
  assert.equal(operatorClosedTask({...row, orchestration_revision: undefined}), true);
});

test('the SQL twin checks the same four facts with constant cost', () => {
  const sql = operatorClosedTaskSql('capture_tasks');
  assert.match(sql, /capture_tasks\.metadata->'operatorClose'->>'closedAt'/u);
  assert.match(sql, /capture_tasks\.status IN \('failed', 'completed_with_failures'\)/u);
  assert.match(sql, /->>'attemptNumber' = capture_tasks\.attempt_number::text/u);
  assert.match(sql, /->>'orchestrationRevision' = capture_tasks\.orchestration_revision::text/u);
  assert.doesNotMatch(sql, /SELECT|PREVIOUS_CAPTURE_STOP_UNCONFIRMED/u);
  assert.throws(() => operatorClosedTaskSql('bad alias'), /invalid_task_alias/u);
});

test('state transitions: needs_action ends as failed, only a stopped phone run cancels its queued words', () => {
  const rootId = 'root';
  assert.equal(operatorCloseItemTransition({status: 'needs_action', task_id: 'x', execution_task_id: 'y'}), 'failed');
  for (const status of ['pending', 'retryable']) {
    const own = {status, task_id: rootId, execution_task_id: rootId};
    assert.equal(operatorCloseItemTransition(own, {rootId, standaloneMobileRun: true}), 'canceled');
    assert.equal(operatorCloseItemTransition(own, {rootId, standaloneMobileRun: false}), null);
    assert.equal(operatorCloseItemTransition({...own, execution_task_id: 'child'}, {rootId, standaloneMobileRun: true}), null);
    assert.equal(operatorCloseItemTransition({...own, execution_task_id: null}, {rootId, standaloneMobileRun: true}), null);
  }
  for (const status of ['completed', 'completed_with_warnings', 'failed', 'skipped', 'canceled', 'running', 'dispatched']) {
    assert.equal(operatorCloseItemTransition({status, task_id: rootId, execution_task_id: rootId},
      {rootId, standaloneMobileRun: true}), null, status);
  }
  assert.equal(operatorCloseAttemptTransition('needs_action'), 'failed');
  assert.equal(operatorCloseAttemptTransition('interrupted'), 'failed');
  for (const status of ['running', 'completed', 'failed', 'retryable', 'canceled']) {
    assert.equal(operatorCloseAttemptTransition(status), null, status);
  }
  assert.equal(operatorCloseChildTransition('needs_action'), 'failed');
  for (const status of ['interrupted', 'running', 'failed', 'superseded', 'completed']) {
    assert.equal(operatorCloseChildTransition(status), null, status);
  }
});

test('bulk ids are 1..100 UUIDs, lower-cased, de-duplicated and sorted', () => {
  const a = '6F1E1C8E-9F53-4F7E-9A55-1B9A0C3F0A11';
  const b = '0a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
  assert.deepEqual(normalizeOperatorCloseTaskIds([a, b, a.toLowerCase()]), [b, a.toLowerCase()]);
  assert.equal(normalizeOperatorCloseTaskIds([]), null);
  assert.equal(normalizeOperatorCloseTaskIds(['not-a-uuid']), null);
  assert.equal(normalizeOperatorCloseTaskIds(Array(101).fill(b)), null);
  assert.equal(normalizeOperatorCloseTaskIds('nope'), null);
});
