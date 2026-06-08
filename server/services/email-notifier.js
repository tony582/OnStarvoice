/**
 * 邮件通知服务
 */

import nodemailer from 'nodemailer';
import { getSetting } from '../db/init.js';

let transporter = null;

function getTransporter() {
  const host = getSetting('smtp_host') || process.env.SMTP_HOST;
  const port = Number(getSetting('smtp_port') || process.env.SMTP_PORT || 465);
  const secure = (getSetting('smtp_secure') || process.env.SMTP_SECURE || 'true') === 'true';
  const user = getSetting('smtp_user') || process.env.SMTP_USER;
  const pass = getSetting('smtp_pass') || process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    return null;
  }

  if (!transporter || transporter._host !== host || transporter._user !== user) {
    transporter = nodemailer.createTransport({
      host, port, secure,
      auth: { user, pass },
    });
    transporter._host = host;
    transporter._user = user;
  }

  return transporter;
}

const LEVEL_LABEL = {
  critical: '🔴 重度',
  warning: '🟡 中度',
  info: '🟢 轻度',
};

const LEVEL_COLOR = {
  critical: '#DC2626',
  warning: '#F59E0B',
  info: '#10B981',
};

/**
 * 发送预警邮件
 */
export async function sendAlertEmail(alert) {
  const t = getTransporter();
  if (!t) {
    console.log('[Email] SMTP not configured, skipping notification');
    return;
  }

  const from = getSetting('email_from') || process.env.EMAIL_FROM || '';
  const to = getSetting('email_to') || process.env.EMAIL_TO || '';

  if (!to) {
    console.log('[Email] No recipient configured');
    return;
  }

  const levelLabel = LEVEL_LABEL[alert.level] || alert.level;
  const levelColor = LEVEL_COLOR[alert.level] || '#666';

  const subject = `[OnStarVoice 舆情预警] ${levelLabel} ${alert.reason}`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: linear-gradient(135deg, #0077B6 0%, #00B4D8 100%); padding: 20px 24px; border-radius: 12px 12px 0 0;">
        <h2 style="color: #fff; margin: 0; font-size: 18px;">OnStarVoice 舆情预警</h2>
      </div>
      <div style="border: 1px solid #E5E7EB; border-top: none; padding: 24px; border-radius: 0 0 12px 12px;">
        <div style="display: flex; align-items: center; margin-bottom: 16px;">
          <span style="background: ${levelColor}; color: #fff; padding: 4px 12px; border-radius: 6px; font-size: 14px; font-weight: 600;">
            ${levelLabel}
          </span>
        </div>

        <h3 style="margin: 0 0 8px; color: #111827; font-size: 16px;">${alert.title || '(无标题)'}</h3>

        <p style="color: #6B7280; font-size: 14px; line-height: 1.6; margin: 0 0 16px;">
          ${alert.summary || ''}
        </p>

        <table style="width: 100%; border-collapse: collapse; font-size: 13px; color: #374151;">
          <tr>
            <td style="padding: 8px 0; border-bottom: 1px solid #F3F4F6; font-weight: 600; width: 100px;">预警原因</td>
            <td style="padding: 8px 0; border-bottom: 1px solid #F3F4F6;">${alert.reason}</td>
          </tr>
          ${alert.interaction_total ? `
          <tr>
            <td style="padding: 8px 0; border-bottom: 1px solid #F3F4F6; font-weight: 600;">总互动量</td>
            <td style="padding: 8px 0; border-bottom: 1px solid #F3F4F6;">${alert.interaction_total}</td>
          </tr>` : ''}
          ${alert.url ? `
          <tr>
            <td style="padding: 8px 0; border-bottom: 1px solid #F3F4F6; font-weight: 600;">原文链接</td>
            <td style="padding: 8px 0; border-bottom: 1px solid #F3F4F6;">
              <a href="${alert.url}" style="color: #0077B6;">${alert.url}</a>
            </td>
          </tr>` : ''}
          <tr>
            <td style="padding: 8px 0; font-weight: 600;">预警时间</td>
            <td style="padding: 8px 0;">${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</td>
          </tr>
        </table>

        <div style="margin-top: 24px; padding: 12px; background: #F9FAFB; border-radius: 8px; font-size: 12px; color: #9CA3AF;">
          此邮件由 OnStarVoice 舆情监控系统自动发送，请勿直接回复。
        </div>
      </div>
    </div>
  `;

  await t.sendMail({ from, to, subject, html });
  console.log(`[Email] Alert notification sent to ${to}`);
}

/**
 * 发送报表邮件
 */
export async function sendReportEmail(subject, htmlContent) {
  const t = getTransporter();
  if (!t) {
    console.log('[Email] SMTP not configured, skipping report');
    return;
  }

  const from = getSetting('email_from') || process.env.EMAIL_FROM || '';
  const to = getSetting('email_to') || process.env.EMAIL_TO || '';

  if (!to) return;

  await t.sendMail({ from, to, subject, html: htmlContent });
  console.log(`[Email] Report sent to ${to}`);
}

/**
 * 发送测试邮件
 */
export async function sendTestEmail() {
  const t = getTransporter();
  if (!t) {
    throw new Error('SMTP 未配置');
  }

  const from = getSetting('email_from') || process.env.EMAIL_FROM || '';
  const to = getSetting('email_to') || process.env.EMAIL_TO || '';

  if (!to) throw new Error('收件人未配置');

  await t.sendMail({
    from, to,
    subject: '[OnStarVoice] 测试邮件',
    html: '<p>这是一封测试邮件，如果你收到了说明邮件通知配置正确。</p>',
  });

  return { ok: true, message: `测试邮件已发送到 ${to}` };
}
