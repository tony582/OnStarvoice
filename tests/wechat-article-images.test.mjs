import test from 'node:test';
import assert from 'node:assert/strict';
import {isAllowedMediaHost, resolveReferer} from '../server/services/media-proxy.js';
import imageProxy from '../server/routes/image-proxy.js';
import {inspectWechatImage, WECHAT_IMAGE_MAX_BYTES} from '../server/services/wechat-image-validation.js';
import {recordImageCandidates} from '../server/services/image-text-extraction.js';
import {pngFixture} from './helpers/wechat-image-fixtures.mjs';

test('WeChat image allowlist and Referer use the actual qpic host without expanding qq.com', () => {
  for (const host of ['qpic.cn', 'mmbiz.qpic.cn', 'mmecoa.qpic.cn']) {
    const url = `https://${host}/mmbiz_png/asset/640?wx_fmt=png&unused=xhscdn.com`;
    assert.equal(isAllowedMediaHost(url), true);
    assert.equal(resolveReferer(url, 'douyin'), 'https://mp.weixin.qq.com/');
  }
  for (const host of ['qq.com', 'mp.weixin.qq.com', 'evilqpic.cn', 'qpic.cn.evil.test', '127.0.0.1']) {
    assert.equal(isAllowedMediaHost(`https://${host}/?image=mmbiz.qpic.cn`), false);
  }
  assert.equal(resolveReferer('https://unknown.example/image', 'wechat_articles'), 'https://mp.weixin.qq.com/');
  assert.equal(resolveReferer('https://p3.douyinpic.com/image', 'douyin'), 'https://www.douyin.com/');
});

test('stored WeChat images meet the byte OR dimension threshold and reject placeholder/non-image/oversize files', () => {
  const compact = pngFixture(120, 120), large = pngFixture(80, 80, true);
  assert.ok(compact.length < 10 * 1024); assert.ok(large.length > 10 * 1024);
  assert.deepEqual(inspectWechatImage(compact), {mime: 'image/png', width: 120, height: 120, bytes: compact.length});
  assert.equal(inspectWechatImage(large).width, 80);
  assert.equal(inspectWechatImage(Buffer.concat([pngFixture(20, 20), Buffer.alloc(2000)])), null);
  assert.equal(inspectWechatImage(Buffer.from('<html>not authorized</html>'.repeat(1000))), null);
  assert.equal(inspectWechatImage(Buffer.alloc(WECHAT_IMAGE_MAX_BYTES + 1)), null);
});

test('header-only JPEG, GIF, WebP and BMP data cannot claim that an image was saved', () => {
  const jpeg = Buffer.from([0xff,0xd8,0xff,0xc0,0x00,0x11,0x08,0x00,0x78,0x00,0x82,0x03,1,0x11,0,2,0x11,0,3,0x11,0,0xff,0xd9]);
  const gif = Buffer.alloc(13); gif.write('GIF89a'); gif.writeUInt16LE(120,6); gif.writeUInt16LE(130,8);
  const webp = Buffer.alloc(30); webp.write('RIFF'); webp.write('WEBP',8); webp.write('VP8X',12); webp.writeUIntLE(119,24,3); webp.writeUIntLE(129,27,3);
  const bmp = Buffer.alloc(54); bmp.write('BM'); bmp.writeUInt32LE(40,14); bmp.writeInt32LE(120,18); bmp.writeInt32LE(-130,22);
  for (const bytes of [jpeg, gif, webp, bmp]) assert.equal(inspectWechatImage(bytes), null);
});

test('qpic image proxy preserves original URL parameters and refuses redirects outside qpic using only mocked fetch', async t => {
  const fetches = [], previous = globalThis.fetch;
  const original = 'https://mmbiz.qpic.cn/mmbiz_png/asset/640?wx_fmt=png';
  globalThis.fetch = async (url, options) => {
    fetches.push({url, options});
    if (String(url).includes('redirect')) return new Response('', {status: 302, headers: {location: 'https://evil.example/private'}});
    assert.equal(url, original);
    return new Response(pngFixture(), {headers: {'content-type': 'image/png'}});
  };
  t.after(() => { globalThis.fetch = previous; });
  const handler = imageProxy.stack.find(layer => layer.route)?.route.stack[0].handle;
  const invoke = async url => {
    const result = {code: 200, headers: {}};
    const res = {status(code) { result.code = code; return this; }, set(name, value) { result.headers[name] = value; return this; },
      send(body) { result.body = body; return this; }};
    await handler({query: {url}}, res); return result;
  };
  const ok = await invoke(original);
  assert.equal(ok.code, 200); assert.deepEqual(ok.body, pngFixture());
  assert.equal(fetches[0].options.headers.Referer, 'https://mp.weixin.qq.com/');
  assert.equal(fetches[0].options.redirect, 'manual');
  assert.equal((await invoke('https://mmbiz.qpic.cn/redirect')).code, 403);
  assert.equal((await invoke('https://qpic.cn.evil.example/image')).code, 403);
  assert.equal((await invoke('https://user@mmbiz.qpic.cn/image')).code, 403);
  assert.equal(fetches.length, 2, 'the redirect target and invalid hosts were never fetched');
});

test('article body image references reach existing OCR candidates and retain local-file preference', () => {
  const source = 'https://mmbiz.qpic.cn/mmbiz_png/asset/640?wx_fmt=png';
  assert.deepEqual(recordImageCandidates({platform: 'wechat_articles', image_urls: [source],
    image_local_urls: [{source_url: source, url: '/media/images/local.png'}]}),
  [{url: '/media/images/local.png', sourceUrl: source, ref: source}]);
});
