import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import test from "node:test";
import vm from "node:vm";
import {fileURLToPath} from "node:url";

import {
  ensureCurrentSocialAccount,
  hasDurableSocialAccountIdentity,
  isReservedPlatformAccountId as isReservedServerAccountId,
  isTrustedSocialAccountObservation,
  normalizeObservedSocialAccount,
  normalizeSocialUsageEvent,
  normalizeSocialUsageEvents,
  processSocialAccountHeartbeat,
  socialAccountIdentityMatchesAccount,
} from "../server/services/social-account-usage.js";
import {
  extractPlatformAccountId,
  isReservedPlatformAccountId,
  normalizeSocialPlatform,
} from "../utils/social-account-identity.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function source(path) {
  return await readFile(resolve(repoRoot, path), "utf8");
}

async function loadUsageUtility() {
  const code = await source("utils/social-account-usage.js");
  const context = vm.createContext({
    Date,
    Math,
    crypto: {randomUUID: () => "usage-event-1"},
  });
  vm.runInContext(code, context, {filename: "utils/social-account-usage.js"});
  return context.OnStarvoiceSocialAccountUsage;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("platform account ids are extracted only from supported profile urls", () => {
  assert.equal(normalizeSocialPlatform("Douyin"), "douyin");
  assert.equal(
    extractPlatformAccountId(
      "xiaohongshu",
      "https://www.xiaohongshu.com/user/profile/65abc?xsec_token=secret",
    ),
    "65abc",
  );
  assert.equal(
    extractPlatformAccountId(
      "douyin",
      "https://www.douyin.com/user/MS4wLjABAAAA-example",
    ),
    "MS4wLjABAAAA-example",
  );
  assert.equal(
    extractPlatformAccountId("weibo", "https://weibo.com/u/1234567890"),
    "1234567890",
  );
  assert.equal(
    extractPlatformAccountId(
      "douyin",
      "https://www.douyin.com/video/1234567890",
    ),
    "",
  );
  assert.equal(
    extractPlatformAccountId("douyin", "https://www.douyin.com/user/self"),
    "",
  );
  assert.equal(isReservedPlatformAccountId("@self"), true);
  assert.equal(isReservedServerAccountId("SELF"), true);
});

test("extension usage events distinguish search, enhancement, runs, and captured items", async () => {
  const usage = await loadUsageUtility();
  const event = usage.buildUsageEventFromRelay({
    action: "captureKeywordNotes",
    platform: "xiaohongshu",
    response: {
      ok: true,
      data: {items: [{id: "a"}, {id: "b"}]},
    },
    taskId: "task-a",
    observedAccount: {
      platformAccountId: "account-a",
      accountHandle: "starvoice-a",
      displayName: "账号 A",
      confidence: "high",
      observedAt: "2026-07-25T04:00:00.000Z",
    },
  });

  assert.deepEqual(plain(event), {
    eventId: "usage-event-1",
    platform: "xiaohongshu",
    searches: 1,
    enhancements: 0,
    captureRuns: 1,
    capturedItems: 2,
    succeeded: true,
    safetyVerification: false,
    occurredAt: event.occurredAt,
    accountIdentity: {
      platformAccountId: "account-a",
      accountHandle: "starvoice-a",
      displayName: "账号 A",
      confidence: "high",
      observedAt: "2026-07-25T04:00:00.000Z",
    },
    metadata: {
      action: "captureKeywordNotes",
      taskId: "task-a",
      featureKey: "",
      errorCode: "",
    },
  });

  const enhancement = usage.buildUsageEventFromRelay({
    action: "captureSingleNote",
    platform: "douyin",
    response: {ok: true, data: {}},
  });
  assert.equal(enhancement.searches, 0);
  assert.equal(enhancement.enhancements, 1);
  assert.equal(enhancement.captureRuns, 0);
  assert.equal(enhancement.capturedItems, 1);
});

test("display name alone is not used as a durable account identity", async () => {
  const usage = await loadUsageUtility();
  const event = usage.buildUsageEventFromRelay({
    action: "captureKeywordNotes",
    platform: "xiaohongshu",
    response: {ok: true, data: {items: []}},
    observedAccount: {displayName: "页面里可能重复出现的昵称"},
  });
  assert.equal(event.accountIdentity, null);
});

test("extension usage events preserve explicit platform safety evidence", async () => {
  const usage = await loadUsageUtility();
  const event = usage.buildUsageEventFromRelay({
    action: "captureKeywordNotes",
    platform: "douyin",
    response: {
      ok: false,
      platformSafetyBlocked: true,
      error: {
        code: "SECURITY_VERIFICATION_REQUIRED",
        message: "检测到抖音图片安全验证",
      },
    },
  });
  assert.equal(event.safetyVerification, true);
  assert.equal(event.succeeded, false);

  const thrownError = new Error("当前页面触发安全验证");
  const thrownEvent = usage.buildUsageEventFromRelay({
    action: "captureKeywordNotes",
    platform: "xiaohongshu",
    error: thrownError,
  });
  assert.equal(thrownEvent.safetyVerification, true);
});

test("offline usage queue is idempotent and acknowledges only accepted event ids", async () => {
  const usage = await loadUsageUtility();
  const first = {eventId: "event-1", platform: "douyin", captureRuns: 1};
  const second = {eventId: "event-2", platform: "douyin", captureRuns: 1};
  const queue = usage.appendUsageEvent(
    usage.appendUsageEvent([], first),
    second,
  );
  const duplicate = usage.appendUsageEvent(queue, first);
  assert.deepEqual(
    plain(duplicate.map(event => event.eventId)),
    ["event-2", "event-1"],
  );
  assert.deepEqual(
    plain(
      usage
        .acknowledgeUsageEvents(duplicate, ["event-1"])
        .map(event => event.eventId),
    ),
    ["event-2"],
  );
});

test("server normalizes identity snapshots and uses the Shanghai usage day", () => {
  const observed = normalizeObservedSocialAccount({
    platform: "douyin",
    platformAccountId: "account-a",
    displayName: "账号 A",
    loginState: "authenticated",
    observedAt: "2026-07-25T15:59:59.000Z",
  });
  assert.equal(observed.platform, "douyin");
  assert.equal(observed.platformAccountId, "account-a");
  assert.equal(hasDurableSocialAccountIdentity(observed), true);
  assert.equal(isTrustedSocialAccountObservation(observed), false);

  const reserved = normalizeObservedSocialAccount({
    platform: "douyin",
    platformAccountId: "self",
    accountHandle: "@self",
    loginState: "authenticated",
    confidence: "high",
  });
  assert.equal(reserved.platformAccountId, "");
  assert.equal(reserved.accountHandle, "");
  assert.equal(hasDurableSocialAccountIdentity(reserved), false);
  assert.equal(isTrustedSocialAccountObservation(reserved), false);

  const trusted = normalizeObservedSocialAccount({
    platform: "douyin",
    platformAccountId: "account-b",
    confidence: "high",
  });
  assert.equal(isTrustedSocialAccountObservation(trusted), true);
  assert.equal(
    isTrustedSocialAccountObservation({
      ...trusted,
      confidence: "medium",
    }),
    true,
  );
  assert.equal(
    socialAccountIdentityMatchesAccount(
      {
        platformAccountId: "new-stable-id",
        accountHandle: "same-handle",
      },
      {
        platform_account_id: "",
        account_handle: "same-handle",
      },
    ),
    true,
  );

  const event = normalizeSocialUsageEvent(
    {
      eventId: "event-a",
      platform: "douyin",
      searches: 1,
      captureRuns: 1,
      occurredAt: "2026-07-25T16:01:00.000Z",
      accountIdentity: {
        platformAccountId: "account-a",
        displayName: "账号 A",
      },
    },
    Date.parse("2026-07-25T16:02:00.000Z"),
  );
  assert.equal(event.usageDate, "2026-07-26");
  assert.equal(event.accountIdentity.platformAccountId, "account-a");
  assert.equal(
    normalizeSocialUsageEvents([event, event], Date.parse("2026-07-25T16:02:00.000Z")).length,
    1,
  );
});

test("account overview returns usage dates without UTC day rollover", async () => {
  const route = await source("server/routes/social-accounts.js");
  assert.match(
    route,
    /du\.usage_date::text AS usage_date/u,
  );
  assert.match(
    route,
    /String\(row\.usage_date\) === today/u,
  );
});

test("manual Agent binding cannot be overwritten by a conflicting heartbeat", async () => {
  const executed = [];
  const tx = {
    async queryOne(sql) {
      if (sql.includes("FROM social_account_bindings b")) {
        return {
          binding_id: "binding-manual",
          social_account_id: "account-manual",
          binding_source: "extension",
          platform_account_id: "earth-account",
          account_handle: "earth",
          display_name: "地球",
          identity_source: "extension",
          agent_binding_mode: "manual",
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    async execute(sql, params) {
      executed.push({sql, params});
      return null;
    },
  };
  const result = await ensureCurrentSocialAccount(
    tx,
    {id: "agent-earth", tenant_id: "tenant-a"},
    "douyin",
    {
      platform: "douyin",
      platformAccountId: "mars-account",
      accountHandle: "mars",
      loginState: "authenticated",
      confidence: "high",
      observedAt: "2026-07-27T03:00:00.000Z",
    },
  );
  assert.equal(result, null);
  assert.equal(executed.length, 1);
  assert.match(executed[0].sql, /metadata = metadata/u);
  assert.equal(
    JSON.parse(executed[0].params[0]).identityConflict,
    true,
  );
});

test("unbound Agent usage is persisted and acknowledged without an account", async () => {
  const executed = [];
  const tx = {
    async queryOne(sql) {
      if (sql.includes("FROM social_account_bindings b")) return null;
      if (sql.includes("INSERT INTO social_account_usage_events")) {
        return {id: 1};
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    async execute(sql, params) {
      executed.push({sql, params});
      return null;
    },
  };
  const result = await processSocialAccountHeartbeat(tx, {
    agent: {id: "agent-unassigned", tenant_id: "tenant-a"},
    usageEvents: [{
      eventId: "usage-unassigned",
      platform: "douyin",
      searches: 1,
      occurredAt: "2026-07-27T03:01:00.000Z",
      accountIdentity: {
        platformAccountId: "account-unconfirmed",
        confidence: "low",
      },
    }],
  });
  assert.deepEqual(result.acceptedUsageEventIds, ["usage-unassigned"]);
  assert.equal(executed.length, 1);
  assert.match(executed[0].sql, /INSERT INTO social_agent_daily_usage/u);
  assert.equal(executed[0].params[1], "agent-unassigned");
});

test("schema, heartbeat, tenant api, and admin page are wired as one Agent-first daily-health flow", async () => {
  const [
    migration,
    agentDailyMigration,
    bindingModeMigration,
    captureRoute,
    accountRoute,
    serverIndex,
    background,
    cloudAgent,
    page,
    desktop,
    mobile,
    navigation,
  ] = await Promise.all([
    source("server/db/migrations/045_social_account_usage.sql"),
    source("server/db/migrations/063_social_agent_daily_health.sql"),
    source("server/db/migrations/047_social_account_binding_mode.sql"),
    source("server/routes/capture-cloud.js"),
    source("server/routes/social-accounts.js"),
    source("server/index.js"),
    source("background.js"),
    source("utils/cloud-task-agent.js"),
    source("web/admin/src/pages/SocialAccountsPage.tsx"),
    source("web/admin/src/desktop/DesktopApp.tsx"),
    source("web/admin/src/mobile/MobileApp.tsx"),
    source("web/admin/src/lib/navigation.tsx"),
  ]);

  for (const table of [
    "social_accounts",
    "social_account_bindings",
    "social_account_usage_events",
    "social_account_daily_usage",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(migration, /UNIQUE \(tenant_id, event_id\)/u);
  assert.match(agentDailyMigration, /ALTER COLUMN social_account_id DROP NOT NULL/u);
  assert.match(agentDailyMigration, /CREATE TABLE IF NOT EXISTS social_agent_daily_usage/u);
  assert.match(agentDailyMigration, /Asia\/Shanghai/u);
  assert.match(agentDailyMigration, /ALTER COLUMN agent_binding_mode SET DEFAULT 'manual'/u);
  assert.match(agentDailyMigration, /WHERE agent_binding_mode <> 'manual'/u);
  assert.match(bindingModeMigration, /agent_binding_mode/u);
  assert.match(bindingModeMigration, /'auto', 'manual'/u);
  assert.match(bindingModeMigration, /invalidIdentityArchived/u);
  assert.match(bindingModeMigration, /binding\.source = 'manual'/u);
  assert.match(captureRoute, /processSocialAccountHeartbeat/u);
  assert.match(captureRoute, /acceptedSocialUsageEventIds/u);
  assert.match(accountRoute, /router\.get\(\s*'\/overview'/u);
  assert.match(accountRoute, /registered_phone/u);
  assert.match(accountRoute, /FROM social_agent_daily_usage du/u);
  assert.match(accountRoute, /today_safety_verifications/u);
  assert.match(accountRoute, /task\.source_updated_at/u);
  assert.match(accountRoute, /task\.error::text ~\* \$2/u);
  assert.match(accountRoute, /router\.put\(\s*'\/:id\/bindings'/u);
  assert.match(accountRoute, /agent_binding_mode = \$1/u);
  assert.match(accountRoute, /bindingModeAtUnbind', \$5::text/u);
  assert.match(accountRoute, /lockCaptureAgentExecutionSlot/u);
  assert.match(
    accountRoute,
    /status IN \('active', 'paused'\)/u,
    "migrated and revoked Agents must not be offered for social-account binding",
  );
  assert.doesNotMatch(accountRoute, /status <> 'revoked'/u);
  assert.match(serverIndex, /app\.use\('\/api\/social-accounts', socialAccountsRouter\)/u);
  assert.match(background, /onstarvoice\.socialAccountUsageQueue/u);
  assert.match(background, /recordSocialAccountUsageFromRelay/u);
  assert.match(background, /acknowledgeSocialAccountUsageEvents/u);
  assert.match(background, /SOCIAL_ACCOUNT_IDENTITY_CACHE_MAX_AGE_MS/u);
  assert.match(background, /schemaVersion:\s*2/u);
  assert.match(background, /remove\(STORAGE_KEYS\.observedSocialAccounts\)/u);
  assert.match(cloudAgent, /socialAccountDailyUsage:\s*true/u);
  assert.match(page, /今天每个 Agent 跑了多少，有没有安全验证/u);
  assert.match(page, /每天 00:00 按上海自然日进入新一天/u);
  assert.match(page, /社交账号只作可选信息，不影响计数/u);
  assert.match(page, /未登记账号，不影响 Agent 搜索、采集和安全验证统计/u);
  assert.match(page, /每个平台最多 1 个/u);
  assert.match(page, /api\.post\(`\/social-accounts\/\$\{accountId\}\/bindings`/u);
  assert.match(desktop, /'social-accounts': SocialAccountsPage/u);
  assert.match(mobile, /'social-accounts': SocialAccountsPage/u);
  assert.match(navigation, /'social-accounts': 'opinion'/u);
});
