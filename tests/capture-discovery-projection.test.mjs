import assert from 'node:assert/strict';
import test from 'node:test';
import {projectDiscoveryTaskResult} from '../server/services/capture-discovery/detail-projection.js';

const rawError={code:'TARGET_RUNNER_TAB_TIMEOUT',message:'定向作品采集页打开超时',phase:'target_navigating'};
function fixture(overrides={}) {
  const task={id:'detail-task',status:'running',metadata:{candidateId:'candidate'},...overrides};
  const candidate={id:'candidate',item_id:'item',record_id:null,observation_id:null,attempt_count:1,assignment_revision:1};
  const writes=[];
  const tx={async execute(sql,values) {writes.push({sql,values});},async queryOne(sql,values) {
    if(sql.includes('SELECT candidate.*')) return candidate;
    writes.push({sql,values});
    return {...task,status:values[2],error:values[3],counts:values[4],progress:values[5],message:values[6]};
  }};
  return {task,candidate,writes,run:snapshot=>projectDiscoveryTaskResult(tx,{tenantId:'tenant',task,snapshot})};
}

test('detail timeout keeps its original diagnosis and receipt contract on every projection row',async()=>{
  const f=fixture();const task=await f.run({status:'failed',error:rawError,progress:{phase:'discovered_post_capture'}});
  assert.equal(task.status,'needs_action');assert.equal(task.error.code,'detail_finished_without_ingestion');
  assert.equal(task.error.reportedStatus,'failed');
  assert.equal(task.error.sourceCode,rawError.code);assert.equal(task.error.sourceMessage,rawError.message);
  assert.equal(task.error.sourcePhase,'target_navigating');
  assert.match(task.message,/定向作品采集页打开超时.*TARGET_RUNNER_TAB_TIMEOUT/u);
  assert.match(task.message,/尚未取得入库回执/u);assert.equal(task.error.message,task.message);
  assert.deepEqual(task.counts,{total:1,processed:1,success:0,failed:1});
  assert.deepEqual(task.progress,{current:1,total:1,percent:100,phase:'needs_action'});
  assert.deepEqual(f.writes[0].values[5],task.error);assert.deepEqual(f.writes[1].values[3],task.error);
  assert.deepEqual(f.writes[2].values[2],task.error);
  assert.equal(f.writes[0].values[3],null);assert.equal(f.writes[0].values[4],null);
});

test('task errors and repeated projection preserve the source without recursive generic wrapping',async()=>{
  const first=await fixture({error:rawError}).run({status:'failed',error:{}});
  const second=await fixture(first).run({status:'needs_action',error:first.error,message:first.message});
  assert.equal(second.error.sourceCode,rawError.code);assert.equal(second.error.sourceMessage,rawError.message);
  assert.equal(second.error.sourcePhase,rawError.phase);assert.equal(second.message,first.message);
  const repeated=await fixture(first).run({status:'failed',error:{},message:'任务失败'});
  assert.equal(repeated.error.sourceCode,rawError.code);assert.equal(repeated.message,first.message);
});

test('failure stages are observed, never inferred from timeout codes',async()=>{
  const f=fixture();const error={code:rawError.code,message:rawError.message};
  assert.equal((await f.run({status:'failed',error})).error.sourcePhase,undefined);
  assert.equal((await f.run({status:'failed',error,phase:'unknown'})).error.sourcePhase,undefined);
  assert.equal((await f.run({status:'failed',error,progress:{phase:'target_navigating'}})).error.sourcePhase,'target_navigating');
  assert.equal((await f.run({status:'failed',error,progress:{phase:'discovered_post_capture'}})).error.sourcePhase,'discovered_post_capture');
});

test('the observed initial-readiness stage survives projection and replay without claiming a receipt',async()=>{
  const error={code:'TARGET_RUNNER_TAB_TIMEOUT',message:rawError.message,stage:'initial_detail_readiness'};
  const task=await fixture().run({status:'failed',error,progress:{phase:'discovered_post_capture'}});
  assert.equal(task.error.sourcePhase,'initial_detail_readiness');
  assert.equal(task.error.code,'detail_finished_without_ingestion');assert.equal(task.counts.success,0);
  const replayed=await fixture(task).run({status:'needs_action',error:task.error});
  assert.equal(replayed.error.sourcePhase,'initial_detail_readiness');assert.equal(replayed.message,task.message);
  const explicit=await fixture().run({status:'failed',error:{...error,phase:'target_navigating'}});
  assert.equal(explicit.error.sourcePhase,'target_navigating');
});

test('client success and partial record identity never replace a real ingestion receipt',async()=>{
  for(const recordId of [null,'record']) {
    const f=fixture();f.candidate.record_id=recordId;
    const task=await f.run({status:'completed',message:'采集完成',counts:{total:1,processed:1,success:1,failed:0}});
    assert.equal(task.status,'needs_action');assert.equal(task.counts.success,0);
    assert.deepEqual(task.error,{code:'detail_finished_without_ingestion',reportedStatus:'completed'});
    assert.equal(task.message,'补详情结束但未取得入库回执，需要处理');
  }
});

test('a later real receipt clears the diagnostic and alone establishes successful ingestion',async()=>{
  const failed=await fixture().run({status:'failed',error:rawError});
  const f=fixture(failed);f.candidate.record_id='record';f.candidate.observation_id='observation';
  const stored=await f.run({status:'completed'});
  assert.equal(stored.status,'completed');assert.equal(stored.counts.success,1);assert.equal(stored.counts.failed,0);
  assert.deepEqual(stored.error,{});assert.equal(stored.message,'手机发现作品已补齐详情并入库');
  assert.equal(f.writes.length,3);
});

test('canceled and superseded projections retain their stop semantics and source diagnosis',async()=>{
  for(const status of ['canceled','superseded']) {
    const f=fixture({status});const task=await f.run({status,error:rawError});
    assert.equal(task.status,status);assert.equal(task.error.code,'detail_canceled');
    assert.equal(task.error.sourceCode,rawError.code);assert.equal(task.counts.success,0);
    assert.match(task.message,/^补详情已停止/u);assert.equal(f.writes[0].values[2],'canceled');
  }
  const stopped=await fixture({status:'canceled',error:rawError}).run({status:'completed'});
  assert.equal(stopped.status,'canceled');assert.equal(stopped.error.code,'detail_canceled');
});

test('an operator-closed detail cannot be reopened or have its stored original error rewritten',async()=>{
  const f=fixture({status:'failed',attempt_number:1,orchestration_revision:0,error:rawError,
    metadata:{candidateId:'candidate',operatorClose:{closedAt:'2026-09-28T00:00:00Z',attemptNumber:1,orchestrationRevision:0}}});
  assert.equal(await f.run({status:'completed',error:rawError}),null);assert.deepEqual(f.writes,[]);
});

test('legacy errorless failure text is bounded and projected only as a diagnosis',async()=>{
  const f=fixture();const task=await f.run({status:'failed',message:'失败原因'.repeat(1000),progress:{phase:'target_navigating'}});
  assert.equal(task.error.sourceMessage.length,1500);assert.equal(task.error.sourceCode,undefined);
  assert.equal(task.error.sourcePhase,'target_navigating');assert.equal(task.counts.success,0);
});
