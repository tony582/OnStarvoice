import assert from 'node:assert/strict';
import test from 'node:test';

import {
  allocateKeywordRetryItems,
  buildKeywordRetryAssignments,
} from '../web/admin/src/pages/dispatch/cloud-tasks/retry-item-allocation.js';

test('a strict retry override survives candidate refresh and stays non-dispatchable', () => {
  const items = [{id: 'item-1'}, {id: 'item-2'}];
  const selectedAgent = {id: 'agent-selected'};
  const overrides = {'item-1': selectedAgent.id};

  const beforeRefresh = allocateKeywordRetryItems({
    items,
    candidates: [selectedAgent, {id: 'agent-auto'}],
    overrides,
  });
  assert.equal(beforeRefresh[0].overridden, true);
  assert.equal(beforeRefresh[0].strictWaiting, false);
  assert.equal(beforeRefresh[0].agent?.id, selectedAgent.id);

  const afterRefresh = allocateKeywordRetryItems({
    items,
    candidates: [{id: 'agent-auto'}],
    overrides,
  });
  assert.equal(afterRefresh[0].overridden, true);
  assert.equal(afterRefresh[0].strictWaiting, true);
  assert.equal(afterRefresh[0].agent, null);
  assert.equal(
    afterRefresh.filter(allocation => Boolean(allocation.agent)).length,
    1,
  );
  assert.deepEqual(buildKeywordRetryAssignments({items, overrides}), [{
    itemId: 'item-1',
    agentId: selectedAgent.id,
  }]);
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
