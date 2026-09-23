import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {createRequire} from 'node:module';
import {once} from 'node:events';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {createAndroidControlService} from '../../../server/services/android-control/service.js';

test('Android task control uses durable capture lineage and fenced leases',async t=>{
  validatePostgresIntegrationTarget({testDatabaseUrl:process.env.TEST_DATABASE_URL,databaseUrl:process.env.DATABASE_URL,requireDatabaseUrl:true});
  const {runMigrations}=await import('../../../server/db/migrate.js');
  const {getPool,closePool}=await import('../../../server/db/pool.js');
  await runMigrations(); const pool=getPool();t.after(closePool);
  const query=async(sql,values=[])=>(await pool.query(sql,values)).rows;
  async function fixture(st) {
    const [{id:tenantId}]=await query('INSERT INTO tenants(name) VALUES($1) RETURNING id',[randomUUID()]);
    st.after(async()=>{await query('DELETE FROM tenants WHERE id=$1',[tenantId]);});
    const code=randomUUID();
    const [auth]=await query('INSERT INTO auth_codes(tenant_id,code,max_bindings) VALUES($1,$2,2) RETURNING *',[tenantId,code]);
    const service=createAndroidControlService({enabledTenants:()=>new Set([tenantId])});
    const registration={code,clientUuid:randomUUID(),deviceId:`test-${randomUUID()}`};
    const registered=await service.register(registration);
    const [agent]=await query('SELECT * FROM capture_agents WHERE id=$1',[registered.agent.id]);
    const principal={tenantId,agentId:agent.id,authCodeId:agent.auth_code_id,authBindingId:agent.auth_binding_id};
    const body={requestId:randomUUID(),agentId:agent.id};
    const created=await service.create(tenantId,body);
    const poll={sessionId:randomUUID(),deviceId:registration.deviceId,readyForSearch:true};
    const claim=()=>service.poll(principal,poll);
    const completion=(task,extra={})=>({requestId:randomUUID(),identity:task.identity,sessionId:poll.sessionId,status:'completed',deviceIdle:true,...extra});
    return {tenantId,code,auth,service,registration,registered,agent,principal,body,runId:created.run.id,poll,claim,completion};
  }
  await t.test('default off registration, binding quotas and mobile/browser isolation',async st=>{
    const f=await fixture(st);
    assert.equal(f.agent.capabilities.agentKind,'android_mobile');assert.equal(f.agent.capabilities.remoteTaskCreate,false);
    assert.equal(f.agent.browser_name,'Android Runner');
    assert.equal((await f.service.register(f.registration)).agent.id,f.agent.id);
    assert.equal((await query('SELECT * FROM auth_bindings WHERE code_id=$1',[f.auth.id])).length,1);
    const off=createAndroidControlService({enabledTenants:()=>new Set()});
    await assert.rejects(off.register(f.registration),{code:'ANDROID_DISCOVERY_NOT_ENABLED'});
    await assert.rejects(f.service.register({...f.registration,clientUuid:randomUUID()}),{code:'DEVICE_ALREADY_BOUND'});
    await query("UPDATE auth_codes SET status='frozen' WHERE id=$1",[f.auth.id]);
    await assert.rejects(f.claim(),{code:'MOBILE_AGENT_NOT_AUTHORIZED'});
  });
  await t.test('create retries deduplicate, input conflict rejected, no deadline consumed while offline',async st=>{
    const f=await fixture(st);
    const retried=await f.service.create(f.tenantId,f.body);assert.equal(retried.run.id,f.runId);
    assert.equal(retried.run.deadlineAt,null);
    await assert.rejects(f.service.create(f.tenantId,{...f.body,keywords:['安吉星']}),{code:'CREATE_REQUEST_CONFLICT'});
    const idle=await f.service.poll(f.principal,{...f.poll,readyForSearch:false});assert.equal(idle.task,null);
    assert.equal((await f.service.detail(f.tenantId,f.runId)).items.length,2);
  });
  await t.test('concurrent claims share exactly one attempt; wrong session gets no permit',async st=>{
    const f=await fixture(st);const [a,b]=await Promise.all([f.claim(),f.claim()]);
    assert.deepEqual(a.task.identity,b.task.identity);
    assert.equal((await query('SELECT * FROM capture_task_item_attempts WHERE parent_task_id=$1',[f.runId])).length,1);
    assert.equal(Date.parse(a.permit.leaseUntil)-Date.parse(a.permit.serverTime),90000);
    const other=await f.service.poll(f.principal,{...f.poll,sessionId:randomUUID()});
    assert.equal(other.permit,null);assert.equal(other.control.reason,'runner_session_changed');
    const renewed=await f.service.renew(f.principal,{identity:a.task.identity,sessionId:f.poll.sessionId,leaseId:a.permit.leaseId});
    assert.ok(renewed.permit);
  });
  await t.test('lease expiry retains physical hold, forbids refresh and requires actual closure',async st=>{
    const f=await fixture(st);const a=await f.claim();
    await query(`UPDATE capture_task_items SET metadata=jsonb_set(metadata,'{leaseUntil}',to_jsonb((now()-interval '1 second')::text)) WHERE id=$1`,[a.task.identity.itemId]);
    const expired=await f.claim();assert.equal(expired.control.reason,'lease_expired');assert.equal(expired.task,null);
    const denied=await f.service.renew(f.principal,{identity:a.task.identity,sessionId:f.poll.sessionId,leaseId:a.permit.leaseId});
    assert.equal(denied.permit,null);
    const nodes=await f.service.nodes(f.tenantId);assert.equal(nodes.nodes[0].deviceHeld,true);
    await assert.rejects(f.service.resume(f.tenantId,f.runId),{code:'STOP_OR_DEVICE_CLOSURE_REQUIRED'});
    const body=f.completion(a.task,{status:'interrupted',reason:'lease_expired'});
    await f.service.complete(f.principal,body);
    assert.equal((await f.service.nodes(f.tenantId)).nodes[0].deviceHeld,false);
  });
  await t.test('complete is durable and immutable; next keyword retains its own item identity',async st=>{
    const f=await fixture(st);const a=await f.claim();const body=f.completion(a.task);
    await f.service.complete(f.principal,body);
    assert.equal((await f.service.complete(f.principal,body)).duplicate,true);
    await assert.rejects(f.service.complete(f.principal,{...body,deviceIdle:false}),{code:'COMPLETION_CONFLICT'});
    const b=await f.claim();assert.notEqual(b.task.identity.itemId,a.task.identity.itemId);
    assert.equal(b.task.identity.taskId,a.task.identity.taskId);
    await f.service.complete(f.principal,f.completion(b.task));
    assert.equal((await f.service.detail(f.tenantId,f.runId)).run.status,'completed');
    assert.equal((await f.claim()).task,null);
  });
  await t.test('stop fences action immediately but slot stays held until confirmation',async st=>{
    const f=await fixture(st);const a=await f.claim();await f.service.stop(f.tenantId,f.runId,{scope:'batch'});
    const stopped=await f.service.renew(f.principal,{identity:a.task.identity,sessionId:f.poll.sessionId,leaseId:a.permit.leaseId});
    assert.equal(stopped.control.reason,'remote_stop');assert.equal(stopped.permit,null);
    await f.service.complete(f.principal,f.completion(a.task,{status:'canceled',deviceIdle:false}));
    assert.equal((await f.service.nodes(f.tenantId)).nodes[0].deviceHeld,true);
    await assert.rejects(f.service.close(f.principal,{requestId:randomUUID(),identity:a.task.identity,evidence:{}}),{code:'CLOSURE_EVIDENCE_REQUIRED'});
    const evidence={method:'independent_stop_check',evidenceId:randomUUID(),verifiedBy:'test-adapter',verifiedAt:new Date().toISOString()};
    const closure={requestId:randomUUID(),identity:a.task.identity,evidence};await f.service.close(f.principal,closure);
    assert.equal((await f.service.close(f.principal,closure)).duplicate,true);
    assert.equal((await f.service.detail(f.tenantId,f.runId)).run.status,'canceled');
    assert.equal((await f.claim()).task,null);
  });
  await t.test('resume is explicit, new attempt fences history and keeps deadline/budget',async st=>{
    const f=await fixture(st);const a=await f.claim();const body=f.completion(a.task,{status:'interrupted'});
    await f.service.complete(f.principal,body);
    await f.service.resume(f.tenantId,f.runId);const b=await f.claim();
    assert.equal(b.task.identity.itemId,a.task.identity.itemId);assert.notEqual(b.task.identity.attemptId,a.task.identity.attemptId);
    assert.equal(b.task.identity.assignmentRevision,2);assert.equal(b.task.resumeAuthorized,true);
    assert.equal(b.task.deadlineAt,a.task.deadlineAt);assert.deepEqual(b.task.budgets,a.task.budgets);
    assert.equal((await f.service.complete(f.principal,body)).duplicate,true);
    const rows=await query('SELECT status,metadata FROM capture_task_items WHERE id=$1',[b.task.identity.itemId]);
    assert.equal(rows[0].status,'running');assert.equal(rows[0].metadata.attemptId,b.task.identity.attemptId);
  });
  await t.test('real mobile bearer token cannot heartbeat through legacy browser protocol',async st=>{
    const f=await fixture(st);
    const require=createRequire(new URL('../../../server/package.json',import.meta.url));
    const express=require('express'),app=express();
    const {default:legacy}=await import('../../../server/routes/capture-cloud.js');
    app.use(express.json());app.use('/api/capture-cloud',legacy);
    const server=app.listen(0,'127.0.0.1');await once(server,'listening');
    st.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/capture-cloud/agent/heartbeat`,{
      method:'POST',headers:{authorization:`Bearer ${f.registered.agent.token}`,'content-type':'application/json'},body:'{}'});
    assert.equal(response.status,403);assert.equal((await response.json()).error,'android_control_protocol_required');
    assert.equal((await query('SELECT * FROM capture_task_item_attempts WHERE parent_task_id=$1',[f.runId])).length,0);
  });
  await t.test('issued task identity is accepted by discovery ingest and current UI query preserves event ids',async st=>{
    const f=await fixture(st);const claimed=await f.claim();
    st.after(async()=>{await query('DELETE FROM capture_discovery_run_candidates WHERE tenant_id=$1',[f.tenantId]);
      await query('DELETE FROM capture_discovery_events WHERE tenant_id=$1',[f.tenantId]);
      await query('DELETE FROM capture_discovery_candidates WHERE tenant_id=$1',[f.tenantId]);});
    const {createDiscoveryService}=await import('../../../server/services/capture-discovery/service.js');
    const {createDiscoveryRepository}=await import('../../../server/services/capture-discovery/repository.js');
    const event={...claimed.task.identity,eventId:randomUUID(),keyword:claimed.task.keyword,
      verification:'verified',discoveredAt:new Date().toISOString(),rawShareUrl:'https://www.douyin.com/video/7654321098765432109'};
    const result=await createDiscoveryService({repository:createDiscoveryRepository()}).ingestBatch({principal:f.principal,
      batch:{uploadBatchId:randomUUID(),events:[event]}});
    assert.equal(result.receipts[0].deliveryMode,'normal');assert.ok(result.receipts[0].candidateId);
    const detail=await f.service.detail(f.tenantId,f.runId);
    assert.equal(detail.events[0].eventId,event.eventId);assert.equal(detail.events[0].candidateId,result.receipts[0].candidateId);
  });
  await t.test('independent closure fences a delayed old completion without changing current recovery state',async st=>{
    const f=await fixture(st);const a=await f.claim();
    await f.service.close(f.principal,{requestId:randomUUID(),identity:a.task.identity,
      evidence:{method:'operator_takeover',evidenceId:randomUUID(),verifiedBy:'operator',verifiedAt:new Date().toISOString()}});
    await f.service.resume(f.tenantId,f.runId);const b=await f.claim();
    const receipt=await f.service.complete(f.principal,f.completion(a.task));assert.equal(receipt.closed,true);
    const [item]=await query('SELECT * FROM capture_task_items WHERE id=$1',[a.task.identity.itemId]);
    assert.equal(item.metadata.attemptId,b.task.identity.attemptId);assert.equal(item.status,'running');assert.equal(item.metadata.deviceHeld,true);
  });
  await t.test('registration enforces quota under concurrency and stale heartbeat readiness is hidden',async st=>{
    const f=await fixture(st);
    const results=await Promise.allSettled([1,2].map(()=>f.service.register({code:f.code,clientUuid:randomUUID(),deviceId:randomUUID()})));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(results.find(r=>r.status==='rejected').reason.code,'BINDING_LIMIT_REACHED');
    await f.claim();await query("UPDATE capture_agents SET last_liveness_at=now()-interval '3 minutes' WHERE id=$1",[f.agent.id]);
    const node=(await f.service.nodes(f.tenantId)).nodes.find(n=>n.id===f.agent.id);
    assert.equal(node.readyForSearch,false);assert.equal(node.deviceHeld,true);
  });
  await t.test('recovery view follows actual closure, queue and fresh attempt without carrying old errors',async st=>{
    const f=await fixture(st);const a=await f.claim();
    assert.equal((await f.service.nodes(f.tenantId)).nodes[0].holdState,'working');
    assert.equal((await f.service.detail(f.tenantId,f.runId)).recovery.state,'working');
    await f.service.complete(f.principal,f.completion(a.task,{status:'interrupted',deviceIdle:false,
      reason:'clipboard_restore_unconfirmed',checkpoint:{stats:{links:2,cards:4,keywordElapsedMs:90000}}}));
    const blocked=await f.service.detail(f.tenantId,f.runId);
    assert.equal(blocked.recovery.state,'closure_required');assert.equal(blocked.recovery.canResume,false);
    assert.deepEqual(blocked.items[0].stats,{links:2,cards:4,keywordElapsedMs:90000});
    assert.equal((await f.service.nodes(f.tenantId)).nodes[0].holdReason,'clipboard_restore_unconfirmed');
    await assert.rejects(f.service.resume(f.tenantId,f.runId),{code:blocked.recovery.resumeError});
    await f.service.close(f.principal,{requestId:randomUUID(),identity:a.task.identity,
      evidence:{method:'independent_stop_check',evidenceId:randomUUID(),verifiedBy:'test',verifiedAt:new Date().toISOString()}});
    await query("UPDATE capture_agents SET last_liveness_at=now()-interval '3 minutes' WHERE id=$1",[f.agent.id]);
    const offline=await f.service.detail(f.tenantId,f.runId);
    assert.equal(offline.recovery.canResume,true);assert.equal(offline.recovery.state,'waiting_device');
    assert.ok(offline.recovery.lastClosedAt);assert.ok(offline.recovery.remainingMs>0);
    await f.service.resume(f.tenantId,f.runId);
    await query(`UPDATE capture_task_items SET error='{"code":"old_error"}'::jsonb WHERE id=$1`,[a.task.identity.itemId]);
    const b=await f.claim();assert.equal(b.task.identity.assignmentRevision,2);
    assert.equal(b.task.deadlineAt,a.task.deadlineAt);
    const resumed=await f.service.detail(f.tenantId,f.runId);
    assert.equal(resumed.recovery.state,'working');assert.equal(resumed.items[0].reason,'');assert.equal(resumed.items[0].stats,null);
    assert.equal((await f.service.nodes(f.tenantId)).nodes[0].holdReason,'');
    const [old]=await query('SELECT result FROM capture_task_item_attempts WHERE id=$1',[a.task.identity.attemptId]);
    assert.equal(old.result.reason,'clipboard_restore_unconfirmed');assert.ok(old.result.closure);
  });
  await t.test('expired resume is rejected after a previously eligible page snapshot',async st=>{
    const f=await fixture(st);const a=await f.claim();
    await f.service.complete(f.principal,f.completion(a.task,{status:'interrupted'}));
    assert.equal((await f.service.detail(f.tenantId,f.runId)).recovery.canResume,true);
    await query(`UPDATE capture_tasks SET metadata=jsonb_set(metadata,'{deadlineAt}',to_jsonb((now()-interval '1 second')::text)) WHERE id=$1`,[f.runId]);
    await assert.rejects(f.service.resume(f.tenantId,f.runId),{code:'RUN_DEADLINE_EXPIRED'});
    const expired=await f.service.detail(f.tenantId,f.runId);
    assert.equal(expired.recovery.state,'deadline_expired');assert.equal(expired.recovery.canResume,false);
    assert.equal(expired.recovery.remainingMs,0);
  });
  await t.test('bounded completion preserves actual result and duration in the operator view',async st=>{
    const f=await fixture(st);const a=await f.claim();
    await f.service.complete(f.principal,f.completion(a.task,{reason:'keyword_time_limit',checkpoint:{stats:{links:3,cards:5,keywordElapsedMs:601823}}}));
    const b=await f.claim();await f.service.complete(f.principal,f.completion(b.task));
    const result=await f.service.detail(f.tenantId,f.runId);
    assert.equal(result.run.status,'completed');assert.equal(result.recovery.canResume,false);
    assert.equal(result.items[0].reason,'keyword_time_limit');assert.equal(result.items[0].stats.links,3);
    assert.equal(result.items[0].stats.keywordElapsedMs,601823);
  });
  await t.test('different tenant cannot inspect run or forge original attempt',async st=>{
    const f=await fixture(st);const a=await f.claim();
    await assert.rejects(f.service.detail(randomUUID(),f.runId),{code:'MOBILE_RUN_NOT_FOUND'});
    await assert.rejects(f.service.renew(f.principal,{identity:{...a.task.identity,attemptId:randomUUID()},sessionId:f.poll.sessionId,leaseId:a.permit.leaseId}),{code:'ATTEMPT_LINEAGE_MISMATCH'});
  });
});
