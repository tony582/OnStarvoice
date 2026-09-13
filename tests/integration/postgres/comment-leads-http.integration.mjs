import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { validatePostgresIntegrationTarget } from '../../../scripts/lib/postgres-integration-target.mjs';
import { runMigrations } from '../../../server/db/migrate.js';
import { getPool, closePool } from '../../../server/db/pool.js';
import { createApp } from '../../../server/app.js';
import { hashPassword } from '../../../server/services/auth-service.js';
import { decodeSalesReviewCursor, rejudgeSalesLeadBatch } from '../../../server/services/comment-lead-rejudge.js';
import { mutateCommentLead } from '../../../server/services/comment-lead-followup.js';
import { withTransaction } from '../../../server/db/init.js';
import { persistPendingCommentAiClassification } from '../../../server/services/comment-workflow.js';

test('comment leads HTTP and review preserve follow-ups, cover cursor pages and isolate tenants', async t => {
  validatePostgresIntegrationTarget({ testDatabaseUrl: process.env.TEST_DATABASE_URL, databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true });
  await runMigrations();
  const pool = getPool();
  const tenants = [], users = [];
  let server;
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (users.length) await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
    if (tenants.length) await pool.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])', [tenants]);
    await closePool();
  });
  async function tenant() {
    const id = (await pool.query('INSERT INTO tenants(name) VALUES($1) RETURNING id', [`评论验证 ${randomUUID()}`])).rows[0].id;
    tenants.push(id); return id;
  }
  const tenantId = await tenant(), otherTenant = await tenant();
  async function fixture({ type = 'other', status = 'new', owner = tenantId, content = '这个价格真敢收，谁买谁后悔', manual = false } = {}) {
    const recordId = randomUUID(), commentId = randomUUID(), leadId = randomUUID();
    const externalId = String(Math.floor(Math.random() * 1e15));
    const sourceUrl = `https://www.douyin.com/video/${externalId}`;
    await pool.query(`INSERT INTO records(id,tenant_id,platform,external_id,title,content,url,canonical_url,ai_result)
      VALUES($1,$2,'douyin',$3,'当前原帖标题','完整原帖内容',$4,$4,'{"relevance":"relevant"}')`, [recordId, owner, externalId, sourceUrl]);
    await pool.query(`INSERT INTO record_comments(id,tenant_id,record_id,platform,external_comment_id,content,content_hash,ai_result)
      VALUES($1,$2,$3,'douyin',$4,$5,$4,'{"salesIntent":true}')`, [commentId, owner, recordId, randomUUID(), content]);
    await pool.query(`INSERT INTO comment_leads(id,tenant_id,record_id,comment_id,platform,lead_type,status,record_url,comment_content,manual_lead_type,manual_reason)
      VALUES($1,$2,$3,$4,'douyin',$5,$6,'https://www.douyin.com/video/old',$7,$8,$9)`,
    [leadId, owner, recordId, commentId, type, status, content, manual ? type : null, manual ? '已人工确认' : '']);
    return { id: leadId, recordId, commentId, sourceUrl, content };
  }
  const fresh = await fixture(), following = await fixture({ status: 'following' }), ticketed = await fixture({ status: 'ticketed' });
  await fixture({ status: 'resolved' });
  const foreign = await fixture({ owner: otherTenant });
  const ticketId = (await pool.query("INSERT INTO tickets(tenant_id,source_type,source_record_id,source_comment_id,status) VALUES($1,'comment',$2,$3,'pending') RETURNING id", [tenantId, ticketed.recordId, ticketed.id])).rows[0].id;
  async function user(role) {
    const email = `leads-${randomUUID()}@integration.invalid`;
    const id = (await pool.query("INSERT INTO users(email,name,password_hash,status,is_internal,global_role,must_change_password) VALUES($1,'跟进测试员',$2,'active',false,'',false) RETURNING id", [email, hashPassword('test-leads-password')])).rows[0].id;
    users.push(id);
    await pool.query("INSERT INTO user_memberships(user_id,tenant_id,role,status) VALUES($1,$2,$3,'active')", [id, tenantId, role]);
    return { id, email };
  }
  const writer = await user('tenant_analyst'), viewer = await user('tenant_viewer');
  const app = createApp({ logger: { log() {}, error() {} } });
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function login(person) {
    const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: person.email, password: 'test-leads-password' }) });
    assert.equal(r.status, 200); return (await r.json()).token;
  }
  const token = await login(writer), readToken = await login(viewer);
  async function request(path, { method = 'GET', body, auth = token, owner = tenantId } = {}) {
    return fetch(`${base}/api/leads/comments${path}`, { method, headers: { authorization: `Bearer ${auth}`, 'x-tenant-id': owner, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  async function ticketRequest(path, body, method = 'PATCH') {
    const response = await fetch(`${base}/api/tickets${path}`, { method,
      headers: { authorization: `Bearer ${token}`, 'x-tenant-id': tenantId, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  await t.test('active bucket and status intersect; live sources and linked tickets remain visible', async () => {
    const r = await request('?category=opinion&bucket=active');
    const data = await r.json(); assert.equal(r.status, 200, JSON.stringify(data));
    assert.deepEqual(new Set(data.leads.map(l => l.status)), new Set(['new', 'following', 'ticketed']));
    assert.equal(data.leads.find(l => l.id === ticketed.id).ticket_id, ticketId);
    assert.equal(data.leads.find(l => l.id === fresh.id).record_current_url, fresh.sourceUrl);
    const narrowed = await (await request('?bucket=active&status=following')).json();
    assert.deepEqual(narrowed.leads.map(l => l.id), [following.id]);
    const mismatch = await (await request('?bucket=archived&status=following')).json();
    assert.equal(mismatch.leads.length, 0);
    const exported = await request('/export?bucket=active&status=ticketed');
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-type'), /spreadsheetml/);
  });
  await t.test('detail, append, correction, archive/restore and reader restrictions', async () => {
    for (const body of ['首次沟通：核实具体问题', '第二次沟通：等待用户补充']) {
      const r = await request(`/${fresh.id}/notes`, { method: 'POST', body: { body } }); assert.equal(r.status, 200, await r.text());
    }
    const statusResponse = await request(`/${fresh.id}`, { method: 'PATCH', body: { status: 'following' } }); assert.equal(statusResponse.status, 200);
    const detail = await (await request(`/${fresh.id}`)).json();
    assert.equal(detail.record.url, fresh.sourceUrl);
    assert.ok(detail.activity.some(a => a.body === '首次沟通：核实具体问题'));
    assert.ok(detail.activity.some(a => a.body === '第二次沟通：等待用户补充'));
    assert.ok(detail.activity.some(a => a.action === 'status_changed'));
    assert.ok(detail.suggestion.steps.length > 1);
    assert.equal((await request(`/${fresh.id}`, { method: 'PATCH', body: { leadType: 'sales_intent' } })).status, 400);
    const corrected = await (await request(`/${fresh.id}`, { method: 'PATCH', body: { leadType: 'sales_intent', correctionReason: '沟通后确认本人有真实需求' } })).json();
    assert.equal(corrected.lead.manual_lead_type, 'sales_intent');
    assert.equal((await request(`/${fresh.id}`, { method: 'PATCH', body: { status: 'resolved' } })).status, 200);
    assert.equal((await request(`/${fresh.id}`, { method: 'PATCH', body: { status: 'new' } })).status, 200);
    assert.equal((await request(`/${fresh.id}/notes`, { method: 'POST', body: { body: '' } })).status, 400);
    assert.equal((await request(`/${fresh.id}/notes`, { method: 'POST', body: { body: '越权' }, auth: readToken })).status, 403);
    assert.equal((await request(`/${foreign.id}`)).status, 404);
    assert.equal((await request(`/${foreign.id}`, { method: 'PATCH', body: { status: 'following' } })).status, 404);
    assert.equal((await request('', { owner: otherTenant })).status, 403);
    assert.equal((await request('/rejudge-sales', { method: 'POST', body: { cursor: 'bad' } })).status, 400);
    const batch = await (await request('/batch', { method: 'PATCH', body: { ids: [following.id, foreign.id], status: 'resolved', note: '批量复核完毕' } })).json();
    assert.equal(batch.updated, 1); assert.deepEqual(batch.skipped, [foreign.id]);
    const batchDetail = await (await request(`/${following.id}`)).json();
    assert.ok(batchDetail.activity.some(a => a.body === '批量复核完毕'));
    assert.equal((await request('/batch', { method: 'PATCH', body: { ids: [following.id], status: 'new', note: ' ' } })).status, 400);
    assert.equal((await (await request(`/${following.id}`)).json()).lead.status, 'resolved');
    for (const [path, method, body] of [
      [`/${fresh.id}`, 'PATCH', { status: 'following' }],
      ['/batch', 'PATCH', { ids: [fresh.id], status: 'following' }],
      ['/rejudge-sales', 'POST', { cursor: 'bad' }],
    ]) assert.equal((await request(path, { method, body, auth: readToken })).status, 403);
  });
  await t.test('comment ticket creation stays active and appends one idempotent activity', async () => {
    const source = await fixture({ status: 'following' });
    const createTicket = (auth = token, id = source.id) => fetch(`${base}/api/tickets`, {
      method: 'POST', headers: { authorization: `Bearer ${auth}`, 'x-tenant-id': tenantId, 'content-type': 'application/json' },
      body: JSON.stringify({ sourceType: 'comment', sourceId: id, note: '转售后核实', externalTicketNo: 'COMMENT-REVIEW-TEST' }),
    });
    assert.equal((await createTicket(readToken)).status, 403);
    assert.equal((await createTicket(token, foreign.id)).status, 404);
    const createdResponse = await createTicket();
    const created = await createdResponse.json();
    assert.equal(createdResponse.status, 200, JSON.stringify(created));
    assert.equal(created.existed, false);
    assert.equal((await (await createTicket()).json()).existed, true);
    const detail = await (await request(`/${source.id}`)).json();
    assert.equal(detail.lead.status, 'ticketed');
    assert.equal(detail.lead.ticket_id, created.ticket.id);
    const events = detail.activity.filter(a => a.action === 'ticket_created');
    assert.equal(events.length, 1);
    assert.equal(events[0].metadata.ticket_id, created.ticket.id);
    assert.equal(events[0].metadata.status_from, 'following');
    assert.equal(events[0].metadata.status_to, 'ticketed');
    assert.match(events[0].body, /转售后核实/);
    const active = await (await request('?bucket=active&status=ticketed')).json();
    assert.ok(active.leads.some(l => l.id === source.id));
    assert.equal(detail.ticket.id, created.ticket.id);
    assert.equal(detail.ticket.dispatch_note, '转售后核实');
    assert.equal(detail.lead.ticket_status, 'pending');
    const closed = await ticketRequest(`/${created.ticket.id}`, { action: 'close', note: '已核实处理结果' });
    assert.equal(closed.status, 200);
    const resolved = await (await request(`/${source.id}`)).json();
    assert.equal(resolved.lead.status, 'resolved');
    assert.equal(resolved.lead.handled_by, writer.id);
    assert.equal(resolved.lead.ticket_id, created.ticket.id);
    assert.equal(resolved.lead.ticket_status, 'closed');
    assert.equal(resolved.ticket.status, 'closed');
    assert.equal(resolved.activity.filter(a => a.action === 'ticket_closed').length, 1);
    assert.ok(resolved.activity.some(a => a.action === 'ticket_closed' && a.metadata.status_from === 'ticketed' && a.metadata.status_to === 'resolved'));
    const archived = await (await request('?bucket=archived')).json();
    assert.ok(archived.leads.some(l => l.id === source.id));
    assert.equal((await ticketRequest(`/${created.ticket.id}`, { action: 'close' })).status, 409);
    assert.equal((await ticketRequest(`/${created.ticket.id}`, { action: 'reopen', note: '用户补充新情况' })).status, 200);
    const reopened = await (await request(`/${source.id}`)).json();
    assert.equal(reopened.lead.status, 'ticketed');
    assert.equal(reopened.lead.ticket_status, 'doing');
    assert.equal(reopened.activity.filter(a => a.action === 'ticket_reopened').length, 1);
    assert.ok(reopened.activity.some(a => a.action === 'ticket_reopened' && a.metadata.status_from === 'resolved' && a.metadata.status_to === 'ticketed'));
  });
  await t.test('ticket confirmation closes its source, while independent human states are preserved on close and reopen', async () => {
    const source = await fixture();
    const created = await ticketRequest('', { sourceType: 'comment', sourceId: source.id }, 'POST');
    const id = created.body.ticket.id;
    assert.equal((await ticketRequest(`/${id}`, { action: 'done', result: '已答复' })).status, 200);
    assert.equal((await ticketRequest(`/${id}/review`, { decision: 'confirm', note: '确认反馈' })).status, 200);
    let detail = await (await request(`/${source.id}`)).json();
    assert.equal(detail.lead.status, 'resolved');
    assert.ok(detail.activity.some(a => a.action === 'ticket_closed'));
    // Human changes after ticket closure must not be undone by reopening it.
    assert.equal((await request(`/${source.id}`, { method: 'PATCH', body: { status: 'ignored', note: '人工决定忽略后续讨论' } })).status, 200);
    assert.equal((await ticketRequest(`/${id}`, { action: 'reopen' })).status, 200);
    detail = await (await request(`/${source.id}`)).json();
    assert.equal(detail.lead.status, 'ignored');
    assert.equal(detail.lead.ticket_status, 'doing');
    assert.equal(detail.activity.find(a => a.action === 'ticket_reopened').metadata.workflow_changed, false);
    // Closing an independently following source must likewise leave it following.
    assert.equal((await request(`/${source.id}`, { method: 'PATCH', body: { status: 'following' } })).status, 200);
    assert.equal((await ticketRequest(`/${id}`, { action: 'close' })).status, 200);
    detail = await (await request(`/${source.id}`)).json();
    assert.equal(detail.lead.status, 'following');
    assert.equal(detail.lead.ticket_status, 'closed');
  });
  await t.test('other active tickets block source completion; legacy closed ticket sources retain truthful linked status', async () => {
    const source = await fixture({ status: 'ticketed' });
    const older = (await pool.query("INSERT INTO tickets(tenant_id,source_type,source_record_id,source_comment_id,status,created_at) VALUES($1,'comment',$2,$3,'pending','2000-01-01') RETURNING id", [tenantId, source.recordId, source.id])).rows[0].id;
    const newer = (await pool.query("INSERT INTO tickets(tenant_id,source_type,source_record_id,source_comment_id,status) VALUES($1,'comment',$2,$3,'doing') RETURNING id", [tenantId, source.recordId, source.id])).rows[0].id;
    assert.equal((await ticketRequest(`/${older}`, { action: 'close' })).status, 200);
    let detail = await (await request(`/${source.id}`)).json();
    assert.equal(detail.lead.status, 'ticketed');
    assert.equal(detail.lead.ticket_id, newer);
    assert.equal(detail.lead.ticket_status, 'doing');
    assert.equal((await ticketRequest(`/${older}`, { action: 'reopen' })).status, 409);
    assert.equal((await ticketRequest(`/${newer}`, { action: 'close' })).status, 200);
    detail = await (await request(`/${source.id}`)).json();
    assert.equal(detail.lead.status, 'resolved');
    assert.equal(detail.lead.ticket_id, newer);
    assert.equal(detail.lead.ticket_status, 'closed');
    // Existing mismatches are displayed as they are, without a bulk rewrite.
    await pool.query("UPDATE comment_leads SET status='ticketed' WHERE id=$1", [source.id]);
    detail = await (await request(`/${source.id}`)).json();
    assert.equal(detail.lead.status, 'ticketed');
    assert.equal(detail.lead.ticket_status, 'closed');
    assert.match(detail.suggestion.steps.join(' '), /关联工单已结案/);
  });
  await t.test('review cursor passes retained rows, reroutes sarcasm, refreshes facts, records failures and respects manual overrides', async () => {
    const reviews = [];
    for (let i = 0; i < 7; i++) reviews.push(await fixture({ type: 'sales_intent', status: 'following', content: i % 2 ? '怎么购买服务？' : '这么贵真是谢谢你啊' }));
    const ids = new Set(), failId = reviews[0].commentId;
    const classify = async ({ comment }) => {
      ids.add(comment.id);
      if (comment.id === failId) return null;
      const sales = comment.content === '怎么购买服务？';
      return { is_negative: !sales, sentiment: sales ? 'neutral' : 'negative', category: sales ? 'other' : 'renewal_billing', risk_level: sales ? 'none' : 'low', ai_summary: sales ? '本人咨询服务购买' : '暗讽收费过高',
        ai_result: { salesIntent: sales, salesIntentStatus: sales ? 'confirmed' : 'rejected', salesIntentConfidence: .95, salesActor: sales ? 'buyer' : 'unknown', salesTargetMatch: 'relevant', salesIntentEvidence: [comment.content], expressionType: sales ? 'literal' : 'sarcasm', salesIntentReason: '已结合原帖核验语境' } };
    };
    let cursor, scanned = 0, failed = 0, changed = 0;
    for (let pass = 0; pass < 5; pass++) {
      const result = await rejudgeSalesLeadBatch({ tenantId, cursor, limit: 2, classify, actor: writer });
      scanned += result.scanned; failed += result.failed; changed += result.changed;
      if (!result.hasMore) break;
      assert.ok(result.nextCursor); cursor = result.nextCursor;
      if (pass === 4) assert.fail('review did not terminate');
    }
    assert.equal(scanned, 7); assert.equal(ids.size, 7); assert.equal(failed, 1); assert.equal(changed, 3);
    assert.ok(!ids.has(fresh.commentId), 'manual classification must be excluded');
    const rerouted = reviews[2];
    const rc = (await pool.query('SELECT * FROM record_comments WHERE id=$1', [rerouted.commentId])).rows[0];
    assert.equal(rc.is_negative, true); assert.equal(rc.ai_result.expressionType, 'sarcasm');
    const lead = (await pool.query('SELECT * FROM comment_leads WHERE id=$1', [rerouted.id])).rows[0];
    assert.equal(lead.lead_type, 'renewal_billing'); assert.equal(lead.status, 'following');
    const record = (await pool.query('SELECT negative_comment_count FROM records WHERE id=$1', [rerouted.recordId])).rows[0];
    assert.equal(record.negative_comment_count, 1);
    const retained = reviews[1];
    assert.equal((await pool.query('SELECT ai_result FROM comment_leads WHERE id=$1', [retained.id])).rows[0].ai_result.salesIntentStatus, 'confirmed');
    assert.equal((await pool.query("SELECT COUNT(*)::int n FROM comment_lead_activities WHERE tenant_id=$1 AND action='ai_review'", [tenantId])).rows[0].n, 6);
  });
  await t.test('review cursor preserves a microsecond cutoff and cannot be reused across tenants', async () => {
    const owner = await tenant();
    const inside = await fixture({ owner, type: 'sales_intent' });
    const outside = await fixture({ owner, type: 'sales_intent' });
    await pool.query("UPDATE comment_leads SET created_at = '2000-01-01 12:00:00.123450+00' WHERE id=$1", [inside.id]);
    await pool.query("UPDATE comment_leads SET created_at = '2000-01-01 12:00:00.123457+00' WHERE id=$1", [outside.id]);
    const until = '2000-01-01 12:00:00.123456+00';
    const cursor = Buffer.from(JSON.stringify({ tenantId: owner, lastId: '00000000-0000-0000-0000-000000000000', until })).toString('base64url');
    assert.equal(decodeSalesReviewCursor(cursor, owner).until, until);
    assert.throws(() => decodeSalesReviewCursor(cursor, tenantId), { code: 'invalid_cursor' });
    const seen = [];
    const result = await rejudgeSalesLeadBatch({ tenantId: owner, cursor, classify: async ({ comment }) => { seen.push(comment.id); return null; } });
    assert.equal(result.scanned, 1);
    assert.deepEqual(seen, [inside.commentId]);
  });
  const rejectedAi = {
    is_negative: true, sentiment: 'negative', category: 'renewal_billing', risk_level: 'low', ai_summary: '费用相关反讽',
    ai_result: { salesIntent: false, salesIntentStatus: 'rejected', salesActor: 'unknown', salesTargetMatch: 'relevant', expressionType: 'sarcasm', salesIntentEvidence: [], salesIntentReason: '评论质疑费用，没有真实购买请求' },
  };
  await t.test('AI response cannot overwrite an intervening human correction or changed source context', async () => {
    for (const change of ['manual', 'comment', 'record', 'visibility']) {
      const owner = await tenant();
      const source = await fixture({ owner, type: 'sales_intent' });
      const result = await rejudgeSalesLeadBatch({ tenantId: owner, actor: writer, classify: async () => {
        if (change === 'manual') await mutateCommentLead({ tenantId: owner, id: source.id, leadType: 'service_quality', correctionReason: '人工已核实诉求', actor: writer });
        if (change === 'comment') await pool.query("UPDATE record_comments SET content='用户已补充新的真实购买需求', updated_at=clock_timestamp() WHERE id=$1", [source.commentId]);
        if (change === 'record') await pool.query("UPDATE records SET title='原帖已更新为不同产品' WHERE id=$1", [source.recordId]);
        if (change === 'visibility') await pool.query(`UPDATE records SET ai_result='{"relevance":"irrelevant"}' WHERE id=$1`, [source.recordId]);
        return rejectedAi;
      } });
      assert.equal(result.skipped, 1, change);
      const lead = (await pool.query('SELECT * FROM comment_leads WHERE id=$1', [source.id])).rows[0];
      assert.equal(lead.lead_type, change === 'manual' ? 'service_quality' : 'sales_intent', change);
      assert.equal((await pool.query("SELECT COUNT(*)::int n FROM comment_lead_activities WHERE lead_id=$1 AND action='ai_review'", [source.id])).rows[0].n, 0);
    }
  });
  await t.test('review preserves concurrent human priority, archive status and notes without reopening from old likes', async () => {
    const owner = await tenant();
    const source = await fixture({ owner, type: 'sales_intent', status: 'following' });
    await pool.query('UPDATE record_comments SET like_count=100 WHERE id=$1', [source.commentId]);
    const result = await rejudgeSalesLeadBatch({ tenantId: owner, actor: writer, classify: async () => {
      await mutateCommentLead({ tenantId: owner, id: source.id, priority: 'urgent', status: 'resolved', note: '人工已核实并归档', actor: writer });
      return rejectedAi;
    } });
    assert.equal(result.changed, 1);
    const lead = (await pool.query('SELECT * FROM comment_leads WHERE id=$1', [source.id])).rows[0];
    assert.equal(lead.lead_type, 'renewal_billing');
    assert.equal(lead.status, 'resolved');
    assert.equal(lead.priority, 'urgent');
    assert.equal(lead.last_risk_reopened_at, null);
    const events = (await pool.query('SELECT * FROM comment_lead_activities WHERE lead_id=$1', [source.id])).rows;
    assert.ok(events.some(event => event.note === '人工已核实并归档'));
    assert.equal(events.filter(event => event.action === 'ai_review').length, 1);
  });
  await t.test('a failed row write is reported while the batch continues and returns its cursor', async () => {
    const owner = await tenant();
    const sources = [];
    for (let i = 0; i < 3; i++) sources.push(await fixture({ owner, type: 'sales_intent' }));
    sources.sort((a, b) => a.id.localeCompare(b.id));
    const result = await rejudgeSalesLeadBatch({ tenantId: owner, limit: 2, actor: writer, classify: async ({ comment }) => (
      comment.id === sources[0].commentId ? { ...rejectedAi, risk_level: 'invalid' } : rejectedAi
    ) });
    assert.equal(result.scanned, 2);
    assert.equal(result.failed, 1);
    assert.equal(result.changed, 1);
    assert.equal(result.hasMore, true);
    assert.ok(result.nextCursor);
    const failedLead = (await pool.query('SELECT lead_type FROM comment_leads WHERE id=$1', [sources[0].id])).rows[0];
    assert.equal(failedLead.lead_type, 'sales_intent');
    const next = await rejudgeSalesLeadBatch({ tenantId: owner, cursor: result.nextCursor, classify: async () => rejectedAi });
    assert.equal(next.scanned, 1);
    assert.equal(next.changed, 1);
  });
  await t.test('late background AI cannot overwrite changed inputs or a newer completed review', async () => {
    const owner = await tenant();
    for (const state of ['changed_input', 'review_complete']) {
      const source = await fixture({ owner, type: 'sales_intent' });
      const pending = (await pool.query('SELECT id, updated_at::text AS ai_input_version FROM record_comments WHERE id=$1', [source.commentId])).rows[0];
      if (state === 'changed_input') {
        await pool.query("UPDATE record_comments SET content='新采集补充的评论', updated_at=clock_timestamp() WHERE id=$1", [source.commentId]);
      } else {
        // Keep the same input version to independently exercise the pending gate.
        await pool.query("UPDATE record_comments SET ai_classified_at=clock_timestamp(), ai_summary='较新的重判结论' WHERE id=$1", [source.commentId]);
      }
      const before = (await pool.query('SELECT * FROM record_comments WHERE id=$1', [source.commentId])).rows[0];
      const result = await withTransaction(tx => persistPendingCommentAiClassification(tx, { tenantId: owner, comment: pending, classification: rejectedAi }));
      assert.equal(result, null, state);
      assert.deepEqual((await pool.query('SELECT * FROM record_comments WHERE id=$1', [source.commentId])).rows[0], before, state);
    }
  });
  await t.test('pending AI writes require tenant scope and preserve the exact PostgreSQL input version', async () => {
    const owner = await tenant();
    const source = await fixture({ owner, type: 'sales_intent' });
    await pool.query("UPDATE record_comments SET updated_at='2000-01-01 12:00:00.123456+00' WHERE id=$1", [source.commentId]);
    const pending = (await pool.query('SELECT id, updated_at::text AS ai_input_version FROM record_comments WHERE id=$1', [source.commentId])).rows[0];
    const mismatched = await withTransaction(tx => persistPendingCommentAiClassification(tx, { tenantId, comment: pending, classification: rejectedAi }));
    assert.equal(mismatched, null);
    const truncated = await withTransaction(tx => persistPendingCommentAiClassification(tx, {
      tenantId: owner, comment: { ...pending, ai_input_version: new Date(pending.ai_input_version).toISOString() }, classification: rejectedAi,
    }));
    assert.equal(truncated, null);
    const result = await withTransaction(tx => persistPendingCommentAiClassification(tx, { tenantId: owner, comment: pending, classification: rejectedAi }));
    assert.equal(result.id, source.commentId);
    assert.equal(result.ai_summary, rejectedAi.ai_summary);
    assert.ok(result.ai_classified_at);
  });
});
