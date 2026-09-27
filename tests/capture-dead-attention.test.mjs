import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEAD_ATTENTION_CANDIDATE_SQL,
  DEAD_ATTENTION_GRACE_MS,
  DEAD_ATTENTION_KINDS,
  DEAD_ATTENTION_MIN_AGE_MS,
  DEAD_ATTENTION_SAFETY_CODES,
  classifyDeadAttentionRoot,
  deadAttentionManualMark,
  deadAttentionSweepEnabled,
  loadDeadAttentionTreeFlags,
  sweepDeadAttentionRoots,
} from '../server/services/capture-dead-attention.js';
import {MOBILE_MANUAL_ACTION_REASONS, mobileReasonRequiresManualAction} from '../server/services/android-control/validation.js';
import {captureTaskUnconfirmedLocalStopSql} from '../server/services/capture-cloud.js';

// docs/hotfix/20260927-unattended-self-heal.md (S4).
const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ago = ms => new Date(NOW - ms).toISOString();
const clean = {manualRequired: false, needsActionItems: 1, exhaustedMobileItems: 0};

const discovered = (error, overrides = {}) => ({id: 'd', task_type: 'discovered_post_capture', status: 'needs_action',
  parent_task_id: null, platform: 'douyin', updated_at: ago(11 * MINUTE),
  metadata: {workflow: 'discovered_post_capture'}, error, ...overrides});
const manualBatch = (overrides = {}) => ({id: 'm', task_type: 'capture', status: 'needs_action', parent_task_id: null,
  platform: 'xiaohongshu', updated_at: ago(61 * MINUTE), metadata: {executionMode: 'manual_batch'},
  error: {code: 'MANUAL_BATCH_PAGE_CLOSED'}, ...overrides});
const phoneRun = (deadlineAt, overrides = {}) => ({id: 'p', task_type: 'capture', status: 'needs_action',
  parent_task_id: null, platform: 'douyin', updated_at: ago(3 * HOUR),
  metadata: {workflow: 'douyin_mobile_discovery', deadlineAt}, error: {}, ...overrides});
const phoneBatch = (distributionMode, overrides = {}) => ({id: 'b', task_type: 'capture_orchestration',
  status: 'needs_action', parent_task_id: null, platform: 'douyin', updated_at: ago(7 * HOUR),
  metadata: {distributionMode}, error: {}, ...overrides});

test('the sweep switch only accepts an explicit off and phone manual reasons are shared', () => {
  assert.equal(deadAttentionSweepEnabled({}), true);
  assert.equal(deadAttentionSweepEnabled({CAPTURE_DEAD_ATTENTION_SWEEP: ' OFF '}), false);
  assert.deepEqual([...MOBILE_MANUAL_ACTION_REASONS].sort(),
    ['challenge_or_unknown', 'login_or_challenge_required', 'login_required']);
  assert.equal(mobileReasonRequiresManualAction(' Login_Required '), true);
  assert.equal(mobileReasonRequiresManualAction('invalid_ui_source'), false);
  assert.equal(DEAD_ATTENTION_MIN_AGE_MS, Math.min(...Object.values(DEAD_ATTENTION_GRACE_MS)));
});

test('K1: a failed report settles after ten minutes, a completed one after a day, a needs_action one never', () => {
  const failed = {code: 'detail_finished_without_ingestion', reportedStatus: 'failed'};
  assert.deepEqual(classifyDeadAttentionRoot(discovered(failed), clean, NOW),
    {kind: DEAD_ATTENTION_KINDS.discoveredPostDetail, eligible: true, reason: '', dueAt: ago(MINUTE)});
  assert.equal(classifyDeadAttentionRoot(discovered(failed, {updated_at: ago(9 * MINUTE)}), clean, NOW).reason,
    'grace_period');
  const completed = {code: 'detail_finished_without_ingestion', reportedStatus: 'completed'};
  assert.equal(classifyDeadAttentionRoot(discovered(completed, {updated_at: ago(23 * HOUR)}), clean, NOW).reason,
    'grace_period', 'a late upload may still land');
  assert.equal(classifyDeadAttentionRoot(discovered(completed, {updated_at: ago(25 * HOUR)}), clean, NOW).eligible, true);
  assert.equal(classifyDeadAttentionRoot(discovered({...completed, reportedStatus: 'completed_with_warnings'},
    {updated_at: ago(25 * HOUR)}), clean, NOW).eligible, true);
  const asked = classifyDeadAttentionRoot(discovered({code: 'detail_finished_without_ingestion',
    reportedStatus: 'needs_action'}, {updated_at: ago(48 * HOUR)}), clean, NOW);
  assert.deepEqual([asked.kind, asked.eligible, asked.reason],
    [DEAD_ATTENTION_KINDS.discoveredPostDetail, false, 'reported_status_needs_person']);
  const expired = {code: 'detail_create_expired'};
  assert.equal(classifyDeadAttentionRoot(discovered(expired, {updated_at: ago(29 * MINUTE)}), clean, NOW).reason,
    'grace_period');
  assert.equal(classifyDeadAttentionRoot(discovered(expired, {updated_at: ago(31 * MINUTE)}), clean, NOW).eligible, true);
});

test('K2 settles after an hour; K3 thirty minutes after its deadline; unknown deadlines never', () => {
  assert.equal(classifyDeadAttentionRoot(manualBatch(), clean, NOW).kind, DEAD_ATTENTION_KINDS.manualBatch);
  assert.equal(classifyDeadAttentionRoot(manualBatch(), clean, NOW).eligible, true);
  assert.equal(classifyDeadAttentionRoot(manualBatch({updated_at: ago(59 * MINUTE)}), clean, NOW).reason, 'grace_period');
  const run = classifyDeadAttentionRoot(phoneRun(ago(31 * MINUTE)), clean, NOW);
  assert.deepEqual([run.kind, run.eligible], [DEAD_ATTENTION_KINDS.standaloneMobileRun, true]);
  assert.equal(classifyDeadAttentionRoot(phoneRun(ago(29 * MINUTE)), clean, NOW).reason, 'grace_period');
  assert.equal(classifyDeadAttentionRoot(phoneRun(new Date(NOW + HOUR).toISOString()), clean, NOW).reason,
    'grace_period', 'a run before its deadline can still be resumed');
  assert.equal(classifyDeadAttentionRoot(phoneRun(null), clean, NOW).reason, 'deadline_unknown');
});

test('K4 only when every needs_action keyword is a phone keyword out of attempts; elastic after 6 h, fixed after 24 h', () => {
  const exhausted = {manualRequired: false, needsActionItems: 3, exhaustedMobileItems: 3};
  const elastic = classifyDeadAttentionRoot(phoneBatch('elastic_pool'), exhausted, NOW);
  assert.deepEqual([elastic.kind, elastic.eligible], [DEAD_ATTENTION_KINDS.mobileBatchExhausted, true]);
  assert.equal(classifyDeadAttentionRoot(phoneBatch('elastic_pool', {updated_at: ago(5 * HOUR)}), exhausted, NOW).reason,
    'grace_period');
  assert.equal(classifyDeadAttentionRoot(phoneBatch('fixed_batch'), exhausted, NOW).reason, 'grace_period');
  assert.equal(classifyDeadAttentionRoot(phoneBatch('fixed_batch', {updated_at: ago(25 * HOUR)}), exhausted, NOW).eligible,
    true);
  for (const flags of [{...exhausted, exhaustedMobileItems: 2}, {...exhausted, needsActionItems: 0, exhaustedMobileItems: 0}]) {
    assert.equal(classifyDeadAttentionRoot(phoneBatch('elastic_pool'), flags, NOW).reason, 'not_exhausted_mobile_batch',
      JSON.stringify(flags));
  }
  assert.equal(classifyDeadAttentionRoot(phoneBatch('elastic_pool', {metadata: {orchestrationTemplate: true}}),
    exhausted, NOW).reason, 'not_dead_kind');
});

test('fences, manual marks, other kinds and unknown trees are never settled automatically', () => {
  const failed = {code: 'detail_finished_without_ingestion', reportedStatus: 'failed'};
  assert.equal(classifyDeadAttentionRoot(manualBatch({error: {code: 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED'}}), clean, NOW)
    .reason, 'stop_fence');
  for (const error of [{requiresManualAction: true}, {securityBlocked: 'true'}, {platformSafetyBlocked: true},
    {category: 'login_required'}, {code: 'xhs_security_block'}, {securityEvidence: {confirmed: true}}]) {
    assert.equal(deadAttentionManualMark(error), true, JSON.stringify(error));
    assert.equal(classifyDeadAttentionRoot(manualBatch({error}), clean, NOW).reason, 'manual_action_required');
  }
  assert.equal(deadAttentionManualMark({code: 'MANUAL_BATCH_PAGE_CLOSED'}), false);
  assert.equal(classifyDeadAttentionRoot(discovered(failed), {...clean, manualRequired: true}, NOW).reason,
    'manual_action_required', 'a mark anywhere on the rows to settle');
  assert.equal(classifyDeadAttentionRoot(discovered(failed), null, NOW).reason, 'tree_unknown');
  assert.equal(classifyDeadAttentionRoot({...manualBatch(), parent_task_id: 'x'}, clean, NOW).reason, 'not_candidate');
  assert.equal(classifyDeadAttentionRoot({...manualBatch(), status: 'failed'}, clean, NOW).reason, 'not_candidate');
  assert.equal(classifyDeadAttentionRoot({...manualBatch(), task_type: 'unattended_keyword_capture',
    metadata: {}}, clean, NOW).reason, 'not_dead_kind');
  assert.equal(classifyDeadAttentionRoot(phoneBatch('elastic_pool', {platform: 'xiaohongshu'}),
    {manualRequired: false, needsActionItems: 1, exhaustedMobileItems: 1}, NOW).reason, 'not_dead_kind');
});

test('the candidate query is cheap, index-shaped and never the admission fence SQL', () => {
  assert.match(DEAD_ATTENTION_CANDIDATE_SQL, /WHERE t\.tenant_id = \$1\s+AND t\.status = 'needs_action'\s+AND t\.parent_task_id IS NULL\s+AND t\.attention_dismissed_at IS NULL/u);
  assert.match(DEAD_ATTENTION_CANDIDATE_SQL, /UPPER\(COALESCE\(t\.error->>'code', ''\)\) <> 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED'/u);
  assert.match(DEAD_ATTENTION_CANDIDATE_SQL, /\(t\.updated_at, t\.id\) > \(\$2::timestamptz, \$3::uuid\)/u);
  assert.match(DEAD_ATTENTION_CANDIDATE_SQL, /ORDER BY t\.updated_at, t\.id\s+LIMIT \$4/u);
  assert.equal(DEAD_ATTENTION_CANDIDATE_SQL.includes('confirmed_stops'), false);
  assert.equal(DEAD_ATTENTION_CANDIDATE_SQL.includes(captureTaskUnconfirmedLocalStopSql('t')), false);
  assert.ok(DEAD_ATTENTION_SAFETY_CODES.includes('LOGIN_REQUIRED'));
});

test('tree flags are one statement keyed by root and bound to the shared constants', async () => {
  const statements = [];
  const executor = {queryAll: async (sql, params) => {
    statements.push({sql, params});
    return [{root_id: '11111111-1111-4111-8111-111111111111', manual_required: true, needs_action_items: 2,
      exhausted_mobile_items: 1}];
  }};
  const flags = await loadDeadAttentionTreeFlags(executor, 'tenant-1',
    ['11111111-1111-4111-8111-111111111111', 'not-a-uuid']);
  assert.deepEqual(flags.get('11111111-1111-4111-8111-111111111111'),
    {manualRequired: true, needsActionItems: 2, exhaustedMobileItems: 1});
  assert.equal(statements.length, 1);
  assert.deepEqual(statements[0].params[1], ['11111111-1111-4111-8111-111111111111']);
  assert.equal(statements[0].params[2], 3, 'the phone attempt budget');
  assert.deepEqual(statements[0].params[3], MOBILE_MANUAL_ACTION_REASONS);
  assert.equal(statements[0].sql.includes('confirmed_stops'), false);
  assert.deepEqual(await loadDeadAttentionTreeFlags(executor, 'tenant-1', []), new Map());
  assert.equal(statements.length, 1, 'nothing to read, no statement');
});

test('the sweep is off with the switch and refuses to run without the parent projector', async () => {
  assert.deepEqual(await sweepDeadAttentionRoots({env: {CAPTURE_DEAD_ATTENTION_SWEEP: 'off'}}),
    {tenants: 0, scanned: 0, settled: 0, skipped: 0, busy: 0, kinds: {}, disabled: true});
  await assert.rejects(sweepDeadAttentionRoots({env: {}, tenantIds: []}), /orchestration_parent_projector_required/u);
});
