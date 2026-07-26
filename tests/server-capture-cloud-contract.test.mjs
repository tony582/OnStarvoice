import assert from "node:assert/strict";
import crypto from "node:crypto";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import {
  captureAgentOnline,
  isCloudTaskActive,
  isCloudTaskTerminal,
  lockCaptureAgentExecutionSlot,
  normalizeCaptureAgentPlatforms,
  normalizeCloudTaskSnapshot,
  normalizeCloudTaskStatus,
  normalizeRemoteTaskInput,
  parseCaptureAgentEnvironment,
  sanitizeCloudStructuredObject,
} from "../server/services/capture-cloud.js";
import {
  captureTaskSnapshotFingerprint,
  orchestrationCheckpointEntries,
  orchestrationCheckpointInteger,
  orchestrationCheckpointTimestamp,
  resolveStopCommandOutcome,
} from "../server/routes/capture-cloud.js";

const captureCloudRouteSource = await readFile(
  new URL("../server/routes/capture-cloud.js", import.meta.url),
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

test("agent platform assignment is bounded, normalized, and deduplicated", () => {
  assert.deepEqual(
    normalizeCaptureAgentPlatforms(["xhs", "douyin", "DOUYIN", "unknown", "weibo"]),
    ["xiaohongshu", "douyin", "weibo"],
  );
  assert.deepEqual(normalizeCaptureAgentPlatforms("xiaohongshu"), []);
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
    /metadata = metadata \|\| jsonb_build_object\('checkpoint', \$4::jsonb\)/u,
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

  const heartbeat = readRouteSection(
    "router.post('/agent/heartbeat'",
    "router.post('/agent/commands/:id/complete'",
  );
  const heartbeatTransaction = heartbeat.indexOf(
    "const result = await withTransaction(async tx =>",
  );
  const heartbeatLock = heartbeat.indexOf(
    "await lockCaptureAgentExecutionSlot(",
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

test("overview never presents interrupted or needs-action Agents as idle", () => {
  const overview = readRouteSection(
    "router.get('/overview'",
    "router.patch('/agents/:id'",
  );
  assert.match(
    overview,
    /AS active_task_count[\s\S]*assigned\.status IN \([\s\S]*'interrupted'[\s\S]*'needs_action'/u,
  );
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
    /status: 'needs_action',[\s\S]*code: 'create_command_expired'/u,
  );
  assert.match(
    expiry,
    /status: 'needs_action',[\s\S]*code: 'create_agent_unavailable'/u,
  );

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
    /command\.command_type === 'stop'[\s\S]*success[\s\S]*status: 'canceled'/u,
  );
  assert.match(completion, /SELECT id, parent_task_id, status, error, metadata/u);
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
    /assigned\.status IN \([\s\S]*'claimed', 'running', 'recovering', 'interrupted',[\s\S]*'needs_action', 'resume_requested'/u,
  );
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
    /FROM capture_task_attempts existing_attempt[\s\S]*existing_attempt\.attempt_number = EXCLUDED\.attempt_number[\s\S]*existing_attempt\.client_attempt_id <> ''[\s\S]*\$27 <> ''[\s\S]*existing_attempt\.client_attempt_id <> \$27/u,
  );
  assert.match(
    mirrorSection,
    /client_attempt_id = CASE[\s\S]*capture_task_attempts\.client_attempt_id <> ''[\s\S]*EXCLUDED\.client_attempt_id = ''[\s\S]*THEN capture_task_attempts\.client_attempt_id[\s\S]*ELSE EXCLUDED\.client_attempt_id/u,
  );
  assert.match(
    mirrorSection,
    /WHERE capture_task_attempts\.client_attempt_id = ''[\s\S]*OR EXCLUDED\.client_attempt_id = ''[\s\S]*OR capture_task_attempts\.client_attempt_id = EXCLUDED\.client_attempt_id/u,
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
