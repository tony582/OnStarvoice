import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import {beginXhsSearchFilterEvidence, createXhsSearchTimeFilterError, isXhsSearchTimeFilterVerified} from '../../utils/capture/xhs-search-filter-evidence.js';
import {isXhsPublishTimeWindow} from '../../utils/capture/xhs-publish-window.js';
import {createXhsSecurityBlockError} from '../../utils/capture/xiaohongshu-security.js';

const contentSource = await readFile(new URL('../../content-v2.js', import.meta.url), 'utf8');
const syncSource = await readFile(new URL('../../utils/capture-sync.js', import.meta.url), 'utf8');

class Element {
  constructor(className = '', textContent = '', attrs = {}) {
    this.className = className;
    this.textContent = textContent;
    this.attrs = attrs;
    this.children = [];
    this.parentElement = null;
    this.hidden = false;
  }
  get isConnected() { return this.className === 'body' || Boolean(this.parentElement?.isConnected); }
  getBoundingClientRect() { return {width: this.hidden ? 0 : 100, height: this.hidden ? 0 : 30}; }
  getAttribute(key) { return this.attrs[key] || null; }
  append(node) { node.parentElement = this; this.children.push(node); return node; }
  remove(node) { this.children = this.children.filter(child => child !== node); node.parentElement = null; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  matches(selector) {
    return selector.split(',').some(part => {
      const s = part.trim();
      if (s.startsWith('.')) return this.className.split(' ').includes(s.slice(1));
      if (s.startsWith('a[')) return Boolean(this.attrs.href?.includes(s.match(/\*="([^"]+)/u)?.[1] || '!'));
      const attr = s.match(/^\[([^=*]+)(\*?=)"([^"]+)"\]$/u);
      if (attr) {
        const value = attr[1] === 'class' ? this.className : this.attrs[attr[1]] || '';
        return attr[2] === '*=' ? value.includes(attr[3]) : value === attr[3];
      }
      return false;
    });
  }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector) {
    const found = [];
    for (const child of this.children) {
      if (child.matches(selector)) found.push(child);
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function page(ids = ['665df0000000000000000001', '665df0000000000000000002']) {
  const body = new Element('body');
  const scope = body.append(new Element('search-results'));
  const root = scope.append(new Element('feeds-container'));
  let listener;
  let disconnects = 0;
  let clock = 0;
  const emit = (records = []) => listener?.(records);
  const replaceCards = (nextIds) => {
    const removedNodes = [...root.children];
    for (const node of removedNodes) root.remove(node);
    for (const id of nextIds) {
      const card = root.append(new Element('note-item'));
      card.append(new Element('', '', {href: `/explore/${id}`}));
    }
    emit([{removedNodes}]);
  };
  replaceCards(ids);
  const witness = beginXhsSearchFilterEvidence({
    documentRef: {body, documentElement: {}, querySelector: selector => body.querySelector(selector)},
    windowRef: {getComputedStyle: () => ({display: 'block', visibility: 'visible', opacity: '1'})},
    Observer: class {
      constructor(callback) { listener = callback; }
      observe(target) { assert.equal(target, scope); }
      disconnect() { disconnects += 1; }
    },
    now: () => clock,
  });
  return {root, scope, witness, replaceCards, emit, ids,
    wait: async (ms) => { clock += ms; },
    disconnects: () => disconnects};
}

test('XHS unchanged old cards cannot prove that a changed time filter refreshed results', async () => {
  const p = page();
  p.root.append(new Element('caption', 'new decorative text'));
  p.emit([{removedNodes: []}]);
  const result = await p.witness.waitForSettled({changed: true, wait: p.wait});
  assert.equal(result.verified, false);
  assert.equal(result.transitioned, false);
  p.witness.disconnect();
  assert.equal(p.disconnects(), 1);
});

test('XHS already-active time filter accepts stable matching cards without a new transition', async () => {
  const p = page();
  const result = await p.witness.waitForSettled({changed: false, wait: p.wait});
  assert.equal(result.verified, true);
  assert.equal(result.reason, 'already_active');
});

test('XHS identical result IDs rendered in new card nodes are valid refreshed results', async () => {
  const p = page();
  p.replaceCards(p.ids);
  const result = await p.witness.waitForSettled({changed: true, wait: p.wait});
  assert.equal(result.verified, true);
  assert.equal(result.reason, 'result_cards_replaced');
});

test('XHS replacement of the result container still accepts an identical result set', async () => {
  const p = page();
  p.scope.remove(p.root);
  const replacement = p.scope.append(new Element('feeds-container'));
  for (const id of p.ids) replacement.append(new Element('note-item')).append(new Element('', '', {href: `/explore/${id}`}));
  p.emit([{removedNodes: [p.root]}]);
  const result = await p.witness.waitForSettled({changed: true, wait: p.wait});
  assert.equal(result.verified, true);
  assert.equal(result.reason, 'result_root_replaced');
});

test('XHS a lazy-loaded tail does not prove the time filter refreshed the old result set', async () => {
  const p = page();
  p.root.append(new Element('note-item')).append(new Element('', '', {href: '/explore/665df0000000000000000003'}));
  p.emit([{removedNodes: []}]);
  assert.equal((await p.witness.waitForSettled({changed: true, wait: p.wait})).verified, false);
});

test('XHS result-scoped loading lifecycle accepts unchanged IDs after loading finishes', async () => {
  const p = page();
  const loading = p.scope.append(new Element('loading'));
  p.emit();
  p.scope.remove(loading);
  p.emit([{removedNodes: [loading]}]);
  assert.equal((await p.witness.waitForSettled({changed: true, wait: p.wait})).verified, true);
});

test('XHS a visible scoped empty state after result clearing completes normally', async () => {
  const p = page();
  p.replaceCards([]);
  p.scope.append(new Element('empty-container', '没有找到相关笔记'));
  p.emit();
  const result = await p.witness.waitForSettled({changed: true, wait: p.wait});
  assert.equal(result.verified, true);
  assert.equal(result.confirmedEmpty, true);
  assert.equal(result.cardCount, 0);
});

test('XHS hidden empty state and matching post text do not prove empty search results', async () => {
  const p = page();
  p.root.children[0].append(new Element('empty-container', '暂无相关结果'));
  const empty = p.scope.append(new Element('empty-container', '暂无相关结果'));
  empty.hidden = true;
  p.emit();
  assert.equal(p.witness.sample().confirmedEmpty, false);
  p.replaceCards([]);
  assert.equal((await p.witness.waitForSettled({changed: true, wait: p.wait})).verified, false);
});

test('XHS filter evidence is tied to the requested time option and remains keyword-scoped', () => {
  const result = {results: [{field: 'publishTime', value: 'day', applied: true}], xhsTimeFilterEvidence: {verified: true, active: true}};
  assert.equal(isXhsSearchTimeFilterVerified(result, 'day'), true);
  assert.equal(isXhsSearchTimeFilterVerified(result, 'week'), false);
  assert.equal(isXhsSearchTimeFilterVerified({...result, xhsTimeFilterEvidence: {verified: false, active: true}}, 'day'), false);
  const error = createXhsSearchTimeFilterError(result);
  assert.equal(error.fatal, false);
  assert.equal(error.stopBatch, false);
  assert.equal(error.retryable, false);
});

function runFilters({platform = 'xiaohongshu', options = {}, active = {}, fail = [], resetTime = false, evidence = {verified: true, confirmedEmpty: false}} = {}) {
  const applied = [];
  let witnessed = 0;
  let disconnected = 0;
  const context = vm.createContext({
    window: {location: {href: `https://www.${platform}.com/search_result`}},
    detectPageType: () => 'search_results', isXhsPublishTimeWindow,
    assertNoDouyinSearchSecurityChallengePage() {}, assertNoDouyinSearchServiceAbnormalPage() {},
    assertNoXhsSearchFilterSecurityPage() {},
    shouldApplyBatchFilter: (value, defaultValue) => Boolean(value && value !== defaultValue && value !== 'all'),
    ensureKeywordStrategyFilterPanelOpen: async () => true,
    isBatchFilterOptionActive: ({field, value}) => active[field] === (value || options[field]),
    applyBatchFilterOption: async ({field, value}) => {
      applied.push(field);
      if (fail.includes(field)) return false;
      active[field] = value;
      if (resetTime && field === 'contentType') active.publishTime = 'all';
      return true;
    },
    closeKeywordStrategyFilterPanel: async () => true,
    waitForKeywordStrategyUi: async () => {},
    beginXhsSearchFilterEvidence: () => { witnessed += 1; return {waitForSettled: async () => evidence, disconnect: () => { disconnected += 1; }}; },
  });
  const constants = contentSource.slice(contentSource.indexOf('const BATCH_SORT_LABELS'), contentSource.indexOf('async function handleApplyBatchSearchFilters'));
  const fn = contentSource.slice(contentSource.indexOf('async function applyBatchSearchFilters('), contentSource.indexOf('async function prepareKeywordStrategyCapture('));
  vm.runInContext(`${constants}\n${fn}\nglobalThis.run = applyBatchSearchFilters;`, context);
  return {result: context.run(options), applied, counts: () => ({witnessed, disconnected})};
}

test('XHS time verification allows unrelated sorting failure and does not apply default options', async () => {
  const h = runFilters({options: {sort: 'latest', publishTime: 'day', contentType: 'all', verifyXhsTimeFilter: true}, fail: ['sort']});
  const result = await h.result;
  assert.equal(result.complete, false);
  assert.equal(isXhsSearchTimeFilterVerified(result, 'day'), true);
  assert.deepEqual(h.applied, ['sort', 'publishTime']);
  assert.deepEqual(h.counts(), {witnessed: 1, disconnected: 1});
});

test('XHS final verification catches another filter resetting the time selection', async () => {
  const h = runFilters({options: {publishTime: 'day', contentType: 'video', verifyXhsTimeFilter: true}, resetTime: true});
  assert.equal(isXhsSearchTimeFilterVerified(await h.result, 'day'), false);
  assert.equal(h.counts().disconnected, 1);
});

test('No-window and Douyin filtering never starts the XHS observer', async () => {
  for (const config of [
    {options: {sort: 'latest', publishTime: 'all', verifyXhsTimeFilter: true}},
    {platform: 'douyin', options: {publishTime: 'day', verifyXhsTimeFilter: true}},
  ]) {
    const h = runFilters(config);
    const result = await h.result;
    assert.equal(result.xhsTimeFilterEvidence, undefined);
    assert.equal(h.counts().witnessed, 0);
  }
});

function filterRelay(sendMessage) {
  const context = vm.createContext({
    chrome: {runtime: {sendMessage}}, MESSAGE_TYPE: {RELAY_TO_CONTENT: 'relay'},
    isXhsPublishTimeWindow, isXhsSearchTimeFilterVerified, createXhsSearchTimeFilterError, createXhsSecurityBlockError,
    assertNoDouyinSearchSecurityChallengeInTab: async () => {},
    isDouyinSearchServiceAbnormalError: error => error?.code === 'DOUYIN_SEARCH_SERVICE_ABNORMAL',
    isDouyinSearchSecurityChallengeError: error => error?.code === 'DOUYIN_SEARCH_SECURITY_CHALLENGE',
    createDouyinSearchServiceAbnormalError: value => value,
    createDouyinSearchSecurityChallengeError: value => value,
  });
  const fn = syncSource.slice(syncSource.indexOf('function createSearchFilterApplicationError('), syncSource.indexOf('function formatEnhanceSkipReason('));
  vm.runInContext(`${fn}\nglobalThis.run = applySearchFiltersInTab;`, context);
  return context.run;
}

test('XHS explicit time window fails closed for missing evidence or relay failure without forcing default filters', async () => {
  let payload;
  const run = filterRelay(async (request) => { payload = request.payload; return {ok: true, data: {ok: true, data: {complete: true, results: []}}}; });
  await assert.rejects(run(1, {publishTime: 'day'}, {platform: 'xiaohongshu'}), error => error.code === 'XHS_SEARCH_TIME_FILTER_UNVERIFIED' && error.fatal === false);
  assert.equal(payload.verifyDefaults, false);
  assert.equal(payload.verifyXhsTimeFilter, true);
  const failed = filterRelay(async () => { throw new Error('disconnected'); });
  await assert.rejects(failed(1, {publishTime: 'day'}, {platform: 'xiaohongshu'}), error => error.code === 'XHS_SEARCH_TIME_FILTER_UNVERIFIED');
  assert.equal(await failed(1, {publishTime: 'all'}, {platform: 'xiaohongshu'}), null);
  assert.equal(await failed(1, {publishTime: 'day'}, {platform: 'douyin'}), null);
});

test('XHS known platform safety evidence is never downgraded to a keyword filter failure', async () => {
  const securityError = createXhsSecurityBlockError({confirmed: true, reason: 'rate_limit', variant: 'cn_rate_limit_300013', language: 'zh-CN'});
  const run = filterRelay(async () => ({ok: true, data: {ok: false, error: securityError}}));
  await assert.rejects(run(1, {publishTime: 'day'}, {platform: 'xiaohongshu'}), error =>
    error.code === 'XHS_SECURITY_BLOCK' && error.securityBlocked === true && error.requiresManualAction === true);
});

test('Keyword content request carries the publish window without adding it to single-note requests', () => {
  const context = vm.createContext({});
  const fn = syncSource.slice(syncSource.indexOf('function buildContentRequest('));
  // The function is the last declaration in this module.
  vm.runInContext(`${fn}\nglobalThis.build = buildContentRequest;`, context);
  assert.equal(context.build('keyword', {publishTimeWindow: 'day'}).publishTimeWindow, 'day');
  assert.equal(context.build('single', {publishTimeWindow: 'day'}).publishTimeWindow, undefined);
  const handler = contentSource.slice(contentSource.indexOf('async function handleCaptureKeywordNotes('), contentSource.indexOf('async function handleDetectSearchSortDimension('));
  assert.match(handler, /publishTimeWindow: request\.publishTimeWindow/u);
});
