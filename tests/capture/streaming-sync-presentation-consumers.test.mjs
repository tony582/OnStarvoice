import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import * as presentation from '../../utils/capture/streaming-sync-presentation.js';
import * as reconciliation from '../../utils/capture/sync-reconciliation-state.js';
import {createRecordSyncQueue} from '../../utils/record-sync-queue.js';

// Execute the actual sidebar terminal sections and drain adapter. Capture,
// browser UI, and refresh I/O are seams; presentation/status decisions are not
// copied. This is local consumer preparation, not full browser or server QA.
const sidebar = readFileSync(new URL('../../sidebar/sidebar-logic.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function section(source, start, end) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `missing actual source marker: ${start}`);
  assert.equal(source.indexOf(start, from + start.length), -1, `ambiguous source marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `missing ending source marker: ${end}`);
  return source.slice(from, to);
}

const manualSource = section(sidebar,
  'async function handleCaptureSearchData()', 'function setKeywordStrategyTab(');
const batchSource = section(sidebar,
  'async function handleBatchKeywordCapture(options = {})', 'function activateUnattendedRunRequest(');
const terminalStart = '\n    streamingSyncResult = await drainStreamingDetailSyncQueue(';
const terminalEnd = '\n  } catch (error) {';
const manualTerminal = section(manualSource, terminalStart, terminalEnd);
const batchTerminal = section(batchSource, terminalStart, terminalEnd);
const drainSource = section(sidebar,
  'async function drainStreamingDetailSyncQueue(', 'async function handleBatchKeywordCapture(');
const factorySource = section(sidebar,
  'function createStreamingDetailAutoSyncQueue(', 'function routeDetailItemToStreamingSync(');

function syncStats(overrides = {}) {
  return {
    enabled: true, enqueuedCount: 2, processedCount: 2,
    successCount: 2, failedCount: 0, skippedCount: 0, retryCount: 0,
    pendingCount: 0, activeCount: 0, remainingCount: 0,
    blocked: false, canceled: false,
    ...overrides,
  };
}

function heldStats(overrides = {}) {
  return syncStats({
    enqueuedCount: 3, processedCount: 1, successCount: 1,
    pendingCount: 1, remainingCount: 2, reconciliationRequired: true,
    heldRecordId: 'B', heldRecordIds: ['B', 'C'], heldUniqueCount: 2,
    drainCompleted: false,
    ...overrides,
  });
}

function bridge(stats, overrides = {}) {
  const messages = [];
  const progress = [];
  const notifications = [];
  const context = vm.createContext({
    ...presentation,
    ...reconciliation,
    streamingSyncQueue: {
      enabled: Boolean(stats?.enabled),
      getStats: () => stats,
      drain: async () => stats,
    },
    streamingSyncResult: null,
    streamingSyncDrained: false,
    taskStatus: 'completed',
    searchRound: 2,
    searchAutoLoop: false,
    searchCaptureCancelRequested: false,
    round: 2,
    autoLoop: false,
    sequentialSearchEnabled: false,
    sequentialSearchPasses: ['one', 'two', 'three'],
    batchKeywordCancelRequested: false,
    result: {stats: {total: 3, processed: 3, success: 3, failed: 0}},
    totalSuccess: 3,
    totalFailed: 0,
    sidebarTaskStatus: 'failed',
    sidebarTaskError: null,
    sidebarTaskMetadata: {existing: 'preserved'},
    refreshDataPool: async () => {},
    refreshSyncHistory: async () => {},
    showMessage: (message, tone) => messages.push({message, tone}),
    showProgress: (message, tone) => progress.push({message, tone}),
    updateBatchProgress: value => progress.push(plain(value)),
    notifyProgress: value => notifications.push(plain(value)),
    ...overrides,
  });
  vm.runInContext(`${drainSource}
    globalThis.runManual = async () => {
      ${manualTerminal}
      return {taskStatus, streamingSyncDrained, streamingSyncResult};
    };
    globalThis.runBatch = async () => { ${batchTerminal} };`, context, {timeout: 5000});
  return {context, messages, progress, notifications};
}

test('manual consumer retains the ordinary successful upload notice and counters', async () => {
  const stats = syncStats();
  const original = plain(stats);
  const ui = bridge(stats);
  const result = await ui.context.runManual();
  assert.deepEqual(ui.messages, [{
    message: '已采数据已同步后台：成功 2 条，跳过 0 条', tone: 'success',
  }]);
  assert.equal(result.taskStatus, 'completed');
  assert.equal(result.streamingSyncResult.drainCompleted, true);
  assert.deepEqual(stats, original, 'the consumer must not rewrite queue counters');
});

test('manual consumer keeps ordinary failure, blocked, disabled and empty queue behavior', async () => {
  for (const [overrides, status, expectedNotice] of [
    [{failedCount: 1, successCount: 1}, 'completed_with_failures', /边采边同步部分失败/],
    [{blocked: true, error: {message: 'authentication required'}}, 'completed', /同步前检查失败|authentication required/],
    [{enabled: false}, 'completed', null],
    [{enqueuedCount: 0, processedCount: 0, successCount: 0}, 'completed', null],
  ]) {
    const ui = bridge(syncStats(overrides));
    assert.equal((await ui.context.runManual()).taskStatus, status);
    assert.equal(ui.messages.some(({tone}) => tone === 'success'), false);
    if (expectedNotice) assert.match(ui.messages.at(-1).message, expectedNotice);
    else assert.deepEqual(ui.messages, []);
  }
});

test('manual hold uses a verification warning even after a previous ordinary failure', async () => {
  for (const failedCount of [0, 1]) {
    const ui = bridge(heldStats({failedCount}));
    const result = await ui.context.runManual();
    assert.match(ui.messages.at(-1).message, /同步待核对/);
    assert.equal(ui.messages.every(({tone}) => tone === 'warning'), true);
    assert.equal(ui.messages.some(({message}) => /已采数据已同步后台/.test(message)), false);
    assert.equal(result.streamingSyncResult.drainCompleted, false);
    assert.equal(result.streamingSyncResult.remainingCount, 2);
    assert.equal(result.taskStatus, failedCount ? 'completed_with_failures' : 'completed',
      'this section changes presentation, not the existing task-status protocol');
  }
});

test('manual auto-loop completion and cancellation never add a success tone to a hold', async () => {
  for (const canceled of [false, true]) {
    const ui = bridge(heldStats({canceled}), {
      searchAutoLoop: true, searchCaptureCancelRequested: canceled,
    });
    await ui.context.runManual();
    assert.equal(ui.messages.length, 2);
    assert.match(ui.messages[0].message, /同步待核对/);
    assert.equal(ui.messages.at(-1).message,
      `无人值守搜索采集${canceled ? '已停止' : '结束'}:共跑 2 轮`);
    assert.equal(ui.messages.every(({tone}) => tone === 'warning'), true);
  }
});

test('manual and batch consumers do not opt in for truthy non-boolean hold markers', async () => {
  for (const marker of ['true', 1, {}, null, false]) {
    for (const method of ['runManual', 'runBatch']) {
      const ui = bridge(syncStats({reconciliationRequired: marker}));
      await ui.context[method]();
      assert.equal(ui.messages.at(-1).tone, 'success');
      assert.equal(ui.messages.some(({message}) => /待核对/.test(message)), false);
    }
  }
});

test('batch success keeps the exact ordinary summary, task metadata and returned result', async () => {
  const ui = bridge(syncStats());
  const outcome = await ui.context.runBatch();
  assert.deepEqual(ui.messages, [{
    message: '批量采集完成：共 3 个关键词，成功 3，失败 0；同步成功 2，失败 0，待上传 0',
    tone: 'success',
  }]);
  assert.equal(outcome.ok, true);
  assert.equal(ui.context.sidebarTaskStatus, 'completed');
  assert.deepEqual(plain(ui.context.sidebarTaskMetadata), {
    existing: 'preserved', rounds: 2, successCount: 3, failedCount: 0,
    syncSuccessCount: 2, syncFailedCount: 0, syncSkippedCount: 0,
    syncRemainingCount: 0, syncRetryCount: 0, syncBlocked: false,
  });
});

test('batch keeps capture failures and ordinary upload failures in the legacy task-status path', async () => {
  const captureFailure = bridge(syncStats(), {
    result: {stats: {total: 3, processed: 3, success: 2, failed: 1}},
    totalSuccess: 2, totalFailed: 1,
  });
  assert.equal((await captureFailure.context.runBatch()).ok, false);
  assert.equal(captureFailure.messages.at(-1).tone, 'warning');
  assert.equal(captureFailure.context.sidebarTaskStatus, 'completed_with_failures');
  const syncFailure = bridge(syncStats({failedCount: 1, successCount: 1}));
  assert.equal((await syncFailure.context.runBatch()).ok, false);
  assert.equal(syncFailure.context.sidebarTaskError.code, 'STREAMING_SYNC_INCOMPLETE');
  assert.equal(syncFailure.context.sidebarTaskStatus, 'completed_with_failures');
  // The old outer tone is based on capture failures, not upload failures. E1g
  // intentionally changes only explicit holds, not this separate legacy path.
  assert.equal(syncFailure.messages.at(-1).tone, 'success');
});

test('batch hold warns and carries the explicit needs-action signal to the outer consumer', async () => {
  const stats = heldStats({receipt: {body: 'must not enter presentation metadata'}});
  const original = plain(stats);
  const ui = bridge(stats);
  const outcome = await ui.context.runBatch();
  assert.equal(ui.messages.length, 1);
  assert.equal(ui.messages[0].tone, 'warning');
  assert.match(ui.messages[0].message, /同步待核对/);
  assert.doesNotMatch(ui.messages[0].message, /批量采集完成|待上传|瞬时重试/);
  assert.equal(ui.context.sidebarTaskError.code, 'STREAMING_SYNC_RECONCILIATION_REQUIRED');
  assert.equal(ui.context.sidebarTaskError.retryable, false);
  assert.equal(ui.context.sidebarTaskMetadata.syncReconciliationRequired, true);
  assert.equal(ui.context.sidebarTaskMetadata.syncDrainCompleted, false);
  assert.equal(ui.context.sidebarTaskMetadata.syncRemainingCount, 2);
  assert.equal('receipt' in ui.context.sidebarTaskMetadata, false);
  assert.equal('heldRecordIds' in ui.context.sidebarTaskMetadata, false);
  assert.deepEqual(stats, original);
  assert.equal(outcome.ok, false);
  assert.deepEqual(plain(outcome.error), reconciliation.buildSyncReconciliationError());
  assert.equal(outcome.reconciliationRequired, true);
  assert.equal(ui.context.sidebarTaskStatus, 'needs_action');
  assert.equal(outcome.streamingSync.drainCompleted, false);
});

test('auto-loop and sequential-search hold summaries retain capture facts but use warning tone', async () => {
  for (const sequentialSearchEnabled of [false, true]) {
    const ui = bridge(heldStats(), {autoLoop: true, sequentialSearchEnabled});
    await ui.context.runBatch();
    assert.equal(ui.messages.at(-1).tone, 'warning');
    assert.match(ui.messages.at(-1).message, /累计成功 3，失败 0/);
    assert.match(ui.messages.at(-1).message, /同步待核对/);
    assert.match(ui.messages.at(-1).message, sequentialSearchEnabled ? /2\/3 个巡检步骤/ : /共跑 2 轮/);
  }
});

test('batch cancellation keeps its stopped wording and priority when a hold is also present', async () => {
  for (const autoLoop of [false, true]) {
    const ui = bridge(heldStats({canceled: true}), {
      autoLoop, batchKeywordCancelRequested: true,
      result: {canceled: true, stats: {total: 3, processed: 2, success: 2, failed: 0}},
    });
    const outcome = await ui.context.runBatch();
    assert.match(ui.messages.at(-1).message, /已停止/);
    assert.match(ui.messages.at(-1).message, /同步待核对/);
    assert.equal(ui.messages.at(-1).tone, 'warning');
    assert.equal(ui.context.sidebarTaskStatus, 'canceled');
    assert.equal(outcome.canceled, true);
    assert.equal(outcome.ok, false);
  }
});

test('platform safety warning remains ahead of cancellation, auto-loop and hold presentation', async () => {
  const blockingError = {code: 'PLATFORM_SAFETY_BLOCK', message: 'fixture platform verification required'};
  const ui = bridge(heldStats(), {
    autoLoop: true, batchKeywordCancelRequested: true,
    result: {securityBlocked: true, canceled: true, blockingError,
      stats: {total: 3, processed: 1, success: 1, failed: 0}},
  });
  const outcome = await ui.context.runBatch();
  assert.deepEqual(ui.messages, [{message: blockingError.message, tone: 'warning'}]);
  assert.equal(ui.context.sidebarTaskStatus, 'needs_action');
  assert.deepEqual(plain(ui.context.sidebarTaskError), blockingError);
  assert.equal(outcome.securityBlocked, true);
  assert.equal(outcome.ok, false);
});

test('an actual held queue reaches both actual terminal sections without sending its pending record', {timeout: 3000}, async () => {
  let release;
  const pending = new Promise(resolve => {release = resolve;});
  const calls = [];
  const queue = createRecordSyncQueue({
    processRecord: async ({recordId}) => {calls.push(recordId); await pending; return {ok: false, remoteAccepted: true};},
    shouldHoldForReconciliation: result => result.remoteAccepted === true,
    shouldRetry: () => assert.fail('a held result must never reach the retry predicate'),
    retryDelaysMs: [0],
  });
  queue.registerCaptured(['A', 'B']);
  queue.enqueue('A');
  queue.enqueue('B');
  const manual = bridge(null, {streamingSyncQueue: queue});
  const manualCompletion = manual.context.runManual();
  release();
  const result = await manualCompletion;
  assert.equal(result.streamingSyncResult.remainingCount, 2);
  assert.equal(result.streamingSyncResult.drainCompleted, false);
  assert.equal(manual.messages.at(-1).tone, 'warning');
  const batch = bridge(null, {streamingSyncQueue: queue});
  const outcome = await batch.context.runBatch();
  assert.equal(outcome.streamingSync.remainingCount, 2);
  assert.equal(outcome.ok, false);
  assert.equal(batch.messages.at(-1).tone, 'warning');
  assert.deepEqual(calls, ['A']);
});

test('the actual shipping factory still does not enable the hold guard or import the prototype', async () => {
  assert.doesNotMatch(factorySource, /\bshouldHoldForReconciliation\b/);
  assert.doesNotMatch(sidebar, /from\s*['"][^'"]*prototypes\//);
  const context = vm.createContext({
    createRecordSyncQueue: options => options,
    maybeRunAutoSyncAfterDetailCapture: async () => ({ok: true, successCount: 1}),
  });
  vm.runInContext(`${factorySource}\nglobalThis.create = createStreamingDetailAutoSyncQueue;`, context, {timeout: 5000});
  const options = context.create({autoDetailCaptureAfterListCapture: true, autoSyncAfterDetailCapture: true}, {
    shouldHoldForReconciliation: () => assert.fail('the shipping factory must not forward the new opt-in'),
  });
  assert.equal(Object.hasOwn(options, 'shouldHoldForReconciliation'), false);
  assert.equal((await options.processRecord({recordId: 'A'})).ok, true);
});
