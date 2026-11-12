import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter, getEventListeners} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtempSync, readdirSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createOcrPool, OCR_REQUEST_TIMEOUT_MS, OCR_FAST_FAILURE_MS, OCR_RECYCLE_COOLDOWN_MS} from '../src/device/ocr-pool.mjs';

const png = Buffer.from('89504e470d0a1a0a', 'hex');
function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'starvoice-ocr-pool-'));
  const workers = [];
  const spawnImpl = (binary, args, spawnOptions) => {
    const proc = new EventEmitter();
    Object.assign(proc, {stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), requests: [], signals: []});
    proc.stdin.on('data', data => proc.requests.push(JSON.parse(String(data))));
    proc.kill = signal => { proc.signals.push(signal); return true; };
    proc.reply = (reply, index = 0) => proc.stdout.write(JSON.stringify({id: proc.requests[index].id, ...reply}) + '\n');
    proc.spawnOptions = spawnOptions;
    workers.push(proc);
    return proc;
  };
  const pool = createOcrPool({binaryPath: process.execPath, tmpDir: directory, spawnImpl, ...options});
  t.after(() => { pool.close(); rmSync(directory, {recursive: true, force: true}); });
  return {pool, workers, directory};
}

test('helper errors preserve error, NSError identity and only the last 2 KB of stderr', async t => {
  const {pool, workers, directory} = fixture(t);
  const request = pool.recognize(png);
  const worker = workers[0];
  assert.deepEqual(worker.spawnOptions.stdio, ['pipe', 'pipe', 'pipe']);
  const stderr = 'old diagnostic\n'.repeat(300) + 'Vision loading failed\n';
  worker.stderr.write(stderr.slice(0, 100));
  worker.stderr.write(stderr.slice(100));
  worker.reply({ok: false, error: 'recognition_failed', domain: 'VNErrorDomain', code: 9});
  await assert.rejects(request, failure => {
    assert.equal(failure.code, 'ocr_failed');
    assert.deepEqual(failure.details, {error: 'recognition_failed', domain: 'VNErrorDomain', code: 9, stderr: stderr.slice(-2048)});
    return true;
  });
  assert.deepEqual(readdirSync(directory), []);
  assert.equal(pool.pending, 0);
  assert.equal(pool.lastSuccessAt, null);
});

test('image_unreadable and UTF-8 stderr stay bounded without overwriting the pool error code', async t => {
  const {pool, workers} = fixture(t);
  const request = pool.recognize(png);
  workers[0].stderr.write('识字诊断'.repeat(400));
  workers[0].reply({ok: false, error: 'image_unreadable'});
  await assert.rejects(request, failure => {
    assert.equal(failure.code, 'ocr_failed');
    assert.equal(failure.details.error, 'image_unreadable');
    assert.ok(Buffer.byteLength(failure.details.stderr) <= 2048);
    assert.ok(failure.details.stderr.endsWith('识字诊断'));
    return true;
  });
});

test('a 120 second request can complete after 40 seconds without widening the 15 second default', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let now = 1000;
  const {pool, workers} = fixture(t, {now: () => now});
  assert.equal(OCR_REQUEST_TIMEOUT_MS, 15_000);
  assert.equal(pool.lastSuccessAt, null);
  const request = pool.recognize(png, {timeoutMs: 120_000});
  t.mock.timers.tick(40_000);
  now += 40_000;
  assert.equal(pool.pending, 1);
  workers[0].reply({ok: true, rows: [{text: '  微信文章 ', x: 2.6, y: 3, w: 4, h: 5}], ms: 40_000});
  assert.equal((await request).rows[0].text, '微信文章');
  assert.equal(pool.lastSuccessAt, 41_000);
});

test('default timeout retires outstanding work and allows a fresh warmup without stacking requests', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const {pool, workers, directory} = fixture(t, {now: () => 25});
  const first = pool.recognize(png);
  workers[0].reply({ok: true, rows: []});
  await first;
  assert.equal(pool.lastSuccessAt, 25);
  const timed = pool.recognize(png);
  const other = pool.recognize(png, {timeoutMs: 120_000});
  const timedCheck = assert.rejects(timed, error => error.code === 'ocr_timeout' && error.details.timeoutMs === 15_000);
  const otherCheck = assert.rejects(other, error => error.code === 'ocr_unavailable' && error.details.error === 'request_timeout');
  t.mock.timers.tick(15_000);
  await Promise.all([timedCheck, otherCheck]);
  assert.deepEqual(workers[0].signals, ['SIGTERM']);
  assert.equal(pool.lastSuccessAt, null);
  assert.equal(pool.pending, 0);
  assert.deepEqual(readdirSync(directory), []);
  const recovered = pool.recognize(png, {timeoutMs: 120_000});
  assert.equal(workers.length, 2);
  workers[1].reply({ok: true, rows: []});
  await recovered;
  assert.equal(pool.lastSuccessAt, 25);
});

test('abort and close remove listeners, cancel helper work and do not mark it warm', async t => {
  const {pool, workers, directory} = fixture(t);
  const canceled = new AbortController();
  canceled.abort();
  await assert.rejects(pool.recognize(png, {signal: canceled.signal}), {code: 'aborted'});
  assert.equal(workers.length, 0);
  const controller = new AbortController();
  const request = pool.recognize(png, {signal: controller.signal});
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  controller.abort();
  await assert.rejects(request, {code: 'aborted'});
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.deepEqual(workers[0].signals, ['SIGTERM']);
  const nextController = new AbortController();
  const next = pool.recognize(png, {signal: nextController.signal});
  pool.close();
  await assert.rejects(next, {code: 'aborted'});
  assert.equal(getEventListeners(nextController.signal, 'abort').length, 0);
  assert.equal(pool.lastSuccessAt, null);
  assert.deepEqual(readdirSync(directory), []);
  await assert.rejects(pool.recognize(png), {code: 'ocr_unavailable'});
});

test('successful replies detach abort listeners and an exited helper cannot remain warm', async t => {
  const {pool, workers} = fixture(t, {now: () => 900});
  const controller = new AbortController();
  const request = pool.recognize(png, {signal: controller.signal});
  workers[0].reply({ok: true, rows: []});
  await request;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(pool.lastSuccessAt, 900);
  workers[0].emit('exit', 23, 'SIGKILL');
  assert.equal(pool.lastSuccessAt, null);
  workers[0].emit('close', 23, 'SIGKILL');
  const next = pool.recognize(png);
  assert.equal(workers.length, 2);
  workers[1].stderr.write('exit ');
  workers[1].emit('exit', 23, 'SIGKILL');
  await assert.rejects(pool.recognize(png), {code: 'ocr_unavailable'});
  workers[1].stderr.write('detail');
  workers[1].emit('close', 23, 'SIGKILL');
  await assert.rejects(next, failure => {
    assert.deepEqual(failure.details, {exitCode: 23, signal: 'SIGKILL', stderr: 'exit detail'});
    return failure.code === 'ocr_unavailable';
  });
});

test('spawn and stdin errors retain diagnostics and release pending screenshots', async t => {
  const {pool, workers, directory} = fixture(t);
  const request = pool.recognize(png);
  workers[0].stderr.write('write failure');
  workers[0].stdin.emit('error', Object.assign(new Error('broken helper pipe'), {code: 'EPIPE'}));
  await assert.rejects(request, failure => {
    assert.deepEqual(failure.details, {error: 'EPIPE', message: 'broken helper pipe', stderr: 'write failure'});
    return failure.code === 'ocr_unavailable';
  });
  assert.equal(pool.pending, 0);
  assert.deepEqual(readdirSync(directory), []);
  const failing = fixture(t, {spawnImpl: () => { throw Object.assign(new Error('spawn refused'), {code: 'EACCES'}); }});
  await assert.rejects(failing.pool.recognize(png), failure => {
    assert.deepEqual(failure.details, {error: 'EACCES', message: 'spawn refused', stderr: ''});
    return failure.code === 'ocr_unavailable';
  });
});

test('a successful reply drained after helper exit cannot claim a warm live helper', async t => {
  const {pool, workers} = fixture(t, {now: () => 1234});
  const request = pool.recognize(png);
  workers[0].emit('exit', 0, null);
  workers[0].reply({ok: true, rows: []});
  await request;
  assert.equal(pool.lastSuccessAt, null);
  workers[0].emit('close', 0, null);
  assert.equal(pool.lastSuccessAt, null);
});

test('a process error cannot leave stale warmth or unhandled pending requests', async t => {
  const {pool, workers, directory} = fixture(t);
  const request = pool.recognize(png);
  workers[0].stderr.write('launch detail');
  workers[0].emit('error', Object.assign(new Error('helper launch failed'), {code: 'ENOEXEC'}));
  await assert.rejects(request, failure => failure.code === 'ocr_unavailable' && failure.details.error === 'ENOEXEC' && failure.details.stderr === 'launch detail');
  assert.equal(pool.pending, 0);
  assert.equal(pool.lastSuccessAt, null);
  assert.deepEqual(readdirSync(directory), []);
});

test('three fast recognition failures recycle the helper, settle concurrent work and gate ordinary retries until warm', async t => {
  let clock = 0;
  const {pool, workers, directory} = fixture(t, {now: () => clock});
  const events = [];
  pool.onRecycled(event => events.push(event));
  pool.onRecycled(() => { throw new Error('diagnostic sink unavailable'); });
  for (let i = 0; i < 2; i++) {
    const request = pool.recognize(png);
    clock += 20;
    workers[0].reply({ok: false, error: 'recognition_failed'}, i);
    await assert.rejects(request, {code: 'ocr_failed'});
  }
  assert.equal(workers.length, 1);
  const third = pool.recognize(png), concurrent = pool.recognize(png);
  const concurrentCheck = assert.rejects(concurrent, failure => failure.code === 'ocr_unavailable' && failure.details.reason === 'ocr_helper_recycled');
  clock += 50;
  workers[0].stderr.write('Vision detail');
  workers[0].reply({ok: false, error: 'recognition_failed', domain: 'Vision', code: 9}, 2);
  await assert.rejects(third, {code: 'ocr_failed'});await concurrentCheck;
  assert.equal(workers.length, 2);assert.deepEqual(workers[0].signals, ['SIGTERM']);
  assert.equal(pool.lastSuccessAt, null);assert.equal(pool.pending, 0);assert.deepEqual(readdirSync(directory), []);
  assert.deepEqual(events, [{event: 'ocr_helper_recycled', reason: 'recognition_failed', failures: 3, elapsedMs: 50,
    cooldownMs: 120_000, details: {error: 'recognition_failed', domain: 'Vision', code: 9, stderr: 'Vision detail'}}]);
  await assert.rejects(pool.recognize(png), failure => failure.code === 'ocr_unavailable' && failure.details.error === 'ocr_warming');
  assert.equal(workers[1].requests.length, 0);
  const warmup = pool.recognize(png, {warmup: true, timeoutMs: 120_000});
  workers[1].reply({ok: true, rows: []});await warmup;
  // Delayed termination events from the intentionally retired process cannot invalidate its replacement.
  workers[0].emit('exit', 0, 'SIGTERM');workers[0].emit('close', 0, 'SIGTERM');
  assert.equal(pool.lastSuccessAt, clock);
  const normal = pool.recognize(png);workers[1].reply({ok: true, rows: []}, 1);await normal;
});

test('success, a different error, and a failure taking exactly one second each break the rapid-failure streak', async t => {
  let clock = 0;
  const {pool, workers} = fixture(t, {now: () => clock});
  async function reply({elapsed = 20, ok = false, error = 'recognition_failed'} = {}) {
    const request = pool.recognize(png), worker = workers.at(-1), index = worker.requests.length - 1;
    clock += elapsed;
    worker.reply({ok, rows: [], error, ms: 1}, index); // Trust local elapsed time, not helper-reported milliseconds.
    if (ok) await request;else await assert.rejects(request, {code: 'ocr_failed'});
  }
  for (const breaker of [{ok: true}, {error: 'image_unreadable'}, {elapsed: OCR_FAST_FAILURE_MS}]) {
    await reply();await reply();await reply(breaker);
    assert.equal(workers.length, 1);
  }
  await reply();await reply();
  assert.equal(workers.length, 1);
  await reply({elapsed: OCR_FAST_FAILURE_MS - 1});
  assert.equal(workers.length, 2);
});

test('intentional recycling has a shared two-minute cooldown across helper generations', async t => {
  let clock = 0;
  const {pool, workers} = fixture(t, {now: () => clock});
  const events = [];pool.onRecycled(event => events.push(event));
  async function fail() {
    const request = pool.recognize(png, {warmup: true, timeoutMs: 120_000}), worker = workers.at(-1);
    worker.reply({ok: false, error: 'recognition_failed'}, worker.requests.length - 1);
    await assert.rejects(request, {code: 'ocr_failed'});
  }
  await fail();await fail();await fail();assert.equal(workers.length, 2);
  await fail();await fail();await fail();assert.equal(workers.length, 2);
  clock = OCR_RECYCLE_COOLDOWN_MS - 1;await fail();assert.equal(workers.length, 2);
  clock++;await fail();assert.equal(workers.length, 3);assert.equal(events.length, 2);
});

test('intentional recycling never consumes or resets the independent unexpected-exit budget', async t => {
  let clock = 0;
  const {pool, workers} = fixture(t, {now: () => clock});
  for (let crash = 0; crash < 2; crash++) {
    const request = pool.recognize(png);workers.at(-1).emit('close', 9, 'SIGKILL');
    await assert.rejects(request, {code: 'ocr_unavailable'});
  }
  for (let cycle = 0; cycle < 5; cycle++) {
    for (let failure = 0; failure < 3; failure++) {
      const request = pool.recognize(png), worker = workers.at(-1);
      worker.reply({ok: false, error: 'recognition_failed'}, worker.requests.length - 1);
      await assert.rejects(request, {code: 'ocr_failed'});
    }
    const retired = workers.at(-2);retired.emit('close', 0, 'SIGTERM');
    const warmup = pool.recognize(png, {warmup: true, timeoutMs: 120_000});
    workers.at(-1).reply({ok: true, rows: []});await warmup;
    clock += OCR_RECYCLE_COOLDOWN_MS;
  }
  assert.equal(workers.length, 8, 'more than MAX_RESTARTS healthy intentional replacements are allowed');
  for (let crash = 0; crash < 2; crash++) {
    const request = pool.recognize(png);workers.at(-1).emit('close', 9, 'SIGKILL');
    await assert.rejects(request, {code: 'ocr_unavailable'});
  }
  await assert.rejects(pool.recognize(png), error => error.code === 'ocr_unavailable' && error.message.includes('keeps stopping'));
});
