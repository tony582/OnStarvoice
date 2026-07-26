import crypto from 'crypto';
import { withTransaction } from '../db/query.js';

const CLOUD_TASK_STATUSES = new Set([
  'pending',
  'waiting_device',
  'claimed',
  'running',
  'recovering',
  'interrupted',
  'resume_requested',
  'needs_action',
  'completed',
  'completed_with_warnings',
  'completed_with_failures',
  'failed',
  'canceled',
  'skipped',
  'superseded',
]);

const ACTIVE_TASK_STATUSES = new Set([
  'pending',
  'waiting_device',
  'claimed',
  'running',
  'recovering',
  'interrupted',
  'resume_requested',
  'needs_action',
]);

const TERMINAL_TASK_STATUSES = new Set([
  'completed',
  'completed_with_warnings',
  'completed_with_failures',
  'failed',
  'canceled',
  'skipped',
  'superseded',
]);

const PLATFORM_ALIASES = Object.freeze({
  xhs: 'xiaohongshu',
  red: 'xiaohongshu',
  xiaohongshu: 'xiaohongshu',
  douyin: 'douyin',
  tiktok_cn: 'douyin',
  weibo: 'weibo',
  mixed: 'mixed',
  unknown: 'unknown',
});

function text(value, limit = 500) {
  const normalized = String(value ?? '').trim();
  return normalized.length > limit ? normalized.slice(0, limit) : normalized;
}

function integer(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : fallback;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(numeric)));
}

function boolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function normalizeCalendarDate(value) {
  const match = String(value ?? '').trim().match(
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/,
  );
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return '';
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];
  if (day > daysInMonth) return '';
  return `${match[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function isoTimestamp(value) {
  if (!value) return null;
  const timestamp = Date.parse(String(value));
  if (!Number.isFinite(timestamp)) return null;
  const now = Date.now();
  return new Date(Math.min(timestamp, now + 5 * 60 * 1000)).toISOString();
}

function scheduledIsoTimestamp(value) {
  if (!value) return null;
  const timestamp = Date.parse(String(value));
  if (!Number.isFinite(timestamp)) return null;
  const now = Date.now();
  const tenYearsMs = 10 * 366 * 24 * 60 * 60 * 1000;
  if (timestamp < now - tenYearsMs || timestamp > now + tenYearsMs) return null;
  return new Date(timestamp).toISOString();
}

function jsonObject(value, fallback = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  return value;
}

const SENSITIVE_KEY_PATTERN =
  /(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|auth(?:entication)?[_-]?code|activation[_-]?code|credential|session)/i;

function safeStructuredValue(value, key = '', depth = 0, budget = null) {
  const limits = budget || {remainingNodes: 2000, remainingChars: 100000};
  if (limits.remainingNodes <= 0 || limits.remainingChars <= 0) return '[TRUNCATED]';
  limits.remainingNodes -= 1;
  const normalizedKey = String(key || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  if (SENSITIVE_KEY_PATTERN.test(normalizedKey)) return '[REDACTED]';
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const result = text(value, Math.min(2000, limits.remainingChars))
      .replace(/\bBearer\s+[A-Za-z0-9._~+/\-]+/gi, 'Bearer [REDACTED]');
    limits.remainingChars -= result.length;
    return result;
  }
  if (depth >= 4) {
    const result = text(value, Math.min(2000, limits.remainingChars));
    limits.remainingChars -= result.length;
    return result;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 200).map(item => safeStructuredValue(item, '', depth + 1, limits));
  }
  if (!value || typeof value !== 'object') return text(value, 2000);
  const result = {};
  for (const [childKey, childValue] of Object.entries(value).slice(0, 80)) {
    const safeKey = text(childKey, 80);
    if (!safeKey) continue;
    result[safeKey] = safeStructuredValue(childValue, safeKey, depth + 1, limits);
  }
  return result;
}

export function sanitizeCloudStructuredObject(value) {
  const result = safeStructuredValue(jsonObject(value));
  return result && typeof result === 'object' && !Array.isArray(result) ? result : {};
}

export function sanitizeCloudText(value, limit = 1000) {
  return text(safeStructuredValue(value), limit);
}

export function makeCaptureAgentToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashCaptureAgentToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

export function parseCaptureAgentEnvironment(clientLabel = '', userAgent = '') {
  const source = `${clientLabel} ${userAgent}`;
  const browserName = /Edg\//i.test(source) || /\bEdge\b/i.test(source)
    ? 'Edge'
    : /Chrome\//i.test(source) || /\bChrome\b/i.test(source)
      ? 'Chrome'
      : /Firefox\//i.test(source)
        ? 'Firefox'
        : /Safari\//i.test(source)
          ? 'Safari'
          : 'Browser';
  const operatingSystem = /Mac OS X|macOS/i.test(source)
    ? 'macOS'
    : /Windows/i.test(source)
      ? 'Windows'
      : /Linux/i.test(source)
        ? 'Linux'
        : 'Unknown OS';
  return { browserName, operatingSystem };
}

export function normalizeCaptureAgentPlatforms(value) {
  const source = Array.isArray(value) ? value : [];
  return [...new Set(source
    .map(item => PLATFORM_ALIASES[String(item || '').trim().toLowerCase()] || '')
    .filter(platform => ['xiaohongshu', 'douyin', 'weibo'].includes(platform)))]
    .slice(0, 3);
}

/**
 * Normalize the small, explicitly supported unattended-keyword contract used by
 * both the plan mirror and a cloud-created task. Arbitrary heartbeat metadata is
 * deliberately not round-tripped into a command that the browser will execute.
 */
export function normalizeRemoteTaskInput(input = {}) {
  const request = jsonObject(input);
  const nestedPlan = jsonObject(
    request.planSnapshot || request.unattendedPlan || request.plan,
  );
  const plan = Object.keys(nestedPlan).length > 0 ? nestedPlan : request;
  const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const read = (key, fallback = undefined) => {
    if (has(request, key)) return request[key];
    if (has(plan, key)) return plan[key];
    return fallback;
  };

  const rawExecutionMode = String(
    request.executionMode || request.execution_mode || 'one_time',
  ).trim().toLowerCase();
  const executionMode = [
    'unattended',
    'unattended_plan',
    'plan',
    'scheduled',
  ].includes(rawExecutionMode)
    ? 'unattended_plan'
    : 'one_time';

  const rawPlatform = String(read('platform', 'unknown')).trim().toLowerCase();
  const platform = PLATFORM_ALIASES[rawPlatform] || 'unknown';
  const rawKeywords = Array.isArray(read('keywords'))
    ? read('keywords')
    : String(read('keywords', '')).slice(0, 100000).split(/\r?\n/g);
  const keywords = [];
  const seenKeywords = new Set();
  for (const rawKeyword of rawKeywords) {
    const keyword = text(rawKeyword, 120);
    if (!keyword || seenKeywords.has(keyword)) continue;
    seenKeywords.add(keyword);
    keywords.push(keyword);
    if (keywords.length >= 30) break;
  }

  const rawFilters = jsonObject(read('searchFilters'));
  const filterValue = (key, fallback = '') => {
    if (has(request, key)) return text(request[key], 80).toLowerCase();
    return text(rawFilters[key], 80).toLowerCase() || fallback;
  };
  const searchFilters = {
    sort: filterValue('sort'),
    publishTime: filterValue('publishTime'),
    contentType: filterValue('contentType'),
    searchScope: filterValue('searchScope'),
    distance: filterValue('distance'),
    videoDuration: filterValue('videoDuration'),
  };

  const maxRounds = boundedInteger(read('maxRounds'), 1, 1, 100);
  const roundGapMin = boundedInteger(read('roundGapMin'), 10, 0, 1440);
  const randomOffsetMin = boundedInteger(read('randomOffsetMin'), 0, 0, 1440);
  const rawMode = String(read('mode', 'daily')).trim().toLowerCase();
  const mode = rawMode === 'holidays'
    ? 'custom_dates'
    : ['daily', 'custom_dates'].includes(rawMode) ? rawMode : 'daily';
  const rawStartTime = text(read('startTime', '09:00'), 5);
  const startTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(rawStartTime)
    ? rawStartTime
    : '09:00';
  const customDates = [...new Set(
    String(read('customDates') || read('holidayDates') || '').slice(0, 20000)
      .split(/[\s,，;；]+/g)
      .map(normalizeCalendarDate)
      .filter(Boolean),
  )].slice(0, 400).join('\n');
  const hasKeywordMaxDetectedItems =
    has(request, 'keywordMaxDetectedItems') ||
    has(plan, 'keywordMaxDetectedItems');
  const keywordMaxDetectedItems = boundedInteger(
    read('keywordMaxDetectedItems'),
    50,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const enabled = has(request, 'enabled') || has(plan, 'enabled')
    ? Boolean(read('enabled'))
    : true;
  const rawCaptureSettings = jsonObject(read('captureSettings'));
  const hasCaptureSettings = Object.keys(rawCaptureSettings).length > 0;
  const enhancementEnabled = boolean(
    rawCaptureSettings.autoDetailCaptureAfterListCapture,
    false,
  );
  const includeComments = enhancementEnabled && boolean(
    rawCaptureSettings.includeCommentsOnDetailCapture,
    false,
  );
  const includeBloggerMetrics = enhancementEnabled && boolean(
    rawCaptureSettings.includeBloggerMetricsOnDetailCapture,
    false,
  );
  const captureSettings = {
    autoDetailCaptureAfterListCapture: enhancementEnabled,
    autoSyncAfterDetailCapture: enhancementEnabled && boolean(
      rawCaptureSettings.autoSyncAfterDetailCapture,
      false,
    ),
    enableAiRelevancePrefilter: enhancementEnabled && boolean(
      rawCaptureSettings.enableAiRelevancePrefilter,
      false,
    ),
    includeBloggerMetricsOnDetailCapture: includeBloggerMetrics,
    enableLowFollowerHitFilterOnDetailCapture:
      includeBloggerMetrics && boolean(
        rawCaptureSettings.enableLowFollowerHitFilterOnDetailCapture,
        false,
      ),
    lowFollowerHitThresholdOnDetailCapture: boundedInteger(
      rawCaptureSettings.lowFollowerHitThresholdOnDetailCapture,
      10000,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    includeCommentsOnDetailCapture: includeComments,
    detailCommentsMaxDetectedItems: boundedInteger(
      rawCaptureSettings.detailCommentsMaxDetectedItems,
      50,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    enableCommentLeadsFilterOnDetailCapture:
      includeComments && boolean(
        rawCaptureSettings.enableCommentLeadsFilterOnDetailCapture,
        false,
      ),
    skipAlreadyCapturedOnDetailCapture: enhancementEnabled && boolean(
      rawCaptureSettings.skipAlreadyCapturedOnDetailCapture,
      true,
    ),
  };
  const rawRecoveryPolicy = jsonObject(read('recoveryPolicy'));
  const recoveryPolicy = {
    allowIdleAgentHandoff: boolean(
      rawRecoveryPolicy.allowIdleAgentHandoff ??
      rawRecoveryPolicy.allow_idle_agent_handoff,
      true,
    ),
    // Platform safety challenges are never allowed to trigger an automatic
    // device switch. This value is intentionally fixed by the server contract.
    platformSafetyMode: 'manual_confirmed',
  };

  const planSnapshot = {
    enabled,
    platform,
    mode,
    startTime,
    randomOffsetMin,
    keywords,
    searchFilters,
    ...(hasKeywordMaxDetectedItems ? {keywordMaxDetectedItems} : {}),
    autoLoop: maxRounds > 1,
    roundGapMin,
    maxRounds,
    recoveryPolicy,
    holidayDates: '',
    customDates,
    ...(hasCaptureSettings ? {captureSettings} : {}),
    // A daily or holiday schedule commonly runs tomorrow or much later. Unlike
    // observation timestamps, a valid planned time must not be clamped to five
    // minutes in the future.
    nextRunAt: scheduledIsoTimestamp(read('nextRunAt')) || '',
    lastRunAt: isoTimestamp(read('lastRunAt')) || '',
    lastRunStatus: text(read('lastRunStatus'), 80),
    lastRunMessage: sanitizeCloudText(read('lastRunMessage'), 1000),
    lastRunProgress: sanitizeCloudStructuredObject(read('lastRunProgress')),
    updatedAt: isoTimestamp(read('updatedAt')) || '',
  };

  return {
    clientTaskId: text(request.clientTaskId || request.requestKey, 240),
    executionMode,
    title: text(
      request.title || (
        executionMode === 'unattended_plan'
          ? '无人值守关键词采集计划'
          : '一次性关键词采集'
      ),
      240,
    ),
    planSnapshot,
  };
}

export function normalizeCloudTaskStatus(value, fallback = 'pending') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  const aliases = {
    queued: 'pending',
    started: 'running',
    capturing: 'running',
    syncing: 'running',
    retrying: 'recovering',
    paused: 'needs_action',
    blocked: 'needs_action',
    partial: 'completed_with_failures',
    success: 'completed',
    succeeded: 'completed',
    done: 'completed',
    cancelled: 'canceled',
    stopped: 'canceled',
  };
  const resolved = aliases[normalized] || normalized;
  return CLOUD_TASK_STATUSES.has(resolved) ? resolved : fallback;
}

export function normalizeCloudTaskSnapshot(input = {}) {
  const task = jsonObject(input);
  const clientTaskId = text(task.id || task.clientTaskId, 240);
  if (!clientTaskId) return null;
  const rawPlatform = String(task.platform || 'unknown').trim().toLowerCase();
  const platform = PLATFORM_ALIASES[rawPlatform] || 'unknown';
  const sanitizedTargetResults = safeStructuredValue(
    Array.isArray(task.targetResults) ? task.targetResults : [],
  );
  const targetResults = Array.isArray(sanitizedTargetResults)
    ? sanitizedTargetResults
    : [];
  const checkpoint = sanitizeCloudStructuredObject(task.checkpoint);
  if (targetResults.length > 0) {
    checkpoint.targetResults = targetResults;
  }
  return {
    clientTaskId,
    // Only the currently recoverable local request receives a control id from
    // the extension. Falling back to the ledger id would make historical tasks
    // look resumable even though the device can no longer recover them.
    controlTaskId: text(task.controlTaskId || task.actionTaskId, 240),
    taskType: text(task.taskType || task.type || 'capture', 120),
    featureKey: text(task.featureKey, 120),
    title: text(task.title || task.name || '采集任务', 240),
    platform,
    source: text(task.source || 'extension', 80),
    triggerType: text(task.trigger || task.triggerType, 80),
    status: normalizeCloudTaskStatus(task.status),
    progress: sanitizeCloudStructuredObject(task.progress),
    checkpoint,
    targetResults,
    counts: sanitizeCloudStructuredObject(task.counts),
    metadata: sanitizeCloudStructuredObject(task.metadata),
    error: sanitizeCloudStructuredObject(task.error),
    message: text(safeStructuredValue(task.message), 2000),
    attemptId: text(task.attemptId, 240),
    attemptNumber: integer(task.attemptNumber),
    progressSeq: integer(task.progressSeq),
    heartbeatAt: isoTimestamp(task.heartbeatAt),
    businessProgressAt: isoTimestamp(task.businessProgressAt),
    startedAt: isoTimestamp(task.startedAt),
    finishedAt: isoTimestamp(task.finishedAt),
    createdAt: isoTimestamp(task.createdAt),
    updatedAt: isoTimestamp(task.updatedAt),
  };
}

export function isCloudTaskActive(status) {
  return ACTIVE_TASK_STATUSES.has(normalizeCloudTaskStatus(status, ''));
}

export function isCloudTaskTerminal(status) {
  return TERMINAL_TASK_STATUSES.has(normalizeCloudTaskStatus(status, ''));
}

export function captureAgentOnline(lastHeartbeatAt, now = Date.now(), staleMs = 2 * 60 * 1000) {
  const timestamp = Date.parse(String(lastHeartbeatAt || ''));
  return Number.isFinite(timestamp) && now - timestamp <= staleMs;
}

export async function lockCaptureAgentExecutionSlot(
  executor,
  tenantId,
  agentId,
) {
  const scopedTenantId = text(tenantId, 100);
  const scopedAgentId = text(agentId, 100);
  if (!scopedTenantId || !scopedAgentId) {
    throw new Error('capture_agent_execution_slot_identity_required');
  }
  await executor.execute(
    'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
    ['capture_agent_execution_slot', `${scopedTenantId}:${scopedAgentId}`],
  );
}

export async function issueCaptureAgentCredential({
  tenantId,
  authCodeId,
  authBindingId = null,
  clientUuid,
  clientLabel = '',
  appVersion = '',
  userAgent = '',
}) {
  const stableClientUuid = text(clientUuid, 240);
  if (!tenantId || !authCodeId || !authBindingId || !stableClientUuid) return null;

  const token = makeCaptureAgentToken();
  const tokenHash = hashCaptureAgentToken(token);
  const environment = parseCaptureAgentEnvironment(clientLabel, userAgent);
  const defaultDisplayName = `${environment.browserName} · ${environment.operatingSystem}`;
  // Browser extensions cannot reliably read a privacy-safe physical machine id.
  // Keep unknown machines separate by default; admins can assign two browser
  // profiles to the same host label from the cloud task center.
  const defaultHostLabel = `${environment.operatingSystem} · ${stableClientUuid.slice(0, 8)}`;
  return await withTransaction(async tx => {
    const agent = await tx.queryOne(`
      INSERT INTO capture_agents (
        tenant_id, auth_code_id, auth_binding_id, client_uuid, client_label,
        display_name, host_label, browser_name, operating_system,
        app_version, status, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9,
        $10, 'active', now()
      )
      ON CONFLICT (tenant_id, client_uuid)
      DO UPDATE SET
        auth_code_id = EXCLUDED.auth_code_id,
        auth_binding_id = EXCLUDED.auth_binding_id,
        client_label = EXCLUDED.client_label,
        browser_name = EXCLUDED.browser_name,
        operating_system = EXCLUDED.operating_system,
        app_version = EXCLUDED.app_version,
        status = capture_agents.status,
        updated_at = now()
      RETURNING id, client_uuid, client_label, display_name, host_label,
        browser_name, operating_system, app_version, allowed_platforms, status
    `, [
      tenantId,
      authCodeId,
      authBindingId,
      stableClientUuid,
      text(clientLabel, 240),
      defaultDisplayName,
      defaultHostLabel,
      environment.browserName,
      environment.operatingSystem,
      text(appVersion, 80),
    ]);
    if (!agent || agent.status !== 'active') {
      return agent ? { ...agent, token: '' } : null;
    }

    // A token remains valid only for the entitlement under which it was issued.
    // Switching the same browser profile to another activation code/binding must
    // never make an older token valid again through the agent's new entitlement.
    await tx.execute(`
      UPDATE capture_agent_tokens
      SET revoked_at = now()
      WHERE agent_id = $1 AND revoked_at IS NULL
        AND (auth_code_id <> $2 OR auth_binding_id <> $3)
    `, [agent.id, authCodeId, authBindingId]);
    await tx.execute(`
      INSERT INTO capture_agent_tokens (
        agent_id, auth_code_id, auth_binding_id, token_hash
      ) VALUES ($1, $2, $3, $4)
    `, [agent.id, authCodeId, authBindingId, tokenHash]);
    await tx.execute(`
      DELETE FROM capture_agent_tokens
      WHERE agent_id = $1
        AND id NOT IN (
          SELECT id FROM capture_agent_tokens
          WHERE agent_id = $1 AND revoked_at IS NULL
          ORDER BY created_at DESC, id DESC
          LIMIT 3
        )
    `, [agent.id]);

    return { ...agent, token };
  });
}
