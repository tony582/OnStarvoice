import assert from "node:assert/strict";
import test from "node:test";

function createMemoryStorageArea() {
  const values = new Map();
  return {
    async get(keys) {
      if (keys == null) return Object.fromEntries(values);
      if (typeof keys === "string") {
        return values.has(keys) ? {[keys]: structuredClone(values.get(keys))} : {};
      }
      if (Array.isArray(keys)) {
        return Object.fromEntries(
          keys
            .filter((key) => values.has(key))
            .map((key) => [key, structuredClone(values.get(key))]),
        );
      }
      const result = {...keys};
      for (const key of Object.keys(keys || {})) {
        if (values.has(key)) result[key] = structuredClone(values.get(key));
      }
      return result;
    },
    async set(patch) {
      for (const [key, value] of Object.entries(patch || {})) {
        values.set(key, structuredClone(value));
      }
    },
    async remove(keys) {
      const requested = Array.isArray(keys) ? keys : [keys];
      requested.forEach((key) => values.delete(key));
    },
  };
}

test("non-empty list capture finalizes trace bindings and reuses the saved record", async () => {
  const storageArea = createMemoryStorageArea();
  const sourceTab = {
    id: 41,
    active: true,
    status: "complete",
    url: "https://www.xiaohongshu.com/search_result?keyword=test",
  };
  let captureRun = 0;

  globalThis.chrome = {
    storage: {local: storageArea},
    runtime: {
      async sendMessage(message) {
        if (message?.type === "onstarvoice:relay-to-content") {
          if (message?.payload?.action === "updateListCaptureTraceBindings") {
            return {ok: true, data: {ok: true}};
          }
          assert.equal(message?.payload?.action, "captureKeywordNotes");
          captureRun += 1;
          return {
            ok: true,
            data: {
              ok: true,
              type: "keyword_notes",
              platform: "xiaohongshu",
              data: {
                keyword: "test",
                totalCount: 1,
                filteredCount: 1,
                items: [
                  {
                    noteId: "trace-note-1",
                    url: "https://www.xiaohongshu.com/explore/trace-note-1",
                    title: "trace contract",
                    author: "tester",
                    likes: 10,
                    captureTrace: {
                      version: 1,
                      runId: `list-run-${captureRun}`,
                      sequence: 1,
                      identityKey: "id:trace-note-1",
                      state: "discovered",
                    },
                  },
                ],
              },
            },
          };
        }
        return {ok: true, data: null};
      },
      getURL(path) {
        return `chrome-extension://test/${path}`;
      },
    },
    tabs: {
      async query() {
        return [sourceTab];
      },
      async get(tabId) {
        assert.equal(tabId, sourceTab.id);
        return sourceTab;
      },
    },
  };

  const [{getDataPool}, {captureAndSync}] = await Promise.all([
    import("../../utils/storage.js?list-save-finalization"),
    import("../../utils/capture-sync.js?list-save-finalization"),
  ]);

  const first = await captureAndSync({
    mode: "keyword",
    autoSync: false,
    captureParams: {keyword: "test"},
  });
  assert.equal(first.ok, true);
  assert.equal(first.recordIds.length, 1);
  assert.equal(first.traceBindings.length, 1);
  assert.equal(first.traceBindings[0].recordId, first.recordIds[0]);
  assert.equal(first.traceBindings[0].state, "saved");

  const second = await captureAndSync({
    mode: "keyword",
    autoSync: false,
    captureParams: {keyword: "test"},
  });
  assert.equal(second.ok, true);
  assert.deepEqual(second.recordIds, first.recordIds);
  assert.equal(second.traceBindings.length, 1);
  assert.equal(second.traceBindings[0].runId, "list-run-2");
  assert.equal(second.traceBindings[0].recordId, first.recordIds[0]);

  const dataPool = await getDataPool();
  assert.equal(dataPool.records.length, 1);
  assert.equal(
    dataPool.records[0].payload.captureTrace.recordId,
    first.recordIds[0],
  );
  assert.equal(dataPool.records[0].payload.captureTrace.runId, "list-run-2");
});
