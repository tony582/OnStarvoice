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
  return {listDevices, inspect, inspectApp, helperPids, stopHelper};
}
