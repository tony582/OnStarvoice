import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {
  negativePatrolTargetUrl,
  normalizeNegativePatrolFilter,
} from '../server/routes/negative-patrol.js';

const route = await readFile(
  new URL('../server/routes/negative-patrol.js', import.meta.url),
  'utf8',
);
const serverIndex = await readFile(
  new URL('../server/index.js', import.meta.url),
  'utf8',
);

function section(startMarker, endMarker) {
  const start = route.indexOf(startMarker);
  assert.notEqual(start, -1, `missing marker: ${startMarker}`);
  const end = route.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing marker: ${endMarker}`);
  return route.slice(start, end);
}

test('negative patrol router is mounted under capture-cloud', () => {
  assert.match(
    serverIndex,
    /import negativePatrolRouter from '\.\/routes\/negative-patrol\.js';/u,
  );
  assert.match(
    serverIndex,
    /app\.use\('\/api\/capture-cloud', negativePatrolRouter\);/u,
  );
});

test('negative patrol filters require a real publish date range and platform', () => {
  assert.deepEqual(
    normalizeNegativePatrolFilter({
      publishDateFrom: '2026-07-01',
      publishDateTo: '2026-07-26',
      platform: 'douyin',
      query: '门店',
      minInteractions: 50,
      limit: 80,
    }).filter,
    {
      publishDateFrom: '2026-07-01',
      publishDateTo: '2026-07-26',
      platform: 'douyin',
      query: '门店',
      minInteractions: 50,
      limit: 80,
      timezone: 'Asia/Shanghai',
      sentiment: 'negative',
      excludePendingFalsePositive: true,
    },
  );
  assert.equal(
    normalizeNegativePatrolFilter({
      publishDateFrom: '2026-02-30',
      publishDateTo: '2026-03-01',
      platform: 'douyin',
    }).failure.error,
    'publish_date_range_required',
  );
  assert.equal(
    normalizeNegativePatrolFilter({
      publishDateFrom: '2026-07-02',
      publishDateTo: '2026-07-01',
      platform: 'douyin',
    }).failure.error,
    'invalid_publish_date_range',
  );
  assert.equal(
    normalizeNegativePatrolFilter({
      publishDateFrom: '2026-07-01',
      publishDateTo: '2026-07-02',
      platform: 'weibo',
    }).failure.error,
    'unsupported_platform',
  );
});

test('target URLs are bound to the selected platform and record identity', () => {
  assert.equal(
    negativePatrolTargetUrl({
      platform: 'xiaohongshu',
      external_id: '64abcdeffedcba9876543210',
      url: 'https://www.xiaohongshu.com/explore/64abcdeffedcba9876543210?xsec_token=token',
    }),
    'https://www.xiaohongshu.com/explore/64abcdeffedcba9876543210?xsec_token=token&xsec_source=pc_search',
  );
  assert.equal(
    negativePatrolTargetUrl({
      platform: 'douyin',
      external_id: '7123456789012345678',
      note_type: 'image',
      url: 'https://evil.example/video/7123456789012345678',
    }),
    'https://www.douyin.com/note/7123456789012345678',
  );
  assert.equal(
    negativePatrolTargetUrl({
      platform: 'douyin',
      external_id: '../../etc/passwd',
    }),
    '',
  );
});

test('xiaohongshu target URLs preserve supported note paths and access context', () => {
  const externalId = '6a66eea9000000000f00a1ad';
  const sourceUrls = [
    `https://www.xiaohongshu.com/explore/${externalId}?xsec_token=token&xsec_source=pc_search`,
    `https://www.xiaohongshu.com/discovery/item/${externalId}?xsec_token=token&xsec_source=pc_search`,
    `https://www.xiaohongshu.com/note/${externalId}?xsec_token=token&xsec_source=pc_search`,
    `https://www.xiaohongshu.com/video/${externalId}?xsec_token=token&xsec_source=pc_search`,
    `https://www.xiaohongshu.com/search_result/${externalId}?xsec_token=token&xsec_source=pc_search`,
    `https://www.xiaohongshu.com/user/profile/63da61fe000000002702ba15/${externalId}?xsec_token=token&xsec_source=pc_user`,
  ];

  for (const url of sourceUrls) {
    assert.equal(
      negativePatrolTargetUrl({
        platform: 'xiaohongshu',
        external_id: externalId,
        url,
      }),
      url,
    );
  }

  assert.equal(
    negativePatrolTargetUrl({
      platform: 'xiaohongshu',
      external_id: externalId,
      url: `https://www.xiaohongshu.com/search_result/${externalId}?xsec_token=token`,
    }),
    `https://www.xiaohongshu.com/search_result/${externalId}?xsec_token=token&xsec_source=pc_search`,
  );
});

test('xiaohongshu profile URLs must bind the record id to the note segment', () => {
  const externalId = '6a66eea9000000000f00a1ad';
  const fallbackUrl = `https://www.xiaohongshu.com/explore/${externalId}`;

  assert.equal(
    negativePatrolTargetUrl({
      platform: 'xiaohongshu',
      external_id: externalId,
      url: `https://www.xiaohongshu.com/user/profile/${externalId}/different-note?xsec_token=token&xsec_source=pc_user`,
    }),
    fallbackUrl,
  );
  assert.equal(
    negativePatrolTargetUrl({
      platform: 'xiaohongshu',
      external_id: externalId,
      url: `https://www.xiaohongshu.com/user/profile/${externalId}?xsec_token=token&xsec_source=pc_user`,
    }),
    fallbackUrl,
  );
});

test('preview and create are tenant-writer routes with identical candidate SQL', () => {
  for (const marker of [
    "'/negative-patrol/candidates/preview'",
    "'/negative-patrol/tasks'",
  ]) {
    const start = route.indexOf(marker);
    assert.notEqual(start, -1);
    const middleware = route.slice(start, start + 280);
    assert.match(middleware, /requireTenantAccess/u);
    assert.match(middleware, /requireSessionUser/u);
    assert.match(middleware, /requireTenantWriter/u);
  }
  assert.match(route, /r\.tenant_id = \$1/u);
  assert.match(route, /r\.platform = \$2/u);
  assert.match(route, /r\.sentiment = 'negative'/u);
  assert.match(route, /NULLIF\(BTRIM\(r\.publish_time\), ''\) IS NOT NULL/u);
  assert.match(route, /r\.published_ts IS NOT NULL/u);
  assert.match(route, /r\.published_ts >=/u);
  assert.match(route, /AT TIME ZONE 'Asia\/Shanghai'/u);
  assert.match(route, /r\.title ILIKE/u);
  assert.match(route, /r\.content ILIKE/u);
  assert.match(route, /r\.author_name ILIKE/u);
  assert.match(route, /r\.keyword ILIKE/u);
  assert.match(route, /r\.likes \+ r\.comments_count \+ r\.collects \+ r\.shares/u);
  assert.match(route, /record_feedback rf/u);
  assert.match(route, /rf\.review_status = 'pending'/u);
  assert.equal(
    route.match(/WHERE rf\.tenant_id = r\.tenant_id/gu)?.length,
    1,
    'the record_feedback subquery must contain exactly one WHERE clause',
  );
});

test('create snapshots records into item rows and emits the versioned agent protocol', () => {
  const create = section(
    "router.post(\n  '/negative-patrol/tasks'",
    'export default router',
  );
  assert.match(create, /pg_advisory_xact_lock/u);
  assert.match(create, /remoteRequestHash/u);
  assert.match(create, /candidate_selection_changed/u);
  assert.match(create, /INSERT INTO capture_tasks/u);
  assert.match(create, /'negative_post_patrol'/u);
  assert.match(create, /INSERT INTO capture_task_items/u);
  assert.match(create, /'negative_post'/u);
  assert.match(create, /record_id, external_id, url_snapshot/u);
  assert.match(create, /INSERT INTO capture_task_item_attempts/u);
  assert.match(create, /INSERT INTO capture_agent_commands/u);
  assert.match(create, /workflow: 'negative_post_patrol'/u);
  assert.match(create, /taskKind: 'negative_post_patrol'/u);
  assert.match(create, /protocolVersion: 1/u);
  assert.match(create, /targets,/u);
  assert.match(create, /items: targets/u);
  assert.match(route, /capabilities\.negativePostPatrol !== true/u);
  assert.match(route, /INSERT INTO capture_task_events/u);
  assert.match(create, /INSERT INTO audit_logs/u);
  assert.doesNotMatch(
    create,
    /patrolRequestHash\(\{[\s\S]*?title,\s*title,/u,
    'idempotency hashing must include the title exactly once per call',
  );
});
