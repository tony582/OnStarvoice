/* TEST ONLY. No real browser tabs, credentials, messages or data are accessible. */
(() => {
  window.addEventListener("error", event => parent.postMessage({type: "sv-ui-report", report: `预览错误：${event.error?.stack || event.message}`}, location.origin));
  const store = {};
  const listeners = new Set();
  const params = new URLSearchParams(location.search);
  const platform = params.get("platform") || "xiaohongshu";
  const fixtureUrl = platform === "douyin" ? "https://www.douyin.com/search/新能源汽车" : platform === "weibo" ? "https://s.weibo.com/weibo?q=新能源汽车" : "https://www.xiaohongshu.com/search_result?keyword=新能源汽车";
  const runtime = {platform, selectedPlatform: platform, pageType: "search_results", lastPageUrl: fixtureUrl, lastActiveTabId: 1, detailReady: true};
  store["onstarvoice.runtime"] = runtime;
  const fakeTabs = [{id: 1, url: fixtureUrl, title: "新能源汽车 · 验收数据", active: true}];
  window.chrome = {
    runtime: {
      getManifest: () => ({version: "0.4.23 · 界面验收"}),
      getURL: p => new URL("/" + p, location.origin).href,
      sendMessage: async message => message.type === "onstarvoice:get-extension-state" ? {ok: true, data: runtime} : message.type === "onstarvoice:get-task-ledger" ? {ok: true, data: store["onstarvoice.taskLedger"] || {runs: []}} : {ok: true, data: {pageType: "search_results"}},
      onMessage: {addListener() {}, removeListener() {}},
    },
    tabs: {query: async () => fakeTabs, get: async () => fakeTabs[0], sendMessage: async () => ({ok: true, data: {pageType: "search_results"}})},
    storage: {
      local: {
        get: async keys => keys == null ? {...store} : Object.fromEntries((Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys)).map(key => [key, store[key]])),
        set: async items => {
          const changes = {};
          for (const [key, newValue] of Object.entries(items)) { changes[key] = {oldValue: store[key], newValue}; store[key] = structuredClone(newValue); }
          listeners.forEach(fn => fn(changes, "local"));
        },
        remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key]; },
        getBytesInUse: async () => 0,
      },
      onChanged: {addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn)},
    },
  };
  document.documentElement.dataset.uiRehearsal = "true";
})();
