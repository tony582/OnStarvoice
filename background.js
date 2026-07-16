try {
  importScripts('utils/task-center.js');
} catch (error) {
  // 测试或旧交付快照中可能暂时没有任务中心脚本。后台可靠性逻辑仍可运行，
  // 等脚本可用后会自动把同一份请求镜像到任务账本。
  console.warn('[onstarvoice] task center core unavailable', error);
}

const STORAGE_KEYS = {
  runtime: 'onstarvoice.runtime',
  unattendedKeywordPlan: 'onstarvoice.unattendedKeywordPlan',
  unattendedKeywordRunRequest: 'onstarvoice.unattendedKeywordRunRequest',
  captureExecutionLock: 'onstarvoice.captureExecutionLock',
  taskLedger: 'onstarvoice.taskLedger',
};

const DEFAULT_RUNTIME = {
  clientUuid: '',
  clientLabel: '',
  appVersion: '',
  platform: 'unknown',
  pageType: 'unknown',
  detailReady: null,
  detailReadyReason: '',
  detailReadyCheckedAt: 0,
  lastActiveTabId: null,
  lastCaptureProgress: null,
  lastCaptureProgressAt: 0,
  lastPageUrl: '',
};

const UNATTENDED_KEYWORD_ALARM_NAME = 'onstarvoice:unattended-keyword-plan';
const UNATTENDED_SUPERVISOR_ALARM_NAME = 'onstarvoice:unattended-supervisor';
const UNATTENDED_RUNNER_QUERY_KEY = 'unattendedRun';
const SCHEDULE_MODES = new Set([
  'daily',
  'custom_dates',
]);
const MIN_SCHEDULE_LEAD_MS = 60 * 1000;
const MAX_SCHEDULE_LOOKAHEAD_DAYS = 400;
// 采集锁使用短租约并由持有侧栏续租。这样侧栏刷新、关闭或崩溃后，
// 不会再留下最长 12 小时且界面不可见的“幽灵任务”。
const CAPTURE_EXECUTION_LOCK_LEASE_MS = 2 * 60 * 1000;
const CAPTURE_EXECUTION_LOCK_SCHEMA_VERSION = 1;
const UNATTENDED_LOCK_RETRY_DELAY_MS = 5 * 60 * 1000;
const UNATTENDED_RUN_CLAIM_GRACE_MS = 2 * 60 * 1000;
const UNATTENDED_RUN_ACTIVE_GRACE_MS = 3 * 60 * 1000;
const UNATTENDED_RUN_BUSINESS_STALL_MS = 6 * 60 * 1000;
const UNATTENDED_SUPERVISOR_PERIOD_MINUTES = 1;
const UNATTENDED_SUPERVISOR_SUSPEND_GAP_MS = 2.5 * 60 * 1000;
const UNATTENDED_SUPERVISOR_WAKE_GRACE_MS = 2 * 60 * 1000;
const UNATTENDED_SUPERVISOR_LOCK_WAIT_MS = 5 * 60 * 1000;
const UNATTENDED_RUN_SCHEMA_VERSION = 2;
const UNATTENDED_MAX_RECOVERY_ATTEMPTS = 2;
const CONTENT_SCRIPT_READY_TIMEOUT_MS = 10 * 1000;
const CONTENT_RELAY_DEFAULT_TIMEOUT_MS = 4 * 60 * 1000;
const CONTENT_RELAY_MAX_TIMEOUT_MS = 11 * 60 * 1000;
const CONTENT_RELAY_INACTIVITY_TIMEOUT_MS = 90 * 1000;
const CONTENT_RELAY_WATCHDOG_TICK_MS = 1000;
const CONTENT_RELAY_SUSPEND_GAP_MS = 15 * 1000;
const CONTENT_NETWORK_PAUSE_HEARTBEAT_GRACE_MS = 20 * 1000;
const CAPTURE_REQUEST_ABORT_TTL_MS = 15 * 60 * 1000;
const UNATTENDED_RUN_TERMINAL_STATUSES = new Set([
  'completed',
  'completed_with_warnings',
  'completed_with_failures',
  'failed',
  'canceled',
  'skipped',
  'needs_action',
]);
const UNATTENDED_RUN_REPORTABLE_STATUSES = new Set([
  'started',
  'running',
  ...UNATTENDED_RUN_TERMINAL_STATUSES,
]);
let unattendedKeywordAlarmInFlight = false;
let unattendedSupervisorInFlight = false;
let lastUnattendedSupervisorTickAt = 0;
const contentRelayHeartbeatByRequestId = new Map();
const abortedCaptureRequestIds = new Map();
const settledCaptureRequestIds = new Map();
const DEFAULT_UNATTENDED_KEYWORD_PLAN = Object.freeze({
  enabled: false,
  platform: 'xiaohongshu',
  mode: 'daily',
  startTime: '09:00',
  randomOffsetMin: 20,
  keywords: [],
  searchFilters: {
    sort: '',
    publishTime: '',
  },
  autoLoop: false,
  roundGapMin: 10,
  maxRounds: 1,
  holidayDates: '',
  customDates: '',
  nextRunAt: '',
  lastRunAt: '',
  lastRunStatus: '',
  lastRunMessage: '',
  lastRunProgress: null,
  updatedAt: '',
});

const PLATFORM_HOME_URLS = Object.freeze({
  xiaohongshu: 'https://www.xiaohongshu.com/explore?channel_id=homefeed_recommend',
  douyin: 'https://www.douyin.com/jingxuan',
  weibo: 'https://s.weibo.com/weibo',
});
const SIDEBAR_PAGE_PATH = 'sidebar/sidebar.html';

function createUuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const rand = Math.floor(Math.random() * 16);
    const value = char === 'x' ? rand : (rand & 0x3) | 0x8;
    return value.toString(16);
  });
}

function getPlatformLabel() {
  const ua = navigator.userAgent || '';
  const browser = ua.includes('Edg/')
    ? 'Edge'
    : ua.includes('Chrome/')
      ? 'Chrome'
      : 'Browser';
  const os = ua.includes('Mac OS X')
    ? 'macOS'
    : ua.includes('Windows')
      ? 'Windows'
      : ua.includes('Linux')
        ? 'Linux'
        : 'Unknown OS';

  return `${browser} on ${os}`;
}

function getAppVersion() {
  return chrome.runtime.getManifest().version;
}

function normalizePlatformId(platform) {
  const normalized = String(platform || '').trim().toLowerCase();
  if (normalized === 'xiaohongshu' || normalized === 'douyin' || normalized === 'weibo') {
    return normalized;
  }
  return 'unknown';
}

function getPlatformHomeUrl(platform) {
  const normalized = normalizePlatformId(platform);
  return PLATFORM_HOME_URLS[normalized] || '';
}

function normalizeScheduleMode(mode) {
  const normalized = String(mode || '').trim().toLowerCase();
  if (normalized === 'holidays') {
    return 'custom_dates';
  }
  return SCHEDULE_MODES.has(normalized) ? normalized : 'daily';
}

function normalizeStartTime(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return DEFAULT_UNATTENDED_KEYWORD_PLAN.startTime;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return DEFAULT_UNATTENDED_KEYWORD_PLAN.startTime;
  }
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function normalizeNonNegativeInteger(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function normalizePositiveInteger(value, fallback = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function normalizeKeywordList(value) {
  const source = Array.isArray(value)
    ? value
    : String(value || '').split(/\r?\n/g);
  const seen = new Set();
  const result = [];
  source.forEach((item) => {
    const keyword = String(item || '').trim();
    if (!keyword || seen.has(keyword)) {
      return;
    }
    seen.add(keyword);
    result.push(keyword);
  });
  return result.slice(0, 30);
}

function normalizeSearchFilters(filters = {}) {
  const defaults = {
    sort: 'comprehensive',
    publishTime: 'all',
    contentType: 'all',
    searchScope: 'all',
    distance: 'all',
    videoDuration: 'all',
  };
  return Object.entries(defaults).reduce((result, [field, defaultValue]) => {
    const value = String(filters?.[field] || '').trim().toLowerCase();
    result[field] = !value || value === defaultValue ? '' : value;
    return result;
  }, {});
}

function normalizeDateListText(value) {
  return Array.from(
    new Set(
      String(value || '')
        .split(/[\s,，;；]+/g)
        .map((item) => item.trim())
        .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item)),
    ),
  ).join('\n');
}

function normalizeUnattendedRunProgress(progress = null, fallbackMessage = '') {
  if (!progress || typeof progress !== 'object') {
    return null;
  }
  const current = Number(progress.current);
  const total = Number(progress.total);
  const round = Number(progress.round);
  const runnerTabId = Number(progress.runnerTabId);
  const remainingMs = Number(progress.remainingMs);
  return {
    current: Number.isFinite(current) ? current : 0,
    total: Number.isFinite(total) ? total : 0,
    keyword: String(progress.keyword || ''),
    phase: String(progress.phase || ''),
    round: Number.isFinite(round) ? round : null,
    runnerTabId: Number.isFinite(runnerTabId) && runnerTabId > 0 ? runnerTabId : null,
    recordId: String(progress.recordId || ''),
    remainingMs: Number.isFinite(remainingMs) ? remainingMs : null,
    waitUntil: String(progress.waitUntil || ''),
    message: String(progress.message || fallbackMessage || ''),
    updatedAt: String(progress.updatedAt || new Date().toISOString()),
  };
}

function parseDateList(value) {
  return new Set(
    normalizeDateListText(value)
      .split(/\n/g)
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function normalizeUnattendedKeywordPlan(input = {}) {
  const base =
    input && typeof input === 'object'
      ? input
      : {};
  const mode = normalizeScheduleMode(base.mode);
  const randomOffsetMin = normalizeNonNegativeInteger(
    base.randomOffsetMin,
    DEFAULT_UNATTENDED_KEYWORD_PLAN.randomOffsetMin,
  );
  const autoLoop = Boolean(base.autoLoop);
  const maxRounds = normalizePositiveInteger(
    base.maxRounds,
    DEFAULT_UNATTENDED_KEYWORD_PLAN.maxRounds,
  );
  const customDatesSource =
    String(base.customDates || '').trim() || String(base.holidayDates || '');
  return {
    ...DEFAULT_UNATTENDED_KEYWORD_PLAN,
    ...base,
    enabled: Boolean(base.enabled),
    platform: normalizePlatformId(base.platform) === 'unknown'
      ? DEFAULT_UNATTENDED_KEYWORD_PLAN.platform
      : normalizePlatformId(base.platform),
    mode,
    startTime: normalizeStartTime(base.startTime),
    randomOffsetMin,
    keywords: normalizeKeywordList(base.keywords),
    searchFilters: normalizeSearchFilters(base.searchFilters),
    autoLoop,
    roundGapMin: normalizeNonNegativeInteger(
      base.roundGapMin,
      DEFAULT_UNATTENDED_KEYWORD_PLAN.roundGapMin,
    ),
    maxRounds: autoLoop ? maxRounds : 1,
    holidayDates: '',
    customDates: normalizeDateListText(customDatesSource),
    nextRunAt: String(base.nextRunAt || ''),
    lastRunAt: String(base.lastRunAt || ''),
    lastRunStatus: String(base.lastRunStatus || ''),
    lastRunMessage: String(base.lastRunMessage || ''),
    lastRunProgress: normalizeUnattendedRunProgress(base.lastRunProgress),
    updatedAt: String(base.updatedAt || ''),
  };
}

function formatLocalDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function shouldRunPlanOnDate(date, plan) {
  const dateKey = formatLocalDateKey(date);
  const day = date.getDay();
  const mode = normalizeScheduleMode(plan?.mode);

  if (mode === 'daily') {
    return true;
  }
  if (mode === 'custom_dates') {
    return parseDateList(plan?.customDates).has(dateKey);
  }
  return false;
}

function buildScheduledDateTime(day, plan) {
  const [hours, minutes] = normalizeStartTime(plan?.startTime)
    .split(':')
    .map((part) => Number(part));
  const scheduled = new Date(day);
  scheduled.setHours(hours, minutes, 0, 0);

  const jitterMinutes = normalizeNonNegativeInteger(plan?.randomOffsetMin, 0);
  if (jitterMinutes > 0) {
    scheduled.setMinutes(
      scheduled.getMinutes() + Math.floor(Math.random() * (jitterMinutes + 1)),
    );
  }
  return scheduled;
}

function computeNextUnattendedRunAt(plan, from = new Date()) {
  const normalizedPlan = normalizeUnattendedKeywordPlan(plan);
  if (!normalizedPlan.enabled || normalizedPlan.keywords.length === 0) {
    return '';
  }

  const startDay = new Date(from);
  startDay.setHours(0, 0, 0, 0);

  for (let offset = 0; offset <= MAX_SCHEDULE_LOOKAHEAD_DAYS; offset += 1) {
    const day = new Date(startDay);
    day.setDate(startDay.getDate() + offset);
    if (!shouldRunPlanOnDate(day, normalizedPlan)) {
      continue;
    }

    const scheduled = buildScheduledDateTime(day, normalizedPlan);
    if (scheduled.getTime() > from.getTime() + MIN_SCHEDULE_LEAD_MS) {
      return scheduled.toISOString();
    }
  }

  return '';
}

async function readUnattendedKeywordPlan() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.unattendedKeywordPlan);
  return normalizeUnattendedKeywordPlan(
    stored[STORAGE_KEYS.unattendedKeywordPlan],
  );
}

let unattendedRunMutationQueue = Promise.resolve();
let taskLedgerMutationQueue = Promise.resolve();

function runUnattendedRunMutation(operation) {
  const pending = unattendedRunMutationQueue.then(operation, operation);
  unattendedRunMutationQueue = pending.catch(() => null);
  return pending;
}

function runTaskLedgerMutation(operation) {
  const pending = taskLedgerMutationQueue.then(operation, operation);
  taskLedgerMutationQueue = pending.catch(() => null);
  return pending;
}

function normalizeUnattendedRunRequest(request) {
  if (!request || typeof request !== 'object' || !String(request.id || '')) {
    return null;
  }
  const createdAt =
    String(request.createdAt || request.updatedAt || '') || new Date().toISOString();
  const heartbeatAt = String(
    request.heartbeatAt || request.claimedAt || request.updatedAt || createdAt,
  );
  const businessProgressAt = String(
    request.businessProgressAt ||
      request.progress?.updatedAt ||
      request.startedAt ||
      request.claimedAt ||
      request.updatedAt ||
      createdAt,
  );
  return {
    ...request,
    schemaVersion: UNATTENDED_RUN_SCHEMA_VERSION,
    id: String(request.id),
    attemptId: String(request.attemptId || `legacy-${request.id}`),
    attemptNumber: Math.max(1, Number(request.attemptNumber) || 1),
    progressSeq: Math.max(0, Number(request.progressSeq) || 0),
    recoveryCount: Math.max(0, Number(request.recoveryCount) || 0),
    createdAt,
    heartbeatAt,
    businessProgressAt,
  };
}

async function readUnattendedKeywordRunRequest() {
  const stored = await chrome.storage.local.get(
    STORAGE_KEYS.unattendedKeywordRunRequest,
  );
  return normalizeUnattendedRunRequest(
    stored[STORAGE_KEYS.unattendedKeywordRunRequest],
  );
}

function isTerminalUnattendedRunStatus(status) {
  return UNATTENDED_RUN_TERMINAL_STATUSES.has(String(status || ''));
}

function parseTimestampMs(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? timestamp : NaN;
}

function getUnattendedTaskCenterCore() {
  const core = globalThis.OnStarvoiceTaskCenterCore;
  return core && typeof core === 'object' ? core : null;
}

function buildTaskCenterCheckpointFromUnattendedRequest(request) {
  const source =
    request?.checkpoint && typeof request.checkpoint === 'object'
      ? request.checkpoint
      : {};
  const keywordResults = Array.isArray(source.keywordResults)
    ? source.keywordResults
    : [];
  const collect = (statuses) =>
    Array.from(
      new Set(
        keywordResults
          .filter((entry) => statuses.has(String(entry?.status || '')))
          .map((entry) => String(entry?.keyword || '').trim())
          .filter(Boolean),
      ),
    );
  const attempts = keywordResults.reduce((result, entry) => {
    const keyword = String(entry?.keyword || '').trim();
    if (keyword) {
      result[keyword] = Math.max(0, Number(entry?.attemptCount) || 0);
    }
    return result;
  }, {});
  return {
    round: Math.max(1, Number(source.round) || 1),
    keywordIndex: Math.max(
      0,
      Number(source.keywordIndex ?? source.activeKeywordIndex) || 0,
    ),
    currentKeyword: String(
      source.currentKeyword || source.activeKeyword || request?.progress?.keyword || '',
    ),
    phase: String(source.phase || source.activePhase || request?.progress?.phase || ''),
    completedKeywords:
      keywordResults.length > 0
        ? collect(new Set(['completed']))
        : Array.isArray(source.completedKeywords)
          ? source.completedKeywords
          : [],
    failedKeywords:
      keywordResults.length > 0
        ? collect(new Set(['failed', 'partial']))
        : Array.isArray(source.failedKeywords)
          ? source.failedKeywords
          : [],
    skippedKeywords:
      keywordResults.length > 0
        ? collect(new Set(['skipped']))
        : Array.isArray(source.skippedKeywords)
          ? source.skippedKeywords
          : [],
    keywordResults: keywordResults.slice(0, 500).map((entry) => ({
      round: Math.max(1, Number(entry?.round) || 1),
      index: Math.max(0, Number(entry?.index) || 0),
      keyword: String(entry?.keyword || '').trim(),
      status: String(entry?.status || '').trim(),
      attemptCount: Math.max(0, Number(entry?.attemptCount) || 0),
      savedCount: Math.max(0, Number(entry?.savedCount) || 0),
      error: String(entry?.error || '').trim(),
      finishedAt: String(entry?.finishedAt || ''),
    })),
    attempts:
      keywordResults.length > 0
        ? attempts
        : source.attempts && typeof source.attempts === 'object'
          ? source.attempts
          : {},
  };
}

function buildUnattendedTaskCounts(request, previousCounts = {}) {
  const summary =
    request?.summary && typeof request.summary === 'object'
      ? request.summary
      : {};
  const counts =
    request?.counts && typeof request.counts === 'object'
      ? request.counts
      : {};
  const read = (name, aliases = []) => {
    const values = [counts[name], ...aliases.map((alias) => summary[alias])];
    const value = values.find((candidate) => Number.isFinite(Number(candidate)));
    return value == null
      ? Math.max(0, Number(previousCounts?.[name]) || 0)
      : Math.max(0, Math.floor(Number(value)));
  };
  const completed = read('success', ['success', 'completed']);
  const failed = read('failed', ['failed']);
  const skipped = read('skipped', ['skipped']);
  const warnings = read('warnings', ['partial', 'warnings']);
  const total = read('total', ['total']);
  return {
    total,
    processed: read('processed', ['processed']) ||
      Math.min(total || Number.MAX_SAFE_INTEGER, completed + failed + skipped + warnings),
    saved: read('saved', ['saved']),
    success: completed,
    failed,
    skipped,
    retried: read('retried', ['retries', 'retried']),
    warnings,
  };
}

function buildUnattendedTaskRun(request, previousRun = null) {
  const normalized = normalizeUnattendedRunRequest(request);
  if (!normalized) {
    return null;
  }
  const plan = normalizeUnattendedKeywordPlan(normalized.planSnapshot || {});
  return {
    ...(previousRun && typeof previousRun === 'object' ? previousRun : {}),
    id: normalized.id,
    taskType: 'unattended_keyword_capture',
    featureKey: 'unattended_keyword_plan',
    source: 'unattended_supervisor',
    status: String(normalized.status || 'pending'),
    platform: plan.platform,
    trigger: String(normalized.reason || 'schedule'),
    title: '无人值守关键词采集',
    attemptId: normalized.attemptId,
    attemptNumber: normalized.attemptNumber,
    progressSeq: normalized.progressSeq,
    heartbeatAt: normalized.heartbeatAt,
    businessProgressAt: normalized.businessProgressAt,
    progress: normalizeUnattendedRunProgress(
      normalized.progress,
      normalized.message,
    ),
    counts: buildUnattendedTaskCounts(normalized, previousRun?.counts),
    checkpoint: buildTaskCenterCheckpointFromUnattendedRequest(normalized),
    message: String(normalized.message || ''),
    error:
      normalized.error && typeof normalized.error === 'object'
        ? normalized.error
        : null,
    runnerTabId:
      Number.isFinite(Number(normalized.runnerTabId)) &&
      Number(normalized.runnerTabId) > 0
        ? Number(normalized.runnerTabId)
        : null,
    metadata: {
      ...(previousRun?.metadata && typeof previousRun.metadata === 'object'
        ? previousRun.metadata
        : {}),
      recoveryCount: normalized.recoveryCount,
      maxRecoveryAttempts: UNATTENDED_MAX_RECOVERY_ATTEMPTS,
      recoveryReason: String(normalized.recoveryReason || ''),
      recoveryWaitUntil: String(normalized.recoveryWaitUntil || ''),
      scheduledMode: plan.mode,
      keywordCount: plan.keywords.length,
      keywords: plan.keywords,
      parentRequestId: String(normalized.parentRequestId || ''),
      recoveryMode: String(normalized.recoveryMode || ''),
    },
    createdAt: normalized.createdAt,
    startedAt: String(normalized.startedAt || normalized.claimedAt || ''),
    updatedAt: String(normalized.updatedAt || normalized.createdAt),
    finishedAt: String(normalized.finishedAt || ''),
    legacy: false,
    incomplete: false,
  };
}

function fallbackUpsertUnattendedTaskRun(
  rawLedger,
  taskRun,
  { previousAttemptId = '', allowAttemptTransition = false } = {},
) {
  const ledger =
    rawLedger && typeof rawLedger === 'object'
      ? {
          ...rawLedger,
          version: Number(rawLedger.version) || 1,
          runs: Array.isArray(rawLedger.runs) ? [...rawLedger.runs] : [],
        }
      : {version: 1, runs: [], updatedAt: ''};
  const index = ledger.runs.findIndex((item) => item?.id === taskRun.id);
  const current = index >= 0 ? ledger.runs[index] : null;
  if (
    current &&
    current.attemptId &&
    taskRun.attemptId &&
    current.attemptId !== taskRun.attemptId &&
    (!allowAttemptTransition || current.attemptId !== previousAttemptId)
  ) {
    return {accepted: false, reason: 'attempt_mismatch', ledger, run: current};
  }
  if (current && isTerminalUnattendedRunStatus(current.status)) {
    return {accepted: false, reason: 'terminal_absorbed', ledger, run: current};
  }
  const nextRun = {...(current || {}), ...taskRun};
  if (index >= 0) {
    ledger.runs[index] = nextRun;
  } else {
    ledger.runs.unshift(nextRun);
  }
  ledger.updatedAt = new Date().toISOString();
  return {accepted: true, reason: current ? 'merged' : 'created', ledger, run: nextRun};
}

function upsertUnattendedTaskLedger(
  rawLedger,
  request,
  {
    previousRequest = null,
    allowAttemptTransition = false,
    event = null,
    now = new Date().toISOString(),
  } = {},
) {
  const core = getUnattendedTaskCenterCore();
  let ledger = rawLedger;
  if (core?.normalizeTaskLedger) {
    ledger = core.normalizeTaskLedger(rawLedger, {now});
  }
  const existingRun = Array.isArray(ledger?.runs)
    ? ledger.runs.find((item) => item?.id === request?.id) || null
    : null;
  let taskRun = buildUnattendedTaskRun(request, existingRun);
  if (!taskRun) {
    return {ledger, run: null, accepted: false, reason: 'invalid_id'};
  }
  if (event && core?.appendTaskEvent) {
    taskRun = core.appendTaskEvent(taskRun, event, {now});
  } else if (event) {
    taskRun.events = [
      ...(Array.isArray(existingRun?.events) ? existingRun.events : []),
      {
        type: String(event.type || 'status'),
        message: String(event.message || ''),
        at: String(event.at || now),
      },
    ].slice(-100);
  }
  if (core?.upsertTaskRun) {
    return core.upsertTaskRun(ledger, taskRun, {
      now,
      attemptId: String(previousRequest?.attemptId || request.attemptId || ''),
      allowAttemptTransition,
    });
  }
  return fallbackUpsertUnattendedTaskRun(ledger, taskRun, {
    previousAttemptId: String(previousRequest?.attemptId || ''),
    allowAttemptTransition,
  });
}

function buildPlanMirrorForUnattendedRequest(plan, request, now) {
  const terminal = isTerminalUnattendedRunStatus(request.status);
  const progress = normalizeUnattendedRunProgress(
    request.progress,
    request.message,
  );
  return normalizeUnattendedKeywordPlan({
    ...plan,
    lastRunAt:
      String(
        terminal
          ? request.finishedAt || request.updatedAt || now
          : request.updatedAt || request.startedAt || request.createdAt || now,
      ) || now,
    lastRunStatus: String(request.status || ''),
    lastRunMessage:
      String(request.message || '') || String(request.error?.message || ''),
    // 终态也保留最后一次业务进度，供任务中心和晨间摘要解释卡在哪里。
    lastRunProgress: progress,
    updatedAt: now,
  });
}

async function persistUnattendedRunMutation(
  request,
  {
    previousRequest = null,
    allowAttemptTransition = false,
    event = null,
    mirrorPlan = true,
  } = {},
) {
  return await runTaskLedgerMutation(async () => {
    const normalized = normalizeUnattendedRunRequest(request);
    if (!normalized) {
      return {request: null, plan: null, ledger: null};
    }
    const now = String(normalized.updatedAt || new Date().toISOString());
    const stored = await chrome.storage.local.get([
      STORAGE_KEYS.unattendedKeywordPlan,
      STORAGE_KEYS.taskLedger,
    ]);
    const plan = normalizeUnattendedKeywordPlan(
      stored[STORAGE_KEYS.unattendedKeywordPlan],
    );
    const ledgerResult = upsertUnattendedTaskLedger(
      stored[STORAGE_KEYS.taskLedger],
      normalized,
      {previousRequest, allowAttemptTransition, event, now},
    );
    if (ledgerResult.accepted === false) {
      const error = new Error(
        `task ledger rejected unattended mutation: ${ledgerResult.reason || 'unknown'}`,
      );
      error.code = 'UNATTENDED_LEDGER_REJECTED';
      throw error;
    }
    const nextPlan = mirrorPlan
      ? buildPlanMirrorForUnattendedRequest(plan, normalized, now)
      : plan;
    const values = {
      [STORAGE_KEYS.unattendedKeywordRunRequest]: normalized,
      [STORAGE_KEYS.taskLedger]: ledgerResult.ledger,
    };
    if (mirrorPlan) {
      values[STORAGE_KEYS.unattendedKeywordPlan] = nextPlan;
    }
    await chrome.storage.local.set(values);
    return {
      request: normalized,
      plan: nextPlan,
      ledger: ledgerResult.ledger,
      ledgerAccepted: ledgerResult.accepted,
      ledgerReason: ledgerResult.reason,
    };
  });
}

async function readTaskLedger() {
  return await runTaskLedgerMutation(async () => {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.taskLedger);
    const rawLedger = stored[STORAGE_KEYS.taskLedger];
    const core = getUnattendedTaskCenterCore();
    if (core?.normalizeTaskLedger) {
      return core.normalizeTaskLedger(rawLedger, {now: new Date().toISOString()});
    }
    return rawLedger && typeof rawLedger === 'object'
      ? {
          ...rawLedger,
          version: Number(rawLedger.version) || 1,
          runs: Array.isArray(rawLedger.runs) ? rawLedger.runs : [],
          updatedAt: String(rawLedger.updatedAt || ''),
        }
      : {version: 1, runs: [], updatedAt: ''};
  });
}

async function upsertTaskLedgerRun({run = null, patch = null, event = null} = {}) {
  return await runTaskLedgerMutation(async () => {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.taskLedger);
    const core = getUnattendedTaskCenterCore();
    const now = new Date().toISOString();
    let ledger = core?.normalizeTaskLedger
      ? core.normalizeTaskLedger(stored[STORAGE_KEYS.taskLedger], {now})
      : stored[STORAGE_KEYS.taskLedger] || {version: 1, runs: [], updatedAt: ''};
    const sourceRun =
      run && typeof run === 'object' && !Array.isArray(run) ? run : {};
    const sourcePatch =
      patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    const taskId = String(sourcePatch.id || sourceRun.id || '').trim();
    if (!taskId) {
      return {accepted: false, reason: 'invalid_id', data: null, ledger};
    }
    const existing = Array.isArray(ledger?.runs)
      ? ledger.runs.find((item) => item?.id === taskId) || null
      : null;
    let nextRun = {...(existing || {}), ...sourceRun, ...sourcePatch, id: taskId};
    if (!nextRun.taskType && nextRun.kind) {
      nextRun.taskType = nextRun.kind;
    }
    if (event && typeof event === 'object') {
      if (core?.appendTaskEvent) {
        nextRun = core.appendTaskEvent(nextRun, event, {now});
      } else {
        nextRun.events = [
          ...(Array.isArray(existing?.events) ? existing.events : []),
          {...event, at: String(event.at || now)},
        ].slice(-100);
      }
    }
    const result = core?.upsertTaskRun
      ? core.upsertTaskRun(ledger, nextRun, {
          now,
          attemptId: String(
            sourcePatch.expectedAttemptId ||
              sourceRun.expectedAttemptId ||
              nextRun.attemptId ||
              '',
          ),
        })
      : fallbackUpsertUnattendedTaskRun(ledger, nextRun, {
          previousAttemptId: String(nextRun.attemptId || ''),
        });
    if (result.accepted) {
      await chrome.storage.local.set({[STORAGE_KEYS.taskLedger]: result.ledger});
    }
    return {
      accepted: Boolean(result.accepted),
      reason: String(result.reason || ''),
      data: result.run || null,
      ledger: result.ledger,
    };
  });
}

async function resolveSupersededNeedsActionTask(
  taskId,
  successorTaskId,
  message = '已由新的恢复任务接管',
) {
  const ledger = await readTaskLedger();
  const previousRun = Array.isArray(ledger?.runs)
    ? ledger.runs.find((run) => run?.id === taskId)
    : null;
  if (!previousRun || previousRun.status !== 'needs_action') {
    return null;
  }
  return await upsertTaskLedgerRun({
    patch: {
      id: previousRun.id,
      status: 'canceled',
      finishedAt: new Date().toISOString(),
      message,
      metadata: {
        ...(previousRun.metadata || {}),
        recoveredByTaskId: successorTaskId,
      },
    },
    event: {
      type: 'superseded',
      message,
    },
  });
}

async function isUnattendedRunRequestActive(request) {
  if (!request || typeof request !== 'object') {
    return false;
  }

  const status = String(request.status || '');
  if (isTerminalUnattendedRunStatus(status)) {
    return false;
  }

  const timestamp =
    parseTimestampMs(request.heartbeatAt) ||
    parseTimestampMs(request.updatedAt) ||
    parseTimestampMs(request.claimedAt) ||
    parseTimestampMs(request.createdAt);
  if (!Number.isFinite(timestamp)) {
    return false;
  }

  const graceMs =
    status === 'pending'
      ? UNATTENDED_RUN_CLAIM_GRACE_MS
      : UNATTENDED_RUN_ACTIVE_GRACE_MS;
  if (Date.now() - timestamp > graceMs) {
    return false;
  }

  const runnerTabId = Number(request.runnerTabId);
  if (Number.isFinite(runnerTabId) && runnerTabId > 0) {
    try {
      await chrome.tabs.get(runnerTabId);
    } catch {
      return false;
    }
  }

  return true;
}

async function markUnattendedRunRequestStale(request, message) {
  return await runUnattendedRunMutation(async () => {
    const current = await readUnattendedKeywordRunRequest();
    if (
      !current ||
      (request?.id && current.id !== request.id) ||
      isTerminalUnattendedRunStatus(current.status)
    ) {
      return current;
    }
    const now = new Date().toISOString();
    const nextRequest = {
      ...current,
      status: 'failed',
      finishedAt: now,
      updatedAt: now,
      message,
      error: {message, code: 'UNATTENDED_STALE'},
    };
    await persistUnattendedRunMutation(nextRequest, {
      previousRequest: current,
      event: {type: 'failed', message, at: now},
    });
    return nextRequest;
  });
}

async function cancelUnattendedKeywordRunRequest(message, {requestId = ''} = {}) {
  return await runUnattendedRunMutation(async () => {
    const request = await readUnattendedKeywordRunRequest();
    if (
      !request ||
      (requestId && request.id !== requestId) ||
      (isTerminalUnattendedRunStatus(request.status) &&
        request.status !== 'needs_action')
    ) {
      return null;
    }
    const now = new Date().toISOString();
    const nextRequest = {
      ...request,
      status: 'canceled',
      finishedAt: now,
      updatedAt: now,
      message,
    };
    await persistUnattendedRunMutation(nextRequest, {
      previousRequest: request,
      event: {type: 'canceled', message, at: now},
    });
    return nextRequest;
  });
}

async function relayCancelToTabs(tabIds = []) {
  const uniqueTabIds = [
    ...new Set(
      tabIds
        .map((tabId) => Number(tabId))
        .filter((tabId) => Number.isFinite(tabId) && tabId > 0),
    ),
  ];
  let successCount = 0;
  for (const tabId of uniqueTabIds) {
    try {
      // 取消是"应秒回"的操作:若某个 tab 的 content script 卡死,不应无限阻塞其它 tab 的取消。
      // 只在此取消路径加 5s 超时守卫,主采集中继(relay-to-content)不受影响。
      const response = await Promise.race([
        relayToContentWithRetry(tabId, { action: 'cancelCapture' }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('cancel relay timeout')), 5000),
        ),
      ]);
      if (!response?.ok) {
        throw new Error(
          response?.error?.message || 'cancel relay was not acknowledged',
        );
      }
      successCount += 1;
    } catch (error) {
      console.warn('[Background] Relay unattended cancel failed:', tabId, error);
    }
  }
  return successCount;
}

async function stopPreviousUnattendedCaptureForResume(lock) {
  const holderTabId = Number(lock?.holderTabId);
  if (!Number.isFinite(holderTabId) || holderTabId <= 0) {
    return {ok: true, method: 'no_target'};
  }

  const relayedCount = await relayCancelToTabs([holderTabId]);
  if (relayedCount > 0) {
    return {ok: true, method: 'cancel_acknowledged'};
  }

  // 卡死或断网时 content script 可能无法确认取消。刷新平台页会销毁旧的
  // content 执行上下文，是恢复前唯一可确认的硬停止；刷新本身失败则禁止新执行。
  try {
    await chrome.tabs.reload(holderTabId);
    return {ok: true, method: 'tab_reloaded'};
  } catch (reloadError) {
    try {
      await chrome.tabs.get(holderTabId);
    } catch {
      return {ok: true, method: 'tab_missing'};
    }
    console.warn(
      '[Background] Could not confirm previous unattended capture stopped:',
      holderTabId,
      reloadError,
    );
    return {
      ok: false,
      method: 'stop_unconfirmed',
      error: reloadError,
    };
  }
}

async function stopUnattendedCaptureTargetsForRecovery(tabIds = []) {
  const uniqueTabIds = [
    ...new Set(
      tabIds
        .map((tabId) => Number(tabId))
        .filter((tabId) => Number.isFinite(tabId) && tabId > 0),
    ),
  ];
  for (const holderTabId of uniqueTabIds) {
    const result = await stopPreviousUnattendedCaptureForResume({holderTabId});
    if (!result.ok) {
      return {...result, holderTabId};
    }
  }
  return {ok: true, method: uniqueTabIds.length ? 'all_stopped' : 'no_target'};
}

async function releaseUnattendedKeywordPlanLock() {
  const activeLock = await readActiveCaptureExecutionLock();
  const owner = String(activeLock?.owner || '');
  if (!activeLock || owner !== 'unattended_keyword_plan') {
    return false;
  }
  return await releaseCaptureExecutionLock(activeLock.id);
}

async function snapshotUnattendedKeywordPlanLock() {
  const activeLock = await readActiveCaptureExecutionLock();
  return String(activeLock?.owner || '') === 'unattended_keyword_plan'
    ? activeLock
    : null;
}

async function cancelAndReleaseUnattendedExecutionTargets(
  lockSnapshot,
  tabIds = [],
) {
  const relayedCount = await relayCancelToTabs([
    ...tabIds,
    lockSnapshot?.holderTabId,
  ]);
  if (lockSnapshot?.id) {
    await releaseCaptureExecutionLock(lockSnapshot.id).catch(() => false);
  }
  return relayedCount;
}

async function cleanupDisabledUnattendedKeywordPlanRuntime() {
  const message = '无人值守计划已关闭，已取消未完成任务';
  // 状态切换前捕获旧锁和平台页。列表采集阶段 progress 可能尚未带 runnerTabId，
  // 若先释放锁再取消，旧 content capture 会继续与下一任务并行。
  const request = await readUnattendedKeywordRunRequest();
  const progress = normalizeUnattendedRunProgress(
    request?.progress,
    request?.message,
  );
  const lockSnapshot = await snapshotUnattendedKeywordPlanLock();
  await cancelUnattendedKeywordRunRequest(message);
  await cancelAndReleaseUnattendedExecutionTargets(lockSnapshot, [
    progress?.runnerTabId,
  ]);
}

async function resolveUnattendedPlanLockState(activeLock) {
  if (!activeLock) {
    return {type: 'none'};
  }
  if (String(activeLock.owner || '') !== 'unattended_keyword_plan') {
    return {type: 'blocking'};
  }

  const request = await readUnattendedKeywordRunRequest();
  const requestActive = await isUnattendedRunRequestActive(request);
  if (requestActive) {
    return {type: 'active_unattended', request};
  }

  return {type: 'stale_unattended', request};
}

function buildScheduleReferenceAfterDate(date = new Date()) {
  const reference = new Date(date);
  reference.setHours(23, 59, 59, 999);
  return reference;
}

function normalizeScheduleReference(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value;
  }
  return new Date();
}

async function saveUnattendedKeywordPlan(
  plan,
  {
    recomputeNext = true,
    from = null,
    preserveRunState = true,
  } = {},
) {
  const normalized = normalizeUnattendedKeywordPlan({
    ...plan,
    updatedAt: new Date().toISOString(),
  });
  const nextRunAt = recomputeNext
    ? computeNextUnattendedRunAt(normalized, normalizeScheduleReference(from))
    : normalized.nextRunAt;
  const nextPlan = await runTaskLedgerMutation(async () => {
    const stored = await chrome.storage.local.get(
      STORAGE_KEYS.unattendedKeywordPlan,
    );
    const currentPlan = normalizeUnattendedKeywordPlan(
      stored[STORAGE_KEYS.unattendedKeywordPlan],
    );
    const preservedRunState =
      preserveRunState && currentPlan.lastRunStatus
        ? {
            lastRunAt: currentPlan.lastRunAt,
            lastRunStatus: currentPlan.lastRunStatus,
            lastRunMessage: currentPlan.lastRunMessage,
            lastRunProgress: currentPlan.lastRunProgress,
          }
        : {};
    const next = {
      ...normalized,
      ...preservedRunState,
      nextRunAt,
    };
    await chrome.storage.local.set({
      [STORAGE_KEYS.unattendedKeywordPlan]: next,
    });
    return next;
  });
  await syncUnattendedKeywordAlarm(nextPlan);
  if (!nextPlan.enabled) {
    await cleanupDisabledUnattendedKeywordPlanRuntime();
  }
  return nextPlan;
}

let captureExecutionLockOperationQueue = Promise.resolve();

function runCaptureExecutionLockOperation(operation) {
  const pending = captureExecutionLockOperationQueue.then(operation, operation);
  captureExecutionLockOperationQueue = pending.catch(() => null);
  return pending;
}

function normalizeCaptureExecutionLock(value, { allowExpired = false } = {}) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const id = String(value.id || '');
  const storedExpiresAt = Number(value.expiresAt);
  if (!id || !Number.isFinite(storedExpiresAt)) {
    return null;
  }

  const schemaVersion = Number(value.schemaVersion) || 0;
  let expiresAt = storedExpiresAt;
  if (schemaVersion < CAPTURE_EXECUTION_LOCK_SCHEMA_VERSION) {
    // 旧版没有持有页面或续租凭证。扩展升级会销毁旧执行上下文，
    // 因此继续信任这类 12 小时锁只会把用户再次困在幽灵锁中。
    expiresAt = 0;
  }
  if (!allowExpired && expiresAt <= Date.now()) {
    return null;
  }

  const holderTabId = Number(value.holderTabId);
  return {
    id,
    owner: String(value.owner || 'unknown'),
    label: String(value.label || '正在运行的采集任务'),
    startedAt: String(value.startedAt || ''),
    updatedAt: String(value.updatedAt || ''),
    expiresAt,
    schemaVersion,
    holderId: String(value.holderId || ''),
    holderDocumentId: String(value.holderDocumentId || ''),
    holderTabId:
      Number.isFinite(holderTabId) && holderTabId > 0 ? holderTabId : null,
  };
}

async function getCaptureExecutionLockHolderState(lock) {
  if (!lock?.holderDocumentId || typeof chrome.runtime.getContexts !== 'function') {
    return 'unknown';
  }
  try {
    const contexts = await chrome.runtime.getContexts({
      documentIds: [lock.holderDocumentId],
    });
    if (!Array.isArray(contexts)) {
      return 'unknown';
    }
    return contexts.length > 0 ? 'alive' : 'gone';
  } catch (error) {
    console.warn('[Background] Failed to inspect capture lock holder:', error);
    return 'unknown';
  }
}

async function removeStaleCaptureExecutionLock(lock, reason) {
  const stopResult = await stopPreviousUnattendedCaptureForResume(lock);
  if (!stopResult.ok) {
    console.warn('[Background] Kept stale capture lock because its page could not be stopped:', {
      id: lock?.id || '',
      owner: lock?.owner || 'unknown',
      reason,
    });
    return false;
  }
  await chrome.storage.local.remove(STORAGE_KEYS.captureExecutionLock);
  console.warn('[Background] Removed stale capture execution lock:', {
    id: lock?.id || '',
    owner: lock?.owner || 'unknown',
    reason,
  });
  return true;
}

async function readActiveCaptureExecutionLockUnsafe() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.captureExecutionLock);
  const storedLock = stored[STORAGE_KEYS.captureExecutionLock];
  if (!storedLock) {
    return null;
  }

  const activeLock = normalizeCaptureExecutionLock(storedLock, {
    allowExpired: true,
  });
  if (!activeLock) {
    await chrome.storage.local.remove(STORAGE_KEYS.captureExecutionLock);
    return null;
  }
  if (activeLock.expiresAt <= Date.now()) {
    const removed = await removeStaleCaptureExecutionLock(
      activeLock,
      'lease_expired',
    );
    return removed ? null : activeLock;
  }

  const holderState = await getCaptureExecutionLockHolderState(activeLock);
  if (holderState === 'gone') {
    const removed = await removeStaleCaptureExecutionLock(
      activeLock,
      'holder_document_gone',
    );
    return removed ? null : activeLock;
  }
  return activeLock;
}

async function readActiveCaptureExecutionLock() {
  return await runCaptureExecutionLockOperation(
    readActiveCaptureExecutionLockUnsafe,
  );
}

async function readStoredCaptureExecutionLock() {
  return await runCaptureExecutionLockOperation(async () => {
    const stored = await chrome.storage.local.get(
      STORAGE_KEYS.captureExecutionLock,
    );
    return normalizeCaptureExecutionLock(
      stored[STORAGE_KEYS.captureExecutionLock],
      {allowExpired: true},
    );
  });
}

async function acquireCaptureExecutionLock({
  owner = 'unknown',
  label = '采集任务',
  holderId = '',
  holderDocumentId = '',
  holderTabId = null,
} = {}) {
  return await runCaptureExecutionLockOperation(async () => {
    const activeLock = await readActiveCaptureExecutionLockUnsafe();
    if (activeLock) {
      return {
        ok: false,
        lock: activeLock,
      };
    }

    const now = Date.now();
    const normalizedHolderTabId = Number(holderTabId);
    const lock = {
      id: createUuid(),
      owner: String(owner || 'unknown'),
      label: String(label || '采集任务'),
      startedAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      expiresAt: now + CAPTURE_EXECUTION_LOCK_LEASE_MS,
      schemaVersion: CAPTURE_EXECUTION_LOCK_SCHEMA_VERSION,
      holderId: String(holderId || ''),
      holderDocumentId: String(holderDocumentId || ''),
      holderTabId:
        Number.isFinite(normalizedHolderTabId) && normalizedHolderTabId > 0
          ? normalizedHolderTabId
          : null,
    };
    await chrome.storage.local.set({
      [STORAGE_KEYS.captureExecutionLock]: lock,
    });
    return {
      ok: true,
      lock,
    };
  });
}

async function transferOrReserveUnattendedCaptureExecutionLock({
  holderId = '',
  holderDocumentId = '',
  holderTabId = null,
} = {}) {
  const normalizedHolderId = String(holderId || '');
  const normalizedDocumentId = String(holderDocumentId || '');
  if (!normalizedHolderId || !normalizedDocumentId) {
    return null;
  }
  return await runCaptureExecutionLockOperation(async () => {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.captureExecutionLock);
    let lock = normalizeCaptureExecutionLock(
      stored[STORAGE_KEYS.captureExecutionLock],
      {allowExpired: true},
    );
    const now = Date.now();
    // 即使租约在休眠期间过期，也要保留旧 holderTabId。它是列表采集早期
    // 唯一可靠的 content 目标；先转移并确认停止旧页面，再允许恢复。
    if (lock && String(lock.owner || '') !== 'unattended_keyword_plan') {
      return null;
    }

    const normalizedHolderTabId = Number(holderTabId);
    const transferred = {
      ...(lock || {}),
      id: lock?.id || createUuid(),
      owner: 'unattended_keyword_plan',
      label: lock?.label || '无人值守计划',
      startedAt: lock?.startedAt || new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      expiresAt: now + CAPTURE_EXECUTION_LOCK_LEASE_MS,
      schemaVersion: CAPTURE_EXECUTION_LOCK_SCHEMA_VERSION,
      holderId: normalizedHolderId,
      holderDocumentId: normalizedDocumentId,
      holderTabId:
        lock?.holderTabId ||
        (Number.isFinite(normalizedHolderTabId) && normalizedHolderTabId > 0
          ? normalizedHolderTabId
          : null),
    };
    await chrome.storage.local.set({
      [STORAGE_KEYS.captureExecutionLock]: transferred,
    });
    return transferred;
  });
}

async function renewCaptureExecutionLock({
  lockId = '',
  holderId = '',
  holderDocumentId = '',
  holderTabId = null,
} = {}) {
  return await runCaptureExecutionLockOperation(async () => {
    if (!lockId || !holderId) {
      return {ok: false, lock: null, reason: 'missing_holder'};
    }

    const stored = await chrome.storage.local.get(STORAGE_KEYS.captureExecutionLock);
    const lock = normalizeCaptureExecutionLock(
      stored[STORAGE_KEYS.captureExecutionLock],
      {allowExpired: true},
    );
    if (!lock || lock.id !== lockId) {
      return {ok: false, lock, reason: 'lock_replaced'};
    }
    if (lock.holderId && lock.holderId !== holderId) {
      return {ok: false, lock, reason: 'holder_mismatch'};
    }
    if (
      lock.holderDocumentId &&
      lock.holderDocumentId !== String(holderDocumentId || '')
    ) {
      return {ok: false, lock, reason: 'document_mismatch'};
    }

    const now = Date.now();
    const normalizedHolderTabId = Number(holderTabId);
    const renewedLock = {
      ...lock,
      schemaVersion: CAPTURE_EXECUTION_LOCK_SCHEMA_VERSION,
      holderId,
      holderDocumentId:
        lock.holderDocumentId || String(holderDocumentId || ''),
      holderTabId:
        Number.isFinite(normalizedHolderTabId) && normalizedHolderTabId > 0
          ? normalizedHolderTabId
          : lock.holderTabId,
      updatedAt: new Date(now).toISOString(),
      expiresAt: now + CAPTURE_EXECUTION_LOCK_LEASE_MS,
    };
    await chrome.storage.local.set({
      [STORAGE_KEYS.captureExecutionLock]: renewedLock,
    });
    return {ok: true, lock: renewedLock, reason: ''};
  });
}

async function releaseCaptureExecutionLock(
  lockId = '',
  {holderId = '', holderDocumentId = '', requireHolder = false} = {},
) {
  return await runCaptureExecutionLockOperation(async () => {
    if (!lockId) {
      return false;
    }
    const stored = await chrome.storage.local.get(STORAGE_KEYS.captureExecutionLock);
    const activeLock = normalizeCaptureExecutionLock(
      stored[STORAGE_KEYS.captureExecutionLock],
      {allowExpired: true},
    );
    if (!activeLock) {
      return true;
    }
    if (activeLock.id !== lockId) {
      return false;
    }
    if (
      requireHolder &&
      ((activeLock.holderId && activeLock.holderId !== holderId) ||
        (activeLock.holderDocumentId &&
          activeLock.holderDocumentId !== String(holderDocumentId || '')))
    ) {
      return false;
    }
    await chrome.storage.local.remove(STORAGE_KEYS.captureExecutionLock);
    return true;
  });
}

async function syncUnattendedKeywordAlarm(plan) {
  await chrome.alarms.clear(UNATTENDED_KEYWORD_ALARM_NAME).catch(() => false);
  const normalized = normalizeUnattendedKeywordPlan(plan);
  if (!normalized.enabled || !normalized.nextRunAt) {
    return;
  }

  const when = new Date(normalized.nextRunAt).getTime();
  if (!Number.isFinite(when) || when <= Date.now()) {
    return;
  }

  await chrome.alarms.create(UNATTENDED_KEYWORD_ALARM_NAME, { when });
}

function buildUnattendedRunnerUrl(requestId) {
  const url = new URL(chrome.runtime.getURL(SIDEBAR_PAGE_PATH));
  url.searchParams.set(UNATTENDED_RUNNER_QUERY_KEY, requestId);
  return url.toString();
}

async function openUnattendedRunnerTab(requestId, { windowId = null } = {}) {
  const runnerUrl = buildUnattendedRunnerUrl(requestId);
  const sidebarUrl = chrome.runtime.getURL(SIDEBAR_PAGE_PATH);
  const allTabs = await chrome.tabs.query({});
  const existingRunner = allTabs.find((tab) => {
    const currentUrl = String(tab?.url || '');
    return (
      currentUrl.startsWith(`${sidebarUrl}?`) &&
      currentUrl.includes(`${UNATTENDED_RUNNER_QUERY_KEY}=`)
    );
  });

  if (existingRunner?.id) {
    return await chrome.tabs.update(existingRunner.id, {
      url: runnerUrl,
      active: true,
    });
  }

  const createOptions = {
    url: runnerUrl,
    active: true,
  };
  if (Number.isFinite(Number(windowId)) && Number(windowId) >= 0) {
    createOptions.windowId = Number(windowId);
  }
  return await chrome.tabs.create(createOptions);
}

async function createUnattendedKeywordRunRequest(plan, { reason = 'alarm' } = {}) {
  return await runUnattendedRunMutation(async () => {
    const existing = await readUnattendedKeywordRunRequest();
    if (existing && !isTerminalUnattendedRunStatus(existing.status)) {
      return existing;
    }
    const now = new Date().toISOString();
    const request = {
      schemaVersion: UNATTENDED_RUN_SCHEMA_VERSION,
      id: createUuid(),
      attemptId: createUuid(),
      attemptNumber: 1,
      progressSeq: 0,
      recoveryCount: 0,
      type: 'keyword_batch',
      status: 'pending',
      reason,
      createdAt: now,
      updatedAt: now,
      heartbeatAt: now,
      businessProgressAt: now,
      planSnapshot: normalizeUnattendedKeywordPlan(plan),
      progress: null,
      error: null,
      message: '已创建无人值守任务，等待运行页领取',
    };
    await persistUnattendedRunMutation(request, {
      event: {type: 'created', message: '已创建无人值守任务', at: now},
    });
    if (existing?.status === 'needs_action') {
      await resolveSupersededNeedsActionTask(
        existing.id,
        request.id,
        '新的计划任务已开始，旧任务结果已保留',
      );
    }
    return request;
  });
}

async function bindUnattendedRunnerTab(request, runnerTabId) {
  const normalizedTabId = Number(runnerTabId);
  if (!Number.isFinite(normalizedTabId) || normalizedTabId <= 0) {
    return request;
  }
  return await runUnattendedRunMutation(async () => {
    const current = await readUnattendedKeywordRunRequest();
    if (
      !current ||
      current.id !== request.id ||
      current.attemptId !== request.attemptId ||
      isTerminalUnattendedRunStatus(current.status)
    ) {
      return current;
    }
    const now = new Date().toISOString();
    const nextRequest = {
      ...current,
      runnerTabId: normalizedTabId,
      updatedAt: now,
    };
    await persistUnattendedRunMutation(nextRequest, {
      previousRequest: current,
      event:
        Number(current.runnerTabId) === normalizedTabId
          ? null
          : {
              type: 'runner_bound',
              message: '无人值守运行页已连接',
              at: now,
            },
    });
    return nextRequest;
  });
}

async function claimUnattendedKeywordRun({
  requestId = '',
  senderTabId = null,
  senderDocumentId = '',
  holderId = '',
} = {}) {
  return await runUnattendedRunMutation(async () => {
    const request = await readUnattendedKeywordRunRequest();
    if (!request || (requestId && request.id !== requestId)) {
      return {accepted: false, reason: 'not_found', data: null};
    }
    if (isTerminalUnattendedRunStatus(request.status)) {
      return {accepted: false, reason: 'terminal', data: null};
    }

    const normalizedSenderTabId = Number(senderTabId);
    const assignedRunnerTabId = Number(request.runnerTabId);
    if (
      request.status === 'pending' &&
      Number.isFinite(assignedRunnerTabId) &&
      assignedRunnerTabId > 0 &&
      assignedRunnerTabId !== normalizedSenderTabId
    ) {
      return {accepted: false, reason: 'runner_mismatch', data: null};
    }
    const isSameRunnerTab =
      Boolean(requestId) &&
      Number.isFinite(normalizedSenderTabId) &&
      normalizedSenderTabId > 0 &&
      Number(request.runnerTabId) === normalizedSenderTabId;
    const isSameRunnerResume =
      isSameRunnerTab &&
      new Set(['claimed', 'started', 'running', 'recovering']).has(
        String(request.status || ''),
      );
    if (request.status !== 'pending' && !isSameRunnerResume) {
      return {accepted: false, reason: 'not_claimable', data: null};
    }

    let transferredLock = null;
    if (isSameRunnerResume) {
      transferredLock = await transferOrReserveUnattendedCaptureExecutionLock({
        holderId,
        holderDocumentId: senderDocumentId,
        holderTabId: request?.progress?.runnerTabId,
      });
      if (!transferredLock) {
        const blockedAt = new Date().toISOString();
        const blockedMessage =
          '检测到其他采集任务已占用执行锁，已阻止无人值守任务并行恢复；请等待当前任务结束后在任务中心重试';
        const blockedRequest = {
          ...request,
          status: 'needs_action',
          recoveryPendingLaunch: false,
          finishedAt: blockedAt,
          updatedAt: blockedAt,
          message: blockedMessage,
          error: {
            code: 'CAPTURE_LOCK_CONFLICT',
            message: blockedMessage,
          },
        };
        await persistUnattendedRunMutation(blockedRequest, {
          previousRequest: request,
          event: {
            type: 'needs_action',
            message: blockedMessage,
            at: blockedAt,
          },
        });
        return {
          accepted: false,
          reason: 'capture_lock_conflict',
          data: blockedRequest,
          lock: null,
        };
      }
      // runner 刷新时旧页面编排已经消失。只有旧 content 执行确认停止（或其
      // 页面已被硬刷新/关闭）后，才允许新页面从检查点继续。
      const stopResult = await stopPreviousUnattendedCaptureForResume(
        transferredLock,
      );
      if (!stopResult.ok) {
        const blockedAt = new Date().toISOString();
        const blockedMessage =
          '旧采集页面未能安全停止，已阻止自动继续；请在任务中心取消任务或人工检查页面后重试';
        const blockedRequest = {
          ...request,
          status: 'needs_action',
          recoveryPendingLaunch: false,
          finishedAt: blockedAt,
          updatedAt: blockedAt,
          message: blockedMessage,
          error: {
            code: 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED',
            message: blockedMessage,
          },
        };
        await persistUnattendedRunMutation(blockedRequest, {
          previousRequest: request,
          event: {
            type: 'needs_action',
            message: blockedMessage,
            at: blockedAt,
          },
        });
        return {
          accepted: false,
          reason: 'previous_capture_stop_unconfirmed',
          data: blockedRequest,
          lock: transferredLock,
        };
      }
    }

    const claimedAt = new Date().toISOString();
    const nextRequest = {
      ...request,
      status: 'claimed',
      claimedAt,
      heartbeatAt: claimedAt,
      // 刷新 runner 只是控制面恢复，不是业务进展。保留旧业务时钟，避免
      // 刷新页面把正常 roundGap 或卡顿检测的基准偷偷向后推。
      businessProgressAt: isSameRunnerResume
        ? request.businessProgressAt
        : claimedAt,
      runnerTabId:
        Number.isFinite(normalizedSenderTabId) && normalizedSenderTabId > 0
          ? normalizedSenderTabId
          : request.runnerTabId ?? null,
      updatedAt: claimedAt,
      resumeCount: isSameRunnerResume
        ? Math.max(0, Number(request.resumeCount) || 0) + 1
        : Math.max(0, Number(request.resumeCount) || 0),
      message: isSameRunnerResume
        ? '检测到运行页刷新，正在从已有采集数据恢复任务'
        : String(request.message || '无人值守运行页已领取任务'),
    };
    await persistUnattendedRunMutation(nextRequest, {
      previousRequest: request,
      event: {
        type: isSameRunnerResume ? 'runner_resumed' : 'claimed',
        message: nextRequest.message,
        at: claimedAt,
      },
    });
    return {
      accepted: true,
      reason: isSameRunnerResume ? 'resumed' : 'claimed',
      data: nextRequest,
      lock: transferredLock,
    };
  });
}

async function updateUnattendedKeywordRun({requestId = '', attemptId = '', patch = {}} = {}) {
  return await runUnattendedRunMutation(async () => {
    const request = await readUnattendedKeywordRunRequest();
    if (!request || !requestId || request.id !== requestId) {
      return {accepted: false, reason: 'not_found', data: null};
    }
    if (!attemptId || request.attemptId !== attemptId) {
      return {accepted: false, reason: 'attempt_mismatch', data: request};
    }
    if (isTerminalUnattendedRunStatus(request.status)) {
      return {accepted: false, reason: 'terminal', data: request};
    }

    const safePatch =
      patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    const allowedPatchFields = [
      'status',
      'message',
      'progress',
      'checkpoint',
      'summary',
      'counts',
      'error',
      'startedAt',
      'finishedAt',
      'heartbeatAt',
      'waitUntil',
      'recoveryWaitUntil',
    ];
    const acceptedPatch = Object.fromEntries(
      allowedPatchFields
        .filter((field) => Object.prototype.hasOwnProperty.call(safePatch, field))
        .map((field) => [field, safePatch[field]]),
    );
    const now = new Date().toISOString();
    const hasProgress =
      safePatch.progress &&
      typeof safePatch.progress === 'object' &&
      !Array.isArray(safePatch.progress);
    const hasCheckpoint =
      safePatch.checkpoint &&
      typeof safePatch.checkpoint === 'object' &&
      !Array.isArray(safePatch.checkpoint);
    const hasBusinessProgress = hasProgress || hasCheckpoint;
    let nextProgressSeq = request.progressSeq;
    if (hasProgress) {
      const suppliedProgressSeq = Number(safePatch.progressSeq);
      if (
        Number.isFinite(suppliedProgressSeq) &&
        suppliedProgressSeq <= request.progressSeq
      ) {
        return {accepted: false, reason: 'stale_progress', data: request};
      }
      nextProgressSeq = Number.isFinite(suppliedProgressSeq)
        ? Math.floor(suppliedProgressSeq)
        : request.progressSeq + 1;
    }

    const requestedStatus = String(safePatch.status || '').trim();
    const nextStatus = UNATTENDED_RUN_REPORTABLE_STATUSES.has(requestedStatus)
      ? requestedStatus
      : request.status;
    const normalizedProgress = hasProgress
      ? normalizeUnattendedRunProgress(safePatch.progress, safePatch.message)
      : request.progress || null;
    let waitUntil = String(request.recoveryWaitUntil || '');
    if (Object.prototype.hasOwnProperty.call(safePatch, 'waitUntil')) {
      waitUntil = String(safePatch.waitUntil || '');
    } else if (
      Object.prototype.hasOwnProperty.call(safePatch, 'recoveryWaitUntil')
    ) {
      waitUntil = String(safePatch.recoveryWaitUntil || '');
    } else if (
      safePatch.progress &&
      Object.prototype.hasOwnProperty.call(safePatch.progress, 'waitUntil')
    ) {
      waitUntil = String(safePatch.progress.waitUntil || '');
    }
    const nextRequest = {
      ...request,
      ...acceptedPatch,
      schemaVersion: UNATTENDED_RUN_SCHEMA_VERSION,
      id: request.id,
      attemptId: request.attemptId,
      attemptNumber: request.attemptNumber,
      progressSeq: nextProgressSeq,
      progress: normalizedProgress,
      status: nextStatus,
      heartbeatAt: safePatch.heartbeatAt ? now : request.heartbeatAt,
      businessProgressAt: hasBusinessProgress ? now : request.businessProgressAt,
      recoveryWaitUntil: waitUntil,
      updatedAt: now,
    };
    if (isTerminalUnattendedRunStatus(nextStatus)) {
      nextRequest.finishedAt = String(safePatch.finishedAt || now);
    }
    delete nextRequest.requestId;

    const statusChanged = nextStatus !== request.status;
    await persistUnattendedRunMutation(nextRequest, {
      previousRequest: request,
      event:
        statusChanged || hasBusinessProgress
          ? {
              type: statusChanged
                ? nextStatus
                : hasCheckpoint
                  ? 'checkpoint'
                  : 'progress',
              message: String(
                nextRequest.message || nextRequest.progress?.message || '',
              ),
              at: now,
            }
          : null,
    });
    return {accepted: true, reason: 'updated', data: nextRequest};
  });
}

async function launchUnattendedKeywordRun(plan, { reason = 'alarm' } = {}) {
  const normalizedPlan = normalizeUnattendedKeywordPlan(plan);
  if (!normalizedPlan.enabled || normalizedPlan.keywords.length === 0) {
    return null;
  }

  const request = await createUnattendedKeywordRunRequest(normalizedPlan, {
    reason,
  });
  try {
    const platformTab = await activateOrCreatePlatformTab(normalizedPlan.platform);
    const runnerTab = await openUnattendedRunnerTab(request.id, {
      windowId: platformTab?.windowId,
    });
    await bindUnattendedRunnerTab(request, runnerTab?.id);
  } catch (error) {
    await markUnattendedRunRequestStale(
      request,
      `创建无人值守运行页失败：${error?.message || '未知错误'}`,
    );
    throw error;
  }
  return request;
}

function getUnattendedRecoveryBlockReason(request) {
  const code = String(request?.error?.code || '').toLowerCase();
  const text = [
    request?.message,
    request?.error?.message,
    request?.progress?.message,
    request?.progress?.phase,
  ]
    .map((value) => String(value || '').toLowerCase())
    .join(' ');
  const blockedCode = /captcha|login|auth|security|risk|forbidden|account/.test(code);
  const blockedText =
    /验证码|人机验证|登录失效|请登录|重新登录|账号异常|账号限制|安全验证|访问受限|风控|captcha|login required|security check/.test(
      text,
    );
  if (!blockedCode && !blockedText) {
    return '';
  }
  if (/login|auth/.test(code) || /登录/.test(text)) {
    return '登录状态已失效，需要用户重新登录后继续';
  }
  return '平台触发安全验证或账号限制，已停止自动重试';
}

function getUnattendedWaitUntilMs(request) {
  const candidates = [
    request?.wakeGraceUntil,
    request?.recoveryWaitUntil,
    request?.waitUntil,
    request?.progress?.waitUntil,
  ];
  const timestamps = candidates
    .map((candidate) => parseTimestampMs(candidate))
    .filter((timestamp) => Number.isFinite(timestamp));
  return timestamps.length > 0 ? Math.max(...timestamps) : NaN;
}

async function assessUnattendedRunHealth(
  request,
  {nowMs = Date.now(), removedTabId = null, ignoreWakeGrace = false} = {},
) {
  if (!request || isTerminalUnattendedRunStatus(request.status)) {
    return {healthy: true, reason: 'terminal'};
  }
  const waitUntilMs = getUnattendedWaitUntilMs(request);
  if (!ignoreWakeGrace && Number.isFinite(waitUntilMs) && waitUntilMs > nowMs) {
    return {healthy: true, reason: 'protected_wait', waitUntil: waitUntilMs};
  }

  const status = String(request.status || '');
  const createdAt = parseTimestampMs(request.createdAt);
  if (
    status === 'pending' &&
    (!Number.isFinite(createdAt) || nowMs - createdAt > UNATTENDED_RUN_CLAIM_GRACE_MS)
  ) {
    return {healthy: false, reason: 'claim_timeout'};
  }

  const runnerTabId = Number(request.runnerTabId);
  if (Number.isFinite(runnerTabId) && runnerTabId > 0) {
    if (Number(removedTabId) === runnerTabId) {
      return {healthy: false, reason: 'runner_tab_closed'};
    }
    try {
      await chrome.tabs.get(runnerTabId);
    } catch {
      return {healthy: false, reason: 'runner_tab_missing'};
    }
  } else if (!new Set(['pending', 'recovering']).has(status)) {
    return {healthy: false, reason: 'runner_tab_missing'};
  }

  if (!new Set(['pending', 'recovering']).has(status)) {
    const heartbeatAt = parseTimestampMs(request.heartbeatAt);
    if (
      !Number.isFinite(heartbeatAt) ||
      nowMs - heartbeatAt > UNATTENDED_RUN_ACTIVE_GRACE_MS
    ) {
      return {healthy: false, reason: 'runner_heartbeat_stale'};
    }
    const businessProgressAt = parseTimestampMs(request.businessProgressAt);
    if (
      !Number.isFinite(businessProgressAt) ||
      nowMs - businessProgressAt > UNATTENDED_RUN_BUSINESS_STALL_MS
    ) {
      return {healthy: false, reason: 'business_progress_stalled'};
    }
  }

  return {healthy: true, reason: 'active'};
}

function formatUnattendedRecoveryReason(reason) {
  const messages = {
    claim_timeout: '运行页未在规定时间内领取任务',
    runner_tab_closed: '运行页已被关闭',
    runner_tab_missing: '运行页已不存在',
    runner_heartbeat_stale: '运行页心跳中断',
    business_progress_stalled: '采集业务长时间没有新进展',
  };
  return messages[String(reason || '')] || '无人值守任务运行异常';
}

async function deferPendingUnattendedRecoveryForLock(request, activeLock) {
  return await runUnattendedRunMutation(async () => {
    const current = await readUnattendedKeywordRunRequest();
    if (
      !current ||
      current.id !== request.id ||
      current.attemptId !== request.attemptId ||
      isTerminalUnattendedRunStatus(current.status)
    ) {
      return null;
    }
    const now = new Date();
    const waitUntil = new Date(
      now.getTime() + UNATTENDED_SUPERVISOR_LOCK_WAIT_MS,
    ).toISOString();
    const message = `${activeLock.label || '手动采集任务'}正在运行，自动恢复将在 5 分钟后重试`;
    const nextRequest = {
      ...current,
      status: 'recovering',
      recoveryPendingLaunch: true,
      recoveryWaitUntil: waitUntil,
      updatedAt: now.toISOString(),
      message,
    };
    await persistUnattendedRunMutation(nextRequest, {
      previousRequest: current,
      event: {type: 'recovery_deferred', message, at: now.toISOString()},
    });
    return nextRequest;
  });
}

async function markUnattendedRecoveryStopUnconfirmed(request, message) {
  return await runUnattendedRunMutation(async () => {
    const current = await readUnattendedKeywordRunRequest();
    if (
      !current ||
      current.id !== request?.id ||
      current.attemptId !== request?.attemptId ||
      isTerminalUnattendedRunStatus(current.status)
    ) {
      return current;
    }
    const now = new Date().toISOString();
    const nextRequest = {
      ...current,
      status: 'needs_action',
      recoveryPendingLaunch: false,
      recoveryWaitUntil: '',
      finishedAt: now,
      updatedAt: now,
      message,
      error: {
        code: 'PREVIOUS_CAPTURE_STOP_UNCONFIRMED',
        message,
      },
    };
    await persistUnattendedRunMutation(nextRequest, {
      previousRequest: current,
      event: {type: 'needs_action', message, at: now},
    });
    return nextRequest;
  });
}

async function launchPendingUnattendedRecovery(request) {
  const storedLock = await readStoredCaptureExecutionLock();
  const activeLock =
    storedLock && String(storedLock.owner || '') !== 'unattended_keyword_plan'
      ? await readActiveCaptureExecutionLock()
      : storedLock;
  if (activeLock && String(activeLock.owner || '') !== 'unattended_keyword_plan') {
    return {
      recovered: false,
      deferred: true,
      request: await deferPendingUnattendedRecoveryForLock(request, activeLock),
    };
  }
  if (activeLock && String(activeLock.owner || '') === 'unattended_keyword_plan') {
    const stopResult = await stopUnattendedCaptureTargetsForRecovery([
      activeLock.holderTabId,
      request?.progress?.runnerTabId,
    ]);
    if (!stopResult.ok) {
      const message =
        '旧采集页面未能安全停止，本次恢复已暂停；请人工检查页面后从任务中心重试';
      const blockedRequest = await markUnattendedRecoveryStopUnconfirmed(
        request,
        message,
      );
      return {
        recovered: false,
        deferred: false,
        terminal: true,
        request: blockedRequest || request,
        reason: 'previous_capture_stop_unconfirmed',
      };
    }
    await releaseCaptureExecutionLock(activeLock.id);
  }

  const pendingRequest = await runUnattendedRunMutation(async () => {
    const current = await readUnattendedKeywordRunRequest();
    if (
      !current ||
      current.id !== request.id ||
      current.attemptId !== request.attemptId ||
      isTerminalUnattendedRunStatus(current.status)
    ) {
      return null;
    }
    const now = new Date().toISOString();
    const nextRequest = {
      ...current,
      status: 'pending',
      recoveryPendingLaunch: false,
      recoveryWaitUntil: '',
      runnerTabId: null,
      heartbeatAt: now,
      businessProgressAt: now,
      updatedAt: now,
      message: `正在启动第 ${current.attemptNumber} 次无人值守运行`,
    };
    await persistUnattendedRunMutation(nextRequest, {
      previousRequest: current,
      event: {type: 'recovery_launching', message: nextRequest.message, at: now},
    });
    return nextRequest;
  });
  if (!pendingRequest) {
    return {recovered: false, reason: 'fenced'};
  }

  try {
    const plan = normalizeUnattendedKeywordPlan(pendingRequest.planSnapshot || {});
    const platformTab = await activateOrCreatePlatformTab(plan.platform);
    const runnerTab = await openUnattendedRunnerTab(pendingRequest.id, {
      windowId: platformTab?.windowId,
    });
    const boundRequest = await bindUnattendedRunnerTab(
      pendingRequest,
      runnerTab?.id,
    );
    return {recovered: true, request: boundRequest || pendingRequest};
  } catch (error) {
    const message = `自动恢复运行页失败：${error?.message || '未知错误'}`;
    const deferredRequest = await runUnattendedRunMutation(async () => {
      const current = await readUnattendedKeywordRunRequest();
      if (
        !current ||
        current.id !== pendingRequest.id ||
        current.attemptId !== pendingRequest.attemptId ||
        isTerminalUnattendedRunStatus(current.status)
      ) {
        return current;
      }
      const now = new Date();
      const launchFailures =
        Math.max(0, Number(current.recoveryLaunchFailures) || 0) + 1;
      const exhausted = launchFailures >= UNATTENDED_MAX_RECOVERY_ATTEMPTS;
      const exhaustedMessage = `${message}；运行页连续启动失败 ${launchFailures} 次，请人工检查`;
      const nextRequest = {
        ...current,
        status: exhausted ? 'needs_action' : 'recovering',
        recoveryPendingLaunch: !exhausted,
        recoveryWaitUntil: exhausted
          ? ''
          : new Date(
              now.getTime() + UNATTENDED_SUPERVISOR_WAKE_GRACE_MS,
            ).toISOString(),
        recoveryLaunchFailures: launchFailures,
        finishedAt: exhausted ? now.toISOString() : '',
        updatedAt: now.toISOString(),
        message: exhausted ? exhaustedMessage : message,
        error: {
          code: exhausted
            ? 'UNATTENDED_RECOVERY_LAUNCH_EXHAUSTED'
            : 'RECOVERY_LAUNCH_FAILED',
          message: exhausted ? exhaustedMessage : message,
        },
      };
      await persistUnattendedRunMutation(nextRequest, {
        previousRequest: current,
        event: {
          type: exhausted ? 'needs_action' : 'recovery_launch_failed',
          message: nextRequest.message,
          at: now.toISOString(),
        },
      });
      return nextRequest;
    });
    return {
      recovered: false,
      deferred: deferredRequest?.status !== 'needs_action',
      terminal: deferredRequest?.status === 'needs_action',
      request: deferredRequest,
      reason:
        deferredRequest?.status === 'needs_action'
          ? 'recovery_launch_exhausted'
          : 'recovery_launch_failed',
    };
  }
}

async function recoverUnattendedKeywordRunRequest(request, health) {
  const blockReason = getUnattendedRecoveryBlockReason(request);
  // request.runnerTabId 指向扩展自己的 runner 页面，不是注入 content script 的平台页；
  // 平台页在列表阶段未必已经写入 progress.runnerTabId，因此在释放旧锁之前也要
  // 捕获锁的 holderTabId。恢复只取消这两个旧执行目标，避免误伤新 attempt。
  const oldExecutionLock = await readStoredCaptureExecutionLock();
  const oldUnattendedLock =
    String(oldExecutionLock?.owner || '') === 'unattended_keyword_plan'
      ? oldExecutionLock
      : null;
  const oldRunnerTabIds = [
    request.progress?.runnerTabId,
    oldUnattendedLock?.holderTabId,
  ];
  const transition = await runUnattendedRunMutation(async () => {
    const current = await readUnattendedKeywordRunRequest();
    if (
      !current ||
      current.id !== request.id ||
      current.attemptId !== request.attemptId ||
      isTerminalUnattendedRunStatus(current.status)
    ) {
      return {action: 'fenced', request: current};
    }
    const now = new Date().toISOString();
    if (blockReason) {
      const nextRequest = {
        ...current,
        status: 'needs_action',
        finishedAt: now,
        updatedAt: now,
        message: blockReason,
        error: {
          ...(current.error && typeof current.error === 'object'
            ? current.error
            : {}),
          code: 'UNATTENDED_RECOVERY_BLOCKED',
          message: blockReason,
        },
      };
      await persistUnattendedRunMutation(nextRequest, {
        previousRequest: current,
        event: {type: 'needs_action', message: blockReason, at: now},
      });
      return {action: 'terminal', request: nextRequest};
    }

    const recoveryCount = Math.max(0, Number(current.recoveryCount) || 0);
    if (recoveryCount >= UNATTENDED_MAX_RECOVERY_ATTEMPTS) {
      const reasonText = formatUnattendedRecoveryReason(health.reason);
      const message = `${reasonText}，自动恢复已达到 ${UNATTENDED_MAX_RECOVERY_ATTEMPTS} 次，请人工检查后继续`;
      const nextRequest = {
        ...current,
        status: 'needs_action',
        finishedAt: now,
        updatedAt: now,
        message,
        error: {code: 'UNATTENDED_RECOVERY_EXHAUSTED', message},
      };
      await persistUnattendedRunMutation(nextRequest, {
        previousRequest: current,
        event: {type: 'needs_action', message, at: now},
      });
      return {action: 'terminal', request: nextRequest};
    }

    const nextRecoveryCount = recoveryCount + 1;
    const reasonText = formatUnattendedRecoveryReason(health.reason);
    const message = `${reasonText}，正在自动恢复（${nextRecoveryCount}/${UNATTENDED_MAX_RECOVERY_ATTEMPTS}）`;
    const nextRequest = {
      ...current,
      attemptId: createUuid(),
      attemptNumber: Math.max(1, Number(current.attemptNumber) || 1) + 1,
      progressSeq: Math.max(0, Number(current.progressSeq) || 0) + 1,
      recoveryCount: nextRecoveryCount,
      recoveryReason: String(health.reason || ''),
      recoveryPendingLaunch: true,
      recoveryLaunchFailures: 0,
      recoveryWaitUntil: '',
      status: 'recovering',
      runnerTabId: null,
      heartbeatAt: now,
      businessProgressAt: now,
      updatedAt: now,
      message,
      error: null,
    };
    await persistUnattendedRunMutation(nextRequest, {
      previousRequest: current,
      allowAttemptTransition: true,
      event: {type: 'auto_recovery', message, at: now},
    });
    return {action: 'recover', request: nextRequest};
  });

  if (transition.action === 'fenced') {
    return {recovered: false, reason: 'fenced', request: transition.request};
  }
  const stopResult = await stopUnattendedCaptureTargetsForRecovery(
    oldRunnerTabIds,
  );
  if (!stopResult.ok) {
    const message =
      '旧采集页面未能安全停止，已阻止自动恢复；请人工检查页面后从任务中心继续';
    const blockedRequest = await markUnattendedRecoveryStopUnconfirmed(
      transition.request,
      message,
    );
    return {
      recovered: false,
      terminal: true,
      reason: 'previous_capture_stop_unconfirmed',
      request: blockedRequest || transition.request,
    };
  }
  if (oldUnattendedLock?.id) {
    await releaseCaptureExecutionLock(oldUnattendedLock.id).catch(() => false);
  }
  if (transition.action === 'terminal') {
    return {recovered: false, terminal: true, request: transition.request};
  }
  return await launchPendingUnattendedRecovery(transition.request);
}

function buildManualRecoveryCheckpoint(request, mode) {
  const source =
    request?.checkpoint && typeof request.checkpoint === 'object'
      ? request.checkpoint
      : {};
  const checkpoint = {
    ...source,
    keywordResults: Array.isArray(source.keywordResults)
      ? source.keywordResults.map((entry) => ({...entry}))
      : [],
    completedKeywords: Array.isArray(source.completedKeywords)
      ? [...source.completedKeywords]
      : [],
    failedKeywords: Array.isArray(source.failedKeywords)
      ? [...source.failedKeywords]
      : [],
    skippedKeywords: Array.isArray(source.skippedKeywords)
      ? [...source.skippedKeywords]
      : [],
    attempts:
      source.attempts && typeof source.attempts === 'object'
        ? {...source.attempts}
        : {},
  };
  if (mode === 'failed') {
    return {
      schemaVersion: 1,
      round: 1,
      activeKeywordIndex: 0,
      activeKeyword: '',
      activePhase: 'pending',
      keywordResults: [],
      updatedAt: new Date().toISOString(),
      keywordIndex: 0,
      currentKeyword: '',
      phase: '',
      completedKeywords: [],
      failedKeywords: [],
      skippedKeywords: [],
      attempts: {},
    };
  }
  if (mode === 'skip_current') {
    const currentKeyword = String(
      checkpoint.activeKeyword ||
        checkpoint.currentKeyword ||
        request?.progress?.keyword ||
        '',
    ).trim();
    const round = Math.max(1, Number(checkpoint.round) || 1);
    const resultIndex = checkpoint.keywordResults.findIndex(
      (entry) =>
        String(entry?.keyword || '').trim() === currentKeyword &&
        Math.max(1, Number(entry?.round) || 1) === round,
    );
    const skippedEntry = {
      ...(resultIndex >= 0 ? checkpoint.keywordResults[resultIndex] : {}),
      round,
      index: Math.max(
        0,
        Number(checkpoint.activeKeywordIndex ?? checkpoint.keywordIndex) || 0,
      ),
      keyword: currentKeyword,
      status: 'skipped',
      finishedAt: new Date().toISOString(),
    };
    if (currentKeyword) {
      if (resultIndex >= 0) checkpoint.keywordResults[resultIndex] = skippedEntry;
      else checkpoint.keywordResults.push(skippedEntry);
    }
    if (currentKeyword && !checkpoint.skippedKeywords.includes(currentKeyword)) {
      checkpoint.skippedKeywords.push(currentKeyword);
    }
    checkpoint.failedKeywords = checkpoint.failedKeywords.filter(
      (keyword) => keyword !== currentKeyword,
    );
    checkpoint.keywordIndex = Math.max(0, Number(checkpoint.keywordIndex) || 0) + 1;
    checkpoint.activeKeywordIndex = Math.max(
      0,
      Number(checkpoint.activeKeywordIndex) || 0,
    ) + 1;
    checkpoint.currentKeyword = '';
    checkpoint.activeKeyword = '';
    checkpoint.phase = '';
    checkpoint.activePhase = 'pending';
    checkpoint.updatedAt = new Date().toISOString();
  }
  return checkpoint;
}

async function manuallyRecoverUnattendedKeywordRun({requestId = '', mode = 'remaining'} = {}) {
  const normalizedMode = new Set(['remaining', 'failed', 'skip_current']).has(mode)
    ? mode
    : 'remaining';
  const created = await runUnattendedRunMutation(async () => {
    const current = await readUnattendedKeywordRunRequest();
    if (!current || !requestId || current.id !== requestId) {
      return {accepted: false, reason: 'not_found', request: null};
    }
    if (!isTerminalUnattendedRunStatus(current.status)) {
      return {accepted: false, reason: 'not_recoverable', request: current};
    }

    const now = new Date().toISOString();
    const checkpoint = buildManualRecoveryCheckpoint(current, normalizedMode);
    let planSnapshot = normalizeUnattendedKeywordPlan(current.planSnapshot || {});
    if (normalizedMode === 'failed') {
      const taskCheckpoint = buildTaskCenterCheckpointFromUnattendedRequest(current);
      const failedKeywords = taskCheckpoint.failedKeywords.filter(Boolean);
      if (failedKeywords.length === 0) {
        return {
          accepted: false,
          reason: 'no_failed_keywords',
          request: current,
        };
      }
      planSnapshot = normalizeUnattendedKeywordPlan({
        ...planSnapshot,
        keywords: failedKeywords,
        // “仅重试失败项”是一次有界补偿，不继承原多轮循环；否则第 N 轮的
        // 单个失败词会从第 1 轮重新跑满全部轮次，造成重复采集和风控风险。
        autoLoop: false,
        maxRounds: 1,
        roundGapMin: 0,
      });
    } else if (normalizedMode === 'skip_current') {
      const skippedKeyword = String(
        current.checkpoint?.activeKeyword ||
          current.checkpoint?.currentKeyword ||
          current.progress?.keyword ||
          '',
      ).trim();
      if (!skippedKeyword) {
        return {
          accepted: false,
          reason: 'no_current_keyword',
          request: current,
        };
      }
      planSnapshot = normalizeUnattendedKeywordPlan({
        ...planSnapshot,
        keywords: planSnapshot.keywords.filter(
          (keyword) => keyword !== skippedKeyword,
        ),
      });
      if (planSnapshot.keywords.length === 0) {
        return {
          accepted: false,
          reason: 'no_remaining_keywords',
          request: current,
        };
      }
    }
    const labels = {
      remaining: '继续采集剩余关键词',
      failed: '仅重试失败关键词',
      skip_current: '跳过当前项并继续',
    };
    const nextRequest = {
      ...current,
      schemaVersion: UNATTENDED_RUN_SCHEMA_VERSION,
      id: createUuid(),
      parentRequestId: current.id,
      attemptId: createUuid(),
      attemptNumber: Math.max(1, Number(current.attemptNumber) || 1) + 1,
      progressSeq: Math.max(0, Number(current.progressSeq) || 0) + 1,
      recoveryCount: Math.max(0, Number(current.recoveryCount) || 0),
      manualRecoveryCount:
        Math.max(0, Number(current.manualRecoveryCount) || 0) + 1,
      recoveryMode: normalizedMode,
      recoveryReason: 'manual_recovery',
      recoveryPendingLaunch: true,
      recoveryLaunchFailures: 0,
      recoveryWaitUntil: '',
      type: 'keyword_batch',
      status: 'recovering',
      reason: 'manual_recovery',
      createdAt: now,
      claimedAt: '',
      startedAt: '',
      finishedAt: '',
      updatedAt: now,
      heartbeatAt: now,
      businessProgressAt: now,
      runnerTabId: null,
      planSnapshot,
      checkpoint,
      progress: null,
      error: null,
      message: labels[normalizedMode],
    };
    await persistUnattendedRunMutation(nextRequest, {
      event: {
        type: 'manual_recovery',
        message: labels[normalizedMode],
        at: now,
      },
    });
    return {
      accepted: true,
      reason: 'created',
      request: nextRequest,
      previousRequest: current,
    };
  });
  if (!created.accepted) {
    return created;
  }
  if (created.previousRequest?.status === 'needs_action') {
    await resolveSupersededNeedsActionTask(
      created.previousRequest.id,
      created.request.id,
      '用户已创建新的恢复任务',
    );
  }
  const launchResult = await launchPendingUnattendedRecovery(created.request);
  return {
    accepted: Boolean(launchResult.recovered || launchResult.deferred),
    reason: launchResult.deferred ? 'deferred' : launchResult.recovered ? 'recovered' : launchResult.reason,
    request: launchResult.request || created.request,
  };
}

async function applyUnattendedWakeGrace(request, reason = 'wake') {
  return await runUnattendedRunMutation(async () => {
    const current = await readUnattendedKeywordRunRequest();
    if (
      !current ||
      current.id !== request.id ||
      current.attemptId !== request.attemptId ||
      isTerminalUnattendedRunStatus(current.status)
    ) {
      return current;
    }
    const now = new Date();
    const existingGraceUntil = parseTimestampMs(current.wakeGraceUntil);
    if (Number.isFinite(existingGraceUntil) && existingGraceUntil > now.getTime()) {
      return current;
    }
    const wakeGraceUntil = new Date(
      now.getTime() + UNATTENDED_SUPERVISOR_WAKE_GRACE_MS,
    ).toISOString();
    const nextRequest = {
      ...current,
      wakeGraceUntil,
      updatedAt: now.toISOString(),
      wakeReason: reason,
    };
    await persistUnattendedRunMutation(nextRequest, {
      previousRequest: current,
      event: {
        type: 'wake_grace',
        message: '检测到浏览器或电脑恢复，等待运行页重新连接',
        at: now.toISOString(),
      },
    });
    return nextRequest;
  });
}

async function superviseUnattendedKeywordRun({
  removedTabId = null,
  applyWakeGrace = false,
  scheduledTime = null,
  reason = 'alarm',
} = {}) {
  if (unattendedSupervisorInFlight) {
    return {skipped: true, reason: 'in_flight'};
  }
  unattendedSupervisorInFlight = true;
  try {
    const nowMs = Date.now();
    let request = await readUnattendedKeywordRunRequest();
    if (!request || isTerminalUnattendedRunStatus(request.status)) {
      lastUnattendedSupervisorTickAt = nowMs;
      return {healthy: true, reason: 'no_active_request'};
    }
    const previousSupervisorTickAt = lastUnattendedSupervisorTickAt;
    const supervisorGap = previousSupervisorTickAt
      ? nowMs - previousSupervisorTickAt
      : 0;
    const normalizedScheduledTime = Number(scheduledTime);
    const alarmDelay =
      scheduledTime != null &&
      Number.isFinite(normalizedScheduledTime) &&
      normalizedScheduledTime > 0
      ? Math.max(0, nowMs - normalizedScheduledTime)
      : 0;
    lastUnattendedSupervisorTickAt = nowMs;

    const removedCurrentRunner =
      Number.isFinite(Number(removedTabId)) &&
      Number(removedTabId) === Number(request.runnerTabId);
    const wokeFromSuspension =
      applyWakeGrace ||
      supervisorGap > UNATTENDED_SUPERVISOR_SUSPEND_GAP_MS ||
      alarmDelay > UNATTENDED_SUPERVISOR_SUSPEND_GAP_MS;
    if (wokeFromSuspension && !removedCurrentRunner) {
      request = await applyUnattendedWakeGrace(request, reason);
      return {healthy: true, reason: 'wake_grace', request};
    }

    if (request.status === 'recovering' && request.recoveryPendingLaunch) {
      const waitUntil = parseTimestampMs(request.recoveryWaitUntil);
      if (Number.isFinite(waitUntil) && waitUntil > nowMs) {
        return {healthy: true, reason: 'recovery_wait', request};
      }
      return await launchPendingUnattendedRecovery(request);
    }

    const health = await assessUnattendedRunHealth(request, {
      nowMs,
      removedTabId,
      ignoreWakeGrace: removedCurrentRunner,
    });
    if (health.healthy) {
      return health;
    }
    return await recoverUnattendedKeywordRunRequest(request, health);
  } finally {
    unattendedSupervisorInFlight = false;
  }
}

async function syncUnattendedSupervisorAlarm() {
  await chrome.alarms.create(UNATTENDED_SUPERVISOR_ALARM_NAME, {
    periodInMinutes: UNATTENDED_SUPERVISOR_PERIOD_MINUTES,
  });
}

async function handleUnattendedKeywordAlarm() {
  if (unattendedKeywordAlarmInFlight) {
    return;
  }
  unattendedKeywordAlarmInFlight = true;
  try {
    const plan = await readUnattendedKeywordPlan();
    if (!plan.enabled) {
      await syncUnattendedKeywordAlarm(plan);
      return;
    }

    const now = new Date();
    const todayKey = formatLocalDateKey(now);
    if (!shouldRunPlanOnDate(now, plan)) {
      await saveUnattendedKeywordPlan(plan, { recomputeNext: true });
      return;
    }

    // 计划闹钟与监督闹钟可能在唤醒时同时触发。只要已有未终结请求，
    // 就先监督/恢复它，绝不另建第二个 runner 绕过 attempt fencing。
    const existingRequest = await readUnattendedKeywordRunRequest();
    if (
      existingRequest &&
      !isTerminalUnattendedRunStatus(existingRequest.status)
    ) {
      await superviseUnattendedKeywordRun({reason: 'schedule_alarm'});
      return;
    }

    let activeLock = await readActiveCaptureExecutionLock();
    if (activeLock) {
      const lockState = await resolveUnattendedPlanLockState(activeLock);
      if (lockState.type === 'stale_unattended') {
        await releaseCaptureExecutionLock(activeLock.id);
        await markUnattendedRunRequestStale(
          lockState.request,
          '无人值守旧锁已失去对应运行请求，已安全清理',
        );
        activeLock = null;
      } else if (lockState.type === 'active_unattended') {
        await saveUnattendedKeywordPlan(
          {
            ...plan,
            lastRunAt: now.toISOString(),
            lastRunStatus: 'running',
            lastRunMessage: `${activeLock.label}正在运行，已保留当前任务`,
            nextRunAt: '',
          },
          { recomputeNext: true, from: buildScheduleReferenceAfterDate(now) },
        );
        return;
      } else {
        const retryAt = new Date(now.getTime() + UNATTENDED_LOCK_RETRY_DELAY_MS);
        await saveUnattendedKeywordPlan(
          {
            ...plan,
            lastRunAt: now.toISOString(),
            lastRunStatus: 'deferred',
            lastRunMessage: `${activeLock.label}正在运行，无人值守计划将在 5 分钟后重试`,
            lastRunProgress: null,
            nextRunAt: retryAt.toISOString(),
          },
          {recomputeNext: false, preserveRunState: false},
        );
        return;
      }
    }

    try {
      await launchUnattendedKeywordRun(plan, { reason: 'alarm' });
      await saveUnattendedKeywordPlan(
        {
          ...plan,
          lastRunAt: now.toISOString(),
          lastRunStatus: 'started',
          lastRunMessage: `已在 ${todayKey} 创建无人值守任务`,
          nextRunAt: '',
        },
        { recomputeNext: true, from: buildScheduleReferenceAfterDate(now) },
      );
    } catch (error) {
      await saveUnattendedKeywordPlan(
        {
          ...plan,
          lastRunAt: now.toISOString(),
          lastRunStatus: 'failed',
          lastRunMessage: error?.message || '创建无人值守任务失败',
          nextRunAt: '',
        },
        { recomputeNext: true, from: buildScheduleReferenceAfterDate(now) },
      );
      throw error;
    }
  } finally {
    unattendedKeywordAlarmInFlight = false;
  }
}

async function reconcileUnattendedKeywordPlanSchedule({ launchDue = false } = {}) {
  const plan = await readUnattendedKeywordPlan();
  if (!plan.enabled) {
    await cleanupDisabledUnattendedKeywordPlanRuntime();
    await syncUnattendedKeywordAlarm(plan);
    return plan;
  }

  const activeRequest = await readUnattendedKeywordRunRequest();
  if (await isUnattendedRunRequestActive(activeRequest)) {
    if (plan.nextRunAt) {
      return await saveUnattendedKeywordPlan(
        {
          ...plan,
          nextRunAt: '',
        },
        { recomputeNext: false },
      );
    }
    await syncUnattendedKeywordAlarm(plan);
    return plan;
  }

  if (!plan.nextRunAt) {
    return await saveUnattendedKeywordPlan(plan, { recomputeNext: true });
  }

  const nextRunAt = new Date(plan.nextRunAt).getTime();
  if (!Number.isFinite(nextRunAt)) {
    return await saveUnattendedKeywordPlan(
      {
        ...plan,
        nextRunAt: '',
      },
      { recomputeNext: true },
    );
  }

  if (nextRunAt <= Date.now()) {
    if (launchDue) {
      await handleUnattendedKeywordAlarm();
      return await readUnattendedKeywordPlan();
    }
    return await saveUnattendedKeywordPlan(
      {
        ...plan,
        nextRunAt: '',
      },
      { recomputeNext: true },
    );
  }

  await syncUnattendedKeywordAlarm(plan);
  return plan;
}

async function readRuntimeState() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.runtime);
  const value = stored[STORAGE_KEYS.runtime];

  return {
    ...DEFAULT_RUNTIME,
    ...(value && typeof value === 'object' ? value : {}),
  };
}

let runtimeMutationQueue = Promise.resolve();

/**
 * Serializes every runtime read-modify-write operation. The queue tail always
 * resolves, so one failed storage write cannot block later runtime updates.
 */
function runRuntimeMutation(mutation) {
  if (typeof mutation !== 'function') {
    throw new TypeError('runtime mutation must be a function');
  }

  const execute = () => Promise.resolve().then(mutation);
  const result = runtimeMutationQueue.then(execute, execute);
  runtimeMutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function writeRuntimeState(patchOrFactory) {
  return await runRuntimeMutation(async () => {
    const current = await readRuntimeState();
    const patch =
      typeof patchOrFactory === 'function'
        ? await patchOrFactory(current)
        : patchOrFactory;
    const next = {
      ...current,
      ...(patch && typeof patch === 'object' ? patch : {}),
    };

    await chrome.storage.local.set({
      [STORAGE_KEYS.runtime]: next,
    });

    return next;
  });
}

async function ensureRuntimeState() {
  return await runRuntimeMutation(async () => {
    const current = await readRuntimeState();
    const nextPatch = {};

    if (!current.clientUuid) {
      nextPatch.clientUuid = createUuid();
    }

    if (!current.clientLabel) {
      nextPatch.clientLabel = getPlatformLabel();
    }

    if (!current.appVersion) {
      nextPatch.appVersion = getAppVersion();
    }

    if (Object.keys(nextPatch).length === 0) {
      return current;
    }

    const next = {
      ...current,
      ...nextPatch,
    };
    await chrome.storage.local.set({
      [STORAGE_KEYS.runtime]: next,
    });
    return next;
  });
}

async function openSidePanelForTab(tabId) {
  if (typeof tabId !== 'number') {
    throw new Error('invalid tabId');
  }

  if (chrome.sidePanel && typeof chrome.sidePanel.open === 'function') {
    await chrome.sidePanel.open({ tabId });
    await writeRuntimeState({ lastActiveTabId: tabId });
    return { tabId, mode: 'side_panel' };
  }

  const sidebarUrl = chrome.runtime.getURL(SIDEBAR_PAGE_PATH);
  const tabs = await chrome.tabs.query({});
  const existingSidebarTab = tabs.find((tab) => {
    const currentUrl = String(tab?.url || '');
    return (
      currentUrl === sidebarUrl
      || currentUrl.startsWith(`${sidebarUrl}?`)
      || currentUrl.startsWith(`${sidebarUrl}#`)
    );
  });

  if (existingSidebarTab?.id) {
    if (typeof existingSidebarTab.windowId === 'number' && existingSidebarTab.windowId >= 0) {
      await chrome.windows.update(existingSidebarTab.windowId, { focused: true });
    }
    await chrome.tabs.update(existingSidebarTab.id, { active: true });
    await writeRuntimeState({ lastActiveTabId: tabId });
    return {
      tabId,
      mode: 'sidebar_tab_existing',
      sidebarTabId: existingSidebarTab.id,
      sidebarUrl,
    };
  }

  const createdSidebarTab = await chrome.tabs.create({ url: sidebarUrl, active: true });
  if (!createdSidebarTab?.id) {
    throw new Error('failed to open sidebar fallback tab');
  }

  await writeRuntimeState({ lastActiveTabId: tabId });
  return {
    tabId,
    mode: 'sidebar_tab_created',
    sidebarTabId: createdSidebarTab.id,
    sidebarUrl: createdSidebarTab.url || sidebarUrl,
  };
}

async function findExistingPlatformTab(platform) {
  const normalizedPlatform = normalizePlatformId(platform);
  if (normalizedPlatform === 'unknown') {
    return null;
  }

  const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const currentWindowId = currentTab?.windowId ?? chrome.windows.WINDOW_ID_NONE;
  const allTabs = await chrome.tabs.query({});
  const candidates = allTabs.filter((tab) => detectPlatformFromUrl(tab?.url || '') === normalizedPlatform);

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((left, right) => {
    const leftCurrentWindowScore = left.windowId === currentWindowId ? 1 : 0;
    const rightCurrentWindowScore = right.windowId === currentWindowId ? 1 : 0;
    if (leftCurrentWindowScore !== rightCurrentWindowScore) {
      return rightCurrentWindowScore - leftCurrentWindowScore;
    }

    const leftActiveScore = left.active ? 1 : 0;
    const rightActiveScore = right.active ? 1 : 0;
    if (leftActiveScore !== rightActiveScore) {
      return rightActiveScore - leftActiveScore;
    }

    return (right.id || 0) - (left.id || 0);
  });

  return candidates[0] || null;
}

async function activateOrCreatePlatformTab(platform) {
  const normalizedPlatform = normalizePlatformId(platform);
  const homeUrl = getPlatformHomeUrl(normalizedPlatform);
  if (!homeUrl) {
    throw new Error('unsupported platform');
  }

  const existingTab = await findExistingPlatformTab(normalizedPlatform);
  if (existingTab?.id) {
    if (typeof existingTab.windowId === 'number' && existingTab.windowId >= 0) {
      await chrome.windows.update(existingTab.windowId, { focused: true });
    }
    const activatedTab = await chrome.tabs.update(existingTab.id, { active: true });
    await syncRuntimeForTabId(existingTab.id, activatedTab?.url || existingTab.url || '');
    return {
      tabId: existingTab.id,
      url: activatedTab?.url || existingTab.url || '',
      platform: normalizedPlatform,
      windowId: activatedTab?.windowId ?? existingTab.windowId ?? null,
      created: false,
    };
  }

  const createdTab = await chrome.tabs.create({
    url: homeUrl,
    active: true,
  });
  if (!createdTab?.id) {
    throw new Error('failed to open platform tab');
  }

  await syncRuntimeForTabId(createdTab.id, createdTab.url || homeUrl);
  return {
    tabId: createdTab.id,
    url: createdTab.url || homeUrl,
    platform: normalizedPlatform,
    windowId: createdTab.windowId ?? null,
    created: true,
  };
}

function isTransientContentRelayError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  return (
    /Receiving end does not exist/i.test(message)
    || /The message port closed before a response was received/i.test(message)
    || /message channel closed before a response was received/i.test(message)
    || /Extension context invalidated/i.test(message)
    || /Frame with ID 0 was removed/i.test(message)
  );
}

async function waitForTabReady(tabId, {
  timeoutMs = 10000,
  pollMs = 150,
} = {}) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (String(tab?.status || '') === 'complete') {
      return tab;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  return await chrome.tabs.get(tabId);
}

function isSupportedCaptureUrl(url) {
  const normalized = String(url || '');
  return (
    /^https?:\/\/www\.xiaohongshu\.com\//i.test(normalized) ||
    /^https?:\/\/www\.douyin\.com\//i.test(normalized) ||
    /^https?:\/\/v\.douyin\.com\//i.test(normalized) ||
    /^https?:\/\/(?:www\.)?weibo\.com\//i.test(normalized) ||
    /^https?:\/\/s\.weibo\.com\//i.test(normalized)
  );
}

function detectPlatformFromUrl(url) {
  const normalized = String(url || '').trim().toLowerCase();
  if (!normalized) return 'unknown';
  if (/^https?:\/\/(?:www\.)?xiaohongshu\.com\//i.test(normalized)) {
    return 'xiaohongshu';
  }
  if (
    /^https?:\/\/(?:www\.)?douyin\.com\//i.test(normalized) ||
    /^https?:\/\/v\.douyin\.com\//i.test(normalized)
  ) {
    return 'douyin';
  }
  if (
    /^https?:\/\/(?:www\.)?weibo\.com\//i.test(normalized) ||
    /^https?:\/\/s\.weibo\.com\//i.test(normalized)
  ) {
    return 'weibo';
  }
  return 'unknown';
}

const DOUYIN_SEARCH_QUERY_KEYS = new Set([
  'keyword',
  'query',
  'q',
  'search_keyword',
  'searchkey',
  'search_word',
]);

function hasDouyinSearchKeywordParam(parsedUrl) {
  if (!parsedUrl?.searchParams) return false;

  for (const [key, value] of parsedUrl.searchParams.entries()) {
    const normalizedKey = String(key || '').trim().toLowerCase();
    if (!DOUYIN_SEARCH_QUERY_KEYS.has(normalizedKey)) {
      continue;
    }
    if (String(value || '').trim()) {
      return true;
    }
  }

  return false;
}

function detectPageTypeFromUrl(url) {
  const rawUrl = String(url || '').trim();
  const normalized = rawUrl.toLowerCase();
  if (!normalized) return 'unknown';

  if (/xiaohongshu\.com/i.test(normalized)) {
    if (/\/(?:explore|video)\/[a-z0-9_-]+/i.test(normalized)) return 'note_detail';
    if (/\/user\/profile\/[a-z0-9]+/i.test(normalized)) return 'blogger_profile';
    if (
      /\/search_result/i.test(normalized) ||
      /\/web\/search_result/i.test(normalized) ||
      /[?&]keyword=/i.test(normalized)
    ) {
      return 'search_results';
    }
  }

  if (/douyin\.com/i.test(normalized)) {
    let parsedUrl = null;
    let pathname = '';
    try {
      parsedUrl = new URL(rawUrl);
      pathname = String(parsedUrl.pathname || '').toLowerCase();
    } catch {
      pathname = '';
    }

    if (/\/(?:video|note)\/\d+/i.test(normalized) || /[?&]modal_id=/i.test(normalized)) {
      return 'note_detail';
    }
    if (/\/user\/[a-z0-9._-]+/i.test(normalized)) return 'blogger_profile';
    if (
      pathname.startsWith('/jingxuan/search') ||
      pathname.startsWith('/search/') ||
      pathname === '/jingxuan' ||
      pathname === '/jingxuan/'
    ) {
      return 'search_results';
    }
    if (hasDouyinSearchKeywordParam(parsedUrl)) {
      return 'search_results';
    }
    if (
      /\/jingxuan(?:\/search)?(?:[/?#]|$)/i.test(normalized) ||
      /\/search\//i.test(normalized)
    ) {
      return 'search_results';
    }
  }

  if (/(^|\/\/)(?:www\.)?weibo\.com|(^|\/\/)s\.weibo\.com/i.test(normalized)) {
    let parsedUrl = null;
    let pathname = '';
    try {
      parsedUrl = new URL(rawUrl);
      pathname = String(parsedUrl.pathname || '').toLowerCase();
    } catch {
      pathname = '';
    }

    if (/s\.weibo\.com/i.test(normalized)) {
      return 'search_results';
    }
    if (pathname.includes('/search') || parsedUrl?.searchParams?.get('q')) {
      return 'search_results';
    }
    if (/^\/u\/\d+\/?$/i.test(pathname)) {
      return 'blogger_profile';
    }
    if (/^\/detail\/\d+\/?$/i.test(pathname)) {
      return 'note_detail';
    }
    if (/^\/[a-z0-9_]+\/[a-z0-9]+\/?$/i.test(pathname)) {
      return 'note_detail';
    }
  }

  return 'unknown';
}

async function syncRuntimeForTabId(tabId, explicitUrl = '') {
  if (typeof tabId !== 'number') return null;

  const tab = await chrome.tabs.get(tabId);
  const url = String(explicitUrl || tab?.url || '').trim();
  if (!url) return null;

  return await writeRuntimeState({
    lastActiveTabId: tabId,
    lastPageUrl: url,
    platform: detectPlatformFromUrl(url),
    pageType: detectPageTypeFromUrl(url),
    detailReady: null,
    detailReadyReason: '',
    detailReadyCheckedAt: 0,
  });
}

async function ensureContentScriptReady(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!isSupportedCaptureUrl(tab?.url)) {
    throw new Error('当前页面不支持采集，请切换到小红书、抖音或微博页面后重试');
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content-loader.js'],
  });
}

function getContentRelayTimeoutMs(payload = {}) {
  const action = String(payload?.action || '');
  if (
    action === 'ping' ||
    action === 'cancelCapture' ||
    action === 'detectPageType' ||
    action === 'detectSearchSortDimension'
  ) {
    return 10 * 1000;
  }

  const requestedDurationMs = Number(payload?.maxDurationMs);
  if (Number.isFinite(requestedDurationMs) && requestedDurationMs > 0) {
    return Math.min(
      CONTENT_RELAY_MAX_TIMEOUT_MS,
      Math.max(2 * 60 * 1000, requestedDurationMs + 30 * 1000),
    );
  }

  return CONTENT_RELAY_DEFAULT_TIMEOUT_MS;
}

function normalizeCaptureProgress(progress = null, senderTabId = null) {
  const source = progress && typeof progress === 'object' ? progress : {};
  const updatedAt = Date.now();
  const explicitRunnerTabId = Number(source.runnerTabId);
  const fallbackTabId = Number(senderTabId);
  return {
    ...source,
    runnerTabId:
      Number.isFinite(explicitRunnerTabId) && explicitRunnerTabId > 0
        ? explicitRunnerTabId
        : Number.isFinite(fallbackTabId) && fallbackTabId > 0
          ? fallbackTabId
          : null,
    updatedAt,
    heartbeatAt: updatedAt,
  };
}

function getCaptureRequestId(payload = {}) {
  return String(payload?.captureRequestId || '').trim();
}

function pruneExpiredCaptureRequestAborts(now = Date.now()) {
  for (const [requestId, abortedAt] of abortedCaptureRequestIds.entries()) {
    if (now - Number(abortedAt || 0) >= CAPTURE_REQUEST_ABORT_TTL_MS) {
      abortedCaptureRequestIds.delete(requestId);
    }
  }
}

function markCaptureRequestAborted(requestId) {
  const normalized = String(requestId || '').trim();
  if (!normalized) return false;
  const now = Date.now();
  pruneExpiredCaptureRequestAborts(now);
  abortedCaptureRequestIds.set(normalized, now);
  return true;
}

function isCaptureRequestAborted(requestId) {
  const normalized = String(requestId || '').trim();
  if (!normalized) return false;
  pruneExpiredCaptureRequestAborts();
  return abortedCaptureRequestIds.has(normalized);
}

function pruneExpiredSettledCaptureRequests(now = Date.now()) {
  for (const [requestId, settledAt] of settledCaptureRequestIds.entries()) {
    if (now - Number(settledAt || 0) >= CAPTURE_REQUEST_ABORT_TTL_MS) {
      settledCaptureRequestIds.delete(requestId);
    }
  }
}

function markCaptureRequestSettled(requestId) {
  const normalized = String(requestId || '').trim();
  if (!normalized) return;
  const now = Date.now();
  pruneExpiredSettledCaptureRequests(now);
  settledCaptureRequestIds.set(normalized, now);
}

function isCaptureRequestSettled(requestId) {
  const normalized = String(requestId || '').trim();
  if (!normalized) return false;
  pruneExpiredSettledCaptureRequests();
  return settledCaptureRequestIds.has(normalized);
}

function buildCanceledContentResponse(payload = {}, response = null) {
  const action = String(payload?.action || '');
  if (action !== 'captureComments') {
    return null;
  }
  const source = response && typeof response === 'object' ? response : {};
  const sourceData =
    source.data && typeof source.data === 'object' ? source.data : {};
  const sourceMeta =
    source.meta && typeof source.meta === 'object' ? source.meta : {};
  const finishedAt = new Date().toISOString();
  return {
    ...source,
    ok: true,
    type: source.type || 'comments',
    data: {
      ...sourceData,
      items: Array.isArray(sourceData.items) ? sourceData.items : [],
      totalCount: Number.isFinite(Number(sourceData.totalCount))
        ? Number(sourceData.totalCount)
        : Array.isArray(sourceData.items)
          ? sourceData.items.length
          : 0,
      captureStatus: 'partial',
      stoppedByUser: true,
      stoppedByStall: Boolean(sourceData.stoppedByStall),
      stopReason: 'canceled',
    },
    meta: {
      ...sourceMeta,
      captureStatus: 'partial',
      stoppedByUser: true,
      stoppedByStall: Boolean(sourceMeta.stoppedByStall),
      captureFinishedAt: sourceMeta.captureFinishedAt || finishedAt,
      stopReason: 'canceled',
    },
    error: null,
  };
}

function resolveAbortedCaptureRequest(payload = {}, response = null) {
  const canceledResponse = buildCanceledContentResponse(payload, response);
  if (canceledResponse) {
    return canceledResponse;
  }
  throw createContentRelayWatchdogError(
    'CAPTURE_CANCELED',
    '用户已取消当前采集任务',
  );
}

function beginContentRelayHeartbeat(payload = {}) {
  // cancelCapture carries the target request id for request-scoped cancellation,
  // but it must not replace/delete the heartbeat owned by the in-flight capture.
  if (String(payload?.action || '') === 'cancelCapture') return '';
  const requestId = getCaptureRequestId(payload);
  if (!requestId) return '';
  const now = Date.now();
  contentRelayHeartbeatByRequestId.set(requestId, {
    updatedAt: now,
    phase: 'request_started',
  });
  return requestId;
}

function markContentRelayHeartbeat(progress = {}) {
  const requestId = getCaptureRequestId(progress);
  if (!requestId || !contentRelayHeartbeatByRequestId.has(requestId)) {
    return;
  }
  contentRelayHeartbeatByRequestId.set(requestId, {
    updatedAt: Number(progress?.updatedAt) || Date.now(),
    phase: String(progress?.phase || ''),
  });
}

function createContentRelayWatchdogError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function writeContentRelayRecoveryProgress(tabId, payload, attempt) {
  const requestId = getCaptureRequestId(payload);
  await writeRuntimeState((runtime) => {
    const previous =
      requestId && runtime?.lastCaptureProgress?.captureRequestId === requestId
        ? runtime.lastCaptureProgress
        : {};
    const progress = normalizeCaptureProgress(
      {
        ...previous,
        phase: 'capture_recovering',
        message: `检测到页面卡顿，正在自动恢复当前步骤（第 ${attempt} 次）`,
        captureRequestId: requestId,
        recordId: String(payload?.recordId || previous?.recordId || ''),
        current: Number(payload?.current) || previous?.current || 0,
        total: Number(payload?.total) || previous?.total || 0,
        runnerTabId: Number(payload?.runnerTabId) || Number(tabId) || null,
        recoveryAttempt: attempt,
        recoveryMaxAttempts: 1,
        captureAction: String(payload?.action || previous?.captureAction || ''),
      },
      tabId,
    );
    return {
      lastActiveTabId: tabId,
      lastCaptureProgress: progress,
      lastCaptureProgressAt: progress.updatedAt,
    };
  });
}

async function writeCaptureCancelingProgress(tabId, requestId) {
  await writeRuntimeState((runtime) => {
    const previous =
      requestId && runtime?.lastCaptureProgress?.captureRequestId === requestId
        ? runtime.lastCaptureProgress
        : {};
    const progress = normalizeCaptureProgress(
      {
        ...previous,
        phase: 'capture_canceling',
        message: '正在取消当前任务并保存可用结果…',
        captureRequestId: requestId,
        runnerTabId: Number(previous?.runnerTabId) || Number(tabId) || null,
      },
      tabId,
    );
    return {
      lastActiveTabId: tabId,
      lastCaptureProgress: progress,
      lastCaptureProgressAt: progress.updatedAt,
    };
  });
}

async function clearStoredCaptureProgress({
  captureRequestId = '',
  recordId = '',
  phase = '',
  updatedAt = 0,
} = {}) {
  const expectedRequestId = String(captureRequestId || '').trim();
  const expectedRecordId = String(recordId || '').trim();
  const expectedPhase = String(phase || '').trim();
  const expectedUpdatedAt = Number(updatedAt) || 0;
  return await runRuntimeMutation(async () => {
    const runtime = await readRuntimeState();
    const current = runtime?.lastCaptureProgress;
    if (!current || typeof current !== 'object') {
      return false;
    }

    if (
      (expectedRequestId &&
        String(current.captureRequestId || '').trim() !== expectedRequestId) ||
      (expectedRecordId &&
        String(current.recordId || '').trim() !== expectedRecordId) ||
      (expectedPhase && String(current.phase || '').trim() !== expectedPhase) ||
      (expectedUpdatedAt && Number(current.updatedAt) !== expectedUpdatedAt)
    ) {
      return false;
    }

    await chrome.storage.local.set({
      [STORAGE_KEYS.runtime]: {
        ...runtime,
        lastCaptureProgress: null,
        lastCaptureProgressAt: 0,
      },
    });
    return true;
  });
}

async function sendContentMessageWithTimeout(tabId, payload, timeoutMs) {
  const requestId = beginContentRelayHeartbeat(payload);
  const inactivityTimeoutMs = requestId
    ? CONTENT_RELAY_INACTIVITY_TIMEOUT_MS
    : 0;
  let watchdogId = null;
  let activeElapsedMs = 0;
  let lastWatchdogAt = Date.now();

  try {
    return await Promise.race([
      chrome.tabs.sendMessage(tabId, payload ?? {}),
      new Promise((_, reject) => {
        const checkWatchdog = () => {
          const now = Date.now();
          const tickGapMs = Math.max(0, now - lastWatchdogAt);
          const heartbeat = requestId
            ? contentRelayHeartbeatByRequestId.get(requestId)
            : null;
          const heartbeatAgeBeforeTickMs = heartbeat
            ? now - Number(heartbeat.updatedAt || 0)
            : Number.POSITIVE_INFINITY;
          const networkPauseIsAlive =
            heartbeat?.phase === 'network_paused' &&
            heartbeatAgeBeforeTickMs <= CONTENT_NETWORK_PAUSE_HEARTBEAT_GRACE_MS;

          // 合盖休眠/系统冻结会让定时器整体停摆。唤醒后的大间隔不计入
          // 采集用时，并给原页面一次恢复心跳的机会，而不是立刻误判超时。
          if (tickGapMs > CONTENT_RELAY_SUSPEND_GAP_MS) {
            if (requestId) {
              contentRelayHeartbeatByRequestId.set(requestId, {
                updatedAt: now,
                phase: 'system_resumed',
              });
            }
          } else if (!networkPauseIsAlive) {
            activeElapsedMs += tickGapMs;
          }
          lastWatchdogAt = now;

          const latestHeartbeat = requestId
            ? contentRelayHeartbeatByRequestId.get(requestId)
            : null;
          const heartbeatAgeMs = latestHeartbeat
            ? now - Number(latestHeartbeat.updatedAt || 0)
            : 0;
          const latestNetworkPauseIsAlive =
            latestHeartbeat?.phase === 'network_paused' &&
            heartbeatAgeMs <= CONTENT_NETWORK_PAUSE_HEARTBEAT_GRACE_MS;

          if (
            inactivityTimeoutMs > 0 &&
            !latestNetworkPauseIsAlive &&
            heartbeatAgeMs >= inactivityTimeoutMs
          ) {
            reject(
              createContentRelayWatchdogError(
                'CONTENT_RELAY_STALLED',
                `页面超过 ${Math.ceil(inactivityTimeoutMs / 1000)} 秒没有采集进度，正在自动恢复当前步骤`,
              ),
            );
            return;
          }

          if (activeElapsedMs >= timeoutMs) {
            reject(
              createContentRelayWatchdogError(
                'CONTENT_RELAY_TIMEOUT',
                `页面采集脚本超过 ${Math.ceil(timeoutMs / 1000)} 秒未响应，已停止当前步骤`,
              ),
            );
            return;
          }

          watchdogId = setTimeout(
            checkWatchdog,
            CONTENT_RELAY_WATCHDOG_TICK_MS,
          );
        };

        watchdogId = setTimeout(
          checkWatchdog,
          CONTENT_RELAY_WATCHDOG_TICK_MS,
        );
      }),
    ]);
  } finally {
    if (watchdogId) {
      clearTimeout(watchdogId);
    }
    if (requestId) {
      contentRelayHeartbeatByRequestId.delete(requestId);
    }
  }
}

async function waitForContentScriptReady(tabId, {
  timeoutMs = CONTENT_SCRIPT_READY_TIMEOUT_MS,
  pollMs = 200,
} = {}) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await sendContentMessageWithTimeout(
        tabId,
        { action: 'ping' },
        Math.min(1500, timeoutMs),
      );
      if (response?.ok) {
        return response;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw lastError || new Error('页面采集脚本加载超时，请刷新平台页面后重试');
}

async function cancelTimedOutContentCapture(tabId, captureRequestId = '') {
  try {
    await sendContentMessageWithTimeout(
      tabId,
      {
        action: 'cancelCapture',
        captureRequestId: String(captureRequestId || '').trim(),
      },
      5000,
    );
  } catch {
    // The timed-out page may already have lost its content-script receiver.
  }
}

async function reloadStalledCaptureTab(tabId, { shouldAbort = null } = {}) {
  if (typeof chrome.tabs.reload === 'function') {
    await chrome.tabs.reload(tabId);
  } else {
    const tab = await chrome.tabs.get(tabId);
    const url = String(tab?.url || '').trim();
    if (!url) {
      throw new Error('无法重新加载卡住的采集页面');
    }
    await chrome.tabs.update(tabId, {url});
  }
  if (typeof shouldAbort === 'function' && shouldAbort()) {
    return false;
  }

  // 等待 reload 真正进入 loading，避免立刻读到刷新前的 complete 状态。
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (typeof shouldAbort === 'function' && shouldAbort()) {
    return false;
  }
  await waitForTabReady(tabId, {timeoutMs: 30 * 1000});
  if (typeof shouldAbort === 'function' && shouldAbort()) {
    return false;
  }
  await ensureContentScriptReady(tabId);
  if (typeof shouldAbort === 'function' && shouldAbort()) {
    return false;
  }
  await waitForContentScriptReady(tabId);
  return !(typeof shouldAbort === 'function' && shouldAbort());
}

async function relayToContentWithRetry(tabId, payload) {
  const timeoutMs = getContentRelayTimeoutMs(payload);
  const requestId = getCaptureRequestId(payload);
  if (requestId) {
    settledCaptureRequestIds.delete(requestId);
  }
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (requestId && isCaptureRequestAborted(requestId)) {
        return resolveAbortedCaptureRequest(payload);
      }
      try {
        const response = await sendContentMessageWithTimeout(
          tabId,
          payload,
          timeoutMs,
        );
        if (requestId && isCaptureRequestAborted(requestId)) {
          return resolveAbortedCaptureRequest(payload, response);
        }
        return response;
      } catch (error) {
        if (
          error?.code === 'CONTENT_RELAY_TIMEOUT' ||
          error?.code === 'CONTENT_RELAY_STALLED'
        ) {
          await cancelTimedOutContentCapture(tabId, requestId);
          if (requestId && isCaptureRequestAborted(requestId)) {
            return resolveAbortedCaptureRequest(payload);
          }
          if (error?.code === 'CONTENT_RELAY_STALLED' && attempt === 0) {
            await writeContentRelayRecoveryProgress(
              tabId,
              payload,
              attempt + 1,
            ).catch(() => null);
            if (requestId && isCaptureRequestAborted(requestId)) {
              return resolveAbortedCaptureRequest(payload);
            }
            const reloadCompleted = await reloadStalledCaptureTab(tabId, {
              shouldAbort: () =>
                Boolean(requestId && isCaptureRequestAborted(requestId)),
            });
            if (
              !reloadCompleted ||
              (requestId && isCaptureRequestAborted(requestId))
            ) {
              return resolveAbortedCaptureRequest(payload);
            }
            continue;
          }
          throw error;
        }
        if (!isTransientContentRelayError(error) || attempt === 1) {
          throw error;
        }

        await waitForTabReady(tabId).catch(() => null);
        if (requestId && isCaptureRequestAborted(requestId)) {
          return resolveAbortedCaptureRequest(payload);
        }
        await ensureContentScriptReady(tabId);
        await waitForContentScriptReady(tabId);
      }
    }

    throw new Error('failed to relay message to content script');
  } finally {
    if (requestId) {
      abortedCaptureRequestIds.delete(requestId);
      markCaptureRequestSettled(requestId);
      await clearStoredCaptureProgress({captureRequestId: requestId}).catch(
        () => false,
      );
    }
  }
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    chrome.storage.local.remove('onstarvoice.riskNoticeAcknowledged').catch(() => {});
  }
  ensureRuntimeState().catch((error) => {
    console.error('[onstarvoice] failed to initialize runtime on install', error);
  });
  reconcileUnattendedKeywordPlanSchedule({ launchDue: false })
    .catch((error) => {
      console.error('[onstarvoice] failed to sync unattended alarm on install', error);
    });
  syncUnattendedSupervisorAlarm().catch((error) => {
    console.error('[onstarvoice] failed to sync unattended supervisor on install', error);
  });
});

chrome.runtime.onStartup.addListener(() => {
  ensureRuntimeState().catch((error) => {
    console.error('[onstarvoice] failed to initialize runtime on startup', error);
  });
  syncUnattendedSupervisorAlarm()
    .then(() =>
      superviseUnattendedKeywordRun({
        applyWakeGrace: true,
        reason: 'browser_startup',
      }),
    )
    .then(() => reconcileUnattendedKeywordPlanSchedule({ launchDue: true }))
    .catch((error) => {
      console.error('[onstarvoice] failed to sync unattended alarm on startup', error);
    });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === UNATTENDED_SUPERVISOR_ALARM_NAME) {
    superviseUnattendedKeywordRun({
      reason: 'supervisor_alarm',
      scheduledTime: alarm?.scheduledTime,
    }).catch((error) => {
      console.error('[onstarvoice] unattended supervisor failed', error);
    });
    return;
  }
  if (alarm?.name === UNATTENDED_KEYWORD_ALARM_NAME) {
    handleUnattendedKeywordAlarm().catch((error) => {
      console.error('[onstarvoice] unattended keyword alarm failed', error);
    });
  }
});

chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id) return;

  openSidePanelForTab(tab.id).catch((error) => {
    console.error('[onstarvoice] failed to open side panel', error);
  });
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  syncRuntimeForTabId(tabId).catch((error) => {
    console.warn('[onstarvoice] failed to sync runtime on tab activation', error);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab?.active) return;
  if (!changeInfo.url && changeInfo.status !== 'complete') return;

  syncRuntimeForTabId(tabId, changeInfo.url || tab.url || '').catch((error) => {
    console.warn('[onstarvoice] failed to sync runtime on tab update', error);
  });
});

chrome.tabs.onRemoved?.addListener((tabId) => {
  superviseUnattendedKeywordRun({
    removedTabId: tabId,
    reason: 'runner_tab_removed',
  }).catch((error) => {
    console.error('[onstarvoice] unattended runner removal check failed', error);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const action = message?.action;
  const type = message?.type;

  if (
    action === 'captureProgress' ||
    action === 'expandKeywordProgress' ||
    action === 'pageLoaded' ||
    action === 'pageChanged' ||
    action === 'pageStateChanged'
  ) {
    (async () => {
      try {
        if (action === 'captureProgress' || action === 'expandKeywordProgress') {
          const normalizedProgress = normalizeCaptureProgress(
            message?.progress,
            sender?.tab?.id,
          );
          if (action === 'captureProgress') {
            markContentRelayHeartbeat(normalizedProgress);
          }
          const next = await writeRuntimeState({
            lastActiveTabId: sender?.tab?.id ?? null,
            lastCaptureProgress: normalizedProgress,
            lastCaptureProgressAt: normalizedProgress.updatedAt,
          });

          sendResponse({
            ok: true,
            data: {
              lastCaptureProgress: next.lastCaptureProgress,
            },
          });
          return;
        }

        const next = await writeRuntimeState({
          lastActiveTabId: sender?.tab?.id ?? null,
          lastPageUrl: message?.url ?? '',
          platform: message?.platform || detectPlatformFromUrl(message?.url ?? sender?.tab?.url ?? ''),
          pageType: message?.pageType || 'unknown',
          detailReady: message?.detailReady ?? null,
          detailReadyReason: message?.detailReadyReason || '',
          detailReadyCheckedAt: Number(message?.detailReadyCheckedAt) || Date.now(),
        });

        sendResponse({
          ok: true,
          data: {
            platform: next.platform,
            pageType: next.pageType,
            detailReady: next.detailReady,
            detailReadyReason: next.detailReadyReason,
            lastPageUrl: next.lastPageUrl,
          },
        });
      } catch (error) {
        sendResponse({
          ok: false,
          error: {
            code: 'runtime_error',
            message: error instanceof Error ? error.message : 'unknown runtime error',
          },
        });
      }
    })();

    return true;
  }

  if (!type) {
    return false;
  }

  (async () => {
    try {
      if (type === 'onstarvoice:open-side-panel') {
        const tabId = message?.tabId ?? sender?.tab?.id;
        const data = await openSidePanelForTab(tabId);
        sendResponse({ ok: true, data });
        return;
      }

      if (type === 'onstarvoice:get-client-env') {
        const runtime = await ensureRuntimeState();
        sendResponse({
          ok: true,
          data: {
            clientUuid: runtime.clientUuid,
            clientLabel: runtime.clientLabel,
            appVersion: getAppVersion(),
          },
        });
        return;
      }

      if (type === 'onstarvoice:get-extension-state') {
        const runtime = await ensureRuntimeState();
        sendResponse({
          ok: true,
          data: runtime,
        });
        return;
      }

      if (type === 'onstarvoice:update-runtime') {
        const updates =
          message?.updates &&
          typeof message.updates === 'object' &&
          !Array.isArray(message.updates)
            ? message.updates
            : {};
        const runtime = await writeRuntimeState({
          ...updates,
          lastUpdatedAt: Date.now(),
        });
        sendResponse({ ok: true, data: runtime });
        return;
      }

      if (type === 'onstarvoice:get-task-ledger') {
        const ledger = await readTaskLedger();
        sendResponse({ok: true, data: ledger});
        return;
      }

      if (type === 'onstarvoice:upsert-task-run') {
        const result = await upsertTaskLedgerRun({
          run: message?.run || message?.task || null,
          patch: message?.patch || null,
          event: message?.event || null,
        });
        sendResponse({
          ok: true,
          data: result.data,
          accepted: result.accepted,
          reason: result.reason,
        });
        return;
      }

      if (type === 'onstarvoice:get-unattended-keyword-plan') {
        const plan = await reconcileUnattendedKeywordPlanSchedule({
          launchDue: true,
        });
        sendResponse({ ok: true, data: plan });
        return;
      }

      if (type === 'onstarvoice:save-unattended-keyword-plan') {
        const plan = await saveUnattendedKeywordPlan(message?.plan || {});
        sendResponse({ ok: true, data: plan });
        return;
      }

      if (type === 'onstarvoice:claim-unattended-keyword-run') {
        const requestId = String(message?.requestId || '').trim();
        const result = await claimUnattendedKeywordRun({
          requestId,
          senderTabId: sender?.tab?.id,
          senderDocumentId: sender?.documentId,
          holderId: String(message?.holderId || ''),
        });
        sendResponse({
          ok: true,
          data: result.data,
          accepted: result.accepted,
          reason: result.reason,
          lock: result.lock || null,
        });
        return;
      }

      if (type === 'onstarvoice:update-unattended-keyword-run') {
        const result = await updateUnattendedKeywordRun({
          requestId: String(message?.requestId || '').trim(),
          attemptId: String(message?.attemptId || '').trim(),
          patch: message?.patch,
        });
        sendResponse({
          ok: true,
          data: result.data,
          accepted: result.accepted,
          reason: result.reason,
        });
        return;
      }

      if (type === 'onstarvoice:recover-unattended-keyword-run') {
        const result = await manuallyRecoverUnattendedKeywordRun({
          requestId: String(message?.requestId || '').trim(),
          mode: String(message?.mode || 'remaining').trim(),
        });
        sendResponse({
          ok: result.accepted,
          data: result.request || null,
          accepted: result.accepted,
          reason: result.reason,
        });
        return;
      }

      if (type === 'onstarvoice:cancel-unattended-keyword-run') {
        const reason =
          String(message?.message || '').trim() ||
          '用户手动中止无人值守计划';
        const request = await readUnattendedKeywordRunRequest();
        const requestedId = String(message?.requestId || '').trim();
        if (requestedId && request?.id !== requestedId) {
          sendResponse({
            ok: false,
            data: null,
            accepted: false,
            reason: 'request_mismatch',
          });
          return;
        }
        if (
          request &&
          isTerminalUnattendedRunStatus(request.status) &&
          request.status !== 'needs_action'
        ) {
          sendResponse({
            ok: true,
            accepted: true,
            reason: 'already_terminal',
            data: {
              request,
              plan: await readUnattendedKeywordPlan(),
              relayedCount: 0,
            },
          });
          return;
        }
        const progress = normalizeUnattendedRunProgress(
          request?.progress,
          request?.message,
        );
        const explicitTabId = Number(message?.tabId);
        const progressRunnerTabId = Number(progress?.runnerTabId);
        // 必须在把请求改成 canceled 之前捕获旧锁；锁的 holderTabId 是列表
        // 导航/初始采集阶段唯一可靠的平台页身份。
        const lockSnapshot = await snapshotUnattendedKeywordPlanLock();
        const canceledRequest = await cancelUnattendedKeywordRunRequest(reason, {
          requestId: requestedId,
        });
        if (!canceledRequest) {
          sendResponse({
            ok: false,
            data: request || null,
            accepted: false,
            reason: isTerminalUnattendedRunStatus(request?.status)
              ? 'terminal'
              : 'request_mismatch',
          });
          return;
        }
        const relayedCount = await cancelAndReleaseUnattendedExecutionTargets(
          lockSnapshot,
          [explicitTabId, progressRunnerTabId],
        );

        const now = new Date();
        const plan = await readUnattendedKeywordPlan();
        const nextPlan = await saveUnattendedKeywordPlan(
          {
            ...plan,
            lastRunAt: now.toISOString(),
            lastRunStatus: 'canceled',
            lastRunMessage: reason,
            lastRunProgress: progress,
            nextRunAt: '',
          },
          { recomputeNext: true, from: buildScheduleReferenceAfterDate(now) },
        );

        sendResponse({
          ok: true,
          accepted: true,
          reason: 'canceled',
          data: {
            request: canceledRequest,
            plan: nextPlan,
            relayedCount,
          },
        });
        return;
      }

      if (type === 'onstarvoice:acquire-capture-lock') {
        const result = await acquireCaptureExecutionLock({
          owner: message?.owner,
          label: message?.label,
          holderId: message?.holderId,
          holderDocumentId: sender?.documentId,
          holderTabId: message?.holderTabId ?? sender?.tab?.id,
        });
        sendResponse({ ok: result.ok, data: result.lock });
        return;
      }

      if (type === 'onstarvoice:renew-capture-lock') {
        const result = await renewCaptureExecutionLock({
          lockId: message?.lockId,
          holderId: message?.holderId,
          holderDocumentId: sender?.documentId,
          holderTabId: message?.holderTabId ?? sender?.tab?.id,
        });
        sendResponse({
          ok: result.ok,
          data: result.lock,
          reason: result.reason,
        });
        return;
      }

      if (type === 'onstarvoice:release-capture-lock') {
        const released = await releaseCaptureExecutionLock(message?.lockId, {
          holderId: message?.holderId,
          holderDocumentId: sender?.documentId,
          requireHolder: true,
        });
        sendResponse({ ok: released });
        return;
      }

      if (type === 'onstarvoice:get-capture-lock') {
        const lock = await readActiveCaptureExecutionLock();
        sendResponse({ ok: true, data: lock });
        return;
      }

      if (type === 'onstarvoice:switch-platform-tab') {
        const data = await activateOrCreatePlatformTab(message?.platform);
        sendResponse({ ok: true, data });
        return;
      }

      if (type === 'onstarvoice:capture-progress') {
        const incomingProgress =
          message?.payload && typeof message.payload === 'object'
            ? message.payload
            : {};
        const incomingRequestId = getCaptureRequestId(incomingProgress);
        const incomingPhase = String(incomingProgress?.phase || '').trim();
        const isTerminalCommentProgress = new Set([
          'comments_done',
          'comments_partial',
          'comments_failed',
        ]).has(incomingPhase);
        if (
          incomingRequestId &&
          isCaptureRequestSettled(incomingRequestId) &&
          !isTerminalCommentProgress
        ) {
          sendResponse({ ok: true, data: { ignored: true } });
          return;
        }
        const normalizedProgress = normalizeCaptureProgress(
          incomingProgress,
          sender?.tab?.id,
        );
        markContentRelayHeartbeat(normalizedProgress);
        const next = await writeRuntimeState({
          lastActiveTabId: sender?.tab?.id ?? null,
          lastCaptureProgress: normalizedProgress,
          lastCaptureProgressAt: normalizedProgress.updatedAt,
        });
        sendResponse({
          ok: true,
          data: {
            lastCaptureProgress: next.lastCaptureProgress,
          },
        });
        return;
      }

      if (type === 'onstarvoice:clear-capture-progress') {
        const cleared = await clearStoredCaptureProgress({
          captureRequestId: message?.captureRequestId,
          recordId: message?.recordId,
          phase: message?.phase,
          updatedAt: message?.updatedAt,
        });
        sendResponse({ ok: true, data: { cleared } });
        return;
      }

      if (type === 'onstarvoice:cancel-capture') {
        const tabId = Number(message?.tabId);
        const requestId = String(message?.captureRequestId || '').trim();
        if (!Number.isFinite(tabId) || tabId <= 0) {
          throw new Error('invalid tabId');
        }
        if (requestId && isCaptureRequestSettled(requestId)) {
          await clearStoredCaptureProgress({
            captureRequestId: requestId,
          }).catch(() => false);
          sendResponse({
            ok: true,
            data: {
              captureRequestId: requestId,
              runnerTabId: tabId,
              canceled: false,
              alreadySettled: true,
            },
          });
          return;
        }
        if (requestId) {
          markCaptureRequestAborted(requestId);
          await writeCaptureCancelingProgress(tabId, requestId).catch(() => null);
        }
        await cancelTimedOutContentCapture(tabId, requestId);
        sendResponse({
          ok: true,
          data: {
            captureRequestId: requestId,
            runnerTabId: tabId,
            canceled: true,
          },
        });
        return;
      }

      if (type === 'onstarvoice:relay-to-content') {
        const tabId = message?.tabId;
        if (typeof tabId !== 'number') {
          throw new Error('invalid tabId');
        }

        const response = await relayToContentWithRetry(
          tabId,
          message?.payload ?? {},
        );
        await writeRuntimeState({ lastActiveTabId: tabId });
        sendResponse({ ok: true, data: response ?? null });
        return;
      }

      sendResponse({
        ok: false,
        error: {
          code: 'unsupported_message',
          message: `unsupported message type: ${type}`,
        },
      });
    } catch (error) {
      sendResponse({
        ok: false,
        error: {
          code: String(error?.code || 'runtime_error'),
          message: error instanceof Error ? error.message : 'unknown runtime error',
        },
      });
    }
  })();

  return true;
});
