import assert from 'node:assert/strict';
import test from 'node:test';
import { createHistoryReadAuthorizer } from '../../extension-ui/application/history-read-authorizer.mjs';
import { evaluateAccessPolicy } from '../../extension-ui/domain/access-policy.mjs';
import { createSnapshotResultSource } from '../../extension-ui/application/snapshot-result-source.mjs';
import { createResultReadSession } from '../../extension-ui/application/result-read-session.mjs';

const SCOPE = Object.freeze({ tenantId: 'synthetic-tenant', taskId: 'synthetic-task', executionId: 'synthetic-execution' });
const IDENTITY = Object.freeze({ principalId: 'principal-1', sessionId: 'session-1' });

function request(overrides = {}) {
  return { scope: { ...SCOPE }, snapshotId: 'snapshot-1', recordNamespace: 'client_record', signal: new AbortController().signal, ...overrides };
}

function facts(target = request(), overrides = {}) {
  return {
    ...IDENTITY, scope: { ...target.scope }, snapshotId: target.snapshotId, recordNamespace: target.recordNamespace,
    accessRevision: 'access-1', identityStatus: 'active', tenantStatus: 'active', membershipStatus: 'active', deviceStatus: 'active',
    licenseStatus: 'active', licenseExpiresAt: 2000, sessionExpiresAt: 100000, evidenceExpiresAt: 90000,
    historyReadAllowed: true, captureAllowed: true, ...overrides,
  };
}

function make(options = {}) {
  const calls = [];
  const identity = options.identity ?? { ...IDENTITY };
  const authorize = createHistoryReadAuthorizer({
    identity,
    readAccessFacts(target) {
      calls.push(target);
      return options.readAccessFacts ? options.readAccessFacts(target, calls.length) : facts(target);
    },
    now: options.now ?? (() => 1000),
  });
  return { authorize, calls, identity };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function unavailable(promise) {
  await assert.rejects(promise, error => {
    assert.equal(error instanceof Error, true);
    assert.equal(error.message, 'History read unavailable');
    assert.deepEqual(Object.keys(error), []);
    for (const key of ['cause', 'facts', 'scope', 'identity', 'grant']) assert.equal(Object.hasOwn(error, key), false);
    return true;
  });
}

test('history authorizer passes a frozen exact request and returns only a bounded U3 permission', async () => {
  const { authorize, calls, identity } = make();
  const input = request({ principalId: 'untrusted-principal', sessionId: 'untrusted-session', privateToken: 'not forwarded' });
  const result = await authorize(input);
  assert.deepEqual(result, {
    allowed: true, scope: SCOPE, snapshotId: 'snapshot-1', recordNamespace: 'client_record', accessRevision: 'access-1', expiresAt: 31000,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.scope), true);
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0]).sort(), ['principalId', 'recordNamespace', 'scope', 'sessionId', 'signal', 'snapshotId']);
  assert.equal(calls[0].principalId, IDENTITY.principalId);
  assert.equal(calls[0].sessionId, IDENTITY.sessionId);
  assert.equal(calls[0].signal, input.signal);
  assert.equal(Object.isFrozen(calls[0]), true);
  assert.equal(Object.isFrozen(calls[0].scope), true);
  assert.notEqual(calls[0].scope, input.scope);
  assert.equal(Object.isFrozen(input), false);
  assert.equal(Object.isFrozen(input.scope), false);
  assert.equal(Object.isFrozen(identity), false);
});

test('business license expiration never truncates permitted historical read lifetime', async () => {
  const { authorize } = make({ readAccessFacts: target => facts(target, { licenseStatus: 'expired', licenseExpiresAt: 0 }) });
  assert.equal((await authorize(request())).expiresAt, 31000);
});

for (const field of ['sessionExpiresAt', 'evidenceExpiresAt']) {
  test(`${field} limits the returned grant before the 30-second cap`, async () => {
    const { authorize } = make({ readAccessFacts: target => facts(target, { [field]: 1001 }) });
    assert.equal((await authorize(request())).expiresAt, 1001);
  });
}

test('each invocation reads fresh facts without cached permissions or retries', async () => {
  const { authorize, calls } = make({ readAccessFacts: (target, count) => facts(target, { accessRevision: `revision-${count}` }) });
  assert.equal((await authorize(request())).accessRevision, 'revision-1');
  assert.equal((await authorize(request())).accessRevision, 'revision-2');
  assert.equal(calls.length, 2);
});

test('a denial on a later call is not overridden by an earlier successful historical read', async () => {
  const { authorize, calls } = make({ readAccessFacts: (target, count) => facts(target, { historyReadAllowed: count === 1 }) });
  await authorize(request());
  await unavailable(authorize(request()));
  assert.equal(calls.length, 2);
});

for (const overrides of [
  { licenseStatus: 'frozen' }, { licenseStatus: 'revoked' }, { identityStatus: 'expired' }, { membershipStatus: 'revoked' },
  { tenantStatus: 'frozen' }, { deviceStatus: 'revoked' }, { sessionExpiresAt: 1000 }, { evidenceExpiresAt: 1000 },
  { historyReadAllowed: false }, { principalId: 'foreign-principal' }, { sessionId: 'foreign-session' },
  { scope: { ...SCOPE, tenantId: 'foreign-tenant' } }, { snapshotId: 'foreign-snapshot' }, { recordNamespace: 'server_record' },
  { accessRevision: '' }, { captureAllowed: undefined }, { licenseStatus: 'expired', licenseExpiresAt: 2000 },
]) {
  test(`bridge rejects unavailable facts ${JSON.stringify(overrides)} with no raw error or partial grant`, async () => {
    const { authorize, calls } = make({ readAccessFacts: target => facts(target, overrides) });
    await unavailable(authorize(request()));
    assert.equal(calls.length, 1);
  });
}

for (const mode of ['sync-throw', 'async-reject', 'undefined', 'null', 'getter', 'proxy']) {
  test(`fact provider ${mode} is redacted and never retried`, async () => {
    let reads = 0;
    const { authorize, calls } = make({ readAccessFacts: target => {
      if (mode === 'sync-throw') throw new Error('private session token');
      if (mode === 'async-reject') return Promise.reject(new Error('private session token'));
      if (mode === 'undefined') return undefined;
      if (mode === 'null') return null;
      if (mode === 'proxy') return new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('private descriptor'); } });
      const result = facts(target);
      Object.defineProperty(result, 'historyReadAllowed', { get() { reads++; throw new Error('private getter'); } });
      return result;
    } });
    await unavailable(authorize(request()));
    assert.equal(calls.length, 1);
    assert.equal(reads, 0);
  });
}

for (const field of ['scope', 'snapshotId', 'recordNamespace', 'signal']) {
  test(`request ${field} must be an own data property without getter execution`, async () => {
    for (const mode of ['missing', 'inherited', 'getter']) {
      const { authorize, calls } = make();
      const input = request();
      const value = input[field];
      delete input[field];
      let reads = 0;
      if (mode === 'inherited') Object.setPrototypeOf(input, { [field]: value });
      if (mode === 'getter') Object.defineProperty(input, field, { get() { reads++; return value; } });
      await unavailable(authorize(input));
      assert.equal(calls.length, 0);
      assert.equal(reads, 0);
    }
  });
}

for (const field of Object.keys(SCOPE)) {
  test(`request scope ${field} rejects non-exact and inherited values before fact lookup`, async () => {
    for (const value of ['', ' leading', 'trailing ', 'bad\u200Fid', 'x'.repeat(241), null]) {
      const { authorize, calls } = make();
      await unavailable(authorize(request({ scope: { ...SCOPE, [field]: value } })));
      assert.equal(calls.length, 0);
    }
    const scope = { ...SCOPE };
    delete scope[field];
    Object.setPrototypeOf(scope, { [field]: SCOPE[field] });
    const { authorize, calls } = make();
    await unavailable(authorize(request({ scope })));
    assert.equal(calls.length, 0);
  });
}

test('invalid request containers, snapshots, namespaces, and spoofed signals fail before provider invocation', async () => {
  const { authorize, calls } = make();
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('private'); } });
  for (const value of [undefined, null, [], 'request', true, proxy]) await unavailable(authorize(value));
  for (const value of ['', ' bad', 'x'.repeat(241), 'bad\u2066id', null]) await unavailable(authorize(request({ snapshotId: value })));
  for (const value of ['', 'record', 'client_record ', null]) await unavailable(authorize(request({ recordNamespace: value })));
  for (const signal of [undefined, null, {}, { aborted: false, addEventListener() {}, removeEventListener() {} }]) {
    await unavailable(authorize(request({ signal })));
  }
  assert.equal(calls.length, 0);
});

test('native signal checks do not consult caller-owned aborted accessors', async () => {
  const controller = new AbortController();
  let reads = 0;
  Object.defineProperty(controller.signal, 'aborted', { get() { reads++; throw new Error('not native'); } });
  const { authorize } = make();
  assert.equal((await authorize(request({ signal: controller.signal }))).allowed, true);
  assert.equal(reads, 0);
});

test('already-aborted requests never start reading facts', async () => {
  const controller = new AbortController();
  controller.abort(new Error('private abort reason'));
  const { authorize, calls } = make();
  await unavailable(authorize(request({ signal: controller.signal })));
  assert.equal(calls.length, 0);
});

for (const completion of ['resolve', 'reject']) {
  test(`abort while provider is pending discards later ${completion} without publishing a grant`, async () => {
    const controller = new AbortController();
    const pending = deferred();
    const started = deferred();
    const { authorize, calls } = make({ readAccessFacts(target) { started.resolve(target); return pending.promise; } });
    const work = authorize(request({ signal: controller.signal }));
    const checked = unavailable(work);
    const target = await started.promise;
    controller.abort();
    if (completion === 'resolve') pending.resolve(facts(target));
    else pending.reject(new Error('late private provider failure'));
    await checked;
    assert.equal(calls.length, 1);
  });
}

test('synchronous provider abort prevents permission release', async () => {
  const controller = new AbortController();
  const { authorize } = make({ readAccessFacts(target) { controller.abort(); return facts(target); } });
  await unavailable(authorize(request({ signal: controller.signal })));
});

for (const field of ['principalId', 'sessionId']) {
  test(`mutating original configured ${field} before a call cannot redirect its fixed trusted identity`, async () => {
    const { authorize, identity, calls } = make();
    identity[field] = 'new-identity';
    assert.equal((await authorize(request())).allowed, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][field], IDENTITY[field]);
  });
  test(`mutating original configured ${field} during lookup cannot change the pinned request`, async () => {
    const identity = { ...IDENTITY };
    const { authorize, calls } = make({ identity, readAccessFacts(target) { identity[field] = 'new-identity'; return facts(target); } });
    assert.equal((await authorize(request())).allowed, true);
    assert.equal(calls[0][field], IDENTITY[field]);
  });
  test(`a fresh facts ${field} change after an earlier read rejects the old identity instance`, async () => {
    const { authorize, calls } = make({ readAccessFacts: (target, count) => facts(target, { [field]: count === 1 ? IDENTITY[field] : 'new-identity' }) });
    await authorize(request());
    await unavailable(authorize(request()));
    assert.equal(calls.length, 2);
  });
}

test('replacing an original configuration field with an accessor does not affect the detached identity or invoke it', async () => {
  const { authorize, identity, calls } = make();
  let reads = 0;
  Object.defineProperty(identity, 'sessionId', { get() { reads++; return IDENTITY.sessionId; } });
  assert.equal((await authorize(request())).allowed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, IDENTITY.sessionId);
  assert.equal(reads, 0);
});

test('caller request mutation during a read cannot redirect the frozen facts query or result', async () => {
  const input = request();
  const { authorize } = make({ readAccessFacts(target) {
    input.scope.tenantId = 'foreign-tenant';
    input.snapshotId = 'foreign-snapshot';
    input.recordNamespace = 'server_record';
    return facts(target);
  } });
  const result = await authorize(input);
  assert.deepEqual(result.scope, SCOPE);
  assert.equal(result.snapshotId, 'snapshot-1');
  assert.equal(result.recordNamespace, 'client_record');
});

test('permission expiry uses the current post-provider time, not the time before an asynchronous wait', async () => {
  let clock = 1000;
  const { authorize } = make({ now: () => clock, readAccessFacts(target) { clock = 5000; return facts(target); } });
  assert.equal((await authorize(request())).expiresAt, 35000);
});

test('facts are detached before the clock callback can mutate shared provider values', async () => {
  let shared;
  const { authorize } = make({
    readAccessFacts(target) { shared = facts(target); return shared; },
    now() {
      if (shared) {
        shared.scope.tenantId = 'foreign-tenant';
        shared.accessRevision = 'late-foreign-revision';
        shared.snapshotId = 'foreign-snapshot';
        shared.historyReadAllowed = false;
      }
      return 1000;
    },
  });
  const result = await authorize(request());
  assert.deepEqual(result.scope, SCOPE);
  assert.equal(result.snapshotId, 'snapshot-1');
  assert.equal(result.accessRevision, 'access-1');
});

test('a frozen facts provider response is never mutated or exposed through the returned grant', async () => {
  const shared = facts();
  Object.freeze(shared.scope);
  Object.freeze(shared);
  const { authorize } = make({ readAccessFacts: () => shared });
  const result = await authorize(request());
  assert.equal(result.allowed, true);
  assert.notEqual(result.scope, shared.scope);
  assert.deepEqual(Object.keys(result).sort(), ['accessRevision', 'allowed', 'expiresAt', 'recordNamespace', 'scope', 'snapshotId']);
  assert.equal(Object.hasOwn(result, 'capture'), false);
  assert.equal(Object.hasOwn(result, 'principalId'), false);
  assert.equal(Object.hasOwn(result, 'sessionId'), false);
});

test('session expiry while facts are loading blocks rather than issuing a stale grant', async () => {
  let clock = 1000;
  const { authorize } = make({ now: () => clock, readAccessFacts(target) { clock = 5000; return facts(target, { sessionExpiresAt: 5000 }); } });
  await unavailable(authorize(request()));
});

for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER - 29999, '1000', null, undefined]) {
  test(`invalid or grant-overflowing clock ${String(value)} is redacted`, async () => {
    const { authorize } = make({ now: () => value });
    await unavailable(authorize(request()));
  });
}

test('a throwing clock does not expose its error or return a grant', async () => {
  const { authorize } = make({ now() { throw new Error('private clock failure'); } });
  await unavailable(authorize(request()));
});

test('30-second cap arithmetic rejects overflow even when the underlying facts are otherwise fresh', async () => {
  const clock = Number.MAX_SAFE_INTEGER - 29999;
  const { authorize } = make({ now: () => clock, readAccessFacts: target => facts(target, {
    licenseStatus: 'expired', licenseExpiresAt: 0, sessionExpiresAt: Number.MAX_SAFE_INTEGER, evidenceExpiresAt: Number.MAX_SAFE_INTEGER,
  }) });
  await unavailable(authorize(request()));
});

test('the greatest safe expiry remains valid when 30-second cap addition is exact', async () => {
  const clock = Number.MAX_SAFE_INTEGER - 30000;
  const { authorize } = make({ now: () => clock, readAccessFacts: target => facts(target, {
    licenseStatus: 'expired', licenseExpiresAt: 0, sessionExpiresAt: Number.MAX_SAFE_INTEGER, evidenceExpiresAt: Number.MAX_SAFE_INTEGER,
  }) });
  assert.equal((await authorize(request())).expiresAt, Number.MAX_SAFE_INTEGER);
});

test('default clock uses current time without changing the global clock', async () => {
  const start = Date.now();
  const authorize = createHistoryReadAuthorizer({ identity: IDENTITY, readAccessFacts: target => facts(target, {
    licenseExpiresAt: start + 60000, sessionExpiresAt: start + 120000, evidenceExpiresAt: start + 120000,
  }) });
  const result = await authorize(request());
  const end = Date.now();
  assert.equal(result.expiresAt >= start + 30000, true);
  assert.equal(result.expiresAt <= end + 30000, true);
});

test('malformed factory configuration always yields one fixed TypeError', () => {
  const base = () => ({ identity: { ...IDENTITY }, readAccessFacts: target => facts(target) });
  const configs = [undefined, null, [], {}, { ...base(), identity: null }, { ...base(), readAccessFacts: null }, { ...base(), now: null }, { ...base(), now: 1000 }];
  for (const field of ['principalId', 'sessionId']) {
    for (const value of [undefined, '', 'bad id', 'x'.repeat(241), 'bad\u200Fid', null, 1]) configs.push({ ...base(), identity: { ...IDENTITY, [field]: value } });
    const identity = { ...IDENTITY };
    delete identity[field];
    Object.setPrototypeOf(identity, { [field]: IDENTITY[field] });
    configs.push({ ...base(), identity });
  }
  for (const config of configs) {
    assert.throws(() => createHistoryReadAuthorizer(config), error => error instanceof TypeError && error.message === 'Invalid history authorizer configuration' && !Object.hasOwn(error, 'cause'));
  }
});

test('factory capabilities and identity fields are not read through accessors', () => {
  let reads = 0;
  const getter = { get() { reads++; throw new Error('private config getter'); } };
  for (const field of ['identity', 'readAccessFacts', 'now']) {
    const config = { identity: { ...IDENTITY }, readAccessFacts: target => facts(target) };
    Object.defineProperty(config, field, getter);
    assert.throws(() => createHistoryReadAuthorizer(config), { name: 'TypeError', message: 'Invalid history authorizer configuration' });
  }
  for (const field of ['principalId', 'sessionId']) {
    const identity = { ...IDENTITY };
    Object.defineProperty(identity, field, getter);
    assert.throws(() => createHistoryReadAuthorizer({ identity, readAccessFacts: target => facts(target) }), { name: 'TypeError', message: 'Invalid history authorizer configuration' });
  }
  assert.equal(reads, 0);
});

function composition(t, options = {}) {
  const calls = { facts: [], detail: [] };
  const clock = options.now ?? (() => 1000);
  const authorize = createHistoryReadAuthorizer({ identity: IDENTITY, now: clock, readAccessFacts(target) {
    calls.facts.push(target);
    return options.readAccessFacts ? options.readAccessFacts(target, calls.facts.length) : facts(target, { licenseStatus: 'expired', licenseExpiresAt: 0 });
  } });
  const source = createSnapshotResultSource({
    manifest: {
      scope: SCOPE, snapshotId: 'snapshot-1', recordNamespace: 'client_record',
      entries: [{ recordId: 'record-1', recordVersion: 'version-1', summary: {
        id: 'record-1', title: '人工历史结果', author: '人工作者', platform: 'xiaohongshu', kind: 'note', summary: '历史摘要',
        likes: 1, commentsCount: 0, capture: { status: 'completed' }, delivery: { remote: 'confirmed', local: 'confirmed' },
      } }],
    },
    authorize,
    now: clock,
    loadDetail(target) {
      calls.detail.push(target);
      if (options.loadDetail) return options.loadDetail(target);
      return { ...target, detail: { body: '人工历史正文', comments: [], truncated: { body: false, comments: false } } };
    },
  });
  const session = createResultReadSession({ scope: SCOPE, source });
  t.after(() => { session.close(); source.close(); });
  return { source, session, calls };
}

test('expired-license U2 + U3 + bridge composition reads both history page and precise detail without enabling capture', async t => {
  const { session, calls } = composition(t);
  const page = await session.readPage();
  assert.equal(page.status, 'ready');
  assert.equal(page.page.items[0].title, '人工历史结果');
  const detail = await session.readDetail({ pageToken: page.pageToken, recordId: 'record-1' });
  assert.equal(detail.status, 'ready');
  assert.equal(detail.detail.body, '人工历史正文');
  assert.equal(calls.facts.length, 4);
  assert.equal(calls.detail.length, 1);
  assert.equal(calls.detail[0].recordVersion, 'version-1');
  for (const target of calls.facts) {
    const result = evaluateAccessPolicy(facts(target, { licenseStatus: 'expired', licenseExpiresAt: 0 }), target, 1000);
    assert.equal(result.history.allowed, true);
    assert.equal(result.capture.allowed, false);
    assert.equal(result.capture.reason, 'license_expired');
  }
});

for (const overrides of [{ licenseStatus: 'frozen' }, { licenseStatus: 'revoked' }, { sessionExpiresAt: 1000 }, { membershipStatus: 'revoked' }]) {
  test(`composition refuses page publication after a second-check change ${JSON.stringify(overrides)}`, async t => {
    const { session, calls } = composition(t, { readAccessFacts: (target, count) => facts(target, {
      licenseStatus: 'expired', licenseExpiresAt: 0, ...(count === 2 ? overrides : {}),
    }) });
    const page = await session.readPage();
    assert.equal(page.status, 'read_failed');
    assert.equal(Object.hasOwn(page, 'page'), false);
    assert.equal(calls.facts.length, 2);
    assert.equal(calls.detail.length, 0);
  });
  test(`composition refuses loaded detail after a second-check change ${JSON.stringify(overrides)}`, async t => {
    const { session, calls } = composition(t, { readAccessFacts: (target, count) => facts(target, {
      licenseStatus: 'expired', licenseExpiresAt: 0, ...(count === 4 ? overrides : {}),
    }) });
    const page = await session.readPage();
    assert.equal(page.status, 'ready');
    const detail = await session.readDetail({ pageToken: page.pageToken, recordId: 'record-1' });
    assert.equal(detail.status, 'read_failed');
    assert.equal(Object.hasOwn(detail, 'detail'), false);
    assert.equal(calls.facts.length, 4);
    assert.equal(calls.detail.length, 1);
  });
}

test('the bridge preserves access revision changes so U3 can reject mismatched before/after permits', async t => {
  const { session, calls } = composition(t, { readAccessFacts: (target, count) => facts(target, {
    licenseStatus: 'expired', licenseExpiresAt: 0, accessRevision: `revision-${count}`,
  }) });
  const page = await session.readPage();
  assert.equal(page.status, 'read_failed');
  assert.equal(calls.facts.length, 2);
});

test('business expiration during a historical detail read remains readable with the same access revision', async t => {
  let clock = 1000;
  const { session, calls } = composition(t, {
    now: () => clock,
    readAccessFacts: target => facts(target, { licenseStatus: 'active', licenseExpiresAt: 2000 }),
    loadDetail(target) {
      clock = 3000;
      return { ...target, detail: { body: 'license expired during read', comments: [], truncated: { body: false, comments: false } } };
    },
  });
  const page = await session.readPage();
  const detail = await session.readDetail({ pageToken: page.pageToken, recordId: 'record-1' });
  assert.equal(detail.status, 'ready');
  assert.equal(calls.facts.length, 4);
  const target = calls.facts.at(-1);
  assert.equal(evaluateAccessPolicy(facts(target), target, clock).capture.allowed, false);
});

test('U2 cancellation releases the consumer even while a trusted facts provider does not cooperate', async t => {
  const pending = deferred();
  const started = deferred();
  const { session, calls } = composition(t, { readAccessFacts(target) { started.resolve(target); return pending.promise; } });
  const work = session.readPage();
  const target = await started.promise;
  session.cancel();
  const result = await work;
  assert.equal(result.status, 'cancelled');
  assert.equal(session.isCurrent(result.requestToken), false);
  assert.equal(target.signal.aborted, true);
  pending.resolve(facts(target));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls.facts.length, 1);
  assert.equal(calls.detail.length, 0);
});

test('U3 permanent close rejects pending authorization without waiting for an uncooperative provider', async t => {
  const pending = deferred();
  const started = deferred();
  const { source, calls } = composition(t, { readAccessFacts(target) { started.resolve(target); return pending.promise; } });
  const work = source.readSummaryPage({ scope: SCOPE, query: { filter: 'all', offset: 0, limit: 50 }, signal: new AbortController().signal });
  const checked = assert.rejects(work, { message: 'Result read unavailable' });
  await started.promise;
  source.close();
  await checked;
  pending.reject(new Error('late private failure'));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls.facts.length, 1);
});
