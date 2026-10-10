import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { streamMediaToResponse } from '../server/services/media-proxy.js';

const BODY = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');

function listen(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

// 上游视频服务器：支持单段 Range，记下收到的请求头
function videoUpstream(seen) {
  return listen((req, res) => {
    seen.push({ path: req.url, range: req.headers.range || '', referer: req.headers.referer || '' });
    if (req.url === '/forbidden') {
      res.writeHead(403).end('denied');
      return;
    }
    if (req.url === '/slow') {
      // 总时长远超 timeoutMs，但一直有数据
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(BODY.length) });
      let index = 0;
      const tick = setInterval(() => {
        res.write(BODY.subarray(index, index + 4));
        index += 4;
        if (index >= BODY.length) { clearInterval(tick); res.end(); }
      }, 40);
      return;
    }
    if (req.url === '/stall') {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(BODY.length) });
      res.write(BODY.subarray(0, 4));
      return; // 之后再也不发数据
    }
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (match) {
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : BODY.length - 1;
      if (start >= BODY.length) {
        res.writeHead(416, { 'Content-Range': `bytes */${BODY.length}` }).end();
        return;
      }
      res.writeHead(206, {
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${BODY.length}`,
      });
      res.end(BODY.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': String(BODY.length) });
    res.end(BODY);
  });
}

// 代理：把 Node 的 res 补上 express 的 status/json，直接调 streamMediaToResponse
function proxy(upstreamBase, { timeoutMs } = {}) {
  return listen((req, res) => {
    res.status = code => { res.statusCode = code; return res; };
    res.json = body => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); return res; };
    const url = new URL(req.url, 'http://proxy.local');
    streamMediaToResponse({
      url: upstreamBase + url.pathname,
      filename: 'clip.mp4',
      platform: 'douyin',
      res,
      inline: url.searchParams.get('inline') === '1',
      range: req.headers.range || '',
      ...(timeoutMs ? { timeoutMs } : {}),
    });
  });
}

async function withServers(options, run) {
  const seen = [];
  const upstream = await videoUpstream(seen);
  const front = await proxy(upstream.base, options);
  try {
    await run({ base: front.base, seen });
  } finally {
    front.server.closeAllConnections?.();
    upstream.server.closeAllConnections?.();
    await new Promise(resolve => front.server.close(resolve));
    await new Promise(resolve => upstream.server.close(resolve));
  }
}

test('inline playback forwards the browser Range request and returns 206 without a download header', async () => {
  await withServers({}, async ({ base, seen }) => {
    const resp = await fetch(`${base}/video.mp4?inline=1`, { headers: { Range: 'bytes=10-19' } });
    assert.equal(resp.status, 206);
    assert.equal(resp.headers.get('content-range'), `bytes 10-19/${BODY.length}`);
    assert.equal(resp.headers.get('accept-ranges'), 'bytes');
    assert.equal(resp.headers.get('content-length'), '10');
    assert.equal(resp.headers.get('content-disposition'), null);
    assert.equal(Buffer.from(await resp.arrayBuffer()).toString(), 'abcdefghij');
    assert.equal(seen.at(-1).range, 'bytes=10-19');
    assert.equal(seen.at(-1).referer, 'https://www.douyin.com/');
  });
});

test('download mode keeps the attachment header and serves the whole file', async () => {
  await withServers({}, async ({ base, seen }) => {
    const resp = await fetch(`${base}/video.mp4`);
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get('content-disposition') || '', /^attachment; filename="clip\.mp4"/);
    assert.equal(Buffer.from(await resp.arrayBuffer()).toString(), BODY.toString());
    assert.equal(seen.at(-1).range, '');
  });
});

test('a malformed Range header is not forwarded upstream', async () => {
  await withServers({}, async ({ base, seen }) => {
    for (const range of ['items=0-5', 'bytes=ten-twenty']) {
      const resp = await fetch(`${base}/video.mp4?inline=1`, { headers: { Range: range } });
      assert.equal(resp.status, 200);
      await resp.arrayBuffer();
      assert.equal(seen.at(-1).range, '');
    }
  });
});

test('an unsatisfiable range is passed back as 416 instead of a proxy error', async () => {
  await withServers({}, async ({ base }) => {
    const resp = await fetch(`${base}/video.mp4?inline=1`, { headers: { Range: 'bytes=999-' } });
    assert.equal(resp.status, 416);
    assert.equal(resp.headers.get('content-range'), `bytes */${BODY.length}`);
  });
});

test('a stream that keeps sending data is not cut off by the timeout', async () => {
  // 上游约 400ms 才发完，超时只有 120ms：旧实现按总时长计时，会在半路中断
  await withServers({ timeoutMs: 120 }, async ({ base }) => {
    const resp = await fetch(`${base}/slow?inline=1`);
    assert.equal(resp.status, 200);
    assert.equal(Buffer.from(await resp.arrayBuffer()).toString(), BODY.toString());
  });
});

test('a stalled upstream is dropped after the idle timeout', async () => {
  await withServers({ timeoutMs: 150 }, async ({ base }) => {
    const startedAt = Date.now();
    const resp = await fetch(`${base}/stall?inline=1`);
    assert.equal(resp.status, 200);
    const body = await resp.arrayBuffer().then(buffer => Buffer.from(buffer).toString(), () => null);
    assert.notEqual(body, BODY.toString());
    assert.ok(Date.now() - startedAt < 3000, 'the stalled stream should end soon after the idle timeout');
  });
});

test('an expired or blocked upstream link reports 502 with a readable message', async () => {
  await withServers({}, async ({ base }) => {
    const resp = await fetch(`${base}/forbidden?inline=1`);
    assert.equal(resp.status, 502);
    const data = await resp.json();
    assert.equal(data.status, 403);
    assert.match(data.message, /过期|防盗链/);
  });
});
