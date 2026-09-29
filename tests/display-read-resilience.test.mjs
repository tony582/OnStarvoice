import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import test from 'node:test';

import {
  ClientGoneError,
  ReadBudgetExceededError,
  createClientGoneProbe,
  createLastGoodStore,
  createRateLimitedReporter,
  createSingleFlightReadCache,
  isClientGoneError,
  isTransientDatabaseReadError,
  traceReadExecutor,
  transientDatabaseReadRetryAfterMs,
} from '../server/services/display-read-resilience.js';
import {DbCapacityError} from '../server/db/query.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {promise, resolve, reject};
}

function databaseError(code) {
  return Object.assign(new Error(`database ${code}`), {code});
}

test('only a saturated gate, a statement timeout and a lock timeout are transient', () => {
  assert.equal(isTransientDatabaseReadError(new DbCapacityError('reporting', 250)), true);
  assert.equal(isTransientDatabaseReadError(new DbCapacityError('reporting', 250, 'queue_full')), true);
  assert.equal(isTransientDatabaseReadError(databaseError('57014')), true);
  assert.equal(isTransientDatabaseReadError(databaseError('55P03')), true);
  assert.equal(isTransientDatabaseReadError(new ReadBudgetExceededError('stop_fences', 8000)), true);
  for (const code of ['42P01', '42703', '22012', '23505', '40P01', '28P01', '']) {
    assert.equal(isTransientDatabaseReadError(databaseError(code)), false, code);
  }
  assert.equal(isTransientDatabaseReadError(new TypeError('programming error')), false);
  assert.equal(isTransientDatabaseReadError(null), false);
  assert.equal(isTransientDatabaseReadError(new ClientGoneError()), false);
});

test('the suggested retry interval follows the gate and stays within a quarter second and ten seconds', () => {
  assert.equal(transientDatabaseReadRetryAfterMs(new DbCapacityError('reporting', 1500)), 1500);
  assert.equal(transientDatabaseReadRetryAfterMs(databaseError('57014')), 1000);
  assert.equal(transientDatabaseReadRetryAfterMs(databaseError('57014'), 3000), 3000);
  assert.equal(transientDatabaseReadRetryAfterMs({retryAfterMs: 10}), 250);
  assert.equal(transientDatabaseReadRetryAfterMs({retryAfterMs: 60_000}), 10_000);
  assert.equal(transientDatabaseReadRetryAfterMs({retryAfterMs: 'soon'}, 2000), 2000);
});

test('a client is gone only when its response closed unfinished or its socket was destroyed', () => {
  const finished = Object.assign(new EventEmitter(), {writableEnded: false});
  const finishedProbe = createClientGoneProbe({socket: {destroyed: false}}, finished);
  assert.equal(finishedProbe(), false);
  finished.writableEnded = true;
  finished.emit('close');
  assert.equal(finishedProbe(), false, 'closing after the answer was written is the normal end');

  const aborted = Object.assign(new EventEmitter(), {writableEnded: false});
  const abortedProbe = createClientGoneProbe({socket: {destroyed: false}}, aborted);
  aborted.emit('close');
  assert.equal(abortedProbe(), true);

  const socket = {destroyed: false};
  const socketProbe = createClientGoneProbe({socket}, new EventEmitter());
  assert.equal(socketProbe(), false);
  socket.destroyed = true;
  assert.equal(socketProbe(), true);

  assert.equal(createClientGoneProbe({}, {})(), false, 'test doubles without events or sockets read as present');
  assert.equal(isClientGoneError(new ClientGoneError()), true);
  assert.equal(isClientGoneError(databaseError('57014')), false);
});

test('the last complete answer is readable until its maximum age and bounded in number', () => {
  assert.throws(() => createLastGoodStore({}), /last_good_max_age_required/u);
  const store = createLastGoodStore({maxAgeMs: 1_000, maxEntries: 2});
  assert.equal(store.read('a', 0), null);
  store.remember('a', {n: 1}, 100);
  assert.deepEqual(store.read('a', 100), {value: {n: 1}, ageMs: 0});
  assert.deepEqual(store.read('a', 1_100), {value: {n: 1}, ageMs: 1_000});
  assert.equal(store.read('a', 1_101), null);
  assert.equal(store.size, 0, 'an answer past its age is dropped, not kept for later');

  store.remember('a', 'first', 0);
  store.remember('b', 'second', 0);
  store.remember('a', 'first again', 10);
  store.remember('c', 'third', 20);
  assert.equal(store.size, 2);
  assert.equal(store.read('b', 20), null, 'the least recently remembered key leaves first');
  assert.equal(store.read('a', 20).value, 'first again');
  assert.equal(store.read('c', 20).value, 'third');
  store.clear();
  assert.equal(store.size, 0);
});

test('of two overlapping loads the one that started later stays, whichever finishes last', () => {
  const store = createLastGoodStore({maxAgeMs: 90_000});
  // Load A starts at 1000 and is slow. A writer clears the short cache, load B
  // starts at 4000, sees the write and finishes first.
  assert.equal(store.remember('tenant:100', {task: 'closed by the operator'}, 4_000), true);
  assert.equal(store.remember('tenant:100', {task: 'needs_action'}, 1_000), false);
  assert.deepEqual(store.read('tenant:100', 20_000), {value: {task: 'closed by the operator'}, ageMs: 16_000});
  // Same start (one load remembered twice) and later starts replace.
  assert.equal(store.remember('tenant:100', {task: 'same start'}, 4_000), true);
  assert.equal(store.remember('tenant:100', {task: 'newer'}, 4_001), true);
  assert.equal(store.read('tenant:100', 20_000).value.task, 'newer');
  assert.equal(store.remember('other:100', {task: 'other tenant'}, 10), true, 'keys do not compare with each other');
});

test('ordinary reads share a recent answer and the load that is running', async () => {
  let nowMs = 10_000;
  let loads = 0;
  const cache = createSingleFlightReadCache({ttlMs: 20_000, staleMaxAgeMs: 60_000, now: () => nowMs});
  const first = deferred();
  const loader = () => { loads += 1; return first.promise; };
  const readOne = cache.read('tenant', loader);
  const readTwo = cache.read('tenant', loader);
  await Promise.resolve();
  assert.equal(loads, 1, 'the second reader joins the running load');
  first.resolve({count: 22});
  assert.deepEqual(await readOne, {value: {count: 22}, stale: false, ageMs: 0});
  assert.deepEqual(await readTwo, {value: {count: 22}, stale: false, ageMs: 0});

  nowMs += 20_000;
  assert.deepEqual(
    await cache.read('tenant', () => { loads += 1; return {count: 0}; }),
    {value: {count: 22}, stale: false, ageMs: 20_000},
  );
  assert.equal(loads, 1);

  nowMs += 1;
  assert.deepEqual(
    await cache.read('tenant', () => { loads += 1; return {count: 21}; }),
    {value: {count: 21}, stale: false, ageMs: 0},
  );
  assert.equal(loads, 2);

  assert.deepEqual(
    await cache.read('other tenant', () => { loads += 1; return {count: 5}; }),
    {value: {count: 5}, stale: false, ageMs: 0},
    'keys never share answers',
  );
  assert.equal(loads, 3);
  await assert.rejects(cache.read('tenant'), /read_cache_loader_required/u);
});

test('a read after a write never receives an answer that was started before it', async () => {
  let nowMs = 0;
  const cache = createSingleFlightReadCache({ttlMs: 20_000, staleMaxAgeMs: 60_000, now: () => nowMs});
  assert.equal((await cache.read('tenant', () => 22)).value, 22);

  // Within the ttl an ordinary read reuses 22; a fresh one counts again.
  nowMs = 5;
  let loads = 0;
  assert.equal((await cache.read('tenant', () => { loads += 1; return 21; }, {fresh: true})).value, 21);
  assert.equal(loads, 1);
  assert.equal((await cache.read('tenant', () => { loads += 1; return 0; })).value, 21, 'the fresh answer is the cached one now');
  assert.equal(loads, 1);

  // A load is running when two writes finish: both wait for ONE follow-up load
  // that starts after the running one has ended.
  nowMs = 30_000;
  const running = deferred();
  const order = [];
  const periodic = cache.read('tenant', () => { order.push('running started'); return running.promise; });
  await Promise.resolve();
  const followUp = deferred();
  const followUpLoader = label => () => { order.push(`${label} started`); return followUp.promise; };
  const afterFirstWrite = cache.read('tenant', followUpLoader('first fresh'), {fresh: true});
  const afterSecondWrite = cache.read('tenant', followUpLoader('second fresh'), {fresh: true});
  await Promise.resolve();
  assert.deepEqual(order, ['running started'], 'the follow-up waits for the running load');
  running.resolve(20);
  assert.equal((await periodic).value, 20);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['running started', 'first fresh started'], 'both fresh reads share one follow-up');
  followUp.resolve(19);
  assert.equal((await afterFirstWrite).value, 19);
  assert.equal((await afterSecondWrite).value, 19);

  // A failed running load does not stop the follow-up.
  nowMs = 60_000;
  const failing = deferred();
  const failed = cache.read('tenant', () => failing.promise);
  await Promise.resolve();
  const afterWrite = cache.read('tenant', () => 18, {fresh: true});
  failing.reject(databaseError('42P01'));
  await assert.rejects(failed, {code: '42P01'});
  assert.equal((await afterWrite).value, 18);
});

test('a write that finishes while the follow-up is loading is counted by the next load', async () => {
  // Production shape: the count takes about 2.7 s, the operator handles a post
  // every few seconds. `pending` is what the database holds; each load answers
  // with what it held when the load started.
  let nowMs = 0;
  let pending = 10;
  const cache = createSingleFlightReadCache({ttlMs: 20_000, staleMaxAgeMs: 600_000, now: () => nowMs});
  const loads = [];
  const loader = () => {
    const gate = deferred();
    const load = {startedAt: nowMs, snapshot: pending, finish: () => gate.resolve(load.snapshot)};
    loads.push(load);
    return gate.promise;
  };
  const settle = () => new Promise(resolve => setImmediate(resolve));

  const periodic = cache.read('tenant', loader);
  await settle();
  nowMs = 1_000; pending = 9;
  const afterFirstWrite = cache.read('tenant', loader, {fresh: true});
  await settle();
  assert.equal(loads.length, 1, 'the follow-up waits for the running load');

  nowMs = 2_700;
  loads[0].finish();
  assert.equal((await periodic).value, 10);
  await settle();
  assert.deepEqual(loads.map(load => load.startedAt), [0, 2_700], 'the follow-up is loading now');

  nowMs = 3_500; pending = 8;
  const afterSecondWrite = cache.read('tenant', loader, {fresh: true});
  const ordinaryAfterSecondWrite = cache.read('tenant', loader);
  await settle();
  assert.equal(loads.length, 2, 'one load at a time');

  nowMs = 5_400;
  loads[1].finish();
  assert.equal((await afterFirstWrite).value, 9);
  await settle();
  assert.deepEqual(loads.map(load => load.startedAt), [0, 2_700, 5_400]);
  nowMs = 8_000;
  loads[2].finish();
  assert.deepEqual(await afterSecondWrite, {value: 8, stale: false, ageMs: 0},
    'answered by the load that started after the second write, not by the one that was running');
  assert.equal((await ordinaryAfterSecondWrite).value, 8,
    'a read sent after the fresh one joins the same follow-up: the page applies its latest request');
  assert.deepEqual(await cache.read('tenant', loader), {value: 8, stale: false, ageMs: 2_600});
  assert.equal(loads.length, 3);
});

test('an ordinary read joins the load that is running even when it could reuse the cached answer', async () => {
  let nowMs = 0;
  const cache = createSingleFlightReadCache({ttlMs: 20_000, staleMaxAgeMs: 600_000, now: () => nowMs});
  assert.equal((await cache.read('tenant', () => 22)).value, 22);
  // t=10 s: a write, then the page's fresh read; t=11 s: the page's 60 s timer.
  nowMs = 10_000;
  const recount = deferred();
  const afterWrite = cache.read('tenant', () => recount.promise, {fresh: true});
  nowMs = 11_000;
  let settled = false;
  const periodic = cache.read('tenant', () => assert.fail('must join, not load')).finally(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'the cached 22 would reach the page after the write and replace the recount');
  recount.resolve(21);
  assert.equal((await afterWrite).value, 21);
  assert.equal((await periodic).value, 21);
});

test('random interleavings: one load at a time, fresh answers start after arrival, answers never go back', async () => {
  let unhandled = 0;
  const onUnhandled = () => { unhandled += 1; };
  process.on('unhandledRejection', onUnhandled);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const failures = [];
  let freshAnswers = 0;
  for (let seed = 1; seed <= 400; seed += 1) {
    let state = seed;
    const random = () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
    let nowMs = 1_000;
    const cache = createSingleFlightReadCache({ttlMs: 20_000, staleMaxAgeMs: 600_000, now: () => nowMs});
    let running = 0;
    const open = [];
    const loader = () => {
      const startedAt = nowMs;
      running += 1;
      if (running > 1) failures.push({seed, problem: 'two loads at once'});
      return new Promise((resolve, reject) => {
        open.push(fail => {
          running -= 1;
          if (fail) reject(databaseError('57014')); else resolve({startedAt});
        });
      });
    };
    const answers = [];
    const reads = [];
    for (let step = 0; step < 60; step += 1) {
      nowMs += Math.floor(random() * 3_000) + 1;
      if (random() < 0.55) {
        const fresh = random() < 0.6;
        const arrival = {order: answers.length, arrivedAt: nowMs, fresh, startedAt: null};
        answers.push(arrival);
        reads.push(cache.read('tenant', loader, {fresh}).then(answer => {
          if (!answer.stale) arrival.startedAt = answer.ageMs === 0 ? answer.value.startedAt : answer.value.startedAt;
          arrival.stale = answer.stale;
        }, () => { arrival.failed = true; }));
      } else if (open.length > 0) {
        open.shift()(random() < 0.25);
      }
      if (random() < 0.5) await settle();
    }
    for (let round = 0; round < 200 && (open.length > 0 || round < 3); round += 1) {
      if (open.length > 0) open.shift()(false);
      await settle();
    }
    await Promise.all(reads);
    let newestSoFar = -Infinity;
    for (const arrival of answers) {
      if (arrival.failed || arrival.stale || arrival.startedAt === null) continue;
      if (arrival.fresh) {
        freshAnswers += 1;
        if (arrival.startedAt < arrival.arrivedAt) failures.push({seed, problem: 'fresh answer from an earlier load', arrival});
      }
      if (arrival.startedAt < newestSoFar) failures.push({seed, problem: 'a later read received an older answer', arrival});
      newestSoFar = Math.max(newestSoFar, arrival.startedAt);
    }
  }
  await settle();
  process.off('unhandledRejection', onUnhandled);
  assert.deepEqual(failures.slice(0, 3), []);
  assert.equal(unhandled, 0);
  assert.ok(freshAnswers > 3_000, `the run exercised ${freshAnswers} fresh answers`);
});

test('a transient failure falls back to the last complete answer, marked and bounded by age', async () => {
  let nowMs = 0;
  const cache = createSingleFlightReadCache({ttlMs: 1_000, staleMaxAgeMs: 10_000, now: () => nowMs});
  await assert.rejects(
    cache.read('tenant', () => { throw new DbCapacityError('reporting', 3000); }),
    {code: 'DB_CAPACITY_UNAVAILABLE'},
    'nothing to fall back to yet',
  );
  assert.equal((await cache.read('tenant', () => 22)).value, 22);

  nowMs = 5_000;
  const busy = new DbCapacityError('reporting', 3000);
  const stale = await cache.read('tenant', () => { throw busy; });
  assert.deepEqual(stale, {value: 22, stale: true, ageMs: 5_000, error: busy});

  const fresh = await cache.read('tenant', () => { throw databaseError('57014'); }, {fresh: true});
  assert.equal(fresh.stale, true, 'a read after a write says so too: the caller sees it is not current');
  assert.equal(fresh.value, 22);

  await assert.rejects(
    cache.read('tenant', () => { throw databaseError('42703'); }),
    {code: '42703'},
    'a broken statement is never hidden behind old numbers',
  );

  let loads = 0;
  assert.equal((await cache.read('tenant', () => { loads += 1; return 21; })).value, 21);
  assert.equal(loads, 1, 'failures are never cached: the next read loads again');

  nowMs = 5_000 + 10_001;
  await assert.rejects(
    cache.read('tenant', () => { throw new DbCapacityError('reporting', 3000); }),
    {code: 'DB_CAPACITY_UNAVAILABLE'},
    'an answer older than the bound is not served',
  );
});

test('readers that joined a failing load each receive the fallback or the error', async () => {
  let nowMs = 0;
  const cache = createSingleFlightReadCache({ttlMs: 0, staleMaxAgeMs: 10_000, now: () => nowMs});
  assert.equal((await cache.read('tenant', () => 7)).value, 7);
  nowMs = 1;
  const failing = deferred();
  const readers = [
    cache.read('tenant', () => failing.promise),
    cache.read('tenant', () => failing.promise),
  ];
  failing.reject(databaseError('57014'));
  for (const reader of readers) {
    const answer = await reader;
    assert.equal(answer.stale, true);
    assert.equal(answer.value, 7);
  }
});

test('the cache forgets settled keys beyond its size and never a key that is loading', async () => {
  const cache = createSingleFlightReadCache({ttlMs: 1_000, staleMaxAgeMs: 1_000, maxEntries: 2, now: () => 0});
  const slow = deferred();
  const loading = cache.read('loading', () => slow.promise);
  await cache.read('a', () => 1);
  await cache.read('b', () => 2);
  assert.equal(cache.size, 2, 'the settled key made room; the loading one stayed');
  await cache.read('c', () => 3);
  assert.equal(cache.size, 2);
  let reloads = 0;
  assert.equal((await cache.read('a', () => { reloads += 1; return 'a again'; })).value, 'a again');
  assert.equal(reloads, 1, 'a forgotten key loads again instead of answering from memory');
  slow.resolve('done');
  assert.equal((await loading).value, 'done');
  let loads = 0;
  assert.equal((await cache.read('loading', () => { loads += 1; return 'again'; })).value, 'done');
  assert.equal(loads, 0, 'the key that was loading kept its entry');
  cache.clear();
  assert.equal(cache.size, 0);
  assert.throws(() => createSingleFlightReadCache({staleMaxAgeMs: 1}), /read_cache_ttl_required/u);
  assert.throws(() => createSingleFlightReadCache({ttlMs: 1}), /read_cache_stale_age_required/u);
});

test('the reporter writes one line per key and interval and counts what it skipped', () => {
  let nowMs = 0;
  const lines = [];
  const report = createRateLimitedReporter({
    intervalMs: 10_000,
    now: () => nowMs,
    sink: (message, details) => lines.push([message, details]),
  });
  assert.equal(report('tenant-a', 'failed', {code: '57014'}), true);
  assert.equal(report('tenant-a', 'failed', {code: '57014'}), false);
  assert.equal(report('tenant-a', 'failed', {code: '57014'}), false);
  assert.equal(report('tenant-b', 'failed', {code: '55P03'}), true, 'another key has its own interval');
  nowMs = 10_000;
  assert.equal(report('tenant-a', 'failed', {code: 'DB_CAPACITY_UNAVAILABLE'}), true);
  assert.deepEqual(lines, [
    ['failed', {code: '57014'}],
    ['failed', {code: '55P03'}],
    ['failed', {code: 'DB_CAPACITY_UNAVAILABLE', suppressedSinceLastLine: 2}],
  ]);
});

test('a traced executor names the failed statement and records durations, never parameters', async () => {
  const calls = [];
  const executor = {
    category: 'reporting',
    client: {id: 'client'},
    queryAll: async (sql, params) => { calls.push(['queryAll', sql, params]); return [{id: 1}]; },
    queryOne: async (sql, params) => {
      calls.push(['queryOne', sql, params]);
      if (sql.includes('broken')) throw databaseError('57014');
      return {total: 3};
    },
    query: async () => ({rows: []}),
    execute: async () => ({rowCount: 0}),
  };
  const trace = [];
  const traced = traceReadExecutor(executor, trace, sql => (sql.includes('agents') ? 'agents' : 'summary'));
  assert.equal(traced.category, 'reporting');
  assert.equal(traced.client, executor.client);
  assert.deepEqual(await traced.queryAll('SELECT agents', ['tenant']), [{id: 1}]);
  assert.deepEqual(await traced.queryOne('SELECT summary', ['tenant']), {total: 3});
  await assert.rejects(traced.queryOne('SELECT broken', ['secret parameter']), error => {
    assert.equal(error.code, '57014');
    assert.equal(error.readStatement, 'summary');
    return true;
  });
  assert.deepEqual(calls.map(call => call[0]), ['queryAll', 'queryOne', 'queryOne']);
  assert.deepEqual(trace.map(entry => [entry.statement, entry.failed]), [
    ['agents', false],
    ['summary', false],
    ['summary', true],
  ]);
  for (const entry of trace) {
    assert.equal(Number.isInteger(entry.ms) && entry.ms >= 0, true);
    assert.deepEqual(Object.keys(entry).sort(), ['failed', 'ms', 'statement']);
  }
  assert.equal(JSON.stringify(trace).includes('secret parameter'), false);
});

test('a projection that used its budget sends no further statement', async () => {
  let nowMs = 0;
  const sent = [];
  const executor = {
    queryAll: async sql => { sent.push(sql); nowMs += sql === 'slow' ? 5_000 : 100; return []; },
    queryOne: async sql => { sent.push(sql); nowMs += 100; return null; },
    query: async () => ({rows: []}),
    execute: async () => ({rowCount: 0}),
  };
  const trace = [];
  const traced = traceReadExecutor(executor, trace, sql => sql, {budgetMs: 8_000, now: () => nowMs});
  await traced.queryAll('agents');
  await traced.queryAll('slow');
  await traced.queryOne('summary');
  assert.equal(nowMs, 5_200);
  await traced.queryAll('slow');
  // 10.2 s since the projection opened: the fifth statement is not sent.
  await assert.rejects(traced.queryAll('stop_fences'), error => {
    assert.equal(error instanceof ReadBudgetExceededError, true);
    assert.equal(error.code, 'READ_BUDGET_EXCEEDED');
    assert.equal(error.readStatement, 'stop_fences');
    assert.equal(isTransientDatabaseReadError(error), true);
    return true;
  });
  assert.deepEqual(sent, ['agents', 'slow', 'summary', 'slow']);
  assert.deepEqual(trace.map(entry => [entry.statement, entry.ms, entry.failed]), [
    ['agents', 100, false],
    ['slow', 5_000, false],
    ['summary', 100, false],
    ['slow', 5_000, false],
    ['stop_fences', 0, true],
  ]);

  // Without a budget nothing is refused, however long it takes.
  nowMs = 0;
  const unbounded = traceReadExecutor(executor, [], sql => sql, {now: () => nowMs});
  await unbounded.queryAll('slow');
  await unbounded.queryAll('slow');
  await unbounded.queryAll('slow');
  assert.deepEqual(await unbounded.queryAll('agents'), []);
});
