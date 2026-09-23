import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {once} from 'node:events';
import test from 'node:test';
import {createAndroidControlRouter} from '../server/routes/android-control.js';
import {runInput} from '../server/services/android-control/validation.js';
const require=createRequire(new URL('../server/package.json',import.meta.url)), express=require('express');
async function serve(t,{enabled=true,writer=true,kind='android_mobile',failure}={}) {
  const calls=[];
  const methods=['register','nodes','runs','detail','create','stop','resume','poll','renew','complete','close'];
  const service=Object.fromEntries(methods.map(m=>[m,async(...args)=>{calls.push([m,...args]);if(failure)throw failure;return {};} ]));
  const user=(req,res,next)=>{if(req.headers.authorization!=='Bearer user')return res.status(401).end();req.tenantId='tenant-a';next();};
  const agent=(req,res,next)=>{if(req.headers.authorization!=='Bearer agent')return res.status(401).end();
    req.tenantId='tenant-a';req.captureAgent={id:'agent-a',auth_code_id:'auth-a',auth_binding_id:'bind-a',capabilities:{agentKind:kind}};next();};
  const app=express();app.use(express.json());
  app.use(createAndroidControlRouter({service,enabledTenants:()=>new Set(enabled?['tenant-a']:[]),authenticateUser:user,
    authenticateAgent:agent,sessionUser:(_req,_res,next)=>next(),tenantWriter:(_req,res,next)=>writer?next():res.status(403).end()}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  return {calls,request:(path,body,auth='user')=>fetch(`http://127.0.0.1:${server.address().port}${path}`,{
    method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${auth}`,'content-type':'application/json'},
    body:body===undefined?undefined:JSON.stringify(body)})};
}
test('disabled tenant can inspect capability but cannot create, poll, register or list',async t=>{
  const api=await serve(t,{enabled:false});
  assert.deepEqual(await (await api.request('/capabilities')).json(),{ok:true,enabled:false});
  for(const [path,body,auth]of [['/runs',{},'user'],['/nodes',undefined,'user'],['/register',{},''],['/agent/poll',{},'agent']])
    assert.equal((await api.request(path,body,auth)).status,404);
  assert.equal(api.calls.length,0);
});
test('tenant reader sees runs but cannot mutate',async t=>{
  const api=await serve(t,{writer:false});assert.equal((await api.request('/runs')).status,200);
  for(const path of ['/runs','/runs/id/stop','/runs/id/resume'])assert.equal((await api.request(path,{})).status,403);
  assert.deepEqual(api.calls.map(c=>c[0]),['runs']);
});
test('credentials and node kind fence control APIs',async t=>{
  const api=await serve(t,{kind:'browser_extension'});
  assert.equal((await api.request('/agent/poll',{},'user')).status,401);
  assert.equal((await api.request('/agent/poll',{},'agent')).status,403);assert.equal(api.calls.length,0);
});
test('principal derives from authenticated identity, not submitted tenant',async t=>{
  const api=await serve(t);await api.request('/agent/poll',{tenantId:'foreign'},'agent');
  assert.deepEqual(api.calls[0][1],{tenantId:'tenant-a',agentId:'agent-a',authCodeId:'auth-a',authBindingId:'bind-a'});
});
test('capacity failures expose backoff rather than unbounded retries',async t=>{
  const api=await serve(t,{failure:{code:'55P03'}});const response=await api.request('/agent/renew',{},'agent');
  assert.equal(response.status,503);assert.equal(response.headers.get('retry-after'),'1');
});
test('pilot inputs are bounded and cannot widen filters or budgets silently',()=>{
  const input={agentId:'00000000-0000-4000-8000-000000000000'};
  assert.equal(runInput(input).keywords.length,2);
  assert.throws(()=>runInput({...input,keywords:['a','b','c']}),{code:'ONE_OR_TWO_KEYWORDS_REQUIRED'});
  assert.throws(()=>runInput({...input,budgets:{maxLinks:21}}),{code:'INVALID_BUDGETS'});
  assert.throws(()=>runInput({...input,filters:{sort:'latest',range:'all'}}),{code:'INVALID_FILTERS'});
});
