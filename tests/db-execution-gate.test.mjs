import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDbExecutionGate,
  resolveDbExecutionBudget,
} from '../server/db/query.js';

test('database category budgets never exceed the per-process pool budget', () => {
  const budget = resolveDbExecutionBudget({
    NODE_ENV: 'production',
    PG_POOL_MAX: '20',
    PG_DATABASE_INSTANCE_COUNT: '2',
    PG_CRITICAL_CONCURRENCY: '4',
    PG_GENERAL_CONCURRENCY: '4',
    PG_REPORTING_CONCURRENCY: '2',
  });
  assert.deepEqual(budget, {
    processMax: 10,
    critical: 4,
    general: 4,
    reporting: 2,
  });
  assert.ok(
    budget.critical + budget.general + budget.reporting <= budget.processMax,
  );
});

test('a saturated general gate cannot consume the critical control slot', async () => {
  const general = createDbExecutionGate({
    category: 'general',
    limit: 1,
    maxQueue: 1,
    defaultWaitMs: 1000,
  });
  const critical = createDbExecutionGate({
    category: 'critical',
    limit: 1,
    maxQueue: 1,
    defaultWaitMs: 1000,
  });

  const releaseGeneral = await general.acquire();
  const queuedGeneral = general.acquire();
  await assert.rejects(
    general.acquire(),
    error => error?.code === 'DB_CAPACITY_UNAVAILABLE' &&
      error?.category === 'general' &&
      error?.reason === 'queue_full',
  );

  const releaseCritical = await critical.acquire();
  assert.deepEqual(critical.snapshot(), {
    category: 'critical',
    active: 1,
    queued: 0,
    limit: 1,
    maxQueue: 1,
  });
  releaseCritical();
  releaseGeneral();
  const releaseQueuedGeneral = await queuedGeneral;
  releaseQueuedGeneral();
});
