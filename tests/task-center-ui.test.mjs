import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const rootUrl = new URL("../", import.meta.url);

async function read(relativePath) {
  return await readFile(new URL(relativePath, rootUrl), "utf8");
}

test("task center keeps the historyTab route and exposes compact filters", async () => {
  const html = await read("sidebar/sidebar.html");

  assert.match(html, /id="historyTab"/);
  assert.match(html, />任务中心</);
  assert.match(html, /id="taskCenterRunningCount"/);
  assert.match(html, /id="taskCenterAttentionCount"/);
  assert.match(html, /id="taskCenterHistoryCount"/);
  assert.match(html, /id="taskCenterStatusFilter"/);
  assert.match(html, /id="taskCenterTypeFilter"/);
  assert.match(html, /id="taskCenterPlatformFilter"/);
  assert.match(html, /id="taskCenterTimeFilter"/);
  assert.match(html, /id="taskCenterStatusLive"/);
  assert.match(html, /aria-label="选项菜单"/);
  assert.match(
    html,
    /id="btnMoreMenu"[\s\S]*aria-expanded="false"[\s\S]*aria-controls="dropdownMoreMenu"/,
  );
  assert.match(html, /id="dropdownMoreMenu"\s+role="menu"/);
  assert.match(html, /<button\s+class="dropdown-item"\s+id="menuBtnHistory"\s+type="button">/s);
});

test("more menu exposes keyboard navigation and status announcements ignore heartbeat-only changes", async () => {
  const [logic, taskCenterUi] = await Promise.all([
    read("sidebar/sidebar-logic.js"),
    read("sidebar/task-center-ui.js"),
  ]);

  assert.match(logic, /"ArrowDown", "ArrowUp", "Home", "End"/);
  assert.match(logic, /setMoreMenuOpen\(false, \{restoreFocus: true\}\)/);
  assert.match(taskCenterUi, /lastTaskCenterStatusById/);
  assert.match(taskCenterUi, /previousStatus !== item\.status/);
  assert.doesNotMatch(taskCenterUi, /heartbeatAt[^\n]*statusAnnouncementKey/);
});

test("task center renders one unified list and an accessible detail dialog", async () => {
  const [html, shellUi, taskCenterUi] = await Promise.all([
    read("sidebar/sidebar.html"),
    read("sidebar/sidebar-ui.js"),
    read("sidebar/task-center-ui.js"),
  ]);

  assert.match(html, /id="syncHistoryList"[^>]*class="task-center-list"/s);
  assert.match(html, /id="taskCenterDetailModal"/);
  assert.match(html, /aria-labelledby="taskCenterDetailTitle"/);
  assert.match(shellUi, /from "\.\/task-center-ui\.js"/);
  assert.doesNotMatch(shellUi, /function normalizeTaskCenterItem/);
  assert.match(taskCenterUi, /normalizeTaskLedger/);
  assert.match(taskCenterUi, /buildLegacyTaskCenterItems/);
  assert.match(taskCenterUi, /onstarvoice:task-center-action/);
  assert.doesNotMatch(taskCenterUi, /syncSectionHtml|monitorSectionHtml/);
});

test("monitor history adapter accepts nested response shapes and snake_case", async () => {
  const ui = await read("sidebar/task-center-ui.js");

  assert.match(ui, /source\.data\?\.items/);
  assert.match(ui, /source\.data\?\.executions/);
  assert.match(ui, /source\.result\?\.executions/);
  assert.match(ui, /"batchId", "batch_id"/);
  assert.match(ui, /"startedAt", "started_at"/);
  assert.match(ui, /"errorMessage", "error_message"/);
});

test("task center aggregation keeps ledger and legacy histories in one model", async () => {
  const {buildTaskCenterItems, extractMonitorExecutionEntries} = await import(
    `../sidebar/task-center-ui.js?task-center-ui-test=${Date.now()}`
  );
  const now = Date.now();
  const startedAt = new Date(now - 2 * 60 * 1000).toISOString();
  const finishedAt = new Date(now - 30 * 1000).toISOString();
  const monitorConfig = {
    result: {
      executions: [
        {
          execution_id: "monitor-1",
          batch_id: "batch-1",
          platform: "douyin",
          status: "success",
          started_at: startedAt,
          finished_at: finishedAt,
          hit_count: 2,
        },
      ],
    },
  };

  assert.deepEqual(extractMonitorExecutionEntries(monitorConfig)[0], {
    execution_id: "monitor-1",
    batch_id: "batch-1",
    platform: "douyin",
    status: "success",
    started_at: startedAt,
    finished_at: finishedAt,
    hit_count: 2,
    id: "monitor-1",
    batchId: "batch-1",
    subscriptionId: undefined,
    bloggerName: undefined,
    bloggerUrl: undefined,
    startedAt,
    finishedAt,
    hitCount: 2,
    scannedCount: undefined,
    costCredits: undefined,
    errorMessage: undefined,
  });

  const items = buildTaskCenterItems({
    ledgerState: {
      runs: [
        {
          id: "live-1",
          taskType: "keyword_capture",
          title: "关键词采集",
          status: "running",
          platform: "xiaohongshu",
          createdAt: new Date(now - 10 * 1000).toISOString(),
        },
      ],
    },
    historyConfig: {
      entries: [
        {
          id: "sync-1",
          trigger: "single",
          platform: "weibo",
          successCount: 1,
          finishedAt: new Date(now - 5 * 60 * 1000).toISOString(),
        },
      ],
    },
    monitorConfig,
  });

  assert.equal(items.length, 3);
  assert.equal(items[0].id, "live-1");
  assert.equal(items[0].statusGroup, "running");
  assert.equal(items.filter((item) => item.legacy).length, 2);
  assert.deepEqual(new Set(items.map((item) => item.type)), new Set(["keyword", "sync", "monitor"]));
});

test("task center orders all business tasks by start time descending", async () => {
  const {buildTaskCenterItems} = await import(
    `../sidebar/task-center-ui.js?task-center-time-order-test=${Date.now()}`
  );
  const items = buildTaskCenterItems({
    ledgerState: {
      runs: [
        {
          id: "older-running-task",
          taskType: "capture",
          status: "running",
          createdAt: "2026-07-21T02:00:00.000Z",
          updatedAt: "2026-07-21T02:30:00.000Z",
        },
        {
          id: "newer-completed-task",
          taskType: "capture",
          status: "completed",
          createdAt: "2026-07-21T02:20:00.000Z",
          updatedAt: "2026-07-21T02:21:00.000Z",
        },
      ],
    },
  });

  assert.deepEqual(items.map((item) => item.id), [
    "newer-completed-task",
    "older-running-task",
  ]);
});

test("task center hides capture child syncs but keeps user initiated sync tasks", async () => {
  const {buildTaskCenterItems} = await import(
    `../sidebar/task-center-ui.js?task-center-sync-visibility-test=${Date.now()}`
  );
  const items = buildTaskCenterItems({
    ledgerState: {
      runs: [
        {
          id: "capture-task",
          taskType: "capture",
          status: "completed",
          createdAt: "2026-07-21T02:00:00.000Z",
        },
        {
          id: "technical-sync-ledger",
          taskType: "sync",
          status: "completed",
          createdAt: "2026-07-21T02:03:00.000Z",
          metadata: {taskCenterVisibility: "internal"},
        },
      ],
    },
    historyConfig: {
      entries: [
        {
          id: "detail-auto-sync",
          trigger: "detail_auto",
          status: "completed",
          startedAt: "2026-07-21T02:02:00.000Z",
          finishedAt: "2026-07-21T02:02:01.000Z",
        },
        {
          id: "capture-auto-sync",
          trigger: "capture_auto",
          status: "completed",
          startedAt: "2026-07-21T02:01:00.000Z",
          finishedAt: "2026-07-21T02:01:01.000Z",
        },
        {
          id: "manual-page-sync",
          trigger: "current_page",
          status: "completed",
          startedAt: "2026-07-21T02:04:00.000Z",
          finishedAt: "2026-07-21T02:04:01.000Z",
        },
      ],
    },
  });

  assert.deepEqual(
    items.map((item) => item.id),
    ["legacy:sync:manual-page-sync", "capture-task"],
  );
});

test("single-record capture auto sync keeps its internal trigger in history", async () => {
  const captureSync = await read("utils/capture-sync.js");

  assert.match(
    captureSync,
    /syncRecord\(syncRecordIds\[0\], onProgress, \{\s*trigger: 'capture_auto'/,
  );
  assert.match(
    captureSync,
    /const historyTrigger = String\(options\?\.trigger \|\| 'single'\)/,
  );
  assert.equal(
    captureSync.match(/trigger: historyTrigger/g)?.length,
    4,
  );
});

test("task center clear cutoff hides old local and backend history", async () => {
  const {buildTaskCenterItems} = await import(
    `../sidebar/task-center-ui.js?task-center-clear-test=${Date.now()}`
  );
  const clearedAt = new Date().toISOString();
  const beforeClear = new Date(Date.now() - 60_000).toISOString();
  const items = buildTaskCenterItems({
    ledgerState: {runs: [], clearedAt},
    historyConfig: {
      entries: [
        {id: "old-sync", status: "completed", finishedAt: beforeClear},
      ],
    },
    monitorConfig: {
      executions: [
        {id: "old-monitor", status: "running", startedAt: beforeClear},
      ],
    },
  });

  assert.deepEqual(items, []);
});

test("task center clear cutoff also hides a stale legacy unattended request", async () => {
  const {buildTaskCenterItems} = await import(
    `../sidebar/task-center-ui.js?task-center-unattended-clear-test=${Date.now()}`
  );
  const clearedAt = new Date().toISOString();
  const beforeClear = new Date(Date.now() - 60_000).toISOString();
  const items = buildTaskCenterItems({
    ledgerState: {runs: [], clearedAt},
    legacyState: {
      plan: {
        platform: "xiaohongshu",
        keywords: ["旅行"],
        lastRunStatus: "running",
        lastRunAt: beforeClear,
      },
      request: {
        id: "stale-request-before-clear",
        status: "running",
        createdAt: beforeClear,
        updatedAt: beforeClear,
      },
    },
  });

  assert.deepEqual(items, []);
});

test("new ledger runs suppress their mirrored legacy records", async () => {
  const {buildTaskCenterItems} = await import(
    `../sidebar/task-center-ui.js?task-center-dedupe-test=${Date.now()}`
  );
  const now = Date.now();
  const startedAt = new Date(now - 60_000).toISOString();
  const finishedAt = new Date(now - 10_000).toISOString();
  const items = buildTaskCenterItems({
    ledgerState: {
      runs: [
        {
          id: "request-1",
          taskType: "unattended_keyword_capture",
          title: "无人值守关键词采集",
          status: "running",
          createdAt: startedAt,
        },
        {
          id: "sync-ledger-1",
          taskType: "sync",
          title: "数据同步",
          platform: "douyin",
          status: "completed",
          startedAt,
          finishedAt,
        },
      ],
    },
    historyConfig: {
      entries: [
        {
          id: "sync-history-1",
          platform: "douyin",
          successCount: 1,
          startedAt,
          finishedAt,
        },
      ],
    },
    legacyState: {
      plan: {
        platform: "xiaohongshu",
        keywords: ["旅行"],
        lastRunStatus: "running",
        lastRunAt: startedAt,
      },
      request: {
        id: "request-1",
        status: "running",
        createdAt: startedAt,
      },
    },
  });

  assert.deepEqual(items.map((item) => item.id).sort(), ["request-1", "sync-ledger-1"]);
});

test("legacy unattended actions target the real request id", async () => {
  const {buildTaskCenterItems} = await import(
    `../sidebar/task-center-ui.js?legacy-action-test=${Date.now()}`
  );
  const createdAt = new Date().toISOString();
  const [item] = buildTaskCenterItems({
    legacyState: {
      plan: {
        platform: "xiaohongshu",
        keywords: ["咖啡"],
        lastRunStatus: "running",
        lastRunAt: createdAt,
      },
      request: {
        id: "legacy-request-7",
        status: "running",
        createdAt,
      },
    },
  });

  assert.equal(item.id.startsWith("legacy:unattended:"), true);
  assert.equal(item.actionTaskId, "legacy-request-7");
  assert.equal(item.canControlKeywordRun, true);
});

test("historical keyword tasks are read-only when another request is current", async () => {
  const {buildTaskCenterItems} = await import(
    `../sidebar/task-center-ui.js?historical-control-test=${Date.now()}`
  );
  const createdAt = new Date().toISOString();
  const items = buildTaskCenterItems({
    ledgerState: {
      runs: [
        {
          id: "old-request",
          taskType: "unattended_keyword_capture",
          status: "failed",
          createdAt,
        },
        {
          id: "current-request",
          taskType: "unattended_keyword_capture",
          status: "needs_action",
          createdAt,
        },
      ],
    },
    legacyState: {
      request: {id: "current-request", status: "needs_action", createdAt},
    },
  });

  assert.equal(items.find((item) => item.id === "old-request")?.canControlKeywordRun, false);
  assert.equal(items.find((item) => item.id === "current-request")?.canControlKeywordRun, true);
});

test("an archived failed keyword task becomes retryable after the current task finishes", async () => {
  const {buildTaskCenterItems} = await import(
    `../sidebar/task-center-ui.js?archived-control-test=${Date.now()}`
  );
  const createdAt = new Date().toISOString();
  const items = buildTaskCenterItems({
    ledgerState: {
      runs: [
        {
          id: "archived-request",
          taskType: "unattended_keyword_capture",
          status: "completed_with_failures",
          createdAt,
        },
        {
          id: "finished-current-request",
          taskType: "unattended_keyword_capture",
          status: "completed",
          createdAt,
        },
      ],
    },
    legacyState: {
      request: {
        id: "finished-current-request",
        status: "completed",
        createdAt,
      },
      recoverableRequestIds: ["archived-request"],
    },
  });

  assert.equal(
    items.find((item) => item.id === "archived-request")
      ?.canControlKeywordRun,
    true,
  );
});

test("an archived retry is read-only while the current request is pending", async () => {
  const {buildTaskCenterItems} = await import(
    `../sidebar/task-center-ui.js?archived-busy-control-test=${Date.now()}`
  );
  const createdAt = new Date().toISOString();
  const items = buildTaskCenterItems({
    ledgerState: {
      runs: [
        {
          id: "archived-request",
          taskType: "unattended_keyword_capture",
          status: "failed",
          createdAt,
        },
        {
          id: "pending-current-request",
          taskType: "unattended_keyword_capture",
          status: "pending",
          createdAt,
        },
      ],
    },
    legacyState: {
      request: {
        id: "pending-current-request",
        status: "pending",
        createdAt,
      },
      recoverableRequestIds: ["archived-request"],
    },
  });

  assert.equal(
    items.find((item) => item.id === "archived-request")
      ?.canControlKeywordRun,
    false,
  );
});

test("keep-results hides recovery controls for a dismissed terminal request", async () => {
  const {buildTaskCenterItems} = await import(
    `../sidebar/task-center-ui.js?dismissed-control-test=${Date.now()}`
  );
  const createdAt = new Date().toISOString();
  const [item] = buildTaskCenterItems({
    ledgerState: {
      runs: [
        {
          id: "dismissed-request",
          taskType: "unattended_keyword_capture",
          status: "failed",
          createdAt,
        },
      ],
    },
    legacyState: {
      request: {
        id: "dismissed-request",
        status: "failed",
        recoveryDismissedAt: createdAt,
        createdAt,
      },
    },
  });

  assert.equal(item?.canControlKeywordRun, false);
});

test("an old Agent scope cannot expose recovery controls in the current tenant", async () => {
  const {buildTaskCenterItems} = await import(
    `../sidebar/task-center-ui.js?scope-control-test=${Date.now()}`
  );
  const createdAt = new Date().toISOString();
  const [item] = buildTaskCenterItems({
    ledgerState: {
      runs: [
        {
          id: "old-scope-request",
          taskType: "unattended_keyword_capture",
          status: "failed",
          createdAt,
        },
      ],
    },
    legacyState: {
      request: {
        id: "old-scope-request",
        status: "failed",
        cloudAgentScopeId: "old-agent",
        createdAt,
      },
      requestRecoveryAllowed: false,
    },
  });

  assert.equal(item?.canControlKeywordRun, false);
});

test("task center reads the canonical business clock and keyword checkpoint rows", async () => {
  const {normalizeTaskCenterItem} = await import(
    `../sidebar/task-center-ui.js?checkpoint-ui-test=${Date.now()}`
  );
  const businessProgressAt = new Date().toISOString();
  const item = normalizeTaskCenterItem({
    id: "checkpoint-run",
    taskType: "unattended_keyword_capture",
    status: "running",
    businessProgressAt,
    checkpoint: {
      round: 2,
      keywordResults: [
        {round: 2, keyword: "品牌", status: "completed"},
        {round: 2, keyword: "竞品", status: "failed"},
      ],
    },
  });

  assert.equal(item.lastProgressAt, Date.parse(businessProgressAt));
  assert.deepEqual(item.keywords, [
    {keyword: "品牌", status: "completed"},
    {keyword: "竞品", status: "failed"},
  ]);
});

test("task center refreshes an open detail and blocks code-only safety retries", async () => {
  const ui = await read("sidebar/task-center-ui.js");

  assert.match(ui, /activeTaskCenterDetailId && detailModal\?\.classList\.contains\("is-active"\)/);
  assert.match(ui, /renderTaskCenterDetail\(activeDetailItem\)/);
  assert.match(ui, /focusedDetailAction/);
  assert.match(ui, /CSS\.escape\(focusedDetailAction\)/);
  assert.match(ui, /stillValidAction \|\| document\.getElementById\("btnTaskCenterDetailDone"\)/);
  assert.match(ui, /item\?\.raw\?\.error\?\.code/);
  assert.match(ui, /login\[_\\s-\]\?required/);
  assert.match(ui, /requiresManualAction/);
  assert.match(ui, /douyin_search_service_abnormal/);
  assert.match(
    ui,
    /\["attention", "failed", "partial"\]\.includes\(item\.status\)[\s\S]*isTaskCenterCircuitBreaker\(item\)/,
  );
  assert.match(ui, /button\.setAttribute\("aria-label", `筛选\$\{label\}任务，\$\{count\} 个`\)/);
});

test("sidebar state subscribes to task ledger and legacy unattended records", async () => {
  const [constants, state] = await Promise.all([
    read("utils/constants.js"),
    read("sidebar/state.js"),
  ]);

  assert.match(constants, /TASK_LEDGER:\s*"onstarvoice\.taskLedger"/);
  assert.match(state, /notifyListeners\('taskLedger', currentTaskLedger\)/);
  assert.match(state, /notifyListeners\('taskCenterLegacy', currentTaskCenterLegacy\)/);
  assert.match(state, /initTaskLedger\(\)/);
  assert.match(state, /initTaskCenterLegacyState\(\)/);
  assert.match(
    state,
    /authChange \|\|[\s\S]*UNATTENDED_KEYWORD_RUN_ARCHIVE/u,
  );
});
