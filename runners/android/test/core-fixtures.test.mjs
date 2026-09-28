import test from 'node:test';
import assert from 'node:assert/strict';
import {fixturePermit, fixtureTask} from './core-fixtures.mjs';

test('fixture permit uses one wall-clock sample at the 90-second lease limit', () => {
  const wall = Date.parse('2026-09-28T00:00:00.000Z');
  let reads = 0;
  const clock = {wallNow: () => wall + reads++, monotonicNow: () => 100};
  const permit = fixturePermit(fixtureTask(), clock);
  assert.equal(reads, 1, 'server time and lease expiry must derive from the same clock sample');
  assert.equal(permit.expiresAt, 90_100);
  assert.doesNotThrow(() => permit.assertAllowed());
});
