import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import test from "node:test";
import vm from "node:vm";
import * as classification from "../../utils/capture/sync-response-classification.js";
import {ERROR_REASON, RECORD_STATUS, SYNC_TYPE} from "../../utils/constants.js";

const sourceUrl = new URL("../../utils/capture-sync.js", import.meta.url);
const moduleUrl = new URL("../../utils/capture/sync-response-classification.js", import.meta.url);
const source = readFileSync(sourceUrl, "utf8");
const moduleSource = readFileSync(moduleUrl, "utf8");
const publicNames = Object.keys(classification).sort();
const privateNames = [
  "normalizeBatchFailureMessage", "normalizeSyncItemFailureMessage",
  "isRateLimitedSyncReason", "isIndeterminateSyncReason",
];

test("capture-sync requires the six classifier imports and has no duplicate implementation", () => {
  const imports = [...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]\.\/capture\/sync-response-classification\.js['"];?/g)];
  assert.equal(imports.length, 1, "classification must be an unconditional ESM dependency");
  assert.deepEqual(imports[0][1].split(",").map((name) => name.trim()).filter(Boolean).sort(), publicNames);
  for (const name of [...publicNames, ...privateNames]) {
    assert.doesNotMatch(source, new RegExp(`function\\s+${name}\\s*\\(`));
    assert.equal([...moduleSource.matchAll(new RegExp(`function\\s+${name}\\s*\\(`, "g"))].length, 1, name);
  }
  for (const name of ["RATE_LIMIT_SYNC_REASONS", "INDETERMINATE_SYNC_REASONS"]) {
    assert.doesNotMatch(source, new RegExp(`\\b${name}\\b`));
    assert.equal([...moduleSource.matchAll(new RegExp(`const\\s+${name}\\s*=`, "g"))].length, 1, name);
  }
  assert.equal([...moduleSource.matchAll(/\bimport\b/g)].length, 1);
  assert.match(moduleSource, /^import\s*\{\s*ERROR_REASON\s*\}\s*from\s*['"]\.\.\/constants\.js['"];$/m);
  assert.doesNotMatch(moduleSource, /\b(?:chrome|browser|storage|XMLHttpRequest|WebSocket|Date|performance|setTimeout|setInterval|markRecordSynced|updateRecord|shouldStop|signal)\b/);
  // The literal error matcher contains "fetch failed"; forbid calls, not that text.
  assert.doesNotMatch(moduleSource, /\bfetch\s*(?:\(|\?\.)/);
});

test("the fresh ESM dependency graph loads and classifies without browser, I/O or clock effects", () => {
  // A new process proves first evaluation, not a cached import after installing guards.
  const script = `
    import assert from 'node:assert/strict';
    for (const name of ['chrome', 'browser', 'window', 'document', 'localStorage',
      'sessionStorage', 'indexedDB', 'fetch', 'XMLHttpRequest', 'WebSocket',
      'Date', 'performance', 'crypto', 'setTimeout', 'setInterval', 'queueMicrotask']) {
      Object.defineProperty(globalThis, name, {configurable: true,
        get() {throw new Error('Unexpected external access: ' + name);}});
    }
    Math.random = () => {throw new Error('Unexpected randomness');};
    const api = await import(${JSON.stringify(moduleUrl.href)});
    assert.deepEqual(Object.keys(api).sort(), ${JSON.stringify(publicNames)});
    const batch = Object.freeze({reason: ' TIMEOUT ', error: Object.freeze({httpStatus: 429})});
    const item = Object.freeze({ok: true});
    assert.equal(api.normalizeBatchFailureReason(batch), 'timeout');
    assert.equal(api.normalizeSyncItemFailureReason(item, batch), 'timeout');
    assert.equal(api.isRateLimitedBatchResult(batch), true);
    assert.equal(api.isIndeterminateBatchResult(batch), false);
    assert.equal(api.isRateLimitedSyncItem(item, batch), false);
    assert.equal(api.isIndeterminateSyncItem(item, batch), false);
    assert.equal(batch.reason, ' TIMEOUT ');
    process.stdout.write('cold-import-pure');
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8", timeout: 15000,
  });
  assert.equal(output, "cold-import-pure");
});

function section(start, end) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `missing actual source marker: ${start}`);
  assert.equal(source.indexOf(start, from + start.length), -1, `ambiguous source marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `missing following source marker: ${end}`);
  return source.slice(from, to);
}

// Read real functions, not copied business fixtures. Network/storage/waiting are the
// only seams: chunking, retry decisions, result mapping and apply ordering stay real.
const bridgeSource = [
  section("const MAX_SYNC_RECORDS_PER_REQUEST =", "const DEFAULT_CHECK_SYNC_TYPES ="),
  section("function isSyncCancellationRequested(", "function buildCanceledSyncResult("),
  section("function extractDebugUrl(", "async function appendSingleSyncHistoryEntry("),
  section("async function syncGroupRecordsWithRetry({", "function stripCommentCollectionsForContentSync("),
  section("function buildSyncRecordResultItem(", "function extendSyncPausedMetadata("),
  section("function normalizeSyncDelayMs(", "function buildWorkflowSyncGroups("),
  section("function getSingleNoteType(", "function pickBatchDebugUrl("),
].join("\n");
const NOW = 1_788_566_400_000;
const plain = (value) => JSON.parse(JSON.stringify(value));
const record = (id, payload = {}) => ({id, platform: "xiaohongshu", type: SYNC_TYPE.KEYWORD_NOTES, payload});

function createBridge({responses = [], persist = async () => true} = {}) {
  const events = [];
  const requests = [];
  const writes = [];
  const progress = [];
  let now = NOW;
  const context = vm.createContext({
    ...classification, ERROR_REASON, RECORD_STATUS, SYNC_TYPE, TextEncoder,
    Date: {now: () => now},
    waitMs: async (delay) => {events.push(["wait", delay]); now += delay;},
    syncBatch: async (records, target, options) => {
      const index = requests.length;
      requests.push({records, target, options});
      events.push(["request", ...records.map((entry) => entry.id)]);
      assert.ok(index < responses.length, "unexpected extra network request");
      const response = responses[index];
      return typeof response === "function" ? await response({records, target, options}) : response;
    },
    markRecordSynced: async (id, debugUrl) => {
      const write = {kind: "synced", id, debugUrl};
      writes.push(write);
      events.push(["write-start", id]);
      const result = await persist(write);
      events.push(["write-done", id]);
      return result;
    },
    updateRecord: async (id, patch) => {
      const write = {kind: "failed", id, patch: plain(patch)};
      writes.push(write);
      events.push(["write-start", id]);
      const result = await persist(write);
      events.push(["write-done", id]);
      return result;
    },
  });
  vm.runInContext(`${bridgeSource}\nglobalThis.runGroup = syncGroupRecordsWithRetry;`, context, {
    filename: sourceUrl.pathname, timeout: 5000,
  });
  return {
    events, requests, writes, progress,
    run(records, options = {}) {
      return context.runGroup({
        group: {records}, requestTarget: {id: "isolated-test-target"}, totalCount: records.length,
        requestSpacingMs: 0, rateLimitRetryAttempts: 0,
        onProgress: (value) => {
          progress.push(plain(value));
          events.push(["progress", value.recordId || null, value.current]);
        },
        ...options,
      });
    },
  };
}

test("mixed ACKs commit only final success/failure and retain the unknown record pending", async () => {
  const response = {ok: true, data: {items: [
    {recordId: "a", ok: true, debugUrl: " https://example.invalid/ack/a "},
    {recordId: "b", ok: false, reason: "invalid_payload", message: "invalid"},
    {recordId: "c", ok: false, reason: "timeout"},
  ]}};
  const harness = createBridge({responses: [response]});
  const result = await harness.run([record("a"), record("b"), record("c")], {completedOffset: 4, totalCount: 7});
  assert.deepEqual(plain(result).map(({recordId, success, reason}) => ({recordId, success, reason})), [
    {recordId: "a", success: true, reason: ERROR_REASON.NONE},
    {recordId: "b", success: false, reason: "invalid_payload"},
  ]);
  assert.deepEqual(harness.writes, [
    {kind: "synced", id: "a", debugUrl: "https://example.invalid/ack/a"},
    {kind: "failed", id: "b", patch: {status: RECORD_STATUS.FAILED, lastSyncedAt: NOW,
      lastSyncReason: "invalid_payload", lastSyncDebugUrl: null}},
  ]);
  assert.deepEqual(plain(result.syncPaused.pausedRecordIds), ["c"]);
  assert.equal(result.syncPaused.reason, "timeout");
  assert.equal(result.syncPaused.blocking, true);
  assert.equal(result.syncDiagnostics.requestCount, 1);
  assert.equal(result.syncDiagnostics.pausedCount, 1);
  assert.equal(Object.prototype.propertyIsEnumerable.call(result, "syncDiagnostics"), false);
  assert.equal(Object.prototype.propertyIsEnumerable.call(result, "syncPaused"), false);
  assert.deepEqual(harness.progress.filter((event) => event.recordId).map(({recordId, current}) => [recordId, current]), [["a", 5], ["b", 6]]);
  for (const id of ["a", "b"]) {
    assert.ok(harness.events.findIndex((event) => event[0] === "write-done" && event[1] === id)
      < harness.events.findIndex((event) => event[0] === "progress" && event[1] === id));
  }
});

test("batch success never substitutes for a missing, malformed or differently identified item ACK", async () => {
  for (const items of [undefined, null, {}, [], [{recordId: "elsewhere", ok: true}],
    [{recordId: 7, ok: true}], [{recordId: " 7 ", ok: true}], [null, "legacy", {ok: true}]]) {
    const harness = createBridge({responses: [{ok: true, data: {items}}]});
    const result = await harness.run([record("7")]);
    assert.equal(result.length, 1, JSON.stringify(items));
    assert.equal(result[0].success, false);
    assert.equal(result[0].reason, "SYNC_ERROR");
    assert.equal(harness.writes.length, 1);
    assert.equal(harness.writes[0].id, "7");
    assert.equal(harness.writes[0].kind, "failed");
    assert.equal(result.syncPaused, undefined);
  }
});

test("exact-ID item mapping preserves mixed missing receipts and last duplicate wins", async () => {
  const harness = createBridge({responses: [{ok: true, data: {items: [
    {recordId: "a", ok: false, reason: "earlier"}, {recordId: "a", ok: true},
    {recordId: "unrequested", ok: true},
  ]}}]});
  const result = await harness.run([record("a"), record("b")]);
  assert.deepEqual(plain(result).map(({recordId, success}) => [recordId, success]), [["a", true], ["b", false]]);
  assert.deepEqual(harness.writes.map(({id, kind}) => [id, kind]), [["a", "synced"], ["b", "failed"]]);
});

test("top-level rate limit pauses the whole remaining queue even when its items claim success", async () => {
  const records = Array.from({length: 6}, (_, index) => record(String(index)));
  const response = {ok: false, reason: "timeout", error: {httpStatus: 429}, data: {
    items: records.slice(0, 5).map(({id}) => ({recordId: id, ok: true})),
  }};
  const harness = createBridge({responses: [response]});
  const result = await harness.run(records);
  assert.equal(result.length, 0);
  assert.deepEqual(harness.writes, []);
  assert.equal(harness.requests.length, 1);
  assert.deepEqual(plain(result.syncDiagnostics.initialChunkSizes), [5, 1]);
  assert.equal(result.syncPaused.reason, "rate_limited");
  assert.equal(result.syncPaused.blocking, true);
  assert.deepEqual(plain(result.syncPaused.pausedRecordIds), records.map(({id}) => id));
  assert.equal(result.syncDiagnostics.rateLimitRetryCount, 0);
});

test("all item rate limits retry with real retry accounting before the successful ACK is committed", async () => {
  const harness = createBridge({responses: [
    {ok: true, data: {retryAfterMs: 12, items: [{recordId: "a", ok: false, reason: "rate_limited"}]}},
    {ok: true, data: {items: [{recordId: "a", ok: true}]}},
  ]});
  const result = await harness.run([record("a")], {rateLimitRetryAttempts: 1});
  assert.equal(result.length, 1);
  assert.equal(result[0].success, true);
  assert.equal(result.syncDiagnostics.requestCount, 2);
  assert.equal(result.syncDiagnostics.rateLimitRetryCount, 1);
  assert.deepEqual(plain(result.syncDiagnostics.rateLimitRetryDelaysMs), [12]);
  assert.deepEqual(harness.events.filter(([kind]) => kind === "wait"), [["wait", 12]]);
  assert.deepEqual(harness.writes.map(({id, kind}) => [id, kind]), [["a", "synced"]]);
});

test("unknown batch responses retain pending data, while one isolated heavy record permits later work", async () => {
  const unknown = {ok: false, reason: "network_error", message: "fetch failed", data: null};
  const blocking = createBridge({responses: [unknown]});
  const blocked = await blocking.run([record("a"), record("b")]);
  assert.equal(blocked.length, 0);
  assert.deepEqual(blocking.writes, []);
  assert.equal(blocked.syncPaused.blocking, true);
  assert.deepEqual(plain(blocked.syncPaused.pausedRecordIds), ["a", "b"]);

  const isolated = createBridge({responses: [unknown, {ok: true, data: {items: [{recordId: "b", ok: true}]}}]});
  const continued = await isolated.run([record("heavy", {comments: [{text: "comment"}]}), record("b")]);
  assert.deepEqual(plain(continued.syncDiagnostics.initialChunkSizes), [1, 1]);
  assert.deepEqual(isolated.writes.map(({id}) => id), ["b"]);
  assert.equal(continued.syncPaused.blocking, false);
  assert.deepEqual(plain(continued.syncPaused.pausedRecordIds), ["heavy"]);
  assert.equal(continued.syncDiagnostics.pausedCount, 1);
});

test("explicit cancellation prevents final commits before request, during request, and during retry wait", async () => {
  for (const options of [{signal: {aborted: true}}, {shouldStop: () => true},
    {shouldStop: () => {throw new Error("cancel predicate unavailable");}}]) {
    const harness = createBridge();
    const result = await harness.run([record("a")], options);
    assert.equal(result.syncCanceled, true);
    assert.equal(result.syncDiagnostics.requestCount, 0);
    assert.equal(harness.requests.length, 0);
    assert.deepEqual(harness.writes, []);
  }
  const signal = {aborted: false};
  const shouldStop = () => false;
  const inFlight = createBridge({responses: [({options}) => {
    assert.equal(options.signal, signal);
    assert.equal(options.shouldStop, shouldStop);
    return {canceled: true, ok: true, data: {items: [{recordId: "a", ok: true}]}};
  }]});
  const canceled = await inFlight.run([record("a")], {signal, shouldStop});
  assert.equal(canceled.length, 0);
  assert.equal(canceled.syncCanceled, true);
  assert.deepEqual(inFlight.writes, []);

  let stop = false;
  const retrying = createBridge({responses: [() => {
    stop = true;
    return {ok: false, reason: "rate_limited"};
  }]});
  const retryCanceled = await retrying.run([record("a")], {shouldStop: () => stop, rateLimitRetryAttempts: 1});
  assert.equal(retryCanceled.syncCanceled, true);
  assert.equal(retrying.requests.length, 1);
  assert.deepEqual(retrying.writes, []);
  assert.deepEqual(retrying.events.filter(([kind]) => kind === "wait"), []);
});

test("a rejected data-pool write rejects the group before advancing that record or committing later records", async () => {
  let enterWrite;
  const enteredWrite = new Promise((resolve) => {enterWrite = resolve;});
  let rejectWrite;
  const pendingWrite = new Promise((resolve, reject) => {rejectWrite = reject;});
  const diskError = new Error("isolated data-pool write failed");
  const harness = createBridge({
    responses: [{ok: true, data: {items: ["a", "b", "c"].map((recordId) => ({recordId, ok: true}))}}],
    persist: async ({id}) => {
      if (id === "b") {enterWrite(); return await pendingWrite;}
      return true;
    },
  });
  let resolvedResult;
  const running = harness.run([record("a"), record("b"), record("c")]).then((value) => {
    resolvedResult = value;
    return value;
  });
  await enteredWrite;
  assert.equal(resolvedResult, undefined, "no completed group/statistics before persistence");
  assert.deepEqual(harness.progress.filter(({recordId}) => recordId).map(({recordId, current}) => [recordId, current]), [["a", 1]]);
  assert.deepEqual(harness.writes.map(({id}) => id), ["a", "b"]);
  rejectWrite(diskError);
  await assert.rejects(running, (error) => error === diskError);
  assert.equal(resolvedResult, undefined);
  assert.deepEqual(harness.events.filter(([kind]) => kind === "write-done"), [["write-done", "a"]]);
  assert.deepEqual(harness.progress.filter(({recordId}) => recordId).map(({recordId}) => recordId), ["a"]);
  assert.deepEqual(harness.writes.map(({id}) => id), ["a", "b"]);
});
