import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {webcrypto, createHash} from 'node:crypto';

const source = readFileSync(new URL('../../utils/control/local-capture-authority.js', import.meta.url), 'utf8');
const context = vm.createContext({TextEncoder, AbortController, crypto: webcrypto, setTimeout, clearTimeout});
vm.runInContext(source, context);
const api = context.OnStarvoiceLocalCaptureAuthority;
const NOW = Date.parse('2026-09-07T10:00:00.000Z');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = letter => letter.repeat(64);
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};

function fixture(action = 'admit_local_plan', platform = 'xiaohongshu') {
  let now = NOW, nextTimer = 0;
  const timers = new Map(), cleared = [], calls = [];
  const binding = {tenantId: id(1), agentId: id(2), authCodeId: id(3), authBindingId: id(4), bindingRevision: digest('a')};
  const auth = {authMutationId: 'fixture-auth-mutation', tenant: {id: binding.tenantId},
    captureAgent: {id: binding.agentId, token: 'private-fixture-token-never-persisted'}};
  const source = {originId: id(5), planFingerprint: digest('b'), platform,
    requestId: action === 'admit_local_plan' ? '' : id(6),
    attemptId: action === 'admit_local_plan' ? '' : id(7),
    generation: action === 'admit_local_plan' ? 0 : 1, sourceRevision: digest('c')};
  const input = {action, source, auth, expectedBinding: action === 'admit_local_plan' ? null : binding};
  const response = {ok: true, decision: 'allow', reason: 'local_control_authorized', action,
    policyVersion: 'local-capture-control-v1', ...binding, authorityRevision: digest('d'),
    source: clone(source), evaluatedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 5000).toISOString()};
  let onQuery = null;
  const client = api.create({now: () => now,
    setTimer: (callback, delay) => {const timer = ++nextTimer; timers.set(timer, {callback, delay}); return timer;},
    clearTimer: timer => {cleared.push(timer); timers.delete(timer);},
    query: async (body, options) => {
      calls.push({body, options});
      return onQuery ? onQuery(body, options) : response;
    }});
  return {input, response, binding, calls, timers, cleared, client,
    evaluate: () => client.evaluate(input), advance: ms => {now += ms;},
    expire() {for (const timer of [...timers.values()]) timer.callback();},
    set onQuery(value) {onQuery = value;},
  };
}

test('public contract has four distinct actions and no implicit local source candidate/migration', () => {
  assert.deepEqual([...api.ACTIONS], ['admit_local_plan', 'start_local_capture', 'stop_local_capture', 'recover_local_capture']);
  assert.equal(api.POLICY, 'local-capture-control-v1');
  assert.equal(api.WINDOW_MS, 5000);
  assert.equal(api.ORIGIN_KEY, 'onstarvoice.localCaptureOrigin.v1');
  assert.equal(api.candidate, undefined);
  assert.equal(Object.isFrozen(api), true);
});

for (const action of api.ACTIONS) for (const platform of ['xiaohongshu', 'douyin']) {
  test(`exact online ${action} accepts only its ${platform} source and current binding`, async () => {
    const f = fixture(action, platform), before = clone(f.input);
    const result = await f.evaluate();
    assert.equal(result.deadline, NOW + 5000);
    assert.equal(result.authority.action, action);
    assert.deepEqual(clone(result.authority.source), before.source);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(clone(f.calls[0].body), {action, source: before.source});
    assert.deepEqual(clone(f.calls[0].options.rawAuth), before.auth);
    assert.equal(f.calls[0].options.signal.aborted, false);
    assert.equal(f.timers.size, 0); assert.deepEqual(f.cleared, [1]);
    assert.equal(api.validateSource(action, before.source), true);
    assert.equal(api.sourceMatches(before.source, result.authority.source), true);
    assert.deepEqual(f.input, before);
    assert.equal(Object.isFrozen(result.authority.source), true);
    assert.doesNotMatch(JSON.stringify(result), /private-fixture-token|authMutationId|rawAuth|planSnapshot/);
  });
}

for (const [name, mutate] of [
  ['unknown action', input => {input.action = 'start_capture';}],
  ['missing origin', input => {delete input.source.originId;}],
  ['legacy origin alias', input => {input.source.originId = 'local-plan';}],
  ['uppercase origin UUID', input => {input.source.originId = 'aaaaaaaa-AAAA-4000-8000-000000000001';}],
  ['coerced origin UUID', input => {input.source.originId = {toString: () => id(5)};}],
  ['unknown platform', input => {input.source.platform = 'weibo';}],
  ['invalid plan fingerprint', input => {input.source.planFingerprint = 'a';}],
  ['uppercase plan fingerprint', input => {input.source.planFingerprint = digest('A');}],
  ['invalid source revision', input => {input.source.sourceRevision = null;}],
  ['plan with a request ID', input => {input.source.requestId = id(6);}],
  ['plan with an attempt ID', input => {input.source.attemptId = id(7);}],
  ['plan with positive generation', input => {input.source.generation = 1;}],
  ['coerced generation', input => {input.source.generation = '0';}],
  ['negative generation', input => {input.source.generation = -1;}],
  ['fractional generation', input => {input.source.generation = 0.5;}],
  ['unsafe generation', input => {input.source.generation = Number.MAX_SAFE_INTEGER + 1;}],
  ['cloudAssigned false is not provenance', input => {input.source.cloudAssigned = false;}],
  ['empty cloud command is not provenance', input => {input.source.cloudCommandId = '';}],
  ['unknown field', input => {input.source.trusted = true;}],
  ['symbol field', input => {input.source[Symbol('trusted')] = true;}],
  ['inherited origin', input => {const origin = input.source.originId; delete input.source.originId;
    Object.setPrototypeOf(input.source, {originId: origin});}],
]) {
  test(`malformed source has zero online calls: ${name}`, async () => {
    const f = fixture(); mutate(f.input);
    assert.equal(api.validateSource(f.input.action, f.input.source), false);
    await assert.rejects(f.evaluate(), /local_control_source_invalid/);
    assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 0);
  });
}

for (const action of ['start_local_capture', 'stop_local_capture', 'recover_local_capture']) {
  for (const [name, mutate] of [
    ['missing binding', input => {delete input.expectedBinding;}],
    ['plan-stage source', input => {input.source.requestId = ''; input.source.attemptId = ''; input.source.generation = 0;}],
    ['missing request', input => {input.source.requestId = '';}],
    ['legacy attempt', input => {input.source.attemptId = 'legacy-task';}],
  ]) {
    test(`${action} refuses ${name} before query`, async () => {
      const f = fixture(action); mutate(f.input);
      await assert.rejects(f.evaluate(), /local_control_(binding_unproven|source_invalid)/);
      assert.equal(f.calls.length, 0);
    });
  }
}

for (const [name, mutate] of [
  ['missing auth', input => {input.auth = null;}],
  ['missing mutation witness', input => {delete input.auth.authMutationId;}],
  ['missing agent token', input => {input.auth.captureAgent.token = '';}],
  ['invalid tenant', input => {input.auth.tenant.id = ' ';}],
  ['coerced agent', input => {input.auth.captureAgent.id = 12;}],
  ['mismatched bound tenant', input => {input.expectedBinding.tenantId = id(12);}],
  ['mismatched bound agent', input => {input.expectedBinding.agentId = id(12);}],
  ['missing bound auth code', input => {delete input.expectedBinding.authCodeId;}],
  ['invalid bound auth binding', input => {input.expectedBinding.authBindingId = 'legacy';}],
  ['invalid bound revision', input => {input.expectedBinding.bindingRevision = 'old';}],
  ['unexpected bound trust flag', input => {input.expectedBinding.trusted = true;}],
]) {
  test(`invalid caller binding/auth fails closed before query: ${name}`, async () => {
    const f = fixture('start_local_capture'); mutate(f.input);
    await assert.rejects(f.evaluate(), /local_control_/);
    assert.equal(f.calls.length, 0);
  });
}

test('source and auth accessors are rejected without invoking getters', async () => {
  for (const target of ['source', 'auth']) {
    const f = fixture(); let reads = 0;
    Object.defineProperty(f.input[target], target === 'source' ? 'originId' : 'authMutationId',
      {get() {reads += 1; throw new Error('must not read');}, enumerable: true});
    await assert.rejects(f.evaluate(), /local_control_/);
    assert.equal(reads, 0); assert.equal(f.calls.length, 0);
  }
});

for (const [name, mutate] of [
  ['not explicitly okay', response => {response.ok = 1;}],
  ['denial', response => {response.decision = 'deny';}],
  ['wrong reason', response => {response.reason = 'cloud_stop_allowed';}],
  ['wrong action', response => {response.action = 'stop_local_capture';}],
  ['wrong policy', response => {response.policyVersion = 'active-capture-stop-v1';}],
  ['missing binding ID', response => {delete response.authBindingId;}],
  ['invalid auth code ID', response => {response.authCodeId = 'local';}],
  ['wrong agent', response => {response.agentId = id(14);}],
  ['wrong tenant', response => {response.tenantId = id(14);}],
  ['invalid binding revision', response => {response.bindingRevision = digest('D');}],
  ['invalid authority revision', response => {response.authorityRevision = 'ok';}],
  ['different origin', response => {response.source.originId = id(15);}],
  ['different plan', response => {response.source.planFingerprint = digest('e');}],
  ['different platform', response => {response.source.platform = 'douyin';}],
  ['different source revision', response => {response.source.sourceRevision = digest('e');}],
  ['source omits request ID', response => {delete response.source.requestId;}],
  ['source includes cloud authority', response => {response.source.cloudAssigned = false;}],
  ['response includes raw credential', response => {response.token = 'private-server-secret';}],
  ['response symbol field', response => {response[Symbol('authority')] = true;}],
  ['inherited allow action', response => {const action = response.action; delete response.action; Object.setPrototypeOf(response, {action});}],
  ['noncanonical evaluation time', response => {response.evaluatedAt = '2026-09-07T10:00:00Z';}],
  ['invalid expiry time', response => {response.expiresAt = 'tomorrow';}],
  ['zero validity window', response => {response.expiresAt = response.evaluatedAt;}],
  ['reversed validity window', response => {response.expiresAt = new Date(NOW - 1).toISOString();}],
  ['window longer than five seconds', response => {response.expiresAt = new Date(NOW + 5001).toISOString();}],
  ['evaluation in the future', response => {response.evaluatedAt = new Date(NOW + 1).toISOString();}],
]) {
  test(`online malformed/mismatched decision is never authority: ${name}`, async () => {
    const f = fixture(); mutate(f.response);
    await assert.rejects(f.evaluate(), /local_control_authority_denied/);
    assert.equal(f.calls.length, 1); assert.equal(f.timers.size, 0);
  });
}

test('an online response accessor is rejected without invoking it or falling back', async () => {
  const f = fixture(); let reads = 0;
  Object.defineProperty(f.response, 'authCodeId', {get() {reads += 1;}, enumerable: true});
  await assert.rejects(f.evaluate(), /local_control_authority_denied/);
  assert.equal(reads, 0); assert.equal(f.calls.length, 1);
});

for (const key of api.BINDING_KEYS) {
  test(`a later action cannot cross its witnessed ${key}`, async () => {
    const f = fixture('recover_local_capture');
    f.response[key] = key === 'bindingRevision' ? digest('f') : id(20);
    await assert.rejects(f.evaluate(), /local_control_authority_denied/);
    assert.equal(f.calls.length, 1);
  });
}

test('first plan admission ignores obsolete local auth-code fields and returns only the current provider binding', async () => {
  const f = fixture(); f.input.auth.authCodeId = id(27); f.input.auth.authBindingId = id(28);
  const result = await f.evaluate();
  assert.equal(result.authority.authCodeId, f.binding.authCodeId);
  assert.equal(result.authority.authBindingId, f.binding.authBindingId);
  assert.equal(result.authority.bindingRevision, f.binding.bindingRevision);
});

test('an explicitly pinned first admission must also match that binding', async () => {
  const f = fixture(); f.input.expectedBinding = f.binding;
  f.response.authBindingId = id(30);
  await assert.rejects(f.evaluate(), /local_control_authority_denied/);
});

test('server expiry can shorten but never extend the local five-second deadline', async () => {
  const f = fixture(); f.response.expiresAt = new Date(NOW + 1250).toISOString();
  assert.equal((await f.evaluate()).deadline, NOW + 1250);
});

for (const [name, advance] of [['deadline reached', 5000], ['late response', 5001], ['clock moved backwards', -1]]) {
  test(`response is refused when ${name}`, async () => {
    const f = fixture(); f.onQuery = () => {f.advance(advance); return f.response;};
    await assert.rejects(f.evaluate(), /local_control_authority_denied/);
    assert.equal(f.calls.length, 1); assert.equal(f.timers.size, 0);
  });
}

test('timeout aborts the single online request at five seconds; a late allow cannot revive it', async () => {
  const f = fixture(), gate = deferred(); f.onQuery = () => gate.promise;
  const evaluating = f.evaluate(); await tick();
  assert.equal(f.calls.length, 1);
  assert.equal([...f.timers.values()][0].delay, 5000);
  f.advance(5000); f.expire();
  await assert.rejects(evaluating, /local_control_authority_expired/);
  assert.equal(f.calls[0].options.signal.aborted, true);
  assert.equal(f.timers.size, 0);
  gate.resolve(f.response); await tick();
  assert.equal(f.calls.length, 1); assert.equal(f.timers.size, 0);
});

test('query rejection has no retry, cached decision or fallback', async () => {
  const f = fixture(); f.onQuery = () => {throw new Error('synthetic offline');};
  await assert.rejects(f.evaluate(), /synthetic offline/);
  assert.equal(f.calls.length, 1); assert.equal(f.timers.size, 0);
});

test('caller mutation cannot retarget the captured request, and returned authority is a detached immutable receipt', async () => {
  const f = fixture('stop_local_capture'), gate = deferred(); f.onQuery = () => gate.promise;
  const evaluating = f.evaluate(); await tick();
  f.input.source.attemptId = id(40);
  f.input.auth.captureAgent.id = id(41);
  f.input.expectedBinding.authBindingId = id(42);
  gate.resolve(f.response);
  const result = await evaluating;
  assert.equal(result.authority.source.attemptId, id(7));
  assert.equal(result.authority.agentId, id(2));
  assert.equal(result.authority.authBindingId, id(4));
  f.response.source.attemptId = id(43);
  assert.equal(result.authority.source.attemptId, id(7));
  assert.equal(Object.isFrozen(f.calls[0].options.rawAuth), true);
  assert.equal(api.sourceMatches(result.authority.source, f.input.source), false,
    'the final writer must still compare current source/auth under its own fence');
});

test('canonical hash preserves values but not object-key insertion order', async () => {
  const left = {z: ['中', 2, null], a: {b: false, a: true}};
  const right = {a: {a: true, b: false}, z: ['中', 2, null]};
  assert.equal(api.canonical(left), api.canonical(right));
  assert.equal(await api.hash(left), createHash('sha256').update(api.canonical(left)).digest('hex'));
  assert.equal(await api.hash(left), await api.hash(right));
  assert.notEqual(await api.hash(left), await api.hash({...right, z: ['中', '2', null]}));
});

for (const [name, value] of [['undefined', undefined], ['non-finite', Infinity], ['sparse array', Array(2)],
  ['Date coercion', new Date(NOW)], ['function', () => true], ['BigInt', 1n]]) {
  test(`canonical/hash refuses ${name} instead of erasing/coercing evidence`, async () => {
    assert.throws(() => api.canonical(value), /local_control_invalid_json/);
    await assert.rejects(api.hash(value), /local_control_invalid_json/);
  });
}

test('canonical refuses cycles, symbol fields, and accessor fields without executing them', () => {
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => api.canonical(cycle), /local_control_invalid_json/);
  assert.throws(() => api.canonical({[Symbol('trust')]: true}), /local_control_invalid_json/);
  let reads = 0;
  assert.throws(() => api.canonical({get secret() {reads += 1; return 'not read';}}), /local_control_invalid_json/);
  assert.equal(reads, 0);
});

test('canonical does not invoke an inherited toStringTag getter', () => {
  let reads = 0;
  const prototype = Object.create(null, {[Symbol.toStringTag]: {get() {reads += 1; throw new Error('must not read');}}});
  const value = Object.assign(Object.create(prototype), {actual: 'data'});
  assert.equal(api.canonical(value), '{"actual":"data"}');
  assert.equal(reads, 0);
});

for (const value of [-1, 0.5, Infinity, NaN, 8640000000000000]) {
  test(`invalid local start clock ${String(value)} is rejected before query`, async () => {
    let calls = 0;
    const client = api.create({query: () => {calls += 1;}, now: () => value});
    await assert.rejects(client.evaluate(fixture().input), /local_control_clock_invalid/);
    assert.equal(calls, 0);
  });
}

test('actual read-only provider and client agree on all four actions and stable binding across plan/capture stages', async () => {
  const {evaluateLocalControlAuthority} = await import('../../server/services/capture-local-control-authority.js');
  const {hashCaptureAgentToken} = await import('../../server/services/capture-cloud.js');
  let admittedBinding = null, readCount = 0;
  for (const action of api.ACTIONS) {
    const f = fixture(action);
    if (action !== 'admit_local_plan') f.input.expectedBinding = admittedBinding;
    const identity = {tenant_id: f.binding.tenantId, agent_id: f.binding.agentId,
      auth_code_id: f.binding.authCodeId, auth_binding_id: f.binding.authBindingId,
      token_id: id(50), token_hash: hashCaptureAgentToken(f.input.auth.captureAgent.token),
      token_created_at: new Date(NOW - 1000).toISOString(), bound_at: new Date(NOW - 1000).toISOString(),
      expires_at: null, allowed_platforms: []};
    f.onQuery = (body, options) => evaluateLocalControlAuthority({token: options.rawAuth.captureAgent.token, body}, {
      now: () => NOW,
      readOne: async (_sql, params) => {
        readCount += 1;
        assert.equal(params[0], identity.token_hash);
        assert.equal(params[1], f.input.source.platform);
        return {evaluated_at: new Date(NOW), identity};
      },
    });
    const result = await f.evaluate();
    assert.equal(result.authority.action, action);
    assert.equal(api.sourceMatches(result.authority.source, f.input.source), true);
    const binding = Object.fromEntries(api.BINDING_KEYS.map(key => [key, result.authority[key]]));
    if (admittedBinding) assert.deepEqual(binding, admittedBinding);
    else admittedBinding = binding;
  }
  assert.equal(readCount, 4, 'only four injected memory reads; no real query/DB/network fallback');
});
