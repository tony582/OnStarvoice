import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {validatePostgresIntegrationTarget} from '../../../scripts/lib/postgres-integration-target.mjs';
import {createDiscoveryRepository} from '../../../server/services/capture-discovery/repository.js';
import {createDiscoveryService} from '../../../server/services/capture-discovery/service.js';
import {dispatchDiscoveredPost} from '../../../server/services/capture-discovery/detail-dispatch.js';
import {readDiscoveryDetailTimeoutCooldownMs} from '../../../server/services/capture-discovery/detail-timeout-cooldown.js';

test('discovery-only timeout admission against isolated PostgreSQL', async t => {
  validatePostgresIntegrationTarget({testDatabaseUrl:process.env.TEST_DATABASE_URL,
    databaseUrl:process.env.DATABASE_URL,requireDatabaseUrl:true});
  const {runMigrations}=await import('../../../server/db/migrate.js');
  const {getPool,closePool}=await import('../../../server/db/pool.js');
  const {withTransaction}=await import('../../../server/db/query.js');
  const {mirrorTaskSnapshot,lockActiveCaptureAgentSession}=await import('../../../server/routes/capture-cloud.js');
  const {normalizeCloudTaskSnapshot}=await import('../../../server/services/capture-cloud.js');
  const {upsertCapturedRecord}=await import('../../../server/services/record-store.js');
  await import('../../../utils/cloud-task-agent.js');
  await runMigrations(); const pool=getPool(); t.after(closePool);
  const query=async(sql,values=[])=>(await pool.query(sql,values)).rows;
  const discovery=createDiscoveryService({repository:createDiscoveryRepository()});
  async function fixture(st) {
    const [{id:tenantId}]=await query('INSERT INTO tenants(name) VALUES($1) RETURNING id',[randomUUID()]);
    process.env.ANDROID_DISCOVERY_INGEST_TENANTS=tenantId;
    st.after(async()=>{
      for (const table of ['capture_discovery_reprocess_requests','capture_discovery_run_candidates',
        'capture_discovery_events','capture_discovery_candidates']) await query(`DELETE FROM ${table} WHERE tenant_id=$1`,[tenantId]);
      await query('DELETE FROM tenants WHERE id=$1',[tenantId]);
    });
    const [{id:authCodeId}]=await query('INSERT INTO auth_codes(tenant_id,code) VALUES($1,$2) RETURNING id',[tenantId,randomUUID()]);
    const [{id:authBindingId}]=await query('INSERT INTO auth_bindings(code_id,fingerprint) VALUES($1,$2) RETURNING id',[authCodeId,randomUUID()]);
    const addAgent=async capabilities=>(await query(`INSERT INTO capture_agents(tenant_id,auth_code_id,auth_binding_id,client_uuid,
      allowed_platforms,capabilities) VALUES($1,$2,$3,$4,ARRAY['douyin'],$5) RETURNING *`,
    [tenantId,authCodeId,authBindingId,randomUUID(),capabilities]))[0];
    const capabilities={remoteTaskCreate:true,remoteTargetedPostCaptureV1:true,remoteStop:true,
      discoveredPostCaptureV1:true,supportedPlatforms:['douyin']};
    const browser=await addAgent(capabilities), healthy=await addAgent(capabilities);
    const mobile=await addAgent({agentKind:'android_mobile',mobileSearchDiscoveryV1:true});
    let external=7654321098765432100n;
    async function candidate() {
      const externalId=String(external++),url=`https://www.douyin.com/video/${externalId}`;
      const [{id:taskId}]=await query(`INSERT INTO capture_tasks(tenant_id,origin_agent_id,assigned_agent_id,platform,status,metadata)
        VALUES($1,$2,$2,'douyin','running',$3) RETURNING id`,
      [tenantId,mobile.id,{workflow:'douyin_mobile_discovery',deadlineAt:new Date(Date.now()+600000).toISOString()}]);
      const hash='a'.repeat(64);
      const [{id:itemId}]=await query(`INSERT INTO capture_task_items(tenant_id,task_id,item_key,platform,status,keyword,
        assigned_agent_id,execution_task_id,assignment_revision,request_hash,attempt_count)
        VALUES($1,$2,'kw','douyin','running','fixture',$3,$2,1,$4,1) RETURNING id`,[tenantId,taskId,mobile.id,hash]);
      const [{id:attemptId}]=await query(`INSERT INTO capture_task_item_attempts(tenant_id,item_id,parent_task_id,execution_task_id,
        agent_id,assignment_revision,request_hash,status) VALUES($1,$2,$3,$3,$4,1,$5,'running') RETURNING id`,
      [tenantId,itemId,taskId,mobile.id,hash]);
      const event={eventId:randomUUID(),discoveryRunId:taskId,taskId,itemId,attemptId,agentId:mobile.id,requestHash:hash,
        assignmentRevision:1,keyword:'fixture',verification:'verified',discoveredAt:new Date().toISOString(),rawShareUrl:url};
      const receipt=(await discovery.ingestBatch({principal:{tenantId,agentId:mobile.id,authCodeId,authBindingId},
        batch:{uploadBatchId:randomUUID(),events:[event]}})).receipts[0];
      return {candidateId:receipt.candidateId,externalId,url};
    }
    const dispatch=(agent=browser)=>withTransaction(async tx=>{
      const current=await lockActiveCaptureAgentSession(tx,agent);
      return current?dispatchDiscoveredPost(tx,{agent:{...agent,...current}}):null;
    });
    let sequence=0;
    async function mirror(detail,{status='failed',code='TARGET_RUNNER_TAB_TIMEOUT'}={}) {
      const [command]=await query('SELECT payload FROM capture_agent_commands WHERE id=$1',[detail.commandId]);
      const now=new Date(Date.now()+(++sequence)*1000).toISOString();
      const payload=globalThis.OnStarvoiceCloudTaskAgent.buildHeartbeatPayload({runtime:{appVersion:'0.4.21'},ledger:{runs:[]},
        targetedPostRequest:{id:detail.taskId,taskId:detail.taskId,cloudCommandId:detail.commandId,
          attemptId:command.payload.attemptIdentity,attemptNumber:1,workflow:'discovered_post_capture',platform:'douyin',status,
          targets:command.payload.targets,progressSeq:sequence,createdAt:now,updatedAt:now,startedAt:now,finishedAt:now,
          heartbeatAt:now,error:code?{code}: {}}});
      const snapshot=normalizeCloudTaskSnapshot(payload.tasks[0]);
      await query(`UPDATE capture_agent_commands SET status='completed',finished_at=now() WHERE id=$1`,[detail.commandId]);
      return withTransaction(tx=>mirrorTaskSnapshot(tx,browser,snapshot));
    }
    async function fail(code) {
      const source=await candidate(), detail=await dispatch(); assert.ok(detail);
      await mirror(detail,{code}); return {...detail,...source};
    }
    const cooldown=()=>withTransaction(tx=>readDiscoveryDetailTimeoutCooldownMs(tx,{tenantId,agentId:browser.id}));
    async function store(detail) {
      const [attempt]=await query('SELECT * FROM capture_task_item_attempts WHERE item_id=$1',[detail.itemId]);
      return upsertCapturedRecord({platform:'douyin',external_id:detail.externalId,url:detail.url,
        record_type:'single_note',title:'fixture',author_name:'fixture',author_id:'fixture',content:'fixture'},
      {tenantId,captureTaskId:detail.taskId,captureAgentId:browser.id,captureAgentAuthCodeId:authCodeId,
        captureAgentAuthBindingId:authBindingId,captureTaskItemAttemptId:attempt.id,captureTaskItemRequestHash:attempt.request_hash});
    }
    return {tenantId,browser,healthy,candidate,dispatch,mirror,fail,cooldown,store};
  }
  await t.test('three distinct failed executions pause this browser but leave queued work available to another',async st=>{
    const f=await fixture(st);
    await f.fail(); assert.equal(await f.cooldown(),0);
    await f.fail(); assert.equal(await f.cooldown(),0);
    await f.fail(); assert.ok(await f.cooldown()>0);
    const candidate=await f.candidate(); assert.equal(await f.dispatch(),null);
    const [unchanged]=await query('SELECT status,detail_task_item_id FROM capture_discovery_candidates WHERE id=$1',[candidate.candidateId]);
    assert.deepEqual(unchanged,{status:'queued',detail_task_item_id:null});
    const other=await f.dispatch(f.healthy); assert.equal(other.candidateId,candidate.candidateId);
  });
  await t.test('expiry survives repeated snapshots and admits only one probe, whose failure pauses again',async st=>{
    const f=await fixture(st); await f.fail(); await f.fail(); const last=await f.fail();
    await query(`UPDATE capture_task_snapshots SET received_at=now()-interval '6 minutes' WHERE tenant_id=$1`,[f.tenantId]);
    await f.mirror(last); assert.equal(await f.cooldown(),0,'fresh duplicate cannot renew first timeout');
    const next=await f.candidate(); await f.candidate();
    const claims=await Promise.all([f.dispatch(),f.dispatch()]);
    assert.equal(claims.filter(Boolean).length,1,'serialized execution slot allows one natural probe');
    const probe=claims.find(Boolean); assert.equal(probe.candidateId,next.candidateId);
    assert.equal(await f.dispatch(),null,'execution slot prevents a second probe');
    await f.mirror(probe); assert.ok(await f.cooldown()>0);
    assert.equal(await f.dispatch(),null);
  });
  await t.test('real late ingestion resets a timeout streak despite retained failed raw attempt',async st=>{
    const f=await fixture(st); await f.fail(); await f.fail(); const last=await f.fail();
    assert.ok(await f.cooldown()>0); await f.store(last);
    const [attempt]=await query('SELECT error FROM capture_task_attempts WHERE task_id=$1',[last.taskId]);
    assert.equal(attempt.error.code,'TARGET_RUNNER_TAB_TIMEOUT');
    assert.equal(await f.cooldown(),0);
    await f.candidate(); assert.ok(await f.dispatch());
  });
  await t.test('other errors interrupt the sequence and repeated snapshots never count as executions',async st=>{
    const f=await fixture(st); const first=await f.fail();
    await f.mirror(first); await f.mirror(first); assert.equal(await f.cooldown(),0);
    await f.fail('TARGET_RUNNER_TAB_CLOSED'); await f.fail(); assert.equal(await f.cooldown(),0);
    await f.candidate(); assert.ok(await f.dispatch());
  });
  await t.test('timeouts from another workflow never contribute to discovery cooldown',async st=>{
    const f=await fixture(st); await f.fail(); const other=await f.fail(); await f.fail();
    assert.ok(await f.cooldown()>0);
    await query("UPDATE capture_tasks SET task_type='negative_post_patrol' WHERE id=$1",[other.taskId]);
    assert.equal(await f.cooldown(),0);
    await f.candidate(); assert.ok(await f.dispatch());
  });
  await t.test('missing or foreign attempt receipt evidence cannot cool a browser',async st=>{
    const f=await fixture(st); await f.fail(); await f.fail(); const last=await f.fail();
    await query('UPDATE capture_task_snapshots SET agent_id=$2 WHERE task_id=$1',[last.taskId,f.healthy.id]);
    assert.equal(await f.cooldown(),0);
    await query('UPDATE capture_task_snapshots SET agent_id=$2,client_attempt_id=$3 WHERE task_id=$1',
      [last.taskId,f.browser.id,randomUUID()]);
    assert.equal(await f.cooldown(),0);
  });
  await t.test('an optional cooldown SQL failure rolls back its savepoint and preserves heartbeat admission',async st=>{
    const f=await fixture(st); const source=await f.candidate();
    let failedHistoryRead=false;
    const detail=await withTransaction(async tx=>{
      await lockActiveCaptureAgentSession(tx,f.browser);
      const result=await dispatchDiscoveredPost({...tx,queryAll:(sql,values)=>{
        if (sql.includes('AS first_timeout_received_at')) {
          failedHistoryRead=true;
          return tx.queryAll('SELECT 1 / 0 AS induced_optional_history_error');
        }
        return tx.queryAll(sql,values);
      }},{agent:f.browser});
      assert.equal((await tx.queryOne('SELECT 1 AS usable')).usable,1);
      return result;
    });
    assert.equal(failedHistoryRead,true);
    assert.equal(detail.candidateId,source.candidateId);
  });
  await t.test('history reads are bounded and restore zero or stricter caller statement timeouts',async st=>{
    const f=await fixture(st);
    for (const previousMs of [0,25]) {
      await withTransaction(async tx=>{
        await tx.queryOne("SELECT set_config('statement_timeout',$1,true)",[`${previousMs}ms`]);
        let queried=false, timeoutErrorCode='';
        const remaining=await readDiscoveryDetailTimeoutCooldownMs({...tx,queryAll:async(sql,values)=>{
          if (sql.includes('AS first_timeout_received_at')) {
            queried=true;
            const configured=await tx.queryOne("SELECT setting FROM pg_settings WHERE name='statement_timeout'");
            assert.equal(Number(configured.setting),previousMs||750);
            try { return await tx.queryAll('SELECT pg_sleep(2)'); }
            catch (error) { timeoutErrorCode=error.code; throw error; }
          }
          return tx.queryAll(sql,values);
        }},{tenantId:f.tenantId,agentId:f.browser.id});
        assert.equal(queried,true); assert.equal(remaining,0);
        assert.equal(timeoutErrorCode,'57014','server cancels the optional statement at its timeout');
        const restored=await tx.queryOne("SELECT setting FROM pg_settings WHERE name='statement_timeout'");
        assert.equal(Number(restored.setting),previousMs);
        assert.equal((await tx.queryOne('SELECT 1 AS usable')).usable,1);
        await readDiscoveryDetailTimeoutCooldownMs(tx,{tenantId:f.tenantId,agentId:f.browser.id});
        const afterSuccess=await tx.queryOne("SELECT setting FROM pg_settings WHERE name='statement_timeout'");
        assert.equal(Number(afterSuccess.setting),previousMs);
      });
    }
  });
  await t.test('historical failures and human inactive status never become a permanent or bypassable fence',async st=>{
    const f=await fixture(st); await f.fail(); await f.fail(); await f.fail();
    await query(`UPDATE capture_tasks SET created_at=now()-interval '16 minutes'
      WHERE tenant_id=$1 AND task_type='discovered_post_capture'`,[f.tenantId]);
    assert.equal(await f.cooldown(),0);
    await f.candidate();
    await query("UPDATE capture_agents SET status='revoked' WHERE id=$1",[f.browser.id]);
    assert.equal(await f.dispatch(),null);
  });
});
