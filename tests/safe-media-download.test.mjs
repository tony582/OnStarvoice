import test from 'node:test';
import assert from 'node:assert/strict';
import {withSafeMediaDownload, MEDIA_DOWNLOAD_MAX_BYTES} from '../server/services/safe-media-download.js';
import imageProxy from '../server/routes/image-proxy.js';

const allowed = url => ['p3.douyinpic.com', 'p4.douyinpic.com'].includes(new URL(url).hostname);
const read = async ({stream}) => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); };
const download = (options, consume = read) => withSafeMediaDownload({url: 'https://p3.douyinpic.com/image', isAllowedUrl: allowed, ...options}, consume);

test('every media redirect is manual, revalidated and receives headers for its own URL', async () => {
  const calls = [];
  const body = await download({headers: url => ({Referer: new URL(url).origin}), fetchImpl: async (url, options) => {
    calls.push({url, options});
    return calls.length === 1 ? new Response('', {status: 302, headers: {location: 'https://p4.douyinpic.com/image'}}) : new Response('image');
  }});
  assert.equal(body.toString(), 'image');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.options.redirect === 'manual'));
  assert.deepEqual(calls.map(call => call.options.headers.Referer), ['https://p3.douyinpic.com', 'https://p4.douyinpic.com']);
});

test('bad protocols, credentials, ports and hosts are rejected initially and on redirect before fetch', async () => {
  for (const target of ['http://p3.douyinpic.com/image', 'https://p3.douyinpic.com:8443/image',
    'https://user@p3.douyinpic.com/image', 'https://p3.douyinpic.com.evil.test/image', 'https://127.0.0.1/private']) {
    let calls = 0;
    const fetchImpl = async () => { calls++; return new Response('', {status: 302, headers: {location: target}}); };
    await assert.rejects(download({url: target, fetchImpl}), {code: 'host_not_allowed', status: 403});
    assert.equal(calls, 0);
    await assert.rejects(download({fetchImpl}), {code: 'host_not_allowed', status: 403});
    assert.equal(calls, 1);
  }
});

test('three redirects are allowed and a fourth cannot be followed', async () => {
  for (const count of [3, 4]) {
    let calls = 0, canceled = 0;
    const operation = download({fetchImpl: async () => {
      calls++;
      return calls <= count ? new Response(new ReadableStream({cancel() {canceled++;}}),
        {status: 302, headers: {location: '/next'}}) : new Response('ok');
    }});
    if (count === 3) assert.equal((await operation).toString(), 'ok');
    else await assert.rejects(operation, {code: 'redirect_failed'});
    assert.equal(calls, 4);
    assert.equal(canceled, count);
  }
});

test('an oversized Content-Length aborts and cancels before body consumption', async () => {
  let signal, canceled = false, consumed = false;
  await assert.rejects(download({fetchImpl: async (_url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({cancel() {canceled = true;}}),
      {headers: {'content-length': String(MEDIA_DOWNLOAD_MAX_BYTES + 1)}});
  }}, async () => { consumed = true; }), {code: 'too_large', source: 'content_length', status: 413});
  assert.equal(signal.aborted, true); assert.equal(canceled, true); assert.equal(consumed, false);
});

test('streaming byte limit aborts immediately even without Content-Length and cannot exceed the absolute cap', async () => {
  let signal, canceled = false, reads = 0;
  await assert.rejects(download({maxBytes: MEDIA_DOWNLOAD_MAX_BYTES * 2, fetchImpl: async (_url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({pull(controller) {
      reads++;
      controller.enqueue(Buffer.alloc(MEDIA_DOWNLOAD_MAX_BYTES + 1));
    }, cancel() {canceled = true;}}));
  }}), {code: 'too_large', source: 'stream', maxBytes: MEDIA_DOWNLOAD_MAX_BYTES});
  assert.equal(signal.aborted, true); assert.equal(canceled, true); assert.ok(reads <= 3);
});

test('the deadline covers a stalled response body and cancels even a mocked body that ignores fetch abort', async () => {
  let signal, canceled = false;
  const started = Date.now();
  await assert.rejects(download({timeoutMs: 40, fetchImpl: async (_url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({start(controller) {controller.enqueue(Buffer.from('first'));}, cancel() {canceled = true;}}));
  }}), {code: 'upstream_timeout', status: 504});
  assert.ok(Date.now() - started < 1000);
  assert.equal(signal.aborted, true); assert.equal(canceled, true);
});

test('a continuously trickling download still has a total deadline', async () => {
  let interval, canceled = false;
  await assert.rejects(download({timeoutMs: 60, fetchImpl: async () => new Response(new ReadableStream({
    start(controller) {interval = setInterval(() => controller.enqueue(Buffer.from('x')), 10);},
    cancel() {canceled = true;clearInterval(interval);},
  }))}), {code: 'upstream_timeout'});
  assert.equal(canceled, true);
});

test('a consumer can reject an unexpected body without leaving its fetch alive', async () => {
  let signal, canceled = false;
  assert.equal(await download({fetchImpl: async (_url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({cancel() {canceled = true;}}));
  }}, async () => 'not an image'), 'not an image');
  assert.equal(signal.aborted, true); assert.equal(canceled, true);
});

test('image proxy rejects a non-WeChat CDN redirect and retains successful response headers', async t => {
  const previous = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({url, options});
    return url.endsWith('/redirect') ? new Response('', {status: 302, headers: {location: 'https://evil.test/'}})
      : new Response('pixels', {headers: {'content-type': 'image/png'}});
  };
  t.after(() => {globalThis.fetch = previous;});
  const handler = imageProxy.stack.find(layer => layer.route).route.stack[0].handle;
  const invoke = async url => {
    const output = {status: 200, headers: {}};
    const res = {status(status) {output.status = status;return this;}, set(k,v) {output.headers[k] = v;return this;}, send(body) {output.body = body;return this;}};
    await handler({query: {url}}, res); return output;
  };
  assert.equal((await invoke('https://p3.douyinpic.com/redirect')).status, 403);
  assert.equal(calls.length, 1);
  const success = await invoke('https://p3.douyinpic.com/image');
  assert.equal(success.status, 200);
  assert.equal(success.headers['Cache-Control'], 'public, max-age=86400, immutable');
  assert.equal(success.headers['Cross-Origin-Resource-Policy'], 'cross-origin');
  assert.equal(success.body.toString(), 'pixels');
});

test('inline media streaming cannot bypass URL or size validation', async t => {
  const {streamMediaToResponse} = await import('../server/services/media-proxy.js');
  const previous = globalThis.fetch; let calls = 0, aborted;
  globalThis.fetch = async (_url, options) => {
    calls++; aborted = options.signal;
    return new Response(new ReadableStream(), {headers: {'content-length': String(MEDIA_DOWNLOAD_MAX_BYTES + 1)}});
  };
  t.after(() => {globalThis.fetch = previous;});
  const invoke = async url => {
    const output = {};
    const res = {status(status) {output.status = status;return this;}, json(body) {output.body = body;return this;}};
    await streamMediaToResponse({url, res, inline: true}); return output;
  };
  assert.equal((await invoke('https://127.0.0.1/video')).status,403);
  assert.equal(calls,0);
  assert.equal((await invoke('https://p3.douyinvod.com/video')).status,413);
  assert.equal(aborted.aborted,true);
});

test('non-WeChat stored images reject cross-host redirects and bound actual streamed bytes', async t => {
  const {mkdtemp,mkdir,readdir,rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');const {join} = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(),'bounded-media-store-'));
  const previous = globalThis.fetch; const {downloadImage} = await import('../server/services/media-store.js');
  await mkdir(join(directory,'images'));
  t.after(async () => {globalThis.fetch = previous;await rm(directory,{recursive:true,force:true});});
  let calls = 0;
  globalThis.fetch = async () => {calls++;return new Response('',{status:302,headers:{location:'https://127.0.0.1/private'}});};
  assert.equal(await downloadImage('https://p3.douyinpic.com/image','redirect','douyin',join(directory,'images'),'images'),null);
  assert.equal(calls,1);
  let signal;
  globalThis.fetch = async (_url, options) => {signal = options.signal;return new Response(Buffer.alloc(8*1024*1024+1),{headers:{'content-type':'image/png'}});};
  assert.equal(await downloadImage('https://p3.douyinpic.com/image','overflow','douyin',join(directory,'images'),'images'),null);
  assert.equal(signal.aborted,true);assert.deepEqual(await readdir(join(directory,'images')),[]);
});
