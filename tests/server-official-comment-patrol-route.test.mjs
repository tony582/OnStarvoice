import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {
  normalizeOfficialCommentPatrolFilter,
} from '../server/routes/official-comment-patrol.js';

const route = await readFile(
  new URL('../server/routes/official-comment-patrol.js', import.meta.url),
  'utf8',
);
const serverIndex = await readFile(
  new URL('../server/index.js', import.meta.url),
  'utf8',
);
const taskCreator = await readFile(
  new URL(
    '../web/admin/src/pages/dispatch/cloud-tasks/OfficialCommentPatrolTaskCreator.tsx',
    import.meta.url,
  ),
  'utf8',
);
const monitoringTab = await readFile(
  new URL(
    '../web/admin/src/pages/monitoring/OfficialCommentPatrolTab.tsx',
    import.meta.url,
  ),
  'utf8',
);

test('official comment patrol is mounted under capture-cloud', () => {
  assert.match(
    serverIndex,
    /import officialCommentPatrolRouter from '\.\/routes\/official-comment-patrol\.js';/u,
  );
  assert.match(
    serverIndex,
    /app\.use\('\/api\/capture-cloud', officialCommentPatrolRouter\);/u,
  );
});

test('official comment patrol admin calls the mounted capture-cloud namespace', () => {
  assert.match(
    taskCreator,
    /\/capture-cloud\/official-comment-patrol\/accounts/u,
  );
  assert.match(
    taskCreator,
    /\/capture-cloud\/official-comment-patrol\/candidates\/preview/u,
  );
  assert.match(
    taskCreator,
    /\/capture-cloud\/official-comment-patrol\/tasks/u,
  );
  assert.match(
    monitoringTab,
    /\/capture-cloud\/official-comment-patrol\/accounts/u,
  );
  assert.doesNotMatch(
    `${taskCreator}\n${monitoringTab}`,
    /api\.(?:get|post)[^(]*\('\/official-comment-patrol\//u,
  );
});

test('official comment patrol defaults to latest seven Shanghai calendar days', () => {
  const normalized = normalizeOfficialCommentPatrolFilter({
    officialAccountId: '11111111-1111-4111-8111-111111111111',
  }, {now: new Date('2026-07-26T16:30:00.000Z')});
  assert.deepEqual(normalized.filter, {
    officialAccountId: '11111111-1111-4111-8111-111111111111',
    publishDateFrom: '2026-07-21',
    publishDateTo: '2026-07-27',
    postsLimit: 20,
    commentsLimit: 50,
    requestedPlatform: '',
    timezone: 'Asia/Shanghai',
  });
});

test('official comment patrol rejects missing accounts, bad windows, and over-limit requests', () => {
  assert.equal(
    normalizeOfficialCommentPatrolFilter({}).failure.error,
    'official_account_required',
  );
  assert.equal(
    normalizeOfficialCommentPatrolFilter({
      officialAccountId: '11111111-1111-4111-8111-111111111111',
      publishDateFrom: '2026-02-30',
      publishDateTo: '2026/03/01',
    }).failure.error,
    'invalid_publish_date',
  );
  assert.equal(
    normalizeOfficialCommentPatrolFilter({
      officialAccountId: '11111111-1111-4111-8111-111111111111',
      publishDateFrom: '2026-07-26oops',
    }).failure.error,
    'invalid_publish_date',
  );
  assert.equal(
    normalizeOfficialCommentPatrolFilter({
      officialAccountId: '11111111-1111-4111-8111-111111111111',
      publishDateFrom: '2026-07-26',
      publishDateTo: '2026-07-01',
    }).failure.error,
    'invalid_publish_date_range',
  );
  assert.equal(
    normalizeOfficialCommentPatrolFilter({
      officialAccountId: '11111111-1111-4111-8111-111111111111',
      publishDateFrom: '2026-06-01',
      publishDateTo: '2026-07-01',
    }).failure.error,
    'publish_date_range_too_large',
  );
  assert.equal(
    normalizeOfficialCommentPatrolFilter({
      officialAccountId: '11111111-1111-4111-8111-111111111111',
      postsLimit: 21,
    }).failure.error,
    'invalid_posts_limit',
  );
  assert.equal(
    normalizeOfficialCommentPatrolFilter({
      officialAccountId: '11111111-1111-4111-8111-111111111111',
      commentsLimit: 101,
    }).failure.error,
    'invalid_comments_limit',
  );
});

test('candidate selection is tenant-scoped, exact-account matched, dated, and URL-safe', () => {
  assert.match(route, /oa\.tenant_id = r\.tenant_id/u);
  assert.match(route, /r\.platform = oa\.platform/u);
  assert.match(
    route,
    /NULLIF\(BTRIM\(oa\.account_id\), ''\) IS NOT NULL[\s\S]*r\.author_account_no = oa\.account_id/u,
  );
  assert.match(
    route,
    /NULLIF\(BTRIM\(oa\.account_id\), ''\) IS NULL[\s\S]*r\.author_name = oa\.account_name/u,
  );
  assert.match(route, /r\.author_name = oa\.account_name/u);
  assert.match(route, /jsonb_array_elements_text/u);
  assert.match(route, /r\.published_ts IS NOT NULL/u);
  assert.doesNotMatch(route, /NULLIF\(BTRIM\(r\.publish_time\), ''\) IS NOT NULL/u);
  assert.match(route, /AT TIME ZONE 'Asia\/Shanghai'/u);
  assert.match(route, /negativePatrolTargetUrl\(row\)/u);
  assert.match(route, /filter\(Boolean\)/u);
  assert.match(route, /task\.task_type = '\$\{WORKFLOW\}'/u);
  assert.match(route, /COALESCE\(patrol_summary\.patrol_status, 'not_patrolled'\)/u);
  assert.doesNotMatch(
    route,
    /comment_summary\.last_patrolled_at/u,
  );
});

test('create route creates one agent task with post items and forces comment sampling sync', () => {
  assert.match(route, /'\/official-comment-patrol\/tasks'/u);
  assert.match(route, /agent_required/u);
  assert.match(route, /capabilities\.officialAccountCommentPatrol !== true/u);
  assert.match(route, /task_type, feature_key/u);
  assert.match(route, /official_account_comment_patrol/u);
  assert.match(route, /'official_account_post'/u);
  assert.match(route, /INSERT INTO capture_task_item_attempts/u);
  assert.match(route, /INSERT INTO capture_agent_commands/u);
  assert.match(route, /includeComments: true/u);
  assert.match(route, /autoSyncAfterDetailCapture: true/u);
  assert.match(route, /commentsMaxDetectedItems: normalized\.filter\.commentsLimit/u);
  assert.match(route, /resultDisclosure/u);
  assert.match(route, /不代表平台全部评论/u);
});
