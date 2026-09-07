import assert from 'node:assert/strict';
import {randomUUID, webcrypto} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import express from '../../../server/node_modules/express/index.js';
import {validatePostgresIntegrationTarget, isAllowedPostgresIntegrationServerAddress}
  from '../../../scripts/lib/postgres-integration-target.mjs';
import {getPool, closePool} from '../../../server/db/pool.js';
import {hashCaptureAgentToken} from '../../../server/services/capture-cloud.js';
import {evaluateLocalControlAuthority, LOCAL_CONTROL_ACTIONS, LOCAL_CONTROL_POLICY_VERSION,
  LOCAL_CONTROL_WINDOW_MS, LOCAL_CONTROL_AUTHORITY_SQL} from '../../../server/services/capture-local-control-authority.js';
import {createCaptureLocalControlAuthorityRouter} from '../../../server/routes/capture-local-control-authority.js';

const clone = value => JSON.parse(JSON.stringify(value));
const bindingKeys = ['tenantId', 'agentId', 'authCodeId', 'authBindingId', 'bindingRevision'];
const bindingOf = value => Object.fromEntries(bindingKeys.map(key => [key, value[key]]));
const responseKeys = ['ok', 'action', 'decision', 'reason', 'policyVersion', 'bindingRevision',
  'authorityRevision', 'tenantId', 'agentId', 'authCodeId', 'authBindingId', 'source', 'evaluatedAt', 'expiresAt'];

function extensionBoundary() {
  const context = vm.createContext({TextEncoder, AbortController, crypto: webcrypto, setTimeout, clearTimeout});
  for (const file of ['utils/control/local-capture-authority.js', 'utils/control/local-capture-source.js']) {
    vm.runInContext(readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8'), context, {filename: file});
  }
  return {authority: context.OnStarvoiceLocalCaptureAuthority, source: context.OnStarvoiceLocalCaptureSource};
}

// This file never creates, migrates or resets a database. Both environment URLs
// must explicitly select the already prepared, authorized local integration DB.
// Fixture writes are confined to two newly generated synthetic tenant IDs. Every
// real authority SELECT executes in a PostgreSQL READ ONLY transaction; only a
// loopback HTTP Router is started, without the server, Cron, dispatch or browser.
test('local control authority observes real current PostgreSQL identity without adopting or mutating work', {timeout: 60000}, async t => {
  const target = validatePostgresIntegrationTarget({testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true});
  const ids = Object.fromEntries(['tenant', 'agent', 'code', 'binding', 'token', 'newBinding',
    'reboundToken', 'replacementToken', 'otherTenant', 'otherAgent', 'otherCode', 'otherBinding',
    'otherToken', 'origin', 'request', 'attempt'].map(key => [key, randomUUID()]));
  const names = new Map([[ids.tenant, `local-control-authority-${ids.tenant}`],
    [ids.otherTenant, `local-control-authority-${ids.otherTenant}`]]);
  const tokens = {original: `isolated-local-control-${randomUUID()}`,
    rebound: `isolated-local-rebound-${randomUUID()}`,
    replacement: `isolated-local-replacement-${randomUUID()}`,
    other: `isolated-local-other-${randomUUID()}`};
  let client, server, seeded = false, clock = null;
  const pool = getPool();
  t.after(async () => {
    const errors = [];
    const attempt = async callback => {try {await callback();} catch (error) {errors.push(error);}};
    if (server) await attempt(() => new Promise((resolve, reject) => {
      server.closeAllConnections?.(); server.close(error => error ? reject(error) : resolve());
    }));
    if (client) {
      await attempt(() => client.query('ROLLBACK'));
      if (seeded) for (const [id, name] of names) {
        await attempt(() => client.query('DELETE FROM tenants WHERE id=$1 AND name=$2', [id, name]));
      }
      client.release();
    }
    await attempt(closePool);
    if (errors.length) throw new AggregateError(errors, 'Synthetic local-control fixture cleanup failed');
  });
  client = await pool.connect();
  const actualTarget = (await client.query('SELECT current_database() AS database, inet_server_addr()::text AS address')).rows[0];
  assert.equal(actualTarget.database, target.databaseName);
  assert.ok(isAllowedPostgresIntegrationServerAddress({serverAddress: actualTarget.address, target}),
    `actual PostgreSQL server address is not an allowed integration target: ${JSON.stringify(actualTarget.address)}`);
  await client.query("SET statement_timeout='5s'");
  await client.query("SET lock_timeout='2s'");
  const schema = (await client.query(`SELECT to_regclass('tenants') AS tenants,
    to_regclass('auth_codes') AS codes, to_regclass('auth_bindings') AS bindings,
    to_regclass('capture_agents') AS agents, to_regclass('capture_agent_tokens') AS tokens,
    to_regclass('capture_recovery_intents') AS current_schema`)).rows[0];
  assert.ok(Object.values(schema).every(Boolean), 'Requires an already prepared current schema; this test never runs migrations.');
  await client.query('BEGIN');
  try {
    for (const other of [false, true]) {
      const tenant = other ? ids.otherTenant : ids.tenant;
      const code = other ? ids.otherCode : ids.code;
      const binding = other ? ids.otherBinding : ids.binding;
      const agent = other ? ids.otherAgent : ids.agent;
      const token = other ? ids.otherToken : ids.token;
      await client.query('INSERT INTO tenants (id,name) VALUES ($1,$2)', [tenant, names.get(tenant)]);
      await client.query("INSERT INTO auth_codes (id,tenant_id,code,type) VALUES ($1,$2,$3,'permanent')",
        [code, tenant, `INTEGRATION-${code}`]);
      await client.query('INSERT INTO auth_bindings (id,code_id,fingerprint) VALUES ($1,$2,$3)',
        [binding, code, `isolated-${binding}`]);
      await client.query('INSERT INTO capture_agents (id,tenant_id,auth_code_id,auth_binding_id,client_uuid) VALUES ($1,$2,$3,$4,$5)',
        [agent, tenant, code, binding, `isolated-${agent}`]);
      await client.query('INSERT INTO capture_agent_tokens (id,agent_id,auth_code_id,auth_binding_id,token_hash) VALUES ($1,$2,$3,$4,$5)',
        [token, agent, code, binding, hashCaptureAgentToken(other ? tokens.other : tokens.original)]);
    }
    await client.query('COMMIT'); seeded = true;
  } catch (error) {await client.query('ROLLBACK'); throw error;}

  const reads = [], app = express();
  app.use(express.json());
  app.use('/api/capture-cloud', createCaptureLocalControlAuthorityRouter({evaluate: args => evaluateLocalControlAuthority(args, {
    now: () => clock ? clock() : Date.now(),
    readOne: async (sql, params) => {
      assert.equal(sql, LOCAL_CONTROL_AUTHORITY_SQL, 'the Router evaluates the exact production SELECT');
      reads.push({sql, params: [...params]});
      await client.query('BEGIN READ ONLY');
      try {
        const mode = await client.query('SHOW transaction_read_only');
        assert.equal(mode.rows[0].transaction_read_only, 'on');
        const result = await client.query(sql, params);
        await client.query('COMMIT');
        return result.rows[0];
      } catch (error) {await client.query('ROLLBACK'); throw error;}
    },
  })}));
  app.use((error, _req, res, _next) => res.status(500).json({ok: false, error: error.message}));
  server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1');
    listener.once('error', reject); listener.once('listening', () => resolve(listener));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const body = (action = 'recover_local_capture', platform = 'xiaohongshu') => ({action,
    source: {originId: ids.origin, planFingerprint: 'a'.repeat(64), platform,
      requestId: action === 'admit_local_plan' ? '' : ids.request,
      attemptId: action === 'admit_local_plan' ? '' : ids.attempt,
      generation: action === 'admit_local_plan' ? 0 : 1, sourceRevision: 'b'.repeat(64)}});
  const rows = async () => (await client.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tenants t WHERE id=ANY($1::uuid[])) AS tenants,
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM auth_codes c WHERE tenant_id=ANY($1::uuid[])) AS codes,
    (SELECT jsonb_agg(to_jsonb(b) ORDER BY b.id) FROM auth_bindings b JOIN auth_codes c ON c.id=b.code_id WHERE c.tenant_id=ANY($1::uuid[])) AS bindings,
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM capture_agents a WHERE tenant_id=ANY($1::uuid[])) AS agents,
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM capture_agent_tokens t JOIN capture_agents a ON a.id=t.agent_id WHERE a.tenant_id=ANY($1::uuid[])) AS tokens,
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM capture_tasks t WHERE tenant_id=ANY($1::uuid[])) AS tasks,
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM capture_task_attempts a WHERE tenant_id=ANY($1::uuid[])) AS attempts,
    (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM capture_task_snapshots s WHERE tenant_id=ANY($1::uuid[])) AS snapshots,
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM capture_agent_commands c WHERE tenant_id=ANY($1::uuid[])) AS commands,
    (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM capture_recovery_intents i WHERE tenant_id=ANY($1::uuid[])) AS intents,
    (SELECT jsonb_agg(to_jsonb(w) ORDER BY id) FROM ops_control_wakeups w WHERE tenant_id=ANY($1::uuid[])) AS wakeups`,
  [[ids.tenant, ids.otherTenant]])).rows[0];
  let requests = 0;
  async function request(input = body(), token = tokens.original, {expectedQueries = 1, path = 'local-control-authority'} = {}) {
    const before = await rows(), readCount = reads.length;
    const headers = {'content-type': 'application/json'};
    if (token !== null) headers.authorization = `Bearer ${token}`;
    const response = await fetch(`${origin}/api/capture-cloud/agent/${path}`, {
      method: 'POST', headers, body: JSON.stringify(input), redirect: 'error',
    });
    requests++;
    assert.equal(reads.length - readCount, expectedQueries,
      'each valid token/target evaluation uses one current SELECT; malformed input performs none');
    assert.deepEqual(await rows(), before, 'HTTP authority must not touch identities, last_seen, heartbeat, tasks, commands, intents or wakeups');
    if (path !== 'local-control-authority') return {status: response.status, text: await response.text()};
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('pragma'), 'no-cache');
    return {status: response.status, body: await response.json()};
  }
  function permitted(result, input = body()) {
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.ok, true); assert.equal(result.body.decision, 'allow');
    assert.equal(result.body.reason, 'local_control_authorized');
    assert.equal(result.body.action, input.action);
    assert.equal(result.body.policyVersion, LOCAL_CONTROL_POLICY_VERSION);
    assert.deepEqual(result.body.source, input.source);
    assert.deepEqual(Object.keys(result.body).sort(), responseKeys.slice().sort());
    assert.match(result.body.bindingRevision, /^[a-f0-9]{64}$/u);
    assert.match(result.body.authorityRevision, /^[a-f0-9]{64}$/u);
    const window = Date.parse(result.body.expiresAt) - Date.parse(result.body.evaluatedAt);
    assert.ok(window > 0 && window <= LOCAL_CONTROL_WINDOW_MS);
    for (const token of Object.values(tokens)) assert.equal(JSON.stringify(result.body).includes(token), false);
    assert.doesNotMatch(JSON.stringify(result.body), /tokenHash|tokenId|token_hash|serverTaskId|successorAllowed|originProven|adoptionReceipt/u);
    return result.body;
  }
  function denied(result, reason = 'agent_entitlement_unavailable', status = 403) {
    assert.equal(result.status, status, JSON.stringify(result.body));
    assert.equal(result.body.ok, false); assert.equal(result.body.reason, reason);
    assert.equal(result.body.decision, 'deny');
  }
  async function changed(sql, params, restoreSql, restoreParams, check) {
    await client.query(sql, params);
    try {await check();} finally {await client.query(restoreSql, restoreParams);}
  }
  const extension = extensionBoundary();
  const auth = token => ({authMutationId: 'synthetic-current-auth', tenant: {id: ids.tenant},
    captureAgent: {id: ids.agent, token}});
  const authorityClient = extension.authority.create({query: async (input, options) =>
    (await request(input, options.rawAuth.captureAgent.token)).body});
  const baseline = permitted(await request());
  assert.deepEqual(bindingOf(baseline), {tenantId: ids.tenant, agentId: ids.agent, authCodeId: ids.code,
    authBindingId: ids.binding, bindingRevision: baseline.bindingRevision});

  for (const action of LOCAL_CONTROL_ACTIONS) for (const platform of ['xiaohongshu', 'douyin']) {
    await t.test(`four distinct local actions use real current entitlement: ${action}/${platform}`, async () => {
      const input = body(action, platform), result = permitted(await request(input), input);
      assert.equal(result.bindingRevision, baseline.bindingRevision, 'action/source/platform echo does not rotate unchanged binding');
      assert.deepEqual(reads.at(-1).params, [hashCaptureAgentToken(tokens.original), platform]);
    });
  }
  await t.test('fresh SQL is read on every HTTP request, with no positive entitlement cache', async () => {
    await changed("UPDATE tenants SET status='paused' WHERE id=$1", [ids.tenant],
      "UPDATE tenants SET status='active' WHERE id=$1", [ids.tenant], async () => denied(await request()));
    assert.equal(permitted(await request()).bindingRevision, baseline.bindingRevision);
  });
  await t.test('two real connections do not dirty-read an uncommitted revocation, then observe its commit immediately', async () => {
    const writer = await pool.connect();
    try {
      await writer.query("SET statement_timeout='5s'");
      await writer.query("SET lock_timeout='2s'");
      await writer.query('BEGIN');
      await writer.query('UPDATE capture_agent_tokens SET revoked_at=now() WHERE id=$1', [ids.token]);
      assert.equal(permitted(await request()).bindingRevision, baseline.bindingRevision,
        'the current statement sees the previous committed token, never another transaction\'s dirty row');
      await writer.query('COMMIT');
      denied(await request());
    } finally {
      try {
        await writer.query('ROLLBACK');
        await writer.query('UPDATE capture_agent_tokens SET revoked_at=NULL WHERE id=$1', [ids.token]);
      } finally {writer.release();}
    }
    permitted(await request());
  });
  for (const [name, sql, restore] of [
    ['frozen authorization', "UPDATE auth_codes SET status='frozen' WHERE id=$1", "UPDATE auth_codes SET status='active' WHERE id=$1"],
    ['expired authorization status', "UPDATE auth_codes SET status='expired' WHERE id=$1", "UPDATE auth_codes SET status='active' WHERE id=$1"],
    ['paused agent', "UPDATE capture_agents SET status='paused' WHERE id=$1", "UPDATE capture_agents SET status='active' WHERE id=$1"],
    ['revoked agent', "UPDATE capture_agents SET status='revoked' WHERE id=$1", "UPDATE capture_agents SET status='active' WHERE id=$1"],
    ['revoked token', 'UPDATE capture_agent_tokens SET revoked_at=now() WHERE id=$1', 'UPDATE capture_agent_tokens SET revoked_at=NULL WHERE id=$1'],
  ]) await t.test(`${name} denies the next real request`, async () => {
    const id = sql.includes('auth_codes') ? ids.code : sql.includes('capture_agent_tokens') ? ids.token : ids.agent;
    await changed(sql, [id], restore, [id], async () => denied(await request()));
    permitted(await request());
  });
  await t.test('expired timestamps deny and a near entitlement expiry caps the five-second grant', async () => {
    await changed("UPDATE auth_codes SET expires_at=now()-interval '1 second' WHERE id=$1", [ids.code],
      'UPDATE auth_codes SET expires_at=NULL WHERE id=$1', [ids.code], async () => denied(await request()));
    const expiresAt = new Date(Date.now() + 3500).toISOString();
    await changed('UPDATE auth_codes SET expires_at=$1 WHERE id=$2', [expiresAt, ids.code],
      'UPDATE auth_codes SET expires_at=NULL WHERE id=$1', [ids.code], async () => {
        assert.equal(permitted(await request()).expiresAt, expiresAt);
      });
  });
  await t.test('current platform scope denies the other platform and canonical scope order is stable', async () => {
    await changed('UPDATE capture_agents SET allowed_platforms=$1 WHERE id=$2', [['xiaohongshu'], ids.agent],
      "UPDATE capture_agents SET allowed_platforms='{}' WHERE id=$1", [ids.agent], async () => {
        permitted(await request()); denied(await request(body('recover_local_capture', 'douyin')));
        await client.query('UPDATE capture_agents SET allowed_platforms=$1 WHERE id=$2', [['douyin'], ids.agent]);
        denied(await request()); permitted(await request(body('recover_local_capture', 'douyin')), body('recover_local_capture', 'douyin'));
        await client.query('UPDATE capture_agents SET allowed_platforms=$1 WHERE id=$2', [['douyin', 'xiaohongshu'], ids.agent]);
        const both = permitted(await request());
        await client.query('UPDATE capture_agents SET allowed_platforms=$1 WHERE id=$2', [['xiaohongshu', 'douyin', 'douyin'], ids.agent]);
        assert.equal(permitted(await request()).bindingRevision, both.bindingRevision);
      });
  });
  await t.test('routine heartbeat/updated_at/last_seen changes do not rotate the binding fence', async () => {
    await client.query('UPDATE capture_agents SET last_heartbeat_at=now(),updated_at=now() WHERE id=$1', [ids.agent]);
    await client.query('UPDATE auth_bindings SET last_seen_at=now() WHERE id=$1', [ids.binding]);
    assert.equal(permitted(await request()).bindingRevision, baseline.bindingRevision);
  });
  await t.test('unknown source is only echoed; even an online grant cannot manufacture local production provenance', async () => {
    const input = body();
    input.source = {...input.source, originId: randomUUID(), requestId: randomUUID(), attemptId: randomUUID(),
      generation: 27, planFingerprint: 'c'.repeat(64), sourceRevision: 'd'.repeat(64)};
    const result = permitted(await request(input), input);
    assert.equal(result.bindingRevision, baseline.bindingRevision);
    assert.equal((await rows()).tasks, null, 'no server task exists or is adopted for this arbitrary source');
    assert.throws(() => extension.source.requestProof({origin: {version: 1, request: null},
      request: {id: input.source.requestId, attemptId: input.source.attemptId, cloudAssigned: false, cloudCommandId: ''},
      auth: auth(tokens.original), ledger: {runs: []}, authority: clone(result)}), /local_source_unproven/u);
  });
  await t.test('another valid tenant token returns its own identity and cannot inherit the expected original binding', async () => {
    const accepted = await authorityClient.evaluate({...body(), auth: auth(tokens.original), expectedBinding: bindingOf(baseline)});
    assert.equal(accepted.authority.bindingRevision, baseline.bindingRevision, 'the real Extension client accepts the unchanged original fence');
    const result = permitted(await request(body(), tokens.other));
    assert.equal(result.tenantId, ids.otherTenant); assert.equal(result.agentId, ids.otherAgent);
    assert.notEqual(result.bindingRevision, baseline.bindingRevision);
    await assert.rejects(authorityClient.evaluate({...body(), auth: auth(tokens.other), expectedBinding: bindingOf(baseline)}),
      /local_control_authority_denied/u);
  });
  await t.test('binding replacement invalidates old token and the original Extension origin fence', async () => {
    await client.query('INSERT INTO auth_bindings (id,code_id,fingerprint) VALUES ($1,$2,$3)',
      [ids.newBinding, ids.code, `isolated-${ids.newBinding}`]);
    await changed('UPDATE capture_agents SET auth_binding_id=$1 WHERE id=$2', [ids.newBinding, ids.agent],
      'UPDATE capture_agents SET auth_binding_id=$1 WHERE id=$2', [ids.binding, ids.agent], async () => {
        denied(await request());
        await client.query('INSERT INTO capture_agent_tokens (id,agent_id,auth_code_id,auth_binding_id,token_hash) VALUES ($1,$2,$3,$4,$5)',
          [ids.reboundToken, ids.agent, ids.code, ids.newBinding, hashCaptureAgentToken(tokens.rebound)]);
        const rebound = permitted(await request(body(), tokens.rebound));
        assert.equal(rebound.authBindingId, ids.newBinding);
        assert.notEqual(rebound.bindingRevision, baseline.bindingRevision);
        await assert.rejects(authorityClient.evaluate({...body(), auth: auth(tokens.rebound), expectedBinding: bindingOf(baseline)}),
          /local_control_authority_denied/u);
      });
    permitted(await request());
  });
  await t.test('token replacement under the same binding rotates the fence and revocation remains immediate', async () => {
    await client.query('INSERT INTO capture_agent_tokens (id,agent_id,auth_code_id,auth_binding_id,token_hash) VALUES ($1,$2,$3,$4,$5)',
      [ids.replacementToken, ids.agent, ids.code, ids.binding, hashCaptureAgentToken(tokens.replacement)]);
    await changed('UPDATE capture_agent_tokens SET revoked_at=now() WHERE id=$1', [ids.token],
      'UPDATE capture_agent_tokens SET revoked_at=NULL WHERE id=$1', [ids.token], async () => {
        denied(await request());
        const replacement = permitted(await request(body(), tokens.replacement));
        assert.equal(replacement.authBindingId, baseline.authBindingId);
        assert.notEqual(replacement.bindingRevision, baseline.bindingRevision);
        await assert.rejects(authorityClient.evaluate({...body(), auth: auth(tokens.replacement), expectedBinding: bindingOf(baseline)}),
          /local_control_authority_denied/u);
      });
  });
  await t.test('real joins reject a code outside the current tenant or a binding outside the current code', async () => {
    await changed('UPDATE auth_codes SET tenant_id=$1 WHERE id=$2', [ids.otherTenant, ids.code],
      'UPDATE auth_codes SET tenant_id=$1 WHERE id=$2', [ids.tenant, ids.code], async () => denied(await request()));
    await changed('UPDATE auth_bindings SET code_id=$1 WHERE id=$2', [ids.otherCode, ids.binding],
      'UPDATE auth_bindings SET code_id=$1 WHERE id=$2', [ids.code, ids.binding], async () => denied(await request()));
  });
  await t.test('future token/binding creation timestamps fail closed against the actual SQL statement clock', async () => {
    const tokenCreatedAt = (await client.query('SELECT created_at FROM capture_agent_tokens WHERE id=$1', [ids.token])).rows[0].created_at;
    await changed("UPDATE capture_agent_tokens SET created_at=now()+interval '1 hour' WHERE id=$1", [ids.token],
      'UPDATE capture_agent_tokens SET created_at=$1 WHERE id=$2', [tokenCreatedAt, ids.token], async () => {
        denied(await request(), 'authority_expired', 409);
      });
    const boundAt = (await client.query('SELECT bound_at FROM auth_bindings WHERE id=$1', [ids.binding])).rows[0].bound_at;
    await changed("UPDATE auth_bindings SET bound_at=now()+interval '1 hour' WHERE id=$1", [ids.binding],
      'UPDATE auth_bindings SET bound_at=$1 WHERE id=$2', [boundAt, ids.binding], async () => {
        denied(await request(), 'authority_expired', 409);
      });
  });
  await t.test('a slow evaluation cannot extend a real SQL snapshot beyond its authority window', async () => {
    let calls = 0;
    clock = () => Date.now() + (calls++ ? 6000 : 0);
    try {denied(await request(), 'authority_expired', 409);} finally {clock = null;}
    permitted(await request());
  });
  await t.test('malformed and cross-policy actions never reach PostgreSQL', async () => {
    for (const action of ['resume', 'stop_active_capture', 'dismiss_terminal_recovery_metadata', 'read_history']) {
      denied(await request({...body(), action}, tokens.original, {expectedQueries: 0}), 'invalid_control_target', 400);
    }
    for (const mutate of [input => {input.source.cloudAssigned = false;}, input => {input.source.cloudCommandId = '';},
      input => {input.tenantId = ids.tenant;}, input => {input.source.generation = 0;},
      input => {delete input.source.sourceRevision;}, input => {input.source.platform = 'unknown';}]) {
      const input = body(); mutate(input);
      denied(await request(input, tokens.original, {expectedQueries: 0}), 'invalid_control_target', 400);
    }
    denied(await request(body(), null, {expectedQueries: 0}), 'invalid_agent_token');
    denied(await request(body(), `unknown-isolated-${randomUUID()}`));
    for (const path of ['control-authority', 'stop-authority', 'resume']) {
      assert.equal((await request(body(), tokens.original, {path, expectedQueries: 0})).status, 404);
    }
  });
  const final = await rows();
  assert.equal(final.tasks, null); assert.equal(final.attempts, null);
  assert.equal(final.snapshots, null);
  assert.equal(final.commands, null); assert.equal(final.intents, null); assert.equal(final.wakeups, null);
  assert.ok(reads.every(read => read.sql === LOCAL_CONTROL_AUTHORITY_SQL));
  t.diagnostic(`${requests} loopback HTTP Router requests; ${reads.length} exact production SELECTs in READ ONLY transactions; no task/Attempt/command/recovery/wakeup created.`);
});
