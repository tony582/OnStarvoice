import assert from "node:assert/strict";
import test from "node:test";
import {syncRecord, syncRecordBatch} from "../../utils/capture-sync.js";
import {getDataPool, getSyncHistory} from "../../utils/storage.js";

// These tests expose CURRENT RUNTIME DEFECTS in this isolated candidate's source.
// They do not establish a production incident. The separate confirmation prototype
// is not wired here and does not fix them. A future authorized integration must
// deliberately replace these legacy expectations with the confirmed contract.
const POOL_KEY = "onstarvoice.data_pool";
const clone = (value) => structuredClone(value);

function contentRecord(id, type = "blogger_profile") {
  return {id, type, platform: "xiaohongshu", status: "draft", payload: {
    keyword: id, profileUrl: "https://www.xiaohongshu.com/user/profile/isolated-test",
    items: [{noteId: id, url: `https://www.xiaohongshu.com/explore/${id}`, title: "isolated fixture"}],
  }};
}

function leadsRecord() {
  return {id: "lead-record", type: "single_note", platform: "xiaohongshu", status: "draft", payload: {
    url: "https://www.xiaohongshu.com/explore/isolated-lead", title: "isolated lead",
    commentLeadsItems: [{content: "price please", userName: "test", userId: "fake-user", matchedKeywords: ["price"]}],
    commentLeadsTotal: 1,
  }};
}

function createHarness(t, {records, targetId = "b", deleteAt = "", throwAt = "", rejectLeads = false} = {}) {
  const store = new Map([
    [POOL_KEY, {records: clone(records)}],
    ["onstarvoice.auth", {code: "LAB-FAKE-CODE"}],
    ["onstarvoice.runtime", {clientUuid: "isolated-node-test", clientLabel: "Node", appVersion: "test"}],
  ]);
  const requests = [];
  const writes = [];
  const progress = [];
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  let didThrow = false;
  globalThis.chrome = {
    storage: {local: {
      async get(key) {
        if (key === null) return clone(Object.fromEntries(store));
        if (typeof key === "string") return {[key]: clone(store.get(key))};
        const keys = Array.isArray(key) ? key : Object.keys(key || {});
        return Object.fromEntries(keys.map((entry) => [entry, clone(store.get(entry))]));
      },
      async set(patch) {
        if (patch[POOL_KEY]) {
          writes.push(clone(patch[POOL_KEY]));
          const target = patch[POOL_KEY].records.find(({id}) => id === targetId);
          const targetedCommit = throwAt === "content"
            ? target?.status === "synced"
            : throwAt === "comment_leads" && target?.normalizedPayload?.commentLeadsSyncStatus === "done";
          if (targetedCommit && !didThrow) {
            didThrow = true;
            throw new Error("injected local confirmation write rejection");
          }
        }
        for (const [key, value] of Object.entries(patch)) store.set(key, clone(value));
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
      },
    }},
    runtime: {sendMessage: async () => ({ok: true})},
  };
  globalThis.fetch = async (url, options) => {
    assert.ok(["/api/sync", "/api/sync/batch"].includes(new URL(url).pathname));
    const body = JSON.parse(options.body);
    const stage = body.syncType === "comment_leads" ? "comment_leads" : "content";
    const ids = body.records?.map(({recordId}) => recordId) || [records[0].id];
    requests.push({stage, ids, body});
    // Actual storage.updateRecord returns false only when the record is absent.
    // Resolving Chrome storage.set with false would NOT model this condition.
    if (deleteAt === stage && ids.includes(targetId)) {
      const pool = clone(store.get(POOL_KEY));
      pool.records = pool.records.filter(({id}) => id !== targetId);
      store.set(POOL_KEY, pool);
    }
    const response = rejectLeads && stage === "comment_leads"
      ? {ok: false, reason: "invalid_request", message: "injected remote leads rejection",
        data: {debugUrl: "https://example.invalid/leads-failed"}}
      : {ok: true, data: {debugUrl: `https://example.invalid/${stage}`,
        items: ids.map((recordId) => ({recordId, ok: true}))}};
    return new Response(JSON.stringify(response), {status: 200});
  };
  t.after(() => {globalThis.chrome = previousChrome; globalThis.fetch = previousFetch;});
  return {requests, writes, progress,
    single: () => syncRecord(records[0].id, (event) => progress.push(clone(event)), {captureSettings: {}}),
    batch: () => syncRecordBatch(records.map(({id}) => id), (event) => progress.push(clone(event)), {
      captureSettings: {}, requestSpacingMs: 0, rateLimitRetryAttempts: 0,
    }),
  };
}

test("current success paths still confirm normal content, batch and stored-leads records", async (t) => {
  for (const kind of ["single", "batch", "leads"]) {
    await t.test(kind, async (t) => {
      const records = kind === "leads" ? [leadsRecord()]
        : kind === "batch" ? [contentRecord("a", "keyword_notes"), contentRecord("b", "keyword_notes")]
          : [contentRecord("b")];
      const harness = createHarness(t, {records});
      const result = kind === "batch" ? await harness.batch() : await harness.single();
      assert.equal(result.ok, true);
      assert.equal((await getDataPool()).records.every(({status}) => status === "synced"), true);
      assert.equal((await getSyncHistory()).entries.every(({failedCount}) => failedCount === 0), true);
      if (kind === "batch") assert.equal(result.successCount, 2);
      if (kind === "leads") {
        assert.equal(result.commentLeads.ok, true);
        assert.deepEqual(harness.requests.map(({stage}) => stage), ["content", "comment_leads"]);
        assert.equal((await getDataPool()).records[0].payload.commentLeadsSyncStatus, "done");
      }
    });
  }
});

test("legacy defect: single remote ACK plus missing local record still reports synced", async (t) => {
  const harness = createHarness(t, {records: [contentRecord("b")], deleteAt: "content"});
  const result = await harness.single();
  assert.equal(result.ok, true, "current defect, not the proposed confirmation contract");
  assert.equal(result.rawResponse.ok, true);
  assert.deepEqual((await getDataPool()).records, []);
  assert.equal(harness.progress.some(({phase}) => phase === "synced"), true);
  assert.equal((await getSyncHistory()).entries[0].successCount, 1);
  assert.equal(harness.requests.length, 1);
});

test("legacy defect: a rejected single local commit erases the remote ACK in generic failure handling", async (t) => {
  const harness = createHarness(t, {records: [contentRecord("b")], throwAt: "content"});
  const result = await harness.single();
  assert.equal(result.ok, false);
  assert.equal(result.reason, "SYNC_ERROR");
  assert.equal(result.rawResponse, null);
  assert.equal(result.debugUrl, null);
  assert.equal((await getDataPool()).records[0].status, "failed");
  assert.equal(harness.progress.some(({phase}) => phase === "synced"), false);
  assert.equal(harness.requests.length, 1);
});

test("legacy defect: batch false counts the missing record and continues, while throw loses the structured partial result", async (t) => {
  for (const failure of ["false", "throw"]) {
    await t.test(failure, async (t) => {
      const records = ["a", "b", "c"].map((id) => contentRecord(id, "keyword_notes"));
      const harness = createHarness(t, {records,
        ...(failure === "false" ? {deleteAt: "content"} : {throwAt: "content"})});
      if (failure === "false") {
        const result = await harness.batch();
        assert.equal(result.ok, true);
        assert.equal(result.successCount, 3);
        assert.deepEqual(result.results.map(({recordId, success}) => [recordId, success]), [["a", true], ["b", true], ["c", true]]);
        assert.deepEqual(harness.requests.map(({ids}) => ids), [["a"], ["b"], ["c"]]);
        assert.deepEqual((await getDataPool()).records.map(({id}) => id), ["a", "c"]);
      } else {
        await assert.rejects(harness.batch(), /本地缓存更新失败/);
        assert.deepEqual(harness.requests.map(({ids}) => ids), [["a"], ["b"]]);
        assert.deepEqual((await getDataPool()).records.map(({id, status}) => [id, status]), [["a", "synced"], ["b", "draft"], ["c", "draft"]]);
        const history = (await getSyncHistory()).entries;
        assert.equal(history.length, 1, "only the prior completed group has history");
        assert.deepEqual(history[0].recordIds, ["a"]);
        assert.deepEqual(harness.progress.filter(({recordId}) => recordId).map(({recordId}) => recordId), ["a"]);
      }
    });
  }
});

test("current remote leads failure retains the successful content ACK and partial-content result", async (t) => {
  const harness = createHarness(t, {records: [leadsRecord()], targetId: "lead-record", rejectLeads: true});
  const result = await harness.single();
  assert.equal(result.ok, false);
  assert.equal(result.reason, "COMMENT_LEADS_SYNC_FAILED");
  assert.equal(result.partialContentSuccess, true);
  assert.equal(result.rawResponse.content.ok, true);
  assert.equal(result.rawResponse.commentLeads.ok, false);
  assert.deepEqual(harness.requests.map(({stage}) => stage), ["content", "comment_leads"]);
  assert.equal((await getDataPool()).records[0].payload.commentLeadsSyncStatus, "failed");
});

test("legacy defect: one request ACKs A-E but B's local failure loses the group result while F was never sent", async (t) => {
  const records = ["a", "b", "c", "d", "e", "f"].map((id) => contentRecord(id, "keyword_notes"));
  for (const record of records) record.payload.keyword = "same-keyword";
  const harness = createHarness(t, {records, throwAt: "content"});
  await assert.rejects(harness.batch(), /本地缓存更新失败/);
  assert.deepEqual(harness.requests.map(({ids}) => ids), [["a", "b", "c", "d", "e"]]);
  assert.deepEqual((await getDataPool()).records.map(({id, status}) => [id, status]), [
    ["a", "synced"], ["b", "draft"], ["c", "draft"], ["d", "draft"], ["e", "draft"], ["f", "draft"],
  ]);
  assert.deepEqual((await getSyncHistory()).entries, [], "the throw discards this group's returned ACK evidence and history");
  assert.deepEqual(harness.progress.filter(({recordId}) => recordId).map(({recordId}) => recordId), ["a"]);
});

test("legacy defect: local leads confirmation false or throw misreports or discards already-confirmed content", async (t) => {
  for (const failure of ["false", "throw"]) {
    await t.test(failure, async (t) => {
      const harness = createHarness(t, {records: [leadsRecord()], targetId: "lead-record",
        ...(failure === "false" ? {deleteAt: "comment_leads"} : {throwAt: "comment_leads"})});
      const result = await harness.single();
      assert.deepEqual(harness.requests.map(({stage}) => stage), ["content", "comment_leads"]);
      if (failure === "false") {
        assert.equal(result.ok, true);
        assert.equal(result.commentLeads.ok, true);
        assert.deepEqual((await getDataPool()).records, []);
        assert.equal(harness.progress.some(({phase}) => phase === "synced"), true);
      } else {
        assert.equal(result.ok, false);
        assert.equal(result.reason, "SYNC_ERROR");
        assert.equal(result.rawResponse, null);
        assert.equal(result.partialContentSuccess, undefined);
        assert.equal(result.commentLeads, undefined);
        assert.equal((await getDataPool()).records[0].status, "failed");
      }
    });
  }
});
