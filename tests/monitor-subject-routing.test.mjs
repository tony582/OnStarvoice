import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const rootUrl = new URL("../", import.meta.url);

async function read(relativePath) {
  return await readFile(new URL(relativePath, rootUrl), "utf8");
}

test("monitor profile entry asks the user to choose creator or official account", async () => {
  const [html, css] = await Promise.all([
    read("sidebar/sidebar.html"),
    read("sidebar/sidebar.css"),
  ]);

  assert.match(html, /id="btnMonitorSubjectCreator"/);
  assert.match(html, /data-subject-type="creator"/);
  assert.match(html, /id="btnMonitorSubjectOfficial"/);
  assert.match(html, /data-subject-type="official"/);
  assert.match(html, />关注博主</);
  assert.match(html, />官方账号</);
  assert.match(html, /用于作品与评论巡查/);
  assert.match(css, /\.monitor-subject-option\[aria-pressed="true"\]/);
  assert.match(css, /\.monitor-subject-badge\.is-official/);
});

test("monitor subject payload carries stable and human-readable identity together", async () => {
  const {normalizeMonitorSubscriptionPayload} = await import(
    `../utils/api.js?monitor-subject-routing=${Date.now()}`
  );

  const official = normalizeMonitorSubscriptionPayload({
    platform: "douyin",
    subjectType: "official",
    profileInternalId: "MS4wLjABAAAA-internal",
    accountNo: "anjixing",
    displayName: "安吉星",
    profileUrl: "https://www.douyin.com/user/MS4wLjABAAAA-internal",
    avatarUrl: "https://cdn.example/avatar.jpg",
  });

  assert.deepEqual(
    {
      subjectType: official.subjectType,
      profileInternalId: official.profileInternalId,
      accountNo: official.accountNo,
      displayName: official.displayName,
      profileUrl: official.profileUrl,
      avatarUrl: official.avatarUrl,
    },
    {
      subjectType: "official",
      profileInternalId: "MS4wLjABAAAA-internal",
      accountNo: "anjixing",
      displayName: "安吉星",
      profileUrl: "https://www.douyin.com/user/MS4wLjABAAAA-internal",
      avatarUrl: "https://cdn.example/avatar.jpg",
    },
  );
  assert.equal(official.platformBloggerId, official.profileInternalId);
  assert.equal(official.bloggerNameSnapshot, official.displayName);
  assert.equal(official.bloggerUrl, official.profileUrl);
  assert.equal(official.assignedAgentId, "");

  const legacyCreator = normalizeMonitorSubscriptionPayload({
    platformBloggerId: "legacy-id",
    bloggerNameSnapshot: "旧博主",
    bloggerUrl: "https://example.com/legacy",
  });
  assert.equal(legacyCreator.subjectType, "creator");
  assert.equal(legacyCreator.profileInternalId, "legacy-id");
  assert.equal(legacyCreator.displayName, "旧博主");
  assert.equal(legacyCreator.profileUrl, "https://example.com/legacy");
});

test("sidebar recognition routes the same profile through an explicit subject type", async () => {
  const [logic, ui] = await Promise.all([
    read("sidebar/sidebar-logic.js"),
    read("sidebar/sidebar-ui.js"),
  ]);

  assert.match(logic, /function buildMonitorSubjectCandidate/);
  assert.match(logic, /subjectType:\s*normalizedSubjectType/);
  assert.match(logic, /profileInternalId:\s*normalizedProfileInternalId/);
  assert.match(logic, /accountNo:\s*normalizedAccountNo/);
  assert.match(logic, /displayName:\s*normalizedDisplayName/);
  assert.match(logic, /profileUrl:\s*normalizedProfileUrl/);
  assert.match(logic, /avatarUrl:\s*normalizedAvatarUrl/);
  assert.match(logic, /assignedAgentId:\s*normalizedAssignedAgentId/);
  assert.match(
    logic,
    /assignedAgentId:\s*getCurrentAuth\(\)\?\.captureAgent\?\.id \|\| ""/u,
  );
  assert.match(logic, /captureCurrentMonitorCandidate\(subjectType\)/);
  assert.match(
    logic,
    /runMonitorNow\(\{\s*subjectType:\s*MONITOR_SUBJECT_TYPE\.CREATOR,/,
  );
  assert.match(ui, /resolveMonitorSubscriptionSubjectType/);
  assert.match(ui, /monitor-subject-badge is-\$\{escapeHtml\(subjectType\)\}/);
  assert.match(ui, /resolveMonitorSubscriptionSubjectType\(item\) === selectedSubjectType/);
});

test("legacy monitor polling cannot steal cloud-dispatched account scans", async () => {
  const [cron, monitorRoute] = await Promise.all([
    read("server/cron.js"),
    read("server/routes/monitor.js"),
  ]);

  assert.match(cron, /enqueueDueProfilePatrolTasks\(20\)/u);
  assert.doesNotMatch(cron, /enqueueDueMonitorExecutions/u);
  assert.match(
    monitorRoute,
    /COALESCE\(ms\.subject_type,\s*'creator'\)\s*=\s*'creator'/,
  );
  assert.match(
    monitorRoute,
    /item\.metadata->>'monitorExecutionId'\s*=\s*me\.id::text/,
  );
  assert.match(
    monitorRoute,
    /UPDATE monitor_executions[\s\S]*status = 'pending'[\s\S]*NOT EXISTS \([\s\S]*item\.metadata->>'monitorExecutionId'/u,
  );
});
