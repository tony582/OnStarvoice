import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
const source = await readFile(new URL('../utils/task-window-sources.js', import.meta.url), 'utf8');
const clone = value => structuredClone(value);
const search = keyword => `https://www.douyin.com/search/${encodeURIComponent(keyword)}`;
const owner = {identity:'task:attempt', platform:'douyin', windowId:1};
function memory() {
  const data = {};
  return {data, async get(key) { return {[key]:clone(data[key])}; },
    async set(patch) {Object.assign(data,clone(patch));}};
}
function harness({storage=memory(),fakeTimers=false}={}) {
  const pages=new Map(), pendingTimers=new Map(); let sequence=0, sessionId='session-one';
  let queryCount=0, probeCount=0;
  const options={storage,tabs:{
    async query({windowId}) {queryCount++; return [...pages.values()].filter(p=>p.windowId===windowId).map(clone);},
    async get(id) {if (!pages.has(id)) throw Error('No tab with id'); return clone(pages.get(id));},
  },async getDocumentIdentity(id) {probeCount++; const page=pages.get(id);
    return {url:page.url,windowId:page.windowId,documentId:page.documentId,safeForCleanup:page.safeForCleanup};},
  async getSessionId() {return sessionId;}};
  const context=vm.createContext({URL,console,
    setTimeout:fakeTimers?callback=>{const id=++sequence;pendingTimers.set(id,callback);return id;}:setTimeout,
    clearTimeout:fakeTimers?id=>pendingTimers.delete(id):clearTimeout});
  vm.runInContext(source,context);const api=context.OnStarvoiceTaskWindowSources;
  let controller=api.createController(options);
  return {api,storage,pages,options,get controller(){return controller;},
    add(id,url=search('test'),extras={}) {pages.set(id,{id,url,windowId:1,status:'complete',documentId:`document-${id}`,safeForCleanup:true,...extras});},
    restart(){controller=api.createController(options);},session(value){sessionId=value;},
    counts:()=>({queryCount,probeCount}),fireTimers(){for(const callback of pendingTimers.values())callback();pendingTimers.clear();}};
}
const plain=value=>JSON.parse(JSON.stringify(value));
const turn=()=>new Promise(resolve=>setImmediate(resolve));

test('begin snapshots same-window strict home/search sources and derives exact keyword allowlist',async()=>{
  const h=harness();h.add(1,'https://www.douyin.com/jingxuan/');h.add(2,search('安吉星'));
  h.add(3,search('other'),{windowId:2});h.add(4,'https://www.xiaohongshu.com/explore');
  h.add(5,search('excluded'));
  const result=await h.controller.begin({...owner,excludeTabIds:[5]});
  assert.equal(result.known,true);assert.equal(result.blocked,false);
  assert.deepEqual(Array.from(result.sources,s=>s.sourceTabId),[1,2]);
  assert.deepEqual(Array.from(result.keywords),['安吉星']);
  assert.ok(result.sources.every(s=>s.createdByTask===false&&s.windowSessionId==='session-one'&&s.documentId));
});

test('detail, account, login, modal, hash, foreign origin and malformed search routes are excluded',async()=>{
  const h=harness();
  ['https://www.douyin.com/video/7654321098765432100','https://www.douyin.com/user/abc',
    'https://www.douyin.com/passport/login',search('x')+'?modal_id=1',search('x')+'#section',search('x')+'#',
    'https://evil.example/search/x','http://www.douyin.com/search/x','https://u:p@www.douyin.com/search/x',
    'https://www.douyin.com/search/x/detail','https://www.douyin.com/search/%GG','https://www.douyin.com/jingxuan?modal_id=1',
  ].forEach((url,i)=>h.add(i+1,url));
  const result=await h.controller.begin(owner);
  assert.equal(result.known,true);assert.equal(result.blocked,false);assert.equal(result.sources.length,0);
});

for(const [platform,urls,keyword] of [
  ['xiaohongshu',['https://www.xiaohongshu.com/explore','https://www.xiaohongshu.com/search_result/?keyword=%E6%B1%BD%E8%BD%A6'],'汽车'],
  ['weibo',['https://weibo.com/','https://s.weibo.com/weibo?q=%E6%B1%BD%E8%BD%A6'],'汽车'],
]) test(platform+' only accepts its canonical home and standard search',async()=>{
  const h=harness();urls.forEach((url,i)=>h.add(i+1,url));h.add(5,'https://www.xiaohongshu.com/search_result_ai?keyword=汽车');
  const result=await h.controller.begin({...owner,platform});
  assert.equal(result.sources.length,2);assert.deepEqual(Array.from(result.keywords),[keyword]);
});

test('same task repeated begin and worker restart never refresh a same-URL replacement document',async()=>{
  const h=harness();h.add(1);await h.controller.begin(owner);
  h.pages.get(1).documentId='replacement-document';h.add(2);
  assert.equal((await h.controller.begin(owner)).sources[0].documentId,'document-1');
  h.restart();const result=await h.controller.begin(owner);
  assert.equal(result.sources.length,1);assert.equal(result.sources[0].documentId,'document-1');
  assert.equal(h.counts().queryCount,1);assert.equal(h.counts().probeCount,1);
});

test('new attempt rebuilds proof, supersedes old reads and refuses a recent old begin replay',async()=>{
  const h=harness();h.add(1);await h.controller.begin(owner);h.pages.get(1).documentId='new-document';
  const next={...owner,identity:'task:next'};await h.controller.begin(next);
  assert.equal((await h.controller.get(next)).sources[0].documentId,'new-document');
  assert.deepEqual(plain(await h.controller.get(owner)),{sources:[],keywords:[],known:true,blocked:true});
  assert.equal((await h.controller.begin(owner)).blocked,true);
  assert.equal((await h.controller.get(next)).sources[0].documentId,'new-document');
  assert.equal(h.counts().queryCount,2);
});

test('identity aggregates its windows but never reads another platform or owner proof',async()=>{
  const h=harness();h.add(1);h.add(2,search('second'),{windowId:2});
  await h.controller.begin(owner);await h.controller.begin({...owner,windowId:2});
  assert.equal((await h.controller.get(owner)).sources.length,2);
  assert.deepEqual(plain(await h.controller.get({...owner,platform:'xiaohongshu'})),{sources:[],keywords:[],known:false,blocked:true});
  assert.deepEqual(plain(await h.controller.get({...owner,identity:'unregistered'})),{sources:[],keywords:[],known:true,blocked:true});
});

test('loading, pending navigation, security false and unknown keep protected empty-document placeholders',async()=>{
  const h=harness();h.add(1,search('loading'),{status:'loading'});h.add(2,search('pending'),{pendingUrl:search('new')});
  h.add(3,search('captcha'),{safeForCleanup:false});h.add(4,search('unknown'),{safeForCleanup:undefined});
  h.add(5,'about:blank',{pendingUrl:search('initial'),status:'loading'});
  const result=await h.controller.begin(owner);
  assert.equal(result.known,true);assert.equal(result.blocked,false);assert.equal(result.sources.length,5);
  assert.ok(result.sources.every(s=>s.documentId===''));
  for(const page of h.pages.values())Object.assign(page,{status:'complete',pendingUrl:undefined,safeForCleanup:true});
  assert.ok((await h.controller.begin(owner)).sources.every(s=>s.documentId===''),'same task cannot upgrade placeholders');
});

test('failed document probe and navigation during probe preserve the original unproven source',async()=>{
  const h=harness();h.add(1);h.add(2,search('second'));
  h.options.getDocumentIdentity=async id=>{if(id===1)throw Error('probe unavailable');
    h.pages.get(id).url=search('user switched');return {safeForCleanup:true,url:search('second'),windowId:1,documentId:'document-2'};};
  h.restart();const result=await h.controller.begin(owner);
  assert.equal(result.blocked,false);assert.ok(result.sources.every(s=>!s.documentId));
  assert.equal(result.sources[1].expectedSourceUrl,search('second'));
});

test('session mismatch or unavailable session support is closed and never reuses old proof',async()=>{
  const h=harness();h.add(1);await h.controller.begin(owner);h.session('session-two');
  assert.equal((await h.controller.get(owner)).known,false);
  assert.equal((await h.controller.get(owner)).blocked,true);
  await h.controller.begin({...owner,identity:'new-session-task'});
  assert.equal((await h.controller.get({...owner,identity:'new-session-task'})).sources[0].windowSessionId,'session-two');
  h.session('');assert.equal((await h.controller.begin(owner)).blocked,true);
  const unsupported=h.api.createController({tabs:h.options.tabs,getSessionId:async()=> 'session'});
  assert.equal((await unsupported.begin(owner)).known,false);
});

test('one deadline bounds concurrent probes and late answers cannot grant proof after return',async()=>{
  const h=harness({fakeTimers:true});for(let id=1;id<=20;id++)h.add(id);
  let active=0,peak=0;const pending=[];
  h.options.getDocumentIdentity=id=>{active++;peak=Math.max(peak,active);return new Promise(resolve=>pending.push(()=>{active--;resolve({safeForCleanup:true,url:search('test'),windowId:1,documentId:`late-${id}`});}));};
  h.restart();const begin=h.controller.begin(owner);await turn();
  assert.equal(peak,h.api.PROBE_CONCURRENCY);h.fireTimers();const result=await begin;
  assert.equal(result.blocked,false);assert.equal(result.sources.length,20);
  pending.forEach(resolve=>resolve());await turn();
  assert.ok((await h.controller.get(owner)).sources.every(s=>!s.documentId));
});

test('a canceled old probe cannot overwrite the next queued owner, even when its document arrives late',async()=>{
  const h=harness({fakeTimers:true});h.add(1);let canceled=false,release,probes=0;
  h.options.getDocumentIdentity=()=>++probes===1?new Promise(resolve=>{release=resolve;}):
    Promise.resolve({url:search('test'),windowId:1,documentId:'new-proof',safeForCleanup:true});h.restart();
  const old=h.controller.begin(owner,{isCanceled:()=>canceled});await turn();
  canceled=true;const nextOwner={...owner,identity:'new-owner'};
  const next=h.controller.begin(nextOwner);h.fireTimers();await old;await next;
  assert.equal((await h.controller.get(nextOwner)).sources[0].documentId,'new-proof');
  release({url:search('test'),windowId:1,documentId:'late-old-proof',safeForCleanup:true});await turn();
  assert.equal((await h.controller.get(nextOwner)).sources[0].documentId,'new-proof');
  assert.equal((await h.controller.get(owner)).blocked,true);
});

test('forgetTab removes only that source and preserves first-snapshot identity',async()=>{
  const h=harness();h.add(1);h.add(2);await h.controller.begin(owner);
  await h.controller.forgetTab(1);h.add(1,search('replacement'));
  assert.deepEqual(Array.from((await h.controller.begin(owner)).sources,s=>s.sourceTabId),[2]);
  await h.controller.forgetTab(2);const result=await h.controller.get(owner);
  assert.equal(result.known,true);assert.equal(result.blocked,false);assert.equal(result.sources.length,0);
});

test('candidate overflow is bounded and blocked; window capacity never evicts existing task proof',async()=>{
  const h=harness();for(let id=1;id<=h.api.MAX_SOURCES+1;id++)h.add(id);
  const full=await h.controller.begin(owner);
  assert.equal(full.sources.length,h.api.MAX_SOURCES);assert.equal(full.blocked,true);
  for(let windowId=2;windowId<=h.api.MAX_WINDOWS;windowId++)await h.controller.begin({...owner,windowId});
  const overflow=await h.controller.begin({...owner,windowId:h.api.MAX_WINDOWS+1});
  assert.equal(overflow.known,false);assert.equal(overflow.blocked,true);
  assert.equal((await h.controller.get(owner)).sources.length,h.api.MAX_SOURCES);
});

test('query/storage failures and missing owner identity never manufacture an empty safe snapshot',async()=>{
  const h=harness();h.add(1);h.options.tabs.query=async()=>{throw Error('query unavailable');};
  assert.equal((await h.controller.begin(owner)).blocked,true);
  h.restart();assert.equal((await h.controller.begin(owner)).blocked,true);
  h.storage.get=async()=>{throw Error('storage unavailable');};
  assert.equal((await h.controller.get(owner)).known,false);
  assert.equal((await h.controller.begin({...owner,identity:''})).blocked,true);
});

test('a timed-out inventory remains blocked and does not hold the next owner or accept late pages',async()=>{
  const h=harness({fakeTimers:true});h.add(1);let release,queries=0;
  const readPages=h.options.tabs.query;
  h.options.tabs.query=params=>++queries===1?new Promise(resolve=>{release=resolve;}):readPages(params);
  const old=h.controller.begin(owner);await turn();h.fireTimers();
  assert.equal((await old).blocked,true);
  const nextOwner={...owner,identity:'next-after-query-timeout'};
  assert.equal((await h.controller.begin(nextOwner)).sources[0].documentId,'document-1');
  release([{id:99,url:search('late'),windowId:1}]);await turn();
  assert.equal((await h.controller.get(nextOwner)).sources[0].sourceTabId,1);
  assert.equal((await h.controller.get(owner)).blocked,true);
});
