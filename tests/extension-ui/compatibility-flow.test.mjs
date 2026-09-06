import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecordEnvelope, serializeRecordEnvelope } from '../../utils/platform/record-envelope.js';
import { adaptStoredSummary, adaptStoredDetail } from '../../extension-ui/adapters/stored-result.mjs';
import { presentResult, presentResultDetail } from '../../extension-ui/domain/result-presenter.mjs';
import { presentResultPage } from '../../extension-ui/domain/result-page.mjs';

// Invoke the actual baseline serializer with synthetic data, not customer snapshots.
function stored(type, data, platform = 'xiaohongshu') {
  return serializeRecordEnvelope(createRecordEnvelope({ type, platform, data }));
}

for (const platform of ['xiaohongshu', 'douyin', 'weibo']) {
  test(`actual ${platform} serialized note reaches the new display model without importing old UI`, () => {
    const source = stored('single_note', { title: '测试记录', author: '测试作者', content: '测试正文', likes: 12, comments: 0, commentsCountKnown: true }, platform);
    assert.equal(Object.hasOwn(source, 'payload'), false);
    const output = presentResult(adaptStoredSummary(source).summary);
    assert.equal(output.id, source.id);
    assert.equal(output.title, '测试记录');
    assert.equal(output.author, '测试作者');
    assert.equal(output.platformLabel, { xiaohongshu: '小红书', douyin: '抖音', weibo: '微博' }[platform]);
    assert.equal(output.metrics[1].value, '0');
    assert.notEqual(output.delivery.key, 'confirmed');
    assert.equal(presentResultDetail(adaptStoredDetail(source)).body, '测试正文');
  });
}

test('historical failed status and a timestamp never turn into a capture failure or confirmed delivery', () => {
  const source = stored('single_note', { title: '已采内容' });
  source.status = 'failed';
  source.lastSyncedAt = 123;
  const { summary, provenance } = adaptStoredSummary(source);
  const output = presentResult(summary);
  assert.equal(output.capture.key, 'unknown');
  assert.notEqual(output.delivery.key, 'confirmed');
  assert.equal(provenance.legacyStatus, 'failed');
});

test('old synced records keep provenance but do not receive automatic retry or synchronization actions', () => {
  const source = stored('single_note', { title: '旧记录' });
  source.status = 'synced';
  const mapped = adaptStoredSummary(source);
  const output = presentResult(mapped.summary);
  assert.equal(mapped.provenance.legacyStatus, 'synced');
  assert.equal(mapped.provenance.confirmation, 'unverified');
  assert.equal(output.needsAttention, true);
  assert.equal(output.delivery.key, 'remote_unconfirmed');
  for (const key of ['actions', 'retry', 'synchronize', 'accepted', 'success']) assert.equal(Object.hasOwn(output, key), false);
});

test('standalone comment completion is kept separate from delivery and truncated preview length', () => {
  const source = stored('comments', {
    noteTitle: '评论对象', totalCount: 80, captureStatus: 'done',
    items: Array.from({ length: 80 }, (_, i) => ({ userName: `测试用户${i}`, content: `测试评论${i}` })),
  });
  const mapped = adaptStoredSummary(source);
  const output = presentResult(mapped.summary);
  const detail = presentResultDetail(adaptStoredDetail(source));
  assert.equal(output.kindLabel, '评论');
  assert.equal(output.capture.key, 'completed');
  assert.equal(output.metrics[1].value, '80');
  assert.equal(detail.comments.length, 50);
  assert.equal(detail.truncated.comments, true);
  assert.notEqual(output.delivery.key, 'confirmed');
  assert.equal(mapped.provenance.captureScope, 'comment_record');
});

test('paged adapter composition never asks for details or old raw payloads', () => {
  const records = Array.from({ length: 1500 }, (_, i) => ({
    id: `record-${i}`, type: 'single_note', platform: 'xiaohongshu', title: `测试记录${i}`,
    normalizedPayload: new Proxy({ author: '测试作者', likes: 3, comments: 4 }, {
      getOwnPropertyDescriptor(target, key) {
        assert.equal(['content', 'body', 'detailPayload', 'commentsCleanedItems'].includes(key), false, key);
        return Object.getOwnPropertyDescriptor(target, key);
      },
    }),
  }));
  for (const record of records) Object.defineProperty(record, 'rawPayload', { get() { assert.fail('raw read'); } });
  const output = presentResultPage(records.map(record => adaptStoredSummary(record).summary), { offset: 50, limit: 50 });
  assert.equal(output.items.length, 50);
  assert.equal(output.items[0].id, 'record-50');
  assert.equal(output.counts.all, 1500);
});

test('long detail preserves upstream crop warnings through both conversion layers', () => {
  const source = stored('single_note', { content: '文'.repeat(12010), commentsCleanedItems: [{ userName: '甲', content: '评'.repeat(1610) }] });
  const output = presentResultDetail(adaptStoredDetail(source));
  assert.equal(output.body.length, 12000);
  assert.equal(output.comments[0].text.length, 1600);
  assert.deepEqual(output.truncated, { body: true, comments: true });
});

test('serializer and adapter never mutate the supplied compatibility fixture', () => {
  const data = { title: '<img src=x onerror=alert(1)>', content: '文字', likes: 1, comments: 2 };
  const before = structuredClone(data);
  const source = stored('single_note', data);
  const snapshot = structuredClone(source);
  const output = presentResult(adaptStoredSummary(source).summary);
  assert.equal(output.title, data.title);
  presentResultDetail(adaptStoredDetail(source));
  assert.deepEqual(data, before);
  assert.deepEqual(source, snapshot);
});
