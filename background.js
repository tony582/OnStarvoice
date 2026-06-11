const STORAGE_KEYS = {
  runtime: 'onstarvoice.runtime',
};

const DEFAULT_RUNTIME = {
  clientUuid: '',
  clientLabel: '',
  appVersion: '',
  platform: 'unknown',
  pageType: 'unknown',
  lastActiveTabId: null,
  lastCaptureProgress: null,
  lastPageUrl: '',
};

const PLATFORM_HOME_URLS = Object.freeze({
  xiaohongshu: 'https://www.xiaohongshu.com/explore?channel_id=homefeed_recommend',
  douyin: 'https://www.douyin.com/jingxuan',
  weibo: 'https://s.weibo.com/weibo',
});
const SIDEBAR_PAGE_PATH = 'sidebar/sidebar.html';

function createUuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const rand = Math.floor(Math.random() * 16);
    const value = char === 'x' ? rand : (rand & 0x3) | 0x8;
    return value.toString(16);
  });
}

function getPlatformLabel() {
  const ua = navigator.userAgent || '';
  const browser = ua.includes('Edg/')
    ? 'Edge'
    : ua.includes('Chrome/')
      ? 'Chrome'
      : 'Browser';
  const os = ua.includes('Mac OS X')
    ? 'macOS'
    : ua.includes('Windows')
      ? 'Windows'
      : ua.includes('Linux')
        ? 'Linux'
        : 'Unknown OS';

  return `${browser} on ${os}`;
}

function getAppVersion() {
  return chrome.runtime.getManifest().version;
}

function normalizePlatformId(platform) {
  const normalized = String(platform || '').trim().toLowerCase();
  if (normalized === 'xiaohongshu' || normalized === 'douyin' || normalized === 'weibo') {
    return normalized;
  }
  return 'unknown';
}

function getPlatformHomeUrl(platform) {
  const normalized = normalizePlatformId(platform);
  return PLATFORM_HOME_URLS[normalized] || '';
}

async function readRuntimeState() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.runtime);
  const value = stored[STORAGE_KEYS.runtime];

  return {
    ...DEFAULT_RUNTIME,
    ...(value && typeof value === 'object' ? value : {}),
  };
}

async function writeRuntimeState(patch) {
  const current = await readRuntimeState();
  const next = {
    ...current,
    ...patch,
  };

  await chrome.storage.local.set({
    [STORAGE_KEYS.runtime]: next,
  });

  return next;
}

async function ensureRuntimeState() {
  const current = await readRuntimeState();
  const nextPatch = {};

  if (!current.clientUuid) {
    nextPatch.clientUuid = createUuid();
  }

  if (!current.clientLabel) {
    nextPatch.clientLabel = getPlatformLabel();
  }

  if (!current.appVersion) {
    nextPatch.appVersion = getAppVersion();
  }

  if (Object.keys(nextPatch).length === 0) {
    return current;
  }

  return writeRuntimeState(nextPatch);
}

async function openSidePanelForTab(tabId) {
  if (typeof tabId !== 'number') {
    throw new Error('invalid tabId');
  }

  if (chrome.sidePanel && typeof chrome.sidePanel.open === 'function') {
    await chrome.sidePanel.open({ tabId });
    await writeRuntimeState({ lastActiveTabId: tabId });
    return { tabId, mode: 'side_panel' };
  }

  const sidebarUrl = chrome.runtime.getURL(SIDEBAR_PAGE_PATH);
  const tabs = await chrome.tabs.query({});
  const existingSidebarTab = tabs.find((tab) => {
    const currentUrl = String(tab?.url || '');
    return (
      currentUrl === sidebarUrl
      || currentUrl.startsWith(`${sidebarUrl}?`)
      || currentUrl.startsWith(`${sidebarUrl}#`)
    );
  });

  if (existingSidebarTab?.id) {
    if (typeof existingSidebarTab.windowId === 'number' && existingSidebarTab.windowId >= 0) {
      await chrome.windows.update(existingSidebarTab.windowId, { focused: true });
    }
    await chrome.tabs.update(existingSidebarTab.id, { active: true });
    await writeRuntimeState({ lastActiveTabId: tabId });
    return {
      tabId,
      mode: 'sidebar_tab_existing',
      sidebarTabId: existingSidebarTab.id,
      sidebarUrl,
    };
  }

  const createdSidebarTab = await chrome.tabs.create({ url: sidebarUrl, active: true });
  if (!createdSidebarTab?.id) {
    throw new Error('failed to open sidebar fallback tab');
  }

  await writeRuntimeState({ lastActiveTabId: tabId });
  return {
    tabId,
    mode: 'sidebar_tab_created',
    sidebarTabId: createdSidebarTab.id,
    sidebarUrl: createdSidebarTab.url || sidebarUrl,
  };
}

async function findExistingPlatformTab(platform) {
  const normalizedPlatform = normalizePlatformId(platform);
  if (normalizedPlatform === 'unknown') {
    return null;
  }

  const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const currentWindowId = currentTab?.windowId ?? chrome.windows.WINDOW_ID_NONE;
  const allTabs = await chrome.tabs.query({});
  const candidates = allTabs.filter((tab) => detectPlatformFromUrl(tab?.url || '') === normalizedPlatform);

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((left, right) => {
    const leftCurrentWindowScore = left.windowId === currentWindowId ? 1 : 0;
    const rightCurrentWindowScore = right.windowId === currentWindowId ? 1 : 0;
    if (leftCurrentWindowScore !== rightCurrentWindowScore) {
      return rightCurrentWindowScore - leftCurrentWindowScore;
    }

    const leftActiveScore = left.active ? 1 : 0;
    const rightActiveScore = right.active ? 1 : 0;
    if (leftActiveScore !== rightActiveScore) {
      return rightActiveScore - leftActiveScore;
    }

    return (right.id || 0) - (left.id || 0);
  });

  return candidates[0] || null;
}

async function activateOrCreatePlatformTab(platform) {
  const normalizedPlatform = normalizePlatformId(platform);
  const homeUrl = getPlatformHomeUrl(normalizedPlatform);
  if (!homeUrl) {
    throw new Error('unsupported platform');
  }

  const existingTab = await findExistingPlatformTab(normalizedPlatform);
  if (existingTab?.id) {
    if (typeof existingTab.windowId === 'number' && existingTab.windowId >= 0) {
      await chrome.windows.update(existingTab.windowId, { focused: true });
    }
    const activatedTab = await chrome.tabs.update(existingTab.id, { active: true });
    await syncRuntimeForTabId(existingTab.id, activatedTab?.url || existingTab.url || '');
    return {
      tabId: existingTab.id,
      url: activatedTab?.url || existingTab.url || '',
      platform: normalizedPlatform,
      created: false,
    };
  }

  const createdTab = await chrome.tabs.create({
    url: homeUrl,
    active: true,
  });
  if (!createdTab?.id) {
    throw new Error('failed to open platform tab');
  }

  await syncRuntimeForTabId(createdTab.id, createdTab.url || homeUrl);
  return {
    tabId: createdTab.id,
    url: createdTab.url || homeUrl,
    platform: normalizedPlatform,
    created: true,
  };
}

function isTransientContentRelayError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  return (
    /Receiving end does not exist/i.test(message)
    || /The message port closed before a response was received/i.test(message)
    || /message channel closed before a response was received/i.test(message)
    || /Extension context invalidated/i.test(message)
    || /Frame with ID 0 was removed/i.test(message)
  );
}

async function waitForTabReady(tabId, {
  timeoutMs = 10000,
  pollMs = 150,
} = {}) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (String(tab?.status || '') === 'complete') {
      return tab;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  return await chrome.tabs.get(tabId);
}

function isSupportedCaptureUrl(url) {
  const normalized = String(url || '');
  return (
    /^https?:\/\/www\.xiaohongshu\.com\//i.test(normalized) ||
    /^https?:\/\/www\.douyin\.com\//i.test(normalized) ||
    /^https?:\/\/v\.douyin\.com\//i.test(normalized) ||
    /^https?:\/\/(?:www\.)?weibo\.com\//i.test(normalized) ||
    /^https?:\/\/s\.weibo\.com\//i.test(normalized)
  );
}

function detectPlatformFromUrl(url) {
  const normalized = String(url || '').trim().toLowerCase();
  if (!normalized) return 'unknown';
  if (/^https?:\/\/(?:www\.)?xiaohongshu\.com\//i.test(normalized)) {
    return 'xiaohongshu';
  }
  if (
    /^https?:\/\/(?:www\.)?douyin\.com\//i.test(normalized) ||
    /^https?:\/\/v\.douyin\.com\//i.test(normalized)
  ) {
    return 'douyin';
  }
  if (
    /^https?:\/\/(?:www\.)?weibo\.com\//i.test(normalized) ||
    /^https?:\/\/s\.weibo\.com\//i.test(normalized)
  ) {
    return 'weibo';
  }
  return 'unknown';
}

const DOUYIN_SEARCH_QUERY_KEYS = new Set([
  'keyword',
  'query',
  'q',
  'search_keyword',
  'searchkey',
  'search_word',
]);

function hasDouyinSearchKeywordParam(parsedUrl) {
  if (!parsedUrl?.searchParams) return false;

  for (const [key, value] of parsedUrl.searchParams.entries()) {
    const normalizedKey = String(key || '').trim().toLowerCase();
    if (!DOUYIN_SEARCH_QUERY_KEYS.has(normalizedKey)) {
      continue;
    }
    if (String(value || '').trim()) {
      return true;
    }
  }

  return false;
}

function detectPageTypeFromUrl(url) {
  const rawUrl = String(url || '').trim();
  const normalized = rawUrl.toLowerCase();
  if (!normalized) return 'unknown';

  if (/xiaohongshu\.com/i.test(normalized)) {
    if (/\/(?:explore|video)\/[a-z0-9_-]+/i.test(normalized)) return 'note_detail';
    if (/\/user\/profile\/[a-z0-9]+/i.test(normalized)) return 'blogger_profile';
    if (
      /\/search_result/i.test(normalized) ||
      /\/web\/search_result/i.test(normalized) ||
      /[?&]keyword=/i.test(normalized)
    ) {
      return 'search_results';
    }
  }

  if (/douyin\.com/i.test(normalized)) {
    let parsedUrl = null;
    let pathname = '';
    try {
      parsedUrl = new URL(rawUrl);
      pathname = String(parsedUrl.pathname || '').toLowerCase();
    } catch {
      pathname = '';
    }

    if (/\/(?:video|note)\/\d+/i.test(normalized) || /[?&]modal_id=/i.test(normalized)) {
      return 'note_detail';
    }
    if (/\/user\/[a-z0-9._-]+/i.test(normalized)) return 'blogger_profile';
    if (
      pathname.startsWith('/jingxuan/search') ||
      pathname.startsWith('/search/') ||
      pathname === '/jingxuan' ||
      pathname === '/jingxuan/'
    ) {
      return 'search_results';
    }
    if (hasDouyinSearchKeywordParam(parsedUrl)) {
      return 'search_results';
    }
    if (
      /\/jingxuan(?:\/search)?(?:[/?#]|$)/i.test(normalized) ||
      /\/search\//i.test(normalized)
    ) {
      return 'search_results';
    }
  }

  if (/(^|\/\/)(?:www\.)?weibo\.com|(^|\/\/)s\.weibo\.com/i.test(normalized)) {
    let parsedUrl = null;
    let pathname = '';
    try {
      parsedUrl = new URL(rawUrl);
      pathname = String(parsedUrl.pathname || '').toLowerCase();
    } catch {
      pathname = '';
    }

    if (/s\.weibo\.com/i.test(normalized)) {
      return 'search_results';
    }
    if (pathname.includes('/search') || parsedUrl?.searchParams?.get('q')) {
      return 'search_results';
    }
    if (/^\/u\/\d+\/?$/i.test(pathname)) {
      return 'blogger_profile';
    }
    if (/^\/detail\/\d+\/?$/i.test(pathname)) {
      return 'note_detail';
    }
    if (/^\/[a-z0-9_]+\/[a-z0-9]+\/?$/i.test(pathname)) {
      return 'note_detail';
    }
  }

  return 'unknown';
}

async function syncRuntimeForTabId(tabId, explicitUrl = '') {
  if (typeof tabId !== 'number') return null;

  const tab = await chrome.tabs.get(tabId);
  const url = String(explicitUrl || tab?.url || '').trim();
  if (!url) return null;

  return await writeRuntimeState({
    lastActiveTabId: tabId,
    lastPageUrl: url,
    platform: detectPlatformFromUrl(url),
    pageType: detectPageTypeFromUrl(url),
  });
}

async function ensureContentScriptReady(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!isSupportedCaptureUrl(tab?.url)) {
    throw new Error('当前页面不支持采集，请切换到小红书、抖音或微博页面后重试');
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content-loader.js'],
  });
}

async function relayToContentWithRetry(tabId, payload) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, payload ?? {});
    } catch (error) {
      if (!isTransientContentRelayError(error) || attempt === 1) {
        throw error;
      }

      await waitForTabReady(tabId).catch(() => null);
      await ensureContentScriptReady(tabId);
      await new Promise((resolve) => setTimeout(resolve, 160));
    }
  }

  throw new Error('failed to relay message to content script');
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    chrome.storage.local.remove('onstarvoice.riskNoticeAcknowledged').catch(() => {});
  }
  ensureRuntimeState().catch((error) => {
    console.error('[onstarvoice] failed to initialize runtime on install', error);
  });
});

chrome.runtime.onStartup.addListener(() => {
  ensureRuntimeState().catch((error) => {
    console.error('[onstarvoice] failed to initialize runtime on startup', error);
  });
});

chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id) return;

  openSidePanelForTab(tab.id).catch((error) => {
    console.error('[onstarvoice] failed to open side panel', error);
  });
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  syncRuntimeForTabId(tabId).catch((error) => {
    console.warn('[onstarvoice] failed to sync runtime on tab activation', error);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab?.active) return;
  if (!changeInfo.url && changeInfo.status !== 'complete') return;

  syncRuntimeForTabId(tabId, changeInfo.url || tab.url || '').catch((error) => {
    console.warn('[onstarvoice] failed to sync runtime on tab update', error);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const action = message?.action;
  const type = message?.type;

  if (action === 'captureProgress' || action === 'pageLoaded' || action === 'pageChanged') {
    (async () => {
      try {
        if (action === 'captureProgress') {
          const next = await writeRuntimeState({
            lastActiveTabId: sender?.tab?.id ?? null,
            lastCaptureProgress: message?.progress ?? null,
          });

          sendResponse({
            ok: true,
            data: {
              lastCaptureProgress: next.lastCaptureProgress,
            },
          });
          return;
        }

        const next = await writeRuntimeState({
          lastActiveTabId: sender?.tab?.id ?? null,
          lastPageUrl: message?.url ?? '',
          platform: message?.platform || detectPlatformFromUrl(message?.url ?? sender?.tab?.url ?? ''),
          pageType: message?.pageType || 'unknown',
        });

        sendResponse({
          ok: true,
          data: {
            platform: next.platform,
            pageType: next.pageType,
            lastPageUrl: next.lastPageUrl,
          },
        });
      } catch (error) {
        sendResponse({
          ok: false,
          error: {
            code: 'runtime_error',
            message: error instanceof Error ? error.message : 'unknown runtime error',
          },
        });
      }
    })();

    return true;
  }

  if (!type) {
    return false;
  }

  (async () => {
    try {
      if (type === 'onstarvoice:open-side-panel') {
        const tabId = message?.tabId ?? sender?.tab?.id;
        const data = await openSidePanelForTab(tabId);
        sendResponse({ ok: true, data });
        return;
      }

      if (type === 'onstarvoice:get-client-env') {
        const runtime = await ensureRuntimeState();
        sendResponse({
          ok: true,
          data: {
            clientUuid: runtime.clientUuid,
            clientLabel: runtime.clientLabel,
            appVersion: getAppVersion(),
          },
        });
        return;
      }

      if (type === 'onstarvoice:get-extension-state') {
        const runtime = await ensureRuntimeState();
        sendResponse({
          ok: true,
          data: runtime,
        });
        return;
      }

      if (type === 'onstarvoice:switch-platform-tab') {
        const data = await activateOrCreatePlatformTab(message?.platform);
        sendResponse({ ok: true, data });
        return;
      }

      if (type === 'onstarvoice:capture-progress') {
        const next = await writeRuntimeState({
          lastActiveTabId: sender?.tab?.id ?? null,
          lastCaptureProgress: message?.payload ?? null,
        });
        sendResponse({
          ok: true,
          data: {
            lastCaptureProgress: next.lastCaptureProgress,
          },
        });
        return;
      }

      if (type === 'onstarvoice:relay-to-content') {
        const tabId = message?.tabId;
        if (typeof tabId !== 'number') {
          throw new Error('invalid tabId');
        }

        const response = await relayToContentWithRetry(
          tabId,
          message?.payload ?? {},
        );
        await writeRuntimeState({ lastActiveTabId: tabId });
        sendResponse({ ok: true, data: response ?? null });
        return;
      }

      sendResponse({
        ok: false,
        error: {
          code: 'unsupported_message',
          message: `unsupported message type: ${type}`,
        },
      });
    } catch (error) {
      sendResponse({
        ok: false,
        error: {
          code: 'runtime_error',
          message: error instanceof Error ? error.message : 'unknown runtime error',
        },
      });
    }
  })();

  return true;
});
