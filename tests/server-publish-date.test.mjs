import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {
  formatPublishDate,
  parsePublishTimestamp,
} from '../server/services/publish-date.js';

const migration = await readFile(
  new URL(
    '../server/db/migrations/054_restore_iso_publish_timestamps.sql',
    import.meta.url,
  ),
  'utf8',
);

test('ISO UTC timestamps preserve their exact time instead of becoming midnight', () => {
  const parsed = parsePublishTimestamp(
    '2026-03-23T05:02:26.000Z',
    '2026-07-31T06:13:01.000Z',
  );

  assert.equal(parsed?.toISOString(), '2026-03-23T05:02:26.000Z');
});

test('ISO offset timestamps preserve their instant', () => {
  const parsed = parsePublishTimestamp(
    '2026-03-23T13:02:26+08:00',
    '2026-07-31T06:13:01.000Z',
  );

  assert.equal(parsed?.toISOString(), '2026-03-23T05:02:26.000Z');
});

test('date-only and human-readable local timestamps keep existing behavior', () => {
  const dateOnly = parsePublishTimestamp(
    '2026-03-23',
    '2026-07-31T06:13:01.000Z',
  );
  const localDateTime = parsePublishTimestamp(
    '2026-03-23 13:02',
    '2026-07-31T06:13:01.000Z',
  );

  assert.equal(dateOnly?.getFullYear(), 2026);
  assert.equal(dateOnly?.getMonth(), 2);
  assert.equal(dateOnly?.getDate(), 23);
  assert.equal(dateOnly?.getHours(), 0);
  assert.equal(dateOnly?.getMinutes(), 0);
  assert.equal(localDateTime?.getFullYear(), 2026);
  assert.equal(localDateTime?.getMonth(), 2);
  assert.equal(localDateTime?.getDate(), 23);
  assert.equal(localDateTime?.getHours(), 13);
  assert.equal(localDateTime?.getMinutes(), 2);
  assert.equal(
    formatPublishDate(
      '2026-03-23T05:02:26.000Z',
      '2026-07-31T06:13:01.000Z',
    ),
    '2026-03-23',
  );
});

test('future ISO timestamps retain the existing fail-closed guard', () => {
  assert.equal(
    parsePublishTimestamp(
      '2026-08-10T05:02:26.000Z',
      '2026-07-31T06:13:01.000Z',
    ),
    null,
  );
});

test('timestamp repair migration only targets the exact old parser output', () => {
  assert.match(
    migration,
    /WITH strict_iso_candidates AS MATERIALIZED/u,
  );
  assert.match(
    migration,
    /record\.publish_time::timestamptz AS source_timestamp/u,
  );
  assert.match(
    migration,
    /substring\(record\.publish_time, 1, 10\)::date::timestamp[\s\S]*AT TIME ZONE 'Asia\/Shanghai'/u,
  );
  assert.match(
    migration,
    /record\.published_ts = candidate\.old_parser_timestamp/u,
  );
  assert.match(
    migration,
    /manual_overrides[\s\S]*\? 'publish_time'/u,
  );
  assert.doesNotMatch(migration, /SET[\s\S]*updated_at\s*=/u);
});
