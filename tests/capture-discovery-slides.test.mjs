import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDouyinShareUrl, resolveEventIdentity } from '../server/services/capture-discovery/identity.js';
import { createShareResolver } from '../server/services/capture-discovery/share-resolver.js';

const externalId = '7687942022607741007';
const shortUrl = 'https://v.douyin.com/yn5xsCvO2cg/';
const slidesUrl = `https://www.iesdouyin.com/share/slides/${externalId}/`;
const canonicalUrl = `https://www.douyin.com/note/${externalId}`;

test('verified mobile slides share becomes canonical note without changing the ID', async () => {
  assert.deepEqual(parseDouyinShareUrl(`作品 ${slidesUrl}?tracking=test 复制打开抖音`), {
    status: 'resolved', externalId, canonicalUrl,
  });
  const identity = await resolveEventIdentity({ verification: 'verified', rawShareUrl: slidesUrl,
    verifiedExternalId: externalId });
  assert.deepEqual(identity, { status: 'resolved', externalId, canonicalUrl });
  assert.equal((await resolveEventIdentity({ verification: 'verified', rawShareUrl: slidesUrl,
    verifiedExternalId: '7687942022607741008' })).reason, 'work_identity_mismatch');
  assert.equal((await resolveEventIdentity({ verification: 'link_unverified', rawShareUrl: slidesUrl })).reason, 'link_unverified');
});

test('measured short-link 302 to share/slides resolves once through the existing pinned resolver', async () => {
  const seen = [];
  const resolver = createShareResolver({
    dnsLookup: async (hostname) => {
      assert.equal(hostname, 'v.douyin.com');
      return [{ address: '8.8.8.8', family: 4 }];
    },
    request: async (url, options) => {
      seen.push(url.href);
      assert.equal(options.address, '8.8.8.8');
      assert.equal(options.family, 4);
      return { status: 302, location: `${slidesUrl}?tracking=test` };
    },
  });
  const identity = await resolveEventIdentity({ verification: 'verified', rawShareUrl: shortUrl,
    verifiedExternalId: externalId }, resolver);
  assert.deepEqual(identity, { status: 'resolved', externalId, canonicalUrl });
  assert.deepEqual(seen, [shortUrl], 'canonical note identity needs no follow-up fetch');
});

test('slides parsing cannot broaden the allowed host, path or numeric ID schema', () => {
  for (const url of [
    `https://www.iesdouyin.com.evil.test/share/slides/${externalId}/`,
    `https://127.0.0.1/share/slides/${externalId}/`,
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
  ]) assert.equal(parseDouyinShareUrl(url).status, 'needs_review', url);
  for (const length of [16, 22]) {
    const id = '7'.repeat(length);
    assert.equal(parseDouyinShareUrl(`https://www.iesdouyin.com/share/slides/${id}/`).canonicalUrl,
      `https://www.douyin.com/note/${id}`);
  }
});

test('resolver still rejects malicious slides redirects before fetching the destination', async () => {
  for (const location of [
    `https://www.iesdouyin.com.evil.test/share/slides/${externalId}/`,
    `https://127.0.0.1/share/slides/${externalId}/`,
    `https://evil@www.iesdouyin.com/share/slides/${externalId}/`,
    `http://www.iesdouyin.com/share/slides/${externalId}/`,
  ]) {
    let requests = 0;
    const resolver = createShareResolver({ dnsLookup: async () => [{ address: '8.8.8.8', family: 4 }],
      request: async () => { requests++; return { status: 302, location }; } });
    await assert.rejects(resolver(shortUrl), /UNSAFE_SHARE_REDIRECT/);
    assert.equal(requests, 1);
  }
});
