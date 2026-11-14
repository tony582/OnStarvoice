import {createHash} from 'node:crypto';
import {execute, queryAll, queryOne} from '../db/init.js';
import {createFeishuDailyClient} from './feishu-daily-report.js';
import {openDailySecret, resolvedDailyConfig} from './customer-daily-report-config.js';
import {parsePublishTimestamp} from './publish-date.js';
import {recordTriageAdmission} from './record-triage-admission.js';
import {truncateWellFormed} from '../utils/well-formed-text.js';

export function creatorAlertEligible(row, now = Date.now()) {
  if (!row?.followed_creator_subscription_id || row.subscription_status !== 'active' ||
      !row.alert_enabled || row.enabled !== 'true' || row.business_visibility !== 'eligible' ||
      !['relevant','uncertain'].includes(row.ai_result?.relevance) || !recordTriageAdmission(row).admitted) return false;
  const time = (row.published_ts && new Date(row.published_ts)) || parsePublishTimestamp(row.publish_time, row.created_at) || new Date(row.created_at);
  const configured = Number(row.max_age);
  const days = Number.isInteger(configured) && configured > 0 ? configured : 7;
  return time.getTime() <= now && time.getTime() >= now - days * 86400000;
}

export async function checkFollowedCreatorAlert({tenantId, recordId, relevance}) {
  if (relevance === 'irrelevant') return;
  const row = await queryOne(`SELECT r.*, s.status AS subscription_status, s.alert_enabled,
    COALESCE(NULLIF(s.creator_label,''),s.name) AS creator_label, e.value AS enabled, a.value AS max_age,
    EXISTS(SELECT 1 FROM record_observations o WHERE o.tenant_id=r.tenant_id
      AND o.record_id=r.id AND o.monitor_execution_id IS NOT NULL) AS from_patrol
    FROM records r JOIN monitor_subscriptions s
      ON s.id=r.followed_creator_subscription_id AND s.tenant_id=r.tenant_id
    LEFT JOIN tenant_settings e ON e.tenant_id=r.tenant_id AND e.key='followed_creator_alerts_enabled'
    LEFT JOIN tenant_settings a ON a.tenant_id=r.tenant_id AND a.key='followed_creator_alert_max_age_days'
    WHERE r.tenant_id=$1 AND r.id=$2`, [tenantId, recordId]);
  if (!creatorAlertEligible(row)) return;
  const payload = {
    title: truncateWellFormed(row.title, 240), creator: row.creator_label, platform: row.platform,
    brand: (Array.isArray(row.ai_result?.monitoringEvidence?.evidence) ? row.ai_result.monitoringEvidence.evidence : []).map(item => item?.entity).filter(Boolean).slice(0, 4).join('、'), relevance: row.ai_result.relevance, sentiment: row.sentiment,
    publishedAt: row.published_ts || (row.publish_time ? parsePublishTimestamp(row.publish_time, row.created_at)?.toISOString() : null),
    likes: row.likes, url: row.canonical_url || row.url, fromPatrol: row.from_patrol,
  };
  await execute(`INSERT INTO followed_creator_alerts (tenant_id,record_id,payload) VALUES ($1,$2,$3::jsonb)
    ON CONFLICT (tenant_id,record_id) DO NOTHING`, [tenantId, recordId, JSON.stringify(payload)]);
}

export async function creatorAlertSettings(tenantId) {
  const rows = await queryAll("SELECT key,value FROM tenant_settings WHERE tenant_id=$1 AND key LIKE 'followed_creator_alert%'", [tenantId]);
  return Object.fromEntries(rows.map(({key,value}) => [key,value]));
}

export async function creatorAlertTarget(tenantId, settings) {
  const daily = (await queryOne('SELECT config FROM customer_daily_report_settings WHERE tenant_id=$1', [tenantId]))?.config || {};
  const custom = JSON.parse(settings.followed_creator_alert_target || '{}');
  const channel = custom.channel || daily.channel || 'app';
  const base = channel === 'app' ? resolvedDailyConfig({...daily,channel:'app'}, tenantId, process.env) : {};
  const config = {...base, channel, documentBaseUrl: daily.documentBaseUrl || 'https://app.feishu.cn'};
  if (channel === 'webhook') {
    const source = custom.channel ? custom : daily;
    const prefix = custom.channel ? 'followedCreator' : '';
    config.webhookUrl = openDailySecret(source.webhookUrlEncrypted, tenantId, prefix ? 'followedCreatorWebhookUrl' : 'webhookUrl', process.env);
    config.webhookSecret = openDailySecret(source.webhookSecretEncrypted, tenantId, prefix ? 'followedCreatorWebhookSecret' : 'webhookSecret', process.env);
    if (!config.webhookUrl || !config.webhookSecret) return null;
  } else {
    config.chatId = custom.chatId || daily.chatId;
    if (!config.appId || !config.appSecret || !config.chatId) return null;
  }
  return config;
}

function safeLink(raw) {
  try {
    const url = new URL(raw);
    if (['https:','http:'].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch {}
  return '';
}

export function creatorAlertPost(payload) {
  const names = {douyin:'抖音',xiaohongshu:'小红书',weibo:'微博',wechat_channels:'视频号'};
  const sentiment = {positive:'正面',neutral:'中性',negative:'负面'}[payload.sentiment] || '未判定';
  const when = payload.publishedAt ? new Date(payload.publishedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}) : '未知';
  const title = payload.test ? '关注博主提醒测试' :
    `${payload.sentiment === 'negative' ? '负面 ' : ''}【关注博主】${payload.creator}（${names[payload.platform] || payload.platform}）发布了品牌相关内容`;
  const line = text => [{tag:'text',text}];
  const content = payload.test ? [line('飞书接收测试')] : [
    line(payload.title || '未命名作品'),
    line(`品牌：${payload.brand || '待确认'} · 相关性：${payload.relevance === 'relevant' ? '相关' : '不确定'} · 情感：${sentiment}`),
    line(`发布时间（北京时间）：${when} · 点赞：${payload.likes ?? '未知'}`),
    line(`来源：${payload.fromPatrol ? '博主巡查' : '自然采集'}`),
  ];
  const original = safeLink(payload.url);
  if (original) content.push([{tag:'a',text:'查看原帖',href:original}]);
  const admin = safeLink(process.env.ADMIN_PUBLIC_URL);
  if (admin && !payload.test) {
    const url = new URL('/admin/', admin);
    url.search = 'page=workbench&queue=triage&followedCreator=1';
    content.push([{tag:'a',text:'查看内容分诊',href:url.href}]);
  }
  return {zh_cn:{title, content}};
}

export function creatorAlertFailure(channel, attempts, error) {
  if (channel === 'webhook' && error?.ambiguous) return 'ambiguous';
  return attempts < 3 && (error?.retryable || (channel === 'app' && error?.ambiguous)) ? 'pending' : 'failed';
}

export async function processFollowedCreatorAlerts(limit = 20) {
  // A worker that disappeared after claiming a webhook may already have delivered it.
  await execute(`UPDATE followed_creator_alerts SET status='ambiguous', finished_at=now(),
    last_error='发送结果待核实，不会自动重试'
    WHERE status='sending' AND channel='webhook' AND claimed_at < now()-interval '2 minutes'`);
  await execute(`UPDATE followed_creator_alerts SET status=CASE WHEN attempts<3 THEN 'pending' ELSE 'failed' END,
    claimed_at=NULL WHERE status='sending' AND channel='app' AND claimed_at < now()-interval '2 minutes'`);
  const due = await queryAll(`SELECT id,tenant_id,record_id,payload,channel,target_key FROM followed_creator_alerts
    WHERE status='pending' AND next_attempt_at<=now() ORDER BY next_attempt_at,id LIMIT $1`, [limit]);
  for (const row of due) {
    const config = await creatorAlertSettings(row.tenant_id);
    if (row.record_id) {
      const active = await queryOne(`SELECT 1 FROM records r JOIN monitor_subscriptions s
        ON s.id=r.followed_creator_subscription_id AND s.tenant_id=r.tenant_id
        WHERE r.id=$1 AND r.tenant_id=$2 AND s.status='active' AND s.alert_enabled`,[row.record_id,row.tenant_id]);
      if (!active || config.followed_creator_alerts_enabled !== 'true') {
        await execute("UPDATE followed_creator_alerts SET status='cancelled',finished_at=now() WHERE id=$1 AND status='pending'",[row.id]);
        continue;
      }
    }
    let target;
    try { target = await creatorAlertTarget(row.tenant_id, config); } catch {}
    if (!target) {
      await execute("UPDATE followed_creator_alerts SET status='failed',finished_at=now(),last_error='请先配置日报飞书，或另填一个群' WHERE id=$1 AND status='pending'",[row.id]);
      continue;
    }
    const targetKey = createHash('sha256').update(JSON.stringify(
      target.channel === 'app' ? [target.channel,target.appId,target.chatId] : [target.channel,target.webhookUrl],
    )).digest('hex');
    const claimed = await queryOne(`UPDATE followed_creator_alerts SET status='sending',channel=$1,target_key=$3,
      claimed_at=now(),attempts=attempts+1 WHERE id=$2 AND status='pending' AND next_attempt_at<=now()
      AND (target_key IS NULL OR target_key=$3) RETURNING attempts`, [target.channel,row.id,targetKey]);
    if (!claimed) {
      if (row.target_key && row.target_key !== targetKey) await execute(
        "UPDATE followed_creator_alerts SET status='failed',finished_at=now(),last_error='发送目标已变更' WHERE id=$1 AND status='pending'",[row.id]);
      continue;
    }
    let status = 'sent';
    let message = '';
    try {
      await createFeishuDailyClient(target).sendPost({post:creatorAlertPost(row.payload),uuid:row.id});
    } catch (error) {
      status = creatorAlertFailure(target.channel,claimed.attempts,error);
      message = error?.safeMessage || '发送失败，请核对飞书配置';
    }
    await execute(`UPDATE followed_creator_alerts SET status=$1,last_error=$2,
      finished_at=CASE WHEN $1='pending' THEN NULL ELSE now() END,
      next_attempt_at=now()+interval '1 minute'
      WHERE id=$3 AND status='sending' AND attempts=$4`, [status,message,row.id,claimed.attempts]);
  }
}
