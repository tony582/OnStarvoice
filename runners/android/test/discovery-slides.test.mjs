import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDouyinUrl, createClipboardMarker, validateCopiedShare } from '../src/device/clipboard.mjs';
import { verifyLink } from '../src/core/discovery-evidence.mjs';

// Captured Douyin 30.6.0 redirect target; query parameters are not identity.
const externalId = '7687942022607741007';
const shareUrl = `https://www.iesdouyin.com/share/slides/${externalId}/`;
const canonicalUrl = `https://www.douyin.com/note/${externalId}`;
const detail = { detailId: 'detail-slides', externalId };
const evidence = (url = shareUrl) => ({ shareUrl: url, externalId, detailId: detail.detailId,
  fresh: true, markerReplaced: true, identityVerified: true });

test('measured slides share route is a note with the original work identity', () => {
  assert.deepEqual(classifyDouyinUrl(`${shareUrl}?tracking=test`), {
    kind: 'note', shareUrl: `${shareUrl}?tracking=test`, externalId, canonicalUrl, requiresResolution: false,
  });
  const marker = createClipboardMarker();
  const result = validateCopiedShare({ marker, beforeText: marker,
    afterText: `君越车友们！这波新壁纸你们打多少分？ ${shareUrl}`, expectedExternalId: externalId });
  assert.equal(result.ok, true);
  assert.equal(result.identityVerified, true);
  assert.equal(result.kind, 'note');
  assert.equal(result.canonicalUrl, canonicalUrl);
  assert.doesNotThrow(() => verifyLink({ ...result, detailId: detail.detailId }, detail));
});

test('slides support cannot change the current detail identity or skip clipboard freshness', () => {
  assert.throws(() => verifyLink({ ...evidence(), externalId: '7687942022607741008' }, detail), { code: 'link_identity_mismatch' });
  assert.throws(() => verifyLink({ ...evidence(), fresh: false }, detail), { code: 'clipboard_not_fresh' });
  const marker = createClipboardMarker();
  assert.equal(validateCopiedShare({ marker, beforeText: marker, afterText: shareUrl,
    expectedExternalId: '7687942022607741008' }).reason, 'identity_mismatch');
});

test('slides matching retains exact official host, route, scheme and work ID bounds', () => {
  const invalid = [
    `https://www.iesdouyin.com.evil.test/share/slides/${externalId}/`,
    `https://evil@www.iesdouyin.com/share/slides/${externalId}/`,
    `https://www.iesdouyin.com:444/share/slides/${externalId}/`,
    `http://www.iesdouyin.com/share/slides/${externalId}/`,
    `https://iesdouyin.com/share/slides/${externalId}/`,
    `https://www.douyin.com/share/slides/${externalId}/`,
    `https://v.douyin.com/share/slides/${externalId}/`,
    `https://www.iesdouyin.com/slides/${externalId}/`,
    `https://www.iesdouyin.com/share/slides/${externalId}/comments`,
    `https://www.iesdouyin.com/share/slides/%37${externalId.slice(1)}/`,
    `https://www.iesdouyin.com/share/slides/${'7'.repeat(15)}/`,
    `https://www.iesdouyin.com/share/slides/${'7'.repeat(23)}/`,
    'https://www.iesdouyin.com/share/slides/not-a-work/',
  ];
  for (const url of invalid) {
    assert.equal(classifyDouyinUrl(url).kind, 'invalid', url);
    assert.throws(() => verifyLink(evidence(url), detail), { code: 'link_unverified' }, url);
  }
  for (const length of [16, 22]) {
    const id = '7'.repeat(length);
    assert.equal(classifyDouyinUrl(`https://www.iesdouyin.com/share/slides/${id}/`).externalId, id);
  }
  // All clipboard work routes now use the same bound as the runner and schema.
  for (const kind of ['video', 'note']) for (const length of [15, 23]) {
    assert.equal(classifyDouyinUrl(`https://www.douyin.com/${kind}/${'7'.repeat(length)}`).kind, 'invalid');
  }
});
