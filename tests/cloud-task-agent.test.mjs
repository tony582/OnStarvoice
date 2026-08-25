import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import test from "node:test";
import vm from "node:vm";
import {fileURLToPath} from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(resolve(repoRoot, "utils/cloud-task-agent.js"), "utf8");
const productionRuntimeConfig = await readFile(
  resolve(repoRoot, "utils/runtime-config.js"),
  "utf8",
);
const localRuntimeConfig = await readFile(
  resolve(repoRoot, "scripts/extension-runtime-config.local.js"),
  "utf8",
);
const context = vm.createContext({
  AbortController,
  Date,
  URL,
  clearTimeout,
  setTimeout,
});
vm.runInContext(source, context, {filename: "utils/cloud-task-agent.js"});
const agent = context.OnStarvoiceCloudTaskAgent;

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadAgentWithRuntimeConfig(runtimeConfig) {
  const configuredContext = vm.createContext({
    AbortController,
    Date,
    URL,
    clearTimeout,
    setTimeout,
  });
  vm.runInContext(runtimeConfig, configuredContext, {filename: "runtime-config.js"});
  vm.runInContext(source, configuredContext, {filename: "utils/cloud-task-agent.js"});
  return configuredContext.OnStarvoiceCloudTaskAgent;
}

function loadAgentWithEnvironment(environment = {}) {
  const configuredContext = vm.createContext({
    AbortController,
    Date,
    URL,
    clearTimeout,
    setTimeout,
    ...environment,
  });
  vm.runInContext(source, configuredContext, {filename: "utils/cloud-task-agent.js"});
  return configuredContext.OnStarvoiceCloudTaskAgent;
}

test("heartbeat mirrors the newest local tasks and marks the active control request", () => {
  const payload = agent.buildHeartbeatPayload({
    runtime: {
      clientUuid: "browser-profile-a",
      clientLabel: "Chrome on macOS",
      appVersion: "0.3.51",
    },
    unattendedRequest: {id: "task-new"},
    ledger: {
      version: 1,
      runs: [
        {
          id: "task-old",
          title: "旧任务",
          status: "completed",
          updatedAt: "2026-07-20T07:00:00.000Z",
        },
        {
          id: "task-new",
          title: "新任务",
          taskType: "unattended_keyword_plan",
          platform: "douyin",
          status: "running",
          progress: {current: 2, total: 10},
          updatedAt: "2026-07-20T08:00:00.000Z",
        },
      ],
    },
    reason: "test",
  });

  assert.equal(payload.agent.clientUuid, "browser-profile-a");
  assert.equal(payload.agent.capabilities.parallelSlots, 1);
  assert.deepEqual(
    plain(payload.tasks.map(task => task.id)),
    ["task-new", "task-old"],
  );
  assert.equal(payload.tasks[0].controlTaskId, "task-new");
  assert.deepEqual(plain(payload.tasks[0].progress), {current: 2, total: 10});
});

test("every task carries bounded structured health evidence without page copy or URLs", () => {
  const progressAt = new Date(Date.now() - 1500).toISOString();
  const payload = agent.buildHeartbeatPayload({
    runtime: {
      clientUuid: "browser-health-a",
      appVersion: "0.3.93",
      platform: "douyin",
      pageType: "search_results",
      detailReady: false,
      detailReadyReason: "dom_not_ready",
      lastUpdatedAt: Date.now() - 500,
      lastCaptureProgressAt: Date.now() - 1200,
      lastPageUrl: "https://www.douyin.com/search/private?cookie=secret",
      healthEvidence: {
        page: {
          status: "complete",
          discarded: false,
          frozen: true,
          fullUrl: "https://www.douyin.com/private/post/123",
          body: "private-post-body",
        },
        network: {
          status: "degraded",
          apiRttMs: 999999999,
          timeoutCount: 999999999,
          cookie: "private-cookie",
        },
        runtime: {
          eventLoopLagMs: 999999999,
          heapUsedMb: 999999999,
          heapLimitMb: 999999999,
          serviceWorkerRestartCount: 999999999,
          text: "private-post-text",
        },
      },
    },
    ledger: {
      runs: [{
        id: "health-task-1",
        taskType: "unattended_keyword_capture",
        platform: "douyin",
        status: "running",
        attemptId: "attempt-health-1",
        progressSeq: 7,
        businessProgressAt: progressAt,
        progress: {
          current: 4,
          total: 12,
          phase: "detail_capture",
        },
        stage: "comments",
      }],
    },
    unattendedRequest: {
      id: "health-task-1",
      attemptId: "attempt-health-1",
    },
  });

  const task = payload.tasks[0];
  assert.equal(payload.agent.capabilities.structuredTaskHealthV1, true);
  assert.equal(payload.agent.capabilities.dutyRecoveryLineageV1, true);
  assert.equal(task.appVersion, "0.3.93");
  assert.equal(task.attemptId, "attempt-health-1");
  assert.equal(task.stage, "comments");
  assert.equal(task.phase, "detail_capture");
  assert.equal(task.progressObserved.observed, true);
  assert.equal(task.progressObserved.sequence, 7);
  assert.equal(task.progressObserved.current, 4);
  assert.equal(task.progressObserved.total, 12);
  assert.equal(task.healthEvidence.page.platformMatchesTask, true);
  assert.equal(task.healthEvidence.page.tabStatus, "complete");
  assert.equal(task.healthEvidence.page.discarded, false);
  assert.equal(task.healthEvidence.page.frozen, true);
  assert.equal(task.healthEvidence.network.lastRequestLatencyMs, 120000);
  assert.equal(task.healthEvidence.network.timeoutCount, 1000000);
  assert.equal(task.healthEvidence.runtime.eventLoopLagMs, 120000);
  assert.equal(task.healthEvidence.runtime.heapUsedMb, 1024 * 1024);
  assert.equal(
    task.healthEvidence.runtime.serviceWorkerRestartCount,
    1000000,
  );

  const serializedHealth = JSON.stringify(task.healthEvidence);
  for (const forbidden of [
    "https://",
    "private-post-body",
    "private-post-text",
    "private-cookie",
    "cookie=secret",
  ]) {
    assert.equal(serializedHealth.includes(forbidden), false);
  }
  assert.ok(serializedHealth.length < 1800);
});

test("a completed cloud request becomes bounded network evidence on the next task heartbeat", async () => {
  const response = await agent.requestJson({
    token: "agent-network-health",
    endpoint: "/api/capture-cloud/agent/heartbeat",
    body: {tasks: []},
    baseUrls: ["https://voice.example.com"],
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ok: true, commands: []}),
    }),
  });
  assert.equal(response.ok, true);

  const payload = agent.buildHeartbeatPayload({
    runtime: {
      clientUuid: "browser-network-health",
      appVersion: "0.3.93",
      platform: "douyin",
      pageType: "search_results",
    },
    ledger: {runs: [{
      id: "network-health-task",
      attemptId: "network-health-attempt",
      status: "running",
    }]},
    unattendedRequest: {
      id: "network-health-task",
      attemptId: "network-health-attempt",
    },
  });
  const network = payload.tasks[0].healthEvidence.network;
  assert.equal(network.available, true);
  assert.equal(network.status, "success");
  assert.equal(network.endpointClass, "heartbeat");
  assert.ok(network.lastRequestLatencyMs >= 0);
  assert.ok(network.lastRequestLatencyMs <= 120000);
  assert.match(network.lastRequestAt, /^\d{4}-\d{2}-\d{2}T/u);
});

test("task health rejects URL, JWT, high-entropy and credential-shaped codes before transmission", () => {
  const isolatedAgent = loadAgentWithEnvironment();
  const payload = isolatedAgent.buildHeartbeatPayload({
    runtime: {
      clientUuid: "browser-bad-version",
      appVersion: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcml2YXRlIn0.signature123",
      pageType: "private/path",
      detailReadyReason: "0123456789abcdef0123456789abcdef01234567",
      healthEvidence: {
        network: {status: "secret_prod_ABC123"},
      },
    },
    ledger: {
      runs: [{
        id: "bad-version-task",
        attemptId: "bad-version-attempt",
        status: "running",
        stage: "apiKeyProdABC123",
        progress: {phase: "aB3dE5fG7hJ9kL1mN3pR5tV7xZ9cD2fH"},
      }],
    },
    unattendedRequest: {
      id: "bad-version-task",
      attemptId: "bad-version-attempt",
    },
  });

  assert.equal(payload.agent.appVersion, "");
  assert.equal(payload.tasks[0].appVersion, "");
  assert.equal(payload.tasks[0].stage, "unknown");
  assert.equal(payload.tasks[0].phase, "unknown");
  assert.equal(payload.tasks[0].healthEvidence.page.pageType, "unknown");
  assert.equal(payload.tasks[0].healthEvidence.page.detailReadyReason, "");
  assert.equal(
    payload.tasks[0].healthEvidence.network.status,
    "unavailable",
  );
  const serializedHealthChannel = JSON.stringify({
    agentVersion: payload.agent.appVersion,
    taskVersion: payload.tasks[0].appVersion,
    stage: payload.tasks[0].stage,
    phase: payload.tasks[0].phase,
    healthEvidence: payload.tasks[0].healthEvidence,
  });
  assert.doesNotMatch(
    serializedHealthChannel,
    /eyJhbGci|private\/path|secret_prod|apiKeyProd|aB3dE5fG|0123456789abcdef/iu,
  );
});

test("historical terminal attempts never inherit a newer runtime version or live health", async () => {
  let tabReads = 0;
  const isolatedAgent = loadAgentWithEnvironment({
    chrome: {
      tabs: {
        get: async () => {
          tabReads += 1;
          return {status: "complete", discarded: false, frozen: false};
        },
      },
    },
  });
  const payload = isolatedAgent.buildHeartbeatPayload({
    runtime: {
      clientUuid: "browser-upgraded-after-terminal",
      appVersion: "0.3.93",
      platform: "douyin",
      pageType: "search_results",
      lastActiveTabId: 99,
      healthEvidence: {
        network: {status: "success", apiRttMs: 12},
        runtime: {eventLoopLagMs: 3, heapUsedMb: 64},
      },
    },
    ledger: {
      runs: [{
        id: "old-terminal-attempt",
        attemptId: "old-attempt-1",
        attemptNumber: 1,
        status: "completed",
        platform: "douyin",
        runnerTabId: 99,
        appVersion: "0.3.92",
        healthEvidence: {
          page: {platform: "douyin", pageType: "note_detail", tabStatus: "complete"},
          network: {status: "degraded", lastRequestLatencyMs: 88},
          runtime: {eventLoopLagMs: 9, heapUsedMb: 48},
        },
      }],
    },
  });

  assert.equal(payload.tasks[0].appVersion, "0.3.92");
  assert.equal(payload.tasks[0].healthEvidence.page.pageType, "note_detail");
  assert.equal(payload.tasks[0].healthEvidence.network.status, "degraded");
  assert.equal(payload.tasks[0].healthEvidence.network.lastRequestLatencyMs, 88);
  assert.equal(payload.tasks[0].healthEvidence.runtime.eventLoopLagMs, 9);

  let transmitted;
  await isolatedAgent.sendHeartbeat({
    token: "history-health-token",
    body: payload,
    baseUrls: ["https://voice.example.com"],
    fetchImpl: async (_url, options) => {
      transmitted = JSON.parse(options.body);
      return {ok: true, status: 200, json: async () => ({ok: true})};
    },
  });
  assert.equal(tabReads, 0, "terminal attempts must not probe the current tab");
  assert.equal(transmitted.tasks[0].appVersion, "0.3.92");
  assert.equal(transmitted.tasks[0].healthEvidence.network.status, "degraded");
  assert.equal(
    Object.hasOwn(transmitted.tasks[0].healthEvidence.runtime, "cpuAvailable"),
    false,
  );
});

test("only the exact current attempt receives live health when two ledger attempts still say running", async () => {
  const isolatedAgent = loadAgentWithEnvironment({
    chrome: {
      tabs: {
        get: async () => ({status: "complete", discarded: false, frozen: false}),
      },
    },
  });
  const payload = isolatedAgent.buildHeartbeatPayload({
    runtime: {
      clientUuid: "browser-attempt-fence",
      appVersion: "0.3.93",
      platform: "douyin",
      pageType: "search_results",
      lastActiveTabId: 77,
      healthEvidence: {runtime: {eventLoopLagMs: 4}},
    },
    unattendedRequest: {
      id: "same-business-task",
      attemptId: "attempt-current",
    },
    ledger: {
      runs: [
        {
          id: "same-business-task",
          attemptId: "attempt-current",
          attemptNumber: 2,
          status: "running",
          updatedAt: "2026-08-25T02:00:00.000Z",
        },
        {
          id: "same-business-task",
          attemptId: "attempt-stale",
          attemptNumber: 1,
          status: "running",
          appVersion: "0.3.92",
          updatedAt: "2026-08-25T01:00:00.000Z",
        },
      ],
    },
  });
  const current = payload.tasks.find(task => task.attemptId === "attempt-current");
  const stale = payload.tasks.find(task => task.attemptId === "attempt-stale");
  assert.equal(current.appVersion, "0.3.93");
  assert.equal(current.healthEvidence.page.pageType, "search_results");
  assert.equal(stale.appVersion, "0.3.92");
  assert.equal(stale.healthEvidence.page.pageType, "unknown");

  let transmitted;
  await isolatedAgent.sendHeartbeat({
    token: "attempt-fence-token",
    body: payload,
    baseUrls: ["https://voice.example.com"],
    fetchImpl: async (_url, options) => {
      transmitted = JSON.parse(options.body);
      return {ok: true, status: 200, json: async () => ({ok: true})};
    },
  });
  const transmittedStale = transmitted.tasks.find(
    task => task.attemptId === "attempt-stale",
  );
  assert.equal(
    Object.hasOwn(transmittedStale.healthEvidence.runtime, "cpuAvailable"),
    false,
  );
});

test("sendHeartbeat samples runtime and tab lifecycle into every transmitted task with a short cache", async () => {
  let performanceNowCalls = 0;
  const tabCalls = [];
  const sampledAgent = loadAgentWithEnvironment({
    performance: {
      now: () => {
        performanceNowCalls += 1;
        return performanceNowCalls * 10;
      },
      memory: {
        usedJSHeapSize: 64 * 1024 * 1024,
        totalJSHeapSize: 96 * 1024 * 1024,
        jsHeapSizeLimit: 256 * 1024 * 1024,
      },
    },
    chrome: {
      tabs: {
        get: async (tabId) => {
          tabCalls.push(tabId);
          return {
            id: tabId,
            status: tabId === 42 ? "complete" : "loading",
            discarded: tabId !== 42,
            frozen: tabId === 42,
            url: `https://www.douyin.com/private/${tabId}?cookie=secret`,
            title: "private-post-title",
          };
        },
      },
    },
  });
  const payload = sampledAgent.buildHeartbeatPayload({
    runtime: {
      clientUuid: "browser-runtime-sampled",
      appVersion: "0.3.93",
      platform: "douyin",
      pageType: "search_results",
      lastActiveTabId: 99,
    },
    ledger: {
      runs: [
        {
          id: "sampled-task-a",
          attemptId: "sampled-attempt-a",
          status: "running",
          runnerTabId: 42,
        },
        {id: "sampled-task-b", status: "completed"},
      ],
    },
    unattendedRequest: {
      id: "sampled-task-a",
      attemptId: "sampled-attempt-a",
    },
  });
  const transmittedBodies = [];
  const send = async () =>
    await sampledAgent.sendHeartbeat({
      token: "agent-runtime-sampled",
      body: payload,
      baseUrls: ["https://voice.example.com"],
      fetchImpl: async (_url, options) => {
        transmittedBodies.push(JSON.parse(options.body));
        return {
          ok: true,
          status: 200,
          json: async () => ({ok: true, commands: []}),
        };
      },
    });

  assert.equal((await send()).ok, true);
  assert.equal((await send()).ok, true);
  assert.equal(performanceNowCalls, 4, "second send should reuse the 10s sample");
  assert.deepEqual(tabCalls, [42, 42]);

  const transmitted = transmittedBodies[0];
  assert.equal(transmitted.tasks.length, 2);
  for (const task of transmitted.tasks.slice(0, 1)) {
    assert.equal(task.healthEvidence.runtime.cpuAvailable, false);
    assert.equal(task.healthEvidence.runtime.eventLoopAvailable, true);
    assert.equal(task.healthEvidence.runtime.eventLoopSampleCount, 2);
    assert.equal(task.healthEvidence.runtime.eventLoopLagMs, 2);
    assert.equal(task.healthEvidence.runtime.heapAvailable, true);
    assert.equal(task.healthEvidence.runtime.heapUsedMb, 64);
    assert.equal(task.healthEvidence.runtime.heapTotalMb, 96);
    assert.equal(task.healthEvidence.runtime.heapLimitMb, 256);
    assert.match(task.healthEvidence.sampledAt, /^\d{4}-\d{2}-\d{2}T/u);
  }
  assert.equal(transmitted.tasks[0].healthEvidence.page.tabStatus, "complete");
  assert.equal(transmitted.tasks[0].healthEvidence.page.discarded, false);
  assert.equal(transmitted.tasks[0].healthEvidence.page.frozen, true);
  assert.equal(transmitted.tasks[1].healthEvidence.page.tabStatus, "unavailable");
  assert.equal(transmitted.tasks[1].healthEvidence.page.discarded, null);
  assert.equal(transmitted.tasks[1].healthEvidence.page.frozen, null);
  assert.equal(
    Object.hasOwn(transmitted.tasks[1].healthEvidence.runtime, "cpuAvailable"),
    false,
  );

  const serialized = JSON.stringify(transmitted);
  assert.equal(serialized.includes("https://"), false);
  assert.equal(serialized.includes("private-post-title"), false);
  assert.equal(serialized.includes("cookie=secret"), false);
});

test("heartbeat body does not include the cloud credential", () => {
  const payload = agent.buildHeartbeatPayload({
    runtime: {clientUuid: "profile", captureAgentToken: "must-not-leak"},
    ledger: {
      runs: [{
        id: "sensitive-task",
        message: "Bearer abc.def",
        metadata: {
          activationCode: "ACT-DEMO",
          authCode: "AUTH-DEMO",
          captureAgentToken: "AGENT-DEMO",
          safe: "visible",
        },
      }],
    },
  });
  const serialized = JSON.stringify(payload);
  for (const secret of ["must-not-leak", "ACT-DEMO", "AUTH-DEMO", "AGENT-DEMO", "abc.def"]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.equal(Object.hasOwn(payload.agent, "token"), false);
  assert.equal(payload.tasks[0].metadata.activationCode, "[REDACTED]");
  assert.equal(payload.tasks[0].metadata.safe, "visible");
});

test("heartbeat reports targeted post item results and resumable checkpoint", () => {
  const payload = agent.buildHeartbeatPayload({
    runtime: {clientUuid: "profile-targeted"},
    targetedPostRequest: {
      id: "targeted-request-1",
      taskId: "targeted-task-1",
      attemptId: "attempt-1",
      workflow: "negative_post_patrol",
      protocolVersion: 1,
      platform: "douyin",
      status: "running",
      progress: {current: 1, total: 2},
      checkpoint: {
        nextOrdinal: 2,
        completedItemIds: ["item-1"],
      },
      targetResults: [
        {
          itemId: "item-1",
          recordId: "record-1",
          externalId: "123",
          status: "completed",
        },
      ],
    },
  });
  assert.equal(payload.tasks[0].id, "targeted-request-1");
  assert.equal(payload.tasks[0].taskType, "negative_post_patrol");
  assert.equal(payload.tasks[0].workflow, "negative_post_patrol");
  assert.equal(payload.tasks[0].protocolVersion, 1);
  assert.equal(payload.tasks[0].targetResults[0].itemId, "item-1");
  assert.deepEqual(
    plain(payload.tasks[0].checkpoint.completedItemIds),
    ["item-1"],
  );
});

test("the live targeted request replaces a same-id compact ledger snapshot", () => {
  const payload = agent.buildHeartbeatPayload({
    runtime: {clientUuid: "profile-targeted-reconcile"},
    ledger: {
      runs: [{
        id: "targeted-request-same-id",
        taskType: "negative_post_patrol",
        status: "running",
        checkpoint: {processedCount: 0, total: 2},
        metadata: {workflow: "negative_post_patrol"},
      }],
    },
    targetedPostRequest: {
      id: "targeted-request-same-id",
      taskId: "targeted-task-same-id",
      attemptId: "targeted-attempt-same-id",
      workflow: "negative_post_patrol",
      protocolVersion: 1,
      platform: "douyin",
      status: "running",
      checkpoint: {
        nextOrdinal: 2,
        processedCount: 1,
        completedItemIds: ["item-live-1"],
        total: 2,
      },
      targetResults: [{
        itemId: "item-live-1",
        recordId: "record-live-1",
        externalId: "live-1",
        status: "completed",
      }],
    },
  });

  const matchingTasks = payload.tasks.filter(
    (task) => task.id === "targeted-request-same-id",
  );
  assert.equal(matchingTasks.length, 1);
  assert.equal(matchingTasks[0].targetResults[0].itemId, "item-live-1");
  assert.equal(matchingTasks[0].checkpoint.processedCount, 1);
  assert.deepEqual(
    plain(matchingTasks[0].checkpoint.completedItemIds),
    ["item-live-1"],
  );
});

test("a physical targeted ledger row and its live request report one business task", () => {
  const logicalRequestId = "54c0b3fd-a7f8-41a3-94f6-a3bd0e3cd018";
  const attemptId = "16249468-e006-4c97-af3c-773691dbda65";
  const payload = agent.buildHeartbeatPayload({
    runtime: {clientUuid: "profile-targeted-physical-id"},
    ledger: {
      runs: [{
        id: `${logicalRequestId}::${attemptId}`,
        taskType: "official_account_comment_patrol",
        platform: "douyin",
        status: "failed",
        attemptId,
        attemptNumber: 1,
        checkpoint: {processedCount: 1, total: 1},
        metadata: {
          workflow: "official_account_comment_patrol",
          logicalRequestId,
          attemptId,
        },
        updatedAt: "2026-08-03T05:01:40.716Z",
      }],
    },
    targetedPostRequest: {
      id: logicalRequestId,
      taskId: logicalRequestId,
      attemptId,
      attemptNumber: 1,
      workflow: "official_account_comment_patrol",
      protocolVersion: 1,
      platform: "douyin",
      status: "failed",
      checkpoint: {
        processedCount: 1,
        failedCount: 1,
        total: 1,
      },
      targetResults: [{
        itemId: "official-account-1",
        status: "failed",
        error: {code: "TASK_TAB_GROUP_UNAVAILABLE"},
      }],
    },
  });

  assert.equal(payload.tasks.length, 1);
  assert.equal(payload.tasks[0].id, logicalRequestId);
  assert.equal(payload.tasks[0].attemptId, attemptId);
  assert.equal(payload.tasks[0].targetResults.length, 1);
  assert.equal(
    payload.tasks[0].targetResults[0].error.code,
    "TASK_TAB_GROUP_UNAVAILABLE",
  );
  assert.equal(payload.tasks[0].checkpoint.failedCount, 1);
});

test("a historical physical targeted ledger row reports the canonical business id", () => {
  const logicalRequestId = "42b03c27-d266-488c-9b87-7ac4e96ae058";
  const attemptId = "3492ba37-1863-492b-81c1-0e39193396bd";
  const payload = agent.buildHeartbeatPayload({
    runtime: {clientUuid: "profile-targeted-history"},
    ledger: {
      runs: [{
        id: `${logicalRequestId}::${attemptId}`,
        taskType: "official_account_comment_patrol",
        platform: "xiaohongshu",
        status: "failed",
        attemptId,
        attemptNumber: 1,
        metadata: {
          workflow: "official_account_comment_patrol",
          logicalRequestId,
          attemptId,
        },
        updatedAt: "2026-08-03T05:05:07.183Z",
      }],
    },
  });

  assert.equal(payload.tasks.length, 1);
  assert.equal(payload.tasks[0].id, logicalRequestId);
  assert.equal(payload.tasks[0].attemptId, attemptId);
  assert.equal(payload.tasks[0].controlTaskId, "");
});

test("canonical targeted task ids retain distinct historical attempts", () => {
  const logicalRequestId = "targeted-request-with-retries";
  const payload = agent.buildHeartbeatPayload({
    runtime: {clientUuid: "profile-targeted-attempt-history"},
    ledger: {
      runs: [
        {
          id: `${logicalRequestId}::attempt-2`,
          taskType: "official_account_comment_patrol",
          status: "completed",
          attemptId: "attempt-2",
          attemptNumber: 2,
          metadata: {
            workflow: "official_account_comment_patrol",
            logicalRequestId,
          },
          updatedAt: "2026-08-03T06:00:00.000Z",
        },
        {
          id: `${logicalRequestId}::attempt-1`,
          taskType: "official_account_comment_patrol",
          status: "failed",
          attemptId: "attempt-1",
          attemptNumber: 1,
          metadata: {
            workflow: "official_account_comment_patrol",
            logicalRequestId,
          },
          updatedAt: "2026-08-03T05:00:00.000Z",
        },
      ],
    },
  });

  assert.deepEqual(
    plain(payload.tasks.map((task) => ({
      id: task.id,
      attemptId: task.attemptId,
      attemptNumber: task.attemptNumber,
    }))),
    [
      {id: logicalRequestId, attemptId: "attempt-2", attemptNumber: 2},
      {id: logicalRequestId, attemptId: "attempt-1", attemptNumber: 1},
    ],
  );
});

test("heartbeat preserves the official-account comment patrol workflow and capability", () => {
  const payload = agent.buildHeartbeatPayload({
    runtime: {clientUuid: "profile-official-comments"},
    targetedPostRequest: {
      id: "official-request-1",
      taskId: "official-task-1",
      workflow: "official_account_comment_patrol",
      protocolVersion: 1,
      targetMode: "profile",
      profileMode: true,
      subjectType: "official",
      platform: "xiaohongshu",
      status: "running",
      targets: [{
        itemId: "item-1",
        subscriptionId: "subscription-1",
        accountUrl: "https://www.xiaohongshu.com/user/profile/official-1",
      }],
      monitorSettings: {postsLimit: 30},
      captureSettings: {
        includeComments: true,
        scanLatestPostsByCount: true,
      },
      targetResults: [{
        itemId: "item-1",
        recordId: "post-1",
        externalId: "note-1",
        workflow: "official_account_comment_patrol",
        status: "completed_with_warnings",
        commentObservation: {observedCount: 8, scope: "visible_comments_bounded"},
      }],
    },
  });

  assert.equal(payload.agent.capabilities.negativePostPatrol, true);
  assert.equal(payload.agent.capabilities.officialAccountCommentPatrol, true);
  assert.equal(
    payload.agent.capabilities.officialAccountCommentPatrolProfileV1,
    true,
  );
  assert.equal(
    payload.agent.capabilities.officialAccountLatestPostsByCountV1,
    true,
  );
  assert.equal(payload.tasks[0].taskType, "official_account_comment_patrol");
  assert.equal(payload.tasks[0].workflow, "official_account_comment_patrol");
  assert.equal(payload.tasks[0].targetMode, "profile");
  assert.equal(payload.tasks[0].profileMode, true);
  assert.equal(payload.tasks[0].subjectType, "official");
  assert.equal(payload.tasks[0].monitorSettings.postsLimit, 30);
  assert.equal(
    payload.tasks[0].captureSettings.scanLatestPostsByCount,
    true,
  );
  assert.equal(payload.tasks[0].targets[0].subscriptionId, "subscription-1");
  assert.equal(payload.tasks[0].targetResults[0].workflow, "official_account_comment_patrol");
  assert.equal(payload.tasks[0].targetResults[0].commentObservation.observedCount, 8);
});

test("heartbeat distinguishes creator scan and official post discovery capabilities", () => {
  const creator = agent.buildHeartbeatPayload({
    runtime: {clientUuid: "profile-creator-scan"},
    targetedPostRequest: {
      id: "creator-scan-1",
      taskId: "creator-task-1",
      workflow: "followed_creator_post_patrol",
      protocolVersion: 1,
      platform: "xiaohongshu",
      title: "关注博主作品扫描",
      status: "running",
      targetResults: [],
    },
  });
  assert.equal(creator.agent.capabilities.followedCreatorPostPatrol, true);
  assert.equal(creator.agent.capabilities.officialAccountPostDiscovery, true);
  assert.equal(creator.tasks[0].taskType, "followed_creator_post_patrol");
  assert.equal(creator.tasks[0].title, "关注博主作品扫描");

  const official = agent.buildHeartbeatPayload({
    runtime: {clientUuid: "profile-official-discovery"},
    targetedPostRequest: {
      id: "official-discovery-1",
      taskId: "official-discovery-task-1",
      workflow: "official_account_post_discovery",
      protocolVersion: 1,
      platform: "douyin",
      status: "running",
      targetResults: [],
    },
  });
  assert.equal(official.tasks[0].taskType, "official_account_post_discovery");
  assert.equal(official.tasks[0].title, "官方账号作品发现");
});

test("heartbeat reports social identity and idempotent usage without phone numbers", () => {
  const payload = agent.buildHeartbeatPayload({
    runtime: {clientUuid: "profile-social"},
    observedSocialAccounts: [{
      platform: "douyin",
      platformAccountId: "account-a",
      accountHandle: "handle-a",
      displayName: "账号 A",
      registeredPhone: "13800000000",
      loginState: "authenticated",
      observedAt: "2026-07-25T03:00:00.000Z",
    }],
    socialUsageEvents: [{
      eventId: "usage-a",
      platform: "douyin",
      searches: 1,
      enhancements: 2,
      captureRuns: 3,
      capturedItems: 20,
      succeeded: true,
      safetyVerification: true,
      occurredAt: "2026-07-25T03:01:00.000Z",
      accountIdentity: {
        platformAccountId: "account-a",
        accountHandle: "handle-a",
        displayName: "账号 A",
        confidence: "high",
      },
      metadata: {
        action: "captureKeywordNotes",
        token: "must-not-leak",
      },
    }],
  });

  assert.equal(payload.agent.capabilities.socialAccountIdentity, true);
  assert.equal(payload.agent.capabilities.socialAccountDailyUsage, true);
  assert.equal(payload.observedSocialAccounts.length, 1);
  assert.equal(payload.observedSocialAccounts[0].platformAccountId, "account-a");
  assert.equal(Object.hasOwn(payload.observedSocialAccounts[0], "registeredPhone"), false);
  assert.equal(payload.socialUsageEvents[0].eventId, "usage-a");
  assert.equal(payload.socialUsageEvents[0].safetyVerification, true);
  assert.equal(
    payload.socialUsageEvents[0].accountIdentity.confidence,
    "high",
  );
  assert.equal(payload.socialUsageEvents[0].metadata.token, "[REDACTED]");
  assert.equal(JSON.stringify(payload).includes("13800000000"), false);
  assert.equal(JSON.stringify(payload).includes("must-not-leak"), false);
});

test("heartbeat removes reserved placeholder identities without dropping usage", () => {
  const payload = agent.buildHeartbeatPayload({
    runtime: {clientUuid: "profile-social-reserved"},
    socialUsageEvents: [{
      eventId: "usage-reserved",
      platform: "douyin",
      searches: 1,
      occurredAt: "2026-07-27T03:01:00.000Z",
      accountIdentity: {
        platformAccountId: "self",
        accountHandle: "@self",
        confidence: "high",
      },
    }],
  });
  assert.equal(payload.socialUsageEvents.length, 1);
  assert.equal(payload.socialUsageEvents[0].accountIdentity, null);
});

test("heartbeat advertises remote task creation and mirrors a sanitized unattended plan", () => {
  const keywords = Array.from({length: 35}, (_, index) => ` keyword-${index + 1} `);
  const payload = agent.buildHeartbeatPayload({
    runtime: {clientUuid: "browser-profile-plan"},
    unattendedPlan: {
      enabled: true,
      platform: "douyin",
      mode: "daily",
      startTime: "08:30",
      randomOffsetMin: 12,
      keywords,
      keywordMaxDetectedItems: 275,
      searchFilters: {
        sort: "latest",
        publishTime: "week",
        cookie: "must-not-leak-cookie",
      },
      searchPasses: ["all", "video", "video"],
      captureSettings: {
        autoDetailCaptureAfterListCapture: true,
        autoSyncAfterDetailCapture: true,
        enableAiRelevancePrefilter: true,
        includeBloggerMetricsOnDetailCapture: true,
        enableLowFollowerHitFilterOnDetailCapture: true,
        lowFollowerHitThresholdOnDetailCapture: 8000,
        includeCommentsOnDetailCapture: true,
        detailCommentsMaxDetectedItems: 1000,
        enableCommentLeadsFilterOnDetailCapture: true,
        skipAlreadyCapturedOnDetailCapture: true,
        token: "must-not-leak-capture-token",
      },
      autoLoop: true,
      roundGapMin: 15,
      maxRounds: 3,
      customDates: "2026-07-22\n2026-07-23",
      nextRunAt: "2026-07-22T00:30:00.000Z",
      lastRunStatus: "completed",
      lastRunMessage: "Authorization=Bearer must-not-leak-bearer",
      updatedAt: "2026-07-21T03:00:00.000Z",
    },
  });

  assert.equal(payload.agent.capabilities.remoteTaskCreate, true);
  assert.equal(payload.agent.capabilities.remoteStop, true);
  assert.equal(payload.agent.capabilities.remoteUnattendedPlanWrite, true);
  assert.equal(payload.agent.capabilities.remoteUnattendedPlanDelete, true);
  assert.equal(payload.agent.capabilities.remoteTaskEnhancementOptions, true);
  assert.equal(payload.agent.capabilities.remoteTaskKeywordPostLimit, true);
  assert.equal(payload.agent.capabilities.remoteSequentialSearchPassesV1, true);
  assert.equal(payload.agent.capabilities.negativePostPatrol, true);
  assert.equal(payload.agent.capabilities.remoteTargetedPostCaptureV1, true);
  assert.equal(payload.agent.capabilities.unattendedPlanMirror, true);
  assert.equal(payload.unattendedPlan.configured, true);
  assert.equal(payload.unattendedPlan.enabled, true);
  assert.equal(payload.unattendedPlan.platform, "douyin");
  assert.equal(payload.unattendedPlan.mode, "daily");
  assert.equal(payload.unattendedPlan.startTime, "08:30");
  assert.equal(payload.unattendedPlan.keywordMaxDetectedItems, 275);
  assert.equal(payload.unattendedPlan.keywords.length, 30);
  assert.deepEqual(
    plain(payload.unattendedPlan.keywords.slice(0, 2)),
    ["keyword-1", "keyword-2"],
  );
  assert.deepEqual(plain(payload.unattendedPlan.searchFilters), {
    sort: "latest",
    publishTime: "week",
    cookie: "[REDACTED]",
  });
  assert.deepEqual(plain(payload.unattendedPlan.searchPasses), ["all", "video"]);
  assert.deepEqual(plain(payload.unattendedPlan.captureSettings), {
    autoDetailCaptureAfterListCapture: true,
    autoSyncAfterDetailCapture: true,
    enableAiRelevancePrefilter: true,
    includeBloggerMetricsOnDetailCapture: true,
    enableLowFollowerHitFilterOnDetailCapture: true,
    lowFollowerHitThresholdOnDetailCapture: 8000,
    includeCommentsOnDetailCapture: true,
    detailCommentsMaxDetectedItems: 1000,
    enableCommentLeadsFilterOnDetailCapture: true,
    skipAlreadyCapturedOnDetailCapture: true,
  });
  const serialized = JSON.stringify(payload.unattendedPlan);
  assert.equal(serialized.includes("must-not-leak-cookie"), false);
  assert.equal(serialized.includes("must-not-leak-bearer"), false);
  assert.equal(serialized.includes("must-not-leak-capture-token"), false);
});

test("plan mirroring omits missing or invalid keyword post-limit overrides", () => {
  for (const plan of [
    {enabled: true, platform: "douyin", keywords: ["旧计划"]},
    {
      enabled: true,
      platform: "douyin",
      keywords: ["非法上限"],
      keywordMaxDetectedItems: 0,
    },
  ]) {
    const payload = agent.buildHeartbeatPayload({
      runtime: {clientUuid: "browser-profile-legacy-plan"},
      unattendedPlan: plan,
    });
    assert.equal(
      Object.hasOwn(payload.unattendedPlan, "keywordMaxDetectedItems"),
      false,
    );
  }
});

test("plan mirroring omits missing and empty capture settings", () => {
  const missingPayload = agent.buildHeartbeatPayload({
    runtime: {clientUuid: "browser-profile-plan-without-capture-settings"},
    unattendedPlan: {
      enabled: true,
      platform: "douyin",
      keywords: ["旧计划"],
    },
  });
  const emptyPayload = agent.buildHeartbeatPayload({
    runtime: {clientUuid: "browser-profile-plan-with-empty-capture-settings"},
    unattendedPlan: {
      enabled: true,
      platform: "douyin",
      keywords: ["空增强配置"],
      captureSettings: {},
    },
  });

  assert.equal(Object.hasOwn(missingPayload.unattendedPlan, "captureSettings"), false);
  assert.equal(Object.hasOwn(emptyPayload.unattendedPlan, "captureSettings"), false);
});

test("historical tasks do not invent a remote-control id", () => {
  const payload = agent.buildHeartbeatPayload({
    runtime: {clientUuid: "profile"},
    ledger: {runs: [{id: "historical", status: "failed"}]},
  });
  assert.equal(payload.tasks[0].controlTaskId, "");
});

test("cloud bearer tokens are never replayed to another trust origin", async () => {
  const calls = [];
  const result = await agent.requestJson({
    token: "agent-secret",
    endpoint: "/api/capture-cloud/agent/heartbeat",
    body: {tasks: []},
    baseUrls: ["https://old.example", "https://new.example"],
    fetchImpl: async (url, options) => {
      calls.push({url, options});
      if (url.startsWith("https://old.example")) {
        return {ok: false, status: 404, json: async () => ({ok: false})};
      }
      return {ok: true, status: 200, json: async () => ({ok: true, commands: []})};
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "endpoint_missing");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.Authorization, "Bearer agent-secret");
  assert.equal(calls[0].url, "https://old.example/api/capture-cloud/agent/heartbeat");
});

test("runtime targets select exactly one trusted production or local heartbeat origin", async () => {
  for (const [runtimeConfig, expectedUrl] of [
    [productionRuntimeConfig, "https://voice.minilife.online/api/capture-cloud/agent/heartbeat"],
    [localRuntimeConfig, "http://localhost:3001/api/capture-cloud/agent/heartbeat"],
  ]) {
    const configuredAgent = loadAgentWithRuntimeConfig(runtimeConfig);
    const calls = [];
    const result = await configuredAgent.sendHeartbeat({
      token: "agent-secret",
      body: {tasks: []},
      fetchImpl: async (url) => {
        calls.push(url);
        return {ok: true, status: 200, json: async () => ({ok: true, commands: []})};
      },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [expectedUrl]);
  }
});
