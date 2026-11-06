import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import {
  enqueueUnattendedCheckpointReport,
  flushUnattendedCheckpointReportOutbox,
  UNATTENDED_CHECKPOINT_REPORT_OUTBOX_STORAGE_KEY as PREFIX,
} from "../utils/unattended-report-outbox.js";

const background = await readFile(new URL("../background.js", import.meta.url), "utf8");
const start = background.indexOf("async function inspectUnattendedCheckpointOutboxAttempt(");
const end = background.indexOf("function resolveUnattendedClosureItemIdentities(", start);
assert.ok(start >= 0 && end > start, "the real background outbox inspector must exist");

function harness(initial = {}) {
  const data = structuredClone(initial);
  const storage = {
    async get(keys) {
      return keys === null ? structuredClone(data) : Object.fromEntries(
        (Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(data[key])]),
      );
    },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
  };
  const context = vm.createContext({chrome: {storage: {local: storage}},
    UNATTENDED_CHECKPOINT_OUTBOX_STORAGE_PREFIX: PREFIX});
  vm.runInContext(`${background.slice(start, end)}\nthis.inspect = inspectUnattendedCheckpointOutboxAttempt;`, context);
  return {data, storage,
    inspect: async (...args) => JSON.parse(JSON.stringify(await context.inspect(...args))),
    enqueue: (requestId, attemptId, progressSeq) => enqueueUnattendedCheckpointReport({
      requestId, attemptId, patch: {checkpoint: {round: 1, completedKeywords: [`keyword-${progressSeq}`]}, progressSeq},
    }, {storage}),
  };
}

test("real enqueue updates keep one stable key and remain known pending until the newest report is accepted", async () => {
  const h = harness();
  const first = await h.enqueue("request-a", "attempt-a", 1);
  const second = await h.enqueue("request-a", "attempt-a", 2);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.entry.storageKey, first.entry.storageKey, "the real writer deliberately reuses the original key");
  assert.notEqual(second.entry.revision, first.entry.revision);
  assert.deepEqual(await h.inspect("request-a", "attempt-a"), {known: true, pendingCount: 1, reason: ""});

  const before = structuredClone(h.data);
  const failed = await flushUnattendedCheckpointReportOutbox({send: async () => {throw new Error("transport unavailable");}}, {storage: h.storage});
  assert.equal(failed.retained, 1);
  assert.deepEqual(h.data, before, "neither inspection nor failed transport discards unsent data");
  assert.deepEqual(await h.inspect("request-a", "attempt-a"), {known: true, pendingCount: 1, reason: ""});

  const sent = [];
  const flushed = await flushUnattendedCheckpointReportOutbox({send: async message => {
    sent.push(message); return {ok: true, accepted: true};
  }}, {storage: h.storage});
  assert.equal(flushed.delivered, 1);
  assert.equal(flushed.retained, 0);
  assert.equal(sent[0].patch.progressSeq, 2, "only the newest cumulative checkpoint is delivered");
  assert.deepEqual(await h.inspect("request-a", "attempt-a"), {known: true, pendingCount: 0, reason: ""});
});

test("valid rewritten rows are attributed to the exact request and attempt without blocking unrelated cleanup", async () => {
  const h = harness();
  for (const [requestId, attemptId] of [["request-a", "attempt-1"], ["request-a", "attempt-2"], ["request-b", "attempt-1"]]) {
    await h.enqueue(requestId, attemptId, 1);
    await h.enqueue(requestId, attemptId, 2);
  }
  const before = structuredClone(h.data);
  assert.deepEqual(await h.inspect("request-a", "attempt-1"), {known: true, pendingCount: 1, reason: ""});
  assert.deepEqual(await h.inspect("request-a", "attempt-2"), {known: true, pendingCount: 1, reason: ""});
  assert.deepEqual(await h.inspect("request-a", "", {anyAttempt: true}), {known: true, pendingCount: 2, reason: ""});
  assert.deepEqual(await h.inspect("request-c", "attempt-1"), {known: true, pendingCount: 0, reason: ""});
  assert.deepEqual(await h.inspect("request-a", "not-this-attempt"), {known: true, pendingCount: 0, reason: ""});
  assert.deepEqual(await h.inspect("", "", {anyAttempt: true}), {known: false, pendingCount: null, reason: "outbox_request_missing"});
  assert.deepEqual(h.data, before);
});

test("only explicit acknowledgement removes a valid row from the pending count", async () => {
  for (const acknowledgement of [{acknowledged: true}, {acked: true}, {delivered: true},
    {acknowledgedAt: "2026-11-06T06:00:00Z"}, {deliveryStatus: "delivered"}]) {
    const h = harness();
    await h.enqueue("request-a", "attempt-a", 1);
    const updated = await h.enqueue("request-a", "attempt-a", 2);
    const row = h.data[updated.entry.storageKey];
    Object.assign(row, {acknowledged: false, deliveryStatus: "pending"});
    assert.equal((await h.inspect("request-a", "attempt-a")).pendingCount, 1);
    Object.assign(row, acknowledgement);
    const before = structuredClone(h.data);
    assert.deepEqual(await h.inspect("request-a", "attempt-a"), {known: true, pendingCount: 0, reason: ""});
    assert.deepEqual(h.data, before, "inspection does not erase an acknowledged record either");
  }
});

test("genuinely malformed rows stay unknown even when they appear to belong to another attempt", async () => {
  const cases = [
    ["null", () => null],
    ["array", () => []],
    ["missing request", row => ({...row, requestId: ""})],
    ["missing attempt", row => ({...row, attemptId: ""})],
    ["wrong identity", row => ({...row, id: "another-request:attempt-a"})],
    ["missing revision", row => ({...row, revision: ""})],
    ["object revision", row => ({...row, revision: {value: "revision"}})],
    ["numeric revision", row => ({...row, revision: 7})],
    ["missing patch", row => ({...row, patch: null})],
    ["array checkpoint", row => ({...row, patch: {checkpoint: []}})],
  ];
  for (const [name, corrupt] of cases) {
    const h = harness();
    const queued = await h.enqueue("request-a", "attempt-a", 1);
    h.data[queued.entry.storageKey] = corrupt(h.data[queued.entry.storageKey]);
    const before = structuredClone(h.data);
    for (const identity of [["request-a", "attempt-a"], ["unrelated", "attempt-b"]]) {
      const result = await h.inspect(...identity);
      assert.equal(result.known, false, name);
      assert.equal(result.pendingCount, null, name);
    }
    assert.deepEqual(h.data, before, name);
  }
  const h = harness();
  const queued = await h.enqueue("request-a", "attempt-a", 1);
  h.data[PREFIX] = h.data[queued.entry.storageKey];
  delete h.data[queued.entry.storageKey];
  assert.deepEqual(await h.inspect("request-a", "attempt-a"), {known: false, pendingCount: null, reason: "outbox_identity_unknown"});
});

test("storage read failure never reports an empty outbox", async () => {
  const h = harness();
  h.storage.get = async () => { throw new Error("storage unavailable"); };
  const result = await h.inspect("request-a", "attempt-a");
  assert.equal(result.known, false);
  assert.equal(result.pendingCount, null);
  assert.equal(result.reason, "outbox_read_failed");
});
