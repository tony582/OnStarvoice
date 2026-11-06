import {DeviceError, bounded} from './bounded.mjs';
import {runDeviceBinary, runDeviceCommand} from './command.mjs';
import {validateSerial} from './adb.mjs';

// adb-only screen access for apps that hide their UI tree (WeChat 8.0.80): screenshots, taps, swipes, keys,
// the Appium settings app's Unicode keyboard for one keyword, and its clipboard reader. No UiAutomation.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const UNICODE_IME = 'io.appium.settings/.UnicodeIME';
const IME = /^[a-z][\w.]*\/[\w.$]+$/u;
const coordinate = value => {
  if (!Number.isInteger(value) || value < 0 || value > 4000) throw new DeviceError('invalid_coordinate', 'Screen coordinates are out of range');
  return String(value);
};

/** IMAP-style modified UTF-7, the encoding the Appium Unicode keyboard decodes from `input text`. */
export function encodeModifiedUtf7(text) {
  let out = '', buffer = '';
  const flush = () => {
    if (!buffer) return;
    const utf16 = Buffer.alloc(buffer.length * 2);
    for (let i = 0; i < buffer.length; i++) utf16.writeUInt16BE(buffer.charCodeAt(i), i * 2);
    out += `&${utf16.toString('base64').replace(/=+$/u, '').replaceAll('/', ',')}-`;
    buffer = '';
  };
  for (const char of String(text)) {
    const code = char.codePointAt(0);
    if (code >= 0x20 && code <= 0x7e) { flush(); out += char === '&' ? '&-' : char; }
    else buffer += char;
  }
  flush();
  return out;
}

export function createAdbScreen({adbPath = 'adb', serial, command = runDeviceCommand, binary = runDeviceBinary}) {
  validateSerial(serial);
  const base = ['-H', '127.0.0.1', '-P', '5037', '-s', serial];
  const shell = (args, {signal, timeoutMs = 5000} = {}) => bounded(s => command(adbPath, [...base, 'shell', ...args],
    {signal: s, timeoutMs}), {signal, timeoutMs}).then(result => result.stdout);
  const input = (args, options) => shell(['input', ...args], options);
  return {
    async screenshot({signal} = {}) {
      const raw = await binary(adbPath, [...base, 'exec-out', 'screencap', '-p'], {signal, timeoutMs: 8000});
      const start = raw.indexOf(PNG);
      if (start < 0) throw new DeviceError('screenshot_failed', 'The phone did not return a screenshot');
      return raw.subarray(start);
    },
    tap: (x, y, options) => input(['tap', coordinate(x), coordinate(y)], options),
    swipe: (x1, y1, x2, y2, ms = 400, options) => input(['swipe', coordinate(x1), coordinate(y1), coordinate(x2), coordinate(y2),
      String(Math.max(100, Math.min(2000, Math.round(ms))))], options),
    async key(code, {repeat = 1, ...options} = {}) {
      if (!Number.isInteger(code) || code < 1 || code > 400) throw new DeviceError('invalid_key', 'Key code is out of range');
      return input(['keyevent', ...Array.from({length: Math.max(1, Math.min(40, repeat))}, () => String(code))], options);
    },
    back: options => input(['keyevent', '4'], options),
    async defaultIme(options) { return (await shell(['settings', 'get', 'secure', 'default_input_method'], options)).trim(); },
    async setIme(ime, options) {
      if (!IME.test(ime)) throw new DeviceError('invalid_ime', 'Input method id is invalid');
      return shell(['ime', 'set', ime], options);
    },
    enableIme: (ime, options) => { if (!IME.test(ime)) throw new DeviceError('invalid_ime', 'Input method id is invalid'); return shell(['ime', 'enable', ime], options); },
    disableIme: (ime, options) => { if (!IME.test(ime)) throw new DeviceError('invalid_ime', 'Input method id is invalid'); return shell(['ime', 'disable', ime], options); },
    async listImes(options) { return (await shell(['ime', 'list', '-a', '-s'], options)).split(/\r?\n/u).map(line => line.trim()).filter(Boolean); },
    /** Type text through the already selected Unicode keyboard. Only that keyboard decodes the encoding. */
    typeUnicode(text, options) {
      const encoded = encodeModifiedUtf7(text);
      if (encoded.length > 900 || /['"\\`$]/u.test(encoded)) throw new DeviceError('invalid_input', 'Keyword cannot be typed safely');
      return input(['text', `'${encoded}'`], options);
    },
    /** The clipboard through the Appium settings app's broadcast receiver; null when it holds nothing. */
    async readClipboard(options) {
      const out = await shell(['am', 'broadcast', '-a', 'io.appium.settings.clipboard.get'], options);
      const match = out.match(/result=-1, data="([A-Za-z0-9+/=]*)"/u);
      if (!match) throw new DeviceError('clipboard_unavailable', 'The clipboard could not be read');
      return match[1] ? Buffer.from(match[1], 'base64').toString('utf8') : null;
    },
    async packageVersion(packageName, options) {
      if (!/^[a-z][\w.]+$/u.test(packageName)) throw new DeviceError('invalid_package', 'Package name is invalid');
      const out = await shell(['dumpsys', 'package', packageName], options);
      const versions = [...new Set([...out.matchAll(/versionName=([^\s]+)/gu)].map(match => match[1]))];
      return versions.length === 1 ? versions[0] : null;
    },
    /**
     * Hand one app link to an app's own exported entry, for the main user only, so no browser or app-twin chooser
     * appears. The link travels inside single quotes on the device shell: quotes, spaces and $`\ are refused.
     */
    async openLink(component, link, options = {}) {
      if (!/^[a-z]\w*(?:\.\w+)+\/\.?[\w.$]+$/u.test(component)) throw new DeviceError('invalid_component', 'An explicit component is required');
      if (typeof link !== 'string' || link.length > 600 || !/^[a-z][a-z0-9+.-]*:\/\/[^\s'"\\`$]+$/u.test(link)) {
        throw new DeviceError('invalid_link', 'The app link cannot be passed safely');
      }
      const out = await shell(['am', 'start', '--user', '0', '-a', 'android.intent.action.VIEW', '-c', 'android.intent.category.BROWSABLE',
        '-n', component, '-d', `'${link}'`], options);
      if (/Error|Exception/u.test(out)) throw new DeviceError('app_launch_failed', 'The app did not accept the link', {deviceSettled: true});
      return {launched: true};
    },
    /** Bring an app's main screen forward; clearTop also closes the app's own screens above it. */
    async launch(component, {clearTop = false, ...options} = {}) {
      if (!/^[a-z]\w*(?:\.\w+)+\/\.?[\w.$]+$/u.test(component)) throw new DeviceError('invalid_component', 'An explicit component is required');
      const out = await shell(['am', 'start', ...(clearTop ? ['-f', '0x04000000'] : ['-a', 'android.intent.action.MAIN',
        '-c', 'android.intent.category.LAUNCHER']), '-n', component], options);
      if (/Error/u.test(out)) throw new DeviceError('app_launch_failed', 'The app could not be launched');
      return {launched: true};
    },
  };
}
