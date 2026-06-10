/**
 * 预警引擎 — 检查新记录是否触发预警规则，并生成问题跟进单
 */

import crypto from 'crypto';
import { queryOne, execute, getSetting, withTransaction } from '../db/init.js';
import { sendAlertEmail } from './email-notifier.js';

const HIGH_DANGER_KEYWORDS_DEFAULT = '安全,隐私,泄露,事故,召回,起火,失控,刹车失灵,死亡,伤亡';

function sha1(value) {
  return crypto.createHash('sha1').update(value).digest('hex');
}

function severityForLevel(level) {
  if (level === 'critical') return 'critical';
  if (level === 'warning') return 'high';
  return 'medium';
}

function suggestedAction(record, alert) {
  if (alert.level === 'critical') return '优先人工复核，确认是否需要客服、PR 或产品团队介入。';
  if (record.sentiment === 'negative') return '进入舆情待办池，补充事实核查和处理记录。';
  return '保留观察，后续互动量上升时再升级处理。';
}

function buildClusterKey(record, alert) {
  const base = [
    record.tenant_id,
    record.platform,
    record.category || 'uncategorized',
    record.subcategory || '',
    record.keyword || '',
    alert.reason.split(':')[0] || alert.reason,
  ].join('|');
  return sha1(base);
}

async function attachIssue(record, alert, alertId) {
  const clusterKey = buildClusterKey(record, alert);
  const title = alert.title || record.title || '舆情问题';
  const severity = severityForLevel(alert.level);

  return await withTransaction(async tx => {
    const issue = await tx.queryOne(`
      INSERT INTO issues (
        tenant_id, title, severity, status, cluster_key, summary,
        suggested_action, primary_record_id, first_seen_at, last_seen_at, record_count
      ) VALUES ($1, $2, $3, 'new', $4, $5, $6, $7, now(), now(), 0)
      ON CONFLICT (tenant_id, cluster_key)
      DO UPDATE SET
        last_seen_at = now(),
        updated_at = now(),
        severity = CASE
          WHEN issues.severity = 'critical' THEN issues.severity
          WHEN excluded.severity = 'critical' THEN excluded.severity
          WHEN excluded.severity = 'high' AND issues.severity IN ('low', 'medium') THEN excluded.severity
          ELSE issues.severity
        END,
        status = CASE
          WHEN issues.status IN ('resolved', 'closed', 'ignored') THEN 'new'
          ELSE issues.status
        END,
        summary = COALESCE(NULLIF(excluded.summary, ''), issues.summary),
        suggested_action = COALESCE(NULLIF(excluded.suggested_action, ''), issues.suggested_action)
      RETURNING *
    `, [
      record.tenant_id,
      title,
      severity,
      clusterKey,
      alert.summary || record.ai_summary || record.content?.slice(0, 120) || '',
      suggestedAction(record, alert),
      record.id,
    ]);

    const link = await tx.queryOne(`
      INSERT INTO issue_records (tenant_id, issue_id, record_id, alert_id)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (issue_id, record_id)
      DO UPDATE SET alert_id = COALESCE(issue_records.alert_id, excluded.alert_id)
      RETURNING id
    `, [record.tenant_id, issue.id, record.id, alertId]);

    await tx.execute(`
      UPDATE issues
      SET record_count = (
        SELECT COUNT(*) FROM issue_records WHERE issue_id = $1
      ), updated_at = now()
      WHERE id = $1
    `, [issue.id]);

    await tx.execute(`
      INSERT INTO issue_events (tenant_id, issue_id, event_type, body, metadata)
      VALUES ($1, $2, $3, $4, $5::jsonb)
    `, [
      record.tenant_id,
      issue.id,
      link ? 'record_linked' : 'alert_linked',
      alert.reason,
      JSON.stringify({ alertId, recordId: record.id, level: alert.level }),
    ]);

    await tx.execute('UPDATE alerts SET issue_id = $1 WHERE id = $2', [issue.id, alertId]);
    return issue;
  });
}

export async function checkAlerts(recordId) {
  const record = await queryOne('SELECT * FROM records WHERE id = $1', [recordId]);
  if (!record) return [];

  const alerts = [];

  const dangerKeywords = ((await getSetting('alert_high_danger_keywords', record.tenant_id)) || HIGH_DANGER_KEYWORDS_DEFAULT)
    .split(',').map(k => k.trim()).filter(Boolean);
  const textToCheck = `${record.title} ${record.content}`.toLowerCase();
  const matchedDangerKeywords = dangerKeywords.filter(kw => textToCheck.includes(kw.toLowerCase()));
  const interactionTotal = (record.likes || 0) + (record.comments_count || 0) + (record.collects || 0) + (record.shares || 0);

  if (matchedDangerKeywords.length > 0) {
    alerts.push({
      record_id: recordId,
      level: 'critical',
      reason: `高危关键词命中: ${matchedDangerKeywords.join(', ')}`,
      title: record.title,
      summary: record.ai_summary || record.content?.slice(0, 100) || '',
      url: record.url,
      interaction_total: interactionTotal,
    });
  }

  const threshold = Number((await getSetting('alert_high_interaction_threshold', record.tenant_id)) || 500);

  if (record.sentiment === 'negative' && interactionTotal >= threshold) {
    alerts.push({
      record_id: recordId,
      level: 'critical',
      reason: `高互动负面: 总互动量 ${interactionTotal} (阈值 ${threshold})`,
      title: record.title,
      summary: record.ai_summary || record.content?.slice(0, 100) || '',
      url: record.url,
      interaction_total: interactionTotal,
    });
  }

  const burstCount = Number((await getSetting('alert_negative_burst_count', record.tenant_id)) || 5);
  const burstWindow = Number((await getSetting('alert_negative_burst_window_minutes', record.tenant_id)) || 60);

  if (record.sentiment === 'negative') {
    const windowStart = new Date();
    windowStart.setMinutes(windowStart.getMinutes() - burstWindow);

    const recentNeg = await queryOne(
      "SELECT COUNT(*) as n FROM records WHERE tenant_id = $1 AND sentiment = 'negative' AND created_at >= $2",
      [record.tenant_id, windowStart.toISOString()]
    );

    if (recentNeg && recentNeg.n >= burstCount) {
      const existingBurstAlert = await queryOne(
        "SELECT id FROM alerts WHERE tenant_id = $1 AND level = 'warning' AND reason ILIKE '%集中负面%' AND created_at >= $2",
        [record.tenant_id, windowStart.toISOString()]
      );

      if (!existingBurstAlert) {
        alerts.push({
          record_id: recordId,
          level: 'warning',
          reason: `集中负面: ${burstWindow}分钟内出现 ${recentNeg.n} 条负面内容 (阈值 ${burstCount})`,
          title: '集中负面舆情预警',
          summary: `最近${burstWindow}分钟内检测到${recentNeg.n}条负面舆情`,
          url: '',
          interaction_total: 0,
        });
      }
    }
  }

  if (record.sentiment === 'negative' && alerts.length === 0) {
    alerts.push({
      record_id: recordId,
      level: 'info',
      reason: '负面内容',
      title: record.title,
      summary: record.ai_summary || record.content?.slice(0, 100) || '',
      url: record.url,
      interaction_total: interactionTotal,
    });
  }

  for (const alert of alerts) {
    const inserted = await execute(`
      INSERT INTO alerts (tenant_id, record_id, level, reason, title, summary, url, interaction_total)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id
    `, [
      record.tenant_id,
      alert.record_id,
      alert.level,
      alert.reason,
      alert.title,
      alert.summary,
      alert.url,
      alert.interaction_total,
    ]);

    await attachIssue(record, alert, inserted.lastInsertRowid);

    if (alert.level === 'critical' || alert.level === 'warning') {
      try { await sendAlertEmail(alert, record.tenant_id); }
      catch (err) { console.error('[Alert] Email notification failed:', err.message); }
    }
  }

  if (alerts.length > 0) console.log(`[Alert] Record ${recordId}: ${alerts.length} alerts generated`);
  return alerts;
}
