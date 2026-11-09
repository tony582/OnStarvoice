import test from 'node:test';
import assert from 'node:assert/strict';
import {createWechatAdapter, createWechatDeviceAdapter} from '../src/device/wechat-adapter.mjs';
import {createWechatArticleAdapter} from '../src/device/wechat-article-adapter.mjs';
import {UNICODE_IME} from '../src/device/adb-screen.mjs';

function environment({model = 'DE106', keyboard = UNICODE_IME, remembered = 'owner.keyboard/.IME'} = {}) {
  let selected = keyboard; const calls = [];
  return {calls, options: {serial: 'phone-1', ocrBinary: process.execPath, now: () => 1000,
    ime: {load: () => remembered, save: value => calls.push(['remember', value])},
    adb: {listDevices: async () => [{serial: 'phone-1', state: 'device'}], inspect: async () => ({model, apiLevel: '27'}),
      powerState: async () => 'mWakefulness=Awake', keyguardState: async () => 'mKeyguardShowing=false',
      windowFocus: async () => 'mCurrentFocus=Window{abc u0 com.tencent.mm/.ui.LauncherUI}'},
    ocr: {recognize: async () => ({rows: ['微信', '通讯录', '发现'].map((text, index) => ({text, x: 80 + index * 260, y: 2150, w: 100, h: 45}))})},
    screen: {packageVersion: async name => name === 'com.tencent.mm' ? '8.0.80' : '1.0', listImes: async () => [UNICODE_IME],
      defaultIme: async () => selected, setIme: async value => { selected = value; calls.push(['setIme', value]); },
      disableIme: async value => calls.push(['disableIme', value]),
      launch: async component => calls.push(['launch', component]), screenshot: async () => Buffer.alloc(8)},
  }};
}
for (const [name, create] of [['channels', createWechatAdapter], ['articles', createWechatArticleAdapter]]) {
  test(`${name}: shared lifecycle checks profile, restores the owner's keyboard, parks and closes`, async () => {
    const {options, calls} = environment(); const adapter = create(options);
    const probe = await adapter.probe(); assert.equal(probe.readyForSearch, true); assert.equal(probe.imeRepaired, true);
    assert.deepEqual(calls.slice(0, 2), [['setIme', 'owner.keyboard/.IME'], ['disableIme', UNICODE_IME]]);
    assert.equal((await adapter.inspect()).deviceId, 'phone-1');
    assert.equal((await adapter.parkHome({permit: {assertAllowed() {}, signal: new AbortController().signal}})).parked, true);
    const closed = await adapter.close(); assert.equal(closed.closed, true); assert.equal(closed.verifiedAt, '1970-01-01T00:00:01.000Z');
    assert.match(closed.evidenceId, /^[a-f0-9-]{36}$/u);
    const bad = create(environment({model: 'UnverifiedPhone'}).options);
    assert.equal((await bad.probe()).readyForSearch, false);
  });
  test(`${name}: closure cannot claim success when the original keyboard is unknown`, async () => {
    const adapter = create(environment({remembered: null}).options);
    assert.equal((await adapter.probe()).reason, 'input_method_unknown');
    assert.deepEqual(await adapter.close(), {closed: false, reason: 'input_method_unrestored'});
  });
}

test('the original Channels facade retains its operations; article facade exposes only its distinct UI operations', () => {
  const video = createWechatAdapter(environment().options), article = createWechatArticleAdapter(environment().options);
  assert.equal(video.platform, 'wechat_channels'); assert.equal(article.platform, 'wechat_articles');
  for (const name of ['openPost', 'forwardPost', 'readComments']) assert.equal(typeof video[name], 'function');
  assert.equal(video.openArticleLink, undefined); assert.equal(video.readArticle, undefined);
  assert.equal(typeof article.openArticleLink, 'function'); assert.equal(typeof article.readArticle, 'function');
  assert.equal(article.forwardPost, undefined); assert.equal(article.readComments, undefined);
});

test('shared closure waits for pending flow operations before restoring/resetting, and aborted calls do not start', async () => {
  const waiting = Promise.withResolvers(); let reset = false, finished = false;
  const adapter = createWechatDeviceAdapter(environment({keyboard: 'owner.keyboard/.IME'}).options, {
    flowMethods: ['search'], flowFactory: () => ({search: () => waiting.promise, reset: () => { reset = true; }}),
  });
  const operation = adapter.search(); await Promise.resolve();
  const closure = adapter.close().then(value => { finished = true; return value; });
  await Promise.resolve(); assert.equal(finished, false); assert.equal(reset, false);
  waiting.resolve({verified: true}); await operation;
  assert.equal((await closure).closed, true); assert.equal(reset, true);
  const stopped = AbortSignal.abort(); assert.throws(() => adapter.search({signal: stopped}), {code: 'aborted'});
});
