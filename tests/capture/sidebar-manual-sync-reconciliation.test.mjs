import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import * as reconciliation from '../../utils/capture/sync-reconciliation-state.js';

// Actual local consumers, with I/O replaced. This does not exercise the real
// server, browser collection, or enable the unimplemented confirmation producer.
const source = readFileSync(new URL('../../sidebar/sidebar-logic.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function section(input, start, end) {
  const from = input.indexOf(start);
  assert.ok(from >= 0, start);
  assert.equal(input.indexOf(start, from + start.length), -1, start);
  const to = input.indexOf(end, from + start.length);
  assert.ok(to > from, end);
  return input.slice(from, to);
}
const autoSource = section(source, 'async function maybeRunAutoSyncAfterDetailCapture(', 'async function runDetailCaptureForRecordIds(');
const manualSource = section(source, 'async function handleSyncAll()', 'async function repairInterruptedDetailCaptureRecordsBeforeSync(');
const manualTerminal = manualSource.slice(manualSource.indexOf('    showProgress(`正在同步 ${limitedTargetIds.length} 条记录...`);'));
assert.ok(manualTerminal.startsWith('    showProgress('));

function bridge(result, {syncError, refreshError, stoppedAfterSync = false} = {}) {
  const messages = [];
  const finished = [];
  let syncCalls = 0;
  let refreshes = 0;
  const refresh = async () => {refreshes++; if (refreshError) throw refreshError;};
  const context = vm.createContext({
    ...reconciliation,
    console: {error() {}},
    limitedTargetIds: ['a'], targetIds: ['a'], syncScope: 'pending',
    settings: {autoSyncAfterDetailCapture: true}, commentLeadsConfig: {},
    taskStatus: 'completed', taskError: null, taskContext: {taskId: 'local-test'}, remainingCount: 0,
    getRecords: async ids => ids.map(id => ({id, type: 'single'})),
    buildCommentLeadsConfigFromSettings: () => ({enabled: false}),
    resolveSyncInputForRecord: record => ({syncType: record.type}),
    SYNC_SCOPE_PENDING: 'pending', SYNC_TYPE: {}, ERROR_MESSAGE_MAP: {},
    checkBeforeSync: async () => ({ok: true}),
    syncRecordBatch: async () => {syncCalls++; if (syncError) throw syncError; return result;},
    refreshDataPool: refresh, refreshSyncHistory: refresh,
    showMessage: (message, tone) => messages.push({message, tone}),
    showProgress() {}, hideProgress() {}, handleProgress() {},
    finishSidebarTask: (ctx, outcome) => finished.push(plain(outcome)),
  });
  vm.runInContext(`${autoSource}
    globalThis.runAuto = maybeRunAutoSyncAfterDetailCapture;
    globalThis.runManual = async () => { try { ${manualTerminal};`, context, {timeout: 5000});
  return {
    messages, finished, context,
    get syncCalls() {return syncCalls;}, get refreshes() {return refreshes;},
    auto(options = {}) {
      return context.runAuto(context.settings, {
        recordIds: ['a'], shouldStop: () => stoppedAfterSync && syncCalls > 0, ...options,
      });
    },
    manual() {return context.runManual();},
  };
}

const success = () => ({ok: true, successCount: 1, failedCount: 0, results: [{success: true}]});
const held = extras => ({...success(), reconciliationRequired: true, receipt: {operation: 'ack-a'}, ...extras});
const assertWarning = ui => {
  assert.ok(ui.messages.length > 0);
  assert.equal(ui.messages.every(value => value.tone === 'warning'), true);
  assert.equal(ui.messages.every(value => !/再次点击|重试|同步成功|已自动同步后台/.test(value.message)), true);
};

test('manual explicit hold wins over ok=true, partial leads and remaining-batch retry prompts', async () => {
  for (const remaining of [0, 8]) {
    for (const ok of [true, false]) {
      const input = held({ok, commentLeadsFailedCount: 2});
      const before = plain(input);
      const ui = bridge(input);
      ui.context.remainingCount = remaining;
      await ui.manual();
      assertWarning(ui);
      assert.equal(ui.finished[0].status, 'needs_action');
      assert.deepEqual(ui.finished[0].error, reconciliation.buildSyncReconciliationError());
      assert.equal(ui.syncCalls, 1);
      assert.deepEqual(input, before);
    }
  }
});

test('manual refresh failure cannot replace an already observed hold with an ordinary failure', async () => {
  const ui = bridge(held(), {refreshError: new Error('refresh unavailable')});
  await ui.manual();
  assertWarning(ui);
  assert.equal(ui.finished[0].status, 'needs_action');
  assert.equal(ui.finished[0].error.retryable, false);
  assert.equal(ui.syncCalls, 1);
});

test('manual thrown confirmation signal is distinct from a normal network failure', async () => {
  const hold = bridge(null, {syncError: {code: 'LOCAL_CONFIRMATION_REQUIRED'}});
  await hold.manual();
  assertWarning(hold);
  assert.equal(hold.finished[0].status, 'needs_action');
  const normal = bridge(null, {syncError: new Error('network timeout')});
  await normal.manual();
  assert.equal(normal.finished[0].status, 'failed');
  assert.equal(normal.messages.at(-1).tone, 'error');
});

test('manual no-marker success and remaining-batch warning keep the existing behavior', async () => {
  for (const remaining of [0, 5]) {
    const ui = bridge(success());
    ui.context.remainingCount = remaining;
    await ui.manual();
    assert.equal(ui.messages.at(-1).tone, remaining ? 'warning' : 'success');
    assert.equal(ui.finished[0].status, 'completed');
    assert.equal(ui.finished[0].error, null);
  }
});

test('manual ordinary partial leads still use the legacy retry copy', async () => {
  const ui = bridge({...success(), ok: false, commentLeadsFailedCount: 1});
  await ui.manual();
  assert.match(ui.messages.at(-1).message, /仅重试失败记录/);
  assert.equal(ui.finished[0].status, 'completed_with_failures');
});

test('auto explicit hold retains the receipt and counters before cancellation or refresh', async () => {
  for (const canceled of [false, true]) {
    const input = held({canceled, error: {receipt: {confirmed: 'remote'}}});
    const before = plain(input);
    const ui = bridge(input, {stoppedAfterSync: true, refreshError: new Error('must not refresh')});
    const result = await ui.auto();
    assert.equal(result.ok, false);
    assert.equal(result.canceled, canceled);
    assert.equal(result.reconciliationRequired, true);
    assert.deepEqual(plain(result.receipt), input.receipt);
    assert.equal(result.successCount, 1);
    assert.equal(result.error.retryable, false);
    assert.deepEqual(plain(result.error.receipt), {confirmed: 'remote'});
    assert.equal(ui.refreshes, 0);
    assert.equal(ui.syncCalls, 1);
    assertWarning(ui);
    assert.deepEqual(input, before);
  }
});

test('auto silent hold returns structured state without emitting a toast', async () => {
  const ui = bridge(held());
  assert.equal((await ui.auto({silent: true})).reconciliationRequired, true);
  assert.deepEqual(ui.messages, []);
  assert.equal(ui.refreshes, 0);
});

test('auto thrown hold is preserved even when cancellation has arrived', async () => {
  const ui = bridge(null, {syncError: {requiresReconciliation: true, receipt: {confirmed: 'remote'}}, stoppedAfterSync: true});
  const result = await ui.auto();
  assert.equal(result.reconciliationRequired, true);
  assert.equal(result.error.code, 'SYNC_RECONCILIATION_REQUIRED');
  assert.deepEqual(plain(result.error.receipt), {confirmed: 'remote'});
  assert.equal(ui.refreshes, 0);
  assertWarning(ui);
});

test('auto no-marker result, cancellation and ordinary failure retain legacy shape', async () => {
  const input = success();
  const normal = bridge(input);
  assert.equal(await normal.auto(), input);
  assert.equal(normal.messages.at(-1).tone, 'success');
  assert.equal(normal.refreshes, 2);
  const canceled = bridge({...input, canceled: true});
  assert.deepEqual(plain(await canceled.auto()), {
    ok: false, canceled: true, skipped: true, reason: 'capture_task_canceled', message: '任务已取消，未继续同步',
  });
  const failed = bridge(null, {syncError: new Error('offline')});
  const result = await failed.auto();
  assert.equal(result.phase, 'sync');
  assert.equal(result.reconciliationRequired, undefined);
});

test('truthy flags and nested response text cannot opt manual or auto into reconciliation', async () => {
  for (const marker of ['true', 1, {}, false, null]) {
    const input = {...success(), reconciliationRequired: marker, rawResponse: {requiresReconciliation: true}};
    const manual = bridge(input);
    await manual.manual();
    assert.equal(manual.finished[0].status, 'completed');
    const auto = bridge(input);
    assert.equal(await auto.auto(), input);
    assert.equal(auto.messages.at(-1).tone, 'success');
  }
});
