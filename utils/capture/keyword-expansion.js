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
      'input#search-input',
      '#search-input textarea',
      '#search-input input',
      '#search-input [contenteditable="true"]',
      '#search-input',
      'textarea[name="aiSearchTextarea"]',
      '.textarea-container textarea[name="aiSearchTextarea"]',
      '.textarea-wrapper textarea',
      'textarea.textarea',
      'textarea[role="searchbox"]',
      'textarea[placeholder*="搜索"]',
      'textarea[placeholder*="输入"]',
      'input[role="searchbox"]',
      'input[type="search"]',
      'input.search-input',
      '.input-box input',
      '[class*="search"] textarea',
      '[class*="Search"] textarea',
      '[class*="search"] input',
      '[class*="Search"] input',
      'input[placeholder*="搜索"]',
      'input[placeholder*="探索"]',
      '[contenteditable="true"][role="searchbox"]',
      '[contenteditable="true"][aria-label*="搜索"]',
      '[contenteditable="true"][placeholder*="搜索"]',
    ],
    suggestionDropdown: [
      '.sug-box',
      '.sug-container',
      '.sug-container-wrapper',
      '[class*="search-suggest"]',
      '[class*="searchSuggest"]',
      '[class*="SearchSuggest"]',
      '[class*="suggest"]',
      '[class*="Suggest"]',
      '[class*="suggestion"]',
      '[class*="Suggestion"]',
      '[class*="recommend"]',
      '[class*="Recommend"]',
      '[class*="dropdown"]',
      '[class*="Dropdown"]',
      '[class*="popover"]',
      '[class*="Popover"]',
      '[class*="autocomplete"]',
      '[class*="auto-complete"]',
      '[role="listbox"]',
    ],
    suggestionItem: [
      '.sug-item',
      '.sug-box .sug-item',
      '.sug-wrapper .sug-item',
      '[class*="sug-item"]',
      '[class*="suggest-item"]',
      '[class*="SuggestItem"]',
      '[class*="search-item"]',
      '[class*="SearchItem"]',
      '[class*="dropdown"] [class*="item"]',
      '[class*="Dropdown"] [class*="Item"]',
      '[class*="popover"] [class*="item"]',
      '[class*="Popover"] [class*="Item"]',
      '[class*="option"]',
      '[class*="Option"]',
      '[role="option"]',
      'li',
      'a',
      'button',
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

const DEFAULT_DELAY_MS = 2000;
const DELAY_JITTER_MS = 500;
const DROPDOWN_WAIT_MS = 6000;
const DOUYIN_DROPDOWN_WAIT_MS = 3200;
const DROPDOWN_POLL_MS = 100;
const DROPDOWN_STABLE_MS = 500;
const DROPDOWN_RETRY_WAIT_MS = 1800;
const WRITE_SYNC_WAIT_MS = 250;
const WRITE_SYNC_POLL_MS = 16;
const CARET_SETTLE_ATTEMPTS = 3;
const CARET_SETTLE_DELAY_MS = 30;
const XHS_HP_INPUT_SELECTOR = '[button-hp-installed][data-hp-kind="input"]';
const SEARCH_RESULT_REGION_SELECTOR = [
  '#search-result-container',
  '#waterFallScrollContainer',
  '#search-result',
  '.search-results',
  '.search-result-card',
  '.feeds-container',
  '.waterfall',
  '.note-item',
  '.feed-item',
  '[data-v-feed]',
  '[id^="waterfall_item_"]',
  '[class*="waterfall"]',
  '[class*="note-item"]',
  '[class*="feed-item"]',
].join(',');
const NOTE_RESULT_LINK_SELECTOR = [
  'a[href*="/explore/"]',
  'a[href*="/discovery/item/"]',
  'a[href*="/search_result/notes/"]',
  'a[href*="/note/"]',
].join(',');
const NOTE_RESULT_MEDIA_SELECTOR = [
  'img[src*="xhscdn"]',
  'img[src*="xhscdn.com"]',
  'img[src*="sns-img"]',
  'video',
].join(',');

// ==================== 核心函数 ====================

/**
 * 通过 DOM 模拟输入扩展关键词
 *
 * @param {Object} options
 * @param {string} options.seedKeyword - 种子关键词
 * @param {string} [options.platform] - 平台标识，默认自动检测
 * @param {Function} [options.onProgress] - 进度回调 ({ letter, found, total })
 * @param {number} [options.delayBetweenMs] - 字母间延迟，默认取 DEFAULT_DELAY_MS（±DELAY_JITTER_MS 随机）
 * @returns {Promise<{ expandedKeywords: string[], stats: { totalFound: number, duplicatesRemoved: number } }>}
 */
export async function expandKeywordViaSuggestions({
  seedKeyword,
  platform,
  onProgress,
  delayBetweenMs = DEFAULT_DELAY_MS,
  suffixLetters = LETTERS,
} = {}) {
  const resolvedPlatform =
    platform || detectPlatformFromUrl(window.location.href);
  const selectors = PLATFORM_SELECTORS[resolvedPlatform];
  if (!selectors) {
    throw new Error(`不支持的平台: ${resolvedPlatform}`);
  }
  const resolvedDelayBetweenMs = resolveDelayBetweenMs(delayBetweenMs);
  const resolvedSuffixLetters = normalizeSuffixLetters(suffixLetters);

  const inputHandle = resolveSearchInputHandle(
    selectors,
    resolvedPlatform,
    seedKeyword,
  );
  if (!inputHandle?.realInput) {
    throw new Error('未找到搜索输入框，请确认当前页面是搜索页');
  }
  const inputDebugInfo = {
    platform: resolvedPlatform,
    usingHpProxy: Boolean(inputHandle.hpInput),
    inputTag: inputHandle.realInput.tagName,
    inputId: inputHandle.realInput.id || '',
    inputName: inputHandle.realInput.getAttribute?.('name') || '',
    inputClassName: String(inputHandle.realInput.className || ''),
    inputValue: readSearchInputValue(inputHandle.realInput),
    delayBetweenMs: resolvedDelayBetweenMs,
    delayJitterMs: DELAY_JITTER_MS,
    dropdownWaitMs: resolveDropdownWaitMs(resolvedPlatform),
    dropdownRetryWaitMs: resolveRetryDropdownWaitMs(resolvedPlatform),
    dropdownStableMs: DROPDOWN_STABLE_MS,
  };
  writeKeywordExpandDebugInfo(inputDebugInfo);
  console.info('[KeywordExpand] Input strategy', inputDebugInfo);

  await ensureDocumentInteractiveFocus(inputHandle.realInput);
  await ensureCaretAtEnd(
    inputHandle.realInput,
    readSearchInputValue(inputHandle.realInput),
  );

  // 保存原始值以便恢复
  const originalValue = readSearchInputValue(inputHandle.realInput);
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
        {
          baseKeyword: seedKeyword,
        },
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
          phase: 'keyword_expand',
          letter: '',
          found: seedSuggestions.length,
          total: allSuggestions.length,
          message: `正在读取主词「${seedKeyword}」联想词，已发现 ${allSuggestions.length} 个`,
        });
      }

      if (resolvedPlatform === 'xiaohongshu') {
        await waitMs(200);
      } else {
        await randomDelay(resolvedDelayBetweenMs, onProgress);
      }
    } catch (error) {
      if (isExpandCanceledError(error)) {
        throw error;
      }
      // 种子词联想失败不阻塞后续
    }

    // 循环 a-z
    for (const letter of resolvedSuffixLetters) {
      assertNotCanceled();
      const query = seedKeyword + letter;

      try {
        const suggestions = await getSuggestionsForInput(
          inputHandle,
          query,
          selectors,
          resolvedPlatform,
          {
            baseKeyword: seedKeyword,
            suffixText: letter,
          },
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
            phase: 'keyword_expand',
            letter,
            found: foundThisRound,
            total: allSuggestions.length,
            message: `正在尝试字母 ${letter.toUpperCase()}，本轮新增 ${foundThisRound} 个，累计 ${allSuggestions.length} 个`,
          });
        }
      } catch (error) {
        if (isExpandCanceledError(error)) {
          throw error;
        }
        // 单个字母失败不中断整个流程
      }

      await randomDelay(resolvedDelayBetweenMs, onProgress);
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
async function getSuggestionsForInput(
  inputHandle,
  query,
  selectors,
  platform,
  {
    baseKeyword = query,
    suffixText = '',
  } = {},
) {
  assertNotCanceled();
  const { realInput } = inputHandle;
  const dropdownWaitMs = resolveDropdownWaitMs(platform);
  const dropdownRetryWaitMs = resolveRetryDropdownWaitMs(platform, dropdownWaitMs);
  const requireCurrentInputSignal =
    platform === 'xiaohongshu' && Boolean(suffixText);
  const allowUnchangedDropdown =
    !suffixText || Boolean(requireCurrentInputSignal);
  const shouldSkipRetryOnMissingDropdown =
    requireCurrentInputSignal || (platform === 'xiaohongshu' && !suffixText);
  const effectiveDropdownWaitMs = shouldSkipRetryOnMissingDropdown
    ? Math.min(dropdownWaitMs, 2600)
    : dropdownWaitMs;
  const dropdownContext = {
    baseKeyword,
    allowUnchangedDropdown,
    requireInputValueSignal: requireCurrentInputSignal ? query : '',
  };

  await ensureDocumentInteractiveFocus(realInput);

  // 聚焦输入框
  await ensureSearchInputReadyForTyping(realInput);

  // 记录当前联想内容，用于检测内容是否刷新
  const prevTexts = extractSuggestionTexts(
    findBestDropdown(
      selectors.suggestionDropdown,
      selectors.suggestionItem,
      realInput,
      '',
      platform,
      { baseKeyword },
    ),
    selectors.suggestionItem,
    {
      baseKeyword,
      anchorElement: realInput,
      platform,
    },
  ).join('|');

  const inputWritten = await writeSearchInputQuery(inputHandle, query, platform, {
    baseKeyword,
    suffixText,
  });
  if (!inputWritten) {
    console.warn('[KeywordExpand] Search input did not accept query', {
      query,
      actual: readSearchInputValue(realInput),
      platform,
      usingHpProxy: Boolean(inputHandle.hpInput),
    });
    return [];
  }
  if (platform === 'douyin') {
    dispatchSuggestionTriggerEvents(realInput, query);
  }

  // 等待联想下拉出现且内容刷新
  const dropdown = await waitForDropdown(
    selectors.suggestionDropdown,
    selectors.suggestionItem,
    prevTexts,
    realInput,
    effectiveDropdownWaitMs,
    query,
    platform,
    dropdownContext,
  );
  if (!dropdown) {
    if (shouldSkipRetryOnMissingDropdown) {
      const fallbackTexts = extractFallbackSuggestionsFromSearchRoot(
        query,
        realInput,
        selectors.suggestionItem,
        {
          baseKeyword,
          platform,
        },
      );
      if (fallbackTexts.length > 0) {
        console.info('[KeywordExpand] Suggestions extracted via search root fallback', {
          query,
          count: fallbackTexts.length,
          sample: fallbackTexts.slice(0, 8),
        });
        return fallbackTexts;
      }

      const nearbyFallbackTexts = extractFallbackSuggestionsNearInput(query, realInput, {
        baseKeyword,
        query,
        platform,
        preferBaseKeywordSignal: platform === 'xiaohongshu',
      });
      if (nearbyFallbackTexts.length > 0) {
        console.info('[KeywordExpand] Suggestions extracted via nearby fallback', {
          query,
          count: nearbyFallbackTexts.length,
          sample: nearbyFallbackTexts.slice(0, 8),
        });
        return nearbyFallbackTexts;
      }

      console.warn('[KeywordExpand] Current query dropdown not ready, skip query', {
        query,
        actual: readSearchInputValue(realInput),
        platform,
        suffixText,
        nearbyElementSample: extractNearbyElementTextSample(
          realInput,
          query,
          platform,
        ),
        nearbyTextSample: extractNearbyTextSample(realInput, query, platform),
      });
      return [];
    }

    // 先做一次无可见字符变化的重触发，避免抖音频繁出现“空格-回退”闪动。
    await refreshInputWithoutMutation(inputHandle, query);
    const silentRetried = await waitForDropdown(
      selectors.suggestionDropdown,
      selectors.suggestionItem,
      prevTexts,
      realInput,
      dropdownRetryWaitMs,
      query,
      platform,
      dropdownContext,
    );
    if (silentRetried) {
      const silentRetriedTexts = extractSuggestionTexts(
        silentRetried,
        selectors.suggestionItem,
        {
          query,
          baseKeyword,
          anchorElement: realInput,
          platform,
        },
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
      dropdownRetryWaitMs,
      query,
      platform,
      dropdownContext,
    );
    if (!retried) {
      const fallbackTexts = extractFallbackSuggestionsNearInput(query, realInput, {
        baseKeyword,
        query,
        platform,
      });
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
        nearbyTextSample: extractNearbyTextSample(realInput, query, platform),
      });
      return [];
    }
    const retriedTexts = extractSuggestionTexts(
      retried,
      selectors.suggestionItem,
      {
        query,
        baseKeyword,
        anchorElement: realInput,
        platform,
      },
    );
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
  const texts = extractSuggestionTexts(dropdown, selectors.suggestionItem, {
    query,
    baseKeyword,
    anchorElement: realInput,
    platform,
  });
  if (texts.length === 0) {
    if (requireCurrentInputSignal) {
      console.warn('[KeywordExpand] Current query suggestions empty, skip letter', {
        query,
        dropdownTextSample: extractSuggestionTextFromDropdown(dropdown).slice(0, 10),
      });
      return [];
    }

    const fallbackTexts = extractFallbackSuggestionsNearInput(query, realInput, {
      baseKeyword,
      query,
      platform,
      preferBaseKeywordSignal: platform === 'xiaohongshu',
    });
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
      nearbyTextSample: extractNearbyTextSample(realInput, query, platform),
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

async function writeSearchInputQuery(
  inputHandle,
  query,
  platform,
  {
    baseKeyword = query,
    suffixText = '',
  } = {},
) {
  const wrote = await writeSearchInputValue(inputHandle, query);
  if (platform === 'xiaohongshu' && suffixText) {
    await waitMs(260);
  }
  return wrote;
}

/**
 * 小红书优先写入 hp 代理输入框；其它平台回落到原生 setter。
 */
async function writeSearchInputValue(inputHandle, value) {
  const { realInput, writeInput, hpInput } = inputHandle;
  if (!realInput || !writeInput) {
    return false;
  }

  await ensureSearchInputReadyForTyping(realInput);

  if (hpInput && writeInput === hpInput) {
    const previousRealValue = readSearchInputValue(realInput);
    writeHpProxyInputValue(hpInput, value);
    await waitMs(30);
    writeNativeInputValue(realInput, value);
    let synced = await waitForInputSync(realInput, value);
    if (!synced) {
      console.warn('[KeywordExpand] HP proxy input did not sync, fallback to real input', {
        expected: value,
        actual: readSearchInputValue(realInput),
      });
      writeNativeInputValue(realInput, value);
      synced = await waitForInputSync(realInput, value);
    } else {
      notifyRealInputAfterProxyWrite(realInput, value, previousRealValue);
    }
    await ensureCaretAtEnd(realInput, value);
    return synced;
  }

  writeNativeInputValue(realInput, value);
  const synced = await waitForInputSync(realInput, value);
  await ensureCaretAtEnd(realInput, value);
  return synced;
}

async function appendSearchInputText(inputHandle, text) {
  const { realInput, writeInput, hpInput } = inputHandle;
  if (!realInput || !writeInput || !text) {
    return;
  }

  await ensureCaretAtEnd(realInput, readSearchInputValue(realInput));

  if (hpInput && writeInput === hpInput) {
    const previousRealValue = readSearchInputValue(realInput);
    const expectedValue = `${previousRealValue}${text}`;
    appendTextLikeUser(hpInput, text);
    const synced = await waitForInputSync(realInput, expectedValue);
    if (!synced) {
      console.warn('[KeywordExpand] HP proxy append did not sync, fallback to real input', {
        expected: expectedValue,
        actual: readSearchInputValue(realInput),
      });
      appendTextLikeUser(realInput, text);
      if (!(await waitForInputSync(realInput, expectedValue))) {
        writeNativeInputValue(realInput, expectedValue);
        await waitForInputSync(realInput, expectedValue);
      }
    } else {
      notifyRealInputAfterProxyWrite(realInput, expectedValue, previousRealValue);
    }
    await ensureCaretAtEnd(realInput, readSearchInputValue(realInput));
    return;
  }

  const expectedValue = `${readSearchInputValue(realInput)}${text}`;
  appendTextLikeUser(realInput, text);
  if (!(await waitForInputSync(realInput, expectedValue))) {
    writeNativeInputValue(realInput, expectedValue);
    await waitForInputSync(realInput, expectedValue);
  }
  await ensureCaretAtEnd(realInput, readSearchInputValue(realInput));
}

function writeNativeInputValue(input, value) {
  const previousValue = readSearchInputValue(input);

  activateSearchInputComponent(input, previousValue);

  if (isContentEditableInput(input)) {
    writeContentEditableValue(input, value);
    syncFrameworkValueTracker(input, previousValue);
    moveCaretToEnd(input, value);
    dispatchSuggestionTriggerEvents(input, value);
    input.dispatchEvent(new Event('change', { bubbles: true }));
    moveCaretToEnd(input, value);
    return;
  }

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
  const previousValue = readSearchInputValue(input);

  setSearchInputValue(input, value);
  syncFrameworkValueTracker(input, previousValue);
  moveCaretToEnd(input, value);

  dispatchSuggestionTriggerEvents(input, value);
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function notifyRealInputAfterProxyWrite(input, value, previousValue = '') {
  if (!input) {
    return;
  }

  activateSearchInputComponent(input, value);
  syncFrameworkValueTracker(input, previousValue);
  moveCaretToEnd(input, value);
  dispatchSuggestionTriggerEvents(input, value);
  input.dispatchEvent(new Event('change', { bubbles: true }));
  moveCaretToEnd(input, value);
}

function appendTextLikeUser(input, text) {
  for (const char of String(text || '')) {
    insertSingleCharacterLikeUser(input, char);
  }
}

function insertSingleCharacterLikeUser(input, char) {
  const previousValue = readSearchInputValue(input);
  const key = resolveKeyboardKey(char);
  const code = resolveKeyboardCode(char);
  const keyCode = resolveKeyboardKeyCode(char);

  activateSearchInputComponent(input, previousValue);
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
  dispatchTextInputEvent(input, 'beforeinput', {
    data: char,
    inputType: 'insertText',
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  insertTextAtCaret(input, char);
  syncFrameworkValueTracker(input, previousValue);
  dispatchTextInputEvent(input, 'input', {
    data: char,
    inputType: 'insertText',
    bubbles: true,
    cancelable: true,
    composed: true,
  });
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
  moveCaretToEnd(input, readSearchInputValue(input));
}

function insertTextAtCaret(input, text) {
  if (isContentEditableInput(input)) {
    insertTextIntoContentEditable(input, text);
    return;
  }

  const current = readSearchInputValue(input);
  const position = current.length;
  if (typeof input.setRangeText === 'function') {
    input.setSelectionRange(position, position);
    input.setRangeText(text, position, position, 'end');
    return;
  }

  setSearchInputValue(input, `${current}${text}`);
}

function insertTextIntoContentEditable(input, text) {
  const selection = window.getSelection?.();
  if (!selection || selection.rangeCount === 0 || !input.contains(selection.anchorNode)) {
    moveCaretToEnd(input, readSearchInputValue(input));
  }

  const activeSelection = window.getSelection?.();
  if (!activeSelection || activeSelection.rangeCount === 0) {
    input.textContent = `${readSearchInputValue(input)}${text}`;
    return;
  }

  const range = activeSelection.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.setEndAfter(node);
  range.collapse(false);
  activeSelection.removeAllRanges();
  activeSelection.addRange(range);
}

function readSearchInputValue(input) {
  if (!input) {
    return '';
  }

  if (isContentEditableInput(input)) {
    return String(input.innerText || input.textContent || '');
  }

  return String(input.value || '');
}

function setSearchInputValue(input, value) {
  if (isContentEditableInput(input)) {
    writeContentEditableValue(input, value);
    return;
  }

  input.value = value;
}

function writeContentEditableValue(input, value) {
  input.textContent = String(value || '');
}

function isContentEditableInput(input) {
  return Boolean(input?.isContentEditable);
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
  context = {},
) {
  const startedAt = Date.now();
  let lastTextsKey = '';
  let lastChangedAt = 0;
  let lastDropdown = null;

  while (Date.now() - startedAt < timeoutMs) {
    assertNotCanceled();
    const el = findBestDropdown(
      dropdownSelectors,
      itemSelectors,
      anchorElement,
      query,
      platform,
      context,
    );
    if (el && isElementVisible(el)) {
      if (
        context.requireInputValueSignal &&
        readSearchInputValue(anchorElement) !== context.requireInputValueSignal
      ) {
        await waitMs(DROPDOWN_POLL_MS);
        continue;
      }

      // 等待词表刷新并稳定，避免读到上一轮残留或平台热榜兜底。
      if (itemSelectors) {
        const currentTexts = extractSuggestionTexts(el, itemSelectors, {
          query,
          baseKeyword: context.baseKeyword || query,
          requireQuerySignal: Boolean(context.requireQuerySignal),
          anchorElement,
          platform,
        }).join('|');
        if (
          currentTexts &&
          (!prevTextsKey ||
            currentTexts !== prevTextsKey ||
            context.allowUnchangedDropdown)
        ) {
          const now = Date.now();
          if (currentTexts !== lastTextsKey) {
            lastTextsKey = currentTexts;
            lastChangedAt = now;
          }
          lastDropdown = el;
          if (now - lastChangedAt >= DROPDOWN_STABLE_MS) {
            return lastDropdown || el;
          }
        }
        // 内容未变化或还没有 seed 相关词，继续等待。
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
    context,
  );
  if (!el || !isElementVisible(el)) {
    return null;
  }
  if (
    context.requireInputValueSignal &&
    readSearchInputValue(anchorElement) !== context.requireInputValueSignal
  ) {
    return null;
  }

  if (itemSelectors) {
    const currentTexts = extractSuggestionTexts(el, itemSelectors, {
      query,
      baseKeyword: context.baseKeyword || query,
      requireQuerySignal: Boolean(context.requireQuerySignal),
      anchorElement,
      platform,
    }).join('|');
    if (
      !currentTexts ||
      (currentTexts === prevTextsKey && !context.allowUnchangedDropdown)
    ) {
      return null;
    }
  }

  if (
    !dropdownHasSeedSignal(
      el,
      context.requireQuerySignal ? query : context.baseKeyword || query,
    )
  ) {
    return null;
  }
  return el;
}

/**
 * 从下拉容器中提取联想词文本
 */
function extractSuggestionTexts(dropdown, itemSelectors, context = {}) {
  if (!dropdown) return [];
  const seen = new Set();
  const texts = [];
  const items = querySuggestionItems(dropdown, itemSelectors);

  for (const item of items) {
    if (isInsideSearchResults(item)) {
      continue;
    }
    addSuggestionTextCandidate(
      texts,
      seen,
      normalizeSuggestionText(item),
      context,
    );
  }

  if (texts.length > 0) {
    return texts;
  }

  const structuredTexts = extractSuggestionStructuredTexts(dropdown);
  for (const text of structuredTexts) {
    addSuggestionTextCandidate(texts, seen, text, context);
  }

  if (texts.length > 0) {
    return texts;
  }

  const leafTexts = extractSuggestionLeafTexts(dropdown);
  for (const text of leafTexts) {
    addSuggestionTextCandidate(texts, seen, text, context);
  }

  if (texts.length > 0) {
    return texts;
  }

  const textNodeLines = extractSuggestionTextNodeLines(dropdown);
  for (const text of textNodeLines) {
    addSuggestionTextCandidate(texts, seen, text, context);
  }

  const fallbackLines = extractSuggestionTextFromDropdown(dropdown);
  for (const line of fallbackLines) {
    addSuggestionTextCandidate(texts, seen, line, context);
  }

  return texts;
}

function findElement(selectors, preferredKeyword = '') {
  const candidates = findEditableSearchInputCandidates(selectors);
  if (candidates.length === 0) {
    return null;
  }

  return chooseBestSearchInput(candidates, preferredKeyword);
}

function findEditableSearchInputCandidates(selectors) {
  const seen = new Set();
  const candidates = [];

  for (const sel of selectors) {
    const matches = Array.from(document.querySelectorAll(sel));
    for (const el of matches) {
      const editables = resolveEditableSearchInputs(el);
      for (const editable of editables) {
        if (!editable || seen.has(editable)) {
          continue;
        }
        seen.add(editable);
        candidates.push(editable);
      }
    }
  }

  return candidates;
}

function chooseBestSearchInput(candidates, preferredKeyword = '') {
  const seed = normalizeSuggestionCandidateText(preferredKeyword).toLowerCase();
  const scored = candidates.map((element, index) => ({
    element,
    index,
    score: scoreSearchInputCandidate(element, seed),
  }));

  scored.sort((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    return a.index - b.index;
  });

  return scored[0]?.element || null;
}

function scoreSearchInputCandidate(element, seed = '') {
  const value = readSearchInputValue(element).trim();
  const valueLower = value.toLowerCase();
  const attrs = [
    element.id,
    element.className,
    element.getAttribute?.('name'),
    element.getAttribute?.('role'),
    element.getAttribute?.('aria-label'),
    element.getAttribute?.('placeholder'),
    element.closest?.('[id], [class]')?.id,
    element.closest?.('[id], [class]')?.className,
  ]
    .map((part) => String(part || '').toLowerCase())
    .join(' ');

  let score = 0;
  if (seed && valueLower.includes(seed)) score += 1000;
  if (value) score += 80;
  if (/search|搜索|探索/.test(attrs)) score += 80;
  if (element instanceof HTMLInputElement && element.type === 'search') score += 70;
  if ((element.getAttribute?.('role') || '').toLowerCase() === 'searchbox') {
    score += 60;
  }
  if (isElementVisible(element)) score += 20;
  if (/问点点|ai|chat|聊天|对话|assistant|智能助手/.test(attrs)) {
    score -= seed && valueLower.includes(seed) ? 20 : 320;
  }
  if (!value && /问点点|ai|chat|聊天|对话|assistant|智能助手/.test(attrs)) {
    score -= 180;
  }
  return score;
}

function resolveEditableSearchInput(element) {
  return resolveEditableSearchInputs(element)[0] || null;
}

function resolveEditableSearchInputs(element) {
  if (!element) {
    return [];
  }

  if (isEditableSearchInputElement(element)) {
    return [element];
  }

  if (typeof element.querySelector !== 'function') {
    return [];
  }

  const nestedSelectors = [
    'input[type="search"]',
    'input[role="searchbox"]',
    'input[placeholder*="搜索"]',
    'input[placeholder*="探索"]',
    'input',
    '[contenteditable="true"][role="searchbox"]',
    '[contenteditable="true"][aria-label*="搜索"]',
    '[contenteditable="true"][placeholder*="搜索"]',
    'textarea[role="searchbox"]',
    'textarea[placeholder*="搜索"]',
    'textarea[placeholder*="输入"]',
    'textarea[name="aiSearchTextarea"]',
    'textarea',
    '[contenteditable="true"][role="searchbox"]',
    '[contenteditable="true"][aria-label*="搜索"]',
    '[contenteditable="true"][placeholder*="搜索"]',
    '[contenteditable="true"]',
  ];

  const seen = new Set();
  const editables = [];
  for (const selector of nestedSelectors) {
    const matches = Array.from(element.querySelectorAll(selector));
    for (const nested of matches) {
      if (isEditableSearchInputElement(nested) && !seen.has(nested)) {
        seen.add(nested);
        editables.push(nested);
      }
    }
  }

  return editables;
}

function isEditableSearchInputElement(element) {
  if (!element) {
    return false;
  }

  if (element instanceof HTMLTextAreaElement) {
    return !element.disabled && !element.readOnly;
  }

  if (element instanceof HTMLInputElement) {
    const type = String(element.type || 'text').toLowerCase();
    return (
      !element.disabled &&
      !element.readOnly &&
      !['button', 'checkbox', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(type)
    );
  }

  return isContentEditableInput(element);
}

function writeKeywordExpandDebugInfo(info) {
  try {
    document.documentElement.dataset.onstarvoiceKeywordExpandDebug =
      JSON.stringify({
        ...info,
        writtenAt: new Date().toISOString(),
      });
  } catch {
    // Debug output only; ignore serialization/DOM write failures.
  }
}

function resolveSearchInputHandle(selectors, platform, seedKeyword = '') {
  const realInput = findElement(selectors.searchInput, seedKeyword);
  if (!realInput) {
    return null;
  }

  const hpInput =
    platform === 'xiaohongshu' ? findXhsHpInput(realInput) : null;

  return {
    realInput,
    writeInput: realInput,
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
  context = {},
) {
  let candidates = findAllElements(dropdownSelectors);
  if ((platform === 'douyin' || platform === 'xiaohongshu') && query && anchorElement) {
    const structural = findStructuralSuggestionDropdown(
      query,
      anchorElement,
      platform,
      context,
    );
    if (structural && !candidates.includes(structural)) {
      candidates = [...candidates, structural];
    }

    const nearby = findNearbySuggestionDropdown(
      query,
      anchorElement,
      platform,
      context,
    );
    if (nearby && !candidates.includes(nearby)) {
      candidates = [...candidates, nearby];
    }

  }
  if (candidates.length === 0) {
    return null;
  }

  const scored = candidates
    .map((el) => ({
      el,
      visible: isElementVisible(el),
      itemCount: querySuggestionItems(el, itemSelectors).length,
      textLineCount: estimateSuggestionLineCount(el),
      relevance: scoreDropdownTextRelevance(el, query, context),
      inSearchResults: isInsideSearchResults(el),
      distance: measureDistanceFromAnchor(anchorElement, el),
    }))
    .filter(
      (item) =>
        item.visible &&
        !item.inSearchResults &&
        isWithinSuggestionSearchContext(item.el, anchorElement, platform, {
          query,
          baseKeyword: context.baseKeyword || query,
        }),
    );

  scored.sort((a, b) => {
    if (a.relevance !== b.relevance) {
      return b.relevance - a.relevance;
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
 * 当类名选择器 miss 或误命中搜索结果时，基于结构寻找联想下拉容器。
 * 小红书/抖音新版下拉容器与项常使用随机混淆 class，
 * 没有 data-e2e / suggest / popup 等稳定标识，只能按结构推断：
 *   1. 找到输入框下方 ~600px 内、innerText 以 query 开头的叶子元素
 *   2. 回溯它们的最近共同祖先（包含 ≥2 个候选项的最紧凑容器）
 */
function findStructuralSuggestionDropdown(
  query,
  anchorElement,
  platform = '',
  {
    baseKeyword = '',
  } = {},
) {
  if (!query || !anchorElement) return null;
  // 联想词是拼音/字面混合匹配，item 不一定以 query 字面开头，
  // 但通常会包含种子词。扩词时优先使用调用方传入的 baseKeyword。
  const seed = String(baseKeyword || query).trim();
  if (!seed) return null;
  const seedLower = seed.toLowerCase();
  const anchorRect = anchorElement.getBoundingClientRect();
  const items = [];
  const maxVerticalDistance = platform === 'xiaohongshu' ? 760 : 600;

  const scanned = new Set();
  const scopes = collectSuggestionSearchScopes(anchorElement, platform);
  for (const scope of scopes) {
    const all = scope.querySelectorAll('*');
    for (const el of all) {
      if (scanned.has(el)) continue;
      scanned.add(el);
      if (!(el instanceof HTMLElement)) continue;
      if (el.childElementCount > 4) continue;
      if (!isElementVisible(el)) continue;
      const text = normalizeSuggestionText(el);
      if (!text || text.length > 40) continue;
      if (!isLikelySuggestionCandidate(seedLower, text)) continue;
      const r = el.getBoundingClientRect();
      if (r.top < anchorRect.bottom - 4) continue;
      if (r.top > anchorRect.bottom + maxVerticalDistance) continue;
      if (r.width < 60 || r.height < 16) continue;
      if (isInsideSearchResults(el)) continue;
      if (
        !isWithinSuggestionSearchContext(el, anchorElement, platform, {
          query,
          baseKeyword: seed,
        })
      ) {
        continue;
      }
      items.push(el);
    }
  }

  if (items.length < 2) return null;

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
    if (count < 2) continue;
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

function findNearbySuggestionDropdown(
  query,
  anchorElement,
  platform = '',
  context = {},
) {
  if (!query || !anchorElement) {
    return null;
  }

  const seed = context.baseKeyword || query;
  const candidates = collectNearbyTextCandidates(anchorElement, platform, {
    query,
    baseKeyword: seed,
  }).filter((candidate) => isLikelySuggestionCandidate(seed, candidate.text));
  const elements = [];
  const seen = new Set();

  for (const candidate of candidates) {
    const element = candidate.element;
    if (!(element instanceof HTMLElement) || seen.has(element)) {
      continue;
    }
    seen.add(element);
    elements.push(element);
    if (elements.length >= 12) {
      break;
    }
  }

  if (elements.length === 0) {
    return null;
  }

  if (elements.length === 1) {
    return elements[0].parentElement || elements[0];
  }

  return findCompactCommonSuggestionAncestor(elements, 2);
}

function findCompactCommonSuggestionAncestor(elements, minimumCount = 2) {
  const ancestorCount = new Map();
  for (const element of elements) {
    let parent = element.parentElement;
    let depth = 0;
    while (parent && parent !== document.body && depth < 10) {
      ancestorCount.set(parent, (ancestorCount.get(parent) || 0) + 1);
      parent = parent.parentElement;
      depth++;
    }
  }

  let best = null;
  let bestScore = -1;
  let bestCount = 0;
  for (const [ancestor, count] of ancestorCount) {
    if (count < minimumCount) continue;
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

  return best || elements[0].parentElement || elements[0];
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

function scoreDropdownTextRelevance(dropdown, query, { baseKeyword = '' } = {}) {
  const seed = normalizeSuggestionCandidateText(baseKeyword || query).toLowerCase();
  const fullQuery = normalizeSuggestionCandidateText(query).toLowerCase();
  if (!seed && !fullQuery) {
    return 0;
  }

  const lines = extractSuggestionTextFromDropdown(dropdown)
    .map((line) => normalizeSuggestionCandidateText(line).toLowerCase())
    .filter(Boolean);

  let score = 0;
  for (const line of lines) {
    if (fullQuery && line.startsWith(fullQuery)) {
      score += 8;
    } else if (seed && line.startsWith(seed)) {
      score += 6;
    } else if (fullQuery && line.includes(fullQuery)) {
      score += 4;
    } else if (seed && line.includes(seed)) {
      score += 3;
    }
  }

  return score;
}

function extractFallbackSuggestionsNearInput(query, anchorElement, context = {}) {
  const seen = new Set();
  const texts = [];
  const candidates = [
    ...collectNearbyElementTextCandidates(
      anchorElement,
      context.platform || '',
      {
        query,
        baseKeyword: context.baseKeyword || query,
      },
    ),
    ...collectNearbyTextCandidates(
      anchorElement,
      context.platform || '',
      {
        query,
        baseKeyword: context.baseKeyword || query,
      },
    ),
  ];

  for (const candidate of candidates) {
    const requireQuerySignal =
      !context.preferBaseKeywordSignal &&
      shouldRequireQuerySignal(
        query,
        context.baseKeyword || query,
      );
    const relevanceQuery = requireQuerySignal
      ? query
      : context.baseKeyword || query;
    if (!isLikelySuggestionCandidate(relevanceQuery, candidate.text)) {
      continue;
    }
    addSuggestionTextCandidate(texts, seen, candidate.text, {
      query,
      baseKeyword: context.baseKeyword || query,
      requireQuerySignal,
    });
    if (texts.length >= 12) {
      break;
    }
  }

  return texts;
}

function extractFallbackSuggestionsFromSearchRoot(
  query,
  anchorElement,
  itemSelectors,
  context = {},
) {
  const root =
    findSearchInteractionRoot(anchorElement, context.platform || '') ||
    anchorElement?.closest?.('#search-input') ||
    anchorElement?.parentElement ||
    document.body;
  if (!root) {
    return [];
  }

  const normalizedQuery = normalizeSuggestionCandidateText(query).toLowerCase();
  const seed = context.baseKeyword || query;
  const splitTexts = [];
  for (const text of extractSuggestionTexts(root, itemSelectors, {
    query,
    baseKeyword: seed,
    anchorElement,
    platform: context.platform || '',
  })) {
    splitTexts.push(...splitSuggestionTextBySeed(text, seed));
  }

  return Array.from(new Set(splitTexts)).filter(
    (text) =>
      normalizeSuggestionCandidateText(text).toLowerCase() !== normalizedQuery,
  );
}

function splitSuggestionTextBySeed(text, seedKeyword = '') {
  const normalized = normalizeSuggestionCandidateText(text);
  const seed = normalizeSuggestionCandidateText(seedKeyword);
  if (!normalized || !seed) {
    return normalized ? [normalized] : [];
  }

  const lower = normalized.toLowerCase();
  const seedLower = seed.toLowerCase();
  const positions = [];
  let index = lower.indexOf(seedLower);
  while (index >= 0) {
    positions.push(index);
    index = lower.indexOf(seedLower, index + seedLower.length);
  }

  if (positions.length <= 1) {
    return [normalized];
  }

  return positions
    .map((start, i) => {
      const end = positions[i + 1] ?? normalized.length;
      return normalizeSuggestionCandidateText(normalized.slice(start, end));
    })
    .filter(Boolean);
}

function collectNearbyElementTextCandidates(anchorElement, platform = '', context = {}) {
  if (!anchorElement) {
    return [];
  }

  const anchorRect = anchorElement.getBoundingClientRect();
  const candidates = [];
  const seen = new Set();
  const scopes = collectSuggestionSearchScopes(anchorElement, platform);

  for (const scope of scopes) {
    const elements = Array.from(scope.querySelectorAll('*'));
    for (const element of elements) {
      if (!(element instanceof HTMLElement)) continue;
      if (seen.has(element)) continue;
      seen.add(element);
      if (element.childElementCount > 4) continue;
      if (!isElementVisible(element)) continue;
      if (!isNearbySuggestionRegion(element, anchorRect)) continue;
      if (isInsideSearchResults(element)) continue;
      if (!isDropdownPositionedNearAnchor(element, anchorElement, platform)) {
        continue;
      }

      const text = normalizeSuggestionText(element);
      if (!text || shouldSkipSuggestionText(text)) continue;
      candidates.push({
        text,
        element,
        distance: measureDistanceFromAnchor(anchorElement, element),
      });
    }
  }

  candidates.sort((a, b) => {
    if (a.distance !== b.distance) {
      return a.distance - b.distance;
    }
    return a.text.length - b.text.length;
  });

  return candidates;
}

function extractNearbyTextSample(anchorElement, query, platform = '') {
  return collectNearbyTextCandidates(anchorElement, platform, {
    query,
    baseKeyword: query,
  })
    .filter((candidate) => isPossiblyRelevantNearbyText(query, candidate.text))
    .slice(0, 8)
    .map((candidate) => candidate.text);
}

function extractNearbyElementTextSample(anchorElement, query, platform = '') {
  return collectNearbyElementTextCandidates(anchorElement, platform, {
    query,
    baseKeyword: query,
  })
    .filter((candidate) => isPossiblyRelevantNearbyText(query, candidate.text))
    .slice(0, 8)
    .map((candidate) => candidate.text);
}

function collectNearbyTextCandidates(anchorElement, platform = '', context = {}) {
  if (!anchorElement || typeof document.createTreeWalker !== 'function') {
    return [];
  }

  const anchorRect = anchorElement.getBoundingClientRect();
  const candidates = [];
  const seen = new Set();
  const scopes = collectSuggestionSearchScopes(anchorElement, platform);

  for (const scope of scopes) {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, null);
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
        !isInsideSearchResults(parent) &&
        isWithinSuggestionSearchContext(parent, anchorElement, platform, context)
      ) {
        seen.add(`${parent.tagName}:${text}`);
        candidates.push({
        text,
        element: parent,
        distance: measureDistanceFromAnchor(anchorElement, parent),
      });
      }

      current = walker.nextNode();
    }
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

function resolveSuggestionSearchScope(anchorElement, platform = '') {
  const root = findSearchInteractionRoot(anchorElement, platform);
  return root || document.body;
}

function collectSuggestionSearchScopes(anchorElement, platform = '') {
  const scopes = [];
  const root = findSearchInteractionRoot(anchorElement, platform);
  if (root) {
    scopes.push(root);
  }
  if (document.body && !scopes.includes(document.body)) {
    scopes.push(document.body);
  }
  return scopes.length > 0 ? scopes : [document.body].filter(Boolean);
}

function findSearchInteractionRoot(anchorElement, platform = '') {
  if (!anchorElement || typeof anchorElement.getBoundingClientRect !== 'function') {
    return null;
  }

  const anchorRect = anchorElement.getBoundingClientRect();
  let node = anchorElement.parentElement;
  let bestOverlayRoot = null;

  while (node && node !== document.body && node !== document.documentElement) {
    if (!(node instanceof HTMLElement)) {
      node = node.parentElement;
      continue;
    }

    const rect = node.getBoundingClientRect();
    const canContainDropdown =
      rect.width >= 240 &&
      rect.height >= 120 &&
      rect.top <= anchorRect.top + 12 &&
      rect.bottom >= anchorRect.bottom + 80;
    if (!canContainDropdown) {
      node = node.parentElement;
      continue;
    }

    const attrText = [
      node.id,
      node.className,
      node.getAttribute('role'),
      node.getAttribute('aria-label'),
    ]
      .map((value) => String(value || ''))
      .join(' ');
    const style = window.getComputedStyle(node);
    const zIndex = Number.parseInt(style.zIndex || '0', 10);
    const overlayLike =
      ['fixed', 'absolute', 'sticky'].includes(style.position) ||
      (Number.isFinite(zIndex) && zIndex > 0);
    const searchLike =
      /search|sug|suggest|dropdown|popover|modal|dialog|mask|input|query/i.test(
        attrText,
      );

    if (searchLike && (overlayLike || platform === 'xiaohongshu')) {
      return node;
    }

    if (overlayLike) {
      bestOverlayRoot = node;
    }

    node = node.parentElement;
  }

  return bestOverlayRoot;
}

function isWithinSuggestionSearchContext(
  element,
  anchorElement,
  platform = '',
  context = {},
) {
  if (!element || !anchorElement) {
    return true;
  }

  if (!isDropdownPositionedNearAnchor(element, anchorElement, platform)) {
    return false;
  }

  const root = findSearchInteractionRoot(anchorElement, platform);
  if (!root || root === document.body || root === document.documentElement) {
    return true;
  }

  if (root.contains(element)) {
    return true;
  }

  if (hasSuggestionSurfaceSignal(element)) {
    return true;
  }

  return isLikelyFloatingSuggestionPortal(element, anchorElement, platform, context);
}

function isLikelyFloatingSuggestionPortal(
  element,
  anchorElement,
  platform = '',
  { query = '', baseKeyword = '' } = {},
) {
  if (!(element instanceof HTMLElement) || isInsideSearchResults(element)) {
    return false;
  }

  if (!isDropdownPositionedNearAnchor(element, anchorElement, platform)) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  if (rect.width < 60 || rect.height < 14 || rect.height > 520) {
    return false;
  }

  const seed = normalizeSuggestionCandidateText(baseKeyword || query);
  if (!seed) {
    return false;
  }

  const lines = extractSuggestionTextFromDropdown(element);
  return lines.some((line) => isLikelySuggestionCandidate(seed, line));
}

function isDropdownPositionedNearAnchor(element, anchorElement, platform = '') {
  if (
    !element ||
    !anchorElement ||
    typeof element.getBoundingClientRect !== 'function' ||
    typeof anchorElement.getBoundingClientRect !== 'function'
  ) {
    return true;
  }

  const rect = element.getBoundingClientRect();
  const anchorRect = anchorElement.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    return false;
  }

  const maxTopGap = platform === 'xiaohongshu' ? 760 : 620;
  if (rect.bottom < anchorRect.bottom - 12) {
    return false;
  }
  if (rect.top > anchorRect.bottom + maxTopGap) {
    return false;
  }

  const expandedLeft = anchorRect.left - Math.max(360, anchorRect.width * 0.8);
  const expandedRight =
    anchorRect.right + Math.max(360, anchorRect.width * 1.2);
  return rect.right >= expandedLeft && rect.left <= expandedRight;
}

function hasSuggestionSurfaceSignal(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  const attrText = [
    element.id,
    element.className,
    element.getAttribute('role'),
    element.getAttribute('aria-label'),
  ]
    .map((value) => String(value || ''))
    .join(' ');

  if (
    /sug|suggest|search-suggest|dropdown|popover|autocomplete|auto-complete|listbox|option/i.test(
      attrText,
    )
  ) {
    return true;
  }

  let node = element.parentElement;
  let depth = 0;
  while (node && node !== document.body && depth < 4) {
    const parentAttrs = [
      node.id,
      node.className,
      node.getAttribute?.('role'),
      node.getAttribute?.('aria-label'),
    ]
      .map((value) => String(value || ''))
      .join(' ');
    if (
      /sug|suggest|search-suggest|dropdown|popover|autocomplete|auto-complete|listbox/i.test(
        parentAttrs,
      )
    ) {
      return true;
    }
    node = node.parentElement;
    depth++;
  }

  return false;
}

function isInsideSearchResults(element) {
  if (!element || typeof element.closest !== 'function') {
    return false;
  }

  if (
    element.closest(
      `${SEARCH_RESULT_REGION_SELECTOR}, [data-e2e="scroll-list"]`,
    )
  ) {
    return true;
  }

  let node = element;
  let depth = 0;
  while (node && node !== document.body && depth < 8) {
    if (isLikelyNoteResultContainer(node)) {
      return true;
    }
    node = node.parentElement;
    depth++;
  }

  return false;
}

function isLikelyNoteResultContainer(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  if (hasSuggestionSurfaceSignal(element)) {
    return false;
  }

  const attrText = [
    element.id,
    element.className,
    element.getAttribute('data-v-feed'),
    element.getAttribute('data-e2e'),
  ]
    .map((value) => String(value || ''))
    .join(' ');
  if (/waterfall|feed|note-item|search-result|explore/i.test(attrText)) {
    return true;
  }

  return Boolean(
    element.querySelector?.(NOTE_RESULT_LINK_SELECTOR) ||
      element.querySelector?.(NOTE_RESULT_MEDIA_SELECTOR),
  );
}

function isLikelyNoteMetadataText(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return false;
  }

  return (
    /^(编辑于|发布于|发表于)?\s*\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}/.test(
      normalized,
    ) ||
    /^\d+\s*(秒|分钟|小时|天|周|月|年)前$/.test(normalized) ||
    /^[\w\u3400-\u9fff.-]{1,36}\s*(?:\d{4}-\d{2}-\d{2}|\d+\s*(秒|分钟|小时|天|周|月|年)前)$/.test(
      normalized,
    )
  );
}

function dropdownHasSeedSignal(dropdown, seedKeyword = '') {
  if (!dropdown) {
    return false;
  }

  const seed = normalizeSuggestionCandidateText(seedKeyword).toLowerCase();
  if (!seed) {
    return true;
  }

  const lines = extractSuggestionTextFromDropdown(dropdown)
    .map((line) => normalizeSuggestionCandidateText(line).toLowerCase())
    .filter(Boolean);

  return lines.some((line) => line.includes(seed));
}

function shouldRequireQuerySignal(query, baseKeyword = '') {
  const normalizedQuery = normalizeSuggestionCandidateText(query).toLowerCase();
  const normalizedBase = normalizeSuggestionCandidateText(baseKeyword).toLowerCase();
  return Boolean(
    normalizedQuery &&
      normalizedBase &&
      normalizedQuery !== normalizedBase &&
      normalizedQuery.startsWith(normalizedBase),
  );
}

function isLikelySuggestionCandidate(query, text) {
  const normalizedQuery = normalizeSuggestionCandidateText(query);
  const normalizedText = normalizeSuggestionCandidateText(text);
  if (!normalizedQuery || !normalizedText) {
    return false;
  }
  const queryLower = normalizedQuery.toLowerCase();
  const textLower = normalizedText.toLowerCase();

  if (textLower === queryLower) {
    return false;
  }

  if (/^(搜索|清除|取消|关闭|更多|相关搜索)$/i.test(normalizedText)) {
    return false;
  }

  if (textLower.startsWith(queryLower)) {
    return true;
  }

  if (queryLower.length >= 2 && textLower.includes(queryLower)) {
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
    /^(搜索|搜索小红书|清除|取消|关闭|更多|相关搜索|历史|历史记录|最近|最近搜索|猜你想搜|大家都在搜|清空历史|删除历史记录|删除|综合|笔记|用户|商品|直播|全部|筛选|排序|默认|最热|最新)$/i.test(
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

function addSuggestionTextCandidate(texts, seen, text, context = {}) {
  const normalized = normalizeSuggestionCandidateText(text);
  if (!normalized || seen.has(normalized) || shouldSkipSuggestionText(normalized)) {
    return;
  }
  if (!passesSuggestionTextContext(normalized, context)) {
    return;
  }
  seen.add(normalized);
  texts.push(normalized);
}

function passesSuggestionTextContext(
  text,
  { query = '', baseKeyword = '', requireQuerySignal = false } = {},
) {
  const normalized = normalizeSuggestionCandidateText(text);
  if (!normalized) {
    return false;
  }

  if (isLikelyNoteMetadataText(normalized)) {
    return false;
  }

  const seed = normalizeSuggestionCandidateText(baseKeyword || query);
  if (!seed) {
    return true;
  }

  if (requireQuerySignal) {
    return isLikelySuggestionCandidate(query, normalized);
  }

  return isLikelySuggestionCandidate(seed, normalized);
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
  if (isContentEditableInput(input)) {
    try {
      const range = document.createRange();
      range.selectNodeContents(input);
      range.collapse(false);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    } catch {
      // ignore for non-selectable elements
    }
    return;
  }

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

function resolveRetryDropdownWaitMs(_platform, initialWaitMs = DROPDOWN_WAIT_MS) {
  return Math.min(resolveDelayBetweenMs(initialWaitMs), DROPDOWN_RETRY_WAIT_MS);
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
async function randomDelay(baseMs, onProgress = null) {
  const normalizedBaseMs = resolveDelayBetweenMs(baseMs);
  const jitterLimit = resolveDelayJitterMs(normalizedBaseMs);
  const jitter = jitterLimit > 0
    ? Math.floor(Math.random() * jitterLimit * 2) - jitterLimit
    : 0;
  const ms = Math.max(100, normalizedBaseMs + jitter);
  console.info('[KeywordExpand] Delay before next query', {
    baseMs: normalizedBaseMs,
    jitterMs: jitter,
    waitMs: ms,
  });
  if (typeof onProgress === 'function') {
    onProgress({
      phase: 'keyword_expand_wait',
      delayMs: ms,
      message: `等待 ${(ms / 1000).toFixed(1)} 秒后继续扩词`,
    });
  }
  await waitMs(ms);
}

function resolveDelayJitterMs(baseMs) {
  if (baseMs < 500) {
    return 0;
  }
  return Math.min(DELAY_JITTER_MS, Math.floor(baseMs * 0.25));
}

function resolveDelayBetweenMs(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0
    ? numeric
    : DEFAULT_DELAY_MS;
}

function normalizeSuffixLetters(value) {
  if (!Array.isArray(value)) {
    return LETTERS;
  }

  const normalized = value
    .map((item) => String(item || '').trim())
    .filter((item) => /^[a-z]$/i.test(item))
    .map((item) => item.toLowerCase());

  return normalized.length > 0 ? Array.from(new Set(normalized)) : LETTERS;
}

function waitMs(ms) {
  return waitWithCancel(ms);
}

async function waitForInputSync(input, expectedValue) {
  const startedAt = Date.now();
  const normalizedExpected = String(expectedValue || '');

  while (Date.now() - startedAt < WRITE_SYNC_WAIT_MS) {
    assertNotCanceled();
    if (readSearchInputValue(input) === normalizedExpected) {
      return true;
    }
    await waitMs(WRITE_SYNC_POLL_MS);
  }

  return readSearchInputValue(input) === normalizedExpected;
}

async function ensureCaretAtEnd(input, value) {
  if (!input) {
    return false;
  }

  const normalizedValue = String(value || '');
  for (let i = 0; i < CARET_SETTLE_ATTEMPTS; i++) {
    focusSearchInputAtEnd(input, normalizedValue);

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

async function ensureSearchInputReadyForTyping(input) {
  if (!input) {
    return false;
  }

  const value = readSearchInputValue(input);
  activateSearchInputComponent(input, value);
  await waitMs(40);
  return ensureCaretAtEnd(input, readSearchInputValue(input));
}

function activateSearchInputComponent(input, value = readSearchInputValue(input)) {
  if (!input) {
    return false;
  }

  const normalizedValue = String(value || '');
  const targets = resolveSearchActivationTargets(input);
  for (const target of targets) {
    dispatchMouseActivationSequence(target, input);
  }

  focusSearchInputAtEnd(input, normalizedValue);
  dispatchFocusLifecycleEvents(input);
  moveCaretToEnd(input, normalizedValue);
  return document.activeElement === input;
}

function resolveSearchActivationTargets(input) {
  const targets = [];
  const preferredSelectors = [
    '.textarea-wrapper',
    '.textarea-container',
    '.input-box',
    '[class*="search-input"]',
    '[class*="SearchInput"]',
  ];

  for (const selector of preferredSelectors) {
    const target = input.closest?.(selector);
    if (target instanceof HTMLElement && !targets.includes(target)) {
      targets.push(target);
    }
  }

  let parent = input.parentElement;
  let depth = 0;
  while (parent && parent !== document.body && depth < 3) {
    if (parent instanceof HTMLElement && !targets.includes(parent)) {
      targets.push(parent);
    }
    parent = parent.parentElement;
    depth += 1;
  }

  if (!targets.includes(input)) {
    targets.push(input);
  }

  return targets;
}

function dispatchMouseActivationSequence(target, input) {
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const point = getCaretActivationPoint(input || target);
  const eventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    detail: 1,
    button: 0,
    buttons: 1,
    clientX: point.x,
    clientY: point.y,
    screenX: Math.round(window.screenX + point.x),
    screenY: Math.round(window.screenY + point.y),
  };

  dispatchPointerLikeEvent(target, 'pointerdown', eventInit);
  target.dispatchEvent(new MouseEvent('mousedown', eventInit));
  dispatchPointerLikeEvent(target, 'pointerup', {
    ...eventInit,
    buttons: 0,
  });
  target.dispatchEvent(
    new MouseEvent('mouseup', {
      ...eventInit,
      buttons: 0,
    }),
  );
  target.dispatchEvent(
    new MouseEvent('click', {
      ...eventInit,
      buttons: 0,
    }),
  );
}

function dispatchPointerLikeEvent(target, type, init) {
  try {
    if (typeof PointerEvent === 'function') {
      target.dispatchEvent(
        new PointerEvent(type, {
          ...init,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
        }),
      );
      return;
    }
  } catch {
    // Fall through to mouse event for older browsers/pages.
  }

  target.dispatchEvent(new MouseEvent(type, init));
}

function getCaretActivationPoint(input) {
  const rect =
    typeof input?.getBoundingClientRect === 'function'
      ? input.getBoundingClientRect()
      : null;
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return { x: 0, y: 0 };
  }

  const textEndX = estimateInputTextEndX(input, rect);
  return {
    x: Math.round(Math.min(rect.right - 10, Math.max(rect.left + 10, textEndX))),
    y: Math.round(rect.top + Math.max(12, Math.min(rect.height / 2, 28))),
  };
}

function estimateInputTextEndX(input, rect) {
  try {
    const style = window.getComputedStyle(input);
    const value = readSearchInputValue(input);
    const canvas = estimateInputTextEndX.canvas || document.createElement('canvas');
    estimateInputTextEndX.canvas = canvas;
    const ctx = canvas.getContext('2d');
    ctx.font = style.font || `${style.fontSize || '16px'} ${style.fontFamily || 'sans-serif'}`;
    const paddingLeft = parseFloat(style.paddingLeft || '0') || 0;
    const borderLeft = parseFloat(style.borderLeftWidth || '0') || 0;
    const textWidth = ctx.measureText(value).width;
    return rect.left + borderLeft + paddingLeft + textWidth + 8;
  } catch {
    return rect.left + Math.max(24, rect.width * 0.16);
  }
}

function dispatchFocusLifecycleEvents(input) {
  dispatchFocusEvent(input, 'focusin', true);
  dispatchFocusEvent(input, 'focus', false);
}

function dispatchFocusEvent(input, type, bubbles) {
  try {
    input.dispatchEvent(
      new FocusEvent(type, {
        bubbles,
        cancelable: false,
        composed: true,
        view: window,
      }),
    );
  } catch {
    input.dispatchEvent(new Event(type, { bubbles, composed: true }));
  }
}

function focusSearchInputAtEnd(input, value = readSearchInputValue(input)) {
  if (!input) {
    return false;
  }

  const normalizedValue = String(value || '');

  try {
    window.focus();
  } catch {
    // ignore
  }

  try {
    input.scrollIntoView?.({
      block: 'nearest',
      inline: 'nearest',
      behavior: 'instant',
    });
  } catch {
    // ignore browsers without behavior: instant
    try {
      input.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    } catch {
      // ignore
    }
  }

  try {
    input.focus({ preventScroll: true });
  } catch {
    try {
      input.focus();
    } catch {
      // ignore
    }
  }

  moveCaretToEnd(input, normalizedValue);
  dispatchFocusLifecycleEvents(input);
  input.dispatchEvent(new Event('select', { bubbles: true }));

  return document.activeElement === input;
}

function readSelectionPosition(input) {
  if (isContentEditableInput(input)) {
    const valueLength = readSearchInputValue(input).length;
    const selection = window.getSelection?.();
    if (
      selection &&
      selection.rangeCount > 0 &&
      input.contains(selection.anchorNode) &&
      selection.isCollapsed
    ) {
      return {
        start: valueLength,
        end: valueLength,
      };
    }
    return {
      start: -1,
      end: -1,
    };
  }

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

async function ensureDocumentInteractiveFocus(targetInput = null) {
  assertNotCanceled();
  if (targetInput) {
    await ensureSearchInputReadyForTyping(targetInput);
  }
  return document.hasFocus();
}
