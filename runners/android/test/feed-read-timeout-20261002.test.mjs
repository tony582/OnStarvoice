// 2026-10-02 12:16: after a keyword the phone returned to Douyin's home feed, which rested on an
// auto-advancing photo post. The hierarchy read of that screen never finished, so every later keyword
// failed its first read with device_timeout within 20 seconds (15 in a row; 61 over five days, all since
// tasks started ending on the home feed). Swiping to the next feed item by hand made the phone work again.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DeviceError} from '../src/device/bounded.mjs';
import {createAdbClient} from '../src/device/adb.mjs';
import {resource} from '../src/device/douyin-profile.mjs';
import {createProfileSession} from '../src/device/profile-session.mjs';
import {UNREADABLE_FEED_SKIPS} from '../src/device/douyin-readiness.mjs';

const node = (id, text = '', extra = {}) => `<android.widget.TextView ${Object.entries({
  package: 'com.ss.android.ugc.aweme', class: 'android.widget.TextView', 'resource-id': resource(id),
  text, displayed: 'true', enabled: 'true', bounds: '[0,0][100,100]', ...extra,
}).map(([key, value]) => `${key}="${value}"`).join(' ')} />`;
const xml = body => `<hierarchy>${body}</hierarchy>`;
const ownProfile = xml(node('504', '抖音号：starvoice') + node('whh', '编辑主页') + node('0p3', '', {'content-desc': '首页，按钮'}));
const home = xml(node('hmy', '', {'content-desc': '搜索'}) + node('0p3', '', {'content-desc': '我，按钮'}));
const HANGS = Symbol('a read that never finishes');
const HOME_FOCUS = '  mCurrentFocus=Window{7918cc1 u0 com.ss.android.ugc.aweme/com.ss.android.ugc.aweme.splash.SplashActivity}';
const SEARCH_FOCUS = '  mCurrentFocus=Window{1a2b3c4 u0 com.ss.android.ugc.aweme/com.ss.android.ugc.aweme.search.activity.SearchResultActivity}';

function phone(sources, {focus = HOME_FOCUS, swipe = async () => ({swiped: true})} = {}) {
  const calls = [];
  let index = 0;
  const client = {
    createProfileSession: async () => ({sessionId: 'session-1'}), isLocked: async () => false,
    settings: async () => ({wakeLockTimeout: 0, enableTopmostWindowFromActivePackage: false}),
    source: async () => {
      const next = sources[Math.min(index++, sources.length - 1)];
      calls.push(next === HANGS ? 'read:timeout' : 'read');
      if (next === HANGS) throw new DeviceError('device_timeout', 'Device operation exceeded its time budget', {stopConfirmationRequired: true});
      return next;
    },
    findElements: async () => [{'element-6066-11e4-a52e-4f735466cecf': 'element-1'}], clickElement: async () => { calls.push('click'); return null; },
    back: async () => { calls.push('back'); return null; }, status: async () => ({ready: true}),
    deleteSession: async () => null, isSessionActive: async () => false,
  };
  const adb = {inspect: async () => ({model: 'DE106', apiLevel: 27}), inspectApp: async () => ({appVersion: '40.6.0'}),
    helperPids: async () => [], listDevices: async () => [{serial: 'phone-1', state: 'device'}], stopHelper: async () => null,
    windowFocus: async () => { calls.push('focus'); return focus; },
    swipeUp: async (...args) => { calls.push('swipe'); return swipe(...args); }};
  const session = createProfileSession({serial: 'phone-1', profileId: 'douyin-40.6.0-de106-api27-p0', adb, client, feedSettleMs: 1});
  return {session, calls};
}

test('a home feed item that cannot be read is skipped and the keyword starts', async () => {
  const {session, calls} = phone([HANGS, home, ownProfile, home]);
  const state = await session.inspect();
  assert.deepEqual([state.loggedIn, state.challenge, state.readyForSearch, state.feedSkips], [true, false, true, 1]);
  assert.deepEqual(calls.slice(0, 4), ['read:timeout', 'focus', 'swipe', 'read']);
  assert.equal(calls.filter(call => call === 'swipe').length, 1);
});

test('the feed is moved on a bounded number of times, then the timeout is reported as before', async () => {
  const recovered = phone([HANGS, HANGS, home, ownProfile, home]);
  assert.equal((await recovered.session.inspect()).feedSkips, UNREADABLE_FEED_SKIPS);
  assert.equal(recovered.calls.filter(call => call === 'swipe').length, 2);

  const stuck = phone([HANGS]);
  await assert.rejects(stuck.session.inspect(), error => {
    assert.deepEqual([error.code, error.stage, error.feedSkips, error.stopConfirmationRequired],
      ['device_timeout', 'inspect:login_check', UNREADABLE_FEED_SKIPS, true]);
    return true;
  });
  assert.equal(stuck.calls.filter(call => call === 'swipe').length, UNREADABLE_FEED_SKIPS);
  assert.equal(stuck.calls.filter(call => call === 'read:timeout').length, UNREADABLE_FEED_SKIPS + 1);
});

test('nothing is swiped when Douyin\'s home screen does not hold focus', async () => {
  for (const focus of [SEARCH_FOCUS, '  mCurrentFocus=Window{9 u0 com.smartisanos.launcher/com.smartisanos.launcher.Launcher}', '']) {
    const {session, calls} = phone([HANGS, home], {focus});
    await assert.rejects(session.inspect(), error => {
      assert.deepEqual([error.code, error.feedSkips], ['device_timeout', undefined]);
      return true;
    });
    assert.equal(calls.includes('swipe'), false);
    assert.equal(calls.filter(call => call.startsWith('read')).length, 1);
  }
});

test('only the screen a keyword starts on is skipped: a timeout on a screen the check opened itself is not', async () => {
  // First read works (home), the check opens the own-profile tab, and the read there never finishes.
  const {session, calls} = phone([home, HANGS]);
  await assert.rejects(session.inspect(), error => {
    assert.deepEqual([error.code, error.feedSkips], ['device_timeout', undefined]);
    return true;
  });
  assert.equal(calls.includes('swipe'), false);
  assert.equal(calls.includes('focus'), false);
});

test('a swipe that fails never hides the timeout that led to it', async () => {
  const {session, calls} = phone([HANGS, home], {swipe: async () => { throw new DeviceError('command_failed', 'Device command failed'); }});
  await assert.rejects(session.inspect(), error => {
    assert.deepEqual([error.code, error.stage], ['device_timeout', 'inspect:login_check']);
    return true;
  });
  assert.equal(calls.filter(call => call === 'swipe').length, 1);
  assert.equal(calls.filter(call => call.startsWith('read')).length, 1);
});

test('the swipe goes through adb with points taken from the display size and the serial pinned', async () => {
  const commands = [];
  const reply = size => async (file, args) => { commands.push(args.slice(4)); return {stdout: args.includes('wm') || args.at(-1) === 'wm size' ? size : '', stderr: ''}; };
  const adb = createAdbClient({command: reply('Physical size: 1080x2242\n')});
  assert.deepEqual(await adb.swipeUp('829d89'), {swiped: true, width: 1080, height: 2242});
  assert.deepEqual(commands, [['-s', '829d89', 'shell', 'wm size'], ['-s', '829d89', 'shell', 'input', 'swipe', '540', '1502', '540', '605', '250']]);

  commands.length = 0;
  const scaled = createAdbClient({command: reply('Physical size: 1080x2242\nOverride size: 720x1495\n')});
  await scaled.swipeUp('829d89');
  assert.deepEqual(commands[1].slice(3), ['input', 'swipe', '360', '1002', '360', '404', '250']);

  commands.length = 0;
  const unknown = createAdbClient({command: reply('error: no devices/emulators found\n')});
  await assert.rejects(unknown.swipeUp('829d89'), {code: 'display_size_unknown'});
  assert.equal(commands.some(args => args.includes('input')), false);
  await assert.rejects(adb.swipeUp('not a serial; rm -rf'), {code: 'serial_required'});
});
