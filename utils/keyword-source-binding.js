(function (root) {
  'use strict';
  const STORAGE_KEY = 'onstarvoice.keywordSourceBindings.v1';
  const tabId = value => Number.isSafeInteger(value) && value > 0 ? value : null;
  const identityFor = value => `${value?.id || ''}:${value?.attemptId || value?.commandId || ''}`;
  const keyFor = owner => `${owner.kind}:${owner.identity}`;
  const validOwner = owner => ['unattended', 'manual'].includes(owner?.kind) &&
    Boolean(owner.requestId && owner.identity && owner.platform);
  function searchKeyword(value, platform) {
    try {
      const url = new URL(value);
      if (platform === 'douyin') return decodeURIComponent(url.pathname.replace(/^\/(?:jingxuan\/)?search\//, '').replace(/\/$/, ''));
      if (platform === 'xiaohongshu') return url.searchParams.get('keyword') || '';
      if (platform === 'weibo') return url.searchParams.get('q') || '';
    } catch { /* Malformed search URL is not evidence. */ }
    return '';
  }

  // This is navigation authority, separate from volatile progress snapshots.
  // Only background's actual create/reuse result may establish a source.
  function createController({storage}) {
    let tail = Promise.resolve();
    const serial = fn => { const result = tail.then(fn, fn); tail = result.catch(() => {}); return result; };
    const read = async () => (await storage.get(STORAGE_KEY))[STORAGE_KEY] || {};
    const write = entries => storage.set({[STORAGE_KEY]: entries});
    return {
      bind: (owner, source, {shouldWrite = () => true} = {}) => serial(async () => {
        if (!shouldWrite() || !validOwner(owner) || !tabId(source?.tabId) || !tabId(source?.windowId)) return null;
        const entries = await read(), key = keyFor(owner);
        if (!shouldWrite()) return null;
        const previous = entries[key]?.sources?.find(item => item.sourceTabId === source.tabId);
        let transferred = false;
        for (const [otherKey, entry] of Object.entries(entries)) {
          if (otherKey === key) continue;
          if (entry.sources?.some(item => item.sourceTabId === source.tabId)) transferred = true;
          entry.sources = (entry.sources || []).filter(item => item.sourceTabId !== source.tabId);
          if (!entry.sources.length) delete entries[otherKey];
        }
        const sourceBinding = {
          sourceTabId: source.tabId, windowId: source.windowId,
          // Launch creates the page before the runner's later switch reuses it.
          createdByTask: previous?.createdByTask === true || source.created === true,
          originalUrl: previous?.originalUrl ?? String(source.url || ''),
          expectedSourceUrl: previous?.expectedSourceUrl || '',
          documentId: previous?.documentId || '',
          runnerDocumentId: String(owner.runnerDocumentId || previous?.runnerDocumentId || ''),
        };
        entries[key] = {...owner, sources: [
          ...(entries[key]?.sources || []).filter(item => item.sourceTabId !== source.tabId), sourceBinding,
        ]};
        if (!shouldWrite()) return null;
        await write(entries);
        return {...sourceBinding, transferred};
      }),
      get: owner => serial(async () => {
        if (!validOwner(owner)) return [];
        return (await read())[keyFor(owner)]?.sources || [];
      }),
      forget: sourceTabId => serial(async () => {
        const entries = await read();
        for (const [key, entry] of Object.entries(entries)) {
          entry.sources = (entry.sources || []).filter(source => source.sourceTabId !== sourceTabId);
          if (!entry.sources.length) delete entries[key];
        }
        await write(entries);
      }),
      record: (owner, evidence) => serial(async () => {
        if (!validOwner(owner) || !tabId(evidence?.sourceTabId) || !evidence.documentId || !evidence.url) return false;
        const entries = await read(), entry = entries[keyFor(owner)];
        const source = entry?.sources?.find(item => item.sourceTabId === evidence.sourceTabId);
        if (!source || source.windowId !== evidence.windowId || !owner.runnerDocumentId ||
            source.runnerDocumentId !== owner.runnerDocumentId) return false;
        source.expectedSourceUrl = String(evidence.url);
        source.documentId = String(evidence.documentId);
        await write(entries);
        return true;
      }),
      replace: (removedTabId, addedTabId) => serial(async () => {
        if (!tabId(removedTabId) || !tabId(addedTabId)) return;
        const entries = await read();
        // Browser replacement is the only permitted identity migration. Never
        // adopt a queried same-keyword tab; a replacement needs fresh evidence.
        if (Object.values(entries).some(entry => entry.sources?.some(source => source.sourceTabId === addedTabId))) return;
        for (const entry of Object.values(entries)) for (const source of entry.sources || []) {
          if (source.sourceTabId !== removedTabId) continue;
          source.sourceTabId = addedTabId;
          source.expectedSourceUrl = '';
          source.documentId = '';
        }
        await write(entries);
      }),
    };
  }

  // A best-effort sidecar: recorder/storage failures never change collection's
  // success, retry, cancellation or budget decisions. Background bounds probes.
  async function recordNavigation(sourceTabId, expectedUrl) {
    let timer;
    try {
      if (!tabId(sourceTabId) || !expectedUrl) return;
      await Promise.race([
        root.chrome?.runtime?.sendMessage({type: 'onstarvoice:record-keyword-source-navigation',
          sourceTabId, expectedUrl: String(expectedUrl)}),
        new Promise(resolve => { timer = setTimeout(resolve, 5000); }),
      ]);
    } catch { /* Missing evidence preserves the page. */ }
    finally { clearTimeout(timer); }
  }
  root.OnStarvoiceKeywordSourceBinding = Object.freeze({STORAGE_KEY, identityFor, searchKeyword, createController, recordNavigation});
})(globalThis);
