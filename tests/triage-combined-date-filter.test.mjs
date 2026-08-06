import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { appendTriageDateFilters } from '../server/routes/triage.js';

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('content triage combines independent date ranges with AND conditions', () => {
  const params = ['tenant-id'];
  const where = appendTriageDateFilters(
    'WHERE r.tenant_id = $1',
    params,
    {
      publishFrom: '2026-07-01',
      publishTo: '2026-07-10',
      recentFrom: '2026-07-20',
      recentTo: '2026-07-31',
    },
  );

  assert.equal(
    where,
    "WHERE r.tenant_id = $1"
      + " AND r.published_ts >= $2::date"
      + " AND r.published_ts < ($3::date + INTERVAL '1 day')"
      + " AND r.last_seen_at >= $4::date"
      + " AND r.last_seen_at < ($5::date + INTERVAL '1 day')",
  );
  assert.deepEqual(params, [
    'tenant-id',
    '2026-07-01',
    '2026-07-10',
    '2026-07-20',
    '2026-07-31',
  ]);
});

test('content triage preserves the legacy single-basis date query', () => {
  const params = ['tenant-id'];
  const where = appendTriageDateFilters(
    'WHERE r.tenant_id = $1',
    params,
    {
      dateFrom: '2026-07-01',
      dateTo: '2026-07-31',
      dateBasis: 'first',
    },
  );

  assert.equal(
    where,
    "WHERE r.tenant_id = $1"
      + " AND r.first_seen_at >= $2::date"
      + " AND r.first_seen_at < ($3::date + INTERVAL '1 day')",
  );
  assert.deepEqual(params, ['tenant-id', '2026-07-01', '2026-07-31']);
});

test('content triage UI keeps each date range and sends it to list and export queries', () => {
  const queue = source('web/admin/src/pages/workbench/TriageQueue.tsx');
  const filter = source('web/admin/src/components/shared/DateRangeFilter.tsx');

  assert.match(queue, /<CombinedDateRangeFilter value=\{dateRanges\} onChange=\{setDateRanges\}/);
  for (const key of ['publishFrom', 'publishTo', 'recentFrom', 'recentTo', 'firstFrom', 'firstTo']) {
    assert.match(queue, new RegExp(`params\\.set\\('${key}'`));
  }
  assert.match(filter, /\['publish', '发布时间'\]/);
  assert.match(filter, /\['first', '首次发现'\]/);
  assert.match(filter, /\['recent', '最近采集'\]/);
  assert.match(filter, /label: '今日'/);
  assert.match(filter, /label: '本周'/);
  assert.match(filter, /label: '本月'/);
  assert.match(filter, /各自保留区间/);
  assert.doesNotMatch(filter, /组合日期筛选/);
});
