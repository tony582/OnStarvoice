import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {runInNewContext} from "node:vm";

import {
  discardUnattendedCheckpointReports,
  enqueueUnattendedCheckpointReport,
  flushUnattendedCheckpointReportOutbox,
  UNATTENDED_CHECKPOINT_REPORT_OUTBOX_MAX_ENTRIES,
  UNATTENDED_CHECKPOINT_REPORT_OUTBOX_STORAGE_KEY,
} from "../utils/unattended-report-outbox.js";

const sidebarSource = readFileSync(
  new URL("../sidebar/sidebar-logic.js", import.meta.url),
  "utf8",
);

function sourceSection(startMarker, endMarker) {
  const start = sidebarSource.indexOf(startMarker);
  const end = sidebarSource.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing source marker: ${startMarker}`);
  assert.ok(end > start, `missing source end marker: ${endMarker}`);
  return sidebarSource.slice(start, end);
}

function createStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(key) {
      if (key === null) return structuredClone(data);
      if (Array.isArray(key)) {
        return Object.fromEntries(
          key.map((item) => [item, structuredClone(data[item])]),
        );
      }
      return {[key]: structuredClone(data[key])};
    },
    async set(patch) {
      Object.assign(data, structuredClone(patch));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete data[key];
      }
    },
  };
}

function storedEntries(storage) {
  return Object.entries(storage.data)
    .filter(([key]) =>
      key.startsWith(UNATTENDED_CHECKPOINT_REPORT_OUTBOX_STORAGE_KEY),
    )
    .map(([, value]) => structuredClone(value));
}

function checkpointPatch(index, extra = {}) {
  return {
    checkpoint: {
      round: 1,
      activeKeywordIndex: index,
      keywordResults: Array.from({length: index}, (_, itemIndex) => ({
        keyword: `keyword-${itemIndex + 1}`,
        status: "completed",
      })),
    },
    counts: {processed: index},
    progressSeq: index,
    businessProgressAt: new Date(index * 1000).toISOString(),
    ...extra,
  };
}

async function runDirectReport({response, durableCheckpoint = true} = {}) {
  const queued = [];
  let flushCount = 0;
  let discardCount = 0;
  const context = {
    console,
    activeUnattendedRunAttemptId: "attempt-A",
    async sendUnattendedRuntimeMessage() {
      return response;
    },
    stopRejectedUnattendedAttempt() {},
    async discardUnattendedCheckpointReports() {
      discardCount += 1;
      return {ok: true, removed: 0};
    },
    async enqueueUnattendedCheckpointReport(input) {
      queued.push(structuredClone(input));
      return {ok: true, reason: "queued"};
    },
    flushPendingUnattendedCheckpointReports() {
      flushCount += 1;
      return Promise.resolve({ok: true});
    },
  };
  const baseReporter = sourceSection(
    "async function reportUnattendedKeywordRun(",
    "let unattendedCheckpointOutboxFlushPromise",
  );
  runInNewContext(
    `${baseReporter}\nglobalThis.__reportUnattendedKeywordRun = reportUnattendedKeywordRun;`,
    context,
  );
  const result = await context.__reportUnattendedKeywordRun(
    "request-A",
    checkpointPatch(1),
    {attemptId: "attempt-A", durableCheckpoint, quiet: true},
  );
  return {result, queued, flushCount, discardCount};
}

test("checkpoint outbox keeps only the newest durable snapshot per attempt", async () => {
  const storage = createStorage();
  await enqueueUnattendedCheckpointReport(
    {
      requestId: "request-A",
      attemptId: "attempt-A",
      patch: checkpointPatch(1),
    },
    {storage, now: () => 1000},
  );
  await enqueueUnattendedCheckpointReport(
    {
      requestId: "request-A",
      attemptId: "attempt-A",
      patch: checkpointPatch(2),
    },
    {storage, now: () => 2000},
  );

  const entries = storedEntries(storage);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].patch.checkpoint.activeKeywordIndex, 2);
  assert.equal(entries[0].createdAt, new Date(2000).toISOString());
  assert.equal(entries[0].updatedAt, new Date(2000).toISOString());
});

test("checkpoint outbox is bounded and evicts the oldest attempts", async () => {
  const storage = createStorage();
  for (
    let index = 0;
    index < UNATTENDED_CHECKPOINT_REPORT_OUTBOX_MAX_ENTRIES + 3;
    index += 1
  ) {
    await enqueueUnattendedCheckpointReport(
      {
        requestId: `request-${index}`,
        attemptId: `attempt-${index}`,
        patch: checkpointPatch(index),
      },
      {storage, now: () => index + 1},
    );
  }

  const entries = storedEntries(storage);
  assert.equal(entries.length, UNATTENDED_CHECKPOINT_REPORT_OUTBOX_MAX_ENTRIES);
  assert.equal(entries[0].requestId, "request-3");
});

test("capacity eviction uses age across attempts instead of unrelated progress sequences", async () => {
  const storage = createStorage();
  for (
    let index = 0;
    index < UNATTENDED_CHECKPOINT_REPORT_OUTBOX_MAX_ENTRIES;
    index += 1
  ) {
    const queued = await enqueueUnattendedCheckpointReport(
      {
        requestId: `old-request-${index}`,
        attemptId: `old-attempt-${index}`,
        patch: checkpointPatch(100),
      },
      {storage, now: () => index + 1},
    );
    assert.equal(queued.ok, true);
  }
  const newest = await enqueueUnattendedCheckpointReport(
    {
      requestId: "current-request",
      attemptId: "current-attempt",
      patch: checkpointPatch(1),
    },
    {
      storage,
      now: () => UNATTENDED_CHECKPOINT_REPORT_OUTBOX_MAX_ENTRIES + 1,
    },
  );

  assert.equal(newest.ok, true);
  assert.equal(newest.reason, "queued");
  const entries = storedEntries(storage);
  assert.equal(entries.length, UNATTENDED_CHECKPOINT_REPORT_OUTBOX_MAX_ENTRIES);
  assert.equal(
    entries.some((entry) => entry.requestId === "current-request"),
    true,
  );
  assert.equal(
    entries.some((entry) => entry.requestId === "old-request-0"),
    false,
  );
  const notDurable = await enqueueUnattendedCheckpointReport(
    {
      requestId: "clock-skewed-request",
      attemptId: "clock-skewed-attempt",
      patch: checkpointPatch(1),
    },
    {storage, now: () => 0.5},
  );
  assert.equal(notDurable.ok, false);
  assert.equal(notDurable.reason, "outbox_capacity");
});

test("transport failure retains the checkpoint for a later automatic replay", async () => {
  const storage = createStorage();
  await enqueueUnattendedCheckpointReport(
    {
      requestId: "request-A",
      attemptId: "attempt-A",
      patch: checkpointPatch(1),
    },
    {storage},
  );

  const result = await flushUnattendedCheckpointReportOutbox(
    {
      async send() {
        throw new Error("service worker temporarily unavailable");
      },
    },
    {storage},
  );

  assert.equal(result.reason, "transport_error");
  assert.equal(
    storedEntries(storage).length,
    1,
  );
});

test("missing or malformed replay responses retain the durable checkpoint", async () => {
  for (const response of [undefined, null, {}]) {
    const storage = createStorage();
    await enqueueUnattendedCheckpointReport(
      {
        requestId: "request-A",
        attemptId: "attempt-A",
        patch: checkpointPatch(1),
      },
      {storage},
    );

    const result = await flushUnattendedCheckpointReportOutbox(
      {async send() { return response; }},
      {storage},
    );

    assert.equal(result.ok, false);
    assert.equal(result.reason, "no_response");
    assert.equal(result.delivered, 0);
    assert.equal(result.retained, 1);
    assert.equal(storedEntries(storage).length, 1);
  }
});

test("a direct durable report queues on no response without triggering a success flush", async () => {
  for (const response of [undefined, null, {}]) {
    const outcome = await runDirectReport({response});
    assert.equal(outcome.result.ok, true);
    assert.equal(outcome.result.accepted, true);
    assert.equal(outcome.result.reason, "queued_durable");
    assert.equal(outcome.result.data, null);
    assert.equal(outcome.result.durable, true);
    assert.equal(outcome.queued.length, 1);
    assert.equal(outcome.queued[0].requestId, "request-A");
    assert.equal(outcome.queued[0].attemptId, "attempt-A");
    assert.equal(outcome.flushCount, 0);
    assert.equal(outcome.discardCount, 0);
  }
});

test("a direct non-durable no-response remains a transport failure", async () => {
  const outcome = await runDirectReport({
    response: undefined,
    durableCheckpoint: false,
  });
  assert.equal(outcome.result.ok, false);
  assert.equal(outcome.result.accepted, false);
  assert.equal(outcome.result.reason, "transport_error");
  assert.equal(outcome.queued.length, 0);
  assert.equal(outcome.flushCount, 0);
  assert.equal(outcome.discardCount, 0);
});

test("accepted replay sends the original attempt identity and removes the row", async () => {
  const storage = createStorage();
  await enqueueUnattendedCheckpointReport(
    {
      requestId: "request-A",
      attemptId: "attempt-A",
      patch: checkpointPatch(2),
    },
    {storage},
  );
  const messages = [];
  const result = await flushUnattendedCheckpointReportOutbox(
    {
      async send(message) {
        messages.push(message);
        return {ok: true, accepted: true, reason: "updated"};
      },
    },
    {storage},
  );

  assert.equal(result.delivered, 1);
  assert.equal(messages[0].requestId, "request-A");
  assert.equal(messages[0].attemptId, "attempt-A");
  assert.equal(messages[0].patch.checkpoint.activeKeywordIndex, 2);
  assert.equal(messages[0].patch.progressSeq, 2);
  assert.equal(
    messages[0].patch.businessProgressAt,
    new Date(2000).toISOString(),
  );
  assert.deepEqual(
    storedEntries(storage),
    [],
  );
});

test("an accepted stale replay cannot delete a newer concurrently queued checkpoint", async () => {
  const storage = createStorage();
  await enqueueUnattendedCheckpointReport(
    {
      requestId: "request-A",
      attemptId: "attempt-A",
      patch: checkpointPatch(1),
    },
    {storage, now: () => 1000},
  );

  const result = await flushUnattendedCheckpointReportOutbox(
    {
      async send() {
        await enqueueUnattendedCheckpointReport(
          {
            requestId: "request-A",
            attemptId: "attempt-A",
            patch: checkpointPatch(2),
          },
          {storage, now: () => 2000},
        );
        return {ok: true, accepted: true, reason: "updated"};
      },
    },
    {storage},
  );

  assert.equal(result.delivered, 1);
  const entries = storedEntries(storage);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].patch.checkpoint.activeKeywordIndex, 2);
});

test("a replaced or terminal attempt discards stale durable reports", async () => {
  for (const reason of ["attempt_mismatch", "terminal", "not_found"]) {
    const storage = createStorage();
    await enqueueUnattendedCheckpointReport(
      {
        requestId: "request-A",
        attemptId: "attempt-A",
        patch: checkpointPatch(1),
      },
      {storage},
    );
    const result = await flushUnattendedCheckpointReportOutbox(
      {
        async send() {
          return {ok: true, accepted: false, reason};
        },
      },
      {storage},
    );
    assert.equal(result.discarded, 1, reason);
    assert.deepEqual(
      storedEntries(storage),
      [],
      reason,
    );
  }
});

test("discard is scoped to one request attempt", async () => {
  const storage = createStorage();
  for (const attemptId of ["attempt-A", "attempt-B"]) {
    await enqueueUnattendedCheckpointReport(
      {
        requestId: "request-A",
        attemptId,
        patch: checkpointPatch(1),
      },
      {storage},
    );
  }
  const result = await discardUnattendedCheckpointReports(
    {requestId: "request-A", attemptId: "attempt-A"},
    {storage},
  );
  assert.equal(result.removed, 1);
  assert.equal(
    storedEntries(storage)[0].attemptId,
    "attempt-B",
  );
});

test("invalid or oversized checkpoint payloads are never acknowledged as durable", async () => {
  const storage = createStorage();
  const missingCheckpoint = await enqueueUnattendedCheckpointReport(
    {requestId: "request-A", attemptId: "attempt-A", patch: {counts: {}}},
    {storage},
  );
  const oversized = await enqueueUnattendedCheckpointReport(
    {
      requestId: "request-A",
      attemptId: "attempt-A",
      patch: {checkpoint: {payload: "x".repeat(600 * 1024)}},
    },
    {storage},
  );
  assert.equal(missingCheckpoint.ok, false);
  assert.equal(oversized.ok, false);
  assert.deepEqual(
    storedEntries(storage),
    [],
  );
});

test("two Extension documents cannot erase a newer checkpoint while an old replay settles", async () => {
  const storage = createStorage();
  const moduleUrl = new URL(
    "../utils/unattended-report-outbox.js",
    import.meta.url,
  );
  const realmNonce = `${Date.now()}-${Math.random()}`;
  const [realmA, realmB] = await Promise.all([
    import(`${moduleUrl.href}?realm=a-${realmNonce}`),
    import(`${moduleUrl.href}?realm=b-${realmNonce}`),
  ]);
  await realmA.enqueueUnattendedCheckpointReport(
    {
      requestId: "request-cross-realm",
      attemptId: "attempt-cross-realm",
      patch: checkpointPatch(1),
    },
    {storage, now: () => 1000},
  );

  let releaseOldDelivery;
  const oldDeliveryCanFinish = new Promise((resolve) => {
    releaseOldDelivery = resolve;
  });
  let markSendStarted;
  const sendStarted = new Promise((resolve) => {
    markSendStarted = resolve;
  });
  const flushing = realmA.flushUnattendedCheckpointReportOutbox(
    {
      async send() {
        markSendStarted();
        await oldDeliveryCanFinish;
        return {ok: true, accepted: true, reason: "updated"};
      },
    },
    {storage},
  );
  await sendStarted;
  await realmB.enqueueUnattendedCheckpointReport(
    {
      requestId: "request-cross-realm",
      attemptId: "attempt-cross-realm",
      patch: checkpointPatch(2),
    },
    {storage, now: () => 2000},
  );
  releaseOldDelivery();
  await flushing;

  const entries = storedEntries(storage);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].patch.progressSeq, 2);
  assert.equal(entries[0].patch.checkpoint.activeKeywordIndex, 2);
});

test("only settled checkpoints use durable acknowledgement semantics", () => {
  const checkpointReporter = sourceSection(
    "function createUnattendedKeywordCheckpointReporter(",
    "async function runUnattendedKeywordPlanRequest(",
  );
  const initialReporter = sourceSection(
    "async function reportInitialUnattendedKeywordRun(",
    "async function sendUnattendedRuntimeMessage(",
  );
  const terminalReporter = sourceSection(
    "async function reportUnattendedTerminalRun(",
    "function startUnattendedKeywordRunHeartbeat(",
  );
  const baseReporter = sourceSection(
    "async function reportUnattendedKeywordRun(",
    "let unattendedCheckpointOutboxFlushPromise",
  );

  assert.match(checkpointReporter, /durableCheckpoint:\s*true/u);
  assert.match(
    checkpointReporter,
    /activeUnattendedProgressSeq\s*\+=\s*1[\s\S]*progressSeq:\s*checkpointProgressSeq/u,
  );
  assert.doesNotMatch(initialReporter, /durableCheckpoint/u);
  assert.doesNotMatch(terminalReporter, /durableCheckpoint/u);
  assert.match(baseReporter, /enqueueUnattendedCheckpointReport/u);
  assert.match(baseReporter, /reason:\s*"queued_durable"/u);
  assert.doesNotMatch(
    baseReporter,
    /accepted\s*&&\s*durableCheckpoint[\s\S]*discardUnattendedCheckpointReports/u,
    "an accepted direct report must not delete a newer queued checkpoint",
  );
});
