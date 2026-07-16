export const DETAIL_RUNNER_MODE = Object.freeze({
  SOURCE_TAB: "source_tab",
  DEDICATED_TAB: "dedicated_tab",
});

export function normalizeDetailRunnerMode(value) {
  return value === DETAIL_RUNNER_MODE.DEDICATED_TAB
    ? DETAIL_RUNNER_MODE.DEDICATED_TAB
    : DETAIL_RUNNER_MODE.SOURCE_TAB;
}

export function buildDedicatedRunnerTabCreateProperties(
  sourceTab = {},
  {indexOffset = 1} = {},
) {
  const sourceTabId = Number(sourceTab?.id);
  if (!Number.isFinite(sourceTabId) || sourceTabId <= 0) {
    throw new Error("未找到可用的来源标签页");
  }

  const createProperties = {
    url: "about:blank",
    active: false,
  };
  const windowId = Number(sourceTab?.windowId);
  if (Number.isFinite(windowId) && windowId >= 0) {
    createProperties.windowId = windowId;
  }
  const sourceIndex = Number(sourceTab?.index);
  if (Number.isFinite(sourceIndex) && sourceIndex >= 0) {
    createProperties.index =
      Math.floor(sourceIndex) +
      Math.max(1, Math.floor(Number(indexOffset) || 1));
  }

  return createProperties;
}

export async function createDedicatedDetailRunnerTab({
  sourceTab,
  indexOffset = 1,
  chromeApi = globalThis.chrome,
} = {}) {
  if (!chromeApi?.tabs || typeof chromeApi.tabs.create !== "function") {
    throw new Error("当前浏览器不支持创建详情采集工作页");
  }

  const tab = await chromeApi.tabs.create(
    buildDedicatedRunnerTabCreateProperties(sourceTab, {indexOffset}),
  );
  const runnerTabId = Number(tab?.id);
  if (!Number.isFinite(runnerTabId) || runnerTabId <= 0) {
    throw new Error("创建详情采集工作页失败");
  }
  if (runnerTabId === Number(sourceTab?.id)) {
    throw new Error("详情采集工作页与来源页冲突");
  }

  return tab;
}

export async function closeOwnedDetailRunnerTabs(
  runners = [],
  {chromeApi = globalThis.chrome} = {},
) {
  const uniqueRunners = [];
  const seenTabIds = new Set();
  for (const runner of Array.isArray(runners) ? runners : []) {
    const runnerTabId = Number(runner?.runnerTabId);
    if (
      !Number.isSafeInteger(runnerTabId) ||
      runnerTabId <= 0 ||
      seenTabIds.has(runnerTabId)
    ) {
      continue;
    }
    seenTabIds.add(runnerTabId);
    uniqueRunners.push(runner);
  }

  const settled = await Promise.allSettled(
    uniqueRunners.map(async (runner) => ({
      runnerTabId: Number(runner.runnerTabId),
      closed: await closeOwnedDetailRunnerTab({...runner, chromeApi}),
    })),
  );
  const failedTabIds = settled.flatMap((result, index) =>
    result.status === 'rejected'
      ? [Number(uniqueRunners[index]?.runnerTabId)].filter(
          (tabId) => Number.isSafeInteger(tabId) && tabId > 0,
        )
      : [],
  );
  if (failedTabIds.length > 0) {
    const error = new Error('部分详情采集工作页未能自动关闭');
    error.code = 'detail_worker_close_failed';
    error.failedTabIds = failedTabIds;
    throw error;
  }
  return settled.map((result) => result.value);
}

export async function closeOwnedDetailRunnerTab({
  runnerTabId,
  sourceTabId,
  ownsRunnerTab = false,
  chromeApi = globalThis.chrome,
} = {}) {
  const numericRunnerTabId = Number(runnerTabId);
  const numericSourceTabId = Number(sourceTabId);
  if (
    !ownsRunnerTab ||
    !Number.isFinite(numericRunnerTabId) ||
    numericRunnerTabId <= 0 ||
    numericRunnerTabId === numericSourceTabId
  ) {
    return false;
  }
  if (!chromeApi?.tabs || typeof chromeApi.tabs.remove !== "function") {
    return false;
  }

  try {
    await chromeApi.tabs.remove(numericRunnerTabId);
    return true;
  } catch (error) {
    const message = String(error?.message || error || "");
    if (/no tab with id|tab not found|invalid tab id/i.test(message)) {
      return false;
    }
    throw error;
  }
}
