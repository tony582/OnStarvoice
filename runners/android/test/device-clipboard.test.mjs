import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDouyinUrl, createClipboardMarker, validateCopiedShare } from '../src/device/index.mjs';

const id = '7480000000000000001';
const marker = createClipboardMarker();
const validate = (afterText, rest = {}) => validateCopiedShare({ marker, beforeText: marker, afterText, ...rest });

test('classifies public video, image note and short links without resolving or changing media type', () => {
  assert.equal(classifyDouyinUrl(`https://www.douyin.com/note/${id}?x=1`).canonicalUrl, `https://www.douyin.com/note/${id}`);
  assert.equal(classifyDouyinUrl(`https://www.iesdouyin.com/share/video/${id}`).externalId, id);
  assert.deepEqual(classifyDouyinUrl('https://v.douyin.com/Ab_cD/'), {
    kind: 'short_link', shareUrl: 'https://v.douyin.com/Ab_cD/', externalId: null, requiresResolution: true,
  });
});

test('rejects profile, search, private host, credential, scheme and host-spoofing URLs', () => {
  for (const url of [
    'https://www.douyin.com/user/abc', 'https://www.douyin.com/search/壁纸',
    `https://www.douyin.com.evil.test/video/${id}`, `https://127.0.0.1/video/${id}`,
    `http://www.douyin.com/video/${id}`, `https://someone@www.douyin.com/video/${id}`,
    `https://www.douyin.com:3000/video/${id}`, 'javascript:alert(1)',
  ]) assert.equal(classifyDouyinUrl(url).kind, 'invalid', url);
});

test('confirmed marker replacement plus independently matching work ID permits verified copy', () => {
  const result = validate(`君越车机壁纸 https://www.douyin.com/note/${id} 复制打开抖音`, { expectedExternalId: id });
  assert.equal(result.ok, true);
  assert.equal(result.fresh, true);
  assert.equal(result.identityVerified, true);
  assert.equal(result.kind, 'note');
});

test('stale clipboard, unconfirmed marker and ambiguous multiple works never pass', () => {
  assert.equal(validate(marker).reason, 'stale_clipboard');
  assert.equal(validateCopiedShare({ marker, beforeText: 'old text', afterText: `https://www.douyin.com/video/${id}` }).reason, 'marker_not_confirmed');
  assert.equal(validate(`https://www.douyin.com/video/${id} https://www.douyin.com/video/7999999999999999999`).reason, 'ambiguous_share_links');
  assert.equal(validate('https://www.douyin.com/user/author').reason, 'not_work_url');
});

test('fresh clipboard text is not proof that link belongs to current detail', () => {
  const unknown = validate(`https://www.douyin.com/video/${id}`);
  assert.equal(unknown.fresh, true);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, 'identity_unverified');
  const wrong = validate(`https://www.douyin.com/video/${id}`, { expectedExternalId: '999' });
  assert.equal(wrong.identityVerified, false);
  assert.equal(wrong.reason, 'identity_mismatch');
  const unresolved = validate('8.28 君越 https://v.douyin.com/F2g6YavFR5c/ 复制链接', { expectedExternalId: id });
  assert.equal(unresolved.fresh, true);
  assert.equal(unresolved.ok, false);
  assert.equal(unresolved.reason, 'resolution_required');
});
