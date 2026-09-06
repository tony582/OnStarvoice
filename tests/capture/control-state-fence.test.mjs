import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {AsyncLocalStorage} from 'node:async_hooks';

const source = readFileSync(new URL('../../utils/control/state-fence.js', import.meta.url), 'utf8');
function locks() {
  const tails = new Map();
  return {request(name, _options, operation) {
    const next = (tails.get(name) || Promise.resolve()).then(operation, operation);
    tails.set(name, next.catch(() => {}));
    return next;
  }};
}
function api(sharedLocks) {
  const context = vm.createContext({navigator: {locks: sharedLocks}});
  vm.runInContext(source, context);
  return context.OnStarvoiceControlStateFence;
}
const deferred = () => {
  let resolve;
  const promise = new Promise(done => {resolve = done;});
  return {promise, resolve};
};

test('independent Extension realms share the final leaf lock', async () => {
  const shared = locks(), a = api(shared), b = api(shared), gate = deferred(), events = [];
  const one = a.run(async () => {events.push('read-a'); await gate.promise; events.push('write-a');});
  await Promise.resolve();
  const two = b.run(() => {events.push('read-b'); events.push('write-b');});
  await Promise.resolve();
  assert.deepEqual(events, ['read-a']);
  gate.resolve();
  await Promise.all([one, two]);
  assert.deepEqual(events, ['read-a', 'write-a', 'read-b', 'write-b']);
});

test('Auth then Q serializes set/update/clear with a strict final write', async () => {
  const shared = locks(), a = api(shared), b = api(shared), gate = deferred(), events = [];
  const command = a.runAuth(() => a.run(async () => {
    events.push('command-read'); await gate.promise; events.push('command-write');
  }, {strict: true}), {strict: true});
  await new Promise(resolve => setImmediate(resolve));
  const auth = b.runAuth(() => b.run(() => events.push('auth-write')));
  await Promise.resolve();
  assert.deepEqual(events, ['command-read']);
  gate.resolve();
  await Promise.all([command, auth]);
  assert.deepEqual(events, ['command-read', 'command-write', 'auth-write']);
});

test('missing shared locking refuses strict but preserves the old compatibility path', async () => {
  const fence = api(undefined);
  let effects = 0;
  assert.equal(fence.available(), false);
  await assert.rejects(fence.run(() => {effects++;}, {strict: true}),
    {code: 'strict_shared_lock_unavailable'});
  await assert.rejects(fence.runAuth(() => {effects++;}, {strict: true}),
    {code: 'strict_shared_lock_unavailable'});
  assert.equal(effects, 0);
  await fence.run(() => {effects++;});
  assert.equal(effects, 1);
});

test('failure releases Q so a later operation freshly reads state', async () => {
  const fence = api(locks()), state = {value: 1};
  await assert.rejects(fence.run(() => {throw new Error('quota');}), /quota/);
  state.value = 2;
  assert.equal(await fence.run(() => state.value), 2);
});

const root = new URL('../../', import.meta.url);
const read = file => readFileSync(new URL(file, root), 'utf8');
const background = read('background.js');
const clone = value => structuredClone(value);
const stable = value => JSON.parse(JSON.stringify(value));
const BASE = Date.parse('2026-09-06T04:00:00.000Z');
const iso = delta => new Date(BASE + delta).toISOString();
function declaration(name) {
  const start = background.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, name);
  const end = background.indexOf('\n}', start);
  const body = background.slice(start, end + 2);
  new vm.Script(`(${body})`);
  return body;
}

// Real host writers, queues, request normalizer, ledger core, reserve retry and
// cross-realm fence. Only unrelated business projections are small test ports;
// the full production terminal projection is exercised in terminal-control-wiring.
function writerHarness({store = {}, sharedLocks = null} = {}) {
  let time = BASE, beforeSet = null;
  const events = [], writes = [], lockContext = new AsyncLocalStorage(), tails = new Map();
  const shared = sharedLocks || {request(name, options, operation) {
    assert.equal(options.mode, 'exclusive');
    assert.equal((lockContext.getStore() || []).includes('onstarvoice:control-state-v1'), false,
      'Q must be a leaf, including across awaits');
    const pending = (tails.get(name) || Promise.resolve()).then(() =>
      lockContext.run([...(lockContext.getStore() || []), name], operation));
    tails.set(name, pending.catch(() => {}));
    return pending;
  }};
  class FixedDate extends Date {
    constructor(...args) {super(...(args.length ? args : [time]));}
    static now() {return time;}
  }
  const outsideQ = label => {
    assert.equal((lockContext.getStore() || []).includes('onstarvoice:control-state-v1'), false, label);
    events.push(label);
  };
  const area = {
    async get(keys) {
      events.push('get');
      const list = typeof keys === 'string' ? [keys] : keys;
      return Object.fromEntries(list.filter(key => Object.hasOwn(store, key)).map(key => [key, clone(store[key])]));
    },
    async set(values) {
      writes.push(stable(values));
      if (beforeSet) await beforeSet(values);
      Object.assign(store, clone(values));
    },
    async remove(keys) {for (const key of typeof keys === 'string' ? [keys] : keys) delete store[key];},
  };
  const context = vm.createContext({Date: FixedDate, navigator: {locks: shared}, chrome: {storage: {local: area}},
    console, outsideQ,
    normalizeUnattendedKeywordPlan: value => value || {},
    normalizeStoredTargetedPostRunRequest: request => ({request: {...request, createdAt: request.createdAt || iso(0)}}),
    targetedPostPhysicalRunId: request => request?.id || '',
    targetedPostLogicalRequestId: request => request?.id || '',
    isSupportedCloudTargetedPostWorkflow: () => true,
    isTaskRunActuallyActive: run => run.status === 'running',
    isTerminalUnattendedRunStatus: status => ['completed','completed_with_failures','failed','canceled'].includes(status),
    isRetryableUnattendedRunRequest: request => Boolean(request && !request.recoveryDismissedAt),
    readCloudTaskAgentCredential: async () => ({id: 'scope-a'}),
    buildUnattendedTaskRun: (request, prior) => ({...prior, ...request,
      taskType: 'unattended_keyword_capture', metadata: {cloudAgentScopeId: request.cloudAgentScopeId}}),
    buildTargetedPostTaskCenterRun: request => ({...request, taskType: 'targeted_post_capture',
      metadata: {cloudAgentScopeId: 'scope-a'}}),
    normalizeUnattendedKeywordRunArchive: value => ({version: 1, requests: {}, ...value}),
    scheduleCloudTaskAgentSync: () => outsideQ('sync-scheduled'),
  });
  for (const file of ['utils/task-center.js','utils/control-storage-reserve.js','utils/control/state-fence.js']) {
    vm.runInContext(read(file), context);
  }
  const names = ['runUnattendedRunMutation','runTaskLedgerMutation','runUnattendedRunArchiveMutation',
    'runAuthoritativeControlStorageMutation','normalizeUnattendedRunRequest','getUnattendedTaskCenterCore',
    'upsertUnattendedTaskLedger','persistUnattendedRunMutation','readTaskLedger','persistTargetedPostRunRequest',
    'upsertTaskLedgerRun','clearTaskCenterRecords','archiveUnattendedKeywordRunRequest'];
  const startKeys = background.indexOf('const STORAGE_KEYS = {');
  const keysSource = background.slice(startKeys, background.indexOf('\n};', startKeys) + 3);
  vm.runInContext(`${keysSource}
    let unattendedRunMutationQueue=Promise.resolve(),taskLedgerMutationQueue=Promise.resolve(),unattendedRunArchiveMutationQueue=Promise.resolve();
    const UNATTENDED_RUN_SCHEMA_VERSION=2,TASK_LEDGER_STALE_ACTIVE_MS=600000;
    const UNATTENDED_RUN_TERMINAL_STATUSES=new Set(['completed','completed_with_failures','failed','canceled']);
    const AUTHORITATIVE_CONTROL_TERMINAL_STATUSES=UNATTENDED_RUN_TERMINAL_STATUSES;
    const cloudTargetedPostApi={isTerminalRunStatus:isTerminalUnattendedRunStatus};
    const controlStorageReserveApi=OnStarvoiceControlStorageReserve;
    ${names.map(declaration).join('\n')}
    const readUnattendedKeywordRunArchive=async()=>{
      const result=await chrome.storage.local.get(STORAGE_KEYS.unattendedKeywordRunArchive);
      return normalizeUnattendedKeywordRunArchive(result[STORAGE_KEYS.unattendedKeywordRunArchive]);
    };
    for(const name of ['runUnattendedRunMutation','runTaskLedgerMutation','runUnattendedRunArchiveMutation']) {
      const original=globalThis[name];globalThis[name]=operation=>{outsideQ(name);return original(operation);};
    }
    globalThis.api={${names.join(',')},keys:STORAGE_KEYS};`, context);
  const {api} = context, keys = api.keys;
  const request = {id: 'request-a', attemptId: 'attempt-a', updatedAt: iso(-1000), createdAt: iso(-10000),
    status: 'running', cloudAssigned: true, cloudAgentScopeId: 'scope-a'};
  return {api, keys, store, area, events, writes, request, fence: context.OnStarvoiceControlStateFence, sharedLocks: shared,
    seed(value = request) {
      store[keys.unattendedKeywordRunRequest] = clone(value);
      store[keys.taskLedger] = {version: 1, runs: [{...clone(value), taskType: 'unattended_keyword_capture',
        attemptId: value.attemptId || `legacy-${value.id}`}], updatedAt: value.updatedAt};
      return clone(value);
    },
    setTime(value) {time = value;}, setBeforeSet(value) {beforeSet = value;},
    persist(value, options = {}) {return api.persistUnattendedRunMutation(value, {mirrorPlan: false, ...options});},
  };
}

test('legacy comparison is explicit and never loosens strict raw identity', () => {
  const fence = api(locks()), current = {id: 'old', updatedAt: iso(-1)};
  const normalized = {...current, attemptId: 'legacy-old'};
  assert.equal(fence.sameRequestVersion(current, normalized), false);
  assert.equal(fence.sameLegacyRequestVersion(current, normalized), true);
  assert.equal(fence.sameLegacyRequestVersion(current, {...normalized, attemptId: 'another'}), false);
});

test('legacy missing-Attempt source can update, archive and be replaced without a reset', async () => {
  const h = writerHarness(), raw = {...h.request}; delete raw.attemptId;
  h.seed(raw);
  const previous = h.api.normalizeUnattendedRunRequest(raw);
  const archived = await h.api.archiveUnattendedKeywordRunRequest(previous);
  assert.equal(archived.attemptId, 'legacy-request-a');
  const updated = (await h.persist({...previous, updatedAt: iso(0)}, {previousRequest: previous})).request;
  assert.equal(updated.attemptId, 'legacy-request-a');
  const next = {...h.request, id: 'request-b', attemptId: 'attempt-b', createdAt: iso(1), updatedAt: iso(1)};
  assert.equal((await h.persist(next, {creationSource: updated, creationClearedAt: ''})).request.id, next.id);
});

test('clear history retains live predecessor and permits exact normal Attempt transition', async () => {
  const h = writerHarness(), previous = h.seed();
  const cleared = await h.api.clearTaskCenterRecords();
  assert.equal(cleared.preservedActiveCount, 1);
  const next = {...previous, attemptId: 'attempt-b', attemptNumber: 2, updatedAt: iso(1)};
  assert.equal((await h.persist(next, {previousRequest: previous, allowAttemptTransition: true})).request.attemptId, 'attempt-b');
  assert.equal(h.store[h.keys.taskLedger].clearedAt, iso(0));
  await assert.rejects(h.persist({...next, attemptId: 'attempt-c'}, {
    previousRequest: previous, allowAttemptTransition: true,
  }), {code: 'CONTROL_SOURCE_CHANGED'});
});

test('clear history removes terminal source and a late producer cannot resurrect it after worker restart', async () => {
  const h = writerHarness(), previous = h.seed({...h.request, status: 'failed'});
  await h.api.clearTaskCenterRecords();
  assert.equal(h.store[h.keys.unattendedKeywordRunRequest], undefined);
  const restarted = writerHarness({store: h.store, sharedLocks: h.sharedLocks});
  await assert.rejects(restarted.persist({...previous, updatedAt: iso(1)}), {code: 'CONTROL_SOURCE_CHANGED'});
  assert.equal(h.store[h.keys.taskLedger].runs.length, 0);
});

test('clear history also retains the explicit legacy predecessor for normal recovery', async () => {
  const h = writerHarness(), raw = {...h.request}; delete raw.attemptId;
  h.seed(raw);
  const previous = h.api.normalizeUnattendedRunRequest(raw);
  await h.api.clearTaskCenterRecords();
  const next = {...previous, attemptId: 'attempt-b', attemptNumber: 2, updatedAt: iso(1)};
  assert.equal((await h.persist(next, {previousRequest: previous, allowAttemptTransition: true})).request.attemptId, 'attempt-b');
});

for (const createdAt of [iso(0), iso(1), iso(100000)]) {
  test(`creation prepared before reset cannot use later timestamp ${createdAt} to bypass clear marker`, async () => {
    const h = writerHarness();
    h.store[h.keys.taskLedger] = {version: 1, runs: [], clearedAt: iso(0), updatedAt: iso(0)};
    await assert.rejects(h.persist({...h.request, createdAt, updatedAt: createdAt}, {
      creationSource: null, creationClearedAt: '',
    }), {code: 'CONTROL_SOURCE_CHANGED'});
    assert.equal(h.writes.length, 0);
  });
}

test('fresh creation after clear is accepted only against current marker and slot', async () => {
  const h = writerHarness();
  h.store[h.keys.taskLedger] = {version: 1, runs: [], clearedAt: iso(0), updatedAt: iso(0)};
  assert.equal((await h.persist({...h.request, createdAt: iso(1), updatedAt: iso(1)}, {
    creationSource: null, creationClearedAt: iso(0),
  })).request.id, h.request.id);
});

for (const createdAt of [iso(0), iso(-1000)]) {
  test(`fresh ingress clear witness permits same/backward clock ${createdAt} without accepting pre-reset work`, async () => {
    const h = writerHarness();
    h.store[h.keys.taskLedger] = {version: 1, runs: [], clearedAt: iso(0), updatedAt: iso(0)};
    const request = {...h.request, createdAt, updatedAt: createdAt};
    assert.equal((await h.persist(request, {creationSource: null, creationClearedAt: iso(0)})).request.id, request.id);
    const targeted = {...request, id: 'fresh-targeted'};
    assert.equal((await h.api.persistTargetedPostRunRequest(targeted, {creationClearedAt: iso(0)})).id, targeted.id);
    await assert.rejects(h.api.persistTargetedPostRunRequest({...targeted, id: 'pre-reset-targeted'}, {creationClearedAt: ''}),
      {code: 'CONTROL_SOURCE_CHANGED'});
  });
}

test('Q wait observes a replaced source before any ordinary mutation', async () => {
  const h = writerHarness(), prior = h.seed(), gate = deferred(), entered = deferred();
  const other = api(h.sharedLocks);
  const blocker = other.run(async () => {entered.resolve(); await gate.promise;
    h.store[h.keys.unattendedKeywordRunRequest] = {...prior, attemptId: 'replacement'};});
  await entered.promise;
  const pending = h.persist({...prior, updatedAt: iso(1)}, {previousRequest: prior});
  gate.resolve(); await blocker;
  await assert.rejects(pending, {code: 'CONTROL_SOURCE_CHANGED'});
  assert.equal(h.writes.length, 0);
});

test('late terminal_absorbed writer retains dismissal and a newer global ledger version', async () => {
  const h = writerHarness(), prior = h.seed({...h.request, status: 'completed_with_failures',
    updatedAt: iso(1), recoveryDismissedAt: iso(1), recoveryDismissedMessage: 'keep'});
  h.store[h.keys.taskLedger].updatedAt = iso(100);
  const stale = {...prior, updatedAt: iso(-1000)}; delete stale.recoveryDismissedAt; delete stale.recoveryDismissedMessage;
  const result = await h.persist(stale);
  assert.equal(result.request.recoveryDismissedAt, iso(1));
  assert.equal(result.request.updatedAt, iso(1));
  assert.equal(h.store[h.keys.taskLedger].updatedAt, iso(100));
  assert.ok(h.events.includes('sync-scheduled'));
});

test('archive queued behind dismissal cannot recreate its recovery suggestion', async () => {
  const h = writerHarness(), prior = h.seed(), gate = deferred(), entered = deferred();
  const blocker = h.fence.run(async () => {entered.resolve(); await gate.promise;
    h.store[h.keys.unattendedKeywordRunRequest] = {...prior, updatedAt: iso(1), recoveryDismissedAt: iso(1)};});
  await entered.promise;
  const pending = h.api.archiveUnattendedKeywordRunRequest(prior);
  gate.resolve(); await blocker;
  assert.equal(await pending, null);
  assert.equal(h.writes.length, 0);
});

for (const createdAt of [undefined, iso(-1), iso(0)]) {
  test(`targeted old raw source ${createdAt} cannot repair or recreate reset ledger`, async () => {
    const h = writerHarness(), targeted = {...h.request, id: 'targeted-a', workflow: 'targeted_post', createdAt};
    h.store[h.keys.taskLedger] = {version: 1, runs: [], clearedAt: iso(0), updatedAt: iso(0)};
    h.store[h.keys.targetedPostRunRequest] = targeted;
    assert.equal((await h.api.readTaskLedger()).runs.length, 0);
    await assert.rejects(h.api.persistTargetedPostRunRequest(targeted), {code: 'CONTROL_SOURCE_CHANGED'});
    assert.equal(h.writes.length, 0);
  });
}

test('targeted retained live row can update after history clear while fresh unrelated repair still works', async () => {
  const h = writerHarness(), target = {...h.request, id: 'targeted-a', workflow: 'targeted_post'};
  h.store[h.keys.taskLedger] = {version: 1, runs: [target], clearedAt: iso(0), updatedAt: iso(0)};
  await h.api.persistTargetedPostRunRequest({...target, updatedAt: iso(1)});
  assert.equal(h.store[h.keys.taskLedger].runs.length, 1);
  h.store[h.keys.targetedPostRunRequest] = {...target, id: 'targeted-new', createdAt: iso(2), updatedAt: iso(2)};
  assert.equal((await h.api.readTaskLedger()).runs.length, 2);
});

test('patch-only late ledger write cannot recreate cleared row but retained row still updates', async () => {
  const h = writerHarness();
  h.store[h.keys.taskLedger] = {version: 1, runs: [], clearedAt: iso(0), updatedAt: iso(0)};
  assert.equal((await h.api.upsertTaskLedgerRun({patch: {id: 'late', status: 'running'}})).reason, 'source_missing_or_cleared');
  assert.equal((await h.api.upsertTaskLedgerRun({run: {...h.request, createdAt: iso(1), updatedAt: iso(1)}})).accepted, true);
  assert.equal((await h.api.upsertTaskLedgerRun({patch: {id: h.request.id, message: 'later'}})).accepted, true);
});

test('delta writer reads fresh root, preserves unknown fields and rejects a changed control version', async () => {
  const h = writerHarness(), prior = h.seed();
  h.store[h.keys.unattendedKeywordRunRequest].unrelated = {keep: true};
  await h.fence.writeRequestDelta(h.area, h.keys.unattendedKeywordRunRequest, prior, {...prior, message: 'patch'});
  assert.deepEqual(h.store[h.keys.unattendedKeywordRunRequest].unrelated, {keep: true});
  h.store[h.keys.unattendedKeywordRunRequest].updatedAt = iso(1);
  await assert.rejects(h.fence.writeRequestDelta(h.area, h.keys.unattendedKeywordRunRequest, prior, {...prior, message: 'stale'}),
    {code: 'CONTROL_SOURCE_CHANGED'});
});

test('ordinary quota retry re-enters queues and cannot overwrite a reset between attempts', async () => {
  const h = writerHarness(), prior = h.seed({...h.request, status: 'failed'});
  h.setBeforeSet(async () => {
    h.setBeforeSet(null);
    delete h.store[h.keys.unattendedKeywordRunRequest];
    h.store[h.keys.taskLedger] = {version: 1, runs: [], clearedAt: iso(0), updatedAt: iso(0)};
    throw Object.assign(new Error('quota exceeded'), {name: 'QuotaExceededError'});
  });
  await assert.rejects(h.persist({...prior, updatedAt: iso(1)}), {code: 'CONTROL_SOURCE_CHANGED'});
  assert.equal(h.writes.length, 1);
  assert.equal(h.store[h.keys.taskLedger].runs.length, 0);
});
