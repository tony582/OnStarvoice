import test from 'node:test';
import assert from 'node:assert/strict';
import {createAdbClient} from '../src/device/adb.mjs';
import {createForegroundGuard, DOUYIN_LAUNCH_COMPONENT, parseKeyguard, parseResumedActivity,
  parseWakefulness, parseWindowFocus} from '../src/device/douyin-foreground.mjs';
import {createProfileAdapter} from '../src/device/profile-adapter.mjs';

const serial = '829d89';
const focusDouyin = '  mCurrentFocus=Window{7b9c1d3 u0 com.ss.android.ugc.aweme/com.ss.android.ugc.aweme.detail.ultra.ui.UltraDetailActivity}\n'
  + '  mFocusedApp=AppWindowToken{4c2a1 token=Token{9e1 ActivityRecord{2f3 u0 com.ss.android.ugc.aweme/.detail.ultra.ui.UltraDetailActivity t153}}}';
const focusLauncher = '  mCurrentFocus=Window{1a2b3c u0 com.smartisanos.launcher/com.smartisanos.launcher.Launcher}';
const focusStatusBar = '  mCurrentFocus=Window{a1b2c3 u0 StatusBar}\n  mFocusedApp=AppWindowToken{x token=Token{y ActivityRecord{z u0 com.ss.android.ugc.aweme/.main.MainActivity t153}}}';
const focusNull = '  mCurrentFocus=null\n  mFocusedApp=AppWindowToken{4c2a1 token=Token{9e1 ActivityRecord{2f3 u0 com.smartisanos.launcher/.Launcher t1}}}';
const resumedDouyin = '    mResumedActivity: ActivityRecord{2f3 u0 com.ss.android.ugc.aweme/.main.MainActivity t153}';
const policyLocked = 'WINDOW MANAGER POLICY STATE (dumpsys window policy)\n    mKeyguardDelegate=...\n    showing=true\n    showingAndNotOccluded=true\n    mShowingDream=false';
const policyUnlocked = '    showing=false\n    showingAndNotOccluded=false\n    mShowingDream=false';

test('foreground dumps identify the focused activity, a covering system window and the resumed fallback', () => {
  assert.deepEqual(parseWindowFocus(focusDouyin), {package: 'com.ss.android.ugc.aweme', activity: 'com.ss.android.ugc.aweme.detail.ultra.ui.UltraDetailActivity', source: 'window_focus'});
  assert.equal(parseWindowFocus(focusLauncher).package, 'com.smartisanos.launcher');
  assert.deepEqual(parseWindowFocus(focusStatusBar), {package: null, activity: null, focus: 'StatusBar', source: 'window_focus'});
  assert.deepEqual(parseWindowFocus(focusNull), {package: 'com.smartisanos.launcher', activity: '.Launcher', source: 'focused_app'});
  assert.equal(parseWindowFocus(''), null);
  assert.deepEqual(parseResumedActivity(resumedDouyin), {package: 'com.ss.android.ugc.aweme', activity: '.main.MainActivity', source: 'resumed_activity'});
  assert.equal(parseKeyguard(policyLocked), true);
  assert.equal(parseKeyguard(policyUnlocked), false);
  assert.equal(parseKeyguard('mShowingDream=false'), null, 'an unknown format is unknown, not unlocked');
  assert.equal(parseWakefulness('  mWakefulness=Asleep'), 'Asleep');
  assert.equal(parseWakefulness(''), null);
});

function fakeAdb(state) {
  const launches = [];
  return {launches, adb: {
    powerState: async () => state.power ?? 'mWakefulness=Awake',
    keyguardState: async () => state.policy ?? policyUnlocked,
    windowFocus: async () => state.focus,
    resumedActivity: async () => state.resumed ?? '',
    launchActivity: async (target, component) => { launches.push({target, component}); state.focus = state.afterLaunch ?? focusDouyin; },
    inspect: async () => ({model: 'DE106', apiLevel: 27}),
    inspectApp: async () => ({appVersion: state.version ?? '40.6.0'}),
  }};
}

test('Douyin in front needs no launch; another app is relaunched once through the reviewed component and re-verified', async () => {
  let clock = 0;
  const state = {focus: focusDouyin};
  const {adb, launches} = fakeAdb(state);
  const guard = createForegroundGuard({adb, serial, now: () => clock, wait: async () => { clock += 1000; }});
  assert.deepEqual(await guard.ensure(), {package: 'com.ss.android.ugc.aweme', activity: 'com.ss.android.ugc.aweme.detail.ultra.ui.UltraDetailActivity', source: 'window_focus', launched: false});
  assert.equal(launches.length, 0);
  state.focus = focusLauncher;
  const launched = await guard.ensure();
  assert.equal(launched.launched, true);
  assert.equal(launched.package, 'com.ss.android.ugc.aweme');
  assert.deepEqual(launches, [{target: serial, component: DOUYIN_LAUNCH_COMPONENT}]);
  // Measured launcher on DE106 / Douyin 40.6.0; it also hosts the home feed.
  assert.equal(DOUYIN_LAUNCH_COMPONENT, 'com.ss.android.ugc.aweme/.splash.SplashActivity');
  state.focus = focusLauncher;
  await assert.rejects(guard.ensure(), {code: 'douyin_not_foreground', launched: false, focus: 'com.smartisanos.launcher'});
  assert.equal(launches.length, 1, 'relaunches are rate limited');
  clock += 60_000;
  state.afterLaunch = focusLauncher;
  await assert.rejects(guard.ensure(), {code: 'douyin_not_foreground', launched: true});
  assert.equal(launches.length, 2);
});

test('a relaunch re-checks the Douyin version, and a locked or sleeping phone is never launched into', async () => {
  const mismatch = {focus: focusLauncher, version: '41.0.0'};
  const {adb, launches} = fakeAdb(mismatch);
  await assert.rejects(createForegroundGuard({adb, serial, wait: async () => {}}).ensure(), {code: 'profile_version_mismatch'});
  assert.equal(launches.length, 1);
  const locked = fakeAdb({focus: focusStatusBar, policy: policyLocked});
  await assert.rejects(createForegroundGuard({adb: locked.adb, serial}).ensure(), {code: 'device_locked'});
  const asleep = fakeAdb({focus: focusLauncher, power: 'mWakefulness=Asleep'});
  await assert.rejects(createForegroundGuard({adb: asleep.adb, serial}).ensure(), {code: 'device_asleep'});
  const covered = fakeAdb({focus: focusStatusBar});
  await assert.rejects(createForegroundGuard({adb: covered.adb, serial}).ensure({launch: false}), {code: 'douyin_not_foreground', focus: 'StatusBar'});
  assert.equal(locked.launches.length + asleep.launches.length + covered.launches.length, 0);
});

test('the ADB launch is a plain MAIN/LAUNCHER start pinned to the serial with no reset or clearing flags', async () => {
  const calls = [];
  const adb = createAdbClient({command: async (file, args) => { calls.push(args); return {stdout: 'Starting: Intent { cmp=... }', stderr: ''}; }});
  await adb.launchActivity(serial, DOUYIN_LAUNCH_COMPONENT);
  assert.deepEqual(calls.at(-1), ['-H', '127.0.0.1', '-P', '5037', '-s', serial, 'shell', 'am', 'start', '-a', 'android.intent.action.MAIN',
    '-c', 'android.intent.category.LAUNCHER', '-n', DOUYIN_LAUNCH_COMPONENT]);
  await assert.rejects(adb.launchActivity(serial, 'com.ss.android.ugc.aweme/.main.MainActivity -S'), {code: 'invalid_component'});
  await assert.rejects(adb.launchActivity(serial, 'pm clear com.ss.android.ugc.aweme'), {code: 'invalid_component'});
  const failing = createAdbClient({command: async () => ({stdout: 'Error: Activity class {x} does not exist.', stderr: ''})});
  await assert.rejects(failing.launchActivity(serial, DOUYIN_LAUNCH_COMPONENT), {code: 'app_launch_failed'});
  await adb.windowFocus(serial); await adb.keyguardState(serial); await adb.powerState(serial); await adb.resumedActivity(serial);
  for (const args of calls.slice(1)) {
    assert.deepEqual(args.slice(0, 7), ['-H', '127.0.0.1', '-P', '5037', '-s', serial, 'shell']);
    assert.match(args[7], /^dumpsys (?:window|activity|power)\b/u);
  }
});

test('the profile probe reports precise readiness reasons and never advertises a stale ready state', async () => {
  const state = {focus: focusLauncher};
  const {adb, launches} = fakeAdb({...state});
  const guardState = {focus: focusLauncher};
  const guarded = fakeAdb(guardState);
  const adbClient = {...adb, ...guarded.adb, listDevices: async () => [{serial, state: 'device'}]};
  let appiumReady = true;
  const client = {status: async () => ({ready: appiumReady})};
  const adapter = createProfileAdapter({serial, adb: adbClient, profileId: 'douyin-40.6.0-de106-api27-p0', client,
    foreground: createForegroundGuard({adb: adbClient, serial, wait: async () => {}})});
  const first = await adapter.probe();
  assert.equal(first.readyForSearch, true);
  assert.deepEqual(first.foreground, {package: 'com.ss.android.ugc.aweme', activity: 'com.ss.android.ugc.aweme.detail.ultra.ui.UltraDetailActivity', launched: true});
  assert.equal(guarded.launches.length, 1);
  appiumReady = false;
  assert.deepEqual(await adapter.probe(), {readyForSearch: false, reason: 'appium_not_ready'});
  appiumReady = true;
  guardState.policy = policyLocked;
  assert.deepEqual(await adapter.probe(), {readyForSearch: false, reason: 'device_locked'});
  guardState.policy = policyUnlocked; guardState.focus = focusStatusBar;
  assert.deepEqual(await adapter.probe(), {readyForSearch: false, reason: 'douyin_not_foreground', focus: 'StatusBar'});
  assert.equal(launches.length, 0);
});
