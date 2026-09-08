import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
const source = await readFile(new URL('../server/routes/capture-cloud.js', import.meta.url), 'utf8');
const start = source.indexOf('async function projectNegativePatrolSnapshot(');
const end = source.indexOf('async function projectOrchestrationChildControlOutcome', start);
for (const matched of [true, false]) {
  test(`terminal result replay preserves error only for the current assignment: ${matched}`, async () => {
    let excluded;
    const entry = {itemId: 'item', recordId: 'record', externalId: 'post', status: 'failed', error: {code: 'BLOGGER_METRICS_CAPTURE_FAILED'}};
    const context = vm.createContext({
      isTargetedPostTaskType: () => true,
      text: v => String(v || ''), safeJson: v => v || {},
      elasticParentAgentAttemptLimit: () => 8,
      isProfilePatrolTask: () => false,
      negativePatrolTargetResults: () => [entry],
      classifyCaptureRecoveryDisposition: () => ({automatic: false}),
      NEGATIVE_PATROL_SUCCESS_STATUSES: new Set(['completed']),
      NEGATIVE_PATROL_RESULT_STATUSES: new Set(['failed']),
      NEGATIVE_PATROL_TERMINAL_TASK_STATUSES: new Set(['needs_action']),
      buildElasticRecoveryMetadata: () => ({}),
      elasticRecoveryMetadataForItem: () => ({}),
      sanitizeCloudStructuredObject: v => v,
    });
    vm.runInContext(source.slice(start, end), context);
    await context.projectNegativePatrolSnapshot({
      queryOne: async (sql, params) => {
        if (sql.includes("metadata->'targetResult' = $8")) {
          assert.deepEqual(Array.from(params.slice(0, 7)), ['tenant','task','task','agent','item',3,'post']);
          return matched ? {id:'item'} : null;
        }
        return null; // unchanged UPDATE returns no row
      },
      queryAll: async (sql, params) => {
        if (sql.includes('AND NOT (id = ANY')) excluded = Array.from(params[4]);
        return [];
      },
    }, {id:'agent',tenant_id:'tenant'}, {
      id:'task', task_type:'negative_post_patrol',assigned_agent_id:'agent',orchestration_revision:3,
    }, {status:'needs_action'});
    assert.deepEqual(excluded, matched ? ['item'] : []);
  });
}
