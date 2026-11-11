import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WECHAT_IMAGE_MAX_BYTES} from '../server/services/wechat-image-validation.js';
import {pngFixture} from './helpers/wechat-image-fixtures.mjs';

test('article size failures retain precise evidence using only mocked responses and local files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wechat-storage-errors-'));
  const previousMediaDir = process.env.MEDIA_DIR, previousFetch = globalThis.fetch;
  process.env.MEDIA_DIR = directory;
  let response;
  globalThis.fetch = async url => {
    assert.equal(url, 'https://mmbiz.qpic.cn/offline-storage-fixture');
    return response();
  };
  const {downloadImage, verifiedArticleLocalImage, articleImageStorageResult} = await import('../server/services/media-store.js?storage-error-test');
  const images = join(directory, 'images'); await mkdir(images);
  t.after(async () => {
    globalThis.fetch = previousFetch;
    if (previousMediaDir === undefined) delete process.env.MEDIA_DIR; else process.env.MEDIA_DIR = previousMediaDir;
    await rm(directory, {recursive: true, force: true});
  });
  const url = 'https://mmbiz.qpic.cn/offline-storage-fixture';
  const oversized = Math.ceil(9.3 * 1024 * 1024);
  const error = (source, observedBytes) => ({code: 'too_large', maxBytes: WECHAT_IMAGE_MAX_BYTES, observedBytes, source});

  await t.test('oversized Content-Length refuses a GIF before saving, with exact header evidence', async () => {
    const failures = []; let canceled = false;
    response = () => new Response(new ReadableStream({cancel() { canceled = true; }}),
      {headers: {'content-type': 'image/gif', 'content-length': String(oversized)}});
    assert.equal(await downloadImage(url, 'header', 'wechat_articles', images, 'images', value => failures.push(value)), null);
    assert.deepEqual(failures, [error('content_length', oversized)]); assert.equal(canceled, true);
    assert.deepEqual(await readdir(images), []);
  });

  await t.test('streamed bytes exceeding the unchanged limit are classified and partial files removed', async () => {
    const failures = [];
    response = () => new Response(new ReadableStream({start(controller) {
      controller.enqueue(Buffer.alloc(WECHAT_IMAGE_MAX_BYTES)); controller.enqueue(Buffer.alloc(1)); controller.close();
    }}), {headers: {'content-type': 'image/gif'}});
    assert.equal(await downloadImage(url, 'stream', 'wechat_articles', images, 'images', value => failures.push(value)), null);
    assert.deepEqual(failures, [error('stream', WECHAT_IMAGE_MAX_BYTES + 1)]);
    assert.deepEqual(await readdir(images), []);
  });

  await t.test('network, HTTP and invalid-image failures never acquire a size reason', async () => {
    for (const fail of [() => {throw new Error('offline simulated network failure');},
      () => new Response('', {status: 403}),
      () => new Response('not a valid image', {headers: {'content-type': 'image/gif'}})]) {
      response = fail; const failures = [];
      assert.equal(await downloadImage(url, 'ordinary', 'wechat_articles', images, 'images', value => failures.push(value)), null);
      assert.deepEqual(failures, []);
    }
  });

  await t.test('a valid image is saved through the existing path without size-error evidence', async () => {
    response = () => new Response(pngFixture(), {headers: {'content-type': 'image/png'}});
    const failures = [];
    assert.equal(await downloadImage(url, 'valid', 'wechat_articles', images, 'images', value => failures.push(value)), '/media/images/valid.png');
    assert.deepEqual(failures, []); assert.equal((await verifiedArticleLocalImage('/media/images/valid.png')).width, 120);
  });

  await t.test('downloaded and cached separators have explicit decorative evidence and no saved image', async () => {
    response = () => new Response(pngFixture(1, 3), {headers: {'content-type': 'image/png'}});
    const downloaded = [];
    assert.equal(await downloadImage(url, 'separator', 'wechat_articles', images, 'images', value => downloaded.push(value)), null);
    assert.deepEqual(downloaded, [{code: 'decorative'}]);
    assert.ok(!(await readdir(images)).some(name => name.startsWith('separator')));
    await writeFile(join(images, 'cached-separator.png'), pngFixture(1, 3));
    const cached = [];
    assert.equal(await verifiedArticleLocalImage('/media/images/cached-separator.png', value => cached.push(value)), null);
    assert.deepEqual(cached, [{code: 'decorative'}]);
    const image = articleImageStorageResult({url, stored: false}, '', downloaded[0]);
    assert.deepEqual(image.storageError, {code: 'decorative'});
    assert.deepEqual(articleImageStorageResult(image).storageError, {code: 'decorative'});
    assert.equal(Object.hasOwn(articleImageStorageResult(image, '/media/images/valid.png'), 'storageError'), false);
  });

  await t.test('an existing oversized local cache is refused with measured file size', async () => {
    await writeFile(join(images, 'oversized.gif'), Buffer.alloc(oversized));
    const failures = [];
    assert.equal(await verifiedArticleLocalImage('/media/images/oversized.gif', value => failures.push(value)), null);
    assert.deepEqual(failures, [error('local_file', oversized)]);
  });

  await t.test('missing or malformed local caches have no invented too-large reason', async () => {
    await writeFile(join(images, 'invalid.gif'), Buffer.from('GIF89a'));
    for (const path of ['/media/images/missing.gif', '/media/images/invalid.gif', '/media/../outside.gif']) {
      const failures = [];
      assert.equal(await verifiedArticleLocalImage(path, value => failures.push(value)), null);
      assert.deepEqual(failures, []);
    }
  });

  await t.test('other platforms retain their null result and do not receive article size metadata', async () => {
    response = () => new Response('', {headers: {'content-type': 'image/gif', 'content-length': String(oversized)}});
    const failures = [];
    assert.equal(await downloadImage(url, 'other', 'wechat_channels', images, 'images', value => failures.push(value)), null);
    assert.deepEqual(failures, []);
    assert.equal(WECHAT_IMAGE_MAX_BYTES, 8 * 1024 * 1024);
  });

  await t.test('later unknown failures preserve proven size evidence until a verified save succeeds', () => {
    const known = error('content_length', oversized), image = {url, stored: false, layer: 'interactive', storageError: known};
    assert.deepEqual(articleImageStorageResult(image).storageError, known);
    assert.deepEqual(articleImageStorageResult(image, '', {code: 'download_failed'}).storageError, known);
    const saved = articleImageStorageResult(image, '/media/images/valid.png');
    assert.equal(saved.stored, true); assert.equal(saved.layer, 'interactive'); assert.equal(Object.hasOwn(saved, 'storageError'), false);
    assert.equal(Object.hasOwn(articleImageStorageResult({url, stored: false}), 'storageError'), false);
    assert.equal(Object.hasOwn(articleImageStorageResult({url, storageError: {...known, observedBytes: 1}}), 'storageError'), false);
    assert.deepEqual(articleImageStorageResult(image, '', error('stream', oversized + 1)).storageError, error('stream', oversized + 1));
  });
});
