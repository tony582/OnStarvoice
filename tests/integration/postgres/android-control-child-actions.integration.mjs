import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {createAndroidControlService} from '../../../server/services/android-control/service.js';

test('mobile execution-child controls settle real orchestration items and preserve recovery safety',async t=>{
  validatePostgresIntegrationTarget({testDatabaseUrl:process.env.TEST_DATABASE_URL,
    databaseUrl:process.env.DATABASE_URL,requireDatabaseUrl:true});
  const {runMigrations}=await import('../../../server/db/migrate.js');
  const {getPool,closePool}=await import('../../../server/db/pool.js');
  // Register the actual parent projector; a stub could not prove parent settlement.
  await import('../../../server/routes/capture-cloud.js');
  await runMigrations();
  const pool=getPool();t.after(closePool);
  const query=async(sql,values=[])=>(await pool.query(sql,values)).rows;

  async function fixture(st) {
    const [{id:tenantId}]=await query('INSERT INTO tenants(name) VALUES($1) RETURNING id',[`child-actions-${randomUUID()}`]);
    st.after(async()=>{
      for(const table of ['capture_task_item_attempts','capture_task_items','capture_agent_commands','capture_tasks','records'])
        await query(`DELETE FROM ${table} WHERE tenant_id=$1`,[tenantId]);
      await query('DELETE FROM tenants WHERE id=$1',[tenantId]);
    });
    const code=randomUUID();
    await query('INSERT INTO auth_codes(tenant_id,code,max_bindings) VALUES($1,$2,2)',[tenantId,code]);
    const service=createAndroidControlService({enabledTenants:()=>new Set([tenantId])});
    const deviceId=`child-actions-${randomUUID()}`;
    const registered=await service.register({code,deviceId,clientUuid:randomUUID()});
    const [agent]=await query('SELECT * FROM capture_agents WHERE id=$1',[registered.agent.id]);
    const principal={tenantId,agentId:agent.id,authCodeId:agent.auth_code_id,authBindingId:agent.auth_binding_id};
    const sessionId=randomUUID();
    const poll=()=>service.poll(principal,{deviceId,sessionId,readyForSearch:true,
      platforms:['douyin','wechat_channels','wechat_articles'],features:['wechat_articles','wechat_forward']});
    const complete=(task,extra={})=>service.complete(principal,{requestId:randomUUID(),identity:task.identity,sessionId,
      status:'interrupted',deviceIdle:true,...extra});
    const close=task=>service.close(principal,{requestId:randomUUID(),identity:task.identity,
      evidence:{method:'independent_stop_check',evidenceId:randomUUID(),verifiedBy:'test',verifiedAt:new Date().toISOString()}});
    async function elastic(platform='wechat_channels') {
      const parentId=randomUUID();
      const metadata={distributionMode:'elastic_pool',eligibleAgentIds:[agent.id],claimUnit:'keyword',executionMode:'one_time',
        planSnapshot:{platform,keywords:['安吉星'],searchFilters:{sort:'latest',publishTime:'day',contentType:'all'},
          keywordMaxDetectedItems:20,recoveryPolicy:{disableAutomaticSearchRetry:true,singleRelayV1:true},
          captureSettings:{autoDetailCaptureAfterListCapture:true,includeCommentsOnDetailCapture:true}}};
      await query(`INSERT INTO capture_tasks(id,tenant_id,client_task_id,task_type,feature_key,title,platform,source,
        trigger_type,status,metadata,orchestration_revision,counts,progress)
        VALUES($1::uuid,$2,$1::text,'capture_orchestration','keyword_orchestration','子任务控制回归',$3,'cloud',
        'manual','running',$4,1,'{"total":1,"assigned":0}'::jsonb,'{}'::jsonb)`,[parentId,tenantId,platform,metadata]);
      await query(`INSERT INTO capture_task_items(tenant_id,task_id,item_key,ordinal,keyword,platform,item_type,status,assignment_revision)
        VALUES($1,$2,'keyword:0',0,'安吉星',$3,'keyword','pending',0)`,[tenantId,parentId,platform]);
      const {task}=await poll();assert.ok(task);
      assert.notEqual(task.identity.taskId,parentId);
      const [item]=await query('SELECT task_id,execution_task_id FROM capture_task_items WHERE id=$1',[task.identity.itemId]);
      assert.equal(item.task_id,parentId);assert.equal(item.execution_task_id,task.identity.taskId);
      return {parentId,task};
    }
    return {tenantId,service,agent,poll,complete,close,elastic};
  }

  await t.test('stop cancels the unheld elastic item by execution id and settles its parent',async st=>{
    const f=await fixture(st),{parentId,task}=await f.elastic();
    await f.close(task);
    assert.equal((await f.service.detail(f.tenantId,task.identity.taskId)).items[0].status,'needs_action');
    const stopped=await f.service.stop(f.tenantId,task.identity.taskId,{scope:'batch'});
    assert.equal(stopped.items[0].status,'canceled');assert.equal(stopped.run.status,'canceled');
    const [parent]=await query('SELECT status,counts,finished_at FROM capture_tasks WHERE id=$1',[parentId]);
    assert.equal(parent.status,'canceled');assert.equal(parent.counts.canceled,1);assert.ok(parent.finished_at);
    assert.equal((await f.poll()).task,null);
  });

  await t.test('held elastic child cannot resume; independent closure permits explicit retry of the same item',async st=>{
    const f=await fixture(st),{task}=await f.elastic('douyin');
    await f.complete(task,{deviceIdle:false,reason:'clipboard_restore_unconfirmed'});
    const before=await f.service.detail(f.tenantId,task.identity.taskId);
    assert.equal(before.run.status,'interrupted');assert.equal(before.recovery.canResume,false);
    assert.equal(before.recovery.resumeError,'STOP_OR_DEVICE_CLOSURE_REQUIRED');
    await assert.rejects(f.service.resume(f.tenantId,task.identity.taskId),{code:'STOP_OR_DEVICE_CLOSURE_REQUIRED'});
    await f.close(task);
    assert.equal((await f.service.detail(f.tenantId,task.identity.taskId)).recovery.canResume,true);
    const resumed=await f.service.resume(f.tenantId,task.identity.taskId);
    assert.equal(resumed.items[0].status,'retryable');
    assert.equal(resumed.run.deadlineAt,task.deadlineAt);
    const next=await f.poll();assert.ok(next.task);
    assert.equal(next.task.identity.itemId,task.identity.itemId);
    assert.notEqual(next.task.identity.attemptId,task.identity.attemptId);
    assert.equal(next.task.resumeAuthorized,true);
    assert.deepEqual(next.task.budgets,task.budgets);
  });

  await t.test('node activeRunId opens the child, and hold state uses child stop metadata',async st=>{
    const f=await fixture(st),{parentId,task}=await f.elastic('wechat_articles');
    const node=(await f.service.nodes(f.tenantId)).nodes[0];
    assert.equal(node.activeRunId,task.identity.taskId);assert.notEqual(node.activeRunId,parentId);
    assert.equal((await f.service.detail(f.tenantId,node.activeRunId)).run.id,node.activeRunId);
    assert.equal(node.holdState,'working');
    await f.service.stop(f.tenantId,node.activeRunId);
    const stopping=(await f.service.nodes(f.tenantId)).nodes[0];
    assert.equal(stopping.holdState,'stopping');assert.equal(stopping.deviceHeld,true);
    assert.equal((await f.service.detail(f.tenantId,node.activeRunId)).items[0].status,'running');
    await f.complete(task,{status:'canceled'});
    const [parent]=await query('SELECT status FROM capture_tasks WHERE id=$1',[parentId]);
    assert.equal(parent.status,'canceled');
    assert.equal((await f.service.nodes(f.tenantId)).nodes[0].deviceHeld,false);
  });

  await t.test('a failed forward is never resumable, including when only the item identifies the forward',async st=>{
    const f=await fixture(st);
    const [record]=await query(`INSERT INTO records(tenant_id,external_id,platform,record_type,title,url)
      VALUES($1,$2,'wechat_channels','keyword_notes','转发恢复回归','https://weixin.qq.com/sph/AsvBQklNxh') RETURNING id`,[f.tenantId,randomUUID()]);
    await query(`INSERT INTO tenant_settings(tenant_id,key,value) VALUES($1,'wechat_forward_recipients','文件传输助手')`,[f.tenantId]);
    await f.service.forward(f.tenantId,{recordId:record.id,recipients:['文件传输助手']});
    const {task}=await f.poll();assert.ok(task);
    await f.complete(task,{reason:'forward_send_unconfirmed'});
    for(const taskType of ['wechat_forward','capture']) {
      await query('UPDATE capture_tasks SET task_type=$2 WHERE id=$1',[task.identity.taskId,taskType]);
      const detail=await f.service.detail(f.tenantId,task.identity.taskId);
      assert.equal(detail.items[0].status,'failed');assert.equal(detail.recovery.canResume,false);
      assert.equal(detail.recovery.resumeError,'WECHAT_FORWARD_NOT_RESUMABLE');
      await assert.rejects(f.service.resume(f.tenantId,task.identity.taskId),{code:'WECHAT_FORWARD_NOT_RESUMABLE'});
    }
    assert.equal((await f.poll()).task,null);
    const [item]=await query('SELECT status,attempt_count FROM capture_task_items WHERE id=$1',[task.identity.itemId]);
    assert.equal(item.status,'failed');assert.equal(item.attempt_count,1);
  });

  await t.test('another tenant cannot stop, resume or inspect the execution child',async st=>{
    const f=await fixture(st),other=await fixture(st),{task}=await f.elastic();
    for(const operation of ['stop','resume','detail'])
      await assert.rejects(other.service[operation](other.tenantId,task.identity.taskId),{code:'MOBILE_RUN_NOT_FOUND',status:404});
    assert.equal((await f.service.detail(f.tenantId,task.identity.taskId)).items[0].status,'running');
    assert.equal((await other.service.nodes(other.tenantId)).nodes[0].activeRunId,null);
  });

  await t.test('article completion statistics survive storage and appear in the task detail',async st=>{
    const f=await fixture(st),{task}=await f.elastic('wechat_articles');
    const stats={posts:2,previewFailed:1,previewUnavailable:3,comments:4,partialBodies:5,unavailableBodies:6,
      timeUnverified:7,pageFailures:8,cardsSeen:9,opened:10,outsideWindow:11,stopReason:2,screens:12};
    await f.complete(task,{status:'completed',checkpoint:{stats:{...stats,privateText:'must not persist',links:-1}}});
    const detail=await f.service.detail(f.tenantId,task.identity.taskId);
    assert.deepEqual(detail.items[0].stats,stats);
    const [attempt]=await query('SELECT checkpoint FROM capture_task_item_attempts WHERE id=$1',[task.identity.attemptId]);
    assert.deepEqual(attempt.checkpoint.runner.stats,stats);
  });
});
