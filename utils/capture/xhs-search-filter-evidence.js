// Match the result containers already supported by the XHS list extractor.
const ROOT_SELECTORS = ['.feeds-container', '.search-results', '.waterfall', '#search-result'];
const CARD_SELECTOR = '.note-item, .feed-item';
const LINK_SELECTOR = 'a[href*="/explore/"], a[href*="/search_result/"], a[href*="/discovery/item/"]';
const BUSY_SELECTOR = '[aria-busy="true"], [role="progressbar"], .loading, .loading-container, .loading-spinner, .skeleton';
const EMPTY_SELECTOR = '[class*="empty"], [class*="no-result"], .not-found';

function visible(node, windowRef) {
  if (!node || node.isConnected === false || node.hidden === true) return false;
  const rect = node.getBoundingClientRect?.();
  if (!rect || rect.width <= 0 || rect.height <= 0) return false;
  for (let parent = node, depth = 0; parent && depth < 24; parent = parent.parentElement, depth += 1) {
    if (parent.hidden === true || parent.getAttribute?.('aria-hidden') === 'true') return false;
    const style = windowRef.getComputedStyle?.(parent);
    if (style?.display === 'none' || style?.visibility === 'hidden' || Number(style?.opacity ?? 1) <= 0.01) return false;
  }
  return true;
}

function noteId(node) {
  const link = node.matches?.(LINK_SELECTOR) ? node : node.querySelector?.(LINK_SELECTOR);
  return String(link?.getAttribute?.('href') || '').match(/\/(?:explore|search_result|discovery\/item)\/([a-f\d]{24})(?:[/?#]|$)/iu)?.[1]?.toLowerCase() || '';
}

// This observer only lives while applying an explicit XHS publish-time filter.
// It never submits a search, clicks a control, or observes the entire document.
export function beginXhsSearchFilterEvidence({
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  Observer = globalThis.MutationObserver,
  now = () => Date.now(),
} = {}) {
  const findRoot = (searchRoot) => ROOT_SELECTORS
    .map((selector) => searchRoot?.querySelector?.(selector))
    .find(Boolean) || null;
  const initialRoot = findRoot(documentRef);
  const parent = initialRoot?.parentElement;
  const scope = parent && parent !== documentRef.body && parent !== documentRef.documentElement
    ? parent
    : initialRoot;
  let disconnected = false;
  let observer = null;
  let sawBusy = false;
  let sawClear = false;
  const removedBaselineCards = new Set();
  const read = () => {
    const root = initialRoot?.isConnected !== false && initialRoot
      ? initialRoot
      : findRoot(scope) || findRoot(documentRef);
    const cards = [];
    const seen = new Set();
    const candidates = root?.querySelectorAll?.(`${CARD_SELECTOR}, ${LINK_SELECTOR}`) || [];
    for (const candidate of candidates) {
      if (cards.length >= 64) break;
      const card = candidate.closest?.(CARD_SELECTOR) || candidate;
      if (seen.has(card) || !visible(card, windowRef) || !noteId(card)) continue;
      seen.add(card);
      cards.push(card);
    }
    const ids = Array.from(new Set(cards.map(noteId)));
    const stateScope = scope?.isConnected === false ? root : scope || root;
    const busy = Boolean(
      (root?.getAttribute?.('aria-busy') === 'true' && visible(root, windowRef)) ||
      Array.from(stateScope?.querySelectorAll?.(BUSY_SELECTOR) || []).slice(0, 16)
        .some((node) => !node.closest?.(CARD_SELECTOR) && visible(node, windowRef)),
    );
    let emptyMessage = '';
    if (cards.length === 0 && !busy) {
      const states = Array.from(stateScope?.querySelectorAll?.(EMPTY_SELECTOR) || []).slice(0, 24);
      for (const node of states) {
        if (node.closest?.(CARD_SELECTOR) || !visible(node, windowRef)) continue;
        const text = String(node.textContent || '').replace(/\s+/gu, '').trim();
        if (text.length > 80) continue;
        if (/^(?:(?:暂时)?暂无|没有找到|没有搜索到|未找到|未搜索到)(?:相关)?(?:搜索)?(?:结果|内容|作品|笔记)[。！!]?$/u.test(text) ||
          /^(?:暂无|没有)(?:符合)?(?:当前)?筛选条件的?(?:结果|内容|作品|笔记)[。！!]?$/u.test(text)) {
          emptyMessage = String(node.textContent || '').trim();
          break;
        }
      }
    }
    return {root, cards, ids, busy, emptyMessage};
  };
  const baseline = read();
  const baselineIds = baseline.ids.join('|');
  const sample = () => {
    const current = read();
    if (current.busy) sawBusy = true;
    if (baseline.cards.length > 0 && current.cards.length === 0) sawClear = true;
    const allCardsReplaced = baseline.cards.length > 0 && baseline.cards.every((card) =>
      card.isConnected === false || removedBaselineCards.has(card));
    const rootReplaced = Boolean(initialRoot && current.root && current.root !== initialRoot);
    // A lazy-loaded tail can arrive while the old search cards stay mounted;
    // it is not evidence that the time-filter request produced a result set.
    const onlyTailAppended = current.ids.length > baseline.ids.length &&
      baseline.ids.length > 0 && baseline.ids.every((id, index) => current.ids[index] === id);
    const idsChanged = Boolean(current.ids.length && current.ids.join('|') !== baselineIds && !onlyTailAppended);
    const transitioned = idsChanged || rootReplaced || allCardsReplaced || sawClear || (sawBusy && !current.busy);
    return {
      ready: Boolean(!current.busy && (current.cards.length > 0 || current.emptyMessage)),
      transitioned,
      confirmedEmpty: Boolean(current.emptyMessage),
      emptyMessage: current.emptyMessage,
      cardCount: current.cards.length,
      signature: current.emptyMessage ? `empty:${current.emptyMessage}` : current.ids.join('|'),
      reason: idsChanged ? 'result_ids_changed' : rootReplaced ? 'result_root_replaced' : allCardsReplaced ? 'result_cards_replaced' : sawClear ? 'result_clear_settled' : sawBusy && !current.busy ? 'result_loading_settled' : 'result_transition_unconfirmed',
    };
  };
  if (scope && typeof Observer === 'function') {
    observer = new Observer((records) => {
      if (disconnected) return;
      for (const record of records.slice(0, 128)) {
        for (const removed of Array.from(record.removedNodes || []).slice(0, 64)) {
          for (const card of baseline.cards) {
            if (removed === card || removed.contains?.(card)) removedBaselineCards.add(card);
          }
        }
      }
      sample();
    });
    observer.observe(scope, {childList: true, subtree: true, attributes: true, attributeFilter: ['aria-busy']});
  }
  return {
    sample,
    disconnect() {
      disconnected = true;
      observer?.disconnect();
    },
    async waitForSettled({changed = true, wait, timeoutMs = 8000} = {}) {
      const startedAt = now();
      let previous = '';
      let stable = 0;
      let evidence = sample();
      // Poll count also bounds this loop if the wall clock moves backwards.
      for (let poll = 0; poll < 42; poll += 1) {
        evidence = sample();
        const accepted = evidence.ready && (!changed || evidence.transitioned);
        stable = accepted ? (evidence.signature === previous ? stable + 1 : 1) : 0;
        previous = evidence.signature;
        if (stable >= 2) return {...evidence, verified: true, changed, reason: changed ? evidence.reason : 'already_active'};
        if (now() - startedAt >= timeoutMs || typeof wait !== 'function') break;
        await wait(200);
      }
      return {...evidence, verified: false, changed};
    },
  };
}

export function isXhsSearchTimeFilterVerified(result, publishTime) {
  const timeResult = result?.results?.find?.((entry) => entry?.field === 'publishTime');
  return Boolean(timeResult?.value === publishTime && timeResult.applied === true &&
    result?.xhsTimeFilterEvidence?.verified === true && result.xhsTimeFilterEvidence.active === true);
}

export function createXhsSearchTimeFilterError(result = null) {
  const error = new Error('无法确认小红书时间筛选及结果刷新已生效，已跳过本关键词');
  error.code = 'XHS_SEARCH_TIME_FILTER_UNVERIFIED';
  error.category = 'filter_verification';
  error.fatal = false;
  error.stopBatch = false;
  error.requiresManualAction = false;
  error.retryable = false;
  error.filterResult = result;
  return error;
}
