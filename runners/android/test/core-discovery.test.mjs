import test from 'node:test';
import assert from 'node:assert/strict';
import { RunnerStore } from '../src/storage/runner-store.mjs';
import { runDiscoveryTask } from '../src/core/discovery-runner.mjs';
import { fixtureTask, fixtureClock, fixturePermit, fixtureDevice } from './core-fixtures.mjs';

async function run({ task = fixtureTask(), store = new RunnerStore(':memory:'), clock = fixtureClock(), overrides = {}, ...options } = {}) {
  const permit = options.permit ?? fixturePermit(task, clock);
  const { device, calls } = fixtureDevice(task, overrides);
  const result = await runDiscoveryTask({ task, store, clock, permit, device, ...options });
  return { result, store, calls, clock };
}

test('two keyword items share a run budget and persist independently attributable discoveries', async () => {
  const store = new RunnerStore(':memory:');
  const clock = fixtureClock();
  try {
    const first = fixtureTask();
    const a = await run({ task: first, store, clock });
    clock.advance(5_000);
    const second = fixtureTask({ keyword: '君越壁纸', identity: { ...first.identity, itemId: 'item-2', attemptId: 'attempt-2' } });
    const b = await run({ task: second, store, clock });
    assert.equal(a.result.status, 'completed');
    assert.equal(b.result.status, 'completed');
    assert.equal(b.result.stats.batchElapsedMs, 5_000);
    assert.equal(b.result.stats.keywordElapsedMs, 0);
    const batch = store.nextBatch();
    assert.equal(batch.events.length, 2);
    assert.deepEqual(batch.events.map((e) => e.itemId), ['item-1', 'item-2']);
    assert.deepEqual(batch.events.map((e) => e.keyword), ['别克壁纸', '君越壁纸']);
    assert.equal(batch.events[0].verification, 'verified');
    assert.match(batch.events[0].rawShareUrl, /\/note\//);
    assert.notEqual(batch.events[0].eventId, batch.events[1].eventId);
    assert.match(batch.events[0].eventId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  } finally { store.close(); }
});

test('unknown real-device profile stops before search instead of inferring readiness from USB', async () => {
  const { result, store, calls } = await run({ overrides: { inspect: async () => ({ deviceId: 'phone-1', connected: true,
    unlocked: null, loggedIn: null, challenge: null, readyForSearch: false, reason: 'profile_required' }) } });
  try {
    assert.equal(result.status, 'needs_action');
    assert.equal(result.reason, 'profile_required');
    assert.deepEqual(calls, ['inspect']);
    assert.equal(store.pendingCount(), 0);
  } finally { store.close(); }
});

test('unverified search filters never open a result', async () => {
  const { result, store, calls } = await run({ overrides: { search: async () => ({ verified: true, contextId: 'c', keyword: '别克壁纸', filters: { sort: 'comprehensive' } }) } });
  try {
    assert.equal(result.reason, 'search_filters_mismatch');
    assert.deepEqual(calls, ['inspect', 'search']);
  } finally { store.close(); }
});

test('fresh clipboard with a different work ID is retained as unverified evidence and blocks more actions', async () => {
  const { result, store, calls } = await run({ overrides: { copyLink: async ({ detail }) => ({ identityVerified: true,
    fresh: true, markerReplaced: true, detailId: detail.detailId, externalId: detail.externalId,
    shareUrl: 'https://www.douyin.com/video/9999999999999999999' }) } });
  try {
    assert.equal(result.status, 'needs_action');
    assert.equal(result.reason, 'link_identity_mismatch');
    assert.equal(calls.at(-1), 'copyLink');
    assert.equal(store.pendingCount(), 1);
    const event = store.nextBatch().events[0];
    assert.equal(event.verification, 'link_unverified');
    assert.equal(event.verifiedExternalId, null);
    assert.equal(event.reason, 'link_identity_mismatch');
  } finally { store.close(); }
});

test('stale clipboard cannot be accepted even when the ID and title look plausible', async () => {
  const { result, store } = await run({ overrides: { copyLink: async ({ detail }) => ({ identityVerified: true,
    fresh: false, markerReplaced: false, detailId: detail.detailId, externalId: detail.externalId,
    shareUrl: `https://www.douyin.com/video/${detail.externalId}` }) } });
  try {
    assert.equal(result.reason, 'clipboard_not_fresh');
    assert.equal(result.stats.links, 0);
    assert.equal(store.nextBatch().events[0].verification, 'link_unverified');
  } finally { store.close(); }
});

test('an operator stop in a stuck UI call has no false idle acknowledgement', async () => {
  const task = fixtureTask();
  const clock = fixtureClock();
  const permit = fixturePermit(task, clock);
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const pending = run({ task, clock, permit, overrides: { openCard: async () => { entered(); return new Promise(() => {}); } } });
  await ready;
  permit.stop('operator_takeover');
  const { result, store, calls } = await pending;
  try {
    assert.equal(result.status, 'canceled');
    assert.equal(result.deviceIdle, false);
    assert.equal(result.stopConfirmationRequired, true);
    assert.equal(calls.at(-1), 'openCard');
    assert.equal(store.pendingCount(), 0);
  } finally { store.close(); }
});

test('only an explicitly retry-safe loading failure is retried once', async () => {
  let attempts = 0;
  const { result, store, calls } = await run({ overrides: { search: async () => {
    attempts++;
    throw Object.assign(new Error('Loading failed'), { code: 'loading_failed', safeToRetry: true });
  } } });
  try {
    assert.equal(attempts, 2);
    assert.equal(result.reason, 'loading_failed');
    assert.deepEqual(calls, ['inspect', 'search', 'search']);
  } finally { store.close(); }
});

test('card budget charges before attempting a card and does not block that final permitted card', async () => {
  const task = fixtureTask({ budgets: { maxCards: 1 } });
  const { result, store } = await run({ task });
  try {
    assert.equal(result.status, 'completed');
    assert.equal(result.stats.cards, 1);
    assert.equal(result.stats.links, 1);
  } finally { store.close(); }
});
