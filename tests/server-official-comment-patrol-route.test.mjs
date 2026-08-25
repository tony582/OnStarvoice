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
const serverApp = await readFile(
  new URL('../server/app.js', import.meta.url),
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

function sourceSection(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing source section: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing source section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

test('official comment patrol is mounted under capture-cloud', () => {
  assert.match(
    serverApp,
    /import officialCommentPatrolRouter from '\.\/routes\/official-comment-patrol\.js';/u,
  );
  assert.match(
    serverApp,
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
    /\/capture-cloud\/official-comment-patrol\/tasks/u,
  );
  assert.doesNotMatch(
    taskCreator,
    /\/capture-cloud\/official-comment-patrol\/candidates\/preview/u,
  );
  assert.match(
    monitoringTab,
    /\/capture-cloud\/official-comment-patrol\/workbench/u,
  );
  assert.match(
    monitoringTab,
    /\/capture-cloud\/official-comment-patrol\/posts\/\$\{selectedPostId\}\/comments/u,
  );
  assert.doesNotMatch(
    monitoringTab,
    /\/capture-cloud\/official-comment-patrol\/comments\/\$\{comment\.id\}\/actions/u,
  );
  assert.doesNotMatch(
    `${taskCreator}\n${monitoringTab}`,
    /api\.(?:get|post)[^(]*\('\/official-comment-patrol\//u,
  );
});

test('official post workbench opens one account-page patrol flow without a discovery task', () => {
  assert.match(
    monitoringTab,
    /\.\.\.\(officialAccountId \? \{officialAccountId\} : \{\}\)/u,
  );
  assert.doesNotMatch(
    monitoringTab,
    /official_discovery|createDiscoveryTask|创建作品发现任务/u,
  );
  assert.match(
    taskCreator,
    /initialOfficialAccountId = ''/u,
  );
  assert.match(
    taskCreator,
    /compatibleAccounts\.find\(account => account\.id === initialOfficialAccountId\)/u,
  );
  assert.match(
    taskCreator,
    /Agent 会从账号主页按最新顺序读取你指定数量的作品/u,
  );
  assert.doesNotMatch(taskCreator, /publishDateFrom|publishDateTo|发布时间范围/u);
  assert.doesNotMatch(taskCreator, /recordIds|预览作品|selectedIds/u);
});

test('official post workbench exposes current engagement, sentiment, advice, and source links', () => {
  assert.match(monitoringTab, /帖子信息/u);
  assert.match(monitoringTab, /情感分布/u);
  assert.match(monitoringTab, /互动数据/u);
  assert.match(monitoringTab, /label: '点赞'/u);
  assert.match(monitoringTab, /label: '评论'/u);
  assert.match(monitoringTab, /label: '转发'/u);
  assert.match(monitoringTab, /负面评论/u);
  assert.match(monitoringTab, /正面评论/u);
  assert.match(monitoringTab, /建议：/u);
  assert.doesNotMatch(
    monitoringTab,
    /本次巡查|上次巡查|相比上次巡查|较上次巡查|风险趋势|评论覆盖|本次新增/u,
  );
  assert.doesNotMatch(monitoringTab, /label="点赞"|label="回复鼓励"|标记完成/u);
  assert.match(monitoringTab, /查看原文/u);
  assert.doesNotMatch(monitoringTab, /查看原帖/u);
  assert.doesNotMatch(monitoringTab, />帖子列表</u);
  assert.match(monitoringTab, /href=\{post\.url\}/u);
  assert.match(route, /record\.likes, record\.shares/u);
  assert.match(
    route,
    /const engagement = \{[\s\S]*likes: safeCount\(row\.likes\)[\s\S]*comments: safeCount\(row\.platform_comments\)[\s\S]*shares: safeCount\(row\.shares\)/u,
  );
  assert.match(
    route,
    /trend: row\.previous_engagement_at[\s\S]*engagement\.likes - safeCount\(row\.previous_likes\)[\s\S]*engagement\.comments - safeCount\(row\.previous_platform_comments\)[\s\S]*engagement\.shares - safeCount\(row\.previous_shares\)/u,
  );
  assert.match(
    route,
    /FROM record_observations observation[\s\S]*observation\.record_id = post\.id[\s\S]*observation\.id <> post\.latest_observation_id/u,
  );
});

test('official post workbench defaults to publish time and can sort by latest collection', () => {
  const cte = sourceSection(
    route,
    'function buildWorkbenchCte',
    'async function loadOfficialWorkbenchPost',
  );
  const workbenchRoute = sourceSection(
    route,
    "router.get(\n  '/official-comment-patrol/workbench'",
    "router.get(\n  '/official-comment-patrol/posts/:id/comments'",
  );
  assert.doesNotMatch(cte, /query\.range|query\.freshness|make_interval/u);
  assert.doesNotMatch(workbenchRoute, /req\.query\.range|req\.query\.freshness/u);
  assert.match(workbenchRoute, /sort: req\.query\.sort/u);
  assert.match(
    workbenchRoute,
    /COALESCE\(latest_snapshot_at, latest_comment_at\) DESC NULLS LAST,[\s\S]*published_ts DESC NULLS LAST, id/u,
  );
  assert.match(workbenchRoute, /: 'published_ts DESC NULLS LAST, id'/u);
  assert.match(monitoringTab, /sort: 'published_desc'/u);
  assert.match(monitoringTab, /comparePosts\(left, right, filters\.sort\)/u);
  assert.match(monitoringTab, /formatDateTime\(post\.lastPatrolledAt\)/u);
});

test('task composer hides official discovery while legacy task cards stay readable', async () => {
  const [drawer, dispatchPage, taskCard] = await Promise.all([
    readFile(new URL('../web/admin/src/pages/dispatch/cloud-tasks/CreateTaskDrawer.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../web/admin/src/pages/dispatch/DispatchPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../web/admin/src/pages/dispatch/cloud-tasks/TaskCard.tsx', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(drawer, /official_discovery|官方账号作品发现/u);
  assert.doesNotMatch(dispatchPage, /official_discovery/u);
  assert.match(taskCard, /official_account_post_discovery/u);
  assert.match(taskCard, /官方账号作品发现/u);
});

test('official comment patrol requires an explicit post count and does not infer dates', () => {
  assert.equal(
    normalizeOfficialCommentPatrolFilter({
      officialAccountId: '11111111-1111-4111-8111-111111111111',
    }).failure.error,
    'posts_limit_required',
  );
  const normalized = normalizeOfficialCommentPatrolFilter({
    officialAccountId: '11111111-1111-4111-8111-111111111111',
    postsLimit: 30,
    commentsLimit: 50,
  });
  assert.deepEqual(normalized.filter, {
    officialAccountId: '11111111-1111-4111-8111-111111111111',
    postsLimit: 30,
    commentsLimit: 50,
    requestedPlatform: '',
    timezone: 'Asia/Shanghai',
  });
});

test('official comment patrol keeps the post cap but accepts comment counts above 100', () => {
  assert.equal(
    normalizeOfficialCommentPatrolFilter({}).failure.error,
    'official_account_required',
  );
  assert.equal(
    normalizeOfficialCommentPatrolFilter({
      officialAccountId: '11111111-1111-4111-8111-111111111111',
      postsLimit: 101,
      commentsLimit: 50,
    }).failure.error,
    'invalid_posts_limit',
  );
  assert.equal(
    normalizeOfficialCommentPatrolFilter({
      officialAccountId: '11111111-1111-4111-8111-111111111111',
      postsLimit: 20,
    }).failure.error,
    'comments_limit_required',
  );
  assert.equal(normalizeOfficialCommentPatrolFilter({
    officialAccountId: '11111111-1111-4111-8111-111111111111',
    postsLimit: 20,
    commentsLimit: 1_000,
  }).filter.commentsLimit, 1_000);
  assert.equal(
    normalizeOfficialCommentPatrolFilter({
      officialAccountId: '11111111-1111-4111-8111-111111111111',
      postsLimit: 20,
      commentsLimit: Number.MAX_SAFE_INTEGER + 1,
    }).failure.error,
    'invalid_comments_limit',
  );
  assert.doesNotMatch(route, /MAX_COMMENTS_PER_POST/u);
  assert.match(route, /rawCommentsLimit,[\s\S]*Number\.MAX_SAFE_INTEGER/u);
});

test('candidate selection is tenant-scoped, exact-account matched, and URL-safe', () => {
  const accountWhere = sourceSection(
    route,
    'function officialAccountWhere',
    'function publicCandidate',
  );
  assert.match(accountWhere, /r\.platform = oa\.platform/u);
  assert.match(
    accountWhere,
    /NULLIF\(BTRIM\(oa\.platform_user_id\), ''\) IS NOT NULL[\s\S]*r\.author_id = oa\.platform_user_id/u,
  );
  assert.match(
    accountWhere,
    /NULLIF\(BTRIM\(oa\.account_no\), ''\) IS NOT NULL[\s\S]*r\.author_account_no = oa\.account_no/u,
  );
  assert.match(
    accountWhere,
    /NULLIF\(BTRIM\(oa\.account_id\), ''\) IS NOT NULL[\s\S]*r\.author_id = oa\.account_id[\s\S]*r\.author_account_no = oa\.account_id/u,
  );
  assert.doesNotMatch(accountWhere, /author_name|jsonb_array_elements_text/u);
  assert.match(accountWhere, /r\.published_ts IS NOT NULL/u);
  assert.doesNotMatch(accountWhere, /NULLIF\(BTRIM\(r\.publish_time\), ''\) IS NOT NULL/u);
  assert.match(accountWhere, /AT TIME ZONE 'Asia\/Shanghai'/u);
  assert.match(route, /oa\.tenant_id = r\.tenant_id/u);
  assert.match(route, /official_account_identity_required/u);
  assert.match(route, /hasStrongOfficialIdentity\(account\)/u);
  assert.match(route, /negativePatrolTargetUrl\(row\)/u);
  assert.match(route, /filter\(Boolean\)/u);
  assert.match(route, /task\.task_type = '\$\{WORKFLOW\}'/u);
  assert.match(route, /COALESCE\(patrol_summary\.patrol_status, 'not_patrolled'\)/u);
  assert.doesNotMatch(
    route,
    /comment_summary\.last_patrolled_at/u,
  );
});

test('create route creates one account-page Agent task and forces comment sampling sync', () => {
  const createRoute = sourceSection(
    route,
    "router.post(\n  '/official-comment-patrol/tasks'",
    'export default router',
  );
  assert.match(route, /'\/official-comment-patrol\/tasks'/u);
  assert.match(route, /agent_required/u);
  assert.match(route, /loadCompatibleProfilePatrolAgent/u);
  assert.match(createRoute, /\{excludeTaskIds: \[requestKey\]\}/u);
  assert.match(route, /materializeProfilePatrolTask/u);
  assert.match(route, /subjectType: 'official'/u);
  assert.match(route, /official_account_comment_patrol/u);
  assert.match(route, /postsLimit: normalized\.filter\.postsLimit/u);
  assert.match(route, /includeComments: true/u);
  assert.match(route, /includeCommentsOnDetailCapture: true/u);
  assert.match(route, /autoSyncAfterDetailCapture: true/u);
  assert.match(route, /commentsMaxDetectedItems: normalized\.filter\.commentsLimit/u);
  assert.match(route, /skipAlreadyCapturedOnDetailCapture: false/u);
  assert.match(route, /scanLatestPostsByCount: true/u);
  assert.doesNotMatch(createRoute, /publishDateFrom|publishDateTo|verifyPublishDateFromDetail/u);
  assert.doesNotMatch(route, /recordIds: normalized\.recordIds/u);
});
