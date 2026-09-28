(function (root) {
  'use strict';
  const STORAGE_KEY = 'onstarvoice.taskHomeCleanup.v1';
  const HOMES = Object.freeze({
    douyin: 'https://www.douyin.com/',
    xiaohongshu: 'https://www.xiaohongshu.com/explore',
    weibo: 'https://weibo.com/',
  });
  const id = value => Number.isSafeInteger(value) && value > 0 ? value : null;
  function isHome(url, platform) {
    try {
      const live = new URL(url), home = new URL(HOMES[platform]);
      return live.origin === home.origin && live.pathname.replace(/\/$/, '') === home.pathname.replace(/\/$/, '') &&
        !live.search && !live.hash;
    } catch { return false; }
  }
  function isPlanSearch(url, platform, keywords = []) {
    try {
      const live = new URL(url), home = new URL(HOMES[platform]);
      if (live.origin !== home.origin && !(platform === 'weibo' && live.origin === 'https://s.weibo.com')) return false;
      if (live.searchParams.has('modal_id')) return false;
      let keyword = '';
      if (platform === 'douyin' && /^\/(?:jingxuan\/)?search\/[^/]+\/?$/.test(live.pathname)) {
        keyword = decodeURIComponent(live.pathname.replace(/^\/(?:jingxuan\/)?search\//, '').replace(/\/$/, ''));
      } else if (platform === 'xiaohongshu' && live.pathname === '/search_result') {
        keyword = live.searchParams.get('keyword') || '';
      } else if (platform === 'weibo' && live.pathname === '/weibo') {
        keyword = live.searchParams.get('q') || '';
      }
      return Boolean(keyword && keywords.includes(keyword));
    } catch { return false; }
  }
  // This queue carries only UI cleanup, never work or retries of collection.
  // Callers enqueue after their exact task's producer/upload/stop handshake.
  function createController({storage, tabs, canPark}) {
    let tail = Promise.resolve();
    // A persisted tab id is not navigation authority after browser/worker
    // restart. Fresh successful task cleanup grants it only in this instance.
    const freshSources = new Set();
    const serial = fn => { const next = tail.then(fn, fn); tail = next.catch(() => {}); return next; };
    const read = async () => (await storage.get(STORAGE_KEY))[STORAGE_KEY] || {};
    const write = entries => storage.set({[STORAGE_KEY]: entries});
    async function park(entry) {
      if (!await canPark(entry)) return {parked: false, reason: 'capture_active'};
      const pages = await tabs.query({windowId: entry.windowId});
      if (!pages.length) return {parked: false, settled: true, reason: 'window_closed'};
      const source = freshSources.has(entry.identity) && pages.find(tab => tab.id === entry.sourceTabId &&
        (tab.pendingUrl || tab.url) === entry.expectedSourceUrl);
      const foreground = pages.find(tab => tab.active);
      const activate = Boolean(foreground && (foreground.id === entry.runnerTabId || foreground.id === source?.id));
      if (source && isPlanSearch(entry.expectedSourceUrl, entry.platform, entry.keywords)) {
        if (!await canPark(entry)) return {parked: false, reason: 'capture_active'};
        const live = await tabs.get(source.id);
        if ((live.pendingUrl || live.url) !== entry.expectedSourceUrl || live.windowId !== entry.windowId) {
          return {parked: false, settled: true, reason: 'source_navigated'};
        }
        await tabs.update(source.id, {url: HOMES[entry.platform], ...(activate ? {active: true} : {})});
        return {parked: true, settled: true, tabId: source.id};
      }
      const home = pages.find(tab => isHome(tab.pendingUrl || tab.url, entry.platform));
      if (home) {
        // A tab can navigate while the idle check is awaiting storage.
        if (!await canPark(entry)) return {parked: false, reason: 'capture_active'};
        const live = await tabs.get(home.id);
        if (!isHome(live.pendingUrl || live.url, entry.platform) || live.windowId !== entry.windowId) {
          return {parked: false, reason: 'home_navigated'};
        }
        if (activate) await tabs.update(home.id, {active: true});
        return {parked: true, settled: true, tabId: home.id};
      }
      if (!await canPark(entry)) return {parked: false, reason: 'capture_active'};
      const homeTab = await tabs.create({windowId: entry.windowId, url: HOMES[entry.platform], active: activate});
      return {parked: Boolean(id(homeTab?.id)), settled: Boolean(id(homeTab?.id)), tabId: homeTab?.id};
    }
    return {
      enqueue: value => serial(async () => {
        if (!value?.identity || !HOMES[value.platform] || !id(value.windowId)) return false;
        const entries = await read();
        const key = `${value.windowId}:${value.platform}`;
        // One pending home per platform/window. A newer finished task replaces
        // the older cosmetic request; task evidence itself is never pruned here.
        entries[key] = {
          identity: String(value.identity), platform: value.platform, windowId: value.windowId,
          runnerTabId: id(value.runnerTabId), sourceTabId: id(value.sourceTabId),
          expectedSourceUrl: String(value.expectedSourceUrl || ''),
          keywords: Array.isArray(value.keywords) ? value.keywords.filter(x => typeof x === 'string') : [],
        };
        await write(entries);
        freshSources.add(String(value.identity));
        return true;
      }),
      reconcile: () => serial(async () => {
        const entries = await read(), results = [];
        for (const [key, entry] of Object.entries(entries)) {
          if (!entry?.identity || !HOMES[entry.platform] || !id(entry.windowId)) continue;
          let result;
          try { result = await park(entry); }
          catch (error) { result = {parked: false, reason: 'home_cleanup_pending', error: String(error.message || error)}; }
          results.push({...result, identity: entry.identity});
          if (result.settled) { freshSources.delete(entry.identity); delete entries[key]; await write(entries); }
        }
        return results;
      }),
      forgetTab: tabId => serial(async () => {
        const entries = await read();
        for (const entry of Object.values(entries)) {
          if (entry.sourceTabId === tabId) freshSources.delete(entry.identity);
        }
      }),
    };
  }
  root.OnStarvoiceTaskHomeCleanup = Object.freeze({STORAGE_KEY, HOMES, isHome, isPlanSearch, createController});
})(globalThis);
