import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import test from "node:test";
import vm from "node:vm";
import {fileURLToPath} from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(resolve(repoRoot, "utils/task-center.js"), "utf8");
const context = vm.createContext({Date});
vm.runInContext(source, context, {filename: "utils/task-center.js"});
const core = context.OnStarvoiceTaskCenterCore;

const NOW = Date.parse("2026-07-16T04:00:00.000Z");

function toPlain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("classic script exposes the shared task center core", () => {
  assert.equal(core.TASK_LEDGER_VERSION, 1);
  assert.equal(core.TERMINAL_STATUSES.has("completed"), true);
  assert.equal(core.TERMINAL_STATUSES.has("completed_with_failures"), true);
  assert.equal(core.isTerminalTaskStatus("cancelled"), true);
  assert.equal(core.isTerminalTaskStatus("needs_action"), false);
  assert.equal(typeof core.normalizeTaskLedger, "function");
});

test("normalization keeps heartbeat and business progress independent", () => {
  const run = core.normalizeTaskRun(
    {
      id: "run-1",
      status: "running",
      heartbeatAt: "2026-07-16T03:59:00Z",
      businessProgressAt: "2026-07-16T03:50:00Z",
      progressSeq: 7,
    },
    {now: NOW},
  );

  assert.equal(run.heartbeatAt, "2026-07-16T03:59:00.000Z");
  assert.equal(run.businessProgressAt, "2026-07-16T03:50:00.000Z");
  assert.equal(run.progressSeq, 7);

  const heartbeatOnly = core.mergeTaskRun(
    run,
    {heartbeatAt: "2026-07-16T04:00:00Z"},
    {now: NOW},
  );
  assert.equal(heartbeatOnly.accepted, true);
  assert.equal(heartbeatOnly.run.heartbeatAt, "2026-07-16T04:00:00.000Z");
  assert.equal(
    heartbeatOnly.run.businessProgressAt,
    "2026-07-16T03:50:00.000Z",
  );
});

test("checkpoint normalization keeps bounded per-keyword history for task details", () => {
  const run = core.normalizeTaskRun(
    {
      id: "run-checkpoint",
      status: "running",
      checkpoint: {
        round: 2,
        keywordResults: [
          {
            round: 2,
            index: 1,
            keyword: "竞品",
            status: "failed",
            attemptCount: 2,
            savedCount: 3,
            error: "token=must-not-leak",
            errorCode: "DOUYIN_SEARCH_SERVICE_ABNORMAL",
            errorCategory: "platform_service_abnormal",
            securityBlocked: true,
            requiresManualAction: true,
            finishedAt: "2026-07-16T03:58:00Z",
          },
        ],
      },
    },
    {now: NOW},
  );

  assert.deepEqual(toPlain(run.checkpoint.keywordResults), [
    {
      round: 2,
      index: 1,
      keyword: "竞品",
      status: "failed",
      attemptCount: 2,
      savedCount: 3,
      error: "token=[REDACTED]",
      errorCode: "DOUYIN_SEARCH_SERVICE_ABNORMAL",
      errorCategory: "platform_service_abnormal",
      finishedAt: "2026-07-16T03:58:00.000Z",
    },
  ]);
});

test("checkpoint normalization retains confirmed Xiaohongshu page evidence", () => {
  const run = core.normalizeTaskRun({
    id: "run-xhs-safety",
    status: "needs_action",
    checkpoint: {
      keywordResults: [{
        round: 1,
        keyword: "安吉星",
        status: "failed",
        errorCode: "XHS_SECURITY_BLOCK",
        errorCategory: "platform_safety_block",
        securityBlocked: true,
        platformSafetyBlocked: true,
        requiresManualAction: true,
        securityEvidence: {
          confirmed: true,
          platform: "xiaohongshu",
          variant: "cn_rate_limit_300013",
          language: "zh-CN",
          reason: "rate_limit",
        },
      }],
    },
  }, {now: NOW});

  const entry = run.checkpoint.keywordResults[0];
  assert.equal(entry.securityBlocked, true);
  assert.equal(entry.platformSafetyBlocked, true);
  assert.equal(entry.requiresManualAction, true);
  assert.equal(entry.securityEvidence.variant, "cn_rate_limit_300013");
});

test("terminal status absorbs later updates", () => {
  const completed = core.normalizeTaskRun(
    {
      id: "run-terminal",
      attemptId: "attempt-1",
      status: "completed",
      progressSeq: 12,
      message: "done",
    },
    {now: NOW},
  );
  const result = core.mergeTaskRun(
    completed,
    {
      attemptId: "attempt-1",
      status: "running",
      progressSeq: 13,
      message: "stale heartbeat",
    },
    {now: NOW + 1000},
  );

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "terminal_absorbed");
  assert.equal(result.run.status, "completed");
  assert.equal(result.run.message, "done");
});

test("attempt fencing rejects old writers and permits an explicit newer recovery attempt", () => {
  const current = core.normalizeTaskRun(
    {
      id: "run-attempt",
      status: "running",
      attemptId: "attempt-2",
      attemptNumber: 2,
      progressSeq: 8,
    },
    {now: NOW},
  );

  const rejected = core.mergeTaskRun(
    current,
    {attemptId: "attempt-1", attemptNumber: 1, progressSeq: 9},
    {now: NOW},
  );
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, "attempt_mismatch");

  const noIncrement = core.mergeTaskRun(
    current,
    {attemptId: "attempt-3", attemptNumber: 2, progressSeq: 9},
    {now: NOW, allowAttemptTransition: true},
  );
  assert.equal(noIncrement.accepted, false);
  assert.equal(noIncrement.reason, "attempt_mismatch");

  const recovered = core.mergeTaskRun(
    current,
    {attemptId: "attempt-3", attemptNumber: 3, progressSeq: 9},
    {now: NOW, allowAttemptTransition: true},
  );
  assert.equal(recovered.accepted, true);
  assert.equal(recovered.run.attemptId, "attempt-3");
  assert.equal(recovered.run.attemptNumber, 3);
});

test("ledger normalization never lets an old terminal attempt overwrite a newer running attempt", () => {
  const ledger = core.normalizeTaskLedger({
    runs: [
      {
        id: "run-attempt-order",
        status: "running",
        attemptId: "attempt-2",
        attemptNumber: 2,
        updatedAt: "2026-07-16T02:00:00.000Z",
      },
      {
        id: "run-attempt-order",
        status: "failed",
        attemptId: "attempt-1",
        attemptNumber: 1,
        updatedAt: "2026-07-16T02:01:00.000Z",
        finishedAt: "2026-07-16T02:01:00.000Z",
      },
    ],
  });

  assert.equal(ledger.runs[0].attemptId, "attempt-2");
  assert.equal(ledger.runs[0].status, "running");
});

test("stale active tasks fail retryably while live tasks stay running", () => {
  const ledger = core.reconcileStaleTaskLedger(
    {
      runs: [
        {
          id: "stale-run",
          status: "running",
          createdAt: "2026-07-16T03:40:00Z",
          updatedAt: "2026-07-16T03:40:00Z",
          businessProgressAt: "2026-07-16T03:40:00Z",
        },
        {
          id: "live-run",
          status: "running",
          createdAt: "2026-07-16T03:30:00Z",
          updatedAt: "2026-07-16T03:30:00Z",
          businessProgressAt: "2026-07-16T03:30:00Z",
        },
      ],
    },
    {
      now: NOW,
      staleAfterMs: 10 * 60 * 1000,
      isTaskActive: (run) => run.id === "live-run",
    },
  );

  assert.equal(ledger.runs.find((run) => run.id === "stale-run").status, "failed");
  assert.equal(ledger.runs.find((run) => run.id === "live-run").status, "running");
  assert.match(
    ledger.runs.find((run) => run.id === "stale-run").message,
    /等待重新分配/,
  );
  assert.equal(
    ledger.runs.find((run) => run.id === "stale-run").error.code,
    "STALE_TASK_HEARTBEAT_TIMEOUT",
  );
  assert.equal(
    ledger.runs.find((run) => run.id === "stale-run").error.retryable,
    true,
  );
});

test("task center clear cutoff survives later ledger upserts", () => {
  const clearedAt = "2026-07-16T03:55:00Z";
  const result = core.upsertTaskRun(
    {version: 1, runs: [], clearedAt},
    {id: "new-run", status: "running"},
    {now: NOW},
  );

  assert.equal(result.ledger.clearedAt, "2026-07-16T03:55:00.000Z");
});

test("progress sequence never moves backwards", () => {
  const current = core.normalizeTaskRun(
    {
      id: "run-seq",
      status: "running",
      progressSeq: 20,
      progress: {current: 4, total: 10},
    },
    {now: NOW},
  );
  const result = core.mergeTaskRun(
    current,
    {progressSeq: 19, progress: {current: 3}},
    {now: NOW},
  );

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "stale_progress");
  assert.equal(result.run.progress.current, 4);
});

test("upsert returns the accepted run and normalized ledger", () => {
  const created = core.upsertTaskRun(
    null,
    {
      id: "run-upsert",
      status: "running",
      attemptId: "a1",
      progressSeq: 1,
    },
    {now: NOW},
  );
  assert.equal(created.accepted, true);
  assert.equal(created.reason, "created");
  assert.equal(created.ledger.runs.length, 1);

  const updated = core.upsertTaskRun(
    created.ledger,
    {
      id: "run-upsert",
      attemptId: "a1",
      progressSeq: 2,
      businessProgressAt: "2026-07-16T04:00:02Z",
      savedCount: 5,
    },
    {now: NOW + 2000},
  );
  assert.equal(updated.accepted, true);
  assert.equal(updated.reason, "merged");
  assert.equal(updated.run.counts.saved, 5);
  assert.equal(updated.ledger.runs[0].progressSeq, 2);
});

test("ledger prunes only terminal history by age and count", () => {
  const recentTerminal = Array.from({length: 305}, (_, index) => ({
    id: `terminal-${index}`,
    status: index % 2 ? "completed" : "failed",
    finishedAt: new Date(NOW - index * 1000).toISOString(),
  }));
  const oldTerminal = {
    id: "terminal-old",
    status: "completed",
    finishedAt: new Date(NOW - 31 * 24 * 60 * 60 * 1000).toISOString(),
  };
  const active = {
    id: "active-old",
    status: "running",
    updatedAt: oldTerminal.finishedAt,
  };
  const needsAction = {
    id: "needs-action-old",
    status: "needs_action",
    updatedAt: oldTerminal.finishedAt,
  };

  const ledger = core.normalizeTaskLedger(
    {runs: [...recentTerminal, oldTerminal, active, needsAction]},
    {now: NOW},
  );
  const ids = new Set(ledger.runs.map((run) => run.id));
  const terminalCount = ledger.runs.filter((run) =>
    core.isTerminalTaskStatus(run.status),
  ).length;

  assert.equal(terminalCount, 300);
  assert.equal(ids.has("terminal-old"), false);
  assert.equal(ids.has("active-old"), true);
  assert.equal(ids.has("needs-action-old"), true);
  assert.equal(ledger.runs.length, 302);
});

test("events are capped, length-limited, and redact credentials", () => {
  let run = core.normalizeTaskRun({id: "run-events", status: "running"}, {now: NOW});
  for (let index = 0; index < 55; index += 1) {
    run = core.appendTaskEvent(
      run,
      {
        id: `event-${index}`,
        at: new Date(NOW + index * 1000).toISOString(),
        type: "progress",
        message:
          index === 54
            ? `Bearer abc.def token=very-secret ${"x".repeat(800)}`
            : `step ${index}`,
        metadata: {
          cookie: "session=secret",
          authToken: "secret-token",
          safe: "visible",
        },
      },
      {now: NOW + index * 1000},
    );
  }

  assert.equal(run.events.length, 50);
  assert.equal(run.events[0].id, "event-5");
  const latest = run.events.at(-1);
  assert.equal(latest.message.includes("abc.def"), false);
  assert.equal(latest.message.includes("very-secret"), false);
  assert.ok(latest.message.length <= 500);
  assert.equal(latest.metadata.cookie, "[REDACTED]");
  assert.equal(latest.metadata.authToken, "[REDACTED]");
  assert.equal(latest.metadata.safe, "visible");
});

test("legacy adapter imports sync, snake/camel monitor, and latest unattended state", () => {
  const items = core.buildLegacyTaskCenterItems(
    {
      syncEntries: [
        {
          id: "sync-1",
          platform: "xiaohongshu",
          startedAt: NOW - 5000,
          finishedAt: NOW - 4000,
          totalCount: 3,
          successCount: 2,
          failedCount: 1,
          token: "must-not-be-copied",
        },
      ],
      monitorExecutions: [
        {
          execution_id: "monitor-snake",
          subscription_id: "subscription-1",
          status: "succeeded",
          platform: "douyin",
          records_found: 10,
          new_records: 2,
          started_at: "2026-07-16T03:00:00Z",
          finished_at: "2026-07-16T03:05:00Z",
        },
        {
          executionId: "monitor-camel",
          subscriptionId: "subscription-2",
          status: "failed",
          platform: "weibo",
          recordsFound: 6,
          newRecords: 0,
          startedAt: "2026-07-16T02:00:00Z",
          finishedAt: "2026-07-16T02:05:00Z",
          errorMessage: "network error",
        },
      ],
      unattendedPlan: {
        platform: "xiaohongshu",
        keywords: ["咖啡", "露营"],
        lastRunStatus: "running",
      },
      unattendedRequest: {
        id: "request-1",
        status: "running",
        heartbeatAt: "2026-07-16T03:59:00Z",
        businessProgressAt: "2026-07-16T03:55:00Z",
        progress: {current: 1, total: 2, keyword: "露营"},
      },
      dataPool: {
        records: [{id: "record-must-not-become-task"}],
      },
    },
    {now: NOW},
  );

  assert.equal(items.length, 4);
  assert.equal(items.every((item) => item.legacy && item.incomplete), true);
  const sync = items.find((item) => item.id.includes("legacy:sync:sync-1"));
  assert.equal(sync.status, "completed_with_warnings");
  assert.equal(sync.counts.success, 2);
  assert.equal(sync.counts.failed, 1);
  assert.equal(JSON.stringify(toPlain(sync)).includes("must-not-be-copied"), false);

  const snake = items.find((item) => item.id.includes("monitor-snake"));
  assert.equal(snake.status, "completed");
  assert.equal(snake.counts.processed, 10);
  assert.equal(snake.counts.saved, 2);

  const camel = items.find((item) => item.id.includes("monitor-camel"));
  assert.equal(camel.status, "failed");
  assert.equal(camel.counts.processed, 6);

  const unattended = items.find((item) => item.taskType === "unattended_keyword_capture");
  assert.equal(unattended.id.includes("request-1"), true);
  assert.equal(unattended.heartbeatAt, "2026-07-16T03:59:00.000Z");
  assert.equal(unattended.businessProgressAt, "2026-07-16T03:55:00.000Z");
  assert.equal(unattended.counts.total, 2);
  assert.equal(
    items.some((item) => item.id.includes("record-must-not-become-task")),
    false,
  );
});

test("legacy adapter accepts monitor API response containers", () => {
  const items = core.buildLegacyTaskCenterItems(
    {
      monitorExecutions: {
        executions: [
          {
            id: "remote-1",
            status: "cancelled",
            created_at: "2026-07-16T01:00:00Z",
            finished_at: "2026-07-16T01:01:00Z",
          },
        ],
      },
    },
    {now: NOW},
  );

  assert.equal(items.length, 1);
  assert.equal(items[0].status, "canceled");
  assert.equal(items[0].legacySource, "monitor_executions");
});

test("incomplete legacy running records are historical, not active tasks", () => {
  const items = core.buildLegacyTaskCenterItems(
    {
      syncEntries: [{id: "old-sync", status: "running", startedAt: NOW - 60_000}],
      monitorExecutions: [
        {
          id: "old-monitor",
          status: "running",
          startedAt: "2026-06-21T12:10:00Z",
        },
      ],
    },
    {now: NOW},
  );

  assert.equal(items.length, 2);
  assert.equal(items.every((item) => item.status === "completed_with_warnings"), true);
  assert.equal(items.every((item) => Boolean(item.finishedAt)), true);
});
