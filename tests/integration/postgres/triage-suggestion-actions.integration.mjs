import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {runMigrations} from '../../../server/db/migrate.js';
import {getPool,closePool} from '../../../server/db/pool.js';
import {createApp} from '../../../server/app.js';
import {hashPassword} from '../../../server/services/auth-service.js';
import {refreshTriageSuggestion} from '../../../server/services/triage-suggestions.js';
import {ACTIVE_QUEUE_CONDITION,appendTriageDateFilters} from '../../../server/routes/triage.js';

const ai={contentTopic:'gm_other',relevance:'relevant',currentKeywordMatch:'irrelevant',category:'brand_image',sentiment:'positive',relevanceReason:'只谈品牌外观，未涉及搜索词相关功能'};
test('suggestion actions preserve workflow scope, human history, tenant isolation and reversible acceptance',async t=>{
  validatePostgresIntegrationTarget({testDatabaseUrl:process.env.TEST_DATABASE_URL,databaseUrl:process.env.DATABASE_URL,requireDatabaseUrl:true});
  await runMigrations();const pool=getPool(),tenants=[],users=[];let server;
  t.after(async()=>{if(server)await new Promise(r=>server.close(r));if(users.length)await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users]);if(tenants.length)await pool.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])',[tenants]);await closePool();});
  for(let i=0;i<2;i++)tenants.push((await pool.query('INSERT INTO tenants(name) VALUES($1) RETURNING id',[`Suggestions actions ${randomUUID()}`])).rows[0].id);
  const [tenant,other]=tenants;
  await pool.query("INSERT INTO tenant_settings(tenant_id,key,value) VALUES($1,'triage_non_monitor_suggestion_enabled','true')",[tenant]);
  const email=`suggestions-${randomUUID()}@integration.invalid`,password='suggestions-integration-password';
  const user=(await pool.query("INSERT INTO users(email,name,password_hash,status,is_internal,global_role,must_change_password) VALUES($1,'Suggestion analyst',$2,'active',false,'',false) RETURNING id",[email,hashPassword(password)])).rows[0].id;users.push(user);
  await pool.query("INSERT INTO user_memberships(user_id,tenant_id,role,status) VALUES($1,$2,'tenant_analyst','active')",[user,tenant]);
  server=await new Promise(resolve=>{const instance=createApp({logger:{log(){},error(){}}}).listen(0,'127.0.0.1',()=>resolve(instance));});
  const base=`http://127.0.0.1:${server.address().port}`;
  const login=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password})});assert.equal(login.status,200);
  const headers={authorization:`Bearer ${(await login.json()).token}`,'x-tenant-id':tenant,'content-type':'application/json'};
  async function request(path,{method='GET',body,tenantId=tenant,status=200,authorization=headers.authorization}={}){
    const response=await fetch(`${base}/api/triage${path}`,{method,headers:{...headers,authorization,'x-tenant-id':tenantId},...(body?{body:JSON.stringify(body)}:{})});
    const result=await response.json();assert.equal(response.status,status,JSON.stringify(result));return result;
  }
  async function record({title='凯迪拉克外观与美好生活分享',platform='douyin',suggest=true,tenantId=tenant}={}){
    const id=randomUUID();await pool.query(`INSERT INTO records(id,tenant_id,platform,external_id,title,content,record_type,business_visibility,ai_result)
      VALUES($1::uuid,$2,$3,($1::uuid)::text,$4,'今日分享新车外观和出行生活的美好瞬间','keyword_notes','eligible',$5)`,[id,tenantId,platform,title,ai]);
    if(suggest){const generated=await refreshTriageSuggestion({tenantId,recordId:id});assert.equal(generated.status,'open');}return id;
  }
  const row=id=>pool.query('SELECT * FROM record_triage WHERE tenant_id=$1 AND record_id=$2',[tenant,id]).then(r=>r.rows[0]);
  const suggestion=id=>pool.query('SELECT * FROM record_triage_suggestions WHERE tenant_id=$1 AND record_id=$2',[tenant,id]).then(r=>r.rows[0]);

  await t.test('labels, filter count and all-selection obey the same filters without changing pending count',async()=>{
    const a=await record({platform:'xiaohongshu'}),b=await record({platform:'xiaohongshu',suggest:false});
    await record();
    const all=await request('/records?queue=active&platform=xiaohongshu');assert.equal(all.pagination.total,2);assert.equal(all.suggestions.count,1);
    assert.equal(all.records.find(r=>r.id===a).triage_status,'unhandled');assert.equal(all.records.find(r=>r.id===a).triageSuggestion.suggestion,'non_monitor');assert.equal(all.records.find(r=>r.id===b).triageSuggestion,null);
    const filtered=await request('/records?queue=active&platform=xiaohongshu&suggestion=non_monitor');assert.equal(filtered.pagination.total,1);assert.equal(filtered.suggestions.count,1);
    const selection=await request('/records?queue=active&platform=xiaohongshu&suggestion=non_monitor&selection=1');assert.deepEqual(selection.selection.map(r=>r.id),[a]);
    const detail=await request(`/records/${a}/suggestion`);assert.ok(detail.suggestion.reason.summary);
    await request(`/records/${a}/suggestion`,{tenantId:other,status:403});
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS count FROM records r LEFT JOIN record_triage rt ON rt.tenant_id=r.tenant_id AND rt.record_id=r.id WHERE r.tenant_id=$1 AND (${ACTIVE_QUEUE_CONDITION})`,[tenant])).rows[0].count,3);
  });
  await t.test('batch acceptance records actual actor/day and undo restores state and suggestion; excluded IDs stay pending',async()=>{
    const a=await record(),excluded=await record();
    const result=await request('/records/batch',{method:'PATCH',body:{ids:[a],status:'reviewed_non_monitor',source:'suggestion'}});
    assert.equal((await row(a)).status,'reviewed_non_monitor');assert.equal((await suggestion(a)).resolution,'accepted');assert.equal((await suggestion(a)).resolved_by,user);
    assert.equal(await row(excluded),undefined);assert.equal((await suggestion(excluded)).resolution,null);
    assert.deepEqual(result.acceptedIds,[a]);assert.ok(result.undoId);assert.ok(Date.parse(result.undoExpiresAt)>Date.now());
    const audit=(await pool.query("SELECT * FROM audit_logs WHERE tenant_id=$1 AND target_id=$2 AND action='record.triage_batch_updated'",[tenant,a])).rows[0];
    assert.equal(audit.actor_user_id,user);assert.equal(audit.metadata.source,'suggestion');assert.equal(audit.metadata.ruleVersion,'non_monitor_f_v1');assert.equal(audit.metadata.previous[a].status,'unhandled');
    const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const params=[tenant,a],where=appendTriageDateFilters('WHERE r.tenant_id=$1 AND r.id=$2',params,{handledFrom:day,handledTo:day});
    assert.equal((await pool.query(`SELECT r.id FROM records r ${where}`,params)).rows.length,1);
    const undone=await request('/suggestions/undo',{method:'POST',body:{undoId:result.undoId}});assert.deepEqual(undone.restoredIds,[a]);assert.equal(await row(a),undefined);assert.equal((await suggestion(a)).resolution,null);
    const again=await request('/suggestions/undo',{method:'POST',body:{undoId:result.undoId}});assert.equal(again.restored,0);
  });
  await t.test('mixed reviewed split is atomic; reviewed-all rejects suggestions; other statuses reject',async()=>{
    const a=await record(),b=await record({suggest:false});
    const result=await request('/records/batch',{method:'PATCH',body:{ids:[a,b],status:'reviewed',suggestionMode:'split'}});
    assert.equal(result.statusById[a],'reviewed_non_monitor');assert.equal(result.statusById[b],'reviewed');assert.equal((await suggestion(a)).resolution,'accepted');
    await request('/suggestions/undo',{method:'POST',body:{undoId:result.undoId}});assert.equal(await row(a),undefined);assert.equal(await row(b),undefined);
    await request('/records/batch',{method:'PATCH',body:{ids:[a,b],status:'reviewed'}});assert.equal((await row(a)).status,'reviewed');assert.equal((await suggestion(a)).resolution,'rejected');
    const c=await record();await request('/records/batch',{method:'PATCH',body:{ids:[c],status:'negative_cold'}});assert.equal((await suggestion(c)).resolution,'rejected');
    const stats=(await request('/records?queue=triage')).suggestions.stats;assert.ok(stats.accepted>=0);assert.ok(stats.rejected>=2);assert.equal(stats.acceptanceRate,stats.accepted/(stats.accepted+stats.rejected));
  });
  await t.test('drawer rejection only resolves suggestion; single explicit status resolves, priority-only does not',async()=>{
    const a=await record();await request(`/records/${a}`,{method:'PATCH',body:{priority:'high'}});assert.equal((await suggestion(a)).resolution,null);
    await request(`/records/${a}/suggestion/reject`,{method:'POST',body:{}});assert.equal((await row(a)).status,'unhandled');assert.equal((await suggestion(a)).resolution,'rejected');
    const b=await record();await request(`/records/${b}`,{method:'PATCH',body:{status:'replied'}});assert.equal((await suggestion(b)).resolution,'rejected');
    const c=await record();await request(`/records/${c}`,{method:'PATCH',body:{status:'reviewed_non_monitor'}});assert.equal((await suggestion(c)).resolution,'accepted');
  });
  await t.test('stale all-accept is rejected atomically and tenant setting hides/blocks suggestions',async()=>{
    const a=await record(),b=await record();await request(`/records/${b}/suggestion/reject`,{method:'POST',body:{}});
    await request('/records/batch',{method:'PATCH',body:{ids:[a,b],status:'reviewed_non_monitor',source:'suggestion'},status:409});assert.equal(await row(a),undefined);
    await pool.query("UPDATE tenant_settings SET value='false' WHERE tenant_id=$1 AND key='triage_non_monitor_suggestion_enabled'",[tenant]);
    const list=await request('/records?queue=active&suggestion=non_monitor');assert.equal(list.pagination.total,0);assert.equal(list.suggestions.enabled,false);
    assert.equal((await request(`/records/${a}/suggestion`)).suggestion,null);
    await request('/records/batch',{method:'PATCH',body:{ids:[a],status:'reviewed_non_monitor',source:'suggestion'},status:409});
    await pool.query("UPDATE tenant_settings SET value='true' WHERE tenant_id=$1 AND key='triage_non_monitor_suggestion_enabled'",[tenant]);
  });
  await t.test('another authorized actor in the same tenant cannot use the acceptance undo receipt',async()=>{
    const colleagueEmail=`suggestions-colleague-${randomUUID()}@integration.invalid`;
    const colleague=(await pool.query("INSERT INTO users(email,name,password_hash,status,is_internal,global_role,must_change_password) VALUES($1,'Other analyst',$2,'active',false,'',false) RETURNING id",
      [colleagueEmail,hashPassword(password)])).rows[0].id;users.push(colleague);
    await pool.query("INSERT INTO user_memberships(user_id,tenant_id,role,status) VALUES($1,$2,'tenant_analyst','active')",[colleague,tenant]);
    const signedIn=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:colleagueEmail,password})});
    assert.equal(signedIn.status,200);
    const authorization=`Bearer ${(await signedIn.json()).token}`;
    const a=await record();
    const accepted=await request('/records/batch',{method:'PATCH',body:{ids:[a],status:'reviewed_non_monitor',source:'suggestion'}});
    // The colleague can see the tenant's record; this is actor scoping, not a tenant-access rejection.
    assert.equal((await request(`/records/${a}/suggestion`,{authorization})).ok,true);
    await request('/suggestions/undo',{method:'POST',body:{undoId:accepted.undoId},authorization,status:409});
    assert.equal((await row(a)).status,'reviewed_non_monitor');assert.equal((await suggestion(a)).resolved_by,user);
    assert.equal((await request('/suggestions/undo',{method:'POST',body:{undoId:accepted.undoId}})).restored,1);
    assert.equal(await row(a),undefined);assert.equal((await suggestion(a)).resolution,null);
  });
  await t.test('two concurrent undo requests restore the batch exactly once',async()=>{
    const a=await record(),b=await record();
    const accepted=await request('/records/batch',{method:'PATCH',body:{ids:[a,b],status:'reviewed_non_monitor',source:'suggestion'}});
    const blocker=await pool.connect();let pending;
    try {
      await blocker.query('BEGIN');await blocker.query('SELECT id FROM records WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[[a,b]]);
      pending=Promise.all([1,2].map(()=>request('/suggestions/undo',{method:'POST',body:{undoId:accepted.undoId}})));
      let waiting=0;
      for(let attempt=0;attempt<100;attempt++) {
        waiting=Number((await pool.query(`SELECT COUNT(*) AS count FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM records r%'`)).rows[0].count);
        if(waiting>=2)break;
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.ok(waiting>=2,'both HTTP requests reached the record lock before either can restore');
      await blocker.query('COMMIT');
      const results=await pending;
      assert.deepEqual(results.map(result=>result.restored).sort((x,y)=>x-y),[0,2]);
      assert.equal(new Set(results.flatMap(result=>result.restoredIds)).size,2);
      for(const id of [a,b]) {assert.equal(await row(id),undefined);assert.equal((await suggestion(id)).resolution,null);}
      const audits=(await pool.query(`SELECT target_id,COUNT(*)::int AS count FROM audit_logs
        WHERE tenant_id=$1 AND action='record.triage_updated' AND metadata->>'undoId'=$2 GROUP BY target_id`,[tenant,accepted.undoId])).rows;
      assert.equal(audits.length,2);assert.ok(audits.every(audit=>audit.count===1));
    } finally {
      await blocker.query('ROLLBACK');blocker.release();
      if(pending)await pending;
    }
  });
  await t.test('30-day statistics count accepted rejected and superseded exactly and exclude older or foreign resolutions',async()=>{
    const stats=async()=>(await request('/records?queue=triage')).suggestions.stats;
    const before=await stats();
    const accepted=await Promise.all([1,2,3].map(()=>record()));
    const rejected=await Promise.all([1,2].map(()=>record()));
    const superseded=await Promise.all([1,2].map(()=>record()));
    await request('/records/batch',{method:'PATCH',body:{ids:accepted,status:'reviewed_non_monitor',source:'suggestion'}});
    await request('/records/batch',{method:'PATCH',body:{ids:rejected,status:'reviewed'}});
    for(const id of superseded) {
      await pool.query('UPDATE records SET ai_result=$2 WHERE tenant_id=$1 AND id=$3',[tenant,{...ai,sentiment:'negative'},id]);
      assert.equal((await refreshTriageSuggestion({tenantId:tenant,recordId:id})).status,'superseded');
    }
    const added={accepted:before.accepted+3,rejected:before.rejected+2,superseded:before.superseded+2};
    assert.deepEqual(await stats(),{...added,acceptanceRate:added.accepted/(added.accepted+added.rejected)});

    const older=[accepted[0],rejected[0],superseded[0]];
    await pool.query("UPDATE record_triage_suggestions SET resolved_at=clock_timestamp()-interval '30 days 1 second' WHERE tenant_id=$1 AND record_id=ANY($2::uuid[])",[tenant,older]);
    const stillRecent=[accepted[1],rejected[1],superseded[1]];
    await pool.query("UPDATE record_triage_suggestions SET resolved_at=clock_timestamp()-interval '30 days'+interval '1 minute' WHERE tenant_id=$1 AND record_id=ANY($2::uuid[])",[tenant,stillRecent]);
    const foreign=await record({tenantId:other,suggest:false});
    await pool.query(`INSERT INTO record_triage_suggestions(tenant_id,record_id,suggestion,rule_version,reason,resolution,resolved_at)
      VALUES($1,$2,'non_monitor','non_monitor_f_v1','{}'::jsonb,'accepted',clock_timestamp())`,[other,foreign]);
    const recent={accepted:before.accepted+2,rejected:before.rejected+1,superseded:before.superseded+1};
    assert.deepEqual(await stats(),{...recent,acceptanceRate:recent.accepted/(recent.accepted+recent.rejected)});
  });
  await t.test('undo rechecks its database deadline after waiting for a concurrent record lock',async()=>{
    const a=await record();const accepted=await request('/records/batch',{method:'PATCH',body:{ids:[a],status:'reviewed_non_monitor',source:'suggestion'}});
    await pool.query("UPDATE audit_logs SET metadata=metadata||jsonb_build_object('undoExpiresAt',clock_timestamp()+interval '300 milliseconds') WHERE tenant_id=$1 AND metadata->>'undoId'=$2",[tenant,accepted.undoId]);
    const blocker=await pool.connect();
    try {
      await blocker.query('BEGIN');await blocker.query('SELECT id FROM records WHERE id=$1 FOR UPDATE',[a]);
      const pending=request('/suggestions/undo',{method:'POST',body:{undoId:accepted.undoId},status:409});
      await new Promise(resolve=>setTimeout(resolve,450));await blocker.query('COMMIT');await pending;
      assert.equal((await row(a)).status,'reviewed_non_monitor');assert.equal((await suggestion(a)).resolution,'accepted');
    } finally {await blocker.query('ROLLBACK');blocker.release();}
  });
  await t.test('undo cannot overwrite subsequent human edits, another tenant, or an expired receipt',async()=>{
    const a=await record();const first=await request('/records/batch',{method:'PATCH',body:{ids:[a],status:'reviewed_non_monitor',source:'suggestion'}});
    await request('/suggestions/undo',{method:'POST',body:{undoId:first.undoId},tenantId:other,status:403});
    await request(`/records/${a}`,{method:'PATCH',body:{priority:'urgent'}});
    const conflict=await request('/suggestions/undo',{method:'POST',body:{undoId:first.undoId}});assert.deepEqual(conflict.skipped,[a]);assert.equal((await row(a)).priority,'urgent');assert.equal((await suggestion(a)).resolution,'accepted');
    const b=await record();const second=await request('/records/batch',{method:'PATCH',body:{ids:[b],status:'reviewed_non_monitor',source:'suggestion'}});
    await pool.query("UPDATE audit_logs SET metadata=metadata||jsonb_build_object('undoExpiresAt',clock_timestamp()-interval '1 second') WHERE tenant_id=$1 AND metadata->>'undoId'=$2",[tenant,second.undoId]);
    await request('/suggestions/undo',{method:'POST',body:{undoId:second.undoId},status:409});assert.equal((await row(b)).status,'reviewed_non_monitor');
  });
});
