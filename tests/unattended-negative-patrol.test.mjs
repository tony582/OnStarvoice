import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeUnattendedNegativePatrolScope,
  negativePatrolCalendarDate,
  unattendedNegativePatrolTargetUrl,
  evaluateUnattendedNegativePatrolRecord,
  negativePatrolStableEvidence,
  negativePatrolEffectiveRotationState,
  loadUnattendedNegativePatrolCandidates,
  claimUnattendedNegativePatrolItem,
  completeUnattendedNegativePatrolItem,
  failUnattendedNegativePatrolItem,
} from '../server/services/unattended-negative-patrol.js';

const tenantId = '10000000-0000-4000-8000-000000000001';
const recordId = '20000000-0000-4000-8000-000000000001';
const itemId = '30000000-0000-4000-8000-000000000001';
const executionTaskId = '40000000-0000-4000-8000-000000000001';
const observationId = '50000000-0000-4000-8000-000000000001';
const scope = {
  tenantId, platforms: ['xiaohongshu', 'douyin'], keywords: ['OTA'],
  runStartedAt: '2026-09-08T01:00:00.000Z', timezone: 'Asia/Shanghai',
};
const claim = {...scope, recordId, itemId, executionTaskId,
  assignmentRevision: 2, now: scope.runStartedAt};
const record = changes => ({id: recordId, tenant_id: tenantId,
  platform: 'douyin', external_id: '123456789', keyword: 'OTA',
  record_type: 'single_note', created_at: '2026-09-07T00:00:00.000Z',
  published_ts: '2026-09-07T00:00:00.000Z', publish_time: '2026-09-07',
  sentiment: 'negative', ai_result: {relevance: 'relevant'},
  manual_overrides: {}, business_visibility: 'eligible',
  triage_status: 'unhandled', triage_priority: 'normal',
  content_availability_status: 'available', ...changes});
const state = changes => ({tenant_id: tenantId, platform: 'douyin',
  external_id: '123456789', record_id: recordId, stable_success_count: 0,
  failure_count: 0, ...changes});
const leased = changes => state({lease_item_id: itemId,
  lease_execution_task_id: executionTaskId, lease_assignment_revision: 2,
  ...changes});

test('window is precisely 168 hours, immutable across timezones and rejects ambiguous scope', () => {
  const normalized = normalizeUnattendedNegativePatrolScope(scope);
  assert.equal(normalized.windowStart, '2026-09-01T01:00:00.000Z');
  assert.equal(normalized.windowEnd, scope.runStartedAt);
  assert.equal(normalized.windowBasis, 'first_collected_at');
  assert.equal(normalizeUnattendedNegativePatrolScope({...scope,
    timezone: 'America/New_York'}).windowStart, normalized.windowStart);
  assert.throws(() => normalizeUnattendedNegativePatrolScope({...scope, tenantId: ''}));
  assert.throws(() => normalizeUnattendedNegativePatrolScope({...scope, platforms: ['weibo']}));
  assert.throws(() => normalizeUnattendedNegativePatrolScope({...scope, timezone: 'invalid'}));
  assert.throws(() => normalizeUnattendedNegativePatrolScope({...scope, runStartedAt: ''}));
  assert.throws(() => normalizeUnattendedNegativePatrolScope({...scope, keywordIds: ['not-uuid']}));
});

test('first collection has exact inclusive-start and exclusive-end boundaries independent of publication', () => {
  assert.equal(evaluateUnattendedNegativePatrolRecord(record({created_at: '2026-09-01T01:00:00Z'}), scope).eligible, true);
  assert.equal(evaluateUnattendedNegativePatrolRecord(record({created_at: '2026-09-01T00:59:59.999Z'}), scope).reason, 'outside_window');
  assert.equal(evaluateUnattendedNegativePatrolRecord(record({created_at: scope.runStartedAt}), scope).reason, 'discovered_this_run');
  for (const published_ts of ['2020-01-01T00:00:00Z', scope.runStartedAt, null]) {
    assert.equal(evaluateUnattendedNegativePatrolRecord(record({published_ts, publish_time: ''}), scope).eligible, true);
  }
  const fractional = {...scope, runStartedAt: '2026-09-08T01:00:00.500Z'};
  assert.equal(evaluateUnattendedNegativePatrolRecord(record({created_at: new Date('2026-09-01T01:00:00.500Z')}), fractional).eligible, true);
  assert.equal(evaluateUnattendedNegativePatrolRecord(record({created_at: new Date(fractional.runStartedAt)}), fractional).reason, 'discovered_this_run');
});

test('cross-midnight windows remain 168 hours and later captures never renew old first collection', () => {
  const midnightRun = {...scope, runStartedAt: '2026-09-07T16:00:00Z'}; // September 8 midnight Shanghai
  assert.equal(negativePatrolCalendarDate(midnightRun.runStartedAt), '2026-09-08');
  const normalized = normalizeUnattendedNegativePatrolScope(midnightRun);
  assert.equal(normalized.windowStart, '2026-08-31T16:00:00.000Z');
  assert.equal(evaluateUnattendedNegativePatrolRecord(record({created_at: normalized.windowStart}), midnightRun).due, true);
  const old = record({created_at: '2026-08-31T15:59:59.999Z',
    published_ts: '2026-09-07T15:00:00Z', last_seen_at: '2026-09-07T15:00:00Z',
    updated_at: '2026-09-07T15:00:00Z', latest_formal_success_at: '2026-09-07T15:00:00Z'});
  assert.equal(evaluateUnattendedNegativePatrolRecord(old, midnightRun,
    state({last_success_at: '2026-09-07T15:00:00Z'})).reason, 'outside_window');
});

test('human exclusion, archive, availability and business visibility dominate first-time eligibility', () => {
  const exclusions = [
    [{triage_status: 'reviewed_non_monitor'}, 'triage_reviewed_non_monitor'],
    [{triage_status: 'unavailable'}, 'triage_unavailable'],
    [{triage_status: 'false_positive'}, 'triage_false_positive'],
    [{archived_at: '2026-09-07'}, 'archived'],
    [{content_availability_status: 'deleted'}, 'content_unavailable'],
    [{business_visibility: 'deferred'}, 'business_ineligible'],
    [{record_type: 'official_content'}, 'official_content'],
    [{false_positive_pending: true}, 'false_positive_pending'],
    [{manual_overrides: {relevance: 'irrelevant'}}, 'manual_irrelevant'],
    [{manual_overrides: {sentiment: 'neutral'}}, 'not_negative'],
    [{manual_overrides: {sentiment: {value: 'bogus'}}}, 'manual_sentiment_invalid'],
  ];
  for (const [changes, expected] of exclusions) {
    const result = evaluateUnattendedNegativePatrolRecord(record({...changes, triage_priority: 'urgent'}), scope);
    assert.equal(result.reason, expected);
    assert.equal(result.due, false);
  }
  assert.equal(evaluateUnattendedNegativePatrolRecord(record({triage_status: 'privacy_unreachable'}), scope).due, true);
});

test('manual corrected negative and relevance follow existing patrol override semantics', () => {
  const overridden = record({sentiment: 'neutral', business_visibility: 'filtered_out',
    false_positive_pending: true, manual_overrides: {sentiment: {value: 'negative'}}});
  assert.equal(evaluateUnattendedNegativePatrolRecord(overridden, scope).eligible, true);
  assert.equal(evaluateUnattendedNegativePatrolRecord({...overridden,
    triage_status: 'reviewed_non_monitor'}, scope).eligible, false);
});

test('every eligible handling state remains executable after same-day success and ignores legacy cadence dates', () => {
  for (const triage_status of ['unhandled', 'replied', 'negative_feishu', 'official_responded', 'reviewed', 'negative_cold', 'negative_comment']) {
    for (const triage_priority of ['normal', 'high', 'urgent']) {
      const source = record({triage_status, triage_priority});
      const result = evaluateUnattendedNegativePatrolRecord(source, scope, state({
        last_success_at: '2026-09-08T00:01:00Z', stable_success_count: 3,
        next_due_date: '2026-09-15', cadence_days: 7,
      }));
      assert.equal(result.due, true, `${triage_status}/${triage_priority}`);
      assert.equal(result.reason, 'due');
      assert.equal(result.nextDueDate, null);
      assert.equal(source.triage_status, triage_status);
    }
  }
});

test('cold/reviewed get a first opportunity and measured stability remains audit evidence only', () => {
  for (const status of ['negative_cold', 'reviewed', 'negative_comment']) {
    const cold = record({triage_status: status});
    assert.equal(evaluateUnattendedNegativePatrolRecord(cold, scope).reason, 'first_patrol');
    assert.equal(evaluateUnattendedNegativePatrolRecord(cold, scope,
      state({stable_success_count: 1, last_success_at: '2026-09-08T00:30:00Z'})).due, true);
  }
  const baseline = {id: 'a', likes: 10, comments_count: 2, collects: 0, shares: 0};
  assert.equal(negativePatrolStableEvidence(baseline, {...baseline, id: 'b'}), true);
  assert.equal(negativePatrolStableEvidence(baseline, {...baseline, id: 'b', likes: 9}), false);
  assert.equal(negativePatrolStableEvidence(baseline, {...baseline, id: 'b', likes: 11}), false);
  assert.equal(negativePatrolStableEvidence({...baseline, id: null}, {...baseline, id: 'b'}), false);
  assert.equal(negativePatrolStableEvidence(baseline, {...baseline, id: 'b', shares: null}), false);
});

test('prior exact formal negative/watch success preserves evidence without suppressing another run', () => {
  const todayFormal = record({latest_formal_success_at: '2026-09-08T00:30:00Z',
    latest_formal_observation_id: observationId, latest_formal_stable: false});
  assert.equal(evaluateUnattendedNegativePatrolRecord(todayFormal, scope).reason, 'due');
  assert.equal(evaluateUnattendedNegativePatrolRecord(todayFormal, scope).sharedResultObservationId, observationId);
  const coldYesterday = record({triage_status: 'negative_cold',
    latest_formal_success_at: '2026-09-07T01:00:00Z', latest_formal_stable: false});
  assert.equal(evaluateUnattendedNegativePatrolRecord(coldYesterday, scope).due, true);
  assert.equal(evaluateUnattendedNegativePatrolRecord({...coldYesterday,
    latest_formal_stable: true}, scope).due, true);
  const newerState = state({last_success_at: '2026-09-08T00:45:00Z', stable_success_count: 0});
  assert.equal(negativePatrolEffectiveRotationState(newerState, todayFormal), newerState);
});

test('formal coverage query requires targeted work, successful current attempt and exact persisted endpoint', async () => {
  const result = await loadUnattendedNegativePatrolCandidates({async queryOne() { return {total: 0}; }, async queryAll(sql) {
    assert.match(sql, /formal_execution\.task_type IN \('negative_post_patrol', 'watched_content_patrol'\)/);
    assert.match(sql, /formal_observation\.id = formal_item\.result_observation_id/);
    assert.match(sql, /formal_attempt\.id = formal_observation\.capture_task_item_attempt_id/);
    assert.match(sql, /formal_attempt\.status IN \('completed', 'completed_with_warnings'\)/);
    return [record({latest_formal_success_at: '2026-09-08T00:30:00Z'})];
  }}, scope);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.summary.notDue, 0);
  assert.equal(result.summary.due, 1);
  assert.equal(result.summary.firstPending, 0);
});

test('URL resolution preserves source identity and cannot dispatch an unrelated host or post', () => {
  assert.equal(unattendedNegativePatrolTargetUrl(record({url: 'https://attacker.example/video/123456789'})), 'https://www.douyin.com/video/123456789');
  assert.equal(unattendedNegativePatrolTargetUrl(record({url: 'https://www.douyin.com/video/99999123456789'})), 'https://www.douyin.com/video/123456789');
  assert.equal(unattendedNegativePatrolTargetUrl(record({external_id: '../bad'})), '');
  assert.equal(unattendedNegativePatrolTargetUrl(record({note_type: 'image'})), 'https://www.douyin.com/note/123456789');
});

test('candidate loading does not truncate at 100, rotates old first and never broadens empty keywords', async () => {
  let queries = 0;
  const noScope = await loadUnattendedNegativePatrolCandidates({queryAll() { queries++; throw new Error('must not query'); }}, {...scope, keywords: []});
  assert.equal(noScope.candidates.length, 0);
  assert.equal(queries, 0);
  const records = Array.from({length: 130}, (_, i) => record({
    id: `record-${i}`, external_id: String(123450000 + i),
    created_at: `2026-09-0${i % 6 + 1}T02:00:00Z`,
  }));
  records.push(record({id: 'already-success', last_success_at: '2026-09-06T02:00:00Z'}));
  const result = await loadUnattendedNegativePatrolCandidates({
    async queryOne() { return {total: 0}; },
    async queryAll(sql) { assert.doesNotMatch(sql, /LIMIT\s+100/); return records; },
  }, scope);
  assert.equal(result.candidates.length, 131);
  assert.equal(result.candidates[0].firstCollectedAt, '2026-09-01T02:00:00Z');
  assert.equal(result.candidates.at(-1).recordId, 'already-success');
  assert.equal(result.summary.firstPending, 130);
  assert.equal(result.summary.due, 1);
});

test('candidate summary preserves never-covered expiration and persists history without dispatching it', async () => {
  const writes = [];
  const result = await loadUnattendedNegativePatrolCandidates({
    async queryOne() { return {total: 0}; },
    async queryAll() { return [record({created_at: '2026-08-31T01:00:00Z',
      first_eligible_at: '2026-09-06T01:00:00Z'})]; },
    async execute(sql, params) { writes.push({sql, params}); },
  }, {...scope, persistCandidates: true});
  assert.equal(result.candidates.length, 0);
  assert.equal(result.summary.outOfWindowUncovered, 1);
  assert.match(writes[0].sql, /window_expired_uncovered/);
});

test('formal shared success is covered in both near-expiry and expired summaries even when rotation state has no success', async () => {
  const writes = [];
  const common = {last_success_at: null, first_eligible_at: '2026-09-01T01:00:00Z'};
  const shared = {latest_formal_success_at: '2026-09-07T01:00:00Z',
    latest_formal_observation_id: observationId};
  const result = await loadUnattendedNegativePatrolCandidates({
    async queryOne() { return {total: 0}; },
    async queryAll() { return [
      record({...common, ...shared, external_id: '100000001', created_at: '2026-09-01T02:00:00Z'}),
      record({...common, ...shared, external_id: '100000002', created_at: '2026-08-31T02:00:00Z'}),
      record({...common, external_id: '100000003', created_at: '2026-09-01T02:00:00Z'}),
      record({...common, external_id: '100000004', created_at: '2026-08-31T02:00:00Z'}),
    ]; },
    async execute(sql, params) { writes.push({sql, params}); },
  }, {...scope, persistCandidates: true});
  assert.equal(result.summary.expiringUncovered, 1);
  assert.equal(result.summary.outOfWindowUncovered, 1);
  const expiredWrites = writes.filter(write => write.sql.includes('window_expired_uncovered'));
  assert.equal(expiredWrites.length, 1);
  assert.equal(expiredWrites[0].params[2], '100000004');
});

test('bulk candidates use first collection and include otherwise eligible records with unknown publication', async () => {
  const result = await loadUnattendedNegativePatrolCandidates({
    async queryOne() { throw new Error('must not scan unknown publication history'); },
    async queryAll(sql) {
      assert.match(sql, /r\.created_at >= \$4::timestamptz AND r\.created_at < \$3::timestamptz/);
      assert.match(sql, /END, ''\)\)\) = 'negative'/);
      assert.doesNotMatch(sql, /r\.published_ts (?:IS|>=|<)|BTRIM\(r\.publish_time\)/);
      return [record({published_ts: null, publish_time: ''})];
    },
  }, scope);
  assert.equal(result.summary.unknownPublishTime, 0);
  assert.equal(result.summary.exclusionReasons.publish_time_unknown, undefined);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].firstCollectedAt, '2026-09-07T00:00:00.000Z');
});

function claimDb({row = record(), stored = state(), owner = null, active = null} = {}) {
  const writes = [];
  return {writes,
    async queryOne(sql) {
      if (sql.includes('pg_try_advisory_xact_lock')) { writes.push({sql}); return {locked: true}; }
      if (sql.includes('SELECT r.*')) return row;
      if (sql.includes('SELECT * FROM unattended_negative_patrol_state')) return stored;
      if (sql.includes('SELECT execution.status')) return owner;
      if (sql.includes('SELECT item.id FROM capture_task_items')) return active;
      throw new Error(`unexpected query: ${sql}`);
    },
    async execute(sql, params) { writes.push({sql, params}); },
  };
}

test('claim preserves live exclusions and failure controls while same-day success remains claimable', async () => {
  for (const options of [
    {row: record({triage_status: 'unavailable'})},
    {stored: state({cooldown_until: '2026-09-08T01:30:00Z'})},
    {stored: state({needs_action: true})},
  ]) {
    const db = claimDb(options);
    assert.equal((await claimUnattendedNegativePatrolItem(db, claim)).claimed, false);
    assert.equal(db.writes.some(write => /SET lease_item_id = \$4/.test(write.sql)), false);
  }
  const db = claimDb({stored: state({last_success_at: '2026-09-08T00:00:00Z',
    cadence_days: 7, next_due_date: '2026-09-15'})});
  const result = await claimUnattendedNegativePatrolItem(db, claim);
  assert.equal(result.claimed, true);
  assert.ok(db.writes.some(write => /pg_try_advisory_xact_lock/.test(write.sql)));
  assert.ok(db.writes.some(write => /SET lease_item_id = \$4/.test(write.sql)));
});

test('cross-plan reservations and active watched work block duplicate claims; stale terminal owner is releasable', async () => {
  const prior = leased({lease_execution_task_id: 'prior-execution'});
  assert.equal((await claimUnattendedNegativePatrolItem(claimDb({stored: prior,
    owner: {status: 'running', item_status: 'running', active_command: false}}), claim)).reason, 'already_claimed');
  assert.equal((await claimUnattendedNegativePatrolItem(claimDb({stored: prior,
    owner: {status: 'canceled', item_status: 'canceled', active_command: true}}), claim)).reason, 'already_claimed');
  assert.equal((await claimUnattendedNegativePatrolItem(claimDb({stored: prior,
    owner: {status: 'canceled', item_status: 'canceled', active_command: false, stop_pending: true}}), claim)).reason, 'already_claimed');
  assert.equal((await claimUnattendedNegativePatrolItem(claimDb({active: {id: 'watch'}}), claim)).reason, 'content_execution_active');
  assert.equal((await claimUnattendedNegativePatrolItem(claimDb({stored: prior,
    owner: {status: 'canceled', item_status: 'canceled', active_command: false}}), claim)).claimed, true);
});

test('all existing unconfirmed-stop flags fence both prior owners and other targeted executions', async () => {
  const db = claimDb({stored: leased({lease_execution_task_id: 'prior'}),
    owner: {status: 'canceled', item_status: 'canceled', active_command: false}});
  const read = db.queryOne.bind(db);
  let inspected = 0;
  db.queryOne = async sql => {
    if (sql.includes('SELECT execution.status') || sql.includes('SELECT item.id FROM capture_task_items')) {
      for (const flag of ['stopPending', 'legacyPackStopPending', 'stopIdentityUnavailable']) assert.ok(sql.includes(flag));
      inspected++;
    }
    return read(sql);
  };
  assert.equal((await claimUnattendedNegativePatrolItem(db, claim)).claimed, true);
  assert.equal(inspected, 2);
});

test('formal success committed during claim is refreshed without suppressing the current run', async () => {
  const db = claimDb();
  const read = db.queryOne.bind(db);
  let recordReads = 0;
  db.queryOne = async sql => {
    if (sql.includes('SELECT r.*') && ++recordReads > 1) return record({
      latest_formal_success_at: scope.runStartedAt,
      latest_formal_observation_id: observationId,
    });
    return read(sql);
  };
  const result = await claimUnattendedNegativePatrolItem(db, claim);
  assert.equal(result.claimed, true);
  assert.equal(result.candidate.sharedResultObservationId, observationId);
  assert.equal(result.candidate.nextDueDate, null);
  assert.equal(db.writes.some(write => /SET lease_item_id = \$4/.test(write.sql)), true);
});

function completionDb({result = {}, stored = leased()} = {}) {
  const writes = [];
  return {writes,
    async queryOne(sql) {
      if (sql.includes('SELECT item.record_id')) {
        assert.match(sql, /observation\.capture_task_id = item\.execution_task_id/);
        assert.match(sql, /observation\.capture_task_item_id = item\.id/);
        assert.match(sql, /attempt\.id = observation\.capture_task_item_attempt_id/);
        return result === null ? null : {platform: 'douyin', external_id: '123456789',
          observation_id: observationId, observed_at: scope.runStartedAt,
          triage_status: 'negative_cold', triage_priority: 'normal',
          baseline_id: 'baseline', likes: 10, comments_count: 2, collects: 0, shares: 0,
          baseline_likes: 10, baseline_comments_count: 2, baseline_collects: 0, baseline_shares: 0,
          ...result};
      }
      return stored;
    },
    async execute(sql, params) { writes.push({sql, params}); },
  };
}

test('only durable current attempt result advances rotation; stable success never schedules an interval', async () => {
  const input = {...claim, resultObservationId: observationId, finishedAt: scope.runStartedAt};
  const missing = completionDb({result: null});
  assert.equal((await completeUnattendedNegativePatrolItem(missing, input)).updated, false);
  assert.equal(missing.writes.length, 0);
  const stale = completionDb({stored: leased({lease_assignment_revision: 3})});
  assert.equal((await completeUnattendedNegativePatrolItem(stale, input)).reason, 'stale_execution');
  assert.equal(stale.writes.length, 0);
  const good = completionDb();
  assert.deepEqual(await completeUnattendedNegativePatrolItem(good, input), {
    updated: true, nextDueDate: null, cadenceDays: 1, stable: true,
  });
  assert.match(good.writes[0].sql, /last_result_observation_id/);
  assert.equal(good.writes[0].params[6], null);
  assert.equal(good.writes[0].params[7], 1);
  const growing = completionDb({result: {likes: 11}});
  assert.equal((await completeUnattendedNegativePatrolItem(growing, input)).cadenceDays, 1);
  const wrongClock = completionDb();
  const future = await completeUnattendedNegativePatrolItem(wrongClock,
    {...input, finishedAt: '2099-09-08T01:00:00Z'});
  assert.equal(future.nextDueDate, null);
  assert.equal(wrongClock.writes[0].params[3], scope.runStartedAt);
});

test('failure has bounded cooldown, never marks success, and stale failure cannot release a replacement lease', async () => {
  const writes = [];
  const db = {async queryOne() { return leased({failure_count: 20}); },
    async execute(sql, params) { writes.push({sql, params}); }};
  const result = await failUnattendedNegativePatrolItem(db, claim);
  assert.equal(result.cooldownUntil, '2026-09-08T07:00:00.000Z');
  assert.doesNotMatch(writes[0].sql, /last_success_at\s*=/);
  assert.equal((await failUnattendedNegativePatrolItem({
    async queryOne() { return leased({lease_assignment_revision: 3}); },
    async execute() { throw new Error('must not update stale owner'); },
  }, claim)).reason, 'stale_execution');
});
