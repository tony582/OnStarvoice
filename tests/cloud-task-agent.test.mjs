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

test("heartbeat preserves the official-account comment patrol workflow and capability", () => {
  const payload = agent.buildHeartbeatPayload({
    runtime: {clientUuid: "profile-official-comments"},
    targetedPostRequest: {
      id: "official-request-1",
      taskId: "official-task-1",
      workflow: "official_account_comment_patrol",
      protocolVersion: 1,
      platform: "xiaohongshu",
      status: "running",
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
  assert.equal(payload.tasks[0].taskType, "official_account_comment_patrol");
  assert.equal(payload.tasks[0].workflow, "official_account_comment_patrol");
  assert.equal(payload.tasks[0].targetResults[0].workflow, "official_account_comment_patrol");
  assert.equal(payload.tasks[0].targetResults[0].commentObservation.observedCount, 8);
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
