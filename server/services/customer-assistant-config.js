import {sealDailySecret,openDailySecret,normalizeDailyEmailRecipients} from './customer-daily-report-config.js';

export const ASSISTANT_DEFAULTS = Object.freeze({enabled:false,mode:'preview',useDailyApp:true,appId:'',botOpenId:'',groups:[],members:[]});
const SECRETS = ['appSecret','verificationToken','encryptKey'];
const ID = /^[A-Za-z0-9_-]{1,200}$/;
export const assistantError = (code,message,status=400) => Object.assign(new Error(message),{code,status,safeMessage:message});
const invalid = message => assistantError('assistant_settings_invalid',message);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function text(value,max=100) {
  if (typeof value !== 'string' || value.length>max || /[\u0000-\u001f]/.test(value)) throw invalid('配置文字无效或过长。');
  return value.trim();
}
function id(value) { const result=text(value,200);if (!ID.test(result)) throw invalid('请填写有效的飞书 ID。');return result; }

export function publicAssistantConfig(config={}) {
  const result={...ASSISTANT_DEFAULTS};
  for (const key of Object.keys(ASSISTANT_DEFAULTS)) if(config[key]!==undefined) result[key]=structuredClone(config[key]);
  for(const key of SECRETS) result[`has${key[0].toUpperCase()}${key.slice(1)}`]=!!config[`${key}Encrypted`];
  return result;
}

export function mergeAssistantConfig(existing={},patch,tenantId,env) {
  if(!object(patch)) throw invalid('配置格式无效。');
  const next={...ASSISTANT_DEFAULTS,...existing};
  const known=new Set([...Object.keys(ASSISTANT_DEFAULTS),...SECRETS,...SECRETS.map(k=>`has${k[0].toUpperCase()}${k.slice(1)}`)]);
  if(Object.keys(patch).some(k=>!known.has(k))) throw invalid('配置包含不支持的字段。');
  for(const key of ['enabled','useDailyApp']) if(Object.hasOwn(patch,key)) {
    if(typeof patch[key]!=='boolean') throw invalid('开关值必须为布尔值。');next[key]=patch[key];
  }
  if(Object.hasOwn(patch,'mode')) {if(!['preview','live'].includes(patch.mode)) throw invalid('运行模式无效。');next.mode=patch.mode;}
  for(const key of ['appId','botOpenId']) if(Object.hasOwn(patch,key)) next[key]=patch[key]===''?'':id(patch[key]);
  if(Object.hasOwn(patch,'groups')) {
    if(!Array.isArray(patch.groups)||patch.groups.length>30) throw invalid('最多绑定30个客户群。');
    next.groups=patch.groups.map(g=>{if(!object(g))throw invalid('群配置无效。');return {chatId:id(g.chatId),name:text(g.name||'')};});
    if(new Set(next.groups.map(g=>g.chatId)).size!==next.groups.length)throw invalid('客户群不能重复绑定。');
  }
  if(Object.hasOwn(patch,'members')) {
    if(!Array.isArray(patch.members)||patch.members.length>300)throw invalid('最多绑定300个成员。');
    next.members=patch.members.map(m=>{
      if(!object(m)||typeof m.canEmail!=='boolean')throw invalid('成员权限配置无效。');
      const email=normalizeDailyEmailRecipients(m.email||'').toLowerCase();
      if(email.includes(',')||(m.canEmail&&!email))throw invalid('邮件权限须绑定一个已核实的邮箱。');
      return {chatId:id(m.chatId),openId:id(m.openId),name:text(m.name||''),email,canEmail:m.canEmail};
    });
  }
  const groupIds=new Set(next.groups.map(g=>g.chatId));
  if(next.members.some(m=>!groupIds.has(m.chatId)))throw invalid('成员必须属于已绑定的客户群。');
  if(new Set(next.members.map(m=>`${m.chatId}:${m.openId}`)).size!==next.members.length)throw invalid('同一群内成员不能重复配置。');
  for(const key of SECRETS) {
    if(!Object.hasOwn(patch,key)||patch[key]==='')continue;
    if(patch[key]===null){delete next[`${key}Encrypted`];continue;}
    const value=text(patch[key],2000);if(!value)throw invalid('凭据不能为空。');
    next[`${key}Encrypted`]=sealDailySecret(value,tenantId,`assistant:${key}`,env);
  }
  if(next.enabled && (!next.botOpenId||!next.groups.length||!next.members.length||!next.verificationTokenEncrypted||!next.encryptKeyEncrypted))
    throw invalid('启用前请完成机器人身份、回调凭据、客户群和成员绑定。');
  if(next.enabled&&!next.useDailyApp&&(!next.appId||!next.appSecretEncrypted))throw invalid('请配置飞书应用凭据。');
  return next;
}

export function resolveAssistantMember(config,chatId,senderId) {
  if(!config.groups?.some(g=>g.chatId===chatId))return null;
  return config.members?.find(m=>m.chatId===chatId&&m.openId===senderId)||null;
}

export function resolveAssistantCredentials(config,tenantId,dailyConfig={},env) {
  const result={...publicAssistantConfig(config)};
  for(const key of SECRETS) result[key]=openDailySecret(config[`${key}Encrypted`],tenantId,`assistant:${key}`,env);
  if(config.useDailyApp!==false) {
    result.appId=dailyConfig.appId||'';
    result.appSecret=openDailySecret(dailyConfig.appSecretEncrypted,tenantId,'appSecret',env);
  }
  return result;
}
