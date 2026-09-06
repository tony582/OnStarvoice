import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateAccessPolicy } from '../../extension-ui/domain/access-policy.mjs';

const SCOPE = Object.freeze({ tenantId: 'synthetic-tenant', taskId: 'synthetic-task', executionId: 'synthetic-execution' });
const NOW = 1000;

function request(overrides = {}) {
  return { principalId: 'principal-1', sessionId: 'session-1', scope: { ...SCOPE }, snapshotId: 'snapshot-1', recordNamespace: 'client_record', ...overrides };
}

function facts(overrides = {}) {
  return {
    ...request(), accessRevision: 'access-1', identityStatus: 'active', tenantStatus: 'active', membershipStatus: 'active', deviceStatus: 'active',
    licenseStatus: 'active', licenseExpiresAt: 4000, sessionExpiresAt: 10000, evidenceExpiresAt: 8000,
    historyReadAllowed: true, captureAllowed: true, ...overrides,
  };
}

function freezeTree(value) {
  if (!value || typeof value !== 'object') return value;
  for (const child of Object.values(value)) freezeTree(child);
  return Object.freeze(value);
}

function assertFrozen(value) {
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.history), true);
  assert.equal(Object.isFrozen(value.capture), true);
}

function blocked(input, target, now) {
  const result = evaluateAccessPolicy(input, arguments.length < 2 ? request() : target, arguments.length < 3 ? NOW : now);
  assert.deepEqual(result, {
    state: 'blocked',
    history: { allowed: false, reason: 'access_unavailable', expiresAt: null },
    capture: { allowed: false, reason: 'access_unavailable', expiresAt: null },
  });
  assertFrozen(result);
  return result;
}

test('active identity with explicit permissions separates history and capture expiry', () => {
  const result = evaluateAccessPolicy(facts(), request(), NOW);
  assert.deepEqual(result, {
    state: 'active',
    history: { allowed: true, reason: 'allowed', expiresAt: 8000 },
    capture: { allowed: true, reason: 'allowed', expiresAt: 4000 },
  });
  assertFrozen(result);
});

for (const namespace of ['client_record', 'server_record']) {
  test(`explicit ${namespace} namespace can be authorized without remapping identifiers`, () => {
    const result = evaluateAccessPolicy(facts({ recordNamespace: namespace }), request({ recordNamespace: namespace }), NOW);
    assert.equal(result.history.allowed, true);
    assert.equal(result.capture.allowed, true);
  });
}

for (const [status, expiry] of [['active', 1000], ['active', 999], ['expired', 1000], ['expired', 0]]) {
  test(`${status} license at ${expiry} leaves permitted history readable but never new capture`, () => {
    const result = evaluateAccessPolicy(facts({ licenseStatus: status, licenseExpiresAt: expiry }), request(), NOW);
    assert.deepEqual(result, {
      state: 'expired',
      history: { allowed: true, reason: 'allowed', expiresAt: 8000 },
      capture: { allowed: false, reason: 'license_expired', expiresAt: null },
    });
    assertFrozen(result);
  });
}

test('expired license with a future expiration is contradictory and blocks both capabilities', () => {
  blocked(facts({ licenseStatus: 'expired', licenseExpiresAt: NOW + 1 }));
});

for (const licenseStatus of ['frozen', 'revoked']) {
  for (const licenseExpiresAt of [0, 999, 1000, 4000]) {
    test(`${licenseStatus} license blocks history and capture regardless of expiry ${licenseExpiresAt}`, () => {
      blocked(facts({ licenseStatus, licenseExpiresAt }));
    });
  }
}

for (const historyReadAllowed of [false, true]) {
  for (const captureAllowed of [false, true]) {
    test(`active history=${historyReadAllowed} and capture=${captureAllowed} are independent explicit permissions`, () => {
      const result = evaluateAccessPolicy(facts({ historyReadAllowed, captureAllowed }), request(), NOW);
      assert.equal(result.state, 'active');
      assert.deepEqual(result.history, { allowed: historyReadAllowed, reason: historyReadAllowed ? 'allowed' : 'not_permitted', expiresAt: historyReadAllowed ? 8000 : null });
      assert.deepEqual(result.capture, { allowed: captureAllowed, reason: captureAllowed ? 'allowed' : 'not_permitted', expiresAt: captureAllowed ? 4000 : null });
    });
    test(`expired history=${historyReadAllowed} capture=${captureAllowed} never restores collection`, () => {
      const result = evaluateAccessPolicy(facts({ historyReadAllowed, captureAllowed, licenseStatus: 'expired', licenseExpiresAt: 999 }), request(), NOW);
      assert.equal(result.state, 'expired');
      assert.deepEqual(result.history, { allowed: historyReadAllowed, reason: historyReadAllowed ? 'allowed' : 'not_permitted', expiresAt: historyReadAllowed ? 8000 : null });
      assert.deepEqual(result.capture, { allowed: false, reason: 'license_expired', expiresAt: null });
    });
  }
}

for (const field of ['identityStatus', 'tenantStatus', 'membershipStatus', 'deviceStatus']) {
  for (const status of ['expired', 'frozen', 'revoked', 'unknown', '', true, null, undefined]) {
    test(`${field}=${String(status)} cannot receive the expired-license history exception`, () => {
      blocked(facts({ [field]: status, licenseStatus: 'expired', licenseExpiresAt: 999 }));
    });
  }
}

for (const field of ['licenseExpiresAt', 'sessionExpiresAt', 'evidenceExpiresAt']) {
  for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '4000', true, null, undefined]) {
    test(`${field} rejects non-safe timestamp ${String(value)}`, () => blocked(facts({ [field]: value })));
  }
}

for (const field of ['sessionExpiresAt', 'evidenceExpiresAt']) {
  for (const value of [0, NOW - 1, NOW]) {
    test(`${field} at ${value} is no longer fresh`, () => blocked(facts({ [field]: value })));
  }
  test(`${field} bounds history independently of the business license`, () => {
    const result = evaluateAccessPolicy(facts({ [field]: 2000, licenseExpiresAt: 3000 }), request(), NOW);
    assert.equal(result.history.expiresAt, 2000);
    assert.equal(result.capture.expiresAt, 2000);
  });
}

for (const now of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1000', null, undefined, () => NOW]) {
  test(`invalid current time ${String(now)} blocks without throwing`, () => blocked(facts(), request(), now));
}

test('zero is a valid current time when every required authorization fact is still fresh', () => {
  const result = evaluateAccessPolicy(facts(), request(), 0);
  assert.equal(result.state, 'active');
  assert.equal(result.history.allowed, true);
});

for (const field of ['principalId', 'sessionId', 'snapshotId', 'recordNamespace']) {
  test(`a mismatched ${field} blocks both capabilities`, () => {
    blocked(facts({ [field]: field === 'recordNamespace' ? 'server_record' : `foreign-${field}` }));
  });
}

for (const field of Object.keys(SCOPE)) {
  test(`a mismatched ${field} blocks both capabilities`, () => blocked(facts({ scope: { ...SCOPE, [field]: `foreign-${field}` } })));
}

const BAD_IDS = ['', ' leading', 'trailing ', 'two words', 'x\u0000y', 'x\u0085y', 'x\u200Fy', 'x\u2066y', '\uD800', '\uDFFF', 'x'.repeat(241), 1, {}, null, undefined];
for (const field of ['principalId', 'sessionId', 'snapshotId', 'accessRevision']) {
  test(`${field} is an exact identity and cannot be normalized or coerced`, () => {
    for (const value of BAD_IDS) {
      const target = field === 'accessRevision' ? request() : request({ [field]: value });
      blocked(facts({ [field]: value }), target);
    }
  });
}
for (const field of Object.keys(SCOPE)) {
  test(`${field} cannot match by trimming, truncation, or coercion`, () => {
    for (const value of BAD_IDS) {
      const scope = { ...SCOPE, [field]: value };
      blocked(facts({ scope }), request({ scope }));
    }
  });
}

test('exact 240-character identities and paired emoji are preserved as valid bindings', () => {
  for (const id of ['a'.repeat(240), 'synthetic-🧭']) {
    const target = request({ principalId: id, sessionId: id, snapshotId: id, scope: { tenantId: id, taskId: id, executionId: id } });
    const result = evaluateAccessPolicy(facts({ ...target, accessRevision: id }), target, NOW);
    assert.equal(result.history.allowed, true);
  }
});

for (const field of ['historyReadAllowed', 'captureAllowed']) {
  test(`${field} requires an explicit boolean, not truthiness`, () => {
    for (const value of [undefined, null, 0, 1, '', 'false', 'true', {}, []]) blocked(facts({ [field]: value }));
  });
}

test('unknown license states and namespaces fail closed', () => {
  for (const value of [undefined, null, true, '', 'ACTIVE', 'trial', 'suspended', 'active ']) blocked(facts({ licenseStatus: value }));
  for (const value of [undefined, null, true, '', 'record', 'client_record ', 'clientRecord']) blocked(facts({ recordNamespace: value }), request({ recordNamespace: value }));
});

for (const subject of ['facts', 'request']) {
  for (const field of subject === 'facts' ? Object.keys(facts()) : Object.keys(request())) {
    test(`${subject}.${field} must be an own data field, not inherited or an accessor`, () => {
      for (const mode of ['missing', 'inherited', 'getter']) {
        const input = facts();
        const target = request();
        const object = subject === 'facts' ? input : target;
        const original = object[field];
        delete object[field];
        let reads = 0;
        if (mode === 'inherited') Object.setPrototypeOf(object, { [field]: original });
        if (mode === 'getter') Object.defineProperty(object, field, { enumerable: true, get() { reads++; throw new Error('private getter'); } });
        blocked(input, target);
        assert.equal(reads, 0);
      }
    });
  }
}

for (const subject of ['facts', 'request']) {
  for (const field of Object.keys(SCOPE)) {
    test(`${subject}.scope.${field} rejects inherited values and getters without invoking them`, () => {
      for (const mode of ['inherited', 'getter']) {
        const input = facts();
        const target = request();
        const scope = subject === 'facts' ? input.scope : target.scope;
        const original = scope[field];
        delete scope[field];
        let reads = 0;
        if (mode === 'inherited') Object.setPrototypeOf(scope, { [field]: original });
        else Object.defineProperty(scope, field, { get() { reads++; return original; } });
        blocked(input, target);
        assert.equal(reads, 0);
      }
    });
  }
}

test('malformed containers and hostile descriptor traps are converted to a redacted blocked result', () => {
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('private token'); } });
  const { proxy: revoked, revoke } = Proxy.revocable({}, {});
  revoke();
  for (const value of [undefined, null, false, 1, 'facts', [], () => {}, proxy, revoked]) {
    blocked(value);
    blocked(facts(), value);
    blocked(facts({ scope: value }));
    blocked(facts(), request({ scope: value }));
  }
});

test('policy is a pure frozen projection and never reads or returns unrelated secrets', () => {
  const input = facts({ privateToken: 'secret-token', rawRecord: { body: 'private body' } });
  const target = request();
  let reads = 0;
  Object.defineProperty(input, 'credentials', { get() { reads++; throw new Error('secret'); } });
  Object.defineProperty(target, 'credentials', { get() { reads++; throw new Error('secret'); } });
  freezeTree(input);
  freezeTree(target);
  const result = evaluateAccessPolicy(input, target, NOW);
  assert.equal(result.state, 'active');
  assertFrozen(result);
  assert.equal(reads, 0);
  assert.deepEqual(Object.keys(result).sort(), ['capture', 'history', 'state']);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(JSON.stringify(result).includes('principal-1'), false);
  assert.equal(JSON.stringify(result).includes('synthetic-tenant'), false);
  assert.equal(input.rawRecord.body, 'private body');
});

test('evaluating mutable inputs neither freezes them nor caches an earlier permission', () => {
  const input = facts();
  const target = request();
  const before = structuredClone(input);
  const result = evaluateAccessPolicy(input, target, NOW);
  assert.deepEqual(input, before);
  assert.equal(Object.isFrozen(input), false);
  assert.equal(Object.isFrozen(input.scope), false);
  assert.equal(Object.isFrozen(target), false);
  input.licenseStatus = 'revoked';
  blocked(input, target);
  assert.equal(result.history.allowed, true);
});
