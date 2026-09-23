import test from 'node:test';
import assert from 'node:assert/strict';
import {createShareDnsLookup} from '../server/services/capture-discovery/share-dns.js';
import {createShareResolver} from '../server/services/capture-discovery/share-resolver.js';
import {resolveEventIdentity} from '../server/services/capture-discovery/identity.js';
const host='v.douyin.com';
const data=(change={})=>({Status:0,TC:false,CD:false,Question:[{name:host+'.',type:1}],Answer:[
  {name:host+'.',type:5,TTL:20,data:'cdn.example.com.'},
  {name:'cdn.example.com.',type:1,TTL:60,data:'8.8.8.8'}],...change});
const response=value=>new Response(JSON.stringify(value));
const configured=(fetchImpl,extra={})=>createShareDnsLookup({mode:'google-doh',fetchImpl,...extra});
test('system DNS remains the default; encrypted DNS is explicit and rejects unknown modes',async()=>{
  const lookup=()=>['system'];assert.equal(createShareDnsLookup({mode:'system',systemLookup:lookup}),lookup);
  assert.throws(()=>createShareDnsLookup({mode:'unexpected'}),/UNSUPPORTED_SHARE_DNS_MODE/);
});
test('fixed HTTPS endpoint only receives allowed domain and private subnet setting; CNAME cache follows minimum TTL',async()=>{
  let calls=0,time=0;
  const lookup=configured(async(url,options)=>{calls++;assert.equal(url.origin,'https://dns.google');
    assert.equal(url.pathname,'/resolve');assert.equal(url.searchParams.get('name'),host);
    assert.equal(url.searchParams.get('edns_client_subnet'),'0.0.0.0/0');assert.equal(options.redirect,'error');return response(data());},{now:()=>time});
  assert.deepEqual(await lookup(host),[{address:'8.8.8.8',family:4}]);
  const cached=await lookup(host);cached[0].address='127.0.0.1';assert.equal((await lookup(host))[0].address,'8.8.8.8');
  assert.equal(calls,1);time=20000;await lookup(host);assert.equal(calls,2);
  await assert.rejects(lookup('private.example.com'),/UNSAFE_SHARE_DNS_HOST/);assert.equal(calls,2);
});
test('malformed, mismatched, unrelated, truncated and failed DNS answers never become fetch targets',async()=>{
  for(const value of [data({Status:2}),data({TC:true}),data({CD:true}),data({Question:[{name:'other.example',type:1}]}),
    data({Answer:[{name:'other.example',type:1,TTL:60,data:'8.8.8.8'}]}),
    data({Answer:[{name:host,type:5,TTL:60,data:host}]}),
    data({Answer:[{name:host,type:1,TTL:60,data:'not-an-address'}]})]) {
    await assert.rejects(configured(async()=>response(value))(host),/SHARE_DNS_UNAVAILABLE/);
  }
  await assert.rejects(configured(async()=>new Response('x'.repeat(65537)))(host),/SHARE_DNS_UNAVAILABLE/);
});
test('encrypted DNS still rejects private or synthetic answers and pins validated address for HTTPS',async()=>{
  const short='https://v.douyin.com/validLink/';let requests=0;
  for(const address of ['127.0.0.1','198.18.16.159','192.168.1.1']) {
    const dnsLookup=configured(async()=>response(data({Answer:[{name:host,type:1,TTL:60,data:'8.8.8.8'},
      {name:host,type:1,TTL:60,data:address}]})));
    await assert.rejects(createShareResolver({dnsLookup,request:()=>{requests++;}})(short),/UNSAFE_SHARE_ADDRESS/);
  }
  assert.equal(requests,0);
  const resolver=createShareResolver({dnsLookup:configured(async()=>response(data())),request:async(url,options)=>{
    assert.equal(options.address,'8.8.8.8');return {status:302,location:'https://www.iesdouyin.com/share/slides/7687942022607741007/'};}});
  assert.equal(await resolver(short),'https://www.douyin.com/note/7687942022607741007');
});
test('DNS abort is propagated and failures remain reviewable with specific reasons',async()=>{
  const controller=new AbortController();let observed=false;
  const lookup=configured(async(_url,{signal})=>new Promise((resolve,reject)=>{
    signal.addEventListener('abort',()=>{observed=true;reject(new Error('aborted'));},{once:true});controller.abort();}));
  await assert.rejects(lookup(host,{signal:controller.signal}),/SHARE_DNS_UNAVAILABLE/);assert.equal(observed,true);
  const event={verification:'verified',rawShareUrl:'https://v.douyin.com/validLink/'};
  for(const [message,reason] of [['UNSAFE_SHARE_ADDRESS','short_link_dns_address_blocked'],['SHARE_DNS_UNAVAILABLE','short_link_dns_failed']]) {
    assert.equal((await resolveEventIdentity(event,async()=>{throw new Error(message);})).reason,reason);
  }
});

test('one transient DNS transport failure is retried without replaying the work request',async()=>{
  let queries=0,workRequests=0;
  const dnsLookup=configured(async()=>{if(++queries===1)throw new TypeError('fetch failed');return response(data());});
  const resolver=createShareResolver({dnsLookup,request:async()=>{workRequests++;return {status:302,location:'https://www.douyin.com/note/7688610654147720305'};}});
  assert.equal(await resolver('https://v.douyin.com/validLink/'),'https://www.douyin.com/note/7688610654147720305');
  assert.equal(queries,2);assert.equal(workRequests,1);
});
test('transient HTTP and SERVFAIL DNS errors get one retry; malformed answers do not',async()=>{
  for(const first of [()=>new Response('',{status:503}),()=>new Response('',{status:429}),()=>response(data({Status:2}))]){
    let calls=0;
    const lookup=configured(async()=>++calls===1?first():response(data()));
    assert.deepEqual(await lookup(host),[{address:'8.8.8.8',family:4}]);assert.equal(calls,2);
  }
  for(const first of [()=>new Response('',{status:403}),()=>response(data({Status:3})),()=>response(data({TC:true})),()=>response(data({Question:[{name:'other.example',type:1}]}))]){
    let calls=0;
    await assert.rejects(configured(async()=>{calls++;return first();})(host),/SHARE_DNS_UNAVAILABLE/);
    assert.equal(calls,1);
  }
});
test('persistent DNS transport failures stop after two attempts',async()=>{
  let calls=0;
  await assert.rejects(configured(async()=>{calls++;throw new TypeError('fetch failed');})(host),/SHARE_DNS_UNAVAILABLE/);
  assert.equal(calls,2);
});
test('canceling during DNS retry delay prevents the second query',async()=>{
  let calls=0;const controller=new AbortController();
  const lookup=configured(async()=>{calls++;setTimeout(()=>controller.abort(),20);throw new TypeError('fetch failed');});
  await assert.rejects(lookup(host,{signal:controller.signal}),/SHARE_DNS_UNAVAILABLE/);
  assert.equal(calls,1);
});
test('the original three-second identity deadline aborts retrying DNS reads',async()=>{
  let calls=0;const signals=[];
  const dnsLookup=configured(async(_url,{signal})=>new Promise((resolve,reject)=>{
    calls++;signals.push(signal);signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});
  }));
  const event={verification:'verified',rawShareUrl:'https://v.douyin.com/validLink/'};
  const started=Date.now();const result=await resolveEventIdentity(event,createShareResolver({dnsLookup}));
  assert.equal(result.status,'pending');assert.equal(result.reason,'short_link_resolution_failed');
  assert.equal(calls,2);assert.ok(Date.now()-started<4000);assert.ok(signals.every(signal=>signal.aborted));
});

test('provider Retry-After is respected instead of retrying immediately',async()=>{
  let calls=0;const times=[];
  const lookup=configured(async()=>{times.push(performance.now());return ++calls===1
    ?new Response('',{status:503,headers:{'Retry-After':'1'}}):response(data());});
  await lookup(host);assert.equal(calls,2);assert.ok(times[1]-times[0]>=950);
});
test('a long provider backoff remains pending without issuing another query',async()=>{
  let calls=0;
  const lookup=configured(async()=>{calls++;return new Response('',{status:429,headers:{'Retry-After':'60'}});});
  await assert.rejects(lookup(host),/SHARE_DNS_UNAVAILABLE/);assert.equal(calls,1);
});
