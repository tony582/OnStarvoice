import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {once} from 'node:events';
import test from 'node:test';
import {createAndroidControlRouter} from '../server/routes/android-control.js';
import {createAndroidControlService} from '../server/services/android-control/service.js';
import {taskPayload} from '../server/services/android-control/leases.js';
import {mobileRelevancePrefilterEnabled} from '../server/services/android-control/mobile-tasks.js';
import {mapPrefilterItems} from '../server/services/android-control/prefilter.js';
import {receiptStats} from '../server/services/android-control/recovery.js';
import {PREFILTER_PROMPT_VERSION,PrefilterRequestError} from '../server/services/relevance-prefilter.js';
const require=createRequire(new URL('../server/package.json',import.meta.url)), express=require('express');

const AGENT='00000000-0000-4000-8000-00000000000a', TASK='00000000-0000-4000-8000-00000000000b';
const ITEM='00000000-0000-4000-8000-00000000000c', ATTEMPT='00000000-0000-4000-8000-00000000000d';
const PARENT='00000000-0000-4000-8000-00000000000e', REQUEST='00000000-0000-4000-8000-0000000000f1';
const identity={discoveryRunId:TASK,taskId:TASK,itemId:ITEM,attemptId:ATTEMPT,assignmentRevision:1,requestHash:'a'.repeat(64),agentId:AGENT};
const both={autoDetailCaptureAfterListCapture:true,enableAiRelevancePrefilter:true};
const card=(n,extra={})=>({cardId:n.toString(16).padStart(64,'0'),title:`别克远控 ${n}`,author:`作者${n}`,...extra});

// The real currentAttempt runs against these rows; the fake transaction records
// whether it is open so the test can prove the model is called after commit.
function fakeRepository(rows) {
  const state={inTx:false,transactions:0,failure:null};
  const tx={execute:async()=>({rows:[]}),queryOne:async sql=>{
    if (sql.includes('capture_task_item_attempts')) return rows.attempt;
    if (sql.includes('capture_task_items')) return rows.item;
    if (sql.includes('capture_tasks')) return rows.task;
    if (sql.includes('capture_agents')) return rows.agent;
    throw new Error(`unexpected query ${sql}`);
  }};
  return {state,repository:{async transaction(callback) {
    state.transactions++;if (state.failure) throw state.failure;
    state.inTx=true;try {return await callback(tx);} finally {state.inTx=false;}
  }}};
}
function rows({captureSettings=both,planSnapshot={captureSettings},itemMetadata={}}={}) {
  return {agent:{id:AGENT,status:'active',capabilities:{agentKind:'android_mobile',mobileSearchDiscoveryV1:true},allowed_platforms:['douyin']},
    task:{id:TASK,parent_task_id:PARENT,metadata:{workflow:'douyin_mobile_discovery',...(planSnapshot?{planSnapshot}:{})}},
    item:{id:ITEM,task_id:PARENT,keyword:'别克远控',assignment_revision:1,metadata:{attemptId:ATTEMPT,deviceHeld:true,...itemMetadata}},
    attempt:{id:ATTEMPT}};
}
function okItems(body) {
  return body.items.map(item=>({itemId:item.itemId,status:'ok',modelDecision:'skip',tenantRelevance:'irrelevant',confidence:0.99,
    protectedSignal:false,executionDisposition:'skip_full_capture',reason:'与别克无关',queryMatch:0,brandMatch:0,businessVisibility:'filtered_out'}));
}
async function serve(t,{data=rows(),prefilter,kind='android_mobile',enabled=true}={}) {
  const calls=[], {state,repository}=fakeRepository(data);
  const service=createAndroidControlService({repository,enabledTenants:()=>new Set(['tenant-a']),prefilter:async args=>{
    calls.push({...args,inTx:state.inTx});
    return prefilter ? prefilter(args) : {ok:true,degraded:false,items:okItems(args.body)};
  }});
  const agent=(req,_res,next)=>{req.tenantId='tenant-a';
    req.captureAgent={id:AGENT,auth_code_id:'auth-a',auth_binding_id:'bind-a',capabilities:{agentKind:kind}};next();};
  const app=express();app.use(express.json());
  app.use(createAndroidControlRouter({service,enabledTenants:()=>new Set(enabled?['tenant-a']:[]),authenticateAgent:agent}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const send=async body=>{
    const response=await fetch(`http://127.0.0.1:${server.address().port}/agent/prefilter`,{method:'POST',
      headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    return {status:response.status,retryAfter:response.headers.get('retry-after'),body:await response.json()};
  };
  return {calls,state,send};
}
const request=(cards,extra={})=>({identity,requestId:REQUEST,cards,...extra});

test('poll payload carries the prefilter switch only when the plan has both capture flags',()=>{
  const item={id:ITEM,execution_task_id:TASK,assignment_revision:1,request_hash:'a'.repeat(64),assigned_agent_id:AGENT,
    keyword:'别克远控',metadata:{attemptId:ATTEMPT}};
  const payload=metadata=>taskPayload(item,{deviceId:'d',filters:{},budgets:{},deadlineAt:null,...metadata}).relevancePrefilter;
  assert.deepEqual(payload({planSnapshot:{captureSettings:both}}),{enabled:true});
  assert.deepEqual(payload({planSnapshot:{captureSettings:{...both,enableAiRelevancePrefilter:false}}}),{enabled:false});
  assert.deepEqual(payload({planSnapshot:{captureSettings:{...both,autoDetailCaptureAfterListCapture:false}}}),{enabled:false});
  assert.deepEqual(payload({planSnapshot:{captureSettings:{autoDetailCaptureAfterListCapture:'true',enableAiRelevancePrefilter:'true'}}}),{enabled:false});
  assert.deepEqual(payload({planSnapshot:{}}),{enabled:false});
  assert.deepEqual(payload({}),{enabled:false},'a standalone run without a plan snapshot opens every card');
  assert.equal(mobileRelevancePrefilterEnabled(null),false);
  assert.equal(mobileRelevancePrefilterEnabled({captureSettings:null}),false);
});

test('the route sits behind the same tenant flag and mobile principal as poll',async t=>{
  const disabled=await serve(t,{enabled:false});
  assert.equal((await disabled.send(request([card(1)]))).status,404);
  const browser=await serve(t,{kind:'browser_extension'});
  assert.equal((await browser.send(request([card(1)]))).status,403);
  assert.equal(disabled.state.transactions+browser.state.transactions,0);
  assert.equal(disabled.calls.length+browser.calls.length,0);
});

test('invalid bodies are refused fail-open before any transaction or model call',async t=>{
  const api=await serve(t);
  const cases=[
    [request([]),400,'CARDS_REQUIRED'],
    [request(undefined),400,'CARDS_REQUIRED'],
    [request(Array.from({length:9},(_,i)=>card(i+1))),413,'TOO_MANY_CARDS'],
    [request([card(1),card(1,{title:'另一个'})]),422,'DUPLICATE_CARD_ID'],
    [request([card(1,{cardId:'A'.repeat(64)})]),422,'INVALID_CARD'],
    [request([card(1,{cardId:'abc'})]),422,'INVALID_CARD'],
    [request([card(1,{cardId:`${'a'.repeat(31)}:${'b'.repeat(32)}`})]),422,'INVALID_CARD'],
    [request([card(1,{title:7})]),422,'INVALID_CARD'],
    [request([card(1,{author:null})]),422,'INVALID_CARD'],
    [request([card(1)],{requestId:'not-a-uuid'}),400,'INVALID_REQUEST_ID'],
    [request([card(1)],{identity:{...identity,discoveryRunId:ITEM}}),400,'RUN_TASK_MISMATCH'],
    [[card(1)],400,'INVALID_BODY'],
  ];
  for (const [body,status,error] of cases) {
    const result=await api.send(body);
    assert.equal(result.status,status,error);assert.deepEqual(result.body,{ok:false,error,failOpen:true});
  }
  assert.equal(api.state.transactions,0);assert.equal(api.calls.length,0);
});

test('the service request uses the item keyword, empty external ids and the attempt idempotency key, after commit',async t=>{
  const api=await serve(t);
  const cards=[card(1),card(2,{title:'  ',author:''}),card(3)];
  const result=await api.send(request(cards,{keyword:'伪造关键词',platform:'xiaohongshu'}));
  assert.equal(result.status,200);
  assert.equal(api.calls.length,1);
  const [{tenantId,body,inTx}]=api.calls;
  assert.equal(inTx,false,'the model is never called inside the attempt transaction');
  assert.equal(tenantId,'tenant-a');
  assert.deepEqual(body,{requestId:REQUEST,idempotencyKey:`android:${ATTEMPT}:${REQUEST}`,platform:'douyin',stage:'list',
    keyword:'别克远控',promptVersion:PREFILTER_PROMPT_VERSION,mode:'conservative',skipThreshold:0.97,
    taskId:TASK,runId:TASK,keywordRunId:ITEM,
    items:cards.map(c=>({itemId:c.cardId,externalId:'',title:c.title,author:c.author,noteType:'',publishTime:''}))});
  assert.ok(body.items.every(item=>!item.itemId.includes(':')));
});

test('switch off answers enabled false and never calls the model',async t=>{
  for (const data of [rows({planSnapshot:null}),rows({captureSettings:{...both,enableAiRelevancePrefilter:false}})]) {
    const api=await serve(t,{data});
    const result=await api.send(request([card(1)]));
    assert.equal(result.status,200);
    assert.deepEqual(result.body,{ok:true,enabled:false,degraded:false,items:[]});
    assert.equal(api.calls.length,0);assert.equal(api.state.transactions,1);
  }
});

test('an attempt that is not current, not held or not this agent is refused fail-open',async t=>{
  const cases=[
    [rows({itemMetadata:{attemptId:PARENT}}),request([card(1)]),409,'STALE_ATTEMPT'],
    [rows({itemMetadata:{deviceHeld:false}}),request([card(1)]),409,'STALE_ATTEMPT'],
    [{...rows(),attempt:null},request([card(1)]),403,'ATTEMPT_LINEAGE_MISMATCH'],
    [rows(),request([card(1)],{identity:{...identity,agentId:PARENT}}),403,'AGENT_ID_MISMATCH'],
  ];
  for (const [data,body,status,error] of cases) {
    const api=await serve(t,{data});
    const result=await api.send(body);
    assert.equal(result.status,status,error);assert.deepEqual(result.body,{ok:false,error,failOpen:true});
    assert.equal(api.calls.length,0);
  }
});

test('service refusals keep their status with Retry-After and failOpen',async t=>{
  const cases=[
    [new PrefilterRequestError(429,'PREFILTER_DAILY_LIMIT','limit'),429,'60',60000],
    [new PrefilterRequestError(429,'PREFILTER_BUSY','busy',{retryAfterMs:1500}),429,'2',1500],
    [new PrefilterRequestError(409,'IDEMPOTENCY_IN_PROGRESS','again',{retryAfterMs:500}),409,'1',500],
    [new PrefilterRequestError(422,'KEYWORD_REQUIRED','kw'),422,null,undefined],
  ];
  for (const [error,status,retryAfter,retryAfterMs] of cases) {
    const api=await serve(t,{prefilter:async()=>{throw error;}});
    const result=await api.send(request([card(1)]));
    assert.equal(result.status,status);assert.equal(result.retryAfter,retryAfter);
    assert.deepEqual(result.body,{ok:false,error:error.code,failOpen:true,...(retryAfterMs?{retryAfterMs}:{})});
  }
});

test('unexpected failures are 503 and a busy database is 429, both fail-open',async t=>{
  t.mock.method(console,'error',()=>{});
  const broken=await serve(t,{prefilter:async()=>{throw new Error('relation does not exist');}});
  const unavailable=await broken.send(request([card(1)]));
  assert.equal(unavailable.status,503);assert.deepEqual(unavailable.body,{ok:false,error:'PREFILTER_UNAVAILABLE',failOpen:true});
  for (const failure of [{code:'55P03'},{code:'DB_CAPACITY_UNAVAILABLE'}]) {
    const busy=await serve(t);busy.state.failure=failure;
    const result=await busy.send(request([card(1)]));
    assert.equal(result.status,429);assert.equal(result.retryAfter,'1');
    assert.deepEqual(result.body,{ok:false,error:'server_busy',failOpen:true,retryAfterMs:1000});
    assert.equal(busy.calls.length,0);
  }
});

test('answers follow request order, drop extra fields and mark missing or repeated cards unjudged',async t=>{
  const longReason=`${'很'.repeat(159)}😀尾巴`;
  const cards=[card(1),card(2),card(3),card(4)];
  const api=await serve(t,{prefilter:async({body})=>{
    const [a,b,c]=okItems(body);
    return {ok:true,degraded:false,items:[
      {...c,reason:longReason,confidence:'0.99'},
      {itemId:'f'.repeat(64),status:'ok'},
      {...a,protectedSignal:'yes'},
      b,{...b,modelDecision:'keep'},
    ]};
  }});
  const result=await api.send(request(cards));
  assert.equal(result.status,200);
  assert.equal(result.body.enabled,true);assert.equal(result.body.degraded,true);
  assert.deepEqual(result.body.items.map(item=>item.cardId),cards.map(c=>c.cardId));
  assert.deepEqual(result.body.items[0],{cardId:cards[0].cardId,status:'ok',modelDecision:'skip',tenantRelevance:'irrelevant',
    confidence:0.99,protectedSignal:false,executionDisposition:'skip_full_capture',reason:'与别克无关'});
  for (const index of [1,3]) {
    assert.equal(result.body.items[index].status,'model_error');
    assert.equal(result.body.items[index].executionDisposition,'collect_full');
    assert.equal(result.body.items[index].modelDecision,null);
  }
  const third=result.body.items[2];
  assert.equal(third.confidence,null,'a non-numeric confidence is not passed on');
  assert.equal(third.reason.length,159,'the reason stops before a split emoji');
  assert.ok(third.reason.length<=160);
  assert.equal(result.body.items.every(item=>Object.keys(item).length===8),true);
});

test('mapping answers every card even when the service returns no items',()=>{
  const cards=[card(1),card(2)];
  assert.deepEqual(mapPrefilterItems(cards,null).map(item=>item.status),['model_error','model_error']);
  const reason='x'.repeat(400);
  assert.equal(mapPrefilterItems(cards,[{itemId:cards[0].cardId,status:'ok',reason}])[0].reason.length,160);
});

test('receipt stats accept the prefilter counters and drop invalid ones',()=>{
  assert.deepEqual(receiptStats({runner:{stats:{links:3,prefilterSkipped:12,prefilterJudged:20,prefilterUnjudged:0,other:1}}}),
    {links:3,prefilterSkipped:12,prefilterJudged:20,prefilterUnjudged:0});
  assert.deepEqual(receiptStats({runner:{stats:{prefilterSkipped:-1,prefilterJudged:'4',prefilterUnjudged:2}}}),{prefilterUnjudged:2});
});
