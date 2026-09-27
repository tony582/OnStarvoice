import assert from 'node:assert/strict';
import test from 'node:test';

import {
  allocateKeywordRetryItems,
  buildKeywordRetryAssignments,
  keywordRetrySourceReleased,
  manualKeywordRetrySourceSettled,
} from '../web/admin/src/pages/dispatch/cloud-tasks/retry-item-allocation.js';

test('a preferred retry Agent falls back to another idle Agent after refresh', () => {
  const items = [{id: 'item-1'}, {id: 'item-2'}];
  const selectedAgent = {id: 'agent-selected'};
  const overrides = {'item-1': selectedAgent.id};

  const beforeRefresh = allocateKeywordRetryItems({
    items,
    candidates: [selectedAgent, {id: 'agent-auto'}],
    overrides,
  });
  assert.equal(beforeRefresh[0].overridden, true);
  assert.equal(beforeRefresh[0].preferenceFallback, false);
  assert.equal(beforeRefresh[0].agent?.id, selectedAgent.id);

  const afterRefresh = allocateKeywordRetryItems({
    items,
    candidates: [{id: 'agent-auto'}],
    overrides,
  });
  assert.equal(afterRefresh[0].overridden, false);
  assert.equal(afterRefresh[0].preferenceFallback, true);
  assert.equal(afterRefresh[0].agent?.id, 'agent-auto');
  assert.equal(
    afterRefresh.filter(allocation => Boolean(allocation.agent)).length,
    1,
  );
  assert.deepEqual(buildKeywordRetryAssignments({items, overrides}), [{
    itemId: 'item-1',
    agentId: selectedAgent.id,
  }]);
});

test('automatic retry skips every Agent that already ran the same keyword', () => {
  const items = [{id: 'item-1'}, {id: 'item-2'}];
  const allocation = allocateKeywordRetryItems({
    items,
    candidates: [
      {id: 'agent-1'},
      {id: 'agent-2'},
      {id: 'agent-3'},
    ],
    overrides: {'item-1': 'agent-1'},
    attemptedAgentIdsByItem: new Map([
      ['item-1', new Set(['agent-1', 'agent-2'])],
    ]),
  });

  assert.equal(allocation[0].agent?.id, 'agent-3');
  assert.equal(allocation[0].preferenceFallback, true);
  assert.equal(allocation[0].preferredAgentAlreadyAttempted, true);
  assert.equal(allocation[1].agent?.id, 'agent-1');
});

test('automatic previews are never serialized as strict assignments', () => {
  const items = [{id: 'item-1'}];
  const allocation = allocateKeywordRetryItems({
    items,
    candidates: [{id: 'agent-auto'}],
    overrides: {},
  });
  assert.equal(allocation[0].agent?.id, 'agent-auto');
  assert.equal(allocation[0].overridden, false);
  assert.deepEqual(buildKeywordRetryAssignments({items, overrides: {}}), []);
  assert.deepEqual(buildKeywordRetryAssignments({
    items,
    overrides: {
      'removed-item': 'agent-stale',
    },
  }), []);
});

// 09-27：F2 结算后，批次里还有原执行停在「需处理」（旧页面未确认停止）的关键词；
// 服务端人工重试闸门会因其中任何一条整单 409，管理端必须只提交已结算来源的关键词。
test('manual keyword retry only submits items whose source passes the server gate', () => {
  for (const status of ['completed', 'completed_with_warnings', 'completed_with_failures',
    'failed', 'canceled', 'skipped']) {
    assert.equal(manualKeywordRetrySourceSettled({status}), true, status);
  }
  for (const status of ['needs_action', 'interrupted', 'running', 'pending', 'superseded', '']) {
    assert.equal(manualKeywordRetrySourceSettled({status}), false, status);
  }
  assert.equal(manualKeywordRetrySourceSettled(null), false);
  const released = {status: 'superseded', metadata: {terminalReason: 'stop_fence_operator_released'}};
  assert.equal(manualKeywordRetrySourceSettled(released), true, 'operator confirmed the old page stopped');
  assert.equal(manualKeywordRetrySourceSettled({
    ...released, metadata: {...released.metadata, handoffSuccessorTaskId: 'successor'},
  }), false, 'a handoff successor owns the keywords');
  assert.equal(manualKeywordRetrySourceSettled({
    ...released, metadata: {...released.metadata, recoveryTaskId: 'recovery'},
  }), false, 'a recovery task owns the keywords');

  const fenced = {status: 'needs_action', error: {code: 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED'}};
  const settled = {status: 'completed_with_failures'};
  // Elastic pool: a failed keyword needs a settled source; a retryable one is
  // claimed by heartbeats and may leave a needs_action/interrupted source.
  assert.equal(keywordRetrySourceReleased({item: {status: 'failed'}, execution: settled, elasticPool: true}), true);
  assert.equal(keywordRetrySourceReleased({item: {status: 'needs_action'}, execution: fenced, elasticPool: true}), false);
  assert.equal(keywordRetrySourceReleased({item: {status: 'failed'}, execution: fenced, elasticPool: true}), false);
  assert.equal(keywordRetrySourceReleased({item: {status: 'retryable'}, execution: fenced, elasticPool: true}), true);
  assert.equal(keywordRetrySourceReleased({item: {status: 'retryable'}, execution: {status: 'running'},
    elasticPool: true}), false);
  // Fixed assignment: the manual gate applies to every status.
  assert.equal(keywordRetrySourceReleased({item: {status: 'retryable'}, execution: fenced}), false);
  assert.equal(keywordRetrySourceReleased({item: {status: 'failed'}, execution: {status: 'superseded'}}), false);
  assert.equal(keywordRetrySourceReleased({item: {status: 'failed'}, execution: settled}), true);
  assert.equal(keywordRetrySourceReleased({item: {status: 'failed'}, execution: undefined}), false);
});
