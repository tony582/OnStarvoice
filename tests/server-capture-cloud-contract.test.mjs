import assert from "node:assert/strict";
import crypto from "node:crypto";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import {
  CAPTURE_AGENT_SLOT_BLOCKING_TASK_STATUSES,
  bindCloudTaskSnapshotHealthToAttempt,
  captureAgentFullHeartbeatOnline,
  captureAgentHeartbeatDegraded,
  captureAgentLivenessOnline,
  captureAgentOnline,
  cloudTaskAttemptIdentityAcceptsSnapshot,
  findCaptureAgentExecutionSlotBlocker,
  isCloudTaskActive,
  isCloudTaskTerminal,
  lockCaptureAgentExecutionSlot,
  tryLockCaptureAgentExecutionSlot,
  normalizeCaptureAgentPlatforms,
  normalizeCloudTaskSnapshot,
  normalizeCloudTaskStatus,
  normalizeRemoteTaskInput,
  parseCaptureAgentEnvironment,
  sanitizeCloudStructuredObject,
} from "../server/services/capture-cloud.js";
import {
  captureTaskBusinessRootVisibilitySql,
  captureCreateCommandExpiryEligible,
  captureAgentRemovalBlockerMessage,
  captureTaskSnapshotFingerprint,
  buildSequentialSearchResumeCheckpoint,
  classifyCaptureRecoveryDisposition,
  crossDeviceRetryAgentDailyUsageEligible,
  crossDeviceRetryAgentSupportsTask,
  crossDeviceRetryItemNeedsManualSafety,
  crossDeviceRetrySourceAgentIdsForItems,
  crossDeviceRetryTaskSupported,
  dispatchCrossDeviceRetry,
  elasticAttemptBudgetAfterOutcome,
  projectElasticAttemptBudget,
  projectElasticBootstrapPacing,
  elasticRecoveryHoldRemainingMs,
  evaluateObservedCompletionCandidate,
  isProfilePatrolTask,
  isExplicitUserCancellationSnapshot,
  lockActiveCaptureAgentSession,
  mirrorTaskSnapshot,
  negativePatrolTargetResults,
  orchestrationCheckpointEntries,
  orchestrationCheckpointInteger,
  orchestrationCheckpointTimestamp,
  projectElasticKeywordRecoveryStatus,
  projectCanceledChildItemStatus,
  reconcileAutomaticCaptureRetries,
  reconcileElasticCaptureLeases,
  reconcilePendingCaptureCommands,
  resolveStopCommandOutcome,
  supersedeStalePlanConfigurationAttention,
} from "../server/routes/capture-cloud.js";

const captureCloudRouteSource = await readFile(
  new URL("../server/routes/capture-cloud.js", import.meta.url),
  "utf8",
);
const cronSource = await readFile(
  new URL("../server/cron.js", import.meta.url),
  "utf8",
);

function readRouteSection(startMarker, endMarker) {
  const start = captureCloudRouteSource.indexOf(startMarker);
  assert.notEqual(start, -1, `missing route marker: ${startMarker}`);
  const end = captureCloudRouteSource.indexOf(
    endMarker,
    start + startMarker.length,
  );
  assert.notEqual(end, -1, `missing route marker: ${endMarker}`);
  return captureCloudRouteSource.slice(start, end);
}

test("capture agents distinguish browser profiles while retaining their environment", () => {
  assert.deepEqual(
    parseCaptureAgentEnvironment(
      "Edge on Windows",
      "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/140.0 Edg/140.0",
    ),
    {browserName: "Edge", operatingSystem: "Windows"},
  );
  assert.deepEqual(
    parseCaptureAgentEnvironment(
      "Chrome on macOS",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140.0 Safari/537.36",
    ),
    {browserName: "Chrome", operatingSystem: "macOS"},
  );
});

test("guarded recovery adapters fail closed before an invalid target can widen scope", async () => {
  const tenantId = "11111111-1111-4111-8111-111111111111";
  assert.equal(
    (await reconcilePendingCaptureCommands({
      taskId: "22222222-2222-4222-8222-222222222222",
    })).error,
    "tenant_scope_required",
  );
  assert.equal(
    (await reconcileElasticCaptureLeases({
      tenantId,
      parentTaskIds: ["not-a-uuid"],
      limit: 1,
    })).error,
    "invalid_parent_task_scope",
  );
  assert.equal(
    (await reconcileAutomaticCaptureRetries({
      tenantId,
      taskIds: [],
      limit: 1,
    })).error,
    "invalid_task_scope",
  );
});

test("agent platform assignment is bounded, normalized, and deduplicated", () => {
  assert.deepEqual(
    normalizeCaptureAgentPlatforms(["xhs", "douyin", "DOUYIN", "unknown", "weibo"]),
    ["xiaohongshu", "douyin", "weibo"],
  );
  assert.deepEqual(normalizeCaptureAgentPlatforms("xiaohongshu"), []);
});

test("physical Agent slots ignore attention history but block live commands", async () => {
  assert.deepEqual(CAPTURE_AGENT_SLOT_BLOCKING_TASK_STATUSES, [
    "pending",
    "waiting_device",
    "claimed",
    "running",
    "recovering",
    "resume_requested",
  ]);
  assert.equal(CAPTURE_AGENT_SLOT_BLOCKING_TASK_STATUSES.includes("interrupted"), false);
  assert.equal(CAPTURE_AGENT_SLOT_BLOCKING_TASK_STATUSES.includes("needs_action"), false);

  let statement = null;
  const blocker = {kind: "command", id: "command-id", status: "pending"};
  const executor = {
    async queryOne(sql, params) {
      statement = {sql, params};
      return blocker;
    },
  };
  assert.equal(
    await findCaptureAgentExecutionSlotBlocker(
      executor,
      "tenant-id",
      "agent-id",
      {excludeTaskIds: ["11111111-1111-4111-8111-111111111111"]},
    ),
    blocker,
  );
  assert.match(statement.sql, /task\.status = ANY\(\$3::text\[\]\)/u);
  assert.match(statement.sql, /capture_agent_commands/u);
  assert.match(statement.sql, /command\.status IN \('pending', 'acknowledged'\)/u);
  assert.match(statement.sql, /command\.expires_at IS NULL OR command\.expires_at > now\(\)/u);
  assert.deepEqual(statement.params[2], CAPTURE_AGENT_SLOT_BLOCKING_TASK_STATUSES);
  assert.deepEqual(statement.params[3], ["11111111-1111-4111-8111-111111111111"]);
});

test("cross-device retry supports root business tasks and keyword orchestrations", () => {
  assert.equal(crossDeviceRetryTaskSupported({
    task_type: "unattended_keyword_capture",
    parent_task_id: null,
  }), true);
  assert.equal(crossDeviceRetryTaskSupported({
    task_type: "followed_creator_post_patrol",
    parent_task_id: null,
  }), true);
  assert.equal(crossDeviceRetryTaskSupported({
    task_type: "capture_orchestration",
    parent_task_id: null,
    metadata: {
      promotedRetryParent: true,
      promotedBusinessTaskType: "official_account_comment_patrol",
    },
  }), true);
  assert.equal(crossDeviceRetryTaskSupported({
    task_type: "capture_orchestration",
    parent_task_id: null,
    metadata: {},
  }), true);
  assert.equal(crossDeviceRetryTaskSupported({
    task_type: "capture_orchestration",
    feature_key: "keyword_orchestration",
    parent_task_id: null,
    metadata: {},
  }), true);
  assert.equal(crossDeviceRetryTaskSupported({
    task_type: "capture_orchestration",
    feature_key: "negative_post_patrol",
    parent_task_id: null,
    metadata: {},
  }), true);
  assert.equal(crossDeviceRetryTaskSupported({
    task_type: "negative_post_patrol",
    parent_task_id: "11111111-1111-4111-8111-111111111111",
  }), false);
  assert.equal(crossDeviceRetryTaskSupported({
    task_type: "watched_content_patrol",
    parent_task_id: null,
  }), true);
});

test("recovery grading keeps captcha current and automates technical or unstarted items", () => {
  assert.deepEqual(classifyCaptureRecoveryDisposition({
    status: "needs_action",
    started_at: "2026-08-06T01:00:00.000Z",
    error: {code: "DOUYIN_SEARCH_SECURITY_CHALLENGE"},
  }), {kind: "manual_current", automatic: false});
  assert.deepEqual(classifyCaptureRecoveryDisposition({
    status: "dispatched",
    started_at: null,
  }), {kind: "auto_handoff", automatic: true});
  assert.deepEqual(classifyCaptureRecoveryDisposition({
    status: "failed",
    started_at: "2026-08-06T01:00:00.000Z",
    error: {code: "TAB_NOT_FOUND"},
  }), {kind: "auto_retry_or_handoff", automatic: true});
  assert.deepEqual(classifyCaptureRecoveryDisposition({
    status: "failed",
    started_at: "2026-08-06T01:00:00.000Z",
    error: {code: "IDENTITY_MISMATCH"},
  }), {kind: "terminal_business_failure", automatic: false});
  assert.deepEqual(classifyCaptureRecoveryDisposition({
    status: "failed",
    started_at: "2026-08-06T01:00:00.000Z",
    attempt_count: 3,
    error: {code: "TAB_NOT_FOUND"},
  }), {kind: "automatic_attempts_exhausted", automatic: false});
  assert.deepEqual(classifyCaptureRecoveryDisposition({
    status: "failed",
    started_at: "2026-08-06T01:00:00.000Z",
    attempt_count: 9,
    error: {code: "TAB_NOT_FOUND"},
  }, {phase: "duty"}), {kind: "auto_retry_or_handoff", automatic: true});
  assert.deepEqual(classifyCaptureRecoveryDisposition({
    status: "failed",
    started_at: "2026-08-06T01:00:00.000Z",
    attempt_count: 9,
    error: {code: "IDENTITY_MISMATCH"},
  }, {phase: "duty"}), {kind: "terminal_business_failure", automatic: false});
  assert.deepEqual(classifyCaptureRecoveryDisposition({
    status: "failed",
    started_at: "2026-08-06T01:00:00.000Z",
    attempt_count: 9,
    error: {code: "USER_CANCELLED"},
  }, {phase: "duty"}), {kind: "terminal_business_failure", automatic: false});
});

test("duty cross-device retry fails closed before opening a transaction", async () => {
  assert.deepEqual(await dispatchCrossDeviceRetry({
    recoveryPhase: "duty",
    automatic: true,
    requestKey: "11111111-1111-4111-8111-111111111111",
    dutyRecoveryIntentId: "11111111-1111-4111-8111-111111111111",
    dutyRecoveryGeneration: 1,
    itemIds: [
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ],
    expectedItemRevision: 1,
    expectedAttemptNumber: 3,
  }), {error: "invalid_duty_recovery_request"});
  assert.deepEqual(await dispatchCrossDeviceRetry({
    itemIds: ["not-a-uuid"],
  }), {error: "invalid_retry_item_scope"});
  assert.deepEqual(await dispatchCrossDeviceRetry({
    safetyHandoff: {
      count: 0,
      challengeCode: 'DOUYIN_SEARCH_SECURITY_CHALLENGE',
      sourcePlatformAccountId: 'source-account',
      sourceLoginState: 'authenticated',
      requireDistinctPlatformAccount: true,
      requireSourceLineageQuiet: true,
    },
  }), {error: 'invalid_duty_recovery_request'});
  assert.deepEqual(await dispatchCrossDeviceRetry({
    tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    taskId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    requestKey: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    expectedRevision: 1,
    recoveryPhase: 'duty',
    automatic: true,
    dutyRecoveryIntentId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    dutyRecoveryLeaseToken: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    dutyRecoveryGeneration: 1,
    itemIds: ['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'],
    expectedItemRevision: 1,
    expectedAttemptNumber: 1,
    expectedSourceAttemptId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    safetyHandoff: {
      count: 0,
      challengeCode: 'DOUYIN_SEARCH_SECURITY_CHALLENGE',
      sourcePlatformAccountId: 'source-account',
      sourceLoginState: 'authenticated',
      requireDistinctPlatformAccount: true,
      requireSourceLineageQuiet: true,
    },
  }), {
    error: 'retry_requires_manual_safety_action',
    code: 'HUMAN_REQUIRED',
    humanRequired: true,
    reason: 'source_local_closure_proof_unavailable',
  });
});

test('search-challenge handoff is counted independently but remains fail-closed', () => {
  const projection = readRouteSection(
    'export function projectElasticKeywordRecoveryStatus({',
    'export function isExplicitUserCancellationSnapshot',
  );
  assert.match(projection, /safetyHandoffCount = 0/u);
  assert.match(projection, /sourceLocalClosureProven = false/u);
  assert.match(
    projection,
    /Number\(safetyHandoffCount\)[\s\S]*ELASTIC_AUTOMATIC_SAFETY_HANDOFF_ATTEMPTS/u,
  );
  assert.doesNotMatch(
    projection,
    /normalizedAttemptCount <= ELASTIC_AUTOMATIC_SAFETY_HANDOFF_ATTEMPTS/u,
  );

  const elasticClaim = readRouteSection(
    'async function dispatchNextElasticWorkItem',
    "router.post('/agent/liveness'",
  );
  assert.match(elasticClaim, /CAPTURE_SAFETY_HANDOFF_SEARCH_CODES/u);
  assert.match(elasticClaim, /item\.status = 'retryable'/u);

  const dutyDispatch = readRouteSection(
    'export async function dispatchCrossDeviceRetry',
    'export async function reconcileElasticCaptureLeases',
  );
  assert.match(
    dutyDispatch,
    /source_local_closure_proof_unavailable/u,
  );
  assert.ok(
    dutyDispatch.indexOf('source_local_closure_proof_unavailable') <
      dutyDispatch.indexOf('return await withTransaction'),
  );
  assert.match(dutyDispatch, /evaluateCaptureSafetyHandoff/u);
  assert.match(dutyDispatch, /sourcePlatformAccountId/u);
  assert.match(dutyDispatch, /targetPlatformAccountId/u);
  assert.match(dutyDispatch, /source_lineage_silent/u);
  assert.match(
    dutyDispatch,
    /safety_handoff_count = safety_handoff_count \+[\s\S]*safety_handoff_count = 0/u,
  );
  assert.match(dutyDispatch, /FOR SHARE OF binding, account/u);
  assert.match(dutyDispatch, /source_lineage_silent = false/u);
  assert.ok(
    (dutyDispatch.match(/loadVerifiedCaptureLocalClosureProof\(/gu) || [])
      .length >= 2,
    'safety handoff must verify local closure at source classification and again before writes',
  );
  const closureProofLoader = captureCloudRouteSource.slice(
    captureCloudRouteSource.indexOf(
      'async function loadVerifiedCaptureLocalClosureProof',
    ),
    captureCloudRouteSource.indexOf(
      'export async function dispatchCrossDeviceRetry',
    ),
  );
  assert.match(closureProofLoader, /FROM capture_task_snapshots snapshot/u);
  assert.match(closureProofLoader, /snapshot\.attempt_id/u);
  assert.match(closureProofLoader, /snapshot\.agent_id = \$3::uuid/u);
  assert.match(
    closureProofLoader,
    /snapshot\.metadata->'localClosures' AS local_closures/u,
  );
  assert.match(closureProofLoader, /selectCaptureLocalClosureEvidence\(/u);
  assert.match(closureProofLoader, /expectedItemId: expected\.itemId/u);
  assert.match(
    closureProofLoader,
    /expectedItemAttemptId: expected\.itemAttemptId/u,
  );
  assert.match(
    closureProofLoader,
    /execution_attempt\.client_attempt_id = snapshot\.client_attempt_id/u,
  );
  assert.match(closureProofLoader, /expectedSnapshotRevision/u);
  assert.doesNotMatch(
    closureProofLoader,
    /snapshot\.metadata \? 'localClosure'/u,
    'the latest terminal snapshot stays authoritative even if its proof is missing',
  );
});

test("only explicit operator cancellation is terminal", () => {
  assert.equal(
    projectCanceledChildItemStatus({
      elasticPool: true,
      explicitUserCancellation: true,
    }),
    "canceled",
  );
  assert.equal(
    projectCanceledChildItemStatus({
      elasticPool: true,
      explicitUserCancellation: false,
    }),
    "retryable",
  );
  assert.equal(
    projectCanceledChildItemStatus({
      elasticPool: false,
      explicitUserCancellation: false,
    }),
    "needs_action",
  );
  assert.equal(
    isExplicitUserCancellationSnapshot(
      {metadata: {stopCommandId: "11111111-1111-4111-8111-111111111111"}},
      {status: "canceled", error: {}},
    ),
    true,
  );
  assert.equal(
    isExplicitUserCancellationSnapshot(
      {metadata: {}},
      {
        status: "canceled",
        error: {code: "USER_CANCELED", category: "user_canceled"},
      },
    ),
    true,
  );
  assert.equal(
    isExplicitUserCancellationSnapshot(
      {metadata: {}},
      {
        status: "canceled",
        error: {code: "runner_owner_disconnected"},
        message: "用户手动中止当前采集任务",
      },
    ),
    false,
  );
  assert.equal(
    isExplicitUserCancellationSnapshot(
      {metadata: {}},
      {
        status: "canceled",
        error: {code: "STALE_TASK_HEARTBEAT_TIMEOUT", retryable: true},
      },
    ),
    false,
  );
});

test("elastic timeout fences reject stale snapshots from the revoked attempt", () => {
  const mirror = readRouteSection(
    "async function mirrorTaskSnapshot",
    "async function dispatchNextElasticWorkItem",
  );
  assert.match(
    mirror,
    /ELASTIC_AGENT_OFFLINE_TIMEOUT[\s\S]*ELASTIC_TASK_HEARTBEAT_TIMEOUT/u,
  );
  assert.match(
    mirror,
    /EXCLUDED\.attempt_number = capture_tasks\.attempt_number/u,
  );
  assert.match(
    captureCloudRouteSource,
    /unexpectedChildCancellation/u,
  );
  assert.match(captureCloudRouteSource, /UNEXPECTED_TASK_CANCELLATION/u);
});

test("elastic keyword recovery is patient, bounded, and escalates safety only after a cross-Agent check", () => {
  const safety = {
    code: "DOUYIN_SEARCH_SECURITY_CHALLENGE",
    securityBlocked: true,
    requiresManualAction: true,
  };
  assert.equal(projectElasticKeywordRecoveryStatus({
    elasticPool: true,
    status: "needs_action",
    error: safety,
    attemptCount: 1,
    sourceLocalClosureProven: true,
  }), "retryable");
  assert.equal(projectElasticKeywordRecoveryStatus({
    elasticPool: true,
    status: 'needs_action',
    error: {
      code: 'PAGE_CHALLENGE_BLOCK',
      securityBlocked: true,
    },
    attemptCount: 1,
    safetyHandoffCount: 0,
  }), 'needs_action');
  assert.equal(projectElasticKeywordRecoveryStatus({
    elasticPool: true,
    status: "needs_action",
    error: safety,
    attemptCount: 2,
    safetyHandoffCount: 1,
    sourceLocalClosureProven: true,
  }), "needs_action");
  assert.equal(projectElasticKeywordRecoveryStatus({
    elasticPool: true,
    status: "needs_action",
    error: safety,
    attemptCount: 99,
    safetyHandoffCount: 0,
    sourceLocalClosureProven: true,
  }), "retryable");
  assert.equal(projectElasticKeywordRecoveryStatus({
    elasticPool: true,
    status: 'needs_action',
    error: safety,
    attemptCount: 1,
    safetyHandoffCount: 0,
  }), 'needs_action');
  assert.equal(projectElasticKeywordRecoveryStatus({
    elasticPool: true,
    status: "failed",
    error: {code: "UNATTENDED_SEARCH_BOOTSTRAP_FAILED"},
    attemptCount: 2,
  }), "retryable");
  assert.equal(projectElasticKeywordRecoveryStatus({
    elasticPool: true,
    status: "failed",
    error: {code: "UNATTENDED_SEARCH_BOOTSTRAP_FAILED"},
    attemptCount: 3,
  }), "failed");
  assert.equal(projectElasticKeywordRecoveryStatus({
    elasticPool: true,
    status: "failed",
    error: {code: "UNATTENDED_SEARCH_BOOTSTRAP_FAILED"},
    attemptCount: 0,
    technicalLimitReached: true,
  }), "needs_action");
  assert.equal(projectElasticKeywordRecoveryStatus({
    elasticPool: false,
    status: "needs_action",
    error: safety,
    attemptCount: 1,
  }), "needs_action");

  const now = Date.parse("2026-08-12T02:00:00.000Z");
  assert.equal(elasticRecoveryHoldRemainingMs({
    status: "retryable",
    error: {code: "UNATTENDED_SEARCH_BOOTSTRAP_FAILED"},
    updated_at: "2026-08-12T01:59:00.000Z",
  }, now), 60_000);
  assert.equal(elasticRecoveryHoldRemainingMs({
    status: "retryable",
    error: safety,
    updated_at: "2026-08-12T01:50:00.000Z",
  }, now), 20 * 60_000);
  assert.equal(elasticRecoveryHoldRemainingMs({
    status: "retryable",
    error: {code: "UNATTENDED_SEARCH_BOOTSTRAP_FAILED"},
    updated_at: "2026-08-12T01:55:00.000Z",
  }, now), 0);
});

test("elastic queue does not spend business retries on local capacity or dispatch failures", () => {
  assert.equal(elasticAttemptBudgetAfterOutcome(3, {
    error: {code: "capture_task_group_busy"},
  }), 2);
  assert.equal(elasticAttemptBudgetAfterOutcome(2, {
    error: {code: "create_command_expired"},
  }), 1);
  assert.equal(elasticAttemptBudgetAfterOutcome(3, {
    error: {code: "unattended_begin_fence_changed"},
  }), 2);
  assert.equal(elasticAttemptBudgetAfterOutcome(2, {
    error: {code: "UNATTENDED_STATUS_REPORT_TIMEOUT"},
  }), 1);
  assert.equal(elasticAttemptBudgetAfterOutcome(2, {
    error: {code: "UNATTENDED_STATUS_REPORT_REJECTED"},
  }), 1);
  assert.equal(elasticAttemptBudgetAfterOutcome(2, {
    error: {code: "UNATTENDED_ATTEMPT_REPLACED"},
  }), 1);
  assert.equal(elasticAttemptBudgetAfterOutcome(2, {
    error: {code: "UNATTENDED_SEARCH_BOOTSTRAP_FAILED"},
  }), 1);
  const firstProjection = projectElasticAttemptBudget({
    attempt_count: 3,
    metadata: {elasticAttemptBudgetUsed: 3},
  }, {
    error: {code: "capture_task_group_busy"},
  }, "11111111-1111-4111-8111-111111111111");
  assert.equal(firstProjection.attemptBudget, 2);
  assert.equal(firstProjection.refunded, true);
  const replayProjection = projectElasticAttemptBudget({
    attempt_count: 3,
    metadata: firstProjection.metadataPatch,
  }, {
    error: {code: "capture_task_group_busy"},
  }, "11111111-1111-4111-8111-111111111111");
  assert.equal(replayProjection.attemptBudget, 2);
  assert.equal(replayProjection.refunded, false);

  const firstBootstrapProjection = projectElasticAttemptBudget({
    attempt_count: 1,
    metadata: {elasticAttemptBudgetUsed: 1},
  }, {
    error: {code: "UNATTENDED_SEARCH_BOOTSTRAP_FAILED"},
  }, "21111111-1111-4111-8111-111111111111");
  assert.equal(firstBootstrapProjection.attemptBudget, 0);
  assert.equal(firstBootstrapProjection.technicalAttemptCount, 1);
  assert.equal(firstBootstrapProjection.technicalLimitReached, false);
  const thirdBootstrapProjection = projectElasticAttemptBudget({
    attempt_count: 3,
    metadata: {
      elasticAttemptBudgetUsed: 1,
      elasticTechnicalAttemptCount: 2,
    },
  }, {
    error: {code: "UNATTENDED_SEARCH_BOOTSTRAP_FAILED"},
  }, "31111111-1111-4111-8111-111111111111");
  assert.equal(thirdBootstrapProjection.attemptBudget, 0);
  assert.equal(thirdBootstrapProjection.technicalAttemptCount, 3);
  assert.equal(thirdBootstrapProjection.technicalLimitReached, true);

  const now = Date.parse("2026-08-13T02:00:00.000Z");
  assert.equal(elasticRecoveryHoldRemainingMs({
    status: "retryable",
    error: {code: "capture_task_group_busy"},
    updated_at: "2026-08-13T01:45:00.000Z",
  }, now), 15 * 60_000);
  assert.equal(elasticRecoveryHoldRemainingMs({
    status: "retryable",
    error: {code: "elastic_task_heartbeat_timeout"},
    updated_at: "2026-08-13T01:55:00.000Z",
  }, now), 5 * 60_000);
});

test("elastic bootstrap pacing staggers healthy starts and only adds a short congestion delay", () => {
  const now = "2026-08-24T00:00:00.000Z";
  const healthy = projectElasticBootstrapPacing({
    seed: "tenant:item:agent",
    now,
  });
  const replay = projectElasticBootstrapPacing({
    seed: "tenant:item:agent",
    now,
  });
  assert.deepEqual(replay, healthy);
  assert.equal(healthy.bootstrapPacingReason, "staggered_start");
  assert.ok(healthy.bootstrapDelayMs >= 0);
  assert.ok(healthy.bootstrapDelayMs <= 18_000);

  const congested = projectElasticBootstrapPacing({
    seed: "tenant:item:agent",
    recentFailureCount: 5,
    recentAffectedAgentCount: 3,
    now,
  });
  assert.equal(
    congested.bootstrapPacingReason,
    "recent_technical_congestion",
  );
  assert.ok(congested.bootstrapDelayMs > healthy.bootstrapDelayMs);
  assert.ok(congested.bootstrapDelayMs <= 45_000);
  assert.equal(congested.recentTechnicalFailureCount, 5);
  assert.equal(congested.recentAffectedAgentCount, 3);
});

test("automatic relay excludes devices per selected item instead of per parent task", () => {
  const selectedItemId = "11111111-1111-4111-8111-111111111111";
  const otherItemId = "22222222-2222-4222-8222-222222222222";
  const selectedCurrentAgent = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const selectedEarlierAgent = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const otherItemAgent = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  assert.deepEqual(
    crossDeviceRetrySourceAgentIdsForItems(
      [{id: selectedItemId, assigned_agent_id: selectedCurrentAgent}],
      [
        {item_id: selectedItemId, agent_id: selectedEarlierAgent},
        {item_id: otherItemId, agent_id: otherItemAgent},
      ],
    ).sort(),
    [selectedCurrentAgent, selectedEarlierAgent].sort(),
  );
});

test("cross-device retry requires exact workflow capabilities and blocks safety items", () => {
  const baseAgent = {
    allowed_platforms: ["douyin"],
    capabilities: {
      remoteTaskCreate: true,
      remoteTargetedPostCaptureV1: true,
      supportedPlatforms: ["douyin"],
      followedCreatorPostPatrol: true,
    },
  };
  assert.equal(crossDeviceRetryAgentSupportsTask(baseAgent, {
    task_type: "followed_creator_post_patrol",
    platform: "douyin",
  }), true);
  assert.equal(crossDeviceRetryAgentSupportsTask({
    ...baseAgent,
    capabilities: {
      ...baseAgent.capabilities,
      taskStateKnown: true,
      heartbeatDegraded: true,
    },
  }, {
    task_type: "followed_creator_post_patrol",
    platform: "douyin",
  }), true);
  assert.equal(crossDeviceRetryAgentSupportsTask({
    ...baseAgent,
    capabilities: {
      ...baseAgent.capabilities,
      taskStateKnown: false,
      heartbeatDegraded: true,
    },
  }, {
    task_type: "followed_creator_post_patrol",
    platform: "douyin",
  }), false);
  assert.equal(crossDeviceRetryAgentSupportsTask(baseAgent, {
    task_type: "followed_creator_post_patrol",
    platform: "douyin",
  }, {
    dutyRecovery: {intentId: "11111111-1111-4111-8111-111111111111"},
  }), false);
  assert.equal(crossDeviceRetryAgentSupportsTask({
    ...baseAgent,
    capabilities: {
      ...baseAgent.capabilities,
      remoteStop: true,
    },
  }, {
    task_type: "followed_creator_post_patrol",
    platform: "douyin",
  }, {
    dutyRecovery: {intentId: "11111111-1111-4111-8111-111111111111"},
  }), false);
  assert.equal(crossDeviceRetryAgentSupportsTask({
    ...baseAgent,
    capabilities: {
      ...baseAgent.capabilities,
      remoteStop: true,
      dutyRecoveryLineageV1: true,
    },
  }, {
    task_type: "followed_creator_post_patrol",
    platform: "douyin",
  }, {
    dutyRecovery: {intentId: "11111111-1111-4111-8111-111111111111"},
  }), true);
  assert.equal(crossDeviceRetryAgentSupportsTask(baseAgent, {
    task_type: "negative_post_patrol",
    platform: "douyin",
  }), false);
  assert.equal(crossDeviceRetryAgentSupportsTask({
    ...baseAgent,
    capabilities: {
      ...baseAgent.capabilities,
      watchedContentPatrol: true,
    },
  }, {
    task_type: "watched_content_patrol",
    platform: "douyin",
  }), true);
  assert.equal(crossDeviceRetryAgentSupportsTask(baseAgent, {
    task_type: "followed_creator_post_patrol",
    platform: "xiaohongshu",
  }), false);
  assert.equal(crossDeviceRetryAgentSupportsTask({
    ...baseAgent,
    capabilities: {
      ...baseAgent.capabilities,
      officialAccountCommentPatrol: true,
    },
  }, {
    task_type: "capture_orchestration",
    platform: "douyin",
    metadata: {
      workflow: "official_account_comment_patrol",
      targetMode: "profile",
    },
  }), false);
  assert.equal(crossDeviceRetryAgentSupportsTask({
    ...baseAgent,
    capabilities: {
      ...baseAgent.capabilities,
      officialAccountCommentPatrolProfileV1: true,
      officialAccountLatestPostsByCountV1: true,
    },
  }, {
    task_type: "capture_orchestration",
    platform: "douyin",
    metadata: {
      workflow: "official_account_comment_patrol",
      targetMode: "profile",
    },
  }), true);
  assert.equal(crossDeviceRetryItemNeedsManualSafety({
    error: {code: "DOUYIN_SEARCH_CAPTCHA_REQUIRED"},
  }), true);
  assert.equal(crossDeviceRetryItemNeedsManualSafety({
    metadata: {checkpoint: {requiresManualAction: true}},
  }), true);
  assert.equal(crossDeviceRetryItemNeedsManualSafety({
    error: {code: "LOGIN_REQUIRED", category: "login_required"},
  }), true);
  assert.equal(crossDeviceRetryItemNeedsManualSafety({
    error: {code: "CONTENT_RELAY_STALLED"},
  }), false);
});

test("cloud task snapshots normalize local ledger aliases and timestamps", () => {
  const snapshot = normalizeCloudTaskSnapshot({
    id: "local-task-1",
    actionTaskId: "control-task-1",
    type: "unattended_keyword_plan",
    platform: "xhs",
    status: "partial",
    progress: {current: 3, total: 8},
    metadata: {activationCode: "ACT-DEMO", safe: "visible"},
    attemptNumber: 2.9,
    progressSeq: "7",
    heartbeatAt: "2026-07-20T06:00:00+08:00",
    updatedAt: "not-a-date",
  });

  assert.equal(snapshot.clientTaskId, "local-task-1");
  assert.equal(snapshot.controlTaskId, "control-task-1");
  assert.equal(snapshot.taskType, "unattended_keyword_plan");
  assert.equal(snapshot.platform, "xiaohongshu");
  assert.equal(snapshot.status, "completed_with_failures");
  assert.equal(snapshot.attemptNumber, 2);
  assert.equal(snapshot.progressSeq, 7);
  assert.equal(snapshot.heartbeatAt, "2026-07-19T22:00:00.000Z");
  assert.equal(snapshot.updatedAt, null);
  assert.equal(snapshot.metadata.activationCode, "[REDACTED]");
  assert.equal(snapshot.metadata.safe, "visible");
  assert.equal(normalizeCloudTaskSnapshot({title: "missing id"}), null);
  assert.equal(
    normalizeCloudTaskSnapshot({id: "historical-task", status: "failed"}).controlTaskId,
    "",
  );
});

test("local closure has one top-level heartbeat channel and metadata cannot forge it", () => {
  const localClosure = {
    version: 1,
    requestId: "closure-task",
    attemptId: "closure-attempt",
    itemId: "11111111-1111-4111-8111-111111111111",
    itemAttemptId: "22222222-2222-4222-8222-222222222222",
    attemptNumber: 1,
    assignmentRevision: 3,
    snapshotRevision: 9,
    terminalStatus: "needs_action",
    terminalUpdatedAt: "2026-08-27T00:59:00.000Z",
    closedAt: "2026-08-27T00:59:10.000Z",
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
    capturedRecordCount: 0,
  };
  const promoted = normalizeCloudTaskSnapshot({
    id: "closure-task",
    status: "needs_action",
    localClosure,
    metadata: {localClosure: {...localClosure, attemptId: "forged"}},
  });
  assert.deepEqual(promoted.metadata.localClosure, localClosure);

  const metadataOnly = normalizeCloudTaskSnapshot({
    id: "closure-task",
    status: "needs_action",
    metadata: {localClosure},
  });
  assert.equal(metadataOnly.metadata.localClosure, undefined);

  const secondClosure = {
    ...localClosure,
    itemId: "44444444-4444-4444-8444-444444444444",
    itemAttemptId: "55555555-5555-4555-8555-555555555555",
    attemptNumber: 2,
  };
  const plural = normalizeCloudTaskSnapshot({
    id: "closure-task",
    status: "needs_action",
    localClosure,
    localClosures: [localClosure, secondClosure],
    metadata: {
      localClosures: [{...secondClosure, attemptId: "forged"}],
    },
  });
  assert.deepEqual(plural.metadata.localClosures, [localClosure, secondClosure]);
  const pluralMetadataOnly = normalizeCloudTaskSnapshot({
    id: "closure-task",
    status: "needs_action",
    metadata: {localClosures: [localClosure, secondClosure]},
  });
  assert.equal(pluralMetadataOnly.metadata.localClosures, undefined);
});

test("cloud task snapshots preserve bounded structured health without browser secrets", () => {
  const snapshot = normalizeCloudTaskSnapshot({
    id: "local-task-health-1",
    type: "unattended_keyword_plan",
    platform: "douyin",
    status: "running",
    attemptId: "attempt-health-1",
    attemptNumber: 3,
    appVersion: "0.3.93",
    stage: "DETAIL_CAPTURE",
    phase: "COMMENTS",
    progressObserved: {
      observed: true,
      sequence: 999999999,
      current: 4,
      total: 12,
      observedAt: "2026-08-25T01:50:00.000Z",
      ageMs: 999999999,
      url: "https://www.douyin.com/search/private",
      cookie: "session=secret",
    },
    healthEvidence: {
      version: 99,
      sampledAt: "2026-08-25T01:50:01.000Z",
      page: {
        platform: "douyin",
        pageType: "note_detail",
        platformMatchesTask: true,
        detailReady: false,
        detailReadyReason: "dom_not_ready",
        tabStatus: "complete",
        discarded: false,
        frozen: true,
        url: "https://www.douyin.com/video/private",
        title: "private title",
      },
      network: {
        available: true,
        status: "success",
        lastRequestLatencyMs: 999999999,
        lastRequestAt: "2026-08-25T01:50:02.000Z",
        endpointClass: "heartbeat",
        timeoutCount: 999999999,
        url: "https://api.example.test/private",
        authorization: "Bearer secret",
      },
      runtime: {
        sampledAt: "2026-08-25T01:50:03.000Z",
        stateAgeMs: 999999999,
        captureProgressAgeMs: 999999999,
        cpuAvailable: false,
        eventLoopAvailable: true,
        eventLoopSampleCount: 99,
        eventLoopLagMs: 999999999,
        heapAvailable: true,
        heapUsedMb: 999999999,
        heapTotalMb: 999999999,
        heapLimitMb: 999999999,
        serviceWorkerAgeMs: 999999999,
        serviceWorkerRestartCount: 999999999,
        body: "private post body",
      },
    },
    metadata: {
      structuredTaskHealth: {
        appVersion: "attacker-controlled",
        healthEvidence: {url: "https://evil.example/private"},
      },
    },
  });

  assert.equal(snapshot.appVersion, "0.3.93");
  assert.equal(snapshot.stage, "detail_capture");
  assert.equal(snapshot.phase, "comments");
  assert.deepEqual(snapshot.progressObserved, {
    observed: true,
    sequence: 1000000,
    current: 4,
    total: 12,
    observedAt: "2026-08-25T01:50:00.000Z",
    ageMs: 7 * 24 * 60 * 60 * 1000,
  });
  assert.equal(snapshot.healthEvidence.version, 10);
  assert.equal(snapshot.healthEvidence.page.tabStatus, "complete");
  assert.equal(snapshot.healthEvidence.network.lastRequestLatencyMs, 120000);
  assert.equal(snapshot.healthEvidence.network.timeoutCount, 1000000);
  assert.equal(snapshot.healthEvidence.runtime.eventLoopSampleCount, 10);
  assert.equal(snapshot.healthEvidence.runtime.eventLoopLagMs, 120000);
  assert.equal(snapshot.healthEvidence.runtime.heapUsedMb, 1024 * 1024);
  assert.equal(
    snapshot.healthEvidence.runtime.serviceWorkerAgeMs,
    7 * 24 * 60 * 60 * 1000,
  );
  assert.deepEqual(
    snapshot.metadata.structuredTaskHealth,
    snapshot.structuredTaskHealth,
    "task metadata must use the authoritative top-level health snapshot",
  );

  const serialized = JSON.stringify(snapshot.structuredTaskHealth);
  assert.ok(Buffer.byteLength(serialized, "utf8") < 4096);
  assert.doesNotMatch(
    serialized,
    /https?:\/\/|cookie|authorization|bearer|private title|private post body|attacker-controlled/iu,
  );

  const rejectedVersion = normalizeCloudTaskSnapshot({
    id: "local-task-health-bad-version",
    appVersion: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcml2YXRlIn0.signature123",
    stage: "apiKeyProdABC123",
    phase: "aB3dE5fG7hJ9kL1mN3pR5tV7xZ9cD2fH",
    healthEvidence: {
      page: {
        platform: "private/path",
        pageType: "https://collector.example/private",
        detailReadyReason: "password_prod_ABC123",
      },
      network: {
        status: "secret_prod_ABC123",
        endpointClass: "0123456789abcdef0123456789abcdef01234567",
      },
    },
  });
  assert.equal(rejectedVersion.appVersion, "");
  assert.equal(rejectedVersion.stage, "unknown");
  assert.equal(rejectedVersion.phase, "unknown");
  assert.equal(rejectedVersion.healthEvidence.page.platform, "unknown");
  assert.equal(rejectedVersion.healthEvidence.page.pageType, "unknown");
  assert.equal(rejectedVersion.healthEvidence.page.detailReadyReason, "");
  assert.equal(rejectedVersion.healthEvidence.network.status, "unavailable");
  assert.equal(rejectedVersion.healthEvidence.network.endpointClass, "");
  assert.equal(
    rejectedVersion.healthEvidence.network.lastRequestLatencyMs,
    null,
  );
  assert.equal(rejectedVersion.healthEvidence.runtime.eventLoopLagMs, null);
  assert.doesNotMatch(
    JSON.stringify(rejectedVersion.structuredTaskHealth),
    /collector\.example|private\/path|eyJhbGci|apiKeyProd|aB3dE5fG|password_prod|secret_prod|0123456789abcdef/iu,
  );

  const identityShapedHealth = normalizeCloudTaskSnapshot({
    id: "local-task-health-identity-shaped",
    attemptId: "attempt-health-identity-shaped",
    stage: "AKIAIOSFODNN7EXAMPLE",
    phase: "prod-db.internal",
    healthEvidence: {
      page: {
        platform: "192.168.1.7",
        pageType: "customer_13800138000",
        detailReadyReason: "AKIAIOSFODNN7EXAMPLE",
        tabStatus: "prod-db.internal",
      },
      network: {
        status: "customer_13800138000",
        endpointClass: "prod-db.internal",
      },
    },
  });
  assert.equal(identityShapedHealth.stage, "unknown");
  assert.equal(identityShapedHealth.phase, "unknown");
  assert.equal(identityShapedHealth.healthEvidence.page.platform, "unknown");
  assert.equal(identityShapedHealth.healthEvidence.page.pageType, "unknown");
  assert.equal(identityShapedHealth.healthEvidence.page.detailReadyReason, "");
  assert.equal(
    identityShapedHealth.healthEvidence.page.tabStatus,
    "unavailable",
  );
  assert.equal(
    identityShapedHealth.healthEvidence.network.status,
    "unavailable",
  );
  assert.equal(identityShapedHealth.healthEvidence.network.endpointClass, "");
  assert.doesNotMatch(
    JSON.stringify(identityShapedHealth.structuredTaskHealth),
    /AKIAIOSFODNN7EXAMPLE|prod-db\.internal|192\.168\.1\.7|13800138000/iu,
  );
});

test("legacy reports without an attempt id cannot bind or persist structured health", () => {
  const normalized = normalizeCloudTaskSnapshot({
    id: "legacy-unbound-health",
    attemptNumber: 3,
    progressSeq: 99,
    appVersion: "0.3.93",
    stage: "detail_capture",
    phase: "comments",
    progressObserved: {observed: true, current: 4, total: 12},
    healthEvidence: {
      page: {platform: "douyin", pageType: "note_detail"},
      network: {available: true, status: "success"},
    },
  });

  assert.ok(normalized.metadata.structuredTaskHealth);
  const persisted = bindCloudTaskSnapshotHealthToAttempt(normalized);
  assert.equal(persisted.attemptId, "");
  assert.equal(persisted.appVersion, "");
  assert.equal(persisted.stage, "unknown");
  assert.equal(persisted.phase, "unknown");
  assert.deepEqual(persisted.progressObserved, {});
  assert.deepEqual(persisted.healthEvidence, {});
  assert.deepEqual(persisted.structuredTaskHealth, {});
  assert.equal(
    Object.hasOwn(persisted.metadata, "structuredTaskHealth"),
    false,
  );
  assert.ok(
    normalized.metadata.structuredTaskHealth,
    "binding must not mutate the normalized report used by other consumers",
  );
});

test("health metadata aliases cannot bypass authoritative attempt-scoped health", () => {
  const aliases = {
    structuredTaskHealth: {stage: "comments"},
    structured_task_health: {stage: "comments"},
    agentPlanAudit: {stage: "comments"},
    agent_plan_audit: {stage: "comments"},
    healthEvidence: {network: {status: "success"}},
    health_evidence: {network: {status: "success"}},
    runtimeHealth: {eventLoopLagMs: 1},
    runtime_health: {eventLoopLagMs: 1},
    appVersion: "0.3.93",
    app_version: "0.3.93",
    stage: "comments",
    phase: "comments",
    progressObserved: {observed: true},
    progress_observed: {observed: true},
  };
  const aliasKeys = Object.keys(aliases);
  const normalized = normalizeCloudTaskSnapshot({
    id: "attempt-bound-alias-health",
    attemptId: "attempt-alias-A",
    metadata: aliases,
    appVersion: "0.3.93",
    stage: "detail_capture",
    healthEvidence: {network: {available: true, status: "success"}},
  });

  assert.equal(normalized.metadata.structuredTaskHealth.appVersion, "0.3.93");
  assert.equal(normalized.metadata.structuredTaskHealth.stage, "detail_capture");
  for (const key of aliasKeys) {
    if (key === "structuredTaskHealth") continue;
    assert.equal(Object.hasOwn(normalized.metadata, key), false, key);
  }

  const unbound = bindCloudTaskSnapshotHealthToAttempt({
    ...normalized,
    attemptId: "",
    metadata: aliases,
  });
  for (const key of aliasKeys) {
    assert.equal(Object.hasOwn(unbound.metadata, key), false, key);
  }
  assert.deepEqual(unbound.structuredTaskHealth, {});
});

test("attempt identity may upgrade from legacy empty but never downgrade or cross-bind", () => {
  assert.equal(cloudTaskAttemptIdentityAcceptsSnapshot("", ""), true);
  assert.equal(cloudTaskAttemptIdentityAcceptsSnapshot("", "attempt-A"), true);
  assert.equal(
    cloudTaskAttemptIdentityAcceptsSnapshot("attempt-A", "attempt-A"),
    true,
  );
  assert.equal(cloudTaskAttemptIdentityAcceptsSnapshot("attempt-A", ""), false);
  assert.equal(
    cloudTaskAttemptIdentityAcceptsSnapshot("attempt-A", "attempt-B"),
    false,
  );
});

test("an empty-id replay performs no projection write after attempt A owns the slot", async () => {
  const currentTask = {
    id: "task-db-A",
    status: "running",
    attempt_number: 3,
    progress_seq: 40,
    progress: {current: 4, total: 12},
    checkpoint: {activeKeywordIndex: 4},
    error: {},
    metadata: {structuredTaskHealth: {appVersion: "0.3.93"}},
  };
  const statements = [];
  const tx = {
    async queryOne(sql) {
      statements.push(sql);
      if (sql.includes("occupied_attempt.client_attempt_id")) {
        return {
          id: currentTask.id,
          status: currentTask.status,
          attempt_number: currentTask.attempt_number,
          occupied_attempt_id: "attempt-A",
        };
      }
      if (sql.includes("SELECT *") && sql.includes("WHERE id = $1")) {
        return structuredClone(currentTask);
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    async execute(sql) {
      throw new Error(`unexpected write: ${sql}`);
    },
  };
  const replay = normalizeCloudTaskSnapshot({
    id: "legacy-unbound-replay",
    attemptId: "",
    attemptNumber: 3,
    progressSeq: 999,
    status: "failed",
    progress: {current: 0, total: 12},
    checkpoint: {activeKeywordIndex: 0},
    error: {code: "LATE_LEGACY_FAILURE"},
    appVersion: "0.3.93",
    healthEvidence: {page: {platform: "douyin"}},
  });

  const result = await mirrorTaskSnapshot(
    tx,
    {id: "agent-A", tenant_id: "tenant-A"},
    replay,
  );
  assert.deepEqual(result, currentTask);
  assert.equal(statements.length, 2);
  assert.equal(statements.some(sql => /INSERT|UPDATE/iu.test(sql)), false);
});

test("targeted physical run ids normalize to their canonical business task", () => {
  const logicalRequestId = "54c0b3fd-a7f8-41a3-94f6-a3bd0e3cd018";
  const attemptId = "16249468-e006-4c97-af3c-773691dbda65";
  const snapshot = normalizeCloudTaskSnapshot({
    id: `${logicalRequestId}::${attemptId}`,
    taskType: "official_account_comment_patrol",
    platform: "douyin",
    status: "failed",
    attemptId,
    metadata: {
      workflow: "official_account_comment_patrol",
      logicalRequestId,
      attemptId,
    },
  });

  assert.equal(snapshot.clientTaskId, logicalRequestId);
  assert.equal(snapshot.attemptId, attemptId);
  assert.equal(snapshot.metadata.logicalRequestId, logicalRequestId);

  const unrelated = normalizeCloudTaskSnapshot({
    id: `${logicalRequestId}::${attemptId}`,
    taskType: "unattended_keyword_plan",
    attemptId,
    metadata: {logicalRequestId, attemptId},
  });
  assert.equal(
    unrelated.clientTaskId,
    `${logicalRequestId}::${attemptId}`,
    "non-targeted tasks must retain their native identity",
  );
});

test("negative patrol heartbeats retain bounded target results in the checkpoint", () => {
  const snapshot = normalizeCloudTaskSnapshot({
    id: "patrol-task-1",
    taskType: "negative_post_patrol",
    platform: "douyin",
    status: "running",
    targetResults: [
      {
        itemId: "11111111-1111-4111-8111-111111111111",
        recordId: "22222222-2222-4222-8222-222222222222",
        externalId: "7123456789012345678",
        ordinal: 1,
        status: "completed",
        startedAt: "2026-07-26T02:00:00.000Z",
        finishedAt: "2026-07-26T02:01:00.000Z",
      },
    ],
  });

  assert.equal(snapshot.targetResults.length, 1);
  assert.deepEqual(snapshot.checkpoint.targetResults, snapshot.targetResults);
  assert.equal(
    negativePatrolTargetResults(snapshot)[0].recordId,
    "22222222-2222-4222-8222-222222222222",
  );
});

test("negative patrol target projection rejects bad identities and sync-stage success", () => {
  const entries = negativePatrolTargetResults({
    targetResults: [
      {
        itemId: "11111111-1111-4111-8111-111111111111",
        recordId: "22222222-2222-4222-8222-222222222222",
        externalId: "7123456789012345678",
        ordinal: 2,
        status: "completed",
        error: {stage: "sync", message: "同步失败"},
      },
      {
        itemId: "not-a-uuid",
        recordId: "22222222-2222-4222-8222-222222222222",
        externalId: "7123456789012345678",
        ordinal: 1,
        status: "completed",
      },
    ],
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, "failed");
  assert.equal(entries[0].error.stage, "sync");
});

test("official comment patrol keeps bounded per-run comment observations", () => {
  const entries = negativePatrolTargetResults({
    targetResults: [
      {
        workflow: "official_account_comment_patrol",
        itemId: "11111111-1111-4111-8111-111111111111",
        recordId: "22222222-2222-4222-8222-222222222222",
        externalId: "note-12345",
        ordinal: 1,
        status: "completed_with_warnings",
        commentObservation: {
          observedCount: 18,
          partial: true,
          scope: "visible_comments_bounded",
        },
      },
    ],
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].commentObservation.observedCount, 18);
  assert.equal(entries[0].commentObservation.partial, true);
  assert.equal(
    entries[0].commentObservation.scope,
    "visible_comments_bounded",
  );
});

test("official comment patrol distinguishes profile scans from legacy direct-detail tasks", () => {
  assert.equal(
    isProfilePatrolTask({
      task_type: "official_account_comment_patrol",
      metadata: {targetMode: "profile", profileMode: true},
    }),
    true,
  );
  assert.equal(
    isProfilePatrolTask(
      {task_type: "official_account_comment_patrol", metadata: {}},
      {targetMode: "profile"},
    ),
    true,
  );
  assert.equal(
    isProfilePatrolTask({
      task_type: "official_account_comment_patrol",
      metadata: {targetMode: "detail", subjectType: "official"},
    }, {
      targetMode: "profile",
    }),
    false,
  );
  assert.equal(
    isProfilePatrolTask({
      task_type: "official_account_comment_patrol",
      metadata: {subjectType: "official"},
    }),
    false,
  );
  assert.equal(
    isProfilePatrolTask("followed_creator_post_patrol"),
    true,
  );
  assert.equal(
    isProfilePatrolTask("official_account_post_discovery"),
    true,
  );
  assert.equal(
    isProfilePatrolTask("negative_post_patrol"),
    false,
  );
});

test("targeted detail result projection has a closed workflow allow-list", () => {
  assert.match(
    captureCloudRouteSource,
    /const TARGETED_POST_TASK_TYPES = new Set\(\[\s*'negative_post_patrol',\s*'watched_content_patrol',\s*'official_account_comment_patrol',/u,
  );
  assert.match(
    captureCloudRouteSource,
    /!isTargetedPostTaskType\(task\.task_type\)/u,
  );
  assert.match(
    captureCloudRouteSource,
    /isTargetedPostTaskType\(lockedTask\?\.task_type\)[\s\S]*isTargetedPostTaskType\(command\.payload\?\.workflow\)/u,
  );
});

test("negative patrol result projection binds server records and fresh observations", () => {
  const projection = readRouteSection(
    "async function projectNegativePatrolSnapshot",
    "async function projectOrchestrationChildControlOutcome",
  );
  assert.match(projection, /id = \$14::uuid/u);
  assert.match(projection, /record_id = \$15::uuid/u);
  assert.match(projection, /external_id = \$16/u);
  assert.match(projection, /result_record_id = CASE/u);
  assert.match(projection, /THEN record_id/u);
  assert.match(projection, /FROM record_observations/u);
  assert.match(projection, /record_id = \$2/u);
  assert.match(projection, /captured_at >= \$3::timestamptz/u);
  assert.match(projection, /result_observation_id/u);
  assert.match(projection, /aggregateParentTaskItems\(items\)/u);
  assert.match(projection, /isProfilePatrolTask\(task\)/u);
  assert.match(projection, /commentsSampled/u);
  assert.match(projection, /commentPartialPosts/u);
  assert.match(projection, /visible_comments_bounded/u);
  assert.match(
    projection,
    /code: text\(snapshotError\.code, 100\) \|\| 'missing_target_result'/u,
  );
  assert.match(
    projection,
    /ORDER BY ordinal, id[\s\S]*OFFSET \$5[\s\S]*nextOrdinal\s*-\s*1/u,
  );
  assert.doesNotMatch(projection, /entry\.recordIds/u);
});

test("snapshot fingerprints deduplicate exact replays without collapsing later progress", () => {
  const snapshot = normalizeCloudTaskSnapshot({
    id: "local-task-1",
    actionTaskId: "control-task-1",
    type: "unattended_keyword_plan",
    platform: "xhs",
    status: "running",
    progress: {current: 3, total: 8},
    checkpoint: {keyword: "别克"},
    attemptId: "attempt-2",
    attemptNumber: 2,
    progressSeq: 7,
    heartbeatAt: "2026-07-21T14:00:00.000Z",
    updatedAt: "2026-07-21T14:00:00.000Z",
  });
  const replay = structuredClone(snapshot);
  assert.equal(
    captureTaskSnapshotFingerprint(snapshot),
    captureTaskSnapshotFingerprint(replay),
  );
  assert.notEqual(
    captureTaskSnapshotFingerprint(snapshot),
    captureTaskSnapshotFingerprint({...snapshot, progressSeq: 8}),
  );
  assert.notEqual(
    captureTaskSnapshotFingerprint(snapshot),
    captureTaskSnapshotFingerprint({
      ...snapshot,
      updatedAt: "2026-07-21T14:01:00.000Z",
    }),
  );
});

test("orchestration checkpoint projection never reopens a terminal activeKeyword", () => {
  const terminalEntries = orchestrationCheckpointEntries({
    status: "completed",
    progress: {keyword: "雪佛兰", phase: "completed"},
    checkpoint: {
      activeKeyword: "雪佛兰",
      activePhase: "completed",
      keywordResults: [
        {keyword: "雪佛兰", status: "completed", attemptCount: 1, savedCount: 20},
      ],
    },
  });
  assert.deepEqual(
    terminalEntries.map(entry => [entry.keyword, entry.status]),
    [["雪佛兰", "completed"]],
  );

  const resumedEntries = orchestrationCheckpointEntries({
    status: "running",
    progress: {keyword: "凯迪拉克", phase: "initializing_unattended"},
    checkpoint: {
      // The local checkpoint deliberately retains the previously settled word.
      activeKeyword: "雪佛兰",
      activePhase: "completed",
      keywordResults: [
        {keyword: "雪佛兰", status: "completed", attemptCount: 1, savedCount: 20},
      ],
    },
  });
  assert.deepEqual(
    resumedEntries.map(entry => [entry.keyword, entry.status]),
    [["雪佛兰", "completed"], ["凯迪拉克", "running"]],
  );
});

test("sequential Douyin checkpoints retain both passes and resume only the unfinished pass", () => {
  const runningEntries = orchestrationCheckpointEntries({
    status: "running",
    progress: {keyword: "别克壁纸", roundCurrent: 2},
    checkpoint: {
      round: 2,
      activeKeyword: "别克壁纸",
      keywordResults: [
        {
          round: 1,
          keyword: "别克壁纸",
          status: "completed",
          savedCount: 8,
        },
      ],
    },
  });
  assert.equal(runningEntries[0].round, 2);
  assert.equal(runningEntries[0].status, "running");
  assert.deepEqual(
    runningEntries[0].searchPassResults.map(entry => [entry.round, entry.status]),
    [[1, "completed"]],
  );

  const entries = orchestrationCheckpointEntries({
    status: "needs_action",
    checkpoint: {
      round: 2,
      activeKeyword: "别克壁纸",
      keywordResults: [
        {
          round: 1,
          index: 0,
          keyword: "别克壁纸",
          status: "completed",
          attemptCount: 1,
          savedCount: 8,
          finishedAt: "2026-08-22T00:10:00.000Z",
        },
        {
          round: 2,
          index: 0,
          keyword: "别克壁纸",
          status: "failed",
          attemptCount: 1,
          savedCount: 0,
          errorCode: "DOUYIN_SEARCH_SECURITY_CHALLENGE",
          finishedAt: "2026-08-22T00:12:00.000Z",
        },
      ],
    },
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].round, 2);
  assert.equal(entries[0].status, "failed");
  assert.deepEqual(
    entries[0].searchPassResults.map(entry => [entry.round, entry.status]),
    [[1, "completed"], [2, "failed"]],
  );

  const checkpoint = buildSequentialSearchResumeCheckpoint({
    planSnapshot: {
      platform: "douyin",
      searchPasses: ["general", "note"],
    },
    itemMetadata: {checkpoint: entries[0]},
    keyword: "别克壁纸",
    now: new Date("2026-08-22T00:15:00.000Z"),
  });
  assert.deepEqual(checkpoint, {
    schemaVersion: 1,
    round: 2,
    activeKeywordIndex: 0,
    activeKeyword: "",
    activePhase: "pending",
    keywordResults: [
      {
        round: 1,
        index: 0,
        keyword: "别克壁纸",
        status: "completed",
        attemptCount: 1,
        savedCount: 8,
        error: "",
        finishedAt: "2026-08-22T00:10:00.000Z",
      },
    ],
    updatedAt: "2026-08-22T00:15:00.000Z",
  });
  assert.equal(buildSequentialSearchResumeCheckpoint({
    planSnapshot: {
      platform: "douyin",
      searchPasses: ["general", "note"],
    },
    itemMetadata: {
      checkpoint: {
        searchPassResults: [
          {round: 1, keyword: "别克壁纸", status: "failed"},
        ],
      },
    },
    keyword: "别克壁纸",
  }), null);
});

test("elastic sequential patrol keeps one bounded cross-agent handoff", () => {
  const refresh = readRouteSection(
    "async function refreshOrchestrationParentTask",
    "async function projectNegativePatrolSnapshot",
  );
  assert.match(
    refresh,
    /const elasticPool = parentMetadata\.distributionMode === 'elastic_pool';[\s\S]*if \(!elasticPool\) \{[\s\S]*automaticRetrySuppressed/u,
  );
  assert.doesNotMatch(
    refresh.slice(0, refresh.indexOf("if (!elasticPool)")),
    /automaticRetrySuppressed/u,
  );
});

test("operator cancellation is absorbing against late child heartbeats", () => {
  const mirror = readRouteSection(
    "async function mirrorTaskSnapshot",
    "router.post('/agent/heartbeat'",
  );
  assert.match(
    mirror,
    /WHERE capture_tasks\.status NOT IN \('superseded', 'canceled'\)/u,
  );
  assert.match(
    captureCloudRouteSource,
    /capture_task_items\.status <> 'canceled' OR \$1 = 'canceled'/u,
  );
  assert.match(
    captureCloudRouteSource,
    /capture_task_item_attempts\.status <> 'canceled' OR \$1 = 'canceled'/u,
  );
});

test("a stopped orchestration child keeps later unstarted keywords eligible for safe handoff", () => {
  const projection = readRouteSection(
    "async function projectOrchestrationSnapshot",
    "async function mirrorTaskSnapshot",
  );
  assert.match(
    projection,
    /const activeKeyword = text\([\s\S]*snapshotProgress\.keyword[\s\S]*snapshotCheckpoint\.activeKeyword/u,
  );
  assert.match(
    projection,
    /started_at = COALESCE\(started_at, now\(\)\)[\s\S]*keyword = \$8/u,
  );
  assert.match(
    projection,
    /WHEN \$1 = 'needs_action' AND started_at IS NULL THEN 'retryable'/u,
  );
  assert.match(projection, /'code', 'blocked_by_prior_item'/u);
  assert.match(
    projection,
    /前序关键词需要人工处理，该关键词尚未开始，可安全接力/u,
  );
  assert.match(
    projection,
    /SET status = CASE[\s\S]*finished_at = CASE/u,
  );
  assert.doesNotMatch(
    projection.slice(
      projection.indexOf("UPDATE capture_task_items\n      SET status = CASE"),
      projection.indexOf("UPDATE capture_task_item_attempts attempt"),
    ),
    /started_at = COALESCE\(started_at, now\(\)\)/u,
    "unreported later keywords must not be marked as started",
  );
  const attemptProjection = projection.slice(
    projection.indexOf("UPDATE capture_task_item_attempts attempt"),
  );
  assert.match(attemptProjection, /item\.tenant_id = \$1/u);
  assert.match(attemptProjection, /item\.task_id = \$2/u);
  assert.match(attemptProjection, /item\.execution_task_id = \$3/u);
  assert.match(attemptProjection, /item\.assigned_agent_id = \$4/u);
  assert.doesNotMatch(attemptProjection, /\$(?:5|6)/u);
});

test("operator stop terminal snapshots settle every unresolved child item", () => {
  const projection = readRouteSection(
    "async function projectOrchestrationSnapshot",
    "async function mirrorTaskSnapshot",
  );
  assert.match(
    projection,
    /\$1 IN \('canceled', 'skipped'\)[\s\S]*OR NOT \(id = ANY\(\$7::uuid\[\]\)\)/u,
  );
  assert.match(
    projection,
    /WHEN \$1 = 'needs_action'[\s\S]*ELSE error/u,
    "canceled and skipped settlement must preserve an existing item error",
  );
  assert.match(
    projection,
    /metadata = metadata \|\| jsonb_build_object\('checkpoint', \$3::jsonb\)/u,
    "checkpoint evidence must remain stored before terminal settlement",
  );
});

test("handoff metadata survives agent snapshots and fences resume on the source task", () => {
  const mirror = readRouteSection(
    "async function mirrorTaskSnapshot",
    "router.post('/agent/heartbeat'",
  );
  for (const field of [
    "handoffRequestHash",
    "handoffRequestKey",
    "handoffSourceExecutionTaskId",
    "handoffConfirmedByUser",
    "handoffSuccessorTaskId",
    "handoffSourcePreviousStatus",
    "handedOffAt",
    "recoveryTaskId",
    "recoveryCommandId",
  ]) {
    assert.match(mirror, new RegExp(`'${field}', capture_tasks\\.metadata->'${field}'`, "u"));
  }
  const resume = readRouteSection(
    "router.post('/tasks/:id/resume'",
    "router.post('/tasks/:id/stop'",
  );
  assert.match(resume, /task\.metadata\?\.handoffSuccessorTaskId/u);
  assert.match(resume, /task_handed_off/u);
  assert.match(resume, /后续关键词已经转交其他 Agent/u);
});

test("agent execution-slot locks serialize heartbeat, resume, and handoff assignment", async () => {
  const calls = [];
  await lockCaptureAgentExecutionSlot(
    {execute: async (sql, params) => calls.push({sql, params})},
    "tenant-a",
    "agent-a",
  );
  assert.deepEqual(calls, [{
    sql: "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
    params: ["capture_agent_execution_slot", "tenant-a:agent-a"],
  }]);

  const tryCalls = [];
  assert.equal(await tryLockCaptureAgentExecutionSlot(
    {
      queryOne: async (sql, params) => {
        tryCalls.push({sql, params});
        return {locked: true};
      },
    },
    "tenant-a",
    "agent-b",
  ), true);
  assert.match(tryCalls[0].sql, /pg_try_advisory_xact_lock/u);
  assert.deepEqual(
    tryCalls[0].params,
    ["capture_agent_execution_slot", "tenant-a:agent-b"],
  );

  const heartbeat = readRouteSection(
    "router.post('/agent/heartbeat'",
    "router.post('/agent/commands/:id/complete'",
  );
  const heartbeatTransaction = heartbeat.indexOf(
    "const result = await withTransaction(async tx =>",
  );
  const heartbeatLock = heartbeat.indexOf(
    "await lockActiveCaptureAgentSession(",
    heartbeatTransaction,
  );
  const agentWrite = heartbeat.indexOf("UPDATE capture_agents", heartbeatTransaction);
  assert.ok(heartbeatLock > heartbeatTransaction && heartbeatLock < agentWrite);

  const resume = readRouteSection(
    "router.post('/tasks/:id/resume'",
    "router.post('/tasks/:id/stop'",
  );
  const identityRead = resume.indexOf(
    "SELECT COALESCE(assigned_agent_id, origin_agent_id) AS agent_id",
  );
  const resumeLock = resume.indexOf("await lockCaptureAgentExecutionSlot(");
  const staleCommands = resume.indexOf("await expireStaleCommands(");
  const taskRowLock = resume.indexOf("FOR UPDATE OF t");
  assert.ok(identityRead >= 0 && identityRead < resumeLock);
  assert.ok(resumeLock < staleCommands && staleCommands < taskRowLock);
  assert.match(resume, /task_agent_changed/u);
});

test("a request authenticated before retirement is rejected when retirement commits first", async () => {
  const authenticatedAgent = {
    id: "528f8cbd-42f1-493e-8f77-bd585d53ac31",
    tenant_id: "tenant-a",
    auth_code_id: "code-a",
    auth_binding_id: "binding-a",
    status: "active",
  };
  const calls = [];
  const executor = {
    execute: async (sql, params) => {
      calls.push({method: "execute", sql, params});
    },
    queryOne: async (sql, params) => {
      calls.push({method: "queryOne", sql, params});
      return {
        ...authenticatedAgent,
        status: "revoked",
      };
    },
  };

  assert.equal(
    await lockActiveCaptureAgentSession(executor, authenticatedAgent),
    null,
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "execute");
  assert.match(calls[0].sql, /pg_advisory_xact_lock/u);
  assert.equal(calls[1].method, "queryOne");
  assert.match(calls[1].sql, /FROM capture_agents[\s\S]*FOR UPDATE/u);
});

test("late Agent heartbeat and command receipts are absorbed after retirement wins", () => {
  const heartbeat = readRouteSection(
    "router.post('/agent/heartbeat'",
    "router.post('/agent/commands/:id/complete'",
  );
  const heartbeatGuard = heartbeat.indexOf(
    "await lockActiveCaptureAgentSession(",
  );
  const heartbeatWrite = heartbeat.indexOf("UPDATE capture_agents");
  assert.ok(heartbeatGuard >= 0 && heartbeatGuard < heartbeatWrite);
  assert.match(heartbeat, /if \(!currentAgent\) return \{agentInactive: true\}/u);
  assert.match(
    heartbeat,
    /result\.agentInactive[\s\S]*error: 'agent_inactive'/u,
  );

  const completion = readRouteSection(
    "router.post('/agent/commands/:id/complete'",
    "router.get('/overview'",
  );
  const completionGuard = completion.indexOf(
    "await lockActiveCaptureAgentSession(",
  );
  const commandRead = completion.indexOf("SELECT task_id");
  assert.ok(completionGuard >= 0 && completionGuard < commandRead);
  assert.match(
    completion,
    /commandResult\.agentInactive[\s\S]*error: 'agent_inactive'/u,
  );
  assert.match(completion, /'agent_retired'/u);
});

test("overview separates execution load from attention history and technical tasks", () => {
  const overview = readRouteSection(
    "router.get('/overview'",
    "router.patch('/agents/:id'",
  );
  const workloadStart = overview.indexOf("WITH task_load AS");
  const workloadEnd = overview.indexOf("SELECT ca.id", workloadStart);
  assert.ok(workloadStart >= 0 && workloadEnd > workloadStart);
  const workload = overview.slice(workloadStart, workloadEnd);
  assert.match(
    workload,
    /'claimed', 'running', 'recovering', 'resume_requested'[\s\S]*AS active_task_count/u,
  );
  assert.match(
    workload,
    /assigned\.status IN \('pending', 'waiting_device'\)[\s\S]*AS queued_task_count/u,
  );
  assert.doesNotMatch(workload, /'interrupted'|'needs_action'/u);
  assert.match(workload, /assigned\.status = ANY\(\$2::text\[\]\)/u);
  assert.match(
    overview,
    /req\.tenantId, CAPTURE_AGENT_SLOT_BLOCKING_TASK_STATUSES/u,
  );
  assert.match(
    workload,
    /assigned\.task_type NOT IN \([\s\S]*'capture_orchestration', 'unattended_plan_configuration', 'sync'[\s\S]*RIGHT\(assigned\.task_type, 5\) <> '_sync'/u,
  );
  assert.match(
    overview,
    /ca\.status IN \('active', 'paused'\)/u,
    "migrated and revoked Agents must stay out of operational lists",
  );
  assert.match(
    overview,
    /ca\.status = 'migrated'[\s\S]*原执行节点已移出当前租户/u,
    "historical tasks still explain why their original Agent is unavailable",
  );
});

test("overview hides only exact legacy targeted mirror roots", () => {
  const assigned = captureTaskBusinessRootVisibilitySql("assigned");
  assert.match(assigned, /assigned\.client_task_id\s*=\s*[\s\S]*logicalRequestId[\s\S]*'::'[\s\S]*attemptId/u);
  assert.match(assigned, /canonical\.id::text = assigned\.metadata->>'logicalRequestId'/u);
  assert.match(assigned, /canonical\.client_task_id = assigned\.metadata->>'logicalRequestId'/u);
  assert.match(assigned, /canonical\.origin_agent_id IS NOT DISTINCT FROM assigned\.origin_agent_id/u);
  assert.match(assigned, /canonical\.task_type = assigned\.task_type/u);
  assert.throws(
    () => captureTaskBusinessRootVisibilitySql("unsafe alias"),
    /Unsupported capture task SQL alias/u,
  );

  const overview = readRouteSection(
    "router.get('/overview'",
    "router.patch('/agents/:id'",
  );
  assert.equal(
    [...overview.matchAll(/captureTaskBusinessRootVisibilitySql\('(?:assigned|t)'\)/gu)].length,
    3,
    "agent load, visible task rows, and summary counts must share the filter",
  );
});

test("agent removal blockers explain every unsafe dependency", () => {
  assert.equal(captureAgentRemovalBlockerMessage({}), "");
  const message = captureAgentRemovalBlockerMessage({
    online: true,
    activeTasks: 2,
    activeWorkItems: 3,
    pendingCommands: 1,
    localPlan: true,
    cloudSchedules: 4,
  });
  assert.match(message, /节点仍在线/u);
  assert.match(message, /2 个未结束任务/u);
  assert.match(message, /3 个多 Agent 工作项/u);
  assert.match(message, /1 条远程指令/u);
  assert.match(message, /本地无人值守计划/u);
  assert.match(message, /4 个云端编排计划/u);
});

test("agent deletion is a guarded soft revoke that preserves history", () => {
  const removal = readRouteSection(
    "router.delete('/agents/:id'",
    "router.post('/agents/:id/tasks'",
  );
  assert.match(
    removal,
    /requireTenantAccess, requireSessionUser, requireTenantWriter/u,
  );
  const executionLock = removal.indexOf("await lockCaptureAgentExecutionSlot(");
  const agentRowLock = removal.indexOf("FOR UPDATE");
  assert.ok(executionLock >= 0 && executionLock < agentRowLock);
  assert.match(removal, /captureAgentLivenessOnline\(agent\)/u);
  assert.match(
    removal,
    /COALESCE\(t\.assigned_agent_id, t\.origin_agent_id\)[\s\S]*AGENT_REMOVAL_TASK_STATUSES/u,
  );
  assert.match(
    removal,
    /captureTaskBusinessRootVisibilitySql\('t'\)/u,
    "hidden legacy targeted mirrors must not block Agent deletion",
  );
  assert.match(
    removal,
    /FROM capture_task_items item[\s\S]*JOIN capture_tasks parent[\s\S]*parent\.status = ANY\(\$3::text\[\]\)/u,
  );
  assert.match(
    removal,
    /workItemLoad[\s\S]*AGENT_REMOVAL_TASK_STATUSES/u,
    "terminal parents must not leave stale work items blocking Agent deletion",
  );
  assert.match(removal, /status IN \('pending', 'acknowledged'\)/u);
  assert.match(
    removal,
    /capture_orchestration_schedule_agents[\s\S]*schedule\.status IN \('active', 'paused'\)/u,
  );
  assert.match(removal, /hasConfiguredAgentPlan\(agent\.unattended_plan\)/u);
  assert.match(removal, /UPDATE capture_agent_tokens[\s\S]*revoked_at/u);
  assert.match(
    removal,
    /UPDATE social_account_bindings[\s\S]*status = 'historical'/u,
  );
  assert.match(removal, /UPDATE social_accounts[\s\S]*last_agent_id = NULL/u);
  assert.match(
    removal,
    /UPDATE capture_agents[\s\S]*SET status = 'revoked'/u,
  );
  assert.match(removal, /INSERT INTO audit_logs[\s\S]*capture_agent\.revoked/u);
  assert.match(removal, /authBindingPreserved: true/u);
  assert.doesNotMatch(removal, /DELETE FROM capture_agents/u);
  assert.doesNotMatch(removal, /DELETE FROM auth_bindings/u);
});

test("Agent tenant migration is reversible while permanent retirement stays irreversible", async () => {
  const retirement = readRouteSection(
    "router.post('/agents/:id/retire'",
    "router.post('/agents/:id/tasks'",
  );
  const [credentialIssuer, migration] = await Promise.all([
    readFile(new URL("../server/services/capture-cloud.js", import.meta.url), "utf8"),
    readFile(new URL(
      "../server/db/migrations/055_capture_agent_tenant_migration.sql",
      import.meta.url,
    ), "utf8"),
  ]);
  assert.match(
    retirement,
    /requireTenantAccess, requireSessionUser, requireTenantWriter/u,
  );
  assert.match(
    retirement,
    /\['tenant_migrated', 'permanently_offline'\]/u,
  );
  assert.match(retirement, /requiredConfirmation[\s\S]*移出当前租户[\s\S]*永久停用/u);
  assert.match(retirement, /terminalAgentStatus[\s\S]*'migrated'[\s\S]*'revoked'/u);
  assert.match(retirement, /capture_agent\.migrated[\s\S]*capture_agent\.retired/u);
  assert.match(
    retirement,
    /WHERE id = \$1 AND tenant_id = \$2[\s\S]*FOR UPDATE/u,
  );
  assert.doesNotMatch(retirement, /WHERE client_uuid/u);
  assert.match(
    retirement,
    /captureAgentLivenessOnline\(agent\)[\s\S]*agent_retirement_online/u,
  );
  assert.match(
    retirement,
    /UPDATE capture_agent_tokens[\s\S]*revoked_at = COALESCE\(revoked_at, now\(\)\)/u,
  );
  assert.match(
    retirement,
    /UPDATE capture_agent_commands[\s\S]*status = 'expired'[\s\S]*lifecycleCode/u,
  );
  assert.match(
    retirement,
    /UPDATE capture_task_attempts[\s\S]*status = 'canceled'/u,
  );
  assert.match(
    retirement,
    /UPDATE capture_task_item_attempts[\s\S]*status = 'canceled'/u,
  );
  assert.match(
    retirement,
    /UPDATE capture_task_items[\s\S]*status = 'canceled'/u,
  );
  assert.match(
    retirement,
    /UPDATE capture_tasks[\s\S]*status = 'canceled'[\s\S]*历史采集结果已保留/u,
  );
  assert.match(
    retirement,
    /UPDATE capture_orchestration_schedules[\s\S]*status = 'canceled'[\s\S]*next_run_at = NULL/u,
  );
  assert.match(
    retirement,
    /UPDATE social_account_bindings[\s\S]*status = 'historical'/u,
  );
  assert.match(
    retirement,
    /UPDATE social_accounts[\s\S]*last_agent_id = NULL/u,
  );
  assert.match(
    retirement,
    /UPDATE capture_agents[\s\S]*SET status = \$3[\s\S]*unattended_plan = '\{\}'::jsonb[\s\S]*terminalAgentStatus/u,
  );
  assert.match(
    retirement,
    /INSERT INTO audit_logs[\s\S]*lifecycleAction/u,
  );
  assert.match(retirement, /unattendedPlanSnapshot: planSnapshot/u);
  assert.match(retirement, /historyPreserved: true/u);
  assert.match(retirement, /authBindingPreserved: true/u);
  assert.match(
    credentialIssuer,
    /ON CONFLICT \(tenant_id, client_uuid\)[\s\S]*capture_agents\.status = 'migrated'[\s\S]*THEN 'active'[\s\S]*agent\.status !== 'active'[\s\S]*token: ''/u,
  );
  assert.match(
    credentialIssuer,
    /lockCaptureAgentExecutionSlot\(tx, tenantId, existingAgent\.id\)/u,
  );
  assert.match(
    credentialIssuer,
    /lockCaptureAgentExecutionSlot\(tx, tenantId, existingAgent\.id\)[\s\S]*WHERE tenant_id = \$1 AND id = \$2[\s\S]*FOR UPDATE[\s\S]*ON CONFLICT \(tenant_id, client_uuid\)/u,
    "restore status must be re-read under the same lifecycle lock before upsert",
  );
  assert.match(credentialIssuer, /capture_agent\.returned_to_tenant/u);
  assert.match(migration, /DROP CONSTRAINT IF EXISTS capture_agents_status_check/u);
  assert.match(
    migration,
    /CHECK \(status IN \('active', 'paused', 'migrated', 'revoked'\)\)/u,
  );
  assert.doesNotMatch(retirement, /DELETE FROM capture_tasks/u);
  assert.doesNotMatch(retirement, /DELETE FROM records/u);
  assert.doesNotMatch(retirement, /DELETE FROM auth_bindings/u);
});

test("orchestration checkpoint database values are bounded and timestamp-safe", () => {
  assert.equal(orchestrationCheckpointInteger(-4), 0);
  assert.equal(orchestrationCheckpointInteger("17.9"), 17);
  assert.equal(orchestrationCheckpointInteger(Number.POSITIVE_INFINITY), 0);
  assert.equal(orchestrationCheckpointInteger(2147483648), 2147483647);
  assert.equal(
    orchestrationCheckpointTimestamp("2026-07-23T08:30:00+08:00"),
    "2026-07-23T00:30:00.000Z",
  );
  assert.equal(orchestrationCheckpointTimestamp("not-a-date"), null);
  assert.equal(orchestrationCheckpointTimestamp(""), null);
});

test("orchestration control outcomes lock parent before updating items", () => {
  const helper = readRouteSection(
    "async function projectOrchestrationChildControlOutcome",
    "async function projectOrchestrationSnapshot",
  );
  const parentLock = helper.indexOf("await lockOrchestrationParent");
  const itemUpdate = helper.indexOf("UPDATE capture_task_items");
  const attemptUpdate = helper.indexOf("UPDATE capture_task_item_attempts");
  assert.ok(parentLock >= 0);
  assert.ok(itemUpdate > parentLock);
  assert.ok(attemptUpdate > itemUpdate);
  assert.match(
    helper,
    /status NOT IN \([\s\S]*'completed', 'completed_with_warnings', 'failed', 'skipped', 'canceled'/u,
  );
  assert.match(helper, /return refreshOrchestrationParentTask/u);
});

test("create command failures and successful stops settle orchestration work items", () => {
  const expiry = readRouteSection(
    "async function expireStaleCommands",
    "async function resolveResumeCommandFromSuccessor",
  );
  assert.match(
    expiry,
    /elasticQueueItem \? 'retryable' : 'needs_action',[\s\S]*code: 'create_command_expired'/u,
  );
  assert.match(
    expiry,
    /status: 'needs_action',[\s\S]*code: 'create_agent_unavailable'/u,
  );
  assert.match(
    expiry,
    /failProfileDiscoveryWork\(tx,[\s\S]*code: 'create_command_expired'/u,
  );
  assert.match(
    expiry,
    /failProfileDiscoveryWork\(tx,[\s\S]*code: 'create_agent_unavailable'/u,
  );

  const profileFailure = readRouteSection(
    "async function failProfileDiscoveryWork",
    "async function cancelProfileDiscoveryWork",
  );
  assert.match(
    profileFailure,
    /UPDATE capture_task_items[\s\S]*SET status = 'failed'/u,
  );
  assert.match(
    profileFailure,
    /UPDATE capture_task_item_attempts[\s\S]*SET status = 'failed'/u,
  );
  assert.match(
    profileFailure,
    /UPDATE monitor_executions execution[\s\S]*SET status = 'failed'/u,
  );
  assert.match(profileFailure, /syncProfileDiscoverySubscriptions/u);

  const completion = readRouteSection(
    "router.post('/agent/commands/:id/complete'",
    "router.get('/overview'",
  );
  assert.match(
    completion,
    /command\.command_type === 'create'[\s\S]*status: success \? 'dispatched' : 'needs_action'/u,
  );
  assert.match(
    completion,
    /command\.command_type === 'create'[\s\S]*\(success \|\| targetedPostCreate\)[\s\S]*actualRequestId !== expectedCreateRequestId/u,
  );
  assert.match(
    completion,
    /isTargetedPostTaskType\(lockedTask\?\.task_type\)[\s\S]*isTargetedPostTaskType\(command\.payload\?\.workflow\)/u,
  );
  assert.match(
    completion,
    /command\.command_type === 'stop'[\s\S]*success[\s\S]*status: 'canceled'/u,
  );
  assert.match(
    completion,
    /SELECT id, parent_task_id,[\s\S]*?status, error, metadata/u,
  );
});

test("acknowledged create expiry waits for Agent liveness, while pending expiry does not", () => {
  const now = Date.parse("2026-08-27T06:00:00.000Z");
  const graceMs = 10 * 60 * 1000;
  const freshLivenessAt = "2026-08-27T05:59:55.000Z";
  const staleFullHeartbeatAt = "2026-08-27T05:30:00.000Z";

  assert.equal(captureCreateCommandExpiryEligible({
    status: "pending",
    commandType: "create",
    lastLivenessAt: freshLivenessAt,
    lastFullHeartbeatAt: staleFullHeartbeatAt,
  }, now, graceMs), true, "an unclaimed create still expires at expires_at");
  assert.equal(captureCreateCommandExpiryEligible({
    status: "acknowledged",
    commandType: "create",
    lastLivenessAt: freshLivenessAt,
    lastFullHeartbeatAt: staleFullHeartbeatAt,
  }, now, graceMs), false, "fresh liveness holds an acknowledged create even when the full snapshot is stale");
  assert.equal(captureCreateCommandExpiryEligible({
    status: "acknowledged",
    commandType: "create",
    lastLivenessAt: "2026-08-27T05:49:59.999Z",
    lastFullHeartbeatAt: staleFullHeartbeatAt,
  }, now, graceMs), true, "an acknowledged create may expire after the liveness grace elapses");
  assert.equal(captureCreateCommandExpiryEligible({
    status: "acknowledged",
    commandType: "stop",
    lastLivenessAt: freshLivenessAt,
  }, now, graceMs), true, "non-create command expiry remains unchanged");
});

test("stale command reconciliation rechecks acknowledged create liveness before retry projection", () => {
  const expiry = readRouteSection(
    "async function expireStaleCommands",
    "async function resolveResumeCommandFromSuccessor",
  );
  const candidateCheck = expiry.indexOf("const expiryCandidates = await tx.queryAll");
  const candidateLock = expiry.indexOf("FOR UPDATE OF c", candidateCheck);
  const atomicRecheck = expiry.indexOf("id = ANY($4::uuid[])", candidateLock);
  const retryProjection = expiry.indexOf("projectOrchestrationChildControlOutcome", atomicRecheck);

  assert.ok(candidateCheck >= 0);
  assert.ok(candidateLock > candidateCheck, "expiry candidates must be command-row locked");
  assert.ok(atomicRecheck > candidateLock, "the expiry update must recheck the locked candidate set");
  assert.ok(retryProjection > atomicRecheck, "retry projection must only see commands that passed both checks");
  assert.match(
    expiry,
    /c\.status = 'pending'[\s\S]*c\.command_type <> 'create'[\s\S]*ca\.last_liveness_at[\s\S]*ca\.last_full_heartbeat_at[\s\S]*make_interval\(mins => \$4::integer\)/u,
  );
  assert.match(
    expiry,
    /status = 'pending'[\s\S]*command_type <> 'create'[\s\S]*NOT EXISTS \([\s\S]*ca\.last_liveness_at[\s\S]*>= now\(\) - make_interval\(mins => \$5::integer\)/u,
  );
  assert.match(
    expiry,
    /AND metadata->>'createCommandId' = \$3/u,
    "an expired command must not settle a newer task attempt",
  );
});

test("elastic queue claims one keyword or platform-bound content item per idle heartbeat and fences late attempts", () => {
  const claim = readRouteSection(
    "async function dispatchNextElasticWorkItem",
    "router.post('/agent/heartbeat'",
  );
  assert.match(claim, /findCaptureAgentExecutionSlotBlocker/u);
  assert.match(claim, /item\.status IN \('pending', 'retryable'\)/u);
  assert.match(claim, /FOR UPDATE OF parent, item SKIP LOCKED/u);
  assert.match(claim, /keywords: \[candidate\.keyword\]/u);
  assert.match(claim, /item\.item_type = 'negative_post'/u);
  assert.match(claim, /item\.item_type = 'watched_content'/u);
  assert.match(claim, /item\.platform AS item_platform/u);
  assert.match(claim, /item\.platform = ANY\(\$4::text\[\]\)/u);
  assert.match(claim, /item\.platform = ANY\(\$5::text\[\]\)/u);
  assert.match(claim, /targets: \[target\]/u);
  assert.match(claim, /claimUnit = candidate\.item_type/u);
  assert.match(claim, /platform: candidate\.item_platform/u);
  assert.match(claim, /createAckTimeoutSeconds/u);
  assert.match(claim, /ELASTIC_QUEUE_CREATE_ACK_TIMEOUT_MS/u);
  assert.match(claim, /attempt_count = \$1/u);
  assert.match(claim, /const attemptBudget[\s\S]*candidate\.attempt_budget_used/u);
  assert.match(claim, /attempt_count = \$1[\s\S]*attemptNumber,[\s\S]*attemptBudget/u);
  assert.match(claim, /elasticAttemptBudgetUsed/u);
  assert.match(claim, /const attemptIdentity = crypto\.randomUUID\(\)/u);
  assert.match(claim, /attemptIdentity,/u);
  assert.match(claim, /const itemAttemptBindings = \[\{/u);
  assert.match(
    claim,
    /orchestration:[\s\S]*itemAttempts: itemAttemptBindings/u,
  );
  assert.ok(
    claim.indexOf('INSERT INTO capture_task_item_attempts') <
      claim.indexOf('INSERT INTO capture_agent_commands'),
    'elastic claims must persist their attempt before publishing command',
  );
  assert.match(claim, /projectElasticBootstrapPacing/u);
  assert.match(claim, /\.\.\.\(bootstrapPacing \|\| \{\}\)/u);
  assert.match(claim, /ELASTIC_BOOTSTRAP_CONGESTION_WINDOW_MS/u);
  assert.match(claim, /recentAffectedAgentCount/u);
  assert.match(claim, /assignment_revision = \$5/u);
  assert.match(claim, /execution_task_id = \$4/u);
  assert.match(claim, /INSERT INTO capture_task_item_attempts/u);
  assert.match(claim, /classifyCaptureRecoveryDisposition/u);
  assert.match(claim, /'manual_current'/u);
  assert.match(claim, /elasticRecoveryHoldRemainingMs\(recentRecoveryAttempt\)/u);
  assert.match(claim, /recent_same_agent_attempt/u);
  assert.match(claim, /recent_same_agent_attempt\.agent_id = \$2::uuid/u);
  assert.match(claim, /ELASTIC_SAME_ITEM_RETRY_COOLDOWN_MS/u);
  assert.doesNotMatch(
    claim,
    /recovery[^\n]*nextEvaluationAt|nextEvaluationAt[^\n]*recovery/u,
  );

  const heartbeat = readRouteSection(
    "router.post('/agent/heartbeat'",
    "router.post('/agent/commands/:id/complete'",
  );
  const mirror = heartbeat.indexOf('mirrorTaskSnapshot');
  const elastic = heartbeat.indexOf('dispatchNextElasticWorkItem');
  const commandRead = heartbeat.indexOf('SELECT c.id, c.command_type');
  assert.ok(mirror >= 0);
  assert.ok(elastic > mirror);
  assert.ok(commandRead > elastic);
});

test("elastic recovery releases the item immediately while cooling only the source Agent", () => {
  const recovery = readRouteSection(
    "function buildElasticRecoveryMetadata({",
    "export function crossDeviceRetryAgentSupportsTask(",
  );

  assert.match(recovery, /state: 'released_for_handoff'/u);
  assert.match(recovery, /handoffReadyAt/u);
  assert.match(recovery, /itemLockReleased: true/u);
  assert.match(recovery, /sourceAgentCooling: true/u);
  assert.match(recovery, /cooldownHomeRestored/u);
  assert.match(recovery, /cooldownHomeUrl/u);
  assert.match(recovery, /sourceAgentHoldUntil/u);
  assert.match(recovery, /sourceAgentSameItemRetryAfter/u);
});

test("elastic cleanup tolerates child tasks whose work item already settled", () => {
  assert.deepEqual(
    projectElasticAttemptBudget(null, {
      error: {code: 'elastic_agent_offline_timeout'},
    }),
    {
      attemptBudget: 0,
      technicalAttemptCount: 0,
      technicalLimitReached: false,
      metadataPatch: {
        elasticAttemptBudgetUsed: 0,
        elasticTechnicalAttemptCount: 0,
      },
      refunded: false,
    },
  );
});

test("elastic queue reclaims stale offline work without disturbing fixed assignments", () => {
  const lease = readRouteSection(
    'export async function reconcileElasticCaptureLeases',
    'export async function reconcileAutomaticCaptureRetries',
  );
  assert.match(lease, /ELASTIC_QUEUE_OFFLINE_TIMEOUT_MIN/u);
  assert.match(lease, /agent\.last_liveness_at/u);
  assert.match(lease, /child\.heartbeat_at/u);
  assert.match(lease, /elastic_task_heartbeat_timeout/u);
  assert.match(lease, /captureAgentLivenessOnline/u);
  assert.match(
    lease,
    /COALESCE\([\s\S]*agent\.last_liveness_at[\s\S]*'-infinity'::timestamptz[\s\S]*< now\(\)[\s\S]*AND COALESCE\([\s\S]*child\.heartbeat_at[\s\S]*child\.updated_at/u,
  );
  assert.doesNotMatch(lease, /AGENT_TASK_STATE_UNAVAILABLE/u);
  assert.match(lease, /status: 'retryable'/u);
  assert.match(lease, /elastic_agent_offline_timeout/u);
  assert.match(lease, /FOR UPDATE SKIP LOCKED/u);
  assert.doesNotMatch(lease, /child\.metadata->>'cloudWorkQueue'/u);
  assert.match(
    captureCloudRouteSource,
    /COALESCE\(metadata->>'distributionMode', ''\) <> 'elastic_pool'/u,
  );
});

test("elastic negative patrol uses the same bounded technical and safety handoff policy", () => {
  const projection = readRouteSection(
    'async function projectNegativePatrolSnapshot',
    'async function projectOrchestrationChildControlOutcome',
  );
  assert.match(projection, /distributionMode ===[\s\S]*'elastic_pool'/u);
  assert.match(projection, /classifyCaptureRecoveryDisposition/u);
  assert.match(projection, /SELECT attempt_count[\s\S]*FOR UPDATE/u);
  assert.match(projection, /projectElasticKeywordRecoveryStatus/u);
  assert.match(projection, /buildElasticRecoveryMetadata/u);
  assert.match(projection, /sourceAgentId:\s*agent\.id/u);
  assert.match(projection, /missingTargetResult:\s*true/u);
  assert.doesNotMatch(projection, /snapshotNeedsManualSafety/u);
});

test("unattended plan deletion is a durable device command and clears the mirror only after acknowledgement", () => {
  const deletion = readRouteSection(
    "router.delete('/agents/:id/unattended-plan'",
    "router.post('/tasks/:id/dismiss-attention'",
  );
  assert.match(deletion, /remoteUnattendedPlanDelete/u);
  assert.match(
    deletion,
    /INSERT INTO capture_agent_commands[\s\S]*'create'[\s\S]*planOperation:\s*'delete'/u,
  );
  assert.match(
    deletion,
    /c\.payload->>'planOperation' = 'delete'[\s\S]*删除计划指令已存在/u,
  );
  assert.doesNotMatch(
    deletion,
    /UPDATE capture_agents[\s\S]*SET unattended_plan = '\{\}'::jsonb/u,
    "the admin request must not hide a still-active device plan before receipt",
  );

  const completion = readRouteSection(
    "router.post('/agent/commands/:id/complete'",
    "router.get('/overview'",
  );
  assert.match(
    completion,
    /createPlanOperation === 'delete'[\s\S]*设备已停止并删除无人值守计划/u,
  );
  assert.match(
    completion,
    /success[\s\S]*createPlanOperation === 'delete'[\s\S]*UPDATE capture_agents[\s\S]*unattended_plan = '\{\}'::jsonb/u,
  );
});

test("stop before device receipt immediately cancels orchestration items", () => {
  const stopRoute = readRouteSection(
    "router.post('/tasks/:id/stop'",
    "router.get('/tasks/:id/snapshots'",
  );
  assert.match(
    stopRoute,
    /RETURNING id, parent_task_id, status[\s\S]*task_stopped_before_dispatch/u,
  );
  assert.match(
    stopRoute,
    /canceledTask\?\.parent_task_id[\s\S]*projectOrchestrationChildControlOutcome[\s\S]*status: 'canceled'/u,
  );
});

test("targeted stop commands and receipts are fenced to the current attempt", () => {
  const stopRoute = readRouteSection(
    "router.post('/tasks/:id/stop'",
    "router.get('/tasks/:id/snapshots'",
  );
  assert.match(
    stopRoute,
    /SELECT client_attempt_id[\s\S]*FROM capture_task_attempts[\s\S]*attempt_number = \$3/u,
  );
  assert.doesNotMatch(
    stopRoute,
    /agent_platform_mismatch/u,
    "stopping an already-running exact task must not reuse dispatch eligibility",
  );

  const heartbeat = readRouteSection(
    "router.post('/agent/heartbeat'",
    "router.post('/agent/commands/:id/complete'",
  );
  assert.match(
    heartbeat,
    /c\.command_type = 'stop'[\s\S]*cardinality\(\$5::text\[\]\) = 0/u,
    "stop delivery bypasses current platform assignment while retaining auth fences",
  );
  assert.match(
    stopRoute,
    /task_attempt_unavailable[\s\S]*attemptId: clientAttemptId/u,
  );
  assert.match(
    stopRoute,
    /payload->>'attemptId' = \$7/u,
    "a pending stop from an older attempt must not be reused",
  );

  const completion = readRouteSection(
    "router.post('/agent/commands/:id/complete'",
    "router.get('/overview'",
  );
  assert.match(
    completion,
    /expectedAttemptId: command\.payload\?\.attemptId[\s\S]*actualAttemptId: resultPayload\.attemptId/u,
  );
  assert.match(completion, /stop_attempt_id_mismatch/u);
});

test("overview reports child-inclusive agent load but root-only task summary", () => {
  const overview = readRouteSection(
    "router.get('/overview'",
    "router.patch('/agents/:id'",
  );
  assert.match(overview, /AS active_task_count/u);
  assert.match(overview, /AS queued_task_count/u);
  assert.match(overview, /WITH task_load AS/u);
  assert.doesNotMatch(overview, /LEFT JOIN LATERAL \(\s*SELECT\s+COUNT\(\*\) FILTER/u);
  assert.match(
    overview,
    /GROUP BY COALESCE\([\s\S]*assigned\.assigned_agent_id,[\s\S]*assigned\.origin_agent_id[\s\S]*LEFT JOIN task_load ON task_load\.agent_id = ca\.id/u,
  );
  assert.match(
    overview,
    /assigned\.status = ANY\(\$2::text\[\]\)/u,
  );
  assert.match(overview, /assigned\.task_type NOT IN/u);
  assert.ok(
    [...overview.matchAll(/AND t\.parent_task_id IS NULL/gu)].length >= 2,
  );
  assert.equal(
    [...overview.matchAll(
      /t\.orchestration_revision = 0[\s\S]*?t\.metadata->>'draft' = 'true'/gu,
    )].length,
    2,
  );
});

test("task snapshots append only after freshness acceptance and have a tenant-scoped reader", () => {
  const mirrorSection = readRouteSection(
    "async function mirrorTaskSnapshot",
    "router.post('/agent/heartbeat'",
  );
  const acceptedGuard = mirrorSection.indexOf("if (snapshotAccepted) {");
  const snapshotInsert = mirrorSection.indexOf(
    "INSERT INTO capture_task_snapshots",
    acceptedGuard,
  );
  assert.ok(acceptedGuard >= 0);
  assert.ok(snapshotInsert > acceptedGuard);
  assert.match(
    mirrorSection.slice(acceptedGuard, snapshotInsert + 2600),
    /ON CONFLICT \(task_id, snapshot_fingerprint\) DO NOTHING/u,
  );

  const readSection = readRouteSection(
    "router.get('/tasks/:id/snapshots'",
    "router.get('/tasks/:id/events'",
  );
  assert.match(readSection, /requireTenantAccess, requireSessionUser/u);
  assert.match(
    readSection,
    /SELECT id FROM capture_tasks WHERE id = \$1 AND tenant_id = \$2/u,
  );
  assert.match(
    readSection,
    /FROM capture_task_snapshots[\s\S]*WHERE task_id = \$1 AND tenant_id = \$2/u,
  );
  assert.match(readSection, /Math\.min\(500, Math\.max\(1/u);
  assert.match(readSection, /ORDER BY source_updated_at DESC, id DESC/u);
});

test("an occupied attempt number rejects a different concrete attempt id", () => {
  const mirrorSection = readRouteSection(
    "async function mirrorTaskSnapshot",
    "router.post('/agent/heartbeat'",
  );
  assert.match(
    mirrorSection,
    /snapshot = bindCloudTaskSnapshotHealthToAttempt\(snapshot\)/u,
    "unbound legacy reports must lose structured health before task persistence",
  );
  assert.match(
    mirrorSection,
    /cloudTaskAttemptIdentityAcceptsSnapshot\([\s\S]*previous\.occupied_attempt_id,[\s\S]*snapshot\.attemptId/u,
    "the preflight must reject an empty or different identity before any projection write",
  );
  assert.match(
    mirrorSection,
    /FROM capture_task_attempts existing_attempt[\s\S]*existing_attempt\.attempt_number = EXCLUDED\.attempt_number[\s\S]*existing_attempt\.client_attempt_id <> ''[\s\S]*\$27 = ''[\s\S]*OR existing_attempt\.client_attempt_id <> \$27/u,
  );
  assert.match(
    mirrorSection,
    /client_attempt_id = CASE[\s\S]*capture_task_attempts\.client_attempt_id <> ''[\s\S]*EXCLUDED\.client_attempt_id = ''[\s\S]*THEN capture_task_attempts\.client_attempt_id[\s\S]*ELSE EXCLUDED\.client_attempt_id/u,
  );
  assert.match(
    mirrorSection,
    /WHERE capture_task_attempts\.client_attempt_id = ''[\s\S]*OR capture_task_attempts\.client_attempt_id = EXCLUDED\.client_attempt_id/u,
  );
  assert.doesNotMatch(
    mirrorSection,
    /OR EXCLUDED\.client_attempt_id = ''/u,
  );
  assert.ok(
    [...mirrorSection.matchAll(
      /snapshot\.attemptId \? attempt\?\.id \|\| null : null/gu,
    )].length >= 2,
    "an empty attempt id must not bind snapshots or events to an occupied attempt slot",
  );
});

test("accepted task attempts persist the bounded version and structured health evidence", () => {
  const mirrorSection = readRouteSection(
    "async function mirrorTaskSnapshot",
    "router.post('/agent/heartbeat'",
  );
  assert.match(
    mirrorSection,
    /INSERT INTO capture_task_attempts \([\s\S]*app_version, health_evidence,[\s\S]*CASE WHEN \$4 <> '' THEN \$6 ELSE '' END,[\s\S]*CASE WHEN \$4 <> '' THEN \$7::jsonb ELSE '\{\}'::jsonb END/u,
  );
  assert.match(
    mirrorSection,
    /app_version = CASE[\s\S]*EXCLUDED\.client_attempt_id <> ''[\s\S]*capture_task_attempts\.client_attempt_id = EXCLUDED\.client_attempt_id[\s\S]*EXCLUDED\.app_version <> ''[\s\S]*capture_task_attempts\.app_version/u,
  );
  assert.match(
    mirrorSection,
    /health_evidence = CASE[\s\S]*EXCLUDED\.client_attempt_id <> ''[\s\S]*capture_task_attempts\.client_attempt_id = EXCLUDED\.client_attempt_id[\s\S]*EXCLUDED\.health_evidence <> '\{\}'::jsonb[\s\S]*capture_task_attempts\.health_evidence/u,
  );
  assert.match(
    mirrorSection,
    /snapshot\.appVersion,[\s\S]*JSON\.stringify\(snapshot\.structuredTaskHealth\),[\s\S]*normalizedAttemptStatus/u,
  );
});

test("cloud status predicates keep active and terminal lifecycles separate", () => {
  assert.equal(normalizeCloudTaskStatus("started"), "running");
  assert.equal(normalizeCloudTaskStatus("blocked"), "needs_action");
  assert.equal(isCloudTaskActive("resume_requested"), true);
  assert.equal(isCloudTaskTerminal("resume_requested"), false);
  assert.equal(isCloudTaskActive("completed_with_failures"), false);
  assert.equal(isCloudTaskTerminal("completed_with_failures"), true);
  assert.equal(isCloudTaskTerminal("superseded"), true);
});

test("online state is derived from a short heartbeat lease", () => {
  const now = Date.parse("2026-07-20T08:00:00.000Z");
  assert.equal(captureAgentOnline("2026-07-20T07:59:01.000Z", now), true);
  assert.equal(captureAgentOnline("2026-07-20T07:57:59.000Z", now), false);
  assert.equal(captureAgentOnline("", now), false);
});

test("Agent liveness, full task-state health, and auxiliary degradation are distinct", () => {
  const now = Date.parse("2026-08-27T06:00:00.000Z");
  const incomplete = {
    last_liveness_at: "2026-08-27T05:59:50.000Z",
    last_full_heartbeat_at: "2026-08-27T05:50:00.000Z",
    last_heartbeat_at: "2026-08-27T05:50:00.000Z",
    capabilities: {
      taskStateKnown: false,
      heartbeatDegraded: true,
    },
  };
  assert.equal(captureAgentLivenessOnline(incomplete, now), true);
  assert.equal(captureAgentFullHeartbeatOnline(incomplete, now), false);
  assert.equal(captureAgentHeartbeatDegraded(incomplete), true);

  const auxiliaryWarning = {
    last_liveness_at: "2026-08-27T05:59:50.000Z",
    last_full_heartbeat_at: "2026-08-27T05:59:45.000Z",
    last_heartbeat_at: "2026-08-27T05:59:45.000Z",
    capabilities: {
      taskStateKnown: true,
      heartbeatDegraded: true,
    },
  };
  assert.equal(captureAgentFullHeartbeatOnline(auxiliaryWarning, now), true);
  assert.equal(captureAgentHeartbeatDegraded(auxiliaryWarning), true);

  const legacy = {
    last_heartbeat_at: "2026-08-27T05:59:45.000Z",
    capabilities: {},
  };
  assert.equal(captureAgentLivenessOnline(legacy, now), true);
  assert.equal(captureAgentFullHeartbeatOnline(legacy, now), true);
});

test("heartbeat routes keep liveness-only and incomplete task-state writes isolated", () => {
  const liveness = readRouteSection(
    "router.post('/agent/liveness'",
    "router.post('/agent/heartbeat'",
  );
  assert.match(liveness, /SET last_liveness_at = now\(\)/u);
  assert.doesNotMatch(liveness, /SET last_heartbeat_at = now\(\)/u);
  assert.doesNotMatch(liveness, /last_full_heartbeat_at = now\(\)/u);

  const heartbeat = readRouteSection(
    "router.post('/agent/heartbeat'",
    "router.post('/agent/commands/:id/complete'",
  );
  assert.match(
    heartbeat,
    /const hasTaskSnapshotList = Array\.isArray\(req\.body\?\.tasks\);[\s\S]*const rawTasks = hasTaskSnapshotList/u,
  );
  assert.match(
    heartbeat,
    /heartbeatCapabilities\.taskStateKnown !== false && hasTaskSnapshotList;[\s\S]*heartbeatCapabilities\.taskStateKnown = taskStateKnown;/u,
  );
  assert.match(heartbeat, /const taskStateIncomplete = !taskStateKnown/u);
  assert.match(
    heartbeat,
    /last_liveness_at = now\(\)[\s\S]*last_full_heartbeat_at = CASE[\s\S]*last_heartbeat_at = CASE/u,
  );
  assert.match(
    heartbeat,
    /if \(!taskStateIncomplete\) \{[\s\S]*mirrorTaskSnapshot/u,
  );
  assert.match(
    heartbeat,
    /const elasticClaim = taskStateIncomplete[\s\S]*dispatchNextElasticWorkItem/u,
  );
  assert.match(
    heartbeat,
    /const commands = taskStateKnown \? await tx\.queryAll/u,
  );
  assert.match(heartbeat, /hasObservedSocialAccounts \|\| hasSocialUsageEvents/u);

  const hasTaskSnapshotListExpression = heartbeat.match(
    /const hasTaskSnapshotList = ([^;]+);/u,
  )?.[1];
  const taskStateKnownExpression = heartbeat.match(
    /const taskStateKnown =\s*([\s\S]*?);\s*heartbeatCapabilities\.taskStateKnown/u,
  )?.[1];
  assert.ok(hasTaskSnapshotListExpression);
  assert.ok(taskStateKnownExpression);
  const evaluateTaskStateKnown = (body, capabilityValue) => vm.runInNewContext(`
    (() => {
      const hasTaskSnapshotList = ${hasTaskSnapshotListExpression};
      return ${taskStateKnownExpression};
    })()
  `, {
    req: {body},
    heartbeatCapabilities: {taskStateKnown: capabilityValue},
  });
  assert.equal(evaluateTaskStateKnown({}, undefined), false);
  assert.equal(evaluateTaskStateKnown({tasks: {}}, true), false);
  assert.equal(evaluateTaskStateKnown({tasks: []}, undefined), true);
  assert.equal(evaluateTaskStateKnown({tasks: []}, false), false);
});

test("heartbeat migration backfills legacy evidence without changing its full-heartbeat meaning", async () => {
  const migration = await readFile(new URL(
    "../server/db/migrations/076_capture_agent_heartbeat_semantics.sql",
    import.meta.url,
  ), "utf8");
  assert.match(migration, /ADD COLUMN IF NOT EXISTS last_liveness_at/u);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS last_full_heartbeat_at/u);
  assert.match(
    migration,
    /last_liveness_at = COALESCE\(last_liveness_at, last_heartbeat_at\)/u,
  );
  assert.match(
    migration,
    /last_full_heartbeat_at = COALESCE\([\s\S]*last_heartbeat_at/u,
  );
  assert.match(migration, /Legacy compatibility alias/u);
});

test("heartbeat prioritizes plan configuration ahead of ordinary creates with stable ordering", () => {
  const heartbeatRoute = readRouteSection(
    "router.post('/agent/heartbeat'",
    "router.post('/agent/commands/:id/complete'",
  );
  assert.match(
    heartbeatRoute,
    /WHEN c\.command_type = 'stop' THEN 0[\s\S]*WHEN c\.command_type = 'resume' THEN 1[\s\S]*c\.payload->>'executionMode' = 'unattended_plan' THEN 2[\s\S]*ELSE 3/u,
  );
  assert.match(
    heartbeatRoute,
    /END, c\.created_at ASC, c\.id ASC[\s\S]*LIMIT 10/u,
  );
});

test("a newer unattended plan fences older active plan commands after idempotency", () => {
  const createRoute = readRouteSection(
    "router.post('/agents/:id/tasks'",
    "router.post('/tasks/:id/resume'",
  );
  const idempotencyLookup = createRoute.indexOf("const existingTask = await tx.queryOne");
  const supersessionLookup = createRoute.indexOf("const olderPlanCommands = await tx.queryAll");
  const newCommandInsert = createRoute.indexOf("INSERT INTO capture_agent_commands", supersessionLookup);
  assert.ok(idempotencyLookup >= 0);
  assert.ok(supersessionLookup > idempotencyLookup);
  assert.ok(newCommandInsert > supersessionLookup);
  assert.match(
    createRoute,
    /c\.command_type = 'create'[\s\S]*c\.status IN \('pending', 'acknowledged'\)[\s\S]*c\.payload->>'executionMode' = 'unattended_plan'/u,
  );
  assert.match(
    createRoute,
    /SET status = 'expired'[\s\S]*'reason', 'superseded_by_newer_plan'/u,
  );
  assert.match(
    createRoute,
    /SET status = 'superseded'[\s\S]*task_type = 'unattended_plan_configuration'[\s\S]*status IN \('pending', 'claimed'\)/u,
  );
  assert.match(createRoute, /eventType: 'plan_configuration_superseded'/u);
});

test("a successful plan command supersedes only older needs-action configurations", async () => {
  const statements = [];
  await supersedeStalePlanConfigurationAttention({
    async queryAll(sql, params) {
      statements.push({kind: "update", sql, params});
      return [{id: "11111111-1111-4111-8111-111111111111"}];
    },
    async execute(sql, params) {
      statements.push({kind: "event", sql, params});
    },
  }, {
    tenantId: "tenant-id",
    agentId: "22222222-2222-4222-8222-222222222222",
    supersededByTaskId: "33333333-3333-4333-8333-333333333333",
    supersededByCreatedAt: "2026-08-03T02:19:17.694Z",
    actorType: "capture_agent",
    actorId: "22222222-2222-4222-8222-222222222222",
    actorName: "Surface-Chrome",
    taskMessage: "已被成功删除无人值守计划的指令替代",
    eventMessage: "设备已成功删除计划，较早失败的计划配置已封存",
  });
  assert.equal(statements.length, 2);
  assert.equal(statements[0].kind, "update");
  assert.deepEqual(statements[0].params, [
    "tenant-id",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
    "2026-08-03T02:19:17.694Z",
    "已被成功删除无人值守计划的指令替代",
  ]);
  assert.match(statements[0].sql, /message = \$5/u);
  assert.doesNotMatch(statements[0].sql, /error\s*=/u);
  assert.equal(statements[1].kind, "event");
  assert.equal(statements[1].params[1], "11111111-1111-4111-8111-111111111111");
  assert.equal(statements[1].params[4], "plan_configuration_superseded");
  assert.equal(statements[1].params[5], "capture_agent");
  assert.equal(statements[1].params[8], "superseded");
  assert.equal(
    JSON.parse(statements[1].params[10]).supersededByTaskId,
    "33333333-3333-4333-8333-333333333333",
  );

  const helperStart = captureCloudRouteSource.indexOf(
    "export async function supersedeStalePlanConfigurationAttention",
  );
  const helperEnd = captureCloudRouteSource.indexOf(
    "async function expireStaleCommands",
    helperStart,
  );
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = captureCloudRouteSource.slice(helperStart, helperEnd);
  assert.match(helper, /SET status = 'superseded'/u);
  assert.match(
    helper,
    /task_type = 'unattended_plan_configuration'[\s\S]*status = 'needs_action'/u,
  );
  assert.match(
    helper,
    /created_at < \$4::timestamptz[\s\S]*created_at = \$4::timestamptz AND id < \$3::uuid/u,
  );

  const completion = readRouteSection(
    "router.post('/agent/commands/:id/complete'",
    "router.get('/overview'",
  );
  const completionEvent = completion.indexOf("await appendEvent(tx");
  const staleSettlement = completion.indexOf(
    "await supersedeStalePlanConfigurationAttention(tx",
  );
  assert.ok(staleSettlement > completionEvent);
  assert.match(
    completion.slice(completionEvent, staleSettlement + 500),
    /success &&[\s\S]*updatedTask &&[\s\S]*command\.command_type === 'create'[\s\S]*createExecutionMode === 'unattended_plan'[\s\S]*lockedTask\.task_type === 'unattended_plan_configuration'/u,
  );

  const saveRoute = readRouteSection(
    "router.post('/agents/:id/tasks'",
    "router.post('/tasks/:id/resume'",
  );
  const deleteRoute = readRouteSection(
    "router.delete('/agents/:id/unattended-plan'",
    "router.post('/tasks/:id/dismiss-attention'",
  );
  assert.doesNotMatch(
    saveRoute,
    /await supersedeStalePlanConfigurationAttention\(tx/gu,
  );
  assert.doesNotMatch(
    deleteRoute,
    /await supersedeStalePlanConfigurationAttention\(tx/gu,
  );
});

test("plan configuration bypasses capture queue blockers and late receipts stay fenced", () => {
  const createRoute = readRouteSection(
    "router.post('/agents/:id/tasks'",
    "router.post('/tasks/:id/resume'",
  );
  const queueBlockerStart = createRoute.indexOf("const queueBlocker");
  const queueBlockerEnd = createRoute.indexOf("const total", queueBlockerStart);
  const queueBlockerSection = createRoute.slice(
    queueBlockerStart,
    queueBlockerEnd,
  );
  assert.match(
    createRoute,
    /const queueBlocker = isPlanConfiguration \? null : await tx\.queryOne/u,
  );
  assert.match(
    queueBlockerSection,
    /'pending', 'claimed', 'running', 'recovering',[\s\S]*'interrupted', 'resume_requested'/u,
  );
  assert.doesNotMatch(
    queueBlockerSection,
    /'needs_action'|'failed'|'completed_with_failures'/u,
  );
  assert.match(
    captureCloudRouteSource,
    /'superseded_by_stop',[\s\S]*'stopped_before_dispatch',[\s\S]*'superseded_by_newer_plan'/u,
  );
});

test("a stop-fenced acknowledged create settles exact no-target receipts as canceled", () => {
  const requestId = "11111111-1111-4111-8111-111111111111";
  const createCommandId = "22222222-2222-4222-8222-222222222222";
  for (const resultReason of ["not_found", "request_mismatch"]) {
    assert.deepEqual(
      resolveStopCommandOutcome({
        reportedSuccess: false,
        expectedRequestId: requestId,
        actualRequestId: requestId,
        resultReason,
        supersededCreateCommandId: createCommandId,
        previousStatus: "pending",
      }),
      {
        validRequestId: true,
        validAttemptId: true,
        success: true,
        stoppedBeforeLocalCreation: true,
        commandStatus: "completed",
        taskStatus: "canceled",
      },
    );
  }
});

test("stop-fenced no-target handling preserves request identity and real failures", () => {
  const requestId = "11111111-1111-4111-8111-111111111111";
  const createCommandId = "22222222-2222-4222-8222-222222222222";
  const wrongRequest = resolveStopCommandOutcome({
    reportedSuccess: false,
    expectedRequestId: requestId,
    actualRequestId: "33333333-3333-4333-8333-333333333333",
    resultReason: "not_found",
    supersededCreateCommandId: createCommandId,
    previousStatus: "claimed",
  });
  assert.equal(wrongRequest.validRequestId, false);
  assert.equal(wrongRequest.success, false);
  assert.equal(wrongRequest.commandStatus, "failed");
  assert.equal(wrongRequest.taskStatus, "claimed");
  const wrongSuccessfulReceipt = resolveStopCommandOutcome({
    reportedSuccess: true,
    expectedRequestId: requestId,
    actualRequestId: "33333333-3333-4333-8333-333333333333",
    previousStatus: "running",
  });
  assert.equal(wrongSuccessfulReceipt.validRequestId, false);
  assert.equal(wrongSuccessfulReceipt.success, false);
  assert.equal(wrongSuccessfulReceipt.taskStatus, "running");

  for (const input of [
    {resultReason: "not_found", supersededCreateCommandId: ""},
    {resultReason: "capture_cancel_failed", supersededCreateCommandId: createCommandId},
  ]) {
    const outcome = resolveStopCommandOutcome({
      reportedSuccess: false,
      expectedRequestId: requestId,
      actualRequestId: requestId,
      previousStatus: "running",
      ...input,
    });
    assert.equal(outcome.validRequestId, true);
    assert.equal(outcome.success, false);
    assert.equal(outcome.stoppedBeforeLocalCreation, false);
    assert.equal(outcome.commandStatus, "failed");
    assert.equal(outcome.taskStatus, "running");
  }

  const normalSuccess = resolveStopCommandOutcome({
    reportedSuccess: true,
    expectedRequestId: requestId,
    actualRequestId: requestId,
    previousStatus: "running",
  });
  assert.equal(normalSuccess.success, true);
  assert.equal(normalSuccess.stoppedBeforeLocalCreation, false);
  assert.equal(normalSuccess.commandStatus, "completed");
  assert.equal(normalSuccess.taskStatus, "canceled");
});

test("targeted stop receipts require both request and attempt identity", () => {
  const requestId = "11111111-1111-4111-8111-111111111111";
  const attemptId = "targeted-attempt-current";
  const exact = resolveStopCommandOutcome({
    reportedSuccess: true,
    expectedRequestId: requestId,
    actualRequestId: requestId,
    expectedAttemptId: attemptId,
    actualAttemptId: attemptId,
    previousStatus: "running",
  });
  assert.equal(exact.validRequestId, true);
  assert.equal(exact.validAttemptId, true);
  assert.equal(exact.success, true);
  assert.equal(exact.taskStatus, "canceled");

  for (const actualAttemptId of ["", "targeted-attempt-stale"]) {
    const stale = resolveStopCommandOutcome({
      reportedSuccess: true,
      expectedRequestId: requestId,
      actualRequestId: requestId,
      expectedAttemptId: attemptId,
      actualAttemptId,
      previousStatus: "running",
    });
    assert.equal(stale.validRequestId, true);
    assert.equal(stale.validAttemptId, false);
    assert.equal(stale.success, false);
    assert.equal(stale.commandStatus, "failed");
    assert.equal(stale.taskStatus, "running");
  }

  const legacy = resolveStopCommandOutcome({
    reportedSuccess: true,
    expectedRequestId: requestId,
    actualRequestId: requestId,
    previousStatus: "running",
  });
  assert.equal(legacy.validAttemptId, true);
  assert.equal(legacy.success, true);
});

test("agent capabilities and command results share the server-side redaction boundary", () => {
  const sanitized = sanitizeCloudStructuredObject({
    supportedPlatforms: ["xiaohongshu", "douyin"],
    nested: {cookie: "secret-cookie", token: "secret-token", safe: "visible"},
    message: "Authorization=Bearer abc.def",
  });
  const serialized = JSON.stringify(sanitized);
  assert.equal(serialized.includes("secret-cookie"), false);
  assert.equal(serialized.includes("secret-token"), false);
  assert.equal(serialized.includes("abc.def"), false);
  assert.equal(sanitized.nested.safe, "visible");
});

test("remote task input normalizes platform, deduplicates keywords, and clamps execution bounds", () => {
  const nextRunAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const keywords = [
    " 新能源 ",
    "新能源",
    "智能座舱",
    ...Array.from({length: 35}, (_, index) => `关键词-${index + 1}`),
  ];
  const normalized = normalizeRemoteTaskInput({
    clientTaskId: " admin-task-1 ",
    title: " 新能源舆情采集 ",
    platform: "xhs",
    keywords,
    sort: "latest",
    publishTime: "week",
    maxRounds: 999,
    roundGapMin: -9,
    recoveryPolicy: {allowIdleAgentHandoff: false},
    nextRunAt,
  });

  assert.equal(normalized.clientTaskId, "admin-task-1");
  assert.equal(normalized.executionMode, "one_time");
  assert.equal(normalized.title, "新能源舆情采集");
  assert.equal(normalized.planSnapshot.platform, "xiaohongshu");
  assert.equal(normalized.planSnapshot.keywords.length, 30);
  assert.deepEqual(normalized.planSnapshot.keywords.slice(0, 2), [
    "新能源",
    "智能座舱",
  ]);
  assert.equal(new Set(normalized.planSnapshot.keywords).size, 30);
  assert.equal(normalized.planSnapshot.searchFilters.sort, "latest");
  assert.equal(normalized.planSnapshot.searchFilters.publishTime, "week");
  assert.equal(normalized.planSnapshot.maxRounds, 100);
  assert.equal(normalized.planSnapshot.roundGapMin, 0);
  assert.deepEqual(normalized.planSnapshot.recoveryPolicy, {
    allowIdleAgentHandoff: false,
    platformSafetyMode: "manual_confirmed",
  });
  assert.equal(normalized.planSnapshot.nextRunAt, nextRunAt);

  const lowerAndUpperBounds = normalizeRemoteTaskInput({
    platform: "douyin",
    keywords: ["汽车"],
    maxRounds: 0,
    roundGapMin: 99_999,
  });
  assert.equal(lowerAndUpperBounds.planSnapshot.maxRounds, 1);
  assert.equal(lowerAndUpperBounds.planSnapshot.roundGapMin, 1440);

  const unattendedPlan = normalizeRemoteTaskInput({
    executionMode: "plan",
    platform: "douyin",
    keywords: ["汽车"],
    mode: "holidays",
    startTime: "25:90",
    randomOffsetMin: 9999,
    customDates: [
      "2026-10-1",
      "2026/10/01",
      "2026/2/29",
      "2028/2/29",
      "2026-02-30",
      "2026-1-2",
      "invalid",
    ].join("\n"),
  });
  assert.equal(unattendedPlan.executionMode, "unattended_plan");
  assert.equal(unattendedPlan.title, "无人值守关键词采集计划");
  assert.equal(unattendedPlan.planSnapshot.mode, "custom_dates");
  assert.equal(unattendedPlan.planSnapshot.startTime, "09:00");
  assert.equal(unattendedPlan.planSnapshot.randomOffsetMin, 1440);
  assert.equal(
    unattendedPlan.planSnapshot.customDates,
    "2026-10-01\n2028-02-29\n2026-01-02",
  );
});

test("remote sequential search passes force verified filters and disable hidden retries", () => {
  const sequential = normalizeRemoteTaskInput({
    executionMode: "one_time",
    platform: "douyin",
    keywords: ["别克壁纸"],
    searchPasses: ["all", "video"],
  });
  assert.deepEqual(sequential.planSnapshot.searchPasses, ["all", "video"]);
  assert.equal(sequential.planSnapshot.searchFilters.contentType, "all");
  assert.equal(
    sequential.planSnapshot.recoveryPolicy.disableAutomaticSearchRetry,
    true,
  );
  assert.equal(sequential.planSnapshot.recoveryPolicy.requireVerifiedFilters, true);

  const xhs = normalizeRemoteTaskInput({
    executionMode: "unattended_plan",
    platform: "xiaohongshu",
    keywords: ["别克壁纸"],
    searchPasses: ["all", "image"],
  });
  assert.equal(Object.hasOwn(xhs.planSnapshot, "searchPasses"), false);
  assert.equal(
    Object.hasOwn(xhs.planSnapshot.recoveryPolicy, "disableAutomaticSearchRetry"),
    false,
  );

  const constrained = normalizeRemoteTaskInput({
    executionMode: "one_time",
    platform: "douyin",
    keywords: ["别克壁纸"],
    searchPasses: ["all", "image"],
    searchFilters: {
      publishTime: ["day", "week"],
      sort: ["latest", "likes"],
    },
  });
  assert.equal(constrained.planSnapshot.searchFilters.publishTime, "day");
  assert.equal(constrained.planSnapshot.searchFilters.sort, "latest");
  assert.deepEqual(constrained.planSnapshot.searchPasses, ["all", "image"]);
});

test("remote keyword post limits are optional, normalized, and fail safely", () => {
  const explicit = normalizeRemoteTaskInput({
    platform: "douyin",
    keywords: ["汽车"],
    keywordMaxDetectedItems: "137.9",
  }).planSnapshot;
  assert.equal(explicit.keywordMaxDetectedItems, 137);

  const omitted = normalizeRemoteTaskInput({
    platform: "douyin",
    keywords: ["汽车"],
  }).planSnapshot;
  assert.equal(
    Object.hasOwn(omitted, "keywordMaxDetectedItems"),
    false,
    "older nodes and local tasks must keep using the device-local limit",
  );

  for (const invalidValue of [0, -1, "invalid", null]) {
    const normalized = normalizeRemoteTaskInput({
      platform: "xiaohongshu",
      keywords: ["汽车"],
      keywordMaxDetectedItems: invalidValue,
    }).planSnapshot;
    assert.ok(
      Number.isSafeInteger(normalized.keywordMaxDetectedItems) &&
        normalized.keywordMaxDetectedItems > 0,
      `invalid explicit value ${String(invalidValue)} must normalize to a safe positive value`,
    );
  }
});

test("remote request identity changes when only the keyword post limit changes", () => {
  const safeJsonSource = readRouteSection(
    "function safeJson(value)",
    "function remoteTaskRequestHash(",
  );
  const hashSource = readRouteSection(
    "function remoteTaskRequestHash(",
    "export function captureTaskSnapshotFingerprint(",
  );
  const context = vm.createContext({crypto});
  vm.runInContext(
    `${safeJsonSource}\n${hashSource}\nglobalThis.__remoteTaskRequestHash = remoteTaskRequestHash;`,
    context,
  );
  const requestHash = context.__remoteTaskRequestHash;
  const basePlan = {
    enabled: true,
    platform: "douyin",
    keywords: ["汽车"],
    searchFilters: {sort: "latest"},
    maxRounds: 1,
    roundGapMin: 0,
  };

  const limit50 = requestHash(
    "agent-1",
    "云端任务",
    "one_time",
    {...basePlan, keywordMaxDetectedItems: 50},
  );
  const limit51 = requestHash(
    "agent-1",
    "云端任务",
    "one_time",
    {...basePlan, keywordMaxDetectedItems: 51},
  );
  assert.notEqual(limit50, limit51);
  assert.equal(
    limit50,
    requestHash(
      "agent-1",
      "云端任务",
      "one_time",
      {...basePlan, keywordMaxDetectedItems: 50},
    ),
  );
});

test("remote task input accepts nested capture settings and preserves positive comment limits", () => {
  const normalized = normalizeRemoteTaskInput({
    platform: "xiaohongshu",
    keywords: ["汽车"],
    // Enhancement options are a versioned nested contract. A same-named
    // top-level value must not silently override the nested task snapshot.
    autoDetailCaptureAfterListCapture: false,
    detailCommentsMaxDetectedItems: 1,
    captureSettings: {
      autoDetailCaptureAfterListCapture: true,
      autoSyncAfterDetailCapture: true,
      enableAiRelevancePrefilter: true,
      includeBloggerMetricsOnDetailCapture: true,
      enableLowFollowerHitFilterOnDetailCapture: true,
      lowFollowerHitThresholdOnDetailCapture: 7500,
      includeCommentsOnDetailCapture: true,
      detailCommentsMaxDetectedItems: 1000,
      enableCommentLeadsFilterOnDetailCapture: true,
      skipAlreadyCapturedOnDetailCapture: true,
    },
  });

  assert.deepEqual(normalized.planSnapshot.captureSettings, {
    autoDetailCaptureAfterListCapture: true,
    autoSyncAfterDetailCapture: true,
    enableAiRelevancePrefilter: true,
    includeBloggerMetricsOnDetailCapture: true,
    enableLowFollowerHitFilterOnDetailCapture: true,
    lowFollowerHitThresholdOnDetailCapture: 7500,
    includeCommentsOnDetailCapture: true,
    detailCommentsMaxDetectedItems: 1000,
    enableCommentLeadsFilterOnDetailCapture: true,
    skipAlreadyCapturedOnDetailCapture: true,
  });

  const legacyInput = normalizeRemoteTaskInput({
    platform: "douyin",
    keywords: ["汽车"],
    autoDetailCaptureAfterListCapture: true,
    detailCommentsMaxDetectedItems: 1000,
  });
  assert.equal(
    Object.hasOwn(legacyInput.planSnapshot, "captureSettings"),
    false,
  );
});

test("remote capture settings normalize dependent options fail closed", () => {
  const disabledEnhancement = normalizeRemoteTaskInput({
    platform: "douyin",
    keywords: ["汽车"],
    captureSettings: {
      autoDetailCaptureAfterListCapture: false,
      autoSyncAfterDetailCapture: true,
      enableAiRelevancePrefilter: true,
      includeBloggerMetricsOnDetailCapture: true,
      enableLowFollowerHitFilterOnDetailCapture: true,
      includeCommentsOnDetailCapture: true,
      enableCommentLeadsFilterOnDetailCapture: true,
      skipAlreadyCapturedOnDetailCapture: true,
    },
  }).planSnapshot.captureSettings;

  for (const key of [
    "autoDetailCaptureAfterListCapture",
    "autoSyncAfterDetailCapture",
    "enableAiRelevancePrefilter",
    "includeBloggerMetricsOnDetailCapture",
    "enableLowFollowerHitFilterOnDetailCapture",
    "includeCommentsOnDetailCapture",
    "enableCommentLeadsFilterOnDetailCapture",
    "skipAlreadyCapturedOnDetailCapture",
  ]) {
    assert.equal(disabledEnhancement[key], false, `${key} must be gated`);
  }

  const disabledParents = normalizeRemoteTaskInput({
    platform: "xiaohongshu",
    keywords: ["汽车"],
    captureSettings: {
      autoDetailCaptureAfterListCapture: true,
      includeBloggerMetricsOnDetailCapture: false,
      enableLowFollowerHitFilterOnDetailCapture: true,
      includeCommentsOnDetailCapture: false,
      enableCommentLeadsFilterOnDetailCapture: true,
    },
  }).planSnapshot.captureSettings;
  assert.equal(disabledParents.enableLowFollowerHitFilterOnDetailCapture, false);
  assert.equal(disabledParents.enableCommentLeadsFilterOnDetailCapture, false);
});

test("ended failures can be dismissed from attention without deleting task history", () => {
  const single = readRouteSection(
    "router.post('/tasks/:id/dismiss-attention'",
    "router.post('/tasks/dismiss-terminal-attention'",
  );
  const bulk = readRouteSection(
    "router.post('/tasks/dismiss-terminal-attention'",
    "router.post('/tasks/:id/resume'",
  );

  assert.match(
    captureCloudRouteSource,
    /const DISMISSIBLE_ATTENTION_STATUSES = new Set\(\[[\s\S]*'failed'[\s\S]*'completed_with_failures'/u,
  );
  assert.match(single, /parent_task_id/u);
  assert.match(single, /DISMISSIBLE_ATTENTION_STATUSES\.has\(task\.status\)/u);
  assert.match(single, /attention_dismissed_at = now\(\)/u);
  assert.match(single, /eventType: 'task_attention_dismissed'/u);
  assert.match(single, /任务和采集结果仍会保留/u);
  assert.doesNotMatch(single, /\bDELETE\b/u);

  assert.match(
    bulk,
    /status IN \('failed', 'completed_with_failures'\)/u,
  );
  assert.match(bulk, /attention_dismissed_at IS NULL/u);
  assert.match(bulk, /parent_task_id IS NULL/u);
  assert.doesNotMatch(bulk, /\bDELETE\b/u);

  const overview = readRouteSection(
    "router.get('/overview'",
    "router.patch('/agents/:id'",
  );
  assert.match(
    overview,
    /WHERE t\.status IN \('interrupted', 'needs_action', 'failed', 'completed_with_failures'\)[\s\S]*t\.attention_dismissed_at IS NULL/u,
  );
});

test("stale cloud commands are reconciled by cron without waiting for UI or Agent heartbeat", () => {
  assert.match(
    captureCloudRouteSource,
    /export async function reconcilePendingCaptureCommands/u,
  );
  assert.match(
    captureCloudRouteSource,
    /WHERE status IN \('pending', 'acknowledged'\)[\s\S]*expireStaleCommands\(tx, tenant\.tenant_id\)/u,
  );
  assert.match(
    cronSource,
    /reconcilePendingCaptureCommands\(\)[\s\S]*enqueueDueProfilePatrolTasks/u,
  );
  assert.match(
    cronSource,
    /reconcilePendingCaptureCommands\(\)[\s\S]*enqueueDueCaptureOrchestrations/u,
  );
});

test("settled single-node tasks can retry on another idle Agent without forking the business task", () => {
  const retry = readRouteSection(
    "router.post('/tasks/:id/retry-on-idle-agent'",
    "router.post('/tasks/:id/resume'",
  );
  assert.match(retry, /requireTenantAccess/u);
  assert.match(retry, /requireSessionUser/u);
  assert.match(retry, /requireTenantWriter/u);
  assert.match(retry, /dispatchCrossDeviceRetry/u);
  const dispatchCore = captureCloudRouteSource.slice(
    captureCloudRouteSource.indexOf("async function dispatchCrossDeviceRetry"),
    captureCloudRouteSource.indexOf(
      "export async function reconcileAutomaticCaptureRetries",
    ),
  );
  const idleAgentSelection = captureCloudRouteSource.slice(
    captureCloudRouteSource.indexOf(
      "async function loadIdleCrossDeviceRetryAgent",
    ),
    captureCloudRouteSource.indexOf("function promotedRetryFallbackTarget"),
  );
  const profileRetryRenewal = captureCloudRouteSource.slice(
    captureCloudRouteSource.indexOf(
      "async function renewProfileRetryExecutions",
    ),
    captureCloudRouteSource.indexOf(
      "export async function dispatchCrossDeviceRetry",
    ),
  );
  assert.match(dispatchCore, /loadIdleCrossDeviceRetryAgent/u);
  assert.match(idleAgentSelection, /for \(const candidate of eligibleCandidates\)/u);
  assert.match(
    idleAgentSelection,
    /const savepoint = 'capture_retry_agent_candidate'/u,
  );
  assert.match(idleAgentSelection, /tryLockCaptureAgentExecutionSlot/u);
  assert.match(
    idleAgentSelection,
    /ROLLBACK TO SAVEPOINT \$\{savepoint\}/u,
  );
  assert.match(captureCloudRouteSource, /AS active_command_count/u);
  assert.match(
    captureCloudRouteSource,
    /Number\(agent\.active_command_count \|\| 0\) === 0/u,
  );
  assert.match(captureCloudRouteSource, /findCaptureAgentExecutionSlotBlocker/u);
  assert.match(dispatchCore, /promoteSingleNodeTaskForRetry/u);
  assert.match(dispatchCore, /task_type = 'capture_orchestration'/u);
  assert.match(dispatchCore, /parent_task_id/u);
  assert.match(dispatchCore, /crossDeviceRetryRequestKey/u);
  assert.match(dispatchCore, /INSERT INTO capture_task_item_attempts/u);
  assert.match(dispatchCore, /renewProfileRetryExecutions/u);
  assert.ok(
    dispatchCore.indexOf('renewProfileRetryExecutions') <
      dispatchCore.indexOf('targetAgent = await loadIdleCrossDeviceRetryAgent'),
    'profile execution renewal must precede Agent-slot acquisition',
  );
  assert.match(
    profileRetryRenewal,
    /FROM monitor_executions[\s\S]*FOR UPDATE SKIP LOCKED[\s\S]*FROM monitor_subscriptions[\s\S]*FOR SHARE SKIP LOCKED/u,
  );
  assert.match(
    profileRetryRenewal,
    /const subscriptionSnapshot = await tx\.queryOne[\s\S]*retry_profile_subscription_unavailable[\s\S]*FOR SHARE SKIP LOCKED[\s\S]*retry_profile_subscription_busy/u,
  );
  assert.match(
    dispatchCore,
    /abortCrossDeviceRetry\('idle_compatible_agent_unavailable'/u,
  );
  assert.match(
    dispatchCore,
    /crossDeviceRetryError ===[\s\S]*'idle_compatible_agent_unavailable'[\s\S]*return noIdleAgentResult\(\)/u,
  );
  assert.match(dispatchCore, /cross_device_retry_dispatched/u);
  assert.match(dispatchCore, /abortCrossDeviceRetry\(promoted\.error\)/u);
  assert.match(dispatchCore, /abortCrossDeviceRetry\(renewedExecutions\.error\)/u);
  assert.match(
    captureCloudRouteSource,
    /cross_device_retry_transaction_abort/u,
  );
  assert.match(
    captureCloudRouteSource,
    /promotedRetryParent' IS DISTINCT FROM 'true'/u,
  );
});

test("late Xiaohongshu evidence detector is read-only and never trusts human reports", () => {
  const candidate = evaluateObservedCompletionCandidate({
    item_id: "11111111-1111-4111-8111-111111111111",
    task_id: "22222222-2222-4222-8222-222222222222",
    source_execution_task_id: "33333333-3333-4333-8333-333333333333",
    source_attempt_id: "44444444-4444-4444-8444-444444444444",
    source_attempt_number: 2,
    source_assignment_revision: 7,
    source_attempt_status: "failed",
    source_attempt_started_at: "2026-08-27T01:00:00.000Z",
    source_attempt_checkpoint: {
      savedCount: 2,
      scanComplete: true,
      searchPassResults: [
        {round: 1, status: "completed", scanComplete: true},
        {round: 2, status: "completed_with_warnings", scanComplete: true},
      ],
    },
    source_attempt_result: {savedCount: 2},
    parent_metadata: {planSnapshot: {searchPasses: ["main", "latest"]}},
    platform: "xiaohongshu",
    item_status: "needs_action",
    exact_observation_count: 2,
    latest_observation_at: "2026-08-27T01:03:00.000Z",
    lineage_last_activity_at: "2026-08-27T01:05:00.000Z",
    lineage_silent: true,
    active_started_attempt_count: 0,
    active_command_count: 0,
    active_execution_count: 0,
    active_recovery_lease_count: 0,
    started_successor_attempt_count: 0,
    unstarted_successor_attempt_count: 1,
    humanReport: "现场说已经保存成功",
  });

  assert.equal(candidate.evidenceCandidate, true);
  assert.equal(candidate.reconcileEligible, false);
  assert.equal(candidate.readOnly, true);
  assert.equal(candidate.runtimeAbsenceUnverified, true);
  assert.equal(candidate.humanReportAcceptedAsEvidence, false);
  assert.deepEqual(candidate.blockingChecks, ["runtimeAbsenceUnverified"]);
  assert.equal(candidate.successorAttempts.requiresTransactionalSealing, true);
  assert.equal(candidate.successorAttempts.sealed, false);
});

test("late evidence detector rejects incomplete scope, mismatched saves, or active lineage", () => {
  const result = evaluateObservedCompletionCandidate({
    source_attempt_id: "44444444-4444-4444-8444-444444444444",
    source_attempt_status: "running",
    source_attempt_started_at: "2026-08-27T01:00:00.000Z",
    source_attempt_checkpoint: {
      savedCount: 3,
      scanComplete: false,
      searchPassResults: [{round: 1, status: "completed", scanComplete: true}],
    },
    parent_metadata: {planSnapshot: {searchPasses: ["main", "latest"]}},
    platform: "xiaohongshu",
    item_status: "needs_action",
    exact_observation_count: 2,
    lineage_silent: false,
    active_started_attempt_count: 1,
    active_command_count: 1,
    active_execution_count: 1,
    active_recovery_lease_count: 1,
    started_successor_attempt_count: 1,
  });

  assert.equal(result.evidenceCandidate, false);
  assert.equal(result.reconcileEligible, false);
  assert.ok(result.blockingChecks.includes("savedObservationConsistent"));
  assert.ok(result.blockingChecks.includes("scopeComplete"));
  assert.ok(result.blockingChecks.includes("noActiveAttempt"));
  assert.ok(result.blockingChecks.includes("noActiveCommand"));
  assert.ok(result.blockingChecks.includes("noActiveExecution"));
  assert.ok(result.blockingChecks.includes("noActiveRecoveryLease"));
  assert.ok(result.blockingChecks.includes("lineageSilent"));
  assert.ok(result.blockingChecks.includes("noStartedSuccessorAttempt"));
});

test("late evidence candidate endpoint is tenant-scoped and cannot mutate state", () => {
  const route = readRouteSection(
    "router.get('/late-evidence-candidates'",
    "router.get('/history'",
  );
  assert.match(route, /item\.tenant_id = \$1/u);
  assert.match(route, /item\.platform = 'xiaohongshu'/u);
  assert.match(route, /capture_task_item_attempt_id = source_attempt\.id/u);
  assert.match(route, /command\.status IN \('pending', 'acknowledged'\)/u);
  assert.match(
    route,
    /command\.task_id IN \([\s\S]*SELECT DISTINCT attempt\.execution_task_id[\s\S]*attempt\.item_id = item\.id/u,
  );
  assert.doesNotMatch(
    route,
    /command\.task_id IN \(item\.task_id, source_attempt\.execution_task_id\)/u,
  );
  assert.match(route, /intent\.lease_expires_at > clock_timestamp\(\)/u);
  assert.match(route, /automaticMutationEnabled: false/u);
  assert.match(route, /runtimeAbsenceSource: 'not_persisted'/u);
  assert.doesNotMatch(route, /\b(?:UPDATE|INSERT|DELETE)\b/u);
  assert.doesNotMatch(route, /req\.body/u);
});

test("cross-device retry uses known current-day Agent search usage and enforces account limits", () => {
  assert.equal(crossDeviceRetryAgentDailyUsageEligible({}), false);
  assert.equal(crossDeviceRetryAgentDailyUsageEligible({
    today_usage_current: false,
    today_usage_last_event_at: '2026-08-26T23:59:59.000Z',
    today_searches: 0,
    daily_search_limit: 10,
  }), false);
  assert.equal(crossDeviceRetryAgentDailyUsageEligible({
    today_usage_current: true,
    today_usage_last_event_at: null,
    today_searches: 0,
    daily_search_limit: 10,
  }), false);
  assert.equal(crossDeviceRetryAgentDailyUsageEligible({
    today_usage_current: true,
    today_usage_last_event_at: '2026-08-27T00:01:00.000Z',
    today_searches: 7,
    daily_search_limit: 10,
  }), true);
  assert.equal(crossDeviceRetryAgentDailyUsageEligible({
    today_usage_current: true,
    today_usage_last_event_at: '2026-08-27T00:01:00.000Z',
    today_searches: 10,
    daily_search_limit: 10,
  }), false);
  assert.equal(crossDeviceRetryAgentDailyUsageEligible({
    today_usage_current: true,
    today_usage_last_event_at: '2026-08-27T00:01:00.000Z',
    today_searches: 35,
    daily_search_limit: 0,
  }), true);

  const idleAgentSelection = captureCloudRouteSource.slice(
    captureCloudRouteSource.indexOf(
      "async function loadIdleCrossDeviceRetryAgent",
    ),
    captureCloudRouteSource.indexOf("function promotedRetryFallbackTarget"),
  );
  assert.match(
    idleAgentSelection,
    /JOIN social_agent_daily_usage daily_usage/u,
  );
  assert.doesNotMatch(
    idleAgentSelection,
    /social_account_daily_usage/u,
  );
  assert.match(
    idleAgentSelection,
    /daily_usage\.usage_date =\s*\(now\(\) AT TIME ZONE 'Asia\/Shanghai'\)::date/u,
  );
  assert.match(
    idleAgentSelection,
    /daily_usage\.last_event_at IS NOT NULL/u,
  );
  assert.doesNotMatch(
    idleAgentSelection,
    /COALESCE\(daily_usage\.searches,\s*0\)/u,
  );
  assert.match(
    idleAgentSelection,
    /daily_usage\.searches < current_social_account\.daily_search_limit/u,
  );
  assert.match(
    idleAgentSelection,
    /ORDER BY daily_usage\.searches ASC,\s*recent_technical_failure_count ASC/u,
  );
  assert.match(
    idleAgentSelection,
    /FOR UPDATE OF ca, daily_usage/u,
  );
  assert.equal(
    (idleAgentSelection.match(
      /crossDeviceRetryAgentDailyUsageEligible\(/gu,
    ) || []).length,
    2,
    'usage eligibility must be checked both before and after slot locking',
  );
});

test("duty recovery dispatch is one-item, fenced, idempotent, and auditable", () => {
  const dispatchCore = captureCloudRouteSource.slice(
    captureCloudRouteSource.indexOf(
      "export async function dispatchCrossDeviceRetry",
    ),
    captureCloudRouteSource.indexOf(
      "export async function reconcileElasticCaptureLeases",
    ),
  );
  assert.match(dispatchCore, /recoveryPhase = 'fast'/u);
  assert.match(
    captureCloudRouteSource,
    /crossDeviceRetrySourceReady\([\s\S]*dutyRecovery = false[\s\S]*if \(dutyRecovery\) return true/u,
  );
  assert.match(dispatchCore, /requestedItemIds\.length !== 1/u);
  assert.match(dispatchCore, /dutyRecoveryIntentId/u);
  assert.match(dispatchCore, /dutyRecoveryGeneration/u);
  assert.match(dispatchCore, /expectedItemRevision/u);
  assert.match(dispatchCore, /expectedSourceAttemptId/u);
  assert.match(dispatchCore, /expectedAttemptNumber/u);
  assert.match(dispatchCore, /FOR UPDATE[\s\S]*source_attempt_changed/u);
  assert.match(dispatchCore, /code: 'NO_IDLE_AGENT'/u);
  assert.match(dispatchCore, /waitingForAgent: true/u);
  assert.match(dispatchCore, /code: 'SOURCE_EXECUTION_ACTIVE'/u);
  assert.match(dispatchCore, /code: 'SOURCE_COMMAND_ACTIVE'/u);
  assert.match(dispatchCore, /waitingForSource: true/u);
  assert.match(dispatchCore, /replayed: true/u);
  assert.match(dispatchCore, /itemAttempts: dispatchedItemAttempts/u);
  assert.match(dispatchCore, /captureTaskItemAttemptId: binding\.attemptId/u);
  assert.match(dispatchCore, /captureTaskItemRequestHash: binding\.requestHash/u);
  assert.match(
    dispatchCore,
    /const agentCompatibilityPayload = dutyRecovery[\s\S]*dutyRecovery: \{intentId: dutyIntentId, protocolVersion: 1\}[\s\S]*commandPayload: agentCompatibilityPayload/u,
  );
  assert.match(dispatchCore, /orchestration:[\s\S]*itemAttempts: itemAttemptBindings/u);
  assert.match(
    dispatchCore,
    /UPDATE capture_agent_commands[\s\S]*payload = \$3::jsonb/u,
  );
  assert.match(dispatchCore, /dutyRecoverySourceAttemptId/u);
  assert.match(dispatchCore, /recoveryPhase: 'duty'/u);
});

test("recovery verification and replay clocks require exact business evidence", () => {
  const recoverySource = readRouteSection(
    "async function projectNegativePatrolSnapshot",
    "async function projectOrchestrationChildControlOutcome",
  );
  assert.match(
    recoverySource,
    /metadata->'targetResult'\s+IS DISTINCT FROM \$6::jsonb/u,
  );
  assert.match(
    recoverySource,
    /if \(!item\) continue;\s*projectedItemIds\.push\(item\.id\);/u,
  );
  assert.match(
    recoverySource,
    /const projectedBusinessProgressAt =\s*orchestrationCheckpointTimestamp\(snapshot\.businessProgressAt\) \|\|\s*\(projectedItemIds\.length > 0 \? now : null\);/u,
  );
  assert.doesNotMatch(
    recoverySource,
    /const projectedBusinessProgressAt[\s\S]{0,240}snapshot\.heartbeatAt/u,
  );
});

test("legacy retry remains only as a fallback outside guarded duty Agent tenants", () => {
  assert.match(
    captureCloudRouteSource,
    /export async function reconcileAutomaticCaptureRetries/u,
  );
  assert.match(
    captureCloudRouteSource,
    /status = ANY\(\$1::text\[\]\)[\s\S]*allowIdleAgentHandoff/u,
  );
  assert.match(
    captureCloudRouteSource,
    /classifyCaptureRecoveryDisposition\(item\)\.automatic/u,
  );
  assert.match(
    captureCloudRouteSource,
    /sort\(\(left, right\) => Number\(left\.ordinal\) - Number\(right\.ordinal\)\)[\s\S]*\.slice\(0, 1\)/u,
  );
  assert.match(
    captureCloudRouteSource,
    /AUTOMATIC_CROSS_DEVICE_FOLLOWUP_STATUSES[\s\S]*lastAutomaticRecoveryTaskId/u,
  );
  assert.match(
    captureCloudRouteSource,
    /item_id = ANY\(\$2::uuid\[\]\)[\s\S]*crossDeviceRetrySourceAgentIdsForItems/u,
  );
  assert.match(
    captureCloudRouteSource,
    /\$7::boolean = false[\s\S]*recovery_enabled\.key = 'ops_control_recovery_enabled'[\s\S]*LOWER\(BTRIM\(recovery_mode\.value\)\) = 'guarded'/u,
  );
  assert.match(
    cronSource,
    /reconcileAutomaticCaptureRetries\(10\)/u,
  );
  assert.match(cronSource, /processCaptureAttentionNotifications\(20\)/u);
});
