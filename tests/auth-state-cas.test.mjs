import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {AsyncLocalStorage} from "node:async_hooks";
import vm from "node:vm";
import {STORAGE_KEY} from "../utils/constants.js";

const authKey = "onstarvoice.auth";
const store = {
  [authKey]: {
    code: "encrypted-new-code",
    authMutationId: "mutation-new",
    verified: false,
  },
};

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        return Object.fromEntries((Array.isArray(keys) ? keys : [keys])
          .filter(key => Object.hasOwn(store, key)).map(key => [key, structuredClone(store[key])]));
      },
      async set(values) {
        Object.assign(store, values);
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
      },
    },
  },
};

const {updateAuth,setAuth,clearAuth,clearAll} = await import("../utils/storage.js?auth-state-cas");

test("a stale verification response cannot overwrite a newer auth mutation", async () => {
  const result = await updateAuth(
    {
      code: "encrypted-old-code",
      verified: true,
      captureAgent: {id: "old-agent", token: "old-token"},
    },
    {expectedMutationId: "mutation-old"},
  );

  assert.equal(result.accepted, false);
  assert.equal(store[authKey].code, "encrypted-new-code");
  assert.equal(store[authKey].captureAgent, undefined);
});

test("the current auth mutation can commit its verified snapshot", async () => {
  const result = await updateAuth(
    {
      verified: true,
      captureAgent: {id: "new-agent", token: "new-token"},
    },
    {expectedMutationId: "mutation-new"},
  );

  assert.equal(result.accepted, true);
  assert.equal(store[authKey].code, "encrypted-new-code");
  assert.equal(store[authKey].captureAgent.id, "new-agent");
});

const AUTH_LOCK='onstarvoice:auth-state';
const Q_LOCK='onstarvoice:control-state-v1';
const NativeDate=Date;
const clone=value=>structuredClone(value);
function deferred() {
  let resolve;
  const promise=new Promise(done=>{resolve=done;});
  return {promise,resolve};
}

// Actual ESM storage APIs and a second realm's actual fence share one synthetic
// Web Locks manager. No browser profile, real storage, or network is involved.
function storageHarness(t) {
  const originalChrome=globalThis.chrome;
  const navigatorDescriptor=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  const dateDescriptor=Object.getOwnPropertyDescriptor(globalThis,'Date');
  const values={},effects=[],events=[],tails=new Map(),waiters=new Set();
  const context=new AsyncLocalStorage();
  let beforeSet=null,afterSet=null,beforeRemove=null,clock=NativeDate.parse('2026-09-06T04:00:00.000Z');
  const event=entry=>{events.push(entry);for(const check of waiters)check();};
  const locks={request(name,options,operation){
    const owned=context.getStore()||[];
    assert.equal(options.mode,'exclusive');
    assert.equal(owned.includes(name),false,`same-lock reentry: ${name}`);
    assert.equal(owned.includes(Q_LOCK),false,'Q is a leaf; no public locking writer may run inside it');
    event(`queue:${name}`);
    const next=(tails.get(name)||Promise.resolve()).then(()=>context.run([...owned,name],async()=>{
      event(`enter:${name}`);
      try{return await operation();}finally{event(`exit:${name}`);}
    }));
    tails.set(name,next.catch(()=>null));return next;
  }};
  const keys=value=>Array.isArray(value)?value:[value];
  const storage={
    async get(input){
      const selected=input===null?Object.keys(values):keys(input);
      effects.push({type:'get',keys:[...selected],owned:[...(context.getStore()||[])]});
      return Object.fromEntries(selected.filter(key=>Object.hasOwn(values,key)).map(key=>[key,clone(values[key])]));
    },
    async set(patch){
      effects.push({type:'set',keys:Object.keys(patch),patch:clone(patch),owned:[...(context.getStore()||[])]});
      if(beforeSet)await beforeSet(patch);
      Object.assign(values,clone(patch));
      if(afterSet)await afterSet(patch);
    },
    async remove(input){
      const targets=keys(input);
      effects.push({type:'remove',keys:[...targets],owned:[...(context.getStore()||[])]});
      if(beforeRemove)await beforeRemove(targets);
      for(const key of targets)delete values[key];
    },
  };
  globalThis.chrome={storage:{local:storage}};
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks}});
  class ClockDate extends NativeDate {
    constructor(...args){super(...(args.length?args:[clock]));}
    static now(){return clock;}
  }
  Object.defineProperty(globalThis,'Date',{configurable:true,writable:true,value:ClockDate});
  const otherRealm=vm.createContext({navigator:{locks}});
  vm.runInContext(readFileSync(new URL('../utils/control/state-fence.js',import.meta.url),'utf8'),otherRealm);
  const other=otherRealm.OnStarvoiceControlStateFence;
  t.after(()=>{
    globalThis.chrome=originalChrome;
    if(navigatorDescriptor)Object.defineProperty(globalThis,'navigator',navigatorDescriptor);
    else delete globalThis.navigator;
    Object.defineProperty(globalThis,'Date',dateDescriptor);
  });
  const waitForEvent=(expected,count=1)=>new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{waiters.delete(check);reject(new Error(`missing event ${expected}`));},2000);
    const check=()=>{if(events.filter(entry=>entry===expected).length>=count){clearTimeout(timeout);waiters.delete(check);resolve();}};
    waiters.add(check);check();
  });
  values[STORAGE_KEY.AUTH]={code:'current-code',authMutationId:'mutation-current',
    tenant:{id:'tenant-current'},captureAgent:{id:'agent-current',token:'synthetic-private-token'}};
  values[STORAGE_KEY.UNATTENDED_KEYWORD_RUN_REQUEST]={id:'current-request',attemptId:'attempt-current',
    createdAt:'2026-09-06T03:00:00.000Z',updatedAt:'2026-09-06T03:59:00.000Z'};
  values[STORAGE_KEY.UNATTENDED_KEYWORD_RUN_ARCHIVE]={version:1,requests:{archive:{id:'archive'}}};
  values[STORAGE_KEY.TASK_LEDGER]={version:1,runs:[{id:'current-request'}],updatedAt:'2026-09-06T03:59:00.000Z'};
  for(const key of [STORAGE_KEY.RUNTIME,STORAGE_KEY.TARGET,STORAGE_KEY.CAPTURE,STORAGE_KEY.SYNC,
    STORAGE_KEY.MONITOR,STORAGE_KEY.DATA_POOL,STORAGE_KEY.SYNC_HISTORY]) values[key]={keptUntilSuccessfulReset:true};
  values[STORAGE_KEY.UNATTENDED_KEYWORD_PLAN]={enabled:true,notInResetWriteSet:true};
  values['unrelated-key']={preserve:true};
  return {values,effects,events,storage,other,waitForEvent,
    setBeforeSet:value=>{beforeSet=value;},setAfterSet:value=>{afterSet=value;},
    setBeforeRemove:value=>{beforeRemove=value;},setClock:value=>{clock=value;}};
}

for(const [name,invoke] of [
  ['setAuth',()=>setAuth({code:'replacement-code',authMutationId:'mutation-replacement'})],
  ['updateAuth',()=>updateAuth({verified:true},{expectedMutationId:'mutation-current'})],
  ['clearAuth',()=>clearAuth()],
]) test(`${name} waits for another realm's Q and writes only under Auth then Q`,async t=>{
  const h=storageHarness(t),before=clone(h.values),gate=deferred(),entered=deferred();
  const holder=h.other.run(async()=>{entered.resolve();await gate.promise;});
  await entered.promise;
  const pending=invoke();await h.waitForEvent(`queue:${Q_LOCK}`,2);
  assert.equal(h.effects.length,0,'even updateAuth must read its CAS value after Q is available');
  assert.deepEqual(h.values,before);
  gate.resolve();await holder;
  const result=await pending;
  assert.equal(name==='updateAuth'?result.accepted:result,true);
  const writes=h.effects.filter(entry=>entry.type==='set');
  assert.equal(writes.length,1);
  assert.deepEqual(writes[0].keys,[STORAGE_KEY.AUTH]);
  assert.deepEqual(writes[0].owned,[AUTH_LOCK,Q_LOCK]);
  for(const key of Object.keys(before).filter(key=>key!==STORAGE_KEY.AUTH))assert.deepEqual(h.values[key],before[key],key);
});

test('updateAuth checks the fresh mutation after a held-Q writer replaces auth',async t=>{
  const h=storageHarness(t),gate=deferred(),entered=deferred();
  const holder=h.other.run(async()=>{entered.resolve();await gate.promise;
    await h.storage.set({[STORAGE_KEY.AUTH]:{code:'newer-code',authMutationId:'mutation-newer'}});});
  await entered.promise;
  const pending=updateAuth({verified:true,captureAgent:{id:'stale-agent'}},{expectedMutationId:'mutation-current'});
  await h.waitForEvent(`queue:${Q_LOCK}`,2);gate.resolve();await holder;
  const result=await pending;
  assert.equal(result.accepted,false);
  assert.deepEqual(h.values[STORAGE_KEY.AUTH],{code:'newer-code',authMutationId:'mutation-newer'});
  assert.equal(h.effects.filter(entry=>entry.type==='set').length,1,'only the prior owner wrote');
});

test('setAuth, current updateAuth and clearAuth serialize without nested Auth or lost CAS',async t=>{
  const h=storageHarness(t);
  const set=setAuth({code:'chosen-code',authMutationId:'chosen-generation',tenant:{id:'chosen-tenant'}});
  const update=updateAuth({verified:true},{expectedMutationId:'chosen-generation'});
  const clear=clearAuth();
  assert.equal(await set,true);assert.equal((await update).accepted,true);assert.equal(await clear,true);
  const writes=h.effects.filter(entry=>entry.type==='set');
  assert.equal(writes.length,3);
  assert.equal(writes[1].patch[STORAGE_KEY.AUTH].verified,true);
  assert.equal(h.values[STORAGE_KEY.AUTH].authMutationId,'');
  assert.equal(h.values[STORAGE_KEY.AUTH].captureAgent,null);
  assert.equal(h.values[STORAGE_KEY.AUTH].tenant,null);
  assert.ok(writes.every(entry=>JSON.stringify(entry.owned)===JSON.stringify([AUTH_LOCK,Q_LOCK])));
});

test('clearAuth wins over queued old verification, which cannot revive cleared credentials',async t=>{
  const h=storageHarness(t),gate=deferred(),entered=deferred();
  const holder=h.other.run(async()=>{entered.resolve();await gate.promise;});
  await entered.promise;
  const clear=clearAuth();
  const verification=updateAuth({verified:true,captureAgent:{id:'old-agent',token:'old-token'}},
    {expectedMutationId:'mutation-current'});
  await h.waitForEvent(`queue:${AUTH_LOCK}`,2);gate.resolve();await holder;
  assert.equal(await clear,true);assert.equal((await verification).accepted,false);
  assert.equal(h.values[STORAGE_KEY.AUTH].captureAgent,null);
  assert.equal(h.effects.filter(entry=>entry.type==='set').length,1);
});

test('clearAll retains a clear witness and removes related roots inside one cooperative Auth/Q interval',async t=>{
  const h=storageHarness(t),oldRequest=clone(h.values[STORAGE_KEY.UNATTENDED_KEYWORD_RUN_REQUEST]);
  const markerWritten=deferred(),gate=deferred();let observerEntered=false;
  h.setAfterSet(async patch=>{if(Object.hasOwn(patch,STORAGE_KEY.TASK_LEDGER)){markerWritten.resolve();await gate.promise;}});
  const reset=clearAll();await markerWritten.promise;
  assert.equal(Object.hasOwn(h.values,STORAGE_KEY.AUTH),true,'native calls are separate, not a claimed storage transaction');
  const observation=h.other.run(async()=>{observerEntered=true;return await h.storage.get([
    STORAGE_KEY.AUTH,STORAGE_KEY.UNATTENDED_KEYWORD_RUN_REQUEST,STORAGE_KEY.UNATTENDED_KEYWORD_RUN_ARCHIVE,STORAGE_KEY.TASK_LEDGER]);});
  await h.waitForEvent(`queue:${Q_LOCK}`,2);
  assert.equal(observerEntered,false,'cooperating control reader cannot see the intermediate state');
  gate.resolve();assert.equal(await reset,true);
  const visible=await observation;
  assert.deepEqual(Object.keys(visible),[STORAGE_KEY.TASK_LEDGER]);
  const ledger=visible[STORAGE_KEY.TASK_LEDGER];
  assert.deepEqual(ledger,{version:1,runs:[],clearedAt:'2026-09-06T04:00:00.000Z',updatedAt:'2026-09-06T04:00:00.000Z'});
  assert.equal(h.other.sourcePredatesClear(oldRequest,ledger),true);
  const relatedRemove=h.effects.find(entry=>entry.type==='remove'&&entry.keys.includes(STORAGE_KEY.AUTH));
  assert.deepEqual(relatedRemove.keys,[STORAGE_KEY.AUTH,STORAGE_KEY.UNATTENDED_KEYWORD_RUN_REQUEST,STORAGE_KEY.UNATTENDED_KEYWORD_RUN_ARCHIVE]);
  assert.deepEqual(relatedRemove.owned,[AUTH_LOCK,Q_LOCK]);
  assert.equal(h.effects.some(entry=>entry.type==='remove'&&entry.keys.includes(STORAGE_KEY.TASK_LEDGER)),false);
  assert.deepEqual(h.values[STORAGE_KEY.UNATTENDED_KEYWORD_PLAN],{enabled:true,notInResetWriteSet:true});
  assert.deepEqual(h.values['unrelated-key'],{preserve:true});
});

test('clearAll waits for another realm Q before reading the marker or changing any root',async t=>{
  const h=storageHarness(t),before=clone(h.values),gate=deferred(),entered=deferred();
  const holder=h.other.run(async()=>{entered.resolve();await gate.promise;});await entered.promise;
  const reset=clearAll();await h.waitForEvent(`queue:${Q_LOCK}`,2);
  assert.equal(h.effects.length,0);assert.deepEqual(h.values,before);
  gate.resolve();await holder;assert.equal(await reset,true);
  assert.deepEqual(h.values[STORAGE_KEY.TASK_LEDGER].runs,[]);
});

test('same-clock and backward-clock repeated reset advance the existing marker monotonically',async t=>{
  const h=storageHarness(t),base=NativeDate.parse('2026-09-06T04:00:00.000Z');
  h.values[STORAGE_KEY.TASK_LEDGER]={version:1,runs:[],clearedAt:new NativeDate(base+10).toISOString(),updatedAt:new NativeDate(base+10).toISOString()};
  await clearAll();const first=h.values[STORAGE_KEY.TASK_LEDGER].clearedAt;
  await clearAll();const second=h.values[STORAGE_KEY.TASK_LEDGER].clearedAt;
  h.setClock(base-60000);await clearAll();const third=h.values[STORAGE_KEY.TASK_LEDGER].clearedAt;
  assert.equal(NativeDate.parse(first),base+11);assert.equal(NativeDate.parse(second),base+12);assert.equal(NativeDate.parse(third),base+13);
  assert.deepEqual(h.values[STORAGE_KEY.TASK_LEDGER].runs,[]);
  assert.equal(h.values[STORAGE_KEY.TASK_LEDGER].updatedAt,third);
});

test('failed clear-marker persistence aborts reset before removing credentials, history or data',async t=>{
  const h=storageHarness(t),before=clone(h.values);
  h.setBeforeSet(patch=>{if(Object.hasOwn(patch,STORAGE_KEY.TASK_LEDGER))throw new Error('synthetic marker write failure');});
  await assert.rejects(clearAll(),/synthetic marker write failure/);
  assert.deepEqual(h.values,before);
  assert.equal(h.effects.some(entry=>entry.type==='remove'),false);
});

test('failed related-root removal retains the durable witness and does not continue unrelated cleanup',async t=>{
  const h=storageHarness(t),before=clone(h.values),oldRequest=clone(h.values[STORAGE_KEY.UNATTENDED_KEYWORD_RUN_REQUEST]);
  h.setBeforeRemove(keys=>{if(keys.includes(STORAGE_KEY.AUTH))throw new Error('synthetic protected removal failure');});
  await assert.rejects(clearAll(),/synthetic protected removal failure/);
  const witness=clone(h.values[STORAGE_KEY.TASK_LEDGER]);
  assert.deepEqual(witness.runs,[]);assert.equal(h.other.sourcePredatesClear(oldRequest,witness),true);
  for(const key of Object.keys(before).filter(key=>key!==STORAGE_KEY.TASK_LEDGER))assert.deepEqual(h.values[key],before[key],key);
  assert.equal(h.effects.filter(entry=>entry.type==='remove').length,1);
  h.setBeforeRemove(null);assert.equal(await clearAll(),true);
  assert.ok(NativeDate.parse(h.values[STORAGE_KEY.TASK_LEDGER].clearedAt)>NativeDate.parse(witness.clearedAt));
  assert.equal(Object.hasOwn(h.values,STORAGE_KEY.AUTH),false);
});
