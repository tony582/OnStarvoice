import assert from "node:assert/strict";
import test from "node:test";

const storageModule = await import(
  new URL("../utils/storage.js", import.meta.url).href +
    `?storage-pressure-test=${Date.now()}`
);

function createChromeStorage({initial = {}, onSet = null} = {}) {
  const values = new Map(Object.entries(initial));
  const removed = [];
  const writes = [];
  return {
    values,
    removed,
    writes,
    chrome: {
      storage: {
        local: {
          QUOTA_BYTES: 10 * 1024 * 1024,
          get: async (key) => {
            if (key === null) return Object.fromEntries(values);
            const keys = Array.isArray(key) ? key : [key];
            return Object.fromEntries(
              keys.filter((item) => values.has(item)).map((item) => [
                item,
                values.get(item),
              ]),
            );
          },
          set: async (patch) => {
            writes.push(patch);
            if (onSet) await onSet(patch, writes.length);
            for (const [key, value] of Object.entries(patch)) {
              values.set(key, value);
            }
          },
          remove: async (key) => {
            removed.push(key);
            values.delete(key);
          },
          getBytesInUse: async () => 7.5 * 1024 * 1024,
        },
      },
    },
  };
}

test("recognizes the Chromium kQuotaBytes failure shown by the Extension", () => {
  assert.equal(
    storageModule.isStorageQuotaError(
      new Error("Resource::kQuotaBytes quota exceeded"),
    ),
    true,
  );
  assert.equal(
    storageModule.isStorageQuotaError(new Error("temporary network error")),
    false,
  );
});

test("quota compaction removes only old acknowledged inactive records", () => {
  const now = Date.UTC(2026, 7, 27, 0, 0, 0);
  const old = now - 10 * 24 * 60 * 60 * 1000;
  const recent = now - 60 * 60 * 1000;
  const result = storageModule.compactDataPoolForQuota(
    {
      records: [
        {id: "old-synced", status: "synced", lastSyncedAt: old},
        {id: "recent-synced", status: "synced", lastSyncedAt: recent},
        {id: "unsynced", status: "draft", lastSyncedAt: null},
        {id: "failed", status: "failed", lastSyncedAt: old},
        {
          id: "active-synced",
          status: "synced",
          lastSyncedAt: old,
          normalizedPayload: {detailCaptureStatus: "capturing"},
        },
        {
          id: "old-synced-iso",
          status: "synced",
          lastSyncedAt: new Date(old).toISOString(),
        },
      ],
    },
    {now},
  );

  assert.equal(result.removedCount, 2);
  assert.deepEqual(
    result.dataPool.records.map((record) => record.id),
    ["recent-synced", "unsynced", "failed", "active-synced"],
  );
});

test("data-pool quota releases the control reserve, compacts, and retries once", async () => {
  let dataPoolWrites = 0;
  const mock = createChromeStorage({
    initial: {
      [storageModule.CONTROL_STORAGE_RESERVE_KEY]: {
        schemaVersion: 1,
        padding: "0".repeat(storageModule.CONTROL_STORAGE_RESERVE_BYTES),
      },
    },
    onSet: async (patch) => {
      if (Object.hasOwn(patch, "onstarvoice.data_pool")) {
        dataPoolWrites += 1;
        if (dataPoolWrites === 1) {
          throw new Error("Resource::kQuotaBytes quota exceeded");
        }
      }
    },
  });
  globalThis.chrome = mock.chrome;
  const now = Date.now();

  assert.equal(
    await storageModule.setDataPool({
      records: [
        {
          id: "old-synced",
          status: "synced",
          lastSyncedAt: now - 10 * 24 * 60 * 60 * 1000,
        },
        {id: "unsynced", status: "draft", lastSyncedAt: null},
      ],
    }),
    true,
  );
  assert.equal(dataPoolWrites, 2);
  assert.ok(mock.removed.includes(storageModule.CONTROL_STORAGE_RESERVE_KEY));
  assert.deepEqual(
    mock.values
      .get("onstarvoice.data_pool")
      .records.map((record) => record.id),
    ["unsynced"],
  );
});

test("quota with no safe records fails closed but still frees control space", async () => {
  let dataPoolWrites = 0;
  const mock = createChromeStorage({
    initial: {
      [storageModule.CONTROL_STORAGE_RESERVE_KEY]: {
        schemaVersion: 1,
        padding: "reserved",
      },
    },
    onSet: async (patch) => {
      if (Object.hasOwn(patch, "onstarvoice.data_pool")) {
        dataPoolWrites += 1;
        throw new Error("Resource::kQuotaBytes quota exceeded");
      }
    },
  });
  globalThis.chrome = mock.chrome;

  assert.equal(
    await storageModule.setDataPool({
      records: [{id: "unsynced", status: "draft", lastSyncedAt: null}],
    }),
    false,
  );
  assert.equal(dataPoolWrites, 1);
  assert.ok(mock.removed.includes(storageModule.CONTROL_STORAGE_RESERVE_KEY));
});

test("a released reserve is restored later only after verified headroom", async () => {
  const mock = createChromeStorage({
    initial: {
      [storageModule.CONTROL_STORAGE_RESERVE_KEY]: {
        schemaVersion: 1,
        padding: "0".repeat(storageModule.CONTROL_STORAGE_RESERVE_BYTES),
      },
    },
  });
  const area = mock.chrome.storage.local;
  let bytesUsed =
    area.QUOTA_BYTES - storageModule.CONTROL_STORAGE_RESERVE_BYTES;
  area.getBytesInUse = async () => bytesUsed;
  let attempts = 0;

  const result = await storageModule.runWithControlStorageReserveRetry(
    async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("Resource::kQuotaBytes quota exceeded");
      }
      return "persisted";
    },
    {storage: area, restoreDelayMs: 0},
  );

  assert.equal(result.value, "persisted");
  assert.equal(result.retried, true);
  assert.equal(
    mock.values.has(storageModule.CONTROL_STORAGE_RESERVE_KEY),
    false,
  );
  // The delayed maintenance pass sees fresh profile capacity. It never uses
  // the reserve retry helper itself, so a racing quota failure cannot recurse.
  bytesUsed = 0;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(
    mock.values.has(storageModule.CONTROL_STORAGE_RESERVE_KEY),
    true,
  );
});

test("reserve establishment is skipped when measured headroom is too small", async () => {
  const mock = createChromeStorage();
  const area = mock.chrome.storage.local;
  area.getBytesInUse = async () =>
    area.QUOTA_BYTES - storageModule.CONTROL_STORAGE_RESERVE_BYTES;
  globalThis.chrome = mock.chrome;

  assert.equal(await storageModule.ensureControlStorageReserve(), false);
  assert.equal(mock.writes.length, 0);
});

test("quota cleanup hook runs after reserve release and cannot replace the critical retry", async () => {
  const mock = createChromeStorage();
  const area = mock.chrome.storage.local;
  globalThis.chrome = mock.chrome;
  await area.set({
    [storageModule.CONTROL_STORAGE_RESERVE_KEY]: {
      schemaVersion: 1,
      padding: "0".repeat(storageModule.CONTROL_STORAGE_RESERVE_BYTES),
    },
    protectedAuth: {token: "preserved"},
  });
  const events = [];
  let attempts = 0;
  const result = await storageModule.runWithControlStorageReserveRetry(
    async () => {
      attempts += 1;
      events.push(`attempt-${attempts}`);
      if (attempts === 1) {
        throw new Error("Resource::kQuotaBytes quota exceeded");
      }
      return "persisted";
    },
    {
      storage: area,
      onQuotaPressure: async () => {
        events.push("cleanup");
        assert.equal(
          mock.values.has(storageModule.CONTROL_STORAGE_RESERVE_KEY),
          false,
        );
        assert.deepEqual(mock.values.get("protectedAuth"), {
          token: "preserved",
        });
        throw new Error("injected cleanup failure");
      },
    },
  );

  assert.equal(result.value, "persisted");
  assert.deepEqual(events, ["attempt-1", "cleanup", "attempt-2"]);
  assert.deepEqual(mock.values.get("protectedAuth"), {token: "preserved"});
});

test("storage pressure reports profile-scoped watermarks", async () => {
  const mock = createChromeStorage();
  globalThis.chrome = mock.chrome;
  const snapshot = await storageModule.getStoragePressureSnapshot();
  assert.equal(snapshot.pressure, "yellow");
  assert.equal(snapshot.quotaBytes, 10 * 1024 * 1024);
  assert.equal(snapshot.bytesUsed, 7.5 * 1024 * 1024);
});

test("storage pressure stays unknown when Chromium cannot measure the profile", async () => {
  const mock = createChromeStorage();
  delete mock.chrome.storage.local.getBytesInUse;
  globalThis.chrome = mock.chrome;
  const snapshot = await storageModule.getStoragePressureSnapshot();
  assert.equal(snapshot.pressure, "unknown");
  assert.equal(snapshot.bytesUsed, null);
  assert.equal(snapshot.remainingBytes, null);
});
