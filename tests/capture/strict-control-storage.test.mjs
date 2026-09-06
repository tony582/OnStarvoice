import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);
const background = readFileSync(new URL('background.js', root), 'utf8');
const identity = readFileSync(new URL('utils/capture/execution-identity.js', root), 'utf8');
function declaration(name) {
  const starts = [...background.matchAll(new RegExp(`^(?:async )?function ${name}\\(`, 'gm'))];
  assert.equal(starts.length, 1, name);
  const start = starts[0].index;
  const end = background.indexOf('\n}', start);
  assert.ok(end > start);
  const source = background.slice(start, end + 2);
  new vm.Script(`(${source})`);
  return source;
}
const functions = ['runUnattendedRunMutation', 'runTaskLedgerMutation',
  'runUnattendedRunArchiveMutation', 'strictUnattendedControlRejection',
  'captureStrictUnattendedControlSource', 'strictUnattendedStoredSourceMatches',
  'persistStrictUnattendedTerminalMetadata', 'removeArchivedUnattendedKeywordRunRequest'];
const startKeys = background.indexOf('const STORAGE_KEYS = {');
const keysSource = background.slice(startKeys, background.indexOf('\n};', startKeys) + 3);
const expected = Object.freeze({version: 1, requestId: 'request-a', attemptId: 'attempt-a',
  updatedAt: '2026-09-06T00:00:00.000Z', agentScopeId: 'scope-a'});
const raw = Object.freeze({id: expected.requestId, attemptId: expected.attemptId,
  updatedAt: expected.updatedAt, cloudAgentScopeId: expected.agentScopeId,
  status: 'failed', records: ['preserved'], progress: {pending: 3}});
const candidate = Object.freeze({...raw, updatedAt: '2026-09-06T00:00:01.000Z',
  recoveryDismissedAt: '2026-09-06T00:00:01.000Z', recoveryDismissedMessage: 'synthetic keep results'});
const run = Object.freeze({id: raw.id, attemptId: raw.attemptId, updatedAt: raw.updatedAt,
  status: raw.status, metadata: {cloudAgentScopeId: raw.cloudAgentScopeId}, counts: {saved: 7}});
const clone = value => structuredClone(value);
const stable = value => JSON.parse(JSON.stringify(value));
function deferred() {
  let release;
  const promise = new Promise(resolve => {release = resolve;});
  return {promise, release};
}
function harness() {
  const storage = {}, effects = [], writes = [];
  let beforeSet = null;
  const context = vm.createContext({
    chrome: {storage: {local: {
      async get(keys) {
        effects.push('get');
        return Object.fromEntries(keys.filter(key => Object.hasOwn(storage, key)).map(key => [key, clone(storage[key])]));
      },
      async set(values) {
        writes.push(stable(values));
        if (beforeSet) await beforeSet(values, writes.length);
        effects.push('set');
        Object.assign(storage, clone(values));
      },
      async remove() {assert.fail('strict kernel must not remove reserve/other keys');},
    }}},
    controlStorageReserveApi: {isStorageQuotaError: error => error?.name === 'QuotaExceededError'},
    isTerminalUnattendedRunStatus: status => ['failed', 'canceled', 'completed', 'needs_action'].includes(status),
  });
  vm.runInContext(`${identity}\n${keysSource}\nlet unattendedRunMutationQueue=Promise.resolve();
    let taskLedgerMutationQueue=Promise.resolve();let unattendedRunArchiveMutationQueue=Promise.resolve();
    ${functions.map(declaration).join('\n')}
    globalThis.api={${functions.join(',')}, keys:STORAGE_KEYS};`, context);
  const {api} = context, keys = api.keys;
  storage[keys.unattendedKeywordRunRequest] = clone(raw);
  storage[keys.taskLedger] = {version: 1, updatedAt: raw.updatedAt, runs: [clone(run), {id: 'other', untouched: true}]};
  storage[keys.auth] = {captureAgent: {id: expected.agentScopeId, token: 'synthetic-not-authority'}};
  storage[keys.unattendedKeywordPlan] = {untouched: true};
  storage[keys.unattendedKeywordRunArchive] = {version: 1, agentScopeId: expected.agentScopeId,
    requests: {[raw.id]: clone(raw), unrelated: {unknownLegacyFields: true}}};
  return {api, keys, storage, effects, writes, setBeforeSet(value) {beforeSet = value;},
    persist: (value = candidate, source = expected) => api.persistStrictUnattendedTerminalMetadata(value, {strictSource: source}),
    remove: (source = expected) => api.removeArchivedUnattendedKeywordRunRequest(expected.requestId, {strictSource: source})};
}

test('internal terminal kernel changes only dismissal/version metadata and ledger version', async () => {
  const h = harness(), before = clone(h.storage);
  // Even a candidate with other data does not replace business payloads.
  const result = await h.persist({...candidate, records: ['must not overwrite'], progress: {pending: 0}});
  assert.equal(result.accepted, true);
  assert.equal(result.persisted, true);
  const stored = h.storage[h.keys.unattendedKeywordRunRequest];
  assert.deepEqual(stored, {...raw, updatedAt: candidate.updatedAt,
    recoveryDismissedAt: candidate.updatedAt, recoveryDismissedMessage: candidate.recoveryDismissedMessage});
  assert.deepEqual(h.storage[h.keys.taskLedger].runs, [{...run, updatedAt: candidate.updatedAt}, {id: 'other', untouched: true}]);
  for (const key of [h.keys.auth, h.keys.unattendedKeywordPlan, h.keys.unattendedKeywordRunArchive]) {
    assert.deepEqual(h.storage[key], before[key]);
  }
  assert.deepEqual(h.effects, ['get', 'set']);
  assert.deepEqual(Object.keys(h.writes[0]).sort(), [h.keys.unattendedKeywordRunRequest, h.keys.taskLedger].sort());
});

for (const field of ['id', 'attemptId', 'updatedAt', 'cloudAgentScopeId']) {
  test(`queued ${field} replacement rejects without storage mutation`, async () => {
    const h = harness(), gate = deferred();
    const writer = h.api.runUnattendedRunMutation(async () => {
      await gate.promise;
      h.storage[h.keys.unattendedKeywordRunRequest][field] = 'replaced';
    });
    const pending = h.persist();
    await Promise.resolve();
    assert.deepEqual(h.effects, [], 'strict kernel waits for U before reading');
    gate.release();
    await writer;
    const result = await pending;
    assert.equal(result.reason, 'strict_source_changed');
    assert.deepEqual(h.writes, []);
  });
}

test('ledger queue history deletion wins without request resurrection', async () => {
  const h = harness(), gate = deferred();
  const deletion = h.api.runTaskLedgerMutation(async () => {
    await gate.promise;
    delete h.storage[h.keys.unattendedKeywordRunRequest];
    h.storage[h.keys.taskLedger].runs = [];
  });
  const pending = h.persist();
  await Promise.resolve();
  assert.deepEqual(h.effects, []);
  gate.release();
  await deletion;
  assert.equal((await pending).accepted, false);
  assert.equal(Object.hasOwn(h.storage, h.keys.unattendedKeywordRunRequest), false);
  assert.deepEqual(h.writes, []);
});

test('two commands with the same source version cannot both commit', async () => {
  const h = harness();
  const results = await Promise.all([h.persist(), h.persist()]);
  assert.deepEqual(results.map(r => r.accepted), [true, false]);
  assert.equal(h.writes.length, 1);
  const next = {...expected, updatedAt: candidate.updatedAt};
  assert.equal((await h.persist({...candidate, updatedAt: '2026-09-06T00:00:02.000Z',
    recoveryDismissedAt: '2026-09-06T00:00:02.000Z'}, next)).accepted, true, 'request and ledger versions advance together');
});

test('an older target cannot rewind another task\'s newer shared ledger timestamp', async () => {
  const h = harness();
  h.storage[h.keys.taskLedger].updatedAt = '2026-09-06T00:01:00.000Z';
  assert.equal((await h.persist()).accepted, true);
  assert.equal(h.storage[h.keys.taskLedger].updatedAt, '2026-09-06T00:01:00.000Z');
  assert.equal(h.storage[h.keys.taskLedger].runs[0].updatedAt, candidate.updatedAt);
});

for (const status of ['running', 'pending', 'needs_action', undefined]) {
  test(`metadata kernel does not accept ${status} as terminal dismissal`, async () => {
    const h = harness();
    assert.equal((await h.persist({...candidate, status})).reason, 'strict_source_invalid');
    assert.deepEqual(h.effects, []);
  });
}

for (const value of [null, undefined, false, {}, {...expected, attemptId: ''}, {...expected, version: 2}]) {
  test(`malformed kernel source rejects before reads: ${JSON.stringify(value)}`, async () => {
    const h = harness();
    // Avoid the test helper's default-parameter handling for explicit undefined.
    const result = await h.api.persistStrictUnattendedTerminalMetadata(candidate, {strictSource: value});
    assert.equal(result.accepted, false);
    assert.deepEqual(h.effects, []);
  });
}

test('same/backward/invalid successor versions and mismatched patch dates reject', async () => {
  for (const value of [raw.updatedAt, '2026-09-05T00:00:00.000Z', 'bad-date', undefined]) {
    const h = harness();
    assert.equal((await h.persist({...candidate, updatedAt: value, recoveryDismissedAt: value})).accepted, false);
    assert.deepEqual(h.effects, []);
  }
  const h = harness();
  assert.equal((await h.persist({...candidate, recoveryDismissedAt: raw.updatedAt})).accepted, false);
  assert.deepEqual(h.effects, []);
});

for (const change of ['scope', 'ledgerAttempt', 'ledgerVersion', 'ledgerStatus', 'duplicateLedger', 'rawAttemptMissing']) {
  test(`raw ${change} mismatch is zero-write rejection`, async () => {
    const h = harness();
    if (change === 'scope') h.storage[h.keys.auth].captureAgent.id = 'new-scope';
    if (change === 'ledgerAttempt') h.storage[h.keys.taskLedger].runs[0].attemptId = 'attempt-b';
    if (change === 'ledgerVersion') h.storage[h.keys.taskLedger].runs[0].updatedAt = candidate.updatedAt;
    if (change === 'ledgerStatus') h.storage[h.keys.taskLedger].runs[0].status = 'completed';
    if (change === 'duplicateLedger') h.storage[h.keys.taskLedger].runs.push(clone(run));
    if (change === 'rawAttemptMissing') delete h.storage[h.keys.unattendedKeywordRunRequest].attemptId;
    const before = clone(h.storage);
    assert.equal((await h.persist()).accepted, false);
    assert.deepEqual(h.storage, before);
    assert.deepEqual(h.writes, []);
  });
}

for (const change of ['attempt', 'clear', 'scope']) {
  test(`quota retry re-enters queues and rejects ${change} before replay`, async () => {
    const h = harness();
    h.setBeforeSet((_values, count) => {
      if (count !== 1) assert.fail('stale candidate must not reach another set');
      void h.api.runUnattendedRunMutation(() => {
        if (change === 'attempt') h.storage[h.keys.unattendedKeywordRunRequest].attemptId = 'attempt-b';
        if (change === 'clear') delete h.storage[h.keys.unattendedKeywordRunRequest];
        if (change === 'scope') h.storage[h.keys.auth].captureAgent.id = 'scope-b';
      });
      throw Object.assign(new Error('synthetic quota'), {name: 'QuotaExceededError'});
    });
    assert.equal((await h.persist()).reason, 'strict_source_changed');
    assert.equal(h.writes.length, 1, 'one failed write attempt, no stale replay');
    assert.deepEqual(h.effects, ['get', 'get']);
  });
}

test('bounded quota retry succeeds only if source is still exact; nonquota is not retried', async () => {
  const h = harness();
  h.setBeforeSet((_value, count) => {
    if (count === 1) throw Object.assign(new Error('quota'), {name: 'QuotaExceededError'});
  });
  assert.equal((await h.persist()).accepted, true);
  assert.deepEqual(h.effects, ['get', 'get', 'set']);
  const other = harness();
  other.setBeforeSet(() => {throw new Error('disk failure');});
  await assert.rejects(other.persist(), /disk failure/);
  assert.equal(other.writes.length, 1);
});

test('source and patch are frozen before waiting, not reread from caller objects', async () => {
  const h = harness(), gate = deferred(), source = {...expected}, value = {...candidate};
  const blocker = h.api.runUnattendedRunMutation(() => gate.promise);
  const pending = h.persist(value, source);
  source.attemptId = 'bad'; value.recoveryDismissedMessage = 'bad';
  gate.release(); await blocker;
  assert.equal((await pending).accepted, true);
  assert.equal(h.storage[h.keys.unattendedKeywordRunRequest].recoveryDismissedMessage, candidate.recoveryDismissedMessage);
});

test('archive exact deletion preserves unrelated raw legacy records and is not replayable', async () => {
  const h = harness();
  assert.equal((await h.remove()).removed, true);
  assert.deepEqual(h.storage[h.keys.unattendedKeywordRunArchive].requests, {unrelated: {unknownLegacyFields: true}});
  assert.deepEqual(h.storage[h.keys.unattendedKeywordRunRequest], raw);
  assert.equal((await h.remove()).accepted, false);
  assert.equal(h.writes.length, 1);
});

for (const change of ['attemptId', 'updatedAt', 'cloudAgentScopeId', 'containerScope', 'authScope', 'missingAttempt']) {
  test(`archive queued ${change} replacement cannot be deleted`, async () => {
    const h = harness(), gate = deferred();
    const writer = h.api.runUnattendedRunArchiveMutation(async () => {
      await gate.promise;
      const archive = h.storage[h.keys.unattendedKeywordRunArchive];
      if (change === 'containerScope') archive.agentScopeId = 'scope-b';
      else if (change === 'authScope') h.storage[h.keys.auth].captureAgent.id = 'scope-b';
      else if (change === 'missingAttempt') delete archive.requests[raw.id].attemptId;
      else archive.requests[raw.id][change] = 'replacement';
    });
    const pending = h.remove();
    gate.release(); await writer;
    assert.equal((await pending).accepted, false);
    assert.ok(h.storage[h.keys.unattendedKeywordRunArchive].requests[raw.id]);
    assert.deepEqual(h.writes, []);
  });
}
