import { DeviceError, bounded } from './bounded.mjs';
import {profileCapabilities} from './session-profile.mjs';

export function validateAppiumUrl(value = 'http://127.0.0.1:4723') {
  let url;
  try { url = new URL(value); } catch { throw new DeviceError('invalid_appium_url', 'Appium URL is invalid'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash) {
    throw new DeviceError('invalid_appium_url', 'Appium must use a local loopback URL without credentials or query parameters');
  }
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url.href.replace(/\/$/, '');
}

async function readJson(response, maxBytes = 128 * 1024) {
  if (!response.body) throw new DeviceError('invalid_appium_response', 'Appium returned an empty response');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new DeviceError('appium_response_too_large', 'Appium response exceeded the permitted size');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new DeviceError('invalid_appium_response', 'Appium returned invalid JSON'); }
}

function sessionPath(sessionId) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
    throw new DeviceError('invalid_session', 'A valid existing Appium session ID is required');
  }
  return `/session/${sessionId}/execute/sync`;
}

export function createAppiumClient({ appiumUrl, fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  const base = validateAppiumUrl(appiumUrl);
  const request = (path, method, body, options = {}, maxBytes) => bounded(async (signal) => {
    const response = await fetchImpl(`${base}${path}`, {
      method, signal, redirect: 'error', headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await readJson(response, maxBytes);
    if (!response.ok) throw new DeviceError('appium_http_error', `Appium request failed with HTTP ${response.status}`,
      {w3cError: /^[a-z ]{1,80}$/.test(data.value?.error ?? '') ? data.value.error : null});
    if (!data || !Object.hasOwn(data, 'value') || data.value?.error) {
      throw new DeviceError('appium_protocol_error', 'Appium did not return a successful protocol response');
    }
    return data.value;
  }, { timeoutMs, ...options });
  const route = (sessionId, suffix) => sessionPath(sessionId).replace('/execute/sync', suffix);
  const elementRoute = (sessionId, elementId, suffix) => {
    if (typeof elementId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(elementId)) {
      throw new DeviceError('invalid_element', 'A valid Appium element ID is required');
    }
    return route(sessionId, `/element/${elementId}/${suffix}`);
  };
  return {
    async isSessionActive(id, options = {}) {
      try { await request(route(id, '/appium/settings'), 'GET', undefined, options); return true; }
      catch(error) {if(error.w3cError === 'invalid session id') return false; throw error;}
    },
    createProfileSession: (profileId, serial, options = {}) => request('/session', 'POST', {capabilities:{
      alwaysMatch:profileCapabilities(profileId,serial), firstMatch:[{}]}}, options),
    deleteSession: (id, options = {}) => request(route(id, ''), 'DELETE', undefined, options),
    source: (id, options = {}) => request(route(id, '/source'), 'GET', undefined, options, 2 * 1024 * 1024),
    settings: (id, options = {}) => request(route(id, '/appium/settings'), 'GET', undefined, options),
    setWindowScope(id, multiWindows, options = {}) {
      if (typeof multiWindows !== 'boolean') throw new DeviceError('invalid_window_scope', 'Window scope must be explicit');
      return request(route(id, '/appium/settings'), 'POST', { settings: {
        enableMultiWindows: multiWindows, enableTopmostWindowFromActivePackage: false,
      } }, options);
    },
    isLocked: (id, options = {}) => request(sessionPath(id), 'POST', { script: 'mobile: isLocked', args: [{}] }, options),
    back: (id, options = {}) => request(route(id, '/back'), 'POST', {}, options),
    findElements(id, using, value, options = {}) {
      if (!['id', 'xpath'].includes(using) || typeof value !== 'string' || !value || value.length > 8192) {
        throw new DeviceError('invalid_selector', 'A bounded resource ID or XPath selector is required');
      }
      return request(route(id, '/elements'), 'POST', { using, value }, options);
    },
    clickElement: (id, elementId, options = {}) => request(elementRoute(id, elementId, 'click'), 'POST', {}, options),
    clearElement: (id, elementId, options = {}) => request(elementRoute(id, elementId, 'clear'), 'POST', {}, options),
    setValue(id, elementId, text, options = {}) {
      if (typeof text !== 'string' || text.length > 1024) throw new DeviceError('invalid_input', 'Input exceeds its permitted size');
      return request(elementRoute(id, elementId, 'value'), 'POST', { text }, options);
    },
    scrollElement(id, elementId, options = {}) {
      elementRoute(id, elementId, 'scroll');
      return request(sessionPath(id), 'POST', { script: 'mobile: scrollGesture',
        args: [{ elementId, direction: 'down', percent: 0.72 }] }, options);
    },
    status: (options = {}) => request('/status', 'GET', undefined, options),
    // Foreground identity of the session device; diagnostic only, never a substitute for hierarchy verification.
    async currentActivity(id, options = {}) {
      const value = await request(route(id, '/appium/device/current_activity'), 'GET', undefined, options);
      return typeof value === 'string' ? value.slice(0, 200) : null;
    },
    async currentPackage(id, options = {}) {
      const value = await request(route(id, '/appium/device/current_package'), 'GET', undefined, options);
      return typeof value === 'string' ? value.slice(0, 200) : null;
    },
    async getClipboard(sessionId, options = {}) {
      const value = await request(sessionPath(sessionId), 'POST', { script: 'mobile: getClipboard', args: [] }, options);
      if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
        throw new DeviceError('invalid_clipboard', 'Clipboard result is not valid base64 text');
      }
      return Buffer.from(value, 'base64').toString('utf8');
    },
    setClipboard(sessionId, text, options = {}) {
      if (typeof text !== 'string' || Buffer.byteLength(text) > 16 * 1024) {
        throw new DeviceError('invalid_clipboard', 'Clipboard text exceeds its permitted size');
      }
      return request(sessionPath(sessionId), 'POST', {
        script: 'mobile: setClipboard', args: [{ content: Buffer.from(text).toString('base64'), contentType: 'plaintext' }],
      }, options);
    },
    // Creating sessions can install helper packages. P0 must explicitly configure this later.
    createSession() { throw new DeviceError('profile_required', 'Session creation requires a reviewed real-device profile'); },
  };
}
