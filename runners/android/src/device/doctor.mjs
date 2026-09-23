import { DeviceError, bounded } from './bounded.mjs';
import { createAdbClient, selectDevice } from './adb.mjs';
import { createAppiumClient } from './appium.mjs';
import { runDeviceCommand } from './command.mjs';

export function parseDriverInventory(stdout) {
  let inventory;
  try { inventory = JSON.parse(stdout); }
  catch { throw new DeviceError('invalid_driver_inventory', 'Appium driver inventory was not valid JSON'); }
  const driver = inventory?.uiautomator2;
  if (!driver || typeof driver !== 'object' || driver.installed === false || typeof driver.version !== 'string') {
    throw new DeviceError('uiautomator2_missing', 'UiAutomator2 is not listed in the installed Appium drivers');
  }
  return { name: 'uiautomator2', version: driver.version };
}

/** Read-only connection checks. Does not create sessions, install tools, or launch apps.
 * readyForP0 means connection checks passed; it is NOT verified search readiness.
 */
export async function runDoctor({
  serial, adbPath = 'adb', appiumPath = 'appium', appiumCliPath,
  appiumUrl = 'http://127.0.0.1:4723', signal, timeoutMs = 5000,
  command = runDeviceCommand, fetchImpl = globalThis.fetch,
} = {}) {
  const checks = [];
  const blockers = [];
  let device = null;
  let devices = [];
  const probe = async (name, operation) => {
    try {
      const detail = await bounded(operation, { signal, timeoutMs });
      checks.push({ name, ok: true, detail });
      return detail;
    } catch (error) {
      const issue = { name, code: error.code || 'probe_failed', message: error instanceof DeviceError
        ? error.message : 'The connection probe failed' };
      checks.push({ ...issue, ok: false });
      blockers.push(issue);
      return null;
    }
  };
  const adb = createAdbClient({ adbPath, command, timeoutMs });
  await Promise.all([
    (async () => {
      const listed = await probe('adb', (probeSignal) => adb.listDevices({ signal: probeSignal }));
      devices = listed ?? [];
      if (listed) {
        device = await probe('selected_device', async (probeSignal) => {
          selectDevice(devices, serial);
          return adb.inspect(serial, { signal: probeSignal });
        });
      } else if (!serial) {
        blockers.push({ name: 'selected_device', code: 'serial_required', message: 'Select the exact device serial' });
      }
    })(),
    probe('appium_server', async (probeSignal) => {
      const status = await createAppiumClient({ appiumUrl, fetchImpl, timeoutMs }).status({ signal: probeSignal });
      if (status?.ready !== true) throw new DeviceError('appium_not_ready', 'The Appium server does not report ready');
      return { ready: true, version: typeof status.build?.version === 'string' ? status.build.version : null };
    }),
    probe('uiautomator2_inventory', async (probeSignal) => {
      // Explicit JS entry supports Windows without invoking a .cmd through a shell.
      const file = appiumCliPath ? process.execPath : appiumPath;
      const args = [...(appiumCliPath ? [appiumCliPath] : []), 'driver', 'list', '--installed', '--json'];
      const result = await command(file, args, { signal: probeSignal, timeoutMs });
      return parseDriverInventory(result.stdout);
    }),
  ]);
  checks.sort((a, b) => a.name.localeCompare(b.name));
  blockers.sort((a, b) => a.name.localeCompare(b.name));
  return {
    scope: 'connection_and_driver_inventory', readyForP0: blockers.length === 0,
    readyForSearch: false, device, devices, checks, blockers,
    pendingValidation: ['sdk_jdk_driver_compatibility', 'session_and_helper_components',
      'device_unlocked_and_douyin_login', 'profile_required', 'clipboard_identity_and_stop_on_device'],
  };
}
