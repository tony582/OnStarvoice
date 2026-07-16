import assert from "node:assert/strict";
import test from "node:test";

const store = {
  "onstarvoice.runtime": {
    clientUuid: "client-test",
    clientLabel: "Chrome on macOS",
    appVersion: "0.3.31",
  },
  "onstarvoice.auth": {
    code: "LAB-AUTH-CODE",
  },
};

let storageGet = async (key) => ({[key]: store[key] ?? null});

globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        return await storageGet(key);
      },
      async set(values) {
        Object.assign(store, values);
      },
      async remove(key) {
        delete store[key];
      },
    },
  },
};

const {syncBatch} = await import("../../utils/api.js?sync-cancellation-tests");

function createRecord() {
  return {
    id: "record-1",
    type: "keyword_notes",
    platform: "xiaohongshu",
    workflow: "shared_keyword_notes",
    payload: {items: []},
  };
}

async function waitUntil(predicate, message = "condition not reached") {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(message);
}

test("cancel during runtime lookup prevents the first backend write", async () => {
  let releaseRuntime;
  let runtimeReadStarted = false;
  let canceled = false;
  let fetchCount = 0;
  storageGet = async (key) => {
    if (key !== "onstarvoice.runtime") return {[key]: store[key] ?? null};
    runtimeReadStarted = true;
    return await new Promise((resolve) => {
      releaseRuntime = () => resolve({[key]: store[key]});
    });
  };
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({ok: true}), {status: 200});
  };

  const pending = syncBatch([createRecord()], {}, {
    shouldStop: () => canceled,
  });
  while (!runtimeReadStarted) await Promise.resolve();
  canceled = true;
  releaseRuntime();

  const result = await pending;
  assert.equal(result.canceled, true);
  assert.equal(fetchCount, 0);
});

test("cancel after a missing endpoint blocks every fallback URL", async () => {
  storageGet = async (key) => ({[key]: store[key] ?? null});
  let canceled = false;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    canceled = true;
    return new Response(JSON.stringify({message: "missing"}), {status: 404});
  };

  const result = await syncBatch([createRecord()], {}, {
    shouldStop: () => canceled,
  });

  assert.equal(result.canceled, true);
  assert.equal(fetchCount, 1);
});

test("a broken cancellation callback fails closed", async () => {
  storageGet = async (key) => ({[key]: store[key] ?? null});
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({ok: true}), {status: 200});
  };

  const result = await syncBatch([createRecord()], {}, {
    shouldStop() {
      throw new Error("owner state unavailable");
    },
  });

  assert.equal(result.canceled, true);
  assert.equal(fetchCount, 0);
});

test("a pre-aborted signal performs no backend request", async () => {
  storageGet = async (key) => ({[key]: store[key] ?? null});
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({ok: true}), {status: 200});
  };
  const controller = new AbortController();
  controller.abort();

  const result = await syncBatch([createRecord()], {}, {
    signal: controller.signal,
  });

  assert.equal(result.canceled, true);
  assert.equal(fetchCount, 0);
});

test("aborting an active fetch returns canceled without trying a fallback URL", async () => {
  storageGet = async (key) => ({[key]: store[key] ?? null});
  const controller = new AbortController();
  let fetchCount = 0;
  let fetchStarted = false;
  globalThis.fetch = async (_url, options = {}) => {
    fetchCount += 1;
    fetchStarted = true;
    return await new Promise((_resolve, reject) => {
      options.signal?.addEventListener(
        "abort",
        () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        },
        {once: true},
      );
    });
  };

  const pending = syncBatch([createRecord()], {}, {
    signal: controller.signal,
  });
  await waitUntil(() => fetchStarted);
  controller.abort();
  const result = await pending;

  assert.equal(result.canceled, true);
  assert.equal(fetchCount, 1);
});
