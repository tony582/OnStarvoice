import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter, getEventListeners} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtempSync, readdirSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createOcrPool, OCR_REQUEST_TIMEOUT_MS} from '../src/device/ocr-pool.mjs';

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
