import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';

test('manual dispatch stays local, gates old clients, retains full settings and reconciles one stable task', async t => {
  validatePostgresIntegrationTarget({testDatabaseUrl:process.env.TEST_DATABASE_URL,databaseUrl:process.env.DATABASE_URL,requireDatabaseUrl:true});
  const {runMigrations}=await import('../../../server/db/migrate.js');
  const {getPool,closePool}=await import('../../../server/db/pool.js');
  const {withTransaction}=await import('../../../server/db/init.js');
  const {findCaptureAgentExecutionSlotBlocker,normalizeCloudTaskSnapshot}=await import('../../../server/services/capture-cloud.js');
  const {default:router,mirrorTaskSnapshot}=await import('../../../server/routes/capture-cloud.js');
  const {createApp}=await import('../../../server/app.js');
  const {hashPassword}=await import('../../../server/services/auth-service.js');
  await runMigrations();const pool=getPool();const query=async(sql,values=[])=>(await pool.query(sql,values)).rows;
  const [tenant]=await query('INSERT INTO tenants(name) VALUES($1) RETURNING id',[`manual-${randomUUID()}`]);
  const [code]=await query("INSERT INTO auth_codes(tenant_id,code,status,expires_at) VALUES($1,$2,'active',now()+interval '1 day') RETURNING id",[tenant.id,randomUUID()]);
  const [binding]=await query('INSERT INTO auth_bindings(code_id,fingerprint) VALUES($1,$2) RETURNING id',[code.id,randomUUID()]);
  const capabilities={remoteTaskCreate:true,remoteTaskKeywordPostLimit:true,remoteTaskEnhancementOptions:true,taskStateKnown:true,supportedPlatforms:['xiaohongshu']};
  const [agent]=await query(`INSERT INTO capture_agents(tenant_id,client_uuid,display_name,status,allowed_platforms,auth_code_id,auth_binding_id,capabilities,last_heartbeat_at,last_full_heartbeat_at)
    VALUES($1,$2,'Manual test','active',ARRAY['xiaohongshu'],$3,$4,$5,now(),now()) RETURNING *`,[tenant.id,randomUUID(),code.id,binding.id,capabilities]);
  const email=`manual-${randomUUID()}@example.invalid`,password='local-test-only';
  const [user]=await query("INSERT INTO users(email,name,password_hash,status,must_change_password) VALUES($1,'Manual test',$2,'active',false) RETURNING id",[email,hashPassword(password)]);
  await query("INSERT INTO user_memberships(user_id,tenant_id,role,status) VALUES($1,$2,'tenant_admin','active')",[user.id,tenant.id]);
  const server=await new Promise((resolve,reject)=>{const server=createApp({logger:{log(){},error(){}}}).listen(0,'127.0.0.1');server.once('listening',()=>resolve(server));server.once('error',reject);});
  t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await query('DELETE FROM tenants WHERE id=$1',[tenant.id]);await query('DELETE FROM users WHERE id=$1',[user.id]);await closePool();});
  const origin=`http://127.0.0.1:${server.address().port}`;
  const login=await fetch(`${origin}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password})});
  assert.equal(login.status,200);const {token}=await login.json();
  const send=async body=>{const res=await fetch(`${origin}/api/capture-cloud/agents/${agent.id}/tasks`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`,'x-tenant-id':tenant.id},body:JSON.stringify(body)});return {status:res.status,body:await res.json()};};
  const input={requestKey:randomUUID(),executionMode:'manual_batch',platform:'xiaohongshu',keywords:['安吉星','别克APP'],keywordMaxDetectedItems:50,keywordMinLikes:7,manualStartTime:'23:55',maxRounds:7,searchFilters:{sort:'latest',publishTime:'day',contentType:'image'},captureSettings:{autoDetailCaptureAfterListCapture:true,autoSyncAfterDetailCapture:true,enableAiRelevancePrefilter:true,includeBloggerMetricsOnDetailCapture:true,enableLowFollowerHitFilterOnDetailCapture:false,lowFollowerHitThresholdOnDetailCapture:10000,includeCommentsOnDetailCapture:true,detailCommentsMaxDetectedItems:50,enableCommentLeadsFilterOnDetailCapture:false,skipAlreadyCapturedOnDetailCapture:true}};
  const old=await send(input);assert.equal(old.status,409);assert.equal(old.body.error,'agent_manual_batch_capability_missing');
  capabilities.remoteManualKeywordBatchV1=true;
  await query('UPDATE capture_agents SET capabilities=$1,unattended_plan=$2 WHERE id=$3',[capabilities,{keywords:['旧计划词'],captureSettings:{autoDetailCaptureAfterListCapture:true},searchFilters:{searchScope:'followed'},maxRounds:9},agent.id]);
  const result=await send(input);assert.equal(result.status,201,JSON.stringify(result.body));
  const [task]=await query('SELECT * FROM capture_tasks WHERE id=$1',[input.requestKey]);
  assert.equal(task.task_type,'capture');assert.equal(task.feature_key,'capture.search');assert.equal(task.parent_task_id,null);
  assert.equal(task.metadata.executionMode,'manual_batch');assert.equal(task.metadata.planSnapshot.maxRounds,1);
  assert.equal(task.metadata.planSnapshot.searchFilters.searchScope,'all','must not inherit old plan');
  assert.deepEqual(task.metadata.planSnapshot.captureSettings,input.captureSettings);
  assert.equal(task.metadata.planSnapshot.keywordMinLikes,7);
  assert.equal(task.metadata.planSnapshot.recoveryPolicy.allowIdleAgentHandoff,false);
  const repeated=await send(input);assert.equal(repeated.status,200,JSON.stringify(repeated.body));
  assert.equal((await send({...input,keywords:['别的词']})).status,409);
  assert.equal((await query('SELECT id FROM capture_agent_commands WHERE task_id=$1',[task.id])).length,1);
  assert.equal((await query('SELECT id FROM capture_task_items WHERE task_id=$1',[task.id])).length,0);
  const [savedAgent]=await query('SELECT * FROM capture_agents WHERE id=$1',[agent.id]);
  const snapshot=normalizeCloudTaskSnapshot({id:task.id,taskType:'capture',featureKey:'capture.search',platform:'xiaohongshu',source:'sidebar',status:'completed',updatedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),metadata:{executionMode:'manual_batch',remoteManual:true}});
  await withTransaction(tx=>mirrorTaskSnapshot(tx,savedAgent,snapshot));
  assert.equal((await query('SELECT id FROM capture_tasks WHERE client_task_id=$1',[task.id])).length,1);
  assert.equal((await query('SELECT status FROM capture_tasks WHERE id=$1',[task.id]))[0].status,'completed');

  // Exercise the real admission query: only an unconfirmed stop holds a slot.
  await query("UPDATE capture_agent_commands SET status='completed' WHERE task_id=$1",[task.id]);
  const [unsafe]=await query(`INSERT INTO capture_tasks(tenant_id,assigned_agent_id,client_task_id,task_type,platform,title,status,error)
    VALUES($1,$2,$3,'unattended_keyword_capture','xiaohongshu','Unsafe stop','needs_action',$4) RETURNING id`,[tenant.id,agent.id,randomUUID(),{code:'PREVIOUS_CAPTURE_STOP_UNCONFIRMED'}]);
  const blocker=await withTransaction(tx=>findCaptureAgentExecutionSlotBlocker(tx,tenant.id,agent.id,{excludeTaskIds:[unsafe.id]}));
  assert.equal(blocker.task_id,unsafe.id,'exclusions cannot bypass unconfirmed stop');
  const queued=await send({...input,requestKey:randomUUID()});assert.equal(queued.status,201);
  const heartbeat=router.stack.find(layer=>layer.route?.path==='/agent/heartbeat').route.stack.at(-1).handle;
  let heartbeatPayload,failure;
  await heartbeat({captureAgent:savedAgent,body:{agent:{clientUuid:agent.client_uuid,capabilities},tasks:[]}},
    {status(){return this;},set(){return this;},json(value){heartbeatPayload=value;return this;}},error=>{failure=error;});
  if(failure)throw failure;
  assert.equal(heartbeatPayload.commands.length,0,'unconfirmed stop must prevent new create delivery');
  await query("UPDATE capture_tasks SET error='{}',status='needs_action' WHERE id=$1",[unsafe.id]);
  await query("UPDATE capture_agent_commands SET status='completed' WHERE tenant_id=$1",[tenant.id]);
  await query("UPDATE capture_tasks SET status='completed' WHERE tenant_id=$1 AND id<>$2",[tenant.id,unsafe.id]);
  assert.equal(await withTransaction(tx=>findCaptureAgentExecutionSlotBlocker(tx,tenant.id,agent.id)),null,'ordinary failure must not freeze the node');
});
