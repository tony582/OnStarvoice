import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {createCaptureLocalControlAuthorityRouter} from '../server/routes/capture-local-control-authority.js';
import {evaluateLocalControlAuthority, validateLocalControlRequest, LOCAL_CONTROL_ACTIONS,
  LOCAL_CONTROL_POLICY_VERSION, LOCAL_CONTROL_WINDOW_MS, LOCAL_CONTROL_AUTHORITY_SQL,
} from '../server/services/capture-local-control-authority.js';
import {hashCaptureAgentToken} from '../server/services/capture-cloud.js';

const NOW = Date.parse('2026-09-07T03:00:00.000Z');
const AT = new Date(NOW - 1000).toISOString();
const TOKEN = 'synthetic-local-control-token';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const clone = value => JSON.parse(JSON.stringify(value));
function fixture(action = 'recover_local_capture', platform = 'xiaohongshu') {
  return {body: {action, source: {originId: id(1), planFingerprint: 'a'.repeat(64), platform,
    requestId: action === 'admit_local_plan' ? '' : id(2),
    attemptId: action === 'admit_local_plan' ? '' : id(3),
    generation: action === 'admit_local_plan' ? 0 : 1, sourceRevision: 'b'.repeat(64)}},
  row: {evaluated_at: new Date(NOW), identity: {tenant_id: id(4), agent_id: id(5), auth_code_id: id(6),
    auth_binding_id: id(7), token_id: id(8), token_hash: hashCaptureAgentToken(TOKEN),
    token_created_at: AT, bound_at: AT, expires_at: null, allowed_platforms: []}}};
}
async function evaluate(f, options = {}) {
  const calls = [];
  const result = await evaluateLocalControlAuthority({token: TOKEN, body: f.body}, {
    now: () => NOW, readOne: async (sql, params) => {
      calls.push({sql, params}); return clone(f.row);
    }, ...options,
  });
  return {result, calls};
}

for (const action of LOCAL_CONTROL_ACTIONS) for (const platform of ['xiaohongshu', 'douyin']) {
  test(`current entitlement permits only the exact requested local action/source: ${action}/${platform}`, async () => {
    const f = fixture(action, platform), before = clone(f);
    const {result, calls} = await evaluate(f);
    assert.equal(validateLocalControlRequest(f.body), true);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.decision, 'allow');
    assert.equal(result.reason, 'local_control_authorized');
    assert.equal(result.action, action);
    assert.equal(result.policyVersion, LOCAL_CONTROL_POLICY_VERSION);
    assert.equal(result.tenantId, id(4));
    assert.equal(result.agentId, id(5));
    assert.equal(result.authCodeId, id(6));
    assert.equal(result.authBindingId, id(7));
    assert.deepEqual(result.source, f.body.source);
    assert.equal(result.evaluatedAt, new Date(NOW).toISOString());
    assert.equal(result.expiresAt, new Date(NOW + 5000).toISOString());
    assert.match(result.bindingRevision, /^[a-f0-9]{64}$/u);
    assert.match(result.authorityRevision, /^[a-f0-9]{64}$/u);
    assert.deepEqual(Object.keys(result).sort(), ['ok', 'action', 'decision', 'reason', 'policyVersion',
      'bindingRevision', 'authorityRevision', 'tenantId', 'agentId', 'authCodeId', 'authBindingId',
      'source', 'evaluatedAt', 'expiresAt'].sort());
    assert.deepEqual(calls, [{sql: LOCAL_CONTROL_AUTHORITY_SQL, params: [hashCaptureAgentToken(TOKEN), platform]}]);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-local-control-token|token_hash|tokenId|tokenHash|token_created_at|bound_at|allowed_platforms|serverTaskId|successorAllowed/u);
    assert.deepEqual(clone(f), before);
    result.source.generation = 77;
    assert.deepEqual(clone(f), before, 'returned source is detached from input');
  });
}

test('SQL reads only existing current entitlement/binding tables, never task origin or resume permissions', () => {
  assert.equal(LOCAL_CONTROL_WINDOW_MS, 5000);
  assert.doesNotMatch(LOCAL_CONTROL_AUTHORITY_SQL, /\b(?:INSERT|UPDATE|DELETE|CALL|LOCK|pg_advisory|FOR\s+UPDATE|heartbeat|last_seen_at|capture_tasks|capture_agent_commands|capture_task_attempts)\b/iu);
  assert.doesNotMatch(LOCAL_CONTROL_AUTHORITY_SQL, /updated_at|touch|verify/iu);
  assert.equal(LOCAL_CONTROL_AUTHORITY_SQL.includes(';'), false);
  for (const fragment of ['cat.revoked_at IS NULL', "ca.status = 'active'", "tenant.status = 'active'",
    'ca.auth_code_id = cat.auth_code_id', 'ca.auth_binding_id = cat.auth_binding_id',
    'ac.tenant_id = ca.tenant_id', "ac.status = 'active'", 'ac.expires_at > statement_timestamp()',
    'ab.id = ca.auth_binding_id AND ab.code_id = ac.id', 'cat.token_hash = $1',
    'cardinality(ca.allowed_platforms) = 0 OR $2 = ANY(ca.allowed_platforms)', 'statement_timestamp() AS evaluated_at']) {
    assert.ok(LOCAL_CONTROL_AUTHORITY_SQL.includes(fragment), fragment);
  }
});

for (const [name, mutate] of Object.entries({
  'old active stop': f => {f.body.action = 'stop_active_capture';},
  'terminal dismissal': f => {f.body.action = 'dismiss_terminal_recovery_metadata';},
  'cloud resume': f => {f.body.action = 'resume';},
  'history read': f => {f.body.action = 'read_history';},
  'missing action': f => {delete f.body.action;},
  'inherited action': f => {f.body = Object.assign(Object.create({action: f.body.action}), {source: f.body.source});},
  'extra caller permission': f => {f.body.allowed = true;},
  'caller identity': f => {f.body.tenantId = id(4);},
  'missing source': f => {delete f.body.source;},
  'array source': f => {f.body.source = [];},
  'extra source provenance': f => {f.body.source.cloudAssigned = false;},
  'missing source revision': f => {delete f.body.source.sourceRevision;},
  'nonUUID origin': f => {f.body.source.originId = 'legacy-local-plan';},
  'coercible origin': f => {f.body.source.originId = {toString: () => id(1)};},
  'uppercase UUID': f => {f.body.source.originId = 'aaaaaaaa-AAAA-4000-8000-000000000001';},
  'invalid UUID variant': f => {f.body.source.originId = 'aaaaaaaa-aaaa-4000-0000-000000000001';},
  'short plan fingerprint': f => {f.body.source.planFingerprint = 'a'.repeat(63);},
  'uppercase source revision': f => {f.body.source.sourceRevision = 'B'.repeat(64);},
  'coercible fingerprint': f => {f.body.source.planFingerprint = {toString: () => 'a'.repeat(64)};},
  'unknown platform': f => {f.body.source.platform = 'weibo';},
  'shorthand platform': f => {f.body.source.platform = 'xhs';},
  'zero capture generation': f => {f.body.source.generation = 0;},
  'negative capture generation': f => {f.body.source.generation = -1;},
  'string generation': f => {f.body.source.generation = '1';},
  'fractional generation': f => {f.body.source.generation = 1.5;},
  'unsafe generation': f => {f.body.source.generation = Number.MAX_SAFE_INTEGER + 1;},
  'empty capture request': f => {f.body.source.requestId = '';},
  'empty capture attempt': f => {f.body.source.attemptId = '';},
  'plan with runtime request': f => {f.body = fixture('admit_local_plan').body; f.body.source.requestId = id(2);},
  'plan with runtime attempt': f => {f.body = fixture('admit_local_plan').body; f.body.source.attemptId = id(3);},
  'plan with nonzero generation': f => {f.body = fixture('admit_local_plan').body; f.body.source.generation = 1;},
  'plan null runtime id': f => {f.body = fixture('admit_local_plan').body; f.body.source.requestId = null;},
  'accessor source': f => {Object.defineProperty(f.body.source, 'originId', {get() {throw new Error('must not invoke');}});},
  'accessor body': f => {Object.defineProperty(f.body, 'action', {get() {throw new Error('must not invoke');}});},
  'source symbol': f => {f.body.source[Symbol('allow')] = true;},
  'body symbol': f => {f.body[Symbol('allow')] = true;},
})) test(`malformed or cross-policy input denied before query: ${name}`, async () => {
  const f = fixture(); mutate(f);
  const {result, calls} = await evaluate(f);
  assert.equal(validateLocalControlRequest(f.body), false);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_control_target');
  assert.equal(calls.length, 0);
  assert.deepEqual(Object.keys(result).sort(), ['ok', 'action', 'decision', 'reason', 'policyVersion'].sort());
});

for (const token of ['', 'a'.repeat(513), 'two words', '\nsecret', 'secret\u0000', null, 123, {}]) {
  test(`invalid token makes no query: ${JSON.stringify(token).slice(0, 24)}`, async () => {
    let reads = 0;
    const result = await evaluateLocalControlAuthority({token, body: fixture().body}, {
      readOne: async () => {reads++; throw new Error('must not query');},
    });
    assert.equal(result.reason, 'invalid_agent_token');
    assert.equal(result.action, 'recover_local_capture');
    assert.equal(reads, 0);
  });
}

for (const [name, mutate] of Object.entries({
  // SQL applies the status/join restrictions; the offline adapter models the
  // absent identity, without claiming real PostgreSQL execution of the query.
  'revoked token/current binding missing': f => {f.row.identity = null;},
  'missing row': f => {f.row = null;},
  'malformed tenant': f => {f.row.identity.tenant_id = '';},
  'missing Agent': f => {delete f.row.identity.agent_id;},
  'missing auth code': f => {f.row.identity.auth_code_id = null;},
  'missing binding': f => {f.row.identity.auth_binding_id = null;},
  'missing token id': f => {f.row.identity.token_id = null;},
  'different credential hash': f => {f.row.identity.token_hash = 'c'.repeat(64);},
  'missing binding timestamp': f => {delete f.row.identity.bound_at;},
  'malformed token timestamp': f => {f.row.identity.token_created_at = 'tomorrow';},
  'malformed expiry': f => {f.row.identity.expires_at = false;},
  'missing expiry': f => {delete f.row.identity.expires_at;},
  'missing platform scope': f => {delete f.row.identity.allowed_platforms;},
  'wrong platform scope': f => {f.row.identity.allowed_platforms = ['douyin'];},
  'malformed platform scope': f => {f.row.identity.allowed_platforms = [null];},
})) test(`unavailable current entitlement is denied: ${name}`, async () => {
  const f = fixture(); mutate(f);
  const {result, calls} = await evaluate(f);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'agent_entitlement_unavailable');
  assert.equal(result.action, 'recover_local_capture');
  assert.equal(calls.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /tenantId|bindingRevision|authorityRevision|source|tokenHash/u);
});

test('binding revision is stable across actions, source, time, heartbeat and scope ordering', async () => {
  const f = fixture();
  f.row.identity.allowed_platforms = ['douyin', 'xiaohongshu'];
  const first = (await evaluate(f)).result;
  for (const action of LOCAL_CONTROL_ACTIONS) {
    const next = fixture(action);
    next.body.source.originId = id(9); next.body.source.sourceRevision = 'c'.repeat(64);
    next.row.identity.allowed_platforms = ['xiaohongshu', 'douyin', 'douyin'];
    next.row.identity.agent_updated_at = new Date(NOW + 1).toISOString();
    next.row.identity.last_heartbeat_at = new Date(NOW + 1).toISOString();
    next.row.identity.last_seen_at = new Date(NOW + 1).toISOString();
    next.row.evaluated_at = new Date(NOW + 1);
    const result = (await evaluate(next, {now: () => NOW + 1})).result;
    assert.equal(result.ok, true);
    assert.equal(result.bindingRevision, first.bindingRevision, action);
    assert.notEqual(result.authorityRevision, first.authorityRevision, action);
  }
});

for (const [name, mutate] of Object.entries({
  tenant: value => {value.tenant_id = id(9);},
  Agent: value => {value.agent_id = id(9);},
  'auth code': value => {value.auth_code_id = id(9);},
  'auth binding': value => {value.auth_binding_id = id(9);},
  'token row': value => {value.token_id = id(9);},
  'token creation': value => {value.token_created_at = new Date(NOW - 500).toISOString();},
  'bound timestamp': value => {value.bound_at = new Date(NOW - 500).toISOString();},
  expiry: value => {value.expires_at = new Date(NOW + 10000).toISOString();},
  'platform restriction': value => {value.allowed_platforms = ['xiaohongshu'];},
})) test(`current binding/credential change rotates fence: ${name}`, async () => {
  const f = fixture();
  const first = (await evaluate(f)).result;
  mutate(f.row.identity);
  const next = (await evaluate(f)).result;
  assert.equal(next.ok, true);
  assert.notEqual(next.bindingRevision, first.bindingRevision);
  assert.notEqual(next.authorityRevision, first.authorityRevision);
  // A newly effective binding may obtain entitlement; the client must reject
  // an old production-origin witness, never treat this echo as adoption.
});

test('source is captured before awaiting the entitlement read', async () => {
  const f = fixture(), original = clone(f.body);
  const {result} = await evaluate(f, {readOne: async () => {
    f.body.action = 'start_local_capture';
    f.body.source.requestId = id(19); f.body.source.sourceRevision = 'c'.repeat(64);
    return clone(f.row);
  }});
  assert.equal(result.ok, true);
  assert.equal(result.action, original.action);
  assert.deepEqual(result.source, original.source);
});

test('each action and source field changes authority without changing the binding fence', async () => {
  const first = (await evaluate(fixture())).result;
  for (const action of ['start_local_capture', 'stop_local_capture']) {
    const f = fixture(action), result = (await evaluate(f)).result;
    assert.equal(result.ok, true);
    assert.equal(result.bindingRevision, first.bindingRevision);
    assert.notEqual(result.authorityRevision, first.authorityRevision);
  }
  for (const [key, value] of Object.entries({originId: id(9), planFingerprint: 'c'.repeat(64),
    platform: 'douyin', requestId: id(9), attemptId: id(9), generation: 2, sourceRevision: 'c'.repeat(64)})) {
    const f = fixture(); f.body.source[key] = value;
    const result = (await evaluate(f)).result;
    assert.equal(result.ok, true, key);
    assert.equal(result.bindingRevision, first.bindingRevision, key);
    assert.notEqual(result.authorityRevision, first.authorityRevision, key);
  }
});

test('every call re-reads entitlement; revocation or old-token rebinding cannot use a cached allow', async () => {
  const f = fixture();
  let reads = 0;
  const readOne = async () => {reads++; return clone(f.row);};
  const first = (await evaluate(f, {readOne})).result;
  assert.equal(first.ok, true);
  f.row.identity = null;
  const revoked = (await evaluate(f, {readOne})).result;
  assert.equal(revoked.ok, false);
  assert.equal(revoked.reason, 'agent_entitlement_unavailable');
  f.row.identity = fixture().row.identity;
  f.row.identity.auth_binding_id = id(19);
  const rebound = (await evaluate(f, {readOne})).result;
  assert.equal(rebound.ok, true);
  assert.notEqual(rebound.bindingRevision, first.bindingRevision);
  assert.equal(reads, 3);
});

test('a valid replacement credential rotates the binding fence without exposing its token', async () => {
  const f = fixture(), first = (await evaluate(f)).result;
  const token = 'synthetic-replacement-local-token';
  f.row.identity.token_id = id(19);
  f.row.identity.token_hash = hashCaptureAgentToken(token);
  const result = await evaluateLocalControlAuthority({token, body: f.body}, {
    now: () => NOW, readOne: async (sql, params) => {
      assert.deepEqual(params, [hashCaptureAgentToken(token), f.body.source.platform]);
      return clone(f.row);
    },
  });
  assert.equal(result.ok, true);
  assert.notEqual(result.bindingRevision, first.bindingRevision);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-replacement-local-token|token_hash/u);
});

test('entitlement expiry, query latency, statement age, and backwards/future clocks cannot renew authority', async () => {
  const f = fixture();
  f.row.identity.expires_at = new Date(NOW + 800).toISOString();
  assert.equal((await evaluate(f)).result.expiresAt, f.row.identity.expires_at);
  let ticks = [NOW, NOW + 800];
  assert.equal((await evaluate(f, {now: () => ticks.shift()})).result.reason, 'authority_expired');
  for (const offset of [0, -1, -1000]) {
    f.row.identity.expires_at = new Date(NOW + offset).toISOString();
    assert.equal((await evaluate(f)).result.reason, 'authority_expired');
  }
  f.row.identity.expires_at = null;
  ticks = [NOW, NOW + 5000];
  assert.equal((await evaluate(f, {now: () => ticks.shift()})).result.reason, 'authority_expired');
  ticks = [NOW, NOW - 1];
  assert.equal((await evaluate(f, {now: () => ticks.shift()})).result.reason, 'authority_expired');
  for (const timestamp of [new Date(NOW + 1), new Date(NOW - 5000), 'bad', null]) {
    f.row.evaluated_at = timestamp;
    assert.equal((await evaluate(f)).result.reason, 'authority_expired');
  }
  f.row.evaluated_at = new Date(NOW);
  f.row.identity.token_created_at = new Date(NOW + 1).toISOString();
  assert.equal((await evaluate(f)).result.reason, 'authority_expired');
  f.row.identity.token_created_at = AT;
  f.row.identity.bound_at = new Date(NOW + 1).toISOString();
  assert.equal((await evaluate(f)).result.reason, 'authority_expired');
});

for (const value of [NaN, Infinity, -1, '0', Number.MAX_SAFE_INTEGER]) {
  test(`invalid local clock rejected before SELECT: ${String(value)}`, async () => {
    const {result, calls} = await evaluate(fixture(), {now: () => value});
    assert.equal(result.reason, 'authority_expired');
    assert.equal(calls.length, 0);
  });
}

// Actual Express Router matching and handler chain, with synthetic req/res and
// injected readOne. No listening socket, HTTP request, real auth API or DB.
function dispatch(router, {body, headers = {authorization: `Bearer ${TOKEN}`},
  method = 'POST', path = '/agent/local-control-authority'} = {}) {
  return new Promise((resolve, reject) => {
    const result = {status: 200, headers: {}, body: null};
    const req = {method, url: path, originalUrl: path, headers, body};
    const res = {
      set(name, value) {result.headers[name.toLowerCase()] = value; return this;},
      status(status) {result.status = status; return this;},
      json(value) {result.body = value; resolve(result); return this;},
    };
    router.handle(req, res, error => error ? reject(error) : resolve({...result, status: 404}));
  });
}

test('real offline Router enforces exact path/action/status, no-store, both token transports and error propagation', async () => {
  const f = fixture(), calls = [];
  let queryFailure = false;
  const router = createCaptureLocalControlAuthorityRouter({evaluate: args => {
    calls.push(args);
    return evaluateLocalControlAuthority(args, {now: () => NOW, readOne: async () => {
      if (queryFailure) throw new Error('synthetic query failure');
      return clone(f.row);
    }});
  }});
  const allowed = await dispatch(router, {body: f.body});
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers['cache-control'], 'no-store');
  assert.equal(allowed.headers.pragma, 'no-cache');
  assert.equal(allowed.body.action, 'recover_local_capture');
  assert.equal(calls[0].token, TOKEN);
  assert.equal((await dispatch(router, {body: f.body, headers: {'x-capture-agent-token': TOKEN}})).status, 200);
  for (const action of ['resume', 'stop_active_capture', 'dismiss_terminal_recovery_metadata']) {
    const denied = await dispatch(router, {body: {...f.body, action}});
    assert.equal(denied.status, 400);
    assert.equal(denied.headers['cache-control'], 'no-store');
    assert.equal(denied.body.decision, 'deny');
  }
  assert.equal((await dispatch(router, {body: f.body, headers: {}})).status, 403);
  const identity = f.row.identity;
  f.row.identity = null;
  assert.equal((await dispatch(router, {body: f.body})).status, 403);
  f.row.identity = identity;
  f.row.identity.expires_at = new Date(NOW).toISOString();
  assert.equal((await dispatch(router, {body: f.body})).status, 409);
  f.row.identity.expires_at = null;
  for (const path of ['/agent/stop-authority', '/agent/control-authority', '/tasks/id/resume']) {
    assert.equal((await dispatch(router, {body: f.body, path})).status, 404);
  }
  assert.equal((await dispatch(router, {body: f.body, method: 'GET'})).status, 404);
  queryFailure = true;
  await assert.rejects(dispatch(router, {body: f.body}), /synthetic query failure/u);
});

test('app registers only the independent local authority router beside the unchanged policies', () => {
  const app = readFileSync(new URL('../server/app.js', import.meta.url), 'utf8');
  assert.equal((app.match(/app\.use\('\/api\/capture-cloud', captureLocalControlAuthorityRouter\)/gu) || []).length, 1);
  assert.ok(app.indexOf("app.use('/api/capture-cloud', captureLocalControlAuthorityRouter)") <
    app.indexOf("app.use('/api/capture-cloud', captureCloudRouter)"));
});
