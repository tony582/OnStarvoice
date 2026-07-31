import assert from "node:assert/strict";
import test from "node:test";

class MemoryStorage {
  constructor() {
    this.items = new Map();
  }

  get length() {
    return this.items.size;
  }

  key(index) {
    return Array.from(this.items.keys())[index] ?? null;
  }

  getItem(key) {
    return this.items.get(String(key)) ?? null;
  }

  setItem(key, value) {
    this.items.set(String(key), String(value));
  }

  removeItem(key) {
    this.items.delete(String(key));
  }
}

const previousSessionStorage = globalThis.sessionStorage;
const previousLocalStorage = globalThis.localStorage;
globalThis.sessionStorage = new MemoryStorage();
globalThis.localStorage = new MemoryStorage();

const {readDouyinApiCache} = await import(
  `../../utils/capture/douyin-single-note.js?api-cache-identity=${Date.now()}`
);

test.after(() => {
  globalThis.sessionStorage = previousSessionStorage;
  globalThis.localStorage = previousLocalStorage;
});

function writeCache(storage, cacheId, detail) {
  storage.setItem(
    `__mc_dy_detail_${cacheId}`,
    JSON.stringify({
      ts: Date.now(),
      detail,
    }),
  );
}

test.beforeEach(() => {
  globalThis.sessionStorage = new MemoryStorage();
  globalThis.localStorage = new MemoryStorage();
});

test("Douyin API cache accepts matching aweme_id and id identities", () => {
  const noteId = "7662443795690278611";
  const detail = {
    aweme_id: noteId,
    id: noteId,
    desc: "matched",
  };
  writeCache(globalThis.sessionStorage, noteId, detail);

  assert.deepEqual(readDouyinApiCache(noteId), detail);
});

test("Douyin API cache rejects a detail whose aweme_id mismatches its cache key", () => {
  const requestedId = "7662443795690278611";
  const mismatchedId = "7662443795690278622";
  writeCache(globalThis.sessionStorage, requestedId, {
    aweme_id: mismatchedId,
    desc: "wrong detail",
  });

  assert.equal(readDouyinApiCache(requestedId), null);
  assert.notEqual(
    globalThis.sessionStorage.getItem(`__mc_dy_detail_${requestedId}`),
    null,
  );
});

test("Douyin API cache rejects a conflicting id even when aweme_id matches", () => {
  const requestedId = "7662443795690278611";
  writeCache(globalThis.sessionStorage, requestedId, {
    aweme_id: requestedId,
    id: "7662443795690278633",
  });

  assert.equal(readDouyinApiCache(requestedId), null);
});

test("Douyin API cache can use a valid local fallback after ignoring a mismatched session entry", () => {
  const requestedId = "7662443795690278611";
  const validDetail = {
    id: requestedId,
    desc: "valid local fallback",
  };
  writeCache(globalThis.sessionStorage, requestedId, {
    id: "7662443795690278644",
  });
  writeCache(globalThis.localStorage, requestedId, validDetail);

  assert.deepEqual(readDouyinApiCache(requestedId), validDetail);
});

test("Douyin API cache can use a valid local fallback after malformed session JSON", () => {
  const requestedId = "7662443795690278611";
  const validDetail = {
    aweme_id: requestedId,
    desc: "valid local fallback",
  };
  globalThis.sessionStorage.setItem(
    `__mc_dy_detail_${requestedId}`,
    "{not-json",
  );
  writeCache(globalThis.localStorage, requestedId, validDetail);

  assert.deepEqual(readDouyinApiCache(requestedId), validDetail);
});

test("Douyin API cache rejects details that expose no embedded ID", () => {
  const requestedId = "7662443795690278611";
  const detail = {
    desc: "legacy detail without identity fields",
  };
  writeCache(globalThis.sessionStorage, requestedId, detail);

  assert.equal(readDouyinApiCache(requestedId), null);
});
