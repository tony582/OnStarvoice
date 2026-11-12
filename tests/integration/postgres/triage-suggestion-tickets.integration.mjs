import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {createApp} from '../../../server/app.js';
import {runMigrations} from '../../../server/db/migrate.js';
import {getPool, closePool} from '../../../server/db/pool.js';
import {hashSessionToken} from '../../../server/services/auth-service.js';

test('content ticket status changes settle suggestions in the same transaction', async t => {
  validatePostgresIntegrationTarget({testDatabaseUrl: process.env.TEST_DATABASE_URL,
    databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true});
  await runMigrations();
  const pool = getPool(), tenants = [], originalFetch = globalThis.fetch;
  let userId, server;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (server) await new Promise(resolve => {server.close(resolve); server.closeAllConnections();});
    if (userId) await pool.query('DELETE FROM users WHERE id=$1', [userId]);
    if (tenants.length) await pool.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])', [tenants]);
    await closePool();
  });
  for (let i = 0; i < 2; i++) {
    tenants.push((await pool.query('INSERT INTO tenants(name) VALUES($1) RETURNING id',
      [`Suggestion ticket fixture ${randomUUID()}`])).rows[0].id);
  }
  const [tenantId, otherTenantId] = tenants;
  userId = (await pool.query(`INSERT INTO users(email,name,password_hash,status,is_internal,global_role)
    VALUES($1,'Suggestion ticket reviewer','not-a-login-password','active',false,'') RETURNING id`,
  [`suggestion-ticket-${randomUUID()}@integration.invalid`])).rows[0].id;
  await pool.query(`INSERT INTO user_memberships(user_id,tenant_id,role,status)
    VALUES($1,$2,'tenant_analyst','active')`, [userId, tenantId]);
  const token = randomUUID();
  await pool.query(`INSERT INTO user_sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')`,
    [userId, hashSessionToken(token)]);
  server = createApp({logger: {log() {}, error() {}}}).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  globalThis.fetch = (input, init) => {
    assert.equal(new URL(String(input)).origin, origin, 'integration test must not make outbound HTTP requests');
    return originalFetch(input, init);
  };
  async function request(path, body, method = 'PATCH', owner = tenantId) {
    const response = await fetch(`${origin}/api/tickets${path}`, {method,
      headers: {'content-type': 'application/json', Cookie: `osv_session=${token}`, 'x-tenant-id': owner},
      body: JSON.stringify(body)});
    return {status: response.status, body: await response.json()};
  }
  async function fixture({status = 'unhandled', owner = tenantId} = {}) {
    const recordId = randomUUID();
    await pool.query(`INSERT INTO records(id,tenant_id,platform,external_id,title,content,ai_result)
      VALUES($1,$2,'douyin',$3,'Fixture post','A public post used only by the offline test','{"relevance":"relevant"}')`,
    [recordId, owner, recordId]);
    if (status !== null) await pool.query(`INSERT INTO record_triage(tenant_id,record_id,status) VALUES($1,$2,$3)`,
      [owner, recordId, status]);
    await pool.query(`INSERT INTO record_triage_suggestions(tenant_id,record_id,suggestion,rule_version,reason)
      VALUES($1,$2,'non_monitor','fixture-v1','{"label":"Fixture suggestion"}')`, [owner, recordId]);
    return recordId;
  }
  async function ticket(recordId, {status = 'pending', owner = tenantId, number = ''} = {}) {
    return (await pool.query(`INSERT INTO tickets(tenant_id,source_type,source_record_id,status,external_ticket_no,feedback_status)
      VALUES($1,'content',$2,$3,$4,$5) RETURNING id`,
    [owner, recordId, status, number, status === 'done' ? 'pending_review' : 'none'])).rows[0].id;
  }
  async function suggestion(recordId, owner = tenantId) {
    return (await pool.query(`SELECT resolution,resolved_at,resolved_by FROM record_triage_suggestions
      WHERE tenant_id=$1 AND record_id=$2`, [owner, recordId])).rows[0];
  }
  async function assertRejected(recordId) {
    const row = await suggestion(recordId);
    assert.equal(row.resolution, 'rejected');
    assert.equal(row.resolved_by, userId);
    assert.ok(row.resolved_at instanceof Date);
    return row;
  }
  async function assertOpen(recordId, owner = tenantId) {
    assert.deepEqual(await suggestion(recordId, owner), {resolution: null, resolved_at: null, resolved_by: null});
  }

  await t.test('creating a content ticket rejects its open suggestion', async () => {
    const id = await fixture();
    const response = await request('', {sourceType: 'content', sourceId: id, externalTicketNo: 'TEST-001'}, 'POST');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.existed, false);
    await assertRejected(id);
    const triage = (await pool.query('SELECT status FROM record_triage WHERE tenant_id=$1 AND record_id=$2', [tenantId, id])).rows[0];
    assert.equal(triage.status, 'negative_feishu');
  });
  await t.test('reusing an active ticket also rejects the suggestion without duplicating tickets', async () => {
    const id = await fixture(), ticketId = await ticket(id, {number: 'TEST-002'});
    const response = await request('', {sourceType: 'content', sourceId: id, externalTicketNo: 'TEST-002'}, 'POST');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.existed, true);
    assert.equal(response.body.ticket.id, ticketId);
    await assertRejected(id);
    assert.equal((await pool.query('SELECT count(*) AS count FROM tickets WHERE tenant_id=$1 AND source_record_id=$2', [tenantId, id])).rows[0].count, 1);
  });
  await t.test('closing a legacy ticket without triage creates negative_feishu and rejects only once', async () => {
    const id = await fixture({status: null}), ticketId = await ticket(id);
    const response = await request(`/${ticketId}`, {action: 'close'});
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.recordArchiveChanged, true);
    const before = await assertRejected(id);
    const repeated = await request(`/${ticketId}`, {action: 'close'});
    assert.equal(repeated.status, 200, JSON.stringify(repeated.body));
    assert.equal(repeated.body.idempotent, true);
    assert.deepEqual(await suggestion(id), before);
    const triage = (await pool.query('SELECT status,archived_at FROM record_triage WHERE tenant_id=$1 AND record_id=$2', [tenantId, id])).rows[0];
    assert.equal(triage.status, 'negative_feishu');
    assert.ok(triage.archived_at);
  });
  await t.test('confirming a legacy content receipt settles the newly introduced human status', async () => {
    const id = await fixture({status: null}), ticketId = await ticket(id, {status: 'done'});
    const response = await request(`/${ticketId}/review`, {decision: 'confirm'});
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.ticket.status, 'closed');
    await assertRejected(id);
  });
  await t.test('pure archival via close or receipt confirmation preserves an existing status and open suggestion', async () => {
    for (const review of [false, true]) {
      const id = await fixture(), ticketId = await ticket(id, {status: review ? 'done' : 'pending'});
      const response = review ? await request(`/${ticketId}/review`, {decision: 'confirm'})
        : await request(`/${ticketId}`, {action: 'close'});
      assert.equal(response.status, 200, JSON.stringify(response.body));
      await assertOpen(id);
      const triage = (await pool.query('SELECT status,archived_at FROM record_triage WHERE tenant_id=$1 AND record_id=$2', [tenantId, id])).rows[0];
      assert.equal(triage.status, 'unhandled');
      assert.ok(triage.archived_at);
    }
  });
  await t.test('another active ticket prevents archival and leaves suggestions untouched', async () => {
    const id = await fixture({status: null}), older = await ticket(id, {status: 'closed'});
    const active = await ticket(id);
    const response = await request(`/${older}`, {action: 'close'});
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.recordArchiveBlockedByActiveTicket, true);
    assert.equal(response.body.blockingActiveTicketId, active);
    await assertOpen(id);
    assert.equal((await pool.query('SELECT count(*) AS count FROM record_triage WHERE tenant_id=$1 AND record_id=$2', [tenantId, id])).rows[0].count, 0);
  });
  await t.test('changing or repeating a ticket number does not resolve suggestions', async () => {
    const id = await fixture(), ticketId = await ticket(id);
    for (let i = 0; i < 2; i++) {
      const response = await request(`/${ticketId}/external-number`, {externalTicketNo: 'TEST-METADATA'});
      assert.equal(response.status, 200, JSON.stringify(response.body));
      await assertOpen(id);
    }
  });
  await t.test('a foreign tenant cannot change or resolve the target content', async () => {
    const id = await fixture({owner: otherTenantId});
    const denied = await request('', {sourceType: 'content', sourceId: id, externalTicketNo: 'DENIED'}, 'POST', otherTenantId);
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    await assertOpen(id, otherTenantId);
  });
  await t.test('a suggestion update failure rolls back the ticket, status and audit together', async () => {
    const id = await fixture();
    // The UUID is generated by this test; the trigger only rejects this fixture.
    const suffix = randomUUID().replaceAll('-', '');
    const name = `test_suggestion_ticket_${suffix}`;
    await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.record_id='${id}'::uuid THEN RAISE EXCEPTION 'fixture rejection'; END IF; RETURN NEW; END $$`);
    try {
      await pool.query(`CREATE TRIGGER ${name} BEFORE UPDATE ON record_triage_suggestions
        FOR EACH ROW EXECUTE FUNCTION ${name}()`);
      const response = await request('', {sourceType: 'content', sourceId: id, externalTicketNo: 'ROLLBACK'}, 'POST');
      assert.equal(response.status, 500, JSON.stringify(response.body));
      await assertOpen(id);
      const triage = (await pool.query('SELECT status FROM record_triage WHERE tenant_id=$1 AND record_id=$2', [tenantId, id])).rows[0];
      assert.equal(triage.status, 'unhandled');
      assert.equal((await pool.query('SELECT count(*) AS count FROM tickets WHERE tenant_id=$1 AND source_record_id=$2', [tenantId, id])).rows[0].count, 0);
      assert.equal((await pool.query("SELECT count(*) AS count FROM audit_logs WHERE tenant_id=$1 AND target_id=$2 AND action IN ('record.ticket_created','record.triage_updated')", [tenantId, id])).rows[0].count, 0);
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${name} ON record_triage_suggestions`);
      await pool.query(`DROP FUNCTION IF EXISTS ${name}()`);
    }
  });
});
