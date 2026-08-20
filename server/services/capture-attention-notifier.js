import { createHash, randomUUID } from 'crypto';
import { execute, getSetting, withTransaction } from '../db/init.js';
import {
  EmailConfigurationError,
  sendTenantEmail,
} from './email-notifier.js';

const SAFETY_NOTIFICATION_TYPE = 'security_verification';
const MAX_DELIVERY_ATTEMPTS = 5;
const MAX_CLAIM_BATCH_SIZE = 50;
const RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
];
const SAFETY_CODES = new Set([
  'DOUYIN_SEARCH_SECURITY_CHALLENGE',
  'PLATFORM_SAFETY_BLOCK',
  'SECURITY_VERIFICATION_REQUIRED',
  'XHS_SECURITY_BLOCK',
  'PAGE_CHALLENGE_BLOCK',
  'PAGE_CHALLENGE',
  'HTTP_429',
  'RATE_LIMITED',
  'CAPTCHA_REQUIRED',
  'LOGIN_REQUIRED',
  'AUTH_REQUIRED',
  'DOUYIN_LOGIN_REQUIRED',
  'XHS_LOGIN_REQUIRED',
]);
const CONFIGURATION_ERROR_CODES = new Set([
  'SMTP_NOT_CONFIGURED',
  'EMAIL_RECIPIENT_NOT_CONFIGURED',
]);

function object(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function text(value, limit = 1000) {
  const normalized = String(value ?? '').trim();
  return normalized.length > limit ? normalized.slice(0, limit) : normalized;
}

function integer(value, fallback = 0) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

function safetyCode(value) {
  const source = object(value);
  const nestedError = object(source.error);
  return text(
    source.code ||
      source.errorCode ||
      source.error_code ||
      nestedError.code,
    100,
  ).toUpperCase();
}

function safetyCategory(value) {
  const source = object(value);
  const nestedError = object(source.error);
  return text(
    source.category ||
      source.errorCategory ||
      source.error_category ||
      nestedError.category,
    100,
  ).toLowerCase();
}

function hasStructuredSafetyEvidence(value) {
  const source = object(value);
  const nestedError = object(source.error);
  const code = safetyCode(source);
  if (code === 'DOUYIN_SEARCH_SERVICE_ABNORMAL') return false;
  return Boolean(
    source.securityBlocked === true ||
      source.security_blocked === true ||
      source.platformSafetyBlocked === true ||
      source.platform_safety_blocked === true ||
      source.requiresManualAction === true ||
      source.requires_manual_action === true ||
      nestedError.securityBlocked === true ||
      nestedError.security_blocked === true ||
      nestedError.platformSafetyBlocked === true ||
      nestedError.platform_safety_blocked === true ||
      nestedError.requiresManualAction === true ||
      nestedError.requires_manual_action === true ||
      object(source.securityEvidence).confirmed === true ||
      object(nestedError.securityEvidence).confirmed === true ||
      [
        'platform_safety_block',
        'login_required',
        'authentication_required',
      ].includes(safetyCategory(source)) ||
      SAFETY_CODES.has(code)
  );
}

function checkpointEntries(snapshot) {
  const checkpoint = object(snapshot?.checkpoint);
  const candidates = [
    checkpoint.keywordResults,
    checkpoint.keyword_results,
    checkpoint.results,
  ];
  const entries = candidates.find(Array.isArray);
  return Array.isArray(entries)
    ? entries.filter(item => item && typeof item === 'object')
    : [];
}

function safetyEvidenceCandidates(snapshot, task = {}) {
  return [
    snapshot?.error,
    snapshot?.progress,
    snapshot?.checkpoint,
    snapshot?.metadata,
    task?.error,
    task?.progress,
    task?.checkpoint,
    ...checkpointEntries(snapshot),
  ].filter(Boolean);
}

function firstSafetyEvidence(snapshot, task = {}) {
  return safetyEvidenceCandidates(snapshot, task)
    .find(hasStructuredSafetyEvidence) || {};
}

export function isStructuredSafetyAttention(snapshot = {}, task = {}) {
  if (text(snapshot?.status, 80) !== 'needs_action') return false;
  if (text(task?.status, 80) !== 'needs_action') return false;
  return safetyEvidenceCandidates(snapshot, task)
    .some(hasStructuredSafetyEvidence);
}

export function buildCaptureAttentionEventKey(
  taskId,
  attemptNumber,
  code = 'PLATFORM_SAFETY_BLOCK',
) {
  return [
    SAFETY_NOTIFICATION_TYPE,
    text(taskId, 100),
    integer(attemptNumber),
    text(code, 100).toUpperCase() || 'PLATFORM_SAFETY_BLOCK',
  ].join(':');
}

export function captureAttentionRetryDelayMs(attemptNumber) {
  const index = Math.max(0, integer(attemptNumber, 1) - 1);
  return RETRY_DELAYS_MS[
    Math.min(index, RETRY_DELAYS_MS.length - 1)
  ];
}

export function normalizeCaptureAttentionRecipients(raw) {
  const seen = new Set();
  const recipients = [];
  for (const candidate of String(raw || '').split(/[;,\n]/gu)) {
    const email = candidate.trim().toLowerCase();
    if (
      !email ||
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ||
      seen.has(email)
    ) {
      continue;
    }
    seen.add(email);
    recipients.push(email);
    if (recipients.length >= 20) break;
  }
  return recipients.join(',');
}

function currentKeywordDetails(snapshot, task = {}) {
  const progress = object(snapshot?.progress);
  const checkpoint = object(snapshot?.checkpoint);
  const entries = checkpointEntries(snapshot);
  const safetyEntry = [...entries].reverse().find(hasStructuredSafetyEvidence);
  const latestEntry = safetyEntry || entries.at(-1) || {};
  const keyword = text(
    progress.keyword ||
      progress.currentKeyword ||
      checkpoint.currentKeyword ||
      checkpoint.activeKeyword ||
      latestEntry.keyword,
    240,
  );
  const total = Math.max(
    integer(progress.total),
    integer(checkpoint.total),
    integer(object(snapshot?.counts).total),
    integer(object(task?.counts).total),
    entries.length,
  );
  const rawCurrent =
    progress.current ??
    progress.index ??
    checkpoint.current ??
    checkpoint.index ??
    latestEntry.index;
  let current = integer(rawCurrent);
  if (
    rawCurrent !== undefined &&
    latestEntry.index !== undefined &&
    Number(rawCurrent) === Number(latestEntry.index)
  ) {
    current += 1;
  }
  if (!current && keyword && entries.length) {
    const position = entries.findIndex(entry => text(entry.keyword, 240) === keyword);
    if (position >= 0) current = position + 1;
  }
  return {
    keyword,
    current: Math.min(total || current, current),
    total,
    savedCount: Math.max(
      integer(object(snapshot?.counts).saved),
      integer(object(snapshot?.counts).records),
      integer(progress.savedCount),
      integer(checkpoint.savedCount),
      integer(latestEntry.savedCount),
    ),
  };
}

function captureAttentionAdminUrl(taskId, orchestrationId = '') {
  const configured = text(process.env.ADMIN_PUBLIC_URL, 2000);
  if (!configured) return '';
  try {
    const base = new URL(configured);
    if (!['http:', 'https:'].includes(base.protocol)) return '';
    const url = new URL('/admin/', base);
    url.searchParams.set('page', 'dispatch');
    url.searchParams.set('view', 'attention');
    url.searchParams.set('taskId', text(taskId, 100));
    if (text(orchestrationId, 100)) {
      url.searchParams.set('orchestrationId', text(orchestrationId, 100));
    }
    const mobileParams = new URLSearchParams({
      view: 'attention',
      taskId: text(taskId, 100),
      ...(text(orchestrationId, 100)
        ? {orchestrationId: text(orchestrationId, 100)}
        : {}),
    });
    url.hash = `/m/page/dispatch?${mobileParams.toString()}`;
    return url.toString();
  } catch {
    return '';
  }
}

function captureAttentionMessageId(eventKey) {
  const digest = createHash('sha256')
    .update(String(eventKey || ''))
    .digest('hex')
    .slice(0, 32);
  return `<capture-attention-${digest}@starvoice.local>`;
}

function formatDetectedAt(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
  });
}

export function buildCaptureAttentionEmail(notification = {}) {
  const payload = object(notification.payload);
  const title = text(payload.taskTitle || '采集任务', 240);
  const taskId = text(notification.task_id || payload.taskId, 100);
  const orchestrationId = text(payload.orchestrationId, 100);
  const eventKey = text(notification.event_key || payload.eventKey, 500);
  const adminUrl = captureAttentionAdminUrl(taskId, orchestrationId);
  const keywordCurrent = integer(payload.keywordCurrent);
  const keywordTotal = integer(payload.keywordTotal);
  const position = payload.keywordTotal
    ? `${keywordCurrent || '—'}/${keywordTotal}`
    : keywordCurrent
      ? String(keywordCurrent)
      : '—';
  const detectedAt = payload.detectedAt
    ? formatDetectedAt(payload.detectedAt)
    : '—';
  const link = adminUrl
    ? `<p style="margin:24px 0 0"><a href="${escapeHtml(adminUrl)}" style="display:inline-block;padding:10px 16px;border-radius:8px;background:#316ff6;color:#fff;text-decoration:none">打开调度中心处理</a></p>`
    : '';
  const subject = `[StarVoice 星语] 采集任务需要人工登录或安全验证 · ${title}`;
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:640px;margin:0 auto;color:#111827">
      <h2 style="font-size:20px;margin:0 0 8px">采集任务需要人工登录或验证</h2>
      <p style="margin:0 0 20px;color:#6b7280">当前关键词已在多轮自动恢复或跨 Agent 接力后再次遇到登录或安全验证，系统已停止继续扩散重试，等待人工处理当前 Agent。其它未开始关键词仍由系统自动分配。</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr><td style="padding:8px 0;color:#6b7280;width:120px">任务</td><td>${escapeHtml(title)}</td></tr>
        <tr><td style="padding:8px 0;color:#6b7280">Agent</td><td>${escapeHtml(payload.agentName || '—')}</td></tr>
        <tr><td style="padding:8px 0;color:#6b7280">平台</td><td>${escapeHtml(payload.platform || '—')}</td></tr>
        <tr><td style="padding:8px 0;color:#6b7280">中断关键词</td><td>${escapeHtml(payload.keyword || '—')}（${escapeHtml(position)}）</td></tr>
        <tr><td style="padding:8px 0;color:#6b7280">已保存</td><td>${integer(payload.savedCount)} 条</td></tr>
        <tr><td style="padding:8px 0;color:#6b7280">检测时间</td><td>${escapeHtml(detectedAt)}</td></tr>
        <tr><td style="padding:8px 0;color:#6b7280">原因</td><td>${escapeHtml(payload.errorMessage || payload.errorCode || '平台安全验证')}</td></tr>
      </table>
      ${link}
      <p style="margin:24px 0 0;color:#9ca3af;font-size:12px">此邮件只包含任务诊断信息，不包含账号凭据或验证码内容。</p>
    </div>
  `;
  return {
    subject,
    html,
    messageId: captureAttentionMessageId(eventKey),
    adminUrl,
  };
}

export async function enqueueCaptureSafetyAttentionNotification(tx, {
  agent = {},
  task = {},
  snapshot = {},
  previous = null,
  snapshotAccepted = false,
} = {}) {
  if (!snapshotAccepted || !task?.id) return null;
  if (!isStructuredSafetyAttention(snapshot, task)) return null;

  if (task.parent_task_id) {
    const recoveryProjection = await tx.queryOne(`
      SELECT
        COUNT(*) FILTER (WHERE item.status = 'retryable') AS retryable_count,
        COUNT(*) FILTER (WHERE item.status = 'needs_action') AS needs_action_count
      FROM capture_task_items item
      JOIN capture_tasks parent
        ON parent.id = item.task_id
        AND parent.tenant_id = item.tenant_id
      WHERE item.tenant_id = $1
        AND item.task_id = $2
        AND item.execution_task_id = $3
        AND item.status IN ('retryable', 'needs_action')
        AND COALESCE(parent.metadata->>'distributionMode', '') = 'elastic_pool'
    `, [
      agent.tenant_id || task.tenant_id,
      task.parent_task_id,
      task.id,
    ]);
    // 弹性队列第一次遇到验证码时先自动换一个账号验证是否为节点局部问题。
    // 只有跨节点仍然命中安全限制、工作项保持 needs_action 时才通知人。
    if (
      Number(recoveryProjection?.retryable_count || 0) > 0 &&
      Number(recoveryProjection?.needs_action_count || 0) === 0
    ) {
      return null;
    }
  }

  const attemptNumber = integer(
    task.attempt_number ?? snapshot.attemptNumber,
  );
  if (
    previous?.status === 'needs_action' &&
    integer(previous?.attempt_number) === attemptNumber
  ) {
    return null;
  }

  const evidence = firstSafetyEvidence(snapshot, task);
  const code = safetyCode(evidence) || 'PLATFORM_SAFETY_BLOCK';
  const category = safetyCategory(evidence) || 'platform_safety_block';
  const keyword = currentKeywordDetails(snapshot, task);
  const evidenceObject = object(evidence);
  const evidenceError = evidenceObject.error;
  const detailedEvidence = object(
    evidenceObject.securityEvidence ||
      object(evidenceError).securityEvidence,
  );
  const eventKey = buildCaptureAttentionEventKey(
    task.id,
    attemptNumber,
    code,
  );
  const payload = {
    eventKey,
    taskId: task.id,
    orchestrationId: text(task.parent_task_id, 100),
    taskTitle: text(task.title || snapshot.title || '采集任务', 240),
    agentId: agent.id,
    agentName: text(
      agent.display_name ||
        agent.client_label ||
        agent.browser_name ||
        '未命名 Agent',
      240,
    ),
    platform: text(task.platform || snapshot.platform || 'unknown', 80),
    attemptNumber,
    keyword: keyword.keyword,
    keywordCurrent: keyword.current,
    keywordTotal: keyword.total,
    savedCount: keyword.savedCount,
    errorCode: code,
    errorCategory: category,
    securityVariant: text(detailedEvidence.variant, 100),
    securityLanguage: text(detailedEvidence.language, 40),
    securityReason: text(detailedEvidence.reason, 100),
    errorMessage: text(
      evidenceObject.message ||
        object(evidenceError).message ||
        (typeof evidenceError === 'string' ? evidenceError : '') ||
        snapshot.message,
      1000,
    ),
    detectedAt:
      snapshot.updatedAt ||
      snapshot.heartbeatAt ||
      task.source_updated_at ||
      new Date().toISOString(),
  };

  return tx.queryOne(`
    INSERT INTO capture_attention_notifications (
      tenant_id, task_id, attempt_number, notification_type,
      event_key, status, payload, next_attempt_at, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4,
      $5, 'pending', $6::jsonb, now(), now(), now()
    )
    ON CONFLICT (tenant_id, event_key) DO NOTHING
    RETURNING id, event_key, status
  `, [
    agent.tenant_id || task.tenant_id,
    task.id,
    attemptNumber,
    SAFETY_NOTIFICATION_TYPE,
    eventKey,
    JSON.stringify(payload),
  ]);
}

async function claimCaptureAttentionNotifications(limit) {
  const claimToken = randomUUID();
  return withTransaction(async tx => tx.queryAll(`
    WITH due AS (
      SELECT id
      FROM capture_attention_notifications
      WHERE (
          status IN ('pending', 'retry_wait')
          AND next_attempt_at <= now()
        )
        OR (
          status = 'processing'
          AND locked_at <= now() - interval '10 minutes'
        )
      ORDER BY next_attempt_at ASC, created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT $1
    )
    UPDATE capture_attention_notifications notification
    SET status = 'processing',
      claim_token = $2::uuid,
      locked_at = now(),
      updated_at = now()
    FROM due
    WHERE notification.id = due.id
    RETURNING notification.*
  `, [limit, claimToken]));
}

async function persistCaptureAttentionDelivery(row, update) {
  const nextAttemptAt = update.nextAttemptAt instanceof Date
    ? update.nextAttemptAt.toISOString()
    : update.nextAttemptAt || new Date().toISOString();
  const result = await execute(`
    UPDATE capture_attention_notifications
    SET status = $3,
      recipient = $4,
      attempt_count = $5,
      next_attempt_at = $6,
      sent_at = $7,
      last_error = $8,
      message_id = $9,
      claim_token = NULL,
      locked_at = NULL,
      updated_at = now()
    WHERE id = $1
      AND status = 'processing'
      AND claim_token = $2::uuid
  `, [
    row.id,
    row.claim_token,
    update.status,
    update.recipient || '',
    integer(update.attemptCount),
    nextAttemptAt,
    update.sentAt || null,
    text(update.lastError, 2000),
    text(update.messageId, 500),
  ]);
  return result.rowCount === 1;
}

export async function deliverClaimedCaptureAttentionNotification(
  row,
  dependencies = {},
) {
  const getSettingFn = dependencies.getSettingFn || getSetting;
  const sendEmailFn = dependencies.sendEmailFn || sendTenantEmail;
  const persistFn = dependencies.persistFn || persistCaptureAttentionDelivery;
  const now = dependencies.now instanceof Date
    ? dependencies.now
    : new Date();
  const recipient = normalizeCaptureAttentionRecipients(
    await getSettingFn('capture_attention_email_to', row.tenant_id),
  );
  if (!recipient) {
    await persistFn(row, {
      status: 'blocked_config',
      recipient: '',
      attemptCount: integer(row.attempt_count),
      nextAttemptAt: now,
      sentAt: null,
      lastError: 'capture_attention_email_to 未配置或格式无效',
      messageId: '',
    });
    return {status: 'blocked_config'};
  }

  const email = buildCaptureAttentionEmail(row);
  try {
    await sendEmailFn({
      tenantId: row.tenant_id,
      to: recipient,
      subject: email.subject,
      html: email.html,
      messageId: email.messageId,
    });
    await persistFn(row, {
      status: 'sent',
      recipient,
      attemptCount: integer(row.attempt_count) + 1,
      nextAttemptAt: now,
      sentAt: now.toISOString(),
      lastError: '',
      messageId: email.messageId,
    });
    return {status: 'sent'};
  } catch (error) {
    const attemptCount = integer(row.attempt_count) + 1;
    const configurationError =
      error instanceof EmailConfigurationError ||
      CONFIGURATION_ERROR_CODES.has(text(error?.code, 100));
    const terminal = !configurationError &&
      attemptCount >= MAX_DELIVERY_ATTEMPTS;
    const status = configurationError
      ? 'blocked_config'
      : terminal
        ? 'failed'
        : 'retry_wait';
    const nextAttemptAt = status === 'retry_wait'
      ? new Date(
          now.getTime() + captureAttentionRetryDelayMs(attemptCount),
        )
      : now;
    await persistFn(row, {
      status,
      recipient,
      attemptCount,
      nextAttemptAt,
      sentAt: null,
      lastError: text(error?.message || '邮件发送失败', 2000),
      messageId: email.messageId,
    });
    return {status};
  }
}

export async function processCaptureAttentionNotifications(limit = 20) {
  const boundedLimit = Math.min(
    MAX_CLAIM_BATCH_SIZE,
    Math.max(1, integer(limit, 20)),
  );
  const rows = await claimCaptureAttentionNotifications(boundedLimit);
  const counts = {
    claimed: rows.length,
    sent: 0,
    retry_wait: 0,
    blocked_config: 0,
    failed: 0,
    worker_error: 0,
  };
  for (const row of rows) {
    try {
      const result = await deliverClaimedCaptureAttentionNotification(row);
      if (Object.prototype.hasOwnProperty.call(counts, result.status)) {
        counts[result.status] += 1;
      }
    } catch (error) {
      // An unexpected database/config read failure leaves this claimed row
      // fenced; the stale-claim window will safely return it to a later worker.
      counts.worker_error += 1;
      console.error(
        `[CaptureAttention] Notification ${row.id} worker error:`,
        error?.message || 'unknown error',
      );
    }
  }
  return counts;
}
