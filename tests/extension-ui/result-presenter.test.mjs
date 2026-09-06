import test from 'node:test';
import assert from 'node:assert/strict';
import { presentResult, presentResultDetail } from '../../extension-ui/domain/result-presenter.mjs';
import { exactRecordId } from '../../extension-ui/domain/record-id.mjs';

function record(overrides = {}) {
  return {
    id: 'result-1', title: '独立采集结果', platform: 'xiaohongshu', kind: 'note', author: '作者', summary: '内容摘要', body: '正文内容',
    likes: 12, commentsCount: 0, comments: [], capture: { status: 'completed' },
    delivery: { remote: 'confirmed', local: 'confirmed' }, reconciliationRequired: false, ...overrides,
  };
}

test('projects the complete independent display contract with successful states', () => {
  assert.deepEqual(presentResult(record()), {
    id: 'result-1', title: '独立采集结果', platformLabel: '小红书', kindLabel: '内容', author: '作者', summary: '内容摘要',
    metrics: [{ label: '点赞', value: '12' }, { label: '评论', value: '0' }],
    capture: { key: 'completed', label: '采集已完成' },
    delivery: { key: 'confirmed', label: '服务器与本地均已确认', tone: 'success' },
    needsAttention: false,
    review: { unverified: false, hasIssue: false, interventionReported: false, reasons: [] },
  });
});

for (const [name, input] of [['missing', undefined], ['null', null], ['array', []], ['number', 3], ['string', 'record'], ['boolean', true], ['function', () => {}], ['empty object', {}]]) {
  test(`handles ${name} without inventing completion or quantities`, () => {
    const output = presentResult(input);
    assert.equal(output.capture.key, 'unknown');
    assert.equal(output.delivery.key, 'unknown');
    assert.equal(output.needsAttention, true);
    assert.equal(output.title, '未命名内容');
    assert.deepEqual(output.metrics.map(metric => metric.value), ['—', '—']);
    assert.deepEqual(presentResultDetail(input), { body: '', comments: [], truncated: { body: false, comments: false } });
  });
}

test('distinguishes platforms and profile presentation without legacy names', () => {
  const output = presentResult(record({ platform: 'douyin', kind: 'profile', title: '' }));
  assert.equal(output.platformLabel, '抖音');
  assert.equal(output.kindLabel, '作者主页');
  assert.equal(output.title, '未命名作者主页');
});

test('unknown platform and kind cannot masquerade as supported values', () => {
  const output = presentResult(record({ platform: 'constructor', kind: 'toString' }));
  assert.equal(output.platformLabel, '未知平台');
  assert.equal(output.kindLabel, '未知类型');
});

for (const [status, expected] of [['pending', 'pending'], ['queued', 'pending'], ['running', 'running'], ['success', 'completed'], ['succeeded', 'completed'], ['completed', 'completed'], ['partial', 'partial'], ['needs_action', 'needs_action'], ['failed', 'failed'], ['cancelled', 'stopped'], ['stopped', 'stopped'], ['other', 'unknown']]) {
  test(`projects capture status ${status} to ${expected}`, () => {
    const output = presentResult(record({ capture: { status } }));
    assert.equal(output.capture.key, expected);
    assert.equal(output.needsAttention, !['pending', 'running', 'completed'].includes(expected));
  });
}

for (const local of ['failed', 'pending', 'unknown', undefined]) {
  test(`remote acceptance with local=${local} remains attention, not complete`, () => {
    const output = presentResult(record({ delivery: { remote: 'confirmed', local } }));
    assert.equal(output.delivery.key, 'local_unconfirmed');
    assert.equal(output.delivery.tone, 'warning');
    assert.equal(output.needsAttention, true);
    assert.match(output.delivery.label, /本地待核对/u);
    assert.equal('actions' in output, false);
    assert.equal('actions' in output.delivery, false);
  });
}

test('explicit reconciliation overrides contradictory completion of both saves', () => {
  const output = presentResult(record({ reconciliationRequired: true }));
  assert.equal(output.capture.key, 'completed');
  assert.equal(output.delivery.key, 'reconciliation_required');
  assert.equal(output.needsAttention, true);
  assert.equal(output.delivery.tone, 'warning');
});

for (const reconciliationRequired of ['true', 'false', 1, 0, null, {}]) {
  test(`malformed reconciliation flag ${JSON.stringify(reconciliationRequired)} does not clear attention`, () => {
    const output = presentResult(record({ reconciliationRequired }));
    assert.equal(output.delivery.key, 'unknown');
    assert.equal(output.needsAttention, true);
  });
}

test('unknown remote result remains uncertain despite confirmed local data', () => {
  const output = presentResult(record({ delivery: { remote: 'unknown', local: 'confirmed' } }));
  assert.equal(output.delivery.key, 'remote_unconfirmed');
  assert.equal(output.needsAttention, true);
});

test('local saved and remote pending remains waiting, not success or failure', () => {
  const output = presentResult(record({ delivery: { remote: 'pending', local: 'confirmed' } }));
  assert.equal(output.delivery.key, 'pending');
  assert.equal(output.delivery.tone, 'neutral');
  assert.equal(output.needsAttention, false);
});

for (const [remote, local, key] of [['pending', 'pending', 'pending'], ['pending', 'failed', 'local_failed'], ['failed', 'confirmed', 'remote_failed'], ['failed', 'pending', 'remote_failed'], ['failed', 'failed', 'delivery_failed'], ['pending', 'alien', 'unknown'], ['ok', 'confirmed', 'unknown']]) {
  test(`delivery ${remote}/${local} is represented by ${key}`, () => {
    assert.equal(presentResult(record({ delivery: { remote, local } })).delivery.key, key);
  });
}

test('save confirmation does not turn failed capture into a successful task', () => {
  const output = presentResult(record({ capture: { status: 'failed' } }));
  assert.equal(output.delivery.key, 'confirmed');
  assert.equal(output.capture.key, 'failed');
  assert.equal(output.needsAttention, true);
});

test('zero comments and likes remain explicit zero instead of missing data', () => {
  const output = presentResult(record({ likes: 0, commentsCount: 0 }));
  assert.deepEqual(output.metrics.map(metric => metric.value), ['0', '0']);
  assert.deepEqual(presentResultDetail(record()).comments, []);
});

for (const invalid of [-1, 0.5, Infinity, NaN, '0', null, true, {}, Number.MAX_SAFE_INTEGER + 1]) {
  test(`invalid metric ${String(invalid)} is not coerced into a quantity`, () => {
    assert.deepEqual(presentResult(record({ likes: invalid, commentsCount: invalid })).metrics.map(metric => metric.value), ['—', '—']);
  });
}

test('comment total is not inferred from a potentially incomplete comment preview', () => {
  const output = presentResult(record({ commentsCount: undefined, comments: [{ author: '甲', text: '只是一条预览' }] }));
  assert.equal(output.metrics[1].value, '—');
  assert.equal('detail' in output, false);
});

test('hostile markup remains literal text for textContent, not HTML or executable actions', () => {
  const markup = '<img src=x onerror="alert(1)"><script>steal()</script>';
  const output = presentResult(record({ title: markup, author: markup, body: markup, comments: [{ author: markup, text: markup }] }));
  const detail = presentResultDetail(record({ body: markup, comments: [{ author: markup, text: markup }] }));
  assert.equal(output.title, markup);
  assert.equal(detail.body, markup);
  assert.equal(detail.comments[0].text, markup);
  assert.equal(detail.comments[0].author, markup);
  assert.equal('html' in output, false);
  assert.equal('url' in output, false);
});

test('input records are neither mutated nor retained as output references', () => {
  const input = record({ comments: [{ author: '甲', text: '原评论' }] });
  const before = structuredClone(input);
  Object.freeze(input.capture); Object.freeze(input.delivery); Object.freeze(input.comments[0]); Object.freeze(input.comments); Object.freeze(input);
  const output = presentResult(input);
  const detail = presentResultDetail(input);
  detail.comments[0].text = '修改输出'; output.capture.key = 'changed';
  assert.deepEqual(input, before);
  assert.notStrictEqual(detail.comments, input.comments);
});

test('only selected text fields are exposed, never raw credentials or nested object serialization', () => {
  const output = presentResult(record({ token: 'secret-token', authorization: 'secret-bearer', cookies: 'secret-cookie', raw: { secret: 'raw-secret' }, author: { password: 'author-secret' } }));
  const encoded = JSON.stringify(output);
  for (const secret of ['secret-token', 'secret-bearer', 'secret-cookie', 'raw-secret', 'author-secret']) assert.equal(encoded.includes(secret), false);
  assert.equal(output.author, '作者待确认');
});

test('text and comment output are bounded without splitting surrogate pairs', () => {
  const long = '😀'.repeat(10000);
  const input = record({ id: long, title: long, author: long, summary: long, body: long, comments: Array.from({ length: 200 }, () => ({ author: long, text: long })) });
  const output = presentResult(input);
  const detail = presentResultDetail(input);
  assert.ok(output.id.length <= 128); assert.ok(output.title.length <= 180); assert.ok(output.author.length <= 80);
  assert.ok(output.summary.length <= 240); assert.ok(detail.body.length <= 12000); assert.equal(detail.comments.length, 50);
  for (const value of [output.id, output.title, output.author, output.summary, detail.body, ...detail.comments.flatMap(comment => [comment.author, comment.text])]) {
    assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value), false);
  }
  for (const comment of detail.comments) { assert.ok(comment.author.length <= 80); assert.ok(comment.text.length <= 1600); }
});

test('normalizes display controls and whitespace but preserves multiline body', () => {
  const input = record({ title: '  标题\n 第二行\u0000\u202E ', summary: '第一行\r\n第二行\u0000', body: '第一行\r\n第二行\u0000', comments: [{ text: '\t评论\n下一行\u2066' }] });
  const output = presentResult(input);
  const detail = presentResultDetail(input);
  assert.equal(output.title, '标题 第二行'); assert.equal(output.summary, '第一行 第二行');
  assert.equal(detail.body, '第一行\n第二行');
  assert.deepEqual(detail.comments, [{ author: '评论者', text: '评论\n下一行' }]);
});

test('invalid or empty comments are omitted without coercion', () => {
  const output = presentResultDetail(record({ comments: [null, 'text', { text: '' }, { text: {} }, { author: '甲', text: '评论' }] }));
  assert.deepEqual(output.comments, [{ author: '甲', text: '评论' }]);
});

test('accessors and throwing proxies do not execute or leak data', () => {
  let invoked = 0;
  const input = record();
  Object.defineProperty(input, 'body', { get() { invoked += 1; throw new Error('secret'); } });
  Object.defineProperty(input, 'reconciliationRequired', { get() { invoked += 1; return false; } });
  const output = presentResult(input);
  assert.equal(invoked, 0); assert.equal(presentResultDetail(input).body, ''); assert.equal(output.needsAttention, true);
  const inaccessible = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('secret-proxy'); } });
  assert.equal(presentResult(inaccessible).delivery.key, 'unknown');
});

test('inherited values are not treated as authoritative record fields', () => {
  const output = presentResult(Object.create(record()));
  assert.equal(output.title, '未命名内容'); assert.equal(output.delivery.key, 'unknown'); assert.equal(output.needsAttention, true);
});

test('accessor-backed comments and entries beyond the bounded prefix are not read', () => {
  let invoked = 0;
  const comments = Array.from({ length: 51 }, () => ({ text: '评论' }));
  Object.defineProperty(comments, '0', { get() { invoked += 1; return { text: '秘密' }; } });
  Object.defineProperty(comments, '50', { get() { invoked += 1; throw new Error('not read'); } });
  const output = presentResultDetail(record({ comments }));
  assert.equal(invoked, 0); assert.equal(output.comments.length, 49);
});

test('identical inputs produce identical outputs without global runtime services', () => {
  const input = record();
  assert.deepEqual(presentResult(input), presentResult(input));
  assert.deepEqual(Object.keys(presentResult(input)), ['id', 'title', 'platformLabel', 'kindLabel', 'author', 'summary', 'metrics', 'capture', 'delivery', 'needsAttention', 'review']);
});

test('list projection never reads body or comments, even to derive a missing summary', () => {
  let invoked = 0;
  const input = record({ summary: undefined });
  Object.defineProperty(input, 'body', { get() { invoked += 1; throw new Error('body must remain lazy'); } });
  Object.defineProperty(input, 'comments', { get() { invoked += 1; throw new Error('comments must remain lazy'); } });
  const seen = [];
  const guarded = new Proxy(input, { getOwnPropertyDescriptor(target, key) {
    seen.push(key);
    if (key === 'body' || key === 'comments') throw new Error('heavy field descriptor inspected');
    return Object.getOwnPropertyDescriptor(target, key);
  } });
  const output = presentResult(guarded);
  assert.equal(invoked, 0);
  assert.equal(seen.includes('body'), false);
  assert.equal(seen.includes('comments'), false);
  assert.equal(output.summary, '暂无内容摘要');
  assert.equal('detail' in output, false);
});

test('detail projection does not read list fields or credential containers', () => {
  const seen = [];
  const guarded = new Proxy(record(), { getOwnPropertyDescriptor(target, key) {
    seen.push(key);
    return Object.getOwnPropertyDescriptor(target, key);
  } });
  assert.deepEqual(presentResultDetail(guarded), { body: '正文内容', comments: [], truncated: { body: false, comments: false } });
  assert.deepEqual(seen, ['body', 'comments', 'truncated']);
});

test('revoked proxies fail closed as records or comment arrays', () => {
  const unavailableRecord = Proxy.revocable({}, {});
  unavailableRecord.revoke();
  assert.equal(presentResult(unavailableRecord.proxy).needsAttention, true);
  assert.deepEqual(presentResultDetail(unavailableRecord.proxy), { body: '', comments: [], truncated: { body: false, comments: false } });
  const unavailableComments = Proxy.revocable([], {});
  unavailableComments.revoke();
  assert.deepEqual(presentResultDetail(record({ comments: unavailableComments.proxy })).comments, []);
});

test('sparse comments omit holes while preserving valid entries within the bounded prefix', () => {
  const comments = [];
  comments[2] = { text: '保留评论' };
  comments[80] = { text: '超出预览范围' };
  assert.deepEqual(presentResultDetail(record({ comments })).comments, [{ author: '评论者', text: '保留评论' }]);
});

test('lookup identities stay exact and invalid identities are never normalized into other records', () => {
  for (const id of ['record:甲:1', 'a'.repeat(128), 'record-😀']) {
    assert.equal(exactRecordId(id), id);
    assert.equal(presentResult(record({ id })).id, id);
  }
  for (const id of ['', ' record-1', 'record-1 ', 'record 1', 'record\u00001', 'record\u202E1', 'a'.repeat(129), 'record-\uD83D', 1, null]) {
    const output = presentResult(record({ id }));
    assert.equal(output.id, '');
    assert.equal(output.needsAttention, true);
  }
});

test('distinct overlong identities cannot collide through display truncation', () => {
  const prefix = 'a'.repeat(128);
  assert.equal(presentResult(record({ id: `${prefix}1` })).id, '');
  assert.equal(presentResult(record({ id: `${prefix}2` })).id, '');
  assert.equal(presentResult(record({ id: prefix })).id, prefix);
});

test('whitespace normalization at the character cap never leaves a lone surrogate', () => {
  for (const title of [` ${'a'.repeat(179)}😀`, '\uD83Dinside\uDE00', `${'a'.repeat(180)}😀`]) {
    const output = presentResult(record({ title }));
    assert.equal(/[\uD800-\uDFFF]/u.test(output.title), false);
  }
});

test('detail flags explain bounded previews and retain upstream truncation evidence', () => {
  const detail = presentResultDetail(record({ body: 'a'.repeat(12001), comments: Array.from({ length: 51 }, () => ({ text: '评论' })) }));
  assert.deepEqual(detail.truncated, { body: true, comments: true });
  assert.equal(detail.comments.length, 50);
  const upstream = presentResultDetail({ body: '短预览', comments: [], truncated: { body: true, comments: true } });
  assert.deepEqual(upstream.truncated, { body: true, comments: true });
});

test('comment records have their own kind and do not masquerade as full notes', () => {
  assert.equal(presentResult(record({ kind: 'comments' })).kindLabel, '评论');
});

test('even one long comment reports that the detail preview is truncated', () => {
  const output = presentResultDetail({ comments: [{ text: '字'.repeat(1601) }] });
  assert.equal(output.comments.length, 1);
  assert.equal(output.comments[0].text.length, 1600);
  assert.equal(output.truncated.comments, true);
});
