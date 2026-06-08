/**
 * 报表生成器 — 日报/周报
 */

import { queryOne, queryAll } from '../db/init.js';
import { sendReportEmail } from './email-notifier.js';

function getReportStats(sinceDate) {
  const since = sinceDate.toISOString();
  const total = queryOne('SELECT COUNT(*) as n FROM records WHERE created_at >= ?', [since]).n;
  const sentiment = queryAll("SELECT sentiment, COUNT(*) as count FROM records WHERE created_at >= ? AND sentiment != '' GROUP BY sentiment", [since]);
  const category = queryAll("SELECT category, COUNT(*) as count FROM records WHERE created_at >= ? AND category != '' GROUP BY category ORDER BY count DESC", [since]);
  const platform = queryAll('SELECT platform, COUNT(*) as count FROM records WHERE created_at >= ? GROUP BY platform ORDER BY count DESC', [since]);
  const intent = queryAll("SELECT intent, COUNT(*) as count FROM records WHERE created_at >= ? AND intent != '' GROUP BY intent ORDER BY count DESC", [since]);
  const topNegative = queryAll("SELECT title, url, platform, likes, comments_count, collects, ai_summary, author_name FROM records WHERE created_at >= ? AND sentiment = 'negative' ORDER BY (likes + comments_count + collects) DESC LIMIT 5", [since]);
  const topInteraction = queryAll('SELECT title, url, platform, likes, comments_count, collects, sentiment, ai_summary, author_name FROM records WHERE created_at >= ? ORDER BY (likes + comments_count + collects) DESC LIMIT 10', [since]);
  const alerts = queryAll('SELECT level, COUNT(*) as count FROM alerts WHERE created_at >= ? GROUP BY level', [since]);
  return { total, sentiment, category, platform, intent, topNegative, topInteraction, alerts };
}

const SENTIMENT_LABEL = { positive: '正面', neutral: '中性', negative: '负面' };
const SENTIMENT_COLOR = { positive: '#10B981', neutral: '#6B7280', negative: '#DC2626' };
const CATEGORY_LABEL = {
  safety_rescue: '安全救援', feature_usage: '功能使用', renewal_billing: '续费收费',
  privacy: '隐私安全', app_issue: 'App问题', service_quality: '服务质量',
  brand_image: '品牌形象', other: '其他',
};

function buildReportHTML(title, periodLabel, stats) {
  const sentimentMap = {};
  for (const s of stats.sentiment) sentimentMap[s.sentiment] = s.count;
  const negativeRate = stats.total > 0 ? ((sentimentMap.negative || 0) / stats.total * 100).toFixed(1) : '0.0';

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 700px; margin: 0 auto;">
      <div style="background: linear-gradient(135deg, #0077B6 0%, #00B4D8 100%); padding: 24px; border-radius: 12px 12px 0 0;">
        <h2 style="color: #fff; margin: 0 0 4px; font-size: 20px;">${title}</h2>
        <p style="color: rgba(255,255,255,0.8); margin: 0; font-size: 14px;">${periodLabel}</p>
      </div>
      <div style="border: 1px solid #E5E7EB; border-top: none; padding: 24px; border-radius: 0 0 12px 12px;">
        <div style="display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap;">
          <div style="flex: 1; min-width: 120px; padding: 16px; background: #F9FAFB; border-radius: 8px; text-align: center;">
            <div style="font-size: 28px; font-weight: 700; color: #111827;">${stats.total}</div>
            <div style="font-size: 12px; color: #6B7280; margin-top: 4px;">总舆情量</div>
          </div>
          <div style="flex: 1; min-width: 120px; padding: 16px; background: #FEF2F2; border-radius: 8px; text-align: center;">
            <div style="font-size: 28px; font-weight: 700; color: #DC2626;">${sentimentMap.negative || 0}</div>
            <div style="font-size: 12px; color: #6B7280; margin-top: 4px;">负面 (${negativeRate}%)</div>
          </div>
          <div style="flex: 1; min-width: 120px; padding: 16px; background: #F0FDF4; border-radius: 8px; text-align: center;">
            <div style="font-size: 28px; font-weight: 700; color: #10B981;">${sentimentMap.positive || 0}</div>
            <div style="font-size: 12px; color: #6B7280; margin-top: 4px;">正面</div>
          </div>
        </div>
        <h3 style="font-size: 15px; color: #111827; margin: 0 0 12px; border-bottom: 2px solid #E5E7EB; padding-bottom: 8px;">📊 情感分布</h3>
        ${stats.sentiment.length > 0 ? `<div style="margin-bottom: 20px;">${stats.sentiment.map(s => {
          const pct = stats.total > 0 ? (s.count / stats.total * 100).toFixed(1) : 0;
          return `<div style="display: flex; align-items: center; margin-bottom: 6px;">
            <span style="width: 50px; font-size: 13px; color: ${SENTIMENT_COLOR[s.sentiment] || '#666'}; font-weight: 600;">${SENTIMENT_LABEL[s.sentiment] || s.sentiment}</span>
            <div style="flex: 1; height: 20px; background: #F3F4F6; border-radius: 4px; overflow: hidden; margin: 0 8px;">
              <div style="height: 100%; width: ${pct}%; background: ${SENTIMENT_COLOR[s.sentiment] || '#6B7280'}; border-radius: 4px;"></div>
            </div>
            <span style="font-size: 13px; color: #374151; width: 80px; text-align: right;">${s.count} (${pct}%)</span>
          </div>`;
        }).join('')}</div>` : '<p style="color: #9CA3AF; font-size: 13px;">暂无数据</p>'}
        <h3 style="font-size: 15px; color: #111827; margin: 0 0 12px; border-bottom: 2px solid #E5E7EB; padding-bottom: 8px;">📂 问题分类</h3>
        ${stats.category.length > 0 ? `<table style="width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 20px;">
          <tr style="background: #F9FAFB;"><th style="padding: 8px 12px; text-align: left; color: #6B7280;">分类</th><th style="padding: 8px 12px; text-align: right; color: #6B7280;">数量</th><th style="padding: 8px 12px; text-align: right; color: #6B7280;">占比</th></tr>
          ${stats.category.map(c => {
            const pct = stats.total > 0 ? (c.count / stats.total * 100).toFixed(1) : 0;
            return `<tr><td style="padding: 8px 12px; border-bottom: 1px solid #F3F4F6;">${CATEGORY_LABEL[c.category] || c.category}</td><td style="padding: 8px 12px; border-bottom: 1px solid #F3F4F6; text-align: right;">${c.count}</td><td style="padding: 8px 12px; border-bottom: 1px solid #F3F4F6; text-align: right;">${pct}%</td></tr>`;
          }).join('')}
        </table>` : '<p style="color: #9CA3AF; font-size: 13px;">暂无数据</p>'}
        ${stats.topNegative.length > 0 ? `<h3 style="font-size: 15px; color: #111827; margin: 0 0 12px; border-bottom: 2px solid #E5E7EB; padding-bottom: 8px;">🔴 TOP 负面内容</h3>
        <ol style="padding-left: 20px; margin: 0 0 20px; font-size: 13px; line-height: 1.8;">
          ${stats.topNegative.map(r => `<li style="margin-bottom: 8px;"><a href="${r.url}" style="color: #0077B6; text-decoration: none;">${r.title || '(无标题)'}</a>
            <span style="color: #9CA3AF;"> — ${r.author_name || '匿名'} | ${r.likes}赞 ${r.comments_count}评论</span>
            ${r.ai_summary ? `<br><span style="color: #6B7280; font-size: 12px;">${r.ai_summary}</span>` : ''}</li>`).join('')}
        </ol>` : ''}
        <div style="margin-top: 24px; padding: 12px; background: #F9FAFB; border-radius: 8px; font-size: 12px; color: #9CA3AF;">
          此报表由 OnStarVoice 舆情监控系统自动生成 | ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
        </div>
      </div>
    </div>`;
}

export async function generateDailyReport() {
  const since = new Date(); since.setDate(since.getDate() - 1);
  const stats = getReportStats(since);
  if (stats.total === 0) { console.log('[Report] No data for daily report'); return; }
  const today = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const yesterday = since.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const html = buildReportHTML('OnStarVoice 舆情日报', `${yesterday} — ${today}`, stats);
  await sendReportEmail(`[OnStarVoice 日报] ${today} 舆情概览`, html);
  console.log('[Report] Daily report sent');
}

export async function generateWeeklyReport() {
  const since = new Date(); since.setDate(since.getDate() - 7);
  const stats = getReportStats(since);
  if (stats.total === 0) { console.log('[Report] No data for weekly report'); return; }
  const today = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const weekAgo = since.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const html = buildReportHTML('OnStarVoice 舆情周报', `${weekAgo} — ${today}`, stats);
  await sendReportEmail(`[OnStarVoice 周报] ${weekAgo} - ${today} 舆情概览`, html);
  console.log('[Report] Weekly report sent');
}
