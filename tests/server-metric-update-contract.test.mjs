import assert from 'node:assert/strict';
import test from 'node:test';

import {normalizeRecord} from '../server/routes/sync.js';
import {
  guardRecordCommentCount,
  mergeObservationMetrics,
  resolveGuardedCommentsCount,
} from '../server/services/record-store.js';
import {
  resolveMetricUpdateFromPayload,
  resolveRecordMetrics,
} from '../server/utils/metrics.js';

const COMMENT_KEYS = [
  'comments',
  'commentCount',
  'comment_count',
  'commentsCount',
  'comments_count',
];
const COLLECT_KEYS = [
  'collects',
  'collectCount',
  'collect_count',
  'collectsCount',
  'collects_count',
];

test('legacy likes-only list payload does not turn comments or collects into zero', () => {
  const payload = {
    syncType: 'keyword_notes',
    items: [{
      likes: 8,
      comments: 0,
      collects: 0,
      displayMetricDimension: 'likes',
      displayMetricCount: 8,
    }],
  };

  assert.equal(
    resolveMetricUpdateFromPayload(payload, 'likes', ['likes']),
    8,
  );
  assert.equal(
    resolveMetricUpdateFromPayload(payload, 'comments', COMMENT_KEYS),
    null,
  );
  assert.equal(
    resolveMetricUpdateFromPayload(payload, 'collects', COLLECT_KEYS),
    null,
  );
});

test('sync normalization preserves unknown list metrics as null', () => {
  const [record] = normalizeRecord({
    syncType: 'keyword_notes',
    platform: 'xiaohongshu',
    payload: {
      items: [{
        noteId: 'note-1',
        likes: 8,
        comments: 0,
        collects: 0,
        displayMetricDimension: 'likes',
        displayMetricCount: 8,
      }],
    },
  });

  assert.equal(record.likes, 8);
  assert.equal(record.comments_count, null);
  assert.equal(record.collects, null);
});

test('sync normalization preserves comment count certainty and source', () => {
  const [record] = normalizeRecord({
    syncType: 'single_note',
    platform: 'douyin',
    payload: {
      noteId: 'douyin-1',
      comments: 22,
      commentsCountKnown: true,
      commentsCountSource: 'api_statistics',
    },
  });

  assert.equal(record.comments_count, 22);
  assert.equal(record.comments_count_known, true);
  assert.equal(record.comments_count_source, 'api_statistics');
});

test('confirmed zero updates while an unproven displayed zero stays unknown', () => {
  assert.equal(
    resolveMetricUpdateFromPayload(
      {items: [{comments: 0, metricKnown: {comments: true}}]},
      'comments',
      COMMENT_KEYS,
    ),
    0,
  );
  assert.equal(
    resolveMetricUpdateFromPayload(
      {
        items: [{
          comments: 0,
          displayMetricDimension: 'comments',
          displayMetricCount: 0,
        }],
      },
      'comments',
      COMMENT_KEYS,
    ),
    null,
  );
});

test('a completed detail may explicitly report zero, partial detail may not', () => {
  const complete = {
    detailCaptureStatus: 'done',
    detailPayload: {comments: 0, collects: 0},
  };
  const partial = {
    detailCaptureStatus: 'failed',
    detailPayload: {comments: 0, collects: 0},
  };

  assert.equal(
    resolveMetricUpdateFromPayload(complete, 'comments', COMMENT_KEYS),
    0,
  );
  assert.equal(
    resolveMetricUpdateFromPayload(complete, 'collects', COLLECT_KEYS),
    0,
  );
  assert.equal(
    resolveMetricUpdateFromPayload(partial, 'comments', COMMENT_KEYS),
    null,
  );
  assert.equal(
    resolveMetricUpdateFromPayload(partial, 'collects', COLLECT_KEYS),
    null,
  );
});

test('observation snapshots inherit stored metrics only for unknown fields', () => {
  const existing = {
    likes: 8,
    comments_count: 7,
    collects: 1,
    shares: 2,
  };

  assert.deepEqual(
    mergeObservationMetrics(
      {likes: 9, comments_count: null, collects: undefined, shares: 0},
      existing,
    ),
    {likes: 9, comments_count: 7, collects: 1, shares: 0},
  );
});

test('latest proven zero wins over an older enhanced payload on reads', () => {
  const metrics = resolveRecordMetrics({
    likes: 8,
    comments_count: 0,
    collects: 0,
    shares: 0,
    observation_payload: {
      items: [{comments: 0, metricKnown: {comments: true}}],
    },
    record_payload: {
      detailCaptureStatus: 'done',
      detailPayload: {comments: 7, collects: 1},
    },
  });

  assert.equal(metrics.comments_count, 0);
  assert.equal(metrics.collects, 1);
});

test('unknown latest metrics fall back to the older enhanced values', () => {
  const metrics = resolveRecordMetrics({
    likes: 8,
    comments_count: 0,
    collects: 0,
    shares: 0,
    observation_payload: {
      items: [{
        comments: 0,
        collects: 0,
        displayMetricDimension: 'likes',
        displayMetricCount: 8,
      }],
    },
    record_payload: {
      detailCaptureStatus: 'done',
      detailPayload: {comments: 7, collects: 1},
    },
  });

  assert.equal(metrics.comments_count, 7);
  assert.equal(metrics.collects, 1);
});

test('legacy comment count cannot overwrite a trusted stored count', () => {
  const existing = {
    comments_count: 22,
    payload: {
      comments: 22,
      commentsCountKnown: true,
      commentsCountSource: 'api_statistics',
    },
  };
  const decision = resolveGuardedCommentsCount(
    {comments_count: 23, payload: {comments: 23}},
    existing,
  );

  assert.equal(decision.value, 22);
  assert.equal(decision.preserved, true);
  assert.equal(decision.reason, 'untrusted_regression');
});

test('repeated DOM concatenation is blocked for records and observations', () => {
  const existing = {
    comments_count: 35,
    payload: {
      comments: 35,
      commentsCountKnown: true,
      commentsCountSource: 'api_statistics',
    },
  };
  const guarded = guardRecordCommentCount({
    comments_count: 3535,
    comments_count_known: true,
    comments_count_source: 'dom_count',
    payload: JSON.stringify({
      comments: 3535,
      commentsCountKnown: true,
      commentsCountSource: 'dom_count',
    }),
  }, existing);

  assert.equal(guarded.comments_count, 35);
  assert.equal(JSON.parse(guarded.payload).comments, 35);
  assert.equal(
    mergeObservationMetrics(guarded, existing).comments_count,
    35,
  );
});

test('trusted API evidence may repair a bad old count and record real growth', () => {
  const oldBad = {
    comments_count: 2222,
    payload: {
      comments: 2222,
      commentsCountKnown: true,
      commentsCountSource: 'legacy_known',
    },
  };
  const repaired = resolveGuardedCommentsCount({
    comments_count: 22,
    comments_count_known: true,
    comments_count_source: 'api_statistics',
    payload: {
      comments: 22,
      commentsCountKnown: true,
      commentsCountSource: 'api_statistics',
    },
  }, oldBad);
  const grown = resolveGuardedCommentsCount({
    comments_count: 36,
    comments_count_known: true,
    comments_count_source: 'api_statistics',
    payload: {
      comments: 36,
      commentsCountKnown: true,
      commentsCountSource: 'api_statistics',
    },
  }, {
    comments_count: 35,
    payload: {
      comments: 35,
      commentsCountKnown: true,
      commentsCountSource: 'api_statistics',
    },
  });

  assert.equal(repaired.value, 22);
  assert.equal(repaired.preserved, false);
  assert.equal(grown.value, 36);
  assert.equal(grown.preserved, false);
});
