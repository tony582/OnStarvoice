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
  let opens = 0, previewCalls = 0;
  const base = device({pages: [[card('打不开的', '车主A', 1), card('能打开的', '车主B', 2)]], calls});
  const broken = {...base, openCard: async params => {
    calls.push('openCard');
    if (++opens === 1) throw Object.assign(new Error('no'), {code: 'card_open_failed', deviceSettled: true});
    return {opened: true, params};
  }};
  const result = await runWechatTask({task: t, store, device: broken, permit: fixturePermit(t, clock), clock, postPauseMs: [0, 0],
    preview: {resolve: async () => {
      previewCalls++;
      throw Object.assign(new Error('fallback also timed out'), {code: 'preview_timeout', retryable: false});
    }}});
  assert.equal(previewCalls, 1, 'a preview that exhausted its fallback must not be retried by the task');
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

test('patrol: the stored link refreshes counts; with comments the post is looked up and must match its publish second', async () => {
  const createtime = 1793671301;
  const info = (overrides = {}) => ({unavailable: false, description: '承诺更新不履约', createtime, nickname: '上海交通广播', avatarUrl: '',
    likeCountFmt: '1', favCountFmt: '2', forwardCountFmt: '3', commentCountFmt: '4', coverUrl: '', isImage: false, exportId: '', ...overrides});
  const patrolTask = comments => task({mode: 'patrol', keyword: '承诺更新不履约', filters: {sort: 'all', publishWindowHours: null},
    comments, patrolTarget: {recordId: 'r1', url: 'https://weixin.qq.com/sph/Stored1', title: '差评', content: '承诺更新不履约 #别克',
      author: '上海交通广播', createtime}});
  // 1. Comments off: one preview of the stored link, no phone search.
  {
    const store = new RunnerStore(':memory:');
    const clock = fixtureClock();
    const t = patrolTask({enabled: false, limit: 0});
    const calls = [];
    const result = await runWechatTask({task: t, store, device: device({pages: [[]], calls}), permit: fixturePermit(t, clock), clock,
      postPauseMs: [0, 0], preview: {resolve: async () => info()}});
    assert.equal(result.reason, 'patrol_preview');
    assert.equal(calls.includes('search'), false);
    const event = store.getEvent(result.lastEventId).payload;
    assert.equal(event.mode, 'patrol');
    assert.equal(event.link.shareUrl, 'https://weixin.qq.com/sph/Stored1');
    store.close();
  }
  // 2. Comments on: a look-alike card from another day is rejected, the real one is read.
  {
    const store = new RunnerStore(':memory:');
    const clock = fixtureClock();
    const t = patrolTask({enabled: true, limit: 10});
    const calls = [];
    const pages = [[card('承诺更新不履约', '上海交通广播', 50), card('承诺更新不履约！#上汽通用', '上海交通广播', 48)]];
    const result = await runWechatTask({task: t, store, device: device({pages, calls}), permit: fixturePermit(t, clock), clock,
      postPauseMs: [0, 0], preview: {resolve: async link => link.endsWith('Stored1') ? info() : link.includes('Abc1') ? info({createtime: createtime - 86_400}) : info()}});
    assert.equal(result.reason, 'patrol_relocated');
    assert.equal(calls.filter(name => name === 'openCard').length, 2);
    const event = store.getEvent(result.lastEventId).payload;
    assert.equal(event.link.shareUrl, 'https://weixin.qq.com/sph/Abc2xyz');
    assert.equal(event.comments.items.length, 1);
    store.close();
  }
  // 2b. The stored link's preview carries an export id: the post is opened directly, no search, comments read.
  {
    const store = new RunnerStore(':memory:');
    const clock = fixtureClock();
    const t = patrolTask({enabled: true, limit: 10});
    const calls = [];
    const exportId = 'export/UzFfBgAAxKWAeCIjPWGPk8zT4DCsIuXYLQ';
    const base = device({pages: [[]], calls});
    const opened = [];
    const linked = {...base, openPost: async params => { calls.push('openPost'); opened.push(params.exportId); return {opened: true}; },
      readComments: async () => { calls.push('readComments'); return {status: 'captured', headerCount: 1, post: null,
        items: [{author: '那年夏天', location: '湖北', timeLabel: '1天前', content: '[图片]', likeCount: null, reply: false, parentIndex: null}]}; }};
    const result = await runWechatTask({task: t, store, device: linked, permit: fixturePermit(t, clock), clock,
      postPauseMs: [0, 0], preview: {resolve: async () => info({exportId})}});
    assert.equal(result.reason, 'patrol_relocated');
    assert.deepEqual(opened, [exportId]);
    assert.equal(calls.includes('search'), false);
    const event = store.getEvent(result.lastEventId).payload;
    assert.equal(event.link.shareUrl, 'https://weixin.qq.com/sph/Stored1', 'the stored link stays the post link');
    assert.deepEqual(event.comments.items.map(item => item.content), ['[图片]']);
    store.close();
  }
  // 2c. Opening by link does not reach the work page (phone settled): the search path still finds the post.
  {
    const store = new RunnerStore(':memory:');
    const clock = fixtureClock();
    const t = patrolTask({enabled: true, limit: 10});
    const calls = [];
    const pages = [[card('承诺更新不履约！#上汽通用', '上海交通广播', 48)]];
    const base = device({pages, calls});
    const failing = {...base, openPost: async () => { calls.push('openPost');
      throw Object.assign(new Error('WeChat did not reach the expected screen'), {code: 'screen_unverified', deviceSettled: true}); }};
    const result = await runWechatTask({task: t, store, device: failing, permit: fixturePermit(t, clock), clock, postPauseMs: [0, 0],
      preview: {resolve: async () => info({exportId: 'export/UzFfBgAAxKWAeCIjPWGPk8zT4DCsIuXYLQ'})}});
    assert.equal(result.reason, 'patrol_relocated');
    assert.deepEqual(calls.filter(name => ['openPost', 'search', 'openCard'].includes(name)), ['openPost', 'search', 'openCard']);
    assert.equal(store.getEvent(result.lastEventId).payload.link.shareUrl, 'https://weixin.qq.com/sph/Abc1xyz');
    store.close();
  }
  // 3. Nothing works: no event, a warning ending that only cools the post down on the server.
  {
    const store = new RunnerStore(':memory:');
    const clock = fixtureClock();
    const t = patrolTask({enabled: true, limit: 10});
    const result = await runWechatTask({task: t, store, device: device({pages: [[card('别的帖子', '别人', 2)]]}), permit: fixturePermit(t, clock),
      clock, postPauseMs: [0, 0], preview: {resolve: async () => ({unavailable: true, reason: '内容已删除'})}});
    assert.equal(result.status, 'completed_with_warnings');
    assert.equal(result.reason, 'patrol_not_relocated');
    assert.equal(store.pendingCount(), 0);
    store.close();
  }
});

test('the App\'s own 时长 / 范围 choices from the task reach the phone search; a task without them searches with 不限', async () => {
  for (const [filters, expected] of [
    [{sort: 'latest', publishWindowHours: 24, duration: 'under_5m', scope: 'viewed'}, {sort: 'latest', duration: 'under_5m', scope: 'viewed'}],
    [{sort: 'hot', publishWindowHours: null}, {sort: 'hot', duration: 'all', scope: 'all'}],
  ]) {
    const store = new RunnerStore(':memory:');
    const clock = fixtureClock();
    const t = task({filters});
    const base = device({pages: [[]]});
    let searched = null;
    const watching = {...base, search: async params => { searched = params; return base.search(params); }};
    await runWechatTask({task: t, store, device: watching, permit: fixturePermit(t, clock), clock, postPauseMs: [0, 0],
      preview: {resolve: async () => ({unavailable: true})}});
    assert.deepEqual({sort: searched.sort, duration: searched.duration, scope: searched.scope}, expected);
    store.close();
  }
});

test('发到微信: the stored link must still be the same post; then the post is opened and forwarded once', async () => {
  const createtime = 1793851201;
  const info = (overrides = {}) => ({unavailable: false, description: '忍无可忍', createtime, nickname: '萧枫-东莞新起点凯迪专修', avatarUrl: '',
    likeCountFmt: '', favCountFmt: '', forwardCountFmt: '', commentCountFmt: '', coverUrl: '', isImage: false,
    exportId: 'export/UzFfBgAAxKWAeCIjPWGPk8zT4DCsIobzXQ', ...overrides});
  const forwardTask = () => task({mode: 'forward', keyword: '金明Tony', filters: {sort: 'all', publishWindowHours: null},
    comments: {enabled: false, limit: 0}, forwardTarget: {recordId: 'r1', url: 'https://weixin.qq.com/sph/AsvBQklNxh', recipient: '金明Tony',
      title: '忍无可忍', author: '萧枫-东莞新起点凯迪专修', createtime}});
  const run = async (preview, sent = {sent: true, confirmed: true}) => {
    const store = new RunnerStore(':memory:');
    const clock = fixtureClock();
    const t = forwardTask();
    const calls = [];
    const base = device({pages: [[]], calls});
    const phone = {...base, openPost: async params => { calls.push(['openPost', params.exportId]); return {opened: true}; },
      forwardPost: async params => { calls.push(['forwardPost', params.recipient]); return sent; }};
    const result = await runWechatTask({task: t, store, device: phone, permit: fixturePermit(t, clock), clock, postPauseMs: [0, 0], preview: {resolve: preview}});
    store.close();
    return {result, calls: calls.filter(Array.isArray), searched: calls.includes('search')};
  };
  const ok = await run(async () => info());
  assert.deepEqual([ok.result.status, ok.result.reason], ['completed', 'forward_sent']);
  assert.deepEqual(ok.calls, [['openPost', 'export/UzFfBgAAxKWAeCIjPWGPk8zT4DCsIobzXQ'], ['forwardPost', '金明Tony']]);
  assert.equal(ok.searched, false);
  assert.equal((await run(async () => info(), {sent: true, confirmed: false})).result.reason, 'forward_unconfirmed');
  const moved = await run(async () => info({createtime: createtime - 60}));
  assert.deepEqual([moved.result.status, moved.result.reason, moved.calls.length], ['needs_action', 'forward_post_mismatch', 0]);
  const gone = await run(async () => ({unavailable: true}));
  assert.deepEqual([gone.result.reason, gone.calls.length], ['forward_post_unavailable', 0]);
});
