import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ensureAppium, stopAppium} from '../src/daemon/appium-process.mjs';
import {runUp, describeReadiness} from '../src/cli/up-command.mjs';
import {until} from './daemon-fixture.mjs';

const LAUNCH = {node: 'node', entry: '/tool/main.js', args: ['--port', '4723'], env: {JAVA_HOME: '/j', ANDROID_HOME: '/a', APPIUM_HOME: '/p'}};
const baseConfig = () => ({baseUrl: 'http://127.0.0.1:3999', deviceId: 'PHONE-1', clientUuid: randomUUID(),
  agentId: 'agent-1', agentToken: 'tok-1', tenantId: 'tenant-1', simulation: false,
  deviceProfile: 'douyin-40.6.0-de106-api27-p0', adbPath: '/opt/homebrew/bin/adb', appiumUrl: 'http://127.0.0.1:4723', appiumLaunch: LAUNCH});
const writeConfig = (dir, config) => writeFileSync(join(dir, 'connection.json'), JSON.stringify(config));

// A daemon stub whose run() resolves once requestStop() is called; readiness fields drive the status lines.
function stubDaemon(fields = {}) {
  let done;
  const ref = {ready: false, deviceReason: 'appium_not_ready', blocked: null, ...fields,
    run: () => new Promise(resolve => { done = () => resolve({deviceClosureRequired: fields.closureRequired === true}); }),
    requestStop: () => done?.()};
  return ref;
}

test('ensureAppium spawns node directly (no shell) with the launch env, then waits for /status', async () => {
  let spawned; const child = {killed: false, exitCode: null, once() {}};
  let ready = false;
  const client = {status: async () => ({ready})};
  const result = await ensureAppium({launch: LAUNCH, client, sleep: async () => {}, now: () => 0, timeoutMs: 5, pollMs: 1,
    spawnImpl: (bin, args, opts) => { spawned = {bin, args, opts}; ready = true; return child; }});
  assert.equal(result.started, true);
  assert.equal(result.child, child);
  assert.equal(spawned.bin, process.execPath, 'a bare "node" resolves to the running node binary');
  assert.deepEqual(spawned.args, ['/tool/main.js', '--port', '4723']);
  assert.equal(spawned.opts.shell, false);
  assert.equal(spawned.opts.env.JAVA_HOME, '/j');
  assert.equal(spawned.opts.env.APPIUM_HOME, '/p');
});

test('ensureAppium never spawns when Appium already answers /status', async () => {
  let spawned = false;
  const result = await ensureAppium({launch: LAUNCH, client: {status: async () => ({ready: true})},
    spawnImpl: () => { spawned = true; }});
  assert.equal(result.started, false);
  assert.equal(spawned, false);
});

test('stopAppium escalates SIGTERM to SIGKILL, but sends only SIGTERM when the child exits', async () => {
  const stubborn = []; const stubbornChild = {killed: false, exitCode: null, once() {}, kill(sig) { stubborn.push(sig); }};
  await stopAppium(stubbornChild, {graceMs: 1, sleep: async () => {}});
  assert.deepEqual(stubborn, ['SIGTERM', 'SIGKILL']);
  const graceful = []; const gracefulChild = {killed: false, exitCode: null, once() {},
    kill(sig) { graceful.push(sig); if (sig === 'SIGTERM') this.exitCode = 0; }};
  await stopAppium(gracefulChild, {graceMs: 1, sleep: async () => {}});
  assert.deepEqual(graceful, ['SIGTERM']);
});

test('readiness lines map the probe reason to plain language', () => {
  assert.match(describeReadiness({ready: true}), /已上线，可在调度中心下发任务/u);
  assert.match(describeReadiness({ready: false, deviceReason: 'douyin_not_foreground'}), /抖音未在前台/u);
  assert.match(describeReadiness({ready: false, deviceReason: 'device_asleep'}), /手机息屏/u);
  assert.match(describeReadiness({ready: false, blocked: 'device_closure_required'}), /需人工确认手机停稳/u);
});

test('up ensures adb, starts Appium with the stored descriptor and stops it after shutdown', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'android-up-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  writeConfig(dir, baseConfig());
  const out = []; const child = {tag: 'appium-child'};
  const events = {adb: 0, stopped: null}; let ensured; let daemon;
  const deps = {
    adb: {startServer: async () => { events.adb++; }, listDevices: async () => [{serial: 'PHONE-1', state: 'device'}]},
    ensureAppium: async options => { ensured = options; return {started: true, child}; },
    stopAppium: async c => { events.stopped = c; },
    createDaemon: options => (daemon = stubDaemon({config: options.config})),
    onSignals: () => () => {}, sleep: ms => new Promise(r => setTimeout(r, 1)), watchMs: 1,
  };
  const running = runUp({'state-dir': dir}, {env: {}, stdout: line => out.push(line), deps});
  await until(() => !!daemon && !!ensured);
  daemon.requestStop();
  await running;
  assert.ok(events.adb >= 1, 'adb start-server ran');
  assert.equal(ensured.appiumUrl, 'http://127.0.0.1:4723');
  assert.deepEqual(ensured.launch, LAUNCH);
  assert.equal(events.stopped, child, 'the Appium child is stopped after the daemon');
  assert.ok(out.some(l => l.includes('deviceClosureRequired=false')));
  assert.ok(out.some(l => /等待…|已上线/u.test(l)), 'a readiness line was printed');
});

test('up registers on first use, prompting for cloud URL and code without logging the code', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'android-up-first-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const out = []; const answers = ['', 'SECRET-CODE-123']; let setupArgs; let daemon;
  const deps = {
    adb: {startServer: async () => {}, listDevices: async () => [{serial: 'ONLYPHONE', state: 'device'}]},
    ensureAppium: async () => ({started: false, child: null}),
    stopAppium: async () => {},
    createDaemon: () => (daemon = stubDaemon({ready: true, deviceReason: null})),
    setup: async args => { setupArgs = args; writeConfig(dir, {...baseConfig(), deviceId: 'ONLYPHONE'}); return {ok: true}; },
    prompt: async () => answers.shift(),
    onSignals: () => () => {}, sleep: ms => new Promise(r => setTimeout(r, 1)), watchMs: 1,
  };
  const running = runUp({'state-dir': dir, 'cloud-url': 'http://127.0.0.1:3999'}, {env: {}, stdout: line => out.push(line), deps});
  await until(() => !!daemon);
  daemon.requestStop();
  await running;
  assert.equal(setupArgs.baseUrl, 'http://127.0.0.1:3999', 'a blank answer falls back to --cloud-url');
  assert.equal(setupArgs.code, 'SECRET-CODE-123');
  assert.equal(setupArgs.deviceId, 'ONLYPHONE', 'the single online device is auto-selected');
  assert.equal(setupArgs.deviceProfile, 'douyin-40.6.0-de106-api27-p0');
  assert.ok(out.every(line => !line.includes('SECRET-CODE-123')), 'the activation code is never printed');
});

test('up prints the device list and refuses to guess when adb has no single online device', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'android-up-many-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const out = []; let setupCalled = false;
  const deps = {
    adb: {startServer: async () => {}, listDevices: async () => [{serial: 'A', state: 'device'}, {serial: 'B', state: 'device'}]},
    setup: async () => { setupCalled = true; }, prompt: async () => 'code',
    ensureAppium: async () => ({started: false, child: null}), stopAppium: async () => {},
    createDaemon: () => stubDaemon(), onSignals: () => () => {}, sleep: async () => {},
  };
  await assert.rejects(runUp({'state-dir': dir, 'cloud-url': 'http://127.0.0.1:3999'}, {env: {}, stdout: l => out.push(l), deps}));
  assert.equal(setupCalled, false);
  assert.ok(out.some(l => l.includes('A')) && out.some(l => l.includes('B')), 'both candidate serials are listed');
});
