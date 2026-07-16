import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = (await readFile(
  resolve(repoRoot, 'utils/comment-dedupe.js'),
  'utf8',
)).replace(/\bexport\s+(?=function\b)/g, '');
const context = vm.createContext({});
vm.runInContext(
  `${source}\n;globalThis.__commentDedupeApi = {dedupeNormalizedCommentItems, resolveCommentMergeLimit};`,
  context,
  {filename: 'utils/comment-dedupe.js'},
);
const {dedupeNormalizedCommentItems, resolveCommentMergeLimit} =
  context.__commentDedupeApi;

test('different stable ids are preserved even when comment text matches', () => {
  const result = dedupeNormalizedCommentItems([
    {commentId: 'c1', userId: 'u1', content: '同一句话', likes: 3},
    {commentId: 'c2', userId: 'u1', content: '同一句话', likes: 3},
  ]);

  assert.equal(result.length, 2);
  assert.deepEqual(
    Array.from(result, (item) => item.commentId),
    ['c1', 'c2'],
  );
});

test('id-less legacy checkpoint is replaced by the matching stable-id item', () => {
  const result = dedupeNormalizedCommentItems([
    {userId: 'u1', content: '旧快照', likes: 1},
    {commentId: 'c9', userId: 'u1', content: '旧快照', likes: 1},
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].commentId, 'c9');
});

test('id-less duplicate does not duplicate a stable-id comment', () => {
  const result = dedupeNormalizedCommentItems([
    {commentId: 'c3', userId: 'u2', content: '已保存', likes: 0},
    {userId: 'u2', content: '已保存', likes: 0},
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].commentId, 'c3');
});

test('retry merge limit never truncates an existing larger checkpoint', () => {
  assert.equal(resolveCommentMergeLimit(50, 200), 200);
  assert.equal(resolveCommentMergeLimit(300, 200), 300);
});
