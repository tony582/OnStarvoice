import {createHash,createDecipheriv,timingSafeEqual} from 'node:crypto';
import {assistantError} from './customer-assistant-config.js';

const fail = () => assistantError('assistant_callback_invalid','飞书回调验证失败。',401);
const id = value => typeof value==='string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
function same(a,b){if(typeof a!=='string'||typeof b!=='string')return false;const left=Buffer.from(a),right=Buffer.from(b);return left.length===right.length&&timingSafeEqual(left,right);}

// Official SHA-256 signature and AES-CBC envelope contracts:
// github.com/larksuite/node-sdk/{dispatcher/request-handle.ts,utils/aes-cipher.ts}
export function verifyFeishuAssistantEvent({rawBody,headers,credentials,now=Date.now()}) {
  if(!Buffer.isBuffer(rawBody)||rawBody.length>262144||!credentials.encryptKey||!credentials.verificationToken)throw fail();
  const timestamp=headers['x-lark-request-timestamp'];const nonce=headers['x-lark-request-nonce'];
  const signature=headers['x-lark-signature'];
  let body;
  try{body=JSON.parse(rawBody.toString('utf8'));}catch{throw fail();}
  // URL verification is also authenticated: decrypt first, then require the
  // secret verification token. It never queues work or returns customer data.
  let payload=body;
  if(body?.encrypt) {
    try{
      const encrypted=Buffer.from(body.encrypt,'base64');
      if(encrypted.length<32||encrypted.length%16!==0)throw fail();
      const decipher=createDecipheriv('aes-256-cbc',createHash('sha256').update(credentials.encryptKey).digest(),encrypted.subarray(0,16));
      payload=JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(16)),decipher.final()]).toString('utf8'));
    }catch{throw fail();}
  }
  if(payload?.type==='url_verification') {
    if(!same(payload.token,credentials.verificationToken)||typeof payload.challenge!=='string'||payload.challenge.length>2000)throw fail();
    return {challenge:payload.challenge};
  }
  if(!/^\d{10}$/.test(String(timestamp||''))||Math.abs(Number(now)-Number(timestamp)*1000)>300000||typeof nonce!=='string'||nonce.length>200||!nonce)throw fail();
  const expected=createHash('sha256').update(`${timestamp}${nonce}${credentials.encryptKey}`).update(rawBody).digest('hex');
  if(!same(expected,signature)||payload?.schema!=='2.0'||!same(payload.header?.token,credentials.verificationToken)||payload.header?.app_id!==credentials.appId)throw fail();
  if(payload.header.event_type!=='im.message.receive_v1')return {ignored:true};
  const event=payload.event;const message=event?.message;const sender=event?.sender;
  if(sender?.sender_type!=='user'||message?.chat_type!=='group'||message?.message_type!=='text')return {ignored:true};
  if(!id(message.chat_id)||!id(message.message_id)||!id(sender.sender_id?.open_id)||!id(payload.header.event_id))throw fail();
  const mention=message.mentions?.find(m=>m.id?.open_id===credentials.botOpenId);
  if(!mention||!id(credentials.botOpenId))return {ignored:true};
  let text;try{text=JSON.parse(message.content).text;}catch{throw fail();}
  if(typeof text!=='string'||text.length>4000)throw assistantError('assistant_message_too_long','消息过长，最多4000字。');
  if(typeof mention.key==='string'&&mention.key)text=text.split(mention.key).join('');
  text=text.trim();if(!text)return {ignored:true};
  return {eventId:payload.header.event_id,messageId:message.message_id,chatId:message.chat_id,senderId:sender.sender_id.open_id,
    threadId:id(message.thread_id)?message.thread_id:'',rootId:id(message.root_id)?message.root_id:'',
    requestedAt:/^\d{13}$/.test(String(message.create_time||''))?new Date(Number(message.create_time)).toISOString():new Date(now).toISOString(),text};
}

export function createAssistantFeishuClient(credentials,{fetchImpl=globalThis.fetch}={}) {
  const origin='https://open.feishu.cn';
  async function request(path,body,token) {
    const response=await fetchImpl(origin+path,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
      headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});
    const data=await response.json();
    if(!response.ok||data.code!==0)throw assistantError('assistant_feishu_failed','飞书未确认消息送达，请检查应用权限和群配置。',502);
    return data;
  }
  return {async reply(messageId,text,requestId) {
    if(!id(messageId)||!credentials.appId||!credentials.appSecret)throw assistantError('assistant_feishu_config_missing','飞书应用配置不完整。',409);
    const auth=await request('/open-apis/auth/v3/tenant_access_token/internal',{app_id:credentials.appId,app_secret:credentials.appSecret});
    if(typeof auth.tenant_access_token!=='string'||!auth.tenant_access_token)throw assistantError('assistant_feishu_auth_failed','飞书应用认证失败。',502);
    // Persist the outbox claim before calling: uncertain outcomes are never blindly retried.
    return request(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`,{msg_type:'text',content:JSON.stringify({text:String(text).slice(0,12000)}),
      reply_in_thread:true,uuid:createHash('sha256').update(String(requestId)).digest('hex').slice(0,32)},auth.tenant_access_token);
  }};
}
