import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {
  normalizeWatchedContentFilter,
} from '../server/routes/negative-patrol.js';
import {
  getContentPatrolPostTimeline,
} from '../server/services/negative-patrol-analytics.js';

async function source(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

test('watched-content filters support one platform or a deduplicated mixed list', () => {
  assert.deepEqual(
    normalizeWatchedContentFilter({platform: 'douyin', limit: 20}).filter,
    {
      platform: 'douyin',
      platforms: ['douyin'],
      query: '',
      limit: 20,
      watchedOnly: true,
    },
  );
  assert.deepEqual(
    normalizeWatchedContentFilter({
      platforms: ['xiaohongshu', 'douyin', 'xiaohongshu'],
      query: '售后',
    }).filter,
    {
      platform: 'mixed',
      platforms: ['xiaohongshu', 'douyin'],
      query: '售后',
      limit: 100,
      watchedOnly: true,
    },
  );
  assert.deepEqual(
    normalizeWatchedContentFilter({platform: 'mixed'}).filter.platforms,
    ['xiaohongshu', 'douyin'],
  );
  assert.equal(
    normalizeWatchedContentFilter({platforms: ['weibo']}).failure.error,
    'unsupported_platform',
  );
});

test('watch state is tenant-scoped, independent from record classification, filterable, and auditable', async () => {
  const [migration, triage] = await Promise.all([
    source('server/db/migrations/065_record_watchlist.sql'),
    source('server/routes/triage.js'),
  ]);

  assert.match(migration, /CREATE TABLE IF NOT EXISTS record_watchlist/u);
  assert.match(migration, /PRIMARY KEY \(tenant_id, record_id\)/u);
  assert.match(migration, /FOREIGN KEY \(tenant_id, record_id\)[\s\S]*REFERENCES records\(tenant_id, id\)[\s\S]*ON DELETE CASCADE/u);
  assert.match(triage, /router\.patch\('\/records\/watch'/u);
  assert.match(triage, /router\.patch\('\/records\/watch', requireTenantAccess, requireSessionUser, requireTenantWriter/u);
  assert.match(triage, /ids 需为 1-100 个内容ID/u);
  assert.match(triage, /ON CONFLICT \(tenant_id, record_id\) DO NOTHING/u);
  assert.match(triage, /DELETE FROM record_watchlist[\s\S]*tenant_id = \$1/u);
  assert.match(triage, /appendWatchedFilter\(where, req\.query\.watched\)/u);
  assert.match(triage, /AS is_watched/u);
  assert.match(triage, /AS watched_at/u);
  assert.match(triage, /AS watched_by_name/u);
  assert.match(triage, /record\.watch_batch_added/u);
  assert.match(triage, /record\.watch_batch_removed/u);
  assert.match(
    triage,
    /ai_result->>'relevance' IS DISTINCT FROM 'irrelevant'[\s\S]*record_watchlist watched_override/u,
    'a watched non-negative or relevance-filtered record must remain visible in content triage',
  );
});

test('watched-content task creation revalidates live watch state and creates platform-bound elastic items', async () => {
  const route = await source('server/routes/negative-patrol.js');
  const previewStart = route.indexOf("router.post(\n  '/watched-content/candidates/preview'");
  const createStart = route.indexOf("router.post(\n  '/watched-content/tasks'");
  const negativeStart = route.indexOf("router.post(\n  '/negative-patrol/tasks'");
  assert.ok(previewStart >= 0 && createStart > previewStart && negativeStart > createStart);
  const create = route.slice(createStart, negativeStart);

  assert.match(route.slice(previewStart, previewStart + 350), /requireTenantAccess[\s\S]*requireSessionUser[\s\S]*requireTenantWriter/u);
  assert.match(create.slice(0, 350), /requireTenantAccess[\s\S]*requireSessionUser[\s\S]*requireTenantWriter/u);
  assert.match(route, /JOIN record_watchlist watch/u);
  assert.match(route, /ORDER BY watch\.watched_at DESC/u);
  assert.match(create, /loadWatchedCandidates\([\s\S]*lock: true/u);
  assert.match(create, /candidate_selection_changed/u);
  assert.match(create, /部分已选内容已取消关注/u);
  assert.match(create, /requiredPlatforms[\s\S]*selection\.candidates\.map\(candidate => candidate\.platform\)/u);
  assert.match(create, /workflow: 'watched_content_patrol'/u);
  assert.match(create, /itemType: 'watched_content'/u);
  assert.match(create, /distributionMode: 'elastic_pool'/u);
  assert.match(create, /loadCompatibleAgents\([\s\S]*requiredPlatforms[\s\S]*workflow: 'watched_content_patrol'/u);
  assert.match(route, /capabilities\.watchedContentPatrol !== true/u);
});

test('mixed content patrol is claimed by item platform, never by the mixed parent platform', async () => {
  const queue = await source('server/routes/capture-cloud.js');
  const start = queue.indexOf('async function dispatchNextElasticWorkItem');
  const end = queue.indexOf("router.post('/agent/heartbeat'", start);
  assert.ok(start >= 0 && end > start);
  const claim = queue.slice(start, end);

  assert.match(claim, /item\.platform AS item_platform/u);
  assert.match(claim, /item\.item_type = 'watched_content'/u);
  assert.match(claim, /freshCapabilities\.watchedContentPatrol === true/u);
  assert.match(claim, /item\.platform = ANY\(\$4::text\[\]\)/u);
  assert.match(claim, /item\.platform = ANY\(\$5::text\[\]\)/u);
  assert.match(claim, /platform: candidate\.item_platform/u);
  assert.match(claim, /targetedContent \? candidate\.item_platform : candidate\.parent_platform/u);
  assert.doesNotMatch(
    claim,
    /cardinality\(\$4::text\[\]\) = 0 OR parent\.platform = ANY/u,
  );
});

test('Extension advertises and executes watched-content patrol through the shared targeted protocol', async () => {
  const [protocol, agent, background, sidebar] = await Promise.all([
    source('utils/cloud-targeted-post.js'),
    source('utils/cloud-task-agent.js'),
    source('background.js'),
    source('sidebar/sidebar-logic.js'),
  ]);

  assert.match(protocol, /const WATCHED_CONTENT_WORKFLOW = "watched_content_patrol"/u);
  assert.match(protocol, /SUPPORTED_WORKFLOWS[\s\S]*WATCHED_CONTENT_WORKFLOW/u);
  assert.match(protocol, /Object\.freeze\(\{[\s\S]*WATCHED_CONTENT_WORKFLOW/u);
  assert.match(agent, /"watched_content_patrol"/u);
  assert.match(agent, /watchedContentPatrol: true/u);
  assert.match(background, /workflow === 'watched_content_patrol'/u);
  assert.match(background, /title: String\(request\?\.title \|\| ''\)\.trim\(\) \|\| '关注内容巡查'/u);
  assert.match(sidebar, /normalized === "watched_content_patrol"/u);
  assert.match(sidebar, /"negative_post_patrol",\s*"watched_content_patrol"/u);
});

test('admin exposes watched content as a scope and groups both patrol handoffs in the batch bar', async () => {
  const [triage, batchBar, drawer, creator, negativeCreator, dispatch, route] = await Promise.all([
    source('web/admin/src/pages/workbench/TriageQueue.tsx'),
    source('web/admin/src/components/shared/BatchBar.tsx'),
    source('web/admin/src/pages/dispatch/cloud-tasks/CreateTaskDrawer.tsx'),
    source('web/admin/src/pages/dispatch/cloud-tasks/WatchedContentTaskCreator.tsx'),
    source('web/admin/src/pages/dispatch/cloud-tasks/NegativePatrolTaskCreator.tsx'),
    source('web/admin/src/pages/dispatch/DispatchPage.tsx'),
    source('server/routes/negative-patrol.js'),
  ]);

  assert.match(triage, /aria-label="内容生命周期"/u);
  assert.match(triage, /const ARCHIVE_VIEWS[\s\S]*value: 'active', label: '工作中'[\s\S]*value: 'archived', label: '已归档'/u);
  assert.doesNotMatch(triage.match(/const ARCHIVE_VIEWS[\s\S]*?const PAGE_SIZE_OPTIONS/u)?.[0] || '', /watched|已关注/u);
  assert.match(triage, /const viewingWatchlist = watchedFilter === 'watched'/u);
  assert.match(triage, /aria-label=\{viewingWatchlist \? '关闭关注清单，显示当前生命周期的全部内容' : '打开关注清单'\}/u);
  assert.match(triage, /已归档的关注清单暂无内容/u);
  assert.doesNotMatch(triage, /<option value="unwatched">|label: '未关注'/u);
  assert.match(triage, /runWatchBatch\(true\)/u);
  assert.match(triage, /runWatchBatch\(false\)/u);
  assert.match(triage, /label: '创建巡查'/u);
  assert.match(triage, /createPatrolFromSelection\('negative_patrol'\)/u);
  assert.match(triage, /createPatrolFromSelection\('watched_content'\)/u);
  assert.match(triage, /create: taskType,[\s\S]*recordIds: selectedRecords/u);
  assert.match(triage, /onSetWatched:/u);
  assert.match(batchBar, /export type BatchActionMenu/u);
  assert.match(batchBar, /menu\.actions\.map/u);
  assert.match(drawer, /value: 'watched_content'/u);
  assert.match(drawer, /<WatchedContentTaskCreator/u);
  assert.match(drawer, /<NegativePatrolTaskCreator[\s\S]*initialRecordIds=\{intent\.recordIds\}/u);
  assert.match(drawer, /await onCreated\(taskType\)/u);
  assert.match(drawer, /\['negative_patrol', 'watched_content'\]\.includes\(presetTaskType \|\| ''\) \? 'multi' : 'single'/u);
  assert.match(drawer, /\['negative_patrol', 'watched_content'\]\.includes\(item\.value\)[\s\S]*setMethod\('multi'\)/u);
  assert.match(dispatch, /params\?\.create === 'negative_patrol'[\s\S]*taskType: 'negative_patrol'[\s\S]*recordIds:/u);
  assert.match(dispatch, /params\?\.create === 'watched_content'/u);
  assert.match(dispatch, /关注内容巡查已创建，内容将按平台由兼容 Agent 领取/u);
  assert.match(creator, /platformCoverage/u);
  assert.match(creator, /missingCoverage/u);
  assert.match(creator, /handoffMissingCount/u);
  assert.match(creator, /preview\(stableInitialIds\)/u);
  assert.match(creator, /带入的关注内容尚未完整加载，不能创建可能漏采的任务/u);
  assert.match(creator, /const eligibleAgents = agents\.filter\(agent => selectedItemPlatforms\.some/u);
  assert.match(creator, /agentIds: eligibleAgents\.map\(agent => agent\.id\)/u);
  assert.match(creator, /distributionMode: 'elastic_pool'/u);
  assert.match(creator, /\/capture-cloud\/watched-content\/tasks/u);
  assert.match(negativeCreator, /initialRecordIds\?: string\[\]/u);
  assert.match(negativeCreator, /preview\(stableInitialIds\)/u);
  assert.match(negativeCreator, /带入的负面内容尚未完整加载，不能创建可能漏采的任务/u);
  const negativePreviewStart = route.indexOf("router.post(\n  '/negative-patrol/candidates/preview'");
  const watchedPreviewStart = route.indexOf("router.post(\n  '/watched-content/candidates/preview'");
  assert.match(route.slice(negativePreviewStart, watchedPreviewStart), /normalizeRecordIds\(req\.body\?\.recordIds\)[\s\S]*loadCandidates\([\s\S]*recordIds: normalizedIds\.recordIds/u);
});

test('content patrol timeline combines negative and watched runs while preserving workflow labels', async () => {
  let timelineSql = '';
  const timeline = await getContentPatrolPostTimeline({
    tenantId: 'tenant-id',
    recordId: 'record-id',
    db: {
      async queryOne() {
        return {
          id: 'record-id',
          title: '已关注内容',
          platform: 'douyin',
          content_availability_status: 'available',
        };
      },
      async queryAll(sql) {
        timelineSql = sql;
        return [{
          item_id: 'item-id',
          task_id: 'task-id',
          status: 'completed',
          workflow: 'watched_content_patrol',
          created_at: '2026-08-13T01:00:00.000Z',
          updated_at: '2026-08-13T01:01:00.000Z',
          availability_status: 'available',
        }];
      },
    },
  });

  assert.match(timelineSql, /watched_content_patrol/u);
  assert.match(timelineSql, /negative_post_patrol/u);
  assert.equal(timeline.runs[0].workflow, 'watched_content_patrol');
  assert.equal(timeline.runs[0].workflowLabel, '关注内容巡查');
  assert.equal(timeline.summary.runCount, 1);
});
