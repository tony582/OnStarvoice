import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {
  CAPTURE_RECOVERY_ACTIONS_GLOBAL_ENV,
  CAPTURE_RECOVERY_AGENT_SLOT_SOURCE_TYPE,
  CAPTURE_RECOVERY_FAST_ATTEMPT_LIMIT,
  CAPTURE_RECOVERY_LOCAL_CLOSURE_RECHECK_MS,
  CAPTURE_RECOVERY_MAX_GENERATIONS,
  CAPTURE_RECOVERY_VERIFY_DELAY_MS,
  CAPTURE_RECOVERY_WAITING_AGENT_BACKOFF_MS,
  buildCaptureRecoveryKey,
  buildCaptureRecoverySourceFingerprint,
  buildBoundedCaptureRecoveryHealth,
  captureRecoveryGenerationAvailableAt,
  claimCaptureRecoveryIntents,
  classifyCaptureRecoveryCandidate,
  enqueueCaptureRecoveryBackfillsForEnabledTenants,
  ingestCaptureRecoveryItem,
  normalizeCaptureRecoverySettings,
  processClaimedCaptureRecoveryIntent,
  processCaptureRecoveryIntentBatch,
  processCaptureRecoveryWakeups,
  renewCaptureRecoveryIntentLease,
  scanCaptureRecoveryBackfillPage,
  verifyCaptureRecoveryBusinessOutcome,
  wakeWaitingCaptureRecoveryIntents,
} from '../server/services/capture-recovery-intents.js';
import {
  processOpsControlWakeupBatch,
  startOpsControlWakeupRuntime,
} from '../server/services/ops-control-wakeup.js';

const tenantId = '10000000-0000-4000-8000-000000000001';
const itemId = '20000000-0000-4000-8000-000000000001';
const intentId = '30000000-0000-4000-8000-000000000001';
const sourceAttemptId = '40000000-0000-4000-8000-000000000001';
const leaseToken = '50000000-0000-4000-8000-000000000001';
const parentTaskId = '60000000-0000-4000-8000-000000000001';
const executionAttemptId = '70000000-0000-4000-8000-000000000001';
const recoveryTaskId = '80000000-0000-4000-8000-000000000001';
const recoveryCommandId = '90000000-0000-4000-8000-000000000001';
const recoveryAgentId = 'a0000000-0000-4000-8000-000000000001';
const recoveryAttemptId = 'b0000000-0000-4000-8000-000000000001';
const sourceAgentId = 'c0000000-0000-4000-8000-000000000001';
const sourceExecutionClientTaskId =
  'd0000000-0000-4000-8000-000000000001';
const sourceExecutionClientAttemptId =
  'e0000000-0000-4000-8000-000000000001';

function localClosureEvidence(overrides = {}) {
  return {
    version: 1,
    requestId: sourceExecutionClientTaskId,
    attemptId: sourceExecutionClientAttemptId,
    itemId,
    itemAttemptId: sourceAttemptId,
    attemptNumber: 3,
    assignmentRevision: 7,
    snapshotRevision: 12,
    terminalStatus: 'needs_action',
    terminalUpdatedAt: '2026-08-25T00:59:30.000Z',
    closedAt: '2026-08-25T00:59:45.000Z',
    terminalLedgerConfirmed: true,
    runnerTabCount: 0,
    platformTaskTabCount: 0,
    detailTaskTabCount: 0,
    ownedTaskTabCount: 0,
    executionLockPresent: false,
    debugSessionPresent: false,
    taskSessionPresent: false,
    taskOwnerPresent: false,
    pendingCheckpointReportCount: 0,
    businessUploadEvidenceKnown: true,
    streamingSyncDrainCompleted: true,
    capturedRecordCount: 0,
    streamingSyncEnabled: false,
    streamingSyncEnqueuedCount: 0,
    streamingSyncProcessedCount: 0,
    streamingSyncSuccessCount: 0,
    streamingSyncFailedCount: 0,
    streamingSyncSkippedCount: 0,
    streamingSyncPendingCount: 0,
    streamingSyncActiveCount: 0,
    streamingSyncRemainingCount: 0,
    streamingSyncBlocked: false,
    streamingSyncCanceled: false,
    ...overrides,
  };
}

function recoverySafetyClosureRow(overrides = {}) {
  return recoveryCandidateRow({
    intent_fault_class: 'platform_safety',
    intent_safety_handoff_count: 0,
    item_status: 'needs_action',
    item_attempt_count: 3,
    safety_handoff_count: 0,
    item_type: 'keyword',
    item_platform: 'douyin',
    parent_task_type: 'unattended_keyword_capture',
    source_platform_account_id: 'douyin-account-a',
    source_login_state: 'authenticated',
    error: {code: 'DOUYIN_SEARCH_SECURITY_CHALLENGE'},
    current_source_attempt_error: {
      code: 'DOUYIN_SEARCH_SECURITY_CHALLENGE',
      securityBlocked: true,
    },
    current_source_attempt_agent_id: sourceAgentId,
    execution_client_task_id: sourceExecutionClientTaskId,
    execution_attempt_client_attempt_id: sourceExecutionClientAttemptId,
    source_local_closure_snapshot_agent_id: sourceAgentId,
    source_local_closure_snapshot_status: 'needs_action',
    source_local_closure_snapshot_received_at: '2026-08-25T00:59:50.000Z',
    source_local_closure_snapshot_revision: 12,
    source_local_closure_evidence: localClosureEvidence(),
    ...overrides,
  });
}

function recoveryCandidateRow(overrides = {}) {
  return {
    id: intentId,
    generation: 1,
    intent_status: 'ready',
    intent_fault_class: 'extension_runtime',
    intent_stage: 'detail_capture',
    item_id: itemId,
    parent_task_id: parentTaskId,
    source_attempt_id: sourceAttemptId,
    source_execution_attempt_id: executionAttemptId,
    expected_assignment_revision: 7,
    expected_attempt_number: 3,
    window_ends_at: '2026-08-25T03:00:00.000Z',
    item_status: 'failed',
    item_attempt_count: 3,
    assignment_revision: 7,
    error: {code: 'CONTENT_RELAY_TIMEOUT', stage: 'detail_capture'},
    metadata: {},
    parent_status: 'running',
    parent_metadata: {},
    parent_orchestration_revision: 10,
    current_source_attempt_id: sourceAttemptId,
    current_source_attempt_number: 3,
    current_source_assignment_revision: 7,
    current_source_attempt_status: 'failed',
    current_source_attempt_checkpoint: {},
    current_source_attempt_result: {},
    current_source_attempt_error: {
      code: 'CONTENT_RELAY_TIMEOUT',
      stage: 'detail_capture',
    },
    current_execution_attempt_id: executionAttemptId,
    current_execution_attempt_number: 1,
    current_execution_attempt_status: 'failed',
    current_execution_attempt_checkpoint: {},
    current_execution_attempt_error: {},
    ...overrides,
  };
}

function verifyingRecoveryRow(overrides = {}) {
  const row = recoveryCandidateRow({
    id: intentId,
    generation: 1,
    intent_status: 'verifying_collection',
    recovery_task_id: recoveryTaskId,
    recovery_command_id: recoveryCommandId,
    recovery_agent_id: recoveryAgentId,
    dispatched_attempt_id: recoveryAttemptId,
    dispatched_at: '2026-08-25T01:00:00.000Z',
    execution_task_id: recoveryTaskId,
    item_assigned_agent_id: recoveryAgentId,
    ...overrides,
  });
  return {
    ...row,
    current_source_attempt_id: recoveryAttemptId,
    current_source_attempt_number: row.expected_attempt_number,
    current_source_assignment_revision: row.expected_assignment_revision,
    exact_dispatched_attempt_id: recoveryAttemptId,
    exact_dispatched_item_id: itemId,
    exact_dispatched_parent_task_id: parentTaskId,
    exact_dispatched_execution_task_id: recoveryTaskId,
    exact_dispatched_agent_id: recoveryAgentId,
    exact_dispatched_attempt_number: row.expected_attempt_number,
    exact_dispatched_assignment_revision: row.expected_assignment_revision,
    exact_recovery_task_id: recoveryTaskId,
    exact_recovery_parent_task_id: parentTaskId,
    exact_recovery_agent_id: recoveryAgentId,
    exact_recovery_task_metadata: {
      dutyRecovery: true,
      dutyRecoveryIntentId: intentId,
      dutyRecoveryGeneration: row.generation,
      dutyRecoverySourceItemId: itemId,
    },
    exact_recovery_command_id: recoveryCommandId,
    exact_recovery_command_task_id: recoveryTaskId,
    exact_recovery_command_agent_id: recoveryAgentId,
    exact_recovery_command_type: 'create',
    ...overrides,
  };
}

test('capture recovery remains globally and tenant disabled by default', () => {
  const defaults = normalizeCaptureRecoverySettings({}, {env: {}});
  assert.equal(defaults.globalEnabled, false);
  assert.equal(defaults.tenantEnabled, false);
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.mode, 'observe');
  assert.equal(defaults.actionsEnabled, false);
  assert.equal(defaults.guarded, false);

  const globalOnly = normalizeCaptureRecoverySettings({}, {
    env: {OPS_CONTROL_RECOVERY_GLOBAL_ENABLED: 'true'},
  });
  assert.equal(globalOnly.enabled, false);

  const observed = normalizeCaptureRecoverySettings({
    ops_control_recovery_enabled: 'true',
    ops_control_recovery_mode: 'guarded',
  }, {env: {OPS_CONTROL_RECOVERY_GLOBAL_ENABLED: 'true'}});
  assert.equal(observed.enabled, true);
  assert.equal(observed.mode, 'guarded');
  assert.equal(observed.actionsEnabled, false);
  assert.equal(observed.actionsGlobalEnabled, false);

  const fullyGuarded = normalizeCaptureRecoverySettings({
    ops_control_recovery_enabled: 'true',
    ops_control_recovery_mode: 'guarded',
  }, {
    env: {
      OPS_CONTROL_RECOVERY_GLOBAL_ENABLED: 'true',
      [CAPTURE_RECOVERY_ACTIONS_GLOBAL_ENV]: 'true',
    },
  });
  assert.equal(fullyGuarded.enabled, true);
  assert.equal(fullyGuarded.actionsGlobalEnabled, true);
  assert.equal(fullyGuarded.actionsEnabled, true);
  assert.equal(fullyGuarded.guarded, true);

  const observeMode = normalizeCaptureRecoverySettings({
    ops_control_recovery_enabled: 'true',
    ops_control_recovery_mode: 'observe',
  }, {
    env: {
      OPS_CONTROL_RECOVERY_GLOBAL_ENABLED: 'true',
      [CAPTURE_RECOVERY_ACTIONS_GLOBAL_ENV]: 'true',
    },
  });
  assert.equal(observeMode.actionsEnabled, false);
});

test('capture recovery backfill scans one tenant with a stable cursor page', async () => {
  const secondItemId = '20000000-0000-4000-8000-000000000002';
  const thirdItemId = '20000000-0000-4000-8000-000000000003';
  let sql = '';
  let params = [];
  const page = await scanCaptureRecoveryBackfillPage({
    tenantId,
    cursor: {
      cutoffCreatedAt: '2026-08-25T02:00:00.000Z',
      afterCreatedAt: '2026-08-25T00:30:00.000Z',
      afterId: '20000000-0000-4000-8000-000000000000',
    },
    limit: 2,
    queryAll: async (statement, values) => {
      sql = statement;
      params = values;
      return [
        {
          item_id: itemId,
          status: 'retryable',
          assignment_revision: 2,
          attempt_count: 1,
          created_at: '2026-08-25T01:00:00.000Z',
        },
        {
          item_id: secondItemId,
          status: 'failed',
          assignment_revision: 3,
          attempt_count: 2,
          created_at: '2026-08-25T01:01:00.000Z',
        },
        {
          item_id: thirdItemId,
          status: 'needs_action',
          assignment_revision: 4,
          attempt_count: 3,
          created_at: '2026-08-25T01:02:00.000Z',
        },
      ];
    },
  });
  assert.match(sql, /WHERE item\.tenant_id = \$1/u);
  assert.match(sql, /item\.status = ANY\(\$2::text\[\]\)/u);
  assert.match(
    sql,
    /\(item\.created_at, item\.id\) > \(\$4::timestamptz, \$5::uuid\)/u,
  );
  assert.doesNotMatch(sql, /OFFSET/u);
  assert.deepEqual(params.slice(0, 2), [
    tenantId,
    ['retryable', 'needs_action', 'failed'],
  ]);
  assert.equal(params[2], '2026-08-25T02:00:00.000Z');
  assert.equal(params[3], '2026-08-25T00:30:00.000Z');
  assert.equal(params[4], '20000000-0000-4000-8000-000000000000');
  assert.equal(params[5], 3, 'one extra row proves that another page exists');
  assert.deepEqual(page.itemIds, [itemId, secondItemId]);
  assert.equal(page.hasMore, true);
  assert.deepEqual(page.nextCursor, {
    version: 1,
    cutoffCreatedAt: '2026-08-25T02:00:00.000Z',
    afterCreatedAt: '2026-08-25T01:01:00.000Z',
    afterId: secondItemId,
  });
});

test('global recovery startup backfills enabled tenants only when the global gate is on', async () => {
  let disabledQueries = 0;
  let disabledEnqueues = 0;
  const disabled = await enqueueCaptureRecoveryBackfillsForEnabledTenants({
    env: {OPS_CONTROL_RECOVERY_GLOBAL_ENABLED: 'false'},
    queryAll: async () => { disabledQueries += 1; return []; },
    enqueueWakeup: async () => { disabledEnqueues += 1; },
  });
  assert.equal(disabled.kind, 'global_disabled');
  assert.equal(disabledQueries, 0);
  assert.equal(disabledEnqueues, 0);

  const secondTenantId = '10000000-0000-4000-8000-000000000002';
  const enqueued = [];
  const enabled = await enqueueCaptureRecoveryBackfillsForEnabledTenants({
    env: {OPS_CONTROL_RECOVERY_GLOBAL_ENABLED: 'true'},
    now: new Date('2026-08-25T01:00:00.000Z'),
    queryAll: async (sql, params) => {
      assert.match(sql, /FROM tenant_settings setting/u);
      assert.match(sql, /tenant\.status <> 'deleted'/u);
      assert.equal(params[0], 'ops_control_recovery_enabled');
      assert.deepEqual(params[1], ['1', 'true', 'on', 'yes']);
      return [{tenant_id: tenantId}, {tenant_id: secondTenantId}];
    },
    enqueueWakeup: async wakeup => {
      enqueued.push(wakeup);
      return enqueued.length;
    },
  });
  assert.equal(enabled.kind, 'enqueued');
  assert.equal(enabled.tenants, 2);
  assert.equal(enqueued.length, 2);
  for (const wakeup of enqueued) {
    assert.equal(wakeup.reason, 'capture_recovery_backfill');
    assert.equal(wakeup.sourceType, 'capture_recovery_backfill');
    assert.equal(wakeup.dedupeKey, 'capture-recovery-backfill:root');
    assert.equal(wakeup.payload.cursor, null);
    assert.equal(wakeup.payload.trigger, 'global_enable_startup');
    assert.equal(wakeup.payload.observeOnly, true);
    assert.equal(wakeup.replaceAvailable, false);
  }
});

test('candidate classification separates Extension, network, safety and user-stop boundaries', () => {
  const dom = classifyCaptureRecoveryCandidate({
    status: 'failed',
    attempt_count: 3,
    error: {code: 'DOUYIN_DETAIL_NOT_READY', stage: 'detail_capture'},
  });
  assert.equal(dom.eligible, true);
  assert.equal(dom.stage, 'detail_capture');
  assert.equal(dom.faultClass, 'extension_dom_contract');
  assert.equal(dom.terminalStatus, null);

  const runtime = classifyCaptureRecoveryCandidate({
    status: 'retryable',
    attempt_count: 3,
    error: {code: 'CONTENT_RELAY_TIMEOUT', stage: 'comments'},
  });
  assert.equal(runtime.faultClass, 'extension_runtime');
  assert.equal(runtime.stage, 'comments');

  const network = classifyCaptureRecoveryCandidate({
    status: 'failed',
    attempt_count: 3,
    error: {code: 'REQUEST_TIMEOUT', category: 'api_timeout'},
  });
  assert.equal(network.faultClass, 'network_local');

  for (const code of [
    'CAPTURE_TASK_UNEXPECTED_CANCELLATION',
    'EXTENSION_RUNTIME_RESTARTED',
    'RUNTIME_ERROR',
    'TASK_RUN_ERROR',
  ]) {
    assert.equal(
      classifyCaptureRecoveryCandidate({
        status: 'failed',
        attempt_count: 3,
        error: {code},
      })
        .faultClass,
      'extension_runtime',
      code,
    );
  }
  assert.equal(
    classifyCaptureRecoveryCandidate({
      status: 'failed',
      attempt_count: 3,
      error: {code: 'STALE_TASK_HEARTBEAT_TIMEOUT'},
    }).faultClass,
    'agent_control_plane',
  );
  assert.equal(
    classifyCaptureRecoveryCandidate({
      status: 'failed',
      attempt_count: 3,
      error: {code: 'TIMEOUT'},
    })
      .faultClass,
    'network_local',
  );

  const safety = classifyCaptureRecoveryCandidate({
    status: 'needs_action',
    error: {code: 'DOUYIN_SEARCH_SECURITY_CHALLENGE'},
  });
  assert.equal(safety.eligible, true);
  assert.equal(safety.terminalStatus, 'waiting_human');
  assert.equal(safety.decision, 'human_required');

  const firstAllowlistedSearchChallenge = classifyCaptureRecoveryCandidate({
    status: 'needs_action',
    attempt_count: 19,
    safety_handoff_count: 0,
    item_type: 'keyword',
    item_platform: 'douyin',
    parent_task_type: 'unattended_keyword_capture',
    source_platform_account_id: 'douyin-account-a',
    source_login_state: 'authenticated',
    error: {code: 'DOUYIN_SEARCH_SECURITY_CHALLENGE'},
  });
  assert.equal(firstAllowlistedSearchChallenge.eligible, true);
  assert.equal(firstAllowlistedSearchChallenge.terminalStatus, null);
  assert.equal(firstAllowlistedSearchChallenge.decision, 'observe');
  assert.equal(
    firstAllowlistedSearchChallenge.reason,
    'platform_safety_waiting_local_closure',
  );
  assert.equal(firstAllowlistedSearchChallenge.waitingForLocalClosure, true);
  assert.equal(
    firstAllowlistedSearchChallenge.safetyHandoff.automaticEligible,
    false,
  );
  assert.equal(
    firstAllowlistedSearchChallenge.safetyHandoff.safetyHandoffCount,
    0,
  );

  const firstChallengeWithClosure = classifyCaptureRecoveryCandidate({
    status: 'needs_action',
    safety_handoff_count: 0,
    item_type: 'keyword',
    item_platform: 'douyin',
    parent_task_type: 'unattended_keyword_capture',
    source_platform_account_id: 'douyin-account-a',
    source_login_state: 'authenticated',
    source_local_closure_proven: true,
    error: {code: 'DOUYIN_SEARCH_SECURITY_CHALLENGE'},
  });
  assert.equal(firstChallengeWithClosure.terminalStatus, null);
  assert.equal(firstChallengeWithClosure.reason, 'platform_safety_handoff_candidate');
  assert.equal(firstChallengeWithClosure.safetyHandoff.automaticEligible, true);

  const failedClosureProof = classifyCaptureRecoveryCandidate({
    status: 'needs_action',
    safety_handoff_count: 0,
    item_type: 'keyword',
    item_platform: 'douyin',
    parent_task_type: 'unattended_keyword_capture',
    source_platform_account_id: 'douyin-account-a',
    source_login_state: 'authenticated',
    source_local_closure_proof_failed: true,
    error: {code: 'DOUYIN_SEARCH_SECURITY_CHALLENGE'},
  });
  assert.equal(failedClosureProof.terminalStatus, 'waiting_human');
  assert.equal(
    failedClosureProof.reason,
    'platform_safety_local_closure_proof_failed',
  );

  const secondAllowlistedSearchChallenge = classifyCaptureRecoveryCandidate({
    status: 'retryable',
    attempt_count: 1,
    safety_handoff_count: 1,
    item_type: 'keyword',
    item_platform: 'douyin',
    parent_task_type: 'unattended_keyword_capture',
    source_platform_account_id: 'douyin-account-b',
    source_login_state: 'authenticated',
    error: {code: 'DOUYIN_SEARCH_SECURITY_CHALLENGE'},
  });
  assert.equal(secondAllowlistedSearchChallenge.terminalStatus, 'waiting_human');
  assert.equal(
    secondAllowlistedSearchChallenge.safetyHandoff.reason,
    'safety_handoff_already_used',
  );

  const invalidSourceLogin = classifyCaptureRecoveryCandidate({
    status: 'needs_action',
    safety_handoff_count: 0,
    item_type: 'keyword',
    item_platform: 'douyin',
    parent_task_type: 'unattended_keyword_capture',
    source_platform_account_id: 'douyin-account-a',
    source_login_state: 'expired',
    source_local_closure_proven: true,
    error: {code: 'DOUYIN_SEARCH_SECURITY_CHALLENGE'},
  });
  assert.equal(invalidSourceLogin.terminalStatus, 'waiting_human');
  assert.equal(
    invalidSourceLogin.safetyHandoff.reason,
    'source_login_not_authenticated',
  );

  const humanBoundaries = [
    ['item_error', {
      error: {code: 'NEW_PLATFORM_CHALLENGE', requiresManualAction: true},
    }],
    ['item_checkpoint', {
      metadata: {
        checkpoint: {errorCode: 'NEW_PLATFORM_CHALLENGE', securityBlocked: true},
      },
    }],
    ['source_attempt_error', {
      source_attempt_error: {
        code: 'NEW_PLATFORM_CHALLENGE',
        platformSafetyBlocked: true,
      },
    }],
    ['source_attempt_checkpoint', {
      source_attempt_checkpoint: {
        errorCode: 'NEW_PLATFORM_CHALLENGE',
        requires_manual_action: true,
      },
    }],
    ['execution_attempt_error', {
      execution_attempt_error: {
        code: 'NEW_PLATFORM_CHALLENGE',
        security_blocked: true,
      },
    }],
    ['execution_attempt_checkpoint', {
      execution_attempt_checkpoint: {
        errorCode: 'NEW_PLATFORM_CHALLENGE',
        securityEvidence: {confirmed: true},
      },
    }],
  ];
  for (const [boundary, evidence] of humanBoundaries) {
    const layeredSafety = classifyCaptureRecoveryCandidate({
      status: 'needs_action',
      error: {},
      ...evidence,
    });
    assert.equal(layeredSafety.eligible, true, boundary);
    assert.equal(layeredSafety.faultClass, 'platform_safety', boundary);
    assert.equal(layeredSafety.terminalStatus, 'waiting_human', boundary);
    assert.equal(layeredSafety.decision, 'human_required', boundary);
    assert.equal(layeredSafety.code, '', boundary);
  }

  const stopped = classifyCaptureRecoveryCandidate({
    status: 'canceled',
    error: {code: 'USER_CANCELED'},
  });
  assert.equal(stopped.eligible, false);
  assert.equal(stopped.terminalStatus, 'stopped_by_user');
  assert.equal(stopped.decision, 'stop');

  const completed = classifyCaptureRecoveryCandidate({status: 'completed'});
  assert.equal(completed.eligible, false);
  assert.equal(completed.terminalStatus, 'resolved');
});

test('an exhausted local retry marker opens duty recovery without weakening stop or safety boundaries', () => {
  for (const code of [
    'UNATTENDED_RECOVERY_EXHAUSTED',
    'UNATTENDED_RECOVERY_LAUNCH_EXHAUSTED',
  ]) {
    const exhausted = classifyCaptureRecoveryCandidate({
      status: 'failed',
      attempt_count: 1,
      error: {
        code,
        fastRetryExhausted: true,
        failureOrigin: 'extension_runtime',
      },
    });
    assert.equal(exhausted.eligible, true, code);
    assert.equal(exhausted.faultClass, 'extension_runtime', code);
    assert.equal(exhausted.reason, 'observe_candidate', code);
    assert.equal(exhausted.fastBudget.exhausted, true, code);
    assert.equal(exhausted.fastBudget.explicitExhausted, true, code);
  }

  const transient = classifyCaptureRecoveryCandidate({
    status: 'failed',
    attempt_count: 1,
    error: {code: 'CONTENT_RELAY_TIMEOUT'},
  });
  assert.equal(transient.eligible, false);
  assert.equal(transient.reason, 'fast_recovery_budget_available');

  const stopped = classifyCaptureRecoveryCandidate({
    status: 'canceled',
    attempt_count: 1,
    error: {
      code: 'USER_CANCELED',
      fastRetryExhausted: true,
      failureOrigin: 'extension_runtime',
    },
  });
  assert.equal(stopped.eligible, false);
  assert.equal(stopped.terminalStatus, 'stopped_by_user');

  const safety = classifyCaptureRecoveryCandidate({
    status: 'needs_action',
    attempt_count: 1,
    error: {
      code: 'DOUYIN_SEARCH_CAPTCHA_REQUIRED',
      fastRetryExhausted: true,
      failureOrigin: 'extension_runtime',
    },
  });
  assert.equal(safety.faultClass, 'platform_safety');
  assert.equal(safety.terminalStatus, 'waiting_human');
  assert.equal(safety.decision, 'human_required');
});

test('a first cloud item with exhausted local retries creates a ready recovery intent', async () => {
  for (const code of [
    'UNATTENDED_RECOVERY_EXHAUSTED',
    'UNATTENDED_RECOVERY_LAUNCH_EXHAUSTED',
  ]) {
    let persistedEvidence = null;
    const result = await ingestCaptureRecoveryItem({
      tenantId,
      itemId,
      now: new Date('2026-08-25T01:00:00.000Z'),
      withTransaction: async callback => callback({
        execute: async () => 1,
        queryAll: async () => [],
        queryOne: async (sql, params) => {
          if (/FROM capture_task_items item/u.test(sql)) {
            return {
              item_id: itemId,
              tenant_id: tenantId,
              parent_task_id: parentTaskId,
              source_attempt_id: sourceAttemptId,
              source_attempt_number: 1,
              execution_attempt_id: executionAttemptId,
              execution_attempt_number: 4,
              status: 'failed',
              attempt_count: 1,
              assignment_revision: 1,
              error: {
                code,
                fastRetryExhausted: true,
                failureOrigin: 'extension_runtime',
              },
              metadata: {},
              parent_metadata: {},
              parent_created_at: '2026-08-25T00:00:00.000Z',
            };
          }
          if (/source_fingerprint = \$2/u.test(sql)) return null;
          if (/ORDER BY generation DESC/u.test(sql)) return null;
          if (/INSERT INTO capture_recovery_intents/u.test(sql)) {
            persistedEvidence = JSON.parse(params[16]);
            return {
              id: intentId,
              generation: 1,
              status: 'ready',
              decision: 'none',
            };
          }
          assert.fail(`unexpected SQL for ${code}: ${sql}`);
        },
      }),
    });
    assert.equal(result.kind, 'created', code);
    assert.equal(result.intent.status, 'ready', code);
    assert.equal(result.classification.eligible, true, code);
    assert.equal(result.classification.faultClass, 'extension_runtime', code);
    assert.equal(result.classification.fastBudget.explicitExhausted, true, code);
    assert.equal(persistedEvidence.fastBudget.explicitExhausted, true, code);
    assert.equal(persistedEvidence.fastBudget.attemptCount, 1, code);
  }
});

test('recovery error codes use a closed business-code namespace', () => {
  const known = classifyCaptureRecoveryCandidate({
    status: 'retryable',
    error: {code: 'CONTENT_RELAY_TIMEOUT'},
  });
  assert.equal(known.code, 'CONTENT_RELAY_TIMEOUT');

  for (const value of [
    'AKIAIOSFODNN7EXAMPLE',
    'prod-db.internal',
    '192.168.1.7',
    'customer_13800138000',
    ['xoxb', '123456789012', '123456789012', 'abcdefghijklmnop'].join('-'),
    ['glpat', 'abcdefghijklmnopqrst'].join('-'),
    'CAPTURE_XOXB_123456789012_123456789012_ABCDEFGHIJKLMNOP',
    'NETWORK_GLPAT_ABCDEFGHIJKLMNOPQRST',
    'NEW_PLATFORM_CHALLENGE',
  ]) {
    const classified = classifyCaptureRecoveryCandidate({
      status: 'failed',
      error: {code: value},
    });
    assert.equal(classified.code, 'UNKNOWN', value);
    assert.equal(JSON.stringify(classified).includes(value), false, value);
  }
});

test('unknown error codes persist only as UNKNOWN in recovery evidence', async () => {
  const credential =
    'CAPTURE_XOXB_123456789012_123456789012_ABCDEFGHIJKLMNOP';
  let persistedEvidence = null;
  const result = await ingestCaptureRecoveryItem({
    tenantId,
    itemId,
    now: new Date('2026-08-25T01:00:00.000Z'),
    withTransaction: async callback => callback({
      execute: async () => 1,
      queryAll: async () => [],
      queryOne: async (sql, params) => {
        if (/FROM capture_task_items item/u.test(sql)) {
          return {
            item_id: itemId,
            tenant_id: tenantId,
            parent_task_id: '60000000-0000-4000-8000-000000000001',
            status: 'failed',
            attempt_count: 3,
            assignment_revision: 1,
            error: {code: credential, stage: 'detail_capture'},
            metadata: {},
            parent_metadata: {},
            parent_created_at: '2026-08-25T00:00:00.000Z',
          };
        }
        if (/source_fingerprint = \$2/u.test(sql)) return null;
        if (/ORDER BY generation DESC/u.test(sql)) return null;
        if (/INSERT INTO capture_recovery_intents/u.test(sql)) {
          persistedEvidence = JSON.parse(params[16]);
          return {id: intentId, generation: 1, status: 'ready'};
        }
        assert.fail(`unexpected SQL: ${sql}`);
      },
    }),
  });
  assert.equal(result.kind, 'created');
  assert.equal(result.classification.code, 'UNKNOWN');
  assert.equal(persistedEvidence.errorCode, 'UNKNOWN');
  assert.equal(JSON.stringify(persistedEvidence).includes(credential), false);
});

test('ingest requeues the same safety fingerprint when its authoritative closure snapshot arrives', async () => {
  const statements = [];
  const result = await ingestCaptureRecoveryItem({
    tenantId,
    itemId,
    now: new Date('2026-08-25T01:00:00.000Z'),
    withTransaction: async callback => callback({
      execute: async () => 1,
      queryAll: async () => [],
      queryOne: async (sql, params) => {
        statements.push({sql, params});
        if (/FROM capture_task_items item/u.test(sql)) {
          assert.match(sql, /FROM capture_task_snapshots snapshot/u);
          assert.match(sql, /snapshot\.attempt_id = execution_attempt\.id/u);
          assert.match(
            sql,
            /snapshot\.client_task_id = execution_task\.client_task_id/u,
          );
          assert.match(
            sql,
            /snapshot\.client_attempt_id = execution_attempt\.client_attempt_id/u,
          );
          assert.doesNotMatch(
            sql,
            /snapshot\.metadata->'localClosure' IS NOT NULL/u,
            'the latest terminal snapshot must be authoritative even when it has no proof',
          );
          return {
            ...recoverySafetyClosureRow(),
            status: 'needs_action',
            source_attempt_number: 3,
            source_attempt_agent_id: sourceAgentId,
            execution_attempt_id: executionAttemptId,
            execution_attempt_number: 1,
          };
        }
        if (/source_fingerprint = \$2/u.test(sql)) {
          return {
            id: intentId,
            status: 'waiting_due',
            action_count: 0,
          };
        }
        if (/SET status = 'ready'/u.test(sql)) {
          return {
            id: intentId,
            status: 'ready',
            decision: 'none',
          };
        }
        assert.fail(`unexpected SQL: ${sql}`);
      },
    }),
  });
  assert.equal(result.kind, 'local_closure_proven_requeued');
  assert.equal(result.intent.status, 'ready');
  const requeue = statements.find(entry => /SET status = 'ready'/u.test(entry.sql));
  assert.ok(requeue);
  assert.match(requeue.sql, /action_count = 0/u);
  assert.match(requeue.sql, /status IN \('ready', 'waiting_due', 'waiting_agent'\)/u);
});

test('guarded recovery keeps a first search challenge reevaluable while local closure proof is pending', async () => {
  let dispatchCalls = 0;
  const updates = [];
  const current = recoveryCandidateRow({
    intent_fault_class: 'platform_safety',
    intent_safety_handoff_count: 0,
    item_status: 'retryable',
    item_attempt_count: 19,
    safety_handoff_count: 0,
    item_type: 'keyword',
    item_platform: 'douyin',
    parent_task_type: 'unattended_keyword_capture',
    source_platform_account_id: 'douyin-account-a',
    source_login_state: 'authenticated',
    error: {code: 'DOUYIN_SEARCH_SECURITY_CHALLENGE'},
    current_source_attempt_error: {
      code: 'DOUYIN_SEARCH_SECURITY_CHALLENGE',
      securityBlocked: true,
    },
  });
  const settled = await processClaimedCaptureRecoveryIntent({
    tenantId,
    intent: {id: intentId, generation: 1, status: 'ready'},
    leaseToken,
    now: new Date('2026-08-25T01:00:00.000Z'),
    policy: {mode: 'guarded', actionsEnabled: true},
    dispatchRecovery: async input => {
      dispatchCalls += 1;
      assert.fail(`unexpected safety dispatch: ${JSON.stringify(input)}`);
    },
    queryOne: async (sql, params) => {
      if (/FROM capture_recovery_intents intent/u.test(sql)) return current;
      updates.push({sql, params});
      return {
        id: intentId,
        status: params[3],
        decision: params[4],
        decision_payload: JSON.parse(params[5]),
        verification: JSON.parse(params[6]),
        available_at: params[8],
      };
    },
  });
  assert.equal(settled.status, 'waiting_due');
  assert.equal(settled.decision, 'observe');
  assert.equal(settled.decision_payload.redHumanNotification, false);
  assert.equal(dispatchCalls, 0);
  assert.equal(updates[0].params[3], 'waiting_due');
  assert.equal(
    settled.verification.reason,
    'platform_safety_waiting_local_closure',
  );
  assert.equal(
    new Date(settled.available_at).toISOString(),
    new Date(
      Date.parse('2026-08-25T01:00:00.000Z')
        + CAPTURE_RECOVERY_LOCAL_CLOSURE_RECHECK_MS,
    ).toISOString(),
  );
  assert.doesNotMatch(updates[0].sql, /attempt_count/u);
});

test('an authoritative exact-attempt closure proof enables one safety handoff dispatch', async () => {
  const calls = [];
  const settled = await processClaimedCaptureRecoveryIntent({
    tenantId,
    intent: {id: intentId, generation: 1, status: 'ready'},
    leaseToken,
    now: new Date('2026-08-25T01:00:00.000Z'),
    policy: {mode: 'guarded', actionsEnabled: true},
    dispatchRecovery: async input => {
      calls.push(input);
      return {
        child: {id: recoveryTaskId},
        command: {id: recoveryCommandId},
        agent: {id: recoveryAgentId},
        itemAttempts: [{
          id: recoveryAttemptId,
          itemId,
          executionTaskId: recoveryTaskId,
          agentId: recoveryAgentId,
          attemptNumber: 4,
          assignmentRevision: 11,
          status: 'dispatched',
        }],
      };
    },
    queryOne: async (sql, params) => {
      if (/FROM capture_recovery_intents intent/u.test(sql)) {
        assert.match(sql, /FROM capture_task_snapshots snapshot/u);
        assert.match(sql, /snapshot\.task_id = item\.execution_task_id/u);
        assert.match(sql, /snapshot\.attempt_id = current_execution_attempt\.id/u);
        assert.match(sql, /snapshot\.agent_id = current_item_attempt\.agent_id/u);
        assert.match(
          sql,
          /snapshot\.client_task_id = source_execution_task\.client_task_id/u,
        );
        assert.match(
          sql,
          /snapshot\.client_attempt_id =\s*current_execution_attempt\.client_attempt_id/u,
        );
        return recoverySafetyClosureRow();
      }
      return {
        id: intentId,
        status: 'verifying_collection',
        decision: 'cross_agent_recovery',
        action_count: 1,
      };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].safetyHandoff.sourceLocalClosureProven, true);
  assert.equal(calls[0].safetyHandoff.challengeCode, 'DOUYIN_SEARCH_SECURITY_CHALLENGE');
  assert.equal(calls[0].safetyHandoff.count, 0);
  assert.equal(settled.status, 'verifying_collection');
});

test('multi-item recovery selects the exact closure proof instead of the legacy first item', async () => {
  const secondItemId = '21000000-0000-4000-8000-000000000002';
  const secondSourceAttemptId = '41000000-0000-4000-8000-000000000002';
  const secondEvidence = localClosureEvidence({
    itemId: secondItemId,
    itemAttemptId: secondSourceAttemptId,
    attemptNumber: 4,
    assignmentRevision: 8,
  });
  const calls = [];
  const settled = await processClaimedCaptureRecoveryIntent({
    tenantId,
    intent: {id: intentId, generation: 1, status: 'ready'},
    leaseToken,
    now: new Date('2026-08-25T01:00:00.000Z'),
    policy: {mode: 'guarded', actionsEnabled: true},
    dispatchRecovery: async input => {
      calls.push(input);
      return {
        child: {id: recoveryTaskId},
        command: {id: recoveryCommandId},
        agent: {id: recoveryAgentId},
        itemAttempts: [{
          id: recoveryAttemptId,
          itemId: secondItemId,
          executionTaskId: recoveryTaskId,
          agentId: recoveryAgentId,
          attemptNumber: 5,
          assignmentRevision: 9,
          status: 'dispatched',
        }],
      };
    },
    queryOne: async sql => {
      if (/FROM capture_recovery_intents intent/u.test(sql)) {
        assert.match(
          sql,
          /local_closure_snapshot\.metadata->'localClosures' AS\s+source_local_closure_evidences/u,
        );
        return recoverySafetyClosureRow({
          item_id: secondItemId,
          source_attempt_id: secondSourceAttemptId,
          current_source_attempt_id: secondSourceAttemptId,
          current_source_attempt_number: 4,
          current_source_assignment_revision: 8,
          assignment_revision: 8,
          expected_attempt_number: 4,
          expected_assignment_revision: 8,
          source_local_closure_evidence: localClosureEvidence(),
          source_local_closure_evidences: [
            localClosureEvidence(),
            secondEvidence,
          ],
        });
      }
      return {
        id: intentId,
        status: 'verifying_collection',
        decision: 'cross_agent_recovery',
        action_count: 1,
      };
    },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].itemIds, [secondItemId]);
  assert.equal(calls[0].safetyHandoff.sourceLocalClosureProven, true);
  assert.equal(settled.status, 'verifying_collection');
});

test('a malformed exact-attempt closure proof remains a human boundary', async () => {
  let dispatchCalls = 0;
  const settled = await processClaimedCaptureRecoveryIntent({
    tenantId,
    intent: {id: intentId, generation: 1, status: 'ready'},
    leaseToken,
    now: new Date('2026-08-25T01:00:00.000Z'),
    policy: {mode: 'guarded', actionsEnabled: true},
    dispatchRecovery: async () => { dispatchCalls += 1; },
    queryOne: async (sql, params) => {
      if (/FROM capture_recovery_intents intent/u.test(sql)) {
        return recoverySafetyClosureRow({
          source_local_closure_evidence: localClosureEvidence({
            requestId: 'wrong-request',
          }),
        });
      }
      return {
        id: intentId,
        status: params[3],
        decision: params[4],
        verification: JSON.parse(params[6]),
      };
    },
  });
  assert.equal(dispatchCalls, 0);
  assert.equal(settled.status, 'waiting_human');
  assert.equal(
    settled.verification.reason,
    'platform_safety_local_closure_proof_failed',
  );
});

test('missing local closure proof times out to waiting human without dispatch', async () => {
  let dispatchCalls = 0;
  const settled = await processClaimedCaptureRecoveryIntent({
    tenantId,
    intent: {id: intentId, generation: 1, status: 'waiting_due'},
    leaseToken,
    now: new Date('2026-08-25T03:00:01.000Z'),
    policy: {mode: 'guarded', actionsEnabled: true},
    dispatchRecovery: async () => { dispatchCalls += 1; },
    queryOne: async (sql, params) => {
      if (/FROM capture_recovery_intents intent/u.test(sql)) {
        return recoverySafetyClosureRow({
          source_local_closure_snapshot_agent_id: null,
          source_local_closure_snapshot_status: null,
          source_local_closure_snapshot_received_at: null,
          source_local_closure_evidence: null,
        });
      }
      return {
        id: intentId,
        status: params[3],
        decision: params[4],
        decision_payload: JSON.parse(params[5]),
      };
    },
  });
  assert.equal(dispatchCalls, 0);
  assert.equal(settled.status, 'waiting_human');
  assert.equal(
    settled.decision_payload.reason,
    'source_local_closure_proof_timeout',
  );
});

test('attempt-scoped structured health is unpacked, bounded and privacy-safe', () => {
  const health = buildBoundedCaptureRecoveryHealth({
    execution_attempt_app_version: '0.3.93',
    execution_attempt_health_evidence: {
      stage: 'detail_capture',
      phase: 'comments',
      progressObserved: {
        observed: true,
        sequence: 7,
        current: 4,
        total: 12,
        observedAt: '2026-08-25T01:00:00.000Z',
      },
      healthEvidence: {
        page: {
          platform: 'douyin',
          pageType: 'search_results',
          tabStatus: 'complete',
          frozen: true,
          fullUrl: 'https://www.douyin.com/private?token=secret',
        },
        network: {
          status: 'degraded',
          lastRequestLatencyMs: 999999999,
          timeoutCount: 999999999,
          cookie: 'private-cookie',
        },
        runtime: {
          eventLoopLagMs: 999999999,
          heapUsedMb: 999999999,
          heapLimitMb: 999999999,
          serviceWorkerRestartCount: 999999999,
          authorization: 'Bearer private-token',
        },
      },
    },
    execution_metadata: {
      appVersion: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcml2YXRlIn0.signature123',
      stage: 'apiKeyProdABC123',
      phase: 'aB3dE5fG7hJ9kL1mN3pR5tV7xZ9cD2fH',
      healthEvidence: {
        page: {pageType: 'secret_prod_ABC123'},
      },
    },
  });
  assert.equal(health.appVersion, '0.3.93');
  assert.equal(health.stage, 'detail_capture');
  assert.equal(health.phase, 'comments');
  assert.equal(health.progressObserved.sequence, 7);
  assert.equal(health.page.tabStatus, 'complete');
  assert.equal(health.page.frozen, true);
  assert.equal(health.network.status, 'degraded');
  assert.equal(health.network.lastRequestLatencyMs, 120000);
  assert.equal(health.network.lastRequestAt, '');
  assert.equal(health.network.timeoutCount, 1000000);
  assert.equal(health.runtime.eventLoopLagMs, 120000);
  assert.equal(health.runtime.heapUsedMb, 1024 * 1024);
  assert.equal(health.runtime.serviceWorkerRestartCount, 1000000);
  const serialized = JSON.stringify(health);
  for (const forbidden of [
    'https://',
    'bad.example',
    'eyJhbGci',
    'apiKeyProd',
    'aB3dE5fG',
    'secret_prod',
    'private-cookie',
    'private-token',
    'authorization',
    'Bearer',
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.ok(serialized.length < 1800);

  const emptyHealth = buildBoundedCaptureRecoveryHealth({});
  assert.equal(emptyHealth.progressObserved.observedAt, '');
  assert.equal(emptyHealth.network.lastRequestAt, '');
  assert.equal(JSON.stringify(emptyHealth).includes('1970-01-01'), false);

  const rejectedHealth = buildBoundedCaptureRecoveryHealth({
    execution_attempt_app_version:
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcml2YXRlIn0.signature123',
    execution_attempt_health_evidence: {
      stage: 'apiKeyProdABC123',
      phase: 'aB3dE5fG7hJ9kL1mN3pR5tV7xZ9cD2fH',
      healthEvidence: {
        page: {pageType: 'secret_prod_ABC123'},
        network: {status: '0123456789abcdef0123456789abcdef01234567'},
      },
    },
  });
  assert.equal(rejectedHealth.appVersion, '');
  assert.equal(rejectedHealth.stage, '');
  assert.equal(rejectedHealth.phase, '');
  assert.equal(rejectedHealth.page.pageType, '');
  assert.equal(rejectedHealth.network.status, '');

  const identityShapedHealth = buildBoundedCaptureRecoveryHealth({
    execution_metadata: {
      stage: 'AKIAIOSFODNN7EXAMPLE',
      phase: 'prod-db.internal',
      healthEvidence: {
        page: {
          platform: '192.168.1.7',
          pageType: 'customer_13800138000',
          detailReadyReason: 'AKIAIOSFODNN7EXAMPLE',
          tabStatus: 'prod-db.internal',
        },
        network: {
          status: 'customer_13800138000',
          endpointClass: 'prod-db.internal',
        },
      },
    },
    parent_metadata: {
      stage: 'customer_13800138000',
      healthEvidence: {
        page: {pageType: 'prod-db.internal'},
      },
    },
  });
  assert.equal(identityShapedHealth.stage, '');
  assert.equal(identityShapedHealth.phase, '');
  assert.equal(identityShapedHealth.page.platform, '');
  assert.equal(identityShapedHealth.page.pageType, '');
  assert.equal(identityShapedHealth.page.detailReadyReason, '');
  assert.equal(identityShapedHealth.page.tabStatus, '');
  assert.equal(identityShapedHealth.network.status, '');
  assert.equal(identityShapedHealth.network.endpointClass, '');
  assert.doesNotMatch(
    JSON.stringify(identityShapedHealth),
    /AKIAIOSFODNN7EXAMPLE|prod-db\.internal|192\.168\.1\.7|13800138000/iu,
  );

  const forgedAliasHealth = buildBoundedCaptureRecoveryHealth({
    metadata: {
      agentPlanAudit: {
        stage: 'detail_capture',
        healthEvidence: {network: {status: 'degraded', timeoutCount: 9}},
      },
    },
    execution_metadata: {
      structuredTaskHealth: {
        stage: 'detail_capture',
        healthEvidence: {page: {frozen: true}},
      },
    },
    parent_metadata: {
      healthEvidence: {network: {status: 'offline'}},
    },
  });
  assert.equal(forgedAliasHealth.stage, '');
  assert.equal(forgedAliasHealth.page.frozen, null);
  assert.equal(forgedAliasHealth.network.status, '');
  assert.equal(forgedAliasHealth.network.timeoutCount, 0);

  const classified = classifyCaptureRecoveryCandidate({
    status: 'failed',
    execution_attempt_health_evidence: {
      stage: 'detail_capture',
      healthEvidence: {
        network: {status: 'degraded', timeoutCount: 2},
      },
    },
  });
  assert.equal(classified.stage, 'detail_capture');
  assert.equal(classified.faultClass, 'network_local');
});

test('source fingerprints replay one failure while generation keys remain deterministic', () => {
  const candidate = {
    tenant_id: tenantId,
    item_id: itemId,
    source_attempt_id: '40000000-0000-4000-8000-000000000001',
    assignment_revision: 2,
    attempt_count: 2,
    status: 'failed',
    error: {code: 'CONTENT_RELAY_TIMEOUT', stage: 'detail_capture'},
  };
  const classification = classifyCaptureRecoveryCandidate(candidate);
  const first = buildCaptureRecoverySourceFingerprint(candidate, classification);
  const replay = buildCaptureRecoverySourceFingerprint({...candidate}, classification);
  const nextRevision = buildCaptureRecoverySourceFingerprint({
    ...candidate,
    assignment_revision: 3,
  }, classification);
  const sameAttemptDifferentPresentation = buildCaptureRecoverySourceFingerprint({
    ...candidate,
    status: 'retryable',
    error: {code: 'A_NEW_DISPLAY_ERROR', stage: 'detail_capture'},
  }, classifyCaptureRecoveryCandidate({
    ...candidate,
    status: 'retryable',
    error: {code: 'A_NEW_DISPLAY_ERROR', stage: 'detail_capture'},
  }));
  assert.match(first, /^[0-9a-f]{64}$/u);
  assert.equal(replay, first);
  assert.equal(
    sameAttemptDifferentPresentation,
    first,
    'status/error presentation changes within one attempt must not consume a generation',
  );
  assert.notEqual(nextRevision, first);

  const key = buildCaptureRecoveryKey({
    tenantId,
    itemId,
    stage: classification.stage,
    generation: 1,
    sourceFingerprint: first,
  });
  assert.equal(key, buildCaptureRecoveryKey({
    tenantId,
    itemId,
    stage: classification.stage,
    generation: 1,
    sourceFingerprint: first,
  }));
  assert.notEqual(key, buildCaptureRecoveryKey({
    tenantId,
    itemId,
    stage: classification.stage,
    generation: 2,
    sourceFingerprint: first,
  }));
});

test('duty recovery allows one immediate generation and clamps overflow to that policy', () => {
  const now = new Date('2026-08-25T01:00:00.000Z');
  const windowEndsAt = '2026-08-25T03:00:00.000Z';
  assert.equal(CAPTURE_RECOVERY_FAST_ATTEMPT_LIMIT, 2);
  assert.equal(CAPTURE_RECOVERY_MAX_GENERATIONS, 1);
  assert.equal(
    captureRecoveryGenerationAvailableAt({generation: 1, now, windowEndsAt})
      .toISOString(),
    '2026-08-25T01:00:00.000Z',
  );
  assert.equal(
    captureRecoveryGenerationAvailableAt({generation: 2, now, windowEndsAt})
      .toISOString(),
    '2026-08-25T01:00:00.000Z',
  );
  assert.equal(
    captureRecoveryGenerationAvailableAt({generation: 3, now, windowEndsAt})
      .toISOString(),
    '2026-08-25T01:00:00.000Z',
  );
  assert.equal(
    captureRecoveryGenerationAvailableAt({
      generation: 1,
      faultClass: 'platform_service',
      now,
      windowEndsAt,
    }).toISOString(),
    '2026-08-25T01:10:00.000Z',
  );
  assert.equal(
    captureRecoveryGenerationAvailableAt({
      generation: 3,
      now,
      windowEndsAt: '2026-08-25T01:20:00.000Z',
    }).toISOString(),
    '2026-08-25T01:00:00.000Z',
  );
});

test('business verification requires persisted collection evidence, not command state', () => {
  assert.deepEqual(
    verifyCaptureRecoveryBusinessOutcome({
      exact_recovery_task_type: 'unattended_keyword_capture',
      item_status: 'completed',
      recovery_command_id: recoveryCommandId,
      current_source_attempt_status: 'completed',
      metadata: {},
    }),
    {
      verified: false,
      kind: 'keyword_attempt_not_settled',
      taskType: 'unattended_keyword_capture',
    },
  );
  assert.deepEqual(
    verifyCaptureRecoveryBusinessOutcome({
      exact_recovery_task_type: 'unattended_keyword_capture',
      exact_dispatched_attempt_status: 'completed',
      exact_dispatched_attempt_checkpoint: {
        status: 'completed',
        savedCount: 0,
        scanComplete: true,
        searchPassResults: [{round: 1, status: 'completed', scanComplete: true}],
        finishedAt: '2026-08-25T01:05:00.000Z',
      },
    }),
    {
      verified: false,
      kind: 'keyword_business_evidence_pending',
      taskType: 'unattended_keyword_capture',
    },
  );
  assert.deepEqual(
    verifyCaptureRecoveryBusinessOutcome({
      exact_recovery_task_type: 'unattended_keyword_capture',
      exact_dispatched_attempt_status: 'completed',
      exact_dispatched_attempt_finished_at: '2026-08-25T01:05:00.000Z',
      exact_dispatched_attempt_checkpoint: {
        status: 'completed',
        savedCount: 0,
        noResults: true,
        resultKind: 'no_matching_results',
        candidateCount: 0,
        scanComplete: true,
        searchPassResults: [{round: 1, status: 'completed', scanComplete: true}],
        finishedAt: '2026-08-25T01:05:00.000Z',
      },
    }),
    {
      verified: true,
      kind: 'verified_zero_result',
      taskType: 'unattended_keyword_capture',
      observedAt: '2026-08-25T01:05:00.000Z',
    },
  );

  const subscriptionId = 'c0000000-0000-4000-8000-000000000001';
  const monitorExecutionId = 'd0000000-0000-4000-8000-000000000001';
  assert.deepEqual(
    verifyCaptureRecoveryBusinessOutcome({
      exact_recovery_task_type: 'followed_creator_post_patrol',
      exact_dispatched_attempt_status: 'completed',
      item_type: 'profile_subscription',
      item_status: 'completed',
      metadata: {subscriptionId},
      exact_dispatched_attempt_result: {
        executionId: monitorExecutionId,
        subscriptionId,
        status: 'completed',
        noResults: true,
        resultKind: 'profile_scan_no_new_posts',
        businessOutcome: 'profile_scan_no_new_posts',
        scanComplete: true,
        hitCount: 0,
        qualifyingCount: 0,
        finishedAt: '2026-08-25T01:06:00.000Z',
      },
      monitor_execution_id: monitorExecutionId,
      monitor_execution_status: 'succeeded',
      monitor_execution_records_found: 0,
      monitor_execution_finished_at: '2026-08-25T01:06:00.000Z',
      monitor_subject_type: 'creator',
      monitor_subscription_id: subscriptionId,
    }),
    {
      verified: true,
      kind: 'profile_zero_result_verified',
      taskType: 'followed_creator_post_patrol',
      observedAt: '2026-08-25T01:06:00.000Z',
      proofCompletedAt: '2026-08-25T01:06:00.000Z',
    },
  );
});

test('claim verification closes an intent when item or execution attempt advances without a revision change', async () => {
  const leaseToken = '50000000-0000-4000-8000-000000000001';
  const sourceItemAttemptId = '40000000-0000-4000-8000-000000000001';
  const nextItemAttemptId = '40000000-0000-4000-8000-000000000002';
  const sourceExecutionAttemptId = '70000000-0000-4000-8000-000000000001';
  const writes = [];
  const settled = await processClaimedCaptureRecoveryIntent({
    tenantId,
    intent: {id: intentId, stage: 'detail_capture', fault_class: 'extension_runtime'},
    leaseToken,
    now: new Date('2026-08-25T01:00:00.000Z'),
    queryOne: async (sql, params) => {
      if (/FROM capture_recovery_intents intent/u.test(sql)) {
        return {
          id: intentId,
          item_id: itemId,
          source_attempt_id: sourceItemAttemptId,
          source_execution_attempt_id: sourceExecutionAttemptId,
          expected_assignment_revision: 7,
          expected_attempt_number: 3,
          window_ends_at: '2026-08-25T02:00:00.000Z',
          item_status: 'failed',
          item_attempt_count: 4,
          assignment_revision: 7,
          current_source_attempt_id: nextItemAttemptId,
          current_source_attempt_number: 4,
          current_execution_attempt_id: sourceExecutionAttemptId,
          current_execution_attempt_number: 1,
          error: {code: 'CONTENT_RELAY_TIMEOUT'},
          metadata: {},
          parent_status: 'running',
          parent_metadata: {},
        };
      }
      writes.push({sql, params});
      return {
        id: intentId,
        status: params[3],
        decision: params[4],
        verification: JSON.parse(params[6]),
      };
    },
  });
  assert.equal(settled.status, 'resolved');
  assert.equal(settled.verification.reason, 'source_attempt_superseded');
  assert.equal(settled.verification.assignmentRevisionMatches, true);
  assert.equal(settled.verification.sourceItemAttemptMatches, false);
  assert.equal(settled.verification.sourceExecutionAttemptMatches, true);
  assert.match(writes[0].sql, /lease_token = \$3::uuid/u);
});

test('human-required intents stay open and can reconcile to resolved after completion', async () => {
  const statements = [];
  const result = await ingestCaptureRecoveryItem({
    tenantId,
    itemId,
    now: new Date('2026-08-25T01:00:00.000Z'),
    withTransaction: async callback => callback({
      queryOne: async sql => {
        if (/FROM capture_task_items item/u.test(sql)) {
          return {
            item_id: itemId,
            tenant_id: tenantId,
            parent_task_id: '60000000-0000-4000-8000-000000000001',
            status: 'completed',
            attempt_count: 1,
            assignment_revision: 1,
            error: {},
            metadata: {},
            parent_metadata: {},
          };
        }
        if (/WITH actioned AS/u.test(sql)) return null;
        assert.fail(`unexpected queryOne SQL: ${sql}`);
      },
      queryAll: async (sql, params) => {
        statements.push({sql, params});
        return [{id: intentId, status: 'resolved', decision: 'observe'}];
      },
    }),
  });
  assert.equal(result.kind, 'terminal_reconciled');
  assert.equal(result.intents[0].status, 'resolved');
  assert.match(statements[0].sql, /status <> ALL\(\$7::text\[\]\)/u);
  assert.equal(
    statements[0].params[6].includes('waiting_human'),
    false,
    'waiting_human is open and must be eligible for completion reconciliation',
  );
});

test('a same-attempt timeout that becomes captcha escalates immediately without spending a generation', async () => {
  const sourceAttemptId = '40000000-0000-4000-8000-000000000001';
  const updates = [];
  const result = await ingestCaptureRecoveryItem({
    tenantId,
    itemId,
    now: new Date('2026-08-25T01:05:00.000Z'),
    withTransaction: async callback => callback({
      execute: async () => 1,
      queryAll: async () => [],
      queryOne: async (sql, params) => {
        if (/FROM capture_task_items item/u.test(sql)) {
          return {
            item_id: itemId,
            tenant_id: tenantId,
            parent_task_id: '60000000-0000-4000-8000-000000000001',
            source_attempt_id: sourceAttemptId,
            source_attempt_number: 1,
            status: 'needs_action',
            attempt_count: 1,
            assignment_revision: 1,
            error: {
              code: 'DOUYIN_CAPTCHA_REQUIRED',
              stage: 'detail_capture',
            },
            metadata: {},
            parent_metadata: {},
          };
        }
        if (/source_fingerprint = \$2/u.test(sql)) {
          return {
            id: intentId,
            generation: 1,
            status: 'waiting_due',
            decision: 'observe',
          };
        }
        if (/SET status = 'waiting_human'/u.test(sql)) {
          updates.push({sql, params});
          return {
            id: intentId,
            generation: 1,
            status: 'waiting_human',
            decision: 'human_required',
            resolved_at: null,
          };
        }
        assert.fail(`unexpected SQL: ${sql}`);
      },
    }),
  });
  assert.equal(result.kind, 'human_required');
  assert.equal(result.intent.generation, 1);
  assert.equal(result.intent.status, 'waiting_human');
  assert.equal(result.intent.resolved_at, null);
  assert.equal(updates.length, 1);
  assert.match(String(updates[0].params[3]), /platform_safety/u);
});

test('recovery generations reuse the first fixed window even if later task metadata extends it', async () => {
  const previousWindowEndsAt = '2026-08-25T12:00:00.000Z';
  let insertedWindowEndsAt = '';
  const result = await ingestCaptureRecoveryItem({
    tenantId,
    itemId,
    now: new Date('2026-08-25T08:00:00.000Z'),
    withTransaction: async callback => callback({
      execute: async () => 1,
      queryAll: async () => [],
      queryOne: async (sql, params) => {
        if (/FROM capture_task_items item/u.test(sql)) {
          return {
            item_id: itemId,
            tenant_id: tenantId,
            parent_task_id: '60000000-0000-4000-8000-000000000001',
            status: 'failed',
            attempt_count: 3,
            assignment_revision: 2,
            error: {code: 'REQUEST_TIMEOUT', stage: 'detail_capture'},
            metadata: {},
            parent_metadata: {
              recoveryWindowEndsAt: '2026-08-25T14:00:00.000Z',
            },
            parent_created_at: '2026-08-25T00:00:00.000Z',
          };
        }
        if (/source_fingerprint = \$2/u.test(sql)) return null;
        if (/ORDER BY generation DESC/u.test(sql)) {
          return {id: intentId, generation: 1, window_ends_at: previousWindowEndsAt};
        }
        if (/SET parent_task_id = \$3/u.test(sql)) {
          insertedWindowEndsAt = params[13];
          return {id: intentId, generation: 1, status: 'ready'};
        }
        assert.fail(`unexpected SQL: ${sql}`);
      },
    }),
  });
  assert.equal(result.kind, 'rebound_without_budget_consumption');
  assert.equal(result.intent.generation, 1);
  assert.equal(insertedWindowEndsAt, previousWindowEndsAt);
});

test('durable intent claims use skip-locked leases and bounded claim metadata', async () => {
  const queries = [];
  const claimed = await claimCaptureRecoveryIntents({
    tenantId,
    intentIds: [intentId],
    now: new Date('2026-08-25T01:00:00.000Z'),
    leaseToken: '50000000-0000-4000-8000-000000000001',
    leaseOwner: 'phase-a-test',
    leaseSeconds: 45,
    withTransaction: async callback => callback({
      queryAll: async (sql, params) => {
        queries.push({sql, params});
        if (/UPDATE capture_recovery_intents intent/u.test(sql)) {
          return [{id: intentId, status: 'ready'}];
        }
        return [];
      },
    }),
  });
  assert.match(queries[0].sql, /FOR UPDATE SKIP LOCKED/u);
  assert.match(queries[0].sql, /lease_expires_at/u);
  assert.deepEqual(queries[0].params[2], [intentId]);
  assert.equal(queries[0].params[5], 'phase-a-test');
  assert.equal(queries[0].params[6], 45);
  assert.match(queries[1].sql, /AS retry_at/u);
  assert.equal(claimed.intents.length, 1);
  assert.equal(claimed.deferred.length, 0);
});

test('a second duty generation persists a waiting-human boundary on the first intent', async () => {
  const statements = [];
  const result = await ingestCaptureRecoveryItem({
    tenantId,
    itemId,
    now: new Date('2026-08-25T01:00:00.000Z'),
    withTransaction: async callback => callback({
      execute: async () => 1,
      queryAll: async () => [],
      queryOne: async (sql, params) => {
        statements.push({sql, params});
        if (/FROM capture_task_items item/u.test(sql)) {
          return {
            item_id: itemId,
            tenant_id: tenantId,
            parent_task_id: '60000000-0000-4000-8000-000000000001',
            status: 'failed',
            attempt_count: 4,
            assignment_revision: 4,
            source_attempt_id: recoveryAttemptId,
            source_attempt_number: 4,
            error: {code: 'REQUEST_TIMEOUT', stage: 'detail_capture'},
            metadata: {},
            parent_metadata: {},
          };
        }
        if (/source_fingerprint = \$2/u.test(sql)) return null;
        if (/ORDER BY generation DESC/u.test(sql)) {
          return {
            id: intentId,
            generation: 1,
            stage: 'search_ready',
            status: 'waiting_due',
            action_count: 1,
            recovery_task_id: recoveryTaskId,
            dispatched_attempt_id: recoveryAttemptId,
          };
        }
        if (/SET status = 'waiting_human'/u.test(sql)) {
          return {
            id: intentId,
            generation: 1,
            status: 'waiting_human',
            decision: 'human_required',
          };
        }
        assert.fail(`unexpected SQL: ${sql}`);
      },
    }),
  });
  assert.equal(result.kind, 'generation_exhausted');
  assert.equal(result.intent.status, 'waiting_human');
  assert.equal(result.intent.decision, 'human_required');
  const latestLookup = statements.find(entry => /ORDER BY generation DESC/u.test(entry.sql));
  assert.match(latestLookup.sql, /WHERE tenant_id = \$1 AND item_id = \$2/u);
  assert.doesNotMatch(latestLookup.sql, /stage =/u);
  const exhaustedUpdate = statements.find(entry => /SET status = 'waiting_human'/u.test(entry.sql));
  assert.doesNotMatch(exhaustedUpdate.sql, /stage =/u);
  const settlement = statements.find(entry => (entry.params || []).some(
    value => /generation_budget_exhausted/u.test(String(value)),
  ));
  assert.ok(settlement, 'hard-budget outcome must be persisted in the Agent ledger');
});

test('lease renewal is fenced by tenant, intent and lease token', async () => {
  let sql = '';
  let params = [];
  const renewed = await renewCaptureRecoveryIntentLease({
    tenantId,
    intentId,
    leaseToken: '50000000-0000-4000-8000-000000000001',
    now: new Date('2026-08-25T01:00:30.000Z'),
    leaseSeconds: 60,
    queryOne: async (statement, values) => {
      sql = statement;
      params = values;
      return {id: intentId};
    },
  });
  assert.match(sql, /lease_token = \$3::uuid/u);
  assert.deepEqual(params.slice(0, 3), [
    intentId,
    tenantId,
    '50000000-0000-4000-8000-000000000001',
  ]);
  assert.equal(renewed.id, intentId);
});

test('guarded recovery dispatches exactly one fenced item and records its lineage', async () => {
  const calls = [];
  const writes = [];
  const settled = await processClaimedCaptureRecoveryIntent({
    tenantId,
    intent: {
      id: intentId,
      generation: 1,
      stage: 'detail_capture',
      fault_class: 'extension_runtime',
    },
    leaseToken,
    now: new Date('2026-08-25T01:00:00.000Z'),
    policy: {mode: 'guarded', actionsEnabled: true},
    dispatchRecovery: async input => {
      calls.push(input);
      return {
        existing: false,
        child: {id: recoveryTaskId},
        command: {id: recoveryCommandId},
        agent: {id: recoveryAgentId},
        parent: {orchestration_revision: 11},
        itemAttempts: [{
          id: recoveryAttemptId,
          itemId,
          executionTaskId: recoveryTaskId,
          agentId: recoveryAgentId,
          attemptNumber: 4,
          assignmentRevision: 11,
          status: 'dispatched',
        }],
      };
    },
    queryOne: async (sql, params) => {
      if (/FROM capture_recovery_intents intent/u.test(sql)) {
        return recoveryCandidateRow();
      }
      writes.push({sql, params});
      return {
        id: intentId,
        item_id: itemId,
        generation: 1,
        status: 'verifying_collection',
        decision: 'cross_agent_recovery',
      };
    },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].itemIds, [itemId]);
  assert.equal(calls[0].requestKey, intentId);
  assert.equal(calls[0].recoveryPhase, 'duty');
  assert.equal(calls[0].expectedItemRevision, 7);
  assert.equal(calls[0].expectedSourceAttemptId, sourceAttemptId);
  assert.equal(calls[0].expectedAttemptNumber, 3);
  assert.equal(calls[0].dutyRecoveryGeneration, 1);
  assert.equal(settled.status, 'verifying_collection');
  assert.equal(settled.actionExecuted, true);
  assert.match(writes[0].sql, /action_count = action_count \+ CASE/u);
  assert.match(writes[0].sql, /dispatched_attempt_id = \$7::uuid/u);
  assert.equal(writes[0].params[3], recoveryTaskId);
  assert.equal(writes[0].params[6], recoveryAttemptId);
  assert.equal(writes[0].params[10], true);
  assert.equal(
    new Date(writes[0].params[13]).toISOString(),
    new Date(Date.parse('2026-08-25T01:00:00.000Z') + CAPTURE_RECOVERY_VERIFY_DELAY_MS)
      .toISOString(),
  );
});

test('a committed child is recovered after a crash before the intent ledger update', async () => {
  let dispatchCalls = 0;
  let markParams = null;
  const settled = await processClaimedCaptureRecoveryIntent({
    tenantId,
    intent: {id: intentId, generation: 1, status: 'ready'},
    leaseToken,
    now: new Date('2026-08-25T01:00:30.000Z'),
    policy: {mode: 'guarded', actionsEnabled: true},
    dispatchRecovery: async () => { dispatchCalls += 1; },
    queryOne: async (sql, params) => {
      if (/FROM capture_recovery_intents intent/u.test(sql)) {
        return recoveryCandidateRow({
          item_status: 'dispatched',
          item_attempt_count: 4,
          assignment_revision: 11,
          current_source_attempt_id: recoveryAttemptId,
          current_source_attempt_number: 4,
          current_source_assignment_revision: 11,
          current_source_attempt_status: 'dispatched',
          current_execution_attempt_id: null,
          replayed_recovery_task_id: recoveryTaskId,
          replayed_recovery_command_id: recoveryCommandId,
          replayed_recovery_agent_id: recoveryAgentId,
          replayed_dispatched_attempt_id: recoveryAttemptId,
          replayed_attempt_number: 4,
          replayed_assignment_revision: 11,
          replayed_execution_task_id: recoveryTaskId,
        });
      }
      markParams = params;
      return {
        id: intentId,
        status: 'verifying_collection',
        decision: 'cross_agent_recovery',
        action_count: 1,
      };
    },
  });
  assert.equal(dispatchCalls, 0);
  assert.equal(settled.status, 'verifying_collection');
  assert.equal(settled.actionExecuted, false);
  assert.equal(settled.recoveredUnrecordedDispatch, true);
  assert.equal(markParams[10], true, 'the durable ledger records the already committed action');
  assert.equal(markParams[3], recoveryTaskId);
  assert.equal(markParams[6], recoveryAttemptId);
});

test('no idle Agent becomes WAITING_AGENT without spending action or generation budget', async () => {
  const writes = [];
  const settled = await processClaimedCaptureRecoveryIntent({
    tenantId,
    intent: {
      id: intentId,
      generation: 1,
      stage: 'detail_capture',
      fault_class: 'network_local',
    },
    leaseToken,
    now: new Date('2026-08-25T01:00:00.000Z'),
    policy: {mode: 'guarded', actionsEnabled: true},
    dispatchRecovery: async () => ({
      error: 'idle_compatible_agent_unavailable',
      code: 'NO_IDLE_AGENT',
      waitingForAgent: true,
    }),
    queryOne: async (sql, params) => {
      if (/FROM capture_recovery_intents intent/u.test(sql)) {
        return recoveryCandidateRow({generation: 1});
      }
      writes.push({sql, params});
      return {
        id: intentId,
        generation: 1,
        status: params[3],
        decision: params[4],
        decision_payload: JSON.parse(params[5]),
        available_at: params[8],
      };
    },
  });
  assert.equal(settled.status, 'waiting_agent');
  assert.equal(settled.decision_payload.budgetConsumed, false);
  assert.equal(settled.actionExecuted, undefined);
  assert.doesNotMatch(writes[0].sql, /action_count\s*=/u);
  assert.equal(
    new Date(settled.available_at).toISOString(),
    new Date(
      Date.parse('2026-08-25T01:00:00.000Z')
        + CAPTURE_RECOVERY_WAITING_AGENT_BACKOFF_MS,
    ).toISOString(),
  );
});

test('captcha is absorbed at the human boundary before any dispatch call', async () => {
  let dispatchCalls = 0;
  const settled = await processClaimedCaptureRecoveryIntent({
    tenantId,
    intent: {id: intentId, generation: 1},
    leaseToken,
    now: new Date('2026-08-25T01:00:00.000Z'),
    policy: {mode: 'guarded', actionsEnabled: true},
    dispatchRecovery: async () => { dispatchCalls += 1; },
    queryOne: async (sql, params) => {
      if (/FROM capture_recovery_intents intent/u.test(sql)) {
        return recoveryCandidateRow({
          item_status: 'needs_action',
          error: {code: 'DOUYIN_SEARCH_CAPTCHA_REQUIRED'},
          current_source_attempt_error: {
            code: 'DOUYIN_SEARCH_CAPTCHA_REQUIRED',
          },
        });
      }
      return {
        id: intentId,
        status: params[3],
        decision: params[4],
        verification: JSON.parse(params[6]),
      };
    },
  });
  assert.equal(dispatchCalls, 0);
  assert.equal(settled.status, 'waiting_human');
  assert.equal(settled.decision, 'human_required');
  assert.equal(settled.verification.reason, 'platform_safety');
});

test('a dispatched recovery resolves only after item-scoped business evidence appears', async () => {
  let dispatchCalls = 0;
  const settled = await processClaimedCaptureRecoveryIntent({
    tenantId,
    intent: {id: intentId, generation: 1, status: 'verifying_collection'},
    leaseToken,
    now: new Date('2026-08-25T01:05:00.000Z'),
    policy: {mode: 'guarded', actionsEnabled: true},
    dispatchRecovery: async () => { dispatchCalls += 1; },
    queryOne: async (sql, params) => {
      if (/FROM capture_recovery_intents intent/u.test(sql)) {
        return verifyingRecoveryRow({
          exact_recovery_task_type: 'unattended_keyword_capture',
          expected_assignment_revision: 11,
          expected_attempt_number: 4,
          item_status: 'completed',
          item_attempt_count: 4,
          assignment_revision: 11,
          current_source_attempt_status: 'completed',
          current_source_attempt_checkpoint: {
            status: 'completed',
            savedCount: 0,
            noResults: true,
            resultKind: 'no_matching_results',
            candidateCount: 0,
            scanComplete: true,
            searchPassResults: [{
              round: 1,
              status: 'completed',
              scanComplete: true,
            }],
            finishedAt: '2026-08-25T01:04:30.000Z',
          },
          exact_dispatched_attempt_status: 'completed',
          exact_dispatched_attempt_checkpoint: {
            status: 'completed',
            savedCount: 0,
            noResults: true,
            resultKind: 'no_matching_results',
            candidateCount: 0,
            scanComplete: true,
            searchPassResults: [{
              round: 1,
              status: 'completed',
              scanComplete: true,
            }],
            finishedAt: '2026-08-25T01:04:30.000Z',
          },
          exact_dispatched_attempt_finished_at: '2026-08-25T01:04:30.000Z',
        });
      }
      return {
        id: intentId,
        status: params[3],
        decision: params[4],
        verification: JSON.parse(params[6]),
      };
    },
  });
  assert.equal(dispatchCalls, 0);
  assert.equal(settled.status, 'resolved');
  assert.equal(settled.decision, 'cross_agent_recovery');
  assert.equal(settled.verification.reason, 'business_outcome_verified');
  assert.equal(settled.verification.businessOutcome.verified, true);
});

test('a business result finished inside the hard window still verifies after a delayed wakeup', async () => {
  const settled = await processClaimedCaptureRecoveryIntent({
    tenantId,
    intent: {id: intentId, generation: 1, status: 'verifying_collection'},
    leaseToken,
    now: new Date('2026-08-25T03:05:00.000Z'),
    policy: {mode: 'guarded', actionsEnabled: true},
    dispatchRecovery: async () => assert.fail('verification cannot redispatch'),
    queryOne: async (sql, params) => {
      if (/FROM capture_recovery_intents intent/u.test(sql)) {
        return verifyingRecoveryRow({
          exact_recovery_task_type: 'unattended_keyword_capture',
          expected_assignment_revision: 11,
          expected_attempt_number: 4,
          window_ends_at: '2026-08-25T03:00:00.000Z',
          item_status: 'completed',
          item_attempt_count: 4,
          assignment_revision: 11,
          item_finished_at: '2026-08-25T02:59:00.000Z',
          current_source_attempt_status: 'completed',
          current_source_attempt_checkpoint: {
            status: 'completed',
            savedCount: 0,
            noResults: true,
            resultKind: 'no_matching_results',
            candidateCount: 0,
            scanComplete: true,
            searchPassResults: [{
              round: 1,
              status: 'completed',
              scanComplete: true,
            }],
            finishedAt: '2026-08-25T02:59:00.000Z',
          },
          exact_dispatched_attempt_status: 'completed',
          exact_dispatched_attempt_checkpoint: {
            status: 'completed',
            savedCount: 0,
            noResults: true,
            resultKind: 'no_matching_results',
            candidateCount: 0,
            scanComplete: true,
            searchPassResults: [{
              round: 1,
              status: 'completed',
              scanComplete: true,
            }],
            finishedAt: '2026-08-25T02:59:00.000Z',
          },
          exact_dispatched_attempt_finished_at: '2026-08-25T02:59:00.000Z',
        });
      }
      return {
        id: intentId,
        status: params[3],
        decision: params[4],
        verification: JSON.parse(params[6]),
      };
    },
  });
  assert.equal(settled.status, 'resolved');
  assert.equal(settled.verification.reason, 'business_outcome_verified');
  assert.equal(
    settled.verification.businessOutcome.observedAt,
    '2026-08-25T02:59:00.000Z',
  );
});

test('Agent slot events wake only waiting intents and can execute a guarded recovery', async () => {
  let sql = '';
  const awakened = await wakeWaitingCaptureRecoveryIntents({
    tenantId,
    now: new Date('2026-08-25T01:00:00.000Z'),
    queryAll: async (statement, params) => {
      sql = statement;
      assert.equal(params[0], tenantId);
      return [{id: intentId, status: 'waiting_agent'}];
    },
  });
  assert.equal(awakened.length, 1);
  assert.match(sql, /status = 'waiting_agent'/u);
  assert.match(sql, /FOR UPDATE SKIP LOCKED/u);

  let processedInput = null;
  const result = await processCaptureRecoveryWakeups({
    tenantId,
    wakeups: [{
      source_type: CAPTURE_RECOVERY_AGENT_SLOT_SOURCE_TYPE,
      source_id: recoveryAgentId,
    }],
    now: new Date('2026-08-25T01:00:00.000Z'),
    env: {
      OPS_CONTROL_RECOVERY_GLOBAL_ENABLED: 'true',
      OPS_CONTROL_RECOVERY_ACTIONS_GLOBAL_ENABLED: 'true',
    },
    getSettings: async () => ({
      ops_control_recovery_enabled: 'true',
      ops_control_recovery_mode: 'guarded',
    }),
    wakeWaitingIntents: async () => [{id: intentId}],
    processIntents: async input => {
      processedInput = input;
      return {
        claimed: 1,
        observed: 0,
        terminal: 0,
        humanRequired: 0,
        actionsExecuted: 1,
        results: [],
        deferred: [],
      };
    },
    enqueueWakeup: async () => 1,
  });
  assert.deepEqual(processedInput.intentIds, [intentId]);
  assert.equal(processedInput.policy.actionsEnabled, true);
  assert.equal(result.kind, 'acted');
  assert.equal(result.actionsExecuted, 1);
  assert.deepEqual(result.agentSlot, {observed: true, intentsWoken: 1});
});

test('disabled recovery wakeups perform no ingestion, lease or action', async () => {
  let ingested = 0;
  let processed = 0;
  let enqueued = 0;
  const result = await processCaptureRecoveryWakeups({
    tenantId,
    wakeups: [{source_type: 'capture_task_item', source_id: itemId}],
    env: {OPS_CONTROL_RECOVERY_GLOBAL_ENABLED: 'false'},
    getSettings: async () => ({ops_control_recovery_enabled: 'true'}),
    ingestItem: async () => { ingested += 1; },
    processIntents: async () => { processed += 1; },
    enqueueWakeup: async () => { enqueued += 1; },
  });
  assert.equal(result.kind, 'disabled');
  assert.equal(result.actionsExecuted, 0);
  assert.equal(ingested, 0);
  assert.equal(processed, 0);
  assert.equal(enqueued, 0);
});

test('a backfill wakeup consumed while the global gate is off performs no scan', async () => {
  let scans = 0;
  const result = await processCaptureRecoveryWakeups({
    tenantId,
    wakeups: [{
      source_type: 'capture_recovery_backfill',
      source_id: tenantId,
      payload: {cursor: null},
    }],
    env: {OPS_CONTROL_RECOVERY_GLOBAL_ENABLED: 'false'},
    getSettings: async () => ({ops_control_recovery_enabled: 'true'}),
    scanBackfillPage: async () => { scans += 1; },
    enqueueWakeup: async () => assert.fail('disabled backfill must not enqueue'),
  });
  assert.equal(result.kind, 'disabled');
  assert.equal(result.actionsExecuted, 0);
  assert.equal(scans, 0);
});

test('enabled backfill wakeups page tenant failures into durable item hints and a cursor continuation', async () => {
  const secondItemId = '20000000-0000-4000-8000-000000000002';
  const nextCursor = {
    version: 1,
    cutoffCreatedAt: '2026-08-25T02:00:00.000Z',
    afterCreatedAt: '2026-08-25T01:01:00.000Z',
    afterId: secondItemId,
  };
  const enqueued = [];
  let ingested = 0;
  const result = await processCaptureRecoveryWakeups({
    tenantId,
    wakeups: [{
      source_type: 'capture_recovery_backfill',
      source_id: tenantId,
      payload: {cursor: null, observeOnly: true},
    }],
    now: new Date('2026-08-25T02:00:00.000Z'),
    env: {OPS_CONTROL_RECOVERY_GLOBAL_ENABLED: 'true'},
    getSettings: async () => ({ops_control_recovery_enabled: 'true'}),
    scanBackfillPage: async input => {
      assert.equal(input.tenantId, tenantId);
      assert.equal(input.cursor, null);
      return {
        items: [
          {
            itemId,
            taskId: '60000000-0000-4000-8000-000000000001',
            executionTaskId: '',
            status: 'retryable',
            assignmentRevision: 2,
            attemptCount: 1,
          },
          {
            itemId: secondItemId,
            taskId: '60000000-0000-4000-8000-000000000001',
            executionTaskId: '60000000-0000-4000-8000-000000000002',
            status: 'failed',
            assignmentRevision: 3,
            attemptCount: 2,
          },
        ],
        itemIds: [itemId, secondItemId],
        hasMore: true,
        nextCursor,
      };
    },
    ingestItem: async () => { ingested += 1; },
    enqueueWakeup: async wakeup => {
      enqueued.push(wakeup);
      return enqueued.length;
    },
  });
  assert.equal(ingested, 0, 'the page creates durable item hints before ingestion');
  assert.equal(result.kind, 'observed');
  assert.equal(result.candidates, 2);
  assert.equal(result.actionsExecuted, 0);
  assert.deepEqual(result.backfill, {
    pages: 1,
    candidates: 2,
    itemWakeups: 2,
    continuations: 1,
    hasMore: true,
  });
  assert.equal(enqueued.length, 3);
  assert.deepEqual(enqueued.map(row => row.sourceType), [
    'capture_task_item',
    'capture_task_item',
    'capture_recovery_backfill',
  ]);
  assert.equal(
    enqueued[0].dedupeKey,
    `capture-recovery-item:${itemId}:2:retryable`,
  );
  assert.equal(enqueued[0].payload.observeOnly, true);
  assert.equal(enqueued[1].payload.executionTaskId, '60000000-0000-4000-8000-000000000002');
  assert.equal(
    enqueued[2].dedupeKey,
    `capture-recovery-backfill:${secondItemId}`,
  );
  assert.deepEqual(enqueued[2].payload.cursor, nextCursor);
});

test('enabled Phase A ingests an item and schedules only an observe intent', async () => {
  const enqueued = [];
  const result = await processCaptureRecoveryWakeups({
    tenantId,
    wakeups: [{source_type: 'capture_task_item', source_id: itemId}],
    now: new Date('2026-08-25T01:00:00.000Z'),
    env: {OPS_CONTROL_RECOVERY_GLOBAL_ENABLED: 'true'},
    getSettings: async () => ({ops_control_recovery_enabled: 'true'}),
    ingestItem: async () => ({
      kind: 'created',
      intent: {
        id: intentId,
        item_id: itemId,
        stage: 'detail_capture',
        generation: 1,
        status: 'ready',
        available_at: '2026-08-25T01:00:00.000Z',
      },
    }),
    enqueueWakeup: async wakeup => {
      enqueued.push(wakeup);
      return 1;
    },
  });
  assert.equal(result.kind, 'observed');
  assert.equal(result.policy.mode, 'observe');
  assert.equal(result.policy.actionsEnabled, false);
  assert.equal(result.actionsExecuted, 0);
  assert.equal(result.intents, 1);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].sourceType, 'capture_recovery_intent');
  assert.equal(enqueued[0].payload.observeOnly, true);
});

test('intent batches settle only observe decisions and expose zero action executions', async () => {
  const result = await processCaptureRecoveryIntentBatch({
    tenantId,
    intentIds: [intentId],
    claimIntents: async () => ({
      leaseToken: '50000000-0000-4000-8000-000000000001',
      intents: [{id: intentId, status: 'ready'}],
    }),
    processIntent: async ({intent}) => ({
      ...intent,
      status: 'waiting_due',
      decision: 'observe',
    }),
  });
  assert.equal(result.claimed, 1);
  assert.equal(result.observed, 1);
  assert.equal(result.actionsExecuted, 0);
});

test('intent batches count only newly dispatched actions, not passive or replay rows', async () => {
  const result = await processCaptureRecoveryIntentBatch({
    tenantId,
    intentIds: [intentId],
    policy: {mode: 'guarded', actionsEnabled: true},
    claimIntents: async () => ({
      leaseToken,
      intents: [{id: intentId, status: 'ready'}],
      deferred: [],
    }),
    processIntent: async input => {
      assert.equal(input.policy.actionsEnabled, true);
      return {
        id: intentId,
        status: 'verifying_collection',
        decision: 'cross_agent_recovery',
        actionExecuted: true,
      };
    },
  });
  assert.equal(result.claimed, 1);
  assert.equal(result.actionsExecuted, 1);
  assert.equal(result.observed, 0);
});

test('a retry before the intent lease expires schedules durable catch-up instead of orphaning it', async () => {
  await assert.rejects(
    processCaptureRecoveryIntentBatch({
      tenantId,
      intentIds: [intentId],
      claimIntents: async () => ({
        leaseToken: '50000000-0000-4000-8000-000000000001',
        intents: [{id: intentId, status: 'ready'}],
        deferred: [],
      }),
      processIntent: async () => {
        throw new Error('simulated worker crash after durable lease');
      },
    }),
    /simulated worker crash/u,
  );

  const catchups = [];
  const leaseExpiresAt = '2026-08-25T01:02:00.000Z';
  const retry = await processCaptureRecoveryWakeups({
    tenantId,
    wakeups: [{source_type: 'capture_recovery_intent', source_id: intentId}],
    now: new Date('2026-08-25T01:00:30.000Z'),
    env: {OPS_CONTROL_RECOVERY_GLOBAL_ENABLED: 'true'},
    getSettings: async () => ({ops_control_recovery_enabled: 'true'}),
    processIntents: async () => ({
      claimed: 0,
      observed: 0,
      terminal: 0,
      actionsExecuted: 0,
      results: [],
      deferred: [{
        id: intentId,
        item_id: itemId,
        stage: 'detail_capture',
        generation: 1,
        status: 'ready',
        lease_expires_at: leaseExpiresAt,
        retry_at: leaseExpiresAt,
      }],
    }),
    enqueueWakeup: async wakeup => {
      catchups.push(wakeup);
      return 2;
    },
  });
  assert.equal(retry.claimed, 0);
  assert.equal(retry.actionsExecuted, 0);
  assert.equal(catchups.length, 1);
  assert.equal(catchups[0].reason, 'capture_recovery_lease_due');
  assert.equal(new Date(catchups[0].availableAt).toISOString(), leaseExpiresAt);
  assert.equal(catchups[0].replaceAvailable, true);
});

test('ops-control processes recovery hints before ordinary observation', async () => {
  const order = [];
  const completed = [];
  const result = await processOpsControlWakeupBatch({
    now: new Date('2026-08-25T01:00:00.000Z'),
    claimWakeups: async () => ({
      claimToken: '50000000-0000-4000-8000-000000000001',
      wakeups: [{
        id: 1,
        tenant_id: tenantId,
        source_type: 'capture_task_item',
        source_id: itemId,
        reason: 'capture_item_state_changed',
        created_at: '2026-08-25T00:59:59.000Z',
      }],
    }),
    processRecoveryWakeups: async () => {
      order.push('recovery');
      return {kind: 'observed', actionsExecuted: 0};
    },
    observeTenant: async input => {
      assert.equal(input.forceObserveOnly, true);
      order.push('ops-observation');
      return {result: {kind: 'disabled'}, policy: null};
    },
    completeWakeups: async input => {
      completed.push(input.ids);
      return input.ids.length;
    },
    retryWakeups: async () => assert.fail('observe-only recovery should not retry'),
    cleanupWakeups: async () => 0,
  });
  assert.deepEqual(order, ['recovery', 'ops-observation']);
  assert.deepEqual(completed, [[1]]);
  assert.equal(result.results[0].recovery.actionsExecuted, 0);
});

test('recovery hints force the same OpsControl batch to observe only', async () => {
  let observationInput = null;
  let businessActionCalls = 0;
  let followupCalls = 0;
  const result = await processOpsControlWakeupBatch({
    now: new Date('2026-08-25T01:00:00.000Z'),
    claimWakeups: async () => ({
      claimToken: '50000000-0000-4000-8000-000000000001',
      wakeups: [{
        id: 11,
        tenant_id: tenantId,
        source_type: 'capture_recovery_intent',
        source_id: intentId,
        reason: 'capture_recovery_intent_due',
        created_at: '2026-08-25T00:59:59.000Z',
      }],
    }),
    processRecoveryWakeups: async () => ({
      kind: 'observed',
      actionsExecuted: 0,
    }),
    observeTenant: async input => {
      observationInput = input;
      if (!input.forceObserveOnly) businessActionCalls += 1;
      return {
        result: {
          kind: 'observed',
          actions: {enabled: false, executed: 0},
          assessment: {
            lifecycleStatus: 'progressing',
            summary: {consecutiveEvidence: false, activeTaskCount: 0},
          },
          activation: {activeCommandCount: 0, pendingActionCount: 0},
        },
        policy: {snapshotGapSeconds: 25},
      };
    },
    enqueueWakeup: async () => {
      followupCalls += 1;
      return 12;
    },
    completeWakeups: async () => 1,
    retryWakeups: async () => assert.fail('observe-only batch should not retry'),
    cleanupWakeups: async () => 0,
  });

  assert.equal(observationInput.forceObserveOnly, true);
  assert.equal(businessActionCalls, 0);
  assert.equal(result.results[0].recovery.actionsExecuted, 0);
  assert.equal(result.results[0].result.actions.executed, 0);
  assert.equal(followupCalls, 0);
  assert.equal(result.followups, 0);
});

test('ops-control routes capture_recovery_backfill wakeups into recovery processing', async () => {
  let recoveryCalls = 0;
  const result = await processOpsControlWakeupBatch({
    claimWakeups: async () => ({
      claimToken: '50000000-0000-4000-8000-000000000001',
      wakeups: [{
        id: 2,
        tenant_id: tenantId,
        source_type: 'capture_recovery_backfill',
        source_id: tenantId,
        reason: 'capture_recovery_backfill',
      }],
    }),
    processRecoveryWakeups: async input => {
      recoveryCalls += 1;
      assert.equal(input.tenantId, tenantId);
      assert.equal(input.wakeups[0].source_type, 'capture_recovery_backfill');
      return {kind: 'observed', actionsExecuted: 0};
    },
    observeTenant: async () => ({result: {kind: 'disabled'}, policy: null}),
    completeWakeups: async () => 1,
    retryWakeups: async () => assert.fail('backfill routing should not retry'),
    cleanupWakeups: async () => 0,
  });
  assert.equal(recoveryCalls, 1);
  assert.equal(result.results[0].recovery.kind, 'observed');
  assert.equal(result.results[0].recovery.actionsExecuted, 0);
});

test('wakeup runtime enqueues enabled-tenant recovery backfills once at startup', async () => {
  let signalBackfill;
  const backfillCalled = new Promise(resolve => { signalBackfill = resolve; });
  let backfillCalls = 0;
  let backfillInput = null;
  let listenerCloses = 0;
  const runtime = startOpsControlWakeupRuntime({
    env: {OPS_CONTROL_RECOVERY_GLOBAL_ENABLED: 'true'},
    openListener: async () => ({
      close: async () => { listenerCloses += 1; },
    }),
    enqueueRecoveryBackfills: async input => {
      backfillCalls += 1;
      backfillInput = input;
      signalBackfill();
      return {kind: 'enqueued', tenants: 1, enqueued: 1};
    },
    processBatch: async () => ({claimed: 0}),
    getNextWakeupAt: async () => null,
    recordState: async () => {},
    createDrain: () => ({
      run: async callback => callback(),
      stopAccepting() {},
      waitForIdle: async () => ({drained: true, timedOut: false, inFlight: 0}),
      get inFlightCount() { return 0; },
    }),
    setTimer: () => 1,
    clearTimer: () => {},
    now: () => new Date('2026-08-25T01:00:00.000Z'),
  });
  await backfillCalled;
  assert.equal(backfillCalls, 1);
  assert.equal(
    backfillInput.env.OPS_CONTROL_RECOVERY_GLOBAL_ENABLED,
    'true',
  );
  assert.equal(typeof backfillInput.enqueueWakeup, 'function');
  await runtime.stop();
  assert.equal(listenerCloses, 1);
});

test('migration and wiring keep guarded item recovery durable and default-off', async () => {
  const [migration, service, wakeup, productionEnv, recordStore] = await Promise.all([
    readFile(new URL('../server/db/migrations/074_capture_recovery_intents.sql', import.meta.url), 'utf8'),
    readFile(new URL('../server/services/capture-recovery-intents.js', import.meta.url), 'utf8'),
    readFile(new URL('../server/services/ops-control-wakeup.js', import.meta.url), 'utf8'),
    readFile(new URL('../deploy/onstarvoice.env.production.example', import.meta.url), 'utf8'),
    readFile(new URL('../server/services/record-store.js', import.meta.url), 'utf8'),
  ]);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS capture_recovery_intents/u);
  assert.match(migration, /uniq_capture_tasks_id_tenant/u);
  assert.match(migration, /uniq_capture_task_attempts_id_tenant/u);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS app_version TEXT/u);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS health_evidence JSONB/u);
  assert.match(migration, /pg_column_size\(health_evidence\) <= 4096/u);
  assert.match(migration, /UNIQUE \(tenant_id, item_id, generation\)/u);
  assert.match(migration, /UNIQUE \(tenant_id, source_fingerprint\)/u);
  assert.match(migration, /source_execution_attempt_id/u);
  assert.match(migration, /dispatched_attempt_id/u);
  assert.match(migration, /recovery_task_id/u);
  assert.match(migration, /'waiting_agent'/u);
  assert.match(migration, /trg_ops_control_capture_recovery_item/u);
  assert.match(
    migration,
    /FUNCTION enqueue_capture_recovery_wakeup[\s\S]*ops_control_recovery_enabled[\s\S]*RETURN NULL/u,
  );
  assert.match(
    migration,
    /FUNCTION notify_ops_control_capture_recovery_item[\s\S]*PERFORM enqueue_capture_recovery_wakeup/u,
  );
  assert.match(migration, /trg_ops_control_capture_recovery_agent_slot/u);
  assert.match(migration, /'capture_recovery_agent_slot'/u);
  assert.match(migration, /trg_ops_control_capture_recovery_enabled/u);
  assert.match(migration, /idx_capture_task_items_recovery_backfill/u);
  assert.match(migration, /'capture_recovery_backfill'/u);
  assert.match(migration, /cascadeStopDeadlineAt/u);
  assert.match(migration, /make_interval\(secs => cascade_stop_backoff_seconds\)/u);
  assert.match(migration, /duty_recovery_stop_verification_deadline_exceeded/u);
  assert.match(migration, /supersededCreateCommandId/u);
  assert.match(migration, /pg_try_advisory_xact_lock/u);
  assert.match(migration, /recovery_agent_auth_binding_id/u);
  assert.match(migration, /notify_capture_recovery_intent_stopped/u);
  assert.match(migration, /notify_capture_recovery_child_terminal/u);
  assert.match(
    migration,
    /FUNCTION stop_capture_recovery_for_watchlist_delete[\s\S]*IF EXISTS \([\s\S]*FROM capture_recovery_intents intent/u,
  );
  assert.match(
    migration,
    /FUNCTION stop_capture_recovery_for_subscription_change[\s\S]*IF EXISTS \([\s\S]*FROM capture_recovery_intents intent/u,
  );
  assert.match(migration, /notify_ops_control_capture_recovery_entitlement_slot/u);
  assert.match(migration, /NEW\.id::text = duty_recovery_intent_id/u);
  assert.match(
    migration,
    /NEW\.id::text = duty_recovery_intent_id[\s\S]*UPDATE capture_recovery_intents intent[\s\S]*status = 'stopped_by_user'/u,
  );
  assert.match(
    migration,
    /OLD\.auth_code_id IS DISTINCT FROM NEW\.auth_code_id/u,
  );
  assert.match(
    migration,
    /OLD\.auth_binding_id IS DISTINCT FROM NEW\.auth_binding_id/u,
  );
  assert.doesNotMatch(migration, /now\(\) \+ interval '15 seconds'/u);
  assert.doesNotMatch(
    migration,
    /ON DELETE SET NULL \([^)]+\)/u,
    'production PostgreSQL 14 cannot parse a SET NULL target-column list',
  );
  assert.match(migration, /new_enabled AND NOT old_enabled/u);
  assert.match(migration, /\('ops_control_recovery_enabled', 'false'\)/u);
  assert.match(migration, /\('ops_control_recovery_mode', 'observe'\)/u);
  assert.doesNotMatch(migration, /'observing'/u);
  assert.match(service, /FOR UPDATE SKIP LOCKED/u);
  assert.match(service, /scanCaptureRecoveryBackfillPage/u);
  assert.match(service, /item\.created_at <= \$3::timestamptz/u);
  assert.match(service, /actionsEnabled: false/u);
  assert.match(service, /dispatchCrossDeviceRetry/u);
  assert.doesNotMatch(service, /reconcileAutomaticCaptureRetries/u);
  assert.match(service, /commandStateIsNotBusinessSuccess/u);
  assert.match(service, /business_outcome_verified/u);
  assert.match(
    service,
    /observation\.monitor_execution_id = monitor_execution\.id[\s\S]*observation\.capture_task_item_attempt_id =[\s\S]*intent\.dispatched_attempt_id/u,
  );
  assert.match(
    recordStore,
    /task\.metadata->>'dutyRecovery' IS DISTINCT FROM 'true'[\s\S]*attempt\.id = \$10::uuid[\s\S]*attempt\.request_hash = \$11[\s\S]*intent\.status = 'verifying_collection'/u,
  );
  assert.match(
    service,
    /latest\?\.status === 'stopped_by_user'[\s\S]*kind: 'stopped_by_user'/u,
  );
  assert.match(
    service,
    /const KNOWN_RECOVERY_DISPATCH_ERRORS[\s\S]*'retry_profile_subscription_busy'/u,
  );
  assert.match(
    service,
    /const shortRetry = \[[\s\S]*'retry_profile_subscription_busy'/u,
  );
  assert.match(wakeup, /processCaptureRecoveryWakeups/u);
  assert.match(wakeup, /CAPTURE_RECOVERY_AGENT_SLOT_SOURCE_TYPE/u);
  assert.match(wakeup, /CAPTURE_RECOVERY_BACKFILL_SOURCE_TYPE/u);
  assert.match(wakeup, /enqueueCaptureRecoveryBackfillsForEnabledTenants/u);
  assert.match(productionEnv, /OPS_CONTROL_RECOVERY_GLOBAL_ENABLED=false/u);
  assert.match(productionEnv, /OPS_CONTROL_RECOVERY_ACTIONS_GLOBAL_ENABLED=false/u);
});
