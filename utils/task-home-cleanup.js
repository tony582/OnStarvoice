(function (root) {
  'use strict';
  const STORAGE_KEY = 'onstarvoice.taskHomeCleanup.v1';
  const HOMES = Object.freeze({
    douyin: 'https://www.douyin.com/',
    xiaohongshu: 'https://www.xiaohongshu.com/explore',
    weibo: 'https://weibo.com/',
  });
  const id = value => Number.isSafeInteger(value) && value > 0 ? value : null;
  const text = value => typeof value === 'string' ? value.trim() : '';
  const missingTab = error => /^(?:missing|No tab with id(?::\s*\d+)?\.?)$/iu.test(String(error?.message || error || ''));
  function isHome(url, platform) {
    try {
      const live = new URL(url), home = new URL(HOMES[platform]);
      const path = live.pathname.replace(/\/$/, '');
      const homePath = home.pathname.replace(/\/$/, '');
      return live.origin === home.origin && (path === homePath || (platform === 'douyin' && path === '/jingxuan')) &&
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
      } else if (platform === 'xiaohongshu' && /^\/search_result\/?$/.test(live.pathname)) {
        keyword = live.searchParams.get('keyword') || '';
      } else if (platform === 'weibo' && live.pathname === '/weibo') {
        keyword = live.searchParams.get('q') || '';
      }
      return Boolean(keyword && keywords.includes(keyword));
    } catch { return false; }
  }
  function normalizeSource(value = {}) {
    return {
      sourceTabId: id(value.sourceTabId), expectedSourceUrl: text(value.expectedSourceUrl),
      documentId: text(value.documentId), createdByTask: value.createdByTask === true,
      originalUrl: text(value.originalUrl),
      ...(value.closed === true ? {closed: true} : {}),
      ...(value.homeRequested === true ? {homeRequested: true} : {}),
      ...(text(value.settledReason) ? {settledReason: text(value.settledReason)} : {}),
    };
  }
  const sourceKey = source => JSON.stringify([source.sourceTabId, source.documentId, source.expectedSourceUrl]);
  function sourcesOf(entry) {
    // Old records have no document proof. Keep them pending, never convert a
    // persisted numeric tab id into permission to navigate or close a page.
    return (Array.isArray(entry.sources) ? entry.sources : entry.sourceTabId ? [entry] : []).map(normalizeSource);
  }
  // This queue carries UI cleanup only. Every source obligation survives until
  // it is resolved; sharing a window/platform does not merge task ownership.
  function createController({storage, tabs, canPark, getDocumentIdentity = async () => null, canCreateHome = async () => false}) {
    let tail = Promise.resolve();
    const serial = fn => { const next = tail.then(fn, fn); tail = next.catch(() => {}); return next; };
    const read = async () => (await storage.get(STORAGE_KEY))[STORAGE_KEY] || {};
    const write = entries => storage.set({[STORAGE_KEY]: entries});
    const entryKey = entry => JSON.stringify([entry.windowId, entry.platform, entry.identity]);
    const pendingUrl = tab => text(tab?.pendingUrl);
    const isHomeCandidate = (tab, entry) => tab?.windowId === entry.windowId &&
      isHome(pendingUrl(tab) || tab.url, entry.platform);
    const isLiveHome = (tab, entry) => isHomeCandidate(tab, entry) && isHome(tab.url, entry.platform) &&
      !pendingUrl(tab) && tab.status !== 'loading';
    const canParkPending = entry => canPark({...entry, sources: entry.sources.filter(source => !source.settledReason)});
    async function readTab(tabId) {
      try { return {tab: await tabs.get(tabId)}; }
      catch (error) { if (missingTab(error)) return {gone: true}; throw error; }
    }
    async function inspectSource(entry, source) {
      if (source.closed) return {gone: true};
      if (!source.sourceTabId || !source.documentId || !source.expectedSourceUrl) {
        return {reason: 'source_identity_unverified'};
      }
      const current = await readTab(source.sourceTabId);
      if (current.gone) return current;
      const matches = tab => tab?.windowId === entry.windowId && tab.url === source.expectedSourceUrl &&
        !pendingUrl(tab) && tab.status !== 'loading';
      if (!matches(current.tab)) return {reason: 'source_navigated'};
      if (!isPlanSearch(source.expectedSourceUrl, entry.platform, entry.keywords) && !isHome(source.expectedSourceUrl, entry.platform)) {
        return {reason: 'source_route_unverified'};
      }
      const document = await getDocumentIdentity(source.sourceTabId);
      if (!document?.documentId || !document?.url) return {reason: 'source_identity_unverified'};
      if (document.documentId !== source.documentId || document.url !== source.expectedSourceUrl) {
        return {reason: 'source_document_changed'};
      }
      const latest = await readTab(source.sourceTabId);
      if (latest.gone) return latest;
      return matches(latest.tab) ? {tab: latest.tab} : {reason: 'source_navigated'};
    }
    async function inspectIdleSource(entry, source) {
      if (!await canParkPending(entry)) return {reason: 'capture_active'};
      const first = await inspectSource(entry, source);
      if (!first.tab) return first;
      // Identity probes may await browser work; then check both the task gate
      // and document again before changing a tab.
      if (!await canParkPending(entry)) return {reason: 'capture_active'};
      return await inspectSource(entry, source);
    }
    async function findHome(entry) {
      const pages = await tabs.query({windowId: entry.windowId});
      for (const page of pages) {
        if (!isHomeCandidate(page, entry)) continue;
        const current = await readTab(page.id);
        if (isHomeCandidate(current.tab, entry)) return current.tab;
      }
      return null;
    }
    async function captureCreatedHomeDocument(entry, persist) {
      const own = entry.createdHome;
      if (own.closed) return {gone: true};
      if (own.documentId) return await inspectIdleSource(entry, own);
      if (!own.creationPending || !await canCreateHome(entry)) return {reason: 'home_identity_unverified'};
      if (!await canParkPending(entry)) return {reason: 'capture_active'};
      const current = await readTab(own.sourceTabId);
      if (current.gone) { own.closed = true; await persist(); return current; }
      if (current.tab.windowId !== entry.windowId) {
        own.creationPending = false; await persist(); return {reason: 'home_navigated'};
      }
      if (!isLiveHome(current.tab, entry)) {
        // Chrome may return about:blank/pendingUrl before the initial home
        // navigation commits, including Douyin's redirect to /jingxuan.
        if (isHomeCandidate(current.tab, entry) ||
          (current.tab.status === 'loading' && current.tab.url === 'about:blank')) {
          return {reason: 'home_navigation_pending'};
        }
        own.creationPending = false; await persist(); return {reason: 'home_navigated'};
      }
      const document = await getDocumentIdentity(own.sourceTabId);
      if (!document?.documentId || document.url !== current.tab.url) return {reason: 'home_identity_unverified'};
      if (!await canParkPending(entry) || !await canCreateHome(entry)) return {reason: 'home_identity_unverified'};
      const latest = await readTab(own.sourceTabId);
      if (latest.gone) { own.closed = true; await persist(); return latest; }
      if (!isLiveHome(latest.tab, entry) || latest.tab.url !== document.url) return {reason: 'home_navigation_pending'};
      // Initial proof can be completed after a worker restart, but only in the
      // same browser session. Once captured, a document is never refreshed.
      own.expectedSourceUrl = document.url;
      own.documentId = text(document.documentId);
      own.creationPending = false;
      await persist();
      return await inspectIdleSource(entry, own);
    }
    async function ensureAllowedHome(entry, persist) {
      if (!entry.allowCreateHome) return {parked: false, reason: 'source_identity_unverified'};
      if (!await canParkPending(entry)) return {parked: false, reason: 'capture_active'};
      let home = await findHome(entry);
      if (!home && !entry.createdHome) {
        if (entry.creationRequested) return {parked: false, reason: 'home_creation_unconfirmed'};
        if (!await canCreateHome(entry)) return {parked: false, reason: 'home_creation_session_unverified'};
        if (!await canParkPending(entry)) return {parked: false, reason: 'capture_active'};
        home = await findHome(entry);
        if (!home) {
          const pages = await tabs.query({windowId: entry.windowId});
          if (!pages.length) return {parked: false, settled: true, reason: 'window_closed'};
          // Recording the intent before Chrome prevents an interrupted create
          // from adding another page on retry when its result is unknown.
          entry.creationRequested = true;
          await persist();
          const deferBeforeCreate = async reason => {
            // No Chrome create has been attempted yet, so this interruption
            // can be retried without risking an unknown duplicate tab.
            entry.creationRequested = false; await persist(); return {parked: false, reason};
          };
          if (!await canParkPending(entry)) return await deferBeforeCreate('capture_active');
          if (!await canCreateHome(entry)) return await deferBeforeCreate('home_creation_session_unverified');
          home = await findHome(entry);
          if (!home) {
            if (!await canCreateHome(entry)) return await deferBeforeCreate('home_creation_session_unverified');
            if (!await canParkPending(entry)) return await deferBeforeCreate('capture_active');
            const created = await tabs.create({windowId: entry.windowId, url: HOMES[entry.platform],
              active: pages.some(tab => tab.active && tab.id === entry.runnerTabId)});
            if (!id(created?.id)) return {parked: false, reason: 'home_creation_unconfirmed'};
            entry.createdHome = {sourceTabId: created.id, expectedSourceUrl: '', documentId: '',
              createdByTask: true, creationPending: true};
            // Save the returned id before any probe can fail or the worker ends.
            await persist();
            home = (await readTab(created.id)).tab || null;
          }
        }
      }
      if (entry.createdHome) {
        const own = entry.createdHome;
        const proof = await captureCreatedHomeDocument(entry, persist);
        const pages = await tabs.query({windowId: entry.windowId});
        const other = pages.find(tab => tab.id !== own.sourceTabId && isLiveHome(tab, entry));
        if (proof.gone) return other
          ? {parked: true, settled: true, reason: 'home_reused', tabId: other.id}
          : {parked: false, settled: true, reason: 'created_home_closed'};
        if (!proof.tab) return {parked: false, reason: proof.reason};
        if (other) {
          const liveOther = await readTab(other.id);
          if (!isLiveHome(liveOther.tab, entry)) return {parked: false, reason: 'home_navigated'};
          if (!await canParkPending(entry)) return {parked: false, reason: 'capture_active'};
          const finalProof = await inspectSource(entry, own);
          if (!finalProof.tab) return {parked: false, reason: finalProof.reason || 'home_identity_unverified'};
          await tabs.remove(own.sourceTabId);
          if (!(await readTab(own.sourceTabId)).gone) return {parked: false, reason: 'source_close_unconfirmed'};
          return {parked: true, settled: true, reason: 'created_duplicate_closed', tabId: other.id};
        }
        home = proof.tab;
      }
      if (!await canParkPending(entry)) return {parked: false, reason: 'capture_active'};
      const live = home ? (await readTab(home.id)).tab : null;
      return isLiveHome(live, entry)
        ? {parked: true, settled: true, reason: 'home_reused', tabId: live.id}
        : {parked: false, reason: 'home_navigation_pending'};
    }
    async function park(entry, persist) {
      if (!await canParkPending(entry)) return {parked: false, reason: 'capture_active'};
      const pages = await tabs.query({windowId: entry.windowId});
      if (!pages.length) return {parked: false, settled: true, reason: 'window_closed'};
      if (!entry.sources.length) return await ensureAllowedHome(entry, persist);
      let home = await findHome(entry), reason = '', changed = false;
      const settle = async (source, outcome) => {
        source.settledReason = outcome; changed = true; await persist();
      };
      // A task-owned page is a better home candidate than a user's borrowed
      // page. Borrowed pages stay untouched once an existing home is available.
      const ordered = [...entry.sources].sort((a, b) => Number(b.createdByTask) - Number(a.createdByTask));
      for (const source of ordered) {
        if (source.settledReason) continue;
        if (source.homeRequested) {
          const current = await readTab(source.sourceTabId);
          if (current.gone) { await settle(source, 'source_closed'); continue; }
          if (isLiveHome(current.tab, entry)) {
            // A previous successful update may have outlived the service worker.
            // This acknowledges its destination; it grants no new close authority.
            home = home || current.tab;
            await settle(source, 'home_restored');
            continue;
          }
        }
        const proof = await inspectIdleSource(entry, source);
        if (proof.gone) { await settle(source, 'source_closed'); continue; }
        if (!proof.tab) { reason = proof.reason; continue; }
        // Query again after awaits: another task or the user may already have
        // opened a homepage. Cleanup never creates a fallback tab.
        home = await findHome(entry);
        if (home?.id === source.sourceTabId) { await settle(source, 'home_reused'); continue; }
        if (home && !source.createdByTask && !entry.dedicatedWindow) {
          if (!await canParkPending(entry)) { reason = 'capture_active'; continue; }
          await settle(source, 'user_owned_preserved');
          continue;
        }
        if (home) {
          const finalSource = await inspectIdleSource(entry, source);
          const finalHome = await readTab(home.id);
          if (finalSource.gone) { await settle(source, 'source_closed'); continue; }
          if (!finalSource.tab) { reason = finalSource.reason; continue; }
          if (!isLiveHome(finalHome.tab, entry)) { reason = 'home_navigated'; continue; }
          if (!await canParkPending(entry)) { reason = 'capture_active'; continue; }
          const lastSource = await inspectSource(entry, source);
          if (!lastSource.tab) { reason = lastSource.reason || 'source_closed'; continue; }
          await tabs.remove(source.sourceTabId);
          if (!(await readTab(source.sourceTabId)).gone) { reason = 'source_close_unconfirmed'; continue; }
          await settle(source, 'task_source_closed');
          continue;
        }
        const finalSource = await inspectIdleSource(entry, source);
        if (finalSource.gone) { await settle(source, 'source_closed'); continue; }
        if (!finalSource.tab) { reason = finalSource.reason; continue; }
        if (await findHome(entry)) { reason = 'home_appeared'; continue; }
        if (!await canParkPending(entry)) { reason = 'capture_active'; continue; }
        const lastSource = await inspectSource(entry, source);
        if (!lastSource.tab) { reason = lastSource.reason || 'source_closed'; continue; }
        source.homeRequested = true;
        await persist();
        // Persist the navigation intent first, then recheck after storage awaits.
        const afterPersist = await inspectIdleSource(entry, source);
        if (!afterPersist.tab) { reason = afterPersist.reason || 'source_closed'; continue; }
        if (await findHome(entry)) { source.homeRequested = false; await persist(); reason = 'home_appeared'; continue; }
        if (!await canParkPending(entry)) { reason = 'capture_active'; continue; }
        const finalProof = await inspectSource(entry, source);
        if (!finalProof.tab) { reason = finalProof.reason || 'source_closed'; continue; }
        const destination = isHome(source.originalUrl, entry.platform) ? source.originalUrl : HOMES[entry.platform];
        await tabs.update(source.sourceTabId, {url: destination});
        const navigated = await readTab(source.sourceTabId);
        if (isLiveHome(navigated.tab, entry)) {
          home = navigated.tab;
          await settle(source, 'home_restored');
        } else reason = 'home_navigation_pending';
      }
      const settled = entry.sources.every(source => source.settledReason);
      const sourceResults = entry.sources.map(source => ({sourceTabId: source.sourceTabId,
        reason: source.settledReason || reason || 'source_identity_unverified'}));
      return {parked: isLiveHome(home, entry), settled, reason: settled
        ? entry.sources.every(source => source.settledReason === 'user_owned_preserved') ? 'user_owned_preserved' : 'sources_settled'
        : reason || 'source_identity_unverified',
        ...(home ? {tabId: home.id} : {}), changed, sourceResults,
        closedCount: entry.sources.filter(source => source.settledReason === 'task_source_closed').length,
        preservedCount: entry.sources.filter(source => source.settledReason === 'user_owned_preserved').length};
    }
    return {
      enqueue: value => serial(async () => {
        if (!value?.identity || !HOMES[value.platform] || !id(value.windowId)) return false;
        const entries = await read();
        const next = {identity: String(value.identity), platform: value.platform, windowId: value.windowId,
          runnerTabId: id(value.runnerTabId), dedicatedWindow: value.dedicatedWindow === true,
          allowCreateHome: value.allowCreateHome === true, creationSessionId: text(value.creationSessionId),
          keywords: Array.isArray(value.keywords) ? value.keywords.filter(x => typeof x === 'string') : [], sources: []};
        const key = entryKey(next), sources = new Map();
        // Migrate the old window/platform key without dropping its source.
        for (const [oldKey, old] of Object.entries(entries)) {
          if (old?.identity !== next.identity || old.windowId !== next.windowId || old.platform !== next.platform) continue;
          for (const source of sourcesOf(old)) sources.set(sourceKey(source), source);
          // Re-enqueueing the same task retains progress and cannot replace its
          // original browser-session permission with broader, newer permission.
          next.allowCreateHome = old.allowCreateHome === true;
          next.creationSessionId = text(old.creationSessionId);
          if (old.creationRequested) next.creationRequested = true;
          if (old.createdHome) next.createdHome = {...old.createdHome};
          next.keywords = [...new Set([...(Array.isArray(old.keywords) ? old.keywords : []), ...next.keywords])];
          delete entries[oldKey];
        }
        for (const source of sourcesOf(value)) {
          const old = sources.get(sourceKey(source));
          sources.set(sourceKey(source), old || source);
        }
        next.sources = [...sources.values()];
        const reassignedTabs = new Set(next.sources.filter(source => source.documentId).map(source => source.sourceTabId));
        for (const [oldKey, old] of Object.entries(entries)) {
          if (old.identity === next.identity) continue;
          old.sources = sourcesOf(old).filter(source => !reassignedTabs.has(source.sourceTabId));
          if (reassignedTabs.has(old.createdHome?.sourceTabId)) {
            old.createdHome.creationPending = false; old.createdHome.documentId = '';
          }
          if (!old.sources.length && !old.allowCreateHome) delete entries[oldKey];
        }
        entries[key] = next;
        await write(entries);
        return true;
      }),
      reconcile: () => serial(async () => {
        const entries = await read(), results = [];
        for (const [key, entry] of Object.entries(entries)) {
          if (!entry?.identity || !HOMES[entry.platform] || !id(entry.windowId)) continue;
          entry.sources = sourcesOf(entry);
          let result;
          try { result = await park(entry, () => write(entries)); }
          catch (error) { result = {parked: false, reason: 'home_cleanup_pending', error: String(error.message || error)}; }
          results.push({...result, identity: entry.identity});
          if (result.settled) { delete entries[key]; await write(entries); }
        }
        return results;
      }),
      revokeSource: tabId => serial(async () => {
        const entries = await read();
        for (const [key, entry] of Object.entries(entries)) {
          entry.sources = sourcesOf(entry).filter(source => source.sourceTabId !== tabId);
          if (entry.createdHome?.sourceTabId === tabId) {
            entry.createdHome.creationPending = false; entry.createdHome.documentId = '';
          }
          if (!entry.sources.length && !entry.allowCreateHome) delete entries[key];
        }
        await write(entries);
      }),
      forgetTab: tabId => serial(async () => {
        const entries = await read();
        for (const entry of Object.values(entries)) {
          entry.sources = sourcesOf(entry);
          for (const source of entry.sources) if (source.sourceTabId === tabId) source.closed = true;
          if (entry.createdHome?.sourceTabId === tabId) entry.createdHome.closed = true;
        }
        await write(entries);
      }),
    };
  }
  root.OnStarvoiceTaskHomeCleanup = Object.freeze({STORAGE_KEY, HOMES, isHome, isPlanSearch, createController});
})(globalThis);
