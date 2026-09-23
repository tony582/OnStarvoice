import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAdbClient, createAppiumClient, createAndroidDeviceAdapter,
  parseAdbDevices, selectDevice, validateAppiumUrl, runDoctor,
} from '../src/device/index.mjs';
import { runDeviceCommand } from '../src/device/command.mjs';

const listing = 'List of devices attached\nONE device usb:1-1 model:Pixel_7 transport_id:1\nTWO unauthorized usb:2\nTHREE offline\n';
const response = (value, status = 200) => new Response(JSON.stringify({ value }), { status });
const inventory = { stdout: JSON.stringify({ uiautomator2: { version: '6.0.0', installed: true } }) };
function fakeCommand(calls = []) {
  return async (file, args) => {
    calls.push({ file, args });
    if (args.includes('devices')) return { stdout: listing };
    if (args.includes('getprop')) return { stdout: args.at(-1) === 'ro.build.version.sdk' ? '34\n' : 'test\n' };
    if (args.includes('driver')) return inventory;
    throw new Error('unexpected test command');
  };
}

test('ADB inventory preserves unauthorized/offline states and never silently selects first device', () => {
  const devices = parseAdbDevices(listing);
  assert.equal(devices.length, 3);
  assert.equal(devices[0].model, 'Pixel_7');
  assert.throws(() => selectDevice(devices), { code: 'serial_required' });
  assert.throws(() => selectDevice(devices, 'MISSING'), { code: 'device_missing' });
  assert.throws(() => selectDevice(devices, 'TWO'), { code: 'device_unauthorized' });
  assert.throws(() => selectDevice(devices, 'THREE'), { code: 'device_offline' });
  assert.throws(() => selectDevice([...devices, devices[0]], 'ONE'), { code: 'ambiguous_device' });
});

test('all ADB probes use loopback server and each property command pins exact serial', async () => {
  const calls = [];
  const adb = createAdbClient({ command: fakeCommand(calls) });
  const result = await adb.inspect('ONE');
  assert.equal(result.connected, true);
  assert.equal(result.apiLevel, '34');
  for (const call of calls) assert.deepEqual(call.args.slice(0, 4), ['-H', '127.0.0.1', '-P', '5037']);
  assert.equal(calls.filter((call) => call.args.includes('getprop')).length, 3);
  for (const call of calls.filter((call) => call.args.includes('shell'))) assert.deepEqual(call.args.slice(4, 6), ['-s', 'ONE']);
  await assert.rejects(adb.inspect('ONE; bad'), { code: 'serial_required' });
});

test('disconnect after properties invalidates the original online state', async () => {
  let enumeration = 0;
  const adb = createAdbClient({ command: async (_file, args) => ({
    stdout: args.includes('devices') ? (++enumeration === 1 ? listing : 'List of devices attached\n') : '34',
  }) });
  await assert.rejects(adb.inspect('ONE'), { code: 'device_missing' });
});

test('Appium is strictly local and cannot follow redirect or inject session paths', async () => {
  for (const url of ['http://example.com:4723', 'http://127.0.0.1@evil.test', 'http://127.0.0.1:4723?token=abc']) {
    assert.throws(() => validateAppiumUrl(url), { code: 'invalid_appium_url' });
  }
  const calls = [];
  const client = createAppiumClient({ appiumUrl: 'http://localhost:4723/wd/hub/', fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return response({ ready: true });
  } });
  assert.equal((await client.status()).ready, true);
  assert.equal(calls[0].url, 'http://127.0.0.1:4723/wd/hub/status');
  assert.equal(calls[0].options.redirect, 'error');
  await assert.rejects(client.getClipboard('../bad'), { code: 'invalid_session' });
  assert.throws(() => client.createSession(), { code: 'profile_required' });
});

test('clipboard transport follows UiAutomator2 base64 commands without logging plaintext', async () => {
  const calls = [];
  const client = createAppiumClient({ fetchImpl: async (_url, options) => {
    const data = JSON.parse(options.body);
    calls.push(data);
    return response(data.script.includes('getClipboard') ? Buffer.from('分享中文').toString('base64') : null);
  } });
  await client.setClipboard('session-1', '测试标记');
  assert.deepEqual(calls[0], { script: 'mobile: setClipboard', args: [{ content: Buffer.from('测试标记').toString('base64'), contentType: 'plaintext' }] });
  assert.equal(await client.getClipboard('session-1'), '分享中文');
  const broken = createAppiumClient({ fetchImpl: async () => response('not base64!!') });
  await assert.rejects(broken.getClipboard('session-1'), { code: 'invalid_clipboard' });
});

test('device transport returns bounded timeout even when injected fetch ignores abort', async () => {
  const client = createAppiumClient({ timeoutMs: 15, fetchImpl: async () => new Promise(() => {}) });
  await assert.rejects(client.status(), { code: 'device_timeout', stopConfirmationRequired: true });
});

test('HTTP and malformed/oversized protocol responses fail without leaking payloads', async () => {
  const denied = createAppiumClient({ fetchImpl: async () => response({ message: 'private-fixture' }, 503) });
  await assert.rejects(denied.status(), { code: 'appium_http_error' });
  const malformed = createAppiumClient({ fetchImpl: async () => new Response('private-fixture') });
  await assert.rejects(malformed.status(), { code: 'invalid_appium_response' });
  const oversized = createAppiumClient({ fetchImpl: async () => response('x'.repeat(128 * 1024)) });
  await assert.rejects(oversized.status(), { code: 'appium_response_too_large' });
});

test('abort prevents new actions and interrupts pending I/O', async () => {
  let count = 0;
  const controller = new AbortController();
  controller.abort();
  const client = createAppiumClient({ fetchImpl: async () => { count++; return response({ ready: true }); } });
  await assert.rejects(client.status({ signal: controller.signal }), { code: 'aborted' });
  assert.equal(count, 0);
  const pending = new AbortController();
  const slow = createAdbClient({ command: async () => { count++; return new Promise(() => {}); } });
  const operation = slow.listDevices({ signal: pending.signal });
  pending.abort();
  await assert.rejects(operation, { code: 'aborted' });
  assert.equal(count, 0);
});

test('subprocess errors are structured and do not return raw command output', async () => {
  await assert.rejects(runDeviceCommand('/missing/starvoice-device-tool', []), { code: 'executable_missing' });
  await assert.rejects(runDeviceCommand(process.execPath, ['-e', 'process.stderr.write("secret-fixture");process.exit(1)']), (error) => {
    assert.equal(error.code, 'command_failed');
    assert.ok(!error.message.includes('secret-fixture'));
    return true;
  });
});

test('doctor reports missing executable and serial without claiming operational readiness', async () => {
  const result = await runDoctor({ command: async () => { throw Object.assign(new Error('private detail'), { code: 'executable_missing' }); },
    fetchImpl: async () => { throw new Error('private detail'); } });
  assert.equal(result.readyForP0, false);
  assert.equal(result.readyForSearch, false);
  assert.ok(result.blockers.some((item) => item.code === 'serial_required'));
  assert.ok(result.blockers.some((item) => item.code === 'executable_missing'));
  assert.ok(!JSON.stringify(result).includes('private detail'));
});

test('doctor passes connection inventory while retaining all unverified search prerequisites', async () => {
  const calls = [];
  const result = await runDoctor({ serial: 'ONE', appiumCliPath: '/explicit/appium/main.js',
    command: fakeCommand(calls), fetchImpl: async () => response({ ready: true, build: { version: '3.0.0' } }) });
  assert.equal(result.readyForP0, true);
  assert.equal(result.readyForSearch, false);
  assert.equal(result.device.serial, 'ONE');
  assert.ok(result.pendingValidation.includes('profile_required'));
  assert.ok(calls.some((call) => call.file === process.execPath && call.args[0] === '/explicit/appium/main.js'));
  assert.ok(calls.every((call) => !call.args.includes('install')));
});

test('doctor does not substitute another device for an unauthorized selected phone', async () => {
  const result = await runDoctor({ serial: 'TWO', command: fakeCommand(), fetchImpl: async () => response({ ready: true }) });
  assert.equal(result.readyForP0, false);
  assert.ok(result.blockers.some((item) => item.code === 'device_unauthorized'));
  assert.equal(result.device, null);
});

test('real device bridge explicitly blocks search until profile calibration', async () => {
  const adapter = createAndroidDeviceAdapter({ serial: 'ONE', adb: { inspect: async () => ({ serial: 'ONE', connected: true }) } });
  const status = await adapter.inspect();
  assert.equal(status.readyForSearch, false);
  assert.equal(status.loggedIn, null);
  assert.equal(status.unlocked, null);
  for (const name of ['search', 'readCards', 'openCard', 'copyLink', 'returnToResults', 'scroll', 'readSource']) {
    await assert.rejects(adapter[name]({}), { code: 'profile_required' });
  }
});
