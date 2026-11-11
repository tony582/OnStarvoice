import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {isAllowedMediaHost, resolveReferer} from '../server/services/media-proxy.js';
import imageProxy from '../server/routes/image-proxy.js';
import * as articleHelpers from '../web/admin/src/lib/wechat-article.mjs';
import {pngFixture} from './helpers/wechat-image-fixtures.mjs';

const hosts = ['finder.video.qq.com', 'findermp.video.qq.com', 'wx.qlogo.cn'];
const denied = ['qq.com', 'video.qq.com', 'qlogo.cn', 'mp.weixin.qq.com', 'evilfinder.video.qq.com',
  'finder.video.qq.com.evil.test', 'wx.qlogo.cn.evil.test', '127.0.0.1'];

test('Channels media allowlist and Referer use narrow actual hosts, never URL parameters', () => {
  for (const host of hosts) {
    const url = `https://${host}/image?unused=xhscdn.com`;
    assert.equal(isAllowedMediaHost(url), true);
    assert.equal(resolveReferer(url, 'douyin'), 'https://channels.weixin.qq.com/');
  }
  for (const host of denied) assert.equal(isAllowedMediaHost(`https://${host}/?url=finder.video.qq.com`), false);
  assert.equal(resolveReferer('https://unknown.example/image', 'wechat_channels'), 'https://channels.weixin.qq.com/');
  assert.equal(resolveReferer('https://mmbiz.qpic.cn/image', 'wechat_articles'), 'https://mp.weixin.qq.com/');
  assert.equal(resolveReferer('https://p3.douyinpic.com/image', 'douyin'), 'https://www.douyin.com/');
});

test('Channels image proxy fetches images with its Referer and rejects unsafe targets before fetch', async t => {
  const before = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({url, options});
    if (String(url).includes('/redirect')) return new Response('', {status: 302, headers: {location: 'https://127.0.0.1/private'}});
    return new Response(pngFixture(), {headers: {'content-type': 'image/png'}});
  };
  t.after(() => {globalThis.fetch = before;});
  const handler = imageProxy.stack.find(layer => layer.route).route.stack[0].handle;
  async function invoke(url) {
    const result = {status: 200};
    const response = {status(code) {result.status = code; return this;}, set() {return this;}, send(body) {result.body = body; return this;}};
    await handler({query: {url}}, response); return result;
  }
  for (const host of hosts) {
    const response = await invoke(`https://${host}/image?token=unaltered`);
    assert.equal(response.status, 200); assert.deepEqual(response.body, pngFixture());
  }
  for (const call of calls) {
    assert.equal(call.options.headers.Referer, 'https://channels.weixin.qq.com/');
    assert.equal(call.options.redirect, 'manual');
    assert.ok(call.url.endsWith('?token=unaltered'));
  }
  for (const host of denied) assert.equal((await invoke(`https://${host}/image`)).status, 403);
  for (const url of ['https://user@wx.qlogo.cn/image', 'https://finder.video.qq.com:123/image']) {
    assert.equal((await invoke(url)).status, 403);
  }
  assert.equal((await invoke('https://finder.video.qq.com/redirect')).status, 403);
  assert.equal(calls.length, 4, 'no denied host, credentials, port or redirect destination was fetched');
});

test('admin shared helpers prefer durable media while preserving source URLs and other platform behavior', t => {
  const require = createRequire(new URL('../web/admin/package.json', import.meta.url));
  const ts = require('typescript');
  const source = path => readFileSync(new URL(`../web/admin/src/${path}`, import.meta.url), 'utf8');
  const compile = (path, imports) => {
    const output = ts.transpileModule(source(path), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
    const exports = {}; new Function('require', 'exports', output)(name => imports[name] ?? require(name), exports); return exports;
  };
  const utils = compile('lib/utils.ts', {'./wechat-article.mjs': articleHelpers});
  const images = compile('components/shared/record-images.ts', {'../../lib/utils.ts': utils, '../../lib/wechat-article.mjs': articleHelpers});
  const previous = globalThis.window; globalThis.window = {location: {origin: 'https://offline.invalid'}};
  t.after(() => {if (previous === undefined) delete globalThis.window; else globalThis.window = previous;});
  for (const host of hosts) assert.equal(utils.proxiedImg(`https://${host}/image`), `/api/img?url=${encodeURIComponent(`https://${host}/image`)}`);
  assert.equal(utils.proxiedImg('https://qq.com/image'), 'https://qq.com/image');
  const row = {platform: 'wechat_channels', cover_url: 'https://finder.video.qq.com/original', cover_local: '/media/covers/saved.png',
    author_avatar: 'https://wx.qlogo.cn/original', author_avatar_local: '/media/avatars/saved.png'};
  const original = structuredClone(row);
  assert.equal(images.recordDisplayCover(row), '/media/covers/saved.png');
  assert.equal(images.recordDisplayAvatar(row), '/media/avatars/saved.png');
  assert.deepEqual(row, original);
  assert.equal(images.recordDisplayAvatar({...row, author_avatar_local: ''}), utils.proxiedImg(row.author_avatar));
  assert.equal(images.recordDisplayCover({platform: 'douyin', cover_url: 'https://p3.douyinpic.com/image'}), utils.proxiedImg('https://p3.douyinpic.com/image'));
  const page = source('pages/DataPage.tsx');
  assert.doesNotMatch(page, /PROXY_IMG_HOSTS|function proxyImg/);
  assert.match(page, /imageCell\(displayCover\(r\)/);
  assert.match(page, /imageCell\(displayAvatar\(r\)/);
  assert.match(page, /const cover = primaryImage\(row\)[\s\S]*push\(cover,/);
});
