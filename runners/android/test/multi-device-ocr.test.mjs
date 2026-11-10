import test from 'node:test';
import assert from 'node:assert/strict';
import {combineRunnerDevices} from '../src/daemon/multi-device.mjs';
import {AndroidDaemon} from '../src/daemon/runtime.mjs';
import {RunnerStore} from '../src/storage/runner-store.mjs';
import {readDiagnostics, recordDiagnostic, localOcrDetails} from '../src/core/diagnostics.mjs';
import {DeviceError} from '../src/device/bounded.mjs';

function fixture({douyin = true} = {}) {
  const store = new RunnerStore(':memory:');
  let wall = 1_000_000, previewReady = true, closed = false;
  const requests = [], probes = [];
  const ocr = {lastSuccessAt: null, pending: 0, recognize(png, options) {
    assert.ok(Buffer.isBuffer(png));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    return new Promise((resolve, reject) => {
      ocr.pending++;
      requests.push({options, succeed() { ocr.lastSuccessAt = wall; ocr.pending--; resolve({rows: []}); },
        fail(error) { ocr.pending--; reject(error); }});
    });
  }, close() { closed = true; }};
  const adapter = platform => ({probe: async () => {
    probes.push(platform); return {readyForSearch: true, reason: null};
  }});
  const device = combineRunnerDevices({douyin: douyin ? adapter('douyin') : null,
    wechat: adapter('wechat_channels'), articles: adapter('wechat_articles'), ocr, store, now: () => wall,
    preview: {available: () => previewReady, close() {}}});
  return {store, ocr, device, requests, probes, advance(ms) { wall += ms; },
    unavailablePreview() { previewReady = false; }, get closed() { return closed; },
    close() { device.shutdown(); store.close(); }};
}

test('startup probe reports both WeChat platforms warming for 40 seconds while Douyin remains ready', async () => {
  const f = fixture();
  try {
    const daemon = new AndroidDaemon({config: {deviceId: 'test-phone'}, device: f.device,
      store: f.store, control: {}, delivery: {}});
    await daemon.probeDevice();
    assert.deepEqual(daemon.platforms, ['douyin']);
    assert.equal(daemon.ready, true);
    assert.equal(daemon.status().deviceProbe.platformReasons.wechat_channels, 'ocr_warming');
    assert.equal(daemon.status().deviceProbe.platformReasons.wechat_articles, 'ocr_warming');
    assert.equal(daemon.deviceProbe.ocr.readyForSearch, false);
    assert.deepEqual(f.probes, ['douyin']);
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].options.timeoutMs, 120_000);
    f.advance(39_999);
    assert.equal((await f.device.probe()).platformReasons.wechat_articles, 'ocr_warming');
    f.advance(1); f.requests[0].succeed();
    await f.device.prepareTask({platform: 'wechat_articles'});
    await daemon.probeDevice();
    assert.deepEqual(daemon.platforms, ['douyin', 'wechat_channels', 'wechat_articles']);
    assert.equal(daemon.deviceProbe.ocr.readyForSearch, true);
    assert.equal(daemon.deviceProbe.ocr.lastWarmupMs, 40_000);
    assert.equal(daemon.deviceProbe.platformReasons.wechat_articles, null);
    assert.equal(readDiagnostics(f.store).at(-1).event, 'ocr_warmup_ready');
  } finally { f.close(); }
  assert.equal(f.closed, true);
});

test('a WeChat-only runner stays unready, retries a failed warmup and retains local error details', async () => {
  const f = fixture({douyin: false});
  try {
    const first = await f.device.probe();
    assert.equal(first.readyForSearch, false); assert.equal(first.reason, 'ocr_warming');
    const waiting = f.device.prepareTask({platform: 'wechat_channels'});
    f.requests[0].fail(new DeviceError('ocr_failed', 'Recognition failed', {
      details: {error: 'recognition_failed', domain: 'Vision', code: 9, stderr: 'helper error'},
    }));
    await assert.rejects(waiting, {code: 'ocr_unavailable'});
    const failed = await f.device.probe();
    assert.equal(failed.readyForSearch, false); assert.equal(failed.reason, 'ocr_unavailable');
    assert.deepEqual(failed.platforms, []); assert.deepEqual(f.probes, []);
    assert.equal(readDiagnostics(f.store).at(-1).details.error, 'recognition_failed');
    f.advance(30_000);
    assert.equal((await f.device.probe()).reason, 'ocr_warming');
    assert.equal(f.requests.length, 2);
    f.requests[1].succeed();
    await f.device.prepareTask({platform: 'wechat_channels'});
    assert.deepEqual((await f.device.probe()).platforms, ['wechat_channels', 'wechat_articles']);
  } finally { f.close(); }
});

test('warm OCR never bypasses unavailable preview and stale task preparation is shared across both platforms', async () => {
  const f = fixture();
  try {
    await f.device.probe(); f.requests[0].succeed();
    await f.device.prepareTask({platform: 'wechat_channels'});
    f.unavailablePreview();
    const state = await f.device.probe();
    assert.deepEqual(state.platforms, ['douyin']);
    assert.equal(state.platformReasons.wechat_channels, 'preview_unavailable');
    assert.equal(state.platformReasons.wechat_articles, 'preview_unavailable');
    f.device.setTaskActive(true); f.advance(240_000);
    await f.device.prepareTask({platform: 'douyin'});
    assert.equal(f.requests.length, 1);
    const channels = f.device.prepareTask({platform: 'wechat_channels'});
    const articles = f.device.prepareTask({platform: 'wechat_articles'});
    await Promise.resolve();
    assert.equal(f.requests.length, 2);
    f.requests[1].succeed(); await Promise.all([channels, articles]);
    f.device.setTaskActive(false);
  } finally { f.close(); }
});

test('local diagnostic keeps the last 2 KB of UTF-8 stderr and does not enlarge other strings', () => {
  const store = new RunnerStore(':memory:');
  try {
    const failure = new DeviceError('ocr_failed', 'Recognition failed', {details: {
      error: 'recognition_failed', domain: 'Vision', code: 7, stderr: '丢'.repeat(1000) + '尾声',
    }});
    recordDiagnostic(store, {ocr: localOcrDetails(failure), message: 'x'.repeat(400)});
    const note = readDiagnostics(store)[0];
    assert.equal(note.ocr.error, 'recognition_failed'); assert.equal(note.ocr.code, 7);
    assert.equal(note.ocr.stderr.endsWith('尾声'), true);
    assert.ok(Buffer.byteLength(note.ocr.stderr) <= 2048);
    assert.equal(note.ocr.stderr.includes('\ufffd'), false);
    assert.equal(note.message.length, 300);
    assert.equal(localOcrDetails(new Error('not OCR')), null);
  } finally { store.close(); }
});
