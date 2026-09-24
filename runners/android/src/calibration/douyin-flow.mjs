import {FILTER_OPTIONS, hasSemanticFilters, semanticFilterSelector} from '../device/douyin-semantic-filters.mjs';
import { randomUUID } from 'node:crypto';
import { DeviceError } from '../device/bounded.mjs';
import { descendants, visible } from '../device/ui-tree.mjs';
import { byId, resource, readSearch, searchEntryNodes,
  readFilters, filtersMatch, filterSelector } from '../device/douyin-profile.mjs';
import { readVerifiedDetail } from '../device/douyin-detail.mjs';
import { copyBoundShare } from '../device/douyin-share.mjs';
import { readUntil, READ_TIMEOUT_MS, RETRY_DELAY_MS } from '../device/ui-wait.mjs';

// openCard budget split: the outer action budget minus the results/click time already spent,
// minus one caption-expand read and a safety margin, capped so the gate deadline is never reached.
const OPEN_EXPAND_RESERVE_MS = 11_000;
const OPEN_SAFETY_MS = 3_000;
const MIN_DETAIL_READY_MS = READ_TIMEOUT_MS + RETRY_DELAY_MS;
const MAX_DETAIL_READY_MS = 40_000;
const RETURN_BUDGET_MS = 15_000;

// The calibrated panel choices the flow can select; the profile adapter maps public filter names into these labels.
const CALIBRATED_SORT = FILTER_OPTIONS['排序依据'];
const CALIBRATED_TIME = FILTER_OPTIONS['发布时间'];
const CALIBRATED_CONTENT = FILTER_OPTIONS['内容形式'];
function assertCalibratedSearch(keyword, filters) {
  if (typeof keyword !== 'string' || !keyword.trim() || keyword.length > 100
    || !CALIBRATED_SORT.includes(filters?.sort) || !CALIBRATED_TIME.includes(filters?.time)
    || !CALIBRATED_CONTENT.includes(filters?.content ?? '不限')) {
    throw new DeviceError('unsupported_calibration_search', 'Unsupported calibration keyword or filters');
  }
}

// The UI flow has no cloud client; copied links remain pending independent detail verification.
export function createDouyinCalibrationFlow({ ui, now = () => performance.now() }) {
  let context = null;
  let opened = null;
  let semanticFilters = false;
  const closeFilters = options => semanticFilters
    ? ui.clickXPath("//*[@content-desc='关闭筛选']",options) : ui.clickId('zsg',options);
  const requireContext = () => {
    if (!context) throw new DeviceError('search_context_unverified', 'Search calibration has not established a context');
    return context;
  };
  const results = async (options) => {
    const { keyword } = requireContext();
    const tree = await ui.waitFor(tree => readSearch(tree, keyword).verified, options);
    return readSearch(tree, keyword);
  };
  const filterState = async (options) => {
    await ui.clickXPath(`//*[@resource-id='${resource('hb9')}' and @content-desc='筛选，按钮']`, options);
    await ui.setWindowScope(false, options);
    const tree = await ui.waitFor(tree => hasSemanticFilters(tree) || byId(tree, 'hdi').length === 5, options);
    semanticFilters = hasSemanticFilters(tree);
    return tree;
  };
  const verifyFilters = async (options) => {
    try {
      const tree = await filterState(options);
      if (!filtersMatch(readFilters(tree), requireContext().filters)) throw new DeviceError('search_filters_changed', 'Search filters changed');
      await closeFilters(options);
    } finally { await ui.setWindowScope(false, { timeoutMs: 5000 }); }
    return results(options);
  };
  const flow = {
    async search({ keyword, signal, filters = { sort: '综合排序', time: '一天内', content: '不限' } }) {
      context = null;
      try {
      assertCalibratedSearch(keyword, filters);
      const options = { signal }; await ui.setWindowScope(false, options); let tree = await ui.read(options);
      if (!byId(tree, 'et_search_kw').length && searchEntryNodes(tree).length === 1) {
        await ui.clickXPath(`//*[@resource-id='${resource('hmy')}' and @content-desc='搜索']`,options); tree = await ui.waitFor(tree => byId(tree, 'et_search_kw').length === 1, options);
      }
      if (byId(tree, 'et_search_kw').length !== 1) throw new DeviceError('search_entry_unverified', 'Search entry is not visible');
      await ui.input('et_search_kw', keyword, options); await ui.clickId('0g9', options);
      context = { keyword, filters: { ...filters } }; await results(options);
      try {
      let panel = await filterState(options);
      for (const [group, choice] of [['排序依据', filters.sort], ['发布时间', filters.time],
        ['视频时长', '不限'], ['搜索范围', '不限'], ['内容形式', filters.content ?? '不限'],
        ...(semanticFilters ? [['位置距离','不限']] : [])]) {
        if (readFilters(panel)[group] === choice) continue;
        await ui.clickXPath(semanticFilters ? semanticFilterSelector(group,choice,panel) : filterSelector(group, choice), options);
        panel = await ui.waitFor(tree => readFilters(tree)[group] === choice, options);
      }
      tree = await ui.read(options);
      if (!filtersMatch(readFilters(tree), filters)) throw new DeviceError('filter_unverified', 'Filter readback did not match');
      await closeFilters(options);
      } finally { await ui.setWindowScope(false, { timeoutMs: 5000 }); }
      return await results(options);
      } catch (error) { context = null; throw error; }
    },
    async adoptCurrentSearch({ keyword, filters, signal }) {
      context = null;
      assertCalibratedSearch(keyword, filters);
      context = { keyword, filters: { ...filters } };
      try { await results({ signal }); return await verifyFilters({ signal }); }
      catch (error) { context = null; throw error; }
    },
    readCards: ({ signal } = {}) => results({ signal }),
    async openCard({card, signal, actionBudgetMs = 60_000}) {
      const startedAt = now();
      opened = null;
      const { keyword } = requireContext();
      const page = await results({signal});
      if (page.cards.filter(item => item.cardId === card.cardId).length !== 1) {
        throw new DeviceError('card_identity_unverified', 'Card is missing or ambiguous on the current page', { deviceSettled: true });
      }
      await ui.clickXPath(card.selector, {signal});
      // Exactly one click per openCard. From here the detail is only re-read inside the remaining budget.
      const remaining = actionBudgetMs - (now() - startedAt) - OPEN_EXPAND_RESERVE_MS - OPEN_SAFETY_MS;
      const detail = await readVerifiedDetail({ui, card, signal, searchKeyword: keyword, now,
        budgetMs: Math.min(MAX_DETAIL_READY_MS, Math.max(remaining, MIN_DETAIL_READY_MS))});
      opened = {card, detail};
      return {identityVerified:true, cardId:card.cardId, detailId:card.cardId, kind:detail.kind};
    },
    async copyLink({detail, marker, signal}) {
      if (!opened || opened.card.cardId !== detail?.detailId) {
        throw new DeviceError('detail_identity_unverified', 'No matching open work');
      }
      const current = await readVerifiedDetail({ui, card:opened.card, signal});
      return copyBoundShare({ui, card:opened.card, before:current, marker, signal});
    },
    async returnToResults({signal} = {}) {
      if (!opened) throw new DeviceError('detail_identity_unverified', 'No open work to return from');
      if (opened.detail.back) await ui.clickId(opened.detail.back, {signal}); else await ui.back({signal});
      opened = null;
      await results({signal});
      return verifyFilters({signal});
    },
    /**
     * After a failed openCard: get back to the verified results page without opening anything, then
     * read all filter groups again. Back is pressed at most twice and never from Douyin's home page,
     * because leaving the search can not be undone safely.
     */
    async recoverResults({signal} = {}) {
      opened = null;
      const { keyword } = requireContext();
      const options = {signal};
      let tree = await ui.read(options);
      for (let presses = 0; !readSearch(tree, keyword).verified; presses++) {
        if (presses >= 2 || searchEntryNodes(tree).length) {
          throw new DeviceError('search_context_unverified', 'Could not return to the verified search results',
            { deviceSettled: true, backPresses: presses });
        }
        await ui.back(options);
        ({ tree } = await readUntil({ ui, signal, now, budgetMs: RETURN_BUDGET_MS,
          predicate: current => readSearch(current, keyword).verified }));
      }
      return verifyFilters(options);
    },
    async capture({card, signal}) {
      const detail = await flow.openCard({card, signal});
      const observation = await flow.copyLink({detail, marker:`starvoice-discovery:${randomUUID()}`, signal});
      await flow.returnToResults({signal});
      return {...observation, filtersRetained:true, keyword:context.keyword, filters:context.filters};
    },
    async scroll({ signal } = {}) {
      await results({ signal }); const tree = await ui.read({ signal });
      const containers = tree.nodes.filter(node => visible(node)
        && node.attributes.class === 'androidx.recyclerview.widget.RecyclerView' && node.attributes.scrollable === 'true'
        && descendants(node).some(child => child.attributes['resource-id'] === resource('b87')));
      if (containers.length !== 1 || !containers[0].attributes['resource-id']) throw new DeviceError('scroll_container_ambiguous', 'Result list was not identified uniquely');
      await ui.scroll(containers[0].attributes['resource-id'], { signal }); return results({ signal });
    },
  };
  return flow;
}
