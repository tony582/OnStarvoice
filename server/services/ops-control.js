import { createHash } from 'node:crypto';
import {
  execute as dbExecute,
  getAllSettings,
  queryAll as dbQueryAll,
  queryOne as dbQueryOne,
  withTransaction as dbWithTransaction,
} from '../db/init.js';
import {
  EmailConfigurationError,
  sendTenantEmail,
} from './email-notifier.js';
import {runOpsControlGuardedActions} from './ops-control-actions.js';

export const OPS_CONTROL_POLICY_VERSION = 'ops-guarded-v1';
export const OPS_CONTROL_RUNTIME_BASELINE_VERSION = '0.3.91';
export const OPS_CONTROL_MODE = 'observe';
export const OPS_CONTROL_MODES = Object.freeze(['observe', 'guarded']);
export const OPS_CONTROL_ACTION_TYPES = Object.freeze([
  'capture_retry',
  'schedule_materialize',
  'command_reconcile',
  'elastic_requeue',
]);

export const OPS_CONTROL_SETTING_KEYS = Object.freeze({
  enabled: 'ops_control_enabled',
  mode: 'ops_control_mode',
  windowStart: 'ops_control_window_start',
  windowEnd: 'ops_control_window_end',
  digestTime: 'ops_control_digest_time',
  snapshotGapSeconds: 'ops_control_snapshot_gap_seconds',
  staleAfterSeconds: 'ops_control_stale_after_seconds',
  aiStaleAfterSeconds: 'ops_control_ai_stale_after_seconds',
  digestEmailEnabled: 'ops_control_digest_email_enabled',
  digestEmailTo: 'ops_control_digest_email_to',
  actionAllowlist: 'ops_control_action_allowlist',
  actionMaxPerRun: 'ops_control_action_max_per_run',
  actionMaxAttempts: 'ops_control_action_max_attempts',
  actionCooldownSeconds: 'ops_control_action_cooldown_seconds',
  actionVerificationSeconds: 'ops_control_action_verification_seconds',
});

const OPS_CONTROL_KEYS = new Set(Object.values(OPS_CONTROL_SETTING_KEYS));
const ACTIVE_TASK_STATUSES = new Set([
  'pending',
  'waiting_device',
  'claimed',
  'running',
  'recovering',
  'resume_requested',
  'stop_requested',
]);
const ACTIVE_ITEM_STATUSES = new Set([
  'pending',
  'assigned',
  'dispatch_pending',
  'dispatched',
  'waiting_device',
  'claimed',
  'running',
  'recovering',
  'retryable',
]);
const RECOVERY_TASK_STATUSES = new Set(['recovering', 'resume_requested']);
const BOOLEAN_TRUE = new Set(['1', 'true', 'on', 'yes']);
const BOOLEAN_FALSE = new Set(['0', 'false', 'off', 'no']);
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/u;
const SHANGHAI_OFFSET = '+08:00';
const MAX_TENANTS_PER_CYCLE = 50;
export const OPS_CONTROL_TASK_WAKE_GRACE_SECONDS = 30 * 60;
const OPS_CONTROL_TASK_WINDOW_END_PADDING_MS = 60 * 1000;

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

function integer(value, fallback = 0) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function text(value, limit = 1000) {
  const normalized = String(value ?? '').trim();
  return normalized.length > limit ? normalized.slice(0, limit) : normalized;
}

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function timestamp(value) {
  const normalized = iso(value);
  return normalized ? new Date(normalized).getTime() : 0;
}

function parseBoolean(value, fallback = false) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (BOOLEAN_TRUE.has(normalized)) return true;
  if (BOOLEAN_FALSE.has(normalized)) return false;
  return fallback;
}

function timeOr(value, fallback) {
  const normalized = text(value, 5);
  return TIME_PATTERN.test(normalized) ? normalized : fallback;
}

function timeMinutes(value) {
  const [hours, minutes] = String(value).split(':').map(Number);
  return hours * 60 + minutes;
}

function hashJson(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

function shanghaiDate(now) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function dateAtShanghaiTime(serviceDate, hhmm) {
  return new Date(`${serviceDate}T${hhmm}:00${SHANGHAI_OFFSET}`);
}

function normalizedSettingsSource(settings) {
  return object(settings);
}

export function resolveOpsControlGlobalEnabled(env = process.env) {
  return !BOOLEAN_FALSE.has(
    String(env?.OPS_CONTROL_GLOBAL_ENABLED ?? 'true').trim().toLowerCase(),
  );
}

export function resolveOpsControlActionsGlobalEnabled(env = process.env) {
  return BOOLEAN_TRUE.has(
    String(env?.OPS_CONTROL_ACTIONS_GLOBAL_ENABLED ?? 'false').trim().toLowerCase(),
  );
}

export function normalizeOpsControlActionAllowlist(value) {
  const source = Array.isArray(value) ? value : String(value ?? '').split(',');
  return Array.from(new Set(source
    .map(item => text(item, 80).toLowerCase())
    .filter(item => OPS_CONTROL_ACTION_TYPES.includes(item))));
}

export function normalizeOpsControlSettings(settings = {}, {
  env = process.env,
} = {}) {
  const source = normalizedSettingsSource(settings);
  const globalEnabled = resolveOpsControlGlobalEnabled(env);
  const actionsGlobalEnabled = resolveOpsControlActionsGlobalEnabled(env);
  const tenantEnabled = parseBoolean(source[OPS_CONTROL_SETTING_KEYS.enabled], false);
  const mode = OPS_CONTROL_MODES.includes(source[OPS_CONTROL_SETTING_KEYS.mode])
    ? source[OPS_CONTROL_SETTING_KEYS.mode]
    : OPS_CONTROL_MODE;
  const actionAllowlist = normalizeOpsControlActionAllowlist(
    source[OPS_CONTROL_SETTING_KEYS.actionAllowlist],
  );
  const windowStart = timeOr(source[OPS_CONTROL_SETTING_KEYS.windowStart], '05:30');
  let windowEnd = timeOr(source[OPS_CONTROL_SETTING_KEYS.windowEnd], '08:30');
  if (timeMinutes(windowEnd) <= timeMinutes(windowStart)) windowEnd = '08:30';
  const enabled = globalEnabled && tenantEnabled;
  const actionsEnabled = enabled
    && actionsGlobalEnabled
    && mode === 'guarded'
    && actionAllowlist.length > 0;
  return Object.freeze({
    globalEnabled,
    actionsGlobalEnabled,
    tenantEnabled,
    enabled,
    actionsEnabled,
    mode,
    observeOnly: !actionsEnabled,
    llmEnabled: false,
    runtimeBaselineVersion: OPS_CONTROL_RUNTIME_BASELINE_VERSION,
    windowStart,
    windowEnd,
    digestTime: timeOr(source[OPS_CONTROL_SETTING_KEYS.digestTime], '08:35'),
    snapshotGapSeconds: boundedInteger(
      source[OPS_CONTROL_SETTING_KEYS.snapshotGapSeconds],
      25,
      25,
      300,
    ),
    staleAfterSeconds: boundedInteger(
      source[OPS_CONTROL_SETTING_KEYS.staleAfterSeconds],
      300,
      120,
      3600,
    ),
    aiStaleAfterSeconds: boundedInteger(
      source[OPS_CONTROL_SETTING_KEYS.aiStaleAfterSeconds],
      1200,
      300,
      7200,
    ),
    digestEmailEnabled: parseBoolean(
      source[OPS_CONTROL_SETTING_KEYS.digestEmailEnabled],
      false,
    ),
    digestEmailTo: text(source[OPS_CONTROL_SETTING_KEYS.digestEmailTo], 2000),
    actionAllowlist,
    actionMaxPerRun: boundedInteger(
      source[OPS_CONTROL_SETTING_KEYS.actionMaxPerRun],
      3,
      1,
      10,
    ),
    actionMaxAttempts: boundedInteger(
      source[OPS_CONTROL_SETTING_KEYS.actionMaxAttempts],
      2,
      1,
      5,
    ),
    actionCooldownSeconds: boundedInteger(
      source[OPS_CONTROL_SETTING_KEYS.actionCooldownSeconds],
      300,
      60,
      3600,
    ),
    actionVerificationSeconds: boundedInteger(
      source[OPS_CONTROL_SETTING_KEYS.actionVerificationSeconds],
      900,
      120,
      3600,
    ),
  });
}

export class OpsControlSettingsError extends Error {
  constructor(message, code = 'invalid_ops_control_setting') {
    super(message);
    this.name = 'OpsControlSettingsError';
    this.code = code;
  }
}

export function normalizeOpsControlSettingPatch(patch = {}, current = {}) {
  const source = object(patch);
  const unknown = Object.keys(source).filter(
    key => key.startsWith('ops_control_') && !OPS_CONTROL_KEYS.has(key),
  );
  if (unknown.length > 0) {
    throw new OpsControlSettingsError('包含未知的无人值守控制面设置');
  }
  const normalized = {};
  for (const [key, value] of Object.entries(source)) {
    if (!OPS_CONTROL_KEYS.has(key)) continue;
    if ([
      OPS_CONTROL_SETTING_KEYS.enabled,
      OPS_CONTROL_SETTING_KEYS.digestEmailEnabled,
    ].includes(key)) {
      const candidate = String(value ?? '').trim().toLowerCase();
      if (!BOOLEAN_TRUE.has(candidate) && !BOOLEAN_FALSE.has(candidate)) {
        throw new OpsControlSettingsError('值守开关必须为开启或关闭');
      }
      normalized[key] = BOOLEAN_TRUE.has(candidate) ? 'true' : 'false';
      continue;
    }
    if (key === OPS_CONTROL_SETTING_KEYS.mode) {
      if (!OPS_CONTROL_MODES.includes(String(value))) {
        throw new OpsControlSettingsError('值守模式只允许 observe 或 guarded');
      }
      normalized[key] = String(value);
      continue;
    }
    if ([
      OPS_CONTROL_SETTING_KEYS.windowStart,
      OPS_CONTROL_SETTING_KEYS.windowEnd,
      OPS_CONTROL_SETTING_KEYS.digestTime,
    ].includes(key)) {
      if (!TIME_PATTERN.test(String(value ?? ''))) {
        throw new OpsControlSettingsError('值守时间必须使用 HH:mm 格式');
      }
      normalized[key] = String(value);
      continue;
    }
    if (key === OPS_CONTROL_SETTING_KEYS.digestEmailTo) {
      normalized[key] = text(value, 2000);
      continue;
    }
    if (key === OPS_CONTROL_SETTING_KEYS.actionAllowlist) {
      const raw = Array.isArray(value) ? value : String(value ?? '').split(',');
      const requested = raw.map(item => text(item, 80).toLowerCase()).filter(Boolean);
      const unknownActions = requested.filter(
        item => !OPS_CONTROL_ACTION_TYPES.includes(item),
      );
      if (unknownActions.length > 0) {
        throw new OpsControlSettingsError('动作白名单包含未知动作');
      }
      normalized[key] = normalizeOpsControlActionAllowlist(requested).join(',');
      continue;
    }
    const ranges = {
      [OPS_CONTROL_SETTING_KEYS.snapshotGapSeconds]: [25, 300],
      [OPS_CONTROL_SETTING_KEYS.staleAfterSeconds]: [120, 3600],
      [OPS_CONTROL_SETTING_KEYS.aiStaleAfterSeconds]: [300, 7200],
      [OPS_CONTROL_SETTING_KEYS.actionMaxPerRun]: [1, 10],
      [OPS_CONTROL_SETTING_KEYS.actionMaxAttempts]: [1, 5],
      [OPS_CONTROL_SETTING_KEYS.actionCooldownSeconds]: [60, 3600],
      [OPS_CONTROL_SETTING_KEYS.actionVerificationSeconds]: [120, 3600],
    };
    const [min, max] = ranges[key];
    const candidate = Number(value);
    if (!Number.isInteger(candidate) || candidate < min || candidate > max) {
      throw new OpsControlSettingsError(`${key} 必须为 ${min}-${max} 的整数`);
    }
    normalized[key] = String(candidate);
  }

  const merged = {...object(current), ...normalized};
  const start = timeOr(merged[OPS_CONTROL_SETTING_KEYS.windowStart], '05:30');
  const end = timeOr(merged[OPS_CONTROL_SETTING_KEYS.windowEnd], '08:30');
  if (timeMinutes(end) <= timeMinutes(start)) {
    throw new OpsControlSettingsError('值守结束时间必须晚于开始时间');
  }
  if (
    parseBoolean(merged[OPS_CONTROL_SETTING_KEYS.digestEmailEnabled], false)
    && !text(merged[OPS_CONTROL_SETTING_KEYS.digestEmailTo], 2000)
  ) {
    throw new OpsControlSettingsError('开启运维晨报邮件时必须填写收件人');
  }
  return normalized;
}

export function buildOpsControlWindow(now = new Date(), settings = {}) {
  const policy = settings.windowStart ? settings : normalizeOpsControlSettings(settings);
  const serviceDate = shanghaiDate(now);
  const start = dateAtShanghaiTime(serviceDate, policy.windowStart);
  const end = dateAtShanghaiTime(serviceDate, policy.windowEnd);
  const digestAt = dateAtShanghaiTime(serviceDate, policy.digestTime);
  return Object.freeze({
    serviceDate,
    start,
    end,
    digestAt,
    observationDeadline: new Date(end.getTime() + 30 * 60 * 1000),
  });
}

export function shouldObserveOpsControlWindow(now, window, { force = false } = {}) {
  if (force) return true;
  const nowMs = new Date(now).getTime();
  return nowMs >= window.start.getTime() && nowMs <= window.observationDeadline.getTime();
}

export function normalizeOpsControlTaskWakeState(value = {}) {
  const source = object(value);
  const activeTaskCount = integer(source.active_task_count ?? source.activeTaskCount);
  const recentTaskCount = integer(source.recent_task_count ?? source.recentTaskCount);
  const activeCommandCount = integer(source.active_command_count ?? source.activeCommandCount);
  const pendingActionCount = integer(source.pending_action_count ?? source.pendingActionCount);
  const shouldWake = activeTaskCount > 0
    || recentTaskCount > 0
    || activeCommandCount > 0
    || pendingActionCount > 0;
  const reason = activeTaskCount > 0
    ? 'active_task'
    : activeCommandCount > 0
      ? 'active_command'
      : pendingActionCount > 0
        ? 'pending_action_verification'
        : recentTaskCount > 0
          ? 'recent_task_settlement'
          : 'idle';
  return Object.freeze({
    shouldWake,
    reason,
    activeTaskCount,
    recentTaskCount,
    activeCommandCount,
    pendingActionCount,
  });
}

export async function getOpsControlTaskWakeState({
  tenantId,
  now = new Date(),
  queryOne = dbQueryOne,
} = {}) {
  const recentAfter = new Date(
    new Date(now).getTime() - OPS_CONTROL_TASK_WAKE_GRACE_SECONDS * 1000,
  );
  const row = await queryOne(`
    WITH business_tasks AS (
      SELECT
        task.status,
        GREATEST(
          COALESCE(task.business_progress_at, '-infinity'::timestamptz),
          COALESCE(task.heartbeat_at, '-infinity'::timestamptz),
          COALESCE(task.finished_at, '-infinity'::timestamptz),
          task.updated_at,
          task.created_at
        ) AS activity_at
      FROM capture_tasks task
      WHERE task.tenant_id = $1
        AND task.parent_task_id IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM capture_orchestration_schedules schedule
          WHERE schedule.tenant_id = task.tenant_id
            AND schedule.template_task_id = task.id
        )
    )
    SELECT
      COUNT(*) FILTER (
        WHERE business_tasks.status = ANY($2::text[])
      )::int AS active_task_count,
      COUNT(*) FILTER (
        WHERE business_tasks.activity_at >= $3::timestamptz
      )::int AS recent_task_count,
      (
        SELECT COUNT(*)::int
        FROM capture_agent_commands command
        WHERE command.tenant_id = $1
          AND command.status IN ('pending', 'acknowledged')
      ) AS active_command_count,
      (
        SELECT COUNT(*)::int
        FROM ops_control_actions action
        WHERE action.tenant_id = $1
          AND action.status IN ('claimed', 'pending_verification')
      ) AS pending_action_count
    FROM business_tasks
  `, [tenantId, [...ACTIVE_TASK_STATUSES], recentAfter.toISOString()]);
  return normalizeOpsControlTaskWakeState(row);
}

export function buildOpsControlTaskWindow(
  now = new Date(),
  configuredWindow,
) {
  const current = new Date(now);
  const window = configuredWindow;
  const recentStart = current.getTime() - OPS_CONTROL_TASK_WAKE_GRACE_SECONDS * 1000;
  const paddedEnd = current.getTime() + OPS_CONTROL_TASK_WINDOW_END_PADDING_MS;
  const start = new Date(Math.min(window.start.getTime(), recentStart));
  const end = new Date(Math.max(window.end.getTime(), paddedEnd));
  return Object.freeze({
    ...window,
    start,
    end,
    observationDeadline: new Date(
      end.getTime() + OPS_CONTROL_TASK_WAKE_GRACE_SECONDS * 1000,
    ),
  });
}

async function collectSchedules(db, tenantId, window, now) {
  return db.queryAll(`
    SELECT
      schedule.id,
      schedule.title,
      schedule.platform,
      schedule.status,
      schedule.start_time,
      schedule.next_run_at,
      schedule.last_scheduled_for,
      schedule.last_run_task_id,
      schedule.last_run_status,
      schedule.late_start_grace_min,
      CASE
        WHEN schedule.last_scheduled_for >= $2
          AND schedule.last_scheduled_for < $3
          THEN 'observed'
        WHEN schedule.next_run_at >= $2
          AND schedule.next_run_at < $3
          AND schedule.next_run_at <= $4
          THEN 'due_unmaterialized'
        ELSE 'upcoming'
      END AS occurrence_state
    FROM capture_orchestration_schedules schedule
    WHERE schedule.tenant_id = $1
      AND schedule.archived_at IS NULL
      AND schedule.status IN ('active', 'completed')
      AND (
        (schedule.last_scheduled_for >= $2 AND schedule.last_scheduled_for < $3)
        OR (schedule.next_run_at >= $2 AND schedule.next_run_at < $3)
      )
    ORDER BY COALESCE(schedule.last_scheduled_for, schedule.next_run_at), schedule.id
    LIMIT 200
  `, [tenantId, window.start.toISOString(), window.end.toISOString(), now.toISOString()]);
}

async function collectTasks(db, tenantId, window) {
  return db.queryAll(`
    WITH roots AS (
      SELECT task.*
      FROM capture_tasks task
      WHERE task.tenant_id = $1
        AND task.parent_task_id IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM capture_orchestration_schedules schedule
          WHERE schedule.tenant_id = task.tenant_id
            AND schedule.template_task_id = task.id
        )
        AND (
          (
            COALESCE(task.scheduled_for, task.created_at) >= $2
            AND COALESCE(task.scheduled_for, task.created_at) < $3
          )
          OR task.status = ANY($5::text[])
          OR (
            GREATEST(
              COALESCE(task.business_progress_at, '-infinity'::timestamptz),
              COALESCE(task.heartbeat_at, '-infinity'::timestamptz),
              COALESCE(task.finished_at, '-infinity'::timestamptz),
              task.updated_at,
              task.created_at
            ) >= $2
            AND GREATEST(
              COALESCE(task.business_progress_at, '-infinity'::timestamptz),
              COALESCE(task.heartbeat_at, '-infinity'::timestamptz),
              COALESCE(task.finished_at, '-infinity'::timestamptz),
              task.updated_at,
              task.created_at
            ) < $3
          )
        )
      ORDER BY COALESCE(task.scheduled_for, task.created_at), task.id
      LIMIT 500
    )
    SELECT
      root.id,
      root.title,
      root.platform,
      root.task_type,
      root.trigger_type,
      root.status,
      COALESCE(root.metadata->>'distributionMode', '') AS distribution_mode,
      root.progress_seq,
      root.business_progress_at,
      root.heartbeat_at,
      root.scheduled_for,
      root.started_at,
      root.finished_at,
      root.created_at,
      root.updated_at,
      root.orchestration_schedule_id,
      COALESCE(item_stats.item_total, 0)::int AS item_total,
      COALESCE(item_stats.active_item_count, 0)::int AS active_item_count,
      COALESCE(item_stats.completed_item_count, 0)::int AS completed_item_count,
      COALESCE(item_stats.warning_item_count, 0)::int AS warning_item_count,
      COALESCE(item_stats.failed_item_count, 0)::int AS failed_item_count,
      COALESCE(item_stats.needs_action_item_count, 0)::int AS needs_action_item_count,
      COALESCE(item_stats.skipped_item_count, 0)::int AS skipped_item_count,
      COALESCE(item_stats.recovered_item_count, 0)::int AS recovered_item_count,
      COALESCE(attempt_stats.historical_failure_count, 0)::int AS historical_failure_count,
      COALESCE(child_stats.active_child_count, 0)::int AS active_child_count
    FROM roots root
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) AS item_total,
        COUNT(*) FILTER (WHERE item.status = ANY($4::text[])) AS active_item_count,
        COUNT(*) FILTER (WHERE item.status = 'completed') AS completed_item_count,
        COUNT(*) FILTER (WHERE item.status = 'completed_with_warnings') AS warning_item_count,
        COUNT(*) FILTER (WHERE item.status = 'failed') AS failed_item_count,
        COUNT(*) FILTER (WHERE item.status = 'needs_action') AS needs_action_item_count,
        COUNT(*) FILTER (WHERE item.status IN ('skipped', 'canceled')) AS skipped_item_count,
        COUNT(*) FILTER (
          WHERE item.status IN ('completed', 'completed_with_warnings')
            AND EXISTS (
              SELECT 1
              FROM capture_task_item_attempts recovered_attempt
              WHERE recovered_attempt.item_id = item.id
                AND recovered_attempt.status IN (
                  'failed', 'interrupted', 'retryable', 'needs_action'
                )
            )
        ) AS recovered_item_count
      FROM capture_task_items item
      WHERE item.tenant_id = root.tenant_id
        AND item.task_id = root.id
    ) item_stats ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*) FILTER (
        WHERE attempt.status IN ('failed', 'interrupted', 'retryable', 'needs_action')
      ) AS historical_failure_count
      FROM capture_task_item_attempts attempt
      WHERE attempt.tenant_id = root.tenant_id
        AND attempt.parent_task_id = root.id
    ) attempt_stats ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*) FILTER (WHERE child.status = ANY($5::text[])) AS active_child_count
      FROM capture_tasks child
      WHERE child.tenant_id = root.tenant_id
        AND child.parent_task_id = root.id
    ) child_stats ON true
    ORDER BY COALESCE(root.scheduled_for, root.created_at), root.id
  `, [
    tenantId,
    window.start.toISOString(),
    window.end.toISOString(),
    [...ACTIVE_ITEM_STATUSES],
    [...ACTIVE_TASK_STATUSES],
  ]);
}

async function collectAgents(db, tenantId) {
  return db.queryAll(`
    SELECT
      id,
      display_name,
      client_label,
      browser_name,
      app_version,
      status,
      allowed_platforms,
      last_heartbeat_at,
      updated_at,
      (last_error <> '') AS has_error
    FROM capture_agents
    WHERE tenant_id = $1
      AND status IN ('active', 'paused')
    ORDER BY last_heartbeat_at DESC NULLS LAST, id
    LIMIT 200
  `, [tenantId]);
}

async function collectOperations(db, tenantId, window) {
  return db.queryOne(`
    SELECT
      (
        SELECT COUNT(*)
        FROM capture_agent_commands command
        JOIN capture_tasks task
          ON task.id = command.task_id AND task.tenant_id = command.tenant_id
        LEFT JOIN capture_tasks root
          ON root.id = task.parent_task_id AND root.tenant_id = task.tenant_id
        WHERE command.tenant_id = $1
          AND command.status IN ('pending', 'acknowledged')
          AND COALESCE(root.scheduled_for, task.scheduled_for, root.created_at, task.created_at) >= $2
          AND COALESCE(root.scheduled_for, task.scheduled_for, root.created_at, task.created_at) < $3
      )::int AS active_command_count,
      (
        SELECT MIN(command.created_at)
        FROM capture_agent_commands command
        JOIN capture_tasks task
          ON task.id = command.task_id AND task.tenant_id = command.tenant_id
        LEFT JOIN capture_tasks root
          ON root.id = task.parent_task_id AND root.tenant_id = task.tenant_id
        WHERE command.tenant_id = $1
          AND command.status IN ('pending', 'acknowledged')
          AND COALESCE(root.scheduled_for, task.scheduled_for, root.created_at, task.created_at) >= $2
          AND COALESCE(root.scheduled_for, task.scheduled_for, root.created_at, task.created_at) < $3
      ) AS oldest_active_command_at,
      (
        SELECT command.task_id
        FROM capture_agent_commands command
        JOIN capture_tasks task
          ON task.id = command.task_id AND task.tenant_id = command.tenant_id
        LEFT JOIN capture_tasks root
          ON root.id = task.parent_task_id AND root.tenant_id = task.tenant_id
        WHERE command.tenant_id = $1
          AND command.status IN ('pending', 'acknowledged')
          AND COALESCE(root.scheduled_for, task.scheduled_for, root.created_at, task.created_at) >= $2
          AND COALESCE(root.scheduled_for, task.scheduled_for, root.created_at, task.created_at) < $3
        ORDER BY command.created_at, command.id
        LIMIT 1
      ) AS oldest_active_command_task_id,
      (
        SELECT COUNT(*)
        FROM capture_task_events event
        JOIN capture_tasks task
          ON task.id = event.task_id AND task.tenant_id = event.tenant_id
        LEFT JOIN capture_tasks root
          ON root.id = task.parent_task_id AND root.tenant_id = task.tenant_id
        WHERE event.tenant_id = $1
          AND event.created_at >= $2 AND event.created_at < $3
          AND COALESCE(root.scheduled_for, task.scheduled_for, root.created_at, task.created_at) >= $2
          AND COALESCE(root.scheduled_for, task.scheduled_for, root.created_at, task.created_at) < $3
      )::int AS task_event_count,
      (
        SELECT MAX(event.created_at)
        FROM capture_task_events event
        WHERE event.tenant_id = $1
          AND event.created_at >= $2 AND event.created_at < $3
      ) AS latest_task_event_at
  `, [tenantId, window.start.toISOString(), window.end.toISOString()]);
}

async function collectPersistence(db, tenantId, window) {
  return db.queryOne(`
    SELECT
      (SELECT COUNT(*) FROM record_observations observation
        WHERE observation.tenant_id = $1
          AND observation.captured_at >= $2 AND observation.captured_at < $3
      )::int AS observation_count,
      (SELECT MAX(observation.captured_at) FROM record_observations observation
        WHERE observation.tenant_id = $1
          AND observation.captured_at >= $2 AND observation.captured_at < $3
      ) AS latest_observation_at,
      (SELECT COUNT(*) FROM records record
        WHERE record.tenant_id = $1
          AND record.created_at >= $2 AND record.created_at < $3
      )::int AS created_record_count,
      (SELECT COUNT(*) FROM records record
        WHERE record.tenant_id = $1
          AND record.record_type NOT IN ('official_content', 'blogger_profile')
          AND (record.ai_labeled_at IS NULL OR record.ai_result->>'relevance' IS NULL)
      )::int AS pending_record_ai_count,
      (SELECT MIN(record.created_at) FROM records record
        WHERE record.tenant_id = $1
          AND record.record_type NOT IN ('official_content', 'blogger_profile')
          AND (record.ai_labeled_at IS NULL OR record.ai_result->>'relevance' IS NULL)
      ) AS oldest_pending_record_ai_at,
      (SELECT COUNT(*) FROM records record
        WHERE record.tenant_id = $1
          AND record.ai_labeled_at >= $2 AND record.ai_labeled_at < $3
      )::int AS completed_record_ai_count,
      (SELECT MAX(record.ai_labeled_at) FROM records record
        WHERE record.tenant_id = $1
      ) AS latest_record_ai_at,
      (SELECT COUNT(*) FROM record_comments comment
        WHERE comment.tenant_id = $1
          AND comment.is_official = false
          AND comment.ai_classified_at IS NULL
      )::int AS pending_comment_ai_count,
      (SELECT MIN(comment.created_at) FROM record_comments comment
        WHERE comment.tenant_id = $1
          AND comment.is_official = false
          AND comment.ai_classified_at IS NULL
      ) AS oldest_pending_comment_ai_at,
      (SELECT COUNT(*) FROM record_comments comment
        WHERE comment.tenant_id = $1
          AND comment.ai_classified_at >= $2 AND comment.ai_classified_at < $3
      )::int AS completed_comment_ai_count,
      (SELECT MAX(comment.ai_classified_at) FROM record_comments comment
        WHERE comment.tenant_id = $1
      ) AS latest_comment_ai_at
  `, [tenantId, window.start.toISOString(), window.end.toISOString()]);
}

async function collectAi(db, tenantId, window) {
  const [prefilter, failover] = await Promise.all([
    db.queryOne(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'running')::int AS running_count,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count,
        COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_count,
        MAX(updated_at) FILTER (WHERE status = 'completed') AS latest_completed_at,
        MAX(updated_at) FILTER (WHERE status = 'failed') AS latest_failed_at
      FROM relevance_prefilter_requests
      WHERE tenant_id = $1
        AND created_at >= $2 AND created_at < $3
    `, [tenantId, window.start.toISOString(), window.end.toISOString()]),
    db.queryOne(`
      SELECT
        route,
        primary_model,
        backup_model,
        consecutive_failures,
        last_success_at,
        last_failure_at,
        last_failure_code,
        next_primary_probe_at,
        updated_at
      FROM ai_failover_states
      WHERE tenant_id = $1
    `, [tenantId]),
  ]);
  return {prefilter: prefilter || {}, failover: failover || {}};
}

export async function collectOpsControlEvidence({
  tenantId,
  window,
  now = new Date(),
  db,
}) {
  const database = db || {
    queryAll: dbQueryAll,
    queryOne: dbQueryOne,
  };
  const schedules = await collectSchedules(database, tenantId, window, now);
  const tasks = await collectTasks(database, tenantId, window);
  const agents = await collectAgents(database, tenantId);
  const operations = await collectOperations(database, tenantId, window);
  const persistence = await collectPersistence(database, tenantId, window);
  const ai = await collectAi(database, tenantId, window);
  return {
    capturedAt: now.toISOString(),
    schedules,
    tasks,
    agents,
    operations: operations || {},
    persistence: persistence || {},
    ai,
  };
}

function normalizeSchedule(row) {
  return {
    id: text(row.id, 80),
    title: text(row.title, 240),
    platform: text(row.platform, 80),
    status: text(row.status, 80),
    occurrenceState: text(row.occurrence_state, 80),
    nextRunAt: iso(row.next_run_at),
    lastScheduledFor: iso(row.last_scheduled_for),
    lastRunTaskId: text(row.last_run_task_id, 80),
    lastRunStatus: text(row.last_run_status, 80),
    lateStartGraceMinutes: integer(row.late_start_grace_min, 360),
  };
}

function normalizeTask(row) {
  const status = text(row.status, 80);
  const itemTotal = integer(row.item_total);
  const activeItemCount = integer(row.active_item_count);
  const activeChildCount = integer(row.active_child_count);
  const active = ACTIVE_TASK_STATUSES.has(status) && (
    itemTotal === 0 && activeChildCount === 0
      ? true
      : activeItemCount > 0 || activeChildCount > 0
  );
  return {
    id: text(row.id, 80),
    title: text(row.title, 240),
    platform: text(row.platform, 80),
    taskType: text(row.task_type, 100),
    triggerType: text(row.trigger_type, 100),
    status,
    distributionMode: text(row.distribution_mode, 80),
    active,
    recovering: RECOVERY_TASK_STATUSES.has(status)
      || integer(row.active_item_count) > 0 && status === 'recovering',
    progressSeq: integer(row.progress_seq),
    businessProgressAt: iso(row.business_progress_at),
    heartbeatAt: iso(row.heartbeat_at),
    scheduledFor: iso(row.scheduled_for),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    scheduleId: text(row.orchestration_schedule_id, 80),
    itemTotal,
    activeItemCount,
    completedItemCount: integer(row.completed_item_count),
    warningItemCount: integer(row.warning_item_count),
    failedItemCount: integer(row.failed_item_count),
    needsActionItemCount: integer(row.needs_action_item_count),
    skippedItemCount: integer(row.skipped_item_count),
    recoveredItemCount: integer(row.recovered_item_count),
    historicalFailureCount: integer(row.historical_failure_count),
    activeChildCount,
  };
}

function normalizeAgent(row, capturedAt) {
  const heartbeatAt = iso(row.last_heartbeat_at);
  const heartbeatAgeSeconds = heartbeatAt
    ? Math.max(0, Math.floor((timestamp(capturedAt) - timestamp(heartbeatAt)) / 1000))
    : null;
  return {
    id: text(row.id, 80),
    name: text(row.display_name || row.client_label || row.browser_name, 240),
    browserName: text(row.browser_name, 100),
    appVersion: text(row.app_version, 80),
    status: text(row.status, 80),
    allowedPlatforms: Array.isArray(row.allowed_platforms)
      ? row.allowed_platforms.map(value => text(value, 80))
      : [],
    heartbeatAt,
    heartbeatAgeSeconds,
    online: row.status === 'active'
      && heartbeatAgeSeconds !== null
      && heartbeatAgeSeconds <= 180,
    baselineCurrent: text(row.app_version, 80) === OPS_CONTROL_RUNTIME_BASELINE_VERSION,
    hasError: row.has_error === true,
  };
}

export function normalizeOpsControlEvidence(evidence = {}) {
  const capturedAt = iso(evidence.capturedAt) || new Date().toISOString();
  const schedules = Array.isArray(evidence.schedules)
    ? evidence.schedules.map(normalizeSchedule)
    : [];
  const tasks = Array.isArray(evidence.tasks)
    ? evidence.tasks.map(normalizeTask)
    : [];
  const agents = Array.isArray(evidence.agents)
    ? evidence.agents.map(row => normalizeAgent(row, capturedAt))
    : [];
  const operations = object(evidence.operations);
  const persistence = object(evidence.persistence);
  const prefilter = object(object(evidence.ai).prefilter);
  const failover = object(object(evidence.ai).failover);
  return {
    capturedAt,
    schedules,
    tasks,
    agents,
    scheduleSummary: {
      expected: schedules.length,
      observed: schedules.filter(row => row.occurrenceState === 'observed').length,
      dueUnmaterialized: schedules.filter(row => row.occurrenceState === 'due_unmaterialized').length,
      upcoming: schedules.filter(row => row.occurrenceState === 'upcoming').length,
    },
    taskSummary: {
      total: tasks.length,
      active: tasks.filter(row => row.active).length,
      recovering: tasks.filter(row => row.recovering).length,
      finalFailedItems: tasks.reduce((sum, row) => sum + row.failedItemCount, 0),
      finalNeedsActionItems: tasks.reduce((sum, row) => sum + row.needsActionItemCount, 0),
      finalSkippedItems: tasks.reduce((sum, row) => sum + row.skippedItemCount, 0),
      recoveredItems: tasks.reduce((sum, row) => sum + row.recoveredItemCount, 0),
      historicalFailures: tasks.reduce((sum, row) => sum + row.historicalFailureCount, 0),
      progressSeqTotal: tasks.reduce((sum, row) => sum + row.progressSeq, 0),
      completedItems: tasks.reduce(
        (sum, row) => sum + row.completedItemCount + row.warningItemCount,
        0,
      ),
    },
    agentSummary: {
      registered: agents.filter(row => row.status === 'active').length,
      online: agents.filter(row => row.online).length,
      baselineCurrent: agents.filter(row => row.status === 'active' && row.baselineCurrent).length,
      outdated: agents.filter(row => row.status === 'active' && !row.baselineCurrent).length,
    },
    operations: {
      activeCommandCount: integer(operations.active_command_count),
      oldestActiveCommandAt: iso(operations.oldest_active_command_at),
      oldestActiveCommandTaskId: text(operations.oldest_active_command_task_id, 100),
      taskEventCount: integer(operations.task_event_count),
      latestTaskEventAt: iso(operations.latest_task_event_at),
    },
    persistence: {
      observationCount: integer(persistence.observation_count),
      latestObservationAt: iso(persistence.latest_observation_at),
      createdRecordCount: integer(persistence.created_record_count),
      pendingRecordAiCount: integer(persistence.pending_record_ai_count),
      oldestPendingRecordAiAt: iso(persistence.oldest_pending_record_ai_at),
      completedRecordAiCount: integer(persistence.completed_record_ai_count),
      latestRecordAiAt: iso(persistence.latest_record_ai_at),
      pendingCommentAiCount: integer(persistence.pending_comment_ai_count),
      oldestPendingCommentAiAt: iso(persistence.oldest_pending_comment_ai_at),
      completedCommentAiCount: integer(persistence.completed_comment_ai_count),
      latestCommentAiAt: iso(persistence.latest_comment_ai_at),
    },
    ai: {
      prefilterRunning: integer(prefilter.running_count),
      prefilterFailed: integer(prefilter.failed_count),
      prefilterCompleted: integer(prefilter.completed_count),
      latestPrefilterCompletedAt: iso(prefilter.latest_completed_at),
      latestPrefilterFailedAt: iso(prefilter.latest_failed_at),
      failoverRoute: text(failover.route || 'primary', 80),
      consecutiveFailures: integer(failover.consecutive_failures),
      lastSuccessAt: iso(failover.last_success_at),
      lastFailureAt: iso(failover.last_failure_at),
      lastFailureCode: text(failover.last_failure_code, 200),
      nextPrimaryProbeAt: iso(failover.next_primary_probe_at),
    },
  };
}

function incident(type, targetId, severity, title, message, evidence = {}) {
  const fingerprint = hashJson([type, String(targetId || 'tenant')]);
  return {fingerprint, type, targetId: String(targetId || ''), severity, title, message, evidence};
}

function taskAdvanced(previous, current) {
  if (!previous) return false;
  return current.progressSeq > previous.progressSeq
    || timestamp(current.businessProgressAt) > timestamp(previous.businessProgressAt)
    || current.completedItemCount + current.warningItemCount
      > previous.completedItemCount + previous.warningItemCount
    || current.activeItemCount < previous.activeItemCount;
}

function ageSeconds(now, value) {
  const at = timestamp(value);
  return at ? Math.max(0, Math.floor((timestamp(now) - at) / 1000)) : null;
}

function aiBacklogStalled(previous, current, policy) {
  if (!previous) return false;
  const recordPending = current.persistence.pendingRecordAiCount;
  const commentPending = current.persistence.pendingCommentAiCount;
  if (recordPending + commentPending === 0) return false;
  const progressed = current.persistence.completedRecordAiCount
      > previous.persistence.completedRecordAiCount
    || current.persistence.completedCommentAiCount
      > previous.persistence.completedCommentAiCount
    || recordPending < previous.persistence.pendingRecordAiCount
    || commentPending < previous.persistence.pendingCommentAiCount;
  if (progressed) return false;
  const oldest = Math.min(
    ...[
      timestamp(current.persistence.oldestPendingRecordAiAt),
      timestamp(current.persistence.oldestPendingCommentAiAt),
    ].filter(Boolean),
  );
  if (!Number.isFinite(oldest)) return false;
  return (timestamp(current.capturedAt) - oldest) / 1000 >= policy.aiStaleAfterSeconds;
}

function conclusionHeadline(verdict, summary) {
  if (verdict === 'incident') return `发现 ${summary.redIncidentCount} 个系统性异常，需要立即处理`;
  if (verdict === 'blocked_manual') return `有 ${summary.manualBlockerCount} 项登录或安全验证需要人工处理`;
  if (verdict === 'degraded') return `昨夜任务已结算，但有 ${summary.finalFailureCount} 个最终失败或跳过项`;
  if (verdict === 'pending') return '正在进行连续观察，尚未形成最终结论';
  if (summary.expectedScheduleCount === 0 && summary.taskCount === 0) return '值守窗口内没有预期采集任务';
  if (summary.recoveredItemCount > 0) return `运行正常，${summary.recoveredItemCount} 个历史失败项已自动恢复`;
  return '运行正常，无需人工处理';
}

export function assessOpsControlSnapshots(previousValue, currentValue, settings = {}) {
  const previous = previousValue ? object(previousValue) : null;
  const current = object(currentValue);
  const policy = settings.snapshotGapSeconds
    ? settings
    : normalizeOpsControlSettings(settings);
  const currentAt = timestamp(current.capturedAt);
  const previousAt = timestamp(previous?.capturedAt);
  const gapSeconds = previousAt ? Math.max(0, Math.floor((currentAt - previousAt) / 1000)) : 0;
  const consecutive = Boolean(previous && gapSeconds >= policy.snapshotGapSeconds);
  const previousTasks = new Map(
    (Array.isArray(previous?.tasks) ? previous.tasks : []).map(task => [task.id, task]),
  );
  const incidents = [];
  let progressingTaskCount = 0;
  let stalledTaskCount = 0;

  for (const task of Array.isArray(current.tasks) ? current.tasks : []) {
    if (!task.active) continue;
    const prior = previousTasks.get(task.id);
    if (taskAdvanced(prior, task)) {
      progressingTaskCount += 1;
      continue;
    }
    const progressAt = task.businessProgressAt || task.startedAt || task.createdAt;
    const stale = consecutive
      && prior
      && ageSeconds(current.capturedAt, progressAt) >= policy.staleAfterSeconds;
    if (!stale) continue;
    stalledTaskCount += 1;
    incidents.push(incident(
      'capture_task_stalled',
      task.id,
      'high',
      '采集任务停止业务推进',
      `${task.title || task.id} 连续两次观察没有业务进展`,
      {
        taskId: task.id,
        status: task.status,
        progressSeq: task.progressSeq,
        businessProgressAt: task.businessProgressAt,
      },
    ));
  }

  const expectedScheduleIds = Array.isArray(current.scheduleSummary?.expectedIds)
    ? new Set(current.scheduleSummary.expectedIds.map(String))
    : null;
  const dueMissing = consecutive
    ? (current.schedules || []).filter(schedule => {
        if (expectedScheduleIds && !expectedScheduleIds.has(String(schedule.id))) return false;
        if (schedule.occurrenceState !== 'due_unmaterialized') return false;
        const dueAge = ageSeconds(current.capturedAt, schedule.nextRunAt);
        return dueAge !== null && dueAge >= policy.staleAfterSeconds;
      })
    : [];
  for (const schedule of dueMissing) {
    incidents.push(incident(
      'schedule_occurrence_missing',
      schedule.id,
      'high',
      '无人值守计划未生成本轮任务',
      `${schedule.title || schedule.id} 到期后仍未产生可对账的 occurrence`,
      {scheduleId: schedule.id, nextRunAt: schedule.nextRunAt},
    ));
  }

  const frozenMissingScheduleIds = Array.isArray(current.scheduleSummary?.missingFrozenIds)
    ? current.scheduleSummary.missingFrozenIds
    : [];
  if (consecutive && frozenMissingScheduleIds.length > 0) {
    incidents.push(incident(
      'expected_schedule_missing',
      frozenMissingScheduleIds.join(','),
      'high',
      '值守窗口内的预期计划事实发生缺失',
      `${frozenMissingScheduleIds.length} 个已冻结的预期计划无法继续对账`,
      {scheduleIds: frozenMissingScheduleIds},
    ));
  }

  const activeTaskCount = integer(current.taskSummary?.active);
  if (consecutive && activeTaskCount > 0 && integer(current.agentSummary?.online) === 0) {
    incidents.push(incident(
      'agent_pool_unavailable',
      'tenant',
      'critical',
      '执行端 Agent 全部离线',
      '仍有采集任务未完成，但没有在线执行端 Agent',
      {activeTaskCount},
    ));
  }

  const commandAge = ageSeconds(
    current.capturedAt,
    current.operations?.oldestActiveCommandAt,
  );
  if (
    consecutive
    && integer(current.operations?.activeCommandCount) > 0
    && commandAge !== null
    && commandAge >= policy.staleAfterSeconds
  ) {
    incidents.push(incident(
      'capture_command_stale',
      current.operations?.oldestActiveCommandTaskId || 'tenant',
      'high',
      '采集命令长时间未完成',
      '命令队列存在超过业务停滞阈值的待处理命令',
      {
        activeCommandCount: current.operations.activeCommandCount,
        oldestActiveCommandAt: current.operations.oldestActiveCommandAt,
        taskId: current.operations?.oldestActiveCommandTaskId || '',
      },
    ));
  }

  if (consecutive && aiBacklogStalled(previous, current, policy)) {
    incidents.push(incident(
      'ai_backlog_stalled',
      'tenant',
      'high',
      'AI 后处理队列未继续推进',
      '待处理记录或评论已超时，连续观察没有新完成量',
      {
        pendingRecordAiCount: current.persistence.pendingRecordAiCount,
        pendingCommentAiCount: current.persistence.pendingCommentAiCount,
        failoverRoute: current.ai.failoverRoute,
      },
    ));
  }

  const finalNeedsActionItemCount = integer(current.taskSummary?.finalNeedsActionItems);
  const taskLevelManualBlockerCount = (current.tasks || []).filter(task =>
    task.status === 'needs_action' && integer(task.needsActionItemCount) === 0
  ).length;
  const manualBlockerCount = finalNeedsActionItemCount + taskLevelManualBlockerCount;
  if (manualBlockerCount > 0) {
    incidents.push(incident(
      'manual_intervention_required',
      'tenant',
      'warning',
      '任务需要人工登录或安全验证',
      `${manualBlockerCount} 项最终状态需要人工处理`,
      {manualBlockerCount},
    ));
  }

  const terminalFailureTaskFallbackCount = (current.tasks || []).filter(task =>
    ['failed', 'completed_with_failures', 'skipped'].includes(task.status)
      && integer(task.failedItemCount) + integer(task.skippedItemCount) === 0
  ).length;
  const finalFailureCount = integer(current.taskSummary?.finalFailedItems)
    + integer(current.taskSummary?.finalSkippedItems)
    + terminalFailureTaskFallbackCount;
  if (finalFailureCount > 0) {
    const failedTasks = (current.tasks || []).filter(task =>
      integer(task.failedItemCount)
        + integer(task.skippedItemCount)
        + (['failed', 'completed_with_failures', 'skipped'].includes(task.status)
          && integer(task.failedItemCount) + integer(task.skippedItemCount) === 0
          ? 1
          : 0) > 0
    );
    for (const task of failedTasks) {
      const taskFailureCount = integer(task.failedItemCount)
        + integer(task.skippedItemCount)
        + (['failed', 'completed_with_failures', 'skipped'].includes(task.status)
          && integer(task.failedItemCount) + integer(task.skippedItemCount) === 0
          ? 1
          : 0);
      incidents.push(incident(
        'final_task_failure',
        task.id,
        'warning',
        '采集任务存在最终失败或跳过项',
        `${task.title || task.id} 有 ${taskFailureCount} 个最终未成功项`,
        {taskId: task.id, taskStatus: task.status, finalFailureCount: taskFailureCount},
      ));
    }
  }

  const redIncidentCount = incidents.filter(row => ['high', 'critical'].includes(row.severity)).length;
  const upcomingCount = integer(current.scheduleSummary?.upcoming);
  let lifecycleStatus = 'observing';
  if (activeTaskCount > 0) {
    if (integer(current.taskSummary?.recovering) > 0) lifecycleStatus = 'recovering';
    else if (progressingTaskCount > 0) lifecycleStatus = 'progressing';
  } else if (consecutive && upcomingCount === 0) {
    lifecycleStatus = 'settled';
  }

  let verdict = 'pending';
  if (consecutive && upcomingCount === 0) {
    if (redIncidentCount > 0) verdict = 'incident';
    else if (manualBlockerCount > 0) verdict = 'blocked_manual';
    else if (finalFailureCount > 0) verdict = 'degraded';
    else verdict = 'healthy';
  }
  const summary = {
    consecutiveEvidence: consecutive,
    snapshotGapSeconds: gapSeconds,
    expectedScheduleCount: integer(current.scheduleSummary?.expected),
    observedScheduleCount: integer(current.scheduleSummary?.observed),
    taskCount: integer(current.taskSummary?.total),
    activeTaskCount,
    progressingTaskCount,
    stalledTaskCount,
    recoveredItemCount: integer(current.taskSummary?.recoveredItems),
    historicalFailureCount: integer(current.taskSummary?.historicalFailures),
    finalFailureCount,
    manualBlockerCount,
    observationCount: integer(current.persistence?.observationCount),
    pendingRecordAiCount: integer(current.persistence?.pendingRecordAiCount),
    pendingCommentAiCount: integer(current.persistence?.pendingCommentAiCount),
    onlineAgentCount: integer(current.agentSummary?.online),
    registeredAgentCount: integer(current.agentSummary?.registered),
    baselineCurrentAgentCount: integer(current.agentSummary?.baselineCurrent),
    redIncidentCount,
    llmUsed: false,
    businessActionsExecuted: 0,
  };
  summary.headline = conclusionHeadline(verdict, summary);
  return {
    lifecycleStatus,
    verdict,
    summary,
    incidents,
  };
}

export function buildOpsControlDigest(assessment, current, {serviceDate} = {}, policy = {}) {
  const verdictLabels = {
    pending: '观察中',
    healthy: '正常',
    degraded: '部分异常',
    blocked_manual: '需人工处理',
    incident: '系统异常',
  };
  const label = verdictLabels[assessment.verdict] || assessment.verdict;
  return {
    verdict: assessment.verdict,
    subject: `[StarVoice 星语] ${serviceDate || ''} 昨夜值守 · ${label}`,
    summary: assessment.summary.headline,
    payload: {
      serviceDate,
      lifecycleStatus: assessment.lifecycleStatus,
      verdict: assessment.verdict,
      summary: assessment.summary,
      incidents: assessment.incidents.map(row => ({
        type: row.type,
        severity: row.severity,
        title: row.title,
        message: row.message,
      })),
      latestEvidenceAt: current.capturedAt,
      runtimeBaselineVersion: OPS_CONTROL_RUNTIME_BASELINE_VERSION,
      mode: policy.mode || OPS_CONTROL_MODE,
      actionsEnabled: policy.actionsEnabled === true,
      llmUsed: false,
    },
  };
}

export function buildOpsControlDigestHtml(digest) {
  const payload = object(digest.payload);
  const summary = object(payload.summary);
  const actions = object(payload.actions);
  const guarded = payload.mode === 'guarded' && payload.actionsEnabled === true;
  const incidentRows = Array.isArray(payload.incidents) ? payload.incidents : [];
  const rows = incidentRows.length > 0
    ? incidentRows.map(row => `
        <li style="margin:8px 0"><strong>${escapeHtml(row.title)}</strong>：${escapeHtml(row.message)}</li>
      `).join('')
    : '<li style="margin:8px 0">没有需要人工处理的开放事项</li>';
  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:680px;margin:0 auto;color:#111827">
      <h2 style="margin:0 0 8px;font-size:20px">StarVoice 昨夜值守</h2>
      <p style="margin:0 0 20px;color:#4b5563">${escapeHtml(digest.summary)}</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr><td style="padding:8px 0;color:#6b7280;width:160px">计划覆盖</td><td>${integer(summary.observedScheduleCount)} / ${integer(summary.expectedScheduleCount)}</td></tr>
        <tr><td style="padding:8px 0;color:#6b7280">任务</td><td>${integer(summary.taskCount)} 个，仍在执行 ${integer(summary.activeTaskCount)} 个</td></tr>
        <tr><td style="padding:8px 0;color:#6b7280">自动恢复</td><td>${integer(summary.recoveredItemCount)} 个最终已恢复项</td></tr>
        <tr><td style="padding:8px 0;color:#6b7280">控制面动作</td><td>${integer(actions.verified)} 个已验收，${integer(actions.pendingVerification)} 个待验收，${integer(actions.failed)} 个失败</td></tr>
        <tr><td style="padding:8px 0;color:#6b7280">落库观察</td><td>${integer(summary.observationCount)} 条</td></tr>
        <tr><td style="padding:8px 0;color:#6b7280">执行端 Agent</td><td>${integer(summary.onlineAgentCount)} / ${integer(summary.registeredAgentCount)} 在线</td></tr>
      </table>
      <h3 style="font-size:15px;margin:22px 0 8px">事项</h3>
      <ul style="padding-left:20px;color:#374151">${rows}</ul>
      <p style="margin:24px 0 0;color:#9ca3af;font-size:12px">规则控制面${guarded ? '受控动作模式' : '观察模式'} · 0.3.91 自愈运行时基线 · 本轮未调用大模型${guarded ? ' · 所有动作均写入幂等账本并等待后续快照验收' : '，未执行采集业务写操作'}。</p>
    </div>
  `;
}

async function upsertIncidents(tx, run, assessment, now) {
  const activeFingerprints = [];
  for (const row of assessment.incidents) {
    activeFingerprints.push(row.fingerprint);
    await tx.execute(`
      INSERT INTO ops_control_incidents (
        run_id, tenant_id, fingerprint, incident_type, severity,
        status, title, message, evidence, first_seen_at, last_seen_at,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5,
        'open', $6, $7, $8::jsonb, $9, $9,
        $9, $9
      )
      ON CONFLICT (run_id, fingerprint)
      DO UPDATE SET
        severity = excluded.severity,
        status = 'open',
        title = excluded.title,
        message = excluded.message,
        evidence = excluded.evidence,
        last_seen_at = excluded.last_seen_at,
        resolved_at = NULL,
        alert_delivery_status = CASE
          WHEN ops_control_incidents.status = 'resolved' THEN 'ready'
          ELSE ops_control_incidents.alert_delivery_status
        END,
        alert_attempt_count = CASE
          WHEN ops_control_incidents.status = 'resolved' THEN 0
          ELSE ops_control_incidents.alert_attempt_count
        END,
        alert_next_attempt_at = CASE
          WHEN ops_control_incidents.status = 'resolved' THEN excluded.last_seen_at
          ELSE ops_control_incidents.alert_next_attempt_at
        END,
        alert_recipient = CASE
          WHEN ops_control_incidents.status = 'resolved' THEN ''
          ELSE ops_control_incidents.alert_recipient
        END,
        alert_message_id = CASE
          WHEN ops_control_incidents.status = 'resolved' THEN ''
          ELSE ops_control_incidents.alert_message_id
        END,
        alert_claimed_at = CASE
          WHEN ops_control_incidents.status = 'resolved' THEN NULL
          ELSE ops_control_incidents.alert_claimed_at
        END,
        alert_sent_at = CASE
          WHEN ops_control_incidents.status = 'resolved' THEN NULL
          ELSE ops_control_incidents.alert_sent_at
        END,
        alert_last_error = CASE
          WHEN ops_control_incidents.status = 'resolved' THEN ''
          ELSE ops_control_incidents.alert_last_error
        END,
        updated_at = excluded.updated_at
    `, [
      run.id,
      run.tenant_id,
      row.fingerprint,
      row.type,
      row.severity,
      row.title,
      row.message,
      JSON.stringify(row.evidence),
      now.toISOString(),
    ]);
  }
  if (assessment.verdict === 'pending') return;
  await tx.execute(`
    UPDATE ops_control_incidents
    SET status = 'resolved', resolved_at = $3, updated_at = $3
    WHERE run_id = $1
      AND tenant_id = $2
      AND status <> 'resolved'
      AND NOT (fingerprint = ANY($4::text[]))
  `, [run.id, run.tenant_id, now.toISOString(), activeFingerprints]);
}

async function persistObservation(tx, {
  tenantId,
  window,
  now,
  policy,
  evidence,
  normalized,
  assessment,
}) {
  let run = await tx.queryOne(`
    INSERT INTO ops_control_runs (
      tenant_id, service_date, window_start, window_end,
      mode, lifecycle_status, verdict, policy_version,
      runtime_baseline_version, created_at, updated_at
    ) VALUES (
      $1, $2::date, $3, $4,
      $7, 'observing', 'pending', $5,
      $6, $8, $8
    )
    ON CONFLICT (tenant_id, service_date)
    DO UPDATE SET window_start = excluded.window_start,
      window_end = excluded.window_end,
      mode = excluded.mode,
      policy_version = excluded.policy_version,
      updated_at = excluded.updated_at
    RETURNING *
  `, [
    tenantId,
    window.serviceDate,
    window.start.toISOString(),
    window.end.toISOString(),
    OPS_CONTROL_POLICY_VERSION,
    OPS_CONTROL_RUNTIME_BASELINE_VERSION,
    policy.mode,
    now.toISOString(),
  ]);
  run = await tx.queryOne(`
    SELECT * FROM ops_control_runs
    WHERE id = $1 AND tenant_id = $2
    FOR UPDATE
  `, [run.id, tenantId]);

  const expectedIds = integer(run.snapshot_count) > 0
    && Array.isArray(run.expected_schedule_ids)
    ? run.expected_schedule_ids
    : normalized.schedules.map(row => row.id).filter(Boolean);
  const expectedIdSet = new Set(expectedIds.map(String));
  const expectedSchedules = normalized.schedules.filter(row => expectedIdSet.has(row.id));
  const presentExpectedIds = new Set(expectedSchedules.map(row => row.id));
  normalized.scheduleSummary = {
    expectedIds: expectedIds.map(String),
    expected: expectedIds.length,
    observed: expectedSchedules.filter(row => row.occurrenceState === 'observed').length,
    dueUnmaterialized: expectedSchedules.filter(
      row => row.occurrenceState === 'due_unmaterialized',
    ).length,
    upcoming: expectedSchedules.filter(row => row.occurrenceState === 'upcoming').length,
    missingFrozenIds: expectedIds.filter(id => !presentExpectedIds.has(String(id))),
  };
  const previous = await tx.queryOne(`
    SELECT sequence, captured_at, normalized
    FROM ops_control_snapshots
    WHERE run_id = $1 AND tenant_id = $2
    ORDER BY sequence DESC
    LIMIT 1
  `, [run.id, tenantId]);
  const sequence = integer(previous?.sequence) + 1;
  const finalAssessment = assessment || assessOpsControlSnapshots(
    previous?.normalized,
    normalized,
    policy,
  );
  const snapshotHash = hashJson(normalized);
  await tx.execute(`
    INSERT INTO ops_control_snapshots (
      run_id, tenant_id, sequence, captured_at,
      snapshot_hash, evidence, normalized, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $4)
  `, [
    run.id,
    tenantId,
    sequence,
    now.toISOString(),
    snapshotHash,
    JSON.stringify(evidence),
    JSON.stringify(normalized),
  ]);

  const settledAt = finalAssessment.lifecycleStatus === 'settled'
    ? now.toISOString()
    : null;
  run = await tx.queryOne(`
    UPDATE ops_control_runs
    SET lifecycle_status = $3,
      verdict = $4,
      expected_schedule_ids = $5::uuid[],
      expected_occurrence_count = $6,
      observed_occurrence_count = $7,
      snapshot_count = $8,
      summary = $9::jsonb,
      last_snapshot_at = $10,
      settled_at = $11,
      updated_at = $10
    WHERE id = $1 AND tenant_id = $2
    RETURNING *
  `, [
    run.id,
    tenantId,
    finalAssessment.lifecycleStatus,
    finalAssessment.verdict,
    expectedIds,
    expectedIds.length,
    integer(normalized.scheduleSummary.observed),
    sequence,
    JSON.stringify(finalAssessment.summary),
    now.toISOString(),
    settledAt,
  ]);
  await upsertIncidents(tx, run, finalAssessment, now);

  const digest = buildOpsControlDigest(finalAssessment, normalized, window, policy);
  const persistedDigest = await tx.queryOne(`
    INSERT INTO ops_control_digests (
      run_id, tenant_id, service_date, verdict,
      subject, summary, payload, delivery_status,
      next_attempt_at, created_at, updated_at
    ) VALUES (
      $1, $2, $3::date, $4,
      $5, $6, $7::jsonb, 'ready',
      $8, $8, $8
    )
    ON CONFLICT (tenant_id, service_date)
    DO UPDATE SET
      run_id = excluded.run_id,
      verdict = excluded.verdict,
      subject = excluded.subject,
      summary = excluded.summary,
      payload = excluded.payload,
      delivery_status = CASE
        WHEN ops_control_digests.delivery_status = 'sent' THEN 'sent'
        WHEN ops_control_digests.delivery_status = 'sending' THEN 'sending'
        ELSE 'ready'
      END,
      updated_at = excluded.updated_at
    RETURNING *
  `, [
    run.id,
    tenantId,
    window.serviceDate,
    digest.verdict,
    digest.subject,
    digest.summary,
    JSON.stringify(digest.payload),
    now.toISOString(),
  ]);
  return {
    run,
    digest: persistedDigest,
    assessment: finalAssessment,
    sequence,
    snapshot: normalized,
  };
}

export function buildOpsControlIncidentAlertHtml(incidents, {
  mode = OPS_CONTROL_MODE,
} = {}) {
  const rows = (Array.isArray(incidents) ? incidents : []).map(row => `
    <li style="margin:10px 0">
      <strong>${escapeHtml(row.title)}</strong><br>
      <span style="color:#4b5563">${escapeHtml(row.message)}</span>
    </li>
  `).join('');
  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:680px;margin:0 auto;color:#111827">
      <h2 style="margin:0 0 8px;font-size:20px">StarVoice 值守需要关注</h2>
      <p style="margin:0 0 18px;color:#4b5563">以下事项当前没有正在等待验收的自动恢复动作，请及时查看。</p>
      <ul style="padding-left:20px">${rows}</ul>
      <p style="margin:22px 0 0;color:#9ca3af;font-size:12px">规则控制面${mode === 'guarded' ? '受控动作模式' : '观察模式'} · 0.3.91 自愈运行时基线 · 本轮未调用大模型。</p>
    </div>
  `;
}

export async function maybeDeliverOpsControlIncidentAlerts({
  tenantId,
  run,
  policy,
  assessment,
  now = new Date(),
  withTransaction = dbWithTransaction,
  execute = dbExecute,
  sendEmail = sendTenantEmail,
} = {}) {
  if (assessment?.summary?.consecutiveEvidence !== true) {
    return {status: 'awaiting_evidence', attempted: false, incidentCount: 0};
  }
  if (!policy.digestEmailEnabled || !policy.digestEmailTo) {
    return {status: 'disabled', attempted: false, incidentCount: 0};
  }
  const claimed = await withTransaction(async tx => {
    await tx.execute(`
      UPDATE ops_control_incidents
      SET alert_delivery_status = 'retry_wait',
        alert_next_attempt_at = $3,
        alert_last_error = 'alert_claim_timeout',
        updated_at = $3
      WHERE tenant_id = $1 AND run_id = $2
        AND alert_delivery_status = 'sending'
        AND alert_claimed_at < $3::timestamptz - interval '5 minutes'
    `, [tenantId, run.id, now.toISOString()]);
    const incidents = await tx.queryAll(`
      SELECT incident.*
      FROM ops_control_incidents incident
      WHERE incident.tenant_id = $1 AND incident.run_id = $2
        AND incident.status = 'open'
        AND (
          incident.severity IN ('high', 'critical')
          OR incident.incident_type IN (
            'manual_intervention_required', 'final_task_failure'
          )
        )
        AND incident.alert_delivery_status IN (
          'ready', 'retry_wait', 'blocked_config', 'failed'
        )
        AND incident.alert_next_attempt_at <= $3
        AND NOT EXISTS (
          SELECT 1
          FROM ops_control_actions action
          WHERE action.incident_id = incident.id
            AND action.tenant_id = incident.tenant_id
            AND action.status IN ('claimed', 'pending_verification', 'verified')
        )
      ORDER BY
        CASE incident.severity
          WHEN 'critical' THEN 1 WHEN 'high' THEN 2 ELSE 3
        END,
        incident.first_seen_at,
        incident.id
      FOR UPDATE OF incident SKIP LOCKED
      LIMIT 20
    `, [tenantId, run.id, now.toISOString()]);
    if (incidents.length === 0) return null;
    const ids = incidents.map(row => row.id);
    const messageId = `<ops-alert-${run.id}-${hashJson(ids).slice(0, 16)}@starvoice.local>`;
    await tx.execute(`
      UPDATE ops_control_incidents
      SET alert_delivery_status = 'sending',
        alert_attempt_count = alert_attempt_count + 1,
        alert_recipient = $3,
        alert_message_id = $4,
        alert_claimed_at = $5,
        alert_last_error = '',
        updated_at = $5
      WHERE tenant_id = $1 AND id = ANY($2::uuid[])
    `, [tenantId, ids, policy.digestEmailTo, messageId, now.toISOString()]);
    return {incidents, ids, messageId};
  });
  if (!claimed) return {status: 'idle', attempted: false, incidentCount: 0};

  const top = claimed.incidents[0];
  const subject = claimed.incidents.length === 1
    ? `[StarVoice 星语] 立即关注 · ${top.title}`
    : `[StarVoice 星语] 立即关注 · ${claimed.incidents.length} 个值守事项`;
  try {
    await sendEmail({
      tenantId,
      to: policy.digestEmailTo,
      subject,
      html: buildOpsControlIncidentAlertHtml(claimed.incidents, {
        mode: policy.mode,
      }),
      messageId: claimed.messageId,
    });
    await execute(`
      UPDATE ops_control_incidents
      SET alert_delivery_status = 'sent',
        alert_sent_at = $4,
        alert_last_error = '',
        updated_at = $4
      WHERE tenant_id = $1
        AND id = ANY($2::uuid[])
        AND alert_delivery_status = 'sending'
        AND alert_message_id = $3
    `, [tenantId, claimed.ids, claimed.messageId, now.toISOString()]);
    return {
      status: 'sent',
      attempted: true,
      incidentCount: claimed.incidents.length,
      messageId: claimed.messageId,
    };
  } catch (error) {
    const blocked = error instanceof EmailConfigurationError;
    const attempts = Math.max(
      ...claimed.incidents.map(row => integer(row.alert_attempt_count) + 1),
    );
    const status = blocked ? 'blocked_config' : attempts >= 3 ? 'failed' : 'retry_wait';
    const nextAttemptAt = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
    await execute(`
      UPDATE ops_control_incidents
      SET alert_delivery_status = $4,
        alert_next_attempt_at = $5,
        alert_last_error = $6,
        updated_at = $7
      WHERE tenant_id = $1
        AND id = ANY($2::uuid[])
        AND alert_delivery_status = 'sending'
        AND alert_message_id = $3
    `, [
      tenantId,
      claimed.ids,
      claimed.messageId,
      status,
      nextAttemptAt,
      text(error?.message || error, 2000),
      now.toISOString(),
    ]);
    return {
      status,
      attempted: true,
      incidentCount: claimed.incidents.length,
      error,
    };
  }
}

async function maybeDeliverDigest({
  tenantId,
  digest,
  policy,
  window,
  now,
  queryOne = dbQueryOne,
  execute = dbExecute,
  sendEmail = sendTenantEmail,
}) {
  if (
    !policy.digestEmailEnabled
    || !policy.digestEmailTo
    || digest.verdict === 'pending'
    || now.getTime() < window.digestAt.getTime()
    || digest.delivery_status === 'sent'
  ) {
    return {status: digest.delivery_status, attempted: false};
  }
  const claimed = await queryOne(`
    UPDATE ops_control_digests
    SET delivery_status = 'sending',
      attempt_count = attempt_count + 1,
      recipient = $3,
      updated_at = $4
    WHERE id = $1 AND tenant_id = $2
      AND delivery_status IN ('ready', 'retry_wait', 'blocked_config', 'failed')
      AND next_attempt_at <= $4
    RETURNING *
  `, [digest.id, tenantId, policy.digestEmailTo, now.toISOString()]);
  if (!claimed) return {status: digest.delivery_status, attempted: false};
  const messageId = `<ops-control-${window.serviceDate}-${tenantId}@starvoice.local>`;
  try {
    await sendEmail({
      tenantId,
      to: policy.digestEmailTo,
      subject: claimed.subject,
      html: buildOpsControlDigestHtml(claimed),
      messageId,
    });
    await execute(`
      UPDATE ops_control_digests
      SET delivery_status = 'sent', recipient = $3, message_id = $4,
        sent_at = $5, last_error = '', updated_at = $5
      WHERE id = $1 AND tenant_id = $2 AND delivery_status = 'sending'
    `, [claimed.id, tenantId, policy.digestEmailTo, messageId, now.toISOString()]);
    return {status: 'sent', attempted: true};
  } catch (error) {
    const blocked = error instanceof EmailConfigurationError;
    const attempts = integer(claimed.attempt_count);
    const status = blocked ? 'blocked_config' : attempts >= 3 ? 'failed' : 'retry_wait';
    const nextAttemptAt = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
    await execute(`
      UPDATE ops_control_digests
      SET delivery_status = $3, next_attempt_at = $4,
        last_error = $5, updated_at = $6
      WHERE id = $1 AND tenant_id = $2 AND delivery_status = 'sending'
    `, [
      claimed.id,
      tenantId,
      status,
      nextAttemptAt,
      text(error?.message || error, 2000),
      now.toISOString(),
    ]);
    return {status, attempted: true, error};
  }
}

export async function runOpsControlTenantObservation({
  tenantId,
  settings = {},
  now = new Date(),
  force = false,
  getTaskWakeState = getOpsControlTaskWakeState,
  withTransaction = dbWithTransaction,
  queryOne = dbQueryOne,
  execute = dbExecute,
  sendEmail = sendTenantEmail,
  actionHandlers,
} = {}) {
  const policy = settings.enabled === undefined
    ? normalizeOpsControlSettings(settings)
    : settings;
  const configuredWindow = buildOpsControlWindow(now, policy);
  if (!policy.enabled) {
    return {kind: 'disabled', tenantId, policy, window: configuredWindow};
  }
  const scheduledWindowActive = shouldObserveOpsControlWindow(now, configuredWindow);
  const taskWakeState = scheduledWindowActive
    ? normalizeOpsControlTaskWakeState()
    : await getTaskWakeState({tenantId, now, queryOne});
  if (!scheduledWindowActive && !force && !taskWakeState.shouldWake) {
    return {
      kind: 'outside_window',
      tenantId,
      policy,
      window: configuredWindow,
      activation: {kind: 'idle', ...taskWakeState},
    };
  }
  const taskDriven = !scheduledWindowActive && taskWakeState.shouldWake;
  const window = taskDriven
    ? buildOpsControlTaskWindow(now, configuredWindow)
    : configuredWindow;
  const activation = taskDriven
    ? {kind: 'task_activity', ...taskWakeState}
    : scheduledWindowActive
      ? {kind: 'scheduled_window', ...taskWakeState}
      : {kind: 'manual_force', ...taskWakeState};

  const result = await withTransaction(async tx => {
    const evidence = await collectOpsControlEvidence({tenantId, window, now, db: tx});
    const normalized = normalizeOpsControlEvidence(evidence);
    return persistObservation(tx, {
      tenantId,
      window,
      now,
      policy,
      evidence,
      normalized,
    });
  });
  const actions = await runOpsControlGuardedActions({
    tenantId,
    run: result.run,
    sequence: result.sequence,
    snapshot: result.snapshot,
    assessment: result.assessment,
    policy,
    now,
    handlers: actionHandlers,
  });
  const incidentAlert = await maybeDeliverOpsControlIncidentAlerts({
    tenantId,
    run: result.run,
    policy,
    assessment: result.assessment,
    now,
    sendEmail,
  });
  const refreshedDigest = await queryOne(`
    SELECT * FROM ops_control_digests
    WHERE id = $1 AND tenant_id = $2
  `, [result.digest.id, tenantId]) || result.digest;
  const delivery = await maybeDeliverDigest({
    tenantId,
    digest: refreshedDigest,
    policy,
    window,
    now,
    queryOne,
    execute,
    sendEmail,
  });
  const {snapshot: _snapshot, ...publicResult} = result;
  return {
    kind: 'observed',
    tenantId,
    policy,
    window,
    delivery,
    incidentAlert,
    actions,
    activation,
    ...publicResult,
    digest: refreshedDigest,
  };
}

async function updateSystemState({
  status,
  now,
  mode = OPS_CONTROL_MODE,
  details = {},
  errorCode = '',
  errorMessage = '',
  execute = dbExecute,
}) {
  const succeeded = ['disabled', 'healthy', 'degraded'].includes(status);
  await execute(`
    INSERT INTO ops_control_system_state (
      component, status, mode, cycle_sequence,
      last_started_at, last_succeeded_at, last_failed_at,
      last_error_code, last_error, details, updated_at
    ) VALUES (
      'scheduler', $1, $9, 1,
      $2, $3, $4,
      $5, $6, $7::jsonb, $2
    )
    ON CONFLICT (component)
    DO UPDATE SET
      status = excluded.status,
      mode = excluded.mode,
      cycle_sequence = ops_control_system_state.cycle_sequence + 1,
      last_started_at = excluded.last_started_at,
      last_succeeded_at = CASE
        WHEN $8::boolean THEN excluded.last_succeeded_at
        ELSE ops_control_system_state.last_succeeded_at
      END,
      last_failed_at = CASE
        WHEN $8::boolean THEN ops_control_system_state.last_failed_at
        ELSE excluded.last_failed_at
      END,
      last_error_code = excluded.last_error_code,
      last_error = excluded.last_error,
      details = excluded.details,
      updated_at = excluded.updated_at
  `, [
    status,
    now.toISOString(),
    succeeded ? now.toISOString() : null,
    succeeded ? null : now.toISOString(),
    errorCode,
    text(errorMessage, 2000),
    JSON.stringify(details),
    succeeded,
    mode,
  ]);
}

export async function runOpsControlCycle({
  now = new Date(),
  env = process.env,
  queryAll = dbQueryAll,
  execute = dbExecute,
  observeTenant = runOpsControlTenantObservation,
  logger = console,
} = {}) {
  const globalEnabled = resolveOpsControlGlobalEnabled(env);
  const actionsGlobalEnabled = resolveOpsControlActionsGlobalEnabled(env);
  try {
    if (!globalEnabled) {
      await updateSystemState({
        status: 'disabled',
        now,
        mode: actionsGlobalEnabled ? 'guarded' : 'observe',
        details: {globalEnabled, actionsGlobalEnabled},
        execute,
      });
      return {status: 'disabled', observed: 0, skipped: 0, failed: 0};
    }
    const tenants = await queryAll(`
      SELECT
        tenant.id,
        COALESCE(setting_bundle.settings, '{}'::jsonb) AS settings
      FROM tenants tenant
      LEFT JOIN LATERAL (
        SELECT jsonb_object_agg(setting.key, setting.value) AS settings
        FROM tenant_settings setting
        WHERE setting.tenant_id = tenant.id
          AND setting.key LIKE 'ops_control_%'
      ) setting_bundle ON true
      LEFT JOIN LATERAL (
        SELECT MAX(run.last_snapshot_at) AS last_observed_at
        FROM ops_control_runs run
        WHERE run.tenant_id = tenant.id
      ) observation ON true
      WHERE tenant.status = 'active'
        AND EXISTS (
          SELECT 1
          FROM tenant_settings enabled_setting
          WHERE enabled_setting.tenant_id = tenant.id
            AND enabled_setting.key = 'ops_control_enabled'
            AND lower(trim(enabled_setting.value)) IN ('1', 'true', 'on', 'yes')
        )
      -- Rotate bounded batches instead of starving tenants after the first 50.
      ORDER BY observation.last_observed_at ASC NULLS FIRST, tenant.created_at, tenant.id
      LIMIT $1
    `, [MAX_TENANTS_PER_CYCLE + 1]);
    const truncated = tenants.length > MAX_TENANTS_PER_CYCLE;
    const candidateTenants = tenants.slice(0, MAX_TENANTS_PER_CYCLE);
    const results = [];
    let failed = 0;
    for (const tenant of candidateTenants) {
      const policy = normalizeOpsControlSettings(tenant.settings, {env});
      if (!policy.enabled) {
        results.push({kind: 'disabled', tenantId: tenant.id});
        continue;
      }
      try {
        results.push(await observeTenant({
          tenantId: tenant.id,
          settings: policy,
          now,
        }));
      } catch (error) {
        failed += 1;
        results.push({kind: 'failed', tenantId: tenant.id, error});
        try {
          logger?.error?.(`[OpsControl] tenant observation failed: ${error?.message || error}`);
        } catch {}
      }
    }
    const observed = results.filter(row => row.kind === 'observed').length;
    const incidentCount = results.filter(row => row.assessment?.verdict === 'incident').length;
    const blockedCount = results.filter(row => row.assessment?.verdict === 'blocked_manual').length;
    const actionExecutedCount = results.reduce(
      (sum, row) => sum + integer(row.actions?.executed),
      0,
    );
    const actionFailureCount = results.reduce(
      (sum, row) => sum
        + integer(row.actions?.actionFailed)
        + integer(row.actions?.verificationFailed),
      0,
    );
    const taskActivatedCount = results.filter(
      row => row.activation?.kind === 'task_activity',
    ).length;
    const notificationFailureCount = results.filter(row =>
      ['retry_wait', 'blocked_config', 'failed'].includes(row.incidentAlert?.status)
      || ['retry_wait', 'blocked_config', 'failed'].includes(row.delivery?.status)
    ).length;
    const status = failed > 0
      || truncated
      || actionFailureCount > 0
      || notificationFailureCount > 0
      ? 'degraded'
      : 'healthy';
    await updateSystemState({
      status,
      now,
      mode: actionsGlobalEnabled ? 'guarded' : 'observe',
      details: {
        globalEnabled,
        actionsGlobalEnabled,
        tenantCount: candidateTenants.length,
        truncated,
        enabledTenantCount: results.filter(row => row.kind !== 'disabled').length,
        observed,
        failed,
        incidentCount,
        blockedCount,
        actionExecutedCount,
        actionFailureCount,
        taskActivatedCount,
        notificationFailureCount,
      },
      execute,
    });
    return {
      status,
      observed,
      skipped: results.filter(row => row.kind === 'outside_window').length,
      failed,
      incidentCount,
      blockedCount,
      actionExecutedCount,
      actionFailureCount,
      taskActivatedCount,
      notificationFailureCount,
      truncated,
      results,
    };
  } catch (error) {
    try {
      await updateSystemState({
        status: 'failed',
        now,
        mode: actionsGlobalEnabled ? 'guarded' : 'observe',
        details: {globalEnabled, actionsGlobalEnabled},
        errorCode: text(error?.code || 'OPS_CONTROL_CYCLE_FAILED', 200),
        errorMessage: error?.message || error,
        execute,
      });
    } catch {}
    throw error;
  }
}

export async function getOpsControlTenantSummary(tenantId, {
  env = process.env,
  getSettings = getAllSettings,
  queryOne = dbQueryOne,
  queryAll = dbQueryAll,
} = {}) {
  const settings = await getSettings(tenantId);
  const policy = normalizeOpsControlSettings(settings, {env});
  const {digestEmailTo: _digestEmailTo, ...safePolicy} = policy;
  const [run, digest, incidents, actions] = await Promise.all([
    queryOne(`
      SELECT *
      FROM ops_control_runs
      WHERE tenant_id = $1
      ORDER BY service_date DESC, updated_at DESC
      LIMIT 1
    `, [tenantId]),
    queryOne(`
      SELECT *
      FROM ops_control_digests
      WHERE tenant_id = $1
      ORDER BY service_date DESC, updated_at DESC
      LIMIT 1
    `, [tenantId]),
    queryAll(`
      SELECT id, run_id, fingerprint, incident_type, severity,
        status, title, message, evidence,
        first_seen_at, last_seen_at, resolved_at,
        alert_delivery_status, alert_sent_at
      FROM ops_control_incidents
      WHERE tenant_id = $1 AND status <> 'resolved'
      ORDER BY
        CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2
          WHEN 'warning' THEN 3 ELSE 4 END,
        last_seen_at DESC
      LIMIT 20
    `, [tenantId]),
    queryAll(`
      SELECT id, run_id, incident_id, action_type, target_type, target_id,
        status, attempt_number, snapshot_before_sequence,
        snapshot_after_sequence, result, verification, last_error,
        claimed_at, executed_at, verification_due_at, verified_at,
        created_at, updated_at
      FROM ops_control_actions
      WHERE tenant_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 20
    `, [tenantId]),
  ]);
  return {
    ok: true,
    kind: 'deterministic_ops_control',
    mode: policy.mode,
    observeOnly: policy.observeOnly,
    llmUsed: false,
    runtimeBaselineVersion: OPS_CONTROL_RUNTIME_BASELINE_VERSION,
    policy: {
      ...safePolicy,
      digestEmailConfigured: Boolean(policy.digestEmailTo),
    },
    run,
    digest,
    incidents,
    actions,
    generatedAt: new Date().toISOString(),
  };
}

export async function getOpsControlPublicHealth({
  now = new Date(),
  env = process.env,
  queryOne = dbQueryOne,
} = {}) {
  const globalEnabled = resolveOpsControlGlobalEnabled(env);
  const actionsGlobalEnabled = resolveOpsControlActionsGlobalEnabled(env);
  const state = await queryOne(`
    SELECT component, status, mode, cycle_sequence,
      last_started_at, last_succeeded_at, last_failed_at, updated_at
    FROM ops_control_system_state
    WHERE component = 'scheduler'
  `);
  if (!state) {
    return {
      ok: false,
      status: 'not_started',
      mode: OPS_CONTROL_MODE,
      globalEnabled,
      actionsGlobalEnabled,
      runtimeBaselineVersion: OPS_CONTROL_RUNTIME_BASELINE_VERSION,
      lastCycleAt: null,
    };
  }
  const lagSeconds = ageSeconds(now, state.updated_at);
  const fresh = lagSeconds !== null && lagSeconds <= 180;
  const ok = fresh && ['healthy', 'disabled'].includes(state.status);
  return {
    ok,
    status: fresh ? state.status : 'stale',
    mode: state.mode || OPS_CONTROL_MODE,
    globalEnabled,
    actionsGlobalEnabled,
    runtimeBaselineVersion: OPS_CONTROL_RUNTIME_BASELINE_VERSION,
    lastCycleAt: iso(state.updated_at),
    lastSucceededAt: iso(state.last_succeeded_at),
    cycleSequence: integer(state.cycle_sequence),
    lagSeconds,
  };
}
