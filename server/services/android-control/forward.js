import {randomUUID} from 'node:crypto';
import {fail, id} from './validation.js';
import {beijingSeconds} from './patrol.js';

// 「发到微信」: an operator asks the phone to forward one stored 视频号 post to a contact of the capture account's WeChat
// (2026-11-09). The request is a one-item elastic orchestration so the phone claims, leases and completes it like any
// other work; the item is never retried, because a lost completion after 发送 would otherwise send the post twice.
export const FORWARD_ITEM_TYPE = 'wechat_forward';
export const WECHAT_FORWARD_FEATURE = 'wechat_forward';
const SHARE_LINK = /^https:\/\/weixin\.qq\.com\/sph\/[A-Za-z0-9_-]{4,40}$/u;
// The name as the capture phone's WeChat shows it (remark or nickname). The phone types it into the chat picker's search.
const RECIPIENT = /^[^\p{Cc}'"`$\\]{1,40}$/u;
const VIEW_COLUMNS = `parent.id, parent.status AS task_status, parent.created_at, item.status, item.keyword AS recipient,
  item.record_id, item.finished_at, item.metadata->>'reason' AS reason, item.error->>'code' AS error_code,
  parent.metadata->'wechatForward'->>'requestedByName' AS requested_by`;

export function forwardRecipient(value) {
  if (typeof value !== 'string') fail('INVALID_FORWARD_RECIPIENT', 422);
  const name = value.normalize('NFC').trim();
  if (!RECIPIENT.test(name)) fail('INVALID_FORWARD_RECIPIENT', 422);
  return name;
}

// The contacts an operator may pick, set per tenant in 系统设置 (one name per line). Only these can be sent to.
export const WECHAT_FORWARD_RECIPIENTS_SETTING = 'wechat_forward_recipients';
export const MAX_FORWARD_RECIPIENTS = 20;
/** The stored form of the list: valid names, one per line, de-duplicated; an invalid name rejects the whole list. */
export function normalizeForwardRecipients(value) {
  if (value != null && typeof value !== 'string') fail('INVALID_FORWARD_RECIPIENT', 422);
  const names = [...new Set(String(value ?? '').split(/\r?\n/u).map(line => line.trim()).filter(Boolean).map(forwardRecipient))];
  if (names.length > MAX_FORWARD_RECIPIENTS) fail('TOO_MANY_FORWARD_RECIPIENTS', 422);
  return names.join('\n');
}
export async function forwardRecipients(tx, tenantId) {
  const row = await tx.queryOne('SELECT value FROM tenant_settings WHERE tenant_id=$1 AND key=$2', [tenantId, WECHAT_FORWARD_RECIPIENTS_SETTING]);
  return normalizeForwardRecipients(row?.value).split('\n').filter(Boolean);
}

const view = row => row && ({id: row.id, recordId: row.record_id, recipient: row.recipient, requestedBy: row.requested_by || '',
  status: row.status, reason: row.reason || '', errorCode: row.error_code || '', createdAt: row.created_at, finishedAt: row.finished_at});

/**
 * Queue one forward per chosen contact (each must be on the tenant's list). A same post → same contact request still
 * waiting or running is returned instead of a second one.
 */
export async function requestForwards(tx, tenantId, {recordId, recipients, recipient, userId = '', userName = ''} = {}) {
  if (recipients !== undefined && !Array.isArray(recipients)) fail('INVALID_FORWARD_RECIPIENT', 422);
  const wanted = [...new Set((recipients ?? [recipient]).map(forwardRecipient))];
  if (!wanted.length || wanted.length > MAX_FORWARD_RECIPIENTS) fail('INVALID_FORWARD_RECIPIENT', 422);
  const allowed = await forwardRecipients(tx, tenantId);
  if (!allowed.length) fail('FORWARD_RECIPIENTS_NOT_CONFIGURED', 409);
  if (wanted.some(name => !allowed.includes(name))) fail('FORWARD_RECIPIENT_NOT_ALLOWED', 422);
  // Hold one lock per post for the whole batch. Individual contact locks can deadlock when two operators
  // pick the same contacts in opposite orders. The transaction also keeps a rejected batch all-or-nothing.
  await tx.execute('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [tenantId, `wechat_forward:${id(recordId, 'RECORD_ID')}`]);
  const forwards = [];
  for (const name of wanted) forwards.push(await requestForward(tx, tenantId, {recordId, name, userId, userName}));
  return forwards;
}

async function requestForward(tx, tenantId, {recordId, name, userId, userName}) {
  const record = await tx.queryOne(`SELECT id, platform, url, external_id, title, author_name, publish_time FROM records
    WHERE tenant_id=$1 AND id=$2`, [tenantId, id(recordId, 'RECORD_ID')]);
  if (!record) fail('RECORD_NOT_FOUND', 404);
  if (record.platform !== 'wechat_channels') fail('RECORD_NOT_WECHAT_CHANNELS', 422);
  if (!SHARE_LINK.test(String(record.url || ''))) fail('RECORD_SHARE_LINK_MISSING', 422);
  const open = await tx.queryOne(`SELECT ${VIEW_COLUMNS} FROM capture_task_items item JOIN capture_tasks parent ON parent.id=item.task_id
    WHERE item.tenant_id=$1 AND item.item_type=$2 AND item.record_id=$3 AND item.keyword=$4 AND item.status IN ('pending','running')
    ORDER BY parent.created_at DESC LIMIT 1`, [tenantId, FORWARD_ITEM_TYPE, record.id, name]);
  if (open) return {...view(open), existing: true};
  const phones = (await tx.queryAll(`SELECT id FROM capture_agents WHERE tenant_id=$1 AND status='active'
    AND capabilities->>'agentKind'='android_mobile' AND 'wechat_channels'=ANY(allowed_platforms) ORDER BY created_at`, [tenantId]))
    .map(row => row.id);
  if (!phones.length) fail('NO_WECHAT_PHONE', 409);
  const parentId = randomUUID();
  const metadata = {distributionMode: 'elastic_pool', eligibleAgentIds: phones, claimUnit: 'keyword', executionMode: 'one_time',
    wechatForward: {recordId: record.id, recipient: name, requestedByUserId: userId, requestedByName: String(userName).slice(0, 120)},
    planSnapshot: {platform: 'wechat_channels', keywords: [name], searchFilters: {}, keywordMaxDetectedItems: 1, captureSettings: {}}};
  await tx.execute(`INSERT INTO capture_tasks(id,tenant_id,client_task_id,task_type,feature_key,title,platform,source,trigger_type,
      status,metadata,orchestration_revision,counts,progress,message,created_at)
    VALUES($1::uuid,$2,$1::uuid::text,'capture_orchestration','keyword_orchestration',$3,'wechat_channels','cloud','manual',
      'pending',$4,1,'{"total":1}'::jsonb,'{"current":0,"total":1}'::jsonb,'等待手机空闲后发送',clock_timestamp())`,
  // clock_timestamp: contacts picked together are sent in the order they were picked (the claim orders by creation).
  [parentId, tenantId, `发到微信 · ${name}`.slice(0, 240), metadata]);
  await tx.execute(`INSERT INTO capture_task_items(id,tenant_id,task_id,item_key,ordinal,keyword,platform,item_type,record_id,
      external_id,url_snapshot,status,metadata,assignment_revision)
    VALUES($1,$2,$3,$4,0,$5,'wechat_channels',$6,$7,$8,$9,'pending',$10::jsonb,0)`,
  [randomUUID(), tenantId, parentId, `${FORWARD_ITEM_TYPE}:${record.id}`, name, FORWARD_ITEM_TYPE, record.id, record.external_id,
    record.url, JSON.stringify({recipient: name})]);
  return view(await tx.queryOne(`SELECT ${VIEW_COLUMNS} FROM capture_task_items item JOIN capture_tasks parent ON parent.id=item.task_id
    WHERE parent.id=$1 AND parent.tenant_id=$2`, [parentId, tenantId]));
}

/** The latest forwards of one post, newest first (the drawer shows the newest per contact). */
export async function recordForwards(tx, tenantId, recordId) {
  const rows = await tx.queryAll(`SELECT * FROM (
      SELECT DISTINCT ON (item.keyword) ${VIEW_COLUMNS}
      FROM capture_task_items item JOIN capture_tasks parent ON parent.id=item.task_id
      WHERE item.tenant_id=$1 AND item.item_type=$2 AND item.record_id=$3
      ORDER BY item.keyword, parent.created_at DESC, parent.id DESC
    ) latest ORDER BY created_at DESC, id DESC LIMIT 100`,
  [tenantId, FORWARD_ITEM_TYPE, id(recordId, 'RECORD_ID')]);
  return rows.map(view);
}

/** What the phone needs: the stored link (its preview gives a fresh export id) and who must match it. */
export async function forwardTarget(tx, tenantId, item) {
  const record = await tx.queryOne(`SELECT id, url, title, author_name, publish_time FROM records WHERE tenant_id=$1 AND id=$2`,
    [tenantId, item.record_id]);
  if (!record || !SHARE_LINK.test(String(item.url_snapshot || record.url || ''))) return null;
  return {recordId: record.id, url: item.url_snapshot || record.url, recipient: item.keyword, title: String(record.title || '').slice(0, 200),
    author: record.author_name || '', createtime: beijingSeconds(record.publish_time)};
}

/** The item status of a finished forward attempt: sent, sent without the 「已发送」 toast seen, or failed (never retried). */
export function forwardItemStatus(status, reason) {
  if (status === 'completed') return reason === 'forward_unconfirmed' ? 'completed_with_warnings' : 'completed';
  return 'failed';
}
