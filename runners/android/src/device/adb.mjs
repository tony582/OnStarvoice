import { DeviceError, bounded } from './bounded.mjs';
import { runDeviceCommand } from './command.mjs';

export function validateSerial(serial) {
  if (typeof serial !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(serial)) {
    throw new DeviceError('serial_required', 'Select the exact device serial; automatic device selection is disabled');
  }
  return serial;
}

export function parseAdbDevices(stdout) {
  const devices = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.trim() || /^(List of devices|\*|adb server)/.test(line)) continue;
    const match = line.match(/^(\S+)\s+(device|offline|unauthorized|recovery|sideload|bootloader|no permissions)(?:\s|$)(.*)/);
    if (!match) continue;
    const [, serial, state, metadata] = match;
    const attributes = Object.fromEntries([...metadata.matchAll(/(\w+):([^\s]+)/g)]
      .map((entry) => [entry[1], entry[2]]));
    devices.push({ serial, state, model: attributes.model ?? null, transportId: attributes.transport_id ?? null });
  }
  return devices;
}

export function selectDevice(devices, serial) {
  validateSerial(serial);
  const matches = devices.filter((device) => device.serial === serial);
  if (matches.length !== 1) throw new DeviceError(matches.length ? 'ambiguous_device' : 'device_missing',
    matches.length ? 'Device serial is not unique' : 'The selected device is not connected');
  const device = matches[0];
  if (device.state !== 'device') {
    throw new DeviceError(`device_${device.state.replaceAll(' ', '_')}`, 'The selected device is not authorized and online');
  }
  return device;
}

export function createAdbClient({ adbPath = 'adb', command = runDeviceCommand, timeoutMs = 5000 } = {}) {
  const call = (args, options = {}) => bounded((signal) => command(adbPath,
    ['-H', '127.0.0.1', '-P', '5037', ...args], { signal, timeoutMs }), { timeoutMs, ...options });
  const listDevices = async (options = {}) => parseAdbDevices((await call(['devices', '-l'], options)).stdout);
  // Ensure the local adb server is up. This never selects, connects to or opens a device.
  const startServer = async (options = {}) => { await call(['start-server'], options); return {started: true}; };
  const inspect = async (serial, options = {}) => {
    validateSerial(serial);
    const device = selectDevice(await listDevices(options), serial);
    const values = {};
    // Every device-scoped command explicitly pins the chosen serial.
    for (const [key, property] of Object.entries({ model: 'ro.product.model', androidVersion: 'ro.build.version.release', apiLevel: 'ro.build.version.sdk' })) {
      values[key] = (await call(['-s', serial, 'shell', 'getprop', property], options)).stdout.trim().slice(0, 120);
    }
    // Detect a disconnect during inspection instead of preserving a stale online state.
    selectDevice(await listDevices(options), serial);
    return { ...device, ...values, connected: true };
  };
  const inspectApp = async (serial, options = {}) => {
    validateSerial(serial);
    const value = await call(['-s', serial, 'shell', 'dumpsys', 'package', 'com.ss.android.ugc.aweme'], options);
    const versions = [...new Set([...value.stdout.matchAll(/versionName=([^\s]+)/g)].map(match => match[1]))];
    if (versions.length !== 1) throw new DeviceError('app_version_unknown', 'Installed Douyin version is ambiguous');
    return {appVersion:versions[0]};
  };
  const helperPids = async (serial, options = {}) => {
    validateSerial(serial);
    const value = await call(['-s', serial, 'shell', 'ps', '-A'], options);
    return value.stdout.split(/\r?\n/).filter(line => /\sio\.appium\.uiautomator2\.server$/.test(line.trim()))
      .map(line => line.trim().split(/\s+/)[1]);
  };
  const stopHelper = (serial, options = {}) => {
    validateSerial(serial);
    return call(['-s', serial, 'shell', 'am', 'force-stop', 'io.appium.uiautomator2.server'], options);
  };
  // Read-only foreground and lock probes. Large dumps are filtered on the device so output stays bounded;
  // `|| true` keeps an empty grep from failing the command.
  const dump = (serial, script, options) => { validateSerial(serial); return call(['-s', serial, 'shell', script], options).then(value => value.stdout); };
  const windowFocus = (serial, options = {}) => dump(serial, 'dumpsys window windows | grep -E "mCurrentFocus|mFocusedApp" || true', options);
  const resumedActivity = (serial, options = {}) => dump(serial, 'dumpsys activity activities | grep -E "mResumedActivity|mFocusedActivity" || true', options);
  const keyguardState = (serial, options = {}) => dump(serial, 'dumpsys window policy', options);
  const powerState = (serial, options = {}) => dump(serial, 'dumpsys power | grep -E "mWakefulness=" || true', options);
  // Plain MAIN/LAUNCHER start of an explicit component: no --stop, no reset, no data clearing.
  const launchActivity = async (serial, component, options = {}) => {
    validateSerial(serial);
    if (typeof component !== 'string' || !/^[a-z]\w*(?:\.\w+)+\/\.?[\w.$]+$/u.test(component)) {
      throw new DeviceError('invalid_component', 'An explicit package/activity component is required');
    }
    const result = await call(['-s', serial, 'shell', 'am', 'start', '-a', 'android.intent.action.MAIN',
      '-c', 'android.intent.category.LAUNCHER', '-n', component], options);
    if (/Error/u.test(`${result.stdout}\n${result.stderr}`)) throw new DeviceError('app_launch_failed', 'The app could not be launched');
    return {launched: true};
  };
  // Developer option "stay awake while charging" (0 = off). Read-only; the runner never changes it.
  const stayOnWhilePluggedIn = async (serial, options = {}) => {
    const value = (await dump(serial, 'settings get global stay_on_while_plugged_in', options)).trim();
    return /^\d+$/u.test(value) ? Number(value) : null;
  };
  // Automation-related log lines only (helper crash, low-memory kill), for a local diagnostic after a lost session.
  const automationLog = async (serial, options = {}) => (await dump(serial,
    'logcat -d -t 4000 | grep -E "uiautomator2|UiAutomation|lowmemorykiller|am_kill|FATAL EXCEPTION|Process io\\.appium" | tail -n 30 || true',
    options)).split(/\r?\n/u).map(line => line.trim().slice(0, 240)).filter(Boolean).slice(-30);
  return {listDevices, startServer, inspect, inspectApp, helperPids, stopHelper, windowFocus, resumedActivity, keyguardState,
    powerState, launchActivity, stayOnWhilePluggedIn, automationLog};
}
