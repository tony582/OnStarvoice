import { setTimeout as delay } from 'node:timers/promises';
import { bounded, DeviceError, throwIfAborted } from './bounded.mjs';
import { parseUiTree, xpathLiteral } from './ui-tree.mjs';
import {assertDouyinScreen} from './douyin-readiness.mjs';
import { resource, DOUYIN_P0_PROFILE } from './douyin-profile.mjs';

/** Existing-session transport only; the caller owns the physical lock and session lifecycle. */
export function createUiSession({ client, sessionId, resourceLocator = 'id' }) {
  const read = async (options = {}) => {
    // DE106 hierarchy reads can exceed 5 s; the parent action deadline still applies.
    const tree = parseUiTree(await client.source(sessionId, { timeoutMs: 10000, ...options }));
    if (tree.nodes.some(node => node.attributes.package === 'com.smartisanos.textboom' && node.attributes.displayed === 'true')) {
      throw new DeviceError('system_overlay_blocked', 'Smartisan Big Bang is covering Douyin; calibration stopped');
    }
    if (client.enforceDouyinScreen) assertDouyinScreen(tree);
    return tree;
  };
  const unique = async (using, value, options) => {
    const elements = await client.findElements(sessionId, using, value, options);
    if (!Array.isArray(elements) || elements.length !== 1) throw new DeviceError('ui_target_ambiguous', 'Expected exactly one visible UI target');
    const id = elements[0]['element-6066-11e4-a52e-4f735466cecf'];
    if (typeof id !== 'string') throw new DeviceError('invalid_element', 'Element ID is missing');
    return id;
  };
  const click = async (using, value, options = {}) => {
    const id = await unique(using, value, options); throwIfAborted(options.signal);
    return client.clickElement(sessionId, id, options);
  };
  const locateResource = id => resourceLocator === 'xpath'
    ? ['xpath', `//*[@resource-id=${xpathLiteral(resource(id))}]`] : ['id',resource(id)];
  return {
    read,
    setWindowScope: (multiWindows, options) => client.setWindowScope(sessionId, multiWindows, options),
    waitFor(predicate, options = {}) {
      return bounded(async signal => {
        while (true) {
          const tree = await read({ signal, timeoutMs: 10000 });
          if (predicate(tree)) return tree;
          await delay(300, undefined, { signal });
        }
      }, { timeoutMs: 15000, ...options });
    },
    clickId: (id, options) => click(...locateResource(id), options),
    /**
     * Tap the bottom-right end of one located element. For a collapsed caption this is where the inline
     * "展开" sits; the element centre can be a #topic or @mention link that navigates away instead.
     */
    async tapIdNearEnd(id, options = {}) {
      const elementId = await unique(...locateResource(id), options); throwIfAborted(options.signal);
      const rect = await client.elementRect(sessionId, elementId, options);
      const width = Math.round(Number(rect?.width)), height = Math.round(Number(rect?.height));
      if (!(width > 0 && height > 0)) throw new DeviceError('invalid_element_rect', 'Element size is unknown');
      const x = Math.max(0, width - Math.min(56, Math.max(24, Math.round(width * 0.06))));
      const y = Math.max(0, height - Math.min(36, Math.max(12, Math.round(height * 0.25))));
      throwIfAborted(options.signal);
      await client.tapElementAt(sessionId, elementId, x, y, options);
      return { x, y, width, height };
    },
    clickXPath: (value, options) => click('xpath', value, options),
    clickText: (text, options) => click('xpath', `//*[@package=${xpathLiteral(DOUYIN_P0_PROFILE.packageName)} and @text=${xpathLiteral(text)}]`, options),
    async input(id, text, options = {}) {
      const elementId = await unique(...locateResource(id), options);
      await client.clearElement(sessionId, elementId, options); throwIfAborted(options.signal);
      await client.setValue(sessionId, elementId, text, options);
    },
    async scroll(resourceId, options = {}) {
      const id = await unique('id', resourceId, options); throwIfAborted(options.signal);
      return client.scrollElement(sessionId, id, { timeoutMs: 10000, ...options });
    },
    back: (options) => client.back(sessionId, options),
    currentActivity: (options) => client.currentActivity(sessionId, options),
    currentPackage: (options) => client.currentPackage(sessionId, options),
    getClipboard: (options) => client.getClipboard(sessionId, options),
    setClipboard: (text, options) => client.setClipboard(sessionId, text, options),
  };
}
