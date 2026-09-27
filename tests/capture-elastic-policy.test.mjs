import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ELASTIC_FILTER_VERIFICATION_CODES,
  FILTER_VERIFICATION_SETTLED_MESSAGE,
  buildFilterVerificationSettledError,
  elasticFilterVerificationLimit,
  elasticFilterVerificationSettlement,
  elasticRoundAnchorMs,
  elasticRoundAnchorSql,
  elasticRoundRelaxAfterMs,
  filterVerificationErrorCode,
  filterVerificationWindowBase,
  settleElasticFilterVerification,
} from '../server/services/capture-elastic-policy.js';

// docs/hotfix/20260927-stuck-retry-and-attention-cleanup.md (F1, F2)
const TF = 'XHS_SEARCH_TIME_FILTER_UNVERIFIED';
const AGENT_A = '11111111-1111-4111-8111-111111111111';
const AGENT_B = '22222222-2222-4222-8222-222222222222';
const AGENT_C = '33333333-3333-4333-8333-333333333333';

test('round relax minutes: default 10, 1-1440 accepted, everything else falls back', () => {
  assert.equal(elasticRoundRelaxAfterMs({}), 10 * 60_000);
  assert.equal(elasticRoundRelaxAfterMs({CAPTURE_ELASTIC_ROUND_RELAX_MINUTES: '1'}), 60_000);
  assert.equal(elasticRoundRelaxAfterMs({CAPTURE_ELASTIC_ROUND_RELAX_MINUTES: ' 30 '}), 30 * 60_000);
  assert.equal(elasticRoundRelaxAfterMs({CAPTURE_ELASTIC_ROUND_RELAX_MINUTES: '1440'}), 1440 * 60_000);
  for (const invalid of ['0', '-5', '2.5', '1441', 'abc', '', '1e3', '0x10']) {
    assert.equal(
      elasticRoundRelaxAfterMs({CAPTURE_ELASTIC_ROUND_RELAX_MINUTES: invalid}),
      10 * 60_000,
      invalid,
    );
  }
});

test('filter verification limit: default 3, 2-20 accepted, everything else falls back', () => {
  assert.equal(elasticFilterVerificationLimit({}), 3);
  assert.equal(elasticFilterVerificationLimit({CAPTURE_FILTER_VERIFICATION_LIMIT: '2'}), 2);
  assert.equal(elasticFilterVerificationLimit({CAPTURE_FILTER_VERIFICATION_LIMIT: '20'}), 20);
  for (const invalid of ['0', '1', '-3', '3.5', '21', 'three', '']) {
    assert.equal(
      elasticFilterVerificationLimit({CAPTURE_FILTER_VERIFICATION_LIMIT: invalid}),
      3,
      invalid,
    );
  }
});

test('only the XHS time-filter verification code is governed', () => {
  assert.deepEqual(Array.from(ELASTIC_FILTER_VERIFICATION_CODES), [TF]);
  assert.equal(filterVerificationErrorCode({code: 'xhs_search_time_filter_unverified'}), TF);
  assert.equal(filterVerificationErrorCode({}, {errorCode: TF}), TF);
  assert.equal(filterVerificationErrorCode({code: 'XHS_SEARCH_PAGE_TIMEOUT'}, {errorCode: TF}),
    'XHS_SEARCH_PAGE_TIMEOUT', 'the item error code wins');
});

test('settlement needs K attempts, or every Agent of a pool smaller than K', () => {
  const rule = options => elasticFilterVerificationSettlement({code: TF, limit: 3, ...options}).settle;
  assert.equal(rule({attempts: 2, agents: 2, agentAttemptLimit: 8}), false);
  assert.equal(rule({attempts: 3, agents: 3, agentAttemptLimit: 8}), true);
  // A, B, A: repeated Agents count as attempts.
  assert.equal(rule({attempts: 3, agents: 2, agentAttemptLimit: 8}), true);
  // Pool of two: both Agents failed once.
  assert.equal(rule({attempts: 2, agents: 2, agentAttemptLimit: 2}), true);
  assert.equal(rule({attempts: 1, agents: 1, agentAttemptLimit: 2}), false);
  // Pinned / one-Agent pools keep the original behavior.
  assert.equal(rule({attempts: 5, agents: 1, agentAttemptLimit: 1}), false);
  // Other failures never settle here.
  assert.equal(elasticFilterVerificationSettlement({
    code: 'XHS_SEARCH_PAGE_TIMEOUT', attempts: 9, agents: 8, agentAttemptLimit: 8, limit: 3,
  }).settle, false);
});

test('the settled error keeps the original fields, drops recovery and uses the exact copy', () => {
  const settled = buildFilterVerificationSettledError({
    code: TF,
    category: 'filter_verification',
    message: '结果卡片 0/基线 20；等待 8 秒',
    recovery: {handoffReadyAt: '2026-09-27T04:30:00.000Z'},
  }, {attempts: 3, agents: 3, limit: 3});
  assert.deepEqual(settled, {
    code: TF,
    category: 'filter_verification',
    message: '多台节点都无法确认小红书时间筛选结果（可能该时段没有新内容或页面有变化），已停止自动重试；可稍后在批次里「重试失败关键词」',
    originalMessage: '结果卡片 0/基线 20；等待 8 秒',
    automaticRetryStopped: true,
    automaticRetryStopReason: 'filter_verification_repeated',
    filterVerificationAttemptCount: 3,
    filterVerificationAgentCount: 3,
    filterVerificationLimit: 3,
  });
  assert.equal(settled.message, FILTER_VERIFICATION_SETTLED_MESSAGE);
  assert.equal('recoveryLimitReached' in settled, false,
    'the Admin keeps offering 重试失败关键词');
});

test('the retry window starts after the later manual base', () => {
  assert.equal(filterVerificationWindowBase({}), 0);
  assert.equal(filterVerificationWindowBase({manualRetryBaseAttemptCount: 4}), 4);
  assert.equal(filterVerificationWindowBase({filterVerificationBaseAttemptCount: '7'}), 7);
  assert.equal(filterVerificationWindowBase({
    manualRetryBaseAttemptCount: 9, filterVerificationBaseAttemptCount: 7,
  }), 9);
  assert.equal(filterVerificationWindowBase({manualRetryBaseAttemptCount: 'x'}), 0);
});

function fakeTx(row) {
  const calls = [];
  return {
    calls,
    async queryOne(sql, params) {
      calls.push({sql, params});
      return row;
    },
  };
}

test('projection counts the reporting attempt exactly once, also for a repeated snapshot', async () => {
  const input = {
    tenantId: 'tenant', itemId: 'item', status: 'retryable', elasticPool: true,
    error: {code: TF, message: '结果卡片 0/基线 20'}, checkpoint: {errorCode: TF},
    agentAttemptLimit: 8, itemMetadata: {}, attemptNumber: 3, env: {},
  };
  // Two earlier failures by A and B; C reports the third.
  let tx = fakeTx({attempts: 2, agents: 2, includes_reporter: false});
  const settled = await settleElasticFilterVerification(tx, {...input, reporterAgentId: AGENT_C});
  assert.equal(settled.attempts, 3);
  assert.equal(settled.agents, 3);
  assert.equal(settled.error.automaticRetryStopReason, 'filter_verification_repeated');
  assert.deepEqual(tx.calls[0].params.slice(2, 6), [0, AGENT_C, 3, [TF]]);
  assert.doesNotMatch(tx.calls[0].sql, /PREVIOUS_CAPTURE_STOP_UNCONFIRMED/u);

  // A, B, A: the reporter already failed once, it adds an attempt but no Agent.
  tx = fakeTx({attempts: 2, agents: 2, includes_reporter: true});
  const repeated = await settleElasticFilterVerification(tx, {...input, reporterAgentId: AGENT_A});
  assert.equal(repeated.attempts, 3);
  assert.equal(repeated.agents, 2);

  // Second failure only: stays retryable.
  tx = fakeTx({attempts: 1, agents: 1, includes_reporter: false});
  assert.equal(await settleElasticFilterVerification(tx, {...input, reporterAgentId: AGENT_B, attemptNumber: 2}), null);

  // A duplicate snapshot of the attempt that opened a manual retry window
  // (attempt number == base) is not part of the new window.
  tx = fakeTx({attempts: 0, agents: 0, includes_reporter: false});
  assert.equal(await settleElasticFilterVerification(tx, {
    ...input, reporterAgentId: AGENT_B, attemptNumber: 3,
    itemMetadata: {filterVerificationBaseAttemptCount: 3},
  }), null);
  assert.equal(tx.calls[0].params[2], 3);
});

test('projection never queries for other codes, pools of one, pinned items or non-retryable results', async () => {
  const base = {
    tenantId: 'tenant', itemId: 'item', status: 'retryable', elasticPool: true,
    error: {code: TF}, agentAttemptLimit: 8, reporterAgentId: AGENT_A, attemptNumber: 5, env: {},
  };
  for (const override of [
    {error: {code: 'XHS_SEARCH_PAGE_TIMEOUT'}},
    {agentAttemptLimit: 1},
    {itemMetadata: {pinnedAgentId: AGENT_B}},
    {status: 'failed'},
    {status: 'needs_action'},
    {elasticPool: false},
  ]) {
    const tx = fakeTx({attempts: 9, agents: 8, includes_reporter: false});
    assert.equal(await settleElasticFilterVerification(tx, {...base, ...override}), null, JSON.stringify(override));
    assert.equal(tx.calls.length, 0, JSON.stringify(override));
  }
});

test('the round anchor is the latest valid anchor, not the first present one', () => {
  const stale = '2026-09-27T04:30:00.000Z';
  const waiting = '2026-09-27T13:05:00.123456+08:00';
  assert.equal(elasticRoundAnchorMs({
    metadata: {checkpoint: {recovery: {handoffReadyAt: stale}}, elasticRetryWaitingSince: waiting},
    updated_at: '2026-09-27T06:00:00.000Z',
  }), Date.parse('2026-09-27T05:05:00.123Z'));
  assert.equal(elasticRoundAnchorMs({
    metadata: {checkpoint: {recovery: {handoffReadyAt: stale}}},
    error: {recovery: {handoffReadyAt: '2026-09-27T05:00:00.000Z'}},
  }), Date.parse('2026-09-27T05:00:00.000Z'));
  // Offsets without a colon parse too.
  assert.equal(elasticRoundAnchorMs({metadata: {elasticRetryWaitingSince: '2026-09-27T12:00:00+0800'}}),
    Date.parse('2026-09-27T04:00:00.000Z'));
  // Only when all three are missing or invalid does updated_at count.
  assert.equal(elasticRoundAnchorMs({
    metadata: {elasticRetryWaitingSince: '2026-02-30T00:00:00Z', checkpoint: {recovery: {handoffReadyAt: 'soon'}}},
    error: {recovery: {handoffReadyAt: '2026-13-01T00:00:00Z'}},
    updated_at: '2026-09-27T06:00:00.000Z',
  }), Date.parse('2026-09-27T06:00:00.000Z'));
  assert.equal(elasticRoundAnchorMs({updated_at: new Date('2026-09-27T06:00:00.000Z')}),
    Date.parse('2026-09-27T06:00:00.000Z'));
});

test('the SQL anchor guards every cast and takes the greatest of the three fields', () => {
  const sql = elasticRoundAnchorSql('item');
  assert.match(sql, /^COALESCE\(\s*GREATEST\(/u);
  assert.match(sql, /item\.metadata #>> '\{checkpoint,recovery,handoffReadyAt\}'/u);
  assert.match(sql, /item\.error #>> '\{recovery,handoffReadyAt\}'/u);
  assert.match(sql, /item\.metadata ->> 'elasticRetryWaitingSince'/u);
  assert.match(sql, /\),\s*item\.updated_at\s*\)$/u);
  assert.equal((sql.match(/::timestamptz/gu) || []).length, 3);
  assert.equal((sql.match(/CASE WHEN .*? ~ '\^\[1-9\]/gu) || []).length, 3);
  assert.match(sql, /\\\.\[0-9\]\{1,6\}/u, 'the fraction dot is escaped for PostgreSQL');
  assert.doesNotMatch(sql, /nextEvaluationAt/u);
  assert.throws(() => elasticRoundAnchorSql('item; DROP TABLE x'), /invalid_sql_alias/u);
});
