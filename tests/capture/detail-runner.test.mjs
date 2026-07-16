import assert from "node:assert/strict";
import test from "node:test";

import {
  DETAIL_RUNNER_MODE,
  buildDedicatedRunnerTabCreateProperties,
  closeOwnedDetailRunnerTab,
  closeOwnedDetailRunnerTabs,
  createDedicatedDetailRunnerTab,
  normalizeDetailRunnerMode,
} from "../../utils/capture/detail-runner.js";

test("source-tab mode remains the compatibility default", () => {
  assert.equal(normalizeDetailRunnerMode(), DETAIL_RUNNER_MODE.SOURCE_TAB);
  assert.equal(
    normalizeDetailRunnerMode("unexpected"),
    DETAIL_RUNNER_MODE.SOURCE_TAB,
  );
  assert.equal(
    normalizeDetailRunnerMode(DETAIL_RUNNER_MODE.DEDICATED_TAB),
    DETAIL_RUNNER_MODE.DEDICATED_TAB,
  );
});

test("dedicated worker opens inactive beside the source tab", async () => {
  const created = [];
  const chromeApi = {
    tabs: {
      async create(properties) {
        created.push(structuredClone(properties));
        return {id: 92, ...properties};
      },
    },
  };

  const sourceTab = {id: 41, windowId: 7, index: 3};
  const properties = buildDedicatedRunnerTabCreateProperties(sourceTab);
  assert.deepEqual(properties, {
    url: "about:blank",
    active: false,
    windowId: 7,
    index: 4,
  });

  const worker = await createDedicatedDetailRunnerTab({sourceTab, chromeApi});
  assert.equal(worker.id, 92);
  assert.equal(created.length, 1);
  assert.deepEqual(created[0], properties);

  assert.deepEqual(
    buildDedicatedRunnerTabCreateProperties(sourceTab, {indexOffset: 2}),
    {...properties, index: 5},
  );
});

test("dedicated worker creation fails closed on invalid or conflicting ids", async () => {
  assert.throws(
    () => buildDedicatedRunnerTabCreateProperties({id: 0}),
    /来源标签页/,
  );

  await assert.rejects(
    createDedicatedDetailRunnerTab({
      sourceTab: {id: 41},
      chromeApi: {tabs: {async create() { return {id: 41}; }}},
    }),
    /来源页冲突/,
  );
});

test("owned worker cleanup is awaited and runs once", async () => {
  const removed = [];
  let released = false;
  const chromeApi = {
    tabs: {
      async remove(tabId) {
        await Promise.resolve();
        removed.push(tabId);
        released = true;
      },
    },
  };

  const closed = await closeOwnedDetailRunnerTab({
    runnerTabId: 92,
    sourceTabId: 41,
    ownsRunnerTab: true,
    chromeApi,
  });
  assert.equal(closed, true);
  assert.equal(released, true);
  assert.deepEqual(removed, [92]);
});

test("cleanup never removes an unowned or source tab", async () => {
  const removed = [];
  const chromeApi = {tabs: {async remove(tabId) { removed.push(tabId); }}};

  assert.equal(
    await closeOwnedDetailRunnerTab({
      runnerTabId: 92,
      sourceTabId: 41,
      ownsRunnerTab: false,
      chromeApi,
    }),
    false,
  );
  assert.equal(
    await closeOwnedDetailRunnerTab({
      runnerTabId: 41,
      sourceTabId: 41,
      ownsRunnerTab: true,
      chromeApi,
    }),
    false,
  );
  assert.deepEqual(removed, []);
});

test("cleanup tolerates a worker already closed by the user", async () => {
  const closed = await closeOwnedDetailRunnerTab({
    runnerTabId: 92,
    sourceTabId: 41,
    ownsRunnerTab: true,
    chromeApi: {
      tabs: {
        async remove() {
          throw new Error("No tab with id: 92");
        },
      },
    },
  });
  assert.equal(closed, false);
});

test("multi-worker cleanup attempts every owned worker", async () => {
  const removed = [];
  const result = await closeOwnedDetailRunnerTabs(
    [
      {runnerTabId: 92, sourceTabId: 41, ownsRunnerTab: true},
      {runnerTabId: 93, sourceTabId: 41, ownsRunnerTab: true},
    ],
    {
      chromeApi: {
        tabs: {
          async remove(tabId) {
            removed.push(tabId);
            if (tabId === 92) throw new Error("No tab with id: 92");
          },
        },
      },
    },
  );
  assert.deepEqual(removed.sort((a, b) => a - b), [92, 93]);
  assert.deepEqual(
    result
      .map((item) => ({runnerTabId: item.runnerTabId, closed: item.closed}))
      .sort((a, b) => a.runnerTabId - b.runnerTabId),
    [
      {runnerTabId: 92, closed: false},
      {runnerTabId: 93, closed: true},
    ],
  );
});

test("multi-worker cleanup reports every non-benign close failure without skipping peers", async () => {
  const removed = [];
  await assert.rejects(
    closeOwnedDetailRunnerTabs(
      [
        {runnerTabId: 92, sourceTabId: 41, ownsRunnerTab: true},
        {runnerTabId: 93, sourceTabId: 41, ownsRunnerTab: true},
      ],
      {
        chromeApi: {
          tabs: {
            async remove(tabId) {
              removed.push(tabId);
              if (tabId === 92) {
                throw Object.freeze(new Error("permission denied"));
              }
            },
          },
        },
      },
    ),
    (error) => {
      assert.equal(error.code, "detail_worker_close_failed");
      assert.deepEqual(error.failedTabIds, [92]);
      return true;
    },
  );
  assert.deepEqual(removed.sort((a, b) => a - b), [92, 93]);
});
