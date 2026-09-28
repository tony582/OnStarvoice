(function (root) {
  'use strict';
  const STORAGE_KEY = 'onstarvoice.taskWindowSources.v1';
  const MAX_WINDOWS = 32, MAX_SOURCES = 64, RETIRED_LIMIT = 16;
  const PROBE_CONCURRENCY = 8, PROBE_BUDGET_MS = 1000;
  const origins = {douyin: 'https://www.douyin.com', xiaohongshu: 'https://www.xiaohongshu.com', weibo: 'https://weibo.com'};
  const text = value => typeof value === 'string' ? value.trim() : '';
  const id = value => Number.isSafeInteger(value) && value > 0;
  const denied = known => ({sources: [], keywords: [], known, blocked: true});
  function route(value, platform) {
    try {
      if (!origins[platform] || typeof value !== 'string' || value.length > 8192 || value.includes('#')) return null;
      const url = new URL(value), pathname = url.pathname.replace(/\/$/, '');
      if (url.protocol !== 'https:' || url.username || url.password || url.searchParams.has('modal_id')) return null;
      const sameOrigin = url.origin === origins[platform];
      const home = sameOrigin && !url.search && (platform === 'douyin' ? ['', '/jingxuan'].includes(pathname)
        : platform === 'xiaohongshu' ? pathname === '/explore' : pathname === '');
      if (home) return {keyword: ''};
      let keyword = '';
      if (sameOrigin && platform === 'douyin' && /^\/(?:jingxuan\/)?search\/[^/]+$/.test(pathname)) {
        keyword = decodeURIComponent(pathname.replace(/^\/(?:jingxuan\/)?search\//, ''));
      } else if (sameOrigin && platform === 'xiaohongshu' && pathname === '/search_result'
          && url.searchParams.getAll('keyword').length === 1) {
        keyword = url.searchParams.get('keyword');
      } else if (platform === 'weibo' && url.origin === 'https://s.weibo.com' && pathname === '/weibo'
          && url.searchParams.getAll('q').length === 1) {
        keyword = url.searchParams.get('q');
      }
      return keyword && keyword.length <= 512 ? {keyword} : null;
    } catch { return null; }
  }
  // Call only after background validates a real managed task. The small retired
  // list blocks recent replay; background remains authority for older begin calls.
  function createController({storage, tabs, getDocumentIdentity, getSessionId} = {}) {
    let tail = Promise.resolve();
    const serial = operation => {
      const next = tail.then(operation, operation);
      tail = next.catch(() => {}); return next;
    };
    const session = async () => storage?.get && storage?.set && typeof getSessionId === 'function'
      ? text(await getSessionId()) : '';
    const read = async sessionId => {
      const value = (await storage.get(STORAGE_KEY))[STORAGE_KEY];
      return value?.sessionId === sessionId && Array.isArray(value.entries)
        ? value : {sessionId, entries: []};
    };
    const write = state => storage.set({[STORAGE_KEY]: state});
    const matches = (entry, owner) => entry.platform === owner.platform && entry.identity === owner.identity;
    const result = (state, owner) => {
      const entries = state.entries.filter(entry => matches(entry, owner));
      const superseded = state.entries.some(entry => entry.platform === owner.platform && entry.retired?.includes(owner.identity));
      if (!entries.length || superseded) return denied(superseded || state.entries.some(entry => entry.platform === owner.platform));
      const sources = entries.flatMap(entry => entry.sources.map(source => ({...source})));
      // Empty-document rows still matter: they block creation in the cleanup
      // queue but may be replaced by newer, authenticated same-tab task proof.
      return {sources, keywords: [...new Set(entries.flatMap(entry => entry.keywords))], known: true,
        blocked: entries.some(entry => entry.blocked) || sources.some(source => source.windowSessionId !== state.sessionId)};
    };
    const valid = owner => text(owner?.identity) && owner.identity.length <= 512 && Boolean(origins[owner.platform]);
    async function queryWindow(windowId) {
      let timer;
      try {
        return await Promise.race([tabs.query({windowId}),
          new Promise(resolve => { timer = setTimeout(() => resolve(null), PROBE_BUDGET_MS); })]);
      } finally { clearTimeout(timer); }
    }
    async function probe(sources, platform, isCanceled) {
      let stopped = false, cursor = 0, timer;
      const proofs = new Map();
      const current = () => !stopped && !isCanceled();
      const stable = (tab, source) => tab?.id === source.sourceTabId && tab.windowId === source.windowId &&
        tab.url === source.expectedSourceUrl && !tab.pendingUrl && tab.status !== 'loading' &&
        tab.discarded !== true && tab.frozen !== true && route(tab.url, platform);
      const worker = async () => {
        while (current() && cursor < sources.length) {
          const source = sources[cursor++];
          try {
            const before = await tabs.get(source.sourceTabId);
            if (!current() || !stable(before, source)) continue;
            const proof = await getDocumentIdentity(source.sourceTabId);
            if (!current() || proof?.safeForCleanup !== true || !text(proof.documentId) ||
              proof.url !== source.expectedSourceUrl || proof.windowId !== source.windowId) continue;
            const after = await tabs.get(source.sourceTabId);
            if (current() && stable(after, source)) proofs.set(source.sourceTabId, text(proof.documentId));
          } catch { /* Keep an unproven placeholder, never manufacture permission. */ }
        }
      };
      try {
        await Promise.race([
          Promise.all(Array.from({length: Math.min(PROBE_CONCURRENCY, sources.length)}, worker)),
          new Promise(resolve => { timer = setTimeout(resolve, PROBE_BUDGET_MS); }),
        ]);
      } finally { stopped = true; clearTimeout(timer); }
      return sources.map(source => ({...source, documentId: proofs.get(source.sourceTabId) || ''}));
    }
    return {
      begin: (owner, {isCanceled = () => false} = {}) => serial(async () => {
        try {
          if (!valid(owner) || !id(owner.windowId) || isCanceled()) return denied(false);
          const sessionId = await session();
          if (!sessionId || isCanceled()) return denied(false);
          let state = await read(sessionId);
          if (isCanceled()) return denied(false);
          const previous = state.entries.find(entry => entry.windowId === owner.windowId && entry.platform === owner.platform);
          if (previous?.identity === owner.identity) return result(state, owner);
          if (previous?.retired?.includes(owner.identity)) return denied(true);
          if (!previous && state.entries.length >= MAX_WINDOWS) return denied(false);
          const entry = {identity: owner.identity, platform: owner.platform, windowId: owner.windowId,
            generation: (previous?.generation || 0) + 1, sources: [], keywords: [], blocked: true,
            retired: previous ? [...new Set([previous.identity, ...(previous.retired || [])])].slice(0, RETIRED_LIMIT) : []};
          state.entries = state.entries.filter(value => value !== previous); state.entries.push(entry);
          // Reserve the first observation before browser awaits. A restart or a
          // repeated same-task begin must not refresh unknown document evidence.
          if (isCanceled() || await session() !== sessionId) return denied(false);
          await write(state);
          const pages = await queryWindow(owner.windowId);
          if (isCanceled() || !Array.isArray(pages)) return denied(true);
          const excluded = new Set((owner.excludeTabIds || []).filter(id));
          const candidates = pages.filter(tab => id(tab.id) && tab.windowId === owner.windowId && !excluded.has(tab.id))
            .map(tab => ({tab, eligible: route(tab.url, owner.platform) || route(tab.pendingUrl, owner.platform)}))
            .filter(candidate => candidate.eligible);
          const sources = candidates.slice(0, MAX_SOURCES).map(({tab}) => ({sourceTabId: tab.id,
            windowId: owner.windowId, expectedSourceUrl: route(tab.url, owner.platform) ? tab.url : tab.pendingUrl,
            documentId: '', createdByTask: false, windowSessionId: sessionId}));
          const keywords = [...new Set(candidates.slice(0, MAX_SOURCES).map(value => value.eligible.keyword).filter(Boolean))];
          // Persist all placeholders before probing. Probes run concurrently with
          // one shared deadline, and late results cannot mutate these saved rows.
          entry.sources = sources; entry.keywords = keywords; entry.blocked = candidates.length > MAX_SOURCES;
          if (isCanceled() || await session() !== sessionId) return denied(true);
          await write(state);
          const proved = await probe(sources, owner.platform, isCanceled);
          if (isCanceled() || await session() !== sessionId) return denied(true);
          state = await read(sessionId);
          const latest = state.entries.find(value => value.windowId === owner.windowId && value.platform === owner.platform);
          if (latest?.identity !== owner.identity || latest.generation !== entry.generation || isCanceled()) return denied(true);
          latest.sources = proved;
          if (isCanceled()) return denied(true);
          await write(state);
          return result(state, owner);
        } catch { return denied(false); }
      }),
      get: owner => serial(async () => {
        try {
          if (!valid(owner)) return denied(false);
          const sessionId = await session();
          if (!sessionId) return denied(false);
          const state = await read(sessionId);
          if (await session() !== sessionId) return denied(false);
          return result(state, owner);
        } catch { return denied(false); }
      }),
      forgetTab: tabId => serial(async () => {
        try {
          const sessionId = await session();
          if (!id(tabId) || !sessionId) return false;
          const state = await read(sessionId);
          for (const entry of state.entries) entry.sources = entry.sources.filter(source => source.sourceTabId !== tabId);
          if (await session() !== sessionId) return false;
          await write(state); return true;
        } catch { return false; }
      }),
    };
  }
  root.OnStarvoiceTaskWindowSources = Object.freeze({STORAGE_KEY, MAX_WINDOWS, MAX_SOURCES, RETIRED_LIMIT,
    PROBE_CONCURRENCY, PROBE_BUDGET_MS, createController});
})(globalThis);
