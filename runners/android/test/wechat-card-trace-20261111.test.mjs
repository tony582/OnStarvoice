import test from 'node:test';
import assert from 'node:assert/strict';
import {RunnerStore} from '../src/storage/runner-store.mjs';
import {runWechatTask} from '../src/core/wechat-runner.mjs';
import {CARD_DIAGNOSTICS_KEY, CARD_DIAGNOSTICS_LIMIT, createWechatCardTrace} from '../src/core/wechat-card-diagnostics.mjs';
import {recordDiagnostic, readDiagnostics} from '../src/core/diagnostics.mjs';
import {cardKey} from '../src/device/wechat-ocr-parse.mjs';
import {fixtureClock, fixturePermit} from './core-fixtures.mjs';

const card = (name, hours = 1, previewHours = hours) => {
  const value = {snippet: name, author: `作者${name}`, timeLabel: hours === null ? '' : `${hours}小时前`,
    column: 0, age: hours === null ? null : {minHours: hours, maxHours: hours + 1}, tap: {x: 275, y: 900}, previewHours};
  return {...value, cardKey: cardKey(value)};
};
const old = n => card(`旧${n}`, 48);
async function collect(pages, {prefilter = null, failOpen = '', budgets = {}, readCards = null,
  returnCards = null, recoverCards = null} = {}) {
  const store = new RunnerStore(':memory:'), clock = fixtureClock(), opened = [], openTaps = [], reads = [];
  const task = {identity: {taskId: 'run', discoveryRunId: 'run', itemId: 'item', attemptId: 'attempt',
    agentId: 'agent', requestHash: 'a'.repeat(64), assignmentRevision: 1}, deviceId: 'phone', keyword: '安吉星',
    platform: 'wechat_channels', filters: {sort: 'latest', publishWindowHours: 24}, comments: {enabled: false},
    budgets: {maxLinks: 0, maxCards: 0, maxSwipes: 20, keywordMs: 300_000, batchMs: 900_000, maxPending: 100, ...budgets}};
  let page = 0, target;
  for (const cards of pages) Object.defineProperty(cards, 'screenEvidence', {value: {rawOcrRows: 17, parsedCards: cards.length}});
  const device = {inspect: async () => ({deviceId: 'phone'}),
    search: async ({onDiagnostic}) => {onDiagnostic({event: 'wechat_sort_evidence', beforeHash: 'a'.repeat(64)}); return {verified: true, cards: pages[page]};},
    readCards: async () => {reads.push(page); return readCards ? readCards(pages[page], page) : pages[page];},
    openCard: async ({card}) => {target = card; if (card.snippet === failOpen) throw Object.assign(new Error('open'), {code: 'card_open_failed', deviceSettled: true}); opened.push(card.snippet); openTaps.push(card.tap);},
    copyLink: async () => ({shareUrl: `https://weixin.qq.com/sph/Test${opened.length}`}),
    readComments: async () => ({items: []}),
    returnToResults: async () => returnCards ? returnCards(pages[page], page) : pages[page],
    recoverResults: async () => recoverCards ? recoverCards(pages[page], page) : pages[page],
    scroll: async () => {page = Math.min(page + 1, pages.length - 1);}};
  const result = await runWechatTask({task, store, device, clock, permit: fixturePermit(task, clock), prefilter, postPauseMs: [0, 0],
    preview: {resolve: async () => target.previewHours === null ? {unavailable: true} : {
      createtime: Math.floor(clock.wallNow() / 1000 - target.previewHours * 3600), nickname: target.author,
      description: target.snippet, unavailable: false}}});
  return {result, opened, openTaps, reads, notes: readDiagnostics(store, {key: CARD_DIAGNOSTICS_KEY}), main: readDiagnostics(store), store};
}

test('two old cards followed by a new card remain collectable; three old cards on the following screen stop', async () => {
  const f = await collect([[old(1), old(2), card('新')], [old(3), old(4), old(5)]]);
  try {
    assert.deepEqual(f.opened, ['新']);
    assert.equal(f.result.reason, 'publish_window_end');
    assert.equal(f.result.stats.stopReason, 2);
    assert.equal(f.result.stats.cardsSeen, 6);
    assert.equal(f.result.stats.outsideWindow, 5);
    assert.equal(f.result.stats.opened, 1);
    assert.ok(f.notes.some(n => n.disposition === 'old_card' && n.author === '作者旧5'));
  } finally {f.store.close();}
});

test('even the third old card cannot stop before a later new card on the same screen', async () => {
  const f = await collect([[old(1), old(2), old(3), card('末尾新')], [card('下一屏新')], [old(4), old(5), old(6)]]);
  try {
    assert.deepEqual(f.opened, ['末尾新', '下一屏新']);
    assert.equal(f.result.stats.posts, 2);
    assert.equal(f.result.reason, 'publish_window_end');
  } finally {f.store.close();}
});

test('unreadable age resets the streak even when its preview is unavailable', async () => {
  const f = await collect([[old(1), old(2), card('未知', null, null), old(3)], [card('下一屏新')], [old(4), old(5), old(6)]]);
  try { assert.deepEqual(f.opened, ['未知', '下一屏新']); assert.equal(f.result.stats.posts, 1); }
  finally {f.store.close();}
});

test('exact preview ages also wait until the screen is exhausted before stopping', async () => {
  const f = await collect([[card('网页旧1', 1, 48), card('网页旧2', 1, 48), card('网页旧3', 1, 48), card('新')], [old(4), old(5), old(6)]]);
  try {
    assert.deepEqual(f.opened, ['网页旧1', '网页旧2', '网页旧3', '新']);
    assert.equal(f.result.stats.posts, 1);
    assert.equal(f.notes.filter(n => n.disposition === 'outside_window').length, 3);
  } finally {f.store.close();}
});

test('three consecutive exact old previews end at the screen boundary without scrolling', async () => {
  const f = await collect([[card('网页旧1', 1, 48), card('网页旧2', 1, 48), card('网页旧3', 1, 48)], [card('不应到达')]]);
  try {assert.equal(f.result.reason, 'publish_window_end'); assert.equal(f.result.stats.swipes, 0); assert.equal(f.result.stats.posts, 0);}
  finally {f.store.close();}
});

test('a card lost from return OCR is reread before a three-old-card stop and uses only its fresh tap', async () => {
  const freshTap = {x: 777, y: 1111};
  const pages = [[card('网页旧1', 1, 48), card('网页旧2', 1, 48), card('网页旧3', 1, 48), card('漏识新卡')], [old(4), old(5), old(6)]];
  const f = await collect(pages, {
    returnCards: (cards, page) => page === 0 ? cards.slice(0, 3) : cards,
    readCards: (cards, page) => page === 0 ? cards.map(c => c.snippet === '漏识新卡' ? {...c, tap: freshTap} : c) : cards,
  });
  try {
    assert.deepEqual(f.opened, ['网页旧1', '网页旧2', '网页旧3', '漏识新卡']);
    assert.deepEqual(f.openTaps.at(-1), freshTap);
    assert.deepEqual(f.reads, [0, 1]);
    assert.equal(f.result.stats.posts, 1);
    assert.equal(f.result.stats.swipes, 1);
    assert.ok(f.notes.some(n => n.event === 'screen' && n.source === 'reread'));
    assert.equal(f.result.reason, 'publish_window_end');
  } finally {f.store.close();}
});

test('a still-missing card clears the old streak and continues without clicking its stale coordinates', async () => {
  const pages = [[card('网页旧1', 1, 48), card('网页旧2', 1, 48), card('网页旧3', 1, 48), card('持续漏识')],
    [card('下屏新卡')], [old(4), old(5), old(6)]];
  const omit = (cards, page) => page === 0 ? cards.slice(0, 3) : cards;
  const f = await collect(pages, {returnCards: omit, readCards: omit});
  try {
    assert.deepEqual(f.opened, ['网页旧1', '网页旧2', '网页旧3', '下屏新卡']);
    assert.deepEqual(f.reads, [0, 1, 2]);
    assert.equal(f.result.stats.swipes, 2);
    assert.ok(f.notes.some(n => n.disposition === 'missing_on_reread' && n.snippet === '持续漏识'));
    assert.ok(f.notes.some(n => n.disposition === 'not_opened' && n.snippet === '持续漏识'));
  } finally {f.store.close();}
});

test('recovery OCR also retains pending cards until one reread has checked them', async () => {
  const pages = [[card('打不开'), old(1), old(2), old(3), card('恢复后新卡')], [old(4), old(5), old(6)]];
  const f = await collect(pages, {failOpen: '打不开', recoverCards: (cards, page) => page === 0 ? cards.slice(0, 4) : cards});
  try {
    assert.deepEqual(f.opened, ['恢复后新卡']);
    assert.deepEqual(f.reads, [0, 1]);
    assert.equal(f.result.stats.posts, 1);
    assert.equal(f.result.stats.swipes, 1);
  } finally {f.store.close();}
});

test('card diagnostics retain screen counts and all local dispositions, while statistics contain only numbers', async () => {
  const skip = card('预筛跳过'), bad = card('打不开'), ok = card('成功');
  const f = await collect([[skip, bad, ok], [old(1), old(2), old(3)]], {failOpen: bad.snippet,
    prefilter: () => ({enabled: true, decide: async () => ({skip: new Set([skip.cardKey]), judged: 3, unjudged: 0})})});
  try {
    for (const disposition of ['prefilter_skip', 'open_failed', 'opened', 'duplicate', 'old_card']) assert.ok(f.notes.some(n => n.disposition === disposition), disposition);
    assert.ok(f.notes.some(n => n.event === 'screen' && n.rawOcrRows === 17 && n.parsedCards === 3));
    assert.ok(f.notes.some(n => n.event === 'card' && n.keyword === '安吉星' && n.timeLabel && n.age && n.screen > 0));
    assert.ok(Object.values(f.result.stats).every(value => typeof value === 'number'));
    assert.ok(f.main.some(n => n.event === 'wechat_sort_evidence'));
    assert.equal(JSON.stringify(f.result.stats).includes('作者'), false);
  } finally {f.store.close();}
});

test('a budget stop accounts for parsed cards that were never opened', async () => {
  const f = await collect([[card('先打开'), card('预算后')]], {budgets: {maxCards: 1}});
  try {assert.equal(f.result.reason, 'card_limit'); assert.ok(f.notes.some(n => n.disposition === 'not_opened' && n.snippet === '预算后'));}
  finally {f.store.close();}
});

test('the 3000-entry local card ring overwrites its oldest entries without displacing the error ring', () => {
  const store = new RunnerStore(':memory:');
  try {
    recordDiagnostic(store, {event: 'keep_failure'});
    store.saveCheckpoint(CARD_DIAGNOSTICS_KEY, {entries: Array.from({length: CARD_DIAGNOSTICS_LIMIT}, (_, index) => ({event: 'old', index}))});
    const trace = createWechatCardTrace({store, task: {keyword: '安吉星'}, clock: fixtureClock()});
    trace.observe([card('新')], 'search'); trace.record(card('新'), 'opened');
    const entries = readDiagnostics(store, {key: CARD_DIAGNOSTICS_KEY});
    assert.equal(entries.length, 3000); assert.equal(entries[0].index, 2);
    assert.equal(entries.at(-2).event, 'screen'); assert.equal(entries.at(-1).disposition, 'opened');
    assert.deepEqual(readDiagnostics(store), [{event: 'keep_failure'}]);
  } finally {store.close();}
});
