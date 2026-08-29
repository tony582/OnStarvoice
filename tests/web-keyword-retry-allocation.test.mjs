import assert from 'node:assert/strict';
import test from 'node:test';

import {
  allocateKeywordRetryItems,
  buildKeywordRetryAssignments,
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
