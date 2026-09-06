import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptStoredSummary, adaptStoredDetail } from '../../extension-ui/adapters/stored-result.mjs';

// Synthetic records only: the shape is a compatibility contract, not captured data.
function note(overrides = {}) {
  return { id: 'record-1', recordType: 'single_note', platform: 'xiaohongshu', status: 'synced', normalizedPayload: { title: '演示内容', author: '演示作者', likes: 12, comments: 0, commentsCountKnown: true, content: '演示正文' }, ...overrides };
}

test('v2 note fields are adapted without promoting historical synced into current confirmation', () => {
  assert.deepEqual(adaptStoredSummary(note()), {
    summary: { id: 'record-1', title: '演示内容', platform: 'xiaohongshu', kind: 'note', author: '演示作者', summary: '', likes: 12, commentsCount: 0, capture: { status: 'unknown' }, delivery: { remote: 'unknown', local: 'unknown' } },
    provenance: { recordType: 'single_note', legacyStatus: 'synced', confirmation: 'unverified' },
  });
  assert.deepEqual(adaptStoredDetail(note()), { body: '演示正文', comments: [], truncated: { body: false, comments: false } });
});

test('explicit uncertain metric evidence overrides positive fallback values', () => {
  const source = note({ normalizedPayload: { likes: 12, comments: 8, metricKnown: { likes: false }, commentsCountKnown: false } });
  const output = adaptStoredSummary(source).summary;
  assert.equal(output.likes, null);
  assert.equal(output.commentsCount, null);
});

test('conflicting or malformed known flags cannot prove a zero metric', () => {
  for (const unknown of [false, 'true', 1, null]) {
    const source = note({ normalizedPayload: { comments: 0, commentsCountKnown: true, metricKnown: { comments: unknown } } });
    assert.equal(adaptStoredSummary(source).summary.commentsCount, null);
  }
});

test('a present but malformed metric evidence container cannot disappear into positive fallback', () => {
  for (const metricKnown of [null, undefined, 'unknown', [], 1]) {
    const result = adaptStoredSummary(note({ normalizedPayload: { likes: 12, metricKnown } }));
    assert.equal(result.summary.likes, null);
  }
  assert.equal(adaptStoredSummary(note({ normalizedPayload: { likes: 12 } })).summary.likes, 12);
});

test('unreadable metric evidence is not executed or treated as absent', () => {
  let invoked = 0;
  const payload = { likes: 12 };
  Object.defineProperty(payload, 'metricKnown', { get() { invoked += 1; return { likes: true }; } });
  assert.equal(adaptStoredSummary(note({ normalizedPayload: payload })).summary.likes, null);
  assert.equal(invoked, 0);
});

test('Douyin video uses the content kind and explicit platform, not a new stored video type', () => {
  const value = note({ platform: 'douyin', normalizedPayload: { noteType: 'video', title: '演示视频', content: '视频说明' } });
  assert.equal(adaptStoredSummary(value).summary.kind, 'note');
  assert.equal(adaptStoredSummary(value).summary.platform, 'douyin');
  assert.equal(adaptStoredDetail(value).body, '视频说明');
});

for (const type of ['blogger_notes', 'keyword_notes']) {
  test(`${type} reads the single saved list item and keeps detail separate`, () => {
    const value = note({ recordType: type, normalizedPayload: { bloggerName: '主页作者', items: [{ title: '列表标题', author: '列表作者', likes: 9, comments: 3 }], detailCaptureStatus: 'done', detailPayload: { content: '详情正文', commentsCleanedItems: [{ userName: '评论作者', content: '评论文字' }] } } });
    const result = adaptStoredSummary(value).summary;
    assert.equal(result.title, '列表标题'); assert.equal(result.author, '列表作者');
    assert.equal(result.likes, 9); assert.equal(result.commentsCount, 3);
    assert.equal(result.capture.status, 'unknown');
    assert.deepEqual(adaptStoredDetail(value), { body: '详情正文', comments: [{ author: '评论作者', text: '评论文字' }], truncated: { body: false, comments: false } });
  });
}

test('profile aggregate metrics are not mislabeled as note likes or comments', () => {
  const value = note({ recordType: 'blogger_profile', normalizedPayload: { bloggerName: '演示主页', description: '简介', likedAndCollectedCount: 300, followersCount: 70, bloggerMetricsCaptureStatus: 'done' } });
  const result = adaptStoredSummary(value).summary;
  assert.equal(result.kind, 'profile'); assert.equal(result.title, '演示主页'); assert.equal(result.author, '演示主页');
  assert.equal(result.summary, ''); assert.equal(result.likes, null); assert.equal(result.commentsCount, null); assert.equal(result.capture.status, 'unknown');
  assert.equal(adaptStoredDetail(value).body, '简介');
});

for (const [status, mapped] of [['done', 'completed'], ['partial', 'partial'], ['failed', 'failed'], ['capturing', 'running'], ['not_started', 'pending'], ['success', 'unknown']]) {
  test(`standalone comments ${status} is scoped to that comment record`, () => {
    const value = note({ recordType: 'comments', normalizedPayload: { noteTitle: '关联内容', totalCount: 7, captureStatus: status, items: [{ userName: '演示甲', content: '演示评论' }] } });
    const result = adaptStoredSummary(value);
    assert.equal(result.summary.kind, 'comments'); assert.equal(result.summary.commentsCount, 7); assert.equal(result.summary.capture.status, mapped);
    assert.equal(result.provenance.captureScope, 'comment_record');
    assert.deepEqual(adaptStoredDetail(value).comments, [{ author: '演示甲', text: '演示评论' }]);
  });
}

for (const status of ['draft', 'synced', 'failed', 'success']) {
  test(`legacy ${status}, timestamps and caller claims cannot authorize delivery`, () => {
    const value = note({ status, lastSyncedAt: 123, delivery: { remote: 'confirmed', local: 'confirmed' }, provenance: { confirmation: 'verified' }, capture: { status: 'success' } });
    const result = adaptStoredSummary(value);
    assert.deepEqual(result.summary.delivery, { remote: 'unknown', local: 'unknown' });
    assert.equal(result.summary.capture.status, 'unknown'); assert.equal(result.provenance.confirmation, 'unverified');
  });
}

test('summary cannot inspect heavy detail or comment entries and never falls back to body for a summary', () => {
  const forbidden = () => { throw new Error('heavy field inspected'); };
  const payload = { title: '轻量标题', likes: 2, comments: 4 };
  for (const field of ['content', 'body', 'description', 'commentsCleanedItems', 'detailPayload']) Object.defineProperty(payload, field, { get: forbidden });
  const value = note({ normalizedPayload: payload });
  Object.defineProperty(value, 'rawPayload', { get: forbidden });
  assert.equal(adaptStoredSummary(value).summary.title, '轻量标题');
  assert.equal(adaptStoredSummary(value).summary.summary, '');
});

test('summary reads no comment array entries or array lengths', () => {
  const items = new Proxy([{ content: 'should not inspect' }], { getOwnPropertyDescriptor() { throw new Error('comments array inspected'); } });
  const value = note({ recordType: 'comments', normalizedPayload: { items, totalCount: 3 } });
  assert.equal(adaptStoredSummary(value).summary.commentsCount, 3);
});

test('summary never even requests descriptors for heavy fields or raw payload', () => {
  const requested = [];
  const payload = new Proxy({ title: '轻量标题', comments: 9 }, { getOwnPropertyDescriptor(target, key) { requested.push(key); return Object.getOwnPropertyDescriptor(target, key); } });
  const value = new Proxy(note({ normalizedPayload: payload }), { getOwnPropertyDescriptor(target, key) { requested.push(key); return Object.getOwnPropertyDescriptor(target, key); } });
  adaptStoredSummary(value);
  for (const key of ['rawPayload', 'content', 'body', 'description', 'commentsCleanedItems', 'detailPayload']) assert.equal(requested.includes(key), false, key);
});

test('list summary reads only slot zero and shallow light fields', () => {
  let inspectedSecond = 0;
  const items = [{ title: '第一条', likes: 3 }];
  Object.defineProperty(items, '1', { get() { inspectedSecond += 1; throw new Error('second item'); } });
  assert.equal(adaptStoredSummary(note({ recordType: 'keyword_notes', normalizedPayload: { items } })).summary.title, '第一条');
  assert.equal(inspectedSecond, 0);
});

test('malformed list items objects cannot masquerade as a stored list array', () => {
  const value = note({ recordType: 'keyword_notes', normalizedPayload: { items: { 0: { title: '伪造项', content: '伪造正文', likes: 9 } } } });
  assert.equal(adaptStoredSummary(value).summary.title, '');
  assert.equal(adaptStoredSummary(value).summary.likes, null);
  assert.equal(adaptStoredDetail(value).body, '');
});

for (const corrupted of [null, undefined, [], 'bad', 7]) {
  test(`present corrupt normalized payload does not resurrect older payload: ${String(corrupted)}`, () => {
    const value = note({ normalizedPayload: corrupted, payload: { title: '旧数据', content: '旧正文' }, data: { title: '更旧数据' }, rawPayload: { title: '原始数据' } });
    assert.equal(adaptStoredSummary(value).summary.title, ''); assert.equal(adaptStoredDetail(value).body, '');
  });
}

test('legacy payload then data are supported only when preferred fields are absent', () => {
  for (const key of ['payload', 'data']) {
    const value = { id: 'old-1', type: 'single_note', [key]: { title: '旧格式标题', content: '旧格式正文' } };
    assert.equal(adaptStoredSummary(value).summary.title, '旧格式标题'); assert.equal(adaptStoredDetail(value).body, '旧格式正文');
  }
  assert.equal(adaptStoredSummary({ id: 'raw-only', rawPayload: { title: '不可回退' } }).summary.title, '');
});

test('own accessor fields are not executed and inherited fields are not accepted', () => {
  let reads = 0;
  const value = Object.create({ id: 'inherited', recordType: 'single_note', platform: 'douyin' });
  Object.defineProperty(value, 'normalizedPayload', { get() { reads += 1; return { title: 'getter' }; } });
  assert.equal(adaptStoredSummary(value).summary.id, ''); assert.equal(adaptStoredSummary(value).summary.kind, 'unknown');
  assert.equal(adaptStoredDetail(value).body, ''); assert.equal(reads, 0);
});

test('platform is explicit, never inferred from URLs or aliases', () => {
  assert.equal(adaptStoredSummary(note({ platform: 'unknown', normalizedPayload: { url: 'https://www.douyin.com/video/1' } })).summary.platform, 'unknown');
  assert.equal(adaptStoredSummary({ id: 'explicit', type: 'single_note', payload: { platform: 'douyin' } }).summary.platform, 'douyin');
  assert.equal(adaptStoredSummary(note({ platform: 'xhs' })).summary.platform, 'unknown');
});

test('zero metrics require explicit evidence; absent values and aggregate comment previews stay unknown', () => {
  const value = note({ normalizedPayload: { likes: 0, comments: 0, commentsCleanedItems: [{ content: '只有一条' }] } });
  assert.equal(adaptStoredSummary(value).summary.likes, null); assert.equal(adaptStoredSummary(value).summary.commentsCount, null);
  value.normalizedPayload.metricKnown = { likes: true, comments: true };
  assert.equal(adaptStoredSummary(value).summary.likes, 0); assert.equal(adaptStoredSummary(value).summary.commentsCount, 0);
});

for (const invalid of [-1, 0.5, '12', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, {}, []]) {
  test(`invalid metrics are not coerced: ${String(invalid)}`, () => {
    const result = adaptStoredSummary(note({ normalizedPayload: { likes: invalid, comments: invalid } })).summary;
    assert.equal(result.likes, null); assert.equal(result.commentsCount, null);
  });
}

test('explicit hold flags and allowlisted codes only raise caution, never a release', () => {
  for (const signal of [{ reconciliationRequired: true }, { requiresReconciliation: true }, { error: { code: 'LOCAL_CONFIRMATION_REQUIRED' } }, { streamingSync: { reconciliationRequired: true } }]) {
    assert.equal(adaptStoredSummary(note(signal)).summary.reconciliationRequired, true);
  }
  for (const signal of [{ reconciliationRequired: 'true' }, { streamingSync: { code: 'LOCAL_CONFIRMATION_REQUIRED' } }, { rawResponse: { reconciliationRequired: true } }, { message: 'SYNC_RECONCILIATION_REQUIRED' }]) {
    assert.equal(Object.hasOwn(adaptStoredSummary(note(signal)).summary, 'reconciliationRequired'), false);
  }
});

test('strict IDs are not trimmed, truncated, stringified or repaired', () => {
  for (const id of ['', 'x'.repeat(129), ' leading', 'trailing ', 'has space', 'a\u0000b', 'a\u007Fb', 'a\u202Eb', 'a\uD800b', 12, { toString() { throw new Error('coercion'); } }]) {
    assert.equal(adaptStoredSummary(note({ id })).summary.id, '');
  }
  for (const id of ['record-1', 'x'.repeat(128), '中文-😀']) assert.equal(adaptStoredSummary(note({ id })).summary.id, id);
});

test('detail is bounded and flags body, comment quantity and per-comment truncation', () => {
  const value = note({ normalizedPayload: { content: '😀'.repeat(7000), commentsCleanedItems: Array.from({ length: 55 }, () => ({ userName: '甲', content: '😀'.repeat(1000) })) } });
  const result = adaptStoredDetail(value);
  assert.ok(result.body.length <= 12000); assert.equal(result.comments.length, 50); assert.ok(result.comments.every(item => item.text.length <= 1600));
  assert.deepEqual(result.truncated, { body: true, comments: true });
  assert.equal(/[\uD800-\uDBFF]$/u.test(result.body), false);
});

test('detail never reads entries beyond 50, accessors, array iteration or length getters', () => {
  let getterCalls = 0;
  const comments = [{ userName: '甲', content: '第一条' }];
  Object.defineProperty(comments, '1', { get() { getterCalls += 1; throw new Error('getter'); } });
  Object.defineProperty(comments, '50', { get() { getterCalls += 1; throw new Error('outside prefix'); } });
  comments[Symbol.iterator] = () => { throw new Error('iteration'); };
  const result = adaptStoredDetail(note({ normalizedPayload: { commentsCleanedItems: comments } }));
  assert.deepEqual(result.comments, [{ author: '甲', text: '第一条' }]); assert.equal(result.truncated.comments, true); assert.equal(getterCalls, 0);
});

test('invalid preferred detail and comment text do not revive older content', () => {
  const value = note({ recordType: 'keyword_notes', normalizedPayload: { items: [{ content: '旧列表正文' }], detailPayload: [] } });
  assert.equal(adaptStoredDetail(value).body, '');
  assert.deepEqual(adaptStoredDetail(note({ recordType: 'comments', normalizedPayload: { items: [{ content: null, commentContent: '旧评论' }] } })).comments, []);
});

test('outputs are independent plain values and source objects are unchanged', () => {
  const value = note({ summary: '摘要', normalizedPayload: { title: '标题', content: '正文', commentsCleanedItems: [{ userName: '甲', content: '评论' }] } });
  const before = structuredClone(value);
  Object.freeze(value.normalizedPayload.commentsCleanedItems[0]); Object.freeze(value.normalizedPayload); Object.freeze(value);
  const result = adaptStoredDetail(value); result.comments[0].text = '修改输出';
  adaptStoredSummary(value).summary.title = '修改标题';
  assert.deepEqual(value, before);
});

test('revoked proxies and throwing descriptor traps produce conservative values without throwing', () => {
  const proxy = Proxy.revocable({}, {}); proxy.revoke();
  const hostile = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('trap'); } });
  for (const value of [proxy.proxy, hostile, undefined, null, [], () => {}, 3]) {
    assert.equal(adaptStoredSummary(value).summary.id, '');
    assert.deepEqual(adaptStoredSummary(value).summary.delivery, { remote: 'unknown', local: 'unknown' });
    assert.deepEqual(adaptStoredDetail(value), { body: '', comments: [], truncated: { body: false, comments: false } });
  }
});
