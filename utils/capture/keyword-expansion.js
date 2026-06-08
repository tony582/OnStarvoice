/**
 * 关键词裂变模块 — 通过 DOM 模拟输入获取搜索联想词
 *
 * 在搜索框中依次输入 seed + a~z，读取平台原生下拉联想词，
 * 全局去重后返回扩展词列表。
 */

import { isCanceled, wait as waitWithCancel } from '../scroll.js';
import { detectPlatformFromUrl } from '../platform/page-routing.js';

// ==================== 平台选择器配置 ====================

const PLATFORM_SELECTORS = {
  xiaohongshu: {
    searchInput: [
      '#search-input',
      'input[type="search"]',
      'input.search-input',
      '.input-box input',
      '[class*="search"] input',
      'input[placeholder*="搜索"]',
      'input[placeholder*="探索"]',
    ],
    suggestionDropdown: [
      '.sug-box',
      '.sug-container',
      '.sug-container-wrapper',
      '[class*="search-suggest"]',
      '[class*="searchSuggest"]',
      '[class*="suggest"]',
      '[class*="recommend"]',
      '[role="listbox"]',
    ],
    suggestionItem: [
      '.sug-item',
      '.sug-box .sug-item',
      '.sug-wrapper .sug-item',
      '[class*="sug-item"]',
      '[class*="suggest-item"]',
      '[class*="search-item"]',
      '[role="option"]',
      'li',
      'a',
    ],
  },
  douyin: {
    searchInput: [
      '[data-e2e="searchbar-input"]',
      'input[data-e2e*="search"]',
      '[data-e2e*="search"] input',
      'input[type="search"]',
      'input[placeholder*="搜索"]',
    ],
    suggestionDropdown: [
      '[data-e2e="searchbar-popup"]',
      '[data-e2e*="searchbar"][data-e2e*="popup"]',
      '[data-e2e*="search"][data-e2e*="popup"]',
      '[data-e2e*="search"][data-e2e*="dropdown"]',
      '[data-e2e*="search"][data-e2e*="suggest"]',
      '[data-e2e*="search"][data-e2e*="recommend"]',
      '[data-e2e*="search"][class*="popup"]',
      '[data-e2e*="search"][class*="dropdown"]',
      '.search-suggest-popup',
      '[class*="suggestPopup"]',
      '[class*="suggest-popup"]',
      '[class*="suggestDropdown"]',
      '[class*="suggest-dropdown"]',
      '[class*="Search"][class*="Popup"]',
      '[class*="Search"][class*="Dropdown"]',
      '[class*="SearchSuggest"]',
      '[class*="SearchRecommend"]',
      '[class*="search-suggest"]',
      '[class*="search-recommend"]',
      '[class*="autocomplete"]',
      '[class*="auto-complete"]',
      '[role="listbox"]',
    ],
    suggestionItem: [
      '[data-e2e="searchbar-popup"] li',
      '[data-e2e*="searchbar"][data-e2e*="popup"] li',
      '[data-e2e*="search"][data-e2e*="popup"] li',
      '[data-e2e*="search"][data-e2e*="dropdown"] li',
      '[data-e2e*="search"][data-e2e*="suggest"] li',
      '[data-e2e*="search"][data-e2e*="recommend"] li',
      '.search-suggest-popup li',
      '[class*="suggestPopup"] li',
      '[class*="suggest-popup"] li',
      '[class*="suggestDropdown"] li',
      '[class*="suggest-dropdown"] li',
      '[class*="SearchSuggest"] li',
      '[class*="SearchRecommend"] li',
      '[class*="search-suggest"] li',
      '[class*="search-recommend"] li',
      '[class*="autocomplete"] li',
      '[class*="auto-complete"] li',
      '[data-e2e="searchbar-popup"] a',
      '[data-e2e="searchbar-popup"] [class*="item"]',
      '[data-e2e*="search"][class*="popup"] [class*="item"]',
      '[data-e2e*="search"][class*="dropdown"] [class*="item"]',
      '[data-e2e*="search"] [class*="option"]',
      '[data-e2e*="search"] [class*="item"]',
      '[role="listbox"] [role="option"]',
      '[role="listbox"] li',
      '[role="option"]',
    ],
  },
};

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');

const DEFAULT_DELAY_MS = 800;
const DELAY_JITTER_MS = 200;
const DROPDOWN_WAIT_MS = 1500;
const DOUYIN_DROPDOWN_WAIT_MS = 2400;
const DROPDOWN_POLL_MS = 100;
const WRITE_SYNC_WAIT_MS = 250;
const WRITE_SYNC_POLL_MS = 16;
const CARET_SETTLE_ATTEMPTS = 3;
const CARET_SETTLE_DELAY_MS = 30;
const XHS_HP_INPUT_SELECTOR = '[button-hp-installed][data-hp-kind="input"]';
const FOCUS_OVERLAY_ID = 'onstarvoice-keyword-expand-focus-overlay';
const FOCUS_OVERLAY_STYLE_ID = 'onstarvoice-keyword-expand-focus-style';

// ==================== 核心函数 ====================

/**
 * 通过 DOM 模拟输入扩展关键词
 *
 * @param {Object} options
 * @param {string} options.seedKeyword - 种子关键词
 * @param {string} [options.platform] - 平台标识，默认自动检测
 * @param {Function} [options.onProgress] - 进度回调 ({ letter, found, total })
 * @param {number} [options.delayBetweenMs] - 字母间延迟，默认 800ms（±200ms 随机）
 * @returns {Promise<{ expandedKeywords: string[], stats: { totalFound: number, duplicatesRemoved: number } }>}
 */
export async function expandKeywordViaSuggestions({
  seedKeyword,
  platform,
  onProgress,
  delayBetweenMs = DEFAULT_DELAY_MS,
} = {}) {
  const resolvedPlatform =
    platform || detectPlatformFromUrl(window.location.href);
  const selectors = PLATFORM_SELECTORS[resolvedPlatform];
  if (!selectors) {
    throw new Error(`不支持的平台: ${resolvedPlatform}`);
  }

  const inputHandle = resolveSearchInputHandle(selectors, resolvedPlatform);
  if (!inputHandle?.realInput) {
    throw new Error('未找到搜索输入框，请确认当前页面是搜索页');
  }
  console.info('[KeywordExpand] Input strategy', {
    platform: resolvedPlatform,
    usingHpProxy: Boolean(inputHandle.hpInput),
  });

  await ensureDocumentInteractiveFocus();

  // 保存原始值以便恢复
  const originalValue = String(inputHandle.realInput.value || '');
  try {
    assertNotCanceled();

    const allSuggestions = [];
    const seen = new Set();
    let totalFoundRaw = 0;

    // 先采集种子词本身的联想
    try {
      const seedSuggestions = await getSuggestionsForInput(
        inputHandle,
        seedKeyword,
        selectors,
        resolvedPlatform,
      );
      for (const s of seedSuggestions) {
        totalFoundRaw++;
        if (!seen.has(s)) {
          seen.add(s);
          allSuggestions.push(s);
        }
      }

      if (onProgress) {
        onProgress({
          letter: '',
          found: seedSuggestions.length,
          total: allSuggestions.length,
        });
      }

      await randomDelay(delayBetweenMs);
    } catch (error) {
      if (isExpandCanceledError(error)) {
        throw error;
      }
      // 种子词联想失败不阻塞后续
    }

    // 循环 a-z
    for (const letter of LETTERS) {
      assertNotCanceled();
      const query = seedKeyword + letter;

      try {
        const suggestions = await getSuggestionsForInput(
          inputHandle,
          query,
          selectors,
          resolvedPlatform,
        );

        let foundThisRound = 0;
        for (const s of suggestions) {
          totalFoundRaw++;
          if (!seen.has(s)) {
            seen.add(s);
            allSuggestions.push(s);
            foundThisRound++;
          }
        }

        if (onProgress) {
          onProgress({
            letter,
            found: foundThisRound,
            total: allSuggestions.length,
          });
        }
      } catch (error) {
        if (isExpandCanceledError(error)) {
          throw error;
        }
        // 单个字母失败不中断整个流程
      }

      await randomDelay(delayBetweenMs);
    }

    assertNotCanceled();
    return {
      expandedKeywords: allSuggestions,
      stats: {
        totalFound: totalFoundRaw,
        duplicatesRemoved: totalFoundRaw - allSuggestions.length,
      },
    };
  } finally {
    await writeSearchInputValue(inputHandle, originalValue);
  }
}

// ==================== 内部工具函数 ====================

/**
 * 向搜索框设值并等待联想下拉，然后提取联想词
 */
async function getSuggestionsForInput(inputHandle, query, selectors, platform) {
  assertNotCanceled();
  const { realInput } = inputHandle;
  const dropdownWaitMs = resolveDropdownWaitMs(platform);

  await ensureDocumentInteractiveFocus();

  // 聚焦输入框
  await ensureCaretAtEnd(realInput, String(realInput.value || ''));

  // 记录当前联想内容，用于检测内容是否刷新
  const prevTexts = extractSuggestionTexts(
    findBestDropdown(
      selectors.suggestionDropdown,
      selectors.suggestionItem,
      realInput,
      '',
      platform,
    ),
    selectors.suggestionItem,
  ).join('|');

  await writeSearchInputValue(inputHandle, query);
  if (platform === 'douyin') {
    dispatchSuggestionTriggerEvents(realInput, query);
  }

  // 等待联想下拉出现且内容刷新
  const dropdown = await waitForDropdown(
    selectors.suggestionDropdown,
    selectors.suggestionItem,
    prevTexts,
    realInput,
    dropdownWaitMs,
    query,
    platform,
  );
  if (!dropdown) {
    // 先做一次无可见字符变化的重触发，避免抖音频繁出现“空格-回退”闪动。
    await refreshInputWithoutMutation(inputHandle, query);
    const silentRetried = await waitForDropdown(
      selectors.suggestionDropdown,
      selectors.suggestionItem,
      prevTexts,
      realInput,
      dropdownWaitMs,
      query,
      platform,
    );
    if (silentRetried) {
      const silentRetriedTexts = extractSuggestionTexts(
        silentRetried,
        selectors.suggestionItem,
      );
      if (silentRetriedTexts.length > 0) {
        console.info('[KeywordExpand] Suggestions extracted', {
          query,
          count: silentRetriedTexts.length,
          sample: silentRetriedTexts.slice(0, 8),
        });
        return silentRetriedTexts;
      }
    }

    // 最后兜底：部分页面仅在输入值变化时触发联想，做一次空格增删刷新。
    await refreshInputBySpaceToggle(inputHandle, query);
    const retried = await waitForDropdown(
      selectors.suggestionDropdown,
      selectors.suggestionItem,
      prevTexts,
      realInput,
      dropdownWaitMs,
      query,
      platform,
    );
    if (!retried) {
      const fallbackTexts = extractFallbackSuggestionsNearInput(query, realInput);
      if (fallbackTexts.length > 0) {
        console.info('[KeywordExpand] Suggestions extracted via fallback', {
          query,
          count: fallbackTexts.length,
          sample: fallbackTexts.slice(0, 8),
        });
        return fallbackTexts;
      }
      console.warn('[KeywordExpand] Dropdown not found', {
        query,
        location: window.location.href,
        platform: platform || 'unknown',
        usingHpProxy: Boolean(inputHandle.hpInput),
        documentHasFocus: document.hasFocus(),
        inputFocused: document.activeElement === realInput,
        selectionStart: readSelectionPosition(realInput).start,
        selectionEnd: readSelectionPosition(realInput).end,
        nearbyTextSample: extractNearbyTextSample(realInput, query),
      });
      return [];
    }
    const retriedTexts = extractSuggestionTexts(retried, selectors.suggestionItem);
    if (retriedTexts.length === 0) {
      console.warn('[KeywordExpand] No suggestions extracted after retry', {
        query,
        dropdownClassName: String(retried?.className || ''),
        dropdownRole: retried?.getAttribute?.('role') || '',
        itemCount: querySuggestionItems(retried, selectors.suggestionItem).length,
        structuredTextSample: extractSuggestionStructuredTexts(retried).slice(0, 10),
        dropdownTextSample: extractSuggestionTextFromDropdown(retried).slice(0, 10),
      });
    } else {
      console.info('[KeywordExpand] Suggestions extracted', {
        query,
        count: retriedTexts.length,
        sample: retriedTexts.slice(0, 8),
      });
    }
    return retriedTexts;
  }

  // 提取联想词文本
  const texts = extractSuggestionTexts(dropdown, selectors.suggestionItem);
  if (texts.length === 0) {
    const fallbackTexts = extractFallbackSuggestionsNearInput(query, realInput);
    if (fallbackTexts.length > 0) {
      console.info('[KeywordExpand] Suggestions extracted via fallback', {
        query,
        count: fallbackTexts.length,
        sample: fallbackTexts.slice(0, 8),
      });
      return fallbackTexts;
    }
    console.warn('[KeywordExpand] No suggestions extracted', {
      query,
      dropdownClassName: String(dropdown?.className || ''),
      dropdownRole: dropdown?.getAttribute?.('role') || '',
      itemCount: querySuggestionItems(dropdown, selectors.suggestionItem).length,
      structuredTextSample: extractSuggestionStructuredTexts(dropdown).slice(0, 10),
      dropdownTextSample: extractSuggestionTextFromDropdown(dropdown).slice(0, 10),
      nearbyTextSample: extractNearbyTextSample(realInput, query),
    });
  } else {
    console.info('[KeywordExpand] Suggestions extracted', {
      query,
      count: texts.length,
      sample: texts.slice(0, 8),
    });
  }
  return texts;
}

/**
 * 小红书优先写入 hp 代理输入框；其它平台回落到原生 setter。
 */
async function writeSearchInputValue(inputHandle, value) {
  const { realInput, writeInput, hpInput } = inputHandle;
  if (!realInput || !writeInput) {
    return;
  }

  await ensureCaretAtEnd(realInput, String(realInput.value || ''));

  if (hpInput && writeInput === hpInput) {
    writeHpProxyInputValue(hpInput, value);
    await waitForInputSync(realInput, value);
    await ensureCaretAtEnd(realInput, value);
    return;
  }

  writeNativeInputValue(realInput, value);
  await ensureCaretAtEnd(realInput, value);
}

function writeNativeInputValue(input, value) {
  const previousValue = String(input?.value || '');

  // 只做 focus，避免程序化 click 触发页面风控脚本异常。
  input.focus();

  // native setter 仅对 HTMLInputElement 有效；textarea / contenteditable 等
  // 非 input 元素调用会抛 Illegal invocation，回落到普通赋值。
  if (input instanceof HTMLInputElement) {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    if (nativeSetter) {
      nativeSetter.call(input, value);
    } else {
      input.value = value;
    }
  } else if (input instanceof HTMLTextAreaElement) {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    if (nativeSetter) {
      nativeSetter.call(input, value);
    } else {
      input.value = value;
    }
  } else {
    input.value = value;
  }
  syncFrameworkValueTracker(input, previousValue);

  // 设置光标位置到最后，许多搜索框联想依赖此状态
  moveCaretToEnd(input, value);

  dispatchSuggestionTriggerEvents(input, value);
  input.dispatchEvent(new Event('change', { bubbles: true }));
  moveCaretToEnd(input, value);
}

function writeHpProxyInputValue(input, value) {
  const previousValue = String(input?.value || '');

  input.value = value;
  syncFrameworkValueTracker(input, previousValue);
  moveCaretToEnd(input, value);

  dispatchSuggestionTriggerEvents(input, value);
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function syncFrameworkValueTracker(input, previousValue) {
  const tracker = input?._valueTracker;
  if (!tracker || typeof tracker.setValue !== 'function') {
    return;
  }

  try {
    tracker.setValue(String(previousValue || ''));
  } catch {
    // ignore tracker sync failures
  }
}

function dispatchSuggestionTriggerEvents(input, value) {
  const lastChar = value ? value.slice(-1) : '';
  const key = resolveKeyboardKey(lastChar);
  const code = resolveKeyboardCode(lastChar);
  const keyCode = resolveKeyboardKeyCode(lastChar);
  const inputType = value ? 'insertText' : 'deleteContentBackward';
  const inputEventInit = {
    data: lastChar || null,
    inputType,
    bubbles: true,
    cancelable: true,
    composed: true,
  };

  input.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      code,
      keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true,
    }),
  );
  dispatchTextInputEvent(input, 'beforeinput', inputEventInit);
  dispatchTextInputEvent(input, 'input', inputEventInit);
  input.dispatchEvent(
    new KeyboardEvent('keyup', {
      key,
      code,
      keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function dispatchTextInputEvent(input, type, init) {
  try {
    input.dispatchEvent(new InputEvent(type, init));
  } catch {
    input.dispatchEvent(
      new Event(type, { bubbles: true, cancelable: true, composed: true }),
    );
  }
}

/**
 * 等待联想下拉 DOM 出现且内容刷新
 *
 * @param {string[]} dropdownSelectors - 下拉容器选择器
 * @param {string[]} [itemSelectors] - 联想词条目选择器（用于检测内容变化）
 * @param {string} [prevTextsKey] - 上一轮联想词指纹，用于检测内容是否刷新
 */
async function waitForDropdown(
  dropdownSelectors,
  itemSelectors,
  prevTextsKey,
  anchorElement,
  timeoutMs = DROPDOWN_WAIT_MS,
  query = '',
  platform = '',
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    assertNotCanceled();
    const el = findBestDropdown(
      dropdownSelectors,
      itemSelectors,
      anchorElement,
      query,
      platform,
    );
    if (el && isElementVisible(el)) {
      // 如果提供了 prevTextsKey，检测内容是否已刷新
      if (prevTextsKey && itemSelectors) {
        const currentTexts = extractSuggestionTexts(el, itemSelectors).join('|');
        if (currentTexts && currentTexts !== prevTextsKey) {
          await waitMs(100);
          assertNotCanceled();
          return el;
        }
        // 内容未变化，继续等待
      } else {
        // 没有基准比较，直接等待内容渲染
        await waitMs(150);
        assertNotCanceled();
        return el;
      }
    }
    await waitMs(DROPDOWN_POLL_MS);
  }
  // 超时后仍返回找到的元素（内容可能就是没变化）
  const el = findBestDropdown(
    dropdownSelectors,
    itemSelectors,
    anchorElement,
    query,
    platform,
  );
  return el && isElementVisible(el) ? el : null;
}

/**
 * 从下拉容器中提取联想词文本
 */
function extractSuggestionTexts(dropdown, itemSelectors) {
  if (!dropdown) return [];
  const seen = new Set();
  const texts = [];
  const items = querySuggestionItems(dropdown, itemSelectors);

  for (const item of items) {
    addSuggestionTextCandidate(texts, seen, normalizeSuggestionText(item));
  }

  if (texts.length > 0) {
    return texts;
  }

  const structuredTexts = extractSuggestionStructuredTexts(dropdown);
  for (const text of structuredTexts) {
    addSuggestionTextCandidate(texts, seen, text);
  }

  if (texts.length > 0) {
    return texts;
  }

  const leafTexts = extractSuggestionLeafTexts(dropdown);
  for (const text of leafTexts) {
    addSuggestionTextCandidate(texts, seen, text);
  }

  if (texts.length > 0) {
    return texts;
  }

  const textNodeLines = extractSuggestionTextNodeLines(dropdown);
  for (const text of textNodeLines) {
    addSuggestionTextCandidate(texts, seen, text);
  }

  const fallbackLines = extractSuggestionTextFromDropdown(dropdown);
  for (const line of fallbackLines) {
    addSuggestionTextCandidate(texts, seen, line);
  }

  return texts;
}

/**
 * 在多个选择器中查找第一个匹配的元素
 */
function findElement(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function resolveSearchInputHandle(selectors, platform) {
  const realInput = findElement(selectors.searchInput);
  if (!realInput) {
    return null;
  }

  const hpInput =
    platform === 'xiaohongshu' ? findXhsHpInput(realInput) : null;

  return {
    realInput,
    writeInput: hpInput || realInput,
    hpInput,
  };
}

function findXhsHpInput(realInput) {
  const container = realInput.closest('.input-box');
  if (!container) {
    return document.querySelector(XHS_HP_INPUT_SELECTOR);
  }

  return (
    container.querySelector(XHS_HP_INPUT_SELECTOR) ||
    document.querySelector(XHS_HP_INPUT_SELECTOR)
  );
}

function findAllElements(selectors) {
  const seen = new Set();
  const elements = [];

  for (const sel of selectors) {
    const found = document.querySelectorAll(sel);
    for (const el of found) {
      if (seen.has(el)) {
        continue;
      }
      seen.add(el);
      elements.push(el);
    }
  }

  return elements;
}

function findBestDropdown(
  dropdownSelectors,
  itemSelectors,
  anchorElement = null,
  query = '',
  platform = '',
) {
  let candidates = findAllElements(dropdownSelectors);
  if (
    candidates.length === 0 &&
    platform === 'douyin' &&
    query &&
    anchorElement
  ) {
    const structural = findDouyinStructuralDropdown(query, anchorElement);
    if (structural) {
      candidates = [structural];
    }
  }
  if (candidates.length === 0) {
    return null;
  }

  const scored = candidates.map((el) => ({
    el,
    visible: isElementVisible(el),
    itemCount: querySuggestionItems(el, itemSelectors).length,
    textLineCount: estimateSuggestionLineCount(el),
    distance: measureDistanceFromAnchor(anchorElement, el),
  }));

  scored.sort((a, b) => {
    if (a.visible !== b.visible) {
      return a.visible ? -1 : 1;
    }
    if (a.itemCount !== b.itemCount) {
      return b.itemCount - a.itemCount;
    }
    if (a.textLineCount !== b.textLineCount) {
      return b.textLineCount - a.textLineCount;
    }
    if (a.distance !== b.distance) {
      return a.distance - b.distance;
    }
    return 0;
  });

  return scored[0]?.el || null;
}

/**
 * 抖音专用：当类名选择器全部 miss 时，基于结构寻找联想下拉容器。
 * 抖音新版下拉容器与项使用随机混淆 class（如 .QmcwBilY / .UTRhD9xM），
 * 没有 data-e2e / suggest / popup 等稳定标识，只能按结构推断：
 *   1. 找到输入框下方 ~600px 内、innerText 以 query 开头的叶子元素
 *   2. 回溯它们的最近共同祖先（包含 ≥3 个候选项的最紧凑容器）
 */
function findDouyinStructuralDropdown(query, anchorElement) {
  if (!query || !anchorElement) return null;
  // 抖音联想词是拼音/字面混合匹配，item 不一定以 query 字面开头，
  // 但一定以种子词（去掉末尾 a-z 后缀）开头。
  const seed = String(query).replace(/[a-zA-Z]+$/, '').trim();
  if (!seed) return null;
  const seedLower = seed.toLowerCase();
  const anchorRect = anchorElement.getBoundingClientRect();
  const items = [];

  const all = document.querySelectorAll('body *');
  for (const el of all) {
    if (!(el instanceof HTMLElement)) continue;
    if (el.childElementCount > 4) continue;
    if (!isElementVisible(el)) continue;
    const text = normalizeSuggestionText(el);
    if (!text || text.length > 40) continue;
    if (!text.toLowerCase().startsWith(seedLower)) continue;
    const r = el.getBoundingClientRect();
    if (r.top < anchorRect.bottom - 4) continue;
    if (r.top > anchorRect.bottom + 600) continue;
    if (r.width < 60 || r.height < 16) continue;
    items.push(el);
  }

  if (items.length < 3) return null;

  const ancestorCount = new Map();
  for (const item of items) {
    let p = item.parentElement;
    let depth = 0;
    while (p && p !== document.body && depth < 10) {
      ancestorCount.set(p, (ancestorCount.get(p) || 0) + 1);
      p = p.parentElement;
      depth++;
    }
  }

  // 挑选紧凑度最高的容器：命中项 / 直系子元素 的比值越接近 1 越好，
  // 避免选到只包裹单个 dropdown 的外层 wrapper。
  let best = null;
  let bestScore = -1;
  let bestCount = 0;
  for (const [ancestor, count] of ancestorCount) {
    if (count < 3) continue;
    const childCount = Math.max(ancestor.childElementCount, 1);
    const density = count / childCount;
    const score = density * 100 + Math.min(count, 30);
    if (
      score > bestScore ||
      (score === bestScore && count > bestCount)
    ) {
      best = ancestor;
      bestScore = score;
      bestCount = count;
    }
  }

  return best;
}

function querySuggestionItems(dropdown, itemSelectors = []) {
  if (!dropdown || !itemSelectors.length) {
    return [];
  }

  const seen = new Set();
  const matches = [];

  for (const selector of itemSelectors) {
    const scoped = Array.from(dropdown.querySelectorAll(selector));
    for (const item of scoped) {
      if (seen.has(item)) {
        continue;
      }
      seen.add(item);
      matches.push(item);
    }

    const globalMatches = Array.from(document.querySelectorAll(selector)).filter(
      (item) => item === dropdown || dropdown.contains(item),
    );
    for (const item of globalMatches) {
      if (seen.has(item)) {
        continue;
      }
      seen.add(item);
      matches.push(item);
    }
  }

  return matches;
}

function normalizeSuggestionText(node) {
  const lines = String(node?.innerText || node?.textContent || '')
    .split('\n')
    .map((part) => part.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return '';
  }

  if (lines.length === 1) {
    return lines[0].replace(/\s+/g, ' ').trim();
  }

  // 抖音高亮词常拆成多行（命中词 + 后缀），优先拼成完整候选词。
  const joined = lines.join('').replace(/\s+/g, ' ').trim();
  if (joined && joined.length <= 80) {
    return joined;
  }

  return lines.reduce(
    (longest, current) => (current.length > longest.length ? current : longest),
    '',
  );
}

function extractSuggestionLeafTexts(dropdown) {
  const leaves = Array.from(dropdown.querySelectorAll('*')).filter((element) => {
    if (!(element instanceof HTMLElement)) {
      return false;
    }
    if (element.childElementCount > 0) {
      return false;
    }
    if (!isElementVisible(element)) {
      return false;
    }
    return true;
  });

  return leaves
    .map((element) => normalizeSuggestionText(element))
    .filter(Boolean);
}

function extractSuggestionStructuredTexts(dropdown) {
  const containers = collectStructuredSuggestionContainers(dropdown);
  if (containers.length === 0) {
    return [];
  }

  const texts = [];
  const seen = new Set();
  for (const container of containers) {
    const text = normalizeSuggestionText(container);
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    texts.push(text);
  }
  return texts;
}

function collectStructuredSuggestionContainers(dropdown) {
  const directRows = findRepeatedVisibleChildren(dropdown);
  if (directRows.length > 1) {
    return directRows;
  }

  const descendants = Array.from(dropdown.querySelectorAll('*')).filter((element) =>
    element instanceof HTMLElement && isElementVisible(element),
  );

  for (const element of descendants) {
    const rows = findRepeatedVisibleChildren(element);
    if (rows.length > 1) {
      return rows;
    }
  }

  const heuristicRows = descendants.filter((element) =>
    isHeuristicSuggestionRow(dropdown, element),
  );
  return dedupeSuggestionContainers(heuristicRows);
}

function findRepeatedVisibleChildren(root) {
  if (!(root instanceof HTMLElement)) {
    return [];
  }

  const children = Array.from(root.children).filter((child) =>
    child instanceof HTMLElement && isCandidateSuggestionBlock(root, child),
  );

  if (children.length < 2) {
    return [];
  }

  const withText = children.filter((child) => normalizeSuggestionText(child));
  if (withText.length < 2) {
    return [];
  }

  return dedupeSuggestionContainers(withText);
}

function isCandidateSuggestionBlock(root, element) {
  if (!(element instanceof HTMLElement) || !isElementVisible(element)) {
    return false;
  }

  const text = normalizeSuggestionText(element);
  if (!text) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  const rootRect = root.getBoundingClientRect();
  if (!rect.width || !rect.height || !rootRect.width || !rootRect.height) {
    return false;
  }

  if (rect.height > Math.max(rootRect.height * 0.9, 220)) {
    return false;
  }

  if (rect.width < Math.min(rootRect.width * 0.25, 80)) {
    return false;
  }

  return true;
}

function isHeuristicSuggestionRow(dropdown, element) {
  if (!(element instanceof HTMLElement) || element === dropdown) {
    return false;
  }

  const text = normalizeSuggestionText(element);
  if (!text) {
    return false;
  }

  const interactive =
    /^(A|BUTTON|LI)$/i.test(element.tagName) ||
    /option|button|menuitem|link/i.test(element.getAttribute('role') || '') ||
    typeof element.onclick === 'function';
  const hasTextChildren = Array.from(element.children).some(
    (child) => child instanceof HTMLElement && normalizeSuggestionText(child),
  );

  if (!interactive && !hasTextChildren) {
    return false;
  }

  return isCandidateSuggestionBlock(dropdown, element);
}

function dedupeSuggestionContainers(containers) {
  const unique = [];
  const seen = new Set();

  for (const container of containers) {
    const text = normalizeSuggestionText(container);
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    unique.push(container);
  }

  unique.sort((a, b) => {
    const rectA = a.getBoundingClientRect();
    const rectB = b.getBoundingClientRect();
    if (rectA.top !== rectB.top) {
      return rectA.top - rectB.top;
    }
    return rectA.left - rectB.left;
  });

  return unique;
}

function extractSuggestionTextNodeLines(dropdown) {
  const lines = [];
  const walker = document.createTreeWalker(
    dropdown,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = node?.parentElement;
        if (!parent || !isElementVisible(parent)) {
          return NodeFilter.FILTER_REJECT;
        }
        const normalized = normalizeSuggestionCandidateText(node.textContent);
        if (!normalized) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    },
  );

  let current = walker.nextNode();
  while (current) {
    const normalized = normalizeSuggestionCandidateText(current.textContent);
    if (normalized) {
      lines.push(normalized);
    }
    current = walker.nextNode();
  }

  return lines;
}

function extractSuggestionTextFromDropdown(dropdown) {
  const raw = String(dropdown?.innerText || dropdown?.textContent || '');
  if (!raw.trim()) {
    return [];
  }

  return raw
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((line) => line.length <= 80);
}

function estimateSuggestionLineCount(el) {
  const lines = extractSuggestionTextFromDropdown(el);
  return Math.min(lines.length, 30);
}

function extractFallbackSuggestionsNearInput(query, anchorElement) {
  const seen = new Set();
  const texts = [];
  const candidates = collectNearbyTextCandidates(anchorElement);

  for (const candidate of candidates) {
    if (!isLikelySuggestionCandidate(query, candidate.text)) {
      continue;
    }
    addSuggestionTextCandidate(texts, seen, candidate.text);
    if (texts.length >= 12) {
      break;
    }
  }

  return texts;
}

function extractNearbyTextSample(anchorElement, query) {
  return collectNearbyTextCandidates(anchorElement)
    .filter((candidate) => isPossiblyRelevantNearbyText(query, candidate.text))
    .slice(0, 8)
    .map((candidate) => candidate.text);
}

function collectNearbyTextCandidates(anchorElement) {
  if (!anchorElement || typeof document.createTreeWalker !== 'function') {
    return [];
  }

  const anchorRect = anchorElement.getBoundingClientRect();
  const candidates = [];
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);

  let current = walker.nextNode();
  while (current) {
    const parent = current.parentElement;
    const text = normalizeSuggestionCandidateText(current.textContent);

    if (
      parent &&
      text &&
      !seen.has(`${parent.tagName}:${text}`) &&
      isElementVisible(parent) &&
      isNearbySuggestionRegion(parent, anchorRect) &&
      !isInsideSearchResults(parent)
    ) {
      seen.add(`${parent.tagName}:${text}`);
      candidates.push({
        text,
        distance: measureDistanceFromAnchor(anchorElement, parent),
      });
    }

    current = walker.nextNode();
  }

  candidates.sort((a, b) => {
    if (a.distance !== b.distance) {
      return a.distance - b.distance;
    }
    return a.text.length - b.text.length;
  });

  return candidates;
}

function isNearbySuggestionRegion(element, anchorRect) {
  if (!anchorRect || typeof element.getBoundingClientRect !== 'function') {
    return false;
  }

  const rect = element.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return false;
  }

  const verticalGap = rect.top - anchorRect.bottom;
  const horizontalGap = Math.abs(rect.left - anchorRect.left);

  if (verticalGap < -120 || verticalGap > 720) {
    return false;
  }

  if (horizontalGap > 520) {
    return false;
  }

  return rect.top < Math.max(anchorRect.bottom + 720, window.innerHeight * 0.72);
}

function isInsideSearchResults(element) {
  return Boolean(
    element.closest(
      '#search-result-container, #waterFallScrollContainer, .search-result-card, [id^="waterfall_item_"], [data-e2e="scroll-list"]',
    ),
  );
}

function isLikelySuggestionCandidate(query, text) {
  const normalizedQuery = normalizeSuggestionCandidateText(query);
  const normalizedText = normalizeSuggestionCandidateText(text);
  if (!normalizedQuery || !normalizedText) {
    return false;
  }

  if (normalizedText === normalizedQuery) {
    return false;
  }

  if (/^(搜索|清除|取消|关闭|更多|相关搜索)$/i.test(normalizedText)) {
    return false;
  }

  if (normalizedText.startsWith(normalizedQuery)) {
    return true;
  }

  if (normalizedQuery.length >= 2 && normalizedText.includes(normalizedQuery)) {
    return true;
  }

  return false;
}

function isPossiblyRelevantNearbyText(query, text) {
  const normalizedQuery = normalizeSuggestionCandidateText(query);
  const normalizedText = normalizeSuggestionCandidateText(text);
  if (!normalizedText) {
    return false;
  }

  if (!normalizedQuery) {
    return true;
  }

  return (
    normalizedText.includes(normalizedQuery.slice(0, Math.min(normalizedQuery.length, 2))) ||
    normalizedText.startsWith(normalizedQuery)
  );
}

function shouldSkipSuggestionText(text) {
  const normalized = String(text || '').trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  // 排除明显不是联想词的提示文本。
  if (
    /^(搜索|搜索小红书|清除|取消|历史|历史记录|最近|最近搜索|更多|猜你想搜|大家都在搜|相关搜索|清空历史|删除历史记录|删除|关闭)$/i.test(
      normalized,
    )
  ) {
    return true;
  }

  // 排除过短噪音。
  if (normalized.length <= 1) {
    return true;
  }

  // 排除纯标点或无字母数字/汉字的噪音。
  if (!/[\p{L}\p{N}\u3400-\u9fff]/u.test(normalized)) {
    return true;
  }

  return false;
}

function addSuggestionTextCandidate(texts, seen, text) {
  const normalized = normalizeSuggestionCandidateText(text);
  if (!normalized || seen.has(normalized) || shouldSkipSuggestionText(normalized)) {
    return;
  }
  seen.add(normalized);
  texts.push(normalized);
}

function normalizeSuggestionCandidateText(text) {
  const normalized = String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/[·•]+/g, ' ')
    .trim();

  if (!normalized) {
    return '';
  }

  if (normalized.length > 80) {
    return '';
  }

  return normalized;
}

function moveCaretToEnd(input, value) {
  try {
    input.setSelectionRange(value.length, value.length);
  } catch {
    // ignore for non-text-like inputs
  }
}

function resolveKeyboardKey(char) {
  if (!char) {
    return 'Process';
  }
  return char;
}

function resolveKeyboardCode(char) {
  if (!char) {
    return '';
  }
  if (/^[a-z]$/i.test(char)) {
    return `Key${char.toUpperCase()}`;
  }
  if (/^[0-9]$/.test(char)) {
    return `Digit${char}`;
  }
  return '';
}

function resolveKeyboardKeyCode(char) {
  if (!char) {
    return 229;
  }
  if (/^[a-z]$/i.test(char)) {
    return char.toUpperCase().charCodeAt(0);
  }
  if (/^[0-9]$/.test(char)) {
    return 48 + Number(char);
  }
  return 229;
}

async function refreshInputBySpaceToggle(inputHandle, value) {
  await writeSearchInputValue(inputHandle, `${value} `);
  await waitMs(60);
  await writeSearchInputValue(inputHandle, value);
}

async function refreshInputWithoutMutation(inputHandle, value) {
  await writeSearchInputValue(inputHandle, value);
  await waitMs(40);
}

function resolveDropdownWaitMs(platform) {
  return platform === 'douyin' ? DOUYIN_DROPDOWN_WAIT_MS : DROPDOWN_WAIT_MS;
}

function isElementVisible(el) {
  if (!el) {
    return false;
  }

  const rect = typeof el.getBoundingClientRect === 'function'
    ? el.getBoundingClientRect()
    : null;
  if (rect && rect.width > 0 && rect.height > 0) {
    return true;
  }

  return el.offsetHeight > 0 || el.offsetWidth > 0;
}

function measureDistanceFromAnchor(anchorElement, targetElement) {
  if (
    !anchorElement ||
    !targetElement ||
    typeof anchorElement.getBoundingClientRect !== 'function' ||
    typeof targetElement.getBoundingClientRect !== 'function'
  ) {
    return Number.POSITIVE_INFINITY;
  }

  const anchorRect = anchorElement.getBoundingClientRect();
  const targetRect = targetElement.getBoundingClientRect();
  const verticalDistance = Math.abs(targetRect.top - anchorRect.bottom);
  const horizontalDistance = Math.abs(targetRect.left - anchorRect.left);
  return verticalDistance + horizontalDistance;
}

function assertNotCanceled() {
  if (isCanceled()) {
    throw new Error('EXPAND_KEYWORD_CANCELED');
  }
}

function isExpandCanceledError(error) {
  return String(error?.message || error || '') === 'EXPAND_KEYWORD_CANCELED';
}

/**
 * 随机延迟
 */
function randomDelay(baseMs) {
  const jitter = Math.floor(Math.random() * DELAY_JITTER_MS * 2) - DELAY_JITTER_MS;
  const ms = Math.max(100, baseMs + jitter);
  return waitMs(ms);
}

function waitMs(ms) {
  return waitWithCancel(ms);
}

async function waitForInputSync(input, expectedValue) {
  const startedAt = Date.now();
  const normalizedExpected = String(expectedValue || '');

  while (Date.now() - startedAt < WRITE_SYNC_WAIT_MS) {
    assertNotCanceled();
    if (String(input?.value || '') === normalizedExpected) {
      return true;
    }
    await waitMs(WRITE_SYNC_POLL_MS);
  }

  return String(input?.value || '') === normalizedExpected;
}

async function ensureCaretAtEnd(input, value) {
  const normalizedValue = String(value || '');
  for (let i = 0; i < CARET_SETTLE_ATTEMPTS; i++) {
    try {
      window.focus();
    } catch {
      // ignore
    }
    try {
      input.focus({ preventScroll: true });
    } catch {
      input.focus();
    }
    moveCaretToEnd(input, normalizedValue);
    input.dispatchEvent(new Event('select', { bubbles: true }));

    const selection = readSelectionPosition(input);
    if (
      document.activeElement === input &&
      selection.start === normalizedValue.length &&
      selection.end === normalizedValue.length
    ) {
      return true;
    }

    if (i < CARET_SETTLE_ATTEMPTS - 1) {
      await waitMs(CARET_SETTLE_DELAY_MS);
    }
  }

  return false;
}

function readSelectionPosition(input) {
  try {
    return {
      start: Number.isFinite(input.selectionStart) ? input.selectionStart : -1,
      end: Number.isFinite(input.selectionEnd) ? input.selectionEnd : -1,
    };
  } catch {
    return {
      start: -1,
      end: -1,
    };
  }
}

async function ensureDocumentInteractiveFocus() {
  assertNotCanceled();
  if (document.hasFocus()) {
    return true;
  }

  console.info('[KeywordExpand] Waiting for page focus');
  await waitForUserFocusOnPage();
  assertNotCanceled();
  return document.hasFocus();
}

async function waitForUserFocusOnPage() {
  ensureFocusOverlayStyle();

  const existing = document.getElementById(FOCUS_OVERLAY_ID);
  if (existing) {
    existing.remove();
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let cancelTimer = null;

    const overlay = document.createElement('div');
    overlay.id = FOCUS_OVERLAY_ID;
    overlay.innerHTML = `
      <div class="onstarvoice-keyword-expand-focus-card">
        <div class="onstarvoice-keyword-expand-focus-title">扩词需要页面焦点</div>
        <div class="onstarvoice-keyword-expand-focus-desc">点击下方按钮后继续自动扩词</div>
        <button type="button" class="onstarvoice-keyword-expand-focus-button">点击这里继续</button>
      </div>
    `;

    const button = overlay.querySelector('button');

    const cleanup = () => {
      if (cancelTimer) {
        clearInterval(cancelTimer);
        cancelTimer = null;
      }
      window.removeEventListener('focus', handleWindowFocus, true);
      document.removeEventListener('visibilitychange', handleVisibilityChange, true);
      overlay.removeEventListener('pointerdown', handlePointerDown, true);
      button?.removeEventListener('click', handleButtonClick, true);
      overlay.remove();
    };

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(true);
    };

    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const checkFocusSoon = () => {
      window.setTimeout(() => {
        if (settled) {
          return;
        }
        if (document.hasFocus()) {
          finish();
        }
      }, 30);
    };

    const handleWindowFocus = () => {
      checkFocusSoon();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        checkFocusSoon();
      }
    };

    const handlePointerDown = () => {
      try {
        window.focus();
      } catch {
        // ignore
      }
      checkFocusSoon();
    };

    const handleButtonClick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        window.focus();
      } catch {
        // ignore
      }
      checkFocusSoon();
    };

    window.addEventListener('focus', handleWindowFocus, true);
    document.addEventListener('visibilitychange', handleVisibilityChange, true);
    overlay.addEventListener('pointerdown', handlePointerDown, true);
    button?.addEventListener('click', handleButtonClick, true);
    document.documentElement.appendChild(overlay);

    cancelTimer = window.setInterval(() => {
      if (settled) {
        return;
      }
      if (isCanceled()) {
        fail(new Error('EXPAND_KEYWORD_CANCELED'));
        return;
      }
      if (document.hasFocus()) {
        finish();
      }
    }, 100);
  });
}

function ensureFocusOverlayStyle() {
  if (document.getElementById(FOCUS_OVERLAY_STYLE_ID)) {
    return;
  }

  const style = document.createElement('style');
  style.id = FOCUS_OVERLAY_STYLE_ID;
  style.textContent = `
    #${FOCUS_OVERLAY_ID} {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.16);
      pointer-events: auto;
    }

    #${FOCUS_OVERLAY_ID} .onstarvoice-keyword-expand-focus-card {
      width: min(360px, calc(100vw - 32px));
      padding: 18px;
      border-radius: 16px;
      background: rgba(24, 24, 28, 0.96);
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.25);
      color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
      text-align: center;
    }

    #${FOCUS_OVERLAY_ID} .onstarvoice-keyword-expand-focus-title {
      font-size: 18px;
      font-weight: 600;
      line-height: 1.4;
    }

    #${FOCUS_OVERLAY_ID} .onstarvoice-keyword-expand-focus-desc {
      margin-top: 8px;
      font-size: 14px;
      line-height: 1.5;
      color: rgba(255, 255, 255, 0.72);
    }

    #${FOCUS_OVERLAY_ID} .onstarvoice-keyword-expand-focus-button {
      margin-top: 16px;
      width: 100%;
      min-height: 44px;
      border: 0;
      border-radius: 12px;
      background: #ff2e4d;
      color: #fff;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
    }
  `;

  document.documentElement.appendChild(style);
}
