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

test('a 0 budget lifts the link, card, swipe and batch ceilings while keyword time still bounds', () => {
  const store = new RunnerStore(':memory:');
  try {
    const clock = fixtureClock();
    const task = fixtureTask({ budgets: { maxLinks: 0, maxCards: 0, maxSwipes: 0, batchMs: 0, keywordMs: 1_000 } });
    const ledger = new BudgetLedger({ task, store, clock });
    for (let i = 0; i < 100; i++) { ledger.beforeCard(); ledger.beforeSwipe(); ledger.noteLink(`work-${i}`); }
    assert.doesNotThrow(() => ledger.assertAllowed(), 'no card, swipe, link or batch ceiling applies');
    assert.equal(ledger.summary().cards, 100);
    assert.equal(ledger.summary().swipes, 100);
    assert.equal(ledger.summary().links, 100);
    clock.advance(1_000);
    assert.throws(() => ledger.assertAllowed(), (error) => error.code === 'budget_exhausted' && error.details.reason === 'keyword_time_limit');
  } finally { store.close(); }
});

test('keywordMs and maxPending must still be positive; the other dimensions accept 0', () => {
  const clock = fixtureClock();
  for (const budgets of [{ keywordMs: 0 }, { maxPending: 0 }, { maxLinks: -1 }, { maxCards: 1.5 }]) {
    const store = new RunnerStore(':memory:');
    try { assert.throws(() => new BudgetLedger({ task: fixtureTask({ budgets }), store, clock }), { code: 'invalid_budget' }); }
    finally { store.close(); }
  }
});

test('an unlimited run walks every page to results end past the default card and link ceilings', async () => {
  const total = 41; // beyond the default maxCards 40 / maxLinks 20 to prove the ceilings are gone.
  const clock = fixtureClock();
  const store = new RunnerStore(':memory:');
  const task = fixtureTask({ budgets: { maxLinks: 0, maxCards: 0, maxSwipes: 0, batchMs: 0 } });
  try {
    const context = { verified: true, keyword: task.keyword, filters: task.filters, contextId: 'ctx-unlimited' };
    let served = 0; const perPage = 5; const calls = { openCard: 0, scroll: 0 };
    const device = {
      inspect: async () => ({ deviceId: task.deviceId, connected: true, unlocked: true, loggedIn: true, challenge: false }),
      search: async () => context,
      readCards: async () => {
        const cards = [];
        for (let i = 0; i < perPage && served < total; i++, served++) cards.push({ cardId: `card-${served}`, title: `t${served}`, author: `a${served}` });
        return { contextVerified: true, contextId: context.contextId, cards, end: served >= total };
      },
      openCard: async ({ card }) => { calls.openCard++; return { identityVerified: true, cardId: card.cardId,
        detailId: `d-${card.cardId}`, externalId: String(7_000_000_000_000_000n + BigInt(Number(card.cardId.split('-')[1]))) }; },
      copyLink: async ({ detail }) => ({ identityVerified: true, fresh: true, markerReplaced: true, detailId: detail.detailId,
        externalId: detail.externalId, shareUrl: `https://www.douyin.com/note/${detail.externalId}` }),
      returnToResults: async () => context,
      scroll: async () => { calls.scroll++; return { contextVerified: true, contextId: context.contextId }; },
    };
    const result = await runDiscoveryTask({ task, store, clock, device, permit: fixturePermit(task, clock) });
    assert.equal(result.status, 'completed');
    assert.equal(result.reason, 'results_end');
    assert.equal(result.stats.cards, total);
    assert.equal(result.stats.links, total);
    assert.equal(calls.openCard, total);
    assert.equal(calls.scroll, Math.ceil(total / perPage) - 1);
  } finally { store.close(); }
});

test('resume faults name the earlier attempt, and a new run or item never inherits them', () => {
  const store = new RunnerStore(':memory:');
  try {
    const task = fixtureTask();
    const clock = fixtureClock();
    new BudgetLedger({ task, store, clock }).finish('needs_action', 'douyin_not_foreground');
    assert.throws(() => new BudgetLedger({ task, store, clock }), error => error.code === 'resume_authorization_required'
      && error.details.previousAttemptId === 'attempt-1' && error.details.previousAssignmentRevision === 1
      && error.details.previousStatus === 'needs_action' && error.details.previousReason === 'douyin_not_foreground');
    const otherItem = fixtureTask({ keyword: '君越壁纸', identity: { ...task.identity, itemId: 'item-2', attemptId: 'attempt-2' } });
    assert.equal(new BudgetLedger({ task: otherItem, store, clock }).skippedCards, 0);
    const otherRun = fixtureTask({ identity: { ...task.identity, taskId: 'run-2', discoveryRunId: 'run-2', itemId: 'item-9', attemptId: 'attempt-9' } });
    const ledger = new BudgetLedger({ task: otherRun, store, clock });
    assert.equal(ledger.summary().batchElapsedMs, 0);
    assert.equal(ledger.noteSkippedCard(), 1);
    assert.equal(store.loadCheckpoint('run-1').value.items['item-1'].skippedCards, undefined, 'skips stay with their own item');
  } finally { store.close(); }
});
