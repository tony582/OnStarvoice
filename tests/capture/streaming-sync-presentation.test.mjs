import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import * as presentation from '../../utils/capture/streaming-sync-presentation.js';

const {
  isStreamingSyncReconciliationRequired,
  formatStreamingSyncSummary,
  buildStreamingSyncTaskIssue,
  buildStreamingSyncTaskMetadata,
  buildStreamingSyncCompletionNotice,
} = presentation;

// Frozen E1f sidebar helpers from 8d9670798662cc25f5aa8744a4f288de905e7e64.
// Keep these independent of the extracted module and of the current checkout's
// sidebar: they characterize old coercion and messaging, not desired cleanup.
function legacyFormatStreamingSyncSummary(stats = {}) {
  if (!stats?.enabled || Number(stats.enqueuedCount || 0) === 0) {
    return '';
  }
  const retryNote =
    Number(stats.retryCount || 0) > 0
      ? `，瞬时重试 ${Number(stats.retryCount || 0)}`
      : '';
  return `同步成功 ${Number(stats.successCount || 0)}，失败 ${Number(stats.failedCount || 0)}，待上传 ${Number(stats.remainingCount || 0)}${retryNote}`;
}

function legacyBuildStreamingSyncTaskIssue(stats = {}) {
  if (!stats?.enabled) return null;
  const failedCount = Number(stats.failedCount || 0);
  const remainingCount = Number(stats.remainingCount || 0);
  const blocked = Boolean(stats.blocked);
  if (!blocked && failedCount === 0 && remainingCount === 0) {
    return null;
  }
  const successCount = Number(stats.successCount || 0);
  const blockedReason = String(stats?.error?.message || '').trim();
  return {
    code: blocked ? 'STREAMING_SYNC_BLOCKED' : 'STREAMING_SYNC_INCOMPLETE',
    message: [
      blockedReason ? `数据同步未完成：${blockedReason}` : '数据同步未全部完成',
      `成功 ${successCount}，失败 ${failedCount}，待上传 ${remainingCount}`,
    ].join('；'),
  };
}

function legacyBuildStreamingSyncTaskMetadata(stats = {}) {
  return {
    syncSuccessCount: Number(stats?.successCount || 0),
    syncFailedCount: Number(stats?.failedCount || 0),
    syncSkippedCount: Number(stats?.skippedCount || 0),
    syncRemainingCount: Number(stats?.remainingCount || 0),
    syncRetryCount: Number(stats?.retryCount || 0),
    syncBlocked: Boolean(stats?.blocked),
  };
}

// Equivalent projection of the original manual handler's failed-count branch
// followed by its success showMessage call. NaN was not treated as > 0 there.
function legacyBuildStreamingSyncCompletionNotice(stats, {enabled = false} = {}) {
  if (Number(stats?.failedCount || 0) > 0) return null;
  if (enabled && Number(stats?.enqueuedCount || 0) > 0 && !stats?.blocked) {
    return {
      message: `已采数据已同步后台：成功 ${Number(stats?.successCount || 0)} 条，跳过 ${Number(stats?.skippedCount || 0)} 条`,
      tone: 'success',
    };
  }
  return null;
}

const legacyPairs = [
  [formatStreamingSyncSummary, legacyFormatStreamingSyncSummary],
  [buildStreamingSyncTaskIssue, legacyBuildStreamingSyncTaskIssue],
  [buildStreamingSyncTaskMetadata, legacyBuildStreamingSyncTaskMetadata],
];

function assertLegacyParity(stats, description) {
  for (const [actual, legacy] of legacyPairs) {
    assert.deepEqual(actual(stats), legacy(stats), `${actual.name}: ${description}`);
  }
  for (const enabled of [false, true, 0, 1, '', 'yes']) {
    assert.deepEqual(
      buildStreamingSyncCompletionNotice(stats, {enabled}),
      legacyBuildStreamingSyncCompletionNotice(stats, {enabled}),
      `notice: ${description}; enabled=${String(enabled)}`,
    );
  }
}

function held(overrides = {}) {
  return {
    enabled: true, reconciliationRequired: true,
    enqueuedCount: 3, processedCount: 1, successCount: 1,
    failedCount: 0, skippedCount: 0, remainingCount: 2, retryCount: 0,
    blocked: false, drainCompleted: false,
    ...overrides,
  };
}

test('streaming presentation exposes only the five pure presentation helpers', () => {
  assert.deepEqual(Object.keys(presentation).sort(), [
    'buildStreamingSyncCompletionNotice',
    'buildStreamingSyncTaskIssue',
    'buildStreamingSyncTaskMetadata',
    'formatStreamingSyncSummary',
    'isStreamingSyncReconciliationRequired',
  ]);
});

test('only the explicit boolean true marker requires reconciliation', () => {
  for (const input of [undefined, null, {}, false, 'true', 1]) {
    assert.equal(isStreamingSyncReconciliationRequired(input), false);
  }
  for (const value of [undefined, null, false, 0, 1, '', 'true', [], {}, new Boolean(true)]) {
    assert.equal(isStreamingSyncReconciliationRequired({reconciliationRequired: value}), false);
  }
  assert.equal(isStreamingSyncReconciliationRequired({reconciliationRequired: true}), true);
});

test('missing, primitive and disabled inputs retain frozen legacy output shapes', () => {
  for (const input of [undefined, null, {}, false, true, 0, 1, '', 'old-stats', [], {enabled: false}]) {
    assertLegacyParity(input, String(input));
  }
});

test('legacy numeric fallback and coercion remain identical over the count matrix', () => {
  const fields = ['enqueuedCount', 'successCount', 'failedCount', 'skippedCount', 'remainingCount', 'retryCount'];
  const values = [undefined, null, false, true, 0, -0, -3, 2, 0.5, '', '0', '4', '-2', '  ', 'invalid', NaN, Infinity, -Infinity];
  for (const enabled of [undefined, false, true, 0, 1, '', 'yes']) {
    for (const field of fields) {
      for (const value of values) {
        const stats = Object.freeze({enabled, enqueuedCount: 3, successCount: 2,
          failedCount: 0, skippedCount: 1, remainingCount: 0, retryCount: 0, [field]: value});
        assertLegacyParity(stats, `${field}=${String(value)}; stats.enabled=${String(enabled)}`);
      }
    }
  }
});

test('non-boolean reconciliation markers never change existing blocked or incomplete messages', () => {
  for (const reconciliationRequired of [undefined, null, false, 0, 1, '', 'true', [], {}]) {
    for (const blocked of [false, true, 0, 1, '', 'false']) {
      for (const message of [undefined, null, '', '  ', '  backend check rejected  ', 0, 42]) {
        assertLegacyParity({enabled: true, reconciliationRequired, blocked,
          enqueuedCount: 4, successCount: 1, failedCount: 1, remainingCount: 2,
          error: {message}}, `marker=${String(reconciliationRequired)}; blocked=${String(blocked)}; message=${String(message)}`);
      }
    }
  }
});

test('normal completion preserves the old wording, option source and NaN branch', () => {
  const expected = {message: '已采数据已同步后台：成功 2 条，跳过 1 条', tone: 'success'};
  assert.deepEqual(buildStreamingSyncCompletionNotice(
    {enabled: false, enqueuedCount: '3', successCount: '2', skippedCount: 1}, {enabled: true}), expected);
  assert.equal(buildStreamingSyncCompletionNotice({enabled: true, enqueuedCount: 3}), null);
  assert.deepEqual(buildStreamingSyncCompletionNotice(
    {enqueuedCount: 3, successCount: 2, skippedCount: 1, failedCount: 'invalid'}, {enabled: true}), expected);
  for (const stats of [{enqueuedCount: 0}, {enqueuedCount: 3, blocked: true}, {enqueuedCount: 3, failedCount: 1}]) {
    assert.equal(buildStreamingSyncCompletionNotice(stats, {enabled: true}), null);
  }
});

test('held summary names reconciliation rather than uploads or a retry action', () => {
  const summary = formatStreamingSyncSummary(held({retryCount: 4}));
  assert.match(summary, /待核对/);
  assert.doesNotMatch(summary, /待上传|瞬时重试|(?:请|稍后|正在|将会)自动重试/);
  assert.doesNotMatch(summary, /已同步后台|全部完成/);
});

test('held issue is explicit, non-retryable and cannot be mistaken for a legacy incomplete issue', () => {
  const issue = buildStreamingSyncTaskIssue(held());
  assert.equal(issue.code, 'STREAMING_SYNC_RECONCILIATION_REQUIRED');
  assert.equal(issue.retryable, false);
  assert.equal(issue.reconciliationRequired, true);
  assert.match(issue.message, /待核对/);
  assert.doesNotMatch(issue.message, /待上传|(?:请|稍后|正在|将会)自动重试/);
});

test('held metadata keeps existing count semantics and adds only the two lightweight flags', () => {
  const stats = held({successCount: '2', failedCount: -1, skippedCount: '3', remainingCount: 'invalid', retryCount: 4, blocked: 1});
  assert.deepEqual(buildStreamingSyncTaskMetadata(stats), {
    ...legacyBuildStreamingSyncTaskMetadata(stats),
    syncReconciliationRequired: true,
    syncDrainCompleted: false,
  });
});

test('held completion is a warning only when enabled and never reuses success wording', () => {
  const notice = buildStreamingSyncCompletionNotice(held(), {enabled: true});
  assert.equal(notice.tone, 'warning');
  assert.match(notice.message, /待核对/);
  assert.doesNotMatch(notice.message, /已采数据已同步后台|同步成功|待上传/);
  assert.equal(buildStreamingSyncCompletionNotice(held()), null);
  assert.equal(buildStreamingSyncCompletionNotice(held(), {enabled: false}), null);
  assert.equal(buildStreamingSyncCompletionNotice(held(), {enabled: 0}), null);
});

test('true hold dominates disabled, empty, malformed and contradictory completion counts', () => {
  for (const overrides of [
    {enabled: false, enqueuedCount: 0, remainingCount: 0, drainCompleted: true},
    {enqueuedCount: 0, processedCount: 0, successCount: 0, remainingCount: 0},
    {enqueuedCount: -2, successCount: -2, remainingCount: -2},
    {enqueuedCount: 'invalid', successCount: 'invalid', failedCount: 'invalid', remainingCount: 'invalid'},
    {blocked: true, error: {message: 'network timeout; retry now'}, failedCount: 3},
    {canceled: true, drainCompleted: true, enqueuedCount: 3, successCount: 3, remainingCount: 0},
  ]) {
    const stats = held(overrides);
    assert.match(formatStreamingSyncSummary(stats), /待核对/);
    assert.equal(buildStreamingSyncTaskIssue(stats).code, 'STREAMING_SYNC_RECONCILIATION_REQUIRED');
    assert.equal(buildStreamingSyncTaskMetadata(stats).syncDrainCompleted, false);
    assert.equal(buildStreamingSyncCompletionNotice(stats, {enabled: true}).tone, 'warning');
  }
});

test('presentation never reads full receipts, record identifiers or queue control methods', () => {
  const stats = held();
  for (const key of ['heldRecordIds', 'heldRecordId', 'records', 'operations', 'remoteResult',
    'receipt', 'reconciliationSnapshot', 'getReconciliationSnapshot', 'cancel', 'drain', 'enqueue']) {
    Object.defineProperty(stats, key, {
      enumerable: true,
      get() {throw new Error(`presentation must not consume ${key}`);},
    });
  }
  Object.freeze(stats);
  assert.equal(isStreamingSyncReconciliationRequired(stats), true);
  assert.match(formatStreamingSyncSummary(stats), /待核对/);
  assert.equal(buildStreamingSyncTaskIssue(stats).reconciliationRequired, true);
  assert.deepEqual(Object.keys(buildStreamingSyncTaskMetadata(stats)).sort(), [
    'syncBlocked', 'syncDrainCompleted', 'syncFailedCount', 'syncReconciliationRequired',
    'syncRemainingCount', 'syncRetryCount', 'syncSkippedCount', 'syncSuccessCount',
  ]);
  assert.equal(buildStreamingSyncCompletionNotice(stats, {enabled: true}).tone, 'warning');
});

test('helpers do not mutate frozen inputs or retain caller-mutable returned objects', () => {
  const stats = Object.freeze(held({error: Object.freeze({message: 'old failure'})}));
  const before = structuredClone(stats);
  const issue = buildStreamingSyncTaskIssue(stats);
  const metadata = buildStreamingSyncTaskMetadata(stats);
  const notice = buildStreamingSyncCompletionNotice(stats, {enabled: true});
  issue.retryable = true;
  metadata.syncDrainCompleted = true;
  notice.tone = 'success';
  assert.equal(buildStreamingSyncTaskIssue(stats).retryable, false);
  assert.equal(buildStreamingSyncTaskMetadata(stats).syncDrainCompleted, false);
  assert.equal(buildStreamingSyncCompletionNotice(stats, {enabled: true}).tone, 'warning');
  assert.deepEqual(stats, before);
});

test('presentation module has no imports, browser, storage, transport or recovery dependencies', () => {
  const source = readFileSync(new URL('../../utils/capture/streaming-sync-presentation.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*import\b/m);
  assert.doesNotMatch(source, /\b(?:chrome|browser|localStorage|sessionStorage|indexedDB|fetch|XMLHttpRequest|createRecordSyncQueue)\s*[.(]/);
  assert.doesNotMatch(source, /\b(?:markRecordSynced|setDataPool|projectElasticKeywordRecoveryStatus)\s*\(/);
});
