import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {runMigrations} from '../../../server/db/migrate.js';
import {getPool,closePool} from '../../../server/db/pool.js';
import {withTransaction} from '../../../server/db/init.js';
import {persistRecordClassification} from '../../../server/services/ai-labeler.js';
import {resolveMonitoringIntent,resolveTenantMonitoringScope} from '../../../server/services/monitoring-intent.js';
import {DEFAULT_SUGGESTION_TENANT_ID,TRIAGE_SUGGESTION_SETTING} from '../../../shared/triage-suggestions.mjs';
import {
  refreshTriageSuggestion,resolveTriageSuggestions,reopenTriageSuggestions,isTriageSuggestionEnabled,
  backfillTriageSuggestions,TRIAGE_SUGGESTION_ACTIVE_SQL,
} from '../../../server/services/triage-suggestions.js';

const ai={contentTopic:'gm_other',relevance:'relevant',currentKeywordMatch:'irrelevant',category:'brand_image',
  sentiment:'neutral',relevanceReason:'上汽通用品牌动态，未涉及监测主题，与关键词不匹配。',intent:'share',confidence:.9};

test('non-monitor suggestions are independent labels with human-controlled resolution and safe backfill',async t=>{
  validatePostgresIntegrationTarget({testDatabaseUrl:process.env.TEST_DATABASE_URL,databaseUrl:process.env.DATABASE_URL,requireDatabaseUrl:true});
  await runMigrations();
  const pool=getPool();t.after(closePool);
  const query=async(sql,values=[])=>(await pool.query(sql,values)).rows;
  async function fixture(st,{tenantId=randomUUID(),enabled=true}={}) {
    await query('INSERT INTO tenants(id,name) VALUES($1,$2)',[tenantId,`suggestions-${randomUUID()}`]);
    const [user]=await query('INSERT INTO users(email,name,password_hash) VALUES($1,$2,$3) RETURNING id',
      [`${randomUUID()}@example.invalid`,'Suggestion operator','not-a-password']);
    st.after(async()=>{await query('DELETE FROM tenants WHERE id=$1',[tenantId]);await query('DELETE FROM users WHERE id=$1',[user.id]);});
    async function setting(value) {
      await query(`INSERT INTO tenant_settings(tenant_id,key,value) VALUES($1,$2,$3)
        ON CONFLICT(tenant_id,key) DO UPDATE SET value=excluded.value`,[tenantId,TRIAGE_SUGGESTION_SETTING,String(value)]);
    }
    if(enabled!==null) await setting(enabled);
    async function record({status,archived=false,title='别克全新车型正式亮相',content='周末大家一起来欣赏新车展示',
      aiResult=ai,visibility='eligible',type='keyword_notes',overrides={},keyword='别克'}={}) {
      const [row]=await query(`INSERT INTO records(tenant_id,external_id,platform,record_type,title,content,keyword,
        business_visibility,ai_result,manual_overrides) VALUES($1,$2,'douyin',$3,$4,$5,$6,$7,$8,$9)
        RETURNING *,ai_labeled_at::text AS classification_version`,[tenantId,randomUUID(),type,title,content,keyword,visibility,aiResult,overrides]);
      if(status || archived) await query(`INSERT INTO record_triage(tenant_id,record_id,status,archived_at)
        VALUES($1,$2,$3,CASE WHEN $4::boolean THEN now() ELSE NULL END)`,[tenantId,row.id,status || 'unhandled',archived]);
      return row;
    }
    const suggestion=async id=>(await query('SELECT *,resolved_at::text AS resolved_at FROM record_triage_suggestions WHERE tenant_id=$1 AND record_id=$2',[tenantId,id]))[0];
    return {tenantId,userId:user.id,record,suggestion,setting,
      refresh:recordId=>refreshTriageSuggestion({tenantId,recordId}),
      resolve:(recordIds,status)=>withTransaction(tx=>resolveTriageSuggestions(tx,{tenantId,recordIds,status,userId:user.id}))};
  }

  await t.test('classification commit creates the suggestion without creating triage or handling audit entries',async st=>{
    const f=await fixture(st),row=await f.record({aiResult:{}});
    const outcome=await persistRecordClassification({record:row,observedKeywords:['别克'],labeled:{result:ai,
      provider:'fixture',model:'offline',intent:resolveMonitoringIntent('别克'),tenantScope:resolveTenantMonitoringScope({brandName:'安吉星'})}});
    assert.ok(outcome?.persisted);
    const suggested=await f.suggestion(row.id);
    assert.equal(suggested.suggestion,'non_monitor');assert.equal(suggested.resolved_at,null);
    assert.ok(suggested.reason.summary);
    assert.equal((await query('SELECT id FROM record_triage WHERE tenant_id=$1',[f.tenantId])).length,0);
    assert.equal((await query('SELECT id FROM audit_logs WHERE tenant_id=$1',[f.tenantId])).length,0);
    const [saved]=await query('SELECT ai_labeled_at,sentiment FROM records WHERE id=$1',[row.id]);
    assert.ok(saved.ai_labeled_at);assert.equal(saved.sentiment,'neutral');
  });

  await t.test('accepted and rejected suggestions stay closed after AI relabeling; only open rows resolve',async st=>{
    const f=await fixture(st),accepted=await f.record(),rejected=await f.record();
    await f.refresh(accepted.id);await f.refresh(rejected.id);
    const [a]=await f.resolve([accepted.id],'reviewed_non_monitor');
    const [r]=await f.resolve([rejected.id],'rejected');
    assert.equal(a.resolution,'accepted');assert.equal(r.resolution,'rejected');assert.equal(a.resolved_by,f.userId);
    assert.equal((await f.resolve([accepted.id,rejected.id],'reviewed')).length,0);
    assert.equal((await f.refresh(accepted.id)).status,'suppressed');
    assert.equal((await f.refresh(rejected.id)).status,'suppressed');
    assert.equal((await f.suggestion(accepted.id)).resolution,'accepted');
    assert.equal((await f.suggestion(rejected.id)).resolution,'rejected');
    assert.equal((await query('SELECT id FROM record_triage WHERE tenant_id=$1',[f.tenantId])).length,0,'dismissal alone never changes status');
  });

  await t.test('other manual statuses reject open suggestions and never overwrite previous resolution',async st=>{
    const f=await fixture(st);
    for(const status of ['reviewed','replied','negative_feishu','negative_cold','negative_comment','unhandled']) {
      const row=await f.record();await f.refresh(row.id);
      const [resolved]=await f.resolve([row.id],status);
      assert.equal(resolved.resolution,'rejected',status);
      assert.equal(resolved.resolved_by,f.userId);
    }
  });

  await t.test('AI mismatch supersedes an open suggestion and a later match can reopen it',async st=>{
    const f=await fixture(st),row=await f.record();await f.refresh(row.id);
    await query('UPDATE records SET ai_result=$2 WHERE id=$1',[row.id,{...ai,sentiment:'negative'}]);
    assert.equal((await f.refresh(row.id)).status,'superseded');
    assert.equal((await f.suggestion(row.id)).resolution,'superseded');
    await query('UPDATE records SET ai_result=$2 WHERE id=$1',[row.id,ai]);
    assert.equal((await f.refresh(row.id)).status,'open');
    assert.equal((await f.suggestion(row.id)).resolved_at,null);
  });

  await t.test('undo reopens exactly the recorded resolution, including PostgreSQL microseconds',async st=>{
    const f=await fixture(st),row=await f.record();await f.refresh(row.id);
    const snapshots=await f.resolve([row.id],'reviewed_non_monitor');
    assert.equal(typeof snapshots[0].resolved_at,'string');
    const wire=JSON.parse(JSON.stringify(snapshots));
    assert.equal((await withTransaction(tx=>reopenTriageSuggestions(tx,{tenantId:f.tenantId,resolutions:wire}))).length,1);
    assert.equal((await f.suggestion(row.id)).resolution,null);
    const second=await f.resolve([row.id],'rejected');
    assert.equal((await withTransaction(tx=>reopenTriageSuggestions(tx,{tenantId:f.tenantId,resolutions:wire}))).length,0,'stale undo must not overwrite a later rejection');
    await query(`INSERT INTO record_triage(tenant_id,record_id,status) VALUES($1,$2,'reviewed')`,[f.tenantId,row.id]);
    assert.equal((await withTransaction(tx=>reopenTriageSuggestions(tx,{tenantId:f.tenantId,resolutions:second}))).length,0,'handled content cannot regain an open suggestion');
  });

  await t.test('current status and admission restrict refresh and backfill, and dry-run changes no rows',async st=>{
    const f=await fixture(st);
    const pending=await f.record(),pendingExplicit=await f.record({status:'unhandled'});
    const excluded=[await f.record({status:'replied'}),await f.record({status:'reviewed'}),await f.record({status:'reviewed_non_monitor'}),
      await f.record({archived:true}),await f.record({type:'official_content'}),await f.record({type:'blogger_profile'}),
      await f.record({visibility:'filtered_out'}),await f.record({overrides:{relevance:'irrelevant'}}),
      await f.record({keyword:'别克哨兵',title:'全新车型正式亮相'})];
    // Historical sentry content without brand evidence remains outside the current work list.
    await query(`UPDATE records SET created_at='2026-01-01'::timestamptz WHERE id=$1`,[excluded.at(-1).id]);
    const negative=await f.record({aiResult:{...ai,sentiment:'negative'}});
    for(const row of excluded) assert.equal((await f.refresh(row.id)).status,'not_matched');
    const dry=await backfillTriageSuggestions({tenantId:f.tenantId});
    assert.equal(dry.dryRun,true);assert.equal(dry.wouldCreate,2);assert.equal(dry.matched,2);assert.equal(dry.scanned,3);
    assert.equal((await query('SELECT * FROM record_triage_suggestions WHERE tenant_id=$1',[f.tenantId])).length,0);
    const applied=await backfillTriageSuggestions({tenantId:f.tenantId,apply:true});
    assert.equal(applied.applied,2);
    assert.ok(await f.suggestion(pending.id));assert.ok(await f.suggestion(pendingExplicit.id));assert.equal(await f.suggestion(negative.id),undefined);
    const second=await backfillTriageSuggestions({tenantId:f.tenantId});
    assert.equal(second.wouldCreate,0);assert.equal(second.alreadyOpen,2);
    assert.equal((await query(`SELECT count(*)::int AS n FROM records r LEFT JOIN record_triage rt ON rt.record_id=r.id AND rt.tenant_id=r.tenant_id
      WHERE r.tenant_id=$1 AND (${TRIAGE_SUGGESTION_ACTIVE_SQL})`,[f.tenantId]))[0].n,3,'adding suggestions does not change pending count');
  });

  await t.test('undo restores the pending state but supersedes a suggestion invalidated by a later AI result',async st=>{
    const f=await fixture(st),row=await f.record();await f.refresh(row.id);
    const snapshots=await withTransaction(async tx=>{
      await tx.execute(`INSERT INTO record_triage(tenant_id,record_id,status) VALUES($1,$2,'reviewed_non_monitor')`,[f.tenantId,row.id]);
      return resolveTriageSuggestions(tx,{tenantId:f.tenantId,recordIds:[row.id],status:'reviewed_non_monitor',userId:f.userId});
    });
    await query('UPDATE records SET ai_result=$2 WHERE id=$1',[row.id,{...ai,sentiment:'negative'}]);
    await f.refresh(row.id);
    assert.equal((await f.suggestion(row.id)).resolution,'accepted','a relabel must not rewrite the prior human acceptance');
    const reopened=await withTransaction(async tx=>{
      await tx.queryOne('SELECT id FROM records WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[f.tenantId,row.id]);
      await tx.execute("UPDATE record_triage SET status='unhandled' WHERE tenant_id=$1 AND record_id=$2",[f.tenantId,row.id]);
      return reopenTriageSuggestions(tx,{tenantId:f.tenantId,resolutions:JSON.parse(JSON.stringify(snapshots))});
    });
    assert.equal(reopened.length,0);
    assert.equal((await query('SELECT status FROM record_triage WHERE tenant_id=$1 AND record_id=$2',[f.tenantId,row.id]))[0].status,'unhandled');
    const stale=await f.suggestion(row.id);
    assert.equal(stale.resolution,'superseded');assert.equal(stale.resolved_by,null);assert.ok(stale.resolved_at);
  });

  await t.test('tenant switch defaults and isolation apply to refresh, backfill, resolve and undo',async st=>{
    const enabled=await fixture(st,{tenantId:DEFAULT_SUGGESTION_TENANT_ID,enabled:null});
    const other=await fixture(st,{enabled:null});
    assert.equal(await withTransaction(tx=>isTriageSuggestionEnabled(tx,enabled.tenantId)),true);
    assert.equal(await withTransaction(tx=>isTriageSuggestionEnabled(tx,other.tenantId)),false);
    const a=await enabled.record(),b=await other.record();
    assert.equal((await enabled.refresh(a.id)).status,'open');assert.equal((await other.refresh(b.id)).status,'disabled');
    assert.equal((await backfillTriageSuggestions({tenantId:other.tenantId,apply:true})).applied,0);
    assert.equal((await other.resolve([a.id],'reviewed_non_monitor')).length,0);
    assert.equal((await other.refresh(a.id)).status,'not_found');
    await enabled.setting(false);assert.equal((await enabled.refresh(a.id)).status,'disabled');
    await other.setting(true);assert.equal((await other.refresh(b.id)).status,'open');
    const snapshots=await other.resolve([b.id],'reviewed_non_monitor');
    assert.equal((await withTransaction(tx=>reopenTriageSuggestions(tx,{tenantId:enabled.tenantId,resolutions:snapshots}))).length,0);
  });

  await t.test('a human decision committed while refresh waits wins the record lock',async st=>{
    const f=await fixture(st),row=await f.record();
    const client=await pool.connect();
    try {
      await client.query('BEGIN');await client.query('SELECT id FROM records WHERE id=$1 FOR UPDATE',[row.id]);
      const refresh=f.refresh(row.id);
      await client.query(`INSERT INTO record_triage(tenant_id,record_id,status) VALUES($1,$2,'replied')`,[f.tenantId,row.id]);
      await client.query('COMMIT');
      assert.equal((await refresh).status,'not_matched');assert.equal(await f.suggestion(row.id),undefined);
    } finally { await client.query('ROLLBACK');client.release(); }
  });

  await t.test('dry-run works before the new migration exists and apply refuses that schema',async st=>{
    const f=await fixture(st);const record=await f.record();
    await query('ALTER TABLE record_triage_suggestions RENAME TO test_saved_triage_suggestions');
    try {
      const preview=await backfillTriageSuggestions({tenantId:f.tenantId});
      assert.equal(preview.wouldCreate,1);assert.equal(preview.samples.length,1);
      await assert.rejects(backfillTriageSuggestions({tenantId:f.tenantId,apply:true}),/TRIAGE_SUGGESTION_MIGRATION_REQUIRED/u);
      const errors=[],originalError=console.error;
      console.error=(...args)=>errors.push(args);
      try {
        assert.ok((await persistRecordClassification({record,observedKeywords:['别克'],labeled:{result:ai,
          provider:'fixture',model:'offline',intent:resolveMonitoringIntent('别克'),tenantScope:resolveTenantMonitoringScope({brandName:'安吉星'})}}))?.persisted);
      } finally { console.error=originalError; }
      assert.ok(errors.some(args=>String(args[0]).includes('Triage suggestion refresh failed')));
      assert.ok((await query('SELECT ai_labeled_at FROM records WHERE id=$1',[record.id]))[0].ai_labeled_at,
        'a failed derived suggestion must not roll back a committed classification');
    } finally { await query('ALTER TABLE test_saved_triage_suggestions RENAME TO record_triage_suggestions'); }
  });
});
