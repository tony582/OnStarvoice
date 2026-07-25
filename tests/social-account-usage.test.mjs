import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import test from "node:test";
import vm from "node:vm";
import {fileURLToPath} from "node:url";

import {
  normalizeObservedSocialAccount,
  normalizeSocialUsageEvent,
  normalizeSocialUsageEvents,
} from "../server/services/social-account-usage.js";
import {
  extractPlatformAccountId,
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
    occurredAt: event.occurredAt,
    accountIdentity: {
      platformAccountId: "account-a",
      accountHandle: "starvoice-a",
      displayName: "账号 A",
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

test("schema, heartbeat, tenant api, and admin page are wired as one account-health flow", async () => {
  const [
    migration,
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
  assert.match(captureRoute, /processSocialAccountHeartbeat/u);
  assert.match(captureRoute, /acceptedSocialUsageEventIds/u);
  assert.match(accountRoute, /router\.get\(\s*'\/overview'/u);
  assert.match(accountRoute, /registered_phone/u);
  assert.match(serverIndex, /app\.use\('\/api\/social-accounts', socialAccountsRouter\)/u);
  assert.match(background, /onstarvoice\.socialAccountUsageQueue/u);
  assert.match(background, /recordSocialAccountUsageFromRelay/u);
  assert.match(background, /acknowledgeSocialAccountUsageEvents/u);
  assert.match(cloudAgent, /socialAccountDailyUsage:\s*true/u);
  assert.match(page, /今天哪些账号该继续，哪些该休息/u);
  assert.match(page, /建议休息/u);
  assert.match(desktop, /'social-accounts': SocialAccountsPage/u);
  assert.match(mobile, /'social-accounts': SocialAccountsPage/u);
  assert.match(navigation, /'social-accounts': 'opinion'/u);
});
