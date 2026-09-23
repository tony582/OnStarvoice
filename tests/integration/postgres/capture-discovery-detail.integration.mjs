import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {createDiscoveryRepository} from '../../../server/services/capture-discovery/repository.js';
import {createDiscoveryService} from '../../../server/services/capture-discovery/service.js';
import {dispatchDiscoveredPost} from '../../../server/services/capture-discovery/detail-dispatch.js';
import {cancelDiscoveryDemands,reconcileDiscoveryDetails} from '../../../server/services/capture-discovery/detail-lifecycle.js';
import {createAndroidControlService} from '../../../server/services/android-control/service.js';
import {createDiscoveryManagementService} from '../../../server/services/capture-discovery/management.js';

test('discovery detail pipeline against isolated PostgreSQL',async t=>{
  validatePostgresIntegrationTarget({testDatabaseUrl:process.env.TEST_DATABASE_URL,databaseUrl:process.env.DATABASE_URL,requireDatabaseUrl:true});
  const {runMigrations}=await import('../../../server/db/migrate.js');
  const {getPool,closePool}=await import('../../../server/db/pool.js');
  const {withTransaction}=await import('../../../server/db/query.js');
  const {projectNegativePatrolSnapshot,mirrorTaskSnapshot}=await import('../../../server/routes/capture-cloud.js');
  const {normalizeCloudTaskSnapshot}=await import('../../../server/services/capture-cloud.js');
  await import('../../../utils/cloud-task-agent.js');
  const {upsertCapturedRecord}=await import('../../../server/services/record-store.js');
  await runMigrations(); const pool=getPool(); t.after(closePool);
  const query=async(sql,values=[])=>(await pool.query(sql,values)).rows;
  const service=createDiscoveryService({repository:createDiscoveryRepository()});
  const management=createDiscoveryManagementService();
  async function fixture(st) {
    const [{id:tenantId}]=await query('INSERT INTO tenants(name) VALUES($1) RETURNING id',[randomUUID()]);
    process.env.ANDROID_DISCOVERY_INGEST_TENANTS=tenantId;
    st.after(async()=>{
      for (const table of ['capture_discovery_reprocess_requests','capture_discovery_run_candidates','capture_discovery_events','capture_discovery_candidates'])
        await query(`DELETE FROM ${table} WHERE tenant_id=$1`,[tenantId]);
      await query('DELETE FROM tenants WHERE id=$1',[tenantId]);
    });
    const [{id:authCodeId}]=await query('INSERT INTO auth_codes(tenant_id,code) VALUES($1,$2) RETURNING id',[tenantId,randomUUID()]);
    const [{id:authBindingId}]=await query('INSERT INTO auth_bindings(code_id,fingerprint) VALUES($1,$2) RETURNING id',[authCodeId,randomUUID()]);
    const addAgent=async capabilities=>(await query(`INSERT INTO capture_agents(tenant_id,auth_code_id,auth_binding_id,client_uuid,
      allowed_platforms,capabilities) VALUES($1,$2,$3,$4,ARRAY['douyin'],$5) RETURNING *`,[tenantId,authCodeId,authBindingId,randomUUID(),capabilities]))[0];
    const mobile=await addAgent({agentKind:'android_mobile',mobileSearchDiscoveryV1:true});
    const browser=await addAgent({remoteTaskCreate:true,remoteTargetedPostCaptureV1:true,remoteStop:true,
      discoveredPostCaptureV1:true,supportedPlatforms:['douyin']});
    async function addRun(rawShareUrl='https://www.douyin.com/video/7654321098765432109',ingestService=service,evidence={}) {
      const [{id:taskId}]=await query(`INSERT INTO capture_tasks(tenant_id,origin_agent_id,assigned_agent_id,platform,status,metadata)
        VALUES($1,$2,$2,'douyin','running',$3) RETURNING id`,[tenantId,mobile.id,{workflow:'douyin_mobile_discovery',deadlineAt:new Date(Date.now()+600000).toISOString()}]);
      const requestHash='a'.repeat(64);
      const [{id:itemId}]=await query(`INSERT INTO capture_task_items(tenant_id,task_id,item_key,platform,status,keyword,
        assigned_agent_id,execution_task_id,assignment_revision,request_hash,attempt_count)
        VALUES($1,$2,'kw-1','douyin','running','别克壁纸',$3,$2,1,$4,1) RETURNING id`,[tenantId,taskId,mobile.id,requestHash]);
      const [{id:attemptId}]=await query(`INSERT INTO capture_task_item_attempts(tenant_id,item_id,parent_task_id,execution_task_id,
        agent_id,assignment_revision,request_hash,status) VALUES($1,$2,$3,$3,$4,1,$5,'running') RETURNING id`,[tenantId,itemId,taskId,mobile.id,requestHash]);
      const event={eventId:randomUUID(),discoveryRunId:taskId,taskId,itemId,attemptId,agentId:mobile.id,requestHash,
        assignmentRevision:1,keyword:'别克壁纸',verification:'verified',discoveredAt:new Date().toISOString(),rawShareUrl,...evidence};
      const principal={tenantId,agentId:mobile.id,authCodeId,authBindingId};
      const receipt=(await ingestService.ingestBatch({principal,batch:{uploadBatchId:randomUUID(),events:[event]}})).receipts[0];
      return {taskId,event,receipt};
    }
    const dispatch=()=>withTransaction(tx=>dispatchDiscoveredPost(tx,{agent:browser}));
    async function store(detail,overrides={},contextOverrides={}) {
      const [attempt]=await query('SELECT * FROM capture_task_item_attempts WHERE item_id=$1',[detail.itemId]);
      return upsertCapturedRecord({platform:'douyin',external_id:'7654321098765432109',url:'https://www.douyin.com/video/7654321098765432109',
        record_type:'single_note',title:'君越车机壁纸很有秋天的味道',author_name:'真实用户',author_id:'person-123',
        content:'喜欢这张新壁纸 @上海安吉星信息服务有限公司',...overrides},
      {tenantId,captureTaskId:detail.taskId,captureAgentId:browser.id,captureAgentAuthCodeId:authCodeId,
        captureAgentAuthBindingId:authBindingId,captureTaskItemAttemptId:attempt.id,captureTaskItemRequestHash:attempt.request_hash,...contextOverrides});
    }
    async function mirror(detail,status='running') {
      const [command]=await query('SELECT * FROM capture_agent_commands WHERE id=$1',[detail.commandId]);
      const now=new Date(Date.now()+1000).toISOString();
      const payload=globalThis.OnStarvoiceCloudTaskAgent.buildHeartbeatPayload({runtime:{appVersion:'0.4.7'},ledger:{runs:[]},
        targetedPostRequest:{id:detail.taskId,taskId:detail.taskId,cloudCommandId:detail.commandId,
          attemptId:command.payload.attemptIdentity,attemptNumber:1,workflow:'discovered_post_capture',platform:'douyin',status,
          targets:command.payload.targets,metadata:{candidateId:randomUUID(),workflow:'forged'},progressSeq:2,
          createdAt:now,updatedAt:now,startedAt:now,heartbeatAt:now}});
      const snapshot=normalizeCloudTaskSnapshot(payload.tasks[0]);
      return withTransaction(tx=>mirrorTaskSnapshot(tx,browser,snapshot));
    }
    return {tenantId,browser,mobile,addRun,dispatch,store,mirror};
  }
  await t.test('new work traverses actual tasks, attempts and formal record sync without fake recordId',async st=>{
    const f=await fixture(st),run=await f.addRun();
    assert.equal(run.receipt.candidateStatus,'queued');
    const detail=await f.dispatch(); assert.ok(detail?.commandId);
    const [command]=await query('SELECT payload FROM capture_agent_commands WHERE id=$1',[detail.commandId]);
    assert.equal(command.payload.workflow,'discovered_post_capture');
    assert.equal(command.payload.targets[0].candidateId,run.receipt.candidateId);
    assert.equal(command.payload.targets[0].recordId,undefined);
    assert.equal(await f.dispatch(),null,'occupied browser must not claim another task');
    const mirrored=await f.mirror(detail);
    assert.equal(mirrored.metadata.candidateId,run.receipt.candidateId);
    assert.equal(mirrored.metadata.workflow,'discovered_post_capture');
    const stored=await f.store(detail); assert.equal(stored.action,'inserted');
    const repeated=await f.store(detail); assert.equal(repeated.observationId,stored.observationId);
    const [task]=await query('SELECT * FROM capture_tasks WHERE id=$1',[detail.taskId]);
    const projected=await withTransaction(tx=>projectNegativePatrolSnapshot(tx,f.browser,task,{status:'completed',targetResults:[{itemId:detail.itemId,status:'completed'}]}));
    assert.equal(projected.status,'completed');
    const [item]=await query('SELECT * FROM capture_task_items WHERE id=$1',[detail.itemId]);
    assert.equal(item.status,'completed'); assert.equal(item.result_record_id,stored.id);
    const result=await management.list({tenantId:f.tenantId,runId:run.taskId});
    assert.equal(result.candidates[0].status,'stored');
    assert.equal(result.candidates[0].demandStatus,'fulfilled');
    assert.equal(result.candidates[0].recordId,stored.id);
    assert.equal((await query('SELECT * FROM record_observations WHERE tenant_id=$1',[f.tenantId])).length,1);
  });
  await t.test('UI-bound candidate requires independent full author and caption before any formal record commits',async st=>{
    const f=await fixture(st);
    const evidence={verification:'ui_bound',titleHint:'君越车机壁纸很有秋天的味道',authorHint:'真实用户',
      uiBinding:{profileId:'douyin-30.6.0-de106-api27-p0',cardId:'b'.repeat(64),kind:'video'}};
    await f.addRun(undefined,service,evidence);const detail=await f.dispatch();
    for(const change of [{author_name:'上海安吉星信息服务有限公司'},
      {title:'君越车机壁纸...',content:'君越车机壁纸...'}]) {
      await assert.rejects(f.store(detail,change),{code:'DISCOVERY_DETAIL_IDENTITY_MISMATCH'});
      assert.equal((await query('SELECT id FROM records WHERE tenant_id=$1',[f.tenantId])).length,0);
      assert.equal((await query('SELECT id FROM record_observations WHERE tenant_id=$1',[f.tenantId])).length,0);
    }
    const stored=await f.store(detail);assert.ok(stored.id);
    const mismatched=await f.addRun(undefined,service,{...evidence,authorHint:'另一个人'});
    assert.equal(mismatched.receipt.reason,'existing_record_identity_mismatch');
    const readback=await management.list({tenantId:f.tenantId,runId:mismatched.taskId});
    assert.equal(readback.candidates[0].demandStatus,'needs_action');
  });
  await t.test('leading author marker accepts real PC spelling, preserves mobile evidence and reuses one record',async st=>{
    const f=await fixture(st),url='https://www.douyin.com/note/7654321098765432109';
    const evidence={verification:'ui_bound',titleHint:'#别克世家 的秋天的壁纸来了 期待车机优化和新的功能。#车主生活记录',
      authorHint:'@开世家的宝妈小闫',uiBinding:{profileId:'douyin-40.6.0-de106-api27-p0',cardId:'b'.repeat(64),kind:'note'}};
    const run=await f.addRun(url,service,evidence),detail=await f.dispatch();
    const record={url,title:'#别克世家 的秋天的壁纸来了期待车机优化和新的功能。#车主生活记录',
      content:'#别克世家 的秋天的壁纸来了期待车机优化和新的功能。#车主生活记录',author_name:'开世家的宝妈小闫'};
    await assert.rejects(f.store(detail,{...record,author_name:'上海安吉星信息服务有限公司'}),{code:'DISCOVERY_DETAIL_IDENTITY_MISMATCH'});
    assert.equal((await query('SELECT id FROM records WHERE tenant_id=$1',[f.tenantId])).length,0);
    const stored=await f.store(detail,record);assert.ok(stored.id);
    const original=(await query('SELECT payload FROM capture_discovery_events WHERE tenant_id=$1',[f.tenantId]))[0];
    assert.equal(original.payload.authorHint,evidence.authorHint);
    const reused=await f.addRun(url,service,evidence);
    const result=await management.list({tenantId:f.tenantId,runId:reused.taskId});
    assert.equal(result.candidates[0].demandStatus,'fulfilled');assert.equal(result.candidates[0].recordId,stored.id);
    assert.equal(reused.receipt.candidateId,run.receipt.candidateId);
    assert.equal((await query('SELECT id FROM records WHERE tenant_id=$1',[f.tenantId])).length,1);
  });
  await t.test('client completed snapshot cannot claim success without a formal ingestion receipt',async st=>{
    const f=await fixture(st); await f.addRun(); const detail=await f.dispatch();
    const [task]=await query('SELECT * FROM capture_tasks WHERE id=$1',[detail.taskId]);
    const projected=await withTransaction(tx=>projectNegativePatrolSnapshot(tx,f.browser,task,{status:'completed'}));
    assert.equal(projected.status,'needs_action');
    const [item]=await query('SELECT * FROM capture_task_items WHERE id=$1',[detail.itemId]);
    assert.equal(item.status,'needs_action');
    assert.equal((await query('SELECT * FROM records WHERE tenant_id=$1',[f.tenantId])).length,0);
  });
  await t.test('real completion snapshot arriving before current sync is recovered without false failure',async st=>{
    const f=await fixture(st);await f.addRun();const detail=await f.dispatch();
    const mirrored=await f.mirror(detail,'completed');assert.equal(mirrored.status,'needs_action');
    const stored=await f.store(detail);
    const [task]=await query('SELECT status FROM capture_tasks WHERE id=$1',[detail.taskId]);
    assert.equal(task.status,'completed');
    const [item]=await query('SELECT status,result_record_id FROM capture_task_items WHERE id=$1',[detail.itemId]);
    assert.equal(item.status,'completed');assert.equal(item.result_record_id,stored.id);
  });
  await t.test('concurrent browser mirror and sync keep the task lock before candidate lock',async st=>{
    const f=await fixture(st);await f.addRun();const detail=await f.dispatch();
    const results=await Promise.allSettled([f.mirror(detail,'completed'),f.store(detail)]);
    assert.ok(results.every(result=>result.status==='fulfilled'),JSON.stringify(results));
    assert.equal((await query('SELECT status FROM capture_tasks WHERE id=$1',[detail.taskId]))[0].status,'completed');
  });
  await t.test('different identity and stripped lineage cannot store a false detail receipt',async st=>{
    const f=await fixture(st); await f.addRun(); const detail=await f.dispatch();
    await assert.rejects(f.store(detail,{external_id:'7654321098765432110',url:'https://www.douyin.com/video/7654321098765432110'}),{code:'stale_attempt'});
    await assert.rejects(f.store(detail,{}, {captureTaskItemAttemptId:null,captureTaskItemRequestHash:null}),{code:'DISCOVERY_STRICT_LINEAGE_REQUIRED'});
    assert.equal((await query('SELECT * FROM records WHERE tenant_id=$1',[f.tenantId])).length,0);
  });
  await t.test('shared candidate has one browser job; canceling one run preserves other demand',async st=>{
    const f=await fixture(st),first=await f.addRun(),second=await f.addRun();
    assert.equal(first.receipt.candidateId,second.receipt.candidateId);
    const detail=await f.dispatch();
    assert.equal((await query('SELECT * FROM capture_discovery_run_candidates WHERE tenant_id=$1 AND is_detail_owner=true',[f.tenantId])).length,1);
    const cancel=await withTransaction(tx=>cancelDiscoveryDemands(tx,{tenantId:f.tenantId,runId:first.taskId}));
    assert.equal(cancel.stopped.length,0);
    const stored=await f.store(detail);
    const a=await management.list({tenantId:f.tenantId,runId:first.taskId});
    const b=await management.list({tenantId:f.tenantId,runId:second.taskId});
    assert.equal(a.candidates[0].demandStatus,'canceled');
    assert.equal(b.candidates[0].demandStatus,'fulfilled'); assert.equal(b.candidates[0].recordId,stored.id);
  });
  await t.test('last demand stop fences in-flight create and late sync',async st=>{
    const f=await fixture(st),run=await f.addRun(),detail=await f.dispatch();
    const result=await withTransaction(tx=>cancelDiscoveryDemands(tx,{tenantId:f.tenantId,runId:run.taskId}));
    assert.equal(result.stopped.length,1);
    const commands=await query('SELECT command_type,status FROM capture_agent_commands WHERE task_id=$1',[detail.taskId]);
    assert.deepEqual(commands.map(c=>`${c.command_type}:${c.status}`).sort(),['create:failed','stop:pending']);
    await assert.rejects(f.store(detail),{code:'DISCOVERY_RECEIPT_NOT_CURRENT'});
    assert.equal((await query('SELECT * FROM records WHERE tenant_id=$1',[f.tenantId])).length,0);
  });
  await t.test('manual URL reprocess is bounded, tenant-scoped and idempotent',async st=>{
    const f=await fixture(st),run=await f.addRun('https://v.douyin.com/abc/');
    assert.equal(run.receipt.candidateId,null);
    let calls=0;
    const service=createDiscoveryManagementService({resolveShareUrl:async()=>{calls++;return 'https://www.douyin.com/video/7654321098765432109';}});
    const input={tenantId:f.tenantId,runId:run.taskId,requestId:randomUUID(),eventIds:[run.event.eventId]};
    const result=await service.reprocess(input); assert.ok(result.results.some(row=>row.status==='queued'));
    assert.deepEqual(await service.reprocess(input),result); assert.equal(calls,1);
    await assert.rejects(service.reprocess({...input,eventIds:[],candidateIds:[randomUUID()]}),{code:'REPROCESS_REQUEST_CONFLICT'});
    assert.equal((await management.list({tenantId:f.tenantId,runId:run.taskId})).candidates.length,1);
    await query(`UPDATE capture_tasks SET metadata=metadata||'{"stopScope":"batch"}' WHERE id=$1`,[run.taskId]);
    await assert.rejects(service.reprocess({...input,requestId:randomUUID()}),{code:'DISCOVERY_RUN_STOPPED'});
  });
  await t.test('discovery-only stop permits retrying an existing failed detail without restarting the phone',async st=>{
    const f=await fixture(st),run=await f.addRun(),first=await f.dispatch();
    await f.mirror(first);
    const [task]=await query('SELECT * FROM capture_tasks WHERE id=$1',[first.taskId]);
    await withTransaction(tx=>projectNegativePatrolSnapshot(tx,f.browser,task,{status:'failed'}));
    const control=createAndroidControlService();await control.stop(f.tenantId,run.taskId,{scope:'discovery'});
    const result=await management.reprocess({tenantId:f.tenantId,runId:run.taskId,requestId:randomUUID(),candidateIds:[run.receipt.candidateId]});
    assert.ok(result.results.some(r=>r.status==='queued'));
    const retry=await f.dispatch();assert.ok(retry);assert.notEqual(retry.taskId,first.taskId);
    const stored=await f.store(retry);assert.ok(stored.id);
    const [original]=await query('SELECT status,metadata FROM capture_tasks WHERE id=$1',[run.taskId]);
    assert.equal(original.status,'canceled');assert.equal(original.metadata.stopRequested,true);
    assert.equal(original.metadata.stopScope,'discovery');
    const items=await query('SELECT status,metadata FROM capture_task_items WHERE task_id=$1',[run.taskId]);
    assert.ok(items.every(item=>item.status==='canceled'&&!item.metadata.deviceHeld));
    assert.equal((await management.list({tenantId:f.tenantId,runId:run.taskId})).candidates[0].demandStatus,'fulfilled');
    await control.stop(f.tenantId,run.taskId,{scope:'batch'});
    await assert.rejects(management.reprocess({tenantId:f.tenantId,runId:run.taskId,requestId:randomUUID(),candidateIds:[run.receipt.candidateId]}),{code:'DISCOVERY_RUN_STOPPED'});
  });
  await t.test('a canceled run without explicit discovery-only scope cannot reopen detail demand',async st=>{
    const f=await fixture(st),run=await f.addRun();
    await query("UPDATE capture_tasks SET status='canceled' WHERE id=$1",[run.taskId]);
    await assert.rejects(management.reprocess({tenantId:f.tenantId,runId:run.taskId,requestId:randomUUID(),candidateIds:[run.receipt.candidateId]}),{code:'DISCOVERY_RUN_STOPPED'});
  });
  await t.test('whole-batch stop committed while reprocess waits cannot recreate active demand',async st=>{
    const f=await fixture(st),run=await f.addRun('https://v.douyin.com/abc/');
    let atLock;const waiting=new Promise(resolve=>{atLock=resolve;});
    const service=createDiscoveryManagementService({resolveShareUrl:async()=> 'https://www.douyin.com/video/7654321098765432109',
      database:{withTransaction:callback=>withTransaction(tx=>callback({...tx,queryOne:(sql,values)=>{
        if(sql.includes("metadata->>'workflow'='douyin_mobile_discovery'")&&sql.includes('FOR UPDATE')) atLock();
        return tx.queryOne(sql,values);
      }}))}});
    const holder=await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`UPDATE capture_tasks SET metadata=metadata||'{"stopScope":"batch"}' WHERE id=$1`,[run.taskId]);
      const retry=service.reprocess({tenantId:f.tenantId,runId:run.taskId,requestId:randomUUID(),eventIds:[run.event.eventId]});
      await waiting; await holder.query('COMMIT');
      await assert.rejects(retry,{code:'DISCOVERY_RUN_STOPPED'});
      assert.equal((await management.list({tenantId:f.tenantId,runId:run.taskId})).candidates.length,0);
    } finally {await holder.query('ROLLBACK');holder.release();}
  });
  await t.test('ingestion waiting on a candidate cannot clear a just-committed formal receipt',async st=>{
    const f=await fixture(st),run=await f.addRun();
    let atLock;const waiting=new Promise(resolve=>{atLock=resolve;});
    const repository=createDiscoveryRepository({database:{withTransaction:callback=>withTransaction(tx=>callback({...tx,
      queryOne:(sql,values)=>{if(sql.includes('INSERT INTO capture_discovery_candidates')) atLock();return tx.queryOne(sql,values);},
    }))}});
    const incoming=createDiscoveryService({repository});
    const holder=await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM capture_discovery_candidates WHERE id=$1 FOR UPDATE',[run.receipt.candidateId]);
      const replay=f.addRun(undefined,incoming);await waiting;
      const {rows:[record]}=await holder.query(`INSERT INTO records(tenant_id,platform,external_id,title,business_visibility)
        VALUES($1,'douyin','7654321098765432109','已完成详情','eligible') RETURNING id`,[f.tenantId]);
      await holder.query(`UPDATE capture_discovery_candidates SET record_id=$2,status='stored' WHERE id=$1`,[run.receipt.candidateId,record.id]);
      await holder.query('COMMIT');
      const result=await replay;assert.equal(result.receipt.recordId,record.id);
      assert.equal(result.receipt.candidateStatus,'already_exists');
      assert.equal((await query('SELECT record_id FROM capture_discovery_candidates WHERE id=$1',[run.receipt.candidateId]))[0].record_id,record.id);
    } finally {await holder.query('ROLLBACK');holder.release();}
  });
  await t.test('expired dispatch becomes visible failure rather than an eternal capturing item',async st=>{
    const f=await fixture(st);await f.addRun();const detail=await f.dispatch();
    await query(`UPDATE capture_agent_commands SET expires_at=now()-interval '1 minute' WHERE id=$1`,[detail.commandId]);
    await withTransaction(tx=>reconcileDiscoveryDetails(tx,{tenantId:f.tenantId}));
    const [candidate]=await query('SELECT status,last_error FROM capture_discovery_candidates WHERE tenant_id=$1',[f.tenantId]);
    assert.equal(candidate.status,'failed');assert.equal(candidate.last_error.code,'detail_create_expired');
  });
});
