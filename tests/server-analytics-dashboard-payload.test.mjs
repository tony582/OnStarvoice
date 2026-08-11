import test from 'node:test';
import assert from 'node:assert/strict';

import { compactAnalyticsDashboard } from '../server/services/analytics-dashboard-payload.js';

test('interactive dashboard payload excludes raw platform payloads and duplicate sample pools', () => {
  const oversized = 'x'.repeat(250_000);
  const contentRow = {
    id: 'record-1',
    title: '重点内容',
    content: oversized,
    ai_summary: oversized,
    payload: { raw: oversized },
    image_urls: [oversized],
    platform: 'douyin',
    author_name: '作者',
    likes: 10,
    comments_count: 2,
    collects: 3,
    shares: 4,
    negative_comment_count: 1,
  };
  const compact = compactAnalyticsDashboard({
    total: 1,
    newRecords: 1,
    topInteraction: [contentRow],
    topNegative: [contentRow],
    sentimentSamples: [contentRow],
    topicFocus: [{ samples: [contentRow] }],
    negativeComments: [{
      id: 'comment-1',
      content: oversized,
      author_name: '评论者',
      record_title: '原帖',
    }],
    previous: {
      total: 2,
      newRecords: 2,
      negativeRate: 10,
      sentimentMap: { positive: 1, negative: 1 },
      sentimentSamples: [contentRow],
    },
  });

  assert.equal(compact.topInteraction.length, 1);
  assert.equal(compact.riskItems.length, 1);
  assert.equal(compact.commentRisks.length, 1);
  assert.equal(compact.previous.total, 2);
  assert.equal(compact.topInteraction[0].payload, undefined);
  assert.equal(compact.topInteraction[0].image_urls, undefined);
  assert.equal(compact.sentimentSamples, undefined);
  assert.equal(compact.topicFocus, undefined);
  assert.equal(compact.previous.sentimentSamples, undefined);
  assert.ok(compact.topInteraction[0].content.length <= 320);
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) < 10_000);
});
