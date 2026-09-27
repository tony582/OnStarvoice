import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

import {
  OPERATOR_CLOSE_EXPLAINED_REASONS,
  OPERATOR_CLOSE_REASON_MESSAGES,
  OPERATOR_CLOSE_REASONS,
  loadOperatorCloseEligibility,
  normalizeOperatorCloseTaskIds,
  operatorCloseAttemptTransition,
  operatorCloseChildTransition,
  operatorCloseItemTransition,
  operatorClosedTask,
  operatorClosedTaskSql,
  operatorClosedWorkItem,
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

test('a closed work item stays out of automatic retry until an operator re-dispatches it', () => {
  const item = {status: 'failed', error: {code: 'XHS_SEARCH_PAGE_TIMEOUT', operatorClosed: true, originalStatus: 'needs_action'}};
  assert.equal(operatorClosedWorkItem(item), true);
  // 「重试失败关键词」 resets error on dispatch or queues it (retryable): no longer closed.
  for (const status of ['dispatched', 'retryable', 'running', 'completed', 'needs_action']) {
    assert.equal(operatorClosedWorkItem({...item, status}), false, status);
  }
  assert.equal(operatorClosedWorkItem({...item, error: {}}), false);
  assert.equal(operatorClosedWorkItem({...item, error: {operatorClosed: 'true'}}), false);
  assert.equal(operatorClosedWorkItem(null), false);

  const cloud = readFileSync(new URL('../server/routes/capture-cloud.js', import.meta.url), 'utf8');
  assert.match(cloud, /item => !\(automatic && operatorClosedWorkItem\(item\)\) &&/u,
    'dispatchCrossDeviceRetry skips it only for automatic (cron, duty) callers');
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

test('eligibility is one indexed statement per page: node probes are LATERAL, never the admission fence', async () => {
  const calls = [];
  const tx = {queryAll: async (sql, params) => {
    calls.push({sql, params});
    return [{id: params[1][0], reason: ''}, {id: params[1][1], reason: 'stop_fence'}];
  }};
  const a = '6f1e1c8e-9f53-4f7e-9a55-1b9a0c3f0a11';
  const b = '0a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
  const map = await loadOperatorCloseEligibility(tx, 'tenant', [a, b.toUpperCase(), 'nope', a]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, ['tenant', [a, b]]);
  assert.deepEqual(map.get(a), {eligible: true, reason: ''});
  assert.deepEqual(map.get(b), {eligible: false, reason: 'stop_fence'});
  const {sql} = calls[0];
  assert.match(sql, /WITH RECURSIVE task_tree AS/u);
  assert.match(sql, /CROSS JOIN LATERAL \(\s*SELECT[\s\S]*?FROM capture_task_items item\s+WHERE item\.task_id = tree\.id AND item\.tenant_id = \$1/u);
  assert.match(sql, /FROM capture_agent_commands command\s+WHERE command\.task_id = tree\.id/u);
  assert.match(sql, /FROM capture_discovery_run_candidates demand\s+WHERE demand\.tenant_id = \$1 AND demand\.run_id = tree\.id/u);
  assert.doesNotMatch(sql, /JOIN capture_tasks task ON task\.id = tree\.id/u,
    'task facts come from the recursion, not a second join the planner hashes over the tenant');
  assert.doesNotMatch(sql, /confirmed_stops|settled_runs|FOR UPDATE/u, 'no admission fence SQL, no locks');
  assert.equal((await loadOperatorCloseEligibility(tx, 'tenant', ['nope'])).size, 0);
  assert.equal(calls.length, 1, 'no statement without valid ids');
});

// Admin presentation: the card explains exactly the server's reasons, and
// only the server's eligibility shows the action.
const admin = await import('../web/admin/src/pages/dispatch/cloud-tasks/operator-close-presentation.mjs');

test('the Admin text for each explainable reason is the server message, one to one', () => {
  assert.deepEqual(Object.keys(admin.OPERATOR_CLOSE_BLOCKED_TEXT).sort(), [...OPERATOR_CLOSE_EXPLAINED_REASONS].sort());
  for (const reason of OPERATOR_CLOSE_EXPLAINED_REASONS) {
    assert.equal(admin.operatorCloseBlockedText(reason), OPERATOR_CLOSE_REASON_MESSAGES[reason], reason);
  }
  for (const reason of ['not_root', 'status_not_closeable', '', 'unknown', undefined]) {
    assert.equal(admin.operatorCloseBlockedText(reason), '', String(reason));
  }
  assert.match(admin.operatorCloseBlockedText('interrupted'), /节点上的旧页面可能仍在运行/u);
});

test('the Admin shows 「结束并移到历史」 only for a server-eligible needs_action root still in 需处理', () => {
  const eligible = {status: 'needs_action', parent_task_id: null, attention_dismissed_at: null,
    operator_close: {eligible: true, reason: ''}};
  assert.equal(admin.canOperatorClose(eligible), true);
  for (const variant of [
    {operator_close: undefined},
    {operator_close: {eligible: false, reason: 'stop_fence'}},
    {status: 'interrupted'},
    {status: 'failed'},
    {parent_task_id: 'parent'},
    {attention_dismissed_at: '2026-09-27T12:00:00Z'},
  ]) {
    assert.equal(admin.canOperatorClose({...eligible, ...variant}), false, JSON.stringify(variant));
  }
  assert.equal(admin.canOperatorClose(null), false);
  const fenced = {...eligible, operator_close: {eligible: false, reason: 'stop_fence'}};
  assert.match(admin.operatorCloseBlockedReason(fenced), /确认旧页面已停止/u);
  assert.match(admin.operatorCloseBlockedReason({...fenced, status: 'interrupted',
    operator_close: {eligible: false, reason: 'interrupted'}}), /任务被中断/u);
  for (const variant of [eligible, {...fenced, attention_dismissed_at: 'x'}, {...fenced, parent_task_id: 'p'},
    {...fenced, status: 'failed'}, {...fenced, operator_close: {eligible: false, reason: 'status_not_closeable'}},
    {...fenced, operator_close: undefined}]) {
    assert.equal(admin.operatorCloseBlockedReason(variant), '', JSON.stringify(variant));
  }
});

test('confirmation and result texts say nothing is re-captured and why rows were left', () => {
  const confirm = admin.operatorCloseConfirmText({title: '提前', task_type: 'capture'});
  assert.equal(confirm.split('\n')[0], '结束「提前」并移到历史？');
  assert.match(confirm, /不会重新采集，也不会向设备发送任何指令/u);
  assert.match(confirm, /已采集的内容、运行结果和执行记录全部保留/u);
  assert.match(confirm, /未完成的工作项会标记为失败，原状态和原因记录在任务详情里/u);
  assert.doesNotMatch(confirm, /重新处理/u);
  assert.match(admin.operatorCloseConfirmText({title: '手机发现作品补详情', task_type: 'discovered_post_capture'}),
    /该作品仍可在对应手机批次里「重新处理」。$/u);
  assert.equal(admin.operatorCloseBulkConfirmText(23),
    '将 23 个无法继续的任务结束并移到历史？不会重新采集，也不会给设备发指令；采集结果保留。');
  assert.equal(admin.operatorCloseBulkResultText({closedTaskIds: ['a', 'b'], alreadyClosedTaskIds: [], skipped: []}),
    '已结束 2 个任务并移到历史');
  assert.equal(admin.operatorCloseBulkResultText({closedTaskIds: ['a'], alreadyClosedTaskIds: ['c'],
    skipped: [{taskId: 'x', reason: 'stop_fence'}, {taskId: 'y', reason: 'live_item'}, {taskId: 'z', reason: 'live_child'}]}),
  '已结束 1 个任务并移到历史（另有 1 个此前已结束）；3 个未处理（待确认旧页面停止、仍有进行中的工作）');
});

test('history clear keeps the skipped rows selected and says why they stayed', () => {
  assert.deepEqual(admin.historyClearOutcome({clearedCount: 1, skipped: [{taskId: 'a', reason: 'live_work'},
    {taskId: 'b', reason: 'not_in_history'}]}), {
    keepSelectedIds: ['a', 'b'],
    notice: '已移出 1 条；2 条未移出：仍有未结束的工作或仍需处理',
  });
  assert.deepEqual(admin.historyClearOutcome({clearedCount: 3, skipped: [], message: '已从历史列表移除'}),
    {keepSelectedIds: [], notice: '已从历史列表移除'});
  assert.deepEqual(admin.historyClearOutcome({clearedCount: 2}),
    {keepSelectedIds: [], notice: '已清除 2 条历史记录，采集内容和运行结果已保留。'});
});
