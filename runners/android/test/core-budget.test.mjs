import test from 'node:test';
import assert from 'node:assert/strict';
import { RunnerStore } from '../src/storage/runner-store.mjs';
import { BudgetLedger } from '../src/core/budget.mjs';
import { runDiscoveryTask } from '../src/core/discovery-runner.mjs';
import { fixtureTask, fixtureClock, fixturePermit, fixtureDevice } from './core-fixtures.mjs';

test('restart requires explicit authorization and carries spent cards, swipes and downtime forward', async () => {
  const task = fixtureTask({ budgets: { maxCards: 1, keywordMs: 2_000 } });
  const clock = fixtureClock();
  const store = new RunnerStore(':memory:');
  try {
    const ledger = new BudgetLedger({ task, store, clock });
    ledger.beforeCard();
    ledger.beforeSwipe();
    ledger.finish('interrupted', 'usb_disconnected');
    assert.throws(() => new BudgetLedger({ task, store, clock }), { code: 'resume_authorization_required' });
    clock.advance(2_001);
    const resumed = { ...task, identity: { ...task.identity, attemptId: 'attempt-2', assignmentRevision: 2 } };
    const { device, calls } = fixtureDevice(resumed);
    const result = await runDiscoveryTask({ task: resumed, store, clock, device,
      permit: fixturePermit(resumed, clock), resumeAuthorized: true });
    assert.equal(result.reason, 'keyword_time_limit');
    assert.equal(result.stats.cards, 1);
    assert.equal(result.stats.swipes, 1);
    assert.equal(result.stats.keywordElapsedMs, 2_001);
    assert.deepEqual(calls, []);
  } finally { store.close(); }
});

test('a completed or canceled item cannot restart even with resume authorization', () => {
  for (const status of ['completed', 'completed_with_warnings', 'canceled']) {
    const store = new RunnerStore(':memory:');
    try {
      const task = fixtureTask();
      const clock = fixtureClock();
      const ledger = new BudgetLedger({ task, store, clock });
      ledger.finish(status, 'done');
      assert.throws(() => new BudgetLedger({ task, store, clock, resumeAuthorized: true }), { code: 'terminal_item' });
    } finally { store.close(); }
  }
});

test('a resumed task cannot extend the original durable absolute deadline', () => {
  const store = new RunnerStore(':memory:');
  try {
    const clock = fixtureClock();
    const task = fixtureTask({ deadlineAt: new Date(clock.wallNow() + 500).toISOString() });
    new BudgetLedger({ task, store, clock }).finish('interrupted', 'connection');
    clock.advance(501);
    const resumed = new BudgetLedger({ task: { ...task, identity: { ...task.identity, attemptId: 'attempt-2', assignmentRevision: 2 },
      deadlineAt: new Date(clock.wallNow() + 90_000).toISOString() }, store, clock, resumeAuthorized: true });
    assert.throws(() => resumed.assertAllowed(), (error) => error.code === 'budget_exhausted' && error.details.reason === 'task_deadline');
  } finally { store.close(); }
});

test('resume authorization does not revive the old attempt or permit budget expansion', () => {
  const store = new RunnerStore(':memory:');
  try {
    const task = fixtureTask();
    const clock = fixtureClock();
    new BudgetLedger({ task, store, clock }).finish('interrupted', 'connection');
    assert.throws(() => new BudgetLedger({ task, store, clock, resumeAuthorized: true }), { code: 'fresh_attempt_required' });
    assert.throws(() => new BudgetLedger({ task: { ...task, budgets: { maxCards: 200 } }, store, clock, resumeAuthorized: true }), { code: 'budget_configuration_changed' });
  } finally { store.close(); }
});

test('backward wall clock after restart cannot restore time budget', () => {
  const store = new RunnerStore(':memory:');
  try {
    const task = fixtureTask();
    const clock = fixtureClock();
    new BudgetLedger({ task, store, clock }).finish('interrupted', 'connection');
    clock.wallOnly(-1);
    assert.throws(() => new BudgetLedger({ task, store, clock, resumeAuthorized: true }), { code: 'wall_clock_regressed' });
  } finally { store.close(); }
});

test('backlog stops discovery before a single device action', async () => {
  const task = fixtureTask({ budgets: { maxPending: 1 } });
  const clock = fixtureClock();
  const store = new RunnerStore(':memory:');
  try {
    store.recordEvent({ eventId: 'existing' });
    const { device, calls } = fixtureDevice(task);
    const result = await runDiscoveryTask({ task, store, clock, device, permit: fixturePermit(task, clock) });
    assert.equal(result.reason, 'outbox_backlog');
    assert.deepEqual(calls, []);
  } finally { store.close(); }
});
