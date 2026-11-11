import test from 'node:test';
import assert from 'node:assert/strict';
import {completionStats} from '../src/cloud/completion-stats.mjs';
import {AndroidDaemon} from '../src/daemon/runtime.mjs';
import {stateValue} from '../src/daemon/state.mjs';
import {RunnerStore} from '../src/storage/runner-store.mjs';
import {fixtureTask} from './core-fixtures.mjs';

test('completion uploads T17 counters without local card text or nested diagnostics', async () => {
  const store = new RunnerStore(':memory:'), task = fixtureTask({platform: 'wechat_channels'}), sent = [];
  const stats = {links: 2, cards: 7, cardsSeen: 7, opened: 3, outsideWindow: 4, stopReason: 2, screens: 2,
    keywordElapsedMs: 8123.5, author: '只留本机的作者', title: '只留本机的标题',
    card: {author: '作者', title: '标题'}, privateNumeric: 42, swipes: -1, posts: '2', comments: null};
  try {
    const daemon = new AndroidDaemon({store, config: {deviceId: task.deviceId, agentId: 'agent-1'}, device: {}, delivery: {},
      control: {complete: async body => {sent.push(structuredClone(body)); return {accepted: true, deviceHeld: false};}}});
    daemon.saveCompletion({task, sessionId: 'session-1'}, {status: 'completed', reason: 'time_window_end', deviceIdle: true, stats});
    assert.equal(await daemon.flushCompletion(), true);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].checkpoint.stats, {links: 2, cards: 7, keywordElapsedMs: 8123.5,
      outsideWindow: 4, cardsSeen: 7, opened: 3, stopReason: 2, screens: 2});
    assert.equal(sent[0].reason, 'time_window_end', 'the ordinary completion reason stays separate from its numeric enum');
    assert.ok(Object.values(sent[0].checkpoint.stats).every(value => typeof value === 'number'));
    assert.equal(stats.author, '只留本机的作者', 'projection does not rewrite local diagnostics');
    assert.equal(stateValue(store, 'daemon:completion'), null);
    assert.deepEqual(stateValue(store, 'daemon:last-completion').request, sent[0]);
  } finally {store.close();}
});

test('completion counters retain all existing phone-platform metrics', () => {
  const existing = {links: 2, cards: 6, swipes: 2, skippedCards: 1, keywordElapsedMs: 300.5, batchElapsedMs: 900,
    prefilterSkipped: 1, prefilterJudged: 4, prefilterUnjudged: 1, posts: 2, previewFailed: 1, previewUnavailable: 0,
    outsideWindow: 2, comments: 3, partialBodies: 1, unavailableBodies: 0, timeUnverified: 1, pageFailures: 0};
  assert.deepEqual(completionStats(existing), existing);
});

test('completion rejects untrusted shapes and nonnumeric enum values', () => {
  for (const value of [null, undefined, [], 'private', 3]) assert.equal(completionStats(value), null);
  for (const value of [-1, NaN, Infinity, 'time_window_end', '2', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(completionStats({stopReason: value, cardsSeen: 0}), {cardsSeen: 0});
  }
  assert.deepEqual(completionStats(Object.assign(Object.create({opened: 1}), {screens: 0})), {screens: 0});
  assert.deepEqual(completionStats({cardsSeen: {title: 'private'}, opened: '2', outsideWindow: Infinity, screens: -1}), {});
});
