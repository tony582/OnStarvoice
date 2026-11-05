import test from 'node:test';
import assert from 'node:assert/strict';
import {RunnerStore} from '../src/storage/runner-store.mjs';
import {runWechatTask} from '../src/core/wechat-runner.mjs';
import {wechatWorkKey} from '../src/core/wechat-evidence.mjs';
import {cardKey} from '../src/device/wechat-ocr-parse.mjs';
import {fixtureClock, fixturePermit} from './core-fixtures.mjs';

const task = (overrides = {}) => ({identity: {taskId: 'run-1', discoveryRunId: 'run-1', itemId: 'item-1', attemptId: 'attempt-1',
  agentId: 'agent-1', requestHash: 'a'.repeat(64), assignmentRevision: 1}, deviceId: 'phone-1', keyword: '别克车机升级',
platform: 'wechat_channels', mode: 'keyword', filters: {sort: 'latest', publishWindowHours: 24},
comments: {enabled: true, limit: 20}, budgets: {maxLinks: 0, maxCards: 0, maxSwipes: 0, keywordMs: 900_000, batchMs: 1_200_000, maxPending: 100},
...overrides});
const card = (snippet, author, hours) => {
  const value = {snippet, author, timeLabel: `${hours}小时`, likeLabel: '', age: {minHours: hours, maxHours: hours + 1}, tap: {x: 275, y: 900}};
  return {...value, cardKey: cardKey(value)};
};

function device({pages, calls = []}) {
  let page = 0, opened = null, links = 0;
  const methods = {
    inspect: async () => ({deviceId: 'phone-1', connected: true, unlocked: true, loggedIn: true, challenge: false, readyForSearch: true}),
    search: async () => ({verified: true, cards: pages[0]}),
    readCards: async () => pages[page],
    openCard: async ({card: target}) => { opened = target; return {opened: true}; },
    copyLink: async () => ({shareUrl: `https://weixin.qq.com/sph/Abc${++links}xyz`}),
    readComments: async ({limit}) => ({status: 'captured', headerCount: 2, post: null,
      items: [{author: '车主甲', location: '江苏', timeLabel: '2天前', content: `评论 ${opened.snippet}`, likeCount: 3, reply: false, parentIndex: null}].slice(0, limit)}),
    returnToResults: async () => pages[page],
    recoverResults: async () => pages[page],
    scroll: async () => { page = Math.min(page + 1, pages.length - 1); return {scrolled: true}; },
  };
  return Object.fromEntries(Object.entries(methods).map(([name, fn]) => [name, async params => { calls.push(name); return fn(params); }]));
}

function preview(byLink) {
  return {resolve: async link => {
    const index = Number(link.match(/Abc(\d+)xyz/u)[1]);
    return byLink(index);
  }};
}

test('a Channels keyword: in-window cards are opened, linked, read and recorded; the run stops past the window', async () => {
  const store = new RunnerStore(':memory:');
  const clock = fixtureClock();
  const t = task();
  const permit = fixturePermit(t, clock);
  const calls = [];
  const pages = [[card('新车机升级来了', '车主A', 1), card('升级后很卡', '车主B', 3)],
    [card('老款车机怎么升级', '车主C', 30), card('车机升级教程', '车主D', 40), card('更老的', '车主E', 50)]];
  const nowSec = Math.floor(clock.wallNow() / 1000);
  const result = await runWechatTask({task: t, store, device: device({pages, calls}), permit, clock, postPauseMs: [0, 0],
    preview: preview(index => ({unavailable: false, description: `文案 ${index}`, createtime: nowSec - index * 3600,
      nickname: `作者${index}`, avatarUrl: '', likeCountFmt: '1', favCountFmt: '2', forwardCountFmt: '3', commentCountFmt: '4',
      coverUrl: '', isImage: false, exportId: ''}))});
  assert.equal(result.status, 'completed');
  assert.equal(result.reason, 'publish_window_end');
  assert.equal(result.stats.posts, 2);
  assert.equal(result.deviceIdle, true);
  assert.deepEqual(calls.filter(name => name === 'openCard').length, 2);
  const events = [store.getEvent(result.lastEventId).payload];
  assert.equal(events[0].eventKind, 'wechat_post');
  assert.equal(events[0].comments.items.length, 1);
  assert.equal(events[0].link.shareUrl, 'https://weixin.qq.com/sph/Abc2xyz');
  assert.equal(store.pendingForAttempt('attempt-1'), 2);
  store.close();
});

test('the exact preview time drops a post outside the window and skips its comments', async () => {
  const store = new RunnerStore(':memory:');
  const clock = fixtureClock();
  const t = task();
  const calls = [];
  const nowSec = Math.floor(clock.wallNow() / 1000);
  const result = await runWechatTask({task: t, store, device: device({pages: [[card('标签说一小时', '车主A', 1)]], calls}),
    permit: fixturePermit(t, clock), clock, postPauseMs: [0, 0],
    preview: preview(() => ({unavailable: false, description: '其实是旧帖', createtime: nowSec - 48 * 3600, nickname: '作者',
      avatarUrl: '', likeCountFmt: '', favCountFmt: '', forwardCountFmt: '', commentCountFmt: '', coverUrl: '', isImage: false, exportId: ''}))});
  assert.equal(result.stats.posts, 0);
  assert.equal(result.stats.outsideWindow, 1);
  assert.equal(calls.includes('readComments'), false);
  assert.equal(result.status, 'completed');
  store.close();
});

test('a failed preview never uploads OCR-only data; a settled open failure is skipped after a safe return', async () => {
  const store = new RunnerStore(':memory:');
  const clock = fixtureClock();
  const t = task({filters: {sort: 'all', publishWindowHours: null}, comments: {enabled: false, limit: 0}});
  const calls = [];
  let opens = 0;
  const base = device({pages: [[card('打不开的', '车主A', 1), card('能打开的', '车主B', 2)]], calls});
  const broken = {...base, openCard: async params => {
    calls.push('openCard');
    if (++opens === 1) throw Object.assign(new Error('no'), {code: 'card_open_failed', deviceSettled: true});
    return {opened: true, params};
  }};
  const result = await runWechatTask({task: t, store, device: broken, permit: fixturePermit(t, clock), clock, postPauseMs: [0, 0],
    preview: {resolve: async () => { throw Object.assign(new Error('down'), {code: 'preview_timeout'}); }}});
  assert.equal(result.stats.posts, 0);
  assert.equal(result.stats.previewFailed, 1);
  assert.ok(calls.includes('recoverResults'));
  assert.equal(result.reason, 'results_end');
  assert.equal(store.pendingCount(), 0);
  store.close();
});

test('a stop during the run cancels it and leaves the device settled', async () => {
  const store = new RunnerStore(':memory:');
  const clock = fixtureClock();
  const t = task();
  const permit = fixturePermit(t, clock);
  const base = device({pages: [[card('一', '甲', 1), card('二', '乙', 2)]]});
  const stopping = {...base, readComments: async () => { permit.stop('remote_stop'); return {status: 'captured', items: []}; }};
  const nowSec = Math.floor(clock.wallNow() / 1000);
  const result = await runWechatTask({task: t, store, device: stopping, permit, clock, postPauseMs: [0, 0],
    preview: preview(index => ({unavailable: false, description: `文案 ${index}`, createtime: nowSec - 60, nickname: `作者${index}`,
      avatarUrl: '', likeCountFmt: '', favCountFmt: '', forwardCountFmt: '', commentCountFmt: '', coverUrl: '', isImage: false, exportId: ''}))});
  assert.equal(result.status, 'canceled');
  assert.equal(result.reason, 'remote_stop');
  store.close();
});

test('the work key follows the preview identity (publish second + author)', () => {
  assert.equal(wechatWorkKey({createtime: 1793671301, nickname: '上海交通广播'}), wechatWorkKey({createtime: 1793671301, nickname: '上海交通广播'}));
  assert.notEqual(wechatWorkKey({createtime: 1793671301, nickname: '上海交通广播'}), wechatWorkKey({createtime: 1793671302, nickname: '上海交通广播'}));
});

test('the outbox batches one kind of event at a time', () => {
  const store = new RunnerStore(':memory:');
  const base = {discoveryRunId: 'r', itemId: 'i', attemptId: 'a'};
  store.recordEvent({...base, eventId: 'e1'});
  store.recordEvent({...base, eventId: 'e2', eventKind: 'wechat_post'});
  store.recordEvent({...base, eventId: 'e3'});
  store.recordEvent({...base, eventId: 'e4', eventKind: 'wechat_post'});
  const first = store.nextBatch();
  assert.deepEqual(first.events.map(event => event.eventId), ['e1', 'e3']);
  store.ackBatch(first.uploadBatchId, first.events.map(event => ({eventId: event.eventId, status: 'accepted', receiptId: 'r'})));
  assert.deepEqual(store.nextBatch().events.map(event => event.eventId), ['e2', 'e4']);
  store.close();
});
