import {randomUUID} from 'node:crypto';
import {DeviceError, bounded, throwIfAborted} from './bounded.mjs';
import {selectDevice} from './adb.mjs';
import {createAdbScreen, UNICODE_IME} from './adb-screen.mjs';
import {createWechatScreen} from './wechat-screen.mjs';
import {createWechatFlow} from './wechat-flow.mjs';
import {assertWechatDevice, WECHAT_PROFILE} from './wechat-profile.mjs';
import {ocrHelperAvailable} from './ocr-pool.mjs';

// The WeChat Channels device adapter. It opens no automation session: adb screenshots, taps and keys, local OCR,
// and the Appium settings app for the Unicode keyboard and the clipboard. `ime` remembers the owner's keyboard
// ({load, save}) so an interrupted keyword entry is repaired by the next probe.
const CHANNEL_METHODS = ['search', 'readCards', 'openCard', 'openPost', 'forwardPost', 'copyLink', 'readComments', 'returnToResults', 'recoverResults', 'scroll'];

export function createWechatAdapter(options) { return createWechatDeviceAdapter(options); }

/** Shared WeChat device lifecycle; platform-specific UI flows supply only their operations. */
export function createWechatDeviceAdapter({serial, adb, adbPath = 'adb', ocr, ocrBinary, ime = {load: () => null, save: () => {}},
  screen = createAdbScreen({adbPath, serial}), now = Date.now}, {flowFactory = createWechatFlow, flowMethods = CHANNEL_METHODS,
  platform = WECHAT_PROFILE.platform, profileId = WECHAT_PROFILE.id} = {}) {
  const view = createWechatScreen({adb, screen, ocr, serial});
  const flow = flowFactory({screen, view, rememberIme: value => ime.save(value), restoreIme: ime.load(), now});
  const pending = new Set();
  const check = async options => {
    const device = selectDevice(await adb.listDevices(options), serial);
    const info = await adb.inspect(serial, options);
    const wechatVersion = await screen.packageVersion(WECHAT_PROFILE.packageName, options);
    assertWechatDevice({model: info.model, apiLevel: info.apiLevel, wechatVersion});
    if (!await screen.packageVersion('io.appium.settings', options)) throw new DeviceError('helper_app_missing', 'The Appium settings app is not installed');
    if (!(await screen.listImes(options)).includes(UNICODE_IME)) throw new DeviceError('helper_app_missing', 'The Appium Unicode keyboard is not available');
    if (!ocrHelperAvailable(ocrBinary)) throw new DeviceError('ocr_unavailable', 'The local OCR helper is not installed');
    return {...device, ...info, wechatVersion};
  };
  // A keyword entry stopped between the two keyboard switches leaves the Unicode keyboard selected: put the
  // owner's keyboard back. Only the remembered value is ever restored.
  const repairIme = async options => {
    if (await screen.defaultIme(options) !== UNICODE_IME) return false;
    const original = ime.load();
    if (!original) throw new DeviceError('input_method_unknown', 'The phone keyboard to restore is unknown');
    await screen.setIme(original, options);
    await screen.disableIme(UNICODE_IME, options);
    return true;
  };
  const adapter = {
    platform,
    profileId,
    async probe({signal} = {}) {
      try {
        const options = {signal};
        await check(options);
        await view.assertAwakeAndUnlocked(options);
        const repaired = await repairIme(options);
        return {readyForSearch: true, reason: null, ...(repaired ? {imeRepaired: true} : {})};
      } catch (error) {
        return {readyForSearch: false, reason: error.code ?? 'device_unavailable'};
      }
    },
    async inspect({signal} = {}) {
      const options = {signal};
      const info = await check(options);
      await view.assertAwakeAndUnlocked(options);
      await repairIme(options);
      flow.reset();
      return {...info, deviceId: serial, connected: true, unlocked: true, loggedIn: true, challenge: false, readyForSearch: true};
    },
    async parkHome({permit, timeoutMs = 15000}) {
      permit.assertAllowed();
      return bounded(signal => flow.parkHome({signal}), {signal: permit.signal, timeoutMs});
    },
    /** No automation session exists; closing waits for in-flight commands and puts the owner's keyboard back. */
    async close() {
      await bounded(() => Promise.allSettled([...pending]), {timeoutMs: 15000});
      try { await repairIme({}); } catch { return {closed: false, reason: 'input_method_unrestored'}; }
      flow.reset();
      return {closed: true, verifiedAt: new Date(now()).toISOString(), evidenceId: randomUUID()};
    },
  };
  for (const name of flowMethods) adapter[name] = params => flow[name](params);
  for (const name of ['inspect', ...flowMethods]) {
    const method = adapter[name];
    adapter[name] = params => {
      throwIfAborted(params?.signal);
      const operation = Promise.resolve().then(() => method(params)).finally(() => pending.delete(operation));
      pending.add(operation);
      return operation;
    };
  }
  return adapter;
}
