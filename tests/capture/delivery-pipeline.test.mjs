import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import {createResultDeliveryPipeline} from '../../utils/capture/delivery/coordinator.js';
import * as constants from '../../utils/constants.js';
import * as helpers from '../../utils/helpers.js';
import * as classification from '../../utils/capture/sync-response-classification.js';
import * as router from '../../utils/platform/sync-router.js';
import * as dedupe from '../../utils/comment-dedupe.js';
import * as recovery from '../../utils/capture-recovery.js';
import * as author from '../../utils/capture/douyin-author.js';

const root = new URL('../../', import.meta.url);
const hostSource = readFileSync(new URL('utils/capture-sync.js', root), 'utf8');
const fixture = JSON.parse(readFileSync(new URL('tests/fixtures/capture-delivery-body-fingerprints.json', root), 'utf8'));
const functionNames = fixture.entries.map(({name}) => name);
const plain = value => JSON.parse(JSON.stringify(value));
const clone = value => structuredClone(value);
function deferred() {let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}

// Execute the actual host body and actual ESM coordinator with only imported
// I/O capabilities substituted. No concatenated reconstruction of moved code.
// This also exercises EOF composition and host-to-stage compatibility aliases.
function createHostHarness({source=hostSource, records=[], responses=[], rejectWrite=false, pipelineFactory=createResultDeliveryPipeline}={}) {
  let pool={records:clone(records)};let sequence=0;let queue=Promise.resolve();
  const events=[];const controls={rejectWrite,responses:[...responses]};
  const tidy=value=>JSON.parse(JSON.stringify(value, (key,v)=>
    ['startedAt','batchStartedAt','finishedAt','createdAt','updatedAt','lastSyncedAt','lastAttemptedAt','captureTimestamp','durationMs'].includes(key)?undefined:v));
  const recordEvent=(...parts)=>events.push(tidy(parts));
  const persistRecord=record=>{recordEvent('save-one',record);pool.records.unshift(clone(record));return Promise.resolve(record);};
  const persistRecords=records=>{recordEvent('save-many',records);pool.records.unshift(...clone(records));return Promise.resolve(records);};
  const context=vm.createContext({
    ...constants,...helpers,...classification,...dedupe,...recovery,...author,
    createResultDeliveryPipeline:pipelineFactory,URL,TextEncoder,Date,Math,console:{log(){},warn(){},error(){}},
    buildPlatformSyncInput:router.buildSyncInput,
    buildSyncHistoryTarget:router.buildSyncHistoryTarget,
    resolveSyncTableName:router.resolveSyncTableName,
    createRecordEnvelope:({platform,type,data,meta})=>({id:`prepared-${++sequence}`,platform,type,payload:data,meta,status:'draft'}),
    addRecord:persistRecord,addRecords:persistRecords,persistRecord,persistRecords,
    getDataPool:async()=>{recordEvent('read-pool');return clone(pool);},
    setDataPool:async value=>{recordEvent('write-pool',value);if(controls.rejectWrite==='throw')throw Error('synthetic write failure');if(controls.rejectWrite)return false;pool=clone(value);return true;},
    runDataPoolMutation:operation=>{const pending=queue.then(operation,operation);queue=pending.catch(()=>null);return pending;},
    getRecord:async id=>clone(pool.records.find(record=>record.id===id)),
    getRecords:async ids=>clone(pool.records.filter(record=>ids.includes(record.id))),
    updateRecord:async(id,patch)=>{recordEvent('update-record',id,patch);const record=pool.records.find(r=>r.id===id);if(!record)return false;Object.assign(record,clone(patch));return record;},
    markRecordSynced:async(id,url)=>{recordEvent('confirm-record',id,url);const record=pool.records.find(r=>r.id===id);if(!record)return false;record.status='synced';return record;},
    updateSync:async patch=>recordEvent('sync-state',patch),
    getTarget:async()=>({}),getCaptureSettings:async()=>({}),getAuth:async()=>({verified:true,code:'SYNTHETIC'}),
    getActiveTaskContext:()=>({taskId:'synthetic-cloud-task'}),
    recordDiagnosticError:async()=>{},
    addSyncHistoryEntry:async entry=>recordEvent('history',entry),
    sync:async request=>{recordEvent('request-one',request);return controls.responses.shift()||{ok:true,data:{debugUrl:'https://example.invalid/ack'}};},
    syncBatch:async(records,target)=>{recordEvent('request-batch',records,target);return controls.responses.shift()||{ok:true,data:{items:records.map(record=>({recordId:record.id,ok:true}))}};},
  });
  let executable=source.replace(/^import\s*(?:\{[^}]*\}\s*from\s*)?['"][^'"]+['"];[^\S\n]*\n/gmu,'');
  executable=executable.replace(/^export \{[^}]*\};/gmu,'').replace(/^export (?=(?:async )?function\b)/gmu,'');
  assert.doesNotMatch(executable,/^import\b|^export\b/mu);
  const expose = `globalThis.deliveryTestApi = {${functionNames.join(',')}};`;
  if (source.includes('export function createCaptureSyncScope(')) {
    const boundary = 'return Object.freeze({\n  beginCaptureTaskSession: scopedCaptureEntry(beginCaptureTaskSession),';
    assert.equal(executable.split(boundary).length, 2, 'one actual private host assembly');
    executable = executable.replace(boundary, `${expose}\n${boundary}`);
    executable += '\ncreateCaptureSyncScope({chromeApi:{}});';
  } else {
    // Exact historical Git objects predate the private capability scope.
    executable += `\n${expose}`;
  }
  vm.runInContext(executable,context,{filename:'actual-capture-sync-host',timeout:1000});
  return {api:context.deliveryTestApi,controls,events,context,get pool(){return clone(pool);},progress:event=>recordEvent('progress',event),tidy};
}

const profile=id=>({id,type:'blogger_profile',platform:'xiaohongshu',status:'draft',payload:{bloggerId:id,bloggerName:id}});
const keyword=id=>({id,type:'keyword_notes',platform:'xiaohongshu',status:'draft',payload:{keyword:'synthetic',items:[{noteId:id,url:`https://www.xiaohongshu.com/explore/${id}`,title:id,likes:3}]}});

test('cold ESM stage graph and empty assembly perform no host, clock, randomness or storage work',()=>{
  const script=`import assert from 'node:assert/strict';
    for(const key of ['chrome','browser','window','document','localStorage','indexedDB','fetch','Date','performance','setTimeout','setInterval'])Object.defineProperty(globalThis,key,{get(){throw Error('unexpected '+key);},configurable:true});
    Math.random=()=>{throw Error('unexpected randomness');};
    const {createResultDeliveryPipeline}=await import(${JSON.stringify(new URL('utils/capture/delivery/coordinator.js',root).href)});
    const api=createResultDeliveryPipeline({});assert.equal(Object.isFrozen(api),true);assert.equal(api.getActiveListCaptureCheckpointStats(),null);
    process.stdout.write('cold-safe');`;
  assert.equal(execFileSync(process.execPath,['--input-type=module','--eval',script],{encoding:'utf8',timeout:10000}),'cold-safe');
});

test('all 166 actual stage bodies retain the pinned baseline except explicit checkpoint ownership',()=>{
  const api=createResultDeliveryPipeline({});assert.equal(fixture.baseline,'5f774ebfcaed24b79bfe84369d9b9c483da38f66');assert.equal(fixture.entries.length,166);
  for(const {name,sha256}of fixture.entries){const source=api[name].toString().replace(/\bstate\.activeListCaptureCheckpointSession\b/gu,'activeListCaptureCheckpointSession').split('\n').map(line=>line.trim()).join('\n');assert.equal(createHash('sha256').update(source).digest('hex'),sha256,name);}
  for(const key of ['state','activeListCaptureCheckpointSession','queue','operations'])assert.equal(Object.hasOwn(api,key),false);
});

test('prepared record ports retain parameters, synchronous values and the exact Promise without another queue',async()=>{
  const one={id:'one'};const many=[one];const pending=Promise.resolve(many);const calls=[];
  const api=createResultDeliveryPipeline({persistRecord(...args){calls.push(args);return one;},persistRecords(...args){calls.push(args);return pending;}});
  assert.equal(api.savePreparedRecord(one,'metadata'),one);assert.equal(api.savePreparedRecords(many,'metadata'),pending);assert.equal(await pending,many);assert.deepEqual(calls,[[one,'metadata'],[many,'metadata']]);
});

test('host stores and checkpoint instances remain isolated and an old finish cannot clear a new session',()=>{
  const a=createHostHarness();const b=createHostHarness();const old=a.api.beginListCaptureCheckpointSession({mode:'keyword_notes'});
  old.id='old-session';const current=a.api.beginListCaptureCheckpointSession({mode:'keyword_notes'});current.id='current-session';current.stats.savedCount=7;
  assert.equal(b.api.getActiveListCaptureCheckpointStats(),null);a.api.finishListCaptureCheckpointSession(old);assert.equal(a.api.getActiveListCaptureCheckpointStats().savedCount,7);
  a.api.finishListCaptureCheckpointSession(current);assert.equal(a.api.getActiveListCaptureCheckpointStats(),null);
});

for(const rejectWrite of [false,true,'throw'])test(`list persistence retains confirmation order and recoverable dedupe: ${rejectWrite}`,async()=>{
  const h=createHostHarness({rejectWrite});const s=h.api.beginListCaptureCheckpointSession({mode:'keyword_notes'});const r=keyword('save-test');
  if(rejectWrite){await assert.rejects(h.api.saveRecordsWithCacheDedupe([r],{session:s}),/write failure|本地缓存写入失败/u);assert.equal(s.knownKeys.size,0);assert.equal(s.stats.savedCount,0);assert.deepEqual(h.pool.records,[]);h.controls.rejectWrite=false;}
  await h.api.saveRecordsWithCacheDedupe([r],{session:s});assert.equal(s.stats.savedCount,1);assert.equal(s.knownKeys.size>0,true);assert.equal(h.pool.records.length,1);
  const writes=h.events.filter(e=>e[0]==='write-pool').length;await h.api.saveRecordsWithCacheDedupe([r],{session:s});assert.equal(h.events.filter(e=>e[0]==='write-pool').length,writes);assert.equal(s.stats.savedCount,1);
});

test('finalization waits its checkpoint queue while another pipeline can save independently',async()=>{
  const a=createHostHarness();const b=createHostHarness();const gate=deferred();const s=a.api.beginListCaptureCheckpointSession({mode:'keyword_notes'});s.queue=gate.promise;
  const result={ok:true,type:'keyword_notes',platform:'xiaohongshu',data:keyword('queued').payload};
  const waiting=a.api.saveCaptureResultRecords(result,{session:s});await Promise.resolve();assert.deepEqual(a.events,[]);
  await b.api.saveCaptureResultRecords({...result,type:'blogger_profile',data:{bloggerName:'independent'}});assert.equal(b.events[0][0],'save-one');gate.resolve();await waiting;assert.equal(a.pool.records.length,1);
});

test('single submission preserves content confirmation before final progress and history',async()=>{
  const h=createHostHarness({records:[profile('one')]});const result=await h.api.syncRecord('one',h.progress,{captureSettings:{}});assert.equal(result.ok,true);
  const kind=h.events.map(e=>e[0]);assert.ok(kind.indexOf('request-one')<kind.indexOf('confirm-record'));assert.ok(kind.indexOf('confirm-record')<kind.lastIndexOf('progress'));assert.ok(kind.lastIndexOf('progress')<kind.indexOf('history'));
});

test('batch mixed and absent ACKs preserve exact record confirmation, progress and pause ownership',async()=>{
  const h=createHostHarness({records:[keyword('a'),keyword('b'),keyword('c'),keyword('d')],responses:[{ok:true,data:{items:[{recordId:'a',ok:true},{recordId:'b',ok:false,reason:'invalid_payload'},{recordId:'c',ok:false,reason:'timeout'}]}}]});
  const result=await h.api.syncRecordBatch(['a','b','c','d'],h.progress,{captureSettings:{},requestSpacingMs:0,rateLimitRetryAttempts:0});
  assert.deepEqual(h.events.filter(e=>e[0]==='confirm-record').map(e=>e[1]),['a']);assert.equal(h.pool.records.find(r=>r.id==='c').status,'draft');assert.equal(result.pausedCount,1);
  assert.equal(h.pool.records.find(r=>r.id==='d').status,'failed','legacy missing-ACK failure differs from explicit timeout; neither becomes a success');
  assert.ok(h.events.findIndex(e=>e[0]==='confirm-record')<h.events.findIndex(e=>e[0]==='progress'&&e[1]?.recordId==='a'));
});

test('cancelled batch cannot issue a request or confirm any record',async()=>{
  const h=createHostHarness({records:[keyword('a')]});const result=await h.api.syncRecordBatch(['a'],h.progress,{shouldStop:()=>true,captureSettings:{},requestSpacingMs:0});
  assert.equal(result.canceled,true);assert.equal(h.events.some(e=>e[0].startsWith('request')||e[0]==='confirm-record'),false);
});

test('separate batch requests are not serialized through an invented global submission queue',async()=>{
  const gate=deferred();const entered=deferred();
  // An I/O seam is captured during assembly, so create a fresh real host realm
  // with a delayed response rather than mutating any stage's operation table.
  const original=createResultDeliveryPipeline;let blockedApi;
  const wrapped=ports=>{const api=original({...ports,syncBatch:async(...args)=>{entered.resolve();await gate.promise;return ports.syncBatch(...args);}});blockedApi=api;return api;};
  const a=createHostHarness({records:[keyword('a')],pipelineFactory:wrapped});const b=createHostHarness({records:[keyword('b')]});
  const portsSource=hostSource.slice(hostSource.indexOf('const resultDelivery = createResultDeliveryPipeline('),hostSource.indexOf('\nconst {\n  appendFrontendSyncFailureHistory,',hostSource.indexOf('const resultDelivery ='))).replace('const resultDelivery =','globalThis.delayedDelivery =');
  assert.ok(portsSource.includes('waitMs,'));assert.equal(typeof a.api.syncRecordBatch,'function');
  const waiting=blockedApi.syncRecordBatch(['a'],null,{captureSettings:{},requestSpacingMs:0});await entered.promise;
  const other=await b.api.syncRecordBatch(['b'],null,{captureSettings:{},requestSpacingMs:0});assert.equal(other.ok,true);gate.resolve();assert.equal((await waiting).ok,true);
});

test('all original host export names remain present and old migrated bodies are absent',async()=>{
  const api=await import('../../utils/capture-sync.js');assert.equal(fixture.publicExports.length,45);
  assert.deepEqual(Object.keys(api).sort(),[...fixture.publicExports,'createCaptureSyncScope'].sort());
  assert.deepEqual(Object.keys(api.createCaptureSyncScope({chromeApi:{}})).sort(),fixture.publicExports);
  const privateHost = hostSource.slice(0,hostSource.indexOf('\nconst legacyChromeApi ='));
  assert.ok(privateHost.length>0);
  for(const name of functionNames){
    assert.doesNotMatch(privateHost,new RegExp(`\\bfunction ${name}\\(`,'u'));
    if(fixture.publicExports.includes(name))assert.match(api[name].toString(),new RegExp(`^(?:async )?function ${name}\\(\\.\\.\\.args\\) \\{\\s*return getLegacyCaptureSyncScope\\(\\)\\.${name}\\(\\.\\.\\.args\\);\\s*\\}$`,'u'));
    else assert.doesNotMatch(hostSource,new RegExp(`\\bfunction ${name}\\(`,'u'));
  }
  assert.match(hostSource,/addRecord as persistRecord/u);assert.match(hostSource,/savePreparedRecord: addRecord/u);assert.match(hostSource,/savePreparedRecords: addRecords/u);
  assert.doesNotMatch(hostSource,/\b(?:let|const) activeListCaptureCheckpointSession\b/u);
});

// Optional local differential audit against an exact Git object. CI still runs
// every above scenario without history/network requirements (Node 18 is shallow).
// This does not skip any regression test; it adds four local evidence cases.
if(process.env.ONSTARVOICE_L2_BASELINE_REF){
  assert.equal(process.env.ONSTARVOICE_L2_BASELINE_REF,fixture.baseline);
  const baseline=execFileSync('git',['show',`${fixture.baseline}:utils/capture-sync.js`],{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024});
  for(const scenario of ['single','batch-success','batch-mixed','canceled'])test(`exact baseline/candidate business event trace: ${scenario}`,async()=>{
    const results=[];
    for(const source of [baseline,hostSource]){
      const records=scenario==='single'?[profile('one')]:[keyword('a'),keyword('b')];
      const responses=scenario==='batch-mixed'?[{ok:true,data:{items:[{recordId:'a',ok:true},{recordId:'b',ok:false,reason:'timeout'}]}}]:[];
      const h=createHostHarness({source,records,responses});
      const result=scenario==='single'?await h.api.syncRecord('one',h.progress,{captureSettings:{}}):await h.api.syncRecordBatch(['a','b'],h.progress,{captureSettings:{},requestSpacingMs:0,rateLimitRetryAttempts:0,shouldStop:()=>scenario==='canceled'});
      results.push(h.tidy({result,events:h.events,pool:h.pool}));
    }
    assert.deepEqual(results[1],results[0]);
  });
}
