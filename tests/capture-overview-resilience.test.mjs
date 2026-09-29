import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

import {
  CAPTURE_OVERVIEW_LAST_GOOD_MAX_AGE_MS,
  clearCaptureOverviewProjectionCache,
  loadCachedCaptureOverviewProjection,
  readLastGoodCaptureOverviewProjection,
} from '../server/routes/capture-cloud.js';

const routeSource = readFileSync(new URL('../server/routes/capture-cloud.js', import.meta.url), 'utf8');
const overviewRoute = routeSource.slice(
  routeSource.indexOf("router.get('/overview'"),
  routeSource.indexOf("router.patch('/agents/:id'"),
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {promise, resolve, reject};
}

const tenant = '33333333-3333-4333-8333-333333333333';
const otherTenant = '44444444-4444-4444-8444-444444444444';
const busy = () => Object.assign(new Error('canceling statement due to statement timeout'), {code: '57014'});

test('the last complete projection is kept per tenant and page size, for ninety seconds', async () => {
  clearCaptureOverviewProjectionCache({includeLastGood: true});
  let nowMs = 1_000;
  const now = () => nowMs;
  assert.equal(CAPTURE_OVERVIEW_LAST_GOOD_MAX_AGE_MS, 90_000);
  assert.equal(readLastGoodCaptureOverviewProjection({tenantId: tenant, limit: 100, now}), null);

  const projection = {agents: [{id: 'a'}], tasks: [{id: 't', status: 'running'}], taskSummary: {running_tasks: 1}};
  assert.equal(await loadCachedCaptureOverviewProjection({tenantId: tenant, limit: 100, now, loader: async () => projection}), projection);
  assert.deepEqual(readLastGoodCaptureOverviewProjection({tenantId: tenant, limit: 100, now}), {value: projection, ageMs: 0});
  assert.equal(readLastGoodCaptureOverviewProjection({tenantId: tenant, limit: 50, now}), null, 'another page size is another projection');
  assert.equal(readLastGoodCaptureOverviewProjection({tenantId: otherTenant, limit: 100, now}), null, 'never another tenant\'s');

  // A failed read neither replaces nor removes it.
  nowMs = 31_000;
  await assert.rejects(loadCachedCaptureOverviewProjection({tenantId: tenant, limit: 100, now, loader: async () => { throw busy(); }}), {code: '57014'});
  assert.deepEqual(readLastGoodCaptureOverviewProjection({tenantId: tenant, limit: 100, now}), {value: projection, ageMs: 30_000});

  // Writers clear the one-second cache so the next read is fresh; the last
  // complete projection stays for the case that this fresh read fails.
  clearCaptureOverviewProjectionCache();
  assert.equal(readLastGoodCaptureOverviewProjection({tenantId: tenant, limit: 100, now}).value, projection);
  let loads = 0;
  await loadCachedCaptureOverviewProjection({tenantId: tenant, limit: 100, now, loader: async () => { loads += 1; return projection; }});
  assert.equal(loads, 1, 'the clear did make the next read load');

  nowMs = 31_000 + 90_000;
  assert.equal(readLastGoodCaptureOverviewProjection({tenantId: tenant, limit: 100, now}).ageMs, 90_000);
  nowMs += 1;
  assert.equal(readLastGoodCaptureOverviewProjection({tenantId: tenant, limit: 100, now}), null, 'older than the bound is not an answer');
  clearCaptureOverviewProjectionCache({includeLastGood: true});
});

test('a slow read that started before a write never replaces the projection read after it', async () => {
  clearCaptureOverviewProjectionCache({includeLastGood: true});
  let nowMs = 10_000;
  const now = () => nowMs;
  const beforeWrite = deferred();
  const slow = loadCachedCaptureOverviewProjection({tenantId: tenant, limit: 100, now, loader: () => beforeWrite.promise});
  await Promise.resolve();

  // The operator closes the task; the route clears the cache; the page reads again.
  nowMs = 12_000;
  clearCaptureOverviewProjectionCache();
  const afterWrite = {agents: [], tasks: [{id: 't', status: 'failed'}], taskSummary: {attention_tasks: 0}};
  assert.equal(await loadCachedCaptureOverviewProjection({tenantId: tenant, limit: 100, now, loader: async () => afterWrite}), afterWrite);

  nowMs = 14_000;
  const stale = {agents: [], tasks: [{id: 't', status: 'needs_action'}], taskSummary: {attention_tasks: 1}};
  beforeWrite.resolve(stale);
  assert.equal(await slow, stale, 'its own caller still receives what it read');

  nowMs = 20_000;
  assert.deepEqual(readLastGoodCaptureOverviewProjection({tenantId: tenant, limit: 100, now}), {value: afterWrite, ageMs: 8_000},
    'the board never moves back to before the write');
  clearCaptureOverviewProjectionCache({includeLastGood: true});
});

test('the overview waits, bounds each statement and the whole projection, and answers from the last complete one', () => {
  assert.match(routeSource, /const CAPTURE_OVERVIEW_WAIT_TIMEOUT_MS = 1_500;/u);
  assert.match(routeSource, /const CAPTURE_OVERVIEW_STATEMENT_TIMEOUT_MS = 5_000;/u);
  assert.match(routeSource, /const CAPTURE_OVERVIEW_PROJECTION_BUDGET_MS = 8_000;/u);
  assert.match(overviewRoute, /category: 'reporting',\s+waitTimeoutMs: CAPTURE_OVERVIEW_WAIT_TIMEOUT_MS,\s+statementTimeoutMs: CAPTURE_OVERVIEW_STATEMENT_TIMEOUT_MS,\s+lockTimeoutMs: 100,\s+jitOff: true,/u);
  assert.match(overviewRoute, /const tx = traceReadExecutor\(transaction, trace, captureOverviewStatementLabel, \{\s+budgetMs: CAPTURE_OVERVIEW_PROJECTION_BUDGET_MS,\s+\}\);/u);
  assert.equal([...overviewRoute.matchAll(/withTransaction\(/gu)].length, 1, 'still one transaction on one reporting connection');

  // Only a transient database failure is answered from the last complete
  // projection, and that answer says so.
  assert.match(overviewRoute, /if \(!isTransientDatabaseReadError\(error\)\) throw error;\s+const lastGood = readLastGoodCaptureOverviewProjection\(\{tenantId: req\.tenantId, limit\}\);/u);
  assert.match(overviewRoute, /if \(!lastGood\) throw error;\s+projection = lastGood\.value;\s+projectionRead\.stale = true;\s+projectionRead\.staleAgeMs = lastGood\.ageMs;/u);
  assert.match(overviewRoute, /\.\.\.\(projectionRead\.stale\s+\? \{\s+stale: true,\s+staleAgeMs: projectionRead\.staleAgeMs,\s+retryAfterMs: projectionRead\.retryAfterMs,\s+\}\s+: \{\}\),/u);
  assert.match(overviewRoute, /if \(isTransientDatabaseReadError\(err\)\) \{[\s\S]{0,260}return res\.status\(503\)\.json\(\{\s+ok: false,\s+error: 'server_busy',\s+message: '任务看板查询繁忙，请稍后重试',/u);

  // The log line names statements and durations; parameters never reach it.
  assert.match(overviewRoute, /reportCaptureOverviewRead\(`failed:\$\{req\.tenantId\}`, '\[CaptureOverview\] projection failed', \{/u);
  assert.doesNotMatch(overviewRoute.slice(overviewRoute.indexOf('reportCaptureOverviewRead(`failed')), /params|req\.query|req\.body/u);
});

test('every statement of the overview has its own label', () => {
  const labelSource = routeSource.slice(
    routeSource.indexOf('function captureOverviewStatementLabel'),
    routeSource.indexOf('// One normal execution plus one different-Agent relay.'),
  );
  const label = new Function(`${labelSource}; return captureOverviewStatementLabel;`)();
  assert.equal(label('WITH task_load AS (SELECT 1) SELECT ca.id, ca.display_name FROM capture_agents ca'), 'agents');
  assert.equal(label('SELECT t.*, ca.display_name AS agent_display_name FROM capture_tasks t'), 'tasks');
  assert.equal(label('SELECT COUNT(*) FILTER (WHERE true) AS running_tasks FROM capture_tasks t'), 'task_summary');
  assert.equal(label('WITH RECURSIVE task_tree AS (SELECT 1), node_flags AS (SELECT 1) SELECT root.id'), 'operator_close');
  assert.equal(label('SELECT t.*, schedule.id AS orchestration_schedule_id FROM capture_orchestration_schedules schedule'), 'schedule_templates');
  assert.equal(label('SELECT ranked.* FROM (SELECT stop_fence.*, ROW_NUMBER() OVER (PARTITION BY stop_fence.agent_id) FROM x) ranked'), 'stop_fences');
  assert.equal(label('SELECT 1'), 'other');
  // The inline statements of the route are recognised by these same markers.
  for (const marker of ['WITH task_load AS', 'agent_display_name', 'AS running_tasks']) {
    assert.equal(overviewRoute.includes(marker), true, marker);
  }
});
