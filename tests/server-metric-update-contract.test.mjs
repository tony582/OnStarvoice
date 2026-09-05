import assert from 'node:assert/strict';
import test from 'node:test';

import {buildSyncAiJob, normalizeRecord} from '../server/routes/sync.js';
import {
  assertCaptureAttemptLineage,
  captureAttemptLineageStrictlyRequired,
  guardRecordCommentCount,
  guardRecordTextCompleteness,
  isCapturedRecordIdentityConflict,
  mergeObservationMetrics,
  normalizeCapturedRecordLinks,
  retryCapturedRecordIdentityConflict,
  resolveDouyinCanonicalRecordUrl,
  resolveXhsCanonicalRecordUrl,
  resolveXhsSourceRecordUrl,
  resolveGuardedCommentsCount,
  resolveCapturedTextUpdate,
  resolveRecordBusinessVisibility,
  resolveRecordRelabelReason,
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

test('record identity conflicts retry once after the losing transaction rolls back', async () => {
  let calls = 0;
  const result = await retryCapturedRecordIdentityConflict(async () => {
    calls += 1;
    if (calls === 1) {
      throw Object.assign(new Error('duplicate record'), {
        code: '23505',
        constraint: 'uniq_records_external_id',
      });
    }
    return {action: 'updated'};
  });

  assert.equal(calls, 2);
  assert.deepEqual(result, {action: 'updated'});
  assert.equal(isCapturedRecordIdentityConflict({
    code: '23505',
    constraint: 'uniq_records_content_hash',
  }), true);
});

test('record identity conflict retry is bounded and ignores unrelated unique errors', async () => {
  let boundedCalls = 0;
  await assert.rejects(
    retryCapturedRecordIdentityConflict(async () => {
      boundedCalls += 1;
      throw Object.assign(new Error('still duplicated'), {
        code: '23505',
        constraint: 'uniq_records_external_id',
      });
    }),
    /still duplicated/u,
  );
  assert.equal(boundedCalls, 2);

  let unrelatedCalls = 0;
  await assert.rejects(
    retryCapturedRecordIdentityConflict(async () => {
      unrelatedCalls += 1;
      throw Object.assign(new Error('other unique key'), {
        code: '23505',
        constraint: 'some_other_constraint',
      });
    }),
    /other unique key/u,
  );
  assert.equal(unrelatedCalls, 1);
});

test('cloud sync with an exact-attempt contract rejects missing lineage', () => {
  const context = {
    captureTaskId: '10000000-0000-4000-8000-000000000001',
    captureTaskItemAttemptId: '20000000-0000-4000-8000-000000000001',
    captureTaskItemRequestHash: 'a'.repeat(64),
  };
  assert.equal(captureAttemptLineageStrictlyRequired(context), true);
  assert.throws(
    () => assertCaptureAttemptLineage(context, null),
    error => error?.code === 'stale_attempt' && error?.statusCode === 409,
  );
  const lineage = {capture_task_item_attempt_id: context.captureTaskItemAttemptId};
  assert.strictEqual(assertCaptureAttemptLineage(context, lineage), lineage);
  assert.equal(captureAttemptLineageStrictlyRequired({
    ...context,
    captureTaskItemRequestHash: '',
  }), false);
});

test('Douyin search navigation URLs are not persisted as original work URLs', () => {
  const imageRecord = {
    platform: 'douyin',
    external_id: '7679243972795505774',
    note_type: 'image',
    url: 'https://www.douyin.com/search/%E5%AE%89%E5%90%89%E6%98%9F?type=general&modal_id=7679243972795505774',
    payload: {
      detailCaptureStatus: 'failed',
      detailCaptureNoteUrl: 'https://www.douyin.com/note/7679243972795505774?previous_page=search_result',
    },
  };
  const videoRecord = {
    platform: 'douyin',
    external_id: '7679329980892269553',
    note_type: 'video',
    url: 'https://www.douyin.com/search/%E5%AE%89%E5%90%89%E6%98%9F?modal_id=7679329980892269553',
    payload: JSON.stringify({detailCaptureStatus: 'failed'}),
  };

  assert.equal(
    resolveDouyinCanonicalRecordUrl(imageRecord),
    'https://www.douyin.com/note/7679243972795505774',
  );
  assert.deepEqual(normalizeCapturedRecordLinks(videoRecord), {
    ...videoRecord,
    url: 'https://www.douyin.com/video/7679329980892269553',
    canonical_url: 'https://www.douyin.com/video/7679329980892269553',
  });
  assert.equal(
    JSON.parse(normalizeCapturedRecordLinks(videoRecord).payload).detailCaptureStatus,
    'failed',
  );
});

test('Douyin canonical link normalization is conservative without a proven work type', () => {
  const searchOnly = {
    platform: 'douyin',
    external_id: '7679243972795505774',
    url: 'https://www.douyin.com/search/test?modal_id=7679243972795505774',
  };
  const direct = {
    platform: 'douyin',
    external_id: '7679243972795505774',
    url: 'https://www.douyin.com/note/7679243972795505774?foo=bar#comments',
  };
  const xiaohongshu = {
    platform: 'xiaohongshu',
    external_id: '7679243972795505774',
    note_type: 'image',
    url: 'https://www.xiaohongshu.com/search_result?keyword=test',
  };

  assert.equal(resolveDouyinCanonicalRecordUrl(searchOnly), '');
  assert.strictEqual(normalizeCapturedRecordLinks(searchOnly), searchOnly);
  assert.equal(
    resolveDouyinCanonicalRecordUrl(direct),
    'https://www.douyin.com/note/7679243972795505774',
  );
  assert.deepEqual(normalizeCapturedRecordLinks(xiaohongshu), {
    ...xiaohongshu,
    url: '',
    canonical_url: 'https://www.xiaohongshu.com/explore/7679243972795505774',
  });
});

test('Xiaohongshu keeps complete navigation URL separate from stable identity URL', () => {
  const record = {
    platform: 'xiaohongshu',
    external_id: '6a92558e000000001f000325',
    url: 'https://www.xiaohongshu.com/search_result/6a92558e000000001f000325?xsec_token=temporary&xsec_source=pc_search',
    payload: JSON.stringify({
      detailCaptureStatus: 'failed',
      detailCaptureFailureCode: 'PAGE_OPEN_TIMEOUT',
    }),
  };

  assert.equal(
    resolveXhsCanonicalRecordUrl(record),
    'https://www.xiaohongshu.com/explore/6a92558e000000001f000325',
  );
  assert.equal(resolveXhsSourceRecordUrl(record), record.url);
  assert.deepEqual(normalizeCapturedRecordLinks(record), {
    ...record,
    url: record.url,
    canonical_url: 'https://www.xiaohongshu.com/explore/6a92558e000000001f000325',
  });
});

test('Xiaohongshu restores the clicked detail URL from payload instead of the bare record URL', () => {
  const noteId = '68e8d33e0000000005032c3f';
  const clickedUrl = `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=fresh-detail-token&xsec_source=pc_search`;
  const record = {
    platform: 'xiaohongshu',
    external_id: noteId,
    url: `https://www.xiaohongshu.com/explore/${noteId}`,
    payload: {
      detailCaptureNoteUrl: `https://www.xiaohongshu.com/search_result/${noteId}?xsec_token=fresh-detail-token&xsec_source=pc_search`,
      items: [{
        noteId,
        url: clickedUrl,
        noteUrl: clickedUrl,
      }],
    },
  };

  assert.equal(resolveXhsSourceRecordUrl(record), clickedUrl);
  assert.deepEqual(normalizeCapturedRecordLinks(record), {
    ...record,
    url: clickedUrl,
    canonical_url: `https://www.xiaohongshu.com/explore/${noteId}`,
  });
});

test('Xiaohongshu rejects bare, insecure and wrong-note URLs as source navigation', () => {
  const noteId = '6a92558e000000001f000325';
  const record = {
    platform: 'xiaohongshu',
    external_id: noteId,
    url: `https://www.xiaohongshu.com/explore/${noteId}`,
    payload: {
      items: [{
        noteId,
        url: `https://www.xiaohongshu.com/explore/6a92558e000000001f000399?xsec_token=wrong-note`,
      }],
      detailCaptureNoteUrl: `http://www.xiaohongshu.com/search_result/${noteId}?xsec_token=insecure`,
      noteUrl: `https://www.xiaohongshu.com:444/explore/${noteId}?xsec_token=wrong-port`,
    },
  };

  assert.equal(resolveXhsSourceRecordUrl(record), '');
  assert.deepEqual(normalizeCapturedRecordLinks(record), {
    ...record,
    url: '',
    canonical_url: `https://www.xiaohongshu.com/explore/${noteId}`,
  });
});

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

test('a collapsed prefix cannot overwrite a more complete captured body', () => {
  const full = '接到安吉星续费推销电话。客服原话：套餐即将到期，到期所有功能都会被婉拒。';
  const short = '接到安吉星续费推销电话。客服原话：套餐即将到期，到期所';
  assert.deepEqual(resolveCapturedTextUpdate(full, short), {
    value: full,
    preserved: true,
    reason: 'truncated_prefix',
  });
  assert.equal(resolveCapturedTextUpdate(short, full).value, full);
  assert.equal(resolveCapturedTextUpdate(full, '作者重新编辑后的另一段内容').value, '作者重新编辑后的另一段内容');

  const guarded = guardRecordTextCompleteness({
    platform: 'douyin',
    title: short,
    content: short,
    payload: JSON.stringify({
      title: short,
      content: short,
      contentCompleteness: 'unverified_dom',
    }),
  }, { title: full, content: full });
  assert.equal(guarded.title, full);
  assert.equal(guarded.content, full);
  assert.equal(JSON.parse(guarded.payload).content, full);

  const legacyGuarded = guardRecordTextCompleteness({
    platform: 'douyin',
    title: short,
    content: short,
    payload: JSON.stringify({ title: short, content: short }),
  }, { title: full, content: full });
  assert.equal(legacyGuarded.content, full);

  const verifiedShortEdit = guardRecordTextCompleteness({
    platform: 'douyin',
    title: short,
    content: short,
    payload: JSON.stringify({
      title: short,
      content: short,
      contentCompleteness: 'complete',
    }),
  }, { title: full, content: full });
  assert.equal(verifiedShortEdit.content, short);
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

test('capture enrichment and new keyword context request a bounded AI relabel', () => {
  const filtered = {
    keyword: '凯迪拉克车机升级',
    content: '',
    comments_text: '',
    payload: {detailCaptureStatus: 'filtered'},
    ai_result: {relevance: 'irrelevant'},
  };
  assert.equal(
    resolveRecordRelabelReason(
      filtered,
      {
        keyword: '安吉星',
        content: '车辆经常莫名拨打紧急救援电话。',
        payload: {detailCaptureStatus: 'done'},
      },
      ['content', 'payload'],
    ),
    'detail_completed',
  );
  assert.equal(
    resolveRecordRelabelReason(
      {...filtered, payload: {detailCaptureStatus: 'done'}},
      {keyword: '安吉星', payload: {detailCaptureStatus: 'done'}},
      [],
    ),
    'new_keyword_context',
  );
  assert.equal(
    resolveRecordRelabelReason(
      {...filtered, payload: {detailCaptureStatus: 'done'}, ai_result: {relevance: 'relevant'}},
      {keyword: '安吉星', payload: {detailCaptureStatus: 'done'}},
      [],
    ),
    '',
  );
  assert.equal(
    resolveRecordRelabelReason(
      {...filtered, payload: {detailCaptureStatus: 'done'}},
      {keyword: filtered.keyword, comments_text: '新增负面评论', payload: {detailCaptureStatus: 'done'}},
      ['comments_text'],
    ),
    'comments_enriched',
  );
});

test('sync forces AI only for enriched updates while preserving normal inserts', () => {
  assert.deepEqual(
    buildSyncAiJob({id: 'new-record', action: 'inserted'}),
    {id: 'new-record', force: false},
  );
  assert.deepEqual(
    buildSyncAiJob({
      id: 'existing-record',
      action: 'updated',
      shouldRelabel: true,
      relabelReason: 'new_keyword_context',
    }),
    {id: 'existing-record', force: true, reason: 'new_keyword_context'},
  );
  assert.equal(buildSyncAiJob({id: 'existing-record', action: 'updated'}), null);
  assert.equal(buildSyncAiJob({
    id: 'filtered-record',
    action: 'inserted',
    businessVisibility: 'filtered_out',
  }), null);
  assert.equal(buildSyncAiJob({
    id: 'deferred-record',
    action: 'updated',
    shouldRelabel: true,
    businessVisibility: 'deferred',
  }), null);
});

test('prefilter audit projects records into one explicit business visibility state', () => {
  assert.equal(resolveRecordBusinessVisibility({
    payload: {detailCaptureStatus: 'filtered'},
  }), 'filtered_out');
  assert.equal(resolveRecordBusinessVisibility({
    payload: {
      aiRelevancePrefilter: {modelExecutionDisposition: 'skip_full_capture'},
    },
  }), 'filtered_out');
  assert.equal(resolveRecordBusinessVisibility({
    payload: {detailCaptureStatus: 'deferred'},
  }), 'deferred');
  assert.equal(resolveRecordBusinessVisibility({
    payload: {
      aiRelevancePrefilter: {executionDisposition: 'collect_minimal_detail'},
    },
  }), 'eligible');
  assert.equal(resolveRecordBusinessVisibility(
    {payload: {}},
    {business_visibility: 'deferred'},
  ), 'deferred');
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
