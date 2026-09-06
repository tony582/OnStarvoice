import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import test from 'node:test';
import vm from 'node:vm';
import {evaluateTerminalControlAuthority} from '../../server/services/capture-control-authority.js';
import {normalizeCloudTaskSnapshot,normalizeRemoteTaskInput} from '../../server/services/capture-cloud.js';
import express from '../../server/node_modules/express/index.js';
import {createCaptureControlAuthorityRouter} from '../../server/routes/capture-control-authority.js';

const root = new URL('../../', import.meta.url);
const read = file => readFileSync(new URL(file, root), 'utf8');
const background = read('background.js');
const clone = value => JSON.parse(JSON.stringify(value));
const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const BASE = Date.parse('2026-09-06T02:00:00.000Z');
const ATTEMPT = 'c92a2f61-7be8-4d72-89ad-87f6ad0e8e7a';
const REQUEST = '83a706cd-f488-417d-bd73-a4cb178da0b7';
const COMMAND = '7864b11d-2cae-40b5-b710-f194d2732912';
const AGENT = '751cce5c-651e-4438-9b25-6b1836ec6265';
const TENANT = '13b82d50-021d-4c54-8f6c-10a5cd4d53e9';
const CODE = 'bf81e75e-ccbc-48da-9098-c4999a31f9e8';
const BINDING = '6cdcc49c-7864-4bea-ae6c-d0a608093343';
const sender = Object.freeze({id: EXTENSION_ID,
  url: `chrome-extension://${EXTENSION_ID}/sidebar/sidebar.html`,
  documentId: 'document-1', documentLifecycle: 'active', frameId: 0});
function declaration(source, name, indent = '') {
  const pattern = new RegExp(`^${indent}(?:async )?function ${name}\\(`, 'gm');
  const starts = [...source.matchAll(pattern)];
  assert.equal(starts.length, 1, name);
  let end = starts[0].index;
  while ((end = source.indexOf(`\n${indent}}`, end + 1)) >= 0) {
    const body = source.slice(starts[0].index, end + indent.length + 2);
    try {new vm.Script(`(${body})`);return body;} catch {}
  }
  assert.fail(`unclosed function ${name}`);
}
function constDeclaration(name) {
  const start = background.indexOf(`const ${name} = `);
  assert.ok(start >= 0, name);
  const end = background.indexOf('\n', background.indexOf(';', start));
  return background.slice(start, end);
}

// A real producer/projection fixture, not a hand-written terminal status. The
// only stubbed producer ports are storage and physical cleanup: no page, auth,
// network or capture operation runs while constructing this offline evidence.
async function producerFixture() {
  class FixedDate extends Date {
    constructor(...args) {super(...(args.length ? args : [BASE]));}
    static now() {return BASE;}
  }
  const context = vm.createContext({Date: FixedDate, console,
    DOUYIN_SEARCH_SERVICE_ABNORMAL_CODE: 'DOUYIN_SEARCH_SERVICE_ABNORMAL'});
  const checkpointModule = read('utils/unattended-keyword-run.js')
    .replace(/^import[^\n]+\n/, '').replace(/^export /gm, '');
  vm.runInContext(checkpointModule, context);
  vm.runInContext(read('utils/task-center.js'), context);
  vm.runInContext(read('utils/cloud-task-agent.js'), context);
  vm.runInContext(read('utils/capture/task-center-projection.js'), context);
  vm.runInContext(read('sidebar/task-controller/unattended-run.js').replace(/^export /gm, ''), context);
  const functions = ['normalizePlatformId', 'normalizeScheduleMode', 'normalizeStartTime',
    'normalizeNonNegativeInteger', 'normalizePositiveInteger', 'normalizeKeywordList',
    'normalizeSearchFilters', 'normalizeCalendarDate', 'normalizeDateListText',
    'normalizeUnattendedRunProgress', 'normalizeUnattendedKeywordPlan', 'normalizeUnattendedRunRequest',
    'normalizeOrchestrationExecutionContext', 'buildUnattendedTaskRun', 'parseTimestampMs',
    'resolveUnattendedBusinessProgressAt', 'buildUnattendedBusinessProgressFingerprint',
    'buildUnattendedRecoveryMilestoneFingerprint', 'updateUnattendedKeywordRun'];
  vm.runInContext(`${['DEFAULT_UNATTENDED_KEYWORD_PLAN', 'UNATTENDED_RUN_SCHEMA_VERSION',
    'UNATTENDED_MAX_RECOVERY_ATTEMPTS', 'UNATTENDED_PROGRESS_VOLATILE_FIELDS',
    'UNATTENDED_SETTLED_CHECKPOINT_STATUSES'].map(constDeclaration).join('\n')}
    const SCHEDULE_MODES = new Set(['daily','weekdays','weekends','custom_dates']);
    const UNATTENDED_RUN_REPORTABLE_STATUSES = new Set(['running','completed_with_failures']);
    const {buildTaskCenterCheckpointFromUnattendedRequest, buildUnattendedTaskCounts} = OnStarvoiceCaptureTaskCenterProjection;
    ${functions.map(name => declaration(background, name)).join('\n')}
    const runUnattendedRunMutation = callback => callback();
    const isTerminalUnattendedRunStatus = value => value === 'completed_with_failures';
    let fixtureRequest = null;
    const readUnattendedKeywordRunRequest = async () => fixtureRequest;
    const persistUnattendedRunMutation = async request => {fixtureRequest=request; return {request};};
    const unattendedRunRequiresLocalClosureProof = () => false;
    const cleanupTerminalUnattendedRuntime = async request => ({request});
    const controller = createUnattendedRunController({controllerState:{},controllerOperations:{},
      controllerPorts:{summarizeUnattendedKeywordCheckpoint, hasSyncReconciliationSignal:() => false}});
    const project = request => {
      const run = OnStarvoiceTaskCenterCore.normalizeTaskRun(buildUnattendedTaskRun(request,null),{now:request.updatedAt});
      return {run,snapshot:OnStarvoiceCloudTaskAgent.buildTaskSnapshot(run,request.id,{}, {allowLiveHealth:false})};
    };
    globalThis.producer={controller,project,buildUnattendedTaskRun,settleUnattendedKeywordCheckpoint,summarizeUnattendedKeywordCheckpoint,
      normalizeUnattendedKeywordPlan, updateUnattendedKeywordRun,setRequest:request=>{fixtureRequest=request;}};`, context);
  const {producer} = context;
  const keywords = ['alpha', 'beta'];
  let checkpoint = producer.settleUnattendedKeywordCheckpoint({keywords, keyword: 'alpha', originalIndex: 0,
    result: {ok: true}, recordIds: ['saved-1'], now: '2026-09-06T01:59:58.000Z'}).checkpoint;
  checkpoint = producer.settleUnattendedKeywordCheckpoint({checkpoint, keywords, keyword: 'beta', originalIndex: 1,
    attempt: 2, result: {ok: false, error: 'offline fixture non-safety failure'},
    recordIds: [], now: '2026-09-06T01:59:59.000Z'}).checkpoint;
  const summary = producer.summarizeUnattendedKeywordCheckpoint(checkpoint);
  const finishedAt = '2026-09-06T01:59:59.500Z';
  const request = {id: REQUEST, attemptId: ATTEMPT, attemptNumber: 1, progressSeq: 1,
    cloudAssigned: true, cloudCommandId: COMMAND, cloudAgentScopeId: AGENT,
    status: 'running', executionMode: 'one_time', createdAt: '2026-09-06T01:50:00.000Z',
    startedAt: '2026-09-06T01:50:01.000Z', updatedAt: '2026-09-06T01:59:57.000Z',
    heartbeatAt: '2026-09-06T01:59:57.000Z', businessProgressAt: '2026-09-06T01:59:57.000Z',
    planSnapshot: producer.normalizeUnattendedKeywordPlan(normalizeRemoteTaskInput({
      executionMode:'one_time',platform:'xiaohongshu',keywords}).planSnapshot)};
  producer.setRequest(request);
  const progress = producer.controller.buildUnattendedTerminalProgress({status:'completed_with_failures',
    summary, finishedAt, taskTotal:2, keywords, requestId:request.id, attemptId:ATTEMPT,
    streamingSync: {enabled:true, drainCompleted:true, enqueuedCount:1, processedCount:1,
      successCount:0, failedCount:1, skippedCount:0, pendingCount:0, activeCount:0, remainingCount:0,
      capturedUniqueCount:1, enqueuedUniqueCount:1, excludedUniqueCount:0, succeededUniqueCount:0,
      blocked:false,canceled:false}});
  const result = await producer.updateUnattendedKeywordRun({requestId:request.id, attemptId:ATTEMPT,
    patch:{status:'completed_with_failures',finishedAt,checkpoint,summary,progress,progressSeq:2,
      counts:producer.controller.buildUnattendedTaskCounts(checkpoint,summary,{total:2})}});
  assert.equal(result.accepted,true);
  const finalRequest = clone(result.data);
  const projection = producer.project(finalRequest);
  assert.equal(Object.hasOwn(projection.run.progress,'progressScope'),false,'real ledger drops raw-only fields');
  assert.equal(Object.hasOwn(projection.snapshot,'summary'),false,'real snapshot has no raw summary');
  return {request:finalRequest, project:request=>clone(producer.project(request)),
    buildRawRun:request=>clone(producer.buildUnattendedTaskRun(request,null)),
    run:clone(projection.run), snapshot:clone(projection.snapshot)};
}
const fixture = await producerFixture();

function harness() {
  let time = BASE + 1000, sequence = 0, ready = true, callerLive = true;
  const state = {request:clone(fixture.request), ledger:{version:1,updatedAt:fixture.request.updatedAt,
    runs:[clone(fixture.run),{id:'other',counts:{saved:44},untouched:true}]}, archive:null};
  const auth = {authMutationId:'auth-generation-1',tenant:{id:TENANT},
    captureAgent:{id:AGENT,token:'synthetic-private-token-not-an-authorization'}};
  const effects = {reads:0,network:0,writes:0,page:0,sync:0,verify:0};
  const requests = [], commits = [];
  const timers = new Map();let timerSeq=0;
  let onlineHook = null, commitHook = null, responseHook = null, authorityEvaluator = null;
  const context = vm.createContext({crypto:webcrypto,TextEncoder,AbortController,setTimeout,clearTimeout});
  vm.runInContext(read('utils/control/terminal-authority.js'),context);
  const api = context.OnStarvoiceTerminalAuthority;
  const authority = api.createTerminalAuthority({extensionId:EXTENSION_ID,generation:'background-generation-1',
    now:()=>time, randomId:()=>`opaque-${++sequence}`, isReady:()=>ready, isCallerCurrent:()=>callerLive,
    setTimer:callback=>{const id=++timerSeq;timers.set(id,callback);return id;},
    clearTimer:id=>timers.delete(id),
    readCredential:async()=>{effects.reads++;return clone(auth);},
    readState:async()=>{effects.reads++;return clone(state);},
    buildProjection:fixture.project,
    async checkOnlineAuthority(body,options) {
      effects.network++; requests.push(clone(body));
      assert.equal(options.rawAuth.captureAgent.token,auth.captureAgent.token);
      assert.ok(options.signal instanceof AbortSignal);
      if (onlineHook) await onlineHook(body,options);
      if (authorityEvaluator) return await authorityEvaluator(body,options,time);
      const {settlement,...identity} = body.source;
      const response = {ok:true,action:api.ACTION,decision:'allow',reason:'terminal_metadata_authorized',
        policyVersion:api.POLICY,authorityRevision:'a'.repeat(64),tenantId:TENANT,agentId:AGENT,
        authCodeId:CODE,authBindingId:BINDING,source:{...identity,
          serverTaskId:'server-task-1',serverAttemptId:'server-attempt-1',snapshotId:'snapshot-1',
          snapshotFingerprint:'b'.repeat(64)},evaluatedAt:new Date(time).toISOString(),
        expiresAt:new Date(time+5000).toISOString()};
      return responseHook ? responseHook(response) : response;
    },
    async commitTerminalMetadata(input) {
      if (commitHook) await commitHook(input);
      const validation = input.validateCurrent(clone(state),clone(auth));
      if (validation.accepted !== true) return validation;
      effects.writes++; commits.push(input);
      const at = new Date(time).toISOString();
      state.request = {...state.request,updatedAt:at,recoveryDismissedAt:at,
        recoveryDismissedMessage:'已撤销这次任务的本地恢复建议；已有结果和同步状态不变。'};
      state.ledger = {...state.ledger,updatedAt:at,runs:state.ledger.runs.map(run=>run.id===state.request.id?{...run,updatedAt:at}:run)};
      return {accepted:true,persisted:true};
    }});
  return {api,authority,state,auth,effects,requests,commits,
    prepare:(message={action:api.ACTION},from=sender)=>authority.prepare(message,from),
    execute:(handle,from=sender)=>authority.execute({action:api.ACTION,handle},from),
    advance:ms=>{time+=ms;},setReady:value=>{ready=value;},setCallerLive:value=>{callerLive=value;},
    onOnline:hook=>{onlineHook=hook;},onResponse:hook=>{responseHook=hook;},onCommit:hook=>{commitHook=hook;},
    useAuthority:hook=>{authorityEvaluator=hook;},fireTimers:()=>{for(const callback of timers.values())callback();timers.clear();}};
}

function serverRow(time=BASE+1000) {
  const raw=fixture.request,normalized=normalizeCloudTaskSnapshot(clone(fixture.snapshot));
  const identity={tenant_id:TENANT,agent_id:AGENT,auth_code_id:CODE,auth_binding_id:BINDING,
    expires_at:null,token_id:'test-token-row',token_created_at:raw.createdAt,
    agent_updated_at:raw.updatedAt,bound_at:raw.createdAt};
  const task={id:REQUEST,tenant_id:TENANT,origin_agent_id:AGENT,assigned_agent_id:AGENT,
    task_type:normalized.taskType,client_task_id:REQUEST,control_task_id:REQUEST,
    attempt_number:raw.attemptNumber,progress_seq:raw.progressSeq,source_updated_at:raw.updatedAt,
    finished_at:raw.finishedAt,platform:normalized.platform,status:normalized.status,
    progress:normalized.progress,counts:normalized.counts,checkpoint:normalized.checkpoint,
    metadata:{...normalized.metadata,createCommandId:COMMAND},error:{},updated_at:raw.updatedAt};
  const attempt={id:'ba573de5-2b4a-4b6c-9834-40a3f01fdd3f',task_id:REQUEST,tenant_id:TENANT,
    agent_id:AGENT,client_attempt_id:ATTEMPT,attempt_number:raw.attemptNumber,progress_seq:raw.progressSeq,
    status:raw.status,progress:clone(normalized.progress),checkpoint:clone(normalized.checkpoint),
    finished_at:raw.finishedAt,error:{},updated_at:raw.updatedAt};
  const snapshot={...clone(task),id:101,task_id:REQUEST,agent_id:AGENT,attempt_id:attempt.id,
    client_attempt_id:ATTEMPT,metadata:clone(normalized.metadata),snapshot_fingerprint:'a'.repeat(64)};
  const command={id:COMMAND,task_id:REQUEST,tenant_id:TENANT,agent_id:AGENT,command_type:'create',
    status:'completed',finished_at:raw.createdAt,updated_at:raw.createdAt,
    payload:{taskId:REQUEST,clientTaskId:REQUEST,authCodeId:CODE,authBindingId:BINDING,planSnapshot:raw.planSnapshot}};
  return {evaluated_at:new Date(time).toISOString(),identity,evidence:[{task,attempt,snapshot,command,
    attempt_conflict:false,command_conflict:false,successor_conflict:false}]};
}

test('client-produced request and server-normalized mirror pass the actual read-only authority service',async()=>{
  const h=harness(),row=serverRow(),before=clone(row),queries=[];
  h.useAuthority((body,options,time)=>evaluateTerminalControlAuthority({token:options.rawAuth.captureAgent.token,body:clone(body)},
    {now:()=>time,readOne:async(sql,params)=>{queries.push({sql,params});return clone(row);}}));
  const prepared=await h.prepare();
  assert.equal(prepared.accepted,true,JSON.stringify(prepared));
  const result=await h.execute(prepared.handle);
  assert.equal(result.reason,'terminal_metadata_persisted',JSON.stringify(result));
  assert.equal(queries.length,2);
  assert.equal(h.effects.writes,1);
  assert.deepEqual(row,before,'authority fixture remains SELECT-only');
});

test('real terminal producer to ledger/snapshot projections authorize a single metadata commit',async()=>{
  const h=harness(),before=clone(h.state),authBefore=clone(h.auth);
  const prepared=await h.prepare();
  assert.equal(prepared.accepted,true,JSON.stringify(prepared));
  assert.equal(prepared.persisted,false);
  assert.deepEqual(Object.keys(prepared).sort(),['accepted','action','expiresAt','handle','ok','persisted','reason']);
  const result=await h.execute(prepared.handle);
  assert.equal(result.reason,'terminal_metadata_persisted',JSON.stringify(result));
  assert.equal(h.effects.network,2,'execute requires a new online authority decision');
  assert.equal(h.effects.writes,1);
  assert.equal(h.state.request.summary.saved,1);
  assert.equal(h.state.request.progress.streamingSyncFailedCount,1,'failed upload preserved');
  const {updatedAt,recoveryDismissedAt,recoveryDismissedMessage,...unchanged}=h.state.request;
  const {updatedAt:previousUpdatedAt,...previous}=before.request;
  assert.deepEqual(unchanged,previous);
  assert.deepEqual(h.state.ledger.runs[1],before.ledger.runs[1]);
  assert.deepEqual(h.auth,authBefore);
  assert.equal(h.effects.page+h.effects.sync+h.effects.verify,0);
  const replay=await h.execute(prepared.handle);
  assert.equal(replay.replayed,true);
  assert.equal(h.effects.writes,1);
  assert.equal(h.effects.network,2,'receipt replay is not new permission');
  assert.equal(JSON.stringify(result).includes('token'),false);
  assert.equal(JSON.stringify(prepared).includes('snapshot'),false);
});

for(const [name,mutate] of [
  ['foreign extension',value=>({...value,id:'p'.repeat(32)})],
  ['content page',value=>({...value,url:'https://www.xiaohongshu.com/explore'})],
  ['lookalike path',value=>({...value,url:value.url+'.other'})],
  ['query string',value=>({...value,url:value.url+'?run=1'})],
  ['missing document',value=>({...value,documentId:undefined})],
  ['inactive document',value=>({...value,documentLifecycle:'cached'})],
  ['iframe',value=>({...value,frameId:1})],
  ['tab mismatch',value=>({...value,tab:{id:2,url:'https://example.invalid/'}})],
]) test(`rejects ${name} sender before reading credentials or invoking any port`,async()=>{
  const h=harness(),result=await h.prepare(undefined,mutate(sender));
  assert.equal(result.reason,'caller_invalid');
  assert.deepEqual(h.effects,{reads:0,network:0,writes:0,page:0,sync:0,verify:0});
});

test('UI permissions, source, token, and unknown command fields are never trusted',async()=>{
  for(const field of ['source','permissions','token','strictControl']) {
    const h=harness(),result=await h.prepare({action:h.api.ACTION,[field]:{allowed:true}});
    assert.equal(result.reason,'command_invalid');
    assert.equal(h.effects.reads+h.effects.network+h.effects.writes,0);
  }
});

test('accessor sender/message evidence is refused without executing the accessor',async()=>{
  const h=harness(); let called=0;
  const forged={...sender};Object.defineProperty(forged,'id',{enumerable:true,get(){called++;return EXTENSION_ID;}});
  assert.equal((await h.prepare(undefined,forged)).reason,'caller_invalid');
  const message={action:h.api.ACTION};Object.defineProperty(message,'source',{enumerable:true,get(){called++;return {};}});
  assert.equal((await h.prepare(message)).accepted,false);
  assert.equal(called,0);
});

for(const [name,mutate] of [
  ['synthesized legacy Attempt',h=>{h.state.request.attemptId='legacy-terminal-request-1';}],
  ['missing explicit pending-launch flag',h=>{delete h.state.request.recoveryPendingLaunch;}],
  ['pending launch',h=>{h.state.request.recoveryPendingLaunch=true;}],
  ['missing sync cancellation boolean',h=>{delete h.state.request.progress.streamingSyncCanceled;}],
  ['unknown sync cancellation boolean',h=>{h.state.request.progress.streamingSyncCanceled=null;}],
  ['unknown sync counter',h=>{delete h.state.request.progress.streamingSyncRemainingCount;}],
  ['needs action',h=>{h.state.request.status='needs_action';}],
  ['stale failed terminal',h=>{h.state.request.status='failed';h.state.request.error={code:'UNATTENDED_STALE'};}],
  ['partial source still has remaining work',h=>{h.state.request.checkpoint.keywordResults.pop();}],
  ['contradictory summary',h=>{h.state.request.summary.failed=0;}],
  ['truncated ledger checkpoint',h=>{h.state.ledger.runs[0].checkpoint.keywordResults.pop();}],
  ['duplicate ledger row',h=>{h.state.ledger.runs.push(clone(h.state.ledger.runs[0]));}],
  ['duplicate archive source',h=>{h.state.archive={requests:{other:clone(h.state.request)}};}],
  ['archive source under expected key',h=>{h.state.archive={requests:{[h.state.request.id]:{}}};}],
  ['missing archive observation',h=>{delete h.state.archive;}],
  ['unknown archive schema',h=>{h.state.archive={};}],
  ['safety evidence',h=>{h.state.request.checkpoint.keywordResults[1].securityBlocked=true;}],
  ['reconciliation signal',h=>{h.state.request.progress.syncReconciliationRequired=true;}],
  ['legacy closure evidence',h=>{h.state.request.localClosureStopConfirmation={sourceStopped:true};}],
  ['orchestration namespace',h=>{h.state.request.orchestrationContext={attemptIdentity:ATTEMPT};}],
  ['unsupported looping',h=>{h.state.request.planSnapshot.autoLoop=true;}],
  ['missing auth mutation identity',h=>{delete h.auth.authMutationId;}],
]) test(`${name} cannot acquire an opaque handle`,async()=>{
  const h=harness();mutate(h);
  const result=await h.prepare();
  assert.equal(result.accepted,false,JSON.stringify(result));
  assert.equal(h.effects.network+h.effects.writes,0,'invalid source never leaves this extension');
});

test('new background generation and another document cannot consume old handles',async()=>{
  const h=harness(),prepared=await h.prepare();
  assert.equal((await h.execute(prepared.handle,{...sender,documentId:'other-document'})).reason,'handle_invalid');
  const fresh=harness();
  assert.equal((await fresh.execute(prepared.handle)).reason,'handle_invalid');
  assert.equal(h.effects.writes+fresh.effects.writes,0);
});

test('unavailable locks and disconnected document deny before raw reads',async()=>{
  const h=harness();h.setReady(false);
  assert.equal((await h.prepare()).reason,'control_unavailable');
  h.setReady(true);h.setCallerLive(false);
  assert.equal((await h.prepare()).reason,'control_unavailable');
  assert.equal(h.effects.reads,0);
});

test('late online authority consumes the conservative local 5 second budget',async()=>{
  const h=harness();h.onOnline(()=>h.advance(5000));
  assert.equal((await h.prepare()).reason,'authority_expired');
  assert.equal(h.effects.writes,0);
});

test('unresponsive online provider is aborted and refused with no retry or fallback',async()=>{
  const h=harness();let started,signal;
  const entered=new Promise(resolve=>{started=resolve;});
  h.onOnline((body,options)=>{signal=options.signal;started();return new Promise(()=>{});});
  const pending=h.prepare();await entered;h.advance(5000);h.fireTimers();
  const result=await pending;
  assert.equal(result.reason,'authority_expired');
  assert.equal(signal.aborted,true);
  assert.equal(h.effects.network,1);
  assert.equal(h.effects.writes+h.effects.page+h.effects.sync+h.effects.verify,0);
});

test('an expired prepared handle cannot use a fresh online evaluation to renew itself',async()=>{
  const h=harness(),prepared=await h.prepare();h.advance(5000);
  assert.equal((await h.execute(prepared.handle)).reason,'handle_invalid');
  assert.equal(h.effects.network,1);
  assert.equal(h.effects.writes,0);
});

test('waiting for the final write fence consumes authority; expired handle cannot renew',async()=>{
  const h=harness(),prepared=await h.prepare();
  h.onCommit(()=>h.advance(5000));
  assert.equal((await h.execute(prepared.handle)).reason,'authority_expired');
  assert.equal(h.effects.writes,0);
  assert.equal((await h.execute(prepared.handle)).reason,'handle_invalid');
});

for(const [name,mutate] of [
  ['same-agent token replacement',h=>{h.auth.captureAgent.token='replacement';}],
  ['auth generation replacement',h=>{h.auth.authMutationId='replaced';}],
  ['tenant replacement',h=>{h.auth.tenant.id='tenant-other';}],
  ['binding replacement',h=>{h.auth.binding={id:'new-binding'};}],
  ['source predicate with unchanged updatedAt',h=>{h.state.request.recoveryPendingLaunch=true;}],
  ['archive inserted while waiting',h=>{h.state.archive={requests:{[h.state.request.id]:clone(h.state.request)}};}],
  ['source deleted by reset',h=>{h.state.request=null;h.state.ledger.runs=[];}],
]) test(`final private validator denies ${name} while waiting for the fence`,async()=>{
  const h=harness(),prepared=await h.prepare();
  assert.equal(prepared.accepted,true,JSON.stringify(prepared));
  h.onCommit(()=>mutate(h));
  assert.equal((await h.execute(prepared.handle)).accepted,false);
  assert.equal(h.effects.writes,0);
});

test('lost active caller port and explicit invalidation are checked again at commit',async()=>{
  const h=harness(),prepared=await h.prepare();
  h.onCommit(()=>h.authority.invalidateCaller({documentId:sender.documentId}));
  assert.equal((await h.execute(prepared.handle)).accepted,false);
  assert.equal(h.effects.writes,0);
});

test('one handle is reserved before awaits so concurrent execute cannot commit twice',async()=>{
  const h=harness(),prepared=await h.prepare();
  const [first,second]=await Promise.all([h.execute(prepared.handle),h.execute(prepared.handle)]);
  assert.equal(first.accepted,true,JSON.stringify(first));
  assert.equal(second.reason,'handle_consumed');
  assert.equal(h.effects.writes,1);
});

for(const [name,mutate] of [
  ['expired',response=>({...response,expiresAt:'2026-09-06T01:59:00.000Z'})],
  ['frozen',response=>({...response,ok:false,decision:'deny',reason:'agent_inactive'})],
  ['wrong tenant',response=>({...response,tenantId:'other'})],
  ['wrong source',response=>({...response,source:{...response.source,clientAttemptId:'other'}})],
  ['missing source witness',response=>({...response,source:{...response.source,snapshotId:''}})],
  ['missing revision',response=>({...response,authorityRevision:''})],
  ['wrong action',response=>({...response,action:'start_capture'})],
]) test(`online ${name} authority never grants local write permission`,async()=>{
  const h=harness();h.onResponse(mutate);
  assert.equal((await h.prepare()).accepted,false);
  assert.equal(h.effects.writes,0);
});

test('credential/token and raw fields cannot escape through arbitrary port errors',async()=>{
  const h=harness();h.onOnline(()=>{throw new Error(h.auth.captureAgent.token);});
  const result=await h.prepare();
  assert.equal(result.reason,'control_unavailable');
  assert.equal(JSON.stringify(result).includes(h.auth.captureAgent.token),false);
});

test('completed receipt cannot leak prior-scope IDs while auth change notification is delayed',async()=>{
  const h=harness(),prepared=await h.prepare();
  assert.equal((await h.execute(prepared.handle)).accepted,true);
  h.auth.captureAgent.token='new-identity-token-with-same-agent-id';
  const replay=await h.execute(prepared.handle);
  assert.equal(replay.reason,'handle_invalid');
  assert.equal(Object.hasOwn(replay,'requestId'),false);
  assert.equal(h.effects.writes,1);assert.equal(h.effects.network,2);
});

function deferred() {
  let resolve;
  const promise=new Promise(done=>{resolve=done;});
  return {promise,resolve};
}

async function realEntryHarness(t) {
  let time=BASE+1000,portDisconnect=null,listener=null,writeHook=null;
  const connectionListeners=[];
  const stored={},events=[],writes=[],queries=[],network=[],lockTails=new Map(),activeLocks=new Set();
  const lockContext=new AsyncLocalStorage();
  const eventWaiters=new Set();
  const recordEvent=event=>{events.push(event);for(const waiter of eventWaiters)waiter();};
  const waitForEvent=(event,count=1)=>new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{eventWaiters.delete(check);reject(new Error(`missing deterministic event ${event}`));},2000);
    const check=()=>{if(events.filter(item=>item===event).length>=count){clearTimeout(timeout);eventWaiters.delete(check);resolve();}};
    eventWaiters.add(check);check();
  });
  const row=serverRow(time);
  const app=express();app.use(express.json());
  app.use('/api/capture-cloud',createCaptureControlAuthorityRouter({evaluate:args=>
    evaluateTerminalControlAuthority(args,{now:()=>time,readOne:async(sql,params)=>{
      queries.push({sql,params});return clone(row);}})}));
  const server=await new Promise(resolve=>{
    const value=app.listen(0,'127.0.0.1',()=>resolve(value));
  });
  t.after(()=>new Promise(resolve=>{server.closeAllConnections?.();server.close(resolve);}));
  const origin=`http://127.0.0.1:${server.address().port}`;
  class ClockDate extends Date {
    constructor(...args){super(...(args.length?args:[time]));}
    static now(){return time;}
  }
  const locks={request(name,options,operation){
    assert.equal(options.mode,'exclusive');
    recordEvent(`queue:${name}`);
    const tail=lockTails.get(name)||Promise.resolve();
    const pending=tail.then(async()=>{
      assert.equal(activeLocks.has(name),false,'no same-lock reentry');
      activeLocks.add(name);recordEvent(`enter:${name}`);
      try{return await lockContext.run([...(lockContext.getStore()||[]),name],operation);}
      finally{activeLocks.delete(name);recordEvent(`exit:${name}`);}
    });
    lockTails.set(name,pending.catch(()=>null));return pending;
  }};
  const chrome={runtime:{id:EXTENSION_ID,getURL:path=>`chrome-extension://${EXTENSION_ID}/${path}`,
    onMessage:{addListener:callback=>{listener=callback;}},onConnect:{addListener:callback=>{connectionListeners.push(callback);}}},
    storage:{local:{
      async get(keys){events.push('storage:get');const list=typeof keys==='string'?[keys]:keys;
        return Object.fromEntries(list.filter(key=>Object.hasOwn(stored,key)).map(key=>[key,clone(stored[key])]));},
      async set(patch){writes.push(clone(patch));if(writeHook)await writeHook(patch,writes.length);
        Object.assign(stored,clone(patch));events.push('storage:set');},
      async remove(keys){for(const key of typeof keys==='string'?[keys]:keys)delete stored[key];events.push('storage:remove');},
    }},
  };
  const context=vm.createContext({chrome,navigator:{locks},crypto:webcrypto,TextEncoder,AbortController,
    Date:ClockDate,URL,setTimeout,clearTimeout,console,
    __ONSTARVOICE_API_BASE_URL__:origin,__ONSTARVOICE_BUILD_TARGET__:'local',
    buildUnattendedTaskRun:fixture.buildRawRun,
    controlStorageReserveApi:{isStorageQuotaError:error=>error?.name==='QuotaExceededError'},
    async fetch(url,options){
      assert.equal((lockContext.getStore()||[]).length,0,'online caller does not own write locks');
      assert.equal(new URL(url).origin,origin,'no customer API request');
      assert.equal(new URL(url).pathname,'/api/capture-cloud/agent/control-authority');
      assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');
      network.push({url:String(url),body:JSON.parse(options.body)});
      return await fetch(url,options);
    }});
  for(const file of ['utils/task-center.js','utils/cloud-task-agent.js','utils/capture/task-owner.js','utils/control/state-fence.js','utils/control/terminal-authority.js']) {
    vm.runInContext(read(file),context,{filename:file});
  }
  const functions=['runUnattendedRunMutation','runTaskLedgerMutation','runUnattendedRunArchiveMutation',
    'invalidateTerminalMetadataAuthority','handleTerminalMetadataConnection','readTerminalMetadataState',
    'readTerminalMetadataCredential','buildTerminalMetadataProjection','queryTerminalMetadataAuthority',
    'commitAuthorizedTerminalMetadata','getTerminalMetadataAuthority','getUnattendedTaskCenterCore'];
  const keysStart=background.indexOf('const STORAGE_KEYS = {');
  const keysSource=background.slice(keysStart,background.indexOf('\n};',keysStart)+3);
  // Register the unchanged, complete real runtime listeners. Unused legacy
  // branches stay uninvoked, rather than testing a retyped dispatch facade.
  const listeners=background.slice(background.indexOf('chrome.runtime.onConnect.addListener('));
  vm.runInContext(`${keysSource}
    const cloudTaskAgentApi=OnStarvoiceCloudTaskAgent;
    const captureTaskOwnerCoordinator=OnStarvoiceCaptureTaskOwner.createCoordinator({
      setTimeoutFn:()=>{throw new Error('strict control must not start old owner timers');},
      onAbandoned:()=>{throw new Error('strict control must not abandon a legacy owner');}});
    let terminalMetadataAuthority=null;
    const terminalMetadataCallers=new Map();
    let unattendedRunMutationQueue=Promise.resolve(),taskLedgerMutationQueue=Promise.resolve(),unattendedRunArchiveMutationQueue=Promise.resolve();
    ${functions.map(name=>declaration(background,name)).join('\n')}
    ${listeners}
    globalThis.entry={keys:STORAGE_KEYS,runUnattendedRunMutation,runTaskLedgerMutation,
      runUnattendedRunArchiveMutation,invalidateTerminalMetadataAuthority};`,context);
  const {entry}=context,keys=entry.keys;
  stored[keys.unattendedKeywordRunRequest]=clone(fixture.request);
  stored[keys.taskLedger]={version:1,updatedAt:fixture.request.updatedAt,
    runs:[clone(fixture.run),{id:'unrelated-task',counts:{saved:3},keep:true}]};
  stored[keys.auth]={authMutationId:'auth-state-1',tenant:{id:TENANT},
    captureAgent:{id:AGENT,token:'synthetic-real-entry-token'}};
  stored[keys.unattendedKeywordPlan]={enabled:true,untouched:true};
  stored[keys.runtime]={untouched:true};
  stored['synthetic.results']={body:'must survive',syncStatus:'failed'};
  const connect=(from=sender)=>{
    const disconnects=[];
    const port={name:'onstarvoice:terminal-control-client-v1',sender:clone(from),
      onDisconnect:{addListener:callback=>disconnects.push(callback)},
      disconnect(){for(const callback of disconnects)callback();}};
    for(const connectionListener of connectionListeners)connectionListener(port);
    portDisconnect=()=>port.disconnect();return port;
  };
  const send=(type,extra={},from=sender)=>new Promise(resolve=>{
    assert.equal(listener({type,action:'dismiss_terminal_recovery_metadata',...extra},clone(from),resolve),true);
  });
  return {context,entry,keys,stored,events,writes,queries,network,row,connect,waitForEvent,
    disconnect:()=>portDisconnect?.(),advance:ms=>{time+=ms;},onWrite:hook=>{writeHook=hook;},
    prepare:(from=sender)=>send('onstarvoice:prepare-terminal-recovery-dismissal',{},from),
    execute:(handle,from=sender)=>send('onstarvoice:execute-terminal-recovery-dismissal',{handle},from),
    fence:context.OnStarvoiceControlStateFence,locks,
  };
}

test('real connected runtime messages traverse read-only Router and all final write queues once',async t=>{
  const h=await realEntryHarness(t),before=clone(h.stored);h.connect();
  const prepared=await h.prepare();assert.equal(prepared.accepted,true,JSON.stringify(prepared));
  const result=await h.execute(prepared.handle);assert.equal(result.reason,'terminal_metadata_persisted',JSON.stringify(result));
  assert.equal(h.queries.length,2);assert.equal(h.network.length,2);assert.equal(h.writes.length,1);
  assert.deepEqual(Object.keys(h.writes[0]).sort(),[h.keys.unattendedKeywordRunRequest,h.keys.taskLedger].sort());
  for(const key of Object.keys(before).filter(key=>![h.keys.unattendedKeywordRunRequest,h.keys.taskLedger].includes(key))) {
    assert.deepEqual(h.stored[key],before[key],key);
  }
  assert.deepEqual(h.stored[h.keys.taskLedger].runs[1],before[h.keys.taskLedger].runs[1]);
  assert.equal(h.stored[h.keys.unattendedKeywordRunRequest].progress.streamingSyncFailedCount,1);
  assert.ok(h.events.indexOf('enter:onstarvoice:auth-state')<h.events.indexOf('enter:onstarvoice:control-state-v1'));
  assert.equal((await h.execute(prepared.handle)).replayed,true);assert.equal(h.writes.length,1);
});

test('real runtime entry without a live document connection cannot read or authorize',async t=>{
  const h=await realEntryHarness(t);
  assert.equal((await h.prepare()).reason,'control_unavailable');
  assert.equal(h.events.length+h.network.length+h.writes.length,0);
});

test('real runtime document disconnect in U queue prevents final metadata write',async t=>{
  const h=await realEntryHarness(t);h.connect();const prepared=await h.prepare();
  const gate=deferred(),entered=deferred();
  const blocker=h.entry.runUnattendedRunMutation(async()=>{entered.resolve();await gate.promise;});
  await entered.promise;
  const pending=h.execute(prepared.handle);
  // The online response was accepted and the real commit owns Auth while U waits.
  await h.waitForEvent('enter:onstarvoice:auth-state');
  h.disconnect();gate.resolve();await blocker;
  assert.equal((await pending).accepted,false);assert.equal(h.writes.length,0);
});

for(const queue of ['runUnattendedRunMutation','runTaskLedgerMutation','runUnattendedRunArchiveMutation']) {
  test(`real ${queue} wait consumes the same five second authority deadline`,async t=>{
    const h=await realEntryHarness(t);h.connect();const prepared=await h.prepare();
    const gate=deferred(),entered=deferred();
    const blocker=h.entry[queue](async()=>{entered.resolve();await gate.promise;});
    await entered.promise;const pending=h.execute(prepared.handle);
    await h.waitForEvent('enter:onstarvoice:auth-state');h.advance(5000);gate.resolve();await blocker;
    assert.equal((await pending).accepted,false);assert.equal(h.writes.length,0);
  });
}

test('real Auth to Q replacement wins over queued command without same-agent token inheritance',async t=>{
  const h=await realEntryHarness(t);h.connect();const prepared=await h.prepare();
  const gate=deferred(),entered=deferred();
  const replacement=h.fence.runAuth(async()=>{entered.resolve();await gate.promise;
    await h.fence.run(async()=>{h.stored[h.keys.auth].captureAgent.token='replaced-same-agent-token';});});
  await entered.promise;const pending=h.execute(prepared.handle);
  await h.waitForEvent('queue:onstarvoice:auth-state',2);gate.resolve();await replacement;
  assert.equal((await pending).accepted,false);assert.equal(h.writes.length,0);
});

test('real Auth to Q reset cannot be followed by task resurrection',async t=>{
  const h=await realEntryHarness(t);h.connect();const prepared=await h.prepare();
  const gate=deferred(),entered=deferred();
  const reset=h.fence.runAuth(async()=>{entered.resolve();await gate.promise;
    await h.fence.run(async()=>{delete h.stored[h.keys.auth];delete h.stored[h.keys.unattendedKeywordRunRequest];delete h.stored[h.keys.taskLedger];});});
  await entered.promise;const pending=h.execute(prepared.handle);
  await h.waitForEvent('queue:onstarvoice:auth-state',2);gate.resolve();await reset;
  assert.equal((await pending).accepted,false);assert.equal(h.writes.length,0);
  assert.equal(Object.hasOwn(h.stored,h.keys.unattendedKeywordRunRequest),false);
});

test('real final Q wait cannot renew authority after other writers finish',async t=>{
  const h=await realEntryHarness(t);h.connect();const prepared=await h.prepare();
  const gate=deferred(),entered=deferred();
  const writer=h.fence.run(async()=>{entered.resolve();await gate.promise;});
  await entered.promise;const pending=h.execute(prepared.handle);
  await h.waitForEvent('queue:onstarvoice:control-state-v1',2);
  h.advance(5000);gate.resolve();await writer;
  assert.equal((await pending).accepted,false);assert.equal(h.writes.length,0);
});

test('real same-document port replacement rotates handles and old disconnect cannot remove new connection',async t=>{
  const h=await realEntryHarness(t),oldPort=h.connect();const prepared=await h.prepare();
  h.connect();oldPort.disconnect();
  assert.equal((await h.execute(prepared.handle)).accepted,false);
  assert.equal(h.writes.length,0);
  const fresh=await h.prepare();assert.equal(fresh.accepted,true,JSON.stringify(fresh));
  assert.equal((await h.execute(fresh.handle)).reason,'terminal_metadata_persisted');
  assert.equal(h.writes.length,1);
});

test('real quota retry rereads predicates and preserves results instead of replaying a stale patch',async t=>{
  const h=await realEntryHarness(t);h.connect();const prepared=await h.prepare();
  h.onWrite((patch,number)=>{if(number===1){h.stored[h.keys.unattendedKeywordRunRequest].recoveryPendingLaunch=true;
    const error=new Error('synthetic quota');error.name='QuotaExceededError';throw error;}});
  assert.equal((await h.execute(prepared.handle)).accepted,false);
  assert.equal(h.writes.length,1,'second entry rejected before a second write');
  assert.equal(h.stored[h.keys.unattendedKeywordRunRequest].recoveryDismissedAt,undefined);
  assert.deepEqual(h.stored['synthetic.results'],{body:'must survive',syncStatus:'failed'});
});

test('real quota retry can succeed once with fresh reads and no extra network or reserve cleanup',async t=>{
  const h=await realEntryHarness(t);h.connect();const prepared=await h.prepare();
  h.onWrite((patch,number)=>{if(number===1){const error=new Error('synthetic quota');error.name='QuotaExceededError';throw error;}});
  assert.equal((await h.execute(prepared.handle)).reason,'terminal_metadata_persisted');
  assert.equal(h.writes.length,2);assert.equal(h.network.length,2);
  assert.equal(h.events.includes('storage:remove'),false);
});
