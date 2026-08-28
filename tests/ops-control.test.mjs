import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assessOpsControlSnapshots,
  buildOpsControlDigest,
  buildOpsControlDigestHtml,
  buildOpsControlIncidentAlertHtml,
  buildOpsControlTaskWindow,
  buildOpsControlWindow,
  getOpsControlPublicHealth,
  getOpsControlTenantSummary,
  maybeDeliverOpsControlIncidentAlerts,
  normalizeOpsControlEvidence,
  normalizeOpsControlActionAllowlist,
  normalizeOpsControlSettingPatch,
  normalizeOpsControlSettings,
  resolveOpsControlObservationPolicy,
  normalizeOpsControlTaskWakeState,
  OPS_CONTROL_RUNTIME_BASELINE_VERSION,
  OPS_CONTROL_TASK_WAKE_GRACE_SECONDS,
  OpsControlSettingsError,
  resolveOpsControlGlobalEnabled,
  resolveOpsControlActionsGlobalEnabled,
} from '../server/services/ops-control.js';
import {
  selectOpsControlActionCandidates,
  verifyOpsControlAction,
} from '../server/services/ops-control-actions.js';

function source(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

function policy(overrides = {}) {
  return normalizeOpsControlSettings({
    ops_control_enabled: 'true',
    ops_control_mode: 'observe',
    ops_control_window_start: '05:30',
    ops_control_window_end: '08:30',
    ops_control_digest_time: '08:35',
    ops_control_snapshot_gap_seconds: '25',
    ops_control_stale_after_seconds: '120',
    ops_control_ai_stale_after_seconds: '300',
    ...overrides,
  }, {env: {OPS_CONTROL_GLOBAL_ENABLED: 'true'}});
}

test('a recovery observation override disables an otherwise guarded policy', () => {
  const guarded = normalizeOpsControlSettings({
    ops_control_enabled: 'true',
    ops_control_mode: 'guarded',
    ops_control_action_allowlist: 'capture_retry,elastic_requeue',
  }, {
    env: {
      OPS_CONTROL_GLOBAL_ENABLED: 'true',
      OPS_CONTROL_ACTIONS_GLOBAL_ENABLED: 'true',
    },
  });
  assert.equal(guarded.actionsEnabled, true);

  const forced = resolveOpsControlObservationPolicy(guarded, {
    forceObserveOnly: true,
  });
  assert.equal(forced.enabled, true);
  assert.equal(forced.actionsGlobalEnabled, true);
  assert.equal(forced.configuredMode, 'guarded');
  assert.equal(forced.mode, 'observe');
  assert.equal(forced.actionsEnabled, false);
  assert.equal(forced.observeOnly, true);
  assert.equal(forced.forcedObserveOnly, true);
  assert.deepEqual(forced.actionAllowlist, []);
});

function snapshot(capturedAt, overrides = {}) {
  const base = {
    capturedAt,
    schedules: [],
    tasks: [],
    agents: [],
    scheduleSummary: {expected: 0, observed: 0, dueUnmaterialized: 0, upcoming: 0},
    taskSummary: {
      total: 0,
      active: 0,
      recovering: 0,
      finalFailedItems: 0,
      finalNeedsActionItems: 0,
      finalSkippedItems: 0,
      recoveredItems: 0,
      historicalFailures: 0,
      progressSeqTotal: 0,
      completedItems: 0,
    },
    agentSummary: {registered: 1, online: 1, baselineCurrent: 1, outdated: 0},
    operations: {activeCommandCount: 0, oldestActiveCommandAt: null},
    persistence: {
      observationCount: 0,
      pendingRecordAiCount: 0,
      oldestPendingRecordAiAt: null,
      completedRecordAiCount: 0,
      pendingCommentAiCount: 0,
      oldestPendingCommentAiAt: null,
      completedCommentAiCount: 0,
    },
    ai: {failoverRoute: 'primary'},
  };
  return {
    ...base,
    ...overrides,
    scheduleSummary: {...base.scheduleSummary, ...overrides.scheduleSummary},
    taskSummary: {...base.taskSummary, ...overrides.taskSummary},
    agentSummary: {...base.agentSummary, ...overrides.agentSummary},
    operations: {...base.operations, ...overrides.operations},
    persistence: {...base.persistence, ...overrides.persistence},
    ai: {...base.ai, ...overrides.ai},
  };
}

function task(overrides = {}) {
  return {
    id: 'task-a',
    title: '早间采集',
    status: 'completed',
    active: false,
    recovering: false,
    progressSeq: 2,
    businessProgressAt: '2026-08-24T00:00:00.000Z',
    startedAt: '2026-08-23T23:40:00.000Z',
    createdAt: '2026-08-23T23:30:00.000Z',
    completedItemCount: 13,
    warningItemCount: 0,
    failedItemCount: 0,
    needsActionItemCount: 0,
    activeItemCount: 0,
    recoveredItemCount: 0,
    historicalFailureCount: 0,
    ...overrides,
  };
}

test('control plane defaults to tenant-off observe-only mode with an explicit global kill switch', () => {
  const defaults = normalizeOpsControlSettings({}, {env: {}});
  assert.equal(defaults.globalEnabled, true);
  assert.equal(defaults.tenantEnabled, false);
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.mode, 'observe');
  assert.equal(defaults.observeOnly, true);
  assert.equal(defaults.actionsEnabled, false);
  assert.equal(defaults.actionsGlobalEnabled, false);
  assert.equal(defaults.llmEnabled, false);
  assert.equal(defaults.runtimeBaselineVersion, '0.3.96');
  assert.equal(resolveOpsControlGlobalEnabled({OPS_CONTROL_GLOBAL_ENABLED: 'off'}), false);
  assert.equal(resolveOpsControlActionsGlobalEnabled({}), false);
  assert.equal(resolveOpsControlActionsGlobalEnabled({OPS_CONTROL_ACTIONS_GLOBAL_ENABLED: 'true'}), true);

  const globallyStopped = normalizeOpsControlSettings({
    ops_control_enabled: 'true',
  }, {env: {OPS_CONTROL_GLOBAL_ENABLED: 'false'}});
  assert.equal(globallyStopped.tenantEnabled, true);
  assert.equal(globallyStopped.enabled, false);

  const guarded = normalizeOpsControlSettings({
    ops_control_enabled: 'true',
    ops_control_mode: 'guarded',
    ops_control_action_allowlist: 'capture_retry,schedule_materialize',
  }, {env: {
    OPS_CONTROL_GLOBAL_ENABLED: 'true',
    OPS_CONTROL_ACTIONS_GLOBAL_ENABLED: 'true',
  }});
  assert.equal(guarded.enabled, true);
  assert.equal(guarded.mode, 'guarded');
  assert.equal(guarded.observeOnly, false);
  assert.equal(guarded.actionsEnabled, true);
  assert.deepEqual(guarded.actionAllowlist, ['capture_retry', 'schedule_materialize']);
  assert.deepEqual(
    normalizeOpsControlActionAllowlist('capture_retry,capture_retry,unknown'),
    ['capture_retry'],
  );
});

test('settings patch accepts bounded observe or guarded control-plane values', () => {
  const normalized = normalizeOpsControlSettingPatch({
    ops_control_enabled: true,
    ops_control_mode: 'observe',
    ops_control_recovery_enabled: true,
    ops_control_recovery_mode: 'guarded',
    ops_control_window_start: '05:45',
    ops_control_window_end: '08:45',
    ops_control_snapshot_gap_seconds: 30,
  }, {});
  assert.deepEqual(normalized, {
    ops_control_enabled: 'true',
    ops_control_mode: 'observe',
    ops_control_recovery_enabled: 'true',
    ops_control_recovery_mode: 'guarded',
    ops_control_window_start: '05:45',
    ops_control_window_end: '08:45',
    ops_control_snapshot_gap_seconds: '30',
  });
  assert.throws(
    () => normalizeOpsControlSettingPatch({ops_control_mode: 'enforce'}),
    OpsControlSettingsError,
  );
  assert.throws(
    () => normalizeOpsControlSettingPatch({ops_control_recovery_mode: 'enforce'}),
    /只允许 observe 或 guarded/u,
  );
  assert.throws(
    () => normalizeOpsControlSettingPatch({ops_control_unknown: 'true'}),
    OpsControlSettingsError,
  );
  assert.throws(
    () => normalizeOpsControlSettingPatch({
      ops_control_action_allowlist: 'capture_retry,delete_everything',
    }),
    /未知动作/u,
  );
  assert.throws(
    () => normalizeOpsControlSettingPatch({
      ops_control_window_start: '09:00',
      ops_control_window_end: '08:00',
    }),
    /结束时间必须晚于开始时间/u,
  );
  assert.throws(
    () => normalizeOpsControlSettingPatch({
      ops_control_digest_email_enabled: true,
      ops_control_digest_email_to: '',
    }),
    /必须填写收件人/u,
  );
});

test('tenant summary recovery totals come from tenant-wide aggregates, not the 20-row display slice', async () => {
  const displayedIntents = Array.from({length: 20}, (_, index) => ({
    id: `intent-${index + 1}`,
    status: index === 0 ? 'waiting_human' : 'resolved',
  }));
  const summary = await getOpsControlTenantSummary(
    '10000000-0000-4000-8000-000000000001',
    {
      env: {OPS_CONTROL_GLOBAL_ENABLED: 'true'},
      getSettings: async () => ({
        ops_control_enabled: 'true',
        ops_control_mode: 'observe',
      }),
      queryOne: async sql => {
        if (/COUNT\(\*\) FILTER[\s\S]*FROM capture_recovery_intents/u.test(sql)) {
          return {open_count: '25', human_required_count: '7', total_count: '31'};
        }
        return null;
      },
      queryAll: async sql => (
        /FROM capture_recovery_intents/u.test(sql) ? displayedIntents : []
      ),
    },
  );
  assert.equal(summary.recovery.intents.length, 20);
  assert.equal(summary.recovery.openCount, 25);
  assert.equal(summary.recovery.humanRequiredCount, 7);
  assert.equal(summary.recovery.totalCount, 31);
});

test('tenant summary reports the effective duty recovery gates instead of a hard-coded observe mode', async () => {
  const summary = await getOpsControlTenantSummary(
    '10000000-0000-4000-8000-000000000002',
    {
      env: {
        OPS_CONTROL_GLOBAL_ENABLED: 'true',
        OPS_CONTROL_RECOVERY_GLOBAL_ENABLED: 'true',
        OPS_CONTROL_RECOVERY_ACTIONS_GLOBAL_ENABLED: 'true',
      },
      getSettings: async () => ({
        ops_control_enabled: 'true',
        ops_control_recovery_enabled: 'true',
        ops_control_recovery_mode: 'guarded',
      }),
      queryOne: async sql => (
        /COUNT\(\*\) FILTER[\s\S]*FROM capture_recovery_intents/u.test(sql)
          ? {
              open_count: '2',
              human_required_count: '1',
              stop_manual_required_count: '1',
              total_count: '3',
            }
          : null
      ),
      queryAll: async () => [],
    },
  );
  assert.equal(summary.recovery.mode, 'guarded');
  assert.equal(summary.recovery.enabled, true);
  assert.equal(summary.recovery.actionsEnabled, true);
  assert.equal(summary.recovery.gate.blockedReason, '');
  assert.equal(summary.recovery.stopManualRequiredCount, 1);
});

test('Shanghai observation window is deterministic and includes the digest deadline', () => {
  const window = buildOpsControlWindow(
    new Date('2026-08-24T00:00:00.000Z'),
    policy(),
  );
  assert.equal(window.serviceDate, '2026-08-24');
  assert.equal(window.start.toISOString(), '2026-08-23T21:30:00.000Z');
  assert.equal(window.end.toISOString(), '2026-08-24T00:30:00.000Z');
  assert.equal(window.digestAt.toISOString(), '2026-08-24T00:35:00.000Z');
});

test('task activity wakes the control plane outside the configured morning window', () => {
  const active = normalizeOpsControlTaskWakeState({
    active_task_count: '1',
    recent_task_count: '1',
    active_command_count: '0',
    pending_action_count: '0',
  });
  assert.equal(active.shouldWake, true);
  assert.equal(active.reason, 'active_task');
  assert.equal(active.activeTaskCount, 1);

  const settling = normalizeOpsControlTaskWakeState({recent_task_count: 1});
  assert.equal(settling.shouldWake, true);
  assert.equal(settling.reason, 'recent_task_settlement');

  const idle = normalizeOpsControlTaskWakeState({});
  assert.equal(idle.shouldWake, false);
  assert.equal(idle.reason, 'idle');

  const now = new Date('2026-08-24T12:00:00.000Z');
  const configured = buildOpsControlWindow(now, policy());
  const taskWindow = buildOpsControlTaskWindow(now, configured);
  assert.equal(taskWindow.serviceDate, '2026-08-24');
  assert.equal(taskWindow.start.toISOString(), '2026-08-23T21:30:00.000Z');
  assert.equal(taskWindow.end.toISOString(), '2026-08-24T12:01:00.000Z');
  assert.equal(
    taskWindow.observationDeadline.toISOString(),
    '2026-08-24T12:31:00.000Z',
  );
  assert.equal(OPS_CONTROL_TASK_WAKE_GRACE_SECONDS, 1800);
});

test('a single snapshot cannot declare healthy or stalled', () => {
  const current = snapshot('2026-08-24T00:01:00.000Z');
  const assessment = assessOpsControlSnapshots(null, current, policy());
  assert.equal(assessment.verdict, 'pending');
  assert.equal(assessment.lifecycleStatus, 'observing');
  assert.equal(assessment.summary.consecutiveEvidence, false);
  assert.deepEqual(assessment.incidents, []);
});

test('a duty recovery child that missed its stop deadline is immediately critical', () => {
  const current = snapshot('2026-08-24T00:01:00.000Z', {
    operations: {
      manualRecoveryStopCount: 1,
      manualRecoveryStopTaskId: 'recovery-child-a',
    },
  });
  const assessment = assessOpsControlSnapshots(null, current, policy());
  assert.equal(assessment.verdict, 'incident');
  const incident = assessment.incidents.find(
    row => row.type === 'duty_recovery_stop_failed',
  );
  assert.equal(incident.severity, 'critical');
  assert.equal(incident.evidence.userStopBoundaryPreserved, true);
});

test('historical failed attempts followed by final success remain healthy and are counted as recovered', () => {
  const previous = snapshot('2026-08-24T00:00:00.000Z', {
    tasks: [task({recoveredItemCount: 1, historicalFailureCount: 2})],
    taskSummary: {total: 1, recoveredItems: 1, historicalFailures: 2, completedItems: 13},
  });
  const current = snapshot('2026-08-24T00:01:00.000Z', {
    tasks: [task({recoveredItemCount: 1, historicalFailureCount: 2})],
    taskSummary: {total: 1, recoveredItems: 1, historicalFailures: 2, completedItems: 13},
  });
  const assessment = assessOpsControlSnapshots(previous, current, policy());
  assert.equal(assessment.lifecycleStatus, 'settled');
  assert.equal(assessment.verdict, 'healthy');
  assert.equal(assessment.summary.recoveredItemCount, 1);
  assert.equal(assessment.summary.historicalFailureCount, 2);
  assert.match(assessment.summary.headline, /已自动恢复/u);
  assert.deepEqual(assessment.incidents, []);
});

test('fresh business progress is progressing while stale active work becomes an incident', () => {
  const previousTask = task({
    status: 'running',
    active: true,
    progressSeq: 3,
    activeItemCount: 2,
    completedItemCount: 5,
    businessProgressAt: '2026-08-23T23:50:00.000Z',
  });
  const progressingTask = task({
    ...previousTask,
    progressSeq: 4,
    activeItemCount: 1,
    completedItemCount: 6,
    businessProgressAt: '2026-08-24T00:00:45.000Z',
  });
  const previous = snapshot('2026-08-24T00:00:00.000Z', {
    tasks: [previousTask],
    taskSummary: {total: 1, active: 1, progressSeqTotal: 3, completedItems: 5},
  });
  const progressing = snapshot('2026-08-24T00:01:00.000Z', {
    tasks: [progressingTask],
    taskSummary: {total: 1, active: 1, progressSeqTotal: 4, completedItems: 6},
  });
  const progressAssessment = assessOpsControlSnapshots(previous, progressing, policy());
  assert.equal(progressAssessment.lifecycleStatus, 'progressing');
  assert.equal(progressAssessment.verdict, 'healthy');
  assert.equal(progressAssessment.summary.progressingTaskCount, 1);

  const stale = snapshot('2026-08-24T00:01:00.000Z', {
    tasks: [previousTask],
    taskSummary: {total: 1, active: 1, progressSeqTotal: 3, completedItems: 5},
  });
  const staleAssessment = assessOpsControlSnapshots(previous, stale, policy());
  assert.equal(staleAssessment.verdict, 'incident');
  assert.equal(staleAssessment.summary.stalledTaskCount, 1);
  assert.ok(staleAssessment.incidents.some(row => row.type === 'capture_task_stalled'));
});

test('consecutive evidence detects missing schedules, an offline agent pool, stale commands and a stalled AI backlog', () => {
  const activeTask = task({
    status: 'running',
    active: true,
    progressSeq: 3,
    activeItemCount: 1,
    businessProgressAt: '2026-08-23T23:50:00.000Z',
  });
  const persistence = {
    pendingRecordAiCount: 2,
    oldestPendingRecordAiAt: '2026-08-23T23:50:00.000Z',
    completedRecordAiCount: 4,
  };
  const previous = snapshot('2026-08-24T00:00:00.000Z', {
    tasks: [activeTask],
    taskSummary: {total: 1, active: 1, progressSeqTotal: 3},
    agentSummary: {registered: 1, online: 0},
    persistence,
  });
  const current = snapshot('2026-08-24T00:01:00.000Z', {
    schedules: [{
      id: 'schedule-a',
      title: '早间计划',
      occurrenceState: 'due_unmaterialized',
      nextRunAt: '2026-08-23T23:50:00.000Z',
    }],
    scheduleSummary: {
      expected: 2,
      observed: 0,
      expectedIds: ['schedule-a', 'schedule-missing'],
      missingFrozenIds: ['schedule-missing'],
    },
    tasks: [activeTask],
    taskSummary: {total: 1, active: 1, progressSeqTotal: 3},
    agentSummary: {registered: 1, online: 0},
    operations: {
      activeCommandCount: 1,
      oldestActiveCommandAt: '2026-08-23T23:50:00.000Z',
    },
    persistence,
  });
  const assessment = assessOpsControlSnapshots(previous, current, policy());
  const types = new Set(assessment.incidents.map(row => row.type));
  assert.equal(assessment.verdict, 'incident');
  for (const type of [
    'schedule_occurrence_missing',
    'expected_schedule_missing',
    'agent_pool_unavailable',
    'capture_command_stale',
    'ai_backlog_stalled',
  ]) assert.ok(types.has(type), `missing ${type}`);
});

test('manual final state is separated from a system incident', () => {
  const previous = snapshot('2026-08-24T00:00:00.000Z', {
    tasks: [task({status: 'needs_action', needsActionItemCount: 1})],
    taskSummary: {total: 1, finalNeedsActionItems: 1},
  });
  const current = snapshot('2026-08-24T00:01:00.000Z', {
    tasks: [task({status: 'needs_action', needsActionItemCount: 1})],
    taskSummary: {total: 1, finalNeedsActionItems: 1},
  });
  const assessment = assessOpsControlSnapshots(previous, current, policy());
  assert.equal(assessment.lifecycleStatus, 'settled');
  assert.equal(assessment.verdict, 'blocked_manual');
  assert.equal(assessment.summary.manualBlockerCount, 1);
  assert.ok(assessment.incidents.some(row => row.type === 'manual_intervention_required'));
  assert.equal(assessment.summary.redIncidentCount, 0);
});

test('a task-level terminal failure is not hidden when no work item was created', () => {
  const failedTask = task({
    status: 'failed',
    itemTotal: 0,
    failedItemCount: 0,
    skippedItemCount: 0,
  });
  const previous = snapshot('2026-08-24T00:00:00.000Z', {
    tasks: [failedTask],
    taskSummary: {total: 1},
  });
  const current = snapshot('2026-08-24T00:01:00.000Z', {
    tasks: [failedTask],
    taskSummary: {total: 1},
  });
  const assessment = assessOpsControlSnapshots(previous, current, policy());
  assert.equal(assessment.lifecycleStatus, 'settled');
  assert.equal(assessment.verdict, 'degraded');
  assert.equal(assessment.summary.finalFailureCount, 1);
  assert.ok(assessment.incidents.some(row => row.type === 'final_task_failure'));
});

test('guarded actions select only allowlisted safe targets and require later verification', () => {
  const failedTask = task({
    status: 'completed_with_failures',
    failedItemCount: 1,
  });
  const previous = snapshot('2026-08-24T00:00:00.000Z', {
    tasks: [failedTask],
    taskSummary: {total: 1, finalFailedItems: 1},
  });
  const current = snapshot('2026-08-24T00:01:00.000Z', {
    tasks: [failedTask],
    taskSummary: {total: 1, finalFailedItems: 1},
  });
  const assessment = assessOpsControlSnapshots(previous, current, policy());
  const candidates = selectOpsControlActionCandidates(assessment, current, {
    allowlist: ['capture_retry'],
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].actionType, 'capture_retry');
  assert.equal(candidates[0].targetId, 'task-a');

  const action = {
    action_type: 'capture_retry',
    target_id: 'task-a',
    request: {before: candidates[0].before},
    verification_due_at: '2026-08-24T00:20:00.000Z',
  };
  const inProgress = verifyOpsControlAction(action, current, {
    now: new Date('2026-08-24T00:02:00.000Z'),
  });
  assert.equal(inProgress.status, 'pending_verification');
  const recovered = snapshot('2026-08-24T00:03:00.000Z', {
    tasks: [task({
      status: 'completed',
      completedItemCount: 1,
      recoveredItemCount: 1,
    })],
    taskSummary: {total: 1, completedItems: 1, recoveredItems: 1},
  });
  assert.equal(verifyOpsControlAction(action, recovered, {
    now: new Date('2026-08-24T00:03:00.000Z'),
  }).status, 'verified');
});

test('terminal parent status absorbs stale active child residue in normalized task evidence', () => {
  const normalized = normalizeOpsControlEvidence({
    capturedAt: '2026-08-24T00:01:00.000Z',
    schedules: [],
    agents: [],
    operations: {},
    persistence: {},
    ai: {},
    tasks: [{
      id: 'task-terminal',
      status: 'completed',
      item_total: 1,
      active_item_count: 1,
      active_child_count: 1,
    }],
  });
  assert.equal(normalized.tasks[0].active, false);
  assert.equal(normalized.taskSummary.active, 0);
});

test('control-plane agent evidence separates connection, task-state health, and auxiliary warnings', () => {
  const normalized = normalizeOpsControlEvidence({
    capturedAt: '2026-08-27T06:00:00.000Z',
    schedules: [],
    tasks: [],
    operations: {},
    persistence: {},
    ai: {},
    agents: [
      {
        id: 'task-state-missing',
        status: 'active',
        last_liveness_at: '2026-08-27T05:59:50.000Z',
        last_full_heartbeat_at: '2026-08-27T05:59:40.000Z',
        capabilities: {taskStateKnown: false, heartbeatDegraded: true},
      },
      {
        id: 'auxiliary-warning',
        status: 'active',
        last_liveness_at: '2026-08-27T05:59:50.000Z',
        last_full_heartbeat_at: '2026-08-27T05:59:40.000Z',
        capabilities: {taskStateKnown: true, heartbeatDegraded: true},
      },
      {
        id: 'legacy-offline',
        status: 'active',
        last_heartbeat_at: '2026-08-27T05:40:00.000Z',
        capabilities: {},
      },
    ],
  });
  const incomplete = normalized.agents[0];
  assert.equal(incomplete.connected, true);
  assert.equal(incomplete.fullHeartbeatHealthy, false);
  assert.equal(incomplete.online, false);
  assert.equal(incomplete.heartbeatDegraded, true);

  const auxiliary = normalized.agents[1];
  assert.equal(auxiliary.connected, true);
  assert.equal(auxiliary.fullHeartbeatHealthy, true);
  assert.equal(auxiliary.online, true);
  assert.equal(auxiliary.heartbeatDegraded, true);

  const offline = normalized.agents[2];
  assert.equal(offline.connected, false);
  assert.equal(offline.fullHeartbeatHealthy, false);
  assert.equal(offline.online, false);
});

test('digest is deterministic, identifies observe-only mode and does not claim an LLM action', () => {
  const current = snapshot('2026-08-24T00:01:00.000Z');
  const assessment = assessOpsControlSnapshots(
    snapshot('2026-08-24T00:00:00.000Z'),
    current,
    policy(),
  );
  const digest = buildOpsControlDigest(assessment, current, {serviceDate: '2026-08-24'});
  const html = buildOpsControlDigestHtml(digest);
  assert.equal(digest.payload.llmUsed, false);
  assert.equal(digest.payload.runtimeBaselineVersion, OPS_CONTROL_RUNTIME_BASELINE_VERSION);
  assert.match(html, /未调用大模型/u);
  assert.match(html, /未执行采集业务写操作/u);
});

test('immediate alert explains that no guarded action is awaiting verification', () => {
  const html = buildOpsControlIncidentAlertHtml([{
    title: '执行端 Agent 全部离线',
    message: '仍有任务未完成，但没有在线执行端 Agent',
  }], {mode: 'guarded'});
  assert.match(html, /当前没有正在等待验收的自动恢复动作/u);
  assert.match(html, /执行端 Agent 全部离线/u);
  assert.match(html, /受控动作模式/u);
  assert.match(html, /未调用大模型/u);
});

test('immediate alert waits for consecutive evidence before touching delivery state', async () => {
  const result = await maybeDeliverOpsControlIncidentAlerts({
    tenantId: 'tenant-a',
    run: {id: 'run-a'},
    policy: {digestEmailEnabled: true, digestEmailTo: 'ops@example.test'},
    assessment: {summary: {consecutiveEvidence: false}},
    withTransaction: async () => {
      assert.fail('delivery state was touched before consecutive evidence');
    },
  });
  assert.equal(result.status, 'awaiting_evidence');
  assert.equal(result.attempted, false);
});

test('public sentinel health fails closed on a degraded or stale scheduler', async () => {
  const now = new Date('2026-08-24T00:03:00.000Z');
  const degraded = await getOpsControlPublicHealth({
    now,
    env: {OPS_CONTROL_ACTIONS_GLOBAL_ENABLED: 'true'},
    queryOne: async () => ({
      scheduler: {
        status: 'degraded',
        mode: 'guarded',
        updated_at: '2026-08-24T00:02:30.000Z',
        cycle_sequence: 7,
      },
      event_listener: {
        status: 'healthy',
        mode: 'guarded',
        updated_at: '2026-08-24T00:02:45.000Z',
        cycle_sequence: 2,
        details: {connected: true},
      },
    }),
  });
  assert.equal(degraded.ok, false);
  assert.equal(degraded.status, 'degraded');
  assert.equal(degraded.mode, 'guarded');
  assert.equal(degraded.actionsGlobalEnabled, true);

  const stale = await getOpsControlPublicHealth({
    now,
    queryOne: async () => ({
      scheduler: {
        status: 'healthy',
        mode: 'observe',
        updated_at: '2026-08-23T23:50:00.000Z',
        cycle_sequence: 8,
      },
      event_listener: {
        status: 'healthy',
        mode: 'observe',
        updated_at: '2026-08-24T00:02:45.000Z',
        cycle_sequence: 3,
        details: {connected: true},
      },
    }),
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.status, 'stale');

  const disconnected = await getOpsControlPublicHealth({
    now,
    queryOne: async () => ({
      scheduler: {
        status: 'healthy',
        mode: 'observe',
        updated_at: '2026-08-24T00:02:30.000Z',
        cycle_sequence: 9,
      },
      event_listener: {
        status: 'healthy',
        mode: 'observe',
        updated_at: '2026-08-24T00:02:45.000Z',
        cycle_sequence: 4,
        details: {connected: false},
      },
    }),
  });
  assert.equal(disconnected.ok, false);
  assert.equal(disconnected.status, 'event_listener_degraded');
  assert.equal(disconnected.eventListenerConnected, false);
});

test('migrations, API, scheduler and Admin UI wire the guarded control plane through isolated adapters', async () => {
  const [migration, actionMigration, alertMigration, eventMigration, service, wakeupService, actionService, route, app, cron, schedulerRuntime, overview, mobileApp, settingsPage, adminRoute, productionEnvExample] = await Promise.all([
    source('server/db/migrations/070_ops_control_plane.sql'),
    source('server/db/migrations/071_ops_control_guarded_actions.sql'),
    source('server/db/migrations/072_ops_control_incident_alerts.sql'),
    source('server/db/migrations/073_ops_control_event_wakeups.sql'),
    source('server/services/ops-control.js'),
    source('server/services/ops-control-wakeup.js'),
    source('server/services/ops-control-actions.js'),
    source('server/routes/ops-control.js'),
    source('server/app.js'),
    source('server/cron.js'),
    source('server/runtime/scheduler-runtime.js'),
    source('web/admin/src/pages/OverviewPage.tsx'),
    source('web/admin/src/mobile/MobileApp.tsx'),
    source('web/admin/src/pages/AdminPages.tsx'),
    source('server/routes/admin.js'),
    source('deploy/onstarvoice.env.production.example'),
  ]);

  for (const table of [
    'ops_control_system_state',
    'ops_control_runs',
    'ops_control_snapshots',
    'ops_control_incidents',
    'ops_control_digests',
  ]) assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, 'u'));
  assert.match(migration, /\('ops_control_enabled', 'false'\)/u);
  assert.match(migration, /\('ops_control_mode', 'observe'\)/u);
  assert.match(migration, /runtime_baseline_version TEXT NOT NULL DEFAULT '0\.3\.91'/u);
  assert.match(actionMigration, /CREATE TABLE IF NOT EXISTS ops_control_actions/u);
  assert.match(actionMigration, /CHECK \(mode IN \('observe', 'guarded'\)\)/u);
  assert.match(actionMigration, /\('ops_control_action_allowlist', ''\)/u);
  assert.match(alertMigration, /alert_delivery_status/u);
  assert.match(alertMigration, /idx_ops_control_incidents_alert_delivery/u);
  assert.match(eventMigration, /CREATE TABLE IF NOT EXISTS ops_control_wakeups/u);
  assert.match(eventMigration, /CREATE OR REPLACE FUNCTION enqueue_ops_control_wakeup/u);
  assert.match(eventMigration, /pg_notify\('ops_control_wakeup'/u);
  assert.match(eventMigration, /trg_ops_control_capture_task_wakeup/u);
  assert.match(eventMigration, /trg_ops_control_capture_command_wakeup/u);
  assert.match(eventMigration, /trg_ops_control_schedule_wakeup/u);

  assert.doesNotMatch(service, /(?:INSERT INTO|UPDATE|DELETE FROM)\s+capture_(?:tasks|task_items|task_item_attempts|agent_commands)/iu);
  assert.doesNotMatch(service, /(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:records|record_comments|relevance_prefilter_requests)/iu);
  assert.doesNotMatch(service, /deepseek|llm_api_key|child_process|exec\s*\(/iu);
  assert.doesNotMatch(actionService, /(?:INSERT INTO|UPDATE|DELETE FROM)\s+capture_(?:tasks|task_items|task_item_attempts|agent_commands)/iu);
  assert.match(actionService, /maxDispatchesPerTask: 1/u);
  assert.match(actionService, /verification_due_at/u);
  assert.match(service, /maybeDeliverOpsControlIncidentAlerts/u);
  assert.match(service, /action\.status IN \('claimed', 'pending_verification', 'verified'\)/u);
  assert.match(service, /ORDER BY observation\.last_observed_at ASC NULLS FIRST/u);
  assert.match(route, /router\.get\('\/health'/u);
  assert.match(route, /router\.post\([\s\S]*'\/observe-now'/u);
  assert.match(app, /app\.use\('\/api\/ops-control', opsControlRouter\)/u);
  assert.match(cron, /name: 'ops-control-observer'[\s\S]*runOpsControlCycle/u);
  assert.match(cron, /name: 'ops-control-observer'[\s\S]*expression: '\*\/5 \* \* \* \*'/u);
  assert.match(wakeupService, /LISTEN \$\{OPS_CONTROL_WAKEUP_CHANNEL\}/u);
  assert.match(wakeupService, /FOR UPDATE SKIP LOCKED/u);
  assert.match(wakeupService, /runOpsControlTenantObservation/u);
  assert.match(schedulerRuntime, /startOpsControlWakeupRuntime/u);
  assert.match(overview, /data-ops-control-card/u);
  assert.match(overview, /仅执行白名单动作/u);
  assert.match(mobileApp, /data-ops-control-card/u);
  assert.match(mobileApp, /昨夜值守/u);
  assert.match(mobileApp, /仅执行白名单动作/u);
  assert.match(settingsPage, /title="无人值守控制面"/u);
  assert.match(settingsPage, /ops_control_enabled/u);
  assert.match(settingsPage, /ops_control_action_allowlist/u);
  assert.match(settingsPage, /发送异常提醒与运维晨报/u);
  assert.match(adminRoute, /ops\.control_settings_updated/u);
  assert.match(adminRoute, /key NOT IN \([\s\S]*'ops_control_enabled'[\s\S]*'ops_control_digest_email_to'/u);
  assert.match(
    adminRoute,
    /key NOT IN \([\s\S]*'ops_control_recovery_enabled'[\s\S]*'ops_control_recovery_mode'/u,
  );
  assert.match(
    adminRoute,
    /\(\$1, 'ops_control_recovery_enabled', 'false', now\(\)\)[\s\S]*\(\$1, 'ops_control_recovery_mode', 'observe', now\(\)\)/u,
  );
  assert.match(adminRoute, /key NOT LIKE 'ops_control_action_%'/u);
  assert.match(productionEnvExample, /OPS_CONTROL_RECOVERY_GLOBAL_ENABLED=false/u);
  assert.match(
    productionEnvExample,
    /OPS_CONTROL_RECOVERY_ACTIONS_GLOBAL_ENABLED=false/u,
  );
});
