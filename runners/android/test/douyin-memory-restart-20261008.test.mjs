// 2026-10-08: Douyin had run for eight days on the DE106, grown to 2.7 GB resident with 1.5 GB more in swap, and the
// swap partition was full. Screen reads took 3–11 s, any read over the 10 s bound ended the keyword as device_timeout,
// and two rounds lost 19 keyword attempts to it. Stopping and starting Douyin brought reads back to 1–2 s at once.
// The Runner now reads /proc/meminfo in the idle probe and restarts Douyin under memory pressure, rate limited.
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {parseMemInfo, memoryPressure, describeMemory, MEMORY_RESTART_THRESHOLDS} from '../src/device/douyin-memory.mjs';
import {createForegroundGuard, DOUYIN_LAUNCH_COMPONENT} from '../src/device/douyin-foreground.mjs';
import {createProfileAdapter} from '../src/device/profile-adapter.mjs';
import {parseUiTree} from '../src/device/ui-tree.mjs';
import {resource, DOUYIN_P0_PROFILE} from '../src/device/douyin-profile.mjs';
import {createAdbClient} from '../src/device/adb.mjs';
import {AndroidDaemon} from '../src/daemon/runtime.mjs';
import {stateValue} from '../src/daemon/state.mjs';
import {diagnoseRunner} from '../src/daemon/diagnose.mjs';
import {readDiagnostics} from '../src/core/diagnostics.mjs';
import {RunnerStore} from '../src/storage/runner-store.mjs';
import {createSimulationDevice} from '../src/daemon/simulation.mjs';
import {describeMemoryRestart} from '../src/cli/up-command.mjs';
import {mockControlPlane, until} from './daemon-fixture.mjs';

// The phone as measured on 2026-10-08 22:46 (bad) and 22:48 right after the restart (good).
const STARVED = 'MemTotal:        7837720 kB\nMemFree:          252796 kB\nMemAvailable:    1494020 kB\nBuffers:          191736 kB\n'
  + 'SwapTotal:       2621436 kB\nSwapFree:              4 kB\n';
const RELIEVED = 'MemTotal:        7837720 kB\nMemAvailable:    4346588 kB\nSwapTotal:       2621436 kB\nSwapFree:        1536416 kB\n';

test('the meminfo fields are read in kB and a missing field is null, not zero', () => {
  assert.deepEqual(parseMemInfo(STARVED), {memTotalKb: 7837720, memAvailableKb: 1494020, swapTotalKb: 2621436, swapFreeKb: 4});
  assert.deepEqual(parseMemInfo('MemTotal: 1000 kB\nMemAvailable: 500 kB\n'), {memTotalKb: 1000, memAvailableKb: 500, swapTotalKb: null, swapFreeKb: null});
  assert.deepEqual(parseMemInfo(''), {memTotalKb: null, memAvailableKb: null, swapTotalKb: null, swapFreeKb: null});
});

test('a full swap partition or less than 1 GB available is pressure; a phone without swap is judged by MemAvailable alone', () => {
  assert.deepEqual(MEMORY_RESTART_THRESHOLDS, {memAvailableKb: 1_048_576, swapFreeRatio: 0.1});
  assert.deepEqual(memoryPressure(parseMemInfo(STARVED)), {starved: true, reasons: ['swap_exhausted']});
  assert.deepEqual(memoryPressure(parseMemInfo(RELIEVED)), {starved: false, reasons: []});
  assert.deepEqual(memoryPressure({memAvailableKb: 900_000, swapTotalKb: 0, swapFreeKb: 0}), {starved: true, reasons: ['mem_available_low']});
  assert.deepEqual(memoryPressure({memAvailableKb: 900_000, swapTotalKb: 2_621_436, swapFreeKb: 100}), {starved: true, reasons: ['mem_available_low', 'swap_exhausted']});
  assert.deepEqual(memoryPressure({memAvailableKb: null, swapTotalKb: null, swapFreeKb: null}), {starved: false, reasons: []}, 'unknown fields never restart');
  assert.deepEqual(memoryPressure({memAvailableKb: 3_000_000, swapTotalKb: 2_621_436, swapFreeKb: 262_144}), {starved: false, reasons: []}, 'exactly 10% free is not exhausted');
  assert.equal(describeMemory(parseMemInfo(STARVED)), '可用 1.4 GB · 交换区剩 0 MB / 2.5 GB');
  assert.equal(describeMemory({memAvailableKb: 900_000, swapTotalKb: 0}), '可用 0.9 GB');
  assert.equal(describeMemory({}), '内存读数未知');
});

test('the adb client reads /proc/meminfo and force-stops only Douyin, pinned to the serial', async () => {
  const calls = [];
  const adb = createAdbClient({adbPath: 'adb', command: async (file, args) => { calls.push(args.slice(4));
    return {stdout: args.some(arg => arg.includes('/proc/meminfo')) ? STARVED : '', stderr: ''}; }});
  assert.deepEqual(await adb.memInfo('829d89'), {memTotalKb: 7837720, memAvailableKb: 1494020, swapTotalKb: 2621436, swapFreeKb: 4});
  await adb.stopDouyin('829d89');
  assert.deepEqual(calls, [['-s', '829d89', 'shell', 'cat /proc/meminfo'], ['-s', '829d89', 'shell', 'am', 'force-stop', 'com.ss.android.ugc.aweme']]);
  assert.throws(() => adb.stopDouyin(''), {code: 'serial_required'});
});

const serial = '829d89';
const DOUYIN_FOCUS = '  mCurrentFocus=Window{7918cc1 u0 com.ss.android.ugc.aweme/com.ss.android.ugc.aweme.splash.SplashActivity}';
const LAUNCHER_FOCUS = '  mCurrentFocus=Window{9 u0 com.smartisanos.launcher/com.smartisanos.launcher.Launcher}';

function fakeAdb(state) {
  const calls = [];
  return {calls, adb: {
    powerState: async () => state.power ?? 'mWakefulness=Awake',
    keyguardState: async () => state.locked ? 'showing=true' : 'showing=false',
    windowFocus: async () => state.focus, resumedActivity: async () => '',
    inspect: async () => ({model: 'DE106', apiLevel: 27}), inspectApp: async () => ({appVersion: '40.6.0'}),
    memInfo: async () => parseMemInfo(state.meminfo),
    stopDouyin: async target => { calls.push(['stop', target]); state.focus = LAUNCHER_FOCUS; },
    launchActivity: async (target, component) => { calls.push(['launch', target, component]); state.focus = state.afterLaunch ?? DOUYIN_FOCUS; },
  }};
}

test('under pressure the guard stops Douyin once, starts it through the reviewed launcher and counts a launch', async () => {
  let clock = 0;
  const state = {focus: DOUYIN_FOCUS, meminfo: STARVED};
  const {adb, calls} = fakeAdb(state);
  const guard = createForegroundGuard({adb, serial, now: () => clock, wait: async () => { clock += 1000; }});
  const relief = await guard.relieveMemory();
  assert.equal(relief.restarted, true);
  assert.deepEqual(relief.reasons, ['swap_exhausted']);
  assert.equal(relief.reading.swapFreeKb, 4);
  assert.deepEqual(relief.foreground, {package: 'com.ss.android.ugc.aweme', activity: 'com.ss.android.ugc.aweme.splash.SplashActivity'});
  assert.deepEqual(calls, [['stop', serial], ['launch', serial, DOUYIN_LAUNCH_COMPONENT]]);
  assert.equal(guard.launches, 1, 'the restart is a launch: the next keyword proves login again');
  assert.deepEqual(await guard.ensure(), {package: 'com.ss.android.ugc.aweme', activity: 'com.ss.android.ugc.aweme.splash.SplashActivity', source: 'window_focus', launched: false});
  // Still starved right away (another app, or a reading before swap is released): reported, not restarted again.
  const again = await guard.relieveMemory();
  assert.deepEqual([again.starved, again.restarted, again.skipped], [true, false, 'recently_restarted']);
  assert.equal(calls.length, 2);
  clock += 30 * 60_000;
  assert.equal((await guard.relieveMemory()).restarted, true, 'after the interval a restart is allowed again');
  assert.equal(calls.length, 4);
  state.meminfo = RELIEVED;
  clock += 30 * 60_000;
  assert.deepEqual(await guard.relieveMemory(), {reading: parseMemInfo(RELIEVED), starved: false, reasons: [], restarted: false});
  assert.equal(calls.length, 4);
});

test('a locked or sleeping phone is never restarted into, and an adb client without the reader never restarts', async () => {
  const locked = fakeAdb({focus: DOUYIN_FOCUS, meminfo: STARVED, locked: true});
  await assert.rejects(createForegroundGuard({adb: locked.adb, serial}).relieveMemory(), {code: 'device_locked'});
  const asleep = fakeAdb({focus: DOUYIN_FOCUS, meminfo: STARVED, power: 'mWakefulness=Asleep'});
  await assert.rejects(createForegroundGuard({adb: asleep.adb, serial}).relieveMemory(), {code: 'device_asleep'});
  assert.equal(locked.calls.length + asleep.calls.length, 0);
  const {adb} = fakeAdb({focus: DOUYIN_FOCUS, meminfo: STARVED});
  delete adb.memInfo;
  assert.deepEqual(await createForegroundGuard({adb, serial}).relieveMemory(), {reading: null, starved: false, reasons: [], restarted: false});
});

test('a restart whose launch does not bring Douyin back fails like a relaunch and is not retried on the next poll', async () => {
  let clock = 0;
  const state = {focus: DOUYIN_FOCUS, meminfo: STARVED, afterLaunch: LAUNCHER_FOCUS};
  const {adb, calls} = fakeAdb(state);
  const guard = createForegroundGuard({adb, serial, waitMs: 2000, now: () => clock, wait: async () => { clock += 1000; }});
  await assert.rejects(guard.relieveMemory(), {code: 'douyin_not_foreground', launched: true});
  assert.deepEqual(calls.map(call => call[0]), ['stop', 'launch']);
  clock += 5000;
  assert.equal((await guard.relieveMemory()).skipped, 'recently_restarted');
  assert.equal(calls.length, 2);
});

// ---- The probe in the profile adapter: restart, then the next task proves login on 我 again ----

const encode = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const node = (id, text = '', extra = {}) => `<android.widget.TextView ${Object.entries({
  package: 'com.ss.android.ugc.aweme', class: 'android.widget.TextView', 'resource-id': resource(id),
  text, displayed: 'true', enabled: 'true', bounds: '[0,0][100,100]', ...extra,
}).map(([key, value]) => `${key}="${encode(value)}"`).join(' ')}></android.widget.TextView>`;
const tabs = selected => node('0p3', '', {'content-desc': '首页，按钮', selected: String(selected === 'home')})
  + node('0p3', '', {'content-desc': '我，按钮', selected: String(selected === 'me')});
const PAGES = {
  home: `<hierarchy>${node('hmy', '', {'content-desc': '搜索'})}${tabs('home')}</hierarchy>`,
  me: `<hierarchy>${node('504', '抖音号：starvoice')}${node('whh', '编辑主页')}${tabs('me')}</hierarchy>`,
};

function phone() {
  const state = {page: 'home', focus: DOUYIN_FOCUS, meminfo: RELIEVED, clock: 1_000_000};
  const taps = [], calls = [];
  let lastSelector = null, sessions = 0;
  const adb = {
    inspect: async () => ({model: 'DE106', apiLevel: '27'}), inspectApp: async () => ({appVersion: DOUYIN_P0_PROFILE.version}),
    listDevices: async () => [{serial, state: 'device'}], helperPids: async () => [], stopHelper: async () => null,
    powerState: async () => 'mWakefulness=Awake', keyguardState: async () => (state.locked ? 'showing=true' : 'showing=false'),
    windowFocus: async () => state.focus, resumedActivity: async () => '',
    memInfo: async () => parseMemInfo(state.meminfo),
    stopDouyin: async () => { calls.push('stop'); state.focus = LAUNCHER_FOCUS; state.page = 'home'; },
    launchActivity: async () => { calls.push('launch'); state.focus = DOUYIN_FOCUS; state.page = 'home'; return {launched: true}; },
    swipeUp: async () => assert.fail('the feed reads quickly here'),
  };
  const client = {
    status: async () => ({ready: true}),
    createProfileSession: async () => ({sessionId: `session-${++sessions}`}),
    isLocked: async () => false, settings: async () => ({wakeLockTimeout: 0, enableTopmostWindowFromActivePackage: false}),
    source: async () => PAGES[state.page],
    findElements: async (id, using, value) => { lastSelector = value; return [{'element-6066-11e4-a52e-4f735466cecf': 'element-1'}]; },
    clickElement: async () => {
      if (lastSelector.includes('我，按钮')) { taps.push('me'); state.page = 'me'; }
      else if (lastSelector.includes('首页，按钮')) { taps.push('home'); state.page = 'home'; }
      else assert.fail(`unexpected tap ${lastSelector}`);
    },
    back: async () => { state.page = 'home'; },
    deleteSession: async () => null, isSessionActive: async () => false,
  };
  const foreground = createForegroundGuard({adb, serial, pollMs: 1, now: () => state.clock, wait: async () => { state.clock += 1000; }});
  const adapter = createProfileAdapter({serial, profileId: DOUYIN_P0_PROFILE.id, adb, client, foreground});
  const task = async () => { taps.length = 0; try { return await adapter.inspect({}); } finally { await adapter.close(); } };
  return {state, taps, calls, adapter, foreground, task};
}

test('an idle probe under memory pressure restarts Douyin, reports it, and the next task proves login on 我 again', async () => {
  const {state, taps, calls, adapter, foreground, task} = phone();
  assert.equal((await task()).loginCheck, 'own_profile');
  const quiet = await adapter.probe({});
  assert.deepEqual([quiet.readyForSearch, quiet.foreground.launched, quiet.memory.starved, quiet.memory.restarted], [true, false, false, false]);
  assert.equal((await task()).loginCheck, 'retained');
  state.meminfo = STARVED;
  const probe = await adapter.probe({});
  assert.deepEqual([probe.readyForSearch, probe.reason, probe.foreground.launched, probe.foreground.package], [true, null, true, 'com.ss.android.ugc.aweme']);
  assert.deepEqual([probe.memory.restarted, probe.memory.reasons, probe.memory.reading.swapFreeKb], [true, ['swap_exhausted'], 4]);
  assert.deepEqual(calls, ['stop', 'launch']);
  assert.equal(foreground.launches, 1);
  assert.equal((await task()).loginCheck, 'own_profile', 'the restart invalidates the login proof');
  assert.deepEqual(taps, ['me', 'home']);
  assert.equal((await task()).loginCheck, 'retained');
  // A phone that is starved but locked is reported as locked, like any other probe, and nothing is stopped.
  state.clock += 31 * 60_000;
  state.locked = true;
  const locked = await adapter.probe({});
  assert.deepEqual([locked.readyForSearch, locked.reason, locked.memory], [false, 'device_locked', undefined]);
  assert.deepEqual(calls, ['stop', 'launch']);
});

test('the daemon records each restart as a diagnostic, shows the reading in status, and the window prints one line', async t => {
  const f = await mockControlPlane(t);
  const store = new RunnerStore(join(f.directory, 'runner.sqlite'));
  const device = createSimulationDevice(f.config.deviceId);
  let restarted = true;
  device.probe = async () => {
    const memory = restarted ? {reading: parseMemInfo(STARVED), starved: true, reasons: ['swap_exhausted'], restarted: true}
      : {reading: parseMemInfo(RELIEVED), starved: false, reasons: [], restarted: false};
    restarted = false;
    return {readyForSearch: true, reason: null, memory, foreground: {package: 'com.ss.android.ugc.aweme', activity: '.splash.SplashActivity', launched: memory.restarted}};
  };
  const daemon = new AndroidDaemon({stateDir: f.directory, config: f.config, lockRoot: f.lockRoot, pollMs: 5, renewMs: 10, deliveryMs: 5, watchMs: 5, store, device});
  const running = daemon.run();
  t.after(async () => { daemon.requestStop(); await running; store.close(); });
  await until(() => readDiagnostics(store).some(entry => entry.event === 'douyin_restart'));
  await until(() => stateValue(store, 'daemon:status')?.deviceProbe?.memory?.restarted === false);
  const note = readDiagnostics(store).find(entry => entry.event === 'douyin_restart');
  assert.deepEqual([note.reason, note.reasons, note.memAvailableKb, note.swapFreeKb, note.swapTotalKb], ['memory_pressure', ['swap_exhausted'], 1494020, 4, 2621436]);
  assert.equal(readDiagnostics(store).filter(entry => entry.event === 'douyin_restart').length, 1, 'only the restart is noted, not every reading');
  const status = stateValue(store, 'daemon:status');
  assert.deepEqual(status.deviceProbe.memory.reading, parseMemInfo(RELIEVED));
  assert.equal(daemon.lastMemoryRestart.swapFreeKb, 4);
  const report = diagnoseRunner(store, {hours: 1});
  assert.equal(report.summary.douyinRestarts, 1);
  assert.equal(report.problems.filter(entry => entry.event === 'douyin_restart').length, 1);
  // The poll body keeps its contract: the server never receives the memory reading.
  const poll = f.state.calls.find(call => call.path.endsWith('/poll') && call.body.probe);
  assert.deepEqual(Object.keys(poll.body.probe).sort(), ['checkedAt', 'foreground']);
  assert.equal(describeMemoryRestart(daemon.lastMemoryRestart), '【已重启抖音】手机内存不足（可用 1.4 GB · 交换区剩 0 MB / 2.5 GB）· 已强停并重新拉起抖音，下一个关键词会先确认登录');
  assert.equal(describeMemoryRestart(null), null);
  daemon.requestStop(); await running; // Stop inside the test: the fixture's after-hook removes the lock directory.
});
