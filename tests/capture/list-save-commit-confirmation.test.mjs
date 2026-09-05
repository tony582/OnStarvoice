import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import vm from "node:vm";
import {SYNC_TYPE} from "../../utils/constants.js";
import {detectPlatformFromUrl, extractNoteId, parseInteractionCount} from "../../utils/helpers.js";

const POOL_KEY = "onstarvoice.data_pool";
const source = readFileSync(new URL("../../utils/capture-sync.js", import.meta.url), "utf8");
const copy = (value) => structuredClone(value);
const plain = (value) => JSON.parse(JSON.stringify(value));

function sampleItem(run = 1, likes = 10) {
  return {
    noteId: "commit-note-1", url: "https://www.xiaohongshu.com/explore/commit-note-1",
    title: "durable list save", author: "test author", likes,
    captureTrace: {version: 1, runId: `list-run-${run}`, sequence: 1,
      identityKey: "id:commit-note-1", state: "discovered"},
  };
}

async function createCaptureHarness(t) {
  const values = new Map();
  const poolWrites = [];
  const messages = [];
  const progress = [];
  const checkpoints = [];
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  let captureApi;
  let captureRun = 0;
  let networkCalls = 0;
  const controls = {rejectPoolWrite: () => false, checkpoint: false, likes: 10};
  const tab = {id: 41, active: true, status: "complete",
    url: "https://www.xiaohongshu.com/search_result?keyword=test"};
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error("Unexpected network access in isolated save test");
  };
  globalThis.chrome = {
    storage: {local: {
      QUOTA_BYTES: 10 * 1024 * 1024,
      async get(keys) {
        if (keys == null) return copy(Object.fromEntries(values));
        if (typeof keys === "string") return values.has(keys) ? {[keys]: copy(values.get(keys))} : {};
        if (Array.isArray(keys)) return copy(Object.fromEntries(keys.filter((key) => values.has(key)).map((key) => [key, values.get(key)])));
        const result = copy(keys || {});
        for (const key of Object.keys(result)) if (values.has(key)) result[key] = copy(values.get(key));
        return result;
      },
      async set(patch) {
        if (Object.hasOwn(patch, POOL_KEY)) {
          poolWrites.push(copy(patch[POOL_KEY]));
          const rejection = controls.rejectPoolWrite(poolWrites.length);
          if (rejection) throw new Error(rejection);
        }
        for (const [key, value] of Object.entries(patch)) values.set(key, copy(value));
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key);
      },
    }},
    runtime: {
      getURL: (path) => `chrome-extension://isolated-test/${path}`,
      async sendMessage(message) {
        messages.push(copy(message));
        if (message?.type !== "onstarvoice:relay-to-content") return {ok: true, data: null};
        if (message?.payload?.action === "updateListCaptureTraceBindings") return {ok: true, data: {ok: true}};
        assert.ok(["captureKeywordNotes", "captureBloggerNotes"].includes(message?.payload?.action));
        const type = message.payload.action === "captureBloggerNotes" ? "blogger_notes" : "keyword_notes";
        captureRun += 1;
        const payload = {keyword: "test", totalCount: 1, filteredCount: 1,
          items: [sampleItem(captureRun, controls.likes)]};
        if (controls.checkpoint) {
          const checkpointStats = await captureApi.processListCaptureCheckpointProgress({
            detectedCount: 1, filteredCount: 1,
            listCheckpoint: {type, platform: "xiaohongshu", payload},
          });
          checkpoints.push(copy(checkpointStats));
        }
        return {ok: true, data: {ok: true, type, platform: "xiaohongshu", data: payload}};
      },
    },
    tabs: {query: async () => [tab], get: async (id) => {assert.equal(id, tab.id); return tab;}},
  };
  t.after(() => {
    globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
  });
  captureApi = await import("../../utils/capture-sync.js");
  const storageApi = await import("../../utils/storage.js");
  return {
    controls, values, poolWrites, messages, progress, checkpoints, storageApi,
    get networkCalls() {return networkCalls;},
    run(options = {}) {
      return captureApi.captureAndSync({mode: "keyword", autoSync: false,
        captureParams: {keyword: "test"}, onProgress: (event) => progress.push(copy(event)), ...options});
    },
  };
}

function assertNoSavedPublication(harness, result) {
  assert.equal(result.ok, false);
  assert.equal(result.phase, "error");
  assert.deepEqual(result.recordIds, []);
  assert.deepEqual(result.traceBindings, []);
  assert.equal(result.captureCacheStats.savedCount, 0);
  assert.equal(result.captureCacheStats.skippedCount, 0);
  assert.deepEqual(result.captureCacheStats.savedRecordIds, []);
  assert.deepEqual(result.captureCacheStats.traceBindings, []);
  assert.equal(harness.progress.some(({phase}) => ["saved", "sync_check", "sync_start", "synced"].includes(phase)), false);
  assert.equal(harness.messages.some(({payload}) => payload?.action === "updateListCaptureTraceBindings"), false);
  assert.equal(harness.networkCalls, 0);
}

test("real list finalization rejects ordinary and quota write failures without publishing saved state", async (t) => {
  for (const failure of ["injected storage write failure", "Resource::kQuotaBytes quota exceeded"]) {
    await t.test(failure, async (t) => {
      const harness = await createCaptureHarness(t);
      const before = await harness.storageApi.getDataPool();
      harness.controls.rejectPoolWrite = () => failure;
      const result = await harness.run({autoSync: true});
      assertNoSavedPublication(harness, result);
      assert.deepEqual(await harness.storageApi.getDataPool(), before);
      assert.equal(harness.poolWrites.length, 1);
      assert.equal(harness.values.has(POOL_KEY), false);
    });
  }
});

test("a failed checkpoint can be saved by finalization in the same session without poisoned dedupe or double counting", async (t) => {
  const harness = await createCaptureHarness(t);
  harness.controls.checkpoint = true;
  harness.controls.rejectPoolWrite = (attempt) => attempt === 1 && "injected first checkpoint failure";
  const result = await harness.run({mode: "blogger_notes"});
  assert.equal(result.ok, true);
  assert.equal(harness.poolWrites.length, 2, "finalization must really retry persistence");
  assert.equal(harness.checkpoints.length, 1);
  assert.equal(harness.checkpoints[0].savedCount, 0);
  assert.deepEqual(harness.checkpoints[0].savedRecordIds, []);
  assert.deepEqual(harness.checkpoints[0].traceBindings, []);
  // Observation counters remain observations even when that checkpoint cannot persist.
  assert.equal(harness.checkpoints[0].checkpointCount, 1);
  assert.equal(harness.checkpoints[0].detectedCount, 1);
  const pool = await harness.storageApi.getDataPool();
  assert.equal(pool.records.length, 1);
  assert.deepEqual(result.recordIds, [pool.records[0].id]);
  assert.equal(result.captureCacheStats.savedCount, 1);
  assert.equal(result.captureCacheStats.skippedCount, 0);
  assert.equal(result.traceBindings.length, 1);
  assert.equal(result.traceBindings[0].state, "saved");
  assert.equal(pool.records[0].payload.captureTrace.recordId, pool.records[0].id);
});

test("a failed refresh checkpoint preserves stored metrics and trace until the same-session final retry commits", async (t) => {
  const harness = await createCaptureHarness(t);
  const seeded = await harness.run({mode: "blogger_notes"});
  assert.equal(seeded.ok, true);
  const original = await harness.storageApi.getDataPool();
  const firstWriteAfterSeed = harness.poolWrites.length + 1;
  let atFailedWrite;
  harness.controls.checkpoint = true;
  harness.controls.likes = 25;
  harness.controls.rejectPoolWrite = (attempt) => {
    if (attempt !== firstWriteAfterSeed) return false;
    atFailedWrite = copy(harness.values.get(POOL_KEY));
    return "injected refresh checkpoint failure";
  };
  const refreshed = await harness.run({mode: "blogger_notes"});
  assert.equal(refreshed.ok, true);
  assert.equal(harness.poolWrites.length, firstWriteAfterSeed + 1);
  assert.equal(atFailedWrite.records[0].normalizedPayload.items[0].likes, 10);
  assert.equal(harness.checkpoints[0].savedCount, 0);
  assert.equal(harness.checkpoints[0].skippedCount, 0);
  assert.deepEqual(harness.checkpoints[0].savedRecordIds, []);
  assert.deepEqual(harness.checkpoints[0].traceBindings, []);
  const pool = await harness.storageApi.getDataPool();
  assert.equal(pool.records.length, 1);
  assert.equal(pool.records[0].id, original.records[0].id);
  assert.equal(pool.records[0].payload.items[0].likes, 25);
  assert.equal(pool.records[0].payload.captureTrace.runId, "list-run-2");
  assert.deepEqual(refreshed.recordIds, seeded.recordIds);
  assert.equal(refreshed.captureCacheStats.savedCount, 0, "refresh is not a new record");
  assert.equal(refreshed.captureCacheStats.skippedCount, 1);
});

test("persistent checkpoint and final-save failure cannot escape as an empty successful capture", async (t) => {
  const harness = await createCaptureHarness(t);
  harness.controls.checkpoint = true;
  harness.controls.rejectPoolWrite = () => "Resource::kQuotaBytes quota exceeded";
  const result = await harness.run({autoSync: true, mode: "blogger_notes"});
  assertNoSavedPublication(harness, result);
  assert.equal(harness.poolWrites.length, 2);
  assert.equal((await harness.storageApi.getDataPool()).records.length, 0);
});

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `actual source section unavailable: ${start}`);
  return source.slice(from, to).replace(/^export /gm, "");
}

const saveBridgeSource = [
  section("const LIST_CAPTURE_RECORD_TYPES =", "function applySyncPreferencesToPayload("),
  section("function normalizeCaptureTraceSequence(", "function buildCaptureTraceEventFields("),
  section("function createListCaptureCheckpointSession(", "async function saveCaptureResultRecords("),
].join("\n");

function createSaveBridge({initial = [], persist = async () => true} = {}) {
  let pool = {records: copy(initial)};
  const writes = [];
  const context = vm.createContext({
    SYNC_TYPE, URL, detectPlatformFromUrl, extractNoteId, parseInteractionCount,
    runDataPoolMutation: async (mutation) => await mutation(),
    getDataPool: async () => copy(pool),
    setDataPool: async (candidate) => {
      writes.push(copy(candidate));
      const saved = await persist(candidate);
      if (saved) pool = copy(candidate);
      return saved;
    },
  });
  vm.runInContext(`${saveBridgeSource}\nglobalThis.save = saveRecordsWithCacheDedupe;
    globalThis.session = createListCaptureCheckpointSession({mode: 'keyword_notes'});`, context, {timeout: 5000});
  return {session: context.session, writes, get pool() {return copy(pool);},
    save(records, session = context.session) {return context.save(records, {session});}};
}

function preparedRecord(id = "new-record", likes = 10) {
  return {id, type: SYNC_TYPE.KEYWORD_NOTES, platform: "xiaohongshu",
    payload: {keyword: "test", items: [sampleItem(1, likes)]}};
}

function committedSession(session) {
  return {keys: [...session.knownKeys], stats: plain(session.stats),
    savedRecordIds: [...session.savedRecordIds], skippedRecordIds: [...session.skippedRecordIds],
    savedRecords: plain(session.savedRecords), traceBindings: plain(session.traceBindings)};
}

test("session keys and committed counters remain unchanged while persistence is pending or returns false/throws", async (t) => {
  for (const failure of ["false", "throw"]) {
    await t.test(failure, async () => {
      let entered;
      const started = new Promise((resolve) => {entered = resolve;});
      let release;
      const pending = new Promise((resolve) => {release = resolve;});
      let attempt = 0;
      const harness = createSaveBridge({persist: async () => {
        attempt += 1;
        if (attempt > 1) return true;
        entered();
        await pending;
        if (failure === "throw") throw new Error("injected direct persistence exception");
        return false;
      }});
      const before = committedSession(harness.session);
      const record = preparedRecord();
      const saving = harness.save([record]);
      await started;
      const pendingState = committedSession(harness.session);
      release();
      await assert.rejects(saving, /缓存写入失败|direct persistence exception/);
      assert.deepEqual(pendingState, before, "no keys or counts published before durable confirmation");
      assert.deepEqual(committedSession(harness.session), before);
      assert.deepEqual(harness.pool.records, []);
      const retried = await harness.save([record]);
      assert.equal(retried.savedRecords.length, 1);
      assert.equal(harness.writes.length, 2);
      assert.equal(harness.pool.records.length, 1);
      assert.equal(harness.session.stats.savedCount, 1);
      assert.equal(harness.session.knownKeys.size, 2);
      assert.deepEqual([...harness.session.savedRecordIds], [record.id]);
    });
  }
});

test("staged session dedupe keeps same-batch duplicates suppressed and preserves no-session behavior", async () => {
  const first = preparedRecord("first");
  const duplicate = preparedRecord("duplicate");
  const withSession = createSaveBridge();
  const result = await withSession.save([first, duplicate]);
  assert.equal(result.savedRecords.length, 1);
  assert.equal(result.skippedCount, 0);
  assert.equal(withSession.pool.records.length, 1);
  assert.equal(withSession.session.stats.savedCount, 1);
  assert.equal(withSession.session.knownKeys.size, 2);
  await withSession.save([duplicate]);
  assert.equal(withSession.writes.length, 1, "already committed session keys prevent another write");
  assert.equal(withSession.session.stats.savedCount, 1);

  const withoutSession = createSaveBridge();
  const legacy = await withoutSession.save([first, duplicate], null);
  assert.equal(legacy.savedRecords.length, 1);
  assert.equal(legacy.skippedCount, 1, "without session the duplicate still takes the existing-record path");
  assert.equal(withoutSession.pool.records.length, 1);
  assert.equal(withoutSession.writes.length, 1);
});

test("an unchanged already-persisted record publishes skipped keys without requiring a write", async () => {
  const seed = createSaveBridge();
  await seed.save([preparedRecord("existing")]);
  const harness = createSaveBridge({initial: seed.pool.records, persist: async () => {
    assert.fail("unchanged existing record must not require persistence");
  }});
  const result = await harness.save([preparedRecord("incoming")]);
  assert.equal(harness.writes.length, 0);
  assert.equal(result.savedRecords.length, 0);
  assert.equal(result.skippedCount, 1);
  assert.deepEqual([...result.skippedRecordIds], ["existing"]);
  assert.equal(harness.session.knownKeys.size, 2);
  assert.equal(harness.session.stats.savedCount, 0);
  assert.equal(harness.session.stats.skippedCount, 1);
  assert.deepEqual([...harness.session.skippedRecordIds], ["existing"]);
  assert.equal(harness.session.traceBindings[0].recordId, "existing");
});

test("a later failed save preserves all prior committed session evidence without publishing the new record", async () => {
  let allowWrite = true;
  const harness = createSaveBridge({persist: async () => allowWrite});
  await harness.save([preparedRecord("committed")]);
  const beforeSession = committedSession(harness.session);
  const beforePool = harness.pool;
  allowWrite = false;
  const next = preparedRecord("not-committed");
  Object.assign(next.payload.items[0], {
    noteId: "commit-note-2", url: "https://www.xiaohongshu.com/explore/commit-note-2",
    captureTrace: {...sampleItem().captureTrace, sequence: 2, identityKey: "id:commit-note-2"},
  });
  await assert.rejects(harness.save([next]), /缓存写入失败/);
  assert.deepEqual(committedSession(harness.session), beforeSession);
  assert.deepEqual(harness.pool, beforePool);
  assert.equal(harness.writes.length, 2);
});
