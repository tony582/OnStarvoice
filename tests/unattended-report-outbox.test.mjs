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
import {
  CONTROL_STORAGE_RESERVE_BYTES,
  CONTROL_STORAGE_RESERVE_KEY,
} from "../utils/storage.js";

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

function createSetFailureStorage({
  initial = {},
  failSetCalls = [],
  errorFactory = () => new Error("Resource::kQuotaBytes quota exceeded"),
  rejectNewOutboxKeyAt = null,
} = {}) {
  const storage = createStorage(initial);
  const baseSet = storage.set.bind(storage);
  const failedCalls = new Set(failSetCalls);
  let setCalls = 0;
  storage.set = async (patch) => {
    setCalls += 1;
    const [key] = Object.keys(patch);
    const outboxKeyCount = Object.keys(storage.data).filter((storedKey) =>
      storedKey.startsWith(UNATTENDED_CHECKPOINT_REPORT_OUTBOX_STORAGE_KEY),
    ).length;
    if (
      failedCalls.has(setCalls) ||
      (
        Number.isSafeInteger(rejectNewOutboxKeyAt) &&
        outboxKeyCount >= rejectNewOutboxKeyAt &&
        key.startsWith(UNATTENDED_CHECKPOINT_REPORT_OUTBOX_STORAGE_KEY) &&
        !Object.prototype.hasOwnProperty.call(storage.data, key)
      )
    ) {
      throw errorFactory();
    }
    await baseSet(patch);
  };
  storage.setCallCount = () => setCalls;
  return storage;
}

function storageBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function createByteQuotaStorage(initial = {}) {
  const storage = createStorage(initial);
  const baseSet = storage.set.bind(storage);
  const baseRemove = storage.remove.bind(storage);
  const removed = [];
  let quotaBytes = storageBytes(storage.data);
  storage.QUOTA_BYTES = quotaBytes;
  storage.getBytesInUse = async () => storageBytes(storage.data);
  storage.set = async (patch) => {
    const next = {...storage.data, ...structuredClone(patch)};
    if (storageBytes(next) > quotaBytes) {
      throw new Error("Resource::kQuotaBytes quota exceeded");
    }
    await baseSet(patch);
  };
  storage.remove = async (keys) => {
    removed.push(...(Array.isArray(keys) ? keys : [keys]));
    await baseRemove(keys);
  };
  storage.setQuotaBytes = (value) => {
    quotaBytes = Math.max(0, Number(value) || 0);
    storage.QUOTA_BYTES = quotaBytes;
  };
  storage.removed = removed;
  return storage;
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

test("checkpoint outbox is bounded without evicting distinct unsynced attempts", async () => {
  const storage = createStorage();
  const results = [];
  for (
    let index = 0;
    index < UNATTENDED_CHECKPOINT_REPORT_OUTBOX_MAX_ENTRIES + 3;
    index += 1
  ) {
    results.push(await enqueueUnattendedCheckpointReport(
      {
        requestId: `request-${index}`,
        attemptId: `attempt-${index}`,
        patch: checkpointPatch(index),
      },
      {storage, now: () => index + 1},
    ));
  }

  const entries = storedEntries(storage);
  assert.equal(entries.length, UNATTENDED_CHECKPOINT_REPORT_OUTBOX_MAX_ENTRIES);
  assert.equal(entries[0].requestId, "request-0");
  assert.equal(entries.at(-1).requestId, "request-19");
  assert.equal(results.slice(0, 20).every((result) => result.ok), true);
  assert.deepEqual(
    results.slice(20).map((result) => result.reason),
    ["outbox_capacity", "outbox_capacity", "outbox_capacity"],
  );
});

test("a full outbox updates the same attempt without needing a transient new key", async () => {
  const storage = createSetFailureStorage({
    rejectNewOutboxKeyAt: UNATTENDED_CHECKPOINT_REPORT_OUTBOX_MAX_ENTRIES,
  });
  for (
    let index = 0;
    index < UNATTENDED_CHECKPOINT_REPORT_OUTBOX_MAX_ENTRIES;
    index += 1
  ) {
    const queued = await enqueueUnattendedCheckpointReport(
      {
        requestId: `request-${index}`,
        attemptId: `attempt-${index}`,
        patch: checkpointPatch(index + 1),
      },
      {storage, now: () => index + 1},
    );
    assert.equal(queued.ok, true);
  }
  const keyCountBefore = Object.keys(storage.data).length;
  const updated = await enqueueUnattendedCheckpointReport(
    {
      requestId: "request-0",
      attemptId: "attempt-0",
      patch: checkpointPatch(100),
    },
    {storage, now: () => 10_000},
  );

  assert.equal(updated.ok, true);
  assert.equal(updated.reason, "queued");
  assert.equal(Object.keys(storage.data).length, keyCountBefore);
  const entries = storedEntries(storage);
  assert.equal(entries.length, UNATTENDED_CHECKPOINT_REPORT_OUTBOX_MAX_ENTRIES);
  assert.equal(
    entries.find((entry) => entry.requestId === "request-0")?.patch.progressSeq,
    100,
  );
});

test("capacity preserves active, unsynced, failed, and needs_action attempts", async () => {
  const storage = createStorage();
  const statuses = ["running", "failed", "needs_action"];
  for (
    let index = 0;
    index < UNATTENDED_CHECKPOINT_REPORT_OUTBOX_MAX_ENTRIES;
    index += 1
  ) {
    const queued = await enqueueUnattendedCheckpointReport(
      {
        requestId: `protected-request-${index}`,
        attemptId: `protected-attempt-${index}`,
        patch: checkpointPatch(index + 1, {
          status: statuses[index % statuses.length],
        }),
      },
      {storage, now: () => index + 1},
    );
    assert.equal(queued.ok, true);
  }
  const before = structuredClone(storedEntries(storage));
  const rejected = await enqueueUnattendedCheckpointReport(
    {
      requestId: "new-request",
      attemptId: "new-attempt",
      patch: checkpointPatch(1),
    },
    {
      storage,
      now: () => UNATTENDED_CHECKPOINT_REPORT_OUTBOX_MAX_ENTRIES + 1,
    },
  );

  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, "outbox_capacity");
  assert.deepEqual(storedEntries(storage), before);
});

test("preflight removes an explicitly ACKed row before admitting a new attempt", async () => {
  const storage = createStorage();
  for (
    let index = 0;
    index < UNATTENDED_CHECKPOINT_REPORT_OUTBOX_MAX_ENTRIES;
    index += 1
  ) {
    await enqueueUnattendedCheckpointReport(
      {
        requestId: `request-${index}`,
        attemptId: `attempt-${index}`,
        patch: checkpointPatch(index + 1),
      },
      {storage, now: () => index + 1},
    );
  }
  const acknowledgedKey = Object.keys(storage.data).find((key) =>
    key.startsWith(UNATTENDED_CHECKPOINT_REPORT_OUTBOX_STORAGE_KEY),
  );
  storage.data[acknowledgedKey].acknowledgedAt = new Date().toISOString();

  const queued = await enqueueUnattendedCheckpointReport(
    {
      requestId: "replacement-request",
      attemptId: "replacement-attempt",
      patch: checkpointPatch(1),
    },
    {storage, now: () => 1000},
  );

  assert.equal(queued.ok, true);
  const entries = storedEntries(storage);
  assert.equal(entries.length, UNATTENDED_CHECKPOINT_REPORT_OUTBOX_MAX_ENTRIES);
  assert.equal(
    entries.some((entry) => entry.requestId === "request-0"),
    false,
  );
  assert.equal(
    entries.some((entry) => entry.requestId === "replacement-request"),
    true,
  );
});

test("a genuinely full quota releases the reserve once and makes the second outbox write durable", async () => {
  const storage = createByteQuotaStorage({
    [CONTROL_STORAGE_RESERVE_KEY]: {
      schemaVersion: 1,
      padding: "0".repeat(CONTROL_STORAGE_RESERVE_BYTES),
    },
  });

  const queued = await enqueueUnattendedCheckpointReport(
    {
      requestId: "request-real-quota",
      attemptId: "attempt-real-quota",
      patch: checkpointPatch(1),
    },
    {storage, now: () => 1000},
  );

  assert.equal(queued.ok, true);
  assert.equal(queued.retried, true);
  assert.deepEqual(storage.removed, [CONTROL_STORAGE_RESERVE_KEY]);
  assert.equal(storage.data[CONTROL_STORAGE_RESERVE_KEY], undefined);
  assert.equal(storedEntries(storage).length, 1);
});

test("an exhausted real-quota retry propagates failure and preserves the previous unsynced row", async () => {
  const seeded = createStorage();
  await enqueueUnattendedCheckpointReport(
    {
      requestId: "request-real-quota-exhausted",
      attemptId: "attempt-real-quota-exhausted",
      patch: checkpointPatch(1, {status: "failed"}),
    },
    {storage: seeded, now: () => 1000},
  );
  const previous = structuredClone(storedEntries(seeded));
  const storage = createByteQuotaStorage({
    ...seeded.data,
    [CONTROL_STORAGE_RESERVE_KEY]: {
      schemaVersion: 1,
      padding: "0".repeat(CONTROL_STORAGE_RESERVE_BYTES),
    },
  });

  const queued = await enqueueUnattendedCheckpointReport(
    {
      requestId: "request-real-quota-exhausted",
      attemptId: "attempt-real-quota-exhausted",
      patch: checkpointPatch(2, {
        status: "failed",
        summary: {evidence: "x".repeat(CONTROL_STORAGE_RESERVE_BYTES * 2)},
      }),
    },
    {storage, now: () => 2000},
  );

  assert.equal(queued.ok, false);
  assert.equal(queued.reason, "storage_quota");
  assert.equal(queued.retried, true);
  assert.deepEqual(storage.removed, [CONTROL_STORAGE_RESERVE_KEY]);
  assert.deepEqual(storedEntries(storage), previous);
});

test("quota failure receives exactly one reserve-backed retry", async () => {
  const storage = createSetFailureStorage({failSetCalls: [1]});
  const queued = await enqueueUnattendedCheckpointReport(
    {
      requestId: "request-quota-retry",
      attemptId: "attempt-quota-retry",
      patch: checkpointPatch(1),
    },
    {storage, now: () => 1000},
  );

  assert.equal(queued.ok, true);
  assert.equal(queued.retried, true);
  assert.equal(storage.setCallCount(), 2);
  assert.equal(storedEntries(storage).length, 1);
});

test("a second quota failure stops without a third write", async () => {
  const storage = createSetFailureStorage({failSetCalls: [1, 2, 3]});
  const queued = await enqueueUnattendedCheckpointReport(
    {
      requestId: "request-quota-exhausted",
      attemptId: "attempt-quota-exhausted",
      patch: checkpointPatch(1),
    },
    {storage, now: () => 1000},
  );

  assert.equal(queued.ok, false);
  assert.equal(queued.reason, "storage_quota");
  assert.equal(queued.retried, true);
  assert.equal(storage.setCallCount(), 2);
  assert.deepEqual(storedEntries(storage), []);
});

test("exhausted quota retry preserves the previous unsynced failed checkpoint", async () => {
  const seeded = createStorage();
  await enqueueUnattendedCheckpointReport(
    {
      requestId: "request-protected-failure",
      attemptId: "attempt-protected-failure",
      patch: checkpointPatch(1, {status: "failed"}),
    },
    {storage: seeded, now: () => 1000},
  );
  const previous = structuredClone(storedEntries(seeded));
  const storage = createSetFailureStorage({
    initial: seeded.data,
    failSetCalls: [1, 2, 3],
  });

  const queued = await enqueueUnattendedCheckpointReport(
    {
      requestId: "request-protected-failure",
      attemptId: "attempt-protected-failure",
      patch: checkpointPatch(2, {status: "failed"}),
    },
    {storage, now: () => 2000},
  );

  assert.equal(queued.ok, false);
  assert.equal(queued.reason, "storage_quota");
  assert.equal(storage.setCallCount(), 2);
  assert.deepEqual(storedEntries(storage), previous);
});

test("a non-quota storage failure is never retried", async () => {
  const storage = createSetFailureStorage({
    failSetCalls: [1, 2],
    errorFactory: () => new Error("storage backend unavailable"),
  });
  const queued = await enqueueUnattendedCheckpointReport(
    {
      requestId: "request-storage-error",
      attemptId: "attempt-storage-error",
      patch: checkpointPatch(1),
    },
    {storage, now: () => 1000},
  );

  assert.equal(queued.ok, false);
  assert.equal(queued.reason, "storage_error");
  assert.equal(queued.retried, false);
  assert.equal(storage.setCallCount(), 1);
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
