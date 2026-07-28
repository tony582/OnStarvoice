import assert from 'node:assert/strict';
import test from 'node:test';

import { imageSourceIdentity } from '../server/services/media-store.js';

test('Douyin signed image variants share one stable source identity', () => {
  const searchVariant =
    'https://p3-sign.douyinpic.com/tos-cn-i-0813/asset-token~noop.jpeg?x-expires=1&x-signature=search';
  const detailVariant =
    'https://p11-sign.douyinpic.com/tos-cn-i-0813/asset-token~tplv-dy-aweme-images-v2:3000:3000:q75.webp?x-expires=2&x-signature=detail';

  assert.equal(imageSourceIdentity(searchVariant), 'douyin:asset-token');
  assert.equal(
    imageSourceIdentity(detailVariant),
    imageSourceIdentity(searchVariant),
  );
});

test('different Douyin image assets remain distinct', () => {
  const first =
    'https://p3-sign.douyinpic.com/tos-cn-i-0813/first-token~noop.jpeg?x-signature=one';
  const second =
    'https://p3-sign.douyinpic.com/tos-cn-i-0813/second-token~noop.jpeg?x-signature=two';

  assert.notEqual(imageSourceIdentity(first), imageSourceIdentity(second));
});

test('non-Douyin URLs preserve their exact source identity', () => {
  const first = 'https://example.com/image.jpg?version=1';
  const second = 'https://example.com/image.jpg?version=2';

  assert.equal(imageSourceIdentity(first), first);
  assert.notEqual(imageSourceIdentity(first), imageSourceIdentity(second));
});
