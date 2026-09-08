import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const SECRET_FIELDS = ['appSecret', 'webhookUrl', 'webhookSecret'];
const PUBLIC_FIELDS = ['appId','folderToken','documentBaseUrl','channel','chatId','chatName','editorType','editorId','customerEditVerified','autoEnabled','sendTime'];
export const DAILY_DEFAULTS = Object.freeze({appId:'',folderToken:'',documentBaseUrl:'',channel:'app',chatId:'',chatName:'',editorType:'email',editorId:'',customerEditVerified:false,autoEnabled:false,sendTime:'09:00'});

export function dailyError(message, status = 400, code = 'daily_report_invalid') {
  return Object.assign(new Error(message), {status, code});
}

function encryptionKey(env = process.env) {
  const encoded = env.CUSTOMER_DAILY_REPORT_ENCRYPTION_KEY || '';
  if (!/^[a-fA-F0-9]{64}$/.test(encoded)) {
    throw dailyError('请先为服务端配置日报凭据加密密钥，再保存飞书凭据。', 503, 'daily_encryption_key_missing');
  }
  return Buffer.from(encoded, 'hex');
}

export function sealDailySecret(value, tenantId, field, env) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(env), iv);
  cipher.setAAD(Buffer.from(`customer-daily:${tenantId}:${field}`));
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join('.');
}

export function openDailySecret(value, tenantId, field, env) {
  if (!value) return '';
  try {
    const [version, iv, tag, ciphertext] = value.split('.');
    if (version !== 'v1') throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(env), Buffer.from(iv, 'base64'));
    decipher.setAAD(Buffer.from(`customer-daily:${tenantId}:${field}`));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw dailyError('日报凭据无法解密，请检查服务端密钥或重新保存凭据。', 503, 'daily_credentials_unavailable');
  }
}

export function publicDailyConfig(config = {}) {
  const result = {...DAILY_DEFAULTS};
  for (const key of PUBLIC_FIELDS) if (config[key] !== undefined) result[key] = config[key];
  for (const key of SECRET_FIELDS) result[`has${key[0].toUpperCase()}${key.slice(1)}`] = !!config[`${key}Encrypted`];
  result.hasWebhook = !!config.webhookUrlEncrypted;
  return result;
}

export function resolvedDailyConfig(config, tenantId, env) {
  const used = config.channel === 'webhook' ? SECRET_FIELDS : ['appSecret'];
  return {...publicDailyConfig(config), ...Object.fromEntries(used.map(key => [key, openDailySecret(config[`${key}Encrypted`], tenantId, key, env)]))};
}

function validFeishuBase(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && /^[a-z0-9-]+\.feishu\.cn$/.test(u.hostname) && !u.username && !u.password && !u.port && u.pathname === '/' && !u.search && !u.hash;
  } catch { return false; }
}

export function validateDailyConfig(config, {send = false} = {}) {
  if (!config.appId || !config.appSecretEncrypted || !config.folderToken || !validFeishuBase(config.documentBaseUrl)) {
    throw dailyError('请配置飞书应用、密钥、日报目标目录和文档域名。');
  }
  if (!config.editorId || !['email','openid','openchat'].includes(config.editorType)) throw dailyError('请指定客户编辑者或客户协作群。');
  if (send && !config.customerEditVerified) throw dailyError('请先用客户账号完成一次编辑、保存和留存测试，再启用群发送。');
  if (send && config.channel === 'app' && !config.chatId) throw dailyError('请填写接收日报的飞书群 ID。');
  if (send && config.channel === 'webhook' && (!config.webhookUrlEncrypted || !config.webhookSecretEncrypted)) throw dailyError('请配置群机器人的 Webhook 和签名密钥。');
}

export function mergeDailyConfig(existing = {}, patch, tenantId, env) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw dailyError('配置格式不正确');
  const next = {...DAILY_DEFAULTS, ...existing};
  for (const key of PUBLIC_FIELDS) {
    if (!Object.hasOwn(patch, key)) continue;
    if (typeof DAILY_DEFAULTS[key] === 'boolean') {
      if (typeof patch[key] !== 'boolean') throw dailyError('开关值必须为布尔值');
      next[key] = patch[key];
    } else {
      if (typeof patch[key] !== 'string' || patch[key].length > 500) throw dailyError('配置内容无效或过长');
      next[key] = patch[key].trim();
    }
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(next.sendTime)) throw dailyError('发送时间应为 HH:mm');
  if (!['app','webhook'].includes(next.channel)) throw dailyError('群发送方式无效');
  if (!['email','openid','openchat'].includes(next.editorType)) throw dailyError('编辑者类型无效');
  if (next.documentBaseUrl && !validFeishuBase(next.documentBaseUrl)) throw dailyError('文档域名应为 https://企业域名.feishu.cn');
  for (const key of ['appId','folderToken','chatId']) if (next[key] && !/^[A-Za-z0-9_-]+$/.test(next[key])) throw dailyError('请填写 ID 或目录 token，不能填写完整链接');
  for (const key of SECRET_FIELDS) {
    if (!Object.hasOwn(patch, key) || patch[key] === '') continue; // A blank password input preserves the secret.
    if (patch[key] === null) { delete next[`${key}Encrypted`]; continue; }
    if (typeof patch[key] !== 'string' || patch[key].length > 2000) throw dailyError('凭据格式不正确');
    if (key === 'webhookUrl') {
      let url;
      try { url = new URL(patch[key]); } catch { throw dailyError('Webhook 地址无效'); }
      if (url.origin !== 'https://open.feishu.cn' || !/^\/open-apis\/bot\/v2\/hook\/[a-zA-Z0-9-]+$/.test(url.pathname) || url.search || url.hash || url.username || url.password) throw dailyError('请使用飞书官方群机器人 Webhook 地址');
    }
    next[`${key}Encrypted`] = sealDailySecret(patch[key], tenantId, key, env);
  }
  const ownershipFields = ['appId','folderToken','documentBaseUrl','editorType','editorId'];
  if (ownershipFields.some(key => next[key] !== existing[key])) next.customerEditVerified = false;
  if (next.autoEnabled) validateDailyConfig(next, {send:true});
  return next;
}

export function dailyTargetKey(config) {
  const target = config.channel === 'webhook' ? config.webhookUrl : `${config.appId}:${config.chatId}`;
  return createHash('sha256').update(`${config.channel}:${target}`).digest('hex');
}

export function nextDailySendAt(sendTime, now = new Date()) {
  const current = new Date(now);
  const localDate = new Date(current.getTime() + 8 * 3600000).toISOString().slice(0,10);
  let due = new Date(`${localDate}T${sendTime}:00+08:00`);
  if (due <= current) due = new Date(due.getTime() + 86400000);
  return due.toISOString();
}
