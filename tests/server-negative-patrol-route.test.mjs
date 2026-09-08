import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {
  negativePatrolTargetUrl,
  normalizeNegativePatrolFilter,
  publicNegativePatrolCandidate,
} from '../server/routes/negative-patrol.js';

const route = await readFile(
  new URL('../server/routes/negative-patrol.js', import.meta.url),
  'utf8',
);
const serverApp = await readFile(
  new URL('../server/app.js', import.meta.url),
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
    serverApp,
    /import negativePatrolRouter from '\.\/routes\/negative-patrol\.js';/u,
  );
  assert.match(
    serverApp,
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
      platforms: ['douyin'],
      query: '门店',
      minInteractions: 50,
      limit: 80,
      pageSize: 80,
      cursor: null,
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
  assert.deepEqual(
    normalizeNegativePatrolFilter({
      publishDateFrom: '2026-07-01',
      publishDateTo: '2026-07-02',
      platforms: ['xiaohongshu', 'douyin', 'xiaohongshu'],
    }).filter.platforms,
    ['xiaohongshu', 'douyin'],
  );
  assert.equal(
    normalizeNegativePatrolFilter({
      publishDateFrom: '2026-07-01',
      publishDateTo: '2026-07-02',
      platforms: ['xiaohongshu', 'douyin'],
    }).filter.platform,
    'mixed',
  );
  assert.deepEqual(
    normalizeNegativePatrolFilter({
      publishDateFrom: '2026-07-01',
      publishDateTo: '2026-07-02',
      platform: 'mixed',
    }).filter.platforms,
    ['xiaohongshu', 'douyin'],
  );
});

test('manual negative confirmation wins over a pending false-positive review', () => {
  const base = {
    id: '018f04cc-74d8-7000-8000-000000000001',
    platform: 'xiaohongshu',
    external_id: '64abcdeffedcba9876543210',
    sentiment: 'negative',
    false_positive_pending: true,
  };
  const confirmed = publicNegativePatrolCandidate({
    ...base,
    manual_sentiment_present: true,
    manual_sentiment_raw: 'negative',
    normalized_manual_sentiment: 'negative',
    effective_sentiment: 'negative',
    sentiment_source: 'manual_override',
    can_dispatch: true,
    eligibility_code: 'eligible',
  }, {includeBaseline: false});
  assert.equal(confirmed.canDispatch, true);
  assert.equal(confirmed.eligibilityCode, 'eligible');
  assert.equal(confirmed.falsePositivePending, true);

  const unconfirmed = publicNegativePatrolCandidate({
    ...base,
    manual_sentiment_present: false,
    effective_sentiment: 'negative',
    sentiment_source: 'record',
    // Defensively enforce the pending-review rule even if a stale row were
    // projected with an incorrect database flag.
    can_dispatch: true,
    eligibility_code: 'eligible',
  }, {includeBaseline: false});
  assert.equal(unconfirmed.canDispatch, false);
  assert.equal(unconfirmed.eligibilityCode, 'false_positive_pending');
});

test('invalid manual sentiment never falls back to the stored base sentiment', () => {
  const invalidEmpty = publicNegativePatrolCandidate({
    id: '018f04cc-74d8-7000-8000-000000000002',
    platform: 'douyin',
    external_id: '7123456789012345678',
    sentiment: 'negative',
    manual_sentiment_present: true,
    manual_sentiment_raw: '',
    effective_sentiment: '',
    sentiment_source: 'manual_override_invalid',
    can_dispatch: false,
    eligibility_code: 'manual_sentiment_invalid',
  }, {includeBaseline: false});
  assert.equal(invalidEmpty.effectiveSentiment, '');
  assert.equal(invalidEmpty.sentimentSource, 'manual_override_invalid');
  assert.equal(invalidEmpty.canDispatch, false);

  const invalidValue = publicNegativePatrolCandidate({
    ...invalidEmpty,
    manual_sentiment_raw: 'NEGATIV',
    effective_sentiment: 'negativ',
  }, {includeBaseline: false});
  assert.equal(invalidValue.effectiveSentiment, 'negativ');
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

test('preview and create share current-sentiment qualification and tenant scope', () => {
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
  assert.match(route, /r\.platform = ANY\(\$2::text\[\]\)/u);
  assert.match(route, /manual_sentiment_present/u);
  assert.match(route, /normalized_manual_sentiment/u);
  assert.match(route, /effective_sentiment/u);
  assert.match(route, /sentiment_source/u);
  assert.match(route, /LOWER\(BTRIM\(COALESCE\(r\.sentiment, ''\)\)\) = 'negative'/u);
  assert.match(route, /manual_relevance_present/u);
  assert.match(route, /automatic_relevance_filtered/u);
  assert.match(route, /COALESCE\(external_id, ''\) !~/u);
  assert.match(route, /NULLIF\(BTRIM\(r\.publish_time\), ''\) IS NOT NULL/u);
  assert.match(route, /r\.published_ts IS NOT NULL/u);
  assert.match(route, /r\.published_ts >=/u);
  assert.match(route, /AT TIME ZONE 'Asia\/Shanghai'/u);
  assert.match(route, /r\.title ILIKE/u);
  assert.match(route, /r\.content ILIKE/u);
  assert.match(route, /r\.author_name ILIKE/u);
  assert.match(route, /r\.keyword ILIKE/u);
  assert.match(route, /r\.likes \+ r\.comments_count \+ r\.collects \+ r\.shares/u);
  assert.match(route, /record_feedback feedback/u);
  assert.match(route, /feedback\.review_status = 'pending'/u);
  assert.equal(
    route.match(/WHERE feedback\.tenant_id = r\.tenant_id/gu)?.length,
    1,
    'the record_feedback subquery must contain exactly one WHERE clause',
  );
});

test('create writes a per-item server queue without publishing a browser batch', () => {
  const create = section(
    "router.post(\n  '/negative-patrol/tasks'",
    'export default router',
  );
  const queueWriter = section(
    'async function createElasticPatrolTask',
    'export function negativePatrolReassignmentRequestHash',
  );
  assert.match(create, /pg_advisory_xact_lock/u);
  assert.match(create, /const requestHash = patrolRequestHash/u);
  assert.match(create, /candidate_selection_changed/u);
  assert.match(create, /createElasticPatrolTask\(tx/u);
  assert.match(queueWriter, /INSERT INTO capture_tasks/u);
  assert.match(queueWriter, /workflow = 'negative_post_patrol'/u);
  assert.match(queueWriter, /INSERT INTO capture_task_items/u);
  assert.match(queueWriter, /itemType = 'negative_post'/u);
  assert.match(queueWriter, /record_id, external_id, url_snapshot/u);
  assert.match(queueWriter, /serverPerItemDispatchV1/u);
  assert.match(queueWriter, /perItemAdmissionV1/u);
  assert.match(queueWriter, /pinnedAgentId/u);
  assert.doesNotMatch(queueWriter, /INSERT INTO capture_task_item_attempts/u);
  assert.doesNotMatch(queueWriter, /INSERT INTO capture_agent_commands/u);
  assert.match(create, /negative_patrol_dispatch_paused/u);
  assert.doesNotMatch(create, /serverPerItemDispatchEnabled/u);
  assert.match(route, /capabilities\.negativePostPatrol !== true/u);
  assert.match(route, /negativePatrolTerminalReceiptV1/u);
  assert.match(route, /INSERT INTO capture_task_events/u);
  assert.match(create, /INSERT INTO audit_logs/u);
  assert.doesNotMatch(
    create,
    /patrolRequestHash\(\{[\s\S]*?title,\s*title,/u,
    'idempotency hashing must include the title exactly once per call',
  );
});

test('preview pagination and counts use one repeatable-read reporting snapshot', () => {
  const preview = section(
    "router.post(\n  '/negative-patrol/candidates/preview'",
    "router.post(\n  '/watched-content/candidates/preview'",
  );
  assert.match(preview, /withTransaction\(tx => loadCandidates/u);
  assert.match(preview, /category: 'reporting'/u);
  assert.match(preview, /isolationLevel: 'repeatable_read'/u);
  assert.match(preview, /readOnly: true/u);
  assert.match(preview, /isDbCapacityError\(error\) \|\| error\?\.code === '57014'/u);
  assert.match(preview, /res\.set\('Retry-After'/u);
  assert.match(preview, /res\.status\(503\)\.json/u);
  for (const field of [
    'matchedCount',
    'dispatchableCount',
    'deferredCount',
    'nextCursor',
    'hasMore',
  ]) assert.match(preview, new RegExp(`${field}:`, 'u'));
  assert.match(route, /ORDER BY published_ts DESC, id/u);
  assert.match(route, /published_ts < \$/u);
});

test('create rejects candidates whose current dispatch eligibility changed', () => {
  const create = section(
    "router.post(\n  '/negative-patrol/tasks'",
    "router.post(\n  '/negative-patrol/orchestrations/:id/reassign'",
  );
  assert.match(create, /includeTotal: false/u);
  assert.match(create, /includeBaseline: true/u);
  assert.match(create, /candidate\.canDispatch !== true/u);
  assert.match(create, /invalidRecordIds/u);
  assert.match(create, /invalidCandidates/u);
  assert.match(create, /submissionState: 'confirmed'/u);
  assert.match(create, /created: result\.existing !== true/u);
  assert.match(create, /taskId: result\.task\.id/u);

  const watched = section(
    "router.post(\n  '/watched-content/tasks'",
    "router.post(\n  '/negative-patrol/tasks'",
  );
  assert.doesNotMatch(watched, /deferredSelection/u);
});
