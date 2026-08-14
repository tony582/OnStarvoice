import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isLikelyTruncatedDouyinText,
  pickMostCompleteDouyinText,
} from '../../utils/capture/douyin-single-note.js';
import {pickMoreCompleteCapturedText} from '../../utils/capture-sync.js';

test('Douyin content selection prefers the complete API body over collapsed DOM text', () => {
  const short = '接到安吉星续费推销电话⚠️。客服原话：套餐即将到期，到期所…展开';
  const full = '接到安吉星续费推销电话⚠️。客服原话：套餐即将到期，到期所有功能都会被婉拒，所有的基础服务都没有了！';
  assert.equal(isLikelyTruncatedDouyinText(short), true);
  assert.equal(pickMostCompleteDouyinText(short, full), full);
  assert.equal(pickMoreCompleteCapturedText(full, short), full);
  assert.equal(pickMoreCompleteCapturedText(short, full), full);
});

test('unrelated edits are not replaced merely because an older body is longer', () => {
  assert.equal(
    pickMoreCompleteCapturedText('旧版本是一段更长的正文内容', '作者改写'),
    '作者改写',
  );
});
