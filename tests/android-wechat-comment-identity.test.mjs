import test from 'node:test';
import assert from 'node:assert/strict';
import {commentTextsAgree, reuseKnownCommentIds} from '../server/services/android-control/posts.js';

test('symbol-only comments compare nonempty normalized originals', () => {
  for (const [one, two, expected] of [['👍👍', '😡😡', false], ['？？？', '！！！', false],
    ['👍👍', '👍👍', true], ['？？？', '???', true], ['', '', false], ['...', '…', false],
    ['👍', '好', false]]) assert.equal(commentTextsAgree(one, two), expected, `${one} / ${two}`);
});

test('complete prefixes remain separate; only a shorter ellipsis authorizes prefix merging', () => {
  for (const [one, two, expected] of [
    ['别克君越真不错', '别克君越真不错，就是车机死机', false],
    ['别克君越真不错', '别克君越真不错啊', false],
    ['别克君越真不…', '别克君越真不错，就是车机死机', true],
    ['别克君越真不...', '别克君越真不错，就是车机死机', true],
    ['别克君越真不错', '别克君越真不错，就是车机死机…', false],
  ]) {
    assert.equal(commentTextsAgree(one, two), expected);
    assert.equal(commentTextsAgree(two, one), expected);
  }
});

const comment = (commentId, content, parentCommentId = '', authorName = '同一个读者') =>
  ({commentId, content, parentCommentId, isReply: Boolean(parentCommentId), authorName});

test('replies only reuse ids in their resolved parent, even with reordered floors', () => {
  const known = [comment('root-a', '第一层内容不一样', '', '楼主甲A'),
    comment('reply-a', '确实', 'root-a'), comment('root-b', '第二层内容有区别', '', '楼主乙A'),
    comment('reply-b', '确实', 'root-b'), comment('main', '确实')];
  const incoming = [comment('new-reply-b', '确实', 'new-root-b'),
    comment('new-root-b', '第二层内容有区别', '', '楼主乙B'),
    comment('new-reply-a', '确实', 'new-root-a'),
    comment('new-root-a', '第一层内容不一样', '', '楼主甲B'), comment('new-main', '确实')];
  const got = reuseKnownCommentIds(incoming, known);
  assert.deepEqual(got.map(x => x.commentId), ['reply-b', 'root-b', 'reply-a', 'root-a', 'main']);
  assert.deepEqual(got.map(x => x.parentCommentId), ['root-b', '', 'root-a', '', '']);
  assert.equal(new Set(got.map(x => x.commentId)).size, 5);
});

test('unknown-floor replies cannot steal a main comment or a different-floor reply id', () => {
  const known = [comment('main', '[图片]'), comment('reply', '[图片]', 'parent-a')];
  const items = [{...comment('orphan', '[图片]'), isReply: true}, comment('new', '[图片]', 'parent-b')];
  assert.deepEqual(reuseKnownCommentIds(items, known).map(x => x.commentId), ['orphan', 'new']);
});
