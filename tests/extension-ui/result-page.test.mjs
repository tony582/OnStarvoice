import assert from 'node:assert/strict';
import test from 'node:test';
import { presentResultPage } from '../../extension-ui/domain/result-page.mjs';

function record(id, attention = false) {
  return {
    id: String(id), title: `记录 ${id}`, platform: 'xiaohongshu', kind: 'note',
    capture: { status: 'completed' },
    delivery: { remote: 'confirmed', local: attention ? 'failed' : 'confirmed' },
  };
}

test('result page returns a useful empty page for missing or non-array input', () => {
  for (const input of [undefined, null, {}, 'records']) {
    const output = presentResultPage(input);
    assert.deepEqual(output.items, []);
    assert.deepEqual(output.counts, { all: 0, attention: 0, matching: 0 });
    assert.equal(output.page.hasNext, false);
    assert.equal(output.page.hasPrevious, false);
  }
});

test('result page caps the list at 50 without reading any full bodies or comments', () => {
  let detailReads = 0;
  const input = Array.from({ length: 1500 }, (_, i) => {
    const summary = record(i, i % 10 === 0);
    Object.defineProperties(summary, {
      body: { get() { detailReads += 1; throw new Error('body must stay lazy'); } },
      comments: { get() { detailReads += 1; throw new Error('comments must stay lazy'); } },
    });
    return summary;
  });
  const output = presentResultPage(input, { limit: 1500 });
  assert.equal(output.items.length, 50);
  assert.equal(output.counts.all, 1500);
  assert.equal(output.counts.attention, 150);
  assert.equal(detailReads, 0);
  assert.equal(output.items[0].id, '0');
  assert.equal(output.items[49].id, '49');
  assert.equal(output.page.hasNext, true);
  assert.equal(output.page.hasPrevious, false);
});

test('result page selects attention before applying offset and limit', () => {
  const input = Array.from({ length: 30 }, (_, i) => record(i, i % 3 === 0));
  const output = presentResultPage(input, { filter: 'attention', offset: 2, limit: 3 });
  assert.deepEqual(output.items.map(item => item.id), ['6', '9', '12']);
  assert.deepEqual(output.counts, { all: 30, attention: 10, matching: 10 });
  assert.equal(output.page.hasPrevious, true);
  assert.equal(output.page.hasNext, true);
});

test('result page reports the final partial page accurately', () => {
  const output = presentResultPage([record(0), record(1), record(2)], { offset: 2, limit: 2 });
  assert.deepEqual(output.items.map(item => item.id), ['2']);
  assert.equal(output.page.hasNext, false);
  assert.equal(output.page.hasPrevious, true);
});

test('result page does not silently return the first page for an out-of-range offset', () => {
  const output = presentResultPage([record(0)], { offset: 100 });
  assert.deepEqual(output.items, []);
  assert.equal(output.page.offset, 100);
  assert.equal(output.page.hasNext, false);
  assert.equal(output.page.hasPrevious, true);
});

test('result page uses bounded defaults for malformed pagination', () => {
  const input = [record(0), record(1)];
  for (const config of [null, undefined, { offset: -1, limit: Infinity }, { offset: '1', limit: '2' }]) {
    const output = presentResultPage(input, config);
    assert.equal(output.page.offset, 0);
    assert.equal(output.page.limit, 50);
  }
  assert.equal(presentResultPage(input, { limit: 0 }).items.length, 1);
});

test('result page retains duplicate source identities and does not dedupe business records', () => {
  const output = presentResultPage([record(1), record(1)]);
  assert.equal(output.items.length, 2);
  assert.equal(output.counts.all, 2);
});

test('result page never reads command, secret, receipt or payload fields', () => {
  const input = record('private');
  for (const key of ['token', 'secret', 'receipt', 'payload', 'retry', 'sync']) {
    Object.defineProperty(input, key, { get() { throw new Error(`unexpected read: ${key}`); } });
  }
  assert.equal(presentResultPage([input]).items.length, 1);
});

test('result page does not mutate records or caller pagination', () => {
  const input = [record(0), record(1, true)];
  const config = { filter: 'attention', offset: 0, limit: 2 };
  const before = structuredClone({ input, config });
  presentResultPage(input, config);
  assert.deepEqual({ input, config }, before);
});

test('result page treats unknown filters as all and an empty attention filter as empty', () => {
  assert.equal(presentResultPage([record(0)], { filter: 'finished' }).items.length, 1);
  const output = presentResultPage([record(0)], { filter: 'attention' });
  assert.equal(output.items.length, 0);
  assert.equal(output.counts.matching, 0);
});

test('result page does not execute array entry, iterator or option accessors', () => {
  let reads = 0;
  const input = [record(0), record(1)];
  Object.defineProperty(input, '1', { get() { reads += 1; throw new Error('entry'); } });
  Object.defineProperty(input, Symbol.iterator, { get() { reads += 1; throw new Error('iterator'); } });
  const options = {};
  for (const key of ['offset', 'limit', 'filter']) Object.defineProperty(options, key, { get() { reads += 1; throw new Error(key); } });
  const output = presentResultPage(input, options);
  assert.equal(reads, 0);
  assert.equal(output.items[0].id, '0');
  assert.equal(output.items[1].id, '');
  assert.equal(output.items[1].needsAttention, true);
});

test('result page handles revoked source and config objects without throwing', () => {
  const unavailable = Proxy.revocable([], {});
  unavailable.revoke();
  assert.deepEqual(presentResultPage(unavailable.proxy).items, []);
  assert.equal(presentResultPage([record(0)], unavailable.proxy).items[0].id, '0');
});
