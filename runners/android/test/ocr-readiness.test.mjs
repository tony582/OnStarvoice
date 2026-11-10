import test from 'node:test';
import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import {DeviceError} from '../src/device/bounded.mjs';
import {createOcrReadiness, OCR_KEEPALIVE_MS, OCR_WARMUP_RETRY_MS, OCR_WARMUP_TIMEOUT_MS} from '../src/device/ocr-readiness.mjs';

async function flush() { for (let step = 0; step < 12; step++) await Promise.resolve(); }

function fixture(t, outcomes = []) {
  t.mock.timers.enable({apis: ['setTimeout']});
  let clock = 1000, successAt = null, pending = 0, externalPending = 0;
  const calls = [], diagnostics = [], image = Buffer.from('89504e470d0a1a0a', 'hex');
  const pool = {
    get lastSuccessAt() { return successAt; },
    get pending() { return pending + externalPending; },
    recognize(bytes, options) {
      const outcome = outcomes.shift() ?? {};
      calls.push({bytes, ...options, startedAt: clock});
      pending++;
      return new Promise((resolve, reject) => {
        let ended = false, timer;
        const finish = failure => {
          if (ended) return;
          ended = true;
          clearTimeout(timer);
          options.signal.removeEventListener('abort', cancel);
          pending--;
          if (failure) reject(failure);
          else { successAt = clock; resolve({rows: [{text: '微信文章'}], ms: outcome.delay ?? 0}); }
        };
        const cancel = () => finish(new DeviceError('aborted', 'fake warmup canceled'));
        options.signal.addEventListener('abort', cancel, {once: true});
        if (options.signal.aborted) { cancel(); return; }
        timer = setTimeout(() => finish(outcome.failure), outcome.delay ?? 0);
      });
    },
  };
  const readiness = createOcrReadiness({ocr: pool, now: () => clock, loadImage: () => image,
    onDiagnostic: entry => diagnostics.push(entry)});
  t.after(() => readiness.close());
  return {
    readiness, pool, calls, diagnostics, image,
    async advance(ms) { clock += ms; t.mock.timers.tick(ms); await flush(); },
    async startReady() { readiness.start(); await flush(); t.mock.timers.tick(0); await flush(); },
    recognizeReal() { successAt = clock; },
    invalidateHelper() { successAt = null; },
    setExternalPending(value) { externalPending = value; },
  };
}

test('startup remains ocr_warming through a fake 40 second cold recognition, then becomes ready', async t => {
  const f = fixture(t, [{delay: 40_000}]);
  f.readiness.start();
  assert.deepEqual(f.readiness.status(), {readyForSearch: false, reason: 'ocr_warming', lastSuccessAt: null, lastWarmupMs: null});
  await flush();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].bytes, f.image);
  assert.equal(f.calls[0].timeoutMs, OCR_WARMUP_TIMEOUT_MS);
  assert.equal(OCR_WARMUP_TIMEOUT_MS, 120_000);
  await f.advance(39_999);
  assert.equal(f.readiness.status().reason, 'ocr_warming');
  await f.advance(1);
  assert.deepEqual(f.readiness.status(), {readyForSearch: true, reason: null, lastSuccessAt: 41_000, lastWarmupMs: 40_000});
  assert.deepEqual(f.diagnostics, [{event: 'ocr_warmup_ready', elapsedMs: 40_000}]);
});

test('an idle runner keeps OCR warm at the four minute boundary using only the bundled image', async t => {
  const f = fixture(t);
  await f.startReady();
  assert.equal(f.calls.length, 1);
  await f.advance(OCR_KEEPALIVE_MS - 1);
  assert.equal(f.calls.length, 1);
  await f.advance(1);
  assert.equal(f.calls.length, 2);
  assert.equal(f.readiness.status().reason, 'ocr_warming');
  assert.equal(f.calls[1].bytes, f.image);
  await f.advance(0);
  assert.equal(f.readiness.status().readyForSearch, true);
  assert.equal(f.pool.pending, 0);
});

test('recent real recognition skips the scheduled keepalive and schedules it from that success', async t => {
  const f = fixture(t);
  await f.startReady();
  await f.advance(180_000);
  f.recognizeReal();
  await f.advance(60_000);
  assert.equal(f.calls.length, 1);
  assert.equal(f.readiness.status().readyForSearch, true);
  await f.advance(179_999);
  assert.equal(f.calls.length, 1);
  await f.advance(1);
  assert.equal(f.calls.length, 2);
  await f.advance(0);
  assert.equal(f.readiness.status().readyForSearch, true);
});

test('busy devices do not send keepalive and maintenance resumes after the task releases them', async t => {
  const f = fixture(t);
  await f.startReady();
  f.readiness.setTaskActive(true);
  await f.advance(OCR_KEEPALIVE_MS * 2);
  f.readiness.maintain();
  await flush();
  assert.equal(f.calls.length, 1);
  assert.equal(f.readiness.status().readyForSearch, false);
  f.readiness.setTaskActive(false);
  await flush();
  assert.equal(f.calls.length, 2);
  await f.advance(0);
  assert.equal(f.readiness.status().readyForSearch, true);
});

test('the task can await stale OCR warmth before starting its work while background maintenance is paused', async t => {
  const f = fixture(t, [{}, {delay: 40_000}]);
  await f.startReady();
  f.readiness.setTaskActive(true);
  await f.advance(OCR_KEEPALIVE_MS);
  let taskStarted = false;
  const preparation = f.readiness.ensureReady().then(() => { taskStarted = true; });
  await flush();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].timeoutMs, 120_000);
  await f.advance(39_999);
  assert.equal(taskStarted, false);
  await f.advance(1);
  await preparation;
  assert.equal(taskStarted, true);
  assert.equal(f.readiness.status().readyForSearch, true);
});

test('a warmup failure records its actual error and retries after the retry interval', async t => {
  const detail = {error: 'recognition_failed', domain: 'VNErrorDomain', code: 9, stderr: 'Vision detail'};
  const f = fixture(t, [{failure: new DeviceError('ocr_failed', 'failed', {details: detail})}, {}]);
  await f.startReady();
  assert.equal(f.readiness.status().reason, 'ocr_unavailable');
  assert.equal(f.readiness.status().readyForSearch, false);
  assert.deepEqual(f.diagnostics[0], {event: 'ocr_warmup_failed', code: 'ocr_failed', elapsedMs: 0, details: detail});
  await f.advance(OCR_WARMUP_RETRY_MS - 1);
  assert.equal(f.calls.length, 1);
  await f.advance(1);
  assert.equal(f.calls.length, 2);
  await f.advance(0);
  assert.equal(f.readiness.status().readyForSearch, true);
});

test('startup, maintenance and concurrent task preparation share the same warmup', async t => {
  const f = fixture(t, [{delay: 40_000}]);
  f.readiness.start();
  // Claiming a task pauses new idle work; the task joins the warmup that already started.
  f.readiness.setTaskActive(true);
  const first = f.readiness.ensureReady(), second = f.readiness.ensureReady();
  f.readiness.maintain();
  f.readiness.start();
  await flush();
  assert.equal(f.calls.length, 1);
  await f.advance(40_000);
  await Promise.all([first, second]);
  assert.equal(f.readiness.status().readyForSearch, true);
  await f.readiness.ensureReady();
  assert.equal(f.calls.length, 1);
});

test('canceled task preparation aborts warmup, removes its listener and remains unready until a later retry', async t => {
  const f = fixture(t, [{delay: 40_000}]);
  const controller = new AbortController();
  const preparing = f.readiness.ensureReady({signal: controller.signal});
  await flush();
  const reason = new DeviceError('aborted', 'user_stop');
  controller.abort(reason);
  await assert.rejects(preparing, failure => failure === reason);
  await flush();
  assert.equal(f.calls[0].signal.aborted, true);
  assert.equal(f.pool.pending, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(f.readiness.status().reason, 'ocr_unavailable');
  await f.advance(OCR_WARMUP_RETRY_MS - 1);
  assert.equal(f.calls.length, 1);
});

test('already canceled preparation and closed readiness never start new OCR work', async t => {
  const f = fixture(t);
  const controller = new AbortController();
  controller.abort(new DeviceError('aborted', 'user_stop'));
  await assert.rejects(f.readiness.ensureReady({signal: controller.signal}), {code: 'aborted'});
  assert.equal(f.calls.length, 0);
  f.readiness.close();
  f.readiness.start();
  f.readiness.maintain();
  f.readiness.setTaskActive(false);
  await assert.rejects(f.readiness.ensureReady(), {code: 'ocr_unavailable'});
  await f.advance(OCR_KEEPALIVE_MS * 2);
  assert.equal(f.calls.length, 0);
  assert.equal(f.readiness.status().reason, 'ocr_unavailable');
});

test('close cancels an in-flight warmup and prevents its failure from scheduling retries', async t => {
  const f = fixture(t, [{delay: 40_000}]);
  const preparing = f.readiness.ensureReady();
  await flush();
  f.readiness.close();
  await assert.rejects(preparing, {code: 'ocr_unavailable'});
  await flush();
  assert.equal(f.calls[0].signal.aborted, true);
  assert.equal(f.pool.pending, 0);
  await f.advance(OCR_KEEPALIVE_MS * 2);
  assert.equal(f.calls.length, 1);
  assert.equal(f.readiness.status().readyForSearch, false);
});

test('an in-flight real recognition defers keepalive until it supplies a fresh success', async t => {
  const f = fixture(t);
  await f.startReady();
  f.setExternalPending(1);
  await f.advance(OCR_KEEPALIVE_MS);
  assert.equal(f.calls.length, 1);
  f.recognizeReal();
  f.setExternalPending(0);
  await f.advance(1000);
  assert.equal(f.calls.length, 1);
  assert.equal(f.readiness.status().readyForSearch, true);
});

test('a stopped helper invalidates readiness despite a recent previous success', async t => {
  const f = fixture(t);
  await f.startReady();
  f.invalidateHelper();
  assert.equal(f.readiness.status().readyForSearch, false);
  const preparing = f.readiness.ensureReady();
  await flush();
  assert.equal(f.calls.length, 2);
  await f.advance(0);
  await preparing;
  assert.equal(f.readiness.status().readyForSearch, true);
});
