import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {
  classifyAiFailure,
  initialAiFailoverRoute,
  normalizeAiFailoverPolicy,
  transitionAiFailoverFailure,
  transitionAiFailoverProbe,
} from '../server/services/ai-failover.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function source(path) {
  return await readFile(resolve(repoRoot, path), 'utf8');
}

function policy(overrides = {}) {
  return normalizeAiFailoverPolicy({
    llm_failover_enabled: 'true',
    llm_failover_primary_model: 'deepseek-v4-flash',
    llm_failover_backup_model: 'deepseek-v4-pro',
    llm_failover_failure_threshold: '3',
    llm_failover_window_seconds: '120',
    llm_failover_pending_threshold: '1',
    llm_failover_recovery_probe_seconds: '300',
    llm_failover_recovery_success_threshold: '2',
    ...overrides,
  }, {
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
  });
}

function primaryState(overrides = {}) {
  return {
    route: 'primary',
    primaryModel: 'deepseek-v4-flash',
    backupModel: 'deepseek-v4-pro',
    consecutiveFailures: 0,
    failureWindowStartedAt: null,
    recoveryProbeSuccesses: 0,
    ...overrides,
  };
}

function overloadedError() {
  const error = new Error('Service is too busy');
  error.code = 'LLM_HTTP_ERROR';
  error.status = 503;
  return error;
}

test('failover policy is opt-in, DeepSeek-only and requires distinct models', () => {
  const enabled = policy();
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.failureThreshold, 3);
  assert.equal(enabled.failureWindowMs, 120000);
  assert.equal(enabled.recoveryProbeMs, 300000);

  assert.equal(normalizeAiFailoverPolicy({
    llm_failover_enabled: 'false',
    llm_failover_primary_model: 'a',
    llm_failover_backup_model: 'b',
  }, {provider: 'deepseek', model: 'a'}).enabled, false);

  const wrongProvider = normalizeAiFailoverPolicy({
    llm_failover_enabled: 'true',
    llm_failover_primary_model: 'a',
    llm_failover_backup_model: 'b',
  }, {provider: 'qianwen', model: 'a'});
  assert.equal(wrongProvider.enabled, false);
  assert.equal(wrongProvider.disabledReason, 'provider_not_deepseek');

  const sameModel = policy({llm_failover_backup_model: 'deepseek-v4-flash'});
  assert.equal(sameModel.enabled, false);
  assert.equal(sameModel.disabledReason, 'invalid_models');
});

test('enabling while the manually configured model is Pro preserves Pro first', () => {
  const activePolicy = normalizeAiFailoverPolicy({
    llm_failover_enabled: 'true',
    llm_failover_primary_model: 'deepseek-v4-flash',
    llm_failover_backup_model: 'deepseek-v4-pro',
  }, {
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
  });
  assert.equal(activePolicy.enabled, true);
  assert.equal(initialAiFailoverRoute(activePolicy), 'backup');
});

test('only retryable upstream, timeout, response and admission failures count', () => {
  assert.deepEqual(
    classifyAiFailure(overloadedError()),
    {
      status: 503,
      code: 'LLM_HTTP_ERROR',
      message: 'Service is too busy',
      retryable: true,
      retryCurrent: true,
      category: 'upstream_http',
    },
  );

  const queueTimeout = new Error('AI request queue timeout');
  queueTimeout.code = 'AI_ADMISSION_QUEUE_TIMEOUT';
  assert.equal(classifyAiFailure(queueTimeout).retryable, true);
  assert.equal(classifyAiFailure(queueTimeout).retryCurrent, false);

  const auth = new Error('Authentication failed');
  auth.code = 'LLM_HTTP_ERROR';
  auth.status = 401;
  assert.equal(classifyAiFailure(auth).retryable, false);
});

test('three failures within the window plus backlog switch to backup', () => {
  const activePolicy = policy();
  const failure = classifyAiFailure(overloadedError());
  const pressure = {pendingComments: 7, kind: 'comment_batch_classification'};
  let state = primaryState();
  const startedAt = new Date('2026-08-04T02:00:00.000Z');

  const first = transitionAiFailoverFailure({
    state,
    policy: activePolicy,
    failure,
    pressure,
    attemptedModel: 'deepseek-v4-flash',
    now: startedAt,
  });
  assert.equal(first.switched, false);
  assert.equal(first.state.consecutiveFailures, 1);
  state = first.state;

  const second = transitionAiFailoverFailure({
    state,
    policy: activePolicy,
    failure,
    pressure,
    attemptedModel: 'deepseek-v4-flash',
    now: new Date(startedAt.getTime() + 30000),
  });
  assert.equal(second.switched, false);
  state = second.state;

  const third = transitionAiFailoverFailure({
    state,
    policy: activePolicy,
    failure,
    pressure,
    attemptedModel: 'deepseek-v4-flash',
    now: new Date(startedAt.getTime() + 60000),
  });
  assert.equal(third.switched, true);
  assert.equal(third.state.route, 'backup');
  assert.equal(third.retryModel, 'deepseek-v4-pro');
  assert.equal(third.retryRoute, 'backup');
  assert.equal(third.retryCurrent, true);
  assert.equal(
    new Date(third.state.nextPrimaryProbeAt).getTime(),
    startedAt.getTime() + 60000 + 300000,
  );
});

test('failures without pressure do not switch, while Extension critical path does', () => {
  const readyToSwitch = primaryState({
    consecutiveFailures: 2,
    failureWindowStartedAt: new Date('2026-08-04T02:00:00.000Z'),
  });
  const failure = classifyAiFailure(overloadedError());
  const noPressure = transitionAiFailoverFailure({
    state: readyToSwitch,
    policy: policy(),
    failure,
    pressure: {kind: 'record_classification'},
    attemptedModel: 'deepseek-v4-flash',
    now: new Date('2026-08-04T02:01:00.000Z'),
  });
  assert.equal(noPressure.switched, false);

  const extension = transitionAiFailoverFailure({
    state: readyToSwitch,
    policy: policy(),
    failure,
    pressure: {kind: 'relevance_prefilter', criticalPath: true},
    attemptedModel: 'deepseek-v4-flash',
    now: new Date('2026-08-04T02:01:00.000Z'),
  });
  assert.equal(extension.switched, true);
  assert.equal(extension.pressureDetected, true);
});

test('pending threshold is evaluated across record and comment backlogs', () => {
  const readyToSwitch = primaryState({
    consecutiveFailures: 2,
    failureWindowStartedAt: new Date('2026-08-04T02:00:00.000Z'),
  });
  const transition = transitionAiFailoverFailure({
    state: readyToSwitch,
    policy: policy({llm_failover_pending_threshold: '3'}),
    failure: classifyAiFailure(overloadedError()),
    pressure: {pendingComments: 1, pendingRecords: 2},
    attemptedModel: 'deepseek-v4-flash',
    now: new Date('2026-08-04T02:01:00.000Z'),
  });
  assert.equal(transition.switched, true);
  assert.equal(transition.pressureDetected, true);
});

test('a stale primary request follows a concurrent backup switch without double counting', () => {
  const backupState = primaryState({
    route: 'backup',
    consecutiveFailures: 3,
    backupSince: new Date('2026-08-04T02:01:00.000Z'),
  });
  const transition = transitionAiFailoverFailure({
    state: backupState,
    policy: policy(),
    failure: classifyAiFailure(overloadedError()),
    pressure: {pendingComments: 9},
    attemptedModel: 'deepseek-v4-flash',
    now: new Date('2026-08-04T02:01:01.000Z'),
  });
  assert.equal(transition.switched, false);
  assert.equal(transition.state.consecutiveFailures, 3);
  assert.equal(transition.retryModel, 'deepseek-v4-pro');
  assert.equal(transition.retryRoute, 'backup');
  assert.equal(transition.retryCurrent, true);
});

test('two spaced successful primary probes recover; a failed probe resets progress', () => {
  const backup = primaryState({
    route: 'backup',
    consecutiveFailures: 3,
    backupSince: new Date('2026-08-04T02:00:00.000Z'),
  });
  const first = transitionAiFailoverProbe({
    state: backup,
    policy: policy(),
    succeeded: true,
    now: new Date('2026-08-04T02:05:00.000Z'),
  });
  assert.equal(first.recovered, false);
  assert.equal(first.state.route, 'backup');
  assert.equal(first.state.recoveryProbeSuccesses, 1);

  const failed = transitionAiFailoverProbe({
    state: first.state,
    policy: policy(),
    succeeded: false,
    now: new Date('2026-08-04T02:10:00.000Z'),
  });
  assert.equal(failed.state.recoveryProbeSuccesses, 0);

  const retryOne = transitionAiFailoverProbe({
    state: failed.state,
    policy: policy(),
    succeeded: true,
    now: new Date('2026-08-04T02:15:00.000Z'),
  });
  const recovered = transitionAiFailoverProbe({
    state: retryOne.state,
    policy: policy(),
    succeeded: true,
    now: new Date('2026-08-04T02:20:00.000Z'),
  });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.state.route, 'primary');
  assert.equal(recovered.state.consecutiveFailures, 0);
  assert.equal(recovered.state.backupSince, null);
});

test('integration keeps credentials out of failover state and preserves Extension fail-open', async () => {
  const [migration, service, labeler, serverIndex, adminRoute, adminPage, prefilter] = await Promise.all([
    source('server/db/migrations/056_ai_model_failover.sql'),
    source('server/services/ai-failover.js'),
    source('server/services/ai-labeler.js'),
    source('server/index.js'),
    source('server/routes/admin.js'),
    source('web/admin/src/pages/AdminPages.tsx'),
    source('server/services/relevance-prefilter.js'),
  ]);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS ai_failover_states/u);
  assert.match(migration, /route IN \('primary', 'backup'\)/u);
  assert.doesNotMatch(
    migration,
    /^\s*(?:api_key|credential|secret)\s+[A-Z]/imu,
  );
  assert.match(service, /pg_advisory_xact_lock/u);
  assert.match(service, /ai\.failover_activated/u);
  assert.match(service, /ai\.failover_recovered/u);
  assert.match(service, /\$1::uuid::text/u);
  assert.doesNotMatch(service, /'tenant', \$1::text/u);
  assert.match(labeler, /runModelOperationWithFailover/u);
  assert.match(labeler, /retrying current request on active backup/u);
  assert.match(labeler, /probeDeepSeekPrimaryModel/u);
  assert.match(serverIndex, /runAiFailoverRecoverySweep/u);
  assert.match(adminRoute, /getAiFailoverStatus/u);
  assert.match(
    adminRoute,
    /'ai\.failover_settings_updated', 'tenant', \$1::uuid::text/u,
  );
  assert.match(adminPage, /自动备用切换/u);
  assert.match(prefilter, /executionDisposition: 'collect_full'/u);
  assert.match(prefilter, /failOpen: true/u);
});
