import assert from "node:assert/strict";
import test from "node:test";

import {createRecordSyncQueue} from "../../utils/record-sync-queue.js";

async function waitUntil(predicate, message = "condition not reached") {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(message);
}

test("abort clears pending jobs and prevents an active dirty job from requeueing", async () => {
  const controller = new AbortController();
  const calls = [];
  let releaseActive;
  const queue = createRecordSyncQueue({
    signal: controller.signal,
    async processRecord(input) {
      calls.push(input);
      await new Promise((resolve) => {
        releaseActive = resolve;
      });
      return {ok: true};
    },
  });

  assert.equal(queue.enqueue("record-a", {revision: 1}), true);
  await waitUntil(() => typeof releaseActive === "function");
  assert.equal(queue.enqueue("record-b"), true);
  assert.equal(queue.enqueue("record-a", {revision: 2}), false);

  controller.abort();
  assert.equal(queue.getStats().pendingCount, 0);
  assert.equal(queue.getStats().canceled, true);
  assert.equal(queue.enqueue("record-c"), false);
  releaseActive();

  const stats = await queue.drain();
  assert.deepEqual(calls.map((call) => call.recordId), ["record-a"]);
  assert.equal(calls[0].signal, controller.signal);
  assert.equal(stats.processedCount, 1);
  assert.equal(stats.pendingCount, 0);
  assert.equal(stats.remainingCount, 0);
  assert.equal(stats.cancelReason, "aborted");
});

test("drain waits for the active write to settle after explicit cancellation", async () => {
  let releaseActive;
  let settled = false;
  const queue = createRecordSyncQueue({
    async processRecord() {
      await new Promise((resolve) => {
        releaseActive = resolve;
      });
      settled = true;
      return {ok: true};
    },
  });

  queue.enqueue("record-a");
  await waitUntil(() => typeof releaseActive === "function");
  queue.cancel("user_cancel_requested");
  const draining = queue.drain();
  let drainResolved = false;
  void draining.then(() => {
    drainResolved = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(drainResolved, false);

  releaseActive();
  const stats = await draining;
  assert.equal(settled, true);
  assert.equal(stats.canceled, true);
  assert.equal(stats.cancelReason, "user_cancel_requested");
});

test("a broken stop predicate fails closed before processing a write", async () => {
  let processCount = 0;
  const queue = createRecordSyncQueue({
    shouldStop() {
      throw new Error("owner state unavailable");
    },
    async processRecord() {
      processCount += 1;
      return {ok: true};
    },
  });

  assert.equal(queue.enqueue("record-a"), false);
  const stats = await queue.drain();
  assert.equal(processCount, 0);
  assert.equal(stats.canceled, true);
  assert.equal(stats.pendingCount, 0);
});

test("transient failures retry with bounded delays and settle once", async () => {
  const attempts = [];
  const phases = [];
  const queue = createRecordSyncQueue({
    retryDelaysMs: [0, 0, 0],
    shouldRetry(result) {
      return result?.reason === "network_timeout";
    },
    onStateChange(state) {
      phases.push(state.phase);
    },
    async processRecord({recordId}) {
      attempts.push(recordId);
      return attempts.length < 3
        ? {ok: false, reason: "network_timeout"}
        : {ok: true};
    },
  });

  queue.enqueue("record-a");
  const stats = await queue.drain();
  assert.deepEqual(attempts, ["record-a", "record-a", "record-a"]);
  assert.equal(stats.retryCount, 2);
  assert.equal(stats.processedCount, 1);
  assert.equal(stats.successCount, 1);
  assert.equal(stats.failedCount, 0);
  assert.equal(phases.filter((phase) => phase === "retry_wait").length, 2);
});

test("non-transient failures do not retry", async () => {
  let attemptCount = 0;
  const queue = createRecordSyncQueue({
    retryDelaysMs: [0, 0, 0],
    shouldRetry(result) {
      return result?.reason === "network_timeout";
    },
    async processRecord() {
      attemptCount += 1;
      return {ok: false, reason: "INVALID_PAYLOAD"};
    },
  });

  queue.enqueue("record-a");
  const stats = await queue.drain();
  assert.equal(attemptCount, 1);
  assert.equal(stats.retryCount, 0);
  assert.equal(stats.failedCount, 1);
});

test("cancellation interrupts a retry delay without another write", async () => {
  const controller = new AbortController();
  let attemptCount = 0;
  let retryWaitSeen = false;
  const queue = createRecordSyncQueue({
    signal: controller.signal,
    retryDelaysMs: [5000],
    shouldRetry: () => true,
    onStateChange(state) {
      if (state.phase === "retry_wait") {
        retryWaitSeen = true;
        controller.abort();
      }
    },
    async processRecord() {
      attemptCount += 1;
      return {ok: false, reason: "network_timeout"};
    },
  });

  queue.enqueue("record-a");
  const stats = await queue.drain();
  assert.equal(retryWaitSeen, true);
  assert.equal(attemptCount, 1);
  assert.equal(stats.retryCount, 0);
  assert.equal(stats.canceled, true);
  assert.equal(stats.skippedCount, 1);
  assert.equal(stats.failedCount, 0);
});
