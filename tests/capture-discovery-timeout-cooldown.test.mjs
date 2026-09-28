import assert from 'node:assert/strict';
import test from 'node:test';
import {
  discoveryDetailTimeoutCooldownMs as cooldown,
  DETAIL_OPEN_TIMEOUT_CODE,
  DETAIL_OPEN_TIMEOUT_COOLDOWN_MS,
  DETAIL_OPEN_TIMEOUT_WINDOW_MS,
} from '../server/services/capture-discovery/detail-timeout-cooldown.js';

const now = Date.parse('2026-09-28T14:00:00Z');
const failure = (ageMs = 0, extra = {}) => ({
  task_status: 'needs_action', attempt_status: 'failed',
  error_code: DETAIL_OPEN_TIMEOUT_CODE,
  first_timeout_received_at: new Date(now - ageMs), ...extra,
});
const streak = () => [failure(1000), failure(30000), failure(60000)];

test('only three consecutive original open timeouts trigger a bounded cooldown', () => {
  assert.equal(cooldown([], now), 0);
  assert.equal(cooldown(streak().slice(0, 2), now), 0);
  assert.equal(cooldown(streak(), now), DETAIL_OPEN_TIMEOUT_COOLDOWN_MS - 1000);
});
test('successful receipt resets even while original failed attempt remains', () => {
  for (const index of [0, 1, 2]) {
    const rows = streak(); rows[index].task_status = 'completed';
    assert.equal(cooldown(rows, now), 0);
  }
});
test('another outcome, cancellation or unavailable strict evidence breaks the streak', () => {
  for (const extra of [
    {error_code:'TARGET_RUNNER_TAB_CLOSED'}, {error_code:'detail_finished_without_ingestion'},
    {task_status:'canceled'}, {task_status:'superseded'}, {attempt_status:'completed'},
    {attempt_status:null}, {first_timeout_received_at:null},
  ]) {
    const rows = streak(); rows[1] = failure(30000, extra);
    assert.equal(cooldown(rows, now), 0, JSON.stringify(extra));
  }
});
test('cooldown expires at five minutes and repeated heartbeat update times cannot extend it', () => {
  const rows = [failure(300000), failure(330000), failure(360000)];
  rows[0].updated_at = new Date(now);
  assert.equal(cooldown(rows, now - 1), 1);
  assert.equal(cooldown(rows, now), 0);
  assert.equal(cooldown(rows, now + 1000), 0);
});
test('old, future and malformed receipt times do not lock the node', () => {
  for (const date of [new Date(now - DETAIL_OPEN_TIMEOUT_WINDOW_MS - 1), new Date(now + 1), 'bad']) {
    const rows = streak(); rows[2].first_timeout_received_at = date;
    assert.equal(cooldown(rows, now), 0);
  }
});
test('a failed natural probe starts another finite pause only while the recent streak remains', () => {
  assert.equal(cooldown([failure(), failure(360000), failure(390000)], now), 300000);
  assert.equal(cooldown([failure(), failure(360000), failure(910000)], now), 0);
});
