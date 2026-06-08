/**
 * 预警引擎 — 检查新记录是否触发预警规则
 */

import { queryOne, queryAll, execute, getSetting } from '../db/init.js';
import { sendAlertEmail } from './email-notifier.js';

const HIGH_DANGER_KEYWORDS_DEFAULT = '安全,隐私,泄露,事故,召回,起火,失控,刹车失灵,死亡,伤亡';

export async function checkAlerts(recordId) {
  const record = queryOne('SELECT * FROM records WHERE id = ?', [recordId]);
  if (!record) return;

  const alerts = [];

  // 规则 1：高危关键词
  const dangerKeywords = (getSetting('alert_high_danger_keywords') || HIGH_DANGER_KEYWORDS_DEFAULT)
    .split(',').map(k => k.trim()).filter(Boolean);
  const textToCheck = `${record.title} ${record.content}`.toLowerCase();
  const matchedDangerKeywords = dangerKeywords.filter(kw => textToCheck.includes(kw.toLowerCase()));

  if (matchedDangerKeywords.length > 0) {
    alerts.push({
      record_id: recordId, level: 'critical',
      reason: `高危关键词命中: ${matchedDangerKeywords.join(', ')}`,
      title: record.title,
      summary: record.ai_summary || record.content?.slice(0, 100) || '',
      url: record.url,
      interaction_total: (record.likes || 0) + (record.comments_count || 0) + (record.collects || 0),
    });
  }

  // 规则 2：高互动负面
  const threshold = Number(getSetting('alert_high_interaction_threshold') || 500);
  const interactionTotal = (record.likes || 0) + (record.comments_count || 0) + (record.collects || 0);

  if (record.sentiment === 'negative' && interactionTotal >= threshold) {
    alerts.push({
      record_id: recordId, level: 'critical',
      reason: `高互动负面: 总互动量 ${interactionTotal} (阈值 ${threshold})`,
      title: record.title,
      summary: record.ai_summary || record.content?.slice(0, 100) || '',
      url: record.url, interaction_total: interactionTotal,
    });
  }

  // 规则 3：集中负面
  const burstCount = Number(getSetting('alert_negative_burst_count') || 5);
  const burstWindow = Number(getSetting('alert_negative_burst_window_minutes') || 60);

  if (record.sentiment === 'negative') {
    const windowStart = new Date();
    windowStart.setMinutes(windowStart.getMinutes() - burstWindow);

    const recentNeg = queryOne(
      "SELECT COUNT(*) as n FROM records WHERE sentiment = 'negative' AND created_at >= ?",
      [windowStart.toISOString()]
    );

    if (recentNeg && recentNeg.n >= burstCount) {
      const existingBurstAlert = queryOne(
        "SELECT id FROM alerts WHERE level = 'warning' AND reason LIKE '%集中负面%' AND created_at >= ?",
        [windowStart.toISOString()]
      );

      if (!existingBurstAlert) {
        alerts.push({
          record_id: recordId, level: 'warning',
          reason: `集中负面: ${burstWindow}分钟内出现 ${recentNeg.n} 条负面内容 (阈值 ${burstCount})`,
          title: '集中负面舆情预警',
          summary: `最近${burstWindow}分钟内检测到${recentNeg.n}条负面舆情`,
          url: '', interaction_total: 0,
        });
      }
    }
  }

  // 规则 4：一般负面
  if (record.sentiment === 'negative' && alerts.length === 0) {
    alerts.push({
      record_id: recordId, level: 'info',
      reason: '负面内容', title: record.title,
      summary: record.ai_summary || record.content?.slice(0, 100) || '',
      url: record.url, interaction_total: interactionTotal,
    });
  }

  for (const alert of alerts) {
    execute(
      'INSERT INTO alerts (record_id, level, reason, title, summary, url, interaction_total) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [alert.record_id, alert.level, alert.reason, alert.title, alert.summary, alert.url, alert.interaction_total]
    );

    if (alert.level === 'critical' || alert.level === 'warning') {
      try { await sendAlertEmail(alert); }
      catch (err) { console.error('[Alert] Email notification failed:', err.message); }
    }
  }

  if (alerts.length > 0) console.log(`[Alert] Record ${recordId}: ${alerts.length} alerts generated`);
  return alerts;
}
