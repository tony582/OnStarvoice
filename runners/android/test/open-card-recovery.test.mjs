import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUiTree } from '../src/device/ui-tree.mjs';
import { resource } from '../src/device/douyin-profile.mjs';
import { readVerifiedDetail } from '../src/device/douyin-detail.mjs';
import { readUntil } from '../src/device/ui-wait.mjs';
import { createDouyinCalibrationFlow } from '../src/calibration/douyin-flow.mjs';
import { RunnerStore } from '../src/storage/runner-store.mjs';
import { runDiscoveryTask, MAX_SKIPPED_CARDS } from '../src/core/discovery-runner.mjs';
import { fixtureTask, fixtureClock, fixturePermit, fixtureDevice } from './core-fixtures.mjs';

const encode = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const node = (id, text = '', children = '', extra = {}) => `<android.widget.TextView ${Object.entries({
  package: 'com.ss.android.ugc.aweme', class: 'android.widget.TextView', 'resource-id': resource(id),
  text, displayed: 'true', enabled: 'true', bounds: '[0,0][100,100]', ...extra,
}).map(([key, value]) => `${key}="${encode(value)}"`).join(' ')}>${children}</android.widget.TextView>`;
const tree = body => parseUiTree(`<hierarchy>${body}</hierarchy>`);
const keyword = '安吉星壁纸';
const card = { title: '安吉星车机壁纸上新', author: '真实车主' };
const header = node('et_search_kw', keyword) + node('tab', '综合', '', { 'resource-id': 'android:id/text1', selected: 'true' });
const resultsPage = tree(header + node('b87', '', node('desc', card.title) + node('ab0', card.author) + node('za5', '1小时前')));
const detailPage = tree(node('tv_desc', card.title) + node('w67', card.author) + node('n00') + node('iv_back'));
const loadingPage = tree(node('loading_spinner', '') + node('video_surface', ''));
const homePage = tree(node('hmy', '', '', { 'content-desc': '搜索' }));
const group = (label, selected) => node('uxo', '', node('hdi', label) + node('urc', '', node('rmy', selected), { 'content-desc': `已选中，${selected}，按钮` }));
const filterPanel = tree(group('排序依据', '最新发布') + group('发布时间', '一天内') + group('视频时长', '不限') + group('搜索范围', '不限') + group('内容形式', '不限'));

// A fake phone: every hierarchy read advances a fake clock by 6 s, like the DE106.
function fakePhone({ loadingReads = 0, opensDetail = true, opens = detailPage } = {}) {
  let current = resultsPage; let pendingLoading = loadingReads; let clock = 0; let clipboard = 'original';
  const counts = { cardClicks: 0, backPresses: 0, clipboardWrites: 0 };
  const ui = {
    setWindowScope: async () => {},
    read: async () => { clock += 6000; if (pendingLoading > 0) { pendingLoading--; return loadingPage; } return current; },
    waitFor: async predicate => { assert.equal(predicate(current), true, 'waitFor fixture expects the current page to match'); return current; },
    clickXPath: async selector => {
      if (selector.includes('筛选，按钮')) current = filterPanel;
      else if (selector.includes("content-desc='复制链接'")) { clipboard = `看看【${card.author}的图文作品】${card.title} https://v.douyin.com/abc123/`; current = detailPage; }
      else if (selector.includes(card.title)) { counts.cardClicks++; if (opensDetail) current = opens; }
      else throw new Error(`unexpected selector ${selector}`);
    },
    clickId: async id => {
      if (id === 'zsg' || id === 'iv_back') current = resultsPage;
      else if (id === 'n00') current = tree(node('option', '', '', { 'content-desc': '复制链接' }));
      else throw new Error(`unexpected click ${id}`);
    },
    back: async () => { counts.backPresses++; current = resultsPage; },
    getClipboard: async () => clipboard,
    setClipboard: async text => { counts.clipboardWrites++; clipboard = text; },
    currentActivity: async () => '.detail.ultra.ui.UltraDetailActivity',
  };
  return { ui, counts, now: () => clock, set: page => { current = page; }, get current() { return current; } };
}
async function adopt(phone) {
  const flow = createDouyinCalibrationFlow({ ui: phone.ui, now: phone.now });
  const search = await flow.adoptCurrentSearch({ keyword, filters: { sort: '最新发布', time: '一天内' } });
  return { flow, card: search.cards[0] };
}

test('a detail that becomes readable after two not-ready reads is captured with exactly one card click', async () => {
  const phone = fakePhone({ loadingReads: 2 });
  const { flow, card: selected } = await adopt(phone);
  const result = await flow.capture({ card: selected });
  assert.equal(result.identityVerified, false);
  assert.match(result.shareUrl, /^https:\/\/v\.douyin\.com\//u);
  assert.equal(phone.counts.cardClicks, 1);
  assert.equal(phone.counts.backPresses, 0, 'a note returns through its own back control');
});

test('an open detail that never verifies reports detail_ui_not_ready as settled, without another click or copy', async () => {
  const phone = fakePhone({ loadingReads: 100 });
  const { flow, card: selected } = await adopt(phone);
  await assert.rejects(flow.openCard({ card: selected, actionBudgetMs: 60_000 }), error => {
    assert.equal(error.code, 'detail_ui_not_ready');
    assert.equal(error.deviceSettled, true);
    assert.equal(error.attempts, 5, 'reads stop once another full read no longer fits in the budget');
    assert.equal(error.budgetMs, 40_000);
    assert.equal(error.activity, '.detail.ultra.ui.UltraDetailActivity');
    assert.deepEqual(error.observed, { appNodes: 2, noteCaption: 0, noteAuthor: 0, noteShare: 0, videoCaption: 0, videoAuthor: 0, videoShare: 0 });
    return true;
  });
  assert.equal(phone.counts.cardClicks, 1);
  assert.equal(phone.counts.clipboardWrites, 0);
  await assert.rejects(flow.copyLink({ detail: { detailId: selected.cardId } }), { code: 'detail_identity_unverified' });
});

test('a lease-bounded action budget shrinks the detail wait but still allows one full read', async () => {
  const phone = fakePhone({ loadingReads: 100 });
  const { flow, card: selected } = await adopt(phone);
  await assert.rejects(flow.openCard({ card: selected, actionBudgetMs: 12_000 }), error => error.code === 'detail_ui_not_ready' && error.attempts === 1);
  assert.equal(phone.counts.cardClicks, 1);
});

test('a click that leaves the verified results page showing is card_open_failed, not a timeout', async () => {
  const phone = fakePhone({ opensDetail: false });
  const { flow, card: selected } = await adopt(phone);
  await assert.rejects(flow.openCard({ card: selected }), { code: 'card_open_failed', deviceSettled: true, attempts: 2 });
  assert.equal(phone.counts.cardClicks, 1);
});

test('a loaded detail of another work stays detail_identity_unverified on every retry', async () => {
  const phone = fakePhone({ opens: tree(node('tv_desc', '另一条作品') + node('w67', card.author) + node('n00')) });
  const { flow, card: selected } = await adopt(phone);
  await assert.rejects(flow.openCard({ card: selected }), { code: 'detail_identity_unverified', deviceSettled: true, stage: 'loaded' });
  assert.equal(phone.counts.cardClicks, 1);
});

test('recovery presses back at most once from a detail, never from home, and re-reads the filters', async () => {
  const phone = fakePhone();
  const { flow } = await adopt(phone);
  phone.set(detailPage);
  const recovered = await flow.recoverResults();
  assert.equal(recovered.verified, true);
  assert.equal(phone.counts.backPresses, 1);
  phone.set(homePage);
  await assert.rejects(flow.recoverResults(), { code: 'search_context_unverified', deviceSettled: true, backPresses: 0 });
  assert.equal(phone.counts.backPresses, 1, 'home is never left with back');
  phone.set(loadingPage); phone.ui.back = async () => { phone.counts.backPresses++; };
  await assert.rejects(flow.recoverResults(), { code: 'search_context_unverified', deviceSettled: true, backPresses: 2 });
  assert.equal(phone.counts.backPresses, 3);
});

test('readUntil never starts a hierarchy read that cannot finish inside its budget', async () => {
  let clock = 0; let reads = 0;
  const ui = { read: async () => { reads++; clock += 7000; return { nodes: [] }; } };
  const result = await readUntil({ ui, predicate: () => false, budgetMs: 30_000, now: () => clock, retryDelayMs: 0 });
  assert.equal(result.matched, false);
  assert.equal(reads, 3, 'a fourth read would end at 28 s only if it took 7 s; the 10 s bound does not fit');
  assert.equal(result.attempts, 3);
});

test('readVerifiedDetail keeps a hung hierarchy read as device_timeout with closure required', async () => {
  const ui = { read: async () => { throw Object.assign(new Error('hung'), { code: 'device_timeout', stopConfirmationRequired: true }); } };
  await assert.rejects(readVerifiedDetail({ ui, card }), { code: 'device_timeout', stopConfirmationRequired: true });
});

// Runner level: skipping one work is allowed only after the adapter proves the results page again.
const settled = (code, extra = {}) => Object.assign(new Error(code), { code, deviceSettled: true, attempts: 3, ...extra });
const twoCards = { readCards: async () => ({ contextVerified: true, contextId: 'context-1', end: true,
  cards: [{ cardId: 'card-1', title: '第一条', author: '车友' }, { cardId: 'card-2', title: '第二条', author: '车友' }] }) };
async function run({ task = fixtureTask(), overrides = {}, actionTimeoutMs = 10_000 } = {}) {
  const store = new RunnerStore(':memory:');
  const clock = fixtureClock();
  const permit = fixturePermit(task, clock);
  const { device, calls, context } = fixtureDevice(task, overrides);
  try {
    const result = await runDiscoveryTask({ task, store, clock, permit, device, actionTimeoutMs });
    return { result, calls, context, permit };
  } finally { store.close(); }
}

test('one abnormal work is skipped after a proven safe return and the keyword continues', async () => {
  const { result, calls } = await run({ overrides: { ...twoCards,
    openCard: async ({ card }) => { if (card.cardId === 'card-1') throw settled('detail_ui_not_ready'); return { identityVerified: true, cardId: card.cardId, detailId: 'detail-2', externalId: '1234567890123456789' }; } } });
  assert.equal(result.status, 'completed');
  assert.equal(result.stats.links, 1);
  assert.equal(result.stats.skippedCards, 1);
  assert.equal(result.stats.cards, 2);
  assert.equal(result.deviceIdle, true);
  assert.deepEqual(calls, ['inspect', 'search', 'readCards', 'openCard', 'recoverResults', 'openCard', 'copyLink', 'returnToResults']);
});

test('an unproven safe return keeps the precise reason and the device closure protection', async () => {
  const { result, calls } = await run({ actionTimeoutMs: 20, overrides: { ...twoCards,
    openCard: async () => { throw settled('detail_ui_not_ready', { activity: '.detail.ultra.ui.UltraDetailActivity' }); },
    recoverResults: () => new Promise(() => {}) } });
  assert.equal(result.status, 'needs_action');
  assert.equal(result.reason, 'detail_ui_not_ready');
  assert.equal(result.details.recovery, 'device_action_timeout');
  assert.equal(result.details.activity, '.detail.ultra.ui.UltraDetailActivity');
  assert.equal(result.stopConfirmationRequired, true);
  assert.equal(result.deviceClosure.required, true);
  assert.equal(result.deviceClosure.operation, 'recoverResults');
  assert.equal(calls.filter(name => name === 'openCard').length, 1);
});

test('a safe return that shows another context stops before any further card', async () => {
  const { result, calls } = await run({ overrides: { ...twoCards,
    openCard: async () => { throw settled('card_open_failed'); },
    recoverResults: async () => ({ verified: true, contextId: 'another', keyword: '别克壁纸', filters: { sort: 'latest', range: 'day' } }) } });
  assert.equal(result.reason, 'card_open_failed');
  assert.equal(result.details.recovery, 'search_context_changed');
  assert.equal(result.deviceIdle, true);
  assert.deepEqual(calls, ['inspect', 'search', 'readCards', 'openCard', 'recoverResults']);
});

test('an unsettled open failure is never skipped and still requires closure', async () => {
  const { result, calls } = await run({ overrides: { ...twoCards,
    openCard: async () => { throw Object.assign(new Error('x'), { code: 'detail_ui_not_ready' }); } } });
  assert.equal(result.reason, 'detail_ui_not_ready');
  assert.equal(result.deviceIdle, false);
  assert.equal(calls.includes('recoverResults'), false);
});

test('skips are bounded per keyword and the limit is reported', async () => {
  const cards = Array.from({ length: MAX_SKIPPED_CARDS + 1 }, (_, i) => ({ cardId: `card-${i}`, title: `第${i}条`, author: '车友' }));
  const { result, calls } = await run({ overrides: {
    readCards: async () => ({ contextVerified: true, contextId: 'context-1', end: true, cards }),
    openCard: async () => { throw settled('detail_identity_unverified', { stage: 'loaded' }); } } });
  assert.equal(result.reason, 'detail_identity_unverified');
  assert.equal(result.details.skipLimitReached, true);
  assert.equal(result.stats.skippedCards, MAX_SKIPPED_CARDS);
  assert.equal(calls.filter(name => name === 'recoverResults').length, MAX_SKIPPED_CARDS);
});

test('a stop during the safe return is reported as the stop, not as the open failure', async () => {
  const task = fixtureTask();
  const clock = fixtureClock();
  const permit = fixturePermit(task, clock);
  const store = new RunnerStore(':memory:');
  const { device } = fixtureDevice(task, { ...twoCards, openCard: async () => { throw settled('detail_ui_not_ready'); },
    recoverResults: async () => { permit.stop('user_stop'); return new Promise(() => {}); } });
  try {
    const result = await runDiscoveryTask({ task, store, clock, permit, device });
    assert.equal(result.status, 'canceled');
    assert.equal(result.reason, 'user_stop');
    assert.equal(result.deviceIdle, false);
  } finally { store.close(); }
});
