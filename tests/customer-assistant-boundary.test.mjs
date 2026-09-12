import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,createCipheriv,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {once} from 'node:events';
import {mergeAssistantConfig,publicAssistantConfig,resolveAssistantCredentials,resolveAssistantMember} from '../server/services/customer-assistant-config.js';
import {verifyFeishuAssistantEvent,createAssistantFeishuClient} from '../server/services/customer-assistant-feishu.js';
import {createCustomerAssistantRouter,createCustomerAssistantWebhookRouter} from '../server/routes/customer-assistant.js';

const require=createRequire(new URL('../server/package.json',import.meta.url));const express=require('express');
const tenantId='11111111-1111-4111-8111-111111111111';
const env={CUSTOMER_DAILY_REPORT_ENCRYPTION_KEY:'a'.repeat(64)};
const credentials={appId:'cli_test',appSecret:'app-secret',botOpenId:'ou_bot',verificationToken:'verify-secret',encryptKey:'encrypt-secret'};
const now=Date.parse('2026-09-12T06:00:00Z');
function event(overrides={}){return {schema:'2.0',header:{token:credentials.verificationToken,app_id:credentials.appId,event_id:'event_123',event_type:'im.message.receive_v1'},
  event:{sender:{sender_type:'user',sender_id:{open_id:'ou_member'}},message:{message_id:'om_123',chat_id:'oc_group',chat_type:'group',message_type:'text',
    content:JSON.stringify({text:'@_user_1 今天多少负面？'}),mentions:[{key:'@_user_1',id:{open_id:'ou_bot'}}]}},...overrides};}
function signed(payload,{encrypted=false}={}){
  let body=payload;
  if(encrypted){const iv=randomBytes(16);const cipher=createCipheriv('aes-256-cbc',createHash('sha256').update(credentials.encryptKey).digest(),iv);
    body={encrypt:Buffer.concat([iv,cipher.update(JSON.stringify(payload)),cipher.final()]).toString('base64')};}
  const rawBody=Buffer.from(JSON.stringify(body,null,2));const timestamp=String(now/1000),nonce='test-nonce';
  return {rawBody,headers:{'x-lark-request-timestamp':timestamp,'x-lark-request-nonce':nonce,
    'x-lark-signature':createHash('sha256').update(timestamp+nonce+credentials.encryptKey).update(rawBody).digest('hex')},credentials,now};
}
test('settings default off, secrets encrypted and never returned, blank secret preserves and wrong tenant fails',()=>{
  assert.equal(publicAssistantConfig().enabled,false);assert.equal(publicAssistantConfig().mode,'preview');
  const stored=mergeAssistantConfig({}, {...credentials,useDailyApp:false,appSecret:credentials.appSecret,groups:[{chatId:'oc_group',name:'客户'}],members:[{chatId:'oc_group',openId:'ou_member',name:'成员',email:'member@example.com',canEmail:true}]},tenantId,env);
  const publicConfig=publicAssistantConfig(stored);
  assert.equal(publicConfig.hasAppSecret,true);assert.equal(JSON.stringify(publicConfig).includes('app-secret'),false);
  assert.equal(JSON.stringify(stored).includes('app-secret'),false);
  assert.equal(mergeAssistantConfig(stored,{appSecret:''},tenantId,env).appSecretEncrypted,stored.appSecretEncrypted);
  assert.equal(resolveAssistantCredentials(stored,tenantId,{},env).appSecret,'app-secret');
  assert.throws(()=>resolveAssistantCredentials(stored,'other',{},env));
  assert.equal(resolveAssistantMember(stored,'oc_other','ou_member'),null);
});
test('settings enforce bounded groups, unique identities, one verified email and live readiness',()=>{
  const group={chatId:'oc_group',name:''};const member={chatId:'oc_group',openId:'ou_member',name:'',email:'a@example.com',canEmail:true};
  for(const patch of [{enabled:true},{groups:[group,group]},{members:[member]},{groups:[group],members:[member,member]},
    {groups:[group],members:[{...member,email:'a@example.com,b@example.com'}]},{groups:[group],members:[{...member,email:''}]},{tenantId:'other'}])
    assert.throws(()=>mergeAssistantConfig({},patch,tenantId,env));
});
test('signed raw JSON and AES envelopes normalize only human @bot group text',()=>{
  for(const encrypted of [false,true]){const result=verifyFeishuAssistantEvent(signed(event(),{encrypted}));
    assert.equal(result.text,'今天多少负面？');assert.equal(result.senderId,'ou_member');assert.equal(result.chatId,'oc_group');}
  for(const change of [e=>e.event.sender.sender_type='app',e=>e.event.message.chat_type='p2p',e=>e.event.message.mentions=[],e=>e.event.message.message_type='image']){
    const e=event();change(e);assert.deepEqual(verifyFeishuAssistantEvent(signed(e)),{ignored:true});
  }
});
test('bad signatures, replay timestamps, wrong app/token and changed bytes reject before work',()=>{
  const original=signed(event());
  for(const input of [{...original,rawBody:Buffer.concat([original.rawBody,Buffer.from(' ')])},{...original,now:now+301000},
    {...original,headers:{...original.headers,'x-lark-signature':'错'.repeat(64)}},signed(event({header:{...event().header,app_id:'cli_other'}})),
    signed(event({header:{...event().header,token:'bad'}}))])assert.throws(()=>verifyFeishuAssistantEvent(input),e=>e.status===401);
});
test('URL challenge requires correct token and returns no business data',()=>{
  const input=signed({type:'url_verification',token:credentials.verificationToken,challenge:'challenge'},{encrypted:true});
  assert.deepEqual(verifyFeishuAssistantEvent({...input,headers:{}}),{challenge:'challenge'});
  assert.throws(()=>verifyFeishuAssistantEvent(signed({type:'url_verification',token:'bad',challenge:'challenge'})));
});
test('Feishu reply uses fixed origin and stable uuid; uncertain mutations are never retried',async()=>{
  const calls=[];const client=createAssistantFeishuClient(credentials,{fetchImpl:async(url,options)=>{
    calls.push({url,body:JSON.parse(options.body)});
    if(url.includes('tenant_access_token'))return {ok:true,json:async()=>({code:0,tenant_access_token:'token'})};
    throw new Error('response lost');
  }});
  await assert.rejects(client.reply('om_123','日报已排队','request-123'));
  assert.equal(calls.length,2);assert.match(calls[1].url,/^https:\/\/open.feishu.cn\/open-apis\/im\/v1\/messages\/om_123\/reply$/);
  assert.equal(calls[1].body.reply_in_thread,true);assert.equal(calls[1].body.uuid.length,32);
});
test('HTTP callback receives original bytes; admin preview forwards only authenticated tenant and actor',async()=>{
  const seen=[];const app=express();
  app.use('/callback',createCustomerAssistantWebhookRouter({receive:async(tenant,body)=>{seen.push([tenant,body]);return {ok:true};}}));
  app.use(express.json());
  app.use('/assistant',createCustomerAssistantRouter({preview:async(tenant,body,actor)=>{seen.push([tenant,actor,body]);return {reply:'预览',dryRun:true};}},
    {authorize:[(req,res,next)=>{req.tenantId=tenantId;req.user={id:'admin-1'};next();}]}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const body='{ "x": 1 }';const callback=await fetch(`${base}/callback/${tenantId}`,{method:'POST',headers:{'Content-Type':'application/json'},body});
    assert.equal(callback.status,200);assert.equal(seen[0][1].toString(),body);
    const preview=await fetch(`${base}/assistant/preview`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'日报',tenantId:'attacker'})});
    assert.equal(preview.status,200);assert.equal((await preview.json()).dryRun,true);assert.equal(seen[1][0],tenantId);assert.equal(seen[1][1],'admin-1');
  }finally{await new Promise(resolve=>server.close(resolve));}
});
test('assistant admin endpoints reject unauthenticated requests',async()=>{
  const app=express();app.use('/assistant',createCustomerAssistantRouter({settings:()=>{throw new Error('must not reach');}}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  try{const response=await fetch(`http://127.0.0.1:${server.address().port}/assistant/settings`);assert.ok([401,403].includes(response.status));}
  finally{await new Promise(resolve=>server.close(resolve));}
});
