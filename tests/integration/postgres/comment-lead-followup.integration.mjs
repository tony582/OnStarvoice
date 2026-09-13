import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validatePostgresIntegrationTarget } from '../../../scripts/lib/postgres-integration-target.mjs';

test('comment follow-ups preserve history, serialize transitions, protect tenant data and roll back with failed history writes', async t => {
  validatePostgresIntegrationTarget({
    testDatabaseUrl: process.env.TEST_DATABASE_URL, databaseUrl: process.env.DATABASE_URL, requireDatabaseUrl: true,
  });
  const { runMigrations } = await import('../../../server/db/migrate.js');
  const { getPool, closePool } = await import('../../../server/db/pool.js');
  const { withTransaction } = await import('../../../server/db/init.js');
  const { mutateCommentLead, getCommentLeadActivities } = await import('../../../server/services/comment-lead-followup.js');
  const { upsertCommentLeadForComment } = await import('../../../server/services/comment-leads.js');
  await runMigrations();
  const pool = getPool();
  const tenants = [];
  t.after(async () => {
    try { if (tenants.length) await pool.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [tenants]); }
    finally { await closePool(); }
  });
  for (let i = 0; i < 2; i++) {
    tenants.push((await pool.query('INSERT INTO tenants(name) VALUES($1) RETURNING id', [`Comment follow-up ${randomUUID()}`])).rows[0].id);
  }
  const [tenantId, otherTenantId] = tenants;
  const record = (await pool.query(`
    INSERT INTO records(tenant_id,platform,external_id,title,business_visibility)
    VALUES($1,'douyin',$2,'服务费用讨论','eligible') RETURNING *
  `, [tenantId, randomUUID()])).rows[0];
  const comment = (await pool.query(`
    INSERT INTO record_comments(tenant_id,record_id,platform,content,is_negative,risk_level)
    VALUES($1,$2,'douyin','这么贴心的服务，谁还敢买啊',true,'low') RETURNING *
  `, [tenantId, record.id])).rows[0];
  const lead = (await pool.query(`
    INSERT INTO comment_leads(tenant_id,record_id,comment_id,lead_type,note,handled_name,handled_at)
    VALUES($1,$2,$3,'sales_intent','原先已经核实为反讽','先前处理人','2026-09-10T02:00:00Z') RETURNING *
  `, [tenantId, record.id, comment.id])).rows[0];
  const id = lead.id;
  const actor = { id: randomUUID(), name: '跟进测试员' };
  const readLead = async () => (await pool.query('SELECT * FROM comment_leads WHERE tenant_id=$1 AND id=$2', [tenantId, id])).rows[0];
  const activity = () => getCommentLeadActivities({ tenantId, id });

  await t.test('legacy note backfill is idempotent and retains the original author, date and column', async () => {
    const sql = await readFile(new URL('../../../server/db/migrations/085_comment_lead_followups.sql', import.meta.url), 'utf8');
    await pool.query(sql);
    await pool.query(sql);
    const rows = await activity();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'legacy_note');
    assert.equal(rows[0].body, lead.note);
    assert.equal(rows[0].actor_name, '先前处理人');
    assert.equal(new Date(rows[0].created_at).toISOString(), '2026-09-10T02:00:00.000Z');
    assert.equal((await readLead()).note, lead.note);
  });

  await t.test('tenant mismatches and invalid actions cannot mutate or create history', async () => {
    const before = await readLead();
    await assert.rejects(mutateCommentLead({ tenantId: otherTenantId, id, status: 'following', actor }), { status: 404 });
    assert.deepEqual(await getCommentLeadActivities({ tenantId: otherTenantId, id }), []);
    for (const patch of [{ status: 'ticketed' }, { status: 'invalid' }, { priority: 'invalid' }, { leadType: 'brand_risk' }, { note: ' ' }, { note: '字'.repeat(4001) }, {}]) {
      await assert.rejects(mutateCommentLead({ tenantId, id, actor, ...patch }), { status: 400 });
    }
    await assert.rejects(pool.query(`
      INSERT INTO comment_lead_activities(tenant_id,lead_id,action,note) VALUES($1,$2,'note_added','wrong tenant')
    `, [otherTenantId, id]), { code: '23503' });
    assert.equal((await activity()).length, 1);
    assert.deepEqual(await readLead(), before);
  });

  await t.test('concurrent notes append without replacing an earlier note or handled date', async () => {
    const previousHandledAt = (await readLead()).handled_at;
    await Promise.all([
      mutateCommentLead({ tenantId, id, note: '第一条跟进：待核实实际诉求', actor }),
      mutateCommentLead({ tenantId, id, note: '第二条跟进：已查看原文', actor: { name: '复核员' } }),
    ]);
    const rows = await activity();
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.filter(row => row.action === 'note_added').map(row => row.body).sort(), ['第一条跟进：待核实实际诉求', '第二条跟进：已查看原文'].sort());
    assert.equal((await readLead()).note, lead.note);
    assert.deepEqual((await readLead()).handled_at, previousHandledAt);
  });

  await t.test('concurrent status transitions form a complete ordered chain and no-op patches add no event', async () => {
    await Promise.all([
      mutateCommentLead({ tenantId, id, status: 'following', actor }),
      mutateCommentLead({ tenantId, id, status: 'resolved', actor }),
    ]);
    const rows = (await activity()).filter(row => row.action === 'status_changed').reverse();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].metadata.status_from, 'new');
    assert.equal(rows[1].metadata.status_from, rows[0].metadata.status_to);
    const after = await readLead();
    assert.equal(after.status, rows[1].metadata.status_to);
    assert.equal(after.handled_by, actor.id);
    assert.equal(after.handled_name, actor.name);
    await mutateCommentLead({ tenantId, id, status: after.status, priority: after.priority, actor });
    assert.deepEqual(await readLead(), after);
    assert.equal((await activity()).length, 5);
  });

  await t.test('human correction keeps its reason and survives later AI collection', async () => {
    const corrected = await mutateCommentLead({ tenantId, id, leadType: 'brand_risk', correctionReason: '评论为反讽，没有真实购买诉求', priority: 'high', actor });
    assert.equal(corrected.lead_type, 'brand_risk');
    assert.equal(corrected.manual_lead_type, 'brand_risk');
    assert.equal(corrected.manual_reason, '评论为反讽，没有真实购买诉求');
    const changed = (await activity()).find(row => row.action === 'classification_corrected');
    assert.equal(changed.metadata.lead_type_from, 'sales_intent');
    assert.equal(changed.metadata.lead_type_to, 'brand_risk');
    assert.equal(changed.actor_name, actor.name);
    await withTransaction(tx => upsertCommentLeadForComment(tx, {
      tenantId, record, comment: { ...comment, content: '想了解购买价格', ai_result: {
        salesIntent: true, salesIntentStatus: 'confirmed', salesIntentConfidence: 0.95,
        salesIntentEvidence: ['想了解购买价格'], expressionType: 'literal', salesActor: 'buyer', salesTargetMatch: 'relevant',
      } },
    }));
    const refreshed = await readLead();
    assert.equal(refreshed.lead_type, 'brand_risk');
    assert.equal(refreshed.manual_lead_type, 'brand_risk');
    assert.equal(refreshed.manual_reason, corrected.manual_reason);
    assert.equal(refreshed.ai_result.salesIntent, true);
    assert.equal(refreshed.note, lead.note);
    assert.equal((await activity()).length, 7);
  });

  await t.test('a failed activity insert rolls back the associated priority update', async () => {
    const before = await readLead();
    const historyCount = (await activity()).length;
    const constraint = `followup_test_${randomUUID().replaceAll('-', '')}`;
    // Test-only constraint targets this random lead and does not affect other fixtures.
    await pool.query(`ALTER TABLE comment_lead_activities ADD CONSTRAINT ${constraint} CHECK (lead_id <> '${id}'::uuid OR action <> 'priority_changed') NOT VALID`);
    try {
      await assert.rejects(mutateCommentLead({ tenantId, id, priority: before.priority === 'urgent' ? 'low' : 'urgent', actor }), { code: '23514' });
      assert.deepEqual(await readLead(), before);
      assert.equal((await activity()).length, historyCount);
    } finally {
      await pool.query(`ALTER TABLE comment_lead_activities DROP CONSTRAINT ${constraint}`);
    }
  });
});
